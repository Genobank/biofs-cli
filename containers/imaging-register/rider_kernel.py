#!/usr/bin/env python3
"""Same lung, different reconstruction: how much does the aerated-lung mass depend on the kernel and the slice thickness?

Data: RIDER Lung CT, TCIA (CC BY 4.0, doi 10.7937/k9/tcia.2015.u1x8a5nr; Zhao, Schwartz, Kris, Riely 2015). Each scan was
reconstructed at 6 settings (lung and standard kernel at 3 slice thicknesses) from the same raw data, so the anatomy and the
breath are identical and only the reconstruction differs. The data go to the server's disk, never to a laptop, and are public
benchmark data, not any person's vault data. TCIA data usage policy applies and the citation has to travel with any result.

  download  python rider_kernel.py download --out DIR --patients 6
  analyze   python rider_kernel.py analyze --dir DIR --out report.json      (inside the imaging-register image, GPU)
For each patient: the lung label of one reconstruction (finest lung kernel) is used for all six, after each is resampled to that
grid, and the whole-label and 4 mm core aerated mass (HU below -500, as in lung_volume.py) is read for every reconstruction."""
import argparse, glob, io, json, os, sys, time, urllib.request, zipfile
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, "/app")
API = "https://services.cancerimagingarchive.net/nbia-api/services/v1/"
COLLECTION = "RIDER%20Lung%20CT"


def pick_studies(series, n):
    """One study per patient: the earliest study with at least 6 CT series of 50 images or more (the six reconstructions
    of one scan). Returns {patient: [series dict]}."""
    by = {}
    for s in series:
        if s.get("Modality") == "CT" and int(s.get("ImageCount") or 0) >= 50:
            by.setdefault(s["PatientID"], {}).setdefault(s["StudyInstanceUID"], []).append(s)
    out = {}
    for pid in sorted(by):
        studies = sorted(((min(x.get("StudyDate") or "" for x in v), uid, v) for uid, v in by[pid].items()), key=lambda t: t[0])
        for _, uid, v in studies:
            if len(v) == 6:
                out[pid] = v
                break
        if len(out) >= n:
            break
    return out


def get(url, tries=4):
    for k in range(tries):
        try:
            return urllib.request.urlopen(url, timeout=300).read()
        except Exception as e:
            if k == tries - 1:
                raise
            time.sleep(5 * (k + 1))


def download(out, n):
    series = json.loads(get(API + f"getSeries?Collection={COLLECTION}&format=json"))
    chosen = pick_studies(series, n)
    os.makedirs(out, exist_ok=True)
    for pid, ss in chosen.items():
        for s in ss:
            d = os.path.join(out, pid, s["SeriesInstanceUID"][-12:])
            if glob.glob(os.path.join(d, "*.dcm")):
                continue
            os.makedirs(d, exist_ok=True)
            z = zipfile.ZipFile(io.BytesIO(get(API + "getImage?SeriesInstanceUID=" + s["SeriesInstanceUID"])))
            z.extractall(d)
            print(f"{pid} {s['SeriesInstanceUID'][-12:]} {s['ImageCount']} images", flush=True)
    json.dump({pid: [{k: s.get(k) for k in ("SeriesInstanceUID", "ImageCount", "StudyDate")} for s in ss] for pid, ss in chosen.items()},
              open(os.path.join(out, "selection.json"), "w"), indent=1)
    print("downloaded", len(chosen), "patients")


METRICS = {"whole": "mass_whole_g", "core4": "mass_core4_g", "core4_cap0": "mass_core4_cap0_g", "core4_cap300": "mass_core4_cap300_g"}


def summarize(rows):
    """rows: per patient list of dicts with kernel, thickness, the mass metrics above, reference flag. Median relative effects."""
    def rel(r, ref, k):
        return r[k] / ref[k] - 1.0
    keys = [m for m in METRICS if all(METRICS[m] in r for pat in rows for r in pat)]
    eff = {"kernel_same_thickness": {m: [] for m in keys}, "thickness_same_kernel": {}}
    for pat in rows:
        ref = next(r for r in pat if r["reference"])
        for r in pat:
            if r is ref:
                continue
            if abs(r["thickness_mm"] - ref["thickness_mm"]) < 0.1 and r["kernel"] != ref["kernel"]:
                for m in keys:
                    eff["kernel_same_thickness"][m].append(rel(r, ref, METRICS[m]))
            if r["kernel"] == ref["kernel"]:
                d = eff["thickness_same_kernel"].setdefault(str(r["thickness_mm"]), {m: [] for m in keys})
                for m in keys:
                    d[m].append(rel(r, ref, METRICS[m]))
    med = lambda v: None if not v else {"median": round(float(np.median(v)), 4), "min": round(float(min(v)), 4), "max": round(float(max(v)), 4), "n": len(v)}
    return {"kernel_effect_at_reference_thickness": {k: med(v) for k, v in eff["kernel_same_thickness"].items()},
            "thickness_effect_at_reference_kernel": {t: {k: med(v) for k, v in d.items()} for t, d in eff["thickness_same_kernel"].items()}}


