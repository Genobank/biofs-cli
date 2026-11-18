"""Tests for known_answer.py on small synthetic scans (SimpleITK, scipy, numpy)."""
import copy, json, os, sys, tempfile
import numpy as np
import SimpleITK as sitk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import known_answer as KA
import test_lung_volume as TLV


def _img(shape_zyx=(70, 72, 74), fill=-1000.0):
    img = sitk.GetImageFromArray(np.full(shape_zyx, fill, np.float32))
    img.SetSpacing((1.0, 1.0, 1.0)); img.SetOrigin((-30.0, -40.0, 100.0))
    return img


def test_the_composite_applies_the_bspline_first_and_then_the_rigid_part():
    img = _img()
    T, b, info = KA.truth_transform(img, {"seed": 3, "mesh_cells": [3, 3, 3], "p95_mm": 3.0, "max_mm_limit": 12.0,
                                         "min_jacobian": 0.5, "rigid_translation_mm": [3, -2, 4], "rigid_rotation_deg": [1, 0, 2]})
    r = KA.rigid_transform(img, [3, -2, 4], [1, 0, 2])
    p = (-5.0, 3.0, 130.0)
    a = np.array(T.TransformPoint(p)); c = np.array(r.TransformPoint(b.TransformPoint(p)))
    assert np.abs(a - c).max() < 1e-6, (a, c)
    assert 0.5 <= info["min_jacobian"] <= 1.0 <= info["max_jacobian"] <= 2.0, info


def test_the_new_scan_has_its_content_where_the_transform_says():
    """A bright ball in the old scan appears in the new scan at the point y with T(y) = the ball centre."""
    img = _img()
    arr = sitk.GetArrayFromImage(img)
    zz, yy, xx = np.indices(arr.shape)
    c_idx = (35, 36, 37)
    arr = arr + 800.0 * np.exp(-(((zz - c_idx[0]) ** 2 + (yy - c_idx[1]) ** 2 + (xx - c_idx[2]) ** 2) / (2 * 3.0 ** 2)))
    old = sitk.GetImageFromArray(arr.astype(np.float32)); old.CopyInformation(img)
    T, _, _ = KA.truth_transform(img, {"seed": 5, "mesh_cells": [3, 3, 3], "p95_mm": 4.0, "max_mm_limit": 14.0, "min_jacobian": 0.5,
                                      "rigid_translation_mm": [4, -3, 5], "rigid_rotation_deg": [1.5, 0, 2]})
    new = sitk.Resample(old, old, T, sitk.sitkLinear, -1000.0, sitk.sitkFloat32)
    a = sitk.GetArrayFromImage(new) + 1000.0
    w = np.where(a > 100, a, 0.0)
    cz, cy, cx = [float((w * g).sum() / w.sum()) for g in (zz, yy, xx)]
    p_new = new.TransformContinuousIndexToPhysicalPoint((cx, cy, cz))
    p_old_truth = old.TransformContinuousIndexToPhysicalPoint((float(c_idx[2]), float(c_idx[1]), float(c_idx[0])))
    err = float(np.linalg.norm(np.array(T.TransformPoint(p_new)) - np.array(p_old_truth)))
    assert err < 1.0, err


def test_the_jacobian_filter_counts_the_identity_so_density_scaling_has_the_right_sign():
    img = _img((40, 40, 40))
    c = np.array(img.TransformContinuousIndexToPhysicalPoint((19.5, 19.5, 19.5)))
    tx = sitk.AffineTransform(3)
    tx.SetCenter(tuple(c)); tx.SetMatrix([1.1, 0, 0, 0, 1.1, 0, 0, 0, 1.1])      # T(y) = 1.1 y about the centre
    jac = sitk.GetArrayFromImage(sitk.DisplacementFieldJacobianDeterminant(KA.dense_displacement(tx, img)))
    assert abs(float(jac[20, 20, 20]) - 1.331) < 0.01, jac[20, 20, 20]


