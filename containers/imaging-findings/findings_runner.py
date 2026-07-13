#!/usr/bin/env python3
"""
findings_runner.py - longitudinal CT PATHOGENIC-FINDINGS read (no volumes).

A fresh, findings-only pipeline. For 3 studies (oldest -> newest) it runs the
clinical "current vs prior" read PAIRWISE, baseline-forward, exactly as specified:
  Interval 1: lock on study[0] (fixed) -> find what changed in study[1]
  Interval 2: re-baseline on study[1] (fixed) -> find what changed in study[2]

Per interval (baseline B fixed, follow-up F):
  1. RIGID LOCK   F -> B (SimpleITK 6-DOF Mattes mutual information; Maes 1997 /
     Mattes 2003). Reproducible spatial frame; rigid so a real focal change is
     never smeared away. Produces the locked aligned volumes for a blink/diff view.
  2. DETECT       VISTA-3D auto tumor-class segmentation (He 2024) on B and on F.
     Zero-shot, automatic, from-scratch -> candidate lesion instances. The ONLY
     deployable automatic detector (ULS23 is a VOI-segmenter, PASTA needs
     fine-tuning). HONEST LIMIT: bounded to VISTA-3D's tumor classes, no
     lymph-node class, so "nothing found" is NOT a comprehensive rule-out.
  3. TRACK        LesionLocator (Rokuss CVPR 2025) propagates each B lesion into
     F (prev_mask prompt) -> per-lesion fate, catching iso-attenuating growth and
     lesions VISTA-3D misses on F. Falls back to overlap-in-locked-frame if
     LesionLocator is unavailable (flagged honestly).
  4. FINDINGS     classify new / enlarged / shrunk / resolved; size as RECIST
     long-axis (mm), NEVER volume, NEVER doubling time. Organ comes free from the
     VISTA-3D tumor class.
  5. RECIST 1.1   response category (CR/PR/SD/PD) on long-axis SLD (Eisenhauer
     2009), kept and re-powered by the tracking. Diameter-based: no volume, no VDT.
     Category ALWAYS emitted with a graded confidence + its factors, never withheld.

Decision-support, NOT a diagnosis. Every finding and category is a model-proposed
CANDIDATE for radiologist confirmation against the source images. De-identified:
wallet / case-label only, never a name; no raw DICOM free-text persisted.

Env: WALLET, JOB_ID, TIMEPOINTS (JSON [{label,study,series}], oldest->newest, >=2),
     TREATMENT_CONTEXT (default unknown), LL_CHECKPOINT (LesionLocator checkpoint dir,
     default /scratch/LesionLocatorCheckpoint), IMAGING_BUCKET, OUTPUT_BUCKET.
"""
import os, sys, json, time, math, tempfile, glob, subprocess, traceback
import numpy as np
os.environ.setdefault("HF_HOME", "/scratch/hf")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vista3d_runner as V3            # reuse stage_series/dcm_to_nifti/detect_phase/segment/log/sh
log = V3.log

# VISTA-3D tumor classes (auto-seg; tier fallback drops any the deployment rejects).
# Whole-FOV: try abdomen (pancreatic 24, hepatic 26, liver 130) + chest (lung 23).
TUMOR_TIERS = [[24, 26, 130, 23], [24, 26, 23], [24, 26], [24], [23]]
TUMOR_ORGAN = {23: "lung", 24: "pancreas", 26: "liver", 130: "liver"}
TUMOR_NAME  = {23: "lung_tumor", 24: "pancreatic_tumor", 26: "hepatic_tumor", 130: "liver_tumor"}
MIN_LESION_ML = float(os.getenv("MIN_LESION_ML", "0.2"))   # ~7mm floor, internal noise filter only (NOT reported)
MEAS_MM = 10.0                                              # RECIST measurable long axis
ENLARGE_FRAC = 0.20                                        # >=20% long-axis increase = enlarged (RECIST-ish)
LL_CKPT = os.getenv("LL_CHECKPOINT", "/scratch/LesionLocatorCheckpoint")


