"""Tests for pet_suv.py. numpy only, plus pydicom for the series test."""
import os, sys, tempfile
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pet_suv as P

F18_HALF_S = 6586.2


def tags(**over):
    t = {"CorrectedImage": ["NORM", "DTIM", "ATTN", "SCAT", "DECY", "RADL"][0:0] + ["ATTN", "DECAY", "SCAT"], "DecayCorrection": "START", "Units": "BQML",
         "HalfLife": F18_HALF_S, "TotalDose": 370e6, "StartTime": "100000", "PatientWeight": 70.0,
         "SeriesDate": "20260109", "SeriesTime": "110000", "AcquisitionDate": "20260109", "AcquisitionTime": "110000"}
    t.update(over)
    return t


def test_a_uniform_distribution_of_the_decayed_dose_over_the_body_weight_is_exactly_suv_one():
    f, facts = P.suv_bw_scale_factor(tags())
    decayed = 370e6 * 2 ** (-3600 / F18_HALF_S)
    uniform_bq_per_ml = decayed / (70.0 * 1000.0)                   # the dose spread evenly over 70 kg of water-density tissue
    assert abs(uniform_bq_per_ml * f - 1.0) < 1e-9, uniform_bq_per_ml * f
    assert facts["decay_time_s"] == 3600.0 and facts["units"] == "BQML" and "weight" not in str(facts).lower().replace("inputs_sha256", "")


def test_a_start_time_after_the_scan_time_is_the_previous_day():
    f1, a = P.suv_bw_scale_factor(tags(StartTime="235000", SeriesTime="001000", AcquisitionTime="001000"))
    assert a["decay_time_s"] == 1200.0                              # 23:50 to 00:10 across midnight


def test_every_missing_or_zero_attribute_is_named_and_nothing_is_computed():
    for key in ("HalfLife", "TotalDose", "PatientWeight", "StartTime", "Units", "DecayCorrection"):
        for bad in (None, "", 0):
            try:
                P.suv_bw_scale_factor(tags(**{key: bad}))
            except P.SuvNotCalculable as e:
                assert key in e.missing, (key, bad, e.missing)
            else:
                raise AssertionError(f"{key}={bad!r} was accepted")


def test_cases_outside_the_happy_path_are_refused_with_the_reason():
    cases = [({"Units": "CNTS"}, "Units"), ({"DecayCorrection": "ADMIN"}, "Decay Correction"),
             ({"CorrectedImage": ["NORM", "DECAY"]}, "ATTN"), ({"SeriesTime": "120000"}, "series time is after")]
    for over, text in cases:
        try:
            P.suv_bw_scale_factor(tags(**over))
        except P.SuvNotCalculable as e:
            assert text in e.reason, (over, e.reason)
        else:
            raise AssertionError(f"accepted {over}")


def test_a_series_is_converted_with_each_slices_own_rescale_slope():
    import pydicom
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid
    with tempfile.TemporaryDirectory() as td:
        files = []
        for i, slope in enumerate((0.5, 2.0)):                           # GE writes a different slope per slice
            m = FileMetaDataset(); m.TransferSyntaxUID = ExplicitVRLittleEndian; m.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.128"
            m.MediaStorageSOPInstanceUID = generate_uid()
            ds = FileDataset(os.path.join(td, f"s{i}.dcm"), {}, file_meta=m, preamble=b"\0" * 128)
            ds.is_little_endian, ds.is_implicit_VR = True, False
            ds.Rows = ds.Columns = 2; ds.BitsAllocated = 16; ds.BitsStored = 16; ds.HighBit = 15; ds.PixelRepresentation = 0
            ds.SamplesPerPixel = 1; ds.PhotometricInterpretation = "MONOCHROME2"
            ds.PixelData = np.full((2, 2), 1000, np.uint16).tobytes()
            ds.RescaleSlope, ds.RescaleIntercept = slope, 0.0
            ds.ImagePositionPatient = [0, 0, 3.0 * i]; ds.PixelSpacing = [4.0, 4.0]
            t = tags()
            ds.CorrectedImage = t["CorrectedImage"]; ds.DecayCorrection = "START"; ds.Units = "BQML"; ds.PatientWeight = 70.0
            ds.SeriesDate, ds.SeriesTime, ds.AcquisitionDate, ds.AcquisitionTime = "20260109", "110000", "20260109", "110000"
            r = pydicom.Dataset(); r.RadionuclideHalfLife = F18_HALF_S; r.RadionuclideTotalDose = 370e6; r.RadiopharmaceuticalStartTime = "100000"
            ds.RadiopharmaceuticalInformationSequence = [r]
            ds.save_as(ds.filename); files.append(ds.filename)
        vol, info = P.suv_volume_from_series(files)
        f, _ = P.suv_bw_scale_factor(tags())
        assert vol.shape == (2, 2, 2) and abs(vol[0, 0, 0] - 500 * f) < 1e-6 and abs(vol[1, 0, 0] - 2000 * f) < 1e-6
        assert info["z_mm"] == [0.0, 3.0]
