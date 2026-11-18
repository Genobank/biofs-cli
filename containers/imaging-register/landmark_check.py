#!/usr/bin/env python3
"""Independent landmark check for an imaging-register job (schema imaging-register/3).

Why: the gate in register.py measures overlap of TotalSegmentator labels and the optimizer's own
kind of similarity. A person confirming that two points are the same anatomy is a different kind
of evidence. This tool turns that confirmation into a number: the target registration error (TRE),
in millimetres, after the starting fit, the rigid step and the deformable step.

Roles (nothing here replaces the reader):
  propose   An algorithm picks distinctive points in the reference CT (Foerstner response, zones
            balanced over left/right lung and upper/mid/lower third, plus a few outside the lungs) and
            looks for each in every other scan by local template matching around the RIGID prediction.
            It never uses the deformable result, so the deformation cannot choose its own test points.
            It writes review sheets (PNG) and a template the reader fills in.
  review    A person marks each pair accept or reject (or gives a corrected position). Only accepted
            pairs are measured. A screen by the engineer is not a verification.
  measure   Each accepted moving point is mapped into the reference frame through the stored
            transforms (the production resampling path, so the direction is the one the images use)
            and compared with the reference point.

Criteria are written to a file with a hash BEFORE results are read (`criteria`), and `measure`
refuses a changed file unless told it was amended.

Nothing here reads DICOM. It reads the output folder of a finished register job.
"""
import argparse
import hashlib
import json
import os
import sys
import tempfile
import time

import numpy as np

SCHEMA = "imaging-register-landmarks/1"
CRITERIA_SCHEMA = "imaging-register-landmark-criteria/1"
HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULT_PROPOSAL = {
    "patch_half_mm": 8, "search_half_mm": 35, "ncc_min": 0.80, "margin_min": 0.05,
    "min_spacing_mm": 20, "per_lung_zone": 6, "other_zone": 8, "air_hu": -500,
}


# ------------------------------------------------------------------------------ criteria
LIVER_PROPOSAL = {
    "region": "liver", "version": 2,
    "patch_half_mm": 10, "search_half_mm": 30, "ncc_min": 0.50, "margin_min": 0.05,
    "min_spacing_mm": 12, "per_zone": 12, "min_edge_from_liver_surface_mm": 10, "soft_lo_hu": 0.0, "soft_hi_hu": 300.0,
    "liver_offset": True,                      # the rigid prediction is moved by the liver's own residual offset (centroids of the liver labels)
    "dog": True, "dog_sigma_small_mm": 1.0, "dog_sigma_large_mm": 6.0,     # match on a band-pass copy: vessels against the local background, not raw HU across phases
    "cycle_max_mm": 2.0, "cycle_search_half_mm": 12,                        # forward-backward check: the reverse match must return within this distance
}
LIVER_PROPOSAL_V1 = {
    "region": "liver", "patch_half_mm": 8, "search_half_mm": 45, "ncc_min": 0.60, "margin_min": 0.03,
    "min_spacing_mm": 15, "per_zone": 5, "min_edge_from_liver_surface_mm": 10, "soft_lo_hu": 0.0, "soft_hi_hu": 300.0,
}


def default_criteria(job_id, region="lung"):
    if region == "liver":
        return liver_criteria(job_id)
    return {
        "schema": CRITERIA_SCHEMA,
        "registered_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "job_under_test": job_id,
        "status": ("Provisional. Set by the engineer before any result of this job was read. Not derived from "
                   "the literature and not validated against a reference standard. A reader may change them "
                   "before the results are read, never after."),
        "proposal": DEFAULT_PROPOSAL,
        "verification": {
            "who": "a person who can recognise the same vessel branch, fissure point or bony point in both scans; "
                   "a radiologist is preferred",
            "accept_only_if": "the two points are the same anatomical point, not a similar-looking texture",
            "reject_if": "unsure",
        },
        "sufficiency": {"min_verified_per_pair": 20, "min_per_lung": 6, "min_lower_third": 4},
        "pass": {
            "deformable_median_tre_mm_max": 2.0,
            "deformable_p90_tre_mm_max": 5.0,
            "lower_third_median_tre_mm_max": 3.0,
            "deformable_median_must_beat_rigid_median": True,
        },
        "reading": ("PASS means the registration places points a reader confirmed within these distances. "
                    "It does not say anything about a point nobody confirmed, and the confirmed points are "
                    "the easier, well-matched ones. Report the number of rejected proposals beside the TRE."),
    }


def liver_criteria(job_id):
    """Criteria for the check of the INTERIOR of the liver (vessel branch points), written before any result is read.
    Same pass numbers as the chest check, set before the first look, not tuned."""
    c = default_criteria(job_id)
    c.update({
        "proposal": LIVER_PROPOSAL,
        "verification": {
            "who": "a person who can recognise the same hepatic or portal vein branch point in both scans; a radiologist is preferred",
            "accept_only_if": "the two points are the same vessel branch point, not a similar-looking texture or another branch",
            "reject_if": "unsure",
        },
        "sufficiency": {"min_verified_per_pair": 20, "min_per_side": 4, "min_lower_third": 4},
        "reading": ("PASS means the registration places liver vessel branch points that a reader confirmed within these distances. "
                    "It says nothing about the liver surface or about neighbouring organs that sit in different places in the two scans, "
                    "which is what the label gate measures; it is independent of the labels. Points the algorithm proposed and the reader "
                    "rejected are reported beside the TRE, and the confirmed points are the easier, well-matched ones."),
    })
    return c


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


# ------------------------------------------------------------------------------ geometry helpers
def foerstner_response(ct, sigma_d=1.0, sigma_i=2.0, lo=-1000.0, hi=300.0):
    """det(S) / trace(S)^2 of the structure tensor: large only where the gradient is strong in all
    three directions (vessel branch points, blob centres). ct is a z,y,x array at ~1 mm."""
    from scipy import ndimage
    g = ndimage.gaussian_filter(np.clip(ct.astype(np.float32), lo, hi), sigma_d)
    gz, gy, gx = np.gradient(g)

    def s(a, b):
        return ndimage.gaussian_filter(a * b, sigma_i)

    sxx, syy, szz = s(gx, gx), s(gy, gy), s(gz, gz)
    sxy, sxz, syz = s(gx, gy), s(gx, gz), s(gy, gz)
    det = (sxx * (syy * szz - syz * syz) - sxy * (sxy * szz - syz * sxz) + sxz * (sxy * syz - syy * sxz))
    tr = sxx + syy + szz
    return det / (tr * tr + 1e-6)


