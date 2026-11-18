"""Known-answer tests for organ_package.py. Criteria OP1 to OP13 are in organ_package_criteria-20261106.txt (hashed before the module existed).
Synthetic organs only: every number is made, so every answer is known. Needs numpy, scipy, SimpleITK, scikit-image, trimesh. No ANTs, no GPU."""
import copy
import json
import os
import shutil
import tempfile

import numpy as np
import SimpleITK as sitk

import organ_package as OP

STD = np.diag([-1.0, -1.0, 1.0])
REFLECTED = np.diag([1.0, 1.0, -1.0])


def rot_x(deg):
    a = np.deg2rad(deg)
    return np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])


OBLIQUE = rot_x(12.0) @ STD


def grid_of(spacing=(1.0, 1.0, 1.0), size=(80, 90, 100), origin=(-55.2, 31.4, -140.7), direction=OBLIQUE):
    return OP.Grid(origin, spacing, np.asarray(direction).ravel(), size)


def centres(grid):
    nx, ny, nz = grid.size
    k, j, i = np.indices((nz, ny, nx))
    ijk = np.stack([i.ravel(), j.ravel(), k.ravel()], axis=1)
    return grid.index_to_lps(ijk).reshape(nz, ny, nx, 3)


def centre_of(grid):
    return grid.index_to_lps([(np.array(grid.size) - 1) / 2.0])[0]


AXES = np.array([22.0, 16.0, 30.0])
BALL_OFF = np.array([14.0, -10.0, 21.0])      # +x = patient left, -y = anterior, +z = superior (LPS)
BALL_R = 7.0


def shape_mask(grid, centre=None, axes=AXES, ball=True, ball_off=BALL_OFF, ball_r=BALL_R):
    c = centre_of(grid) if centre is None else np.asarray(centre, float)
    p = centres(grid)
    inside = (((p - c) / axes) ** 2).sum(axis=-1) <= 1.0
    if ball:
        inside |= ((p - (c + ball_off)) ** 2).sum(axis=-1) <= ball_r ** 2
    return inside


def sampson(points, c, axes):
    d = (points - c) / axes
    f = (d ** 2).sum(axis=1)
    grad = 2 * d / axes
    return (f - 1.0) / np.linalg.norm(grad, axis=1)


def surface_error(vertices, grid, axes=AXES):
    c = centre_of(grid)
    de = np.abs(sampson(vertices, c, axes))
    db = np.abs(sampson(vertices, c + BALL_OFF, np.array([BALL_R] * 3)))
    return np.minimum(de, db)


def glb_vertices_lps(path):
    return OP.load_glb_vertices_lps(path)


# ---------------------------------------------------------------------------------------------------------------------
def test_op1_coordinates_isotropic_oblique_grid():
    g = grid_of()
    mesh, info = OP.mesh_from_mask(shape_mask(g), g, face_budget=0)
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "o.glb")
        OP.write_glb(mesh, path, "liver", {"schema": OP.SCHEMA, "organ": "liver"})
        err = surface_error(glb_vertices_lps(path), g)
    assert np.median(err) <= 0.5, np.median(err)
    assert np.percentile(err, 99) <= 1.0, np.percentile(err, 99)


def test_op1_coordinates_anisotropic_grid():
    g = grid_of(spacing=(0.8, 0.9, 2.5), size=(110, 110, 44))
    mesh, _ = OP.mesh_from_mask(shape_mask(g), g, face_budget=0)
    err = surface_error(mesh.vertices, g)
    assert np.percentile(err, 99) <= 2.5, np.percentile(err, 99)


def test_op2_volume():
    g = grid_of()
    ell = shape_mask(g, ball=False)
    n = int(ell.sum())
    assert abs(n * g.voxel_volume_mm3() / 1000.0 - 4.0 / 3.0 * np.pi * np.prod(AXES) / 1000.0) / (4.0 / 3.0 * np.pi * np.prod(AXES) / 1000.0) <= 0.02
    mesh, info = OP.mesh_from_mask(ell, g, face_budget=0)
    vox_ml = n * g.voxel_volume_mm3() / 1000.0
    assert abs(info["mesh_volume_ml"] - vox_ml) / vox_ml <= 0.04, (info["mesh_volume_ml"], vox_ml)


def test_op3_orientation_and_winding_for_three_direction_matrices():
    for name, D in (("standard", STD), ("reflected", REFLECTED), ("oblique", OBLIQUE)):
        g = grid_of(direction=D)
        mesh, _ = OP.mesh_from_mask(shape_mask(g), g, face_budget=0)
        assert mesh.volume > 0, f"{name}: signed volume {mesh.volume}"
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "o.glb")
            OP.write_glb(mesh, path, "liver", {"schema": OP.SCHEMA, "organ": "liver"})
            import trimesh
            sc = trimesh.load(path, file_type="glb", force="scene")
            gm = next(iter(sc.geometry.values()))
            assert gm.volume > 0, f"{name}: the GLB has inward faces"
            v = np.asarray(gm.vertices)
        centre_gl = OP.lps_to_gltf(centre_of(g)[None, :])[0]
        tip = v[np.argmax(np.linalg.norm(v - centre_gl, axis=1))] - centre_gl
        assert tip[0] > 0 and tip[1] > 0 and tip[2] > 0, f"{name}: the ball is not toward patient left, superior and anterior: {tip}"
        # independent of OP.lps_to_gltf: patient left = +X, superior = +Y, anterior = +Z by the stated rule
        assert tip[0] > 0.005 and tip[1] > 0.012 and tip[2] > 0.004, (name, tip)


def moved_scene(angle=0.12, shift=(12.0, -7.0, 5.0)):
    g = grid_of(size=(110, 110, 110))
    ref = shape_mask(g)
    centre = centre_of(g)
    T = sitk.Euler3DTransform()
    T.SetCenter(tuple(float(v) for v in centre))
    T.SetRotation(0.03, -0.05, angle)
    T.SetTranslation(tuple(float(v) for v in shift))          # T: reference point -> later-scan point
    img_ref = g.to_image(ref.astype(np.uint8))
    mov = sitk.GetArrayFromImage(sitk.Resample(img_ref, img_ref, T.GetInverse(), sitk.sitkNearestNeighbor, 0)) > 0
    return g, ref, mov, T


