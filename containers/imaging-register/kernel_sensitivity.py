#!/usr/bin/env python3
"""How much of the difference in aerated lung mass between scans can the reconstruction (sharpness) explain?

Reads <job out>/manifest.json and <job out>/native/<label>/{ct,labels}.nii.gz of a finished register job. numpy and scipy only,
no registration result is used. Usage: kernel_sensitivity.py <job out dir> <report.json>

For each scan:
  noise              standard deviation of HU inside the tracheal lumen (air), and a high-pass noise estimate in the lung core
                     (the scan minus its 2 mm Gaussian smoothing, robust spread, where the lung is plain parenchyma)
  mass by erosion    aerated lung mass of the lung label (erosion 0) and of its core (voxels deeper than 2, 4, 6 mm inside the label)
  mass by blur       the same masses after smoothing the scan with a Gaussian of sigma 0.4 to 1.6 mm, to show how the number
                     moves with sharpness on this very lung

Then for every pair of scans: the difference of mass at each erosion, and the smoothing at which the sharper scan's whole-label
mass equals the other's. If the core masses agree where the whole-label masses do not, the difference is in the rim
(the label edge), where sharpness decides how much tissue density spills into the count; if they disagree at every depth,
the difference is not the rim.
"""
import json
import os
import sys

import numpy as np
import SimpleITK as sitk
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import known_answer as KA

SIGMAS = (0.0, 0.4, 0.6, 0.8, 1.0, 1.2, 1.6)
ERO = (0.0, 2.0, 4.0, 6.0)


def crop_to_lungs(ct, lab, lung_ids, pad=16):
    zz, yy, xx = np.nonzero(np.isin(lab, lung_ids))
    sl = tuple(slice(max(a.min() - pad, 0), a.max() + pad + 1) for a in (zz, yy, xx))
    return ct[sl], lab[sl]


def highpass_sd(a, dist, sp, core_mm=6.0):
    """Robust spread of the scan minus its 2 mm smoothing in plain lung parenchyma deeper than core_mm."""
    sm = ndimage.gaussian_filter(a.astype(np.float32), [2.0 / s for s in sp])
    m = (dist > core_mm) & (sm < -700)
    r = (a.astype(np.float32) - sm)[m]
    return round(float(1.4826 * np.median(np.abs(r - np.median(r)))), 2) if r.size > 1000 else None


def one_scan(ct_img, lab_img, names):
    lung_ids = KA.ids_matching(names, r"^lung_")
    trachea = KA.ids_matching(names, r"^trachea$")
    sp = tuple(float(v) for v in ct_img.GetSpacing()[::-1])
    ct, lab = crop_to_lungs(sitk.GetArrayFromImage(ct_img), sitk.GetArrayFromImage(lab_img), lung_ids)
    dist = KA.lung_distance_map(lab, lung_ids, sp)
    tr = ndimage.binary_erosion(np.isin(lab, trachea), iterations=2)
    out = {"spacing_zyx_mm": [round(v, 3) for v in sp],
           "trachea_lumen_hu": None if tr.sum() < 300 else {"mean": round(float(ct[tr].mean()), 1), "sd": round(float(ct[tr].std()), 2),
                                                           "voxels": int(tr.sum())},
           "by_blur": []}
    for s in SIGMAS:
        a = ct if s == 0 else ndimage.gaussian_filter(ct.astype(np.float32), [s / v for v in sp])
        out["by_blur"].append({"blur_sigma_mm": s, "mass_g_by_erosion_mm": KA.mass_by_erosion(a, dist, sp, ERO),
                               "highpass_sd_hu": highpass_sd(a, dist, sp)})
    return out


def sigma_that_matches(sharp_rows, target_mass, erosion="0.0"):
    """Interpolated blur sigma at which the sharper scan's mass at this erosion reaches target_mass (None if outside the range)."""
    xs = [r["blur_sigma_mm"] for r in sharp_rows]
    ys = [r["mass_g_by_erosion_mm"][erosion] for r in sharp_rows]
    if not (min(ys) <= target_mass <= max(ys)) or not np.all(np.diff(ys) >= -1e-6):
        return None
    return round(float(np.interp(target_mass, ys, xs)), 2)


