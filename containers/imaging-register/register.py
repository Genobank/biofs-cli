#!/usr/bin/env python3
"""
register.py: GenoBank.io staged 3D CT registration with a quality gate (schema imaging-register/3).

The server-side execution surface that biofs-node dispatches to on the GPU executor for
`biofs imaging register`. For N >= 2 CT timepoints of one anatomy it produces a common
reference frame and a consumer contract (`frame_contract.py`) that says, per purpose,
whether a later verb may use that frame. Lesion voxels and HU subtraction stay on a
rigid grid. Organ volume, organ surface, and the pictures use this frame when the gate
did not FAIL. Every gated number names the image it was measured on.

  stage each series -> read DICOM headers (protocol signature, slice-gap check)
  -> 3D volume -> 1 mm isotropic RAS, HU clamp -> TotalSegmentator (117 structures,
     one label map per timepoint)
  -> for every non-reference timepoint, coarse to fine:
       landmark rigid: least-squares fit (Kabsch) of the centroids of the vertebrae that
         TotalSegmentator segmented consistently in both scans, plus the sternum
       -> rigid refinement on the vertebral column (Mattes MI inside the column)
       -> deformable, piecewise so the organs inside the rib cage can slide against it
          (the "motion mask" idea of thoracic registration):
            lungs: SyN (cross-correlation, lung window) inside the lungs
            viscera that move with the diaphragm: SyN (cross-correlation, soft-tissue
              window) driven by the heart, inferior vena cava and the solid abdominal
              organs (liver, spleen, kidneys, pancreas, adrenals, gallbladder, portal and
              splenic veins); stomach and bowel follow this deformation but do not
              drive it, since their content changes between scans. The heart rests on
              the diaphragm and descends with it on a deep breath, as the liver does
            rest of the body (wall, skeleton, aorta, airway, esophagus): SyN with the
              lung and visceral interiors excluded
            each reference voxel takes the transform of the region its reference label
            belongs to, and the body transform everywhere else
     with QC after every stage: label-agnostic surface distance of the whole bony spine,
     of each lung, of the liver and of the spleen, per-structure Dice, centroid error of
     the consistently segmented vertebrae, Jacobian folding per region, bone rigidity
  -> transitivity check (A->B->C against A->C) when there are >= 3 timepoints
  -> gate verdict (PASS / PASS_WITH_WARNINGS / FAIL) against stated thresholds
  -> every timepoint's CT and label map resampled into the reference frame, Jacobian
     maps, QC panels (radiological orientation), manifest -> GCS.

Decision-support, not a diagnosis. Outputs carry no patient identifiers: only the wallet,
study and series UIDs, anonymous anatomical labels, acquisition parameters, and numbers.

Invocation (env vars; CLI flags override):
  WALLET, JOB_ID, ANATOMY (chest|abdomen), TIMEPOINTS (JSON [{label, study, series}]),
  REFERENCE (label; default the first timepoint), PROTOCOL_MODE (auto|same|cross),
  IMAGING_BUCKET, OUTPUT_BUCKET, WORKDIR, ISO_MM (1.0), REG_ISO_MM (1.5, body),
  REG_ISO_LUNG_MM (1.5), MAX_REG_VOX
"""
import os, sys, json, time, glob, shutil, subprocess, argparse, traceback, re

import numpy as np

import lung_volume

SCHEMA = "imaging-register/3"
# Linear CT resample blends across this band at each piecewise boundary.
# Label maps stay a hard switch: a voxel keeps one region's label.
BLEND_MM = 8.0
# Which image a gated metric was measured on. The skin is the resampled CT outline.
# Organ and bone numbers are warped TotalSegmentator labels, not a second segmentation
# of the picture.
METRIC_SOURCE = {
    "spine_assd_mm": "warped_totalsegmentator_labels",
    "spine_hd95_mm": "warped_totalsegmentator_labels",
    "lung_dice_min": "warped_totalsegmentator_labels",
    "lung_assd_max_mm": "warped_totalsegmentator_labels",
    "lung_hd95_max_mm": "warped_totalsegmentator_labels",
    "abdominal_organ_assd_max_mm": "warped_totalsegmentator_labels",
    "abdominal_organ_hd95_max_mm": "warped_totalsegmentator_labels",
    "abdominal_organ_assd_max_mm_corresponding": "warped_totalsegmentator_labels_bowel_excluded",
    "abdominal_organ_hd95_max_mm_corresponding": "warped_totalsegmentator_labels_bowel_excluded",
    "body_surface_assd_mm": "resampled_ct_body_outline",
    "body_surface_hd95_mm": "resampled_ct_body_outline",
    "jacobian_fold_fraction": "deformation_jacobian",
    "vertebra_tre_median_mm": "warped_totalsegmentator_labels",
    "heart_dice": "warped_totalsegmentator_labels",
    "medium_structure_dice_min": "warped_totalsegmentator_labels",
    "esophagus_dice": "warped_totalsegmentator_labels",
    "jacobian_p01": "deformation_jacobian",
    "jacobian_p99": "deformation_jacobian",
    "bone_abs_logjac_p95": "deformation_jacobian_inside_vertebra_labels",
    "dice_median": "warped_totalsegmentator_labels_transitivity",
    "image_agreement_ncc": "ct_intensity_correlation_no_labels_reported_not_gated",
}


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}] [register]", *a, flush=True)


def sh(cmd, **kw):
    log("$", cmd if isinstance(cmd, str) else " ".join(cmd))
    return subprocess.run(cmd, shell=isinstance(cmd, str), check=True, **kw)


# ----------------------------------------------------------------------------------
# Acceptance criteria. Hard checks decide FAIL; soft checks only warn. They are written
# into the manifest so a reader can see exactly what "registered" meant for this job.
# Bone is judged on the whole spine with all vertebra labels merged: TotalSegmentator can
# place the boundary between two vertebrae differently in two scans of the same patient,
# which moves per-vertebra centroids by up to a vertebral half-height even when the bone
# surfaces coincide, so per-vertebra centroid error is reported but only warns.
GATES = [
    # stage, metric, op, threshold, severity, meaning
    ("rigid", "spine_assd_mm", "<=", 2.0, "soft",
     "whole-spine surface distance after the rigid stage; one rigid transform cannot absorb a change of posture"),
    ("deformable", "spine_assd_mm", "<=", 1.0, "hard",
     "average surface distance of the whole bony spine, all vertebra labels merged"),
    ("deformable", "spine_hd95_mm", "<=", 3.0, "hard", "95th percentile surface distance of the whole bony spine"),
    ("deformable", "lung_dice_min", ">=", 0.95, "hard", "worst Dice of the two lungs"),
    ("deformable", "lung_assd_max_mm", "<=", 1.5, "hard", "worst average surface distance of the two lungs"),
    ("deformable", "lung_hd95_max_mm", "<=", 5.0, "hard",
     "worst 95th percentile surface distance of the two lungs (a diaphragm left at the wrong height fails here; "
     "when the lung volume really changed and the breath does not explain it, the three lung checks read as warnings "
     "while the spine stays hard)"),
    ("deformable", "abdominal_organ_assd_max_mm_corresponding", "<=", 2.0, "soft",
     "worst average surface distance of liver and spleen where the two scans correspond (reference organ surface "
     "occupied by bowel in the moving scan is left out and reported as abdominal_organ_bowel_interposition_ml; the "
     "raw distance stays in abdominal_organ_assd_max_mm); a real change of organ shape also raises it"),
    ("deformable", "abdominal_organ_hd95_max_mm_corresponding", "<=", 6.0, "soft",
     "worst 95th percentile surface distance of liver and spleen where the two scans correspond"),
    ("deformable", "body_surface_assd_mm", "<=", 1.5, "soft",
     "average surface distance of the skin, taken from the body outline of the reference CT and of the CT resampled into its frame; arms and breathing move it"),
    ("deformable", "body_surface_hd95_mm", "<=", 5.0, "soft", "95th percentile surface distance of the skin"),
    ("deformable", "jacobian_fold_fraction", "<=", 1e-4, "hard",
     "share of voxels where a deformation folds (det J <= 0), lung and body deformations measured separately"),
    ("deformable", "vertebra_tre_median_mm", "<=", 2.0, "soft",
     "median centroid error of the vertebrae segmented consistently in both scans"),
    ("deformable", "heart_dice", ">=", 0.88, "soft", "heart overlap (non-gated CT: cardiac phase differs between scans)"),
    ("deformable", "medium_structure_dice_min", ">=", 0.80, "soft", "worst Dice of aorta and trachea"),
    ("deformable", "esophagus_dice", ">=", 0.60, "soft", "esophagus overlap (its lumen collapses or fills between scans)"),
    ("deformable", "jacobian_p01", ">=", 0.25, "soft", "1st percentile of det J (no extreme compression)"),
    ("deformable", "jacobian_p99", "<=", 4.0, "soft", "99th percentile of det J (no extreme expansion)"),
    ("deformable", "bone_abs_logjac_p95", "<=", 0.15, "soft",
     "95th percentile of |log det J| inside the vertebrae (bone stays rigid)"),
    ("transitivity", "dice_median", ">=", 0.90, "soft",
     "agreement of A->B->C with A->C over the aligned structures (lungs, whole spine, heart, aorta, trachea, "
     "esophagus, liver, spleen, kidneys)"),
]


# Which organ systems the scan is about decides which checks are hard: a chest CT is judged
# hard on the lungs, an abdominal CT hard on liver and spleen (it holds only the lung bases).
ANATOMY_HARD = {
    "chest": {"lung_dice_min", "lung_assd_max_mm", "lung_hd95_max_mm"},
    "abdomen": {"abdominal_organ_assd_max_mm_corresponding", "abdominal_organ_hd95_max_mm_corresponding"},
}
ANATOMY_SOFT = {
    "chest": {"abdominal_organ_assd_max_mm_corresponding", "abdominal_organ_hd95_max_mm_corresponding"},
    "abdomen": {"lung_dice_min", "lung_assd_max_mm", "lung_hd95_max_mm"},
}


def gates_for(anatomy):
    hard, soft = ANATOMY_HARD.get(anatomy, set()), ANATOMY_SOFT.get(anatomy, set())
    out = []
    for stage, metric, op, thr, sev, meaning in GATES:
        if stage == "deformable" and metric in hard:
            sev = "hard"
        elif stage == "deformable" and metric in soft:
            sev = "soft"
        out.append((stage, metric, op, thr, sev, meaning))
    return out


# The lung surface checks. When the lung volume really changed between the two scans, the lungs are not
# expected to coincide after the warp, so a failure of these reads as a warning (decision of 2026-11-04,
# audit finding A7). Never when the spine fails, never when the lung evidence is missing.
LUNG_SURFACE_METRICS = ("lung_dice_min", "lung_assd_max_mm", "lung_hd95_max_mm")


def _spine_hard_ok(metrics_by_stage, gates):
    """True only when every hard spine check was computed and passed."""
    seen = 0
    for stage, metric, op, thr, sev, _ in gates:
        if sev != "hard" or not metric.startswith("spine_"):
            continue
        val = (metrics_by_stage.get(stage, {}) or {}).get(metric)
        if val is None:
            return False
        seen += 1
        if not ((val >= thr) if op == ">=" else (val <= thr) if op == "<=" else (val > thr)):
            return False
    return seen > 0


