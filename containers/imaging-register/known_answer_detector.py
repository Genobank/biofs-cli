#!/usr/bin/env python3
"""Detector known-answer test of the findings verb. Criteria and predictions: detector_test_criteria-20261105.txt (sha256 80d0dd1e...).

  build     python3 known_answer_detector.py build --src-dir SRC --root ROOT --wallet W [--bucket B]
            SRC holds native/<scan>/ct.nii.gz, native/<scan>/labels.nii.gz and manifest.json (label_names) of a finished register job.
            Writes 7 DICOM series under ROOT/<bucket>/<wallet>/imaging/<study>/<series>/ and ROOT/_truth/{truth.json,pairs.json}.
  evaluate  python3 known_answer_detector.py evaluate --root ROOT --out report.json [--wallet W --bucket B --env env.json]
            Reads what the executor wrote under ROOT/<bucket>/<wallet>/imaging-findings/<job>/ and compares it with the truth.

The executor is run by run_detector_vm.sh with a `gcloud` shim (fake_gcloud.py) on PATH, so the vault is never touched."""
import argparse
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import known_answer as KA                 # insert_sphere, place_nodules, emulate_kernel, ids_matching
import known_answer_findings as KF        # reference_category
import synthetic_dicom as SD

REPORT_SCHEMA = "imaging-findings-detector-known-answer-report/1"
SOLID_HU, GGO_HU = 40.0, -500.0
NOISE_SD = 10.0
RULES = {"min_edge_from_lung_mm": 12.0, "min_spacing_mm": 35.0, "parenchyma_hu_max": -780.0}
IOU_DETECTED = 0.2
BASE_DATE, FU_DATE = "20260101", "20260401"

# scan -> noise seed; pair -> baseline scan, follow-up scan, nodule list and placement seed
SCANS = {"B0": 101, "F0": 102, "F1": 103, "B2": 104, "F2": 105, "B3": 106, "F3": 107}
PAIRS = {
    "D0": {"base": "B0", "fu": "F0", "seed": 0, "nodules": []},
    "D1": {"base": "B0", "fu": "F1", "seed": 31,
           "nodules": [{"id": f"n{i + 1}", "base_d": None, "fu_d": d, "hu": SOLID_HU, "expect": "new"} for i, d in enumerate((6, 8, 10, 12, 16, 20, 30))]
           + [{"id": "n8", "base_d": None, "fu_d": 16, "hu": GGO_HU, "expect": "new"}]},
    "D2": {"base": "B2", "fu": "F2", "seed": 32,
           "nodules": [{"id": "a", "base_d": 12, "fu_d": 18, "hu": SOLID_HU, "expect": "enlarged"},
                       {"id": "b", "base_d": 16, "fu_d": 16, "hu": SOLID_HU, "expect": "stable"}]},
    "D3": {"base": "B3", "fu": "F3", "seed": 33,
           "nodules": [{"id": "a", "base_d": 20, "fu_d": 12, "hu": SOLID_HU, "expect": "shrunk"},
                       {"id": "b", "base_d": 16, "fu_d": 10, "hu": SOLID_HU, "expect": "shrunk"},
                       {"id": "c", "base_d": 14, "fu_d": None, "hu": SOLID_HU, "expect": "resolved"}]},
}
TRUTH_CATEGORY = {"D0": None, "D1": "PD", "D2": "PD", "D3": "PR"}


