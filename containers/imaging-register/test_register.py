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
    # Missing evidence is never a pass. A hard check that was not computed closes the verdict.
    m["deformable"]["lung_hd95_max_mm"] = None
    v, checks, hard, _ = R.evaluate_gate(m, None)
    assert v == "FAIL" and any("lung_hd95_max_mm not computed" in h for h in hard)
    c = [c for c in checks if c["metric"] == "lung_hd95_max_mm"][0]
    assert c["pass"] is None and c["incomplete_hard_check"] is True


def test_missing_evidence_is_never_a_pass():
    # the job ran, every metric came back empty: the old gate called this PASS
    v, checks, hard, _ = R.evaluate_gate({}, None, R.gates_for("chest"))
    assert v == "FAIL" and len(hard) >= 6
    v, _, hard, _ = R.evaluate_gate({}, None, R.gates_for("abdomen"))
    assert v == "FAIL" and any("abdominal_organ" in h for h in hard)
    # a soft metric that could not be computed does not move the verdict
    full = {"rigid": {"spine_assd_mm": 1.0},
            "deformable": {"spine_assd_mm": 0.6, "spine_hd95_mm": 2.0, "lung_dice_min": 0.97, "lung_assd_max_mm": 0.8,
                           "lung_hd95_max_mm": 3.0, "jacobian_fold_fraction": 0.0}}
    v, checks, hard, soft = R.evaluate_gate(full, None, R.gates_for("chest"))
    assert v == "PASS" and not hard and not soft
    assert any(c["pass"] is None and c["severity"] == "soft" for c in checks)


def test_a_lung_missing_from_the_warped_labels_withholds_the_lung_metrics():
    shape = (90, 90, 90)
    ref = np.zeros(shape, np.int16)
    ref[sphere(shape, (60, 30, 30), 14)] = 10
    ref[sphere(shape, (60, 30, 62), 14)] = 11
    zz, yy, xx = np.indices(shape)
    ref[((yy - 70) ** 2 + (xx - 45) ** 2 <= 16) & (zz >= 5) & (zz <= 84)] = 30
    warped = ref.copy()
    warped[warped == 11] = 0                      # the right lung is gone from the warped labels
    groups = {"vertebrae": [30], "lung_left": [10], "lung_right": [11], "liver": [], "spleen": [],
              "medium": [], "esophagus": [], "heart_id": None}
    names = {10: "lung_upper_lobe_left", 11: "lung_upper_lobe_right", 30: "vertebrae_T10"}
    m = R.stage_metrics(ref, warped, np.ones(shape, bool), names, groups, np.ones(3), [], (3, 86))
    assert m["lung_sides_missing"] == ["lung_right"]
    assert m["lung_dice_min"] is None and m["lung_hd95_max_mm"] is None   # not the surviving lung alone
    v, _, hard, _ = R.evaluate_gate({"deformable": {**m, "jacobian_fold_fraction": 0.0}}, None, R.gates_for("chest"))
    assert v == "FAIL" and any("lung_dice_min" in h for h in hard)


def test_image_agreement_is_label_free_and_reports_a_shift():
    rng = np.random.default_rng(3)
    ct = rng.normal(-300, 150, (40, 40, 40)).astype(np.float32)
    ct = np.clip(__import__("scipy.ndimage", fromlist=["x"]).gaussian_filter(ct, 1.5), -1000, 400)
    mask = np.ones(ct.shape, bool); valid = np.ones(ct.shape, bool)
    assert R.image_agreement(ct, ct, mask, valid, (2, 37)) == 1.0
    shifted = np.roll(ct, 3, axis=1)
    assert R.image_agreement(ct, shifted, mask, valid, (2, 37)) < 0.9
    assert R.image_agreement(ct, ct, np.zeros_like(mask), valid, (2, 37)) is None   # too few voxels
    assert R.image_agreement(np.zeros_like(ct), ct, mask, valid, (2, 37)) is None   # flat image


def test_gates_for_anatomy():
    chest = {(s, m): sev for s, m, _, _, sev, _ in R.gates_for("chest")}
    abd = {(s, m): sev for s, m, _, _, sev, _ in R.gates_for("abdomen")}
    assert chest[("deformable", "lung_hd95_max_mm")] == "hard" and chest[("deformable", "abdominal_organ_hd95_max_mm_corresponding")] == "soft"
    assert abd[("deformable", "lung_hd95_max_mm")] == "soft" and abd[("deformable", "abdominal_organ_hd95_max_mm_corresponding")] == "hard"
    assert chest[("deformable", "body_surface_hd95_mm")] == "soft"
    assert chest[("deformable", "spine_assd_mm")] == abd[("deformable", "spine_assd_mm")] == "hard"
    base = {"spine_assd_mm": 0.6, "spine_hd95_mm": 2.0, "lung_dice_min": 0.97, "lung_assd_max_mm": 0.8,
            "lung_hd95_max_mm": 3.0, "jacobian_fold_fraction": 0.0}
    m = {"deformable": {**base, "abdominal_organ_hd95_max_mm_corresponding": 9.0,
                        "abdominal_organ_assd_max_mm_corresponding": 1.0}}
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