def analyze(base, out):
    import SimpleITK as sitk
    import register as R
    import known_answer as KA
    import mass_variants as MV
    from totalsegmentator.map_to_binary import class_map
    names = {int(k): v for k, v in class_map["total"].items()}
    lung_ids = KA.ids_matching(names, r"^lung_")
    rows, detail = [], {}
    for pid in sorted(d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))):
        series = []
        for sd in sorted(glob.glob(os.path.join(base, pid, "*"))):
            if not glob.glob(os.path.join(sd, "**", "*.dcm"), recursive=True):
                continue
            dcm = os.path.dirname(sorted(glob.glob(os.path.join(sd, "**", "*.dcm"), recursive=True))[0])
            p = R.read_protocol(dcm)
            nii = os.path.join(sd, "ct.nii.gz")
            if not os.path.exists(nii):
                nii = R.preprocess(R.dcm_to_nifti(dcm, os.path.join(sd, "raw.nii.gz")), nii, iso=1.0)
            series.append({"dir": sd, "kernel": p["kernel"], "thickness_mm": p["slice_thickness_mm"], "ct": nii, "n": p["n_slices"]})
        if len(series) < 2:
            continue
        lung_like = [s for s in series if "LUNG" in (s["kernel"] or "").upper()] or series
        ref = min(lung_like, key=lambda s: s["thickness_mm"])
        labels, _ = R.segment(ref["ct"], os.path.join(ref["dir"], "labels.nii.gz"))
        ref_img = sitk.ReadImage(ref["ct"]); lab = sitk.GetArrayFromImage(sitk.ReadImage(labels))
        sp = tuple(float(v) for v in ref_img.GetSpacing()[::-1])
        din = KA.lung_distance_map(lab, lung_ids, sp)
        if not (din > 0).any():
            print(pid, "no lung found", flush=True); continue
        pat = []
        for s in series:
            im = ref_img if s is ref else sitk.Resample(sitk.ReadImage(s["ct"]), ref_img, sitk.Transform(), sitk.sitkLinear, -1024.0, sitk.sitkFloat32)
            a = sitk.GetArrayFromImage(im).astype(np.float32)
            m = KA.mass_by_erosion(a, din, sp, (0.0, 4.0))
            core, dv = din > 4.0, float(np.prod(sp)) / 1000.0
            cap0, cap300 = MV.mass(a, core, dv, "cap_0"), MV.mass(a, core, dv, "cap_300")
            pat.append({"kernel": s["kernel"], "thickness_mm": s["thickness_mm"], "n_slices": s["n"], "reference": s is ref,
                        "mass_whole_g": m["0.0"], "mass_core4_g": m["4.0"],
                        "mass_core4_cap0_g": round(cap0, 2), "mass_core4_cap300_g": round(cap300, 2),
                        "lung_volume_ml": round(float((din > 0).sum()) * float(np.prod(sp)) / 1000.0, 1)})
        rows.append(pat); detail[pid] = pat
        print(pid, [(r["kernel"], r["thickness_mm"], r["mass_whole_g"], r["mass_core4_g"]) for r in pat], flush=True)
    res = {"source": "RIDER Lung CT, TCIA, doi 10.7937/k9/tcia.2015.u1x8a5nr, CC BY 4.0 (Zhao, Schwartz, Kris, Riely 2015)",
           "patients": detail, "summary": summarize(rows) if rows else None}
    json.dump(res, open(out, "w"), indent=1)
    print(json.dumps(res["summary"], indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("download"); d.add_argument("--out", required=True); d.add_argument("--patients", type=int, default=6)
    a = sub.add_parser("analyze"); a.add_argument("--dir", required=True); a.add_argument("--out", required=True)
    args = ap.parse_args()
    download(args.out, args.patients) if args.cmd == "download" else analyze(args.dir, args.out)