def build(src_dir, root, wallet, bucket="genobank-health-imaging", pairs=None, rules=None, log=print):
    import SimpleITK as sitk
    pairs, rules = pairs or PAIRS, rules or RULES
    man = json.load(open(os.path.join(src_dir, "manifest.json")))
    names = {int(k): v for k, v in man["label_names"].items()}
    ct_img = sitk.ReadImage(os.path.join(src_dir, "native", "jun17", "ct.nii.gz"))
    lab = sitk.GetArrayFromImage(sitk.ReadImage(os.path.join(src_dir, "native", "jun17", "labels.nii.gz")))
    ct = sitk.GetArrayFromImage(ct_img).astype(np.float32)
    sp_zyx = np.array(ct_img.GetSpacing())[::-1]
    lung = np.isin(lab, KA.ids_matching(names, r"^lung_"))
    # positions: once per pair, written before anything is inserted
    truth = {"schema": "imaging-findings-detector-truth/1", "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
             "source_job": man.get("job_id"), "spacing_zyx_mm": [float(v) for v in sp_zyx], "noise_sd_hu": NOISE_SD, "scan_seeds": SCANS,
             "rules": rules, "pairs": {}}
    scans = {s: {"nodules": []} for s in SCANS}
    for pid, pr in pairs.items():
        nod = pr["nodules"]
        if nod:
            pos = KA.place_nodules(lung, ct, sp_zyx, nod, {**rules, "seed": pr["seed"]}, np.zeros(ct.shape, bool))
        entries = []
        for n, p in zip(nod, pos if nod else []):
            phys = ct_img.TransformContinuousIndexToPhysicalPoint((float(p[2]), float(p[1]), float(p[0])))
            entries.append({**n, "center_index_zyx": [float(v) for v in p], "center_phys_xyz_mm": [float(v) for v in phys]})
            if n["base_d"]:
                scans[pr["base"]]["nodules"].append((p, n["base_d"], n["hu"]))
            if n["fu_d"]:
                scans[pr["fu"]]["nodules"].append((p, n["fu_d"], n["hu"]))
        truth["pairs"][pid] = {"base_scan": pr["base"], "fu_scan": pr["fu"], "nodules": entries, "truth_category": TRUTH_CATEGORY.get(pid)}
    series = {}
    for s, seed in SCANS.items():
        arr = ct.copy()
        for p, d, hu in scans[s]["nodules"]:
            KA.insert_sphere(arr, p, d, hu, sp_zyx)
        arr = KA.emulate_kernel(arr, sp_zyx, 0.0, NOISE_SD, seed)
        img = sitk.GetImageFromArray(arr)
        img.CopyInformation(ct_img)
        study, ser, frame = SD.new_uid(), SD.new_uid(), SD.new_uid()
        out_dir = os.path.join(root, bucket, wallet, "imaging", study, ser)
        date = BASE_DATE if s.startswith("B") else FU_DATE
        SD.write_series(img, out_dir, series_description=f"SYNTHETIC detector test {s}", study_date=date, study_uid=study, series_uid=ser,
                        frame_uid=frame, kernel="Br44d")
        series[s] = {"study": study, "series": ser, "study_date": date, "n_nodules_inserted": len(scans[s]["nodules"])}
        log(f"wrote {s}: {img.GetDepth()} slices, {len(scans[s]['nodules'])} nodules, study {study[-12:]}")
    truth["series"] = series
    pairs_json = {pid: {"job_id": f"ka-detector-{pid}",
                        "timepoints": [{"label": "base", "study": series[pr["base"]]["study"], "series": series[pr["base"]]["series"]},
                                       {"label": "fu", "study": series[pr["fu"]]["study"], "series": series[pr["fu"]]["series"]}]}
                  for pid, pr in pairs.items()}
    os.makedirs(os.path.join(root, "_truth"), exist_ok=True)
    json.dump(truth, open(os.path.join(root, "_truth", "truth.json"), "w"), indent=1)
    json.dump(pairs_json, open(os.path.join(root, "_truth", "pairs.json"), "w"), indent=1)
    return truth


# ------------------------------------------------------------------------------ evaluation
def sphere_mask_on(img, center_xyz_mm, d_mm):
    """Boolean z,y,x array of a sphere of diameter d_mm at a physical position, on the grid of a SimpleITK image."""
    sp = np.array(img.GetSpacing())
    size = np.array(img.GetSize())
    ci = np.array(img.TransformPhysicalPointToContinuousIndex(tuple(float(v) for v in center_xyz_mm)))
    reach = (d_mm / 2.0 + 2.0) / sp
    lo = np.maximum(np.floor(ci - reach).astype(int), 0)
    hi = np.minimum(np.ceil(ci + reach).astype(int) + 1, size)
    out = np.zeros(size[::-1], bool)
    if np.any(hi <= lo):
        return out
    xs, ys, zs = [np.arange(lo[k], hi[k]) for k in range(3)]
    zz, yy, xx = np.meshgrid((zs - ci[2]) * sp[2], (ys - ci[1]) * sp[1], (xs - ci[0]) * sp[0], indexing="ij")
    out[lo[2]:hi[2], lo[1]:hi[1], lo[0]:hi[0]] = (zz ** 2 + yy ** 2 + xx ** 2) <= (d_mm / 2.0) ** 2
    return out


