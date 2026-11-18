#!/usr/bin/env python3
"""Organ volume floors: how much does the volume of an organ, as TotalSegmentator draws it, change between two scans when nothing about the
organ has changed? Criteria and predictions: organ_floor_criteria-20261106.txt (hashed before this module existed).

A floor lets the organ package say that a change is larger than the variation of the measurement. It does not say that a change is relevant for a
patient. It is a lower bound of the variation between two visits: filling of hollow organs, posture, arms and contrast phase are not in it.

Sources, each "no true change" by construction:
  S1  perturbation of the operator's own native scans (noise, blur, a sub-voxel shift), each variant segmented again by the production path
  S2  real same-day repeats (RIDER Lung CT, 8 pairs already segmented)
  S3  real reconstruction change (RIDER Lung CT, lung kernel against standard kernel, same raw data, 1.25 mm and 2.5 mm)

  variants  python organ_floor.py variants --job-out DIR --scan LABEL --out DIR         (inside the imaging-register image, GPU)
  repeats   python organ_floor.py repeats  --dir DATA --out FILE                         (S2, labels read from disk)
  kernel    python organ_floor.py kernel   --dir DATA --out FILE                         (S3, GPU)
  combine   python organ_floor.py combine  --s1 FILE [FILE ...] --s2 FILE --s3 FILE --out floors.json
Nothing here reads DICOM except S3's reconstruction series, which are public benchmark data on the server's disk."""
import argparse
import hashlib
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, "/app")
import organ_package as OP

SCHEMA = "organ-volume-floors/1"
MIN_N = 8
VARIANTS = (("V0", {}),
            ("V1", {"noise_hu": 10.0, "seed": 1}),
            ("V2", {"noise_hu": 10.0, "seed": 2}),
            ("V3", {"noise_hu": 20.0, "seed": 3}),
            ("V4", {"blur_mm": 0.6}),
            ("V5", {"shift_mm": 0.5}),
            ("V6", {"blur_mm": 0.6, "noise_hu": 10.0, "seed": 4}))
FLOOR_VARIANTS = ("V1", "V2", "V3", "V4", "V5", "V6")
SOURCE_TEXT = {
    "S1_perturbation": "native scans of the operator, 6 emulated variants each (noise 10 and 20 HU, blur 0.6 mm, a 0.5 mm shift, blur with noise), segmented again",
    "S2_same_day_repeat": "RIDER Lung CT, 8 same-day pairs of one scanner and kernel, minutes apart (repositioning, breath, noise)",
    "S3_reconstruction": "RIDER Lung CT, lung kernel against standard kernel of the same raw data, 1.25 and 2.5 mm, 6 patients",
}
EXCLUDES = ("filling of hollow organs", "posture and arms", "contrast phase and cardiac phase beyond what the sources contain",
            "differences between scanners and protocols beyond the reconstruction pair of S3",
            "for organs with no same-day repeat (every organ below the chest except the part inside the chest field of view): every real source")
CITATION = ("RIDER Lung CT, The Cancer Imaging Archive, doi 10.7937/k9/tcia.2015.u1x8a5nr, CC BY 4.0 (Zhao, Schwartz, Kris, Riely 2015)")


