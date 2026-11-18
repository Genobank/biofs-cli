#!/usr/bin/env python3
"""Write a CT volume (SimpleITK image) as a DICOM series that the imaging pipeline reads like a scanner's output, for known-answer tests.

The series carries synthetic identifiers only (patient name SYNTHETIC^KNOWNANSWER, patient id SYNTHETIC-KNOWNANSWER); no attribute of
the source scan's patient is copied. The pixel data are derived from a real scan when the volume is, so the series still belongs
to that scan's owner: it is stored only under the owner's wallet and marked synthetic in its series description.

  write_series(img, out_dir, ...)  one .dcm file per slice, int16 with RescaleSlope 1 and RescaleIntercept 0, axial.
Round trip: sitk.ImageSeriesReader and register.read_protocol return the same array, spacing, origin, kernel and thickness."""
import os
import numpy as np

CT_STORAGE = "1.2.840.10008.5.1.4.1.1.2"


def new_uid(root="1.2.826.0.1.3680043.8.498"):
    import uuid
    return f"{root}.{uuid.uuid4().int}"[:64]


def _write(img_src, out_dir, **kw):
    import SimpleITK as sitk
    study_uid, series_uid, frame_uid = kw["study_uid"], kw["series_uid"], kw["frame_uid"]
    os.makedirs(out_dir, exist_ok=True)
    a = np.rint(np.clip(sitk.GetArrayFromImage(img_src), -1024, 3071)).astype(np.int16)
    img = sitk.GetImageFromArray(a)
    img.CopyInformation(img_src)
    d = np.array(img.GetDirection()).reshape(3, 3)
    iop = "\\".join(f"{v:.8f}" for v in (d[:, 0].tolist() + d[:, 1].tolist()))
    sp = img.GetSpacing()
    w = sitk.ImageFileWriter()
    w.KeepOriginalImageUIDOn()
    common = {"0008|0060": "CT", "0008|0016": CT_STORAGE, "0008|0008": "ORIGINAL\\PRIMARY\\AXIAL",
              "0008|0020": kw["study_date"], "0008|0021": kw["study_date"], "0008|0022": kw["study_date"], "0008|0023": kw["study_date"],
              "0008|0030": "120000", "0008|0031": "120100", "0008|0032": "120050", "0008|0033": "120100",
              "0008|0070": kw["manufacturer"], "0008|1090": kw["model"], "0008|103e": kw["series_description"],
              "0010|0010": "SYNTHETIC^KNOWNANSWER", "0010|0020": "SYNTHETIC-KNOWNANSWER",
              "0018|0050": f"{sp[2]:.4f}", "0018|0060": f"{kw['kvp']:.1f}", "0018|1210": kw["kernel"], "0018|5100": "HFS",
              "0020|000d": study_uid, "0020|000e": series_uid, "0020|0011": str(kw["series_number"]), "0020|0052": frame_uid,
              "0020|0037": iop, "0028|0030": f"{sp[1]:.6f}\\{sp[0]:.6f}", "0028|1052": "0", "0028|1053": "1",
              "0028|0100": "16", "0028|0101": "16", "0028|0102": "15", "0028|0103": "1", "0028|0004": "MONOCHROME2"}
    if kw["contrast"]:
        common["0018|0010"] = "SYNTHETIC-CONTRAST"
    for k in range(img.GetDepth()):
        sl = img[:, :, k]
        for tag, v in common.items():
            sl.SetMetaData(tag, v)
        pos = img.TransformIndexToPhysicalPoint((0, 0, k))
        sl.SetMetaData("0020|0032", "\\".join(f"{v:.6f}" for v in pos))
        sl.SetMetaData("0020|0013", str(k + 1))
        sl.SetMetaData("0020|1041", f"{pos[2]:.6f}")
        sl.SetMetaData("0008|0018", new_uid())
        w.SetFileName(os.path.join(out_dir, f"slice_{k + 1:04d}.dcm"))
        w.Execute(sl)
    return {"study_uid": study_uid, "series_uid": series_uid, "n_slices": img.GetDepth(), "dir": out_dir}


def write_series(img, out_dir, series_description="SYNTHETIC known-answer", kernel="Br44d", study_date="20261105", study_uid=None,
                 series_uid=None, frame_uid=None, kvp=120.0, manufacturer="SYNTHETIC", model="KNOWN-ANSWER", contrast=True, series_number=1):
    return _write(img, out_dir, series_description=series_description, kernel=kernel, study_date=study_date,
                  study_uid=study_uid or new_uid(), series_uid=series_uid or new_uid(), frame_uid=frame_uid or new_uid(), kvp=kvp,
                  manufacturer=manufacturer, model=model, contrast=contrast, series_number=series_number)
