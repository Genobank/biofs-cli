"""Regression tests for the lesions verb logic (imaging_lesion_track_runner.py), from lesion_track_criteria-20261105.txt.
Run: python3 test_lesion_track.py   (needs numpy, scipy, SimpleITK, scikit-image; VISTA3D_DIR overrides the runner folder)"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.environ.get("VISTA3D_DIR", "/Users/danieluribe/Downloads/biofs-cli/containers/imaging-vista3d"))
import imaging_lesion_track_runner as LR
import known_answer_findings as KF
import known_answer_lesion_track as KT


class LesionTrack(unittest.TestCase):
    def test_new_lesion_beats_complete_response_and_5mm_rule(self):
        self.assertEqual(LR.recist_category(1, 15.0, 0.0, 15.0, 1)[0], "PD")
        self.assertEqual(LR.recist_category(1, 15.0, 0.0, 15.0, 0)[0], "CR")
        self.assertEqual(LR.recist_category(1, 12.0, 16.0, 12.0, 0)[0], "SD")
        self.assertEqual(LR.recist_category(1, 12.0, 17.0, 12.0, 0)[0], "PD")

    def test_split_and_merge_are_tagged(self):
        sm = KT.split_merge(LR)
        self.assertTrue(sm["T4_split_tagged"])
        self.assertTrue(sm["T4_merge_tagged"])

    def test_overlapping_stable_lesion_is_one_track(self):
        for d, s in ((12, 4), (12, 8), (20, 10)):
            per = []
            for k in (0, 1):
                c, sp = KT.comps(LR, [KF.sphere(KF.CLASS_LUNG, d, (40.0 + (s if k else 0), 80.0, 40.0), "a")], KF.SPACINGS["A"])
                per.append(c)
            self.assertTrue(any(len(t["members"]) == 2 for t in LR.link_tracks(per, sp)))

    def test_volume_within_10_percent_on_fine_grids(self):
        for r in KT.volume_and_axis(LR):
            if r["spacing"] in ("A", "B"):
                self.assertTrue(r["t1_ok"], r)


if __name__ == "__main__":
    unittest.main(verbosity=2)