def evaluate_gate(metrics_by_stage, transitivity, gates=None, protocol_mode=None, lung_change=None):
    checks, hard_fail, soft_fail = [], [], []
    downgrade_lungs = bool(lung_change and lung_change.get("computed") and lung_change.get("real_change_supported")
                           and _spine_hard_ok(metrics_by_stage, gates or GATES))
    for stage, metric, op, thr, sev, meaning in (gates or GATES):
        src = transitivity if stage == "transitivity" else metrics_by_stage.get(stage, {})
        val = (src or {}).get(metric)
        source = METRIC_SOURCE.get(metric, "unspecified")
        if val is None:
            # Missing evidence is never a pass. A hard check that could not be computed closes
            # the verdict (the anatomy chosen for the job says which checks are hard, so a scan
            # without the structure the job is about cannot come back PASS). A soft check that
            # could not be computed is listed in the pair's `not_computed` and does not move it.
            item = {"stage": stage, "metric": metric, "value": None, "op": op, "threshold": thr,
                    "severity": sev, "pass": None, "meaning": meaning, "measured_on": source,
                    "note": "not computed"}
            if sev == "hard":
                item["incomplete_hard_check"] = True
                hard_fail.append(f"{stage}.{metric} not computed (hard check, evidence missing)")
            checks.append(item)
            continue
        ok = (val >= thr) if op == ">=" else (val <= thr) if op == "<=" else (val > thr)
        item = {"stage": stage, "metric": metric, "value": round(float(val), 5), "op": op,
                "threshold": thr, "severity": sev, "pass": bool(ok), "meaning": meaning,
                "measured_on": source}
        note = ""
        # The 5 mm skin line stays. A cross-protocol pair (arms, field of view, kernel)
        # is expected to trip it. The warning says so. The threshold does not move.
        if (not ok) and protocol_mode == "cross" and metric.startswith("body_surface"):
            item["context"] = "cross_protocol_rim_expected"
            item["meaning"] = (meaning + " Cross-protocol: arms, field of view, and the reconstruction "
                               "kernel move this tail. The threshold is unchanged.")
            note = " [cross-protocol rim expected; threshold unchanged]"
        if (not ok) and sev == "hard" and metric in LUNG_SURFACE_METRICS and downgrade_lungs:
            sev = "soft"
            item["severity"] = "soft"
            item["downgraded_from"] = "hard"
            item["context"] = "lung_volume_changed"
            item["meaning"] = (meaning + " Downgraded to a warning: the lung volume changed between the two scans and the "
                               "breath does not explain it, so the lungs are not expected to coincide (see lung_volume).")
            note = " [lung volume changed, not explained by the breath; was a hard check]"
        checks.append(item)
        if not ok:
            (hard_fail if sev == "hard" else soft_fail).append(
                f"{stage}.{metric}={val:.4g} (needs {op} {thr}){note}")
    verdict = "FAIL" if hard_fail else ("PASS_WITH_WARNINGS" if soft_fail else "PASS")
    return verdict, checks, hard_fail, soft_fail


# ----------------------------------------------------------------------------------
# Staging and volume construction
def gcs_prefix(bucket, wallet, study, series):
    return f"gs://{bucket}/{wallet}/imaging/{study}/{series}/"


def stage_series(bucket, wallet, study, series, dest):
    """Copy one series' DICOM slices from GCS to the executor's scratch disk."""
    os.makedirs(dest, exist_ok=True)
    if not [f for f in os.listdir(dest) if f.endswith(".dcm")]:
        sh(["gcloud", "storage", "cp", "--recursive", gcs_prefix(bucket, wallet, study, series) + "*", dest],
           stdout=subprocess.DEVNULL)
    n = len([f for f in os.listdir(dest) if f.endswith(".dcm")])
    log(f"staged {n} DICOM slices -> {dest}")
    if n == 0:
        raise RuntimeError(f"no DICOM slices staged for series {series}")
    return dest


def _first(ds, kw, default=None):
    v = getattr(ds, kw, None)
    if v is None or v == "":
        return default
    if isinstance(v, (list, tuple)) or type(v).__name__ == "MultiValue":
        return [str(x) for x in v]
    return str(v)


def read_protocol(dcm_dir):
    """Acquisition signature of a series from its DICOM headers, plus slice-spacing
    integrity (a missing slice shows as a gap). No patient attribute is read or kept."""
    import pydicom
    files = sorted(glob.glob(os.path.join(dcm_dir, "*.dcm")))
    zs, head = [], None
    for f in files:
        ds = pydicom.dcmread(f, stop_before_pixels=True)
        ipp = getattr(ds, "ImagePositionPatient", None)
        if ipp is not None:
            zs.append(float(ipp[2]))
        if head is None:
            head = ds
    zs = np.sort(np.array(zs))
    steps = np.diff(zs) if len(zs) > 1 else np.array([0.0])
    med = float(np.median(steps)) if len(steps) else 0.0
    kernel = _first(head, "ConvolutionKernel", "")
    kernel_str = "\\".join(kernel) if isinstance(kernel, list) else (kernel or "")
    m = re.match(r"^([A-Za-z]+)(\d+)([A-Za-z]*)", kernel_str.split("\\")[0])
    sig = {
        "manufacturer": _first(head, "Manufacturer"),
        "model": _first(head, "ManufacturerModelName"),
        "series_description": _first(head, "SeriesDescription"),
        "study_date": _first(head, "StudyDate"),
        "kernel": kernel_str,
        "kernel_family": (m.group(1) + m.group(2)) if m else kernel_str,
        "kernel_sharpness": int(m.group(2)) if m else None,
        "kernel_variant": ((m.group(3) or "") + ("\\" + kernel_str.split("\\")[1] if "\\" in kernel_str else "")) if m else "",
        "slice_thickness_mm": float(_first(head, "SliceThickness", "0") or 0),
        "kvp": float(_first(head, "KVP", "0") or 0),
        "contrast_agent": bool(_first(head, "ContrastBolusAgent")),
        "pixel_spacing_mm": [float(x) for x in (_first(head, "PixelSpacing") or [0, 0])],
        "image_type": _first(head, "ImageType"),
        "n_slices": len(files),
        "z_extent_mm": round(float(zs[-1] - zs[0]), 1) if len(zs) > 1 else 0.0,
        "slice_step_mm": round(med, 3),
        "max_gap_mm": round(float(steps.max()), 3) if len(steps) else 0.0,
        "gaps": int(np.sum(steps > 1.5 * med)) if med > 0 else 0,
    }
    return sig


def compare_protocols(ref, mov):
    """Comparability of two acquisitions: 'same' when intensities can be compared voxel
    to voxel, 'cross' when they cannot (different kernel family, scanner or contrast)."""
    hard, soft = [], []
    if (ref.get("kernel_family") or "").lower() != (mov.get("kernel_family") or "").lower():
        hard.append(f"kernel family {ref.get('kernel_family')} vs {mov.get('kernel_family')}")
    if (ref.get("model") or "") != (mov.get("model") or ""):
        soft.append(f"scanner model {ref.get('model')} vs {mov.get('model')}")
    if ref.get("contrast_agent") != mov.get("contrast_agent"):
        hard.append("contrast vs non-contrast")
    if (ref.get("kernel_variant") or "") != (mov.get("kernel_variant") or ""):
        soft.append(f"reconstruction variant {ref.get('kernel_variant') or '-'} vs {mov.get('kernel_variant') or '-'} (noise texture differs)")
    rt, mt = ref.get("slice_thickness_mm") or 0, mov.get("slice_thickness_mm") or 0
    if rt and mt and max(rt, mt) / min(rt, mt) > 1.34:
        soft.append(f"slice thickness {rt} vs {mt} mm")
    if (ref.get("kvp") or 0) != (mov.get("kvp") or 0):
        soft.append(f"kVp {ref.get('kvp')} vs {mov.get('kvp')}")
    return {"comparability": "cross" if hard else "same", "differences_hard": hard, "differences_soft": soft}


def lung_mass_comparability(ref_protocol, mov_protocol):
    """Can the aerated-lung mass of two scans be compared? Not when the kernel family, the contrast state or the slice thickness
    differs (same-scan reconstructions of 6 RIDER patients moved the mass by 22 percent between kernels and 15 percent between
    1.25 and 5 mm). A different reconstruction variant inside one family is allowed and carried as a caveat.
    Returns (comparable, reason or None, caveat or None)."""
    c = compare_protocols(ref_protocol, mov_protocol)
    why = list(c["differences_hard"]) + [d for d in c["differences_soft"] if d.startswith("slice thickness")]
    caveat = next((d for d in c["differences_soft"] if d.startswith("reconstruction variant")), None)
    return (not why), ("; ".join(why) if why else None), caveat


def dcm_to_nifti(dcm_dir, out_nii):
    import SimpleITK as sitk
    reader = sitk.ImageSeriesReader()
    ids = reader.GetGDCMSeriesIDs(dcm_dir)
    if not ids:
        raise RuntimeError(f"no DICOM series found in {dcm_dir}")
    best = max(ids, key=lambda sid: len(reader.GetGDCMSeriesFileNames(dcm_dir, sid)))
    reader.SetFileNames(reader.GetGDCMSeriesFileNames(dcm_dir, best))
    sitk.WriteImage(reader.Execute(), out_nii)
    return out_nii


def preprocess(in_nii, out_nii, iso=1.0, hu_hi=3000.0):
    """Reorient RAS, resample to `iso` mm (never finer than the acquired spacing),
    B-spline interpolation, HU clamp [-1024, hu_hi]."""
    import SimpleITK as sitk
    img = sitk.DICOMOrient(sitk.ReadImage(in_nii), "RAS")
    sp, sz = img.GetSpacing(), img.GetSize()
    iso = max(float(iso), float(min(sp)))
    nsz = [int(round(sz[i] * sp[i] / iso)) for i in range(3)]
    img = sitk.Resample(img, nsz, sitk.Transform(), sitk.sitkBSpline, img.GetOrigin(), [iso] * 3,
                        img.GetDirection(), -1024.0, sitk.sitkFloat32)
    img = sitk.Cast(sitk.Clamp(img, lowerBound=-1024, upperBound=float(hu_hi)), sitk.sitkInt16)
    sitk.WriteImage(img, out_nii)
    log(f"volume {os.path.basename(os.path.dirname(out_nii))}: {nsz} at {iso} mm")
    return out_nii


def segment(ct_nii, out_nii):
    """TotalSegmentator v2, task 'total', one multilabel map (ids per its class map)."""
    from totalsegmentator.python_api import totalsegmentator
    from totalsegmentator.map_to_binary import class_map
    if not os.path.exists(out_nii):
        t = time.time()
        totalsegmentator(ct_nii, out_nii, ml=True, fast=False, task="total", device="gpu", quiet=True)
        log(f"TotalSegmentator {os.path.basename(os.path.dirname(out_nii))}: {time.time() - t:.0f}s")
    return out_nii, {int(k): v for k, v in class_map["total"].items()}


# ----------------------------------------------------------------------------------
# Label and mask helpers
def physical_centroids(label_img, ids):
    import SimpleITK as sitk
    st = sitk.LabelShapeStatisticsImageFilter()
    st.Execute(sitk.Cast(label_img, sitk.sitkUInt16))
    present = set(st.GetLabels())
    return {i: np.array(st.GetCentroid(i)) for i in ids if i in present}


def ids_matching(names, pattern):
    rx = re.compile(pattern)
    return [i for i, n in names.items() if rx.search(n)]


def body_mask_from(ct_img):
    import SimpleITK as sitk
    b = sitk.BinaryThreshold(ct_img, -500, 4000, 1, 0)
    b = sitk.BinaryMorphologicalOpening(b, [2, 2, 2])
    cc = sitk.RelabelComponent(sitk.ConnectedComponent(b), sortByObjectSize=True)
    b = sitk.BinaryThreshold(cc, 1, 1, 1, 0)
    b = sitk.BinaryFillhole(b)
    return sitk.Cast(b, sitk.sitkUInt8)


def mask_from_labels(label_img, ids, dilate_mm=0.0, erode_mm=0.0):
    import SimpleITK as sitk
    arr = sitk.GetArrayFromImage(label_img)
    m = sitk.GetImageFromArray(np.isin(arr, list(ids)).astype(np.uint8))
    m.CopyInformation(label_img)
    if dilate_mm > 0:
        r = max(1, int(round(dilate_mm / label_img.GetSpacing()[0])))
        m = sitk.BinaryDilate(m, [r, r, r])
    if erode_mm > 0:
        r = max(1, int(round(erode_mm / label_img.GetSpacing()[0])))
        m = sitk.BinaryErode(m, [r, r, r])
    return m


