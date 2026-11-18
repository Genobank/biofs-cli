"""Unit tests of recist_for_interval (findings_runner.py): RECIST 1.1 rules as stated in lesion_logic_criteria-20261105.txt.
Run: FINDINGS_DIR=<dir with findings_runner.py> python3 test_findings_recist.py"""
import os
import sys
import unittest

sys.path.insert(0, os.environ.get("FINDINGS_DIR", "/Users/danieluribe/Downloads/biofs-cli/containers/imaging-findings"))
import findings_runner as FR


def f(organ, base, fu, new=False):
    status = "new" if new else ("resolved" if fu == 0 else "stable")
    return {"organ": organ, "baseline_long_axis_mm": 0.0 if new else base, "followup_long_axis_mm": fu, "measurable": (fu if new else base) >= 10.0,
            "new_lesion": new, "status": status}


def cat(findings):
    return FR.recist_for_interval(findings, True, True, "naive")["category"]


class RecistRules(unittest.TestCase):
    def test_rise_needs_5_mm_as_well_as_20_percent(self):
        self.assertEqual(cat([f("lung", 12.0, 16.0)]), "SD")          # +33%, +4 mm
        self.assertEqual(cat([f("lung", 12.0, 17.0)]), "PD")          # +42%, +5 mm
        self.assertEqual(cat([f("lung", 40.0, 47.0)]), "SD")          # +7 mm but +17.5%
        self.assertEqual(cat([f("lung", 40.0, 48.0)]), "PD")          # +8 mm and +20%

    def test_new_lesion_beats_complete_response(self):
        self.assertEqual(cat([f("lung", 15.0, 0.0), f("liver", 0.0, 12.0, new=True)]), "PD")
        self.assertEqual(cat([f("lung", 15.0, 0.0)]), "CR")

    def test_partial_response_and_stable(self):
        self.assertEqual(cat([f("lung", 20.0, 12.0)]), "PR")           # -40%
        self.assertEqual(cat([f("lung", 20.0, 15.0)]), "SD")           # -25%
        self.assertEqual(cat([]), "no-target")

    def test_new_lesion_under_10_mm_is_not_progression(self):
        self.assertEqual(cat([f("lung", 15.0, 15.0), f("liver", 0.0, 8.0, new=True)]), "SD")

    def test_targets_are_5_in_all_and_2_per_organ(self):
        les = [f("lung", 20.0, 20.0), f("lung", 18.0, 18.0), f("lung", 16.0, 16.0), f("lung", 14.0, 14.0),
               f("liver", 12.0, 12.0), f("liver", 11.0, 11.0), f("liver", 10.0, 10.0)]
        r = FR.recist_for_interval(les, True, True, "naive")
        self.assertEqual(r["target_lesion_count"], 4)
        self.assertEqual(r["baseline_sld_mm"], 61.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