def test_a_sphere_has_the_volume_it_was_given():
    a = np.zeros((40, 40, 40), np.float32)
    m = KA.insert_sphere(a, (20.0, 20.0, 20.0), 12.0, 100.0, (1.0, 1.0, 1.0))
    v = 4.0 / 3.0 * np.pi * 6.0 ** 3
    assert abs(m.sum() - v) / v < 0.12, (m.sum(), v)
    assert a.max() > 99 and a[0, 0, 0] == 0


def test_the_lobe_fill_changes_the_lower_part_of_the_air_only():
    ct, lab = TLV.chest()
    lobe = lab == 4                                   # lower right lobe: z 15 to 44
    before = ct.copy()
    roi = KA.consolidate(ct, lobe, 0.5, 25.0)
    zs = np.nonzero(roi.any(axis=(1, 2)))[0]
    assert zs.max() < 30 and zs.min() >= 15, (zs.min(), zs.max())
    assert (ct[roi] == 25.0).all() and (ct[~roi] == before[~roi]).all()


def test_kernel_emulation_adds_the_noise_asked_for_and_blur_removes_texture():
    rng = np.random.default_rng(1)
    a = rng.normal(0, 50, (40, 40, 40)).astype(np.float32)
    b = KA.emulate_kernel(a, (1, 1, 1), 1.0, 0.0, 1)
    assert b.std() < 0.5 * a.std()
    c = KA.emulate_kernel(np.zeros((40, 40, 40), np.float32), (1, 1, 1), 0.0, 12.0, 2)
    assert abs(c.std() - 12.0) < 0.5


def test_blur_moves_the_rim_mass_of_a_lung_but_not_its_core():
    ct, lab = _big_chest()
    d = KA.lung_distance_map(lab, [1, 2, 3, 4], (1.0, 1.0, 1.0))
    base = KA.mass_by_erosion(ct, d, (1.0, 1.0, 1.0))
    blurred = KA.mass_by_erosion(KA.emulate_kernel(ct, (1, 1, 1), 0.6, 0.0, 1), d, (1.0, 1.0, 1.0))
    assert blurred["0.0"] / base["0.0"] - 1.0 > 0.03, (base, blurred)          # the rim number moves with sharpness
    assert abs(blurred["4.0"] / base["4.0"] - 1.0) < 0.005, (base, blurred)   # the core number does not


def test_nodules_are_placed_inside_the_lung_apart_from_each_other():
    ct, lab = TLV.chest()
    lung = lab > 0
    rules = {"min_edge_from_lung_mm": 6.0, "min_spacing_mm": 20.0, "seed": 4, "parenchyma_hu_max": -780.0}
    c = KA.place_nodules(lung, ct, (1.0, 1.0, 1.0), [{}, {}, {}], rules, np.zeros(lung.shape, bool))
    assert len(c) == 3
    for i in range(3):
        assert lung[tuple(int(round(v)) for v in c[i])]
        for j in range(i):
            assert np.linalg.norm(c[i] - c[j]) >= 20.0


def test_sample_points_fill_every_zone_and_respect_the_exclusion():
    ct, lab = TLV.chest()
    lung = lab > 0
    ex = np.zeros(lung.shape, bool); ex[:, :, :60] = True            # the whole left lung is excluded
    pts = KA.sample_points(lung, np.zeros(lung.shape, bool), {"n_per_lung_zone": 5, "n_body": 3, "erode_vox": 3, "seed": 1}, ex, (1.0, 1.0, 1.0))
    assert pts and all(p["index_zyx"][2] >= 60 for p in pts)
    assert {p["group"].split("_")[1] for p in pts} == {"right"}


