#!/usr/bin/env python3
"""extract_embeddings.py — extract CT-FM(512)+PASTA(1024) embeddings from a directory of labeled
ROI niftis, for training the benign/malignant head. Dataset-agnostic: it reads a labels.csv with
columns [roi_path, patient_id, label_or_malignancy, ...extra] (roi_path relative to ROI_DIR or
absolute) and writes one parquet row per ROI with the two embeddings concatenated. Runs in the
imaging-classifier (FROM imaging-pasta) GPU container, reusing the exact verified extractors so the
training embeddings match inference byte-for-byte.

Env: LABELS_CSV, ROI_DIR (prefix for relative roi_path), OUT (parquet path)."""
import os, sys, json, csv
import numpy as np
os.environ.setdefault("HF_HOME", "/scratch/hf")
sys.path.insert(0, "/app")

LABELS_CSV = os.getenv("LABELS_CSV", "/scratch/characterize/classifier/lidc_rois/labels.csv")
ROI_DIR = os.getenv("ROI_DIR", "/scratch/characterize/classifier/lidc_rois")
OUT = os.getenv("OUT", "/scratch/characterize/classifier/lidc_embeddings.parquet")


def log(*a): print("[extract-emb]", *a, flush=True)


def main():
    import torch
    import ctfm_runner as CF, pasta_runner as PA
    from lighter_zoo import SegResEncoder
    from monai.transforms import (Compose, LoadImage, EnsureType, Orientation,
                                   ScaleIntensityRange, CropForeground)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    cf_model = SegResEncoder.from_pretrained("project-lighter/ct_fm_feature_extractor").eval().to(device)
    cf_pre = Compose([LoadImage(ensure_channel_first=True), EnsureType(), Orientation(axcodes="SPL"),
                      ScaleIntensityRange(a_min=-1024, a_max=2048, b_min=0, b_max=1, clip=True),
                      CropForeground(allow_smaller=True)])
    pa_net = PA.get_pasta(device).eval(); PA.load_pasta_weights(pa_net)

    with open(LABELS_CSV) as f:
        recs = list(csv.DictReader(f))
    log(f"{len(recs)} ROIs in {LABELS_CSV}")
    rows = []
    for i, r in enumerate(recs):
        rp = r["roi_path"]
        if not os.path.isabs(rp):
            rp = os.path.join(ROI_DIR, rp)
        if not os.path.exists(rp):
            log(f"skip missing {rp}"); continue
        try:
            ce = CF.embed(cf_model, cf_pre, rp, device)
            pe = PA.embed(pa_net, rp, device)
        except Exception as e:
            log(f"embed failed {rp}: {e}"); continue
        row = {"patient_id": r.get("patient_id", ""),
               "malignancy": int(float(r.get("malignancy", r.get("label", -1)))),
               "n_readers": int(float(r.get("n_readers", 0) or 0))}
        for j, v in enumerate(ce): row[f"ctfm_{j}"] = float(v)
        for j, v in enumerate(pe): row[f"pasta_{j}"] = float(v)
        rows.append(row)
        if (i + 1) % 100 == 0: log(f"{i+1}/{len(recs)} done, {len(rows)} embedded")
    import pandas as pd
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    df = pd.DataFrame(rows); df.to_parquet(OUT)
    dist = {int(k): int(v) for k, v in df["malignancy"].value_counts().items()} if len(df) else {}
    log(f"WROTE {OUT}: {len(df)} ROIs, malignancy dist {dist}")
    print("EXTRACT_RESULT " + json.dumps({"n": len(df), "out": OUT, "malignancy_dist": dist,
                                          "ctfm_dim": 512, "pasta_dim": 1024}))


if __name__ == "__main__":
    main()
