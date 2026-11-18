#!/usr/bin/env python3
"""Lung volume per scan and between scans for a finished register job, with what explains the delta.
Reads <job out>/manifest.json (label names) and <job out>/native/<label>/{ct,labels}.nii.gz. No registration
result is used, so the numbers do not depend on the warp. Usage: lung_volume_job_report.py <out dir> <report.json>"""
import json, os, re, sys
import numpy as np
import SimpleITK as sitk
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lung_volume as LV

out, dest = sys.argv[1], sys.argv[2]
man = json.load(open(os.path.join(out, "manifest.json")))
names = {int(k): v for k, v in man["label_names"].items()}


def ids(rx):
    return sorted(i for i, n in names.items() if re.search(rx, n))


groups = {"lung_left": ids(r"^lung_.*_left$"), "lung_right": ids(r"^lung_.*_right$"),
          "lobes": {nm: ids(rf"^{nm}$") for nm in LV.LUNG_LOBES}}
t10 = ids(r"^vertebrae_T10$")
reports, extra = {}, {}
for tp in man["timepoints"]:
    lab = tp["label"]
    ci = sitk.ReadImage(os.path.join(out, "native", lab, "ct.nii.gz"))
    li = sitk.ReadImage(os.path.join(out, "native", lab, "labels.nii.gz"))
    ct, lb = sitk.GetArrayFromImage(ci), sitk.GetArrayFromImage(li)
    sp = ci.GetSpacing()[::-1]
    reports[lab] = LV.lung_report(ct, lb, sp, groups)
    zz = np.nonzero(np.isin(lb, groups["lung_left"] + groups["lung_right"]))[0]
    e = {"spacing_zyx_mm": [round(float(v), 3) for v in sp], "lung_height_mm": round(float(zz.max() - zz.min() + 1) * sp[0], 1)}
    if t10 and (lb == t10[0]).any():
        zt = np.nonzero(lb == t10[0])[0].mean()
        e["lung_base_below_T10_centroid_mm"] = round(float(zt - zz.min()) * sp[0], 1)     # RAS: z grows upward
    extra[lab] = e
pairs = [(p["moving"], p["reference"]) for p in man["pairs"]]
result = {"job_id": man["job_id"], "params": LV.LUNG_CHANGE_PARAMS, "per_timepoint": reports, "extra": extra, "comparisons": {}}
for mov, ref in pairs:
    result["comparisons"][f"{mov}_to_{ref}"] = LV.compare_lung_volume(reports[ref], reports[mov])
json.dump(result, open(dest, "w"), indent=1)

print("per scan: lung volume mL (left, right), aerated mass g, aerated mean HU, lung height mm, base below T10 mm")
for lab, r in reports.items():
    t = r["total"]
    print(f"  {lab:6s} {t['volume_ml']:8.1f} ({r['left']['volume_ml']:.1f}, {r['right']['volume_ml']:.1f})  mass {t['aerated_mass_g']:7.2f}  "
          f"meanHU {t['aerated_mean_hu']}  height {extra[lab]['lung_height_mm']}  base_below_T10 {extra[lab].get('lung_base_below_T10_centroid_mm')}")
for k, c in result["comparisons"].items():
    print(f"\n{k}: explained_by={c['explained_by']} real_change_supported={c['real_change_supported']}")
    if c.get("computed"):
        print(f"   volume {c['delta_volume_ml']:+.1f} mL ({c['delta_volume_frac']:+.1%}), aerated mass {c['delta_aerated_mass_frac']:+.1%}, "
              f"left {c['delta_left_frac']:+.1%}, right {c['delta_right_frac']:+.1%}, asymmetry {c['left_right_asymmetry']:.1%}")
        for l in c["lobes_by_change"]:
            print(f"     {l['lobe']:24s} {l['delta_ml']:+7.1f} mL ({l['delta_frac']:+.1%})  aerated mass {l['delta_mass_g']:+6.2f} g ({l['delta_mass_frac']:+.1%})")
    print("   " + c["explanation"])