def study_date(dcm_dir):
    """DICOM StudyDate -> datetime.date for the real day-axis. PHI-safe: only the
    relative day-offset is persisted downstream, never the absolute date."""
    try:
        import pydicom, datetime
        for f in sorted(glob.glob(os.path.join(dcm_dir, "*.dcm")))[:1]:
            ds = pydicom.dcmread(f, stop_before_pixels=True, force=True)
            s = str(getattr(ds, "StudyDate", "") or getattr(ds, "SeriesDate", "") or "")
            if len(s) == 8:
                return datetime.date(int(s[:4]), int(s[4:6]), int(s[6:8]))
    except Exception as e:
        log(f"study_date failed: {e}")
    return None


def rigid_lock(fixed_nii, moving_nii, out_warped):
    """Rigid (6-DOF) register the moving (follow-up) CT INTO the fixed (baseline) grid
    and resample it (sitkLinear). Mattes mutual information, body-mask gated, exhaustive
    z-init then gradient refine. Returns (warped_path, transform, bone_dice)."""
    import SimpleITK as sitk
    f = sitk.Cast(sitk.ReadImage(fixed_nii), sitk.sitkFloat32)
    m = sitk.Cast(sitk.ReadImage(moving_nii), sitk.sitkFloat32)

    def iso(img, mm=4.0):
        sp, sz = img.GetSpacing(), img.GetSize()
        ns = [max(1, int(round(sz[i] * sp[i] / mm))) for i in range(3)]
        return sitk.Resample(img, ns, sitk.Transform(), sitk.sitkLinear, img.GetOrigin(),
                             [mm] * 3, img.GetDirection(), -1024.0, img.GetPixelID())

    def bodymask(img):
        b = sitk.BinaryThreshold(img, -500, 4000, 1, 0)
        b = sitk.BinaryMorphologicalClosing(b, (2, 2, 2))
        cc = sitk.RelabelComponent(sitk.ConnectedComponent(b), sortByObjectSize=True)
        return sitk.BinaryThreshold(cc, 1, 1, 1, 0)

    flo, mlo = iso(f), iso(m)
    fm, mm_ = bodymask(flo), bodymask(mlo)

    def centroid(mask):
        s = sitk.LabelShapeStatisticsImageFilter(); s.Execute(mask); return s.GetCentroid(1)

    init = sitk.Euler3DTransform(); init.SetCenter(centroid(fm))
    fc, mc = centroid(fm), centroid(mm_); init.SetTranslation([mc[i] - fc[i] for i in range(3)])
    ex = sitk.ImageRegistrationMethod()
    ex.SetMetricAsMattesMutualInformation(numberOfHistogramBins=32)
    ex.SetMetricFixedMask(fm); ex.SetMetricMovingMask(mm_)
    ex.SetMetricSamplingStrategy(ex.REGULAR); ex.SetMetricSamplingPercentage(0.3)
    ex.SetInterpolator(sitk.sitkLinear)
    ex.SetOptimizerAsExhaustive([0, 0, 0, 2, 2, 12]); ex.SetOptimizerScales([1, 1, 1, 10, 10, 10])
    ex.SetInitialTransform(init, inPlace=True); ex.Execute(flo, mlo)
    R = sitk.ImageRegistrationMethod()
    R.SetMetricAsMattesMutualInformation(numberOfHistogramBins=50)
    R.SetMetricFixedMask(fm); R.SetMetricMovingMask(mm_)
    R.SetMetricSamplingStrategy(R.RANDOM); R.SetMetricSamplingPercentage(0.2, 42)
    R.SetInterpolator(sitk.sitkLinear)
    R.SetOptimizerAsRegularStepGradientDescent(2.0, 1e-4, 200, relaxationFactor=0.6)
    R.SetOptimizerScalesFromPhysicalShift()
    R.SetShrinkFactorsPerLevel([2, 1]); R.SetSmoothingSigmasPerLevel([1, 0])
    R.SmoothingSigmasAreSpecifiedInPhysicalUnitsOn(); R.SetInitialTransform(init, inPlace=True)
    R.Execute(flo, mlo)
    warped = sitk.Resample(sitk.ReadImage(moving_nii), sitk.ReadImage(fixed_nii), init,
                           sitk.sitkLinear, -1024.0)
    sitk.WriteImage(warped, out_warped)
    A = sitk.GetArrayFromImage(sitk.ReadImage(fixed_nii)).astype(np.float32)
    B = sitk.GetArrayFromImage(warped).astype(np.float32)
    cov = B > -900
    fb = (A > 150) & cov; mb = (B > 150) & cov
    inter = int(np.logical_and(fb, mb).sum()); den = int(fb.sum()) + int(mb.sum())
    return out_warped, init, (round(2 * inter / den, 3) if den else 0.0)


