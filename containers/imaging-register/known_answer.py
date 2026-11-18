#!/usr/bin/env python3
"""Known-answer tests for the imaging-register pipeline.

The landmark check asks a person what the right answer is. This test builds the answer first. It takes
one finished scan, makes a second scan from it by a change whose every number is known, runs the
production register job on the pair, and compares what the pipeline reports with what was put in.

What is put in (all of it recorded in truth.json, chosen by a seed, written down before the run):
  1. A smooth deformation (random cubic B-spline, p95 displacement a few millimetres) and a small rigid
     offset. Every point of the new scan has an exact partner in the old one, so the registration error
     at any point is a distance, not an opinion.
  2. Lung density that follows the volume: where the deformation stretches the lung, the density falls
     by the same factor, so the mass of the aerated lung is unchanged (a breath, not a disease).
  3. A different "kernel": a Gaussian blur and white noise. This is an emulation, not a reconstruction
     kernel; it measures how sensitive the numbers are to blur and noise.
  4. New nodules of known diameter and density, placed in the lung.
  5. One lobe filled in: the lower part of a lobe turns to soft tissue (a known loss of aerated mass).

What is read out: the registration error at random lung and body points (through the same code that the
landmark check uses), whether the new nodules survive the deformable frame and stand out in the
difference image, how many false alarms the difference image has, and whether the lung-volume step
names the lobe change and stays quiet when only the deformation was applied.

Limits, stated with the result: the new scan shares the old scan's anatomy, noise texture and
contrast phase except for what is emulated, so the registration problem is easier than two real
scans. The deformation is smooth and invertible; it has no sliding at the pleura. The nodules are
spheres. The test cannot show that the pipeline is right on a patient; it can show that it is wrong.

Thresholds live in the spec file, which is hashed and written read-only before any run
(`register-spec`); `evaluate` refuses a spec whose hash differs from the one recorded in the report
unless told it was amended. Nothing here reads DICOM.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

SPEC_SCHEMA = "imaging-register-known-answer-spec/1"
REPORT_SCHEMA = "imaging-register-known-answer-report/1"

DEFAULT_SPEC = {
    "schema": SPEC_SCHEMA,
    "status": ("Provisional. Set by the engineer before the first run of this test and before any result of it was "
               "read. Not derived from the literature and not validated. Changing a number after a run is an "
               "amendment and has to be said so in the report."),
    "base_scan": "jun17",
    "deformation": {
        "seed": 20261104, "mesh_cells": [5, 5, 6], "p95_mm": 8.0, "max_mm_limit": 20.0, "min_jacobian": 0.35,
        "rigid_translation_mm": [6.0, -5.0, 12.0], "rigid_rotation_deg": [1.5, 0.0, 2.0],
        "mass_conserving_in_lung": True,
    },
    "kernel_emulation": {"blur_sigma_mm": 0.6, "noise_hu_sd": 12.0, "seed": 7,
                         "note": "Gaussian blur and white noise. Not a reconstruction kernel."},
    "nodules": [{"diameter_mm": 4.0, "hu": 30.0}, {"diameter_mm": 6.0, "hu": 30.0}, {"diameter_mm": 8.0, "hu": 30.0},
                {"diameter_mm": 12.0, "hu": 30.0}, {"diameter_mm": 12.0, "hu": -500.0}],
    "nodule_rules": {"min_edge_from_lung_mm": 12.0, "min_spacing_mm": 35.0, "seed": 31, "parenchyma_hu_max": -780.0},
    "consolidation": {"lobe": "lung_lower_lobe_right", "fraction_from_bottom": 0.5, "hu": 25.0, "roi_margin_mm": 20.0},
    "points": {"n_per_lung_zone": 20, "n_body": 30, "erode_vox": 6, "seed": 99, "exclude_near_nodule_mm": 12.0},
    "detection": {"smooth_sigma_mm": 1.0, "threshold_sd": 5.0, "min_component_mm3": 30.0, "region_erode_vox": 4,
                  "exclusion_mm": 15.0},
    "pass": {
        "KA1_registration_error": {
            "lung_points_outside_roi": {"deformable_median_mm_max": 2.0, "deformable_p90_mm_max": 5.0,
                                        "lower_third_median_mm_max": 3.0, "deformable_median_must_beat_rigid": True},
            "body_points": {"deformable_median_mm_max": 3.0},
            "blob_lost_fraction_max": 0.05,
        },
        "KA2_gate_against_truth": ("report only. If KA1 fails while the gate verdict is PASS or PASS_WITH_WARNINGS, or "
                                   "KA1 passes while the gate verdict is FAIL, that disagreement is a finding."),
        "KA3_new_nodules": {"min_diameter_mm": 8.0, "retained_volume_ratio_min": 0.80,
                            "must_be_detected_in_deformable_frame": True,
                            "false_alarms": ("report only, rigid grid beside deformable frame. The detector is a plain "
                                             "smoothed difference image; a high count is a finding about that detector, "
                                             "not a pass or a fail of the registration.")},
        "KA4_lung_volume": {"mass_error_points_max": 0.02, "consolidation_must_flag": True,
                            "deformation_only_must_not_flag": True},
        "KA4b_core_candidate": {"erosion_mm": 4.0, "kernel_effect_points_max": 0.02,
                                "meaning": ("Candidate decision measure: the aerated mass of the lung core, deeper than 4 mm inside the label, "
                                            "which does not include the rim where blur moves tissue density across the label edge. It is "
                                            "judged on the same build, from the arrays: the change in the number caused by the emulated "
                                            "kernel alone (final against before-kernel) has to stay within the points given. Passing "
                                            "makes it eligible to replace the whole-label mass in the lung-volume step; it does not "
                                            "replace it by itself.")},
    },
    "reading": ("PASS on a part means the pipeline met the number on a case built to be easier than a real pair. "
                "FAIL on a part is a finding about the pipeline. Nothing here is a clinical validation."),
}


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ids_matching(names, rx):
    return sorted(i for i, n in names.items() if re.search(rx, n))


# ------------------------------------------------------------------------------ the known change
def dense_displacement(tx, img):
    import SimpleITK as sitk
    return sitk.TransformToDisplacementField(tx, sitk.sitkVectorFloat32, img.GetSize(), img.GetOrigin(),
                                             img.GetSpacing(), img.GetDirection())


def random_bspline(img, mesh_cells, seed, p95_mm, max_mm_limit, min_jacobian, tries=25):
    """A smooth random deformation scaled so that the 95th percentile of the displacement is p95_mm.
    Rejected, and drawn again, when it folds (Jacobian below min_jacobian) or moves anything more than
    max_mm_limit."""
    import SimpleITK as sitk
    rng = np.random.default_rng(seed)
    for k in range(tries):
        tx = sitk.BSplineTransformInitializer(img, [int(v) for v in mesh_cells], 3)
        p = rng.normal(0.0, 1.0, len(tx.GetParameters()))
        tx.SetParameters(p.tolist())
        d = sitk.GetArrayFromImage(dense_displacement(tx, img))
        mag = np.sqrt((d.astype(np.float64) ** 2).sum(axis=-1))
        scale = p95_mm / float(np.percentile(mag[::2, ::2, ::2], 95))
        p = p * scale
        tx.SetParameters(p.tolist())
        dimg = dense_displacement(tx, img)
        d = sitk.GetArrayFromImage(dimg)
        mx = float(np.sqrt((d.astype(np.float64) ** 2).sum(axis=-1)).max())
        jac = sitk.GetArrayFromImage(sitk.DisplacementFieldJacobianDeterminant(dimg))
        if jac.min() >= min_jacobian and mx <= max_mm_limit:
            return tx, {"draw": k + 1, "p95_mm": round(p95_mm, 3), "max_mm": round(mx, 3),
                        "min_jacobian": round(float(jac.min()), 4), "max_jacobian": round(float(jac.max()), 4)}
    raise RuntimeError(f"no deformation with min Jacobian >= {min_jacobian} and max <= {max_mm_limit} mm in {tries} draws")


def rigid_transform(img, translation_mm, rotation_deg):
    import SimpleITK as sitk
    size = img.GetSize()
    c = img.TransformContinuousIndexToPhysicalPoint([(size[i] - 1) / 2.0 for i in range(3)])
    tx = sitk.Euler3DTransform()
    tx.SetCenter(c)
    tx.SetRotation(*[float(np.deg2rad(a)) for a in rotation_deg])
    tx.SetTranslation([float(v) for v in translation_mm])
    return tx


def truth_transform(img, dspec):
    """T maps a point of the NEW scan to its partner in the OLD scan. T(y) = rigid(bspline(y))."""
    import SimpleITK as sitk
    b, info = random_bspline(img, dspec["mesh_cells"], dspec["seed"], dspec["p95_mm"], dspec["max_mm_limit"],
                             dspec["min_jacobian"])
    r = rigid_transform(img, dspec["rigid_translation_mm"], dspec["rigid_rotation_deg"])
    T = sitk.CompositeTransform(3)
    T.AddTransform(r)
    T.AddTransform(b)          # the last transform added is applied first
    return T, b, info


def emulate_kernel(arr, spacing_zyx, sigma_mm, noise_hu_sd, seed):
    from scipy import ndimage
    out = arr.astype(np.float32)
    if sigma_mm and sigma_mm > 0:
        out = ndimage.gaussian_filter(out, [sigma_mm / s for s in spacing_zyx])
    if noise_hu_sd and noise_hu_sd > 0:
        rng = np.random.default_rng(seed)
        out = out + rng.normal(0.0, noise_hu_sd, out.shape).astype(np.float32)
    return out


def insert_sphere(arr, center_zyx, diameter_mm, hu, spacing_zyx, edge_mm=0.8):
    """Blend a sphere of density `hu` into arr in place. Returns (mask of voxels at least half inside, voxels)."""
    r = diameter_mm / 2.0
    reach = r + edge_mm + 2.0
    lo = [max(0, int(np.floor(center_zyx[k] - reach / spacing_zyx[k]))) for k in range(3)]
    hi = [min(arr.shape[k], int(np.ceil(center_zyx[k] + reach / spacing_zyx[k])) + 1) for k in range(3)]
    sl = tuple(slice(lo[k], hi[k]) for k in range(3))
    zz, yy, xx = np.meshgrid(*[(np.arange(lo[k], hi[k]) - center_zyx[k]) * spacing_zyx[k] for k in range(3)], indexing="ij")
    d = np.sqrt(zz ** 2 + yy ** 2 + xx ** 2)
    w = np.clip((r + edge_mm / 2.0 - d) / edge_mm, 0.0, 1.0)
    arr[sl] = arr[sl] * (1.0 - w) + hu * w
    mask = np.zeros(arr.shape, bool)
    mask[sl] = w >= 0.5
    return mask


def consolidate(arr, lobe_mask, fraction_from_bottom, hu):
    """The lower `fraction_from_bottom` of a lobe (by height; z grows upward) turns to soft tissue wherever
    it was air. Returns the mask of the region. Vessels and anything denser than -300 HU stay."""
    zs = np.nonzero(lobe_mask.any(axis=(1, 2)))[0]
    if zs.size == 0:
        raise RuntimeError("the lobe to fill is empty in the new scan")
    cut = zs.min() + fraction_from_bottom * (zs.max() - zs.min() + 1)
    zi = np.arange(arr.shape[0])[:, None, None]
    roi = lobe_mask & (zi < cut)
    air = roi & (arr < -300.0)
    arr[air] = hu
    return roi


def phys_to_index_xyz(img, pts_xyz):
    """Vectorised physical (x, y, z in mm) to continuous index (x, y, z) for a SimpleITK image."""
    d = np.array(img.GetDirection(), float).reshape(3, 3)
    return ((np.asarray(pts_xyz, float) - np.array(img.GetOrigin())) @ d) / np.array(img.GetSpacing())


def splat_mask_to_old_frame(mask_zyx, disp_zyx3, img):
    """Carry a mask of the NEW grid into the OLD grid with the exact displacement field of T (the physical shift
    of each new-grid point to its partner), then close the small holes an expansion leaves."""
    from scipy import ndimage
    idx = np.argwhere(mask_zyx)
    out = np.zeros(mask_zyx.shape, bool)
    if idx.shape[0] == 0:
        return out
    ix = idx[:, ::-1].astype(float)                                   # x, y, z index
    d = np.array(img.GetDirection(), float).reshape(3, 3)
    phys = np.array(img.GetOrigin()) + (ix * np.array(img.GetSpacing())) @ d.T
    phys = phys + disp_zyx3[idx[:, 0], idx[:, 1], idx[:, 2], :].astype(float)
    j = np.rint(phys_to_index_xyz(img, phys)).astype(int)             # x, y, z
    ok = (j >= 0).all(axis=1) & (j[:, 0] < mask_zyx.shape[2]) & (j[:, 1] < mask_zyx.shape[1]) & (j[:, 2] < mask_zyx.shape[0])
    j = j[ok]
    out[j[:, 2], j[:, 1], j[:, 0]] = True
    return ndimage.binary_closing(out, iterations=2)


def place_nodules(lung_mask, ct_for_parenchyma, spacing_zyx, specs, rules, exclude_mask):
    """Seeded positions inside the lung, away from its edge, in plain parenchyma, apart from each other and
    from `exclude_mask`. Returns a list of centre indices (z, y, x as floats)."""
    from scipy import ndimage
    rng = np.random.default_rng(rules["seed"])
    dist = ndimage.distance_transform_edt(lung_mask, sampling=spacing_zyx)
    smooth = ndimage.uniform_filter(np.clip(ct_for_parenchyma, -1024, 200).astype(np.float32), size=11)
    ok = (dist >= rules["min_edge_from_lung_mm"]) & (smooth < rules["parenchyma_hu_max"]) & ~exclude_mask
    cand = np.argwhere(ok)
    if cand.shape[0] < len(specs) * 50:
        raise RuntimeError(f"only {cand.shape[0]} voxels qualify for {len(specs)} nodules")
    chosen = []
    for _ in specs:
        for _try in range(5000):
            p = cand[rng.integers(0, cand.shape[0])].astype(float)
            if all(np.linalg.norm((p - q) * spacing_zyx) >= rules["min_spacing_mm"] for q in chosen):
                chosen.append(p)
                break
        else:
            raise RuntimeError("could not place the nodules with the spacing asked for")
    return chosen


MASS_EROSIONS_MM = (0.0, 2.0, 4.0, 6.0)


def lung_distance_map(labels, lung_ids, spacing_zyx):
    """Distance in mm from each lung voxel to the nearest non-lung voxel (0 outside the lung)."""
    from scipy import ndimage
    return ndimage.distance_transform_edt(np.isin(labels, lung_ids), sampling=spacing_zyx).astype(np.float32)


def mass_by_erosion(ct, dist, spacing_zyx, erosions_mm=MASS_EROSIONS_MM, hu_max=-500.0):
    """Aerated mass (g) of the lung and of its core: voxels deeper than e mm inside the lung label. The core does
    not include the rim, where blur and resampling carry tissue density across the label edge."""
    dv = float(np.prod(spacing_zyx)) / 1000.0
    out = {}
    for e in erosions_mm:
        m = (dist > e) if e > 0 else (dist > 0)
        par = m & (ct < hu_max)
        out[str(e)] = round(float(((np.clip(ct[par].astype(np.float64), -1000.0, hu_max) + 1000.0) / 1000.0).sum() * dv), 2)
    return out


def build(source_out, base_label, spec, out_dir, log=print):
    """Make the new scan from native/<base_label> of a finished register job. Writes files and truth.json."""
    import SimpleITK as sitk
    from scipy import ndimage
    import lung_volume as LV
    man = json.load(open(os.path.join(source_out, "manifest.json")))
    names = {int(k): v for k, v in man["label_names"].items()}
    ref_ct = sitk.ReadImage(os.path.join(source_out, "native", base_label, "ct.nii.gz"))
    ref_lb = sitk.ReadImage(os.path.join(source_out, "native", base_label, "labels.nii.gz"))
    sp_xyz = ref_ct.GetSpacing()
    if not np.allclose(sp_xyz, 1.0, atol=0.05):
        raise RuntimeError(f"expects 1.0 mm isotropic native scans, got {sp_xyz}")
    sp = tuple(float(v) for v in sp_xyz[::-1])
    os.makedirs(out_dir, exist_ok=True)

    log("deformation")
    T, bsp, dinfo = truth_transform(ref_ct, spec["deformation"])
    sitk.WriteTransform(T, os.path.join(out_dir, "truth_transform.tfm"))
    mov = sitk.Resample(ref_ct, ref_ct, T, sitk.sitkLinear, -1024.0, sitk.sitkFloat32)
    mov_lb = sitk.Resample(ref_lb, ref_lb, T, sitk.sitkNearestNeighbor, 0, ref_lb.GetPixelID())
    arr = sitk.GetArrayFromImage(mov).astype(np.float32)
    lab = sitk.GetArrayFromImage(mov_lb)
    lung_ids = ids_matching(names, r"^lung_")
    lung_ref = np.isin(sitk.GetArrayFromImage(ref_lb), lung_ids)
    lung = np.isin(lab, lung_ids)
    # Cropping, not volume change: the deformation is allowed to change the lung volume (that is part of the truth), but no
    # lung voxel may come within 3 voxels of the edge of the image, where the offset or the deformation could have cut it.
    lz, ly, lx = np.nonzero(lung)
    margin = int(min(lz.min(), ly.min(), lx.min(), lung.shape[0] - 1 - lz.max(), lung.shape[1] - 1 - ly.max(), lung.shape[2] - 1 - lx.max()))
    if margin < 3:
        raise RuntimeError(f"the new lung comes within {margin} voxels of the image edge, so it may have been cropped; "
                           "reduce rigid_translation_mm or the deformation")
    if spec["deformation"].get("mass_conserving_in_lung"):
        J = sitk.GetArrayFromImage(sitk.DisplacementFieldJacobianDeterminant(dense_displacement(bsp, ref_ct)))
        par = lung & (arr < -500.0)
        arr[par] = np.clip((arr[par] + 1000.0) * J[par] - 1000.0, -1024.0, -500.0)
        del J
    groups = {"lung_left": ids_matching(names, r"^lung_.*_left$"), "lung_right": ids_matching(names, r"^lung_.*_right$"),
              "lobes": {nm: ids_matching(names, rf"^{nm}$") for nm in LV.LUNG_LOBES}}
    ke = spec["kernel_emulation"]
    deform_only = emulate_kernel(arr, sp, ke["blur_sigma_mm"], ke["noise_hu_sd"], ke["seed"])

    log("lobe fill")
    cs = spec["consolidation"]
    lobe_ids = ids_matching(names, rf"^{cs['lobe']}$")
    roi = consolidate(arr, np.isin(lab, lobe_ids), cs["fraction_from_bottom"], cs["hu"])
    roi_zone = ndimage.binary_dilation(roi, iterations=int(round(cs["roi_margin_mm"] / min(sp)))) if cs["roi_margin_mm"] else roi

    log("nodules")
    centres = place_nodules(lung, arr, sp, spec["nodules"], spec["nodule_rules"], roi_zone)
    nod_truth, nod_masks = [], np.zeros(arr.shape, np.int16)
    for i, (c, ns) in enumerate(zip(centres, spec["nodules"])):
        m = insert_sphere(arr, c, ns["diameter_mm"], ns["hu"], sp)
        nod_masks[m] = i + 1
        p_m = mov.TransformContinuousIndexToPhysicalPoint((float(c[2]), float(c[1]), float(c[0])))
        p_f = T.TransformPoint(p_m)
        nod_truth.append({"id": f"N{i + 1}", "diameter_mm": ns["diameter_mm"], "hu": ns["hu"],
                          "center_index_zyx": [round(float(v), 2) for v in c],
                          "center_phys_new_mm": [round(float(v), 3) for v in p_m],
                          "center_phys_old_mm": [round(float(v), 3) for v in p_f]})
    pre_kernel = arr.copy()
    final = emulate_kernel(arr, sp, ke["blur_sigma_mm"], ke["noise_hu_sd"], ke["seed"] + 1)

    def write_ct(a, path):
        img = sitk.GetImageFromArray(np.rint(np.clip(a, -1024, 3071)).astype(np.int16))
        img.CopyInformation(ref_ct)
        sitk.WriteImage(img, path)

    write_ct(final, os.path.join(out_dir, "new_ct.nii.gz"))
    write_ct(deform_only, os.path.join(out_dir, "new_deformonly_ct.nii.gz"))
    sitk.WriteImage(mov_lb, os.path.join(out_dir, "new_labels.nii.gz"))
    for src, dst in (("ct.nii.gz", "old_ct.nii.gz"), ("labels.nii.gz", "old_labels.nii.gz")):
        import shutil
        shutil.copy(os.path.join(source_out, "native", base_label, src), os.path.join(out_dir, dst))
    m = sitk.GetImageFromArray(nod_masks); m.CopyInformation(ref_ct)
    sitk.WriteImage(m, os.path.join(out_dir, "nodule_masks.nii.gz"))
    r_ = sitk.GetImageFromArray(roi.astype(np.uint8)); r_.CopyInformation(ref_ct)
    sitk.WriteImage(r_, os.path.join(out_dir, "consolidation_roi.nii.gz"))
    # where the filled region sits in the OLD scan: every voxel of it is carried through the exact transform
    disp = sitk.GetArrayFromImage(sitk.TransformToDisplacementField(
        T, sitk.sitkVectorFloat32, ref_ct.GetSize(), ref_ct.GetOrigin(), ref_ct.GetSpacing(), ref_ct.GetDirection()))
    roi_old = splat_mask_to_old_frame(roi, disp, ref_ct)
    del disp
    o_ = sitk.GetImageFromArray(roi_old.astype(np.uint8)); o_.CopyInformation(ref_ct)
    sitk.WriteImage(o_, os.path.join(out_dir, "consolidation_roi_old_frame.nii.gz"))

    old_arr = sitk.GetArrayFromImage(ref_ct)
    old_lab = sitk.GetArrayFromImage(ref_lb)
    old_rep = LV.lung_report(old_arr, old_lab, sp, groups)
    reps = {"old": old_rep,
            "new_before_kernel_emulation": LV.lung_report(pre_kernel, lab, sp, groups),
            "new_deformation_only": LV.lung_report(np.rint(deform_only), lab, sp, groups),
            "new_final": LV.lung_report(np.rint(np.clip(final, -1024, 3071)), lab, sp, groups)}
    comps = {k: LV.compare_lung_volume(old_rep, v) for k, v in reps.items() if k != "old"}
    d_old, d_new = lung_distance_map(old_lab, lung_ids, sp), lung_distance_map(lab, lung_ids, sp)
    tables = {"old": mass_by_erosion(old_arr, d_old, sp), "new_before_kernel_emulation": mass_by_erosion(pre_kernel, d_new, sp),
              "new_deformation_only": mass_by_erosion(np.rint(deform_only), d_new, sp),
              "new_final": mass_by_erosion(np.rint(np.clip(final, -1024, 3071)), d_new, sp)}
    sens = {k: {e: round(v[e] / tables["old"][e] - 1.0, 4) for e in v} for k, v in tables.items() if k != "old"}
    del d_old, d_new
    truth = {"schema": "imaging-register-known-answer-truth/1", "base_scan": base_label,
             "aerated_mass_g_by_erosion_mm": tables, "aerated_mass_change_vs_old_by_erosion_mm": sens,
             "built_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
             "spec_sha256": hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest(),
             "deformation": dinfo, "rigid": {"translation_mm": spec["deformation"]["rigid_translation_mm"],
                                             "rotation_deg": spec["deformation"]["rigid_rotation_deg"]},
             "nodules": nod_truth,
             "consolidation": {"lobe": cs["lobe"], "fraction_from_bottom": cs["fraction_from_bottom"], "hu": cs["hu"],
                               "roi_voxels": int(roi.sum()), "roi_ml": round(float(roi.sum()) * float(np.prod(sp)) / 1000.0, 1),
                               "roi_margin_mm": cs["roi_margin_mm"]},
             "lung_reports": reps, "lung_comparisons_old_to_new": comps,
             "lung_min_margin_to_image_edge_voxels": margin,
             "lung_volume_ratio_new_over_old_labels": round(float(lung.sum() / lung_ref.sum()), 4),
             "files": sorted(os.listdir(out_dir))}
    with open(os.path.join(out_dir, "truth.json"), "w") as f:
        json.dump(truth, f, indent=1)
    return truth


# ------------------------------------------------------------------------------ reading the result
def sample_points(lung_mask, body_mask, spec_points, exclude_mask, spacing_zyx):
    """Random points: n per lung zone (left/right x lower/mid/upper third) and n in the body. Returns
    a list of dicts with index_zyx and group."""
    import landmark_check as LC
    from scipy import ndimage
    rng = np.random.default_rng(spec_points["seed"])
    inner = ndimage.binary_erosion(lung_mask, iterations=int(spec_points["erode_vox"])) & ~exclude_mask
    z = LC.zone_labels(lung_mask)           # zones come from the whole lung, so excluding a region does not move them
    out = []
    if z is not None:
        zi = np.indices(inner.shape)
        side = np.where(zi[2] > z["x_mid"], "right", "left")
        third = np.where(zi[0] < z["z_edges"][0], "lower", np.where(zi[0] < z["z_edges"][1], "mid", "upper"))
        for sd in ("left", "right"):
            for th in ("lower", "mid", "upper"):
                idx = np.argwhere(inner & (side == sd) & (third == th))
                if idx.shape[0] == 0:
                    continue
                pick = idx[rng.choice(idx.shape[0], size=min(spec_points["n_per_lung_zone"], idx.shape[0]), replace=False)]
                out += [{"index_zyx": [int(v) for v in p], "group": f"lung_{sd}_{th}"} for p in pick]
    body = ndimage.binary_erosion(body_mask, iterations=3) & ~exclude_mask
    if body.any():
        idx = np.argwhere(body)
        pick = idx[rng.choice(idx.shape[0], size=min(spec_points["n_body"], idx.shape[0]), replace=False)]
        out += [{"index_zyx": [int(v) for v in p], "group": "body"} for p in pick]
    return out


def detect_changes(diff, region, centres_zyx, radii_mm, spacing_zyx, det):
    """`diff` is the difference image (new minus old, on one grid). The noise level is the robust spread of
    the smoothed difference inside `region` (lung, with the truth zones left out); an object counts as
    found when the smoothed difference near its centre reaches `threshold_sd` times that spread above
    the median. False alarms are connected components over the same threshold, in the region, of at
    least `min_component_mm3`."""
    from scipy import ndimage
    ds = ndimage.gaussian_filter(diff.astype(np.float32), [det["smooth_sigma_mm"] / s for s in spacing_zyx])
    vals = ds[region]
    med = float(np.median(vals))
    sd = float(1.4826 * np.median(np.abs(vals - med)))
    tau = med + det["threshold_sd"] * sd
    found = []
    for c, r in zip(centres_zyx, radii_mm):
        reach = r + 3.0
        lo = [max(0, int(np.floor(c[k] - reach / spacing_zyx[k]))) for k in range(3)]
        hi = [min(diff.shape[k], int(np.ceil(c[k] + reach / spacing_zyx[k])) + 1) for k in range(3)]
        sl = tuple(slice(lo[k], hi[k]) for k in range(3))
        zz, yy, xx = np.meshgrid(*[(np.arange(lo[k], hi[k]) - c[k]) * spacing_zyx[k] for k in range(3)], indexing="ij")
        near = np.sqrt(zz ** 2 + yy ** 2 + xx ** 2) <= reach
        peak = float(ds[sl][near].max()) if near.any() else float("nan")
        found.append({"peak": round(peak, 2), "peak_sd_above_median": round((peak - med) / sd, 2) if sd > 0 else None,
                      "detected": bool(peak >= tau)})
    lab, n = ndimage.label((ds > tau) & region)
    vox_mm3 = float(np.prod(spacing_zyx))
    sizes = ndimage.sum(np.ones_like(lab, dtype=np.float32), lab, index=np.arange(1, n + 1)) if n else []
    false_alarms = int(sum(1 for s in sizes if s * vox_mm3 >= det["min_component_mm3"]))
    return {"median": round(med, 3), "robust_sd": round(sd, 3), "threshold": round(tau, 3), "objects": found,
            "false_alarm_components": false_alarms}


def ants_to_zyx(a):
    """ANTsPy arrays are indexed x, y, z; SimpleITK arrays (and everything else in this file) are z, y, x."""
    return np.transpose(a, (2, 1, 0))


def tre_group_stats(vals):
    import landmark_check as LC
    return LC.tre_stats(vals)


def judge(report, spec):
    """The pass rules of the spec applied to a finished report. Returns a dict of part -> {verdict, reasons}."""
    rules = spec["pass"]
    out = {}
    ka1, reasons, ok = rules["KA1_registration_error"], [], True
    lung = report["registration_error"]["lung_outside_roi"]
    d, r = lung.get("deformable"), lung.get("rigid")
    p = ka1["lung_points_outside_roi"]
    if not d:
        ok = False; reasons.append("no deformable lung error was computed")
    else:
        if d["median_mm"] > p["deformable_median_mm_max"]:
            ok = False; reasons.append(f"lung deformable median {d['median_mm']} mm > {p['deformable_median_mm_max']}")
        if d["p90_mm"] > p["deformable_p90_mm_max"]:
            ok = False; reasons.append(f"lung deformable p90 {d['p90_mm']} mm > {p['deformable_p90_mm_max']}")
        if p.get("deformable_median_must_beat_rigid") and r and not d["median_mm"] < r["median_mm"]:
            ok = False; reasons.append(f"deformable median {d['median_mm']} does not beat rigid {r['median_mm']}")
    low = report["registration_error"].get("lung_lower_third_outside_roi", {}).get("deformable")
    if low and low["median_mm"] > p["lower_third_median_mm_max"]:
        ok = False; reasons.append(f"lower-third deformable median {low['median_mm']} mm > {p['lower_third_median_mm_max']}")
    body = report["registration_error"]["body"].get("deformable")
    if not body:
        ok = False; reasons.append("no deformable body error was computed")
    elif body["median_mm"] > ka1["body_points"]["deformable_median_mm_max"]:
        ok = False; reasons.append(f"body deformable median {body['median_mm']} mm > {ka1['body_points']['deformable_median_mm_max']}")
    lost = report["registration_error"].get("blob_lost_fraction", 0.0)
    if lost > ka1["blob_lost_fraction_max"]:
        ok = False; reasons.append(f"{lost:.1%} of the points lost their blob (max {ka1['blob_lost_fraction_max']:.0%})")
    out["KA1_registration_error"] = {"verdict": "PASS" if ok else "FAIL", "reasons": reasons}

    gate = report.get("gate_verdict")
    out["KA2_gate_against_truth"] = {
        "verdict": "REPORT",
        "reasons": [f"KA1 {out['KA1_registration_error']['verdict']}, gate {gate}"] +
                   (["DISAGREEMENT: the gate does not agree with the measured error"] if
                    (gate and ((out["KA1_registration_error"]["verdict"] == "FAIL" and gate != "FAIL") or
                               (out["KA1_registration_error"]["verdict"] == "PASS" and gate == "FAIL"))) else [])}

    ka3, reasons, ok = rules["KA3_new_nodules"], [], True
    for n in report["nodules"]["objects"]:
        if n["diameter_mm"] < ka3["min_diameter_mm"]:
            continue
        ret = n.get("deformable_retained_volume_ratio")
        if ret is None or ret < ka3["retained_volume_ratio_min"]:
            ok = False; reasons.append(f"{n['id']} ({n['diameter_mm']} mm, {n['hu']} HU) kept {ret} of its volume in the deformable frame (min {ka3['retained_volume_ratio_min']})")
        if ka3["must_be_detected_in_deformable_frame"] and not (n.get("deformable_frame") or {}).get("detected"):
            ok = False; reasons.append(f"{n['id']} was not detected in the deformable frame")
    nod = report["nodules"]
    reasons.append(f"false-alarm components (report only): deformable frame {nod['deformable_frame_false_alarm_components']}, "
                   f"rigid grid {nod['rigid_grid_false_alarm_components']}")
    out["KA3_new_nodules"] = {"verdict": "PASS" if ok else "FAIL", "reasons": reasons}

    ka4, reasons, ok = rules["KA4_lung_volume"], [], True
    v = report["lung_volume"]
    if v.get("mass_error_points") is None or abs(v["mass_error_points"]) > ka4["mass_error_points_max"]:
        ok = False; reasons.append(f"aerated-mass change measured {v.get('measured_mass_frac')} against {v.get('truth_mass_frac')} built in")
    if ka4["consolidation_must_flag"] and not v.get("flagged_with_lobe_fill"):
        ok = False; reasons.append("the lobe fill was not flagged as a change the breath does not explain")
    if ka4["deformation_only_must_not_flag"] and v.get("flagged_deformation_only") is not False:
        ok = False; reasons.append("the deformation alone was flagged (or not computed)")
    out["KA4_lung_volume"] = {"verdict": "PASS" if ok else "FAIL", "reasons": reasons}
    kb = rules["KA4b_core_candidate"]
    eff = (report["lung_volume"].get("kernel_effect_on_mass_points_by_erosion_mm") or {}).get(str(kb["erosion_mm"]))
    whole = (report["lung_volume"].get("kernel_effect_on_mass_points_by_erosion_mm") or {}).get("0.0")
    out["KA4b_core_candidate"] = {
        "verdict": "PASS" if (eff is not None and abs(eff) <= kb["kernel_effect_points_max"]) else "FAIL",
        "reasons": [f"emulated kernel moved the core ({kb['erosion_mm']} mm) mass by {eff} and the whole-label mass by {whole} "
                    f"(allowed {kb['kernel_effect_points_max']})"]}
    return out


def evaluate(job_out, build_dir, spec, out_path, log=print):
    """Compare a finished register job on the known pair with truth.json. job_out is the job's `out` folder."""
    import SimpleITK as sitk
    import ants
    from scipy import ndimage
    import landmark_check as LC
    truth = json.load(open(os.path.join(build_dir, "truth.json")))
    man = json.load(open(os.path.join(job_out, "manifest.json")))
    ref, mov = man["reference"], next(t["label"] for t in man["timepoints"] if t["label"] != man["reference"])
    names = {int(k): v for k, v in man["label_names"].items()}
    pair = f"{mov}_to_{ref}"
    man_pair = next(p for p in man["pairs"] if p["pair"] == pair)
    pdir = os.path.join(job_out, "pairs", pair)
    T = sitk.ReadTransform(os.path.join(build_dir, "truth_transform.tfm"))
    new_img = sitk.ReadImage(os.path.join(build_dir, "new_ct.nii.gz"))
    new_ct = sitk.GetArrayFromImage(new_img)
    new_lab = sitk.GetArrayFromImage(sitk.ReadImage(os.path.join(build_dir, "new_labels.nii.gz")))
    roi = sitk.GetArrayFromImage(sitk.ReadImage(os.path.join(build_dir, "consolidation_roi.nii.gz"))) > 0
    sp = tuple(float(v) for v in new_img.GetSpacing()[::-1])
    lung_ids = ids_matching(names, r"^lung_")
    lung = np.isin(new_lab, lung_ids)
    pts_spec = spec["points"]
    roi_zone = ndimage.binary_dilation(roi, iterations=int(round(truth["consolidation"]["roi_margin_mm"] / min(sp))))
    near_nod = np.zeros(new_ct.shape, bool)
    for n in truth["nodules"]:
        c = n["center_index_zyx"]
        zz, yy, xx = np.ogrid[:new_ct.shape[0], :new_ct.shape[1], :new_ct.shape[2]]
        near_nod |= (((zz - c[0]) * sp[0]) ** 2 + ((yy - c[1]) * sp[1]) ** 2 + ((xx - c[2]) * sp[2]) ** 2) <= pts_spec["exclude_near_nodule_mm"] ** 2
    soft = (new_ct > 10) & (new_ct < 70)
    zr = np.nonzero(lung.any(axis=(1, 2)))[0]
    soft[:zr.min()] = False; soft[zr.max() + 1:] = False
    soft &= ~ndimage.binary_dilation(lung, iterations=10)
    pts = sample_points(lung, soft, pts_spec, near_nod | roi_zone, sp)
    # points inside the lobe fill, reported separately
    inside = sample_points(lung & roi, np.zeros_like(soft), {**pts_spec, "n_per_lung_zone": 15, "erode_vox": 2}, near_nod, sp)
    for p in inside:
        p["group"] = "lobe_fill_roi"
    fixed_ct = sitk.ReadImage(os.path.join(job_out, "frame", f"{ref}_ct.nii.gz"))
    stages = LC.stage_transforms(pdir, man_pair)
    cache = {}
    rows, lost = [], 0
    log(f"measuring {len(pts) + len(inside)} points")
    for i, p in enumerate(pts + inside):
        zyx = p["index_zyx"]
        p_m = new_img.TransformContinuousIndexToPhysicalPoint((float(zyx[2]), float(zyx[1]), float(zyx[0])))
        p_f = T.TransformPoint(p_m)
        res = LC.map_moving_point_to_fixed(ants, sitk, fixed_ct, p_f, p_m, stages, cache)
        row = {"group": p["group"], "tre_mm": {}, "flags": {}}
        for st, r in res.items():
            row["flags"][st] = r["flag"]
            if r["fixed_phys_mm"] is not None and r["flag"] in ("ok", "mass_changed"):
                row["tre_mm"][st] = round(float(np.linalg.norm(np.array(r["fixed_phys_mm"]) - np.array(p_f))), 3)
        if "deformable" not in row["tre_mm"]:
            lost += 1
        rows.append(row)
        if (i + 1) % 25 == 0:
            log(f"  {i + 1} points")

    def vals(st, pick):
        return [r["tre_mm"][st] for r in rows if st in r["tre_mm"] and pick(r)]
    is_lung = lambda r: r["group"].startswith("lung_")
    is_low = lambda r: r["group"].endswith("_lower")
    reg = {"n_points": len(rows), "blob_lost_fraction": round(lost / max(1, len([r for r in rows if r["group"] != "lobe_fill_roi"])), 4),
           "lung_outside_roi": {st: LC.tre_stats(vals(st, is_lung)) for st in ("initial", "rigid", "deformable")},
           "lung_lower_third_outside_roi": {st: LC.tre_stats(vals(st, lambda r: is_lung(r) and is_low(r))) for st in ("rigid", "deformable")},
           "body": {st: LC.tre_stats(vals(st, lambda r: r["group"] == "body")) for st in ("rigid", "deformable")},
           "inside_lobe_fill": {st: LC.tre_stats(vals(st, lambda r: r["group"] == "lobe_fill_roi")) for st in ("rigid", "deformable")},
           "by_zone_deformable_median_mm": {g: LC.tre_stats([r["tre_mm"]["deformable"] for r in rows if r["group"] == g and "deformable" in r["tre_mm"]])
                                            for g in sorted({r["group"] for r in rows})}}

    # new nodules: how much of each survives the deformable frame, and does it stand out in the difference image
    fx_ref = sitk.GetArrayFromImage(fixed_ct)
    fx_new = sitk.GetArrayFromImage(sitk.ReadImage(os.path.join(job_out, "frame", f"{mov}_ct.nii.gz")))
    A_ref = ants.image_read(os.path.join(job_out, "frame", f"{ref}_ct.nii.gz"))
    A_mov = ants.image_read(os.path.join(job_out, "native", mov, "ct.nii.gz"))
    rig = ants_to_zyx(ants.apply_transforms(A_ref, A_mov, [os.path.join(pdir, "rigid.mat")], interpolator="linear", defaultvalue=-1024).numpy())
    assert rig.shape == fx_ref.shape, (rig.shape, fx_ref.shape)
    frame_lab = sitk.GetArrayFromImage(sitk.ReadImage(os.path.join(job_out, "frame", f"{ref}_labels.nii.gz")))
    det = spec["detection"]
    region = ndimage.binary_erosion(np.isin(frame_lab, lung_ids), iterations=int(det["region_erode_vox"]))
    zone_old = np.zeros(region.shape, bool)
    fsp = tuple(float(v) for v in fixed_ct.GetSpacing()[::-1])
    centres_old, radii = [], []
    for n in truth["nodules"]:
        idx = fixed_ct.TransformPhysicalPointToContinuousIndex(tuple(n["center_phys_old_mm"]))
        c = [idx[2], idx[1], idx[0]]
        centres_old.append(c); radii.append(n["diameter_mm"] / 2.0)
        zz, yy, xx = np.ogrid[:region.shape[0], :region.shape[1], :region.shape[2]]
        zone_old |= (((zz - c[0]) * fsp[0]) ** 2 + ((yy - c[1]) * fsp[1]) ** 2 + ((xx - c[2]) * fsp[2]) ** 2) <= det["exclusion_mm"] ** 2
    # the filled region in the OLD frame (carried through the exact transform at build time), with its margin
    fill_old = ndimage.binary_dilation(
        sitk.GetArrayFromImage(sitk.ReadImage(os.path.join(build_dir, "consolidation_roi_old_frame.nii.gz"))) > 0,
        iterations=int(round(truth["consolidation"]["roi_margin_mm"] / min(sp))))
    reg_det = region & ~zone_old & ~fill_old
    dres = detect_changes(fx_new.astype(np.float32) - fx_ref.astype(np.float32), reg_det, centres_old, radii, fsp, det)
    rres = detect_changes(rig.astype(np.float32) - fx_ref.astype(np.float32), reg_det, centres_old, radii, fsp, det)
    objs = []
    for n, d_, r_ in zip(truth["nodules"], dres["objects"], rres["objects"]):
        sig = max(1.0, n["diameter_mm"] / 4.0)
        res = LC.map_moving_point_to_fixed(ants, sitk, fixed_ct, n["center_phys_old_mm"], n["center_phys_new_mm"], stages, cache,
                                           sigma_mm=sig)
        dm = res.get("deformable", {})
        pos_err = None
        if dm.get("fixed_phys_mm"):
            pos_err = round(float(np.linalg.norm(np.array(dm["fixed_phys_mm"]) - np.array(n["center_phys_old_mm"]))), 2)
        objs.append({**{k: n[k] for k in ("id", "diameter_mm", "hu")}, "blob_sigma_mm": sig,
                     "deformable_retained_volume_ratio": dm.get("mass_ratio"), "deformable_flag": dm.get("flag"),
                     "position_error_mm": pos_err, "deformable_frame": d_, "rigid_grid": r_})
    nod = {"objects": objs, "deformable_frame_noise": {k: dres[k] for k in ("median", "robust_sd", "threshold")},
           "rigid_grid_noise": {k: rres[k] for k in ("median", "robust_sd", "threshold")},
           "deformable_frame_false_alarm_components": dres["false_alarm_components"],
           "rigid_grid_false_alarm_components": rres["false_alarm_components"]}

    # lung volume: what the production job measured against what was built in
    lv = man.get("lung_volume") or {}
    comp = (lv.get("comparisons") or {}).get(pair) or {}
    tc = truth["lung_comparisons_old_to_new"]
    measured = comp.get("delta_aerated_mass_frac")
    tmass = tc["new_before_kernel_emulation"].get("delta_aerated_mass_frac")
    lvol = {"pair": pair, "error": lv.get("error"), "measured_mass_frac": measured, "truth_mass_frac": tmass,
            "mass_error_points": None if (measured is None or tmass is None) else round(measured - tmass, 4),
            "measured_volume_frac": comp.get("delta_volume_frac"),
            "truth_volume_frac": tc["new_before_kernel_emulation"].get("delta_volume_frac"),
            "flagged_with_lobe_fill": comp.get("real_change_supported"), "explained_by": comp.get("explained_by"),
            "explanation": comp.get("explanation"),
            "top_lobe_measured": (comp.get("lobes_by_change") or [{}])[0].get("lobe"),
            "flagged_deformation_only": tc["new_deformation_only"].get("real_change_supported"),
            "deformation_only_mass_frac": tc["new_deformation_only"].get("delta_aerated_mass_frac"),
            "deformation_only_explained_by": tc["new_deformation_only"].get("explained_by"),
            "kernel_effect_on_mass_points_by_erosion_mm": {
                e: round(truth["aerated_mass_change_vs_old_by_erosion_mm"]["new_final"][e] -
                         truth["aerated_mass_change_vs_old_by_erosion_mm"]["new_before_kernel_emulation"][e], 4)
                for e in truth["aerated_mass_change_vs_old_by_erosion_mm"]["new_final"]},
            "kernel_emulation_effect_on_mass_points": None if tmass is None else round(
                (tc["new_final"].get("delta_aerated_mass_frac") or 0) - tmass, 4),
            "gate_lung_downgraded": man_pair["gate"].get("lung_gate_downgraded")}
    report = {"schema": REPORT_SCHEMA, "job_id": man["job_id"], "pair": pair,
              "evaluated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "spec_sha256": hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest(),
              "truth_spec_sha256": truth["spec_sha256"], "gate_verdict": man_pair["gate"]["verdict"],
              "gate_hard_failures": man_pair["gate"]["hard_failures"], "gate_warnings": man_pair["gate"]["warnings"],
              "gate_deformable_metrics": {k: man_pair["metrics"]["deformable"].get(k) for k in
                                          ("spine_assd_mm", "lung_dice_min", "lung_assd_max_mm", "lung_hd95_max_mm",
                                           "jacobian_fold_fraction")},
              "registration_error": reg, "nodules": nod, "lung_volume": lvol, "truth_deformation": truth["deformation"]}
    report["pass_rules_applied"] = judge(report, spec)
    with open(out_path, "w") as f:
        json.dump(report, f, indent=1)
    return report


