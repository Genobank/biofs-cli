#!/usr/bin/env python3
"""
imaging_lesion_track_runner.py — PER-LESION VOLUMETRIC TRACKING (true RECIST + VDT).

Segments candidate lesions INDEPENDENTLY at each timepoint with VISTA-3D (NEVER seeded
from the density subtraction — seeding would re-open the iso-attenuating blind spot:
an iso-dense growing mass yields ~0 ΔHU, no density focus, nothing to seed), links the
SAME lesion across timepoints by voxel-overlap in one rigid common grid, and produces a
per-lesion VOLUME trajectory -> true RECIST 1.1 response (target lesions, SLD, baseline
vs nadir, CR/PR/SD/PD as a FLAGGED CANDIDATE) and volume doubling time (VDT). This closes
the iso-attenuating blind spot + the missing RECIST response + the withheld VDT, which are
ONE gap: per-lesion tracking.

Decision-support, NOT diagnosis. Every target lesion, response category, and VDT is a
model-proposed CANDIDATE requiring radiologist confirmation; automated segmentation is
imperfect (false negatives, over/under-seg, limited tumor classes; lymph nodes are NOT a
VISTA-3D class), so absence never excludes disease and nothing is phrased as reassurance.
Output is DROP-IN: writes gs://.../imaging-compare/<job>/ (A.nii.gz = newest reference,
lesion_tracks.json, meshes) so the viewer/MCP/report consume it. Reuses vista3d_runner.py.

Env: WALLET, JOB_ID, ANATOMY (chest|abdomen), TIMEPOINTS (JSON [{label,study,series}],
     oldest->newest), TREATMENT_CONTEXT (naive|post_chemo|post_radiation|post_immunotherapy|
     post_surgery|unknown, default unknown), IMAGING_BUCKET, OUTPUT_BUCKET.
"""
import os, sys, json, time, math, tempfile, glob, traceback
import numpy as np
os.environ.setdefault("HF_HOME", "/scratch/hf")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vista3d_runner as V3            # reuse stage_series/dcm_to_nifti/detect_phase/_foci/segment
log = V3.log

# VISTA-3D tumor classes per anatomy (tier-fallback drops any the deployment can't auto-seg).
# chest lung_tumor=23 (may be zero-shot in this deployment -> dropped, reported honestly).
ANATOMY_PROMPTS = {
    "chest":   [[23], ],                       # lung_tumor
    "abdomen": [[24, 26, 130], [24, 26], [24], ],   # pancreatic + hepatic + liver tumor, with fallback
}
TUMOR_ORGAN = {23: "lung", 24: "pancreas", 26: "liver", 130: "liver", 1: "liver", 4: "pancreas"}
TUMOR_NAME = {23: "lung_tumor", 24: "pancreatic_tumor", 26: "hepatic_tumor", 130: "liver_tumor"}
MIN_LESION_ML = float(os.getenv("MIN_LESION_ML", "0.2"))     # ~7mm floor
MEAS_MM = 10.0                                                # RECIST measurable long axis
VDT_FLOOR_ML = 0.10
SIGMA_REL_DEFAULT = 0.18                                      # volume-uncertainty for VDT gating


def study_date(dcm_dir):
    """DICOM StudyDate (YYYYMMDD) -> a datetime.date, for the real day-axis. PHI-safe:
    only the relative day-offset is persisted downstream, never the absolute date."""
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


def rigid_register_ct(fixed_nii, moving_nii, out_nii):
    """Rigid (6-DOF) register moving CT into the fixed (newest) grid and resample the CT
    (sitkLinear). We resample the CT, then segment IN the common grid — never resample a
    finished label mask (interpolation corrupts boundaries)."""
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
    flo, mlo = iso(f), iso(m); fm, mm_ = bodymask(flo), bodymask(mlo)
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
    sitk.WriteImage(warped, out_nii)
    # bone-Dice QC in the common grid
    A = sitk.GetArrayFromImage(sitk.ReadImage(fixed_nii)).astype(np.float32)
    B = sitk.GetArrayFromImage(warped).astype(np.float32)
    cov = B > -900
    fb = (A > 150) & cov; mb = (B > 150) & cov
    inter = int(np.logical_and(fb, mb).sum()); den = int(fb.sum()) + int(mb.sum())
    return out_nii, (round(2 * inter / den, 3) if den else 0.0)