def test_op4_rigid_placement_and_wrong_direction():
    g, ref, mov, T = moved_scene()
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "rigid.mat")
        sitk.WriteTransform(T, path)
        tf = OP.read_rigid(path)
    mr, _ = OP.mesh_from_mask(ref, g, face_budget=0)
    mm, _ = OP.mesh_from_mask(mov, g, face_budget=0)
    cloud = np.asarray(mr.sample(60000, ))
    from scipy.spatial import cKDTree
    tree = cKDTree(cloud)
    d_ok = tree.query(OP.place_points(mm.vertices, tf))[0]
    assert d_ok.mean() <= 0.5 and d_ok.max() <= 1.5, (d_ok.mean(), d_ok.max())
    A, t, _ = OP.affine_of(tf)
    wrong = (A @ mm.vertices.T).T + t
    d_bad = tree.query(wrong)[0]
    assert d_bad.mean() > 1.5, "a transform applied the wrong way must fail the test"
    rep = OP.rigid_report(tf)
    assert rep["orthonormal_error"] < 1e-9 and abs(rep["determinant"] - 1) < 1e-9


# ---------------------------------------------------------------------------------------------------------------------
# Synthetic job folders
NAMES = {1: "liver", 2: "vertebrae_T8", 3: "vertebrae_T9", 4: "lung_upper_lobe_left", 5: "lung_lower_lobe_left",
         6: "lung_upper_lobe_right", 7: "spleen", 8: "stomach", 9: "heart"}


def checks_for(regions):
    metrics = {"lungs": ("lung_dice_min", "lung_assd_max_mm", "lung_hd95_max_mm"),
               "spine": ("spine_assd_mm", "spine_hd95_mm"),
               "liver_spleen": ("abdominal_organ_assd_max_mm_corresponding", "abdominal_organ_hd95_max_mm_corresponding"),
               "skin": ("body_surface_assd_mm", "body_surface_hd95_mm")}
    out = []
    for region, names in metrics.items():
        state = regions.get(region, "pass")
        for m in names:
            out.append({"stage": "deformable", "metric": m, "severity": "hard" if region in ("lungs", "spine", "liver_spleen") else "soft",
                        "pass": None if state == "unknown" else (state != "fail"), "value": 1.0, "threshold": 5.0})
    return out


def write_nii(arr, grid, path, dtype):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sitk.WriteImage(grid.to_image(arr.astype(dtype)), path)


def spine_mask(g):
    c = centre_of(g)
    p = centres(g)
    off = np.array([-30.0, 28.0, 0.0])
    r2 = ((p[..., 0] - (c[0] + off[0])) ** 2 + (p[..., 1] - (c[1] + off[1])) ** 2)
    return (r2 <= 8.0 ** 2) & (np.abs(p[..., 2] - c[2]) <= 40.0)


def make_job(root, grid, label_maps, ref="b", dates=None, regions_by_pair=None, rigid=None, lung_cmp=None, poison=False,
             anatomy="abdomen", manifest_spine_assd=0.4):
    """label_maps: {tp: int16 array (z, y, x) in the grid}. rigid: {tp: SimpleITK transform (reference point -> scan point)}."""
    os.makedirs(root, exist_ok=True)
    tps = list(label_maps)
    dates = dates or {tp: f"2026030{i + 1}" for i, tp in enumerate(tps)}
    nz, ny, nx = grid.size[2], grid.size[1], grid.size[0]
    k, j, i = np.indices((nz, ny, nx))
    pattern = (((k * 7 + j * 3 + i) % 200) - 100).astype(np.int16)
    for tp in tps:
        write_nii(pattern, grid, os.path.join(root, "native", tp, "ct.nii.gz"), np.int16)
        write_nii(label_maps[tp], grid, os.path.join(root, "native", tp, "labels.nii.gz"), np.int16)
        write_nii(label_maps[tp], grid, os.path.join(root, "frame", f"{tp}_labels.nii.gz"), np.int16)
    pairs = []
    for tp in tps:
        if tp == ref:
            continue
        pair = f"{tp}_to_{ref}"
        os.makedirs(os.path.join(root, "pairs", pair), exist_ok=True)
        T = (rigid or {}).get(tp) or sitk.Euler3DTransform()
        sitk.WriteTransform(T, os.path.join(root, "pairs", pair, "rigid.mat"))
        regions = (regions_by_pair or {}).get(tp, {})
        verdict = "FAIL" if "fail" in regions.values() else "PASS_WITH_WARNINGS"
        pairs.append({"pair": pair, "moving": tp, "reference": ref,
                      "gate": {"verdict": verdict, "checks": checks_for(regions), "warnings": [], "hard_failures": []},
                      "metrics": {"rigid": {"spine_assd_mm": manifest_spine_assd}},
                      "transforms": {"rigid": "rigid.mat"}})
    tp_rows = []
    for tp in tps:
        protocol = {"manufacturer": "TEST", "model": "SCANNER", "study_date": dates[tp], "kernel": "B30f", "slice_thickness_mm": 1.0,
                    "kvp": 120}
        if poison:
            protocol.update({"PatientName": "Smith^Jane", "PatientID": "MRN-4455", "PatientBirthDate": "19700101",
                             "InstitutionName": "Test Hospital", "series_description": "Smith^Jane abdomen", "ReferringPhysicianName": "Doe^J"})
        tp_rows.append({"label": tp, "study_uid": "1.2.3", "series_uid": f"1.2.4.{tp}", "protocol": protocol,
                        "versus_reference": {"comparability": "reference" if tp == ref else "same"}})
    manifest = {"schema": "imaging-register/3", "job_id": "register-test", "wallet": "0x0000000000000000000000000000000000000001",
                "anatomy": anatomy, "reference": ref, "protocol_mode": "same", "voxel_comparison_assessable": True,
                "gate": {"verdict": "PASS_WITH_WARNINGS"}, "software": {"engine_sha256": "test", "image_digest": "sha256:test"},
                "timepoints": tp_rows, "pairs": pairs, "label_names": {str(k_): v for k_, v in NAMES.items()},
                "lung_volume": {"comparisons": lung_cmp or {}}}
    if poison:
        manifest["PatientName"] = "Smith^Jane"
    with open(os.path.join(root, "manifest.json"), "w") as f:
        json.dump(manifest, f)
    return manifest


