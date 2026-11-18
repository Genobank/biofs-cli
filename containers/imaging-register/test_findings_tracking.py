"""The baseline lesion id must survive tracking (findings_runner.analyze_interval with LesionLocator).
The fake tracker behaves like the real one on the detector known-answer test (2026-11-05): whatever the prompt, it returns ONE binary mask
(label 1) holding the follow-up of every lesion in the prompt. Run: FINDINGS_DIR=<dir> python3 test_findings_tracking.py"""
import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.environ.get("FINDINGS_DIR", "/Users/danieluribe/Downloads/biofs-cli/containers/imaging-findings"))
import SimpleITK as sitk
import findings_runner as FR
import known_answer_findings as KF

L = KF.CLASS_LUNG
BASE = [KF.sphere(L, 20, (40.0, 40.0, 40.0), "a"), KF.sphere(L, 16, (80.0, 80.0, 40.0), "b"), KF.sphere(L, 14, (120.0, 120.0, 40.0), "c")]
FU = [KF.sphere(L, 12, (40.0, 40.0, 40.0), "a"), KF.sphere(L, 10, (80.0, 80.0, 40.0), "b")]       # c is gone


def fake_lesionlocator_track(baseline_nii, followup_nii, prompt_path, outdir):
    from scipy import ndimage
    os.makedirs(outdir, exist_ok=True)
    prompt = sitk.ReadImage(prompt_path); pa = sitk.GetArrayFromImage(prompt) > 0
    lab, n = ndimage.label(pa)
    out = np.zeros(pa.shape, np.uint8)
    for i in range(1, n + 1):
        cz, cy, cx = ndimage.center_of_mass(lab == i)
        base = min(BASE, key=lambda s: np.linalg.norm(np.array(s["c"]) - np.array([cx, cy, cz])))
        fu = next((s for s in FU if s["key"] == base["key"]), None)
        if fu is not None:
            out |= (sitk.GetArrayFromImage(KF.make_seg([fu], KF.SPACINGS["A"])) > 0).astype(np.uint8)
    img = sitk.GetImageFromArray(out); img.CopyInformation(prompt)
    p = os.path.join(outdir, "tracked.nii.gz"); sitk.WriteImage(img, p)
    return p


class TrackingIdentity(unittest.TestCase):
    def test_each_baseline_lesion_keeps_its_own_follow_up(self):
        FR.TUMOR_USED = [L]
        FR.lesionlocator_track = fake_lesionlocator_track
        wd = tempfile.mkdtemp()
        b, f = KF.make_seg(BASE, KF.SPACINGS["A"]), KF.make_seg(FU, KF.SPACINGS["A"])
        findings, tracker, nb, nf = FR.analyze_interval("b", "f", b, f, "b.nii", "f.nii", b.GetSpacing(), wd, [0, 90], prefix=None)
        self.assertEqual(tracker, "LesionLocator")
        by = {round(x["baseline_long_axis_mm"]): x for x in findings}
        self.assertEqual(sorted(x["status"] for x in findings), ["resolved", "shrunk", "shrunk"], [(x["status"], x["baseline_long_axis_mm"], x["followup_long_axis_mm"]) for x in findings])
        a = [x for x in findings if x["baseline_long_axis_mm"] > 20][0]            # the 20 mm lesion
        self.assertEqual(a["status"], "shrunk")
        self.assertTrue(10.0 <= a["followup_long_axis_mm"] <= 14.0, a)
        c = [x for x in findings if 14.0 < x["baseline_long_axis_mm"] < 16.5][0]    # the 14 mm lesion
        self.assertEqual(c["status"], "resolved")

    def test_a_failed_call_sends_every_lesion_to_the_overlap_fallback(self):
        FR.TUMOR_USED = [L]
        FR.lesionlocator_track = lambda *a, **k: None
        wd = tempfile.mkdtemp()
        b, f = KF.make_seg(BASE, KF.SPACINGS["A"]), KF.make_seg(FU, KF.SPACINGS["A"])
        findings, tracker, nb, nf = FR.analyze_interval("b", "f", b, f, "b.nii", "f.nii", b.GetSpacing(), wd, [0, 90], prefix=None)
        self.assertEqual(tracker, "overlap_fallback")


if __name__ == "__main__":
    unittest.main(verbosity=2)
