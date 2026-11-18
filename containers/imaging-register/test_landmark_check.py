"""Tests for landmark_check.py. numpy/scipy/skimage always; the transform-direction test needs SimpleITK + ANTsPy."""
import os, sys, tempfile
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_check as L


def smooth_volume(shape, seed=0):
    from scipy import ndimage
    rng = np.random.default_rng(seed)
    return np.clip(ndimage.gaussian_filter(rng.normal(-300, 250, shape), 2.0), -1000, 300).astype(np.float32)


def test_match_patch_recovers_a_known_shift():
    f = smooth_volume((90, 90, 90))
    m = np.roll(f, (3, -2, 4), axis=(0, 1, 2))
    got = L.match_patch(f, m, (45, 45, 45), (45, 45, 45), L.DEFAULT_PROPOSAL)
    assert np.allclose(got["index_zyx"], [48, 43, 49], atol=0.3), got
    assert got["ncc"] > 0.99 and got["second_ncc"] < got["ncc"]


def test_match_patch_returns_none_at_the_border_or_on_a_flat_patch():
    f = smooth_volume((60, 60, 60))
    assert L.match_patch(f, f, (3, 30, 30), (3, 30, 30), L.DEFAULT_PROPOSAL) is None
    flat = np.full((60, 60, 60), -800, np.float32)
    assert L.match_patch(flat, flat, (30, 30, 30), (30, 30, 30), L.DEFAULT_PROPOSAL) is None


def test_zone_balanced_picking_covers_both_lungs_and_thirds():
    shape = (120, 100, 140)
    ct = np.full(shape, 40.0, np.float32)                       # soft tissue
    zz, yy, xx = np.indices(shape)
    for cx in (40, 100):                                        # two lungs: air with bright vessel dots
        lung = ((zz - 60) / 55.0) ** 2 + ((yy - 50) / 34.0) ** 2 + ((xx - cx) / 28.0) ** 2 <= 1
        ct[lung] = -850
    rng = np.random.default_rng(1)
    for _ in range(150):
        z, y, x = rng.integers(15, 105), rng.integers(30, 70), rng.choice([rng.integers(20, 60), rng.integers(80, 120)])
        ct[max(0, z - 1):z + 2, y - 1:y + 2, x - 1:x + 2] = 100
    resp = L.foerstner_response(ct)
    lung = L.lung_mask_from_ct(ct)
    # the body is the whole box here; the lungs are the air components not touching the border
    assert lung.sum() > 150000
    c = L.pick_zone_balanced(resp, lung, (ct > -100) & (ct < 300), np.ones(3), L.DEFAULT_PROPOSAL)
    zones = {k["zone"] for k in c}
    assert any(z.startswith("lung_left") for z in zones) and any(z.startswith("lung_right") for z in zones)
    assert {"lower", "mid", "upper"} <= {z.split("_")[-1] for z in zones if z.startswith("lung")}
    idx = np.array([k["index_zyx"] for k in c])
    d = np.linalg.norm(idx[:, None, :] - idx[None, :, :], axis=2) + np.eye(len(c)) * 1e9
    assert d.min() >= L.DEFAULT_PROPOSAL["min_spacing_mm"] / 2 - 1e-6


def test_lungs_joined_to_the_top_slice_by_the_trachea_are_found_and_the_airway_is_dropped():
    """Real chest scans: the lungs, trachea included, form one air component that touches the top slice.
    The air outside the body touches the sides of the image and must not be taken for lung."""
    shape = (140, 120, 160)
    ct = np.full(shape, 40.0, np.float32)
    zz, yy, xx = np.indices(shape)
    ct[(xx < 5) | (xx >= 155) | (yy < 5) | (yy >= 115)] = -1000          # air outside the body, touches the sides
    for cx in (45, 115):
        ct[((zz - 60) / 50.0) ** 2 + ((yy - 60) / 34.0) ** 2 + ((xx - cx) / 28.0) ** 2 <= 1] = -850
    ct[(zz >= 60) & ((yy - 60) ** 2 + (xx - 80) ** 2 <= 8 ** 2)] = -1000   # trachea up to the top slice
    ct[(np.abs(zz - 100) <= 6) & ((yy - 60) ** 2 + (zz - 100) ** 2 <= 6 ** 2) & (xx >= 45) & (xx <= 115)] = -1000   # main bronchi
    lung = L.lung_mask_from_ct(ct)
    assert lung.sum() > 300000
    assert lung[60, 60, 45] and lung[60, 60, 115]
    assert not lung[:, :, 0].any() and not lung[:, 0, :].any(), "outside air taken for lung"
    assert not lung[130, 60, 80], "trachea kept"


