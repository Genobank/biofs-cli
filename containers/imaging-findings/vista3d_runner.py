#!/usr/bin/env python3
"""
vista3d_runner.py - imaging-twin ENRICHMENT: post-Whipple recurrence-surveillance read.

Runs MONAI VISTA-3D (a CT segmentation foundation model) on BOTH the baseline and
the follow-up CT, prompting pancreas (4) + pancreatic-tumor (24) + liver (1) +
hepatic-tumor (26) + liver-tumor (130). Surfaces MODEL-PROPOSED CANDIDATE REGIONS
for a radiologist to confirm. This is decision-support, NOT a diagnosis, NOT lesion
detection, and NOT a recurrence call.

Honest by construction (grounded in an adversarial design+safety review):
 - VISTA-3D has NO lymph-node class (verified against its channel_def), so this tool
   does NOT fake nodal segmentation. Nodes are handled as an explicit manual-review
   station flag only.
 - Liver malignancy has TWO VISTA-3D class ids (26 "hepatic tumor" + 130 "liver
   tumor"); both are prompted and their masks unioned for recall.
 - It DETECTS each series' contrast phase from DICOM (not assumed). When the two
   timepoints are different phases (this pair: baseline PET/CT delayed vs follow-up
   portal-venous "Con"), liver-lesion interval change is NOT assessable from the pair
   (a hypovascular metastasis can appear/disappear/resize from conspicuity alone), so
   categorical new/growing/stable is SUPPRESSED and only per-timepoint candidate
   regions are listed.
 - Equivalent diameters use the correct mL->mm conversion (a 1.0 mL sphere is ~12.4
   mm, not 1.24 mm).
 - Sub-cm foci are flagged as below CT's reliable characterization floor.

Env: WALLET, BASELINE_STUDY, BASELINE_SERIES, FOLLOWUP_STUDY, FOLLOWUP_SERIES,
     TWIN_JOB_ID, IMAGING_BUCKET (default genobank-health-imaging),
     OUTPUT_BUCKET (default same), MIN_FOCUS_ML (default 0.1), MATCH unused.
The VISTA-3D weights cache under HF_HOME=/scratch/hf (mounted scratch) - one-time.

All derived artifacts are de-identified: wallet / case-label only, never a name, and
NO raw DICOM free-text (e.g. SeriesDescription) is persisted - only a classified
phase enum.
"""
import os, sys, json, time, math, subprocess, tempfile, glob, traceback
import numpy as np
os.environ.setdefault("HF_HOME", "/scratch/hf")

# VISTA-3D class ids (verified from MONAI/VISTA3D-HF metadata.json channel_def):
#   1 liver, 3 spleen, 4 pancreas, 10 gallbladder, 24 pancreatic tumor,
#   26 hepatic tumor, 130 liver tumor.  No lymph-node class exists.
VISTA_LABELS = {1: "liver", 3: "spleen", 4: "pancreas", 10: "gallbladder",
                24: "pancreatic_tumor", 26: "hepatic_tumor", 130: "liver_tumor"}
# VISTA-3D auto-segmentation (label_prompt) only covers its trained "supported" set;
# some tumor classes are zero-shot (need interactive POINT prompts we cannot supply) and
# the appended ids 128-132 ("liver tumor"=130) are absent from this deployment's auto set.
# So we try the richest prompt and progressively DROP labels VISTA-3D rejects as
# "Undefined label prompt", recording exactly what was dropped. Tiers, richest first:
PROMPT_TIERS = [
    [4, 24, 1, 26, 130],   # pancreas + pancreatic-tumor + liver + hepatic-tumor + liver-tumor
    [4, 24, 1, 26],        # drop the appended liver-tumor(130)
    [4, 24, 1],            # drop hepatic-tumor(26) too -> liver ORGAN only
    [4, 1],                # last resort: pancreas + liver organs (no tumor classes)
]
PROMPT = PROMPT_TIERS[0]
LIVER_TUMOR_CLASSES = [26, 130]       # union whichever survive in the used prompt
MIN_FOCUS_ML = float(os.getenv("MIN_FOCUS_ML", "0.1"))
MEAS_FLOOR_MM = 10.0                   # below this, CT cannot reliably characterize a hypovascular met

