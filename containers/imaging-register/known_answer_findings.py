#!/usr/bin/env python3
"""Known-answer test of the findings logic (detect_lesions, analyze_interval, recist_for_interval of findings_runner.py).

Criteria and predictions were frozen before the first run: lesion_logic_criteria-20261105.txt (sha256 0d986a78...) and
lesion_logic_amendment0-20261105.txt (sha256 eaa654ef...). The segmentations are injected (spheres of known diameter on a label
grid); no detector and no LesionLocator run. The tracker is the code's overlap fallback.

  python3 known_answer_findings.py run --out report.json [--findings-dir DIR]
"""
import argparse
import hashlib
import json
import os
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FINDINGS_DIR = os.environ.get("FINDINGS_DIR", "/Users/danieluribe/Downloads/biofs-cli/containers/imaging-findings")
REPORT_SCHEMA = "imaging-findings-logic-known-answer-report/1"
CLASS_LUNG, CLASS_LIVER = 23, 26
ORGAN = {CLASS_LUNG: "lung", CLASS_LIVER: "liver"}
FOV_MM = (80.0, 160.0, 160.0)          # z, y, x
SPACINGS = {"A": (1.0, 1.0, 1.0), "B": (0.7, 0.7, 1.25), "C": (0.8, 0.8, 3.0)}   # x, y, z mm
MEAS_DIAMETERS = (4, 6, 8, 10, 12, 16, 20, 30)
SHIFTS = (0, 2, 4, 6, 8, 10, 14)


def sphere(cls, d, center_xyz, key):
    return {"cls": cls, "d": float(d), "c": tuple(float(v) for v in center_xyz), "key": key}


def make_seg(spheres, spacing_xyz):
    """Label image (uint8) of the given spheres on a grid that covers FOV_MM at the given spacing (x, y, z mm)."""
    import SimpleITK as sitk
    sx, sy, sz = spacing_xyz
    shape = (int(round(FOV_MM[0] / sz)), int(round(FOV_MM[1] / sy)), int(round(FOV_MM[2] / sx)))
    zz, yy, xx = np.indices(shape, dtype=np.float32)
    arr = np.zeros(shape, np.uint8)
    for s in spheres:
        cx, cy, cz = s["c"]
        m = ((xx * sx - cx) ** 2 + (yy * sy - cy) ** 2 + (zz * sz - cz) ** 2) <= (s["d"] / 2.0) ** 2
        arr[m] = s["cls"]
    img = sitk.GetImageFromArray(arr)
    img.SetSpacing((sx, sy, sz))
    return img


def reference_category(base, fu_of_base, new, meas_mm=10.0):
    """RECIST 1.1 as stated in the pre-registration, applied to diameters passed in.
    base: list of (organ, baseline diameter); fu_of_base: follow-up diameter of each (0 if absent); new: list of new diameters."""
    order = sorted(range(len(base)), key=lambda i: -base[i][1])
    sel, per = [], {}
    for i in order:
        o, d = base[i]
        if d < meas_mm or len(sel) >= 5 or per.get(o, 0) >= 2:
            continue
        sel.append(i); per[o] = per.get(o, 0) + 1
    b = sum(base[i][1] for i in sel)
    f = sum(fu_of_base[i] for i in sel)
    if any(d >= meas_mm for d in new):
        return "PD", b, f
    if not sel:
        return "no-target", b, f
    if f == 0:
        return "CR", b, f
    if (b - f) / b >= 0.30:
        return "PR", b, f
    if f - b >= 5.0 and (f - b) / b >= 0.20:
        return "PD", b, f
    return "SD", b, f


def run_pair(FR, base_spheres, fu_spheres, spacing, wd):
    b_seg, f_seg = make_seg(base_spheres, spacing), make_seg(fu_spheres, spacing)
    FR.TUMOR_USED = [CLASS_LUNG, CLASS_LIVER]
    sp = b_seg.GetSpacing()
    findings, tracker, nb, nf = FR.analyze_interval("b", "f", b_seg, f_seg, "b_ct_unused", "f_ct_unused", sp, wd, [0, 30], prefix=None)
    rec = FR.recist_for_interval(findings, True, True, "naive")
    slim = [{k: f[k] for k in ("organ", "status", "baseline_long_axis_mm", "followup_long_axis_mm", "measurable", "centroid_mm")} for f in findings]
    return {"findings": slim, "tracker": tracker, "n_baseline": nb, "n_followup": nf,
            "recist": {k: rec[k] for k in ("category", "baseline_sld_mm", "followup_sld_mm", "pct_change_vs_baseline", "target_lesion_count")}}