def test_a_new_object_is_found_and_a_stray_blob_is_counted_as_a_false_alarm():
    rng = np.random.default_rng(2)
    diff = rng.normal(0, 5, (60, 60, 60)).astype(np.float32)
    KA.insert_sphere(diff, (30.0, 30.0, 30.0), 10.0, 400.0, (1.0, 1.0, 1.0))        # the real one
    KA.insert_sphere(diff, (10.0, 50.0, 10.0), 8.0, 400.0, (1.0, 1.0, 1.0))         # a stray one
    region = np.ones(diff.shape, bool)
    zone = np.zeros(diff.shape, bool); zone[20:40, 20:40, 20:40] = True           # truth zone left out of the noise estimate
    det = {"smooth_sigma_mm": 1.0, "threshold_sd": 5.0, "min_component_mm3": 30.0}
    r = KA.detect_changes(diff, region & ~zone, [(30.0, 30.0, 30.0)], [5.0], (1.0, 1.0, 1.0), det)
    assert r["objects"][0]["detected"] is True
    assert r["false_alarm_components"] == 1, r
    q = KA.detect_changes(diff, region & ~zone, [(45.0, 5.0, 45.0)], [2.0], (1.0, 1.0, 1.0), det)
    assert q["objects"][0]["detected"] is False


def test_the_mask_splat_follows_the_displacement():
    img = _img((30, 30, 30))
    mask = np.zeros((30, 30, 30), bool); mask[10:14, 10:14, 10:14] = True
    disp = np.zeros((30, 30, 30, 3), np.float32); disp[..., 0] = 5.0                  # x moves by 5 mm
    out = KA.splat_mask_to_old_frame(mask, disp, img)
    xs = np.nonzero(out.any(axis=(0, 1)))[0]
    assert xs.min() >= 14 and xs.max() <= 20, (xs.min(), xs.max())
    assert abs(out.sum() - 64) < 40


def _big_chest(shape=(140, 130, 200)):
    """Two lungs of about 480 mL each, lower lobes below z = 70. Large enough that the one-voxel rim of a lung is a
    few percent of it, as on a real scan (a 70 mL test lung is mostly rim)."""
    ct = np.full(shape, 40.0, np.float32)
    lab = np.zeros(shape, np.int16)
    zz, yy, xx = np.indices(shape)
    for cx, ids in ((55, (1, 2)), (145, (3, 4))):
        inside = ((zz - 70) / 60.0) ** 2 + ((yy - 65) / 48.0) ** 2 + ((xx - cx) / 40.0) ** 2 <= 1
        ct[inside] = -850.0
        lab[inside & (zz >= 70)] = ids[0]
        lab[inside & (zz < 70)] = ids[1]
    return ct, lab


def _fake_source(td):
    ct, lab = _big_chest()
    base = os.path.join(td, "src", "native", "jun17")
    os.makedirs(base)
    for arr, name, dt in ((ct, "ct.nii.gz", np.int16), (lab, "labels.nii.gz", np.int16)):
        img = sitk.GetImageFromArray(arr.astype(dt)); img.SetSpacing((1, 1, 1)); img.SetOrigin((-100.0, -65.0, 800.0))
        sitk.WriteImage(img, os.path.join(base, name))
    names = {"1": "lung_upper_lobe_left", "2": "lung_lower_lobe_left", "3": "lung_upper_lobe_right", "4": "lung_lower_lobe_right"}
    json.dump({"label_names": names}, open(os.path.join(td, "src", "manifest.json"), "w"))
    return os.path.join(td, "src")


def _small_spec():
    s = copy.deepcopy(KA.DEFAULT_SPEC)
    s["deformation"].update(mesh_cells=[3, 3, 3], p95_mm=3.0, max_mm_limit=12.0, min_jacobian=0.5,
                            rigid_translation_mm=[3.0, -2.0, 4.0], rigid_rotation_deg=[1.0, 0.0, 1.0])
    s["nodules"] = [{"diameter_mm": 6.0, "hu": 30.0}, {"diameter_mm": 8.0, "hu": -500.0}]
    s["nodule_rules"].update(min_edge_from_lung_mm=10.0, min_spacing_mm=30.0)
    s["consolidation"].update(lobe="lung_lower_lobe_right", fraction_from_bottom=0.8, roi_margin_mm=6.0)
    return s


