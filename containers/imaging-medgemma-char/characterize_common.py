#!/usr/bin/env python3
"""characterize_common.py — shared Tier-2 candidate loader.

Reads a finished `biofs imaging findings` job's saved per-lesion instance masks + native
CTs from GCS and crops each candidate's ROI (image + binary mask) in NATIVE CT space, so
any Tier-2 method (PyRadiomics, CT-FM, Merlin, PASTA, MedGemma) consumes a consistent
substrate. Clinical-scope: wallet only, never a name. Decision-support; this just provides
the ROI, the methods do the studying.
"""
import os, json, subprocess, time
import numpy as np

IMAGING_BUCKET = os.getenv("IMAGING_BUCKET", "genobank-health-imaging")
ROI_MARGIN_MM = float(os.getenv("ROI_MARGIN_MM", "12"))   # context margin around the lesion bbox


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}] [characterize]", *a, flush=True)


def _cat(gcs_path, dest):
    try:
        subprocess.run(["gcloud", "storage", "cp", gcs_path, dest], check=True,
                       capture_output=True, text=True)
        return dest if os.path.exists(dest) else None
    except Exception:
        return None


def load_findings(wallet, job, wd):
    p = f"gs://{IMAGING_BUCKET}/{wallet}/imaging-findings/{job}/findings.json"
    dest = os.path.join(wd, "findings.json")
    if not _cat(p, dest):
        raise RuntimeError(f"no findings.json at {p}")
    return json.load(open(dest))


def _crop(ct_path, mask_path, label, wd, tag):
    """Crop the ROI (image + binary mask) around the given instance label in native space."""
    import SimpleITK as sitk
    from scipy import ndimage as ndi
    ct = sitk.ReadImage(ct_path); mk = sitk.ReadImage(mask_path)
    if mk.GetSize() != ct.GetSize():
        mk = sitk.Resample(mk, ct, sitk.Transform(), sitk.sitkNearestNeighbor, 0, sitk.sitkInt16)
    a = sitk.GetArrayFromImage(mk); m = (a == label)
    if not m.any():
        return None
    sl = ndi.find_objects(m.astype(np.int32))[0]
    sp = ct.GetSpacing()                                  # (x, y, z) mm
    mz = max(1, int(round(ROI_MARGIN_MM / sp[2])))
    my = max(1, int(round(ROI_MARGIN_MM / sp[1])))
    mx = max(1, int(round(ROI_MARGIN_MM / sp[0])))
    z0 = max(0, sl[0].start - mz); z1 = min(a.shape[0], sl[0].stop + mz)
    y0 = max(0, sl[1].start - my); y1 = min(a.shape[1], sl[1].stop + my)
    x0 = max(0, sl[2].start - mx); x1 = min(a.shape[2], sl[2].stop + mx)
    ct_a = sitk.GetArrayFromImage(ct)[z0:z1, y0:y1, x0:x1].astype(np.int16)
    mk_a = (a[z0:z1, y0:y1, x0:x1] == label).astype(np.uint8)
    ci = sitk.GetImageFromArray(ct_a); ci.SetSpacing(sp)
    mi = sitk.GetImageFromArray(mk_a); mi.SetSpacing(sp)
    cip = os.path.join(wd, f"{tag}_ct.nii.gz"); mip = os.path.join(wd, f"{tag}_mask.nii.gz")
    sitk.WriteImage(ci, cip); sitk.WriteImage(mi, mip)
    return {"ct": cip, "mask": mip, "n_vox": int(mk_a.sum()), "spacing": [round(s, 2) for s in sp],
            "shape": list(ct_a.shape)}


def load_candidates(wallet, job, wd):
    """Return (findings_json, [candidate]) where each candidate has its baseline/followup ROI
    crops (image + mask) ready for a Tier-2 method. A crop is None when the lesion is absent at
    that timepoint (e.g. a 'new' lesion has no baseline, a 'resolved' lesion has no followup)."""
    f = load_findings(wallet, job, wd)
    cands = []; art_cache = {}; cidx = 0
    for iv in f.get("intervals", []):
        iid = f"{iv['baseline_label']}_{iv['followup_label']}"
        if iid not in art_cache:
            a = {}
            for nm in ["b_ct", "f_ct", "b_inst", "f_inst", "tracked_inst"]:
                a[nm] = _cat(f"gs://{IMAGING_BUCKET}/{wallet}/imaging-findings/{job}/char_{iid}_{nm}.nii.gz",
                             os.path.join(wd, f"char_{iid}_{nm}.nii.gz"))
            art_cache[iid] = a
        a = art_cache[iid]
        for fnd in iv.get("findings", []):
            cidx += 1; cid = f"C{cidx}"
            base = foll = None
            if fnd.get("baseline_inst") is not None and a.get("b_ct") and a.get("b_inst"):
                base = _crop(a["b_ct"], a["b_inst"], int(fnd["baseline_inst"]), wd, f"{cid}_base")
            if fnd.get("followup_inst") is not None and a.get("f_ct"):
                mp = a.get("f_inst") if fnd.get("followup_src") == "detect" else a.get("tracked_inst")
                if mp:
                    foll = _crop(a["f_ct"], mp, int(fnd["followup_inst"]), wd, f"{cid}_foll")
            cands.append({
                "id": cid, "interval": iid, "organ": fnd.get("organ"),
                "tumor_class": fnd.get("tumor_class"), "status": fnd.get("status"),
                "baseline_long_axis_mm": fnd.get("baseline_long_axis_mm"),
                "followup_long_axis_mm": fnd.get("followup_long_axis_mm"),
                "centroid_mm": fnd.get("centroid_mm"),
                "phase_match": (iv.get("contrast_phase") or {}).get("matched"),
                "baseline": base, "followup": foll,
            })
    log(f"loaded {len(cands)} candidate(s) across {len(art_cache)} interval(s)")
    return f, cands
