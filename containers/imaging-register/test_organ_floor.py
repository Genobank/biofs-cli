"""Known-answer tests for organ_floor.py. Criteria FL1 to FL3, FL5 are in organ_floor_criteria-20261106.txt (hashed before the module existed).
Synthetic volumes only. Needs numpy, scipy, SimpleITK, scikit-image, trimesh. No GPU, no TotalSegmentator."""
import json
import os
import tempfile

import numpy as np
import SimpleITK as sitk

import organ_floor as OF
import organ_package as OP


def image(shape=(60, 60, 60), value=100.0, dtype=np.float32, spacing=(1.0, 1.0, 1.0), direction=None, origin=(-31.2, 12.5, -88.1)):
    img = sitk.GetImageFromArray(np.full(shape, value, dtype))
    img.SetSpacing(spacing)
    img.SetOrigin(origin)
    if direction is not None:
        img.SetDirection(tuple(float(v) for v in np.asarray(direction).ravel()))
    return img


def arr(img):
    return sitk.GetArrayFromImage(img)


def test_fl1_noise_sd_seed_and_type():
    base = image()
    out = OF.apply_variant(base, {"noise_hu": 10.0, "seed": 1})
    sd = float((arr(out) - arr(base)).std())
    assert abs(sd - 10.0) <= 0.3, sd
    again = OF.apply_variant(base, {"noise_hu": 10.0, "seed": 1})
    other = OF.apply_variant(base, {"noise_hu": 10.0, "seed": 2})
    assert arr(out).tobytes() == arr(again).tobytes() and arr(out).tobytes() != arr(other).tobytes()
    ints = OF.apply_variant(image(value=-1000, dtype=np.int16), {"noise_hu": 200.0, "seed": 3})
    assert arr(ints).dtype == np.int16 and arr(ints).min() >= -32768 and arr(ints).max() <= 32767


def test_fl1_blur_effective_sigma():
    base = image(shape=(41, 41, 41), value=0.0)
    a = arr(base).copy()
    a[20, 20, 20] = 1000.0
    base = sitk.GetImageFromArray(a)
    base.SetSpacing((1.0, 1.0, 1.0))
    out = arr(OF.apply_variant(base, {"blur_mm": 0.6})).astype(np.float64)
    w = out / out.sum()
    idx = np.arange(41, dtype=float)
    for ax in range(3):
        marg = w.sum(axis=tuple(i for i in range(3) if i != ax))
        mean = (marg * idx).sum()
        sigma = float(np.sqrt((marg * (idx - mean) ** 2).sum()))
        assert abs(sigma - 0.6) / 0.6 <= 0.05, (ax, sigma)


def test_fl1_shift_matches_the_analytic_shifted_image():
    n = 64
    k, j, i = np.indices((n, n, n)).astype(np.float64)
    f = lambda x, y, z: 100.0 * np.sin(2 * np.pi * (x + 0.7 * y + 0.4 * z) / 37.0)
    img = sitk.GetImageFromArray(f(i, j, k).astype(np.float32))
    img.SetSpacing((1.0, 1.0, 1.0))
    out = arr(OF.apply_variant(img, {"shift_mm": 0.5}))
    expect = f(i + 0.5, j + 0.5, k + 0.5)
    inner = (slice(6, n - 6),) * 3
    assert np.abs(out[inner] - expect[inner]).max() <= 0.02 * 100.0