def test_build_makes_a_new_scan_whose_truth_matches_what_was_done():
    with tempfile.TemporaryDirectory() as td:
        src = _fake_source(td)
        out = os.path.join(td, "ka")
        t = KA.build(src, "jun17", _small_spec(), out, log=lambda *a: None)
        assert len(t["nodules"]) == 2 and t["lung_min_margin_to_image_edge_voxels"] >= 3
        assert 0.85 < t["lung_volume_ratio_new_over_old_labels"] < 1.15          # the deformation may change the volume, not crop it
        comps = t["lung_comparisons_old_to_new"]
        only = comps["new_deformation_only"]
        assert only["computed"] and only["real_change_supported"] is False, only["explanation"]
        # The breath keeps the mass. The label rim does not: blur carries tissue density across the label edge, which moved
        # the whole-lung number by several percent on this 960 mL test lung (see test_blur_moves_the_rim...). The core does not.
        assert abs(only["delta_aerated_mass_frac"]) < 0.08, only["delta_aerated_mass_frac"]
        sens = t["aerated_mass_change_vs_old_by_erosion_mm"]["new_deformation_only"]
        assert abs(sens["4.0"]) < 0.025, sens
        fill = comps["new_final"]
        assert fill["real_change_supported"] is True and fill["delta_aerated_mass_frac"] < -0.10, fill["explanation"]
        assert fill["lobes_by_change"][0]["lobe"] == "lung_lower_lobe_right", fill["lobes_by_change"][0]
        T = sitk.ReadTransform(os.path.join(out, "truth_transform.tfm"))
        new = sitk.ReadImage(os.path.join(out, "new_ct.nii.gz"))
        for n in t["nodules"]:
            back = np.array(T.TransformPoint(tuple(n["center_phys_new_mm"])))
            assert np.abs(back - np.array(n["center_phys_old_mm"])).max() < 0.01
            idx = new.TransformPhysicalPointToContinuousIndex(tuple(n["center_phys_new_mm"]))
            z, y, x = [int(round(v)) for v in (idx[2], idx[1], idx[0])]
            sphere = sitk.GetArrayFromImage(new)[z - 1:z + 2, y - 1:y + 2, x - 1:x + 2].mean()
            assert (sphere > -100) if n["hu"] == 30.0 else (-700 < sphere < -300), (n["id"], sphere)
        assert os.path.exists(os.path.join(out, "consolidation_roi_old_frame.nii.gz"))
        json.dumps(t)


def _report(**over):
    def stats(m, p90, n=60):
        return {"n": n, "mean_mm": m, "median_mm": m, "p90_mm": p90, "max_mm": p90 * 1.5}
    r = {"gate_verdict": "PASS_WITH_WARNINGS",
         "registration_error": {"blob_lost_fraction": 0.0,
                                "lung_outside_roi": {"rigid": stats(6.0, 11.0), "deformable": stats(1.2, 3.0)},
                                "lung_lower_third_outside_roi": {"deformable": stats(1.8, 4.0)},
                                "body": {"deformable": stats(1.5, 3.5)}},
         "nodules": {"objects": [{"id": "N3", "diameter_mm": 8.0, "hu": 30.0, "deformable_retained_volume_ratio": 0.95,
                                  "deformable_frame": {"detected": True}},
                                 {"id": "N1", "diameter_mm": 4.0, "hu": 30.0, "deformable_retained_volume_ratio": 0.3,
                                  "deformable_frame": {"detected": False}}],
                     "deformable_frame_false_alarm_components": 12, "rigid_grid_false_alarm_components": 80},
         "lung_volume": {"measured_mass_frac": -0.15, "truth_mass_frac": -0.148, "mass_error_points": -0.002,
                         "flagged_with_lobe_fill": True, "flagged_deformation_only": False,
                         "kernel_effect_on_mass_points_by_erosion_mm": {"0.0": 0.031, "4.0": 0.004}}}
    for k, v in over.items():
        r[k] = v
    return r


