#!/usr/bin/env python3
"""Does a difference in sharpness explain the difference in aerated lung mass between two real scans?

Sharpness here is the steepness of the edge between the lung and the chest wall: the 95th percentile of the HU gradient
magnitude in a band 2 mm either side of the lung label surface. The sharper scan is blurred (Gaussian) until its edge
steepness equals the softer scan's; then the aerated mass of the blurred scan is compared with the softer scan's own.
If the masses then agree (within 1 point) the offset is a sharpness effect; if a gap stays, that gap is not.
Usage: kernel_match.py <job out dir> <report.json>. numpy and scipy only; no registration result is used."""
import json, os, sys
import numpy as np
import SimpleITK as sitk
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import known_answer as KA
import kernel_sensitivity as KS

SIG = (0.0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.3)


def edge_metric(a, band, sp):
    g = np.sqrt(sum(x ** 2 for x in np.gradient(a.astype(np.float32), *sp)))
    v = g[band]
    return {"p50": round(float(np.percentile(v, 50)), 1), "p95": round(float(np.percentile(v, 95)), 1)}


def load(out, lab, names):
    lung_ids = KA.ids_matching(names, r"^lung_")
    ci, li = (sitk.ReadImage(os.path.join(out, "native", lab, f)) for f in ("ct.nii.gz", "labels.nii.gz"))
    sp = tuple(float(v) for v in ci.GetSpacing()[::-1])
    ct, lb = KS.crop_to_lungs(sitk.GetArrayFromImage(ci), sitk.GetArrayFromImage(li), lung_ids)
    inside = np.isin(lb, lung_ids)
    din = ndimage.distance_transform_edt(inside, sampling=sp).astype(np.float32)
    dout = ndimage.distance_transform_edt(~inside, sampling=sp).astype(np.float32)
    band = ((din > 0) & (din <= 2.0)) | ((dout > 0) & (dout <= 2.0))
    return ct.astype(np.float32), din, band, sp


def curve(ct, din, band, sp):
    rows = []
    for s in SIG:
        a = ct if s == 0 else ndimage.gaussian_filter(ct, [s / v for v in sp])
        m = KA.mass_by_erosion(a, din, sp, (0.0, 4.0))
        rows.append({"blur_sigma_mm": s, "edge": edge_metric(a, band, sp), "mass_g": m})
    return rows


def sigma_for(rows, target_p95):
    xs = [r["blur_sigma_mm"] for r in rows]; ys = [r["edge"]["p95"] for r in rows]
    if not (min(ys) <= target_p95 <= max(ys)):
        return None
    return float(np.interp(target_p95, ys[::-1], xs[::-1]))


def mass_at(rows, sigma, key):
    return float(np.interp(sigma, [r["blur_sigma_mm"] for r in rows], [r["mass_g"][key] for r in rows]))


def main(out, dest):
    man = json.load(open(os.path.join(out, "manifest.json")))
    names = {int(k): v for k, v in man["label_names"].items()}
    cur = {}
    for tp in man["timepoints"]:
        lab = tp["label"]
        ct, din, band, sp = load(out, lab, names)
        cur[lab] = curve(ct, din, band, sp)
        print(f"{lab}: edge steepness p95 {cur[lab][0]['edge']['p95']} HU/mm, p50 {cur[lab][0]['edge']['p50']}, mass {cur[lab][0]['mass_g']}", flush=True)
    res = {"job_id": man["job_id"], "curves": cur, "matches": {}}
    labs = list(cur)
    for i, a in enumerate(labs):
        for b in labs[i + 1:]:
            ea, eb = cur[a][0]["edge"]["p95"], cur[b][0]["edge"]["p95"]
            sharp, soft = (a, b) if ea >= eb else (b, a)
            s = sigma_for(cur[sharp], cur[soft][0]["edge"]["p95"])
            ent = {"sharper_by_edge": sharp, "softer_by_edge": soft, "edge_p95": {a: ea, b: eb}, "blur_sigma_mm_that_matches_edges": None if s is None else round(s, 2)}
            for key in ("0.0", "4.0"):
                m_soft = cur[soft][0]["mass_g"][key]; m_sharp = cur[sharp][0]["mass_g"][key]
                ent[f"mass_g_erosion_{key}"] = {"sharp_unblurred": m_sharp, "soft": m_soft,
                                                "difference_before": round(m_soft / m_sharp - 1.0, 4)}
                if s is not None:
                    mb = mass_at(cur[sharp], s, key)
                    ent[f"mass_g_erosion_{key}"].update(sharp_after_matching_blur=round(mb, 1), difference_after=round(m_soft / mb - 1.0, 4))
            res["matches"][f"{sharp}_vs_{soft}"] = ent
    json.dump(res, open(dest, "w"), indent=1)
    print("\nafter blurring the sharper scan to the softer scan's edge steepness (difference = softer mass against sharper mass)")
    for k, e in res["matches"].items():
        w, c = e.get("mass_g_erosion_0.0", {}), e.get("mass_g_erosion_4.0", {})
        print(f"  {k}: edge p95 {e['edge_p95']}, matching blur {e['blur_sigma_mm_that_matches_edges']} mm; whole label {w.get('difference_before'):+.1%} -> "
              f"{w.get('difference_after')}; 4 mm core {c.get('difference_before'):+.1%} -> {c.get('difference_after')}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