def log(*a):
    print("[organ_floor]", *a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------------------------------------------------
# Perturbations of a CT (SimpleITK image in, same grid and pixel type out)
def _cast_like(arr, img):
    import SimpleITK as sitk
    pid = img.GetPixelID()
    if pid in (sitk.sitkInt16, sitk.sitkInt32, sitk.sitkInt8, sitk.sitkUInt8, sitk.sitkUInt16, sitk.sitkUInt32):
        info = np.iinfo(sitk.GetArrayFromImage(img).dtype)
        arr = np.clip(np.rint(arr), info.min, info.max)
    out = sitk.GetImageFromArray(arr.astype(sitk.GetArrayFromImage(img).dtype))
    out.CopyInformation(img)
    return out


def apply_variant(img, spec):
    """Blur, then shift, then noise. An empty spec returns the original unchanged."""
    import SimpleITK as sitk
    from scipy import ndimage
    if not spec:
        return img
    cur = img
    if spec.get("blur_mm"):
        sp = np.array(img.GetSpacing()[::-1])                 # z, y, x
        arr = ndimage.gaussian_filter(sitk.GetArrayFromImage(cur).astype(np.float32), sigma=float(spec["blur_mm"]) / sp, mode="nearest")
        cur = _cast_like(arr, img)
    if spec.get("shift_mm"):
        tf = sitk.TranslationTransform(3, tuple(float(spec["shift_mm"]) for _ in range(3)))
        cur = sitk.Resample(cur, cur, tf, sitk.sitkLinear, -1024.0, cur.GetPixelID())
    if spec.get("noise_hu"):
        rng = np.random.default_rng(int(spec.get("seed", 0)))
        arr = sitk.GetArrayFromImage(cur).astype(np.float32)
        arr = arr + rng.normal(0.0, float(spec["noise_hu"]), arr.shape).astype(np.float32)
        cur = _cast_like(arr, img)
    return cur


# ---------------------------------------------------------------------------------------------------------------------
# Volumes of the organs of a label map
def organ_table(label_arr, voxel_ml, names, organs=OP.DEFAULT_ORGANS):
    """{organ: {"volume_ml", "cut"}} for the organs present in the label map. `cut` is organ_package.scan_edge."""
    out = {}
    for organ in organs:
        ids = OP.organ_ids(names, organ)
        if not ids:
            continue
        m = np.isin(label_arr, ids)
        n = int(m.sum())
        if n == 0:
            continue
        out[organ] = {"volume_ml": float(n * voxel_ml), "cut": bool(OP.scan_edge(m)["cut_by_scan_range"])}
    return out


def compare_tables(ref, var):
    """Per organ: (percent difference, ml difference) of var against ref; None when the organ is missing in one, or cut in either."""
    out = {}
    for organ, r in ref.items():
        v = var.get(organ)
        if v is None or r["cut"] or v["cut"] or r["volume_ml"] <= 0:
            continue
        d = v["volume_ml"] - r["volume_ml"]
        out[organ] = (abs(100.0 * d / r["volume_ml"]), abs(d))
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Pooling
def stats(pairs, min_n=MIN_N):
    """pairs: list of (percent, ml) absolute differences. None when fewer than min_n."""
    if len(pairs) < min_n:
        return None
    p = np.array([x[0] for x in pairs], float)
    m = np.array([x[1] for x in pairs], float)
    return {"n": int(len(p)), "median_pct": float(np.median(p)), "p95_pct": float(np.percentile(p, 95)), "max_pct": float(p.max()),
            "p95_ml": float(np.percentile(m, 95))}


def pool(records_list):
    """records_list: list of {organ: (pct, ml)} (one per comparison) -> {organ: [(pct, ml), ...]}"""
    out = {}
    for rec in records_list:
        for organ, pm in rec.items():
            out.setdefault(organ, []).append(tuple(pm))
    return out


def combine_floors(sources, organs=OP.DEFAULT_ORGANS, min_n=MIN_N):
    """sources: {source name: {organ: [(pct, ml), ...]}}. Floor per organ = the largest p95 percent over the sources with n >= min_n."""
    res = {}
    for organ in organs:
        by, used = {}, []
        for name in sorted(sources):
            vals = sources[name].get(organ, [])
            st = stats(vals, min_n)
            by[name] = st if st is not None else {"n": len(vals), "floor": None, "reason": f"n below {min_n}"}
            if st is not None:
                used.append((st["p95_pct"], st["p95_ml"], name))
        if not used:
            res[organ] = {"floor_pct": None, "floor_ml": None, "sources_used": [], "by_source": by,
                          "reason": f"no source with {min_n} or more values"}
        else:
            top = max(used)
            res[organ] = {"floor_pct": top[0], "floor_ml": max(u[1] for u in used), "set_by": top[2],
                          "sources_used": sorted(u[2] for u in used), "by_source": by}
    return res


def floors_document(sources, inputs=None, organs=OP.DEFAULT_ORGANS, min_n=MIN_N):
    return {"schema": SCHEMA, "min_n": min_n,
            "rule": "floor_pct = the largest 95th percentile of the absolute relative volume difference (percent) over the sources with n >= min_n",
            "sources": {k: SOURCE_TEXT.get(k, k) for k in sorted(sources)}, "excludes": list(EXCLUDES), "citation": CITATION,
            "inputs": inputs or {}, "organs": combine_floors(sources, organs, min_n),
            "reading": ("A change larger than the floor is larger than the variation between scans of unchanged anatomy seen in the listed sources. "
                        "A change inside it cannot be told from that variation. Neither is a clinical call.")}


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


# ---------------------------------------------------------------------------------------------------------------------
# Commands that need the image libraries
def _names_total():
    from totalsegmentator.map_to_binary import class_map
    return {int(k): v for k, v in class_map["total"].items()}


def cmd_variants(job_out, scan, out_dir, which=None, keep_ct=False):
    import SimpleITK as sitk
    import register as R
    with open(os.path.join(job_out, "manifest.json")) as f:
        manifest = json.load(f)
    names = {int(k): v for k, v in manifest["label_names"].items()}
    ct_path = os.path.join(job_out, "native", scan, "ct.nii.gz")
    lab_path = os.path.join(job_out, "native", scan, "labels.nii.gz")
    ct = sitk.ReadImage(ct_path)
    lab = sitk.GetArrayFromImage(sitk.ReadImage(lab_path))
    vox_ml = float(np.prod(ct.GetSpacing())) / 1000.0
    res = {"job_id": manifest["job_id"], "scan": scan, "voxel_ml": vox_ml, "ct_sha256": OP.sha256_file(ct_path),
           "original": organ_table(lab, vox_ml, names), "variants": {}, "failed": {}}
    os.makedirs(out_dir, exist_ok=True)
    for vname, spec in VARIANTS:
        if which and vname not in which:
            continue
        t0 = time.time()
        d = os.path.join(out_dir, scan, vname)
        os.makedirs(d, exist_ok=True)
        try:
            vct = os.path.join(d, "ct.nii.gz")
            sitk.WriteImage(apply_variant(ct, spec), vct)
            labels, vnames = R.segment(vct, os.path.join(d, "labels.nii.gz"))
            arr = sitk.GetArrayFromImage(sitk.ReadImage(labels))
            tab = organ_table(arr, vox_ml, vnames if vnames else names)
            res["variants"][vname] = {"spec": spec, "table": tab, "seconds": round(time.time() - t0, 1)}
            log(scan, vname, f"{len(tab)} organs, {time.time() - t0:.0f} s")
        except Exception as e:
            res["failed"][vname] = f"{type(e).__name__}: {str(e)[:200]}"
            log(scan, vname, "FAILED", e)
        finally:
            if not keep_ct and os.path.exists(os.path.join(d, "ct.nii.gz")):
                os.remove(os.path.join(d, "ct.nii.gz"))
        with open(os.path.join(out_dir, f"s1_{manifest['job_id']}_{scan}.json"), "w") as f:
            json.dump(res, f, indent=1, sort_keys=True)
    return res


def cmd_repeats(base, out):
    import SimpleITK as sitk
    import rider_repeat as RR
    names = _names_total()
    pairs, skipped = [], {}
    for pid in sorted(d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))):
        A, B, why = RR.select_pair(RR.gather_infos(base, pid))
        if A is None:
            skipped[pid] = why
            continue
        tabs = []
        for s in (A, B):
            ct = sitk.ReadImage(os.path.join(s["sd"], "ct.nii.gz"))
            lab = sitk.GetArrayFromImage(sitk.ReadImage(os.path.join(s["sd"], "labels.nii.gz")))
            tabs.append(organ_table(lab, float(np.prod(ct.GetSpacing())) / 1000.0, names))
        pairs.append({"pair": pid, "acq_times": [A["acq_time"], B["acq_time"]], "A": tabs[0], "B": tabs[1]})
        log(pid, "pair read")
    res = {"source": CITATION, "pairs": pairs, "skipped": skipped}
    json.dump(res, open(out, "w"), indent=1, sort_keys=True)
    return res