def main(out, dest):
    man = json.load(open(os.path.join(out, "manifest.json")))
    names = {int(k): v for k, v in man["label_names"].items()}
    res = {"job_id": man["job_id"], "scans": {}, "pairs": {}}
    for tp in man["timepoints"]:
        lab = tp["label"]
        res["scans"][lab] = one_scan(sitk.ReadImage(os.path.join(out, "native", lab, "ct.nii.gz")),
                                     sitk.ReadImage(os.path.join(out, "native", lab, "labels.nii.gz")), names)
        res["scans"][lab]["protocol"] = {k: tp["protocol"].get(k) for k in ("kernel", "pixel_spacing_mm", "slice_thickness_mm", "series_description")}
        print(f"{lab} done", flush=True)
    labs = list(res["scans"])
    for i, a in enumerate(labs):
        for b in labs[i + 1:]:
            ra, rb = res["scans"][a]["by_blur"][0], res["scans"][b]["by_blur"][0]
            diff = {e: round(rb["mass_g_by_erosion_mm"][e] / ra["mass_g_by_erosion_mm"][e] - 1.0, 4) for e in ra["mass_g_by_erosion_mm"]}
            ent = {"mass_difference_b_vs_a_by_erosion_mm": diff,
                   "highpass_sd_hu": {a: ra["highpass_sd_hu"], b: rb["highpass_sd_hu"]}}
            # which scan is sharper (larger high-pass spread), and the blur that brings its whole-label mass to the other's
            sharp, soft = (a, b) if (ra["highpass_sd_hu"] or 0) > (rb["highpass_sd_hu"] or 0) else (b, a)
            target = res["scans"][soft]["by_blur"][0]["mass_g_by_erosion_mm"]["0.0"]
            ent.update(sharper_by_noise=sharp, blur_sigma_that_equalises_whole_label_mass_mm=sigma_that_matches(res["scans"][sharp]["by_blur"], target))
            res["pairs"][f"{b}_vs_{a}"] = ent
    json.dump(res, open(dest, "w"), indent=1)
    print("\nper scan: trachea lumen SD, high-pass SD (lung core), aerated mass g at erosion 0 / 2 / 4 / 6 mm (no blur)")
    for lab, s in res["scans"].items():
        r0 = s["by_blur"][0]
        m = r0["mass_g_by_erosion_mm"]
        print(f"  {lab:6s} kernel {s['protocol']['kernel']!s:9s} pix {s['protocol']['pixel_spacing_mm']}  trachea SD "
              f"{(s['trachea_lumen_hu'] or {}).get('sd')}  highpass SD {r0['highpass_sd_hu']}  mass {m['0.0']:.1f} / {m['2.0']:.1f} / {m['4.0']:.1f} / {m['6.0']:.1f}")
    print("\nmass of the whole label against blur, per scan (change from no blur)")
    for lab, s in res["scans"].items():
        base = s["by_blur"][0]["mass_g_by_erosion_mm"]
        print(f"  {lab}: " + "  ".join(f"s{r['blur_sigma_mm']}: {r['mass_g_by_erosion_mm']['0.0'] / base['0.0'] - 1:+.1%}/{r['mass_g_by_erosion_mm']['4.0'] / base['4.0'] - 1:+.1%}"
                                       for r in s["by_blur"][1:]) + "   (whole label / 4 mm core)")
    print("\nbetween scans (mass of b against a) at erosion 0 / 2 / 4 / 6 mm")
    for k, p in res["pairs"].items():
        d = p["mass_difference_b_vs_a_by_erosion_mm"]
        print(f"  {k}: {d['0.0']:+.1%} / {d['2.0']:+.1%} / {d['4.0']:+.1%} / {d['6.0']:+.1%}; sharper by noise: {p['sharper_by_noise']}; "
              f"blur that equalises the whole-label mass: {p['blur_sigma_that_equalises_whole_label_mass_mm']} mm")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