def lung_mask_from_ct(ct, air_hu=-500):
    """Lungs from intensity alone: large air components that do not touch the sides of the image
    (the air outside the body does), with the trachea and main bronchi opened away.

    The lungs of a chest scan are joined through the trachea to the top slice, so touching the top
    or bottom slice is allowed. A first version excluded every component that touched any border
    and found no lungs at all on the real chest scans (2026-11-04)."""
    from scipy import ndimage
    air = ct < air_hu
    lab, n = ndimage.label(air)
    if n == 0:
        return np.zeros(ct.shape, bool)
    side = set(np.unique(np.concatenate([lab[:, 0].ravel(), lab[:, -1].ravel(),
                                         lab[:, :, 0].ravel(), lab[:, :, -1].ravel()])))
    sizes = ndimage.sum(air, lab, index=np.arange(1, n + 1))
    keep = [i + 1 for i, sz in enumerate(sizes) if sz > 150000 and (i + 1) not in side]   # > 150 mL at 1 mm
    mask = np.isin(lab, keep)
    if not mask.any():
        return mask
    zz, yy, xx = np.nonzero(mask)
    box = (slice(max(zz.min() - 2, 0), zz.max() + 3), slice(max(yy.min() - 2, 0), yy.max() + 3),
           slice(max(xx.min() - 2, 0), xx.max() + 3))
    core = ndimage.binary_opening(mask[box], iterations=10)          # an air tube under about 20 mm across does not survive
    out = np.zeros(ct.shape, bool)
    out[box] = core
    return out


def zone_labels(lung):
    """left/right (RAS: larger x index is the patient's right) and upper/mid/lower thirds of the lungs."""
    zz, yy, xx = np.nonzero(lung)
    if zz.size == 0:
        return None
    z0, z1 = zz.min(), zz.max()
    xm = (xx.min() + xx.max()) / 2.0
    return {"z_edges": (z0 + (z1 - z0) / 3.0, z0 + 2 * (z1 - z0) / 3.0), "x_mid": xm}


def pick_zone_balanced(resp, lung, body_soft, spacing, props):
    """Greedy non-maximum suppression per zone. Returns a list of dicts with zyx index and zone."""
    z = zone_labels(lung)
    if z is None:
        return []
    zi = np.indices(lung.shape)
    side = np.where(zi[2] > z["x_mid"], "right", "left")
    third = np.where(zi[0] < z["z_edges"][0], "lower", np.where(zi[0] < z["z_edges"][1], "mid", "upper"))
    inner = lung & ~_erode_edge(lung, 4)
    out = []
    zones = [(f"lung_{sd}_{th}", inner & (side == sd) & (third == th), props["per_lung_zone"])
             for sd in ("left", "right") for th in ("upper", "mid", "lower")]
    zones.append(("other", body_soft & ~_dilate(lung, 6), props["other_zone"]))
    for name, mask, quota in zones:
        idx = np.argwhere(mask)
        if idx.shape[0] == 0:
            continue
        r = resp[mask]
        order = np.argsort(-r)[:20000]
        chosen = []
        for k in order:
            p = idx[k]
            if all(np.linalg.norm((p - q) * spacing) >= props["min_spacing_mm"] for q in chosen):
                chosen.append(p)
            if len(chosen) >= quota:
                break
        for p in chosen:
            out.append({"zone": name, "index_zyx": [int(v) for v in p], "response": float(resp[tuple(p)])})
    # a point is kept only once, in the first zone that chose it
    seen, uniq = [], []
    for c in out:
        p = np.array(c["index_zyx"])
        if all(np.linalg.norm((p - q) * spacing) >= props["min_spacing_mm"] / 2 for q in seen):
            seen.append(p)
            uniq.append(c)
    return uniq


def pick_liver_zones(resp, liver_inner, spacing, props):
    """Greedy non-maximum suppression in six zones of the liver: its own left and right halves (by the middle of the liver in x,
    larger x index is the patient's right) and lower, mid and upper thirds of its extent along the slice axis."""
    zz, yy, xx = np.nonzero(liver_inner)
    if zz.size == 0:
        return []
    z0, z1 = zz.min(), zz.max()
    edges = (z0 + (z1 - z0) / 3.0, z0 + 2 * (z1 - z0) / 3.0)
    xm = (xx.min() + xx.max()) / 2.0
    zi = np.indices(liver_inner.shape)
    side = np.where(zi[2] > xm, "right", "left")
    third = np.where(zi[0] < edges[0], "lower", np.where(zi[0] < edges[1], "mid", "upper"))
    out = []
    for sd in ("left", "right"):
        for th in ("upper", "mid", "lower"):
            mask = liver_inner & (side == sd) & (third == th)
            idx = np.argwhere(mask)
            if idx.shape[0] == 0:
                continue
            order = np.argsort(-resp[mask])[:20000]
            chosen = []
            for k in order:
                p = idx[k]
                if all(np.linalg.norm((p - q) * spacing) >= props["min_spacing_mm"] for q in chosen):
                    chosen.append(p)
                if len(chosen) >= props["per_zone"]:
                    break
            for p in chosen:
                out.append({"zone": f"liver_{sd}_{th}", "index_zyx": [int(v) for v in p], "response": float(resp[tuple(p)])})
    return out


def _erode_edge(mask, it):
    from scipy import ndimage
    return ~ndimage.binary_erosion(mask, iterations=it)


def _dilate(mask, it):
    from scipy import ndimage
    return ndimage.binary_dilation(mask, iterations=it)


def match_patch(fixed_arr, moving_arr, f_idx_zyx, m_pred_idx_zyx, props, clip=None):
    """Template-match a fixed patch inside a search window of the moving scan.
    Returns None or dict(index_zyx (float), ncc, second_ncc). Arrays are z,y,x at 1 mm."""
    from skimage.feature import match_template
    h = int(props["patch_half_mm"])
    sh = int(props["search_half_mm"])
    f = np.array([int(round(v)) for v in f_idx_zyx])
    m = np.array([int(round(v)) for v in m_pred_idx_zyx])
    if np.any(f - h < 0) or np.any(f + h + 1 > np.array(fixed_arr.shape)):
        return None
    c0, c1 = clip if clip else (-1000, 300)
    patch = np.clip(fixed_arr[f[0] - h:f[0] + h + 1, f[1] - h:f[1] + h + 1, f[2] - h:f[2] + h + 1], c0, c1).astype(np.float32)
    if patch.std() < 1e-3:
        return None
    lo = m - sh - h
    hi = m + sh + h + 1
    lo_c = np.maximum(lo, 0)
    hi_c = np.minimum(hi, np.array(moving_arr.shape))
    win = np.clip(moving_arr[lo_c[0]:hi_c[0], lo_c[1]:hi_c[1], lo_c[2]:hi_c[2]], c0, c1).astype(np.float32)
    if any(s < 2 * h + 3 for s in win.shape):
        return None
    cc = match_template(win, patch, pad_input=False)
    pk = np.unravel_index(int(np.argmax(cc)), cc.shape)
    peak = float(cc[pk])
    masked = cc.copy()
    r = 4
    masked[max(0, pk[0] - r):pk[0] + r + 1, max(0, pk[1] - r):pk[1] + r + 1, max(0, pk[2] - r):pk[2] + r + 1] = -1.0
    second = float(masked.max())
    sub = []
    for ax in range(3):
        k = pk[ax]
        if 0 < k < cc.shape[ax] - 1:
            a = list(pk); b = list(pk); a[ax] -= 1; b[ax] += 1
            ym, y0, yp = float(cc[tuple(a)]), peak, float(cc[tuple(b)])
            den = ym - 2 * y0 + yp
            sub.append(0.5 * (ym - yp) / den if abs(den) > 1e-9 else 0.0)
        else:
            sub.append(0.0)
    center = np.array(pk, float) + np.array(sub) + h + lo_c      # patch centre in moving index space
    return {"index_zyx": [float(v) for v in center], "ncc": round(peak, 4), "second_ncc": round(second, 4)}