def detect_lesions(seg_img, classes, sp):
    """Connected-component candidate lesions from a VISTA-3D tumor-class segmentation.
    Reports RECIST long-axis (max axial Feret) in mm, organ (from class), centroid,
    instance label, and a binary mask. NO volume is reported (an internal mL floor only
    filters speckle)."""
    import SimpleITK as sitk
    from skimage import measure
    from scipy import ndimage as ndi
    arr = sitk.GetArrayFromImage(seg_img)               # [z,y,x]
    sx, sy, sz = sp[0], sp[1], sp[2]
    voxml = (sx * sy * sz) / 1000.0
    out = []; inst = np.zeros(arr.shape, np.int32); nid = 0
    classes = [c for c in classes if c in TUMOR_NAME]
    for c in classes:
        m = (arr == c)
        if not m.any():
            continue
        lbl, n = ndi.label(m)
        counts = np.bincount(lbl.ravel()); objs = ndi.find_objects(lbl)
        for i in range(1, n + 1):
            if counts[i] * voxml < MIN_LESION_ML:
                continue
            slc = objs[i - 1]; sub = (lbl[slc] == i)
            areas = sub.sum(axis=(1, 2)); lz = int(areas.argmax())
            sl = sub[lz].astype(np.uint8)
            long_mm = short_mm = solidity = 0.0
            try:
                rp = measure.regionprops(sl)[0]
                long_mm = round(float(getattr(rp, "feret_diameter_max", 0) or 0) * sx, 1)
                short_mm = round(float(getattr(rp, "axis_minor_length", 0) or 0) * sx, 1)
                solidity = round(float(getattr(rp, "solidity", 1) or 1), 2)
            except Exception:
                pass
            nid += 1
            full = np.zeros(arr.shape, bool); full[slc] |= sub; inst[full] = nid
            out.append({
                "inst": nid, "class": c, "organ": TUMOR_ORGAN.get(c, "unknown"),
                "tumor_class": TUMOR_NAME.get(c, str(c)),
                "long_axis_mm": long_mm, "short_axis_mm": short_mm, "solidity": solidity,
                "measurable": bool(long_mm >= MEAS_MM),
                "centroid_mm": [round(((slc[2].start) + (np.where(sub.any(axis=(0, 1)))[0].mean() if sub.any() else 0)) * sx, 1),
                                round(((slc[1].start) + (np.where(sub.any(axis=(0, 2)))[0].mean() if sub.any() else 0)) * sy, 1),
                                round((slc[0].start + lz) * sz, 1)],
                "slice_index": int(slc[0].start + lz), "mask": full,
            })
    return out, inst


def write_instance_mask(inst_arr, ref_img, path):
    import SimpleITK as sitk
    im = sitk.GetImageFromArray(inst_arr.astype(np.int16)); im.CopyInformation(ref_img)
    sitk.WriteImage(im, path); return path


def lesionlocator_track(baseline_nii, followup_nii, baseline_inst_mask, outdir):
    """Propagate baseline lesion instances into the follow-up with LesionLocator
    (-t prev_mask). Returns the tracked instance-mask path on F (labels consistent with
    the baseline), or None if LesionLocator is unavailable / errors (caller falls back)."""
    if not os.path.isdir(LL_CKPT):
        log(f"LesionLocator checkpoint not found at {LL_CKPT}; using overlap fallback")
        return None
    os.makedirs(outdir, exist_ok=True)
    cmd = ["LesionLocator_track", "-bl", baseline_nii, "-fu", followup_nii,
           "-p", baseline_inst_mask, "-t", "prev_mask", "-o", outdir, "-m", LL_CKPT,
           "-device", "cuda"]
    try:
        log("$", " ".join(cmd))
        subprocess.run(cmd, check=True, timeout=3600)
    except Exception as e:
        log(f"LesionLocator track failed ({str(e)[:120]}); using overlap fallback")
        return None
    masks = sorted(glob.glob(os.path.join(outdir, "**", "*.nii*"), recursive=True),
                   key=os.path.getsize)
    if not masks:
        log("LesionLocator produced no output; using overlap fallback")
        return None
    return masks[-1]