# PDAC regional drainage stations a radiologist should review (nodes are NOT segmented).
NODE_STATIONS = ["celiac (celiac-axis)",
                 "SMA / superior mesenteric (root of mesentery)",
                 "portacaval / porta hepatis",
                 "para-aortic (station 16)",
                 "aortocaval / interaortocaval"]


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}] [vista3d]", *a, flush=True)


def sh(cmd):
    log("$", " ".join(cmd))
    return subprocess.run(cmd, check=True)


def stage_series(bucket, wallet, study, series, dest):
    os.makedirs(dest, exist_ok=True)
    sh(["gcloud", "storage", "cp", "--recursive",
        f"gs://{bucket}/{wallet}/imaging/{study}/{series}/*", dest])
    n = len([f for f in os.listdir(dest) if f.endswith(".dcm")])
    log(f"staged {n} slices into {os.path.basename(dest)}")
    if n == 0:
        raise RuntimeError("no DICOM staged")
    return dest


def dcm_to_nifti(dcm_dir, out_nii):
    import SimpleITK as sitk
    r = sitk.ImageSeriesReader()
    ids = r.GetGDCMSeriesIDs(dcm_dir)
    if not ids:
        raise RuntimeError(f"no DICOM series found in {dcm_dir}")
    best = max(ids, key=lambda s: len(r.GetGDCMSeriesFileNames(dcm_dir, s)))
    r.SetFileNames(r.GetGDCMSeriesFileNames(dcm_dir, best))
    sitk.WriteImage(r.Execute(), out_nii)
    return out_nii


