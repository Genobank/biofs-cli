#!/usr/bin/env python3
"""lidc_acquire.py — download a subset of LIDC-IDRI CT series from TCIA (public, CC BY 3.0) and lay
them out in the patient hierarchy pylidc expects (LIDC_DIR/<PatientID>/<StudyUID>/<SeriesUID>/*.dcm).
CPU-only data acquisition, runs in the pylidc env. Subsetting keeps this session-feasible; a few
hundred patients gives ~hundreds-to-thousands of labeled nodules, plenty for a linear probe.

Env: LIDC_DIR (final pylidc root), RAW_DIR (scratch download dir), N_PATIENTS (0 = all)."""
import os, sys, json, shutil

LIDC_DIR = os.getenv("LIDC_DIR", "/scratch/lidc")
RAW_DIR = os.getenv("RAW_DIR", "/scratch/lidc_raw")
N_PATIENTS = int(os.getenv("N_PATIENTS", "250"))


def log(*a): print("[lidc-acquire]", *a, flush=True)


def main():
    from tcia_utils import nbia
    os.makedirs(RAW_DIR, exist_ok=True); os.makedirs(LIDC_DIR, exist_ok=True)
    series = nbia.getSeries(collection="LIDC-IDRI", modality="CT")
    if not isinstance(series, list):
        try:
            series = series.to_dict("records")     # tcia_utils may return a DataFrame
        except Exception:
            raise RuntimeError(f"unexpected getSeries return: {type(series)}")
    log(f"{len(series)} LIDC-IDRI CT series available")
    # one CT series per patient is the norm; group by patient and take N distinct patients
    by_pat = {}
    for s in series:
        pid = s.get("PatientID") or s.get("patientID")
        if pid and pid not in by_pat:
            by_pat[pid] = s
    pats = sorted(by_pat)
    if N_PATIENTS:
        pats = pats[:N_PATIENTS]
    sub = [by_pat[p] for p in pats]
    log(f"downloading {len(sub)} series (one per patient) -> {RAW_DIR}")
    nbia.downloadSeries(sub, path=RAW_DIR)          # RAW_DIR/<SeriesInstanceUID>/*.dcm

    moved = 0
    for s in sub:
        suid = s.get("SeriesInstanceUID") or s.get("seriesInstanceUID")
        stuid = s.get("StudyInstanceUID") or s.get("studyInstanceUID") or "STUDY"
        pid = s.get("PatientID") or s.get("patientID")
        src = os.path.join(RAW_DIR, suid)
        if not os.path.isdir(src):
            continue
        dst = os.path.join(LIDC_DIR, pid, stuid, suid)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.exists(dst):
            shutil.rmtree(dst)
        shutil.move(src, dst)
        moved += 1
    log(f"laid out {moved} series under {LIDC_DIR} in pylidc patient hierarchy")
    print("LIDC_ACQUIRE_RESULT " + json.dumps({"patients": len(sub), "series_placed": moved,
          "lidc_dir": LIDC_DIR}))


if __name__ == "__main__":
    main()