def long_axis_of_instance(inst_arr, label, sp):
    """RECIST long-axis (mm) of one instance label in an instance array."""
    from skimage import measure
    from scipy import ndimage as ndi
    sx, sy, sz = sp
    m = (inst_arr == label)
    if not m.any():
        return 0.0, None, None
    objs = ndi.find_objects(m.astype(np.int32))
    slc = objs[0]; sub = m[slc]
    areas = sub.sum(axis=(1, 2)); lz = int(areas.argmax())
    try:
        rp = measure.regionprops(sub[lz].astype(np.uint8))[0]
        la = round(float(getattr(rp, "feret_diameter_max", 0) or 0) * sx, 1)
    except Exception:
        la = 0.0
    cz, cy, cx = ndi.center_of_mass(sub)
    centroid = [round((slc[2].start + cx) * sx, 1), round((slc[1].start + cy) * sy, 1),
                round((slc[0].start + lz) * sz, 1)]
    return la, int(slc[0].start + lz), centroid


def _overlap(a_mask, b_mask):
    inter = int(np.logical_and(a_mask, b_mask).sum())
    if inter == 0:
        return 0.0
    return inter / float(min(int(a_mask.sum()), int(b_mask.sum())) or 1)


def _save_mask_native(inst, ref_seg, native_ct_path, out_path):
    """Persist an instance mask resampled (nearest) onto the NATIVE CT grid, so Tier-2
    characterization crops image + mask in one consistent space. `inst` is a numpy array
    (then ref_seg gives its geometry) or a SimpleITK image."""
    import SimpleITK as sitk
    if isinstance(inst, sitk.Image):
        m = inst
    else:
        m = sitk.GetImageFromArray(inst.astype('int16')); m.CopyInformation(ref_seg)
    ct = sitk.ReadImage(native_ct_path)
    res = sitk.Resample(m, ct, sitk.Transform(), sitk.sitkNearestNeighbor, 0, sitk.sitkInt16)
    sitk.WriteImage(res, out_path); return out_path