def test_verify_marks_unlisted_proposals_as_rejected_and_skips_filtered():
    import json
    prop = {"criteria_sha256": "x", "movers": ["jun17"], "landmarks": [
        {"id": "L01", "matches": {"jun17": {"status": "proposed"}}, "verdict": {"jun17": None}},
        {"id": "L02", "matches": {"jun17": {"status": "proposed"}}, "verdict": {"jun17": None}},
        {"id": "L03", "matches": {"jun17": {"status": "filtered_low_confidence"}}, "verdict": {"jun17": None}},
        {"id": "L04", "matches": {"jun17": {"status": "proposed"}}, "verdict": {"jun17": None}}]}
    with tempfile.TemporaryDirectory() as d:
        pp, op = os.path.join(d, "p.json"), os.path.join(d, "v.json")
        json.dump(prop, open(pp, "w"))
        r = L.verify(pp, "jun17", ["L01"], {"L04": ["1", "2", "3"]}, op)
        assert r["accepted"] == 1 and r["rejected"] == 1 and r["corrected"] == 1
        v = {c["id"]: c["verdict"]["jun17"] for c in json.load(open(op))["landmarks"]}
        assert v["L01"] == "accept" and v["L02"] == "reject" and v["L03"] is None
        assert v["L04"] == {"corrected_moving_phys_mm": [1.0, 2.0, 3.0]}
        try:
            L.verify(pp, "jun17", ["L99"], {}, op)
        except SystemExit:
            pass
        else:
            raise AssertionError("unknown id accepted")


def test_tre_stats_and_empty():
    s = L.tre_stats([1.0, 2.0, 3.0, 10.0])
    assert s["n"] == 4 and s["median_mm"] == 2.5 and s["max_mm"] == 10.0
    assert L.tre_stats([]) is None


def test_criteria_are_registered_once_and_hashed():
    c = L.default_criteria("job-x")
    assert c["pass"]["deformable_median_tre_mm_max"] == 2.0 and "Provisional" in c["status"]
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "c.json")
        L.main(["criteria", "--job", "job-x", "--out", p])
        h = L.file_sha256(p)
        try:
            L.main(["criteria", "--job", "job-x", "--out", p])
        except SystemExit:
            pass
        else:
            raise AssertionError("criteria were rewritten")
        assert L.file_sha256(p) == h


def test_mapping_direction_with_a_known_translation():
    try:
        import SimpleITK as sitk, ants
    except Exception:
        print("skip (no SimpleITK/ANTs)")
        return
    shape = (70, 70, 70)
    ct = smooth_volume(shape, 2)
    fixed = sitk.GetImageFromArray(ct); fixed.SetSpacing((1.0, 1.0, 1.0)); fixed.SetOrigin((0.0, 0.0, 0.0))
    t = np.array([6.0, -4.0, 3.0])                               # fixed -> moving: x_m = x_f + t
    with tempfile.TemporaryDirectory() as d:
        tr = ants.create_ants_transform(transform_type="AffineTransform", dimension=3, matrix=np.eye(3), translation=tuple(t))
        idt = ants.create_ants_transform(transform_type="AffineTransform", dimension=3, matrix=np.eye(3), translation=(0.0, 0.0, 0.0))
        ptr, pid = os.path.join(d, "t.mat"), os.path.join(d, "i.mat")
        ants.write_transform(tr, ptr); ants.write_transform(idt, pid)
        p_f = np.array([35.0, 35.0, 35.0])
        p_m = p_f + t
        stages = {"initial": [pid], "rigid": [ptr], "deformable": {"body": [ptr], "regions": []}}
        res = L.map_moving_point_to_fixed(ants, sitk, fixed, p_f, p_m, stages, {})
        err = {k: float(np.linalg.norm(np.array(v["fixed_phys_mm"]) - p_f)) for k, v in res.items()}
        assert err["rigid"] < 0.3 and err["deformable"] < 0.3, err      # the right transform puts the point home
        assert abs(err["initial"] - np.linalg.norm(t)) < 0.5, err       # the identity leaves the full offset


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for f in fns:
        f(); print("ok", f.__name__)
    print(f"{len(fns)} passed")