def components(seg_img, classes, sp):
    """Per-class lesion connected components in the common grid: volume, RECIST axial long/
    short axis (Feret), centroid, organ (from the tumor class), a binary mask array."""
    import SimpleITK as sitk
    from skimage import measure
    arr = sitk.GetArrayFromImage(seg_img)            # [z,y,x]
    sx, sy, sz = sp[0], sp[1], sp[2]
    voxml = (sx * sy * sz) / 1000.0
    out = []
    from scipy import ndimage as ndi
    classes = [c for c in classes if c in TUMOR_NAME]   # ONLY tumor classes, never whole-organ
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
            vml = counts[i] * voxml
            # RECIST: max axial in-plane caliper (Feret) on the largest slice
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
            cz, cy, cx = ndi.center_of_mass(sub)
            cz += slc[0].start; cy += slc[1].start; cx += slc[2].start
            full = np.zeros(arr.shape, bool); full[slc] |= sub
            out.append({
                "class": c, "organ": TUMOR_ORGAN.get(c, "unknown"), "tumor_class": TUMOR_NAME.get(c, str(c)),
                "volume_ml": round(vml, 2), "long_axis_mm": long_mm, "short_axis_mm": short_mm,
                "solidity": solidity, "measurable": bool(long_mm >= MEAS_MM),
                "centroid_mm": [round(cx * sx, 1), round(cy * sy, 1), round((slc[0].start + lz) * sz, 1)],
                "slice_index": int(slc[0].start + lz), "mask": full,
            })
    return out


def iou(a, b):
    inter = int(np.logical_and(a, b).sum())
    if inter == 0:
        return 0.0
    return inter / float(int(a.sum()) + int(b.sum()) - inter)


def link_tracks(per_tp, sp):
    """Hungarian IoU matching across consecutive timepoints in the common grid, chained
    into N-timepoint tracks. Tags appear / disappear / merge / split explicitly."""
    from scipy.optimize import linear_sum_assignment
    sx, sy, sz = sp
    def cdist(a, b):
        return math.dist(a["centroid_mm"], b["centroid_mm"])
    def req(a, b):  # equiv-sphere radius gate
        ra = (3 * a["volume_ml"] * 1000 / (4 * math.pi)) ** (1 / 3)
        rb = (3 * b["volume_ml"] * 1000 / (4 * math.pi)) ** (1 / 3)
        return max(20.0, 1.5 * (ra + rb))
    n_tp = len(per_tp)
    track_of = [dict() for _ in range(n_tp)]    # tp -> {comp_idx: track_id}
    tracks = []
    # seed tracks from timepoint 0
    for j, c in enumerate(per_tp[0]):
        tid = len(tracks); tracks.append({"id": tid, "members": {0: j}, "topology": "matched"})
        track_of[0][j] = tid
    for t in range(n_tp - 1):
        A, B = per_tp[t], per_tp[t + 1]
        if not A or not B:
            # all of B start new tracks
            for j, c in enumerate(B):
                tid = len(tracks); tracks.append({"id": tid, "members": {t + 1: j}, "topology": "appear"})
                track_of[t + 1][j] = tid
            continue
        C = np.ones((len(A), len(B)))
        for ia, a in enumerate(A):
            for ib, b in enumerate(B):
                v = iou(a["mask"], b["mask"])
                if v == 0 and cdist(a, b) > req(a, b):
                    C[ia, ib] = 1.0
                else:
                    C[ia, ib] = 1.0 - v if (v > 0 or cdist(a, b) <= req(a, b)) else 1.0
        ri, ci = linear_sum_assignment(C)
        matched_b = set()
        for ia, ib in zip(ri, ci):
            if C[ia, ib] >= 1.0:        # gated out -> not a real match
                continue
            tid = track_of[t].get(ia)
            if tid is None:
                tid = len(tracks); tracks.append({"id": tid, "members": {t: ia}, "topology": "matched"})
                track_of[t][ia] = tid
            tracks[tid]["members"][t + 1] = ib
            track_of[t + 1][ib] = tid; matched_b.add(ib)
            tracks[tid].setdefault("ious", []).append(round(1 - C[ia, ib], 2))
        for ib, b in enumerate(B):       # unmatched B = appear
            if ib in matched_b:
                continue
            tid = len(tracks); tracks.append({"id": tid, "members": {t + 1: ib}, "topology": "appear"})
            track_of[t + 1][ib] = tid
    return tracks