def detect_phase(dcm_dir):
    """Classify the contrast phase of a staged series from DICOM tags. Returns ONLY a
    classified enum + a had_contrast bool - the raw SeriesDescription (free text that
    could carry site/date/PHI) is NEVER returned or persisted."""
    try:
        import pydicom
    except Exception as e:
        log(f"pydicom unavailable for phase detection: {e}")
        return {"phase": "unknown", "had_contrast": None}
    files = sorted(glob.glob(os.path.join(dcm_dir, "*.dcm")))
    if not files:
        return {"phase": "unknown", "had_contrast": None}
    ds = None
    for cand in (files[len(files) // 2], files[0]):
        try:
            ds = pydicom.dcmread(cand, stop_before_pixels=True); break
        except Exception:
            continue
    if ds is None:
        return {"phase": "unknown", "had_contrast": None}
    desc = str(getattr(ds, "SeriesDescription", "") or "").lower()
    agent = str(getattr(ds, "ContrastBolusAgent", "") or "").strip()
    had_contrast = bool(agent) or ("con" in desc and "non" not in desc and "w/o" not in desc)
    phase = "unknown"
    if any(k in desc for k in ["delay", "equil", "15min", "10min", "5min", "3min"]):
        phase = "delayed"
    elif any(k in desc for k in ["portal", "venous", "pvp", "pv1", "pv2", " con", "con ", "w/con", "wcon", "+con"]):
        phase = "portal_venous"
    elif any(k in desc for k in ["arterial", "early art", "late art", "hap", "art "]):
        phase = "arterial"
    elif any(k in desc for k in ["non con", "noncon", "w/o con", "wo con", "unenhanced", "plain", " nc ", "non-con"]):
        phase = "non_contrast"
    elif had_contrast:
        phase = "contrast_unspecified"
    log(f"phase({os.path.basename(dcm_dir)}) -> {phase} (had_contrast={had_contrast})")
    return {"phase": phase, "had_contrast": had_contrast}


def _foci(m, classes):
    """Connected-component foci for one class id or a list (unioned). Returns foci >=
    MIN_FOCUS_ML with physical volume (mL), centroid (mm), and the CORRECT
    volume-equivalent sphere diameter (mm): a 1.0 mL sphere is ~12.4 mm.
    measurable=True only when equiv_diam_mm >= the CT characterization floor."""
    import SimpleITK as sitk
    if isinstance(classes, int):
        classes = [classes]
    bin_mask = None
    for c in classes:
        b = sitk.BinaryThreshold(m, c, c, 1, 0)
        bin_mask = b if bin_mask is None else sitk.Or(bin_mask, b)
    foci = []
    try:
        cc = sitk.ConnectedComponent(bin_mask)
        st = sitk.LabelShapeStatisticsImageFilter(); st.Execute(cc)
        for lbl in st.GetLabels():
            ml = st.GetPhysicalSize(lbl) / 1000.0          # mm^3 -> mL (cc)
            if ml >= MIN_FOCUS_ML:
                diam = 2.0 * (3.0 * ml * 1000.0 / (4.0 * math.pi)) ** (1.0 / 3.0)  # mL->mm^3 then sphere diam (mm)
                foci.append({"ml": round(ml, 3),
                             "equiv_diam_mm": round(diam, 1),
                             "centroid_mm": [round(x, 1) for x in st.GetCentroid(lbl)],
                             "measurable": bool(diam >= MEAS_FLOOR_MM)})
        foci.sort(key=lambda f: -f["ml"])
    except Exception as e:
        log(f"connected-component foci failed for {classes}: {e}")
    return foci


def segment(pipeline, ct_nii, outdir, prompt=None):
    """Run VISTA-3D, falling back through PROMPT_TIERS when a label is rejected as
    'Undefined label prompt' / zero-shot (so unsupported tumor classes never abort the
    run). Returns (mask, seg_path, used_prompt). When `prompt` is given, only that exact
    prompt is tried (used for the 2nd timepoint to keep both consistent)."""
    import SimpleITK as sitk
    tiers = [prompt] if prompt is not None else PROMPT_TIERS
    last_err = None
    for i, tier in enumerate(tiers):
        attempt = os.path.join(outdir, f"try{i}"); os.makedirs(attempt, exist_ok=True)
        try:
            pipeline([{"image": ct_nii, "label_prompt": list(tier)}], output_dir=attempt)
            segs = glob.glob(os.path.join(attempt, "**", "*.nii*"), recursive=True)
            if not segs:
                raise RuntimeError("VISTA-3D produced no segmentation output")
            segf = sorted(segs, key=lambda f: os.path.getsize(f))[-1]
            log(f"VISTA-3D segmented with prompt {list(tier)}")
            return sitk.ReadImage(segf), segf, list(tier)
        except Exception as e:
            last_err = e; msg = str(e)
            if any(k in msg.lower() for k in ("undefined label", "zero-shot", "point prompt")):
                log(f"prompt {list(tier)} rejected ({msg[:70]}); trying a reduced tier")
                continue
            raise
    raise last_err or RuntimeError("all VISTA-3D prompt tiers failed")


def volumes(m):
    import SimpleITK as sitk
    a = sitk.GetArrayFromImage(m); sp = m.GetSpacing(); vox = float(np.prod(sp)) / 1000.0
    out = {}
    for lab, name in VISTA_LABELS.items():
        v = float((a == lab).sum() * vox)
        if v > 0 or lab in PROMPT:
            out[name] = round(v, 2)
    return out, sp


def main():
    wallet = os.getenv("WALLET"); job = os.getenv("TWIN_JOB_ID")
    bstudy = os.getenv("BASELINE_STUDY"); bseries = os.getenv("BASELINE_SERIES")
    fstudy = os.getenv("FOLLOWUP_STUDY"); fseries = os.getenv("FOLLOWUP_SERIES")
    src = os.getenv("IMAGING_BUCKET", "genobank-health-imaging")
    out_bucket = os.getenv("OUTPUT_BUCKET", "genobank-health-imaging")
    for k, v in {"WALLET": wallet, "FOLLOWUP_STUDY": fstudy, "FOLLOWUP_SERIES": fseries,
                 "TWIN_JOB_ID": job}.items():
        if not v:
            print('VISTA3D_RESULT ' + json.dumps({"status": "error", "error": f"{k} required"})); sys.exit(2)
    have_baseline = bool(bstudy and bseries)
    wd = tempfile.mkdtemp(prefix="vista_"); t0 = time.time()
    try:
        import torch
        from huggingface_hub import snapshot_download
        repo = snapshot_download("MONAI/VISTA3D-HF")
        sys.path.insert(0, repo)
        from hugging_face_pipeline import HuggingFacePipelineHelper

        # stage + phase-detect both timepoints
        fdir = stage_series(src, wallet, fstudy, fseries, os.path.join(wd, "f"))
        f_ct = dcm_to_nifti(fdir, os.path.join(wd, "followup.nii.gz"))
        f_phase = detect_phase(fdir)
        b_ct = b_phase = None
        if have_baseline:
            bdir = stage_series(src, wallet, bstudy, bseries, os.path.join(wd, "b"))
            b_ct = dcm_to_nifti(bdir, os.path.join(wd, "baseline.nii.gz"))
            b_phase = detect_phase(bdir)

        helper = HuggingFacePipelineHelper("vista3d")
        pipeline = helper.init_pipeline(os.path.join(repo, "vista3d_pretrained_model"),
                                        device=torch.device("cuda:0"))

        log("running VISTA-3D on follow-up (pancreas+tumor+liver prompt, with fallback) ...")
        mf, segf_f, used_prompt = segment(pipeline, f_ct, os.path.join(wd, "seg_f"))
        # which of the requested classes VISTA-3D actually accepted (others were zero-shot/undefined)
        liver_classes_used = [c for c in LIVER_TUMOR_CLASSES if c in used_prompt]
        liver_lesion_available = bool(liver_classes_used)
        dropped_classes = [VISTA_LABELS.get(c, str(c)) for c in PROMPT_TIERS[0] if c not in used_prompt]
        fvols, fspc = volumes(mf)
        panc = fvols.get("pancreas", 0.0)
        ptumor_foci = _foci(mf, 24) if 24 in used_prompt else []
        ptumor = round(sum(x["ml"] for x in ptumor_foci), 2)
        liver_foci_followup = _foci(mf, liver_classes_used) if liver_lesion_available else None

        seg_dest_f = f"gs://{out_bucket}/{wallet}/imaging-twin/{job}/vista3d_seg.nii.gz"
        sh(["gcloud", "storage", "cp", segf_f, seg_dest_f])

        liver_foci_baseline = None; seg_dest_b = None
        if have_baseline:
            log("running VISTA-3D on baseline (same prompt for consistency) ...")
            mb, segf_b, _ = segment(pipeline, b_ct, os.path.join(wd, "seg_b"), prompt=used_prompt)
            liver_foci_baseline = _foci(mb, liver_classes_used) if liver_lesion_available else None
            seg_dest_b = f"gs://{out_bucket}/{wallet}/imaging-twin/{job}/vista3d_seg_baseline.nii.gz"
            sh(["gcloud", "storage", "cp", segf_b, seg_dest_b])

        # contrast-phase determination (DETECTED, not assumed) -> interval-change assessability
        bp = (b_phase or {}).get("phase", "unknown") if have_baseline else "absent"
        fp = f_phase.get("phase", "unknown")
        phase_mismatch = bool(have_baseline and bp != fp)
        phase_unknown = (bp in ("unknown", "absent")) or (fp == "unknown")
        if not have_baseline:
            interval_assessable = False
            interval_reason = ("Baseline series not provided to VISTA-3D; only the follow-up was "
                               "segmented, so interval change cannot be assessed. Per-timepoint "
                               "candidate regions are listed for the follow-up only.")
        elif phase_mismatch or phase_unknown:
            interval_assessable = False
            interval_reason = (f"Baseline ({bp}) and follow-up ({fp}) are not the same contrast phase, "
                               "so liver-lesion / soft-tissue interval change is NOT assessable from this "
                               "acquisition pair: a hypovascular pancreatic-cancer metastasis is most "
                               "conspicuous on portal-venous phase and can be invisible on a delayed phase, "
                               "so a focus seen on one scan but not the other may be a conspicuity effect, "
                               "not true change. Per-timepoint candidate regions are listed separately for "
                               "review; a same-phase comparison or dedicated multiphase liver CT/MRI is "
                               "required before any interval change is believed.")
        else:
            interval_assessable = True
            interval_reason = (f"Both timepoints are the same contrast phase ({fp}). Per-timepoint "
                               "candidate regions are listed; this build does not assert categorical "
                               "new/growing/stable (the foci are segmented in independent grids, not a "
                               "shared registered frame), so the radiologist integrates registration QC, "
                               "priors, and clinical context to judge interval change.")

        node_review = {
            "model_can_segment_nodes": False,
            "reason": ("VISTA-3D's label set has no lymph-node class; this tool does not segment, "
                       "count, or measure nodes."),
            "stations_to_review": NODE_STATIONS,
            "caveat": ("Nodal status is the radiologist's call on short-axis size criteria; peri-SMA / "
                       "celiac / portacaval nodes are confounded by post-surgical perivascular soft tissue "
                       "and can be indistinguishable from bed recurrence on CT."),
        }

        phase_note = ("Contrast phase was detected from DICOM (not assumed): baseline=%s, follow-up=%s%s. "
                      % (bp, fp, " (MISMATCHED)" if phase_mismatch else ""))

        result = {
            "schema": "imaging-twin-vista3d/3",
            "model": "MONAI VISTA-3D (CT segmentation foundation model)",
            "framing": ("Model-proposed CANDIDATE regions for radiologist review. NOT lesion detection, "
                        "NOT counts, NOT a recurrence/metastasis call, NOT a diagnosis."),
            "prompted_classes": [VISTA_LABELS.get(c, str(c)) for c in used_prompt],
            "dropped_classes": dropped_classes,   # requested but VISTA-3D auto-seg could not do (zero-shot / undefined in this deployment)
            "liver_lesion_available": liver_lesion_available,
            # resection bed / pancreas (follow-up anchored), unchanged semantics
            "pancreas_ml": panc, "resection_bed_ml": panc,
            "pancreatic_tumor_ml": ptumor, "pancreatic_tumor_foci": ptumor_foci,
            "n_pancreatic_tumor_foci": len(ptumor_foci),
            # liver candidate foci, PER TIMEPOINT (no cross-scan diff on a phase-mismatched pair)
            "liver_organ_ml_followup": fvols.get("liver"),
            "liver_tumor_classes_used": liver_classes_used,
            "liver_tumor_foci_followup": liver_foci_followup,
            "liver_tumor_foci_baseline": liver_foci_baseline,
            "liver_candidate_note": (
                ("Liver candidate foci from VISTA-3D classes %s; per-timepoint candidate regions only; "
                 "equiv_diam_mm is volume-equivalent sphere diameter; foci with measurable=false are below "
                 "CT's ~%dmm reliable characterization floor for hypovascular mets." % (liver_classes_used, int(MEAS_FLOOR_MM)))
                if liver_lesion_available else
                ("VISTA-3D auto-segmentation in this deployment does not support a liver-LESION class "
                 "(it is zero-shot, requiring interactive point prompts this pipeline cannot supply), so "
                 "liver-lesion foci are NOT reported. Liver ORGAN volume is reported instead; lesion-level "
                 "assessment requires the radiologist or a dedicated point-prompted / liver-lesion model.")),
            # contrast-phase + interval-change determination
            "baseline_phase": bp, "followup_phase": fp, "phase_mismatch": phase_mismatch,
            "interval_change_assessable": interval_assessable,
            "interval_change_reason": interval_reason,
            # nodes (honest: not segmented)
            "node_review": node_review,
            "volumes_ml": fvols, "effective_spacing_mm": [round(s, 2) for s in fspc],
            "seg_gcs": seg_dest_f, "seg_gcs_baseline": seg_dest_b,
            "twin_job_id": job, "elapsed_sec": round(time.time() - t0, 1),
            "phase_confound_note": phase_note,
            "note": ("VISTA-3D candidate segmentation of the pancreatic bed + liver on "
                     + ("both timepoints" if have_baseline else "the follow-up") + ". "
                     f"Resection bed (pancreas class) {panc} mL = ROI for review, not a measurement. "
                     f"{len(liver_foci_followup)} liver candidate focus/foci on follow-up"
                     + (f", {len(liver_foci_baseline)} on baseline" if liver_foci_baseline is not None else "")
                     + ". " + phase_note
                     + "Lymph nodes are NOT segmented (review the named stations). "
                     "Decision-support, not a diagnosis; confirm against the radiology read."),
        }
        out_uri = f"gs://{out_bucket}/{wallet}/imaging-twin/{job}/vista3d.json"
        tmp = os.path.join(wd, "vista3d.json")
        with open(tmp, "w") as fh:
            json.dump(result, fh, indent=2)
        sh(["gcloud", "storage", "cp", tmp, out_uri])
        result["output_gcs"] = out_uri
        log("DONE", out_uri)
        print("VISTA3D_RESULT " + json.dumps(result))
    except Exception as e:
        log("ERROR", e); traceback.print_exc()
        print("VISTA3D_RESULT " + json.dumps({"status": "error", "error": str(e)[:300], "twin_job_id": job})); sys.exit(1)


if __name__ == "__main__":
    main()