def test_the_pass_rules_pass_a_good_report_and_name_each_failure():
    spec = KA.DEFAULT_SPEC
    ok = KA.judge(_report(), spec)
    assert all(ok[k]["verdict"] in ("PASS", "REPORT") for k in ok), ok
    assert KA.judge(_report(lung_volume={**_report()["lung_volume"], "kernel_effect_on_mass_points_by_erosion_mm": {"0.0": 0.07, "4.0": 0.05}}),
                    spec)["KA4b_core_candidate"]["verdict"] == "FAIL"
    assert "false-alarm" in " ".join(ok["KA3_new_nodules"]["reasons"])           # reported, not judged
    bad = _report()
    bad["registration_error"]["lung_outside_roi"]["deformable"] = {"n": 60, "mean_mm": 3.0, "median_mm": 3.0, "p90_mm": 9.0, "max_mm": 14.0}
    bad["nodules"]["objects"][0]["deformable_retained_volume_ratio"] = 0.5
    bad["lung_volume"]["flagged_with_lobe_fill"] = False
    j = KA.judge(bad, spec)
    assert j["KA1_registration_error"]["verdict"] == "FAIL" and len(j["KA1_registration_error"]["reasons"]) >= 2
    assert j["KA3_new_nodules"]["verdict"] == "FAIL" and j["KA4_lung_volume"]["verdict"] == "FAIL"
    assert any("DISAGREEMENT" in r for r in j["KA2_gate_against_truth"]["reasons"])      # KA1 fails, gate passes


def test_the_four_parts_of_the_spec_are_present_and_provisional():
    assert "Provisional" in KA.DEFAULT_SPEC["status"]
    assert set(KA.DEFAULT_SPEC["pass"]) == {"KA1_registration_error", "KA2_gate_against_truth", "KA3_new_nodules", "KA4_lung_volume", "KA4b_core_candidate"}


def test_the_kernel_report_runs_on_a_job_folder_and_sees_the_rim_effect():
    import io, contextlib
    import kernel_sensitivity as KS
    with tempfile.TemporaryDirectory() as td:
        ct, lab = _big_chest()
        names = {"1": "lung_upper_lobe_left", "2": "lung_lower_lobe_left", "3": "lung_upper_lobe_right", "4": "lung_lower_lobe_right", "5": "trachea"}
        lab[60:66, 60:66, 100:106] = 5                    # a tracheal lumen between the lungs, left as air
        ct[60:66, 60:66, 100:106] = -1000.0
        tps = []
        for name, arr in (("sharp", ct), ("soft", KA.emulate_kernel(ct, (1, 1, 1), 0.6, 0.0, 1))):
            d = os.path.join(td, "native", name); os.makedirs(d)
            for a, f in ((arr, "ct.nii.gz"), (lab, "labels.nii.gz")):
                im = sitk.GetImageFromArray(np.rint(a).astype(np.int16)); im.SetSpacing((1, 1, 1)); sitk.WriteImage(im, os.path.join(d, f))
            tps.append({"label": name, "protocol": {"kernel": "x", "pixel_spacing_mm": [1, 1], "slice_thickness_mm": 1}})
        json.dump({"job_id": "t", "label_names": names, "timepoints": tps}, open(os.path.join(td, "manifest.json"), "w"))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            KS.main(td, os.path.join(td, "r.json"))
        r = json.load(open(os.path.join(td, "r.json")))
        d = r["pairs"]["soft_vs_sharp"]["mass_difference_b_vs_a_by_erosion_mm"]
        assert d["0.0"] > 0.03 and abs(d["4.0"]) < 0.01, d              # the whole label moves with sharpness, the 4 mm core does not
        assert r["pairs"]["soft_vs_sharp"]["sharper_by_noise"] in ("sharp", "soft")
        assert "trachea SD" in buf.getvalue()


def test_ants_arrays_are_turned_to_the_simpleitk_axis_order_on_a_non_cubic_image():
    import ants
    a = np.zeros((20, 30, 40), np.float32); a[3, 11, 27] = 100.0                 # z, y, x
    im = sitk.GetImageFromArray(a); im.SetSpacing((1, 1, 1))
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "a.nii.gz"); sitk.WriteImage(im, p)
        b = KA.ants_to_zyx(ants.image_read(p).numpy())
    assert b.shape == a.shape and np.allclose(b, a), (b.shape, np.argwhere(b > 50))