def kernel_plan(base, thicknesses=(1.25, 2.5)):
    """The lung-kernel and standard-kernel reconstruction pairs of each patient, from the DICOM headers only (nothing is segmented)."""
    import glob
    import register as R
    plan, failed = [], {}
    if [d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))] == ["data"]:     # the download keeps the patients one level down
        base = os.path.join(base, "data")
    for pid in sorted(d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d)) and d.startswith("RIDER-")):
        series = []
        for sd in sorted(os.path.join(base, pid, x) for x in os.listdir(os.path.join(base, pid))):
            fs = sorted(glob.glob(os.path.join(sd, "**", "*.dcm"), recursive=True))
            if not fs:
                continue
            p = R.read_protocol(os.path.dirname(fs[0]))
            series.append({"sd": sd, "dir": os.path.dirname(fs[0]), "kernel": (p.get("kernel") or "").upper(),
                           "thickness": p.get("slice_thickness_mm"), "n": p.get("n_slices")})
        for t in thicknesses:
            at = [s for s in series if s["thickness"] and abs(s["thickness"] - t) < 0.15]
            lung = [s for s in at if "LUNG" in s["kernel"]]
            std = [s for s in at if "STANDARD" in s["kernel"]]
            if len(lung) != 1 or len(std) != 1:
                failed[f"{pid}@{t}"] = f"{len(lung)} lung and {len(std)} standard reconstructions at this thickness"
                continue
            plan.append({"pair": f"{pid}@{t}", "thickness_mm": t, "lung": lung[0], "standard": std[0]})
    return plan, failed


