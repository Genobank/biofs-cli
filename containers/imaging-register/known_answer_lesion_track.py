#!/usr/bin/env python3
"""Known-answer test of the lesions verb logic (components, link_tracks, recist_category of imaging_lesion_track_runner.py).
Criteria and predictions frozen before the first run: lesion_track_criteria-20261105.txt (sha256 b9be1623...).
  python3 known_answer_lesion_track.py run --out report.json [--vista3d-dir DIR]"""
import argparse
import hashlib
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
DEFAULT_DIR = os.environ.get("VISTA3D_DIR", "/Users/danieluribe/Downloads/biofs-cli/containers/imaging-vista3d")
import known_answer_findings as KF   # sphere, make_seg, SPACINGS, CLASS_LUNG, CLASS_LIVER

CLASSES = [KF.CLASS_LUNG, KF.CLASS_LIVER]


def comps(LR, spheres, spacing):
    seg = KF.make_seg(spheres, spacing)
    return LR.components(seg, CLASSES, seg.GetSpacing()), seg.GetSpacing()


def volume_and_axis(LR):
    rows = []
    for sname, sp in KF.SPACINGS.items():
        for d in (8, 10, 12, 16, 20, 30):
            c, _ = comps(LR, [KF.sphere(KF.CLASS_LUNG, d, (80.0, 80.0, 40.0), "n")], sp)
            true_v = math.pi * d ** 3 / 6.0 / 1000.0
            if not c:
                rows.append({"spacing": sname, "true_mm": d, "reported": False, "true_ml": round(true_v, 3)}); continue
            x = c[0]
            tol = max(1.5, 0.10 * d)
            rows.append({"spacing": sname, "true_mm": d, "reported": True, "true_ml": round(true_v, 3), "volume_ml": x["volume_ml"],
                         "volume_error_pct": round(100 * (x["volume_ml"] - true_v) / true_v, 1), "long_axis_mm": x["long_axis_mm"],
                         "long_axis_error_mm": round(x["long_axis_mm"] - d, 2), "t2_ok": abs(x["long_axis_mm"] - d) <= tol,
                         "t1_ok": (abs(x["volume_ml"] - true_v) / true_v <= 0.10) if sname in ("A", "B") else None})
    return rows


def tracks_summary(tracks, per_tp):
    return [{"id": t["id"], "members": {str(k): v for k, v in t["members"].items()}, "topology": t.get("topology"), "ious": t.get("ious")} for t in tracks]


def shift_sweep(LR):
    rows = []
    for d in (8, 12, 20):
        for s in (0, 2, 4, 6, 8, 10, 14):
            per_tp = []
            for k in (0, 1):
                c, sp = comps(LR, [KF.sphere(KF.CLASS_LUNG, d, (40.0 + (s if k else 0), 80.0, 40.0), "a")], KF.SPACINGS["A"])
                per_tp.append(c)
            tr = LR.link_tracks(per_tp, sp)
            joined = any(len(t["members"]) == 2 for t in tr)
            rows.append({"d_mm": d, "shift_mm": s, "n_tracks": len(tr), "one_track_two_members": joined, "overlap_expected": s < d,
                         "t3_ok": (joined if s < d else None)})
    return rows


def split_merge(LR):
    sp1 = KF.SPACINGS["A"]
    big = [KF.sphere(KF.CLASS_LUNG, 20, (40.0, 80.0, 40.0), "a")]
    two = [KF.sphere(KF.CLASS_LUNG, 12, (34.0, 80.0, 40.0), "p"), KF.sphere(KF.CLASS_LUNG, 12, (51.0, 80.0, 40.0), "q")]
    out = {}
    for name, (t0, t1) in {"V4_split": (big, two), "V5_merge": (two, big)}.items():
        c0, sp = comps(LR, t0, sp1); c1, _ = comps(LR, t1, sp1)
        tr = LR.link_tracks([c0, c1], sp)
        out[name] = {"components": [len(c0), len(c1)], "tracks": tracks_summary(tr, [c0, c1]), "topologies": sorted({str(t.get("topology")) for t in tr})}
    out["T4_split_tagged"] = "split" in out["V4_split"]["topologies"]
    out["T4_merge_tagged"] = "merge" in out["V5_merge"]["topologies"]
    # category of the split case, the way main() would compute it: targets are the baseline lesion; the second 12 mm sphere appears as new
    return out