def test_kernel_match_blurs_the_sharper_scan_until_its_edges_equal_the_softer_ones():
    import io, contextlib
    import kernel_match as KM
    with tempfile.TemporaryDirectory() as td:
        ct, lab = _big_chest()
        names = {"1": "lung_upper_lobe_left", "2": "lung_lower_lobe_left", "3": "lung_upper_lobe_right", "4": "lung_lower_lobe_right"}
        tps = []
        for name, arr in (("sharp", ct), ("soft", KA.emulate_kernel(ct, (1, 1, 1), 0.6, 0.0, 1))):
            d = os.path.join(td, "native", name); os.makedirs(d)
            for a, f in ((arr, "ct.nii.gz"), (lab, "labels.nii.gz")):
                im = sitk.GetImageFromArray(np.rint(a).astype(np.int16)); im.SetSpacing((1, 1, 1)); sitk.WriteImage(im, os.path.join(d, f))
            tps.append({"label": name, "protocol": {}})
        json.dump({"job_id": "t", "label_names": names, "timepoints": tps}, open(os.path.join(td, "manifest.json"), "w"))
        with contextlib.redirect_stdout(io.StringIO()):
            KM.main(td, os.path.join(td, "m.json"))
        m = json.load(open(os.path.join(td, "m.json")))["matches"]["sharp_vs_soft"]
        assert m["sharper_by_edge"] == "sharp" and 0.3 < m["blur_sigma_mm_that_matches_edges"] < 0.9, m
        assert abs(m["mass_g_erosion_0.0"]["difference_after"]) < 0.02, m           # blur explains this offset, by construction


def test_a_lung_pushed_against_the_image_edge_is_refused_as_cropped_but_a_volume_change_is_not():
    with tempfile.TemporaryDirectory() as td:
        src = _fake_source(td)
        refused = 0
        for sign in (1, -1):
            s = _small_spec()
            s["deformation"]["rigid_translation_mm"] = [0.0, 0.0, 70.0 * sign]
            try:
                KA.build(src, "jun17", s, os.path.join(td, f"ka{sign}"), log=lambda *a: None)
            except RuntimeError as e:
                assert "image edge" in str(e), e
                refused += 1
        assert refused >= 1, "a 70 mm shift of a lung that has 10 mm of margin was not refused"


def test_rider_study_picker_takes_the_first_study_with_six_reconstructions_and_the_summary_reads_kernel_and_thickness():
    import rider_kernel as RK
    def s(p, st, d, n=100, mod="CT"):
        return {"PatientID": p, "StudyInstanceUID": st, "StudyDate": d, "ImageCount": n, "Modality": mod, "SeriesInstanceUID": f"{st}.{d}.{n}.{id({})}"}
    ser = [s("P1", "A", "2006-09-19", 100 + i) for i in range(20)] + [s("P1", "B", "2006-09-05", 100 + i) for i in range(6)] + [s("P1", "B", "2006-09-05", 2)]
    ser += [s("P2", "C", "2006-10-01", 100 + i) for i in range(5)]            # five reconstructions only: skipped
    got = RK.pick_studies(ser, 5)
    assert list(got) == ["P1"] and len(got["P1"]) == 6 and got["P1"][0]["StudyInstanceUID"] == "B", got.keys()
    pat = [{"kernel": "LUNG", "thickness_mm": 1.25, "mass_whole_g": 100.0, "mass_core4_g": 80.0, "mass_core4_cap0_g": 90.0, "mass_core4_cap300_g": 95.0, "reference": True},
           {"kernel": "STANDARD", "thickness_mm": 1.25, "mass_whole_g": 96.0, "mass_core4_g": 79.2, "mass_core4_cap0_g": 90.9, "mass_core4_cap300_g": 95.0, "reference": False},
           {"kernel": "LUNG", "thickness_mm": 5.0, "mass_whole_g": 103.0, "mass_core4_g": 80.8, "mass_core4_cap0_g": 90.0, "mass_core4_cap300_g": 95.0, "reference": False}]
    r = RK.summarize([pat, pat])
    assert r["kernel_effect_at_reference_thickness"]["whole"]["median"] == -0.04
    assert r["thickness_effect_at_reference_kernel"]["5.0"]["core4"]["median"] == 0.01
    assert r["kernel_effect_at_reference_thickness"]["core4_cap300"]["median"] == 0.0