def scene_labels(g, with_lungs=False):
    arr = np.zeros(g.size[::-1], np.int16)
    arr[shape_mask(g)] = 1
    arr[spine_mask(g) & (arr == 0)] = 2
    return arr


def build_scene(tmp, regions_by_pair=None, poison=False, organs="liver,spine", lung_cmp=None):
    g, ref, mov, T = moved_scene()
    base = np.zeros(g.size[::-1], np.int16)
    sp = spine_mask(g)
    base[ref] = 1
    base[sp & ~ref] = 2
    # later scans: the reference scene resampled by a known rigid transform
    moved = sitk.GetArrayFromImage(sitk.Resample(g.to_image(base), g.to_image(base), T.GetInverse(), sitk.sitkNearestNeighbor, 0)).astype(np.int16)
    labels = {"a": moved, "b": base, "c": moved}
    job = os.path.join(tmp, "job")
    make_job(job, g, labels, ref="b", regions_by_pair=regions_by_pair, rigid={"a": T, "c": T}, poison=poison, lung_cmp=lung_cmp)
    out = os.path.join(tmp, "pkg")
    pkg = OP.build_package(job, out, organs=organs, face_budget=0)
    return g, job, out, pkg


def test_op5_policy_cases():
    cases = {
        "a_no_failure": ({}, True, True, None),
        "b_liver_spleen_hard_fail": ({"a": {"liver_spleen": "fail"}, "c": {"liver_spleen": "fail"}}, True, False, "liver_spleen"),
        "c_spine_hard_fail": ({"a": {"spine": "fail"}, "c": {"spine": "fail"}}, False, False, "spine"),
        "e_required_region_unknown": ({"a": {"liver_spleen": "unknown"}, "c": {"liver_spleen": "unknown"}}, True, False, "liver_spleen"),
    }
    for name, (regions, rigid_expected, frame_expected, region_named) in cases.items():
        with tempfile.TemporaryDirectory() as tmp:
            g, job, out, pkg = build_scene(tmp, regions_by_pair=regions)
            for tp in ("a", "c"):
                plc = pkg["placements"][tp]
                assert plc["rigid"]["allowed"] is rigid_expected, (name, tp, plc["rigid"])
                assert plc["frame"]["allowed"] is frame_expected, (name, tp, plc["frame"])
                if region_named and not frame_expected:
                    text = plc["frame"]["reason"] + plc["rigid"]["reason"]
                    assert region_named in text or "FAILed" in text or "no number" in text, (name, text)
                rec = pkg["organs"]["liver"]["per_timepoint"][tp]
                assert rec["volume_ml"] > 0 and rec["files"]["mask"] and rec["mesh"]["native"]["file"], name
                assert (rec["mesh"]["rigid"]["status"] == "built") is rigid_expected, (name, rec["mesh"]["rigid"])
                assert (rec["mesh"]["frame"]["status"] == "built") is frame_expected, (name, rec["mesh"]["frame"])
                if not frame_expected:
                    assert rec["mesh"]["frame"]["reason"], name
                assert not os.path.exists(os.path.join(out, "organs", "liver", f"{tp}_frame.glb")) or frame_expected
            assert OP.verify_package(out)["ok"], (name, OP.verify_package(out))


def test_op5d_unexplained_lung_change_withholds_lung_frame_meshes():
    g = grid_of(size=(100, 100, 100))
    arr = np.zeros(g.size[::-1], np.int16)
    arr[(slice(30, 70), slice(30, 70), slice(30, 60))] = 4            # lung_upper_lobe_left
    arr[(slice(30, 70), slice(30, 70), slice(65, 75))] = 1            # liver (so a non-lung organ exists)
    arr[spine_mask(g) & (arr == 0)] = 2
    cmp_ = {"a_to_b": {"computed": True, "explained_by": None, "real_change_supported": True, "delta_volume_ml": -300.0,
                       "delta_volume_frac": -0.1, "delta_aerated_mass_frac": -0.1, "explanation": "not the breath"}}
    with tempfile.TemporaryDirectory() as tmp:
        job = os.path.join(tmp, "job")
        make_job(job, g, {"a": arr, "b": arr}, ref="b", lung_cmp=cmp_, rigid={})
        pkg = OP.build_package(job, os.path.join(tmp, "pkg"), organs="lung_upper_lobe_left,liver,spine", face_budget=0)
        lung = pkg["organs"]["lung_upper_lobe_left"]["per_timepoint"]["a"]["mesh"]
        liver = pkg["organs"]["liver"]["per_timepoint"]["a"]["mesh"]
        assert lung["frame"]["status"] == "withheld" and "breath" in lung["frame"]["reason"], lung["frame"]
        assert liver["frame"]["status"] == "built", liver["frame"]
        ch = pkg["organs"]["lung_upper_lobe_left"]["change"]["vs_reference"]["a"]
        assert ch["lung_volume_explanation"]["real_change_supported"] is True and ch["lung_volume_explanation"]["explanation"] == "not the breath"


def test_op6_slice_table():
    g = grid_of(spacing=(0.8, 0.9, 2.5), size=(110, 110, 44))
    mask = shape_mask(g)
    ct = np.zeros(mask.shape, np.int16)
    zs = np.flatnonzero(mask.any(axis=(1, 2)))
    z0, z1 = zs[0], zs[-1] + 1
    sub = g.cropped((0, 0, int(z0)), (g.size[0], g.size[1], int(z1 - z0)))
    tab = OP.slice_table(mask[z0:z1], ct[z0:z1], sub, int(z0))
    r = tab["rows"]
    total = sum(r["voxels"]) * g.voxel_volume_mm3()
    area_sum = sum(r["area_mm2"]) * g.spacing[2]
    assert abs(area_sum - total) <= 1e-9 * total
    assert abs(total - mask.sum() * g.voxel_volume_mm3()) <= 1e-9 * total
    n = g.normal()
    for k, pos in zip(r["slice_index"], r["position_mm"]):
        assert abs(pos - float(g.index_to_lps([[0, 0, k]])[0] @ n)) < 1e-9
    one = np.zeros(g.size[::-1], bool)
    one[20, 31, 47] = True
    sub1 = g.cropped((0, 0, 20), (g.size[0], g.size[1], 1))
    t1 = OP.slice_table(one[20:21], ct[20:21], sub1, 20)
    assert np.allclose(t1["rows"]["centroid_lps_mm"][0], g.index_to_lps([[47, 31, 20]])[0], atol=5e-4)