def dog_filter(arr, props):
    """Band-pass copy of a 1 mm scan: soft-tissue window, then small Gaussian minus large Gaussian (vessel branches against the local background)."""
    from scipy import ndimage
    a = np.clip(arr.astype(np.float32), props["soft_lo_hu"], props["soft_hi_hu"])
    return ndimage.gaussian_filter(a, props["dog_sigma_small_mm"]) - ndimage.gaussian_filter(a, props["dog_sigma_large_mm"])


def liver_offset(c_fixed_phys, c_moving_phys, rigid_apply):
    """Residual offset of the liver after the rigid step, in the moving scan's physical space: where the liver centroid of the moving scan is,
    minus where the rigid transform sends the liver centroid of the reference. Added to the rigid prediction of every point."""
    return np.asarray(c_moving_phys, float) - np.asarray(rigid_apply(tuple(float(v) for v in c_fixed_phys)), float)


def cycle_distance(fixed_arr, moving_arr, f_idx_zyx, m_idx_zyx, props, clip=None):
    """Forward-backward check on a match: take the patch of the moving scan at the matched point and look for it in the reference around
    the original point; the distance (mm, both scans at 1 mm) between where it is found and the original point. None if it cannot be matched back."""
    rp = dict(props); rp["search_half_mm"] = props.get("cycle_search_half_mm", 12)
    back = match_patch(moving_arr, fixed_arr, m_idx_zyx, f_idx_zyx, rp, clip=clip)
    if back is None:
        return None
    return float(np.linalg.norm(np.array(back["index_zyx"]) - np.array([float(v) for v in f_idx_zyx])))


def _centroid_phys(img, ids):
    import SimpleITK as sitk
    a = sitk.GetArrayFromImage(img)
    idx = np.argwhere(np.isin(a, ids))
    if idx.shape[0] == 0:
        raise RuntimeError("the liver label is empty")
    m = idx.mean(axis=0)
    return np.array(img.TransformContinuousIndexToPhysicalPoint((float(m[2]), float(m[1]), float(m[0]))))


# ------------------------------------------------------------------------------ propose
def propose(job_dir, criteria_path, out_dir):
    import SimpleITK as sitk
    import ants
    crit = json.load(open(criteria_path))
    props = crit["proposal"]
    man = json.load(open(os.path.join(job_dir, "manifest.json")))
    ref = man["reference"]
    movers = [t["label"] for t in man["timepoints"] if t["label"] != ref]
    os.makedirs(out_dir, exist_ok=True)
    fx = sitk.ReadImage(os.path.join(job_dir, "frame", f"{ref}_ct.nii.gz"))
    fa = sitk.GetArrayFromImage(fx)
    sp = np.array(fx.GetSpacing())[::-1]
    if not np.allclose(sp, 1.0, atol=0.05):
        raise RuntimeError(f"the landmark check expects 1.0 mm isotropic scans, got {sp}")
    if props.get("region") == "liver":
        from scipy import ndimage
        names = {int(k): v for k, v in man["label_names"].items()}
        liver_id = [k for k, v in names.items() if v == "liver"][0]
        flab = sitk.GetArrayFromImage(sitk.ReadImage(os.path.join(job_dir, "frame", f"{ref}_labels.nii.gz")))
        liver_inner = ndimage.binary_erosion(flab == liver_id, iterations=int(props["min_edge_from_liver_surface_mm"]))
        resp = foerstner_response(fa, lo=props["soft_lo_hu"], hi=props["soft_hi_hu"])
        cands = pick_liver_zones(resp, liver_inner, sp, props)
    else:
        resp = foerstner_response(fa)
        lung = lung_mask_from_ct(fa, props["air_hu"])
        body_soft = (fa > -100) & (fa < 300)
        cands = pick_zone_balanced(resp, lung, body_soft, sp, props)
    for i, c in enumerate(cands):
        c["id"] = f"L{i + 1:02d}"
        zyx = c["index_zyx"]
        c["fixed_phys_mm"] = [round(v, 3) for v in fx.TransformContinuousIndexToPhysicalPoint((zyx[2], zyx[1], zyx[0]))]
    fa_dog = dog_filter(fa, props) if props.get("dog") else None
    result = {"schema": SCHEMA, "job_id": man["job_id"], "reference": ref, "movers": movers,
              "criteria_sha256": file_sha256(criteria_path), "proposal": props, "landmarks": cands, "n_candidates": len(cands),
              "reader_instructions": ("For each landmark and each moving scan set verdict to accept, reject, or "
                                      "{\"corrected_moving_phys_mm\": [x,y,z]}. Unsure means reject.")}
    for mv in movers:
        pair = f"{mv}_to_{ref}"
        mx = sitk.ReadImage(os.path.join(job_dir, "native", mv, "ct.nii.gz"))
        ma = sitk.GetArrayFromImage(mx)
        rigid = ants.read_transform(os.path.join(job_dir, "pairs", pair, "rigid.mat"))
        n_ok = 0
        offset = np.zeros(3)
        if props.get("liver_offset"):
            mlab = sitk.ReadImage(os.path.join(job_dir, "native", mv, "labels.nii.gz"))
            offset = liver_offset(_centroid_phys(sitk.ReadImage(os.path.join(job_dir, "frame", f"{ref}_labels.nii.gz")), [liver_id]),
                                  _centroid_phys(mlab, [liver_id]), rigid.apply_to_point)
            result.setdefault("liver_offset_phys_mm", {})[mv] = [round(float(v), 2) for v in offset]
        if not np.allclose(mx.GetSpacing(), 1.0, atol=0.05):
            raise RuntimeError(f"the landmark check expects a 1.0 mm native scan for {mv}, got {mx.GetSpacing()}")
        if props.get("dog"):
            fa_m, ma_m, clip = fa_dog, dog_filter(ma, props), (-1.0e4, 1.0e4)
        else:
            fa_m, ma_m, clip = fa, ma, None
        for c in cands:
            p_f = np.array(c["fixed_phys_mm"])
            pred = np.asarray(rigid.apply_to_point(tuple(float(v) for v in p_f))) + offset    # fixed -> moving, as in register.py, plus the liver's residual offset
            pi = mx.TransformPhysicalPointToContinuousIndex(tuple(float(v) for v in pred))
            m = match_patch(fa_m, ma_m, c["index_zyx"], (pi[2], pi[1], pi[0]), props, clip=clip)
            entry = {"rigid_prediction_phys_mm": [round(float(v), 3) for v in pred]}
            if m is None:
                entry.update(status="no_match_window")
            else:
                ph = mx.TransformContinuousIndexToPhysicalPoint((m["index_zyx"][2], m["index_zyx"][1], m["index_zyx"][0]))
                entry.update(moving_phys_mm=[round(float(v), 3) for v in ph], ncc=m["ncc"], second_ncc=m["second_ncc"],
                             offset_from_rigid_prediction_mm=round(float(np.linalg.norm(np.array(ph) - pred)), 2))
                ok = m["ncc"] >= props["ncc_min"] and (m["ncc"] - m["second_ncc"]) >= props["margin_min"]
                status = "proposed" if ok else "filtered_low_confidence"
                if ok and props.get("cycle_max_mm") is not None:
                    cyc = cycle_distance(fa_m, ma_m, c["index_zyx"], m["index_zyx"], props, clip=clip)
                    entry["cycle_distance_mm"] = None if cyc is None else round(cyc, 2)
                    if cyc is None or cyc > props["cycle_max_mm"]:
                        status, ok = "filtered_cycle_inconsistent", False
                entry["status"] = status
                n_ok += int(ok)
            c.setdefault("matches", {})[mv] = entry
            c.setdefault("verdict", {})[mv] = None
        result.setdefault("proposed_per_mover", {})[mv] = n_ok
        _review_sheets(fa, ma, fx, mx, cands, mv, out_dir)
    with open(os.path.join(out_dir, "landmarks_proposed.json"), "w") as f:
        json.dump(result, f, indent=2)
    return result


