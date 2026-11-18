"""Tests for lung_volume.py (numpy only). Synthetic chests: two ellipsoid lungs in soft tissue."""
import os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lung_volume as LV

GROUPS = {"lung_left": [1, 2], "lung_right": [3, 4],
          "lobes": {"lung_upper_lobe_left": [1], "lung_lower_lobe_left": [2],
                    "lung_upper_lobe_right": [3], "lung_lower_lobe_right": [4]}}


def chest(sl=1.0, sr=1.0, hu_l=-850.0, hu_r=-850.0, consolidate_lower=0.0, shape=(90, 90, 130)):
    """Lungs centred at x=38 (left) and x=92 (right); the lower half of each is label 2 or 4.
    `s*` scales the radii (a deeper breath), `hu_*` is the lung density, `consolidate_lower` turns that
    share of the lower lobes into soft tissue density while the label stays (a lobe filling up)."""
    ct = np.full(shape, 40.0, np.float32)
    lab = np.zeros(shape, np.int16)
    zz, yy, xx = np.indices(shape)
    for cx, s, hu, ids in ((38, sl, hu_l, (1, 2)), (92, sr, hu_r, (3, 4))):
        inside = ((zz - 45) / (30.0 * s)) ** 2 + ((yy - 45) / (25.0 * s)) ** 2 + ((xx - cx) / (22.0 * s)) ** 2 <= 1
        ct[inside] = hu
        lab[inside & (zz >= 45)] = ids[0]
        lab[inside & (zz < 45)] = ids[1]
        if consolidate_lower:
            cut = 45 - (30.0 * s) * (1.0 - consolidate_lower)     # the lower lobe spans z 15 to 45
            ct[inside & (zz < cut)] = -100.0
    return ct, lab


def report(ct_lab):
    return LV.lung_report(ct_lab[0], ct_lab[1], (1.0, 1.0, 1.0), GROUPS)


def test_a_deeper_breath_changes_volume_but_not_aerated_mass():
    a = chest()
    # 12 percent larger radii is 40 percent more volume; the same tissue spread over it is 1/1.405 as dense
    rho = 0.15 / (1.12 ** 3)
    b = chest(sl=1.12, sr=1.12, hu_l=-1000 + 1000 * rho, hu_r=-1000 + 1000 * rho)
    c = LV.compare_lung_volume(report(a), report(b))
    assert c["computed"] and c["delta_volume_frac"] > 0.3, c["delta_volume_frac"]
    assert abs(c["delta_aerated_mass_frac"]) < 0.05, c["delta_aerated_mass_frac"]
    assert c["explained_by"] == "breath_depth" and c["real_change_supported"] is False, c["explanation"]


def test_a_lobe_that_fills_changes_the_mass_and_is_not_the_breath():
    a = chest()
    b = chest(consolidate_lower=0.8)       # the lower 80 percent of the lower lobes turns to soft tissue
    c = LV.compare_lung_volume(report(a), report(b))
    assert c["real_change_supported"] is True and c["explained_by"] == "tissue_or_one_sided_change"
    assert c["delta_aerated_mass_frac"] < -0.2, c["delta_aerated_mass_frac"]
    assert c["lobes_by_change"][0]["lobe"].endswith("lower_lobe_left") or c["lobes_by_change"][0]["lobe"].endswith("lower_lobe_right")
    assert "Not explained by the breath" in c["explanation"]


def test_one_lung_changing_alone_is_not_the_breath_even_when_total_mass_holds():
    a = chest()
    s = 0.85                                 # left lung 38.6 percent smaller, same tissue, so 1/0.614 as light
    b = chest(sl=s, hu_l=-1000 + 1000 * (0.15 / s ** 3))
    c = LV.compare_lung_volume(report(a), report(b))
    assert abs(c["delta_aerated_mass_frac"]) < 0.10, c["delta_aerated_mass_frac"]
    assert c["left_right_asymmetry"] > 0.30 and c["real_change_supported"] is True
    assert "left lung changed" in c["explanation"] and "right by" in c["explanation"]


def test_no_change_reads_as_no_meaningful_change():
    a = chest()
    c = LV.compare_lung_volume(report(a), report(chest()))
    assert c["explained_by"] == "no_meaningful_change" and c["real_change_supported"] is False
    assert c["delta_volume_frac"] == 0.0 and c["delta_aerated_mass_frac"] == 0.0


def test_a_missing_lung_is_missing_evidence_not_a_finding():
    a = chest()
    ct, lab = chest()
    lab[lab == 3] = 0; lab[lab == 4] = 0; lab[lab == 1] = 0; lab[lab == 2] = 0     # no lung label at all
    c = LV.compare_lung_volume(report(a), report((ct, lab)))
    assert c["computed"] is False and c["real_change_supported"] is False and c["explained_by"] == "not_computed"


def test_grids_must_match():
    ct, lab = chest()
    try:
        LV.lung_report(ct, lab[:-1], (1.0, 1.0, 1.0), GROUPS)
    except ValueError as e:
        assert "one grid" in str(e)
    else:
        raise AssertionError("a CT and a label map on different grids were accepted")


