#!/usr/bin/env python3
"""msd_prep_rois.py — crop REAL lesion (positive) and non-lesion (negative) 3D ROIs from MSD volumes
for the lesion-vs-artifact head. MSD masks: label 1 = organ, label 2 = tumor. Positives = an ROI
around each tumor connected-component; negatives = ROIs at random non-tumor locations INSIDE the
organ, so the head learns lesion-vs-normal-organ-tissue (the real "is this a true lesion vs a
detection artifact / normal tissue" signal — NOT malignancy). CPU.

Env: MSD_TASK_DIR, OUT_DIR, ORGAN, TUMOR_LABEL(2), ORGAN_LABEL(1), N_NEG_PER_POS, ROI_MM, MAX_VOL."""
import os, sys, json, csv, random
import numpy as np

MSD_TASK_DIR = os.getenv("MSD_TASK_DIR", "/mnt/scratch/msd/Task07_Pancreas")
OUT_DIR = os.getenv("OUT_DIR", "/mnt/scratch/characterize/fpreader/pancreas_rois")
ORGAN = os.getenv("ORGAN", "pancreas")
TUMOR_LABEL = int(os.getenv("TUMOR_LABEL", "2"))
ORGAN_LABEL = int(os.getenv("ORGAN_LABEL", "1"))
N_NEG_PER_POS = float(os.getenv("N_NEG_PER_POS", "2"))
ROI_MM = float(os.getenv("ROI_MM", "25"))
MAX_VOL = int(os.getenv("MAX_VOL", "0"))


def log(*a): print("[msd-prep]", *a, flush=True)


def _crop_write(arr, cz, cy, cx, rz, ry, rx, sp, out_dir, name, label, recs, pid):
    import SimpleITK as sitk
    z0 = max(0, cz - rz); z1 = min(arr.shape[0], cz + rz)
    y0 = max(0, cy - ry); y1 = min(arr.shape[1], cy + ry)
    x0 = max(0, cx - rx); x1 = min(arr.shape[2], cx + rx)
    roi = arr[z0:z1, y0:y1, x0:x1]
    if roi.size == 0 or min(roi.shape) < 2:
        return
    ri = sitk.GetImageFromArray(np.ascontiguousarray(roi.astype(np.int16)))
    ri.SetSpacing(tuple(float(s) for s in sp))
    fn = f"{name}_c{label}.nii.gz"
    sitk.WriteImage(ri, os.path.join(out_dir, fn))
    recs.append({"roi_path": fn, "patient_id": pid, "label": label, "n_readers": 0})


def main():
    import SimpleITK as sitk, glob
    from scipy import ndimage as ndi
    rng = random.Random(0)
    imgs = sorted(p for p in glob.glob(os.path.join(MSD_TASK_DIR, "imagesTr", "*.nii.gz"))
                  if not os.path.basename(p).startswith("._"))
    if MAX_VOL:
        imgs = imgs[:MAX_VOL]
    log(f"{len(imgs)} volumes in {MSD_TASK_DIR}")
    os.makedirs(OUT_DIR, exist_ok=True)
    recs = []; ci = 0
    for ip in imgs:
        lab = os.path.join(MSD_TASK_DIR, "labelsTr", os.path.basename(ip))
        if not os.path.exists(lab):
            continue
        img = sitk.ReadImage(ip)
        arr = sitk.GetArrayFromImage(img).astype(np.int16)              # [z,y,x] HU
        m = sitk.GetArrayFromImage(sitk.ReadImage(lab))                 # [z,y,x] labels
        sp = img.GetSpacing()                                           # (x,y,z) mm
        rz = max(1, int(round(ROI_MM / sp[2]))); ry = max(1, int(round(ROI_MM / sp[1])))
        rx = max(1, int(round(ROI_MM / sp[0])))
        pid = os.path.basename(ip).replace(".nii.gz", "")
        tum = (m == TUMOR_LABEL)
        npos = 0
        if tum.any():
            lblmap, n = ndi.label(tum)
            for comp in range(1, n + 1):
                idx = np.argwhere(lblmap == comp)
                if len(idx) < 10:                                       # skip tiny specks
                    continue
                cz, cy, cx = idx.mean(0).astype(int)
                ci += 1; npos += 1
                _crop_write(arr, cz, cy, cx, rz, ry, rx, sp, OUT_DIR, f"{pid}_pos{ci}", 1, recs, pid)
        organ = (m == ORGAN_LABEL) & (~tum)
        oidx = np.argwhere(organ)
        nneg = int(round(npos * N_NEG_PER_POS))
        if len(oidx) and nneg:
            for _ in range(nneg):
                cz, cy, cx = oidx[rng.randrange(len(oidx))]
                ci += 1
                _crop_write(arr, cz, cy, cx, rz, ry, rx, sp, OUT_DIR, f"{pid}_neg{ci}", 0, recs, pid)
        if npos:
            log(f"{pid}: +{npos} lesion, {len(recs)} total")
    with open(os.path.join(OUT_DIR, "labels.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["roi_path", "patient_id", "label", "n_readers"])
        w.writeheader(); w.writerows(recs)
    dist = {}
    for r in recs:
        dist[r["label"]] = dist.get(r["label"], 0) + 1
    log(f"WROTE {len(recs)} ROIs to {OUT_DIR}; dist (1=lesion,0=non-lesion) {dist}")
    print("MSD_PREP_RESULT " + json.dumps({"organ": ORGAN, "n_rois": len(recs), "class_dist": dist, "out_dir": OUT_DIR}))


if __name__ == "__main__":
    main()
