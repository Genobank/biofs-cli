"""Unit tests for the pure-numpy parts of register.py (no ANTs, ITK or TotalSegmentator)."""
import sys, os
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import register as R


def rot(ax, deg):
    a = np.radians(deg); c, s = np.cos(a), np.sin(a)
    if ax == "x":
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    if ax == "y":
        return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def test_kabsch_recovers_known_rigid():
    rng = np.random.default_rng(0)
    # a curved "spine" plus an anterior point, like vertebrae plus sternum
    z = np.linspace(0, 300, 10)
    P = np.c_[np.zeros_like(z), 20 * np.sin(z / 300 * np.pi), z]
    P = np.vstack([P, [0, 90, 150]])
    Rt = rot("z", 4) @ rot("x", -3) @ rot("y", 2)
    tt = np.array([5.0, -12.0, 210.0])
    Q = P @ Rt.T + tt + rng.normal(0, 0.2, P.shape)
    Rk, tk = R.kabsch(P, Q)
    assert np.allclose(Rk, Rt, atol=5e-3), Rk
    assert np.allclose(tk, tt, atol=0.6), tk
    assert abs(R.rotation_deg(Rk) - R.rotation_deg(Rt)) < 0.2


def test_robust_rigid_drops_a_mislabeled_point():
    z = np.linspace(0, 300, 10)
    P = np.c_[np.zeros_like(z), 20 * np.sin(z / 300 * np.pi), z]
    P = np.vstack([P, [0, 90, 150]])
    Rt = rot("x", 5); tt = np.array([1.0, 2.0, 3.0])
    Q = P @ Rt.T + tt
    Q[3] += np.array([0, 0, 22.0])            # one vertebra labeled a level off
    ids = list(range(len(P)))
    Rk, tk, res, kept = R.robust_rigid(P, Q, ids)
    assert 3 not in kept, kept
    assert np.allclose(Rk, Rt, atol=1e-6) and np.allclose(tk, tt, atol=1e-6)
    assert res[3] > 20 and np.max(np.delete(res, 3)) < 1e-6


def test_kabsch_never_reflects():
    P = np.array([[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10.0]])
    Q = P * np.array([-1, 1, 1])               # a mirror image
    Rk, _ = R.kabsch(P, Q)
    assert np.linalg.det(Rk) > 0.99


def sphere(shape, c, r):
    zz, yy, xx = np.indices(shape)
    return ((zz - c[0]) ** 2 + (yy - c[1]) ** 2 + (xx - c[2]) ** 2) <= r * r


def test_region_surface_identical_and_shifted():
    shape = (80, 80, 80)
    a = sphere(shape, (40, 40, 40), 20).astype(np.int16) * 7
    sp = np.array([1.0, 1.0, 1.0])
    same = R.region_surface(a, a.copy(), [7], sp, (5, 74))
    assert same["assd_mm"] == 0 and same["hd95_mm"] == 0 and same["dice"] == 1.0
    b = sphere(shape, (40, 40, 44), 20).astype(np.int16) * 7     # 4 mm lateral shift
    s = R.region_surface(a, b, [7], sp, (5, 74))
    assert 1.0 < s["assd_mm"] < 3.0, s
    assert 3.0 <= s["hd95_mm"] <= 4.5, s
    # spacing is honored per axis: a 4-voxel shift along x is 8 mm when x voxels are 2 mm,
    # and still 4 mm when only the z voxels are 2 mm
    s2 = R.region_surface(a, b, [7], np.array([1.0, 1.0, 2.0]), (5, 74))
    assert s2["max_mm"] == 8.0 and s2["hd95_mm"] > 1.5 * s["hd95_mm"], s2
    s3 = R.region_surface(a, b, [7], np.array([2.0, 1.0, 1.0]), (5, 74))
    assert s3["max_mm"] == 4.0, s3


def test_region_surface_ignores_cut_faces():
    # a long cylinder cut by the window: the cut faces must not count as surface
    shape = (100, 40, 40)
    zz, yy, xx = np.indices(shape)
    cyl = (((yy - 20) ** 2 + (xx - 20) ** 2) <= 64).astype(np.int16) * 3
    s = R.region_surface(cyl, cyl.copy(), [3], np.ones(3), (10, 89))
    assert s["assd_mm"] == 0
    # the moving cylinder ends 15 slices early inside the window: that is real disagreement
    short = cyl.copy(); short[75:] = 0
    s2 = R.region_surface(cyl, short, [3], np.ones(3), (10, 89))
    assert s2["hd95_mm"] > 3, s2


def test_consistent_landmarks_rules():
    ft = {1: {"n": 1000, "height_mm": 40.0, "edge": False, "phys": np.zeros(3)},
          2: {"n": 1000, "height_mm": 40.0, "edge": True, "phys": np.zeros(3)},
          3: {"n": 1000, "height_mm": 40.0, "edge": False, "phys": np.zeros(3)},
          4: {"n": 1000, "height_mm": 40.0, "edge": False, "phys": np.zeros(3)},
          5: {"n": 1000, "height_mm": 40.0, "edge": False, "phys": np.zeros(3)}}
    mt = {1: {"n": 1050, "height_mm": 41.0, "edge": False, "phys": np.zeros(3)},
          2: {"n": 1000, "height_mm": 40.0, "edge": False, "phys": np.zeros(3)},
          3: {"n": 740, "height_mm": 40.0, "edge": False, "phys": np.zeros(3)},
          4: {"n": 1000, "height_mm": 60.0, "edge": False, "phys": np.zeros(3)}}
    ok, why = R.consistent_landmarks(ft, mt, [1, 2, 3, 4, 5])
    assert ok == [1], (ok, why)
    assert "cut" in why[2] and "volume" in why[3] and "height" in why[4] and 5 not in why


