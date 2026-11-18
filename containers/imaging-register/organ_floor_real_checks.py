#!/usr/bin/env python3
"""Criteria RF1 to RF4 and predictions P-F1 to P-F7 of organ_floor_criteria-20261106.txt, read from the run's outputs. Numbers and verdicts only.

  organ_floor_real_checks.py --s1 FILE... --s2 FILE --s3 FILE --floors floors.json --pkg-abdomen DIR --pkg-chest DIR --out report.json"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, "/app")
import organ_floor as OF
import organ_package as OP

ABDOMEN_ORGANS = ("liver", "spleen", "kidney_left", "kidney_right", "pancreas", "gallbladder", "stomach", "duodenum", "small_bowel", "colon",
                  "urinary_bladder", "prostate", "adrenal_gland_left", "adrenal_gland_right")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--s1", nargs="+", required=True); ap.add_argument("--s2", required=True); ap.add_argument("--s3", required=True)
    ap.add_argument("--floors", required=True); ap.add_argument("--pkg-abdomen", required=True); ap.add_argument("--pkg-chest", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    floors = json.load(open(a.floors))
    organs = floors["organs"]
    s1 = [json.load(open(f)) for f in a.s1]
    s2 = json.load(open(a.s2)); s3 = json.load(open(a.s3))
    rep = {"criteria": {}, "predictions": {}}

    # RF1
    per_scan = {f"{d['job_id'][:17]}:{d['scan']}": {"variants_done": sorted(d["variants"]), "failed": d["failed"],
                                                      "seconds": [v["seconds"] for v in d["variants"].values()]} for d in s1}
    s1_done = sum(len(v["variants_done"]) for v in per_scan.values())
    rep["criteria"]["RF1_completeness"] = {
        "S1_segmentations": s1_done, "S1_expected": 42, "S1_failed": {k: v["failed"] for k, v in per_scan.items() if v["failed"]},
        "S2_pairs": len(s2["pairs"]), "S2_expected": 8, "S3_pairs": len(s3["pairs"]), "S3_expected": 12, "S3_failed": s3.get("failed"),
        "S1_seconds_median": sorted(sum((v["seconds"] for v in per_scan.values()), []))[s1_done // 2] if s1_done else None,
        "pass": s1_done == 42 and not any(v["failed"] for v in per_scan.values()) and len(s2["pairs"]) == 8 and len(s3["pairs"]) == 12 and not s3.get("failed")}

    # RF2
    cover = {}
    for src in floors["sources"]:
        have = [o for o, d in organs.items() if (d["by_source"].get(src) or {}).get("p95_pct") is not None]
        cover[src] = {"organs_with_n_ge_8": len(have), "organs_without": [o for o in organs if o not in have]}
    no_abd = [o for o in ABDOMEN_ORGANS if (organs.get(o, {}).get("by_source", {}).get("S1_perturbation") or {}).get("p95_pct") is None]
    rep["criteria"]["RF2_coverage"] = {"by_source": cover, "abdomen_organs_without_S1_floor": no_abd, "pass": not no_abd}

    # RF3
    base = OF.baseline_check(a.s1)
    rep["criteria"]["RF3_segmenter_determinism"] = base

    # RF4
    ver = {name: OP.verify_package(d) for name, d in (("abdomen", a.pkg_abdomen), ("chest", a.pkg_chest))}
    rep["criteria"]["RF4_packages_with_floors"] = {k: {"ok": v["ok"], "problems": v["problems"][:5]} for k, v in ver.items()}
    rep["criteria"]["RF4_packages_with_floors"]["floors_hash_in_packages"] = {
        n: json.load(open(os.path.join(d, "package.json"))).get("floors", {}).get("sha256") == OP.sha256_file(a.floors)
        for n, d in (("abdomen", a.pkg_abdomen), ("chest", a.pkg_chest))}
    rep["criteria"]["RF4_packages_with_floors"]["pass"] = all(v["ok"] for v in ver.values()) and all(rep["criteria"]["RF4_packages_with_floors"]["floors_hash_in_packages"].values())

    def p95(o, src):
        return (organs.get(o, {}).get("by_source", {}).get(src) or {}).get("p95_pct")

    # predictions
    rep["predictions"]["P-F1_baseline_identical"] = {"holds": base["worst_diff_pct"] == 0.0, "worst_diff_pct": base["worst_diff_pct"]}
    big = ("lung_left", "lung_right", "liver", "spleen", "kidney_left", "kidney_right", "heart")
    v = {o: p95(o, "S1_perturbation") for o in big}
    rep["predictions"]["P-F2_big_organs_at_most_2pct"] = {"holds": all(x is not None and x <= 2.0 for x in v.values()), "S1_p95_pct": v}
    small = ("adrenal_gland_left", "adrenal_gland_right", "gallbladder", "duodenum", "pancreas")
    v = {o: p95(o, "S1_perturbation") for o in small}
    rep["predictions"]["P-F3_small_organs_at_least_5pct"] = {"holds": all(x is not None and x >= 5.0 for x in v.values()), "S1_p95_pct": v}
    v = {o: p95(o, "S1_perturbation") for o in ("colon", "stomach")}
    rep["predictions"]["P-F4_hollow_organs_at_most_6pct"] = {"holds": all(x is not None and x <= 6.0 for x in v.values()), "S1_p95_pct": v}
    both = [o for o in organs if p95(o, "S1_perturbation") is not None and p95(o, "S3_reconstruction") is not None]
    larger = [o for o in both if p95(o, "S3_reconstruction") > p95(o, "S1_perturbation")]
    rep["predictions"]["P-F5_kernel_larger_than_noise"] = {"holds": bool(both) and len(larger) / len(both) >= 0.6, "organs_with_both": len(both),
                                                           "S3_larger": len(larger), "fraction": round(len(larger) / len(both), 3) if both else None}
    v = {o: p95(o, "S2_same_day_repeat") for o in ("lung_left", "lung_right")}
    rep["predictions"]["P-F6_same_day_lung_between_3_and_15pct"] = {"holds": all(x is not None and 3.0 <= x <= 15.0 for x in v.values()), "S2_p95_pct": v}
    pk = json.load(open(os.path.join(a.pkg_abdomen, "package.json")))
    ex = lambda o, tp: (((pk["organs"].get(o) or {}).get("change") or {}).get("vs_reference") or {}).get(tp) or {}
    want = {("liver", "jan9"): True, ("spleen", "oct21"): True, ("pancreas", "jan9"): True, ("pancreas", "oct21"): True,
            ("kidney_left", "oct21"): False, ("kidney_right", "oct21"): False}
    got = {f"{o}@{tp}": {"delta_pct": round(ex(o, tp).get("delta_pct") or 0, 2), "floor_pct": ex(o, tp).get("floor_pct"),
                         "exceeds": ex(o, tp).get("exceeds_measured_floor")} for (o, tp) in want}
    rep["predictions"]["P-F7_abdomen_changes_against_floors"] = {"holds": all(got[f"{o}@{tp}"]["exceeds"] is w for (o, tp), w in want.items()), "rows": got}
    # all exceeds flags of the abdomen package, for the report
    rep["abdomen_exceeding"] = sorted(f"{o}@{tp} {r['delta_pct']:+.1f}% (floor {r['floor_pct']:.1f}%)" for o, orc in pk["organs"].items()
                                      for tp, r in orc["change"]["vs_reference"].items() if r.get("exceeds_measured_floor"))
    rep["abdomen_within_floor"] = sorted(f"{o}@{tp} {r['delta_pct']:+.1f}% (floor {r['floor_pct']:.1f}%)" for o, orc in pk["organs"].items()
                                         for tp, r in orc["change"]["vs_reference"].items() if r.get("exceeds_measured_floor") is False)
    rep["floors_pct"] = {o: (None if d["floor_pct"] is None else round(d["floor_pct"], 2)) for o, d in organs.items()}
    rep["floor_set_by"] = {o: d.get("set_by") for o, d in organs.items()}
    json.dump(rep, open(a.out, "w"), indent=1, sort_keys=True)
    print(json.dumps({k: v.get("pass") for k, v in rep["criteria"].items()}, indent=1))
    print(json.dumps({k: v["holds"] for k, v in rep["predictions"].items()}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
