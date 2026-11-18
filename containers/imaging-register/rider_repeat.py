#!/usr/bin/env python3
"""Calibration of the lung-mass decision on same-day repeat scans (RIDER Lung CT, TCIA, CC BY 4.0, doi 10.7937/k9/tcia.2015.u1x8a5nr).

Two scans of one patient on one day, same scanner, same kernel, same slice thickness, no known change: whatever difference the
lung-volume step reports between them is noise or false alarm. Each scan is segmented on its own (TotalSegmentator `total`, as in
production). The pair is then compared with lung_volume.compare_lung_volume at its shipped thresholds.

  download  python rider_repeat.py download --out DIR --patients 10
  plan      python rider_repeat.py plan --dir DIR                       (headers only: the pair or the reason per patient, no segmentation)
  analyze   python rider_repeat.py analyze --dir DIR --out report.json      (inside the imaging-register image, GPU)

The pass rules are in rider_repeat_criteria-20261105.txt, registered read-only before the first run; the pair definition was amended once
(rider_repeat_amendment1-20261105.txt, after the first run returned INSUFFICIENT_PAIRS). This calibrates the same-day,
same-protocol floor only. It does not cover differences between days (reconstruction variant, inflation, blood volume, contrast),
which were 5 to 8 points between the three chest scans of the operator, nor inhale against exhale (DIR-Lab, not yet available)."""
import argparse, glob, json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, "/app")
import rider_kernel as RK


def candidates(series, n):
    """The first n patients (sorted) that have a day with at least 4 CT series of 200 to 320 images (the 1.25 mm class of two scans
    reconstructed twice). Returns {patient: (date, [series dict])}."""
    by = {}
    for s in series:
        if s.get("Modality") == "CT" and 200 <= int(s.get("ImageCount") or 0) <= 320:
            by.setdefault((s["PatientID"], (s.get("StudyDate") or "")[:10]), []).append(s)
    out = {}
    for (pid, date), v in sorted(by.items()):
        if len(v) >= 4 and pid not in out:
            out[pid] = (date, v)
        if len(out) >= n:
            break
    return out


def select_pair(infos):
    """Amendment 1 (rider_repeat_amendment1-20261105.txt). infos: [{uid, kernel, thickness_mm, acq_time, series_number, n}] for the series of
    one patient-day. A scan is one distinct acquisition time; a series without an acquisition time is a copy and is dropped only when a timed
    series has the same series number and slice count. Each scan needs exactly one lung-kernel 1.25 mm series. The pair is the two earliest
    scans. Returns (A, B, None) or (None, None, reason)."""
    timed = [i for i in infos if i.get("acq_time")]
    for i in infos:
        if i.get("acq_time"):
            continue
        if not any(t.get("series_number") == i.get("series_number") and t.get("n") == i.get("n") for t in timed):
            return None, None, f"series {i['uid']} has no acquisition time and no timed series with the same series number and slice count"
    by = {}
    for i in timed:
        by.setdefault(i["acq_time"], []).append(i)
    scans = []
    for t in sorted(by):
        lung = [i for i in by[t] if "LUNG" in (i.get("kernel") or "").upper() and abs((i.get("thickness_mm") or 0) - 1.25) < 0.2]
        if len(lung) > 1:
            return None, None, f"{len(lung)} lung-kernel 1.25 mm series in the acquisition at {t}, need exactly 1"
        if lung:
            scans.append(lung[0])
    if len(scans) < 2:
        return None, None, f"{len(scans)} acquisition(s) with a lung-kernel 1.25 mm series, need at least 2"
    return scans[0], scans[1], None