def test_component_centroids_uses_largest_component():
    arr = np.zeros((60, 60, 60), np.int16)
    arr[20:30, 20:30, 20:30] = 9                 # main body, centroid (24.5, 24.5, 24.5)
    arr[55:57, 55:57, 55:57] = 9                 # a stray fragment far away
    c = R.component_centroids(arr, [9])[9]
    assert np.allclose(c, [24.5, 24.5, 24.5]), c


def test_evaluate_gate():
    m = {"rigid": {"spine_assd_mm": 2.5},
         "deformable": {"spine_assd_mm": 0.6, "spine_hd95_mm": 2.0, "lung_dice_min": 0.97, "lung_assd_max_mm": 0.8,
                        "lung_hd95_max_mm": 3.0, "jacobian_fold_fraction": 0.0, "vertebra_tre_median_mm": 1.0,
                        "heart_dice": 0.9, "medium_structure_dice_min": 0.85, "esophagus_dice": 0.7,
                        "jacobian_p01": 0.6, "jacobian_p99": 1.5, "bone_abs_logjac_p95": 0.1}}
    v, checks, hard, soft = R.evaluate_gate(m, {"dice_median": 0.95})
    assert v == "PASS_WITH_WARNINGS" and not hard and len(soft) == 1 and "rigid.spine_assd_mm" in soft[0]
    m["deformable"]["lung_hd95_max_mm"] = 16.0
    v, _, hard, _ = R.evaluate_gate(m, None)
    assert v == "FAIL" and any("lung_hd95_max_mm" in h for h in hard)
    m["deformable"]["lung_hd95_max_mm"] = None   # not computed (no lungs in view): never a pass, never a fail
    v, checks, hard, _ = R.evaluate_gate(m, None)
    assert not any("lung_hd95" in h for h in hard)
    assert [c for c in checks if c["metric"] == "lung_hd95_max_mm"][0]["pass"] is None


def test_gates_for_anatomy():
    chest = {(s, m): sev for s, m, _, _, sev, _ in R.gates_for("chest")}
    abd = {(s, m): sev for s, m, _, _, sev, _ in R.gates_for("abdomen")}
    assert chest[("deformable", "lung_hd95_max_mm")] == "hard" and chest[("deformable", "abdominal_organ_hd95_max_mm")] == "soft"
    assert abd[("deformable", "lung_hd95_max_mm")] == "soft" and abd[("deformable", "abdominal_organ_hd95_max_mm")] == "hard"
    assert chest[("deformable", "spine_assd_mm")] == abd[("deformable", "spine_assd_mm")] == "hard"
    m = {"deformable": {"abdominal_organ_hd95_max_mm": 9.0}}
    assert R.evaluate_gate(m, None, R.gates_for("chest"))[0] != "FAIL"
    assert R.evaluate_gate(m, None, R.gates_for("abdomen"))[0] == "FAIL"


def test_stage_metrics_reports_lungs_and_organs():
    shape = (90, 90, 90)
    ref = np.zeros(shape, np.int16)
    ref[sphere(shape, (60, 30, 30), 14)] = 10        # left lung
    ref[sphere(shape, (60, 30, 62), 14)] = 11        # right lung
    ref[sphere(shape, (25, 40, 60), 13)] = 20        # liver
    ref[sphere(shape, (25, 40, 22), 8)] = 21         # spleen
    zz, yy, xx = np.indices(shape)
    ref[((yy - 70) ** 2 + (xx - 45) ** 2 <= 16) & (zz >= 5) & (zz <= 84)] = 30   # spine
    warped = ref.copy()
    warped[warped == 20] = 0
    warped[sphere(shape, (31, 40, 60), 13) & (warped == 0)] = 20   # liver 6 voxels higher
    groups = {"vertebrae": [30], "lung_left": [10], "lung_right": [11], "liver": [20], "spleen": [21],
              "medium": [], "esophagus": [], "heart_id": None}
    names = {10: "lung_upper_lobe_left", 11: "lung_upper_lobe_right", 20: "liver", 21: "spleen", 30: "vertebrae_T10"}
    m = R.stage_metrics(ref, warped, np.ones(shape, bool), names, groups, np.ones(3), [], (3, 86))
    assert m["lung_hd95_max_mm"] == 0 and m["lung_dice_min"] == 1.0
    assert m["spine_assd_mm"] == 0
    assert m["abdominal_organs"]["spleen"]["assd_mm"] == 0
    assert m["abdominal_organ_hd95_max_mm"] >= 5, m["abdominal_organs"]


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for f in fns:
        f(); print("ok", f.__name__)
    print(f"{len(fns)} passed")