def scenarios():
    L, V = CLASS_LUNG, CLASS_LIVER
    out = []

    def add(sid, title, base, fu, expect_status, expect_cat=None, graded=True):
        out.append({"id": sid, "title": title, "base": base, "fu": fu, "expect_status": sorted(expect_status), "expect_category": expect_cat,
                    "graded": graded})

    a = sphere(L, 12, (40, 80, 40), "a")
    add("S01", "no lesion in either scan", [], [], [], "no-target")
    add("S02", "lung 12 mm, same place", [a], [a], ["stable"], "SD")
    add("S03", "lung 12 -> 16 mm (+33%, +4 mm)", [a], [sphere(L, 16, (40, 80, 40), "a")], ["enlarged"], "SD")
    add("S04", "lung 12 -> 20 mm (+67%, +8 mm)", [a], [sphere(L, 20, (40, 80, 40), "a")], ["enlarged"], "PD")
    add("S05", "lung 20 -> 12 mm (-40%)", [sphere(L, 20, (40, 80, 40), "a")], [sphere(L, 12, (40, 80, 40), "a")], ["shrunk"], "PR")
    add("S06", "lung 15 -> absent", [sphere(L, 15, (40, 80, 40), "a")], [], ["resolved"], "CR")
    add("S07", "lung 15 -> absent, new liver 12 mm", [sphere(L, 15, (40, 80, 40), "a")], [sphere(V, 12, (120, 80, 40), "n")],
        ["resolved", "new"], "PD")
    add("S08", "lung 15 stable, new liver 6 mm (under the 0.2 mL floor)", [sphere(L, 15, (40, 80, 40), "a")],
        [sphere(L, 15, (40, 80, 40), "a"), sphere(V, 6, (120, 80, 40), "n")], ["stable"], None)
    add("S09", "lung 15 stable, new liver 12 mm", [sphere(L, 15, (40, 80, 40), "a")],
        [sphere(L, 15, (40, 80, 40), "a"), sphere(V, 12, (120, 80, 40), "n")], ["stable", "new"], "PD")
    big = [sphere(L, 20, (25, 40, 40), "l1"), sphere(L, 18, (25, 80, 40), "l2"), sphere(L, 16, (25, 120, 40), "l3"), sphere(L, 14, (60, 40, 40), "l4"),
           sphere(V, 12, (100, 40, 40), "v1"), sphere(V, 11, (100, 80, 40), "v2"), sphere(V, 10, (100, 120, 40), "v3")]
    add("S10", "4 lung + 3 liver lesions unchanged", big, big, ["stable"] * 7, "SD")
    return out


def grade_scenarios(FR, wd):
    res = []
    for sc in scenarios():
        spacing = SPACINGS["A"]
        r = run_pair(FR, sc["base"], sc["fu"], spacing, wd)
        statuses = sorted(f["status"] for f in r["findings"])
        # reference category on the TRUE diameters
        keys_fu = {s["key"]: s for s in sc["fu"]}
        base = [(ORGAN[s["cls"]], s["d"]) for s in sc["base"]]
        fu_of_base = [keys_fu[s["key"]]["d"] if s["key"] in keys_fu else 0.0 for s in sc["base"]]
        base_keys = {s["key"] for s in sc["base"]}
        new = [s["d"] for s in sc["fu"] if s["key"] not in base_keys]
        ref_cat, ref_b, ref_f = reference_category(base, fu_of_base, new)
        entry = {"id": sc["id"], "title": sc["title"], "got_statuses": statuses, "expect_statuses": sc["expect_status"],
                 "status_ok": statuses == sc["expect_status"], "got_category": r["recist"]["category"],
                 "reference_category_from_true_diameters": ref_cat, "expect_category_registered": sc["expect_category"],
                 "category_ok": (None if sc["expect_category"] is None else r["recist"]["category"] == sc["expect_category"]),
                 "reference_sld_true_mm": [ref_b, ref_f], "recist": r["recist"], "tracker": r["tracker"], "findings": r["findings"]}
        res.append(entry)
    return res