def window_for(zone):
    """Display window by zone: lung, liver (vessels against enhanced parenchyma) or other soft tissue."""
    if zone.startswith("lung"):
        return (-1000, 200)
    if zone.startswith("liver"):
        return (-20, 220)
    return (-160, 240)


def _crop(arr, idx_zyx, half=24):
    c = [int(round(v)) for v in idx_zyx]
    pad = np.pad(arr, half, mode="constant", constant_values=-1024)
    c = [v + half for v in c]
    return pad[c[0] - half:c[0] + half + 1, c[1] - half:c[1] + half + 1, c[2] - half:c[2] + half + 1]


def _views(vol3):
    """Axial, coronal, sagittal of a small cube in the radiological convention of register.py."""
    h = vol3.shape[0] // 2
    return [np.rot90(vol3[h], 2), np.rot90(vol3[:, h, :], 2), np.rot90(vol3[:, :, h], 2)]


def _review_sheets(fa, ma, fx, mx, cands, mover, out_dir, per_sheet=6):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    rows = [c for c in cands if c["matches"][mover].get("moving_phys_mm") is not None]
    for s in range(0, len(rows), per_sheet):
        chunk = rows[s:s + per_sheet]
        fig, axes = plt.subplots(len(chunk), 6, figsize=(12, 2.1 * len(chunk)))
        axes = np.atleast_2d(axes)
        for r, c in enumerate(chunk):
            m = c["matches"][mover]
            lo, hi = window_for(c["zone"])
            fi = c["index_zyx"]
            mi = mx.TransformPhysicalPointToContinuousIndex(tuple(m["moving_phys_mm"]))
            fv, mv = _views(_crop(fa, fi)), _views(_crop(ma, (mi[2], mi[1], mi[0])))
            for k in range(3):
                for j, (im, who) in enumerate(((fv[k], "reference"), (mv[k], mover))):
                    ax = axes[r, 3 * j + k]
                    ax.imshow(np.clip((im.astype(np.float32) - lo) / (hi - lo), 0, 1), cmap="gray", aspect="equal")
                    ax.axhline(im.shape[0] / 2, color="#ff3b3b", lw=0.4); ax.axvline(im.shape[1] / 2, color="#ff3b3b", lw=0.4)
                    ax.set_xticks([]); ax.set_yticks([])
                    if r == 0:
                        ax.set_title(f"{who} {['axial', 'coronal', 'sagittal'][k]}", fontsize=7)
            axes[r, 0].set_ylabel(f"{c['id']}\n{c['zone']}\nNCC {m['ncc']}\nstatus {m['status']}", fontsize=6, rotation=0, labelpad=34, va="center")
        fig.suptitle(f"{mover}: do the red crosshairs mark the SAME anatomical point? (48 mm view)", fontsize=9)
        fig.tight_layout()
        fig.savefig(os.path.join(out_dir, f"review_{mover}_{s // per_sheet + 1:02d}.png"), dpi=80)
        plt.close(fig)


# ------------------------------------------------------------------------------ measure
def stage_transforms(pair_dir, man_pair):
    """Rebuild the stored stages: initial, rigid, deformable (piecewise: body plus regions)."""
    p = lambda name: os.path.join(pair_dir, name)
    apply_ = man_pair["apply"]
    regions = []
    for name, spec in apply_.items():
        if name == "body":
            continue
        regions.append({"name": name, "tf": [p(x) for x in spec["transforms"]], "select": p(spec["select"])})
    order = ["lung", "viscera"]
    regions.sort(key=lambda r: order.index(r["name"]) if r["name"] in order else 99)
    return {"initial": [p("init.mat")], "rigid": [p("rigid.mat")],
            "deformable": {"body": [p(x) for x in apply_["body"]["transforms"]], "regions": regions}}