def detach_fused_table(body_zyx, spacing_zyx, bridge_mm=8.0, min_slab_ml=30.0):
    """Split a thin slab off the body mask when an erosion of `bridge_mm` separates it.

    Voxels outside the body are already ignored by the caller. This only handles a couch
    that fused into the largest component across a thin bridge. A large extra that is not
    a thin slab is left in the mask and reported as table_fused, so anatomy is not cut away.
    When nothing separates, table_fused is false and the note says the couch was not proven
    absent: those voxels can still drive the body warp.
    """
    from scipy import ndimage
    body = np.asarray(body_zyx).astype(bool)
    spacing = np.asarray(spacing_zyx, dtype=float)
    empty = {"bridge_mm": bridge_mm, "extra_ml": 0.0, "table_detached_ml": 0.0, "table_fused": False}
    if body.sum() < 1000:
        empty["note"] = "body too small to test"
        return body.astype(np.uint8), empty
    step = float(min(spacing))
    iterations = max(1, int(round(bridge_mm / step)))
    eroded = ndimage.binary_erosion(body, iterations=iterations)
    lab, n = ndimage.label(eroded)
    if n == 0:
        empty["note"] = "erosion removed the body; mask left intact"
        return body.astype(np.uint8), empty
    counts = np.bincount(lab.ravel())
    counts[0] = 0
    core = lab == int(counts.argmax())
    restored = ndimage.binary_dilation(core, iterations=iterations) & body
    extra = body & ~restored
    ml = float(extra.sum()) * float(np.prod(spacing)) / 1000.0
    report = {"bridge_mm": bridge_mm, "extra_ml": round(ml, 1), "table_detached_ml": 0.0, "table_fused": False}
    if extra.sum() < 50 or ml < min_slab_ml:
        report["note"] = "no separate slab after erosion; a couch fused wider than the bridge can still drive the warp"
        return body.astype(np.uint8), report
    # Opening a rectangle sheds corner voxels. Judge each extra component on its own,
    # put small crumbs and non-slabs back, and drop only a thin slab.
    cleaned = restored.copy()
    elab, n_extra = ndimage.label(extra)
    detached_ml = 0.0
    voxel_ml = float(np.prod(spacing)) / 1000.0
    for i in range(1, n_extra + 1):
        comp = elab == i
        comp_ml = float(comp.sum()) * voxel_ml
        if comp_ml < min_slab_ml:
            cleaned |= comp
            continue
        pts = np.argwhere(comp)
        extent = (pts.max(axis=0) - pts.min(axis=0) + 1) * spacing
        thin = float(extent.min())
        long = float(extent.max())
        is_slab = thin <= 40.0 and long >= 80.0 and thin / max(long, 1e-6) <= 0.35
        if is_slab:
            detached_ml += comp_ml
        else:
            cleaned |= comp
            report["table_fused"] = True
    report["table_detached_ml"] = round(detached_ml, 1)
    if detached_ml > 0 and not report["table_fused"]:
        report["note"] = "thin slab separated by erosion and removed from the mask that clears the CT"
    elif detached_ml > 0:
        report["note"] = "a thin slab was removed; a separate non-slab extra was kept"
    elif report["table_fused"]:
        report["note"] = ("erosion left a large extra that is not a thin slab; it was kept so anatomy is not removed. "
                          "Those voxels can still drive the body warp.")
    else:
        report["note"] = "no separate slab after erosion; a couch fused wider than the bridge can still drive the warp"
    return cleaned.astype(np.uint8), report


def without_table(ct, body, margin_mm=3.0, bridge_mm=8.0):
    """CT with voxels outside the body (plus `margin_mm`) set to air.

    Returns (image, report). A couch fused by a thin bridge is removed when
    `detach_fused_table` separates a slab. Anything else stays, and the report says so.
    """
    import SimpleITK as sitk
    spacing = np.array(body.GetSpacing())[::-1]
    cleaned, report = detach_fused_table(sitk.GetArrayFromImage(body), spacing, bridge_mm=bridge_mm)
    cleaned_img = sitk.GetImageFromArray(cleaned.astype(np.uint8))
    cleaned_img.CopyInformation(body)
    r = max(1, int(round(margin_mm / body.GetSpacing()[0])))
    keep = sitk.GetArrayFromImage(sitk.BinaryDilate(cleaned_img, [r, r, r])) > 0
    a = sitk.GetArrayFromImage(ct).astype(np.float32)
    a[~keep] = -1024.0
    out = sitk.GetImageFromArray(a)
    out.CopyInformation(ct)
    return out, report


def ct_body_surface(ref_ct, warped_zyx, valid, spacing, zwin):
    """Skin distance between a reference CT and a CT already resampled onto its grid.
    Both outlines come from the CT intensities, on that one grid."""
    import SimpleITK as sitk
    ref_body = sitk.GetArrayFromImage(body_mask_from(ref_ct)).astype(np.uint8)
    wim = sitk.GetImageFromArray(np.ascontiguousarray(warped_zyx.astype(np.float32)))
    wim.CopyInformation(ref_ct)
    wbody = sitk.GetArrayFromImage(body_mask_from(wim)).astype(np.uint8)
    return region_surface(np.where(valid, ref_body, 0), np.where(valid, wbody, 0),
                          [1], spacing, zwin, border_xy=3)


def dilate_mask(m, mm):
    import SimpleITK as sitk
    r = max(1, int(round(mm / m.GetSpacing()[0])))
    return sitk.BinaryDilate(m, [r, r, r])


def mask_minus(a, b):
    """a AND NOT b, for two binary masks on one grid."""
    import SimpleITK as sitk
    arr = (sitk.GetArrayFromImage(a) > 0) & ~(sitk.GetArrayFromImage(b) > 0)
    m = sitk.GetImageFromArray(arr.astype(np.uint8))
    m.CopyInformation(a)
    return m


def window(img, lo, hi):
    import SimpleITK as sitk
    return sitk.Clamp(sitk.Cast(img, sitk.sitkFloat32), lowerBound=float(lo), upperBound=float(hi))


def crop_common(fix_ct, mov_ct, fix_lab, mov_lab, vert_ids, margin_mm=25.0):
    """Crop each volume to the physical z-range of the vertebrae both scans contain
    (+ margin) and to its body bounding box, so the optimizer sees the same anatomy."""
    import SimpleITK as sitk

    def zrange(lab):
        st = sitk.LabelShapeStatisticsImageFilter(); st.Execute(sitk.Cast(lab, sitk.sitkUInt16))
        return st, set(st.GetLabels())

    fst, fl = zrange(fix_lab); mst, ml = zrange(mov_lab)
    common = [i for i in vert_ids if i in fl and i in ml]

    def phys_z(st, lab, ids):
        zs = []
        for i in ids:
            bb = st.GetBoundingBox(i)  # x, y, z, sx, sy, sz in index space
            for k in (bb[2], bb[2] + bb[5] - 1):
                zs.append(lab.TransformIndexToPhysicalPoint((bb[0], bb[1], int(k)))[2])
        return min(zs), max(zs)

    if len(common) >= 2:
        flo, fhi = phys_z(fst, fix_lab, common); mlo, mhi = phys_z(mst, mov_lab, common)
    else:
        flo = fhi = mlo = mhi = None

    def crop(ct, lab, lo, hi):
        sz = ct.GetSize()
        if lo is None:
            k0, k1 = 0, sz[2] - 1
        else:
            ks = []
            for z in (lo - margin_mm, hi + margin_mm):
                o = ct.GetOrigin()
                ks.append(ct.TransformPhysicalPointToContinuousIndex((o[0], o[1], z))[2])
            k0, k1 = int(max(0, np.floor(min(ks)))), int(min(sz[2] - 1, np.ceil(max(ks))))
        body = body_mask_from(ct)
        st = sitk.LabelShapeStatisticsImageFilter(); st.Execute(body)
        bb = st.GetBoundingBox(1)
        pad = int(round(20.0 / ct.GetSpacing()[0]))
        x0, y0 = max(0, bb[0] - pad), max(0, bb[1] - pad)
        x1, y1 = min(sz[0] - 1, bb[0] + bb[3] + pad), min(sz[1] - 1, bb[1] + bb[4] + pad)
        idx, size = [x0, y0, k0], [x1 - x0 + 1, y1 - y0 + 1, k1 - k0 + 1]
        return (sitk.RegionOfInterest(ct, size, idx), sitk.RegionOfInterest(lab, size, idx),
                sitk.RegionOfInterest(body, size, idx))

    fc, flc, fb = crop(fix_ct, fix_lab, flo, fhi)
    mc, mlc, mb = crop(mov_ct, mov_lab, mlo, mhi)
    zr = None if flo is None else (flo - margin_mm, fhi + margin_mm)
    return (fc, flc, fb), (mc, mlc, mb), common, zr


def resample_iso(img, iso, interp, default):
    import SimpleITK as sitk
    sp, sz = img.GetSpacing(), img.GetSize()
    nsz = [max(1, int(round(sz[i] * sp[i] / iso))) for i in range(3)]
    return sitk.Resample(img, nsz, sitk.Transform(), interp, img.GetOrigin(), [iso] * 3,
                         img.GetDirection(), default, img.GetPixelID())


def budget_iso(img, want_iso, max_vox):
    sp, sz = img.GetSpacing(), img.GetSize()
    iso = float(want_iso)
    while iso < 3.0 and int(np.prod([sz[i] * sp[i] / iso for i in range(3)])) > max_vox:
        iso *= 1.1
    return round(iso, 3)


# ----------------------------------------------------------------------------------
# Landmarks: vertebral centroids, used only where TotalSegmentator segmented the same
# vertebra consistently in both scans (largest connected component, not cut by the
# scanned range, volume and height within tolerance). Decided before any registration.
def largest_component(mask):
    from scipy import ndimage
    lab, n = ndimage.label(mask)
    if n <= 1:
        return mask, int(mask.sum())
    sizes = np.bincount(lab.ravel()); sizes[0] = 0
    k = int(sizes.argmax())
    return lab == k, int(sizes[k])


def component_centroids(arr, ids):
    """Index-space centroid (z, y, x) of the largest connected component of each label."""
    from scipy import ndimage
    objs = ndimage.find_objects(arr)
    out = {}
    for i in ids:
        if i - 1 >= len(objs) or objs[i - 1] is None:
            continue
        sl = objs[i - 1]
        m, n = largest_component(arr[sl] == i)
        if n == 0:
            continue
        out[i] = np.array(ndimage.center_of_mass(m)) + np.array([s.start for s in sl], dtype=float)
    return out


_TABLES = {}


def landmark_table(label_path, ids):
    """Per label (largest component): voxel count, height (mm), physical centroid (ITK
    LPS), and whether it touches the top or bottom of the scanned range."""
    if label_path in _TABLES:
        return _TABLES[label_path]
    import SimpleITK as sitk
    from scipy import ndimage
    img = sitk.ReadImage(label_path)
    arr = sitk.GetArrayFromImage(img).astype(np.int16)
    nz, zsp = arr.shape[0], img.GetSpacing()[2]
    objs = ndimage.find_objects(arr)
    tab = {}
    for i in ids:
        if i - 1 >= len(objs) or objs[i - 1] is None:
            continue
        sl = objs[i - 1]
        m, n = largest_component(arr[sl] == i)
        if n == 0:
            continue
        zs = np.flatnonzero(m.any(axis=(1, 2))) + sl[0].start
        c = np.array(ndimage.center_of_mass(m)) + np.array([s.start for s in sl], dtype=float)
        phys = np.array(img.TransformContinuousIndexToPhysicalPoint((float(c[2]), float(c[1]), float(c[0]))))
        tab[i] = {"n": n, "height_mm": float((zs[-1] - zs[0] + 1) * zsp), "phys": phys,
                  "edge": bool(zs[0] <= 1 or zs[-1] >= nz - 2)}
    _TABLES[label_path] = tab
    return tab


def consistent_landmarks(ft, mt, ids, vol_tol=0.15, height_tol=0.25):
    ok, why = [], {}
    for i in ids:
        if i not in ft or i not in mt:
            continue
        a, b = ft[i], mt[i]
        if a["edge"] or b["edge"]:
            why[i] = "cut by the scanned range"
            continue
        r = b["n"] / max(1, a["n"])
        if abs(r - 1) > vol_tol:
            why[i] = f"segmented volume differs between the scans ({r:.2f}x)"
            continue
        h = b["height_mm"] / max(1.0, a["height_mm"])
        if abs(h - 1) > height_tol:
            why[i] = f"segmented height differs between the scans ({h:.2f}x)"
            continue
        ok.append(i)
    return ok, why


def kabsch(P, Q):
    """Rotation R and translation t minimizing |R p + t - q| over matched rows of P, Q."""
    pc, qc = P.mean(0), Q.mean(0)
    H = (P - pc).T @ (Q - qc)
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T)) or 1.0
    R = Vt.T @ np.diag([1.0, 1.0, d]) @ U.T
    return R, qc - R @ pc