def test_corresponding_liver_leaves_out_bowel():
    shape = (40, 40, 40)
    ref = np.zeros(shape, np.int16)
    ref[8:32, 8:32, 8:32] = 5
    warped = ref.copy()
    warped[8:32, 8:14, 8:32] = 20
    groups = {"vertebrae": [], "lung_left": [], "lung_right": [], "liver": [5], "spleen": [],
              "medium": [], "esophagus": [], "heart_id": None, "bowel": [20]}
    names = {5: "liver", 20: "colon"}
    m = R.stage_metrics(ref, warped, np.ones(shape, bool), names, groups, np.ones(3), [], (2, 37))
    assert m["abdominal_organ_bowel_interposition_ml"]["liver"] > 0
    assert m["abdominal_organ_hd95_max_mm"] > m["abdominal_organ_hd95_max_mm_corresponding"]


def test_cross_protocol_skin_warning_keeps_the_threshold():
    m = {"deformable": {"body_surface_hd95_mm": 7.0, "body_surface_assd_mm": 1.4,
                        "spine_assd_mm": 0.6, "spine_hd95_mm": 2.0, "lung_dice_min": 0.97, "lung_assd_max_mm": 0.8,
                        "lung_hd95_max_mm": 3.0, "jacobian_fold_fraction": 0.0}}
    v, checks, hard, soft = R.evaluate_gate(m, None, R.gates_for("chest"), protocol_mode="cross")
    assert v == "PASS_WITH_WARNINGS" and not hard
    skin = [c for c in checks if c["metric"] == "body_surface_hd95_mm"][0]
    assert skin["pass"] is False and skin["threshold"] == 5.0
    assert skin["context"] == "cross_protocol_rim_expected"
    assert skin["measured_on"] == "resampled_ct_body_outline"
    assert "threshold unchanged" in soft[0]
    same = R.evaluate_gate(m, None, R.gates_for("chest"), protocol_mode="same")[1]
    assert "context" not in [c for c in same if c["metric"] == "body_surface_hd95_mm"][0]


def test_far_surface_names_the_side_in_index_axes():
    shape = (80, 80, 80)
    a = sphere(shape, (40, 40, 40), 18).astype(np.int16) * 7
    b = sphere(shape, (40, 40, 48), 18).astype(np.int16) * 7   # +8 mm along axis 2
    s = R.region_surface(a, b, [7], np.ones(3), (5, 74), far_mm=6.0)
    far = s["far_surface"]
    assert far["n"] > 0 and far["fraction_positive_axis2"] < 0.4, far
    assert far["fraction_positive_axis2"] < far["fraction_positive_axis0"]
    assert "anatomical" in far["axes"]


def test_blend_ramps_and_labels_stay_hard():
    body = np.zeros((1, 1, 21), np.float32)
    region = np.full((1, 1, 21), 10.0, np.float32)
    sel = np.zeros((1, 1, 21), dtype=bool)
    sel[:, :, 10:] = True
    mixed = R.blend_piecewise(body, [(region, sel)], (1, 1, 1), 4.0, hard=False)
    line = mixed[0, 0]
    assert line[0] == 0.0 and line[-1] == 10.0
    assert line[9] < 5.0 < line[10], line[8:13]
    assert all(line[i] <= line[i + 1] + 1e-5 for i in range(20))
    hard = R.blend_piecewise(body, [(region, sel)], (1, 1, 1), 4.0, hard=True)
    assert set(np.unique(hard)) == {0.0, 10.0}


def test_detach_fused_table_removes_a_slab_and_keeps_anatomy():
    body = np.zeros((100, 80, 80), np.uint8)
    body[20:90, 25:70, 20:70] = 1
    body[10:95, 2:6, 5:90] = 1                  # thin slab, 4 mm, 85 by 85 mm
    body[48:52, 6:25, 40:44] = 1                # 4 mm bridge
    cleaned, report = R.detach_fused_table(body, (1, 1, 1), bridge_mm=8.0, min_slab_ml=5.0)
    assert report["table_detached_ml"] > 5, report
    assert cleaned[30, 4, 40] == 0 and cleaned[40, 40, 40] == 1
    wide = body.copy()
    wide[20:90, 6:25, 20:60] = 1                # neck too wide to be a bridge
    kept, report2 = R.detach_fused_table(wide, (1, 1, 1), bridge_mm=8.0, min_slab_ml=5.0)
    assert report2["table_detached_ml"] == 0.0
    assert kept.sum() == wide.sum()


def test_leg_report_names_the_weak_hop():
    trans = {"dice_by_target": {"spine": 0.97, "liver": 0.91}}
    pairs = [
        {"pair": "oct_to_mar", "metrics": {"deformable": {"dice_by_structure": {"liver": 0.95}, "spine_dice": 0.99}}},
        {"pair": "jan_to_mar", "metrics": {"deformable": {"dice_by_structure": {"liver": 0.90}, "spine_dice": 0.98}}},
    ]
    out = R.leg_report(trans, pairs)
    assert out["weakest_target"]["structure"] == "liver"
    assert out["weakest_leg"]["pair"] == "jan_to_mar"
    assert out["weakest_leg"]["pair_dice"] == 0.90