# ---- the reading page (added 2026-11-04)
def _cands(n=8):
    zones = ["lung_left_upper", "lung_right_lower", "other", "lung_left_lower"]
    out = []
    for i in range(n):
        out.append({"id": f"L{i + 1:02d}", "zone": zones[i % 4], "index_zyx": [40, 40, 40],
                    "matches": {"jun17": {"status": "proposed", "ncc": 0.99 - 0.01 * i, "moving_phys_mm": [1.0, 2.0, 3.0 + i]},
                                "oct21": {"status": "proposed" if i % 3 else "filtered_low_confidence", "ncc": 0.95, "moving_phys_mm": [1.0, 2.0, 3.0]}},
                    "verdict": {"jun17": None, "oct21": None}})
    return out


def test_the_crosshair_leaves_a_gap_at_the_centre_and_is_red_elsewhere():
    im = np.full((49, 49), -1000.0, np.float32)
    p = L._panel(im, -1000, 200)
    c = p.shape[0] // 2
    assert tuple(p[c, c]) == (0, 0, 0) and tuple(p[c, c + 3]) == (0, 0, 0)       # the structure under the point is visible
    assert tuple(p[c, 5]) == (255, 59, 59) and tuple(p[5, c]) == (255, 59, 59)    # the arms are drawn outside the gap
    assert tuple(p[c, p.shape[1] - 6]) == (255, 59, 59)


def test_decoys_are_moved_by_the_stated_distance_and_cards_carry_no_scores():
    items, key = L.build_review_items(_cands(), ["jun17", "oct21"], n_decoys=2, seed=3)
    real = [i for i in items if not i["decoy"]]
    decoys = [i for i in items if i["decoy"]]
    assert len(decoys) == 4 and len({i["id"] for i in items}) == len(items)
    assert all(abs(np.linalg.norm(d["shift_mm"]) - L.DECOY_SHIFT_MM) < 0.01 for d in decoys)
    assert {i["landmark"] for i in real if i["mover"] == "oct21"} == {c["id"] for c in _cands() if c["matches"]["oct21"]["status"] == "proposed"}
    html = L.page_html([{**i, "png": "AAAA", "zone_text": "x"} for i in items], "pid")
    assert "ncc" not in html.lower() and "NCC" not in html and "http" not in html          # no score shown, nothing fetched
    assert 'id="reader"' in html and 'id="role"' in html and "Unsure" in html
    assert not any(k.startswith("L") for k in key)                                         # ids are opaque


def test_render_item_returns_two_rows_of_three_views():
    import SimpleITK as sitk
    fa = np.zeros((70, 70, 70), np.float32) - 800
    ma = fa.copy()
    mx = sitk.GetImageFromArray(ma); mx.SetSpacing((1, 1, 1)); mx.SetOrigin((0, 0, 0))
    c = _cands(1)[0]; c["index_zyx"] = [35, 35, 35]; c["matches"]["jun17"]["moving_phys_mm"] = [35.0, 35.0, 35.0]
    a = L.render_item(fa, ma, mx, c, "jun17")
    b = L.render_item(fa, ma, mx, c, "jun17", shift_mm=[8, 0, 0])
    assert a.shape[1] == 3 * 49 * 5 and a.shape[0] == 2 * 49 * 5 + 6 and a.shape == b.shape