def s10_targets(entry):
    rec = entry["recist"]
    return {"target_lesion_count": rec["target_lesion_count"], "baseline_sld_mm": rec["baseline_sld_mm"],
            "ok": rec["target_lesion_count"] == 4 and abs(rec["baseline_sld_mm"] - 61.0) <= 3.0}


def measurement_sweep(FR, wd):
    rows = []
    for sname, sp in SPACINGS.items():
        for d in MEAS_DIAMETERS:
            c = (80.0, 80.0, 40.0)
            r = run_pair(FR, [], [sphere(CLASS_LUNG, d, c, "n")], sp, wd)
            fnd = [f for f in r["findings"] if f["status"] == "new"]
            if not fnd:
                rows.append({"spacing": sname, "spacing_xyz_mm": sp, "true_mm": d, "reported": False})
                continue
            f = fnd[0]
            m = f["followup_long_axis_mm"]
            tol = max(1.5, 0.10 * d)
            rows.append({"spacing": sname, "spacing_xyz_mm": sp, "true_mm": d, "reported": True, "measured_mm": m, "error_mm": round(m - d, 2),
                         "error_pct": round(100.0 * (m - d) / d, 1), "tolerance_mm": tol, "lk1_ok": (abs(m - d) <= tol) if d >= 8 else None,
                         "centroid_mm": f["centroid_mm"], "centroid_error_mm": [round(f["centroid_mm"][i] - c[i], 2) for i in range(3)],
                         "lk4_ok": (all(abs(f["centroid_mm"][i] - c[i]) <= 1.5 for i in range(3)) if d >= 8 else None)})
    return rows


def shift_sweep(FR, wd):
    rows = []
    for d in (8, 12, 20):
        for s in SHIFTS:
            b = [sphere(CLASS_LUNG, d, (40.0, 80.0, 40.0), "a")]
            f = [sphere(CLASS_LUNG, d, (40.0 + s, 80.0, 40.0), "a")]
            r = run_pair(FR, b, f, SPACINGS["A"], wd)
            rows.append({"d_mm": d, "shift_mm": s, "statuses": sorted(x["status"] for x in r["findings"]), "category": r["recist"]["category"]})
    return rows


def small_noise(FR, wd):
    rows = []
    for d0, d1 in ((6, 7.5), (8, 9.5)):
        r = run_pair(FR, [sphere(CLASS_LUNG, d0, (40, 80, 40), "a")], [sphere(CLASS_LUNG, d1, (40, 80, 40), "a")], SPACINGS["A"], wd)
        rows.append({"from_mm": d0, "to_mm": d1, "statuses": sorted(x["status"] for x in r["findings"]),
                     "measured": [(x["baseline_long_axis_mm"], x["followup_long_axis_mm"]) for x in r["findings"]], "category": r["recist"]["category"]})
    return rows


def split_case(FR, wd):
    b = [sphere(CLASS_LUNG, 20, (40, 80, 40), "a")]
    f = [sphere(CLASS_LUNG, 12, (34, 80, 40), "p"), sphere(CLASS_LUNG, 12, (51, 80, 40), "q")]    # centres 17 mm apart, 5 mm gap
    r = run_pair(FR, b, f, SPACINGS["A"], wd)
    return {"findings": r["findings"], "category": r["recist"]["category"]}


