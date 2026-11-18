#!/usr/bin/env python3
"""Criteria RD1 to RD6 of organ_package_criteria-20261106.txt, read from a built package and the job it came from.
This script does not call the builder's code for the numbers it checks: it reads the job's own native label files and the job's own
manifest, and compares. Output is numbers and verdicts only (no images, no patient fields).

  organ_package_real_checks.py --job-out <register job out/> --package <package dir> [--lung-report <lung_volume_report.json>] --out report.json
"""
import argparse
import json
import os
import re
import sys

import numpy as np
import SimpleITK as sitk

LUNG_KEYS = {"lung_left": ("left",), "lung_right": ("right",)}
LOBES = ("lung_upper_lobe_left", "lung_lower_lobe_left", "lung_upper_lobe_right", "lung_middle_lobe_right", "lung_lower_lobe_right")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-out", required=True)
    ap.add_argument("--package", required=True)
    ap.add_argument("--lung-report")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, here)
    import organ_package as OP

    manifest = json.load(open(os.path.join(a.job_out, "manifest.json")))
    pkg = json.load(open(os.path.join(a.package, "package.json")))
    names = {int(k): v for k, v in manifest["label_names"].items()}
    ref = manifest["reference"]
    rep = {"job_id": manifest["job_id"], "package": os.path.abspath(a.package), "criteria": {}}

    # RD1
    ver = OP.verify_package(a.package)
    rep["criteria"]["RD1_verify"] = {"pass": ver["ok"], "problems": ver["problems"][:20], "files_checked": ver["files_checked"],
                                     "build_seconds": pkg["build"]["seconds"], "mesh_seconds": pkg["build"]["mesh_seconds"]}

    # RD6 and independent volumes: from the job's native labels, read here, not by the builder
    native = {}
    for tp in pkg["order"]:
        img = sitk.ReadImage(os.path.join(a.job_out, "native", tp, "labels.nii.gz"))
        native[tp] = (sitk.GetArrayFromImage(img), float(np.prod(img.GetSpacing())) / 1000.0)
    bad_vol, sources, checked = [], set(), 0
    for organ, orec in pkg["organs"].items():
        ids = orec["label_ids"]
        for tp, rec in orec["per_timepoint"].items():
            if not rec.get("present"):
                continue
            arr, vox_ml = native[tp]
            v = float(np.isin(arr, ids).sum() * vox_ml)
            sources.add(rec["volume_source"])
            checked += 1
            if abs(v - rec["volume_ml"]) > 1e-6 * max(1.0, v):
                bad_vol.append({"organ": organ, "tp": tp, "package": rec["volume_ml"], "independent": v})
    rep["criteria"]["RD6_volumes_from_native_labels"] = {"pass": not bad_vol and sources == {"native_labels"}, "checked": checked,
                                                         "sources": sorted(sources), "mismatches": bad_vol[:10]}

    # RD2: lung volumes against the job's own lung volume report
    lung = None
    if a.lung_report and os.path.isfile(a.lung_report):
        lung = json.load(open(a.lung_report)).get("per_timepoint")
    if lung is None:
        lung = (manifest.get("lung_volume") or {}).get("per_timepoint") or None
    if lung:
        rows, worst = [], 0.0
        for tp in pkg["order"]:
            lr = lung.get(tp)
            if not lr:
                continue
            for organ in ("lung_left", "lung_right"):
                mine = pkg["organs"].get(organ, {}).get("per_timepoint", {}).get(tp, {})
                theirs = lr["left" if organ == "lung_left" else "right"]["volume_ml"]
                if mine.get("present"):
                    d = abs(mine["volume_ml"] - theirs) / theirs * 100.0
                    worst = max(worst, d)
                    rows.append({"organ": organ, "tp": tp, "package_ml": round(mine["volume_ml"], 2), "report_ml": theirs, "diff_pct": round(d, 4)})
            for lobe, rec in (lr.get("lobes") or {}).items():
                mine = pkg["organs"].get(lobe, {}).get("per_timepoint", {}).get(tp, {})
                if mine.get("present") and rec.get("volume_ml"):
                    d = abs(mine["volume_ml"] - rec["volume_ml"]) / rec["volume_ml"] * 100.0
                    worst = max(worst, d)
                    rows.append({"organ": lobe, "tp": tp, "package_ml": round(mine["volume_ml"], 2), "report_ml": rec["volume_ml"], "diff_pct": round(d, 4)})
        rep["criteria"]["RD2_lung_volumes"] = {"pass": worst <= 0.5, "worst_diff_pct": round(worst, 4), "n": len(rows), "rows": rows}
    else:
        rep["criteria"]["RD2_lung_volumes"] = {"pass": None, "reason": "no lung volume numbers in the job"}

    # RD3
    rd3 = []
    for tp in pkg["order"]:
        if tp == ref:
            continue
        plc = pkg["placements"][tp]
        chk = (plc["rigid"].get("spine_check") or {})
        row = {"tp": tp, "pair": plc["pair"], "rigid_allowed": plc["rigid"]["allowed"], "reason": plc["rigid"]["reason"],
               "assd_mm": chk.get("assd_mm"), "manifest_rigid_assd_mm": chk.get("manifest_rigid_spine_assd_mm"),
               "overlap_z_mm": chk.get("overlap_z_mm")}
        row["pass"] = bool(plc["rigid"]["allowed"] and chk.get("assd_mm") is not None and chk["assd_mm"] <= OP.SPINE_MAX_ASSD_MM and
                           (chk.get("manifest_rigid_spine_assd_mm") is None or
                            abs(chk["assd_mm"] - chk["manifest_rigid_spine_assd_mm"]) <= OP.SPINE_VS_MANIFEST_MM))
        pr = next((p for p in manifest["pairs"] if p["pair"] == plc["pair"]), None)
        row["spine_region_failed_in_gate"] = bool(pr and any(c.get("pass") is False and c.get("severity") == "hard" and c["metric"].startswith("spine")
                                                             for c in pr["gate"]["checks"]))
        rd3.append(row)
    rep["criteria"]["RD3_rigid_spine_check"] = {"pass": all(r["pass"] for r in rd3 if not r["spine_region_failed_in_gate"]), "pairs": rd3}

    # RD4 diagnostic: deformable-frame mesh volume against the reference volume
    rd4 = []
    for organ, orec in pkg["organs"].items():
        for tp, rec in orec["per_timepoint"].items():
            fr = ((rec.get("mesh") or {}).get("frame") or {})
            if fr.get("status") == "built" and fr.get("reference_native_volume_ml"):
                rd4.append({"organ": organ, "tp": tp, "frame_voxel_ml": round(fr["voxel_volume_ml"], 2),
                            "reference_native_ml": round(fr["reference_native_volume_ml"], 2),
                            "ratio": round(fr["voxel_volume_ml"] / fr["reference_native_volume_ml"], 3),
                            "own_native_ml": round(rec["volume_ml"], 2)})
    ratios = [r["ratio"] for r in rd4]
    rep["criteria"]["RD4_frame_volume_vs_reference_diagnostic"] = {"pass": None, "n": len(rd4),
                                                                   "ratio_min": min(ratios) if ratios else None,
                                                                   "ratio_median": float(np.median(ratios)) if ratios else None,
                                                                   "ratio_max": max(ratios) if ratios else None, "rows": rd4[:40]}

    # RD5
    rd5 = []
    for p in manifest["pairs"]:
        if p["reference"] != ref or p["gate"]["verdict"] != "FAIL":
            continue
        tp = p["moving"]
        built = [o for o, orec in pkg["organs"].items()
                 if ((orec["per_timepoint"].get(tp, {}).get("mesh") or {}).get("frame") or {}).get("status") == "built"]
        withheld = [o for o, orec in pkg["organs"].items()
                    if ((orec["per_timepoint"].get(tp, {}).get("mesh") or {}).get("frame") or {}).get("status") == "withheld"]
        reasons = {(((orec["per_timepoint"].get(tp, {}).get("mesh") or {}).get("frame") or {}).get("reason") or "")[:140]
                   for o, orec in pkg["organs"].items() if o in withheld}
        files = [f for f in os.listdir(os.path.join(a.package, "organs", withheld[0])) if f.startswith(f"{tp}_frame")] if withheld else []
        rd5.append({"pair": p["pair"], "frame_meshes_built": built, "withheld": len(withheld), "reasons": sorted(reasons), "frame_files_on_disk": files,
                    "pass": not built and bool(withheld) and all(reasons) and not files})
    rep["criteria"]["RD5_failed_pairs_have_no_frame_mesh"] = {"pass": all(r["pass"] for r in rd5) if rd5 else None, "pairs": rd5}

    # RD7 (amendment 1): closed manifold meshes, recorded in the package and recomputed by verify (RD1 includes that recheck)
    n_mesh, not_closed = 0, []
    for organ, orec in pkg["organs"].items():
        for tp, rec in orec["per_timepoint"].items():
            for kind, m in ((rec.get("mesh") or {}).items() if rec.get("present") else []):
                if isinstance(m, dict) and m.get("file") and "closed_manifold" in m:
                    n_mesh += 1
                    if not m["closed_manifold"]:
                        not_closed.append({"organ": organ, "tp": tp, "kind": kind, "faces": m.get("faces"), "boundary": m.get("boundary_edges"),
                                           "nonmanifold": m.get("nonmanifold_edges"), "note": (m.get("note") or "")[:120]})
    over = [{"organ": o, "tp": tp, "faces": m["faces"], "budget": m["face_budget"], "ratio": m.get("mesh_volume_ratio")}
            for o, orec in pkg["organs"].items() for tp, rec in orec["per_timepoint"].items() if rec.get("present")
            for m in [((rec.get("mesh") or {}).get("native") or {})] if m.get("file") and m.get("within_budget") is False]
    ratios = [m.get("mesh_volume_ratio") for orec in pkg["organs"].values() for rec in orec["per_timepoint"].values() if rec.get("present")
              for m in [((rec.get("mesh") or {}).get("native") or {})] if m.get("mesh_volume_ratio")]
    rep["criteria"]["RD7_closed_manifold_meshes"] = {
        "pass": not not_closed,
        "meshes_with_a_flag": n_mesh, "closed_manifold": n_mesh - len(not_closed), "not_closed": not_closed[:30],
        "over_budget_kept_full_resolution": over, "mesh_volume_ratio_min": min(ratios) if ratios else None,
        "mesh_volume_ratio_max": max(ratios) if ratios else None}

    # P5: organs cut by the scan range
    cut = {}
    for organ, orec in pkg["organs"].items():
        for tp, rec in orec["per_timepoint"].items():
            if rec.get("present") and rec["scan_edge"]["cut_by_scan_range"]:
                cut.setdefault(tp, []).append(organ)
    rep["organs_cut_by_scan_range"] = cut
    rep["organs_present"] = {tp: sorted(o for o, orec in pkg["organs"].items() if orec["per_timepoint"].get(tp, {}).get("present"))
                             for tp in pkg["order"]}
    rep["package_bytes"] = sum(e["bytes"] for e in pkg["files"])
    rep["files"] = len(pkg["files"])
    json.dump(rep, open(a.out, "w"), indent=1, sort_keys=True)
    print(json.dumps({k: v.get("pass") for k, v in rep["criteria"].items()}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