def test_parameters_are_declared_provisional():
    assert "provisional" in LV.LUNG_CHANGE_PARAMS["status"] and "calibrate" in LV.LUNG_CHANGE_PARAMS["status"]


def test_a_mass_change_between_scans_with_different_reconstructions_is_not_read_as_disease():
    a = chest()
    b = chest(consolidate_lower=0.8)               # a real 25 percent loss of aerated mass
    why = "kernel family Br44 vs B30"
    flagged = LV.compare_lung_volume(report(a), report(b))
    assert flagged["real_change_supported"] is True and flagged["mass_comparable"] is True
    held = LV.compare_lung_volume(report(a), report(b), mass_comparable=False, mass_withheld_reason=why)
    assert held["real_change_supported"] is False and held["mass_comparable"] is False
    assert held["delta_aerated_mass_frac"] < -0.2                          # still reported
    assert "not compared" in held["explanation"] and why in held["explanation"]


def test_one_lung_changing_alone_still_flags_when_the_mass_is_withheld():
    a = chest()
    s = 0.85
    b = chest(sl=s, hu_l=-1000 + 1000 * (0.15 / s ** 3))
    c = LV.compare_lung_volume(report(a), report(b), mass_comparable=False, mass_withheld_reason="slice thickness 1.25 vs 5 mm")
    assert c["real_change_supported"] is True and c["explained_by"] == "tissue_or_one_sided_change", c["explanation"]


def test_a_symmetric_volume_change_with_the_mass_withheld_is_named_for_what_it_is():
    a = chest()
    rho = 0.15 / (1.12 ** 3)
    b = chest(sl=1.12, sr=1.12, hu_l=-1000 + 1000 * rho, hu_r=-1000 + 1000 * rho)
    c = LV.compare_lung_volume(report(a), report(b), mass_comparable=False, mass_withheld_reason="contrast vs non-contrast")
    assert c["explained_by"] == "volume_change_mass_not_comparable" and c["real_change_supported"] is False


def test_a_reconstruction_variant_caveat_travels_with_the_explanation():
    a = chest()
    c = LV.compare_lung_volume(report(a), report(chest(sl=1.12, sr=1.12, hu_l=-880, hu_r=-880)),
                               mass_caveat="reconstruction variant f vs d (noise texture differs)")
    assert "reconstruction variant f vs d" in c["explanation"] and c["mass_caveat"]


def _cut_top(ct_lab, keep=60):
    """The same scan with the volume cropped so the lungs run to the last slice (an abdomen scan that starts partway up the chest)."""
    ct, lab = ct_lab
    return ct[:keep].copy(), lab[:keep].copy()


def test_lungs_cut_by_the_scanned_range_are_not_assessable_and_never_explained():
    a, b = chest(), _cut_top(chest(sl=1.12, sr=1.12), keep=60)
    ra, rb = report(a), report(b)
    assert ra["coverage"]["cut_first_slice"] is False and ra["coverage"]["cut_last_slice"] is False
    assert rb["coverage"]["cut_last_slice"] is True and rb["coverage"]["extent_z_mm"] < ra["coverage"]["extent_z_mm"]
    c = LV.compare_lung_volume(ra, rb)
    assert c["computed"] is False and c["real_change_supported"] is False and c["explained_by"] == "not_assessable_lungs_cut", c
    assert "moving" in c["explanation"] and "cuts the lungs" in c["explanation"]
    c2 = LV.compare_lung_volume(rb, ra)              # either side
    assert c2["explained_by"] == "not_assessable_lungs_cut" and "reference" in c2["explanation"]


def test_two_scans_cut_at_different_levels_are_not_compared_even_when_their_volumes_agree():
    a, b = _cut_top(chest(), keep=60), _cut_top(chest(), keep=60)
    c = LV.compare_lung_volume(report(a), report(b))
    assert c["computed"] is False and c["explained_by"] == "not_assessable_lungs_cut"


def test_coverage_is_a_presence_test_on_area_not_a_voxel_count_and_a_complete_chest_is_unaffected():
    a = chest()
    r = report(a)
    assert r["coverage"]["first_slices_lung_area_mm2"] == 0.0 and r["coverage"]["last_slices_lung_area_mm2"] == 0.0
    c = LV.compare_lung_volume(r, report(chest(sl=1.1, sr=1.1)))
    assert c["computed"] is True and "coverage" not in c
    # anisotropic voxels: the area uses the in-plane spacing, a thin sliver under 3 cm2 at the edge does not count as cut
    ct, lab = chest()
    lab2 = lab.copy(); lab2[-1, 40:44, 30:40] = 1       # 40 voxels at 1 mm = 40 mm2
    assert LV.lung_report(ct, lab2, (1.0, 1.0, 1.0), GROUPS)["coverage"]["cut_last_slice"] is False
    assert LV.lung_report(ct, lab2, (1.0, 2.0, 2.0), GROUPS)["coverage"]["last_slices_lung_area_mm2"] == 160.0


def test_an_older_report_without_coverage_is_compared_as_before():
    a, b = chest(), chest(sl=1.1, sr=1.1)
    ra, rb = report(a), report(b)
    ra.pop("coverage"); rb.pop("coverage")
    assert LV.compare_lung_volume(ra, rb)["computed"] is True
