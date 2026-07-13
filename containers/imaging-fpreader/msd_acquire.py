#!/usr/bin/env python3
"""msd_acquire.py — download a Medical Segmentation Decathlon task (real CT + organ+tumor masks)
from the MONAI S3 mirror, for the REAL lesion-vs-artifact head. Task07_Pancreas and Task03_Liver
(= LiTS) carry per-voxel organ (label 1) + tumor (label 2) annotations on real clinical CT. CPU
acquisition. Env: TASK (Task07_Pancreas|Task03_Liver), MSD_DIR."""
import os, sys, json, subprocess, tarfile, glob

TASK = os.getenv("TASK", "Task07_Pancreas")
MSD_DIR = os.getenv("MSD_DIR", "/mnt/scratch/msd")
URL = f"https://msd-for-monai.s3-us-west-2.amazonaws.com/{TASK}.tar"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"


def log(*a): print("[msd-acq]", *a, flush=True)


def main():
    os.makedirs(MSD_DIR, exist_ok=True)
    task_dir = os.path.join(MSD_DIR, TASK)
    have = os.path.isdir(os.path.join(task_dir, "imagesTr")) and \
        len([p for p in glob.glob(os.path.join(task_dir, "imagesTr", "*.nii.gz"))
             if not os.path.basename(p).startswith("._")]) > 0
    if not have:
        tar = os.path.join(MSD_DIR, f"{TASK}.tar")
        if not (os.path.exists(tar) and os.path.getsize(tar) > 0):
            log("download", URL)
            subprocess.run(["wget", "-q", "--tries=3", "--header", f"User-Agent: {UA}", "-O", tar, URL], check=True)
        log("extract", tar)
        with tarfile.open(tar) as tf:
            tf.extractall(MSD_DIR)
        try:
            os.remove(tar)
        except OSError:
            pass
    imgs = [p for p in glob.glob(os.path.join(task_dir, "imagesTr", "*.nii.gz"))
            if not os.path.basename(p).startswith("._")]
    log(f"{len(imgs)} training volumes in {TASK}")
    print("MSD_ACQUIRE_RESULT " + json.dumps({"task": TASK, "n_volumes": len(imgs), "msd_dir": task_dir}))


if __name__ == "__main__":
    main()