def box_labels(g, boxes):
    arr = np.zeros(g.size[::-1], np.int16)
    for label, (zs, ys, xs) in boxes.items():
        arr[zs, ys, xs] = label
    return arr


def test_op7_changes_and_scan_edge():
    g = grid_of(spacing=(1.0, 1.0, 1.0), size=(70, 60, 80), direction=STD)
    # 50 x 40 x 50 voxels = 100 ml; 55 x 40 x 50 = 110 ml; 44 x 40 x 50 = 88 ml (axes x, y, z)
    def liver(nx):
        return {1: (slice(15, 65), slice(10, 50), slice(5, 5 + nx))}
    sp = {2: (slice(5, 75), slice(52, 58), slice(60, 66))}
    maps = {"a": box_labels(g, {**liver(50), **sp}), "b": box_labels(g, {**liver(55), **sp}), "c": box_labels(g, {**liver(44), **sp})}
    with tempfile.TemporaryDirectory() as tmp:
        job = os.path.join(tmp, "job")
        make_job(job, g, maps, ref="a", rigid={})
        pkg = OP.build_package(job, os.path.join(tmp, "pkg"), organs="liver", face_budget=0)
        ch = pkg["organs"]["liver"]["change"]
        assert [round(pkg["organs"]["liver"]["per_timepoint"][t]["volume_ml"], 6) for t in "abc"] == [100.0, 110.0, 88.0]
        assert abs(ch["vs_reference"]["b"]["delta_ml"] - 10.0) < 0.01 and abs(ch["vs_reference"]["b"]["delta_pct"] - 10.0) < 0.01
        assert abs(ch["vs_reference"]["c"]["delta_ml"] + 12.0) < 0.01 and abs(ch["vs_reference"]["c"]["delta_pct"] + 12.0) < 0.01
        assert abs(ch["vs_previous"]["c"]["delta_ml"] + 22.0) < 0.01 and abs(ch["vs_previous"]["c"]["delta_pct"] + 20.0) < 0.01
        assert all(ch[k][t]["delta_assessable"] for k in ch if k.startswith("vs_") for t in ch[k])
        assert ch["repeatability_floor"] is None
    # a liver cut by the first slice of scan b
    def liver_edge(z0):
        return {1: (slice(z0, z0 + 50), slice(10, 50), slice(15, 65))}
    maps2 = {"a": box_labels(g, {**liver(50), **sp}), "b": box_labels(g, {1: (slice(0, 50), slice(10, 50), slice(15, 65)), **sp})}
    with tempfile.TemporaryDirectory() as tmp:
        job = os.path.join(tmp, "job")
        make_job(job, g, maps2, ref="a", rigid={})
        pkg = OP.build_package(job, os.path.join(tmp, "pkg"), organs="liver", face_budget=0)
        row = pkg["organs"]["liver"]["change"]["vs_reference"]["b"]
        assert row["delta_assessable"] is False and "lower bound" in row["reason"] and "b" in row["reason"], row
        assert pkg["organs"]["liver"]["per_timepoint"]["b"]["scan_edge"]["first_slice"] is True


def test_op8_integrity_and_determinism():
    with tempfile.TemporaryDirectory() as tmp:
        g, job, out, pkg = build_scene(tmp)
        assert OP.verify_package(out)["ok"]
        # a second build is the same package
        out2 = os.path.join(tmp, "pkg2")
        pkg2 = OP.build_package(job, out2, organs="liver,spine", face_budget=0)
        assert [(e["path"], e["sha256"]) for e in pkg["files"]] == [(e["path"], e["sha256"]) for e in pkg2["files"]]
        a = json.load(open(os.path.join(out, "package.json")))
        b = json.load(open(os.path.join(out2, "package.json")))
        a.pop("build"); b.pop("build")
        assert a == b
        # one changed byte in a mesh
        mesh = os.path.join(out, "organs", "liver", "a_rigid.glb")
        data = bytearray(open(mesh, "rb").read())
        data[-5] ^= 0xFF
        open(mesh, "wb").write(bytes(data))
        res = OP.verify_package(out)
        assert not res["ok"] and any("a_rigid.glb" in p for p in res["problems"]), res
        shutil.copy(os.path.join(out2, "organs", "liver", "a_rigid.glb"), mesh)
        assert OP.verify_package(out)["ok"]
        # a deleted file
        victim = os.path.join(out, "organs", "liver", "b_mask.nii.gz")
        os.rename(victim, victim + ".x")
        res = OP.verify_package(out)
        assert not res["ok"] and any("b_mask.nii.gz" in p for p in res["problems"]), res
        os.rename(victim + ".x", victim)
        # an extra file
        open(os.path.join(out, "organs", "liver", "stray.txt"), "w").write("x")
        res = OP.verify_package(out)
        assert not res["ok"] and any("stray.txt" in p for p in res["problems"]), res


def test_op9_privacy():
    with tempfile.TemporaryDirectory() as tmp:
        g, job, out, pkg = build_scene(tmp, poison=True)
        text = open(os.path.join(out, "package.json")).read()
        for needle in ("PatientName", "PatientID", "PatientBirthDate", "InstitutionName", "ReferringPhysicianName", "Smith", "MRN-4455",
                       "Test Hospital", "19700101"):
            assert needle not in text, needle
        for root, _, fs in os.walk(out):
            for fn in fs:
                if fn.endswith(".glb"):
                    raw = open(os.path.join(root, fn), "rb").read()
                    assert b"Smith" not in raw and b"PatientName" not in raw
        assert pkg["timepoints"][0]["protocol"]["manufacturer"] == "TEST"