def test_rider_repeat_picks_patient_days_and_the_two_lung_kernel_scans_and_applies_the_registered_rules():
    import rider_repeat as RR
    def s(p, d, n, uid):
        return {"PatientID": p, "StudyDate": d + " 00:00:00.0", "ImageCount": n, "Modality": "CT", "SeriesInstanceUID": uid}
    ser = [s("P1", "2007-01-01", 230, f"a{i}") for i in range(4)] + [s("P1", "2007-02-01", 230, f"b{i}") for i in range(4)] + \
          [s("P2", "2007-01-01", 230, "c0"), s("P2", "2007-01-01", 230, "c1")] + [s("P3", "2007-01-05", 300, f"d{i}") for i in range(5)]
    got = RR.candidates(ser, 5)
    assert sorted(got) == ["P1", "P3"] and got["P1"][0] == "2007-01-01" and len(got["P1"][1]) == 4
    infos = [{"uid": "u1", "kernel": "LUNG", "thickness_mm": 1.25, "acq_time": "101500"}, {"uid": "u2", "kernel": "STANDARD", "thickness_mm": 1.25, "acq_time": "101500"},
             {"uid": "u3", "kernel": "LUNG", "thickness_mm": 1.25, "acq_time": "102900"}, {"uid": "u4", "kernel": "STANDARD", "thickness_mm": 1.25, "acq_time": "102900"},
             {"uid": "u5", "kernel": "LUNG", "thickness_mm": 5.0, "acq_time": "101500"}]
    A, B, why = RR.select_pair(infos)
    assert (A["uid"], B["uid"], why) == ("u1", "u3", None)
    assert RR.select_pair(infos[:2])[2] and RR.select_pair([infos[0], {**infos[0], "uid": "u9"}])[2]       # one scan reconstructed twice is not a repeat
    # amendment 1: three acquisitions -> the two earliest; copies without an acquisition time are dropped only when a timed twin exists
    lu = lambda uid, t, sn, n: {"uid": uid, "kernel": "LUNG", "thickness_mm": 1.25, "acq_time": t, "series_number": sn, "n": n}
    three = [lu("c", "094611", "101", 229), lu("a", "093516", "4", 236), lu("b", "094208", "8", 213), {**lu("x", "093516", "4", 236), "kernel": "STANDARD"}]
    A, B, why = RR.select_pair(three)
    assert (A["uid"], B["uid"], why) == ("a", "b", None)
    twin = [lu("p", "174602", "101", 233), lu("q", "175856", "105", 237), lu("p2", "", "101", 233), lu("q2", "", "105", 237)]
    A, B, why = RR.select_pair(twin)
    assert (A["uid"], B["uid"], why) == ("p", "q", None)
    assert "no acquisition time" in RR.select_pair([lu("p", "174602", "101", 233), lu("q", "175856", "105", 237), lu("z", "", "999", 50)])[2]
    assert "need exactly 1" in RR.select_pair([lu("p", "1", "1", 9), lu("p9", "1", "2", 9), lu("q", "2", "3", 9)])[2]
    rows = [{"pair": f"P{i}", "delta_mass_whole": 0.01 * (i % 3), "delta_mass_core4": 0.0, "delta_mass_core4_cap300": 0.0, "delta_volume": 0.01,
             "asymmetry": 0.02, "flagged": False} for i in range(10)]
    v, st = RR.evaluate(rows, RR.CRITERIA)
    assert all(x["verdict"] == "PASS" for x in v.values()), v
    rows[0]["delta_mass_whole"] = 0.12; rows[1]["delta_mass_whole"] = -0.09; rows[1]["flagged"] = True
    v, _ = RR.evaluate(rows, RR.CRITERIA)
    assert v["C2_whole_mass_repeat_noise"]["verdict"] == "FAIL" and v["C1_no_false_alarm_at_shipped_thresholds"]["flagged"] == ["P1"]