# ------------------------------------------------------------------------------ command line
def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("register-spec"); a.add_argument("--out", required=True)
    b = sub.add_parser("build"); b.add_argument("--source-out", required=True); b.add_argument("--spec", required=True)
    b.add_argument("--out-dir", required=True)
    c = sub.add_parser("evaluate"); c.add_argument("--job-out", required=True); c.add_argument("--build-dir", required=True)
    c.add_argument("--spec", required=True); c.add_argument("--out", required=True); c.add_argument("--spec-amended", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "register-spec":
        if os.path.exists(args.out):
            raise SystemExit(f"{args.out} exists; the spec is not rewritten once registered")
        spec = dict(DEFAULT_SPEC)
        spec["registered_at_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with open(args.out, "w") as f:
            json.dump(spec, f, indent=1)
        os.chmod(args.out, 0o444)
        print(f"spec written: {args.out} sha256 {file_sha256(args.out)}")
    elif args.cmd == "build":
        spec = json.load(open(args.spec))
        t = build(args.source_out, spec["base_scan"], spec, args.out_dir)
        print(json.dumps({"deformation": t["deformation"], "nodules": len(t["nodules"]), "consolidation": t["consolidation"],
                          "lung_min_margin_to_image_edge_voxels": t["lung_min_margin_to_image_edge_voxels"],
                          "lung_volume_ratio_new_over_old_labels": t["lung_volume_ratio_new_over_old_labels"],
                          "truth_comparisons": {k: {"mass": v.get("delta_aerated_mass_frac"), "volume": v.get("delta_volume_frac"),
                                                    "flag": v.get("real_change_supported")}
                                                for k, v in t["lung_comparisons_old_to_new"].items()}}, indent=1))
    else:
        spec = json.load(open(args.spec))
        r = evaluate(args.job_out, args.build_dir, spec, args.out)
        print(json.dumps({"gate": r["gate_verdict"], "pass_rules_applied": r["pass_rules_applied"]}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