def evaluate(rows, crit):
    """rows: per pair dict with delta_mass_whole, delta_mass_core4, delta_mass_core4_cap300, delta_volume, asymmetry, flagged.
    Applies the registered rules. Returns per-rule verdicts and the statistics."""
    a = lambda k: np.abs(np.array([r[k] for r in rows], float))
    st = {k: {"n": len(rows), "median_abs": round(float(np.median(a(k))), 4), "p95_abs": round(float(np.percentile(a(k), 95)), 4),
              "max_abs": round(float(a(k).max()), 4)}
          for k in ("delta_mass_whole", "delta_mass_core4", "delta_mass_core4_cap300", "delta_volume", "asymmetry")}
    flagged = [r["pair"] for r in rows if r["flagged"]]
    c = crit
    out = {"C1_no_false_alarm_at_shipped_thresholds": {"verdict": "PASS" if not flagged else "FAIL", "flagged": flagged},
           "C2_whole_mass_repeat_noise": {"verdict": "PASS" if st["delta_mass_whole"]["p95_abs"] <= c["whole_mass_p95_abs_max"] else "FAIL",
                                          "p95_abs": st["delta_mass_whole"]["p95_abs"], "max_allowed": c["whole_mass_p95_abs_max"]},
           "C3_asymmetry_repeat_noise": {"verdict": "PASS" if st["asymmetry"]["max_abs"] <= c["asymmetry_max_abs_max"] else "FAIL",
                                         "max_abs": st["asymmetry"]["max_abs"], "max_allowed": c["asymmetry_max_abs_max"]}}
    return out, st


CRITERIA = {"whole_mass_p95_abs_max": 0.05, "asymmetry_max_abs_max": 0.075, "min_pairs": 8}


def download(out, n):
    series = json.loads(RK.get(RK.API + f"getSeries?Collection={RK.COLLECTION}&format=json"))
    chosen = candidates(series, n)
    os.makedirs(out, exist_ok=True)
    import io, zipfile
    from concurrent.futures import ThreadPoolExecutor
    jobs = [(pid, date, s) for pid, (date, ss) in chosen.items() for s in ss]

    def one(j):
        pid, date, s = j
        d = os.path.join(out, pid, s["SeriesInstanceUID"][-12:])
        if glob.glob(os.path.join(d, "**", "*.dcm"), recursive=True):
            return
        os.makedirs(d, exist_ok=True)
        zipfile.ZipFile(io.BytesIO(RK.get(RK.API + "getImage?SeriesInstanceUID=" + s["SeriesInstanceUID"]))).extractall(d)
        print(f"{pid} {date} {s['SeriesInstanceUID'][-12:]} {s['ImageCount']} images", flush=True)
    with ThreadPoolExecutor(6) as ex:                      # TCIA serves one series at a time per request; six requests at once
        list(ex.map(one, jobs))
    json.dump({p: {"date": d, "series": [x["SeriesInstanceUID"] for x in ss]} for p, (d, ss) in chosen.items()},
              open(os.path.join(out, "selection.json"), "w"), indent=1)
    print("downloaded", len(chosen), "patients")


def gather_infos(base, pid):
    import pydicom
    import register as R
    infos = []
    for sd in sorted(glob.glob(os.path.join(base, pid, "*"))):
        fs = sorted(glob.glob(os.path.join(sd, "**", "*.dcm"), recursive=True))
        if not fs:
            continue
        p = R.read_protocol(os.path.dirname(fs[0]))
        h = pydicom.dcmread(fs[0], stop_before_pixels=True)
        infos.append({"uid": os.path.basename(sd), "dir": os.path.dirname(fs[0]), "sd": sd, "kernel": p["kernel"], "thickness_mm": p["slice_thickness_mm"],
                      "acq_time": str(getattr(h, "AcquisitionTime", "") or "")[:6],
                      "series_number": str(getattr(h, "SeriesNumber", "") or ""),
                      "study": str(getattr(h, "StudyInstanceUID", ""))[-8:], "n": p["n_slices"]})
    return infos


def plan(base):
    """What analyze would do, without segmenting: per patient the pair or the reason (headers only, no mass values)."""
    out = {}
    for pid in sorted(d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))):
        A, B, why = select_pair(gather_infos(base, pid))
        out[pid] = {"reason": why} if A is None else {"pair": [A["uid"], B["uid"]], "acq_times": [A["acq_time"], B["acq_time"]]}
        print(pid, out[pid], flush=True)
    n = sum(1 for v in out.values() if "pair" in v)
    print(f"{n} usable pairs, registered minimum {CRITERIA['min_pairs']}", flush=True)
    return out