def test_op10_ct_crop_equals_the_source():
    with tempfile.TemporaryDirectory() as tmp:
        g, job, out, pkg = build_scene(tmp)
        rec = pkg["organs"]["liver"]["per_timepoint"]["b"]
        crop = sitk.ReadImage(os.path.join(out, rec["files"]["ct"]))
        src = sitk.ReadImage(os.path.join(job, "native", "b", "ct.nii.gz"))
        ca, sa = sitk.GetArrayFromImage(crop), sitk.GetArrayFromImage(src)
        z0, y0, x0 = rec["crop"]["start_zyx"]
        assert np.array_equal(ca, sa[z0:z0 + ca.shape[0], y0:y0 + ca.shape[1], x0:x0 + ca.shape[2]])
        for (i, j, k) in ((0, 0, 0), (3, 4, 5), (ca.shape[2] - 1, ca.shape[1] - 1, ca.shape[0] - 1)):
            a = np.array(crop.TransformIndexToPhysicalPoint((i, j, k)))
            b = np.array(src.TransformIndexToPhysicalPoint((x0 + i, y0 + j, z0 + k)))
            assert np.abs(a - b).max() < 1e-3


def test_op11_scan_edge_flags():
    m = np.zeros((20, 30, 40), bool)
    m[5:10, 5:10, 5:10] = True
    assert OP.scan_edge(m)["cut_by_scan_range"] is False
    for sl, key in (((0, slice(5, 10), slice(5, 10)), "first_slice"), ((19, slice(5, 10), slice(5, 10)), "last_slice"),
                    ((slice(5, 10), 0, slice(5, 10)), "inplane_border"), ((slice(5, 10), slice(5, 10), 39), "inplane_border")):
        m2 = m.copy()
        m2[sl] = True
        e = OP.scan_edge(m2)
        assert e[key] is True and e["cut_by_scan_range"] is True, (key, e)


def test_op12_composites_are_unions_of_their_lobes():
    g = grid_of(size=(100, 100, 100), direction=STD)
    arr = np.zeros(g.size[::-1], np.int16)
    arr[30:60, 30:60, 20:45] = 4
    arr[30:60, 30:60, 50:70] = 5
    arr[30:60, 30:60, 75:90] = 6
    arr[spine_mask(g) & (arr == 0)] = 2
    with tempfile.TemporaryDirectory() as tmp:
        job = os.path.join(tmp, "job")
        make_job(job, g, {"a": arr, "b": arr}, ref="b", rigid={})
        pkg = OP.build_package(job, os.path.join(tmp, "pkg"), organs="lung_left,lung_right,lung_upper_lobe_left,lung_lower_lobe_left", face_budget=0)
        v = {o: pkg["organs"][o]["per_timepoint"]["b"]["volume_ml"] for o in pkg["organs"]}
        assert abs(v["lung_left"] - (v["lung_upper_lobe_left"] + v["lung_lower_lobe_left"])) < 1e-9
        assert abs(v["lung_right"] - 15 * 30 * 30 / 1000.0) < 1e-9


def test_op13_mesh_budget_and_components():
    g = grid_of(size=(110, 110, 110))
    mask = shape_mask(g, axes=np.array([40.0, 35.0, 45.0]), ball=False)
    mesh, info = OP.mesh_from_mask(mask, g, face_budget=5000)
    assert info["decimated"] is True and info["faces"] <= 5000 and info["faces_full_resolution"] > 5000
    two = np.zeros(g.size[::-1], bool)
    p = centres(g)
    c = centre_of(g)
    two |= ((p - (c + np.array([-30.0, 0, 0]))) ** 2).sum(axis=-1) <= 10.0 ** 2
    two |= ((p - (c + np.array([30.0, 0, 0]))) ** 2).sum(axis=-1) <= 10.0 ** 2
    mesh2, info2 = OP.mesh_from_mask(two, g, face_budget=0)
    assert mesh2.body_count == 2
    assert OP.component_stats(two)[0] == 2
    assert 0.0 < OP.component_stats(two)[1] <= 0.55


def test_cli_build_and_verify():
    with tempfile.TemporaryDirectory() as tmp:
        g, job, out, pkg = build_scene(tmp)
        out3 = os.path.join(tmp, "cli_pkg")
        assert OP.main(["build", "--job-out", job, "--out", out3, "--organs", "liver,spine", "--face-budget", "0"]) == 0
        assert OP.main(["verify", out3]) == 0
        assert OP.main(["build", "--job-out", job, "--out", out3, "--organs", "liver"]) == 2     # not into a non-empty folder


# ---------------------------------------------------------------------------------------------------------------------
# Amendment 1 (organ_package_amendment1-20261106.txt): OP13b, OP14, OP15
def hollow_shell_mask(g):
    p = centres(g)
    r = np.linalg.norm(p - centre_of(g), axis=-1)
    return (r <= 20.0) & (r >= 17.0)


def bridge_mask(g):
    p = centres(g)
    c = centre_of(g)
    a = ((p - (c + np.array([-22.0, 0, 0]))) ** 2).sum(axis=-1) <= 10.0 ** 2
    b = ((p - (c + np.array([22.0, 0, 0]))) ** 2).sum(axis=-1) <= 10.0 ** 2
    rod = (((p[..., 1] - c[1]) ** 2 + (p[..., 2] - c[2]) ** 2) <= 1.6 ** 2) & (np.abs(p[..., 0] - c[0]) <= 24.0)
    return a | b | rod


def lobulated_mask(g, seed=7):
    rng = np.random.default_rng(seed)
    p = centres(g)
    c = centre_of(g)
    m = np.zeros(p.shape[:3], bool)
    for _ in range(7):
        off = rng.uniform(-14, 14, 3)
        ax = rng.uniform(8, 18, 3)
        m |= (((p - (c + off)) / ax) ** 2).sum(axis=-1) <= 1.0
    return m


