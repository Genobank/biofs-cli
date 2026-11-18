#!/usr/bin/env python3
"""Which series of a study is the one to register? Reads ONE DICOM header per series from the imaging bucket (server side, inside the
imaging-register image) and prints acquisition facts only: modality, description, series number, kernel, slice thickness, number of
files, pixel spacing, contrast, image type, scanner. No patient attribute is read or printed.
Usage: series_survey.py <wallet> <study_uid> [<study_uid> ...]    (bucket genobank-health-imaging, prefix <wallet>/imaging/<study>/)"""
import glob, os, subprocess, sys, tempfile
BUCKET = "genobank-health-imaging"


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def main(wallet, studies):
    import pydicom
    for study in studies:
        pre = f"gs://{BUCKET}/{wallet}/imaging/{study}/"
        series = [l.strip().rstrip("/") for l in sh(["gcloud", "storage", "ls", pre]).splitlines() if l.strip()]
        print(f"\n== study {study[-22:]}  ({len(series)} series)")
        for sp in series:
            objs = [l.strip() for l in sh(["gcloud", "storage", "ls", sp + "/"]).splitlines() if l.strip().endswith(".dcm")]
            if not objs:
                print(f"  {sp.split('/')[-1][-24:]}  no .dcm objects"); continue
            with tempfile.TemporaryDirectory() as td:
                subprocess.run(["gcloud", "storage", "cp", objs[len(objs) // 2], td + "/h.dcm"], capture_output=True)
                try:
                    ds = pydicom.dcmread(td + "/h.dcm", stop_before_pixels=True)
                except Exception as e:
                    print(f"  {sp.split('/')[-1][-24:]}  {len(objs)} files, unreadable: {type(e).__name__}"); continue
            g = lambda k: str(getattr(ds, k, "") or "").replace("\\", "/")
            if os.environ.get("TIMES"):
                print(f"  {sp.split('/')[-1][-24:]} #{g('SeriesNumber'):>3s} {g('SeriesDescription')[:26]:26s} acq={g('AcquisitionTime')[:6]} bolus_start={g('ContrastBolusStartTime')[:6] or '-'} "
                      f"bolus_stop={g('ContrastBolusStopTime')[:6] or '-'} agent={g('ContrastBolusAgent')[:22] or '-'} route={g('ContrastBolusRoute')[:10] or '-'} protocol={g('ProtocolName')[:24]}")
                continue
            print(f"  {sp.split('/')[-1][-24:]}  {g('Modality'):3s} n={len(objs):4d} #{g('SeriesNumber'):>4s}  {g('SeriesDescription')[:34]:34s} "
                  f"kernel={g('ConvolutionKernel') or '-':10s} thick={g('SliceThickness'):>5s} px={g('PixelSpacing')[:11]:11s} "
                  f"contrast={'Y' if getattr(ds, 'ContrastBolusAgent', None) else 'n'} type={g('ImageType')[:30]}  {g('ManufacturerModelName')[:18]} {g('SeriesDate')}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
