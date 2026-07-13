#!/usr/bin/env python3
"""lidc_prep_rois.py — turn LIDC-IDRI DICOM into per-nodule 3D ROI niftis + labels.csv for the
benign/malignant head. Runs in a pylidc env (CPU; pylidc + SimpleITK), separate from the GPU
embedding image. Each physical nodule = a cluster of per-reader annotations; consensus malignancy
= median of the readers' 1-5 ratings; ROI = consensus bbox + margin in native HU. Writes
~/.pylidcrc from LIDC_DIR. LIDC malignancy is radiologist SUSPICION (1-5), NOT pathology.

Env: LIDC_DIR (pylidc dicom root, patient hierarchy), OUT_DIR, ROI_MARGIN_MM, MAX_PATIENTS."""
import os, sys, json, csv
import numpy as np

LIDC_DIR = os.getenv("LIDC_DIR", "/scratch/lidc")
OUT_DIR = os.getenv("OUT_DIR", "/scratch/characterize/classifier/lidc_rois")
MARGIN_MM = float(os.getenv("ROI_MARGIN_MM", "12"))
MAX_PATIENTS = int(os.getenv("MAX_PATIENTS", "0"))   # 0 = all


def log(*a): print("[lidc-prep]", *a, flush=True)


def ensure_pylidcrc():
    with open(os.path.expanduser("~/.pylidcrc"), "w") as f:
        f.write(f"[dicom]\npath = {LIDC_DIR}\nwarn = False\n")


def main():
    ensure_pylidcrc()
    import pylidc as pl
    from pylidc.utils import consensus
    import SimpleITK as sitk
    os.makedirs(OUT_DIR, exist_ok=True)
    scans = pl.query(pl.Scan)
    total = scans.count(); log(f"{total} scans indexed under {LIDC_DIR}")
    recs = []; done = 0
    for scan in scans:
        pid = scan.patient_id
        try:
            vol = scan.to_volume(verbose=False)        # [rows(y), cols(x), slices(z)] HU
        except Exception as e:
            log(f"{pid}: to_volume failed {e}"); continue
        sp_xy = float(scan.pixel_spacing)
        sp_z = float(scan.slice_spacing or scan.slice_thickness or sp_xy)
        my = max(1, int(round(MARGIN_MM / sp_xy))); mx = my
        mz = max(1, int(round(MARGIN_MM / sp_z)))
        for ni, anns in enumerate(scan.cluster_annotations()):
            if not anns:
                continue
            mals = [a.malignancy for a in anns if a.malignancy]
            if not mals:
                continue
            mal = int(np.median(mals))
            try:
                cbbox = consensus(anns, clevel=0.5)[1]
            except Exception:
                cbbox = anns[0].bbox()
            ys, xs, zs = cbbox[0], cbbox[1], cbbox[2]
            y0 = max(0, ys.start - my); y1 = min(vol.shape[0], ys.stop + my)
            x0 = max(0, xs.start - mx); x1 = min(vol.shape[1], xs.stop + mx)
            z0 = max(0, zs.start - mz); z1 = min(vol.shape[2], zs.stop + mz)
            roi = vol[y0:y1, x0:x1, z0:z1]              # [y,x,z]
            if roi.size == 0 or min(roi.shape) < 2:
                continue
            arr = np.ascontiguousarray(np.transpose(roi, (2, 0, 1)).astype(np.int16))   # [z,y,x]
            img = sitk.GetImageFromArray(arr); img.SetSpacing((sp_xy, sp_xy, sp_z))
            fn = f"{pid}_n{ni}_m{mal}.nii.gz"
            sitk.WriteImage(img, os.path.join(OUT_DIR, fn))
            recs.append({"roi_path": fn, "patient_id": pid, "nodule_idx": ni,
                         "malignancy": mal, "n_readers": len(anns)})
        done += 1
        if done % 10 == 0:
            log(f"{done} patients, {len(recs)} nodules")
        if MAX_PATIENTS and done >= MAX_PATIENTS:
            break
    with open(os.path.join(OUT_DIR, "labels.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["roi_path", "patient_id", "nodule_idx", "malignancy", "n_readers"])
        w.writeheader(); w.writerows(recs)
    dist = {}
    for r in recs:
        dist[r["malignancy"]] = dist.get(r["malignancy"], 0) + 1
    log(f"WROTE {len(recs)} ROIs + labels.csv to {OUT_DIR}; malignancy dist {dist}")
    print("LIDC_PREP_RESULT " + json.dumps({"n_rois": len(recs), "patients": done,
          "out_dir": OUT_DIR, "malignancy_dist": dist}))


if __name__ == "__main__":
    main()