def cmd_kernel(base, out, thicknesses=(1.25, 2.5), plan_only=False):
    import SimpleITK as sitk
    import register as R
    plan, failed = kernel_plan(base, thicknesses)
    if plan_only:
        print(json.dumps({"pairs": [{k: (v if not isinstance(v, dict) else {"kernel": v["kernel"], "thickness": v["thickness"], "n": v["n"]})
                                     for k, v in p.items()} for p in plan], "failed": failed}, indent=1))
        return None
    names = _names_total()
    pairs = []
    for item in plan:
        tabs = []
        try:
            for s in (item["lung"], item["standard"]):
                nii = os.path.join(s["sd"], "ct.nii.gz")
                if not os.path.exists(nii):
                    nii = R.preprocess(R.dcm_to_nifti(s["dir"], os.path.join(s["sd"], "raw.nii.gz")), nii, iso=1.0)
                labels, _ = R.segment(nii, os.path.join(s["sd"], "labels.nii.gz"))
                ct = sitk.ReadImage(nii)
                tabs.append(organ_table(sitk.GetArrayFromImage(sitk.ReadImage(labels)), float(np.prod(ct.GetSpacing())) / 1000.0, names))
            pairs.append({"pair": item["pair"], "thickness_mm": item["thickness_mm"], "lung": tabs[0], "standard": tabs[1]})
            log(item["pair"], "pair segmented")
        except Exception as e:
            failed[item["pair"]] = f"{type(e).__name__}: {str(e)[:200]}"
            log(item["pair"], "FAILED", e)
        json.dump({"source": CITATION, "pairs": pairs, "failed": failed}, open(out, "w"), indent=1, sort_keys=True)
    res = {"source": CITATION, "pairs": pairs, "failed": failed}
    json.dump(res, open(out, "w"), indent=1, sort_keys=True)
    return res