def robust_rigid(P, Q, ids):
    """Kabsch with up to 3 rounds of trimming: a point whose residual exceeds both 5 mm
    and 3x the median residual of the kept points is dropped, as long as 3 remain."""
    keep = list(range(len(ids)))
    R, t = kabsch(P, Q)
    for _ in range(3):
        res = np.linalg.norm(P @ R.T + t - Q, axis=1)
        thr = max(5.0, 3.0 * float(np.median(res[keep])))
        new = [k for k in range(len(ids)) if res[k] <= thr]
        if len(new) < 3 or new == keep:
            break
        keep = new
        R, t = kabsch(P[keep], Q[keep])
    res = np.linalg.norm(P @ R.T + t - Q, axis=1)
    return R, t, res, [ids[k] for k in keep]


def rotation_deg(R):
    return float(np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))))


# ----------------------------------------------------------------------------------
# QC metrics
def dice_table(a, b, ids):
    maxl = int(max(a.max(), b.max(), max(ids) if ids else 0)) + 1
    same = a[a == b]
    inter = np.bincount(same.ravel(), minlength=maxl)
    ca = np.bincount(a.ravel(), minlength=maxl); cb = np.bincount(b.ravel(), minlength=maxl)
    out = {}
    for i in ids:
        d = ca[i] + cb[i]
        out[i] = (2.0 * inter[i] / d) if d else None
    return out


def _far_surface(surface, distances, far_mm):
    """Where the reference surface sits farther than far_mm from the moving surface.

    Axes are z, y, x index of the isotropic array. Axis 0 is the slice axis.
    This does not name a side anterior or inferior. That needs the image direction.
    """
    idx = np.argwhere(surface)
    rec = {"threshold_mm": far_mm, "n": 0,
           "fraction_of_reference_surface": 0.0,
           "axes": "zyx index of the isotropic volume (axis 0 is the slice axis). Not an anatomical name."}
    if idx.shape[0] == 0 or idx.shape[0] != getattr(distances, "shape", (None,))[0]:
        if idx.shape[0] and idx.shape[0] != getattr(distances, "shape", (None,))[0]:
            rec["note"] = "index mismatch"
        return rec
    far = distances > far_mm
    n = int(far.sum())
    rec["n"] = n
    rec["fraction_of_reference_surface"] = round(float(n) / idx.shape[0], 4)
    if n == 0:
        return rec
    rel = idx[far] - idx.mean(axis=0)
    for axis, name in ((0, "axis0"), (1, "axis1"), (2, "axis2")):
        rec[f"fraction_positive_{name}"] = round(float((rel[:, axis] > 0).mean()), 4)
    return rec


def region_surface(fa, wa, ids, spacing, zwin, border_xy=0, exclude=None, far_mm=None):
    """Label-agnostic agreement of one region (the union of `ids`) between the reference
    and the warped moving label maps: symmetric surface distance (mean and 95th
    percentile, mm) and Dice, inside the slices both scans cover (`zwin`, which already
    excludes the cut faces at the edges of the common coverage). `border_xy` drops surface
    voxels within that many voxels of the in-plane image edge (a body cut by the field of view).
    `exclude` (a mask on the full grid) drops the surface voxels inside it, for places where the
    two scans hold different contents and no correspondence exists."""
    from scipy import ndimage
    a = np.isin(fa, ids); b = np.isin(wa, ids)
    lo, hi = zwin
    a[:lo] = False; a[hi + 1:] = False; b[:lo] = False; b[hi + 1:] = False
    if a.sum() < 500 or b.sum() < 500:
        return None
    sl = ndimage.find_objects((a | b).astype(np.uint8))[0]
    sl = tuple(slice(max(0, s.start - 3), min(n, s.stop + 3)) for s, n in zip(sl, a.shape))
    A, B = a[sl], b[sl]
    sA = A & ~ndimage.binary_erosion(A); sB = B & ~ndimage.binary_erosion(B)
    # surface voxels on the window's top and bottom faces are cut faces, not anatomy
    z = np.arange(sl[0].start, sl[0].stop)[:, None, None]
    inner = (z > lo) & (z < hi)
    if border_xy:
        yy = np.arange(sl[1].start, sl[1].stop)[None, :, None]; xx = np.arange(sl[2].start, sl[2].stop)[None, None, :]
        inner = inner & (yy >= border_xy) & (yy < a.shape[1] - border_xy) & (xx >= border_xy) & (xx < a.shape[2] - border_xy)
    if exclude is not None:
        inner = inner & ~exclude[sl]
    dA = ndimage.distance_transform_edt(~sB, sampling=spacing)[sA & inner]
    dB = ndimage.distance_transform_edt(~sA, sampling=spacing)[sB & inner]
    d = np.concatenate([dA, dB])
    if d.size == 0:
        return None
    out = {"assd_mm": round(float(d.mean()), 3), "hd95_mm": round(float(np.percentile(d, 95)), 3),
           "max_mm": round(float(d.max()), 2), "dice": round(float(2.0 * (A & B).sum() / (A.sum() + B.sum())), 4)}
    if far_mm is not None:
        out["far_surface"] = _far_surface(sA & inner, dA, far_mm)
    return out


def image_agreement(ref_ct, warped_ct, mask, valid, zwin, lo=-1024.0, hi=400.0, min_vox=5000):
    """Label-free agreement of two CTs on one grid: Pearson correlation of the clipped
    intensities inside `mask`, over the slices both scans cover. It does not use any
    TotalSegmentator label of the warped scan, so it is a second opinion on the surface
    metrics. Reported beside them; no threshold is set for it yet."""
    m = np.asarray(mask, bool) & np.asarray(valid, bool)
    m[:zwin[0]] = False
    m[zwin[1] + 1:] = False
    if int(m.sum()) < min_vox:
        return None
    a = np.clip(np.asarray(ref_ct, np.float32)[m], lo, hi)
    b = np.clip(np.asarray(warped_ct, np.float32)[m], lo, hi)
    if a.std() < 1e-6 or b.std() < 1e-6:
        return None
    return round(float(np.corrcoef(a, b)[0, 1]), 4)


def stage_metrics(ref_lab, warped_lab, valid, names, groups, spacing, landmarks, zwin):
    """Everything the gate reads for one stage, plus the per-structure detail."""
    from scipy import ndimage
    nl = max(names) + 1
    fa = np.where(valid, ref_lab, 0); wa = np.where(valid, warped_lab, 0)
    ref_full = np.bincount(ref_lab.ravel(), minlength=nl)
    ref_in = np.bincount(fa.ravel(), minlength=nl)
    cand = [i for i in names if ref_full[i] > 50 and ref_in[i] >= 0.9 * ref_full[i]]
    dice = dice_table(fa, wa, cand)

    spine = region_surface(fa, wa, groups["vertebrae"], spacing, zwin)
    lungs = {side: region_surface(fa, wa, groups[side], spacing, zwin) for side in ("lung_left", "lung_right")}
    organs = {o: region_surface(fa, wa, groups[o], spacing, zwin) for o in ("liver", "spleen") if groups.get(o)}
    # A structure the reference holds inside the common slices must produce a number. If it holds
    # one and the warped scan has none (the lung collapsed out of the label, the organ is gone), the
    # summary over the sides that did produce a number would hide it: the metric is withheld instead,
    # and the gate closes on it (evaluate_gate treats a missing hard metric as a failure).
    lo_p, hi_p = zwin

    def in_reference(ids):
        return bool(ids) and int(np.isin(fa[lo_p:hi_p + 1], ids).sum()) >= 500

    lung_sides_missing = [s for s in ("lung_left", "lung_right") if in_reference(groups.get(s)) and not lungs[s]]
    organs_missing = [o for o in ("liver", "spleen") if in_reference(groups.get(o)) and not organs.get(o)]
    lv = [] if lung_sides_missing else [v for v in lungs.values() if v]
    ov = [] if organs_missing else [v for v in organs.values() if v]
    # Where the moving scan holds bowel (colon, stomach, small bowel) inside the reference organ,
    # the two scans have different contents there: a smooth deformation cannot put an organ where
    # the other scan has gas-filled bowel. That part of the reference surface is left out of the
    # corresponding-surface distance and its volume is reported. Only this one direction is
    # excluded, so an organ that is simply misplaced still shows on its other side.
    bowel = groups.get("bowel") or []
    lo_w, hi_w = zwin
    zin = np.zeros(fa.shape[0], bool); zin[lo_w:hi_w + 1] = True
    corr, interposed = {}, {}
    for o in ("liver", "spleen"):
        if not groups.get(o):
            continue
        ex = np.isin(fa, groups[o]) & np.isin(wa, bowel) & zin[:, None, None]
        interposed[o] = round(float(ex.sum()) * float(np.prod(spacing)) / 1000.0, 1)
        corr[o] = region_surface(fa, wa, groups[o], spacing, zwin,
                                 exclude=ndimage.binary_dilation(ex, iterations=2), far_mm=6.0)
    organs_corr_missing = [o for o in ("liver", "spleen") if in_reference(groups.get(o)) and not corr.get(o)]
    cv = [] if organs_corr_missing else [v for v in corr.values() if v]

    lm = [i for i in landmarks if i in cand]
    cf = component_centroids(fa, lm); cw = component_centroids(wa, lm)
    tre = {i: float(np.linalg.norm((cf[i] - cw[i]) * spacing)) for i in lm if i in cf and i in cw}
    tv = list(tre.values())

    def dget(i):
        return round(dice[i], 4) if i is not None and dice.get(i) is not None else None

    med = {names[i]: dget(i) for i in groups["medium"] if dget(i) is not None}
    return {
        "n_structures": len(cand),
        "dice_median_all": round(float(np.median([v for v in dice.values() if v is not None])), 4) if dice else None,
        "spine_assd_mm": spine["assd_mm"] if spine else None,
        "spine_hd95_mm": spine["hd95_mm"] if spine else None,
        "spine_dice": spine["dice"] if spine else None,
        "lung_dice_min": min(v["dice"] for v in lv) if lv else None,
        "lung_assd_max_mm": max(v["assd_mm"] for v in lv) if lv else None,
        "lung_hd95_max_mm": max(v["hd95_mm"] for v in lv) if lv else None,
        "lungs": lungs,
        "lung_sides_missing": lung_sides_missing,
        "abdominal_organs_missing": sorted(set(organs_missing) | set(organs_corr_missing)),
        "abdominal_organ_assd_max_mm": max(v["assd_mm"] for v in ov) if ov else None,
        "abdominal_organ_hd95_max_mm": max(v["hd95_mm"] for v in ov) if ov else None,
        "abdominal_organs": organs,
        "abdominal_organ_assd_max_mm_corresponding": max(v["assd_mm"] for v in cv) if cv else None,
        "abdominal_organ_hd95_max_mm_corresponding": max(v["hd95_mm"] for v in cv) if cv else None,
        "abdominal_organs_corresponding": corr,
        "abdominal_organ_bowel_interposition_ml": interposed,
        "heart_dice": dget(groups.get("heart_id")),
        "medium_structure_dice_min": min(med.values()) if med else None,
        "medium_structure_dice": med,
        "esophagus_dice": dget(groups["esophagus"][0] if groups["esophagus"] else None),
        "vertebra_tre_median_mm": round(float(np.median(tv)), 3) if tv else None,
        "vertebra_tre_p90_mm": round(float(np.percentile(tv, 90)), 3) if tv else None,
        "vertebra_tre_max_mm": round(float(np.max(tv)), 3) if tv else None,
        "vertebra_landmarks_used": len(tv),
        "vertebra_tre_mm": {names[i]: round(v, 3) for i, v in sorted(tre.items())},
        "dice_by_structure": {names[i]: round(v, 4) for i, v in sorted(dice.items()) if v is not None},
        "abdominal_organ_far_surface": {o: v["far_surface"] for o, v in corr.items() if v and v.get("far_surface")},
        "measured_on": dict(METRIC_SOURCE),
    }


def jacobian_stats(jac_arr, region):
    j = jac_arr[region > 0]
    if not j.size:
        return {}
    return {"fold_fraction": float(np.mean(j <= 0)), "min": float(j.min()), "p01": float(np.percentile(j, 1)),
            "median": float(np.median(j)), "p99": float(np.percentile(j, 99)), "voxels": int(j.size)}