def predictions(scen, meas, shifts, small):
    by = {s["id"]: s for s in scen}
    p1 = by["S03"]["got_category"] == "PD"
    p2 = by["S07"]["got_category"] == "CR"
    errs = [r["error_mm"] for r in meas if r.get("reported")]
    p3 = bool(errs) and float(np.mean(errs)) > 0 and max(errs) <= 1.6
    row8 = [r for r in shifts if r["d_mm"] == 8 and r["shift_mm"] >= 6]
    p4 = all(r["statuses"] == ["new", "resolved"] for r in row8)
    p5 = s10_targets(by["S10"])["ok"]
    p6 = all(by[i]["status_ok"] and by[i]["category_ok"] for i in ("S01", "S02", "S04", "S05", "S06", "S09"))
    p7 = small[0]["statuses"] == ["new"]
    return {"P1_S03_returns_PD": p1, "P2_S07_returns_CR": p2, "P3_positive_bias_of_at_most_1p6_mm": p3, "P4_shift_6mm_or_more_resolved_and_new_for_8mm": p4,
            "P5_S10_passes_LK5": p5, "P6_S01_S02_S04_S05_S06_S09_pass": p6, "P7_6mm_to_7p5mm_reported_as_new": p7}


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["run"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--findings-dir", default=DEFAULT_FINDINGS_DIR)
    ap.add_argument("--criteria", default=os.path.join(HERE, "lesion_logic_criteria-20261105.txt"))
    ap.add_argument("--amendment", default=os.path.join(HERE, "lesion_logic_amendment0-20261105.txt"))
    args = ap.parse_args(argv)
    sys.path.insert(0, args.findings_dir)
    import findings_runner as FR
    import skimage
    FR.LL_CKPT = "/nonexistent-lesionlocator-checkpoint"      # the registered test uses the overlap fallback only
    wd = tempfile.mkdtemp(prefix="ka_find_")
    scen = grade_scenarios(FR, wd)
    meas = measurement_sweep(FR, wd)
    shifts = shift_sweep(FR, wd)
    small = small_noise(FR, wd)
    split = split_case(FR, wd)
    lk = {"LK1_measurement": [r for r in meas if r.get("lk1_ok") is False], "LK2_status_failed": [s["id"] for s in scen if not s["status_ok"]],
          "LK3_category_failed": [s["id"] for s in scen if s["category_ok"] is False],
          "LK4_centroid": [r for r in meas if r.get("lk4_ok") is False], "LK5_S10": s10_targets([s for s in scen if s["id"] == "S10"][0])}
    rep = {"schema": REPORT_SCHEMA, "skimage_version": skimage.__version__, "numpy_version": np.__version__,
           "criteria_sha256": hashlib.sha256(open(args.criteria, "rb").read()).hexdigest(),
           "amendment0_sha256": hashlib.sha256(open(args.amendment, "rb").read()).hexdigest(),
           "findings_runner_sha256": hashlib.sha256(open(os.path.join(args.findings_dir, "findings_runner.py"), "rb").read()).hexdigest(),
           "min_lesion_ml": FR.MIN_LESION_ML, "enlarge_frac": FR.ENLARGE_FRAC,
           "scenarios": scen, "measurement_sweep": meas, "shift_sweep": shifts, "small_lesion_noise": small, "split_case": split,
           "criteria_results": lk, "predictions": predictions(scen, meas, shifts, small)}
    json.dump(rep, open(args.out, "w"), indent=1, default=str)
    print(f"SCENARIOS (statuses and category against the registered expectation)")
    for s in scen:
        print(f"  {s['id']} {s['title'][:52]:52s} status {'ok ' if s['status_ok'] else 'NO '} got {s['got_statuses']}  category got {s['got_category']:9s} "
              f"registered {s['expect_category_registered']}  reference-on-true {s['reference_category_from_true_diameters']}  SLD {s['recist']['baseline_sld_mm']}->{s['recist']['followup_sld_mm']}")
    print("MEASUREMENT (true -> measured, error mm) by spacing")
    for sn in SPACINGS:
        print("  " + sn + " " + str(SPACINGS[sn]) + ": " + "  ".join(f"{r['true_mm']}->{r['measured_mm']}({r['error_mm']:+})" if r.get("reported") else f"{r['true_mm']}->none"
                                                                 for r in meas if r["spacing"] == sn))
    print("SHIFT SWEEP (statuses by shift mm)")
    for d in (8, 12, 20):
        print(f"  d={d}: " + "  ".join(f"{r['shift_mm']}:{'+'.join(r['statuses'])}" for r in shifts if r["d_mm"] == d))
    print("SMALL-LESION NOISE", json.dumps(small))
    print("SPLIT", json.dumps({"statuses": sorted(f["status"] for f in split["findings"]), "category": split["category"]}))
    print("CRITERIA", json.dumps({k: (v if not isinstance(v, list) else (f"{len(v)} failed" if v else "pass")) for k, v in lk.items()}))
    print("PREDICTIONS", json.dumps(rep["predictions"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