def test_op13b_every_mesh_is_closed_manifold_at_three_budgets():
    import trimesh
    g = grid_of(size=(110, 110, 110))
    shapes = {"hollow shell": hollow_shell_mask(g), "thin bridge": bridge_mask(g), "lobulated": lobulated_mask(g),
              "ellipsoid and ball": shape_mask(g)}
    for name, mask in shapes.items():
        vox_ml = mask.sum() * g.voxel_volume_mm3() / 1000.0
        for budget in (40000, 5000, 0):
            mesh, info = OP.mesh_from_mask(mask, g, face_budget=budget)
            bnd, nonman = OP.edge_report(mesh)
            assert (bnd, nonman) == (0, 0), (name, budget, bnd, nonman, info)
            assert info["closed_manifold"] is True and info["boundary_edges"] == 0 and info["nonmanifold_edges"] == 0
            assert abs(info["mesh_volume_ml"] - vox_ml) / vox_ml <= 0.05, (name, budget, info["mesh_volume_ml"], vox_ml)
            assert info["within_budget"] == (budget == 0 or info["faces"] <= budget), (name, budget, info)
            if info["within_budget"] is False:
                assert "full-resolution" in info["note"], info
            with tempfile.TemporaryDirectory() as d:
                path = os.path.join(d, "o.glb")
                OP.write_glb(mesh, path, "liver", {"schema": OP.SCHEMA, "organ": "liver"})
                geom = next(iter(trimesh.load(path, file_type="glb", force="scene").geometry.values()))
                assert OP.edge_report(geom) == (0, 0), (name, budget, "after the GLB round trip")


def test_op13b_the_old_method_is_not_enough():
    """The reason for the amendment: quadric decimation of a lobulated organ leaves a mesh that is not a closed manifold on some shapes. The edge
    report must be able to see that (a mesh with an edge on three faces, and a mesh with a hole)."""
    import trimesh
    tri = trimesh.Trimesh(vertices=[[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]], faces=[[0, 1, 2], [0, 1, 3], [0, 1, 4]], process=False)
    assert OP.edge_report(tri) == (6, 1)
    box = trimesh.creation.box()
    hole = trimesh.Trimesh(vertices=box.vertices, faces=box.faces[1:], process=False)
    assert OP.edge_report(box) == (0, 0) and OP.edge_report(hole)[0] > 0


def test_op14_frame_caution_names_the_scans_that_are_cut():
    g = grid_of(spacing=(1.0, 1.0, 1.0), size=(70, 60, 80), direction=STD)
    sp = {2: (slice(5, 75), slice(52, 58), slice(60, 66))}
    inside = {1: (slice(15, 65), slice(10, 50), slice(8, 58))}
    cut = {1: (slice(15, 65), slice(10, 50), slice(0, 50))}
    for ref_cut, a_cut, expect_a, expect_c in ((False, True, ["a"], None), (True, False, ["b"], ["b"]), (False, False, None, None)):
        maps = {"a": box_labels(g, {**(cut if a_cut else inside), **sp}), "b": box_labels(g, {**(cut if ref_cut else inside), **sp}),
                "c": box_labels(g, {**inside, **sp})}
        with tempfile.TemporaryDirectory() as tmp:
            job = os.path.join(tmp, "job")
            make_job(job, g, maps, ref="b", rigid={})
            pkg = OP.build_package(job, os.path.join(tmp, "pkg"), organs="liver", face_budget=0)
            for tp, expect in (("a", expect_a), ("c", expect_c)):
                fr = pkg["organs"]["liver"]["per_timepoint"][tp]["mesh"]["frame"]
                assert fr["status"] == "built", fr
                if expect is None:
                    assert "caution" not in fr, (tp, fr)
                else:
                    assert "caution" in fr and all(t in fr["caution"] for t in expect), (tp, fr.get("caution"))


def test_op15_physiology_note_only_on_the_listed_organs():
    g = grid_of(spacing=(1.0, 1.0, 1.0), size=(100, 90, 100), direction=STD)
    boxes = {1: (slice(10, 30), slice(10, 30), slice(10, 30)), 7: (slice(10, 30), slice(10, 30), slice(40, 60)),
             8: (slice(40, 60), slice(10, 30), slice(10, 30)), 9: (slice(40, 60), slice(10, 30), slice(40, 60)),
             4: (slice(40, 60), slice(40, 60), slice(10, 30)), 2: (slice(5, 80), slice(70, 76), slice(80, 86))}
    maps = {"a": box_labels(g, boxes), "b": box_labels(g, boxes)}
    expected = {"stomach": "filling", "heart": "cardiac and contrast phase", "lung_upper_lobe_left": "inspiration"}
    with tempfile.TemporaryDirectory() as tmp:
        job = os.path.join(tmp, "job")
        make_job(job, g, maps, ref="b", rigid={})
        pkg = OP.build_package(job, os.path.join(tmp, "pkg"), organs="liver,spleen,stomach,heart,lung_upper_lobe_left", face_budget=0)
        for organ, orec in pkg["organs"].items():
            ch = orec["change"]
            rows = [r for k in ("vs_reference", "vs_previous") for r in ch[k].values()]
            assert rows
            if organ in expected:
                assert ch["volume_varies_with"] == expected[organ] and all(r["volume_varies_with"] == expected[organ] for r in rows), organ
            else:
                assert "volume_varies_with" not in ch and all("volume_varies_with" not in r for r in rows), organ
    assert set(OP.VOLUME_VARIES_WITH) >= {"stomach", "duodenum", "small_bowel", "colon", "urinary_bladder", "gallbladder", "esophagus", "heart",
                                          "aorta", "inferior_vena_cava", "portal_vein_and_splenic_vein", "lung_left", "lung_right"}