def test_engine_identity_hashes_this_file():
    ident = R.engine_identity()
    assert len(ident["engine_sha256"]) == 64
    assert ident["frame_contract_sha256"] is None or len(ident["frame_contract_sha256"]) == 64


def test_qc_panel_body_mask_is_assigned_in_register_pair():
    """ref_body inside ct_body_surface is not visible to the QC panel."""
    import ast, inspect
    tree = ast.parse(inspect.getsource(R.register_pair))
    stores, loads = [], []
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id == "ref_body":
            (stores if isinstance(node.ctx, ast.Store) else loads).append(node.lineno)
    assert stores, "register_pair never assigns ref_body"
    assert loads and min(stores) < min(loads)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for f in fns:
        f(); print("ok", f.__name__)
    print(f"{len(fns)} passed")


# ---- A7 (2026-11-04): a real lung volume change reads as a warning, never the breath, never without the spine
def _lung_fail_metrics(**over):
    d = {"spine_assd_mm": 0.6, "spine_hd95_mm": 2.0, "lung_dice_min": 0.80, "lung_assd_max_mm": 3.0,
         "lung_hd95_max_mm": 14.0, "jacobian_fold_fraction": 0.0}
    d.update(over)
    return {"rigid": {"spine_assd_mm": 1.0}, "deformable": d}


REAL_LUNG_CHANGE = {"computed": True, "real_change_supported": True, "explained_by": "tissue_or_one_sided_change"}
BREATH_ONLY = {"computed": True, "real_change_supported": False, "explained_by": "breath_depth"}


def test_a_real_lung_volume_change_turns_the_lung_checks_into_warnings():
    v, checks, hard, soft = R.evaluate_gate(_lung_fail_metrics(), None, R.gates_for("chest"), lung_change=REAL_LUNG_CHANGE)
    assert v == "PASS_WITH_WARNINGS" and not hard
    lung = [c for c in checks if c["metric"] in R.LUNG_SURFACE_METRICS]
    assert len(lung) == 3
    assert all(c["severity"] == "soft" and c["downgraded_from"] == "hard" and c["pass"] is False for c in lung)
    assert any("lung_dice_min" in s and "lung volume changed" in s for s in soft)


def test_the_breath_does_not_excuse_a_lung_failure():
    v, _, hard, _ = R.evaluate_gate(_lung_fail_metrics(), None, R.gates_for("chest"), lung_change=BREATH_ONLY)
    assert v == "FAIL" and any("lung_dice_min" in h for h in hard)


def test_the_lung_downgrade_needs_the_spine_and_the_evidence():
    chest = R.gates_for("chest")
    v, _, hard, _ = R.evaluate_gate(_lung_fail_metrics(spine_assd_mm=2.5), None, chest, lung_change=REAL_LUNG_CHANGE)
    assert v == "FAIL" and any("spine_assd_mm" in h for h in hard)          # the spine stays hard
    v, _, hard, _ = R.evaluate_gate(_lung_fail_metrics(lung_dice_min=None), None, chest, lung_change=REAL_LUNG_CHANGE)
    assert v == "FAIL" and any("lung_dice_min not computed" in h for h in hard)   # missing evidence is not excused
    v, _, _, _ = R.evaluate_gate(_lung_fail_metrics(), None, chest, lung_change=None)
    assert v == "FAIL"                                                       # no lung comparison at all
    v, _, _, _ = R.evaluate_gate(_lung_fail_metrics(), None, chest,
                                 lung_change={"computed": False, "real_change_supported": False})
    assert v == "FAIL"                                                       # comparison not computed
    v, _, hard, _ = R.evaluate_gate(_lung_fail_metrics(jacobian_fold_fraction=0.01), None, chest, lung_change=REAL_LUNG_CHANGE)
    assert v == "FAIL" and any("jacobian_fold_fraction" in h for h in hard)  # a folded deformation is never excused


def test_engine_identity_names_the_lung_volume_module():
    assert "lung_volume_sha256" in R.engine_identity()


def test_lung_mass_is_comparable_only_when_kernel_family_contrast_and_thickness_agree():
    base = {"kernel_family": "Br44", "kernel_variant": "d", "model": "X", "contrast_agent": True, "slice_thickness_mm": 1.5, "kvp": 120.0}
    ok, why, cav = R.lung_mass_comparability(base, dict(base))
    assert ok and why is None and cav is None
    ok, why, cav = R.lung_mass_comparability(base, {**base, "kernel_variant": "f"})
    assert ok and why is None and "reconstruction variant" in cav                              # allowed, with a caveat
    ok, why, _ = R.lung_mass_comparability(base, {**base, "kernel_family": "B30"})
    assert not ok and "kernel family" in why
    ok, why, _ = R.lung_mass_comparability(base, {**base, "contrast_agent": False})
    assert not ok and "contrast" in why
    ok, why, _ = R.lung_mass_comparability(base, {**base, "slice_thickness_mm": 5.0})
    assert not ok and "slice thickness" in why
