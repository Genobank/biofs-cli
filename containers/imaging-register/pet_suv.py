#!/usr/bin/env python3
"""PET to SUV (body weight), following the QIBA vendor-neutral happy-path pseudocode (SUV_vendorneutral_pseudocode_happypathonly,
QIBA wiki, 2017-09-20). Nothing is guessed: when an attribute the formula needs is missing, empty or zero, or when the series falls
outside the happy path (the vendor-specific cases the pseudocode leaves out), the series is `not calculable` and the reason is named.

Formula (seconds, Bq, kg):
    decay_time   = scan_time - radiopharmaceutical_start_time
    decayed_dose = radionuclide_total_dose * 2 ** (-decay_time / radionuclide_half_life)
    SUVbw scale  = patient_weight * 1000 / decayed_dose                     (g/mL per Bq/mL)
    SUVbw        = (stored_pixel * rescale_slope + rescale_intercept) * SUVbw scale        (rescale slope may differ per slice)
Happy path: Corrected Image (0028,0051) contains ATTN and DECAY, Decay Correction (0054,1102) is START, Units (0054,1001) is BQML,
and the series time is not after the acquisition time (then scan_time is the series time). The radionuclide total dose is not corrected
for residual dose in the syringe, which is ignored, as in the pseudocode. The start date is not explicit in DICOM: it is taken as the
series date, and a start time later than the scan time on that date is read as the previous day (midnight spanning).

Privacy: the persisted record keeps the scale factor and the decay facts (half-life, decay time, units), not the weight or the dose."""
import hashlib
import json
import re
from datetime import datetime, timedelta

import numpy as np


class SuvNotCalculable(Exception):
    def __init__(self, reason, missing=None):
        super().__init__(reason)
        self.reason, self.missing = reason, list(missing or [])


def parse_da_tm(da, tm):
    """DICOM DA (YYYYMMDD) and TM (HHMMSS.ffffff, any shorter form) to a datetime."""
    da, tm = (da or "").strip(), (tm or "").strip()
    if not re.fullmatch(r"\d{8}", da) or not re.fullmatch(r"\d{2}(\d{2}(\d{2}(\.\d{1,6})?)?)?", tm):
        raise SuvNotCalculable(f"unreadable date or time ({da!r}, {tm!r})")
    hh, mm, ss = int(tm[0:2]), int(tm[2:4] or 0), float(tm[4:] or 0)
    return datetime.strptime(da, "%Y%m%d") + timedelta(hours=hh, minutes=mm, seconds=ss)


NEEDED = ("CorrectedImage", "DecayCorrection", "Units", "HalfLife", "TotalDose", "StartTime", "PatientWeight",
          "SeriesDate", "SeriesTime", "AcquisitionDate", "AcquisitionTime")


