"""Round-trip tests for synthetic_dicom.py (SimpleITK, pydicom, numpy; register.py for read_protocol)."""
import os, sys, tempfile
import numpy as np
import SimpleITK as sitk
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synthetic_dicom as SD
import register as R


def _vol():
    rng = np.random.default_rng(3)
    a = rng.integers(-1000, 400, (12, 20, 24)).astype(np.int16)
    img = sitk.GetImageFromArray(a)
    img.SetSpacing((0.8, 0.8, 1.5)); img.SetOrigin((-100.5, -60.25, 800.0)); img.SetDirection((-1, 0, 0, 0, -1, 0, 0, 0, 1))
    return a, img


def test_a_written_series_reads_back_identically_and_the_pipeline_reads_its_protocol():
    a, img = _vol()
    with tempfile.TemporaryDirectory() as td:
        info = SD.write_series(img, td, kernel="Br44d", study_date="20261105")
        assert len([f for f in os.listdir(td) if f.endswith(".dcm")]) == 12
        r = sitk.ImageSeriesReader(); ids = r.GetGDCMSeriesIDs(td); assert len(ids) == 1
        r.SetFileNames(r.GetGDCMSeriesFileNames(td, ids[0])); back = r.Execute()
        b = sitk.GetArrayFromImage(back)
        assert b.shape == a.shape and np.array_equal(b, a)
        assert np.allclose(back.GetSpacing(), img.GetSpacing(), atol=1e-4) and np.allclose(back.GetOrigin(), img.GetOrigin(), atol=1e-3)
        assert np.allclose(back.GetDirection(), img.GetDirection(), atol=1e-6)
        p = R.read_protocol(td)
        assert p["kernel"] == "Br44d" and p["n_slices"] == 12 and abs(p["slice_thickness_mm"] - 1.5) < 1e-6 and p["gaps"] == 0
        assert p["study_date"] == "20261105" and p["contrast_agent"] is True


def test_no_source_patient_attribute_is_written_only_the_synthetic_ones():
    import pydicom
    a, img = _vol()
    with tempfile.TemporaryDirectory() as td:
        SD.write_series(img, td)
        ds = pydicom.dcmread(os.path.join(td, "slice_0001.dcm"), stop_before_pixels=True)
        assert str(ds.PatientName) == "SYNTHETIC^KNOWNANSWER" and ds.PatientID == "SYNTHETIC-KNOWNANSWER"
        assert str(getattr(ds, "PatientBirthDate", "")) == "" and str(getattr(ds, "PatientSex", "")) == ""     # required attributes, left empty
        assert not hasattr(ds, "PatientWeight") and str(getattr(ds, "ReferringPhysicianName", "")) == "" and not str(getattr(ds, "InstitutionName", ""))
        assert "SYNTHETIC" in str(ds.SeriesDescription)


def test_every_series_gets_its_own_uids_unless_told_to_share_a_study():
    a, img = _vol()
    with tempfile.TemporaryDirectory() as t1, tempfile.TemporaryDirectory() as t2:
        i1, i2 = SD.write_series(img, t1), SD.write_series(img, t2)
        assert i1["study_uid"] != i2["study_uid"] and i1["series_uid"] != i2["series_uid"]
        j = SD.write_series(img, t2 + "/b", study_uid=i1["study_uid"])
        assert j["study_uid"] == i1["study_uid"] and len(i1["study_uid"]) <= 64