# ----------------------------------------------------------------------------------
# Sliding regions of the piecewise deformable stage, in the order they take precedence:
# name, label group that drives the similarity metric, label group whose reference voxels
# take this region's transform, HU window for the metric, SyN iterations, grid.
REGIONS = [
    ("lung", "lungs", "lungs", (-1000, 200), (100, 100, 70, 40), "lung"),
    ("viscera", "viscera_solid", "viscera", (-200, 400), (100, 70, 40), "body"),
]
MIN_REGION_ML = 150.0
SKIN_MARGIN_MM = 10.0


# Transforms: a stage is a list of ANTs transform files, or for the piecewise deformable
# stage a dict {"body": [...], "regions": [{"name", "tf": [...], "select": <mask on the
# reference grid>}, ...]}.
def blend_piecewise(body, regions, spacing, blend_mm, hard):
    """Compose piecewise resamples.

    `regions` is a list of (array, select_mask) in precedence order. Later regions win
    inside their mask, matching the previous hard switch. `hard` True (label maps) keeps
    that switch. `hard` False (linear CT) ramps across `blend_mm` at each mask boundary
    so the picture does not tear where two transforms meet.
    """
    out = np.array(body, dtype=np.float32, copy=True)
    if not regions:
        return out
    if hard or blend_mm <= 0:
        for arr, sel in regions:
            out = np.where(sel, arr, out)
        return out
    from scipy import ndimage
    sampling = tuple(float(x) for x in spacing)
    for arr, sel in regions:
        sel = np.asarray(sel, dtype=bool)
        if not sel.any():
            continue
        if sel.all():
            out = np.array(arr, dtype=np.float32, copy=True)
            continue
        dist_in = ndimage.distance_transform_edt(sel, sampling=sampling)
        dist_out = ndimage.distance_transform_edt(~sel, sampling=sampling)
        signed = dist_in - dist_out
        weight = np.clip((signed + blend_mm) / (2.0 * blend_mm), 0.0, 1.0).astype(np.float32)
        out = weight * np.asarray(arr, dtype=np.float32) + (1.0 - weight) * out
    return out


def apply_stage(ants, ref_img, mov_img, tf, interpolator, default, blend_mm=None):
    """Resample `mov_img` onto the grid of `ref_img` through one stage's transforms.

    Piecewise CT (linear) blends across BLEND_MM at each region boundary. Label maps
    stay a hard switch. Which labels drive which region is unchanged.
    """
    if blend_mm is None:
        blend_mm = BLEND_MM
    if isinstance(tf, dict):
        wb = ants.apply_transforms(ref_img, mov_img, tf["body"], interpolator=interpolator, defaultvalue=default)
        regs = tf.get("regions") or []
        if not regs:
            return wb
        hard = interpolator != "linear"
        pieces = []
        for reg in regs:
            w = ants.apply_transforms(ref_img, mov_img, reg["tf"], interpolator=interpolator, defaultvalue=default)
            pieces.append((w.numpy(), ants.image_read(reg["select"]).numpy() > 0))
        mixed = blend_piecewise(wb.numpy(), pieces, tuple(wb.spacing), 0.0 if hard else blend_mm, hard)
        return wb.new_image_like(mixed.astype(np.float32))
    return ants.apply_transforms(ref_img, mov_img, tf, interpolator=interpolator, defaultvalue=default)


def zyx(ants_img, dtype=None):
    a = np.transpose(ants_img.numpy(), (2, 1, 0))       # ants arrays are x, y, z
    return a.astype(dtype) if dtype is not None else a