def test_verify_sees_a_mesh_that_is_not_closed_even_when_the_hashes_match():
    """A forged package: the mesh is swapped for one with a hole and every hash is rewritten. The recorded closed_manifold flag is the claim; verify
    reads the mesh again and refuses it."""
    import hashlib
    import trimesh
    with tempfile.TemporaryDirectory() as tmp:
        g, job, out, pkg = build_scene(tmp)
        rec = pkg["organs"]["liver"]["per_timepoint"]["a"]["mesh"]["native"]       # a later scan: its native file is not the reference entry
        assert rec["closed_manifold"] is True
        path = os.path.join(out, rec["file"])
        box = trimesh.creation.box(extents=[0.02, 0.02, 0.02])
        holed = trimesh.Trimesh(vertices=box.vertices, faces=box.faces[1:], process=False)
        OP.write_glb(holed, path, "liver", {"schema": OP.SCHEMA, "organ": "liver"})
        pj = json.load(open(os.path.join(out, "package.json")))
        for e in pj["files"]:
            if e["path"] == rec["file"]:
                e["bytes"], e["sha256"] = os.path.getsize(path), OP.sha256_file(path)
        json.dump(pj, open(os.path.join(out, "package.json"), "w"), indent=1, sort_keys=True)
        with open(os.path.join(out, "SHA256SUMS"), "w") as f:
            for e in pj["files"] + [{"path": "package.json", "sha256": OP.sha256_file(os.path.join(out, "package.json"))}]:
                f.write(f"{e['sha256']}  {e['path']}\n")
        res = OP.verify_package(out)
        assert not res["ok"] and any("closed manifold" in p and rec["file"] in p for p in res["problems"]), res


def test_op13b_a_tight_crop_is_still_closed_manifold():
    """The organ touches every side of the array (a scan edge, or a tight crop): the lattice must still pass outside the organ at every step."""
    g = grid_of(size=(110, 110, 110))
    for mask in (lobulated_mask(g), shape_mask(g, axes=np.array([40.0, 35.0, 45.0]), ball=False)):
        (z0, z1), (y0, y1), (x0, x1) = OP.bbox_zyx(mask)
        tight = mask[z0:z1, y0:y1, x0:x1]
        sub = g.cropped((x0, y0, z0), (x1 - x0, y1 - y0, z1 - z0))
        for budget in (3000, 8000, 0):
            mesh, info = OP.mesh_from_mask(tight, sub, face_budget=budget)
            assert OP.edge_report(mesh) == (0, 0), (budget, info)
            vox = tight.sum() * g.voxel_volume_mm3() / 1000.0
            assert abs(info["mesh_volume_ml"] - vox) / vox <= 0.05, (budget, info)
            assert info["decimated"] is (budget > 0 and info["faces"] < info["faces_full_resolution"])
            if budget > 0 and info["faces_full_resolution"] > budget:
                assert info["within_budget"] is True and info["faces"] <= budget, (budget, info)


def test_op13b_an_organ_cut_by_the_scan_edge_is_closed_manifold():
    """A real case: the scan ends inside the organ, so the mask has flat faces on the border of the array. Every coarser step must still close the
    surface there (the lattice has to pass outside the organ on every side, whatever the array size modulo the step)."""
    g = grid_of(size=(110, 110, 110))
    big = shape_mask(g, axes=np.array([40.0, 35.0, 45.0]), ball=False)
    for cut in ((30, 80), (31, 79), (32, 80), (29, 77)):
        mask = big[cut[0]:cut[1], 20:90, 15:95]
        sub = g.cropped((15, 20, cut[0]), (80, 70, cut[1] - cut[0]))
        assert mask[0].any() and mask[-1].any()
        for budget in (3000, 6000):
            mesh, info = OP.mesh_from_mask(mask, sub, face_budget=budget)
            assert OP.edge_report(mesh) == (0, 0), (cut, budget, info)
            vox = mask.sum() * g.voxel_volume_mm3() / 1000.0
            assert abs(info["mesh_volume_ml"] - vox) / vox <= 0.05, (cut, budget, info)
            assert info["within_budget"] is True and info["faces"] <= budget and info["decimated"] is True, (cut, budget, info)


def test_op13b_a_full_resolution_mesh_that_is_not_manifold_is_replaced_by_a_coarser_one_even_within_budget(monkeypatch=None):
    """Seen on a real warped label map: 3 edges shared by three faces in a mesh under the budget. The builder must look for a closed manifold step
    then too. The full-resolution mesh is spoiled here on purpose (an extra face on an existing edge)."""
    g = grid_of(size=(110, 110, 110))
    mask = shape_mask(g, axes=np.array([30.0, 26.0, 34.0]), ball=False)
    original = OP._mc_mesh

    def spoiled(mask_zyx, grid, step, smooth_iters):
        mesh = original(mask_zyx, grid, step, smooth_iters)
        if step == 1:
            import trimesh
            f = np.asarray(mesh.faces)
            a, b = f[0][0], f[0][1]
            v = np.vstack([mesh.vertices, mesh.vertices[a] + np.array([0.0, 0.0, 3.0])])
            f2 = np.vstack([f, [a, b, len(v) - 1]])
            return trimesh.Trimesh(vertices=v, faces=f2, process=False)
        return mesh
    OP._mc_mesh = spoiled
    try:
        for budget in (0, 400000):
            mesh, info = OP.mesh_from_mask(mask, g, face_budget=budget)
            assert info["closed_manifold"] is True and OP.edge_report(mesh) == (0, 0), (budget, info)
            assert info["march_step"] > 1 and "not a closed manifold" in info["note"], (budget, info)
        OP._mc_mesh = lambda m_, g_, st, sm: (spoiled(m_, g_, st, sm) if st == 1 else (_ for _ in ()).throw(ValueError("no surface")))
        mesh, info = OP.mesh_from_mask(mask, g, face_budget=0)
        assert info["closed_manifold"] is False and "full-resolution mesh is kept" in info["note"], info
    finally:
        OP._mc_mesh = original


# ---------------------------------------------------------------------------------------------------------------------
# Amendment 2 (organ_floor_criteria-20261106.txt, FL4): floors applied to the change rows
def floors_file(path, liver_pct=5.0, with_spleen=False):
    import organ_floor as OF
    srcs = {"S1_perturbation": {"liver": [(liver_pct - 0.1 * i, 3.0) for i in range(10)]}}
    # the largest p95 of the 10 values liver_pct, liver_pct - 0.1 ... is just under liver_pct; make it exact by a constant list
    srcs = {"S1_perturbation": {"liver": [(liver_pct, 3.0)] * 10}}
    if with_spleen:
        srcs["S1_perturbation"]["spleen"] = [(2.0, 1.0)] * 10
    doc = OF.floors_document(srcs, inputs={"made": "for the test"})
    json.dump(doc, open(path, "w"), indent=1, sort_keys=True)
    return doc