def best_instance(inst_arr, truth_mask):
    """The instance with the best IoU against a truth sphere: (id, iou) or (None, 0.0)."""
    ids = np.unique(inst_arr[truth_mask])
    best, bi = None, 0.0
    tv = int(truth_mask.sum())
    for i in ids:
        if i == 0:
            continue
        m = inst_arr == i
        inter = int(np.logical_and(m, truth_mask).sum())
        iou = inter / float(int(m.sum()) + tv - inter) if inter else 0.0
        if iou > bi:
            best, bi = int(i), iou
    return best, round(bi, 3)


def reference_from_findings(findings):
    base = [(f["organ"], f["baseline_long_axis_mm"]) for f in findings if not f["new_lesion"] and f["baseline_long_axis_mm"] > 0]
    fu = [f["followup_long_axis_mm"] for f in findings if not f["new_lesion"] and f["baseline_long_axis_mm"] > 0]
    new = [f["followup_long_axis_mm"] for f in findings if f["new_lesion"]]
    return KF.reference_category(base, fu, new)[0]


def evaluate(root, wallet, bucket="genobank-health-imaging", env=None, log=print):
    import SimpleITK as sitk
    truth = json.load(open(os.path.join(root, "_truth", "truth.json")))
    pairs = json.load(open(os.path.join(root, "_truth", "pairs.json")))
    out = {"schema": REPORT_SCHEMA, "truth_created_utc": truth["created_utc"], "source_job": truth["source_job"], "environment": env, "pairs": {}}
    for pid, tp in truth["pairs"].items():
        d = os.path.join(root, bucket, wallet, "imaging-findings", pairs[pid]["job_id"])
        fpath = os.path.join(d, "findings.json")
        if not os.path.exists(fpath):
            out["pairs"][pid] = {"ran": False}
            continue
        fj = json.load(open(fpath))
        iv = fj["intervals"][0]
        masks = {}
        for k, nm in (("b", "char_base_fu_b_inst.nii.gz"), ("f", "char_base_fu_f_inst.nii.gz")):
            p = os.path.join(d, nm)
            masks[k] = sitk.ReadImage(p) if os.path.exists(p) else None
        arrs = {k: (sitk.GetArrayFromImage(v) if v is not None else None) for k, v in masks.items()}
        findings = iv["findings"]
        rows = []
        for n in tp["nodules"]:
            row = {"id": n["id"], "hu": n["hu"], "base_d": n["base_d"], "fu_d": n["fu_d"], "expect": n["expect"]}
            det = {}
            for k, dd in (("b", n["base_d"]), ("f", n["fu_d"])):
                if dd and masks[k] is not None:
                    tm = sphere_mask_on(masks[k], n["center_phys_xyz_mm"], dd)
                    iid, iou = best_instance(arrs[k], tm)
                    det[k] = {"instance": iid, "iou": iou, "detected": bool(iid is not None and iou >= IOU_DETECTED)}
                elif dd:
                    det[k] = {"instance": None, "iou": 0.0, "detected": False, "no_mask": True}
            row["detection"] = det
            fnd = None
            if det.get("b", {}).get("detected"):
                fnd = next((f for f in findings if f.get("baseline_inst") == det["b"]["instance"]), None)
            if fnd is None and det.get("f", {}).get("detected"):
                fnd = next((f for f in findings if f.get("followup_inst") == det["f"]["instance"] and f.get("followup_src") == "detect"), None)
            if fnd is not None:
                row["finding"] = {k: fnd[k] for k in ("status", "baseline_long_axis_mm", "followup_long_axis_mm", "organ", "followup_src")}
                for k, dd, key in (("b", n["base_d"], "baseline_long_axis_mm"), ("f", n["fu_d"], "followup_long_axis_mm")):
                    if dd and det.get(k, {}).get("detected") and fnd[key]:
                        err = round(fnd[key] - dd, 2)
                        row.setdefault("axis_error_mm", {})[k] = {"measured": fnd[key], "error": err, "ok": abs(err) <= max(2.0, 0.15 * dd)}
                row["status_graded"] = bool(det) and all(det[k]["detected"] for k in det)       # detected in every scan where it exists
                row["status_ok"] = fnd["status"] == n["expect"] if row["status_graded"] else None
            else:
                row["finding"] = None
                row["status_graded"] = False
            rows.append(row)
        new_or_enl = [f for f in findings if f["status"] in ("new", "enlarged")]
        truth_ids = {r["detection"].get("f", {}).get("instance") for r in rows} | {r["detection"].get("b", {}).get("instance") for r in rows}
        out["pairs"][pid] = {
            "ran": True, "elapsed_sec": fj.get("elapsed_sec"), "tracker": iv["tracker"], "detected_classes": fj.get("detected_classes"),
            "dropped_classes": fj.get("dropped_classes"), "n_baseline_instances": iv["n_baseline_lesions"], "n_followup_instances": iv["n_followup_lesions"],
            "reported_category": iv["recist_response"]["category"], "category_from_findings_by_reference_rules": reference_from_findings(findings),
            "truth_category": tp["truth_category"], "nodules": rows,
            "findings_all": [{k: f[k] for k in ("status", "organ", "baseline_long_axis_mm", "followup_long_axis_mm", "measurable")} for f in findings],
            "n_new_or_enlarged": len(new_or_enl),
            "dt2_ok": (len(new_or_enl) == 0) if pid == "D0" else None,
            "dt5_ok": iv["recist_response"]["category"] == reference_from_findings(findings),
        }
        pr = out["pairs"][pid]
        pr["dt3_failed"] = [r["id"] for r in rows if any(not v["ok"] for v in r.get("axis_error_mm", {}).values())]
        pr["dt4_failed"] = [r["id"] for r in rows if r.get("status_ok") is False]
        pr["missed"] = [r["id"] for r in rows if not any(v["detected"] for v in r["detection"].values())]
    # sensitivity (DT1): by follow-up diameter and density for the new nodules of D1
    sens = []
    if out["pairs"].get("D1", {}).get("ran"):
        for r in out["pairs"]["D1"]["nodules"]:
            sens.append({"id": r["id"], "diameter_mm": r["fu_d"], "hu": r["hu"], "detected": r["detection"]["f"]["detected"], "iou": r["detection"]["f"]["iou"]})
    out["sensitivity_D1"] = sens
    return out


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build"); b.add_argument("--src-dir", required=True); b.add_argument("--root", required=True)
    b.add_argument("--wallet", required=True); b.add_argument("--bucket", default="genobank-health-imaging")
    e = sub.add_parser("evaluate"); e.add_argument("--root", required=True); e.add_argument("--out", required=True)
    e.add_argument("--wallet", required=True); e.add_argument("--bucket", default="genobank-health-imaging"); e.add_argument("--env")
    args = ap.parse_args(argv)
    if args.cmd == "build":
        t = build(args.src_dir, args.root, args.wallet, args.bucket)
        print(json.dumps({pid: len(p["nodules"]) for pid, p in t["pairs"].items()}))
        return 0
    env = json.load(open(args.env)) if args.env and os.path.exists(args.env) else None
    rep = evaluate(args.root, args.wallet, args.bucket, env)
    json.dump(rep, open(args.out, "w"), indent=1, default=str)
    for pid, p in rep["pairs"].items():
        if not p.get("ran"):
            print(pid, "did not run"); continue
        print(f"{pid}: tracker {p['tracker']}, instances {p['n_baseline_instances']}/{p['n_followup_instances']}, new_or_enlarged {p['n_new_or_enlarged']}, "
              f"category reported {p['reported_category']} (reference on findings {p['category_from_findings_by_reference_rules']}, truth {p['truth_category']}), "
              f"missed {p['missed']}, DT3 failed {p['dt3_failed']}, DT4 failed {p['dt4_failed']}, DT5 {'ok' if p['dt5_ok'] else 'NO'}, {p['elapsed_sec']} s")
    print("SENSITIVITY D1", json.dumps([(s["diameter_mm"], s["hu"], s["detected"]) for s in rep["sensitivity_D1"]]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