def test_fl1_zero_specs_return_the_original_and_the_grid_is_kept():
    base = image(shape=(30, 34, 38), dtype=np.int16, spacing=(0.8, 0.9, 1.1),
                 direction=np.array([[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]))
    assert OF.apply_variant(base, {}) is base
    z = OF.apply_variant(base, {"noise_hu": 0.0, "blur_mm": 0.0, "shift_mm": 0.0})
    assert np.array_equal(arr(z), arr(base))
    for _, spec in OF.VARIANTS:
        out = OF.apply_variant(base, spec)
        assert out.GetSize() == base.GetSize() and out.GetPixelID() == base.GetPixelID()
        assert out.GetOrigin() == base.GetOrigin() and out.GetSpacing() == base.GetSpacing() and out.GetDirection() == base.GetDirection()


NAMES = {1: "liver", 2: "vertebrae_T8", 3: "lung_upper_lobe_left", 4: "lung_lower_lobe_left", 5: "spleen"}


def test_fl2_volumes_and_cut_flags():
    a = np.zeros((40, 50, 60), np.int16)
    a[5:15, 10:30, 10:40] = 1
    a[0:5, 5:15, 5:9] = 5
    a[20:30, 20:30, 20:30] = 3
    a[20:30, 20:30, 31:35] = 4
    tab = OF.organ_table(a, 0.00072, NAMES)
    assert abs(tab["liver"]["volume_ml"] - 10 * 20 * 30 * 0.00072) < 1e-12 and tab["liver"]["cut"] is False
    assert tab["spleen"]["cut"] is True
    assert abs(tab["lung_left"]["volume_ml"] - (1000 + 400) * 0.00072) < 1e-12
    assert tab["lung_left"]["cut"] == OP.scan_edge(np.isin(a, [3, 4]))["cut_by_scan_range"]
    assert "colon" not in tab


def test_fl3_pooling_matches_numpy_and_drops_cut_organs():
    rng = np.random.default_rng(5)
    vals = [(float(x), float(x) * 3.0) for x in rng.uniform(0, 8, 25)]
    st = OF.stats(vals)
    p = np.array([v[0] for v in vals])
    assert abs(st["p95_pct"] - np.percentile(p, 95)) < 1e-9 and abs(st["median_pct"] - np.median(p)) < 1e-9 and abs(st["max_pct"] - p.max()) < 1e-9
    assert st["n"] == 25 and abs(st["p95_ml"] - np.percentile([v[1] for v in vals], 95)) < 1e-9
    assert OF.stats(vals[:7]) is None
    ref = {"liver": {"volume_ml": 100.0, "cut": False}, "spleen": {"volume_ml": 50.0, "cut": True}, "colon": {"volume_ml": 10.0, "cut": False}}
    var = {"liver": {"volume_ml": 103.0, "cut": False}, "spleen": {"volume_ml": 52.0, "cut": False}, "colon": {"volume_ml": 9.0, "cut": True}}
    cmp_ = OF.compare_tables(ref, var)
    assert set(cmp_) == {"liver"} and abs(cmp_["liver"][0] - 3.0) < 1e-12 and abs(cmp_["liver"][1] - 3.0) < 1e-12
    assert OF.compare_tables(ref, {}) == {}


def test_fl3_floor_is_the_largest_p95_over_sources_with_enough_values():
    a = [(1.0 + 0.1 * i, 2.0) for i in range(10)]
    b = [(4.0 + 0.1 * i, 9.0) for i in range(8)]
    c = [(50.0, 99.0)] * 7
    srcs = {"S1": {"liver": a, "spleen": a[:5]}, "S2": {"liver": b}, "S3": {"liver": c}}
    fl = OF.combine_floors(srcs, organs=("liver", "spleen", "colon"))
    assert abs(fl["liver"]["floor_pct"] - np.percentile([x[0] for x in b], 95)) < 1e-9 and fl["liver"]["set_by"] == "S2"
    assert fl["liver"]["sources_used"] == ["S1", "S2"] and fl["liver"]["by_source"]["S3"]["floor"] is None
    assert fl["spleen"]["floor_pct"] is None and "no source" in fl["spleen"]["reason"]
    assert fl["colon"]["floor_pct"] is None


def test_fl3_floors_file_has_sources_limits_and_is_deterministic():
    with tempfile.TemporaryDirectory() as d:
        tab = lambda v: {"liver": {"volume_ml": v, "cut": False}}
        orig = tab(100.0)
        s1 = {"job_id": "j", "scan": "a", "original": orig,
              "variants": {f"V{k}": {"spec": {}, "table": tab(100.0 + k)} for k in range(0, 7)}}
        fp = os.path.join(d, "s1.json")
        json.dump(s1, open(fp, "w"))
        for k in (1, 2):
            fp2 = os.path.join(d, f"s1b{k}.json")
            json.dump({**s1, "scan": f"b{k}"}, open(fp2, "w"))
        files = [fp, os.path.join(d, "s1b1.json"), os.path.join(d, "s1b2.json")]
        o1, o2 = os.path.join(d, "f1.json"), os.path.join(d, "f2.json")
        OF.cmd_combine(files, None, None, o1)
        OF.cmd_combine(files, None, None, o2)
        a, b = json.load(open(o1)), json.load(open(o2))
        a.pop("built_at_utc"); b.pop("built_at_utc")
        assert a == b
        assert a["schema"] == OF.SCHEMA and a["excludes"] and a["sources"] and a["citation"] and a["inputs"] and "rule" in a
        liver = a["organs"]["liver"]
        # V0 is not part of the pool: 6 variants x 3 scans = 18 values, differences 1 to 6 percent
        assert liver["by_source"]["S1_perturbation"]["n"] == 18
        assert abs(liver["floor_pct"] - np.percentile([float(k) for k in (1, 2, 3, 4, 5, 6)] * 3, 95)) < 1e-9
        s1["variants"]["V0"]["table"] = tab(103.0)
        json.dump(s1, open(fp, "w"))
        assert OF.baseline_check([fp])["pass"] is False
        s1["variants"]["V0"]["table"] = tab(100.0)
        json.dump(s1, open(fp, "w"))
        assert OF.baseline_check([fp])["pass"] is True