def analyze_interval(b_label, f_label, b_seg, f_seg, b_ct, f_ct, sp, wd, days, prefix=None):
    """One pairwise interval (B fixed -> F). Detect on both, track B->F, classify, RECIST.
    When `prefix` is given, persists per-lesion masks (native-CT space) + the locked CTs so
    Tier-2 (`biofs imaging characterize`) can consume real masks per candidate."""
    import SimpleITK as sitk
    b_les, b_inst = detect_lesions(b_seg, TUMOR_USED, sp)
    f_les, f_inst = detect_lesions(f_seg, TUMOR_USED, sp)
    log(f"interval {b_label}->{f_label}: {len(b_les)} baseline / {len(f_les)} follow-up candidate lesion(s)")

    # track baseline lesions into the follow-up with LesionLocator (prev_mask prompt)
    tracker = "LesionLocator"; tracked_inst = None; tracked_path = None
    if b_les:
        b_mask_path = write_instance_mask(b_inst, b_seg, os.path.join(wd, f"{b_label}_inst.nii.gz"))
        tracked_path = lesionlocator_track(b_ct, f_ct, b_mask_path,
                                           os.path.join(wd, f"track_{b_label}_{f_label}"))
        if tracked_path:
            try:
                tracked_inst = sitk.GetArrayFromImage(sitk.ReadImage(tracked_path))
            except Exception as e:
                log(f"could not read tracked mask: {e}"); tracked_inst = None
    if tracked_inst is None:
        tracker = "overlap_fallback"

    findings = []
    matched_f = set()
    # fate of each baseline lesion
    for bl in b_les:
        f_la = None; f_slice = None; f_centroid = None; matched = None
        if tracker == "LesionLocator" and tracked_inst is not None:
            f_la, f_slice, f_centroid = long_axis_of_instance(tracked_inst, bl["inst"], sp)
            if f_la and f_la > 0:
                # find the follow-up detection this tracked mask overlaps (to mark it matched)
                tm = (tracked_inst == bl["inst"])
                for fl in f_les:
                    if fl["inst"] not in matched_f and _overlap(tm, fl["mask"]) > 0.1:
                        matched = fl; matched_f.add(fl["inst"]); break
        else:
            # overlap fallback: match baseline lesion to best-overlapping follow-up detection
            best = None; bestov = 0.0
            for fl in f_les:
                if fl["inst"] in matched_f:
                    continue
                ov = _overlap(bl["mask"], fl["mask"])
                if ov > bestov:
                    bestov, best = ov, fl
            if best and bestov > 0.1:
                matched = best; matched_f.add(best["inst"]); f_la = best["long_axis_mm"]
                f_slice = best["slice_index"]; f_centroid = best["centroid_mm"]
        b_la = bl["long_axis_mm"]
        if not f_la or f_la <= 0:
            status = "resolved"; change = (-b_la if b_la else 0.0)
        else:
            change = round(f_la - b_la, 1)
            if b_la > 0 and f_la >= b_la * (1 + ENLARGE_FRAC):
                status = "enlarged"
            elif b_la > 0 and f_la <= b_la * (1 - ENLARGE_FRAC):
                status = "shrunk"
            else:
                status = "stable"
        # Tier-2 mask linkage: where this candidate's followup mask lives
        if matched is not None:
            fu_inst = matched["inst"]; fu_src = "detect"
        elif f_la and f_la > 0:
            fu_inst = bl["inst"]; fu_src = "tracked"     # in tracked_inst, keyed by baseline label
        else:
            fu_inst = None; fu_src = None
        findings.append({
            "organ": bl["organ"], "tumor_class": bl["tumor_class"], "status": status,
            "baseline_long_axis_mm": b_la, "followup_long_axis_mm": (f_la if f_la else 0.0),
            "long_axis_change_mm": change, "measurable": bl["measurable"],
            "centroid_mm": (f_centroid or bl["centroid_mm"]),
            "slice_index": (f_slice if f_slice is not None else bl["slice_index"]),
            "new_lesion": False, "solidity": bl["solidity"],
            "interval": f"{b_label}_{f_label}", "baseline_inst": bl["inst"],
            "followup_inst": fu_inst, "followup_src": fu_src,
        })
    # NEW lesions = follow-up detections not corresponded to any baseline lesion
    for fl in f_les:
        if fl["inst"] in matched_f:
            continue
        findings.append({
            "organ": fl["organ"], "tumor_class": fl["tumor_class"], "status": "new",
            "baseline_long_axis_mm": 0.0, "followup_long_axis_mm": fl["long_axis_mm"],
            "long_axis_change_mm": fl["long_axis_mm"], "measurable": fl["measurable"],
            "centroid_mm": fl["centroid_mm"], "slice_index": fl["slice_index"],
            "new_lesion": True, "solidity": fl["solidity"],
            "interval": f"{b_label}_{f_label}", "baseline_inst": None,
            "followup_inst": fl["inst"], "followup_src": "detect",
        })

    # rank by actionability: new > enlarged > shrunk/resolved > stable, then by size
    rank = {"new": 0, "enlarged": 1, "shrunk": 2, "resolved": 2, "stable": 3}
    findings.sort(key=lambda x: (rank.get(x["status"], 4), -max(x["followup_long_axis_mm"], x["baseline_long_axis_mm"])))
    for i, fnd in enumerate(findings):
        fnd["actionability_rank"] = i + 1

    # persist per-lesion masks (native-CT space) + the native CTs for Tier-2 characterization
    if prefix:
        iid = f"{b_label}_{f_label}"
        try:
            _save_mask_native(b_inst, b_seg, b_ct, os.path.join(wd, f"char_{iid}_b_inst.nii.gz"))
            _save_mask_native(f_inst, f_seg, f_ct, os.path.join(wd, f"char_{iid}_f_inst.nii.gz"))
            V3.sh(["gcloud", "storage", "cp", b_ct, f"{prefix}/char_{iid}_b_ct.nii.gz"])
            V3.sh(["gcloud", "storage", "cp", f_ct, f"{prefix}/char_{iid}_f_ct.nii.gz"])
            V3.sh(["gcloud", "storage", "cp", os.path.join(wd, f"char_{iid}_b_inst.nii.gz"), f"{prefix}/char_{iid}_b_inst.nii.gz"])
            V3.sh(["gcloud", "storage", "cp", os.path.join(wd, f"char_{iid}_f_inst.nii.gz"), f"{prefix}/char_{iid}_f_inst.nii.gz"])
            if tracked_path:
                _save_mask_native(sitk.ReadImage(tracked_path), None, f_ct, os.path.join(wd, f"char_{iid}_tracked_inst.nii.gz"))
                V3.sh(["gcloud", "storage", "cp", os.path.join(wd, f"char_{iid}_tracked_inst.nii.gz"), f"{prefix}/char_{iid}_tracked_inst.nii.gz"])
            log(f"saved Tier-2 masks for interval {iid}")
        except Exception as e:
            log(f"WARN Tier-2 mask save failed for {iid}: {e}")
    return findings, tracker, len(b_les), len(f_les)