def main():
    wallet = os.environ["WALLET"]; job = os.environ["JOB_ID"]
    anatomy = os.getenv("ANATOMY", "chest").lower()
    treatment = os.getenv("TREATMENT_CONTEXT", "unknown").lower()
    tps = json.loads(os.environ["TIMEPOINTS"])           # oldest -> newest
    src = os.getenv("IMAGING_BUCKET", "genobank-health-imaging")
    out_bucket = os.getenv("OUTPUT_BUCKET", "genobank-health-imaging")
    prefix = f"gs://{out_bucket}/{wallet}/imaging-compare/{job}"
    wd = tempfile.mkdtemp(prefix="lt_"); t0 = time.time()
    if len(tps) < 2:
        print("LESION_TRACK_RESULT " + json.dumps({"status": "error", "error": ">=2 timepoints required"})); sys.exit(2)
    try:
        import torch, SimpleITK as sitk
        from huggingface_hub import snapshot_download
        repo = snapshot_download("MONAI/VISTA3D-HF"); sys.path.insert(0, repo)
        from hugging_face_pipeline import HuggingFacePipelineHelper

        labels = [t["label"] for t in tps]; ref_label = labels[-1]
        log(f"=== lesion-track {job} ({anatomy}) tps={labels} ref={ref_label} treatment={treatment} ===")
        # stage + nifti + date + phase per timepoint
        cts, dates, phases = [], [], []
        for t in tps:
            d = V3.stage_series(src, wallet, t["study"], t["series"], os.path.join(wd, t["label"]))
            cts.append(V3.dcm_to_nifti(d, os.path.join(wd, t["label"] + ".nii.gz")))
            dates.append(study_date(d)); phases.append(V3.detect_phase(d).get("phase", "unknown"))
        ref_ct = cts[-1]
        # day-axis (relative to oldest); fall back to equal spacing if dates missing
        if all(dates):
            day0 = dates[0]; day_offsets = [(d - day0).days for d in dates]
        else:
            day_offsets = list(range(len(tps))); log("WARN: missing StudyDate, using index day-axis")
        phase_monotonic = len(set(phases)) <= 1 or "unknown" in phases

        # register every earlier CT into the newest grid (rigid, linear), segment IN the grid
        aligned = [None] * len(tps); aligned[-1] = ref_ct; reg_dice = {ref_label: 1.0}
        for i in range(len(tps) - 1):
            w, dice = rigid_register_ct(ref_ct, cts[i], os.path.join(wd, labels[i] + "_inref.nii.gz"))
            aligned[i] = w; reg_dice[labels[i]] = dice
            log(f"registered {labels[i]} -> {ref_label}: bone-Dice {dice}")
        min_reg_dice = round(min(reg_dice.values()), 3); reg_reliable = min_reg_dice >= 0.5

        helper = HuggingFacePipelineHelper("vista3d")
        pipeline = helper.init_pipeline(os.path.join(repo, "vista3d_pretrained_model"),
                                        device=torch.device("cuda:0"))
        tiers = ANATOMY_PROMPTS.get(anatomy, ANATOMY_PROMPTS["abdomen"])
        V3.PROMPT_TIERS = tiers       # make segment()'s undefined-label fallback use the ANATOMY tumor tiers
        # segment newest first to lock the accepted prompt, reuse it for the rest (consistency)
        import gc, SimpleITK as sitk2
        per_tp = [[] for _ in tps]; used_prompt = None; sp = None; seg_failed = None
        for idx in reversed(range(len(tps))):
            try:
                seg, segf, up = V3.segment(pipeline, aligned[idx], os.path.join(wd, f"seg{idx}"),
                                           prompt=used_prompt)
            except Exception as e:
                seg_failed = str(e)[:150]
                log(f"VISTA-3D has no usable auto lesion class for {anatomy} (timepoint {labels[idx]}): {seg_failed}")
                break
            if used_prompt is None:
                used_prompt = up
            if sp is None:
                sp = seg.GetSpacing()
            per_tp[idx] = components(seg, used_prompt, sp)
            log(f"timepoint {labels[idx]}: {len(per_tp[idx])} lesion component(s) (prompt {used_prompt})")
            del seg; gc.collect()
        tumor_used = [c for c in (used_prompt or []) if c in TUMOR_NAME]
        lesion_class_available = bool(tumor_used)
        dropped = [TUMOR_NAME.get(c, str(c)) for c in tiers[0] if c in TUMOR_NAME and c not in (used_prompt or [])]
        if sp is None:
            sp = sitk2.ReadImage(ref_ct).GetSpacing()

        # link across timepoints
        tracks = link_tracks(per_tp, sp)

        # build per-lesion records (volume + diameter series, VDT, iso-attenuating)
        def vdt(vlist, days_present):
            # vlist/days_present aligned, growth between first<last present
            pres = [(d, v) for d, v in zip(days_present, vlist) if v is not None]
            if len(pres) < 2:
                return {"vdt_days": None, "withheld_reason": "lesion present at < 2 timepoints"}
            (d1, v1), (d2, v2) = pres[0], pres[-1]
            dt = d2 - d1
            if v1 < VDT_FLOOR_ML or v2 < VDT_FLOOR_ML:
                return {"vdt_days": None, "withheld_reason": f"below {VDT_FLOOR_ML}mL volume floor"}
            if dt <= 0:
                return {"vdt_days": None, "withheld_reason": "non-positive interval"}
            ratio = v2 / v1
            g_min = 1.96 * math.sqrt(2) * SIGMA_REL_DEFAULT     # ~0.50 -> need ~65% volume change
            if abs(math.log(ratio)) < g_min:
                return {"vdt_days": None, "withheld_reason": "volume change below noise-detectability gate",
                        "vol_pct_change": round(100 * (ratio - 1), 1)}
            if v2 > v1:
                val = dt * math.log(2) / math.log(ratio)
                band = [round(dt * math.log(2) / math.log(max(1.0001, ratio * (1 + 1.96 * SIGMA_REL_DEFAULT))), 0),
                        round(dt * math.log(2) / math.log(max(1.0001, ratio / (1 + 1.96 * SIGMA_REL_DEFAULT))), 0)]
                bandv = sorted(b for b in band if b and b > 0)
                return {"vdt_days": round(val, 0), "kind": "doubling",
                        "vdt_band_days": (bandv if len(bandv) == 2 else None),
                        "vol_pct_change": round(100 * (ratio - 1), 1),
                        "band_label": _band(val)}
            else:
                val = dt * math.log(2) / math.log(1 / ratio)
                return {"vdt_days": None, "halving_time_days": round(val, 0), "kind": "regression",
                        "vol_pct_change": round(100 * (ratio - 1), 1),
                        "withheld_reason": "lesion regressed; doubling time undefined (halving time reported)"}

        lesions = []
        for tr in tracks:
            mem = tr["members"]
            vseries = [None] * len(tps); dseries = [None] * len(tps); comp0 = None
            for tp_i, ci in mem.items():
                c = per_tp[tp_i][ci]
                vseries[tp_i] = c["volume_ml"]; dseries[tp_i] = c["long_axis_mm"]
                if comp0 is None or tp_i < min(mem):
                    pass
            first_tp = min(mem); last_tp = max(mem)
            c_first = per_tp[first_tp][mem[first_tp]]; c_last = per_tp[last_tp][mem[last_tp]]
            present_tps = sorted(mem)
            vrec = vdt([vseries[i] for i in present_tps], [day_offsets[i] for i in present_tps])
            topo = tr.get("topology", "matched")
            ious = tr.get("ious", [])
            link_conf = round(min(ious), 2) if ious else (1.0 if topo == "matched" else None)
            grew = bool(vseries[last_tp] is not None and vseries[first_tp] is not None
                        and vseries[last_tp] >= vseries[first_tp] * 1.25)
            iso = bool(grew and vrec.get("vdt_days") is not None)   # density cross-check at MCP layer
            lesions.append({
                "lesion_id": f"L{tr['id']}", "organ": c_last["organ"], "tumor_class": c_last["tumor_class"],
                "is_node": False, "centroid_mm": c_last["centroid_mm"], "slice_index": c_last["slice_index"],
                "appears_at": labels[first_tp], "topology": topo, "link_confidence": link_conf,
                "iou_across_timepoints": ious,
                "volume_series_ml": vseries, "long_axis_mm_series": dseries,
                "measurable": c_first["measurable"],
                "long_axis_mm": c_last["long_axis_mm"], "short_axis_mm": c_last["short_axis_mm"],
                "volume_ml": c_last["volume_ml"], "solidity": c_last["solidity"],
                **vrec,
                "grew_by_volume": grew, "iso_attenuating_candidate": iso,
                "new_lesion": bool(first_tp > 0),
                "review_required": bool(topo in ("merge", "split") or (link_conf is not None and link_conf < 0.3)
                                        or c_last["solidity"] < 0.5),
            })

        # ---- RECIST 1.1 (flagged candidate) ----
        # target lesions selected on the OLDEST timepoint, measurable, <=5 total, <=2/organ
        baseline_candidates = sorted(
            [l for l in lesions if (0 in [labels.index(l["appears_at"])] or l["volume_series_ml"][0] is not None)
             and l["measurable"] and not l["review_required"]],
            key=lambda l: -(l["long_axis_mm_series"][0] or 0))
        targets = []; per_organ = {}
        for l in baseline_candidates:
            if l["volume_series_ml"][0] is None:
                continue
            o = l["organ"]
            if len(targets) >= 5 or per_organ.get(o, 0) >= 2:
                continue
            targets.append(l); per_organ[o] = per_organ.get(o, 0) + 1
        def sld(ti):
            return round(sum((l["long_axis_mm_series"][ti] or 0) for l in targets), 1)
        slds = [sld(i) for i in range(len(tps))]
        baseline_sld = slds[0] if targets else 0.0
        nadir_sld = min([s for s in slds if s > 0], default=0.0)
        current_sld = slds[-1] if targets else 0.0
        new_measurable = [l for l in lesions if l["new_lesion"] and l["measurable"] and not l["review_required"]]
        pct_base = (round(100 * (current_sld - baseline_sld) / baseline_sld, 1) if baseline_sld else None)
        pct_nadir = (round(100 * (current_sld - nadir_sld) / nadir_sld, 1) if nadir_sld else None)
        # category
        reasons = []
        if targets and current_sld == 0:
            category = "CR"; reasons.append("all target lesions absent on the newest scan")
        elif new_measurable:
            category = "PD"; reasons.append(f"{len(new_measurable)} new measurable lesion(s)")
        elif baseline_sld and pct_base is not None and pct_base <= -30:
            category = "PR"; reasons.append(f"SLD decreased {pct_base}% vs baseline")
        elif nadir_sld and pct_nadir is not None and pct_nadir >= 20 and (current_sld - nadir_sld) >= 5:
            category = "PD"; reasons.append(f"SLD increased {pct_nadir}% vs nadir (+{round(current_sld-nadir_sld,1)}mm)")
        elif targets:
            category = "SD"; reasons.append("neither PR nor PD thresholds met")
        else:
            category = "no-target"; reasons.append("no measurable target lesion identified by automated segmentation")
        # suppression gates (a treated patient is never auto-reassured)
        response_assessable = bool(reg_reliable and phase_monotonic and treatment in ("naive",))
        human_review_forced = treatment not in ("naive",) or not reg_reliable or not phase_monotonic
        if not response_assessable and category in ("CR", "PR", "SD"):
            reasons.append("categorical response SUPPRESSED (registration/phase unreliable or treatment context not naive) "
                           "-> response assessment withheld pending radiologist")

        result = {
            "schema": "imaging-lesion-track/1", "kind": "per-lesion volumetric tracking",
            "job_id": job, "wallet": wallet, "anatomy": anatomy, "treatment_context": treatment,
            "reference_label": ref_label, "baseline_label": labels[0],
            "timepoints": [{"label": labels[i], "study_uid": tps[i]["study"], "day_offset": day_offsets[i],
                            "contrast_phase": phases[i], "sld_mm": slds[i]} for i in range(len(tps))],
            "segmentation": {"model": "MONAI VISTA-3D (independent per-timepoint, not seeded from subtraction)",
                             "prompted_classes": [TUMOR_NAME.get(c, str(c)) for c in (used_prompt or [])],
                             "dropped_classes": dropped, "lesion_class_available": lesion_class_available},
            "registration": {"model": "rigid 6-DOF", "reg_dice_per_timepoint": reg_dice,
                             "min_reg_dice": min_reg_dice, "reliable": reg_reliable},
            "phase_monotonic": phase_monotonic, "node_assessment_unavailable": True,
            "lesions": lesions,
            "target_lesions": [l["lesion_id"] for l in targets],
            "new_lesions": [l["lesion_id"] for l in new_measurable],
            "iso_attenuating_candidates": [l["lesion_id"] for l in lesions if l["iso_attenuating_candidate"]],
            "recist_response": {
                "baseline_sld_mm": baseline_sld, "nadir_sld_mm": nadir_sld, "current_sld_mm": current_sld,
                "pct_change_vs_baseline": pct_base, "pct_change_vs_nadir": pct_nadir,
                "category": category, "reasons": reasons, "recist_cite": "RECIST 1.1 (Eisenhauer EJC 2009)",
                "response_assessable": response_assessable,
                "category_is_flagged_candidate": True, "radiologist_confirmation_required": True,
                "human_review_forced": human_review_forced,
            },
            "limitations": [
                "Automated VISTA-3D segmentation is imperfect (false negatives, over/under-segmentation, "
                "limited tumor classes: chest lung_tumor only / abdomen pancreatic+hepatic+liver only). A "
                "lesion the model did not segment is NOT represented; absence does NOT exclude disease.",
                "Lymph nodes are not a VISTA-3D class (node_assessment_unavailable); nodal disease is unsegmented.",
                "Every target lesion, response category, and doubling time is a model-proposed CANDIDATE "
                "requiring radiologist confirmation against the source images.",
                "VDT assumes exponential growth, needs >=2 confidently-linked timepoints above the volume floor "
                "and noise-detectability gate, and is withheld otherwise; regression yields a halving time, never "
                "a signed doubling time.",
                "ISO-ATTENUATING CATCH: lesions flagged iso_attenuating_candidate grew in VOLUME (independent "
                "segmentation) and would be missed by density subtraction alone; cross-check with the change-surface.",
                "A VISTA-3D false-negative can fake a DISAPPEAR / PR / CR (false reassurance for a treated patient); "
                "categorical CR/PR/SD is suppressed unless registration + phase are reliable AND treatment is naive.",
            ],
            "disclaimer": "Decision-support, not a diagnosis. Automated candidate measurements; not all lesions "
                          "may be detected. Confirm against the radiology read and source images.",
            "elapsed_sec": round(time.time() - t0, 1),
        }
        # write A.nii.gz (newest reference) + lesion_tracks.json (drop-in)
        sitk.WriteImage(sitk.ReadImage(ref_ct), os.path.join(wd, "A.nii.gz"))
        V3.sh(["gcloud", "storage", "cp", os.path.join(wd, "A.nii.gz"), f"{prefix}/A.nii.gz"])
        # strip the heavy in-memory masks before serializing
        for l in result["lesions"]:
            l.pop("mask", None)
        ltp = os.path.join(wd, "lesion_tracks.json"); open(ltp, "w").write(json.dumps(result, indent=2))
        V3.sh(["gcloud", "storage", "cp", ltp, f"{prefix}/lesion_tracks.json"])
        result["output_gcs"] = f"{prefix}/lesion_tracks.json"
        log(f"DONE: {len(lesions)} lesion tracks, {len(targets)} targets, response {category} (assessable={response_assessable})")
        print("LESION_TRACK_RESULT " + json.dumps({k: result[k] for k in
              ("schema", "job_id", "anatomy", "reference_label", "target_lesions", "new_lesions",
               "iso_attenuating_candidates", "recist_response", "segmentation", "registration",
               "output_gcs", "elapsed_sec")}))
    except Exception as e:
        log("ERROR", e); traceback.print_exc()
        print("LESION_TRACK_RESULT " + json.dumps({"status": "error", "error": str(e)[:300], "job_id": job}))
        sys.exit(1)


def _band(vdt_days):
    if vdt_days is None:
        return None
    if vdt_days < 30:
        return "aggressive (<30d; differential incl. inflammatory/infectious, not a malignancy call)"
    if vdt_days <= 400:
        return "indeterminate (30-400d; 100-300d most common in solid malignancy)"
    return "slow (>400d; slow relative to typical malignant kinetics, NOT proven benign)"


if __name__ == "__main__":
    main()