def map_moving_point_to_fixed(ants, sitk, fixed_ct, p_f, p_m, stages, select_cache, sigma_mm=2.0, pad_mm=45):
    """Where does the registration put the moving point, in the reference frame?
    A small Gaussian image at the moving point is resampled with the same transforms and the same
    piecewise hard switch as the label maps, onto a crop of the reference grid around the reference
    point; the centroid is the answer. Mass outside 0.4 to 2.5 of the original, or a blob touching
    the crop, is flagged."""
    from scipy import ndimage
    idx = fixed_ct.TransformPhysicalPointToContinuousIndex(tuple(float(v) for v in p_f))
    c = [int(round(v)) for v in idx]
    size = [2 * pad_mm + 1] * 3
    start = [max(0, c[k] - pad_mm) for k in range(3)]
    size = [min(size[k], fixed_ct.GetSize()[k] - start[k]) for k in range(3)]
    crop = sitk.RegionOfInterest(fixed_ct, size, start)
    n = 25
    zz, yy, xx = np.indices((n, n, n)).astype(np.float32) - n // 2
    g = np.exp(-(xx ** 2 + yy ** 2 + zz ** 2) / (2 * sigma_mm ** 2)).astype(np.float32)
    blob = sitk.GetImageFromArray(g)
    blob.SetSpacing((1.0, 1.0, 1.0))
    blob.SetOrigin(tuple(float(p_m[k] - n // 2) for k in range(3)))
    with tempfile.TemporaryDirectory() as td:
        pc, pb = os.path.join(td, "crop.nii.gz"), os.path.join(td, "blob.nii.gz")
        sitk.WriteImage(crop, pc); sitk.WriteImage(blob, pb)
        A_crop, A_blob = ants.image_read(pc), ants.image_read(pb)
        res = {}
        for st, tf in stages.items():
            if isinstance(tf, dict):
                body = ants.apply_transforms(A_crop, A_blob, tf["body"], interpolator="linear", defaultvalue=0).numpy()
                out = body.copy()
                near = None
                for reg in tf["regions"]:
                    w = ants.apply_transforms(A_crop, A_blob, reg["tf"], interpolator="linear", defaultvalue=0).numpy()
                    key = reg["select"]
                    if key not in select_cache:
                        select_cache[key] = ants.image_read(key)
                    sel = ants.resample_image_to_target(select_cache[key], A_crop, interp_type="nearestNeighbor").numpy() > 0
                    out = np.where(sel, w, out)
                    cx = tuple(int(round(v)) for v in crop.TransformPhysicalPointToContinuousIndex(tuple(float(v) for v in p_f)))
                    if sel.any() and not sel.all() and all(0 <= cx[k] < sel.shape[k] for k in range(3)):
                        d = min(ndimage.distance_transform_edt(sel)[cx], ndimage.distance_transform_edt(~sel)[cx])
                        near = d if near is None else min(near, d)
                arr = out
                boundary = bool(near is not None and near <= 8.0)
            else:
                arr = ants.apply_transforms(A_crop, A_blob, tf, interpolator="linear", defaultvalue=0).numpy()
                boundary = False
            mass = float(arr.sum())
            if mass <= 1e-6:
                res[st] = {"fixed_phys_mm": None, "flag": "blob_lost"}
                continue
            ix = np.indices(arr.shape).reshape(3, -1)
            cen = (ix * arr.reshape(-1)).sum(axis=1) / mass
            phys = crop.TransformContinuousIndexToPhysicalPoint(tuple(float(v) for v in cen))
            ratio = mass / float(g.sum())
            touches = bool(arr[0].sum() + arr[-1].sum() + arr[:, 0].sum() + arr[:, -1].sum() + arr[:, :, 0].sum() + arr[:, :, -1].sum() > 0.02 * mass)
            flag = "ok"
            if ratio < 0.4 or ratio > 2.5:
                flag = "mass_changed"
            if touches:
                flag = "touches_crop"
            res[st] = {"fixed_phys_mm": [round(float(v), 3) for v in phys], "mass_ratio": round(ratio, 3), "flag": flag,
                       "near_region_boundary": boundary}
    return res


def reader_view(rv):
    """What the verified file says about the reader of one moving scan, and whether the reader can be relied on:
    UNRELIABLE when the reader accepted more of the deliberately wrong decoy matches than allowed."""
    rv = rv or {}
    dc = rv.get("decoy_check")
    if dc is None:
        check = "not_measured"
    else:
        check = "OK" if dc["accepted"] <= dc.get("max_allowed", 1) else "UNRELIABLE"
    return {"reader": rv.get("reader"), "reader_role": rv.get("reader_role"), "decoy_check": dc,
            "reader_check": check, "recorded_at_utc": rv.get("recorded_at_utc")}


def verify(proposed_path, mover, accept_ids, correct, out_path, reader=None, reader_role=None, decoy_check=None):
    """Record a reader's decisions for one moving scan. Every proposed pair not listed as accepted
    (or corrected) is a reject. Proposals the algorithm filtered stay unreviewed and are not measured.
    `reader` and `reader_role` are written into the file: a verification nobody signed is not evidence."""
    data = json.load(open(out_path if os.path.exists(out_path) else proposed_path))
    accept, known = set(accept_ids), {c["id"] for c in data["landmarks"]}
    unknown = (accept | set(correct)) - known
    if unknown:
        raise SystemExit(f"unknown landmark ids: {sorted(unknown)}")
    n_acc = n_rej = n_cor = 0
    for c in data["landmarks"]:
        m = c["matches"].get(mover, {})
        if m.get("status") != "proposed" and c["id"] not in correct:
            continue
        if c["id"] in correct:
            c["verdict"][mover] = {"corrected_moving_phys_mm": [float(v) for v in correct[c["id"]]]}
            n_cor += 1
        elif c["id"] in accept:
            c["verdict"][mover] = "accept"
            n_acc += 1
        else:
            c["verdict"][mover] = "reject"
            n_rej += 1
    data.setdefault("reviewed", {})[mover] = {"accepted": n_acc, "rejected": n_rej, "corrected": n_cor,
                                             "reader": reader, "reader_role": reader_role, "decoy_check": decoy_check,
                                             "recorded_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    with open(out_path, "w") as f:
        json.dump(data, f, indent=2)
    return data["reviewed"][mover]


# ------------------------------------------------------------------------------ the reading page
DECOY_SHIFT_MM = 8.0
DECOYS_PER_MOVER = 4
MAX_DECOYS_ACCEPTED = 1


def _png_b64(rgb):
    import base64
    import io
    from PIL import Image
    b = io.BytesIO()
    Image.fromarray(rgb).save(b, "PNG", optimize=True)
    return base64.b64encode(b.getvalue()).decode("ascii")


def _panel(im, lo, hi, scale=5, gap_px=8, thick=2):
    """One view, enlarged, with red lines that stop short of the centre so the structure under the point stays visible."""
    from PIL import Image
    g = (np.clip((im.astype(np.float32) - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)
    big = np.array(Image.fromarray(g).resize((g.shape[1] * scale, g.shape[0] * scale), Image.BICUBIC))
    rgb = np.stack([big] * 3, -1)
    cy, cx, t = big.shape[0] // 2, big.shape[1] // 2, thick // 2
    red = np.array([255, 59, 59], np.uint8)
    rgb[cy - t:cy + t + 1, :cx - gap_px] = red
    rgb[cy - t:cy + t + 1, cx + gap_px + 1:] = red
    rgb[:cy - gap_px, cx - t:cx + t + 1] = red
    rgb[cy + gap_px + 1:, cx - t:cx + t + 1] = red
    return rgb


def render_item(fa, ma, mx, cand, mover, shift_mm=None):
    """Reference above, the other scan below; axial, coronal, sagittal left to right. `shift_mm` moves the point in the
    other scan (a decoy). No score of the matching algorithm is drawn."""
    lo, hi = window_for(cand["zone"])
    p = np.array(cand["matches"][mover]["moving_phys_mm"], float)
    if shift_mm is not None:
        p = p + np.array(shift_mm, float)
    mi = mx.TransformPhysicalPointToContinuousIndex(tuple(float(v) for v in p))
    fv, mv = _views(_crop(fa, cand["index_zyx"])), _views(_crop(ma, (mi[2], mi[1], mi[0])))
    top = np.concatenate([_panel(v, lo, hi) for v in fv], axis=1)
    bot = np.concatenate([_panel(v, lo, hi) for v in mv], axis=1)
    sep = np.full((6, top.shape[1], 3), 40, np.uint8)
    return np.concatenate([top, sep, bot], axis=0)


def build_review_items(cands, movers, n_decoys=DECOYS_PER_MOVER, seed=1):
    """The things the reader sees, in a seeded shuffled order with opaque ids: every proposed pair, plus decoys (a
    proposed pair whose point in the other scan is moved DECOY_SHIFT_MM). Returns (items, key)."""
    rng = np.random.default_rng(seed)
    raw = []
    for mv in movers:
        ok = [c for c in cands if c["matches"].get(mv, {}).get("status") == "proposed"]
        for c in ok:
            raw.append({"landmark": c["id"], "mover": mv, "decoy": False, "shift_mm": None})
        best = sorted(ok, key=lambda c: -c["matches"][mv]["ncc"])
        for c in [best[i] for i in rng.choice(len(best), size=min(n_decoys, len(best)), replace=False)] if best else []:
            v = rng.normal(0, 1, 3)
            v = v / np.linalg.norm(v) * DECOY_SHIFT_MM
            raw.append({"landmark": c["id"], "mover": mv, "decoy": True, "shift_mm": [round(float(a), 3) for a in v]})
    order = rng.permutation(len(raw))
    items, key = [], {}
    for n, k in enumerate(order):
        it = dict(raw[k])
        it["id"] = f"i{n + 1:03d}"
        items.append(it)
        key[it["id"]] = {"landmark": it["landmark"], "mover": it["mover"], "decoy": it["decoy"], "shift_mm": it["shift_mm"]}
    return items, key


PAGE_TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Landmark review</title>
<style>
:root{--bg:#ffffff;--fg:#111111;--mut:#333333;--card:#f2f2f2;--line:#bdbdbd;--ok:#0b6b3a;--no:#9b1c1c;--un:#6b4e00}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#f0f0f0;--mut:#dddddd;--card:#1e1e1e;--line:#4a4a4a;--ok:#6fe0a0;--no:#ff9a9a;--un:#f0cf6a}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;margin:0 auto;max-width:860px;padding:16px}
h1{font-size:1.3rem;margin:0 0 8px} p{margin:6px 0;color:var(--mut)} .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:14px 0}
.card img{width:100%;height:auto;display:block;border-radius:4px;image-rendering:auto} .meta{font-size:.9rem;color:var(--mut);margin-bottom:6px}
.btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px} .btns label{border:1px solid var(--line);border-radius:6px;padding:8px 14px;cursor:pointer;min-height:24px}
.btns input{margin-right:6px} .card.done-accept{border-color:var(--ok)} .card.done-reject{border-color:var(--no)} .card.done-unsure{border-color:var(--un)}
.bar{position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);z-index:2} .row{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0}
input[type=text]{flex:1;min-width:200px;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
button{padding:10px 16px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;cursor:pointer} textarea{width:100%;height:120px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px}
</style></head><body>
<h1>Landmark review</h1>
<p>Each card shows two scans of the same patient. The top row is the reference scan, the bottom row is the other scan. The columns are the same three views (axial, coronal, sagittal) through the marked point. The red lines cross at the point and stop short of the centre so that you can see the structure under it.</p>
<p>Choose <b>Same point</b> only when the structure at the centre of the top row (a vessel branch, a fissure point, a bony point) is the same anatomical point as in the bottom row. Choose <b>Not the same</b> when it is not. Choose <b>Unsure</b> when you cannot tell; unsure counts as not the same. Some cards are deliberately wrong. Nothing on this page says which.</p>
<div class="bar"><div class="row"><input type="text" id="reader" placeholder="Your name"><input type="text" id="role" placeholder="Your role (for example radiologist, or engineer)"></div>
<div id="progress"></div></div>
<div id="cards">__CARDS__</div>
<div class="card"><div class="row"><button id="export">Finish and export decisions</button></div><p>The export is a small text file. Save it and give it to the engineer; it carries your name, your role and every decision.</p><textarea id="out" readonly></textarea></div>
<script id="meta" type="application/json">__META__</script>
<script>
const META = JSON.parse(document.getElementById('meta').textContent);
const KEY = 'landmark-review-' + META.page_id;
let state = {reader:'', role:'', decisions:{}};
try { const s = localStorage.getItem(KEY); if (s) state = JSON.parse(s); } catch (e) {}
function save(){ try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
function paint(){
  let n = 0;
  META.ids.forEach(id => {
    const card = document.getElementById('c_' + id), d = state.decisions[id];
    card.className = 'card' + (d ? ' done-' + d : '');
    card.querySelectorAll('input').forEach(i => { i.checked = (i.value === d); });
    if (d) n++;
  });
  document.getElementById('progress').textContent = n + ' of ' + META.ids.length + ' decided';
  document.getElementById('reader').value = state.reader; document.getElementById('role').value = state.role;
}
document.getElementById('cards').addEventListener('change', e => {
  if (e.target.name) { state.decisions[e.target.name] = e.target.value; save(); paint(); }
});
document.getElementById('reader').addEventListener('input', e => { state.reader = e.target.value; save(); });
document.getElementById('role').addEventListener('input', e => { state.role = e.target.value; save(); });
document.getElementById('export').addEventListener('click', () => {
  const left = META.ids.filter(id => !state.decisions[id]).length;
  if (!state.reader.trim() || !state.role.trim()) { alert('Please enter your name and your role first.'); return; }
  if (left) { alert(left + ' cards still have no decision.'); return; }
  const payload = {schema: 'imaging-register-landmark-decisions/1', page_id: META.page_id, reader: state.reader.trim(),
                   reader_role: state.role.trim(), finished_at: new Date().toISOString(), decisions: state.decisions};
  const text = JSON.stringify(payload, null, 1);
  document.getElementById('out').value = text;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  a.download = 'LandmarkDecisions.json'; a.click();
});
paint();
</script></body></html>
"""


def page_html(items_with_png, page_id, structure_text=None):
    cards = []
    for it in items_with_png:
        who = f"reference above, {it['mover']} below"
        cards.append(
            f'<div class="card" id="c_{it["id"]}"><div class="meta">Card {int(it["id"][1:])} · {it["zone_text"]} · {who}</div>'
            f'<img alt="reference and {it["mover"]}, axial, coronal and sagittal" src="data:image/png;base64,{it["png"]}">'
            f'<div class="btns"><label><input type="radio" name="{it["id"]}" value="accept">Same point</label>'
            f'<label><input type="radio" name="{it["id"]}" value="reject">Not the same</label>'
            f'<label><input type="radio" name="{it["id"]}" value="unsure">Unsure</label></div></div>')
    meta = json.dumps({"page_id": page_id, "ids": [it["id"] for it in items_with_png]}).replace("</", "<\\/")
    page = PAGE_TEMPLATE.replace("__CARDS__", "\n".join(cards)).replace("__META__", meta)
    if structure_text:
        page = page.replace("(a vessel branch, a fissure point, a bony point)", structure_text)
    return page


def _zone_text(zone):
    if zone.startswith("liver_"):
        return "liver, " + zone.replace("liver_", "").replace("_", " ") + " zone"
    return {"other": "outside the lungs"}.get(zone, zone.replace("lung_", "").replace("_", " ") + " lung zone")


def review_page(job_dir, proposed_path, out_dir, n_decoys=DECOYS_PER_MOVER, seed=1):
    """Write review_page.html (self-contained) and review_key.json (opaque card id to landmark, scan and decoy flag).
    Keep the key away from the reader."""
    import SimpleITK as sitk
    data = json.load(open(proposed_path))
    ref = data["reference"]
    fa = sitk.GetArrayFromImage(sitk.ReadImage(os.path.join(job_dir, "frame", f"{ref}_ct.nii.gz")))
    cands = {c["id"]: c for c in data["landmarks"]}
    items, key = build_review_items(data["landmarks"], data["movers"], n_decoys, seed)
    imgs = {}
    for mv in data["movers"]:
        mx = sitk.ReadImage(os.path.join(job_dir, "native", mv, "ct.nii.gz"))
        imgs[mv] = (mx, sitk.GetArrayFromImage(mx))
    out = []
    for it in items:
        mx, ma = imgs[it["mover"]]
        c = cands[it["landmark"]]
        rgb = render_item(fa, ma, mx, c, it["mover"], it["shift_mm"])
        out.append({**it, "png": _png_b64(rgb), "zone_text": _zone_text(c["zone"])})
    os.makedirs(out_dir, exist_ok=True)
    page_id = hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()[:16]
    with open(os.path.join(out_dir, "review_page.html"), "w") as f:
        f.write(page_html(out, page_id, "(a vein branch point inside the liver, where a hepatic or portal vein divides)"
                          if (data.get("proposal") or {}).get("region") == "liver" else None))
    with open(os.path.join(out_dir, "review_key.json"), "w") as f:
        json.dump({"page_id": page_id, "proposed_sha256": file_sha256(proposed_path), "movers": data["movers"], "items": key,
                   "decoy_shift_mm": DECOY_SHIFT_MM, "max_decoys_accepted": MAX_DECOYS_ACCEPTED}, f, indent=1)
    return {"cards": len(out), "decoys": sum(1 for i in items if i["decoy"]), "page_id": page_id}


def verify_export(proposed_path, key_path, export_path, out_path):
    """Turn the reader's exported decisions into the verified file. Refuses an export for another page, one without the
    reader's name and role, and one with a card undecided. Decoys are not landmarks: they only measure the reader."""
    key = json.load(open(key_path))
    exp = json.load(open(export_path))
    if exp.get("page_id") != key["page_id"]:
        raise SystemExit("this export belongs to a different review page")
    reader, role = (exp.get("reader") or "").strip(), (exp.get("reader_role") or "").strip()
    if not reader or not role:
        raise SystemExit("the export has no reader name or role")
    dec = exp.get("decisions") or {}
    undecided = [i for i in key["items"] if dec.get(i) not in ("accept", "reject", "unsure")]
    if undecided:
        raise SystemExit(f"{len(undecided)} cards have no decision")
    summary = {}
    for mv in key["movers"]:
        acc = [it["landmark"] for i, it in key["items"].items() if it["mover"] == mv and not it["decoy"] and dec[i] == "accept"]
        decoys = [i for i, it in key["items"].items() if it["mover"] == mv and it["decoy"]]
        check = {"n": len(decoys), "accepted": sum(1 for i in decoys if dec[i] == "accept"),
                 "max_allowed": key.get("max_decoys_accepted", MAX_DECOYS_ACCEPTED), "shift_mm": key.get("decoy_shift_mm")}
        summary[mv] = verify(proposed_path, mv, acc, {}, out_path, reader=reader, reader_role=role, decoy_check=check)
    return summary


def tre_stats(vals):
    if not vals:
        return None
    a = np.array(vals, float)
    return {"n": int(a.size), "mean_mm": round(float(a.mean()), 3), "median_mm": round(float(np.median(a)), 3),
            "p90_mm": round(float(np.percentile(a, 90)), 3), "max_mm": round(float(a.max()), 3)}


def measure(job_dir, verified_path, criteria_path, out_path, criteria_amended=False):
    import SimpleITK as sitk
    import ants
    crit = json.load(open(criteria_path))
    ver = json.load(open(verified_path))
    if ver.get("criteria_sha256") != file_sha256(criteria_path) and not criteria_amended:
        raise RuntimeError("the criteria file changed after the proposal was written; use --criteria-amended and say why")
    man = json.load(open(os.path.join(job_dir, "manifest.json")))
    ref = man["reference"]
    fx = sitk.ReadImage(os.path.join(job_dir, "frame", f"{ref}_ct.nii.gz"))
    report = {"schema": "imaging-register-landmark-report/1", "job_id": man["job_id"], "reference": ref,
              "criteria_sha256": file_sha256(criteria_path), "criteria_amended": bool(criteria_amended),
              "gate_verdicts": man.get("gate", {}).get("by_pair"), "pairs": {}}
    for mv in ver["movers"]:
        pair = f"{mv}_to_{ref}"
        pd = os.path.join(job_dir, "pairs", pair)
        man_pair = next(p for p in man["pairs"] if p["pair"] == pair)
        stages = stage_transforms(pd, man_pair)
        cache = {}
        rows, rejected, unreviewed = [], 0, 0
        for c in ver["landmarks"]:
            v = c["verdict"].get(mv)
            m = c["matches"].get(mv, {})
            if v is None:
                unreviewed += 1
                continue
            if v == "reject":
                rejected += 1
                continue
            if v == "accept":
                p_m = m.get("moving_phys_mm")
            elif isinstance(v, dict) and v.get("corrected_moving_phys_mm"):
                p_m = v["corrected_moving_phys_mm"]
            else:
                rejected += 1
                continue
            if p_m is None:
                continue
            res = map_moving_point_to_fixed(ants, sitk, fx, c["fixed_phys_mm"], p_m, stages, cache)
            row = {"id": c["id"], "zone": c["zone"], "tre_mm": {}, "flags": {}}
            for st, r in res.items():
                row["flags"][st] = r["flag"] + ("+near_region_boundary" if r.get("near_region_boundary") else "")
                if r["fixed_phys_mm"] is not None and r["flag"] in ("ok", "mass_changed"):
                    row["tre_mm"][st] = round(float(np.linalg.norm(np.array(r["fixed_phys_mm"]) - np.array(c["fixed_phys_mm"]))), 3)
            rows.append(row)
        def vals(st, pick=lambda r: True):
            return [r["tre_mm"][st] for r in rows if st in r["tre_mm"] and pick(r)]
        lower = lambda r: r["zone"].endswith("_lower")
        stats = {st: tre_stats(vals(st)) for st in ("initial", "rigid", "deformable")}
        n_left = sum(1 for r in rows if "left" in r["zone"]); n_right = sum(1 for r in rows if "right" in r["zone"])
        n_lower = sum(1 for r in rows if lower(r))
        suff = crit["sufficiency"]
        enough = (len(rows) >= suff["min_verified_per_pair"] and min(n_left, n_right) >= suff.get("min_per_lung", suff.get("min_per_side", 0))
                  and n_lower >= suff["min_lower_third"])
        pas = crit["pass"]
        d = stats["deformable"]; r_ = stats["rigid"]
        lower_stats = tre_stats(vals("deformable", lower))
        checks = {}
        if d:
            checks["deformable_median"] = d["median_mm"] <= pas["deformable_median_tre_mm_max"]
            checks["deformable_p90"] = d["p90_mm"] <= pas["deformable_p90_tre_mm_max"]
            if lower_stats:
                checks["lower_third_median"] = lower_stats["median_mm"] <= pas["lower_third_median_tre_mm_max"]
            if pas.get("deformable_median_must_beat_rigid_median") and r_:
                checks["deformable_beats_rigid"] = d["median_mm"] < r_["median_mm"]
        verdict = "INSUFFICIENT_LANDMARKS" if not enough else ("PASS" if checks and all(checks.values()) else "FAIL")
        rdr = reader_view((ver.get("reviewed") or {}).get(mv))
        if rdr["reader_check"] == "UNRELIABLE":
            verdict = "READER_UNRELIABLE"          # the reader accepted wrong decoy matches: the confirmations cannot be trusted
        report["pairs"][pair] = {
            "reader": rdr,
            "verified_points": len(rows), "per_lung": {"left": n_left, "right": n_right}, "lower_third": n_lower,
            "rejected_by_reader": rejected, "not_reviewed": unreviewed, "tre_by_stage": stats,
            "tre_lower_third_deformable": lower_stats, "checks": checks, "verdict": verdict,
            "gate_verdict_for_comparison": (man.get("gate", {}).get("by_pair") or {}).get(pair),
            "points": rows}
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)
    return report


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("criteria"); a.add_argument("--job", required=True); a.add_argument("--out", required=True)
    a.add_argument("--region", choices=["lung", "liver"], default="lung")
    b = sub.add_parser("propose"); b.add_argument("--job-dir", required=True); b.add_argument("--criteria", required=True); b.add_argument("--out-dir", required=True)
    v = sub.add_parser("verify"); v.add_argument("--proposed", required=True); v.add_argument("--mover", required=True)
    v.add_argument("--accept", default="", help="comma separated ids the reader accepts; every other proposed pair is rejected")
    v.add_argument("--correct", action="append", default=[], help="L03=x,y,z corrected position in the moving scan (mm, ITK physical)")
    v.add_argument("--reader", required=True, help="who made these decisions")
    v.add_argument("--reader-role", required=True, help="their role, for example radiologist or engineer")
    v.add_argument("--out", required=True)
    rp = sub.add_parser("review-page"); rp.add_argument("--job-dir", required=True); rp.add_argument("--proposed", required=True)
    rp.add_argument("--out-dir", required=True); rp.add_argument("--decoys", type=int, default=DECOYS_PER_MOVER); rp.add_argument("--seed", type=int, default=1)
    ve = sub.add_parser("verify-export"); ve.add_argument("--proposed", required=True); ve.add_argument("--key", required=True)
    ve.add_argument("--export", required=True); ve.add_argument("--out", required=True)
    c = sub.add_parser("measure"); c.add_argument("--job-dir", required=True); c.add_argument("--verified", required=True)
    c.add_argument("--criteria", required=True); c.add_argument("--out", required=True); c.add_argument("--criteria-amended", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "criteria":
        if os.path.exists(args.out):
            raise SystemExit(f"{args.out} exists; the criteria are not rewritten once registered")
        json.dump(default_criteria(args.job, args.region), open(args.out, "w"), indent=2)
        print(f"criteria written: {args.out} sha256 {file_sha256(args.out)}")
    elif args.cmd == "propose":
        r = propose(args.job_dir, args.criteria, args.out_dir)
        print(json.dumps({"candidates": r["n_candidates"], "proposed_per_mover": r.get("proposed_per_mover")}))
    elif args.cmd == "verify":
        corr = {k: v.split(",") for k, v in (x.split("=") for x in args.correct)}
        print(json.dumps(verify(args.proposed, args.mover, [x for x in args.accept.split(",") if x], corr, args.out,
                                reader=args.reader, reader_role=args.reader_role)))
    elif args.cmd == "review-page":
        print(json.dumps(review_page(args.job_dir, args.proposed, args.out_dir, args.decoys, args.seed)))
    elif args.cmd == "verify-export":
        print(json.dumps(verify_export(args.proposed, args.key, args.export, args.out), indent=1))
    else:
        r = measure(args.job_dir, args.verified, args.criteria, args.out, args.criteria_amended)
        print(json.dumps({p: {"verdict": v["verdict"], "n": v["verified_points"], "tre": v["tre_by_stage"]} for p, v in r["pairs"].items()}, indent=2))


if __name__ == "__main__":
    main(sys.argv[1:])