def suv_bw_scale_factor(t):
    """`t` is a dict of the attribute values (strings or numbers; CorrectedImage a list or string):
    CorrectedImage, DecayCorrection, Units, HalfLife (s), TotalDose (Bq), StartTime (TM), PatientWeight (kg),
    SeriesDate, SeriesTime, AcquisitionDate, AcquisitionTime. Returns (scale_factor, facts) or raises SuvNotCalculable."""
    def blank(v):
        return (v is None or (isinstance(v, str) and not v.strip()) or (isinstance(v, (list, tuple)) and not v)
                or (isinstance(v, (int, float)) and not isinstance(v, bool) and v == 0))     # a string "000000" is a valid midnight
    missing = [k for k in NEEDED if blank(t.get(k))]
    for k in ("HalfLife", "TotalDose", "PatientWeight"):
        if k not in missing:
            try:
                if float(t[k]) <= 0:
                    missing.append(k)
            except (TypeError, ValueError):
                missing.append(k)
    if missing:
        raise SuvNotCalculable("SUV cannot be calculated: attribute missing, empty or zero: " + ", ".join(missing), missing)
    ci = t["CorrectedImage"]
    ci = [str(x).upper() for x in (ci if isinstance(ci, (list, tuple)) else str(ci).replace("\\", " ").split())]
    if not ("ATTN" in ci and "DECAY" in ci):
        raise SuvNotCalculable(f"outside the happy path: Corrected Image {ci} does not contain ATTN and DECAY")
    if str(t["DecayCorrection"]).strip().upper() != "START":
        raise SuvNotCalculable(f"outside the happy path: Decay Correction is {t['DecayCorrection']!r}, not START")
    if str(t["Units"]).strip().upper() != "BQML":
        raise SuvNotCalculable(f"outside the happy path: Units are {t['Units']!r}, not BQML")
    series = parse_da_tm(t["SeriesDate"], t["SeriesTime"])
    acq = parse_da_tm(t["AcquisitionDate"], t["AcquisitionTime"])
    if series > acq:
        raise SuvNotCalculable("outside the happy path: the series time is after the acquisition time (a vendor-specific case; "
                               "the scan time cannot be taken from the series time)")
    start = parse_da_tm(t["SeriesDate"], t["StartTime"])
    if start > series:
        start -= timedelta(days=1)                          # the dose was drawn before midnight
    decay_s = (series - start).total_seconds()
    half = float(t["HalfLife"])
    decayed = float(t["TotalDose"]) * 2.0 ** (-decay_s / half)
    factor = float(t["PatientWeight"]) * 1000.0 / decayed
    return factor, {"method": "QIBA vendor-neutral happy path, SUVbw", "half_life_s": half, "decay_time_s": round(decay_s, 1),
                    "units": "BQML", "decay_correction": "START", "scale_factor": factor,
                    "inputs_sha256": hashlib.sha256(json.dumps({k: str(t[k]) for k in NEEDED}, sort_keys=True).encode()).hexdigest()}


def tags_from_dataset(ds):
    """Attribute values out of a pydicom dataset (first slice of a PET series)."""
    seq = getattr(ds, "RadiopharmaceuticalInformationSequence", None)
    r = seq[0] if seq else None
    g = lambda o, k: None if o is None else getattr(o, k, None)
    return {"CorrectedImage": [str(x) for x in (getattr(ds, "CorrectedImage", None) or [])],
            "DecayCorrection": getattr(ds, "DecayCorrection", None), "Units": getattr(ds, "Units", None),
            "HalfLife": g(r, "RadionuclideHalfLife"), "TotalDose": g(r, "RadionuclideTotalDose"),
            "StartTime": g(r, "RadiopharmaceuticalStartTime"), "PatientWeight": getattr(ds, "PatientWeight", None),
            "SeriesDate": getattr(ds, "SeriesDate", None), "SeriesTime": getattr(ds, "SeriesTime", None),
            "AcquisitionDate": getattr(ds, "AcquisitionDate", None), "AcquisitionTime": getattr(ds, "AcquisitionTime", None)}


def suv_volume_from_series(files):
    """A PET series (DICOM files) to an SUVbw volume (z, y, x, float32) with the slice positions, using each slice's own rescale
    slope and intercept. Raises SuvNotCalculable (the series is left unconverted) when the formula does not apply."""
    import pydicom
    dss = sorted((pydicom.dcmread(f) for f in files), key=lambda d: float(d.ImagePositionPatient[2]))
    if not dss:
        raise SuvNotCalculable("no DICOM slices")
    factor, facts = suv_bw_scale_factor(tags_from_dataset(dss[0]))
    slices = []
    for d in dss:
        slope, icpt = float(getattr(d, "RescaleSlope", 1.0) or 1.0), float(getattr(d, "RescaleIntercept", 0.0) or 0.0)
        slices.append((d.pixel_array.astype(np.float64) * slope + icpt) * factor)
    z = [float(d.ImagePositionPatient[2]) for d in dss]
    return np.stack(slices).astype(np.float32), {"z_mm": z, "pixel_spacing_mm": [float(v) for v in dss[0].PixelSpacing], **facts}