# ----------------------------------------------------------------------------------
# QC panels (anatomy pixels only; titles carry labels and stage names, nothing else).
# Every view is shown in radiological convention: axial with anterior up and the
# patient's right on the viewer's left; coronal and sagittal with superior up; sagittal
# with anterior on the viewer's left. The volumes are RAS, so each slice is turned 180
# degrees in-plane.
def render_panels(out_png, ref_arr, stage_arrs, levels, title, body=None):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    def win(a, lo=-160, hi=240):
        return np.clip((a.astype(np.float32) - lo) / (hi - lo), 0, 1)

    def show(a):
        return np.rot90(a, 2)

    cols = ["reference"] + list(stage_arrs.keys()) + ["checker (deformable)", "difference (deformable)"]
    fig, axes = plt.subplots(len(levels), len(cols), figsize=(3.0 * len(cols), 3.1 * len(levels)))
    axes = np.atleast_2d(axes)
    last = list(stage_arrs.values())[-1]
    for r, (name, get) in enumerate(levels):
        ims = [get(ref_arr)] + [get(a) for a in stage_arrs.values()]
        rf, lf = get(ref_arr), get(last)
        tile = 24
        yy, xx = np.indices(rf.shape)
        chk = np.where(((yy // tile + xx // tile) % 2) == 0, rf, lf)
        diff = lf.astype(np.float32) - rf.astype(np.float32)
        if body is not None:
            diff = np.where(get(body) > 0, diff, 0.0)   # air and the scanner table are not anatomy
        for c, im in enumerate(ims + [chk]):
            ax = axes[r, c]; ax.imshow(show(win(im)), cmap="gray", aspect="equal")
            ax.set_xticks([]); ax.set_yticks([])
            if r == 0:
                ax.set_title(cols[c], fontsize=9)
        ax = axes[r, len(cols) - 1]
        ax.imshow(show(np.clip(diff, -200, 200)), cmap="RdBu_r", vmin=-200, vmax=200, aspect="equal")
        ax.set_xticks([]); ax.set_yticks([])
        if r == 0:
            ax.set_title(cols[-1], fontsize=9)
        axes[r, 0].set_ylabel(name, fontsize=9)
    fig.suptitle(title, fontsize=11)
    fig.tight_layout()
    fig.savefig(out_png, dpi=110)
    plt.close(fig)


# ----------------------------------------------------------------------------------
def register_pair(wd, ref, mov, names, groups, reg_iso_req, lung_iso_req, max_vox):
    """Register timepoint `mov` into the frame of `ref`. Returns transforms, metrics, artifacts."""
    import ants, SimpleITK as sitk
    from scipy import ndimage
    nn, lin_i = sitk.sitkNearestNeighbor, sitk.sitkLinear
    pair = f"{mov['label']}_to_{ref['label']}"
    pdir = os.path.join(wd, "pairs", pair); os.makedirs(pdir, exist_ok=True)
    t0 = time.time()
    fix_ct, mov_ct = sitk.ReadImage(ref["ct"]), sitk.ReadImage(mov["ct"])
    fix_lab, mov_lab = sitk.ReadImage(ref["labels"]), sitk.ReadImage(mov["labels"])
    ref_arr = sitk.GetArrayFromImage(fix_lab).astype(np.int16)
    spacing = np.array(fix_ct.GetSpacing())[::-1]  # array order z, y, x

    (fc, flc, fb), (mc, mlc, mb), common_v, zr = crop_common(fix_ct, mov_ct, fix_lab, mov_lab, groups["vertebrae"])
    log(f"{pair}: {len(common_v)} common vertebrae; crop z={None if zr is None else [round(z, 1) for z in zr]}")

    # 1) landmark rigid (fixed -> moving point mapping, ITK physical space)
    ft = landmark_table(ref["labels"], groups["vertebrae"] + groups["sternum"])
    mt = landmark_table(mov["labels"], groups["vertebrae"] + groups["sternum"])
    lm, lm_why = consistent_landmarks(ft, mt, groups["vertebrae"])
    st_ok, _ = consistent_landmarks(ft, mt, groups["sternum"])
    init = {"landmarks_consistent": [names[i] for i in lm],
            "landmarks_excluded": {names[i]: w for i, w in lm_why.items()}}
    R, t = np.eye(3), None
    if len(lm) >= 3:
        pts = lm + st_ok
        P = np.array([ft[i]["phys"] for i in pts]); Q = np.array([mt[i]["phys"] for i in pts])
        Rk, tk, res, kept = robust_rigid(P, Q, pts)
        if rotation_deg(Rk) <= 15.0:
            R, t = Rk, tk
            init.update({"method": "landmark rigid (Kabsch)", "points": [names[i] for i in kept],
                         "rotation_deg": round(rotation_deg(Rk), 2),
                         "residual_mm": {names[i]: round(float(r), 2) for i, r in zip(pts, res)},
                         "residual_median_mm": round(float(np.median([r for i, r in zip(pts, res) if i in lm])), 2)})
    if t is None:
        shared = [i for i in groups["vertebrae"] if i in ft and i in mt]
        if len(shared) >= 2:
            t = np.mean([mt[i]["phys"] - ft[i]["phys"] for i in shared], axis=0)
            init["method"] = f"translation from {len(shared)} vertebral centroids"
        else:
            bf = physical_centroids(body_mask_from(fix_ct), [1]); bm = physical_centroids(body_mask_from(mov_ct), [1])
            t = bm[1] - bf[1]
            init["method"] = "translation from the body centroid"
    init["translation_mm"] = [round(float(x), 2) for x in t]
    init_path = os.path.join(pdir, "init.mat")
    tx = ants.create_ants_transform(transform_type="AffineTransform", dimension=3,
                                    matrix=np.asarray(R, dtype=float), translation=tuple(float(x) for x in t))
    probe = np.asarray(fix_ct.TransformContinuousIndexToPhysicalPoint([s / 2.0 for s in fix_ct.GetSize()]))
    if np.linalg.norm(np.asarray(tx.apply_to_point(tuple(probe))) - (R @ probe + t)) > 0.01:
        raise RuntimeError("landmark transform does not map points as fitted")
    ants.write_transform(tx, init_path)
    log(f"{pair}: init {init['method']}" + (f", {init.get('rotation_deg')} deg, residual median {init.get('residual_median_mm')} mm"
                                            if "rotation_deg" in init else ""))

    # registration grids for the optimizer only; QC and outputs use the 1 mm reference grid
    reg_iso = budget_iso(fc, reg_iso_req, max_vox)

    def to_ants(img, iso, interp, default, tag):
        p = os.path.join(pdir, f"reg_{tag}.nii.gz")
        sitk.WriteImage(resample_iso(img, iso, interp, default), p)
        return ants.image_read(p)

    F = to_ants(sitk.Cast(fc, sitk.sitkFloat32), reg_iso, lin_i, -1024.0, "fixed")
    M = to_ants(sitk.Cast(mc, sitk.sitkFloat32), reg_iso, lin_i, -1024.0, "moving")
    Fcol = to_ants(mask_from_labels(flc, groups["vertebrae"], dilate_mm=3), reg_iso, nn, 0, "fixed_column")
    Mcol = to_ants(mask_from_labels(mlc, groups["vertebrae"], dilate_mm=3), reg_iso, nn, 0, "moving_column")
    log(f"{pair}: body grid {reg_iso} mm, fixed {F.shape}, moving {M.shape}")

    # 2) rigid refinement on the vertebral column
    tr = time.time()
    r_rig = ants.registration(F, M, type_of_transform="Rigid", initial_transform=[init_path],
                              mask=Fcol, moving_mask=Mcol, outprefix=os.path.join(pdir, "rigid_"),
                              aff_metric="mattes", aff_sampling=32, aff_random_sampling_rate=1.0,
                              aff_iterations=(500, 250, 100), aff_shrink_factors=(4, 2, 1),
                              aff_smoothing_sigmas=(2, 1, 0), mask_all_stages=True, random_seed=42, verbose=False)
    rigid_tf = r_rig["fwdtransforms"]
    if len(lm) >= 3 and "rotation_deg" in init:
        # residual_median_mm above is over the consistent vertebrae only, the same set used here
        rt = ants.read_transform(rigid_tf[0])
        rr = [float(np.linalg.norm(np.asarray(rt.apply_to_point(tuple(ft[i]["phys"]))) - mt[i]["phys"])) for i in lm]
        init["after_refinement_residual_median_mm"] = round(float(np.median(rr)), 2)
        if np.median(rr) > init["residual_median_mm"] + 2.0:
            rigid_tf = [init_path]
            init["refinement"] = "rejected: moved the consistent landmarks by more than 2 mm; landmark rigid kept"
    t_rig = time.time() - tr

    # 3) deformable, piecewise: each sliding region (lungs, abdominal viscera) gets its own
    #    deformation, the rest of the body (wall, skeleton, mediastinum) one more
    def vol_ml(lab, ids):
        return float(np.isin(sitk.GetArrayFromImage(lab), ids).sum()) * float(np.prod(lab.GetSpacing())) / 1000.0

    regions = []
    for name, metric_key, select_key, win, iters, grid in REGIONS:
        m_ids, s_ids = groups.get(metric_key) or [], groups.get(select_key) or []
        if m_ids and vol_ml(flc, m_ids) >= MIN_REGION_ML and vol_ml(mlc, m_ids) >= MIN_REGION_ML:
            regions.append({"name": name, "metric_ids": m_ids, "select_ids": s_ids, "window": win, "iters": iters,
                            "iso_req": lung_iso_req if grid == "lung" else reg_iso_req})
    # the skin edge drives the body warp only if the metric sees both sides of it: the body
    # metric masks reach 10 mm into the air (where the table has been removed)
    body_f, body_m = dilate_mask(fb, SKIN_MARGIN_MM), dilate_mask(mb, SKIN_MARGIN_MM)
    for rg in regions:
        body_f = mask_minus(body_f, mask_from_labels(flc, rg["select_ids"], erode_mm=5))
        body_m = mask_minus(body_m, mask_from_labels(mlc, rg["select_ids"], erode_mm=5))
    Fbm = to_ants(body_f, reg_iso, nn, 0, "fixed_bodymask")
    Mbm = to_ants(body_m, reg_iso, nn, 0, "moving_bodymask")
    tr = time.time()
    fixed_notable, fixed_table = without_table(sitk.Cast(fc, sitk.sitkFloat32), fb)
    moving_notable, moving_table = without_table(sitk.Cast(mc, sitk.sitkFloat32), mb)
    log(f"{pair}: table fixed detached {fixed_table.get('table_detached_ml')} ml fused {fixed_table.get('table_fused')}; "
        f"moving detached {moving_table.get('table_detached_ml')} ml fused {moving_table.get('table_fused')}")
    Fnt = to_ants(fixed_notable, reg_iso, lin_i, -1024.0, "fixed_notable")
    Mnt = to_ants(moving_notable, reg_iso, lin_i, -1024.0, "moving_notable")
    r_body = ants.registration(Fnt, Mnt, type_of_transform="SyNOnly", initial_transform=rigid_tf,
                               mask=Fbm, moving_mask=Mbm, outprefix=os.path.join(pdir, "body_"),
                               syn_metric="CC", syn_sampling=2, reg_iterations=(100, 70, 40),
                               flow_sigma=3, total_sigma=0, grad_step=0.2, mask_all_stages=True,
                               random_seed=42, verbose=False)
    t_body = time.time() - tr
    pad = int(round(10.0 / fc.GetSpacing()[0]))
    for rg in regions:
        name, (lo, hi) = rg["name"], rg["window"]
        f_dil = mask_from_labels(flc, rg["metric_ids"], dilate_mm=5)
        m_dil = mask_from_labels(mlc, rg["metric_ids"], dilate_mm=5)
        # the region's own domain: the fixed selection region plus its metric mask, + 10 mm
        dom = sitk.Or(f_dil, mask_from_labels(flc, rg["select_ids"], dilate_mm=5))
        st = sitk.LabelShapeStatisticsImageFilter(); st.Execute(dom)
        bb = st.GetBoundingBox(1)
        idx = [max(0, bb[k] - pad) for k in range(3)]
        size = [min(fc.GetSize()[k] - idx[k], bb[k + 3] + 2 * pad) for k in range(3)]
        iso = budget_iso(sitk.RegionOfInterest(fc, size, idx), rg["iso_req"], max_vox)
        FR = to_ants(window(sitk.RegionOfInterest(fc, size, idx), lo, hi), iso, lin_i, float(lo), f"fixed_{name}win")
        MR = to_ants(window(mc, lo, hi), iso, lin_i, float(lo), f"moving_{name}win")
        FRm = to_ants(sitk.RegionOfInterest(f_dil, size, idx), iso, nn, 0, f"fixed_{name}mask")
        MRm = to_ants(m_dil, iso, nn, 0, f"moving_{name}mask")
        rg["FRsel"] = to_ants(sitk.RegionOfInterest(mask_from_labels(flc, rg["select_ids"]), size, idx), iso, nn, 0, f"fixed_{name}sel")
        rg["FR"], rg["grid"] = FR, iso
        log(f"{pair}: {name} grid {iso} mm, fixed {FR.shape}")
        tr = time.time()
        rg["r"] = ants.registration(FR, MR, type_of_transform="SyNOnly", initial_transform=rigid_tf,
                                    mask=FRm, moving_mask=MRm, outprefix=os.path.join(pdir, f"{name}_"),
                                    syn_metric="CC", syn_sampling=2, reg_iterations=rg["iters"],
                                    flow_sigma=3, total_sigma=0, grad_step=0.2, mask_all_stages=True,
                                    random_seed=42, verbose=False)
        rg["seconds"] = time.time() - tr
        # the selection mask lives on the full 1 mm reference grid
        rg["select"] = os.path.join(pdir, f"{name}_select.nii.gz")
        sitk.WriteImage(mask_from_labels(fix_lab, rg["select_ids"]), rg["select"])
    log(f"{pair}: rigid {t_rig:.0f}s, body SyN {t_body:.0f}s, "
        + ", ".join(f"{rg['name']} SyN {rg['seconds']:.0f}s" for rg in regions))

    deform = {"body": r_body["fwdtransforms"],
              "regions": [{"name": rg["name"], "tf": rg["r"]["fwdtransforms"], "select": rg["select"]} for rg in regions]}
    stages = {"initial": [init_path], "rigid": rigid_tf, "deformable": deform}

    # QC on the full 1 mm reference grid
    REF = ants.image_read(ref["ct"]); MOVLAB = ants.image_read(mov["labels"]); MOVCT = ants.image_read(mov["ct"])
    ones = ants.image_clone(MOVCT) * 0 + 1
    cover = zyx(apply_stage(ants, REF, ones, deform, "nearestNeighbor", 0))
    zmask = np.ones_like(ref_arr, dtype=bool)
    if zr is not None:
        zz = np.array([fix_ct.TransformIndexToPhysicalPoint((0, 0, k))[2] for k in range(fix_ct.GetSize()[2])])
        zmask = np.broadcast_to(((zz >= zr[0]) & (zz <= zr[1]))[:, None, None], ref_arr.shape)
    valid = (cover > 0) & zmask
    zv = np.flatnonzero(valid.any(axis=(1, 2)))
    zwin = (int(zv[0]) + 5, int(zv[-1]) - 5)
    metrics, warped_ct = {}, {}
    ref_ct_np = sitk.GetArrayFromImage(fix_ct)
    for st, tl in stages.items():
        wl = apply_stage(ants, REF, MOVLAB, tl, "genericLabel", 0)
        metrics[st] = stage_metrics(ref_arr, zyx(wl, np.int16), valid, names, groups, spacing, lm, zwin)
        # The skin is the outline of the resampled CT. Warping the binary body mask through the
        # piecewise transforms tears it at the lung and viscera boundaries, and that torn mask
        # reported a distance the CT itself does not have.
        wct = apply_stage(ants, REF, MOVCT, tl, "linear", -1024)
        warped_ct[st] = zyx(wct)
        # label-free second opinion: CT intensity correlation inside the lungs, the viscera and the body
        metrics[st]["image_agreement_ncc"] = {
            "lungs": image_agreement(ref_ct_np, warped_ct[st], np.isin(ref_arr, groups["lungs"]), valid, zwin, lo=-1024.0, hi=-200.0),
            "viscera": image_agreement(ref_ct_np, warped_ct[st], np.isin(ref_arr, groups["viscera"]), valid, zwin, lo=-200.0, hi=300.0),
            "body": image_agreement(ref_ct_np, warped_ct[st], ref_ct_np > -300, valid, zwin),
            "gated": False,
            "note": "CT intensity correlation, no labels. Reported beside the surface metrics. No threshold is set."}
        skin = ct_body_surface(fix_ct, warped_ct[st], valid, spacing, zwin)
        metrics[st].update({"body_surface_assd_mm": skin["assd_mm"] if skin else None,
                            "body_surface_hd95_mm": skin["hd95_mm"] if skin else None,
                            "body_surface": skin})
        if st == "deformable":
            ants.image_write(wl, os.path.join(pdir, f"{mov['label']}_labels_in_{ref['label']}.nii.gz"))
            ants.image_write(wct, os.path.join(pdir, f"{mov['label']}_ct_in_{ref['label']}.nii.gz"))
        m = metrics[st]
        log(f"{pair} {st:>10}: spine ASSD {m['spine_assd_mm']} HD95 {m['spine_hd95_mm']}, lungs Dice min {m['lung_dice_min']} "
            f"ASSD max {m['lung_assd_max_mm']} HD95 max {m['lung_hd95_max_mm']}, liver/spleen ASSD max "
            f"{m['abdominal_organ_assd_max_mm']} HD95 max {m['abdominal_organ_hd95_max_mm']} (corresponding "
            f"{m['abdominal_organ_hd95_max_mm_corresponding']}, bowel in organ {m['abdominal_organ_bowel_interposition_ml']} ml), vertebra TRE median "
            f"{m['vertebra_tre_median_mm']} ({m['vertebra_landmarks_used']}), heart {m['heart_dice']}, "
            f"medium min {m['medium_structure_dice_min']}, skin ASSD {m['body_surface_assd_mm']} HD95 {m['body_surface_hd95_mm']}")

    # Jacobian of each deformation inside the region it governs
    jb = ants.create_jacobian_determinant_image(F, r_body["fwdtransforms"][0], do_log=False)
    ants.image_write(jb, os.path.join(pdir, "jacobian_body.nii.gz"))
    jac = {"body": jacobian_stats(jb.numpy(), Fbm.numpy())}
    vert_reg = to_ants(mask_from_labels(flc, groups["vertebrae"]), reg_iso, nn, 0, "fixed_vertebrae").numpy()
    b = jb.numpy()[vert_reg > 0]; b = b[b > 0]
    for rg in regions:
        jr = ants.create_jacobian_determinant_image(rg["FR"], rg["r"]["fwdtransforms"][0], do_log=False)
        ants.image_write(jr, os.path.join(pdir, f"jacobian_{rg['name']}.nii.gz"))
        jac[rg["name"]] = jacobian_stats(jr.numpy(), rg["FRsel"].numpy())
    jv = [v for v in jac.values() if v]
    metrics["deformable"].update({
        "jacobian_fold_fraction": max(v["fold_fraction"] for v in jv) if jv else None,
        "jacobian_p01": min(v["p01"] for v in jv) if jv else None,
        "jacobian_p99": max(v["p99"] for v in jv) if jv else None,
        "bone_abs_logjac_p95": float(np.percentile(np.abs(np.log(b)), 95)) if b.size else None,
        "jacobian_by_region": jac,
    })
    log(f"{pair}: Jacobian fold {metrics['deformable']['jacobian_fold_fraction']:.2e}, "
        f"p01 {metrics['deformable']['jacobian_p01']:.3f}, p99 {metrics['deformable']['jacobian_p99']:.3f}, "
        f"bone |log J| p95 {metrics['deformable']['bone_abs_logjac_p95']}")

    # QC panels: three vertebral levels, a coronal through the vertebral bodies and a
    # sagittal through the spine
    fa = np.where(valid, ref_arr, 0)
    present = np.bincount(fa.ravel(), minlength=max(names) + 1)
    vc = component_centroids(fa, [i for i in groups["vertebrae"] if present[i] > 0])
    levels = []
    order = sorted(vc.items(), key=lambda kv: kv[1][0])
    for q in (0.2, 0.5, 0.8):
        if order:
            i, c = order[min(len(order) - 1, int(q * (len(order) - 1)))]
            levels.append((names[i], (lambda a, k=int(round(c[0])): a[k])))
    if order:
        ycor = int(round(np.mean([c[1] for _, c in order])))
        xsag = int(round(np.mean([c[2] for _, c in order])))
        levels.append(("coronal", (lambda a, y=ycor: a[:, y, :])))
        levels.append(("sagittal", (lambda a, x=xsag: a[:, :, x])))
    ref_ct_arr = ref_ct_np
    # ct_body_surface keeps its mask local. The difference panel needs the reference
    # outline in this function, or the job dies here after the warp is already written.
    ref_body = sitk.GetArrayFromImage(body_mask_from(fix_ct)).astype(np.uint8)
    png = os.path.join(pdir, f"qc_{pair}.png")
    render_panels(png, ref_ct_arr, {k: warped_ct[k] for k in ("initial", "rigid", "deformable")},
                  levels, f"{pair}: registration stages",
                  body=ndimage.binary_dilation(ref_body > 0, iterations=5))

    # keep the transforms with stable names; apply order for each list is as written
    keep = {"init": "init.mat"}
    shutil.copy(rigid_tf[0], os.path.join(pdir, "rigid.mat")); keep["rigid"] = "rigid.mat"
    apply = {}
    for tag, r in [("body", r_body)] + [(rg["name"], rg["r"]) for rg in regions]:
        w = [x for x in r["fwdtransforms"] if x.endswith("Warp.nii.gz")]
        a = [x for x in r["fwdtransforms"] if x.endswith(".mat")]
        iw = [x for x in r["invtransforms"] if x.endswith("InverseWarp.nii.gz")]
        if w:
            shutil.copy(w[0], os.path.join(pdir, f"{tag}_warp.nii.gz")); keep[f"{tag}_warp"] = f"{tag}_warp.nii.gz"
        if a:
            shutil.copy(a[0], os.path.join(pdir, f"{tag}_affine.mat")); keep[f"{tag}_affine"] = f"{tag}_affine.mat"
        if iw:
            shutil.copy(iw[0], os.path.join(pdir, f"{tag}_inverse_warp.nii.gz")); keep[f"{tag}_inverse_warp"] = f"{tag}_inverse_warp.nii.gz"
        apply[tag] = {"transforms": [f"{tag}_warp.nii.gz", f"{tag}_affine.mat"]}
    for rg in regions:
        keep[f"{rg['name']}_select"] = f"{rg['name']}_select.nii.gz"
        apply[rg["name"]]["select"] = f"{rg['name']}_select.nii.gz"
    return {
        "pair": pair, "moving": mov["label"], "reference": ref["label"], "init": init,
        "registration_grid_mm": {"body": reg_iso, **{rg["name"]: rg["grid"] for rg in regions}},
        "crop_z_mm": None if zr is None else [round(z, 1) for z in zr],
        "deformable_model": ("piecewise: a reference voxel inside a region's select mask takes that region's "
                             "transforms (" + ", ".join(rg["name"] for rg in regions) + "); every other voxel takes "
                             "the body transforms. Linear CT blends across " + str(BLEND_MM) +
                             " mm at each mask boundary. Label maps stay a hard switch."
                             if regions else "single body transform"),
        "blend_mm": BLEND_MM,
        "table": {"fixed": fixed_table, "moving": moving_table},
        "apply": apply,
        "seconds": {"rigid": round(t_rig, 1), "body": round(t_body, 1),
                    **{rg["name"]: round(rg["seconds"], 1) for rg in regions}, "total": round(time.time() - t0, 1)},
        "metrics": metrics, "transforms": keep, "stages_fwd": stages,
        "valid_fraction": round(float(valid.mean()), 4),
        "artifacts": {"qc_png": os.path.basename(png),
                      "jacobians": [f"jacobian_{t}.nii.gz" for t in ["body"] + [rg["name"] for rg in regions]
                                    if os.path.exists(os.path.join(pdir, f"jacobian_{t}.nii.gz"))],
                      "warped_ct": f"{mov['label']}_ct_in_{ref['label']}.nii.gz",
                      "warped_labels": f"{mov['label']}_labels_in_{ref['label']}.nii.gz"},
        "dir": pdir,
    }


def leg_report(trans, pairs):
    """Name the structure and the hop where the triangle is weakest.

    `trans` is the composed-path versus direct-path Dice. `pairs` are the hops already
    measured. The pair with the lowest Dice on that structure is the weakest leg.
    """
    if not trans:
        return trans
    td = trans.get("dice_by_target") or {}
    if not td:
        trans["weakest_target"] = None
        return trans
    structure = min(td, key=lambda k: td[k])
    trans["weakest_target"] = {"structure": structure, "composed_vs_direct_dice": td[structure]}

    def pair_dice(row):
        metrics = ((row.get("metrics") or {}).get("deformable") or {})
        if structure == "spine":
            return metrics.get("spine_dice")
        if structure in ("lung_left", "lung_right"):
            lung = (metrics.get("lungs") or {}).get(structure) or {}
            return lung.get("dice")
        by_name = (metrics.get("dice_by_structure") or {}).get(structure)
        if by_name is not None:
            return by_name
        organ = (metrics.get("abdominal_organs") or {}).get(structure) or {}
        return organ.get("dice")

    legs = [{"pair": row.get("pair"), "dice": pair_dice(row)} for row in pairs]
    known = [leg for leg in legs if isinstance(leg.get("dice"), (int, float))]
    trans["legs"] = legs
    if known:
        worst = min(known, key=lambda leg: leg["dice"])
        trans["weakest_leg"] = {
            "structure": structure,
            "pair": worst["pair"],
            "pair_dice": worst["dice"],
            "composed_vs_direct_dice": td[structure],
            "reading": ("The composed path and the direct path disagree most on this structure. "
                        "The pair named is the hop with the lowest Dice for it."),
        }
    return trans


def transitivity(ref, mid, last, pr_mid_ref, pr_last_mid, pr_last_ref, names, groups):
    """Agreement of last->mid->ref (two resamplings) with last->ref (direct). The gated value
    is over the structures the pipeline claims to align (each lung, the whole spine with
    vertebra labels merged, heart, aorta, trachea, esophagus, liver, spleen, kidneys); the
    value over every labeled structure, which also counts the arms and shoulder girdle
    (they move with arm position), hollow viscera (their content changes) and single
    vertebra labels (their boundaries can differ between scans), is reported beside it."""
    import ants
    REF = ants.image_read(ref["ct"]); MID = ants.image_read(mid["ct"]); LASTLAB = ants.image_read(last["labels"])
    via_mid = apply_stage(ants, MID, LASTLAB, pr_last_mid["stages_fwd"]["deformable"], "genericLabel", 0)
    via = apply_stage(ants, REF, via_mid, pr_mid_ref["stages_fwd"]["deformable"], "genericLabel", 0)
    direct = apply_stage(ants, REF, LASTLAB, pr_last_ref["stages_fwd"]["deformable"], "genericLabel", 0)
    a = zyx(via, np.int16); b = zyx(direct, np.int16)
    ids = [i for i in names if (a == i).sum() > 200 and (b == i).sum() > 200]
    d = dice_table(a, b, ids)
    vals = [v for v in d.values() if v is not None]
    targets = {"lung_left": groups["lung_left"], "lung_right": groups["lung_right"], "spine": groups["vertebrae"]}
    for n in ("heart", "aorta", "trachea", "esophagus", "liver", "spleen", "kidney_left", "kidney_right"):
        targets[n] = [i for i, nm in names.items() if nm == n]
    td = {}
    for key, tids in targets.items():
        A = np.isin(a, tids); B = np.isin(b, tids)
        if tids and A.sum() >= 500 and B.sum() >= 500:
            td[key] = round(float(2.0 * (A & B).sum() / (A.sum() + B.sum())), 4)
    tv = list(td.values())
    return {"path": f"{last['label']}->{mid['label']}->{ref['label']} vs {last['label']}->{ref['label']}",
            "dice_median": round(float(np.median(tv)), 4) if tv else None,
            "dice_min": round(float(min(tv)), 4) if tv else None,
            "dice_by_target": td,
            "all_structures": {"n_structures": len(vals),
                               "dice_median": round(float(np.median(vals)), 4) if vals else None,
                               "dice_p10": round(float(np.percentile(vals, 10)), 4) if vals else None,
                               "worst": sorted(({"structure": names[i], "dice": round(v, 4)} for i, v in d.items() if v is not None),
                                               key=lambda x: x["dice"])[:5]}}


def write_job_status(workdir, payload):
    """Status beside the workdir. /tmp is wiped when the GPU VM powers off. This file is not."""
    path = os.path.join(workdir, "status.json")
    tmp = path + ".tmp"
    payload = dict(payload)
    payload["updated_unix_ms"] = int(time.time() * 1000)
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, path)


def lung_report_files(ct_path, labels_path, groups):
    """Lung volume, aerated mass and lobe volumes of one scan, on its native 1 mm grid."""
    import SimpleITK as sitk
    ci, li = sitk.ReadImage(ct_path), sitk.ReadImage(labels_path)
    return lung_volume.lung_report(sitk.GetArrayFromImage(ci), sitk.GetArrayFromImage(li), ci.GetSpacing()[::-1], groups)


def engine_identity():
    import hashlib
    def sha(path):
        if not os.path.isfile(path):
            return None
        h = hashlib.sha256()
        with open(path, "rb") as f:
            h.update(f.read())
        return h.hexdigest()
    here = os.path.dirname(os.path.abspath(__file__))
    return {
        "engine_sha256": sha(os.path.abspath(__file__)),
        "frame_contract_sha256": sha(os.path.join(here, "frame_contract.py")),
        "lung_volume_sha256": sha(os.path.join(here, "lung_volume.py")),
        "image_digest": os.environ.get("IMAGE_DIGEST") or os.environ.get("REGISTER_IMAGE_DIGEST"),
        "image_tag": os.environ.get("IMAGE_TAG") or os.environ.get("REGISTER_IMAGE_TAG"),
    }


# ----------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wallet", default=os.getenv("WALLET"))
    ap.add_argument("--job-id", default=os.getenv("JOB_ID", "register-" + str(int(time.time()))))
    ap.add_argument("--anatomy", default=os.getenv("ANATOMY", "chest"))
    ap.add_argument("--timepoints", default=os.getenv("TIMEPOINTS"))
    ap.add_argument("--reference", default=os.getenv("REFERENCE", ""))
    ap.add_argument("--protocol-mode", default=os.getenv("PROTOCOL_MODE", "auto"))
    ap.add_argument("--src-bucket", default=os.getenv("IMAGING_BUCKET", "genobank-health-imaging"))
    ap.add_argument("--out-bucket", default=os.getenv("OUTPUT_BUCKET", "genobank-health-imaging"))
    ap.add_argument("--workdir", default=os.getenv("WORKDIR", "/scratch/register"))
    ap.add_argument("--no-upload", action="store_true", default=os.getenv("NO_UPLOAD") == "1")
    args = ap.parse_args()
    threads = int(os.getenv("ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS", str(os.cpu_count() or 8)))
    os.environ["ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS"] = str(threads)
    if not args.wallet or not args.timepoints:
        print("REGISTER_RESULT " + json.dumps({"status": "error", "error": "wallet and timepoints required"})); sys.exit(2)
    tps = []
    for i, t in enumerate(json.loads(args.timepoints)):
        lbl = re.sub(r"[^A-Za-z0-9_]", "_", str(t.get("label") or f"t{i}")) or f"t{i}"
        tps.append({"label": lbl, "study": t["study"], "series": t["series"]})
    if len(tps) < 2 or len({t["label"] for t in tps}) != len(tps):
        print("REGISTER_RESULT " + json.dumps({"status": "error", "error": "need >= 2 timepoints with distinct labels"})); sys.exit(2)
    ref = next((t for t in tps if t["label"] == args.reference), tps[0])
    reg_iso = float(os.getenv("REG_ISO_MM", "1.5"))
    lung_iso = float(os.getenv("REG_ISO_LUNG_MM", "1.5"))
    max_vox = int(os.getenv("MAX_REG_VOX", "24000000"))

    wd = os.path.join(args.workdir, args.job_id); os.makedirs(wd, exist_ok=True)
    identity = engine_identity()
    write_job_status(wd, {"job_id": args.job_id, "status": "running", "schema": SCHEMA})
    gates = gates_for(args.anatomy)
    manifest = {"schema": SCHEMA, "job_id": args.job_id, "wallet": args.wallet, "anatomy": args.anatomy,
                "reference": ref["label"], "protocol_mode_requested": args.protocol_mode,
                "timepoints": [], "pairs": [], "gate": {}, "status": "running",
                "disclaimer": "Decision-support only, not a diagnosis. Registration quality report for clinician and pipeline use.",
                "acceptance_criteria": [dict(zip(("stage", "metric", "op", "threshold", "severity", "meaning"), g)) for g in gates],
                "display_convention": "QC panels: radiological (axial anterior up, patient right on the viewer's left; "
                                      "coronal and sagittal superior up; sagittal anterior on the viewer's left)"}
    t0 = time.time()
    try:
        import SimpleITK as sitk, ants, totalsegmentator
        manifest["software"] = {"SimpleITK": sitk.Version.VersionString(), "antspyx": getattr(ants, "__version__", "?"),
                                "TotalSegmentator": getattr(totalsegmentator, "__version__", "2.x"), "threads": threads,
                                **identity}
        names = None
        for t in tps:
            tdir = os.path.join(wd, t["label"])
            dcm = stage_series(args.src_bucket, args.wallet, t["study"], t["series"], os.path.join(tdir, "dcm"))
            t["protocol"] = read_protocol(dcm)
            raw = dcm_to_nifti(dcm, os.path.join(tdir, "raw.nii.gz"))
            t["ct"] = preprocess(raw, os.path.join(tdir, "ct.nii.gz"), iso=float(os.getenv("ISO_MM", "1.0")))
            t["labels"], names = segment(t["ct"], os.path.join(tdir, "labels.nii.gz"))
            os.remove(raw)
        groups = {
            "vertebrae": sorted(ids_matching(names, r"^vertebrae_[CTL]\d+$")),
            "sternum": ids_matching(names, r"^sternum$"),
            "lungs": ids_matching(names, r"^lung_"),
            "lung_left": ids_matching(names, r"^lung_.*_left$"),
            "lung_right": ids_matching(names, r"^lung_.*_right$"),
            "medium": ids_matching(names, r"^(aorta|trachea)$"),
            "esophagus": ids_matching(names, r"^esophagus$"),
            "heart_id": (ids_matching(names, r"^heart$") or [None])[0],
            "liver": ids_matching(names, r"^liver$"),
            "spleen": ids_matching(names, r"^spleen$"),
            "bowel": ids_matching(names, r"^(stomach|duodenum|small_bowel|colon)$"),
            # the viscera that move with the diaphragm: heart, inferior vena cava and the solid
            # abdominal organs drive this deformation; hollow organs follow it
            "viscera_solid": ids_matching(names, r"^(heart|inferior_vena_cava|liver|spleen|pancreas|gallbladder|kidney_(left|right)"
                                                 r"|kidney_cyst_(left|right)|adrenal_gland_(left|right)|portal_vein_and_splenic_vein)$"),
            "viscera": ids_matching(names, r"^(heart|inferior_vena_cava|liver|spleen|pancreas|gallbladder|kidney_(left|right)"
                                            r"|kidney_cyst_(left|right)|adrenal_gland_(left|right)|portal_vein_and_splenic_vein"
                                            r"|stomach|duodenum|small_bowel|colon)$"),
        }
        for t in tps:
            cmp = compare_protocols(ref["protocol"], t["protocol"]) if t is not ref else {"comparability": "reference", "differences_hard": [], "differences_soft": []}
            manifest["timepoints"].append({"label": t["label"], "study_uid": t["study"], "series_uid": t["series"],
                                           "protocol": t["protocol"], "versus_reference": cmp})
        cross = any(tp["versus_reference"]["comparability"] == "cross" for tp in manifest["timepoints"])
        mode = args.protocol_mode if args.protocol_mode in ("same", "cross") else ("cross" if cross else "same")
        manifest["protocol_mode"] = mode
        manifest["voxel_comparison_assessable"] = (mode == "same")

        # lung volume of every scan on its native grid, so a change of lung volume can be told from a breath
        lung_groups = {"lung_left": groups["lung_left"], "lung_right": groups["lung_right"],
                       "lobes": {nm: ids_matching(names, rf"^{nm}$") for nm in lung_volume.LUNG_LOBES}}
        lung_reports, lung_error = {}, None
        try:
            for t in tps:
                lung_reports[t["label"]] = lung_report_files(t["ct"], t["labels"], lung_groups)
        except Exception as lung_exc:
            lung_reports, lung_error = {}, f"{type(lung_exc).__name__}: {lung_exc}"[:300]
            log("lung volume report not computed", lung_error)
        manifest["lung_volume"] = {"params": lung_volume.LUNG_CHANGE_PARAMS, "per_timepoint": lung_reports,
                                   "comparisons": {}, "error": lung_error,
                                   "reading": ("Native-space lung volume and the mass of the aerated lung per scan. A breath "
                                               "changes the volume but not the mass; a change of mass, or of one lung alone, "
                                               "is not explained by the breath. Decision support, not a diagnosis.")}

        # every non-reference timepoint into the reference frame; with >= 3 timepoints also
        # last -> middle so the transitivity check can compare two independent paths
        others = [t for t in tps if t is not ref]
        results = {}
        for t in others:
            results[(t["label"], ref["label"])] = register_pair(wd, ref, t, names, groups, reg_iso, lung_iso, max_vox)
        trans = None
        if len(tps) >= 3:
            mid, last = tps[-2], tps[-1]                  # chronological as given
            if mid is not ref and last is not ref:
                results[(last["label"], mid["label"])] = register_pair(wd, mid, last, names, groups, reg_iso, lung_iso, max_vox)
                trans = transitivity(ref, mid, last, results[(mid["label"], ref["label"])],
                                     results[(last["label"], mid["label"])], results[(last["label"], ref["label"])], names, groups)
                log(f"transitivity {trans['path']}: target median Dice {trans['dice_median']}, min {trans['dice_min']} "
                    f"{trans['dice_by_target']}; all structures median {trans['all_structures']['dice_median']}")
        manifest["transitivity"] = trans

        verdicts = []
        protos = {t["label"]: t["protocol"] for t in tps}
        for key, pr in results.items():
            lc = None
            if key[0] in lung_reports and key[1] in lung_reports:
                comparable, why_not, caveat = lung_mass_comparability(protos[key[1]], protos[key[0]])
                lc = lung_volume.compare_lung_volume(lung_reports[key[1]], lung_reports[key[0]], mass_comparable=comparable,
                                                     mass_withheld_reason=why_not, mass_caveat=caveat)
                manifest["lung_volume"]["comparisons"][pr["pair"]] = lc
                log(f"{pr['pair']} lung volume: {lc['explanation']}")
            v, checks, hard, soft = evaluate_gate(pr["metrics"], trans if key[1] == ref["label"] else None, gates,
                                                  protocol_mode=mode, lung_change=lc)
            pr["gate"] = {"verdict": v, "checks": checks, "hard_failures": hard, "warnings": soft,
                          "not_computed": [f"{c['stage']}.{c['metric']}" for c in checks if c.get("pass") is None],
                          "lung_gate_downgraded": any(c.get("downgraded_from") for c in checks)}
            verdicts.append(v)
            manifest["pairs"].append({k: pr[k] for k in ("pair", "moving", "reference", "init", "registration_grid_mm",
                                                         "crop_z_mm", "deformable_model", "blend_mm", "table", "apply",
                                                         "seconds", "metrics", "transforms", "valid_fraction",
                                                         "artifacts", "gate")})
            log(f"GATE {pr['pair']}: {v} {('hard: ' + '; '.join(hard)) if hard else ''} {('warn: ' + '; '.join(soft)) if soft else ''}")
        overall = "FAIL" if "FAIL" in verdicts else ("PASS_WITH_WARNINGS" if "PASS_WITH_WARNINGS" in verdicts else "PASS")
        manifest["gate"] = {"verdict": overall, "by_pair": {pr["pair"]: pr["gate"]["verdict"] for pr in results.values()}}
        manifest["transitivity"] = leg_report(trans, manifest["pairs"])
        if mode == "cross":
            manifest["gate"]["note"] = ("cross-protocol: geometry is registered, but voxel intensities are not "
                                        "comparable; use structure- and lesion-level comparison only. "
                                        "A skin warning on this pair is the expected rim. The skin threshold is unchanged.")
        try:
            import frame_contract
            manifest["consumers"] = frame_contract.advise_all(manifest)
        except Exception as hook_error:
            log("consumer contract not written", hook_error)
            manifest["consumers_error"] = str(hook_error)[:300]

        # outputs: reference-frame stack + per-pair artifacts
        out = os.path.join(wd, "out"); os.makedirs(out, exist_ok=True)
        os.makedirs(os.path.join(out, "frame"), exist_ok=True)
        shutil.copy(ref["ct"], os.path.join(out, "frame", f"{ref['label']}_ct.nii.gz"))
        shutil.copy(ref["labels"], os.path.join(out, "frame", f"{ref['label']}_labels.nii.gz"))
        for t in tps:
            os.makedirs(os.path.join(out, "native", t["label"]), exist_ok=True)
            shutil.copy(t["ct"], os.path.join(out, "native", t["label"], "ct.nii.gz"))
            shutil.copy(t["labels"], os.path.join(out, "native", t["label"], "labels.nii.gz"))
        for pr in results.values():
            pd = os.path.join(out, "pairs", pr["pair"]); os.makedirs(pd, exist_ok=True)
            for f in list(pr["transforms"].values()) + [pr["artifacts"]["qc_png"], pr["artifacts"]["warped_ct"],
                                                        pr["artifacts"]["warped_labels"]] + pr["artifacts"]["jacobians"]:
                shutil.copy(os.path.join(pr["dir"], f), os.path.join(pd, f))
            if pr["reference"] == ref["label"]:
                shutil.copy(os.path.join(pr["dir"], pr["artifacts"]["warped_ct"]), os.path.join(out, "frame", f"{pr['moving']}_ct.nii.gz"))
                shutil.copy(os.path.join(pr["dir"], pr["artifacts"]["warped_labels"]), os.path.join(out, "frame", f"{pr['moving']}_labels.nii.gz"))
        manifest["label_names"] = {str(k): v for k, v in sorted(names.items())}
        manifest["elapsed_sec"] = round(time.time() - t0, 1)
        manifest["status"] = "done"
        write_job_status(wd, {"job_id": args.job_id, "status": "done", "schema": SCHEMA,
                              "gate": manifest.get("gate"), "output_dir": os.path.join(wd, "out")})
        out_prefix = f"gs://{args.out_bucket}/{args.wallet}/imaging-register/{args.job_id}/"
        if not args.no_upload:
            manifest["output_gcs"] = out_prefix
        with open(os.path.join(out, "manifest.json"), "w") as f:
            json.dump(manifest, f, indent=2)
        if not args.no_upload:
            sh(["gcloud", "storage", "cp", "--recursive", out + "/*", out_prefix], stdout=subprocess.DEVNULL)
        log("DONE", out_prefix if not args.no_upload else out)
        print("REGISTER_RESULT " + json.dumps({
            "status": "done", "schema": SCHEMA, "job_id": args.job_id, "output_gcs": manifest.get("output_gcs"),
            "reference": ref["label"], "protocol_mode": mode, "gate": manifest["gate"],
            "pairs": [{"pair": p["pair"], "verdict": p["gate"]["verdict"], "hard_failures": p["gate"]["hard_failures"],
                       "warnings": p["gate"]["warnings"],
                       "deformable": {k: p["metrics"]["deformable"].get(k) for k in
                                      ("spine_assd_mm", "spine_hd95_mm", "lung_dice_min", "lung_hd95_max_mm",
                                       "abdominal_organ_assd_max_mm", "abdominal_organ_hd95_max_mm",
                                       "abdominal_organ_assd_max_mm_corresponding", "abdominal_organ_hd95_max_mm_corresponding",
                                       "abdominal_organ_bowel_interposition_ml", "body_surface_assd_mm", "body_surface_hd95_mm",
                                       "vertebra_tre_median_mm", "heart_dice", "medium_structure_dice_min",
                                       "jacobian_fold_fraction", "bone_abs_logjac_p95")}} for p in manifest["pairs"]],
            "transitivity": (trans or {}).get("dice_median"), "elapsed_sec": manifest["elapsed_sec"]}))
    except Exception as e:
        log("ERROR", e); traceback.print_exc()
        try:
            write_job_status(wd, {"job_id": args.job_id, "status": "error", "error": str(e)[:500]})
        except Exception:
            pass
        print("REGISTER_RESULT " + json.dumps({"status": "error", "error": str(e)[:500], "job_id": args.job_id}))
        sys.exit(1)


if __name__ == "__main__":
    main()