def _export(td, accept_all=True, decoy_accept=0, reader="Reader One", role="radiologist", drop=0, page="same"):
    import json
    items, key = L.build_review_items(_cands(), ["jun17", "oct21"], n_decoys=2, seed=3)
    keyf = {"page_id": "pid", "movers": ["jun17", "oct21"], "items": key, "decoy_shift_mm": 8.0, "max_decoys_accepted": 1}
    dec, n_dec = {}, {"jun17": 0, "oct21": 0}
    for i in items:
        if i["decoy"]:
            n_dec[i["mover"]] += 1
            dec[i["id"]] = "accept" if n_dec[i["mover"]] <= decoy_accept else "reject"
        else:
            dec[i["id"]] = "accept" if accept_all else "reject"
    for i in list(dec)[:drop]:
        del dec[i]
    prop = {"criteria_sha256": "x", "movers": ["jun17", "oct21"], "landmarks": _cands()}
    paths = {k: os.path.join(td, k) for k in ("prop.json", "key.json", "exp.json", "ver.json")}
    json.dump(prop, open(paths["prop.json"], "w")); json.dump(keyf, open(paths["key.json"], "w"))
    json.dump({"page_id": "pid" if page == "same" else "other", "reader": reader, "reader_role": role, "decisions": dec}, open(paths["exp.json"], "w"))
    return paths


def test_an_export_becomes_a_signed_verification_and_decoys_are_not_landmarks():
    import json
    with tempfile.TemporaryDirectory() as d:
        p = _export(d, accept_all=True, decoy_accept=1)
        s = L.verify_export(p["prop.json"], p["key.json"], p["exp.json"], p["ver.json"])
        v = json.load(open(p["ver.json"]))
        assert s["jun17"]["reader"] == "Reader One" and s["jun17"]["reader_role"] == "radiologist"
        assert s["jun17"]["accepted"] == 8 and s["oct21"]["accepted"] == 5          # only real landmarks, only the proposed ones
        assert s["jun17"]["decoy_check"]["accepted"] == 1 and L.reader_view(v["reviewed"]["jun17"])["reader_check"] == "OK"
        assert all(c["verdict"]["jun17"] == "accept" for c in v["landmarks"])


def test_a_reader_who_accepts_wrong_decoys_is_marked_unreliable():
    import json
    with tempfile.TemporaryDirectory() as d:
        p = _export(d, accept_all=True, decoy_accept=2)
        L.verify_export(p["prop.json"], p["key.json"], p["exp.json"], p["ver.json"])
        v = json.load(open(p["ver.json"]))
        assert L.reader_view(v["reviewed"]["jun17"])["reader_check"] == "UNRELIABLE"
    assert L.reader_view(None)["reader_check"] == "not_measured"


def test_an_export_without_name_role_or_every_decision_or_for_another_page_is_refused():
    for kw in ({"reader": ""}, {"role": " "}, {"drop": 1}, {"page": "other"}):
        with tempfile.TemporaryDirectory() as d:
            p = _export(d, **kw)
            try:
                L.verify_export(p["prop.json"], p["key.json"], p["exp.json"], p["ver.json"])
            except SystemExit:
                continue
            raise AssertionError(f"accepted a bad export: {kw}")


# ---- liver mode (2026-11-05): the check of the interior of the liver for the abdomen frame
def test_liver_zones_cover_halves_and_thirds_inside_the_mask():
    shape = (120, 100, 140)
    zz, yy, xx = np.indices(shape)
    liver = (((zz - 60) / 45.0) ** 2 + ((yy - 50) / 30.0) ** 2 + ((xx - 70) / 55.0) ** 2) <= 1
    rng = np.random.default_rng(3)
    resp = rng.random(shape).astype(np.float32)
    props = dict(L.LIVER_PROPOSAL)
    sp = np.array([1.0, 1.0, 1.0])
    got = L.pick_liver_zones(resp, liver, sp, props)
    zones = {c["zone"] for c in got}
    assert zones == {f"liver_{s}_{t}" for s in ("left", "right") for t in ("upper", "mid", "lower")}, zones
    for z in zones:
        pts = [np.array(c["index_zyx"]) for c in got if c["zone"] == z]
        assert 1 <= len(pts) <= props["per_zone"]
        for i in range(len(pts)):
            for j in range(i):
                assert np.linalg.norm(pts[i] - pts[j]) >= props["min_spacing_mm"]
    assert all(liver[tuple(c["index_zyx"])] for c in got)
    assert L.pick_liver_zones(resp, np.zeros(shape, bool), sp, props) == []