def analyze(base, out):
    import register as R
    import lung_volume as LV
    import known_answer as KA
    import mass_variants as MV
    import SimpleITK as sitk
    from totalsegmentator.map_to_binary import class_map
    names = {int(k): v for k, v in class_map["total"].items()}
    lung_ids = KA.ids_matching(names, r"^lung_")
    groups = {"lung_left": KA.ids_matching(names, r"^lung_.*_left$"), "lung_right": KA.ids_matching(names, r"^lung_.*_right$"),
              "lobes": {nm: KA.ids_matching(names, rf"^{nm}$") for nm in LV.LUNG_LOBES}}
    rows, skipped = [], {}
    for pid in sorted(d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))):
        infos = gather_infos(base, pid)
        A, B, why = select_pair(infos)
        if A is None:
            skipped[pid] = why; print(pid, "skipped:", why, flush=True); continue
        print(pid, "pair:", A["uid"], A["acq_time"], "+", B["uid"], B["acq_time"], flush=True)
        reps = []
        for s in (A, B):
            nii = os.path.join(s["sd"], "ct.nii.gz")
            if not os.path.exists(nii):
                nii = R.preprocess(R.dcm_to_nifti(s["dir"], os.path.join(s["sd"], "raw.nii.gz")), nii, iso=1.0)
            labels, _ = R.segment(nii, os.path.join(s["sd"], "labels.nii.gz"))
            ci = sitk.ReadImage(nii); ct = sitk.GetArrayFromImage(ci).astype(np.float32); lb = sitk.GetArrayFromImage(sitk.ReadImage(labels))
            sp = tuple(float(v) for v in ci.GetSpacing()[::-1])
            rep = LV.lung_report(ct, lb, sp, groups)
            din = KA.lung_distance_map(lb, lung_ids, sp)
            core, dv = din > 4.0, float(np.prod(sp)) / 1000.0
            reps.append((rep, KA.mass_by_erosion(ct, din, sp, (0.0, 4.0)), MV.mass(ct, core, dv, "cap_300")))
        (ra, ma, ca), (rb, mb, cb) = reps
        c = LV.compare_lung_volume(ra, rb)
        rows.append({"pair": pid, "kernel": A["kernel"], "acq_times": [A["acq_time"], B["acq_time"]], "studies": [A["study"], B["study"]],
                     "delta_mass_whole": round(mb["0.0"] / ma["0.0"] - 1, 4), "delta_mass_core4": round(mb["4.0"] / ma["4.0"] - 1, 4),
                     "delta_mass_core4_cap300": round(cb / ca - 1, 4), "delta_volume": c.get("delta_volume_frac"),
                     "asymmetry": c.get("left_right_asymmetry"), "flagged": bool(c.get("real_change_supported")),
                     "explained_by": c.get("explained_by"), "volume_ml": [ra["total"]["volume_ml"], rb["total"]["volume_ml"]]})
        print(rows[-1], flush=True)
    res = {"source": "RIDER Lung CT, TCIA, doi 10.7937/k9/tcia.2015.u1x8a5nr, CC BY 4.0 (Zhao, Schwartz, Kris, Riely 2015)",
           "criteria": CRITERIA, "pairs": rows, "skipped": skipped}
    if len(rows) >= CRITERIA["min_pairs"]:
        res["verdicts"], res["statistics"] = evaluate(rows, CRITERIA)
    else:
        res["verdicts"] = {"INSUFFICIENT_PAIRS": f"{len(rows)} pairs, registered minimum {CRITERIA['min_pairs']}"}
    json.dump(res, open(out, "w"), indent=1)
    print(json.dumps(res.get("verdicts"), indent=1)); print(json.dumps(res.get("statistics"), indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("download"); d.add_argument("--out", required=True); d.add_argument("--patients", type=int, default=10)
    a = sub.add_parser("analyze"); a.add_argument("--dir", required=True); a.add_argument("--out", required=True)
    pl = sub.add_parser("plan"); pl.add_argument("--dir", required=True)
    args = ap.parse_args()
    if args.cmd == "download":
        download(args.out, args.patients)
    elif args.cmd == "plan":
        plan(args.dir)
    else:
        analyze(args.dir, args.out)
