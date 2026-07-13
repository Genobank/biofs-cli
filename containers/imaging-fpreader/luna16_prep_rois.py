#!/usr/bin/env python3
"""luna16_prep_rois.py — crop 3D ROIs around LUNA16 candidates (real-vs-FP) into niftis + labels.csv
for the FP second-reader. candidates_V2.csv gives world-mm coords + class (1 true nodule, 0 false
positive). LUNA16 has ~754K candidates (mostly FP); we balance-subsample (all true + N_FP_PER_TRUE
false-positives) so the head trains on a sane set. ROI = fixed physical cube around the candidate,
native HU. CPU. Env: LUNA_DIR, OUT_DIR, ROI_MM (cube half-size mm), N_FP_PER_TRUE, MAX_TRUE."""
import os, sys, json, csv, random
import numpy as np

LUNA_DIR = os.getenv("LUNA_DIR", "/mnt/scratch/luna16")
OUT_DIR = os.getenv("OUT_DIR", "/mnt/scratch/characterize/fpreader/luna_rois")
ROI_MM = float(os.getenv("ROI_MM", "25"))            # half-size -> ~50mm cube, matches lesion ROI scale
N_FP_PER_TRUE = float(os.getenv("N_FP_PER_TRUE", "2"))
MAX_TRUE = int(os.getenv("MAX_TRUE", "0"))           # 0 = all true nodules in the downloaded subsets


def log(*a): print("[luna16-prep]", *a, flush=True)


def main():
    import SimpleITK as sitk, glob
    img_dir = os.path.join(LUNA_DIR, "images")
    have = {os.path.splitext(os.path.basename(p))[0] for p in glob.glob(os.path.join(img_dir, "*.mhd"))}
    log(f"{len(have)} series on disk")
    cands = []
    with open(os.path.join(LUNA_DIR, "candidates_V2.csv")) as f:
        for r in csv.DictReader(f):
            if r["seriesuid"] in have:
                cands.append((r["seriesuid"], float(r["coordX"]), float(r["coordY"]),
                              float(r["coordZ"]), int(r["class"])))
    trues = [c for c in cands if c[4] == 1]
    fps = [c for c in cands if c[4] == 0]
    if MAX_TRUE:
        trues = trues[:MAX_TRUE]
    random.Random(0).shuffle(fps)
    fps = fps[:int(len(trues) * N_FP_PER_TRUE)]
    sel = trues + fps
    log(f"{len(trues)} true + {len(fps)} FP = {len(sel)} candidates")
    os.makedirs(OUT_DIR, exist_ok=True)
    by_series = {}
    for c in sel:
        by_series.setdefault(c[0], []).append(c)
    recs = []; ci = 0
    for suid, items in by_series.items():
        try:
            img = sitk.ReadImage(os.path.join(img_dir, suid + ".mhd"))
        except Exception as e:
            log(f"read failed {suid[:12]}: {e}"); continue
        arr = sitk.GetArrayFromImage(img)               # [z,y,x] HU
        origin = np.array(img.GetOrigin()); spacing = np.array(img.GetSpacing())   # (x,y,z) mm
        rz = max(1, int(round(ROI_MM / spacing[2]))); ry = max(1, int(round(ROI_MM / spacing[1])))
        rx = max(1, int(round(ROI_MM / spacing[0])))
        for (_, wx, wy, wz, cls) in items:
            ci += 1
            vx = int(round((wx - origin[0]) / spacing[0]))
            vy = int(round((wy - origin[1]) / spacing[1]))
            vz = int(round((wz - origin[2]) / spacing[2]))
            z0 = max(0, vz - rz); z1 = min(arr.shape[0], vz + rz)
            y0 = max(0, vy - ry); y1 = min(arr.shape[1], vy + ry)
            x0 = max(0, vx - rx); x1 = min(arr.shape[2], vx + rx)
            roi = arr[z0:z1, y0:y1, x0:x1]
            if roi.size == 0 or min(roi.shape) < 2:
                continue
            ri = sitk.GetImageFromArray(np.ascontiguousarray(roi.astype(np.int16)))
            ri.SetSpacing(tuple(float(s) for s in spacing))
            fn = f"{suid[:12]}_{ci}_c{cls}.nii.gz"
            sitk.WriteImage(ri, os.path.join(OUT_DIR, fn))
            recs.append({"roi_path": fn, "patient_id": suid, "label": cls, "n_readers": 0})
        log(f"{len(recs)} ROIs so far ({suid[:12]})")
    with open(os.path.join(OUT_DIR, "labels.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["roi_path", "patient_id", "label", "n_readers"])
        w.writeheader(); w.writerows(recs)
    dist = {}
    for r in recs:
        dist[r["label"]] = dist.get(r["label"], 0) + 1
    log(f"WROTE {len(recs)} ROIs; class dist (1=true,0=FP) {dist}")
    print("LUNA16_PREP_RESULT " + json.dumps({"n_rois": len(recs), "class_dist": dist, "out_dir": OUT_DIR}))


if __name__ == "__main__":
    main()
