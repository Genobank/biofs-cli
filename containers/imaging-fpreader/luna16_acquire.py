#!/usr/bin/env python3
"""luna16_acquire.py — download LUNA16 candidates + a few image subsets from Zenodo (record
3723295), for the false-positive second-reader. candidates_V2.csv labels each detection candidate
true-nodule (class 1) vs false-positive (class 0); the classic FP-reduction benchmark, lung only.
CPU acquisition; subsetting keeps it session-feasible. Env: LUNA_DIR, SUBSETS (comma list)."""
import os, sys, json, subprocess, zipfile, glob, shutil

LUNA_DIR = os.getenv("LUNA_DIR", "/mnt/scratch/luna16")
SUBSETS = [s.strip() for s in os.getenv("SUBSETS", "0,1").split(",") if s.strip() != ""]
# Zenodo download links are /api/records/<id>/files/<key>/content (the plain /records/.../files/<key>
# path 403s). candidates_V2 is a ZIP, not a bare CSV. Record 3723295 = "LUNA16 Part 1/2" (subset0-6).
ZB = "https://zenodo.org/api/records/3723295/files"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"


def log(*a): print("[luna16-acq]", *a, flush=True)


def furl(key): return f"{ZB}/{key}/content"


def dl(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        log("have", os.path.basename(dest)); return dest
    log("download", os.path.basename(dest))
    subprocess.run(["wget", "-q", "--tries=3", "--header", f"User-Agent: {UA}",
                    "-O", dest, url], check=True)
    return dest


def main():
    os.makedirs(LUNA_DIR, exist_ok=True)
    cz = os.path.join(LUNA_DIR, "candidates_V2.zip")
    dl(furl("candidates_V2.zip"), cz)
    with zipfile.ZipFile(cz) as zf:
        zf.extractall(LUNA_DIR)
    if not os.path.exists(os.path.join(LUNA_DIR, "candidates_V2.csv")):
        for p in glob.glob(os.path.join(LUNA_DIR, "**", "candidates_V2.csv"), recursive=True):
            shutil.move(p, os.path.join(LUNA_DIR, "candidates_V2.csv")); break
    img_dir = os.path.join(LUNA_DIR, "images"); os.makedirs(img_dir, exist_ok=True)
    for s in SUBSETS:
        z = os.path.join(LUNA_DIR, f"subset{s}.zip")
        dl(furl(f"subset{s}.zip"), z)
        log(f"unzip subset{s}")
        with zipfile.ZipFile(z) as zf:
            zf.extractall(img_dir)
        os.remove(z)
    # flatten images/subsetN/* -> images/*
    for p in glob.glob(os.path.join(img_dir, "subset*", "*")):
        dst = os.path.join(img_dir, os.path.basename(p))
        if not os.path.exists(dst):
            shutil.move(p, dst)
    n_mhd = len(glob.glob(os.path.join(img_dir, "*.mhd")))
    log(f"{n_mhd} .mhd volumes in {img_dir}")
    print("LUNA16_ACQUIRE_RESULT " + json.dumps({"subsets": SUBSETS, "n_mhd": n_mhd, "luna_dir": LUNA_DIR}))


if __name__ == "__main__":
    main()