def recist_for_interval(findings, reg_reliable, phase_match, treatment):
    """RECIST 1.1 response on long-axis SLD for one interval (kept, re-powered by the
    tracking). Diameter-based, no volume, no VDT. Category ALWAYS emitted with a graded
    confidence + factors, NEVER withheld (per the report-not-withhold rule)."""
    targets = sorted([f for f in findings if f["measurable"] and f["baseline_long_axis_mm"] > 0
                      and not f["new_lesion"]],
                     key=lambda f: -f["baseline_long_axis_mm"])
    sel = []; per_organ = {}
    for f in targets:
        o = f["organ"]
        if len(sel) >= 5 or per_organ.get(o, 0) >= 2:
            continue
        sel.append(f); per_organ[o] = per_organ.get(o, 0) + 1
    base_sld = round(sum(f["baseline_long_axis_mm"] for f in sel), 1)
    foll_sld = round(sum(f["followup_long_axis_mm"] for f in sel), 1)
    new_meas = [f for f in findings if f["new_lesion"] and f["measurable"]]
    pct = (round(100 * (foll_sld - base_sld) / base_sld, 1) if base_sld else None)
    basis = []
    if sel and foll_sld == 0:
        category = "CR"; basis.append("all target lesions absent on the follow-up scan")
    elif new_meas:
        category = "PD"; basis.append(f"{len(new_meas)} new measurable lesion(s)")
    elif base_sld and pct is not None and pct <= -30:
        category = "PR"; basis.append(f"target SLD decreased {pct}% vs baseline")
    elif base_sld and pct is not None and pct >= 20:
        category = "PD"; basis.append(f"target SLD increased {pct}% vs baseline")
    elif sel:
        category = "SD"; basis.append("neither PR nor PD thresholds met")
    else:
        category = "no-target"; basis.append("no measurable target lesion identified by automated detection")
    # graded confidence, REPORTED not withheld
    factors = []
    if not reg_reliable:
        factors.append("rigid registration weak for this interval; verify the lesion is the same locus")
    if not phase_match:
        factors.append("contrast phases differ across the interval; conspicuity not directly comparable")
    if treatment not in ("naive", "treatment_naive", "untreated"):
        factors.append(f"treatment context '{treatment}': a treated lesion can shrink without true clearance, "
                       "weigh a disappearance accordingly")
    confidence = "high" if not factors else ("moderate" if len(factors) == 1 else "low")
    return {"category": category, "confidence": confidence, "confidence_factors": factors,
            "basis": basis, "baseline_sld_mm": base_sld, "followup_sld_mm": foll_sld,
            "pct_change_vs_baseline": pct, "target_lesion_count": len(sel),
            "radiologist_confirmation": "recommended (decision-support, confirm against source images)",
            "recist_cite": "RECIST 1.1 (Eisenhauer EJC 2009)"}


