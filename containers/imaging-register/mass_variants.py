#!/usr/bin/env python3
"""Which lung-mass definition does not move with sharpness, on real scans? Usage: mass_variants.py <job out dir> <report.json>
For each scan, with and without a 0.6 mm Gaussian blur, the mass of the lung core (deeper than 4 mm inside the label) under:
  exclude_above_-500   the shipped definition: voxels at or above -500 HU left out
  cap_-500 / cap_-200 / cap_0 / cap_300   every voxel counted, its density capped at that HU (vessels count as the cap)
Reported: how much each moves with the blur (smaller is better), and how far Mar 3 is from Jun 17 and Oct 21 (smaller is better)."""
import json, os, sys
import numpy as np
import SimpleITK as sitk
from scipy import ndimage
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import known_answer as KA
import kernel_sensitivity as KS

VARIANTS = ("exclude_above_-500", "cap_-500", "cap_-200", "cap_0", "cap_300")


def mass(a, core, dv, v):
    x = a[core]
    if v.startswith("exclude"):
        x = x[x < -500]
        return float(((np.clip(x, -1000, -500) + 1000) / 1000).sum() * dv)
    cap = float(v.split("_")[1])
    return float(((np.clip(x, -1000, cap) + 1000) / 1000).sum() * dv)


def main(out, dest):
    man = json.load(open(os.path.join(out, "manifest.json")))
    names = {int(k): v for k, v in man["label_names"].items()}
    ids = KA.ids_matching(names, r"^lung_")
    res = {"scans": {}}
    for tp in man["timepoints"]:
        lab = tp["label"]
        ci, li = (sitk.ReadImage(os.path.join(out, "native", lab, f)) for f in ("ct.nii.gz", "labels.nii.gz"))
        sp = tuple(float(v) for v in ci.GetSpacing()[::-1])
        ct, lb = KS.crop_to_lungs(sitk.GetArrayFromImage(ci).astype(np.float32), sitk.GetArrayFromImage(li), ids)
        dist = KA.lung_distance_map(lb, ids, sp)
        core = dist > 4.0
        dv = float(np.prod(sp)) / 1000.0
        bl = ndimage.gaussian_filter(ct, [0.6 / s for s in sp])
        res["scans"][lab] = {v: {"sharp_g": round(mass(ct, core, dv, v), 1), "blur0.6_g": round(mass(bl, core, dv, v), 1)} for v in VARIANTS}
        for v in VARIANTS:
            r = res["scans"][lab][v]; r["blur_effect"] = round(r["blur0.6_g"] / r["sharp_g"] - 1, 4)
        print(lab, flush=True)
    labs = list(res["scans"])
    print("\nvariant: blur effect on the 4 mm core mass (mar3 / jun17 / oct21);  mar3 against jun17, mar3 against oct21")
    res["between"] = {}
    for v in VARIANTS:
        be = [res["scans"][l][v]["blur_effect"] for l in labs]
        a = res["scans"]["mar3"][v]["sharp_g"]
        d = {o: round(res["scans"][o][v]["sharp_g"] / a - 1, 4) for o in labs if o != "mar3"}
        res["between"][v] = d
        print(f"  {v:20s} {be[0]:+.1%} / {be[1]:+.1%} / {be[2]:+.1%};  {d.get('jun17'):+.1%}, {d.get('oct21'):+.1%}")
    json.dump(res, open(dest, "w"), indent=1)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