def test_liver_criteria_share_the_chest_pass_numbers_and_name_the_region():
    lung = L.default_criteria("job")
    liv = L.default_criteria("job", "liver")
    assert liv["proposal"]["region"] == "liver" and "region" not in lung["proposal"]
    assert liv["pass"] == lung["pass"]
    assert liv["sufficiency"]["min_per_side"] == 4 and "min_per_lung" not in liv["sufficiency"]
    assert "hepatic or portal vein" in liv["verification"]["who"] and "surface" in liv["reading"]


def test_liver_zone_text_window_and_page_wording():
    assert L._zone_text("liver_right_upper") == "liver, right upper zone"
    assert L._zone_text("lung_left_lower") == "left lower lung zone"
    assert L.window_for("liver_left_mid") == (-20, 220) and L.window_for("lung_left_mid") == (-1000, 200) and L.window_for("other") == (-160, 240)
    item = [{"id": "i001", "mover": "m", "zone_text": "liver, left mid zone", "png": ""}]
    assert "inside the liver" in L.page_html(item, "p", "(a vein branch point inside the liver, where a hepatic or portal vein divides)")
    assert "fissure point" in L.page_html(item, "p")


# ---- liver proposal version 2 (2026-11-05): residual liver offset, band-pass matching, forward-backward check
def test_liver_offset_is_the_residual_left_after_the_rigid_step():
    off = L.liver_offset((10.0, 20.0, 30.0), (40.0, 22.0, 31.0), lambda p: tuple(np.array(p) + np.array([5.0, 0.0, 0.0])))
    assert np.allclose(off, [25.0, 2.0, 1.0]), off


def _liver_props():
    return dict(L.LIVER_PROPOSAL, soft_lo_hu=-1000.0, soft_hi_hu=300.0)


def test_band_pass_matching_recovers_a_shift_across_a_nonlinear_contrast_change_and_the_cycle_check_agrees():
    from scipy import ndimage
    props = _liver_props()
    f = smooth_volume((100, 100, 100), seed=5)
    shifted = np.roll(f, (4, -3, 5), axis=(0, 1, 2))
    rng = np.random.default_rng(8)
    m = 200.0 * np.tanh((shifted + 300.0) / 300.0) + rng.normal(0, 6, f.shape)       # another "phase": monotone but not affine, plus noise
    m = ndimage.gaussian_filter(m, 0.7)
    fd, md = L.dog_filter(f, props), L.dog_filter(m, props)
    clip = (-1.0e4, 1.0e4)
    got = L.match_patch(fd, md, (50, 50, 50), (50, 50, 50), props, clip=clip)
    assert got is not None and np.allclose(got["index_zyx"], [54, 47, 55], atol=0.7), got
    cyc = L.cycle_distance(fd, md, (50, 50, 50), got["index_zyx"], props, clip=clip)
    assert cyc is not None and cyc < 1.0, cyc


def test_the_cycle_distance_equals_the_error_of_a_forward_match_that_is_off():
    """On two scans that really correspond, matching back from a point that is d voxels off the true counterpart lands about d from the start.
    The check therefore catches a forward match that is off; it does not prove a match right (mutual best matches also occur between
    unrelated scans), which is why a reader still decides."""
    props = _liver_props()
    f = smooth_volume((100, 100, 100), seed=5)
    m = np.roll(f, (4, -3, 5), axis=(0, 1, 2))
    fd, md = L.dog_filter(f, props), L.dog_filter(m, props)
    clip = (-1.0e4, 1.0e4)
    right = L.cycle_distance(fd, md, (50, 50, 50), (54, 47, 55), props, clip=clip)
    off = L.cycle_distance(fd, md, (50, 50, 50), (54, 47, 60), props, clip=clip)           # 5 voxels off along x
    assert right is not None and right < 1.0, right
    assert off is not None and 3.5 < off < 6.5, off


def test_the_registered_first_liver_proposal_is_kept_for_the_record():
    assert L.LIVER_PROPOSAL_V1["ncc_min"] == 0.60 and L.LIVER_PROPOSAL["version"] == 2
    assert L.LIVER_PROPOSAL["dog"] and L.LIVER_PROPOSAL["liver_offset"] and L.LIVER_PROPOSAL["cycle_max_mm"] == 2.0