TUMOR_USED = []     # set in main() to the VISTA-3D classes actually accepted


def main():
    global TUMOR_USED
    wallet = os.environ["WALLET"]; job = os.environ["JOB_ID"]
    treatment = os.getenv("TREATMENT_CONTEXT", "unknown").lower()
    tps = json.loads(os.environ["TIMEPOINTS"])            # oldest -> newest
    src = os.getenv("IMAGING_BUCKET", "genobank-health-imaging")
    out_bucket = os.getenv("OUTPUT_BUCKET", "genobank-health-imaging")
    prefix = f"gs://{out_bucket}/{wallet}/imaging-findings/{job}"
    wd = tempfile.mkdtemp(prefix="find_"); t0 = time.time()
    if len(tps) < 2:
        print("FINDINGS_RESULT " + json.dumps({"status": "error", "error": ">=2 timepoints required"})); sys.exit(2)
    try:
        import torch, SimpleITK as sitk
        from huggingface_hub import snapshot_download
        repo = snapshot_download("MONAI/VISTA3D-HF"); sys.path.insert(0, repo)
        from hugging_face_pipeline import HuggingFacePipelineHelper

        labels = [t["label"] for t in tps]
        log(f"=== findings {job}: pairwise baseline-forward {labels} treatment={treatment} ===")
        # stage + nifti + date + phase per timepoint
        cts, dcmdirs, dates, phases = [], [], [], []
        for t in tps:
            d = V3.stage_series(src, wallet, t["study"], t["series"], os.path.join(wd, t["label"]))
            dcmdirs.append(d)
            cts.append(V3.dcm_to_nifti(d, os.path.join(wd, t["label"] + ".nii.gz")))
            dates.append(study_date(d)); phases.append(V3.detect_phase(d).get("phase", "unknown"))
        day0 = dates[0] if dates[0] else None
        day_offsets = [((dt - day0).days if (dt and day0) else i) for i, dt in enumerate(dates)]

        helper = HuggingFacePipelineHelper("vista3d")
        pipeline = helper.init_pipeline(os.path.join(repo, "vista3d_pretrained_model"),
                                        device=torch.device("cuda:0"))
        V3.PROMPT_TIERS = TUMOR_TIERS    # auto tumor-class detection with undefined-label fallback

        # detect on every timepoint once (lock the accepted prompt on the newest, reuse it)
        segs = [None] * len(tps); used_prompt = None; sp = None
        for idx in reversed(range(len(tps))):
            seg, segf, up = V3.segment(pipeline, cts[idx], os.path.join(wd, f"seg{idx}"), prompt=used_prompt)
            if used_prompt is None:
                used_prompt = up
            if sp is None:
                sp = seg.GetSpacing()
            segs[idx] = seg
            log(f"detected on {labels[idx]} (prompt {used_prompt})")
        TUMOR_USED = [c for c in (used_prompt or []) if c in TUMOR_NAME]
        dropped = [TUMOR_NAME.get(c, str(c)) for c in TUMOR_TIERS[0] if c in TUMOR_NAME and c not in TUMOR_USED]
        detected_classes = [TUMOR_NAME.get(c, str(c)) for c in TUMOR_USED]

        intervals = []
        for k in range(len(tps) - 1):
            b, f = k, k + 1
            warped, _, dice = rigid_lock(cts[b], cts[f], os.path.join(wd, f"{labels[f]}_in_{labels[b]}.nii.gz"))
            reg_reliable = dice >= 0.5
            phase_match = (phases[b] == phases[f]) and phases[b] != "unknown"
            findings, tracker, nb, nf = analyze_interval(
                labels[b], labels[f], segs[b], segs[f], cts[b], cts[f], sp, wd, day_offsets, prefix=prefix)
            recist = recist_for_interval(findings, reg_reliable, phase_match, treatment)
            # publish the locked pair for the blink/diff viewer
            V3.sh(["gcloud", "storage", "cp", cts[b], f"{prefix}/{labels[b]}_{labels[f]}_baseline.nii.gz"])
            V3.sh(["gcloud", "storage", "cp", warped, f"{prefix}/{labels[b]}_{labels[f]}_followup_locked.nii.gz"])
            for fnd in findings:
                fnd.pop("mask", None)
            n_new = sum(1 for x in findings if x["status"] == "new")
            n_enl = sum(1 for x in findings if x["status"] == "enlarged")
            intervals.append({
                "baseline_label": labels[b], "followup_label": labels[f],
                "baseline_day_offset": day_offsets[b], "followup_day_offset": day_offsets[f],
                "registration": {"model": "rigid 6-DOF Mattes-MI", "bone_dice": dice, "reliable": reg_reliable},
                "contrast_phase": {"baseline": phases[b], "followup": phases[f], "matched": phase_match},
                "tracker": tracker,
                "n_baseline_lesions": nb, "n_followup_lesions": nf,
                "findings": findings,
                "recist_response": recist,
                "summary": (f"{n_new} new, {n_enl} enlarging finding(s) {labels[b]} -> {labels[f]}; "
                            f"RECIST {recist['category']} ({recist['confidence']} confidence). "
                            "Candidates for radiologist confirmation."),
            })

        result = {
            "schema": "imaging-findings/1", "kind": "longitudinal pathogenic-findings read (no volumes)",
            "job_id": job, "wallet": wallet, "treatment_context": treatment,
            "registration_scheme": "rigid 6-DOF, pairwise baseline-forward (each interval locks on the earlier scan)",
            "detector": "MONAI VISTA-3D auto tumor-class (He 2024); zero-shot automatic",
            "tracker": "LesionLocator prev_mask propagation (Rokuss CVPR 2025), overlap fallback if unavailable",
            "detected_classes": detected_classes, "dropped_classes": dropped,
            "studies": [{"label": labels[i], "study_uid": tps[i]["study"], "day_offset": day_offsets[i],
                         "contrast_phase": phases[i]} for i in range(len(tps))],
            "intervals": intervals,
            "limitations": [
                "Detection is bounded to VISTA-3D's tumor classes (pancreatic / hepatic / lung in this build) and "
                "has NO lymph-node class. A lesion outside those classes, or one the model misses, is NOT represented; "
                "absence of a finding does NOT exclude disease and is not a comprehensive rule-out.",
                "Every finding and RECIST category is a model-proposed CANDIDATE requiring radiologist confirmation "
                "against the source images and the prior report.",
                "RECIST response is computed on automated long-axis diameters, not reader-selected target lesions; "
                "treat the category as decision-support, not a final read.",
                "Rigid registration can be imperfect; a flagged 'new' finding must be visually confirmed against the "
                "locked blink/diff to exclude a registration artifact.",
            ],
            "disclaimer": "DECISION-SUPPORT, NOT A DIAGNOSIS. Automated longitudinal change analysis. Every candidate "
                          "finding must be confirmed by a qualified radiologist. It does not establish, exclude, or "
                          "stage any disease.",
            "elapsed_sec": round(time.time() - t0, 1),
        }
        outp = os.path.join(wd, "findings.json"); open(outp, "w").write(json.dumps(result, indent=2))
        V3.sh(["gcloud", "storage", "cp", outp, f"{prefix}/findings.json"])
        result["output_gcs"] = f"{prefix}/findings.json"
        log(f"DONE: {len(intervals)} interval(s) -> {prefix}/findings.json")
        print("FINDINGS_RESULT " + json.dumps({k: result[k] for k in
              ("schema", "job_id", "detector", "tracker", "detected_classes", "dropped_classes",
               "studies", "output_gcs", "elapsed_sec")} |
              {"interval_summaries": [iv["summary"] for iv in intervals]}))
    except Exception as e:
        log("ERROR", e); traceback.print_exc()
        print("FINDINGS_RESULT " + json.dumps({"status": "error", "error": str(e)[:300], "job_id": job}))
        sys.exit(1)


if __name__ == "__main__":
    main()