def edge_scene(g):
    sp = {2: (slice(5, 75), slice(52, 58), slice(60, 66))}

    def liver(nx, z0=5):
        return {1: (slice(15, 65), slice(10, 50), slice(z0, z0 + nx))}
    return sp, liver


def test_fl4_exceeds_measured_floor_and_nothing_else():
    g = grid_of(spacing=(1.0, 1.0, 1.0), size=(70, 60, 80), direction=STD)
    sp, liver = edge_scene(g)
    maps = {"a": box_labels(g, {**liver(50), **sp}), "b": box_labels(g, {**liver(55), **sp}), "c": box_labels(g, {**liver(44), **sp})}
    with tempfile.TemporaryDirectory() as tmp:
        job = os.path.join(tmp, "job")
        make_job(job, g, maps, ref="a", rigid={})
        fp = os.path.join(tmp, "floors.json")
        floors_file(fp, liver_pct=15.0)
        pkg = OP.build_package(job, os.path.join(tmp, "pkg"), organs="liver,spine", face_budget=0, floors=fp)
        ch = pkg["organs"]["liver"]["change"]
        # 100 -> 110 ml is +10 percent (inside 15), 100 -> 88 is -12 (inside), 110 -> 88 is -20 (beyond)
        assert ch["vs_reference"]["b"]["exceeds_measured_floor"] is False and ch["vs_reference"]["b"]["floor_pct"] == 15.0
        assert ch["vs_reference"]["c"]["exceeds_measured_floor"] is False
        assert ch["vs_previous"]["c"]["exceeds_measured_floor"] is True and abs(ch["vs_previous"]["c"]["delta_pct"] + 20.0) < 0.01
        assert ch["repeatability_floor"]["floor_pct"] == 15.0 and ch["repeatability_floor"]["sources_used"] == ["S1_perturbation"]
        assert ch["repeatability_floor"]["excludes"] and ch["repeatability_floor"]["n_by_source"]["S1_perturbation"] == 10
        # the spine has no floor in this file
        sc = pkg["organs"]["spine"]["change"]
        assert sc["repeatability_floor"] is None
        assert all(r["floor_pct"] is None and r["exceeds_measured_floor"] is None for k in ("vs_reference", "vs_previous") for r in sc[k].values())
        text = open(os.path.join(tmp, "pkg", "package.json")).read()
        assert "clinically relevant" not in text and "clinically significant" not in text
        assert pkg["floors"]["sha256"] == OP.sha256_file(fp) and os.path.isfile(os.path.join(tmp, "pkg", "floors.json"))
        assert OP.verify_package(os.path.join(tmp, "pkg"))["ok"]
        # an organ cut by the scan edge: not assessable, so no verdict about the floor
        maps2 = {"a": box_labels(g, {**liver(50), **sp}), "b": box_labels(g, {1: (slice(15, 65), slice(10, 50), slice(0, 50)), **sp})}
        job2 = os.path.join(tmp, "job2")
        make_job(job2, g, maps2, ref="a", rigid={})
        pkg2 = OP.build_package(job2, os.path.join(tmp, "pkg2"), organs="liver", face_budget=0, floors=fp)
        row = pkg2["organs"]["liver"]["change"]["vs_reference"]["b"]
        assert row["delta_assessable"] is False and row["exceeds_measured_floor"] is None and row["floor_pct"] == 15.0
        # without a floors file nothing of this appears
        pkg3 = OP.build_package(job, os.path.join(tmp, "pkg3"), organs="liver", face_budget=0)
        c3 = pkg3["organs"]["liver"]["change"]
        assert c3["repeatability_floor"] is None and "floors" not in pkg3
        assert all("exceeds_measured_floor" not in r and "floor_pct" not in r for k in ("vs_reference", "vs_previous") for r in c3[k].values())
        assert "clinically relevant" not in open(os.path.join(tmp, "pkg3", "package.json")).read()


def test_fl4_verify_rejects_a_floor_that_differs_from_its_file():
    g = grid_of(spacing=(1.0, 1.0, 1.0), size=(70, 60, 80), direction=STD)
    sp, liver = edge_scene(g)
    maps = {"a": box_labels(g, {**liver(50), **sp}), "b": box_labels(g, {**liver(55), **sp})}
    with tempfile.TemporaryDirectory() as tmp:
        job = os.path.join(tmp, "job")
        make_job(job, g, maps, ref="a", rigid={})
        fp = os.path.join(tmp, "floors.json")
        floors_file(fp, liver_pct=5.0)
        out = os.path.join(tmp, "pkg")
        OP.build_package(job, out, organs="liver", face_budget=0, floors=fp)
        # the floors file inside the package is edited: a changed file
        inner = os.path.join(out, "floors.json")
        data = json.load(open(inner))
        data["organs"]["liver"]["floor_pct"] = 1.0
        json.dump(data, open(inner, "w"), indent=1, sort_keys=True)
        res = OP.verify_package(out)
        assert not res["ok"] and any("floors.json" in p or "floors file" in p for p in res["problems"]), res
        # the recorded floor in package.json is edited and every hash rewritten: the floors file hash and the record disagree
        out2 = os.path.join(tmp, "pkg2")
        OP.build_package(job, out2, organs="liver", face_budget=0, floors=fp)
        pj = json.load(open(os.path.join(out2, "package.json")))
        pj["organs"]["liver"]["change"]["repeatability_floor"]["floor_pct"] = 99.0
        json.dump(pj, open(os.path.join(out2, "package.json"), "w"), indent=1, sort_keys=True)
        with open(os.path.join(out2, "SHA256SUMS"), "w") as f:
            for e in pj["files"] + [{"path": "package.json", "sha256": OP.sha256_file(os.path.join(out2, "package.json"))}]:
                f.write(f"{e['sha256']}  {e['path']}\n")
        res2 = OP.verify_package(out2)
        assert not res2["ok"] and any("differs from the floors file" in p for p in res2["problems"]), res2
