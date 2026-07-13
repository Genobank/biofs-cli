#!/usr/bin/env python3
"""train_fp_head.py — train the false-positive second-reader head on frozen CT-FM+PASTA embeddings.

Target is the LUNA16 candidate class directly (1 = true nodule, 0 = false positive) — no
binarization. (extract_embeddings.py writes the class into the 'malignancy' column when the input
labels.csv carries a 'label' column.) Reports PATIENT(series)-GROUPED 10-fold CV AUROC/AUPRC, then
fits the final StandardScaler + isotonic-calibrated logistic regression. Saves scaler, head, a
subsample of scaled train embeddings (inference OOD), and meta.json. CPU, minutes.

Env: EMB (embeddings parquet), OUTDIR (head dir), ORGAN."""
import os, sys, json
import numpy as np

EMB = os.getenv("EMB", "/scratch/characterize/fpreader/luna_embeddings.parquet")
OUTDIR = os.getenv("OUTDIR", "/scratch/characterize/fpreader/lung")
ORGAN = os.getenv("ORGAN", "lung")
_LABELS = {
    "lung": "LUNA16 candidate class (1=true nodule, 0=false-positive detection candidate); lung only",
    "liver": "MSD Task03 Liver: real tumor (1) vs non-lesion organ tissue (0); lesion-presence, NOT malignancy",
    "pancreas": "MSD Task07 Pancreas: real tumor (1) vs non-lesion organ tissue (0); lesion-presence, NOT malignancy",
}


def main():
    import pandas as pd, joblib
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import StratifiedGroupKFold
    from sklearn.metrics import roc_auc_score, average_precision_score
    from sklearn.calibration import CalibratedClassifierCV

    df = pd.read_parquet(EMB)
    df["y"] = df.malignancy.astype(int)                  # already 1=true nodule, 0=FP
    feat_cols = [c for c in df.columns if c.startswith("ctfm_") or c.startswith("pasta_")]
    ctfm_cols = [c for c in feat_cols if c.startswith("ctfm_")]
    X = df[feat_cols].values.astype(np.float32)
    y = df.y.values.astype(int)
    groups = df.patient_id.values
    n_pos, n_neg = int(y.sum()), int((1 - y).sum())
    print(f"[train-fp] {len(df)} candidates ({n_pos} true nodule, {n_neg} FP), "
          f"{len(np.unique(groups))} series, {len(feat_cols)} features", flush=True)

    aucs, aps = [], []
    n_splits = min(10, n_pos, n_neg)
    if n_splits >= 2 and len(np.unique(groups)) >= n_splits:
        skf = StratifiedGroupKFold(n_splits=n_splits, shuffle=True, random_state=42)
        for tr, te in skf.split(X, y, groups):
            if len(np.unique(y[te])) < 2:
                continue
            sc = StandardScaler().fit(X[tr])
            clf = LogisticRegression(max_iter=3000, class_weight="balanced", C=1.0).fit(sc.transform(X[tr]), y[tr])
            p = clf.predict_proba(sc.transform(X[te]))[:, 1]
            aucs.append(roc_auc_score(y[te], p)); aps.append(average_precision_score(y[te], p))

    scaler = StandardScaler().fit(X)
    base = LogisticRegression(max_iter=3000, class_weight="balanced", C=1.0)
    cv_cal = min(5, n_pos, n_neg)
    head = (CalibratedClassifierCV(base, method="isotonic", cv=cv_cal).fit(scaler.transform(X), y)
            if cv_cal >= 2 else base.fit(scaler.transform(X), y))

    os.makedirs(OUTDIR, exist_ok=True)
    joblib.dump(scaler, os.path.join(OUTDIR, "scaler.pkl"))
    joblib.dump(head, os.path.join(OUTDIR, "head.pkl"))
    Xs = scaler.transform(X)
    idx = np.random.RandomState(0).choice(len(Xs), min(len(Xs), 2000), replace=False)
    np.save(os.path.join(OUTDIR, "train_emb.npy"), Xs[idx].astype(np.float32))

    meta = {"organ": ORGAN, "n": int(len(df)), "n_true": n_pos, "n_fp": n_neg,
            "n_series": int(len(np.unique(groups))), "feat_dim": len(feat_cols),
            "ctfm_dim": len(ctfm_cols), "pasta_dim": len(feat_cols) - len(ctfm_cols),
            "cv_folds": len(aucs),
            "cv_auroc_mean": (float(np.mean(aucs)) if aucs else None),
            "cv_auroc_std": (float(np.std(aucs)) if aucs else None),
            "cv_auprc_mean": (float(np.mean(aps)) if aps else None),
            "label": os.getenv("TRAIN_LABEL", _LABELS.get(ORGAN, f"{ORGAN}: real lesion (1) vs non-lesion (0)")),
            "calibration": (f"isotonic cv={cv_cal}" if cv_cal >= 2 else "uncalibrated (too few samples)")}
    json.dump(meta, open(os.path.join(OUTDIR, "meta.json"), "w"), indent=2)
    print("TRAIN_FP_RESULT " + json.dumps(meta))


if __name__ == "__main__":
    main()