CASES = [
    ("new_lesion_before_CR", (1, 15.0, 0.0, 15.0, 1), "PD"), ("CR", (1, 15.0, 0.0, 15.0, 0), "CR"),
    ("rise_4mm", (1, 12.0, 16.0, 12.0, 0), "SD"), ("rise_5mm", (1, 12.0, 17.0, 12.0, 0), "PD"),
    ("rise_7mm_17pct", (1, 40.0, 47.0, 40.0, 0), "SD"), ("rise_8mm_20pct", (1, 40.0, 48.0, 40.0, 0), "PD"),
    ("PR_minus40", (1, 20.0, 12.0, 12.0, 0), "PR"), ("SD_minus25", (1, 20.0, 15.0, 15.0, 0), "SD"),
    ("no_target", (0, 0.0, 0.0, 0.0, 0), "no-target"), ("nadir_rise", (1, 20.0, 15.0, 10.0, 0), "PD"),
]


def categories(LR):
    rows = []
    for name, args, want in CASES:
        got, reasons = LR.recist_category(*args)
        rows.append({"case": name, "args": args, "want": want, "got": got, "ok": got == want, "reasons": reasons})
    return rows


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["run"]); ap.add_argument("--out", required=True)
    ap.add_argument("--vista3d-dir", default=DEFAULT_DIR)
    ap.add_argument("--criteria", default=os.path.join(HERE, "lesion_track_criteria-20261105.txt"))
    args = ap.parse_args(argv)
    sys.path.insert(0, args.vista3d_dir)
    import imaging_lesion_track_runner as LR
    import skimage
    va = volume_and_axis(LR); sh = shift_sweep(LR); sm = split_merge(LR)
    has_cat = hasattr(LR, "recist_category")
    cat = categories(LR) if has_cat else None
    rep = {"schema": "imaging-lesion-track-logic-known-answer-report/1", "skimage_version": skimage.__version__,
           "criteria_sha256": hashlib.sha256(open(args.criteria, "rb").read()).hexdigest(),
           "runner_sha256": hashlib.sha256(open(os.path.join(args.vista3d_dir, "imaging_lesion_track_runner.py"), "rb").read()).hexdigest(),
           "has_recist_category_function": has_cat, "volume_and_axis": va, "shift_sweep": sh, "split_merge": sm, "categories": cat,
           "criteria_results": {"T1_volume_failed": [r for r in va if r.get("t1_ok") is False], "T2_axis_failed": [r for r in va if r.get("t2_ok") is False],
                                "T3_failed": [r for r in sh if r["t3_ok"] is False], "T4": {"split_tagged": sm["T4_split_tagged"], "merge_tagged": sm["T4_merge_tagged"]},
                                "T5_failed": ([r["case"] for r in cat if not r["ok"]] if cat else "recist_category not present")}}
    json.dump(rep, open(args.out, "w"), indent=1, default=str)
    print("VOLUME error % and LONG AXIS error mm by spacing")
    for sn in KF.SPACINGS:
        print(f"  {sn}: " + "  ".join(f"{r['true_mm']}:{r['volume_error_pct']:+}%/{r['long_axis_error_mm']:+}" if r.get("reported") else f"{r['true_mm']}:none" for r in va if r["spacing"] == sn))
    print("SHIFT SWEEP (one track with two members?)")
    for d in (8, 12, 20):
        print(f"  d={d}: " + "  ".join(f"{r['shift_mm']}:{'joined' if r['one_track_two_members'] else 'split'}" for r in sh if r["d_mm"] == d))
    print("SPLIT/MERGE", json.dumps({k: (v["components"], v["topologies"]) if isinstance(v, dict) else v for k, v in sm.items()}))
    print("CATEGORIES", json.dumps({r["case"]: (r["got"], r["want"]) for r in cat}) if cat else "no recist_category function in this runner")
    print("CRITERIA", json.dumps({k: (v if not isinstance(v, list) else (f"{len(v)} failed" if v else "pass")) for k, v in rep["criteria_results"].items()}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