def records_s1(files):
    """S1 comparisons from the per-scan files: every perturbed variant against the job's own native labels."""
    out = []
    for fp in files:
        d = json.load(open(fp))
        for vname in FLOOR_VARIANTS:
            v = d["variants"].get(vname)
            if v:
                out.append(compare_tables(d["original"], v["table"]))
    return out


def records_pairs(doc, a_key, b_key):
    return [compare_tables(p[a_key], p[b_key]) for p in doc["pairs"]]


def baseline_check(files, min_ml=20.0, tol_pct=0.5):
    """RF3: V0 against the job's own labels, for every organ of min_ml or more."""
    rows, worst, n = [], 0.0, 0
    for fp in files:
        d = json.load(open(fp))
        v0 = (d["variants"].get("V0") or {}).get("table")
        if v0 is None:
            rows.append({"scan": f"{d['job_id']}:{d['scan']}", "V0": "missing"})
            continue
        for organ, r in d["original"].items():
            if r["volume_ml"] < min_ml:
                continue
            n += 1
            v = v0.get(organ)
            diff = 100.0 if v is None else abs(100.0 * (v["volume_ml"] - r["volume_ml"]) / r["volume_ml"])
            worst = max(worst, diff)
            if diff > tol_pct:
                rows.append({"scan": f"{d['job_id']}:{d['scan']}", "organ": organ, "diff_pct": round(diff, 3)})
    return {"organs_checked": n, "worst_diff_pct": round(worst, 4), "deviations": rows, "pass": not rows}


def cmd_combine(s1_files, s2_file, s3_file, out):
    srcs, inputs = {}, {}
    srcs["S1_perturbation"] = pool(records_s1(s1_files))
    for fp in s1_files:
        inputs[os.path.basename(fp)] = OP.sha256_file(fp)
    if s2_file and os.path.isfile(s2_file):
        srcs["S2_same_day_repeat"] = pool(records_pairs(json.load(open(s2_file)), "A", "B"))
        inputs[os.path.basename(s2_file)] = OP.sha256_file(s2_file)
    if s3_file and os.path.isfile(s3_file):
        srcs["S3_reconstruction"] = pool(records_pairs(json.load(open(s3_file)), "lung", "standard"))
        inputs[os.path.basename(s3_file)] = OP.sha256_file(s3_file)
    doc = floors_document(srcs, inputs)
    doc["built_at_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with open(out, "w") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("variants")
    v.add_argument("--job-out", required=True); v.add_argument("--scan", required=True); v.add_argument("--out", required=True)
    v.add_argument("--only", default=""); v.add_argument("--keep-ct", action="store_true")
    r = sub.add_parser("repeats"); r.add_argument("--dir", required=True); r.add_argument("--out", required=True)
    k = sub.add_parser("kernel"); k.add_argument("--dir", required=True); k.add_argument("--out", required=True)
    k.add_argument("--plan-only", action="store_true")
    c = sub.add_parser("combine")
    c.add_argument("--s1", nargs="+", required=True); c.add_argument("--s2"); c.add_argument("--s3"); c.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "variants":
        cmd_variants(a.job_out, a.scan, a.out, set(x for x in a.only.split(",") if x) or None, a.keep_ct)
    elif a.cmd == "repeats":
        cmd_repeats(a.dir, a.out)
    elif a.cmd == "kernel":
        cmd_kernel(a.dir, a.out, plan_only=a.plan_only)
    else:
        doc = cmd_combine(a.s1, a.s2, a.s3, a.out)
        print(json.dumps({o: (d["floor_pct"], d.get("sources_used")) for o, d in doc["organs"].items()}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
