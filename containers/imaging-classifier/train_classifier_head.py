#!/usr/bin/env python3
"""train_classifier_head.py — train the benign/malignant head on frozen CT-FM+PASTA embeddings.

LIDC-IDRI consensus malignancy 1-5 -> binarize (>=4 malignant, <=2 benign, ==3 dropped as
indeterminate). Reports honest PATIENT-GROUPED 10-fold CV AUROC/AUPRC (no patient's nodules split
across folds, which would inflate the metric), then fits the final StandardScaler + isotonic-
calibrated logistic regression on all data. Saves scaler, calibrated head, a subsample of scaled
train embeddings (for the inference OOD distance), and a metrics/provenance meta.json. CPU, minutes.

Env: EMB (embeddings parquet), OUTDIR (head dir), ORGAN."""
import os, sys, json
import numpy as np

EMB = os.getenv("EMB", "/scratch/characterize/classifier/lidc_embeddings.parquet")
OUTDIR = os.getenv("OUTDIR", "/scratch/characterize/classifier/lung")
ORGAN = os.getenv("ORGAN", "lung")


def main():
    import pandas as pd, joblib
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import StratifiedGroupKFold
    from sklearn.metrics import roc_auc_score, average_precision_score
    from sklearn.calibration import CalibratedClassifierCV

    df = pd.read_parquet(EMB)
    df = df[df.malignancy != 3].copy()
    df["y"] = (df.malignancy >= 4).astype(int)
    feat_cols = [c for c in df.columns if c.startswith("ctfm_") or c.startswith("pasta_")]
    ctfm_cols = [c for c in feat_cols if c.startswith("ctfm_")]
    X = df[feat_cols].values.astype(np.float32)
    y = df.y.values.astype(int)
    groups = df.patient_id.values
    n_pos, n_neg = int(y.sum()), int((1 - y).sum())
    print(f"[train] {len(df)} nodules ({n_pos} malignant, {n_neg} benign), "
          f"{len(np.unique(groups))} patients, {len(feat_cols)} features", flush=True)

    aucs, aps = [], []
    oof_p = np.full(len(y), np.nan)          # out-of-fold scores, for cross-conformal calibration
    n_splits = min(10, n_pos, n_neg)
    if n_splits >= 2 and len(np.unique(groups)) >= n_splits:
        skf = StratifiedGroupKFold(n_splits=n_splits, shuffle=True, random_state=42)
        for tr, te in skf.split(X, y, groups):
            sc = StandardScaler().fit(X[tr])
            clf = LogisticRegression(max_iter=3000, class_weight="balanced", C=1.0).fit(sc.transform(X[tr]), y[tr])
            p = clf.predict_proba(sc.transform(X[te]))[:, 1]
            oof_p[te] = p                    # each sample scored by a head that did NOT train on it
            if len(np.unique(y[te])) >= 2:
                aucs.append(roc_auc_score(y[te], p)); aps.append(average_precision_score(y[te], p))

    # ---- method 8: cross-conformal thresholds (split-conformal, Mode A) ----
    # Calibrate on the OOF positives' scores (disjoint from each fold's training). Accept (flag
    # malignant) iff p >= p_threshold guarantees marginal sensitivity ~>= 1-alpha under exchangeability
    # with the LIDC calibration cohort. Public-calibrated -> transfer to operator scans is UNVERIFIED.
    thresholds = {"mode": "split-conformal-A (accept iff p>=p_threshold; marginal sensitivity>=1-alpha)",
                  "transfer_status": "unverified (calibrated on public LIDC-IDRI; nominal alpha may be optimistic under domain shift)",
                  "guarantee": "marginal (long-run average), NOT per-patient", "alphas": {}}
    mask = ~np.isnan(oof_p)
    pos_scores = oof_p[mask][y[mask] == 1]
    if len(pos_scores) >= 5:
        s = np.sort(1.0 - np.asarray(pos_scores, float))          # nonconformity of calibration positives
        ncal = len(s)
        thresholds["achievable_alpha_floor"] = round(1.0 / (ncal + 1), 4)
        for alpha in (0.05, 0.10, 0.20):
            rank = int(np.ceil((ncal + 1) * (1 - alpha)))
            rank = min(max(rank, 1), ncal)
            q_hat = float(s[rank - 1])
            thresholds["alphas"][f"{alpha:.2f}"] = {"q_hat": round(q_hat, 4),
                                                     "p_threshold": round(1.0 - q_hat, 4), "n_calib_pos": ncal}
    else:
        thresholds["note"] = f"too few OOF positives ({len(pos_scores)}) for a conformal threshold"
    os.makedirs(OUTDIR, exist_ok=True)
    json.dump(thresholds, open(os.path.join(OUTDIR, "conformal_thresholds.json"), "w"), indent=2)

    scaler = StandardScaler().fit(X)
    base = LogisticRegression(max_iter=3000, class_weight="balanced", C=1.0)
    cv_cal = min(5, n_pos, n_neg)
    if cv_cal >= 2:
        head = CalibratedClassifierCV(base, method="isotonic", cv=cv_cal).fit(scaler.transform(X), y)
    else:
        head = base.fit(scaler.transform(X), y)

    os.makedirs(OUTDIR, exist_ok=True)
    joblib.dump(scaler, os.path.join(OUTDIR, "scaler.pkl"))
    joblib.dump(head, os.path.join(OUTDIR, "head.pkl"))
    Xs = scaler.transform(X)
    idx = np.random.RandomState(0).choice(len(Xs), min(len(Xs), 2000), replace=False)
    np.save(os.path.join(OUTDIR, "train_emb.npy"), Xs[idx].astype(np.float32))

    meta = {"organ": ORGAN, "n": int(len(df)), "n_malignant": n_pos, "n_benign": n_neg,
            "n_patients": int(len(np.unique(groups))), "feat_dim": len(feat_cols),
            "ctfm_dim": len(ctfm_cols), "pasta_dim": len(feat_cols) - len(ctfm_cols),
            "cv_folds": len(aucs),
            "cv_auroc_mean": (float(np.mean(aucs)) if aucs else None),
            "cv_auroc_std": (float(np.std(aucs)) if aucs else None),
            "cv_auprc_mean": (float(np.mean(aps)) if aps else None),
            "label": "LIDC-IDRI consensus malignancy >=4 vs <=2 (radiologist SUSPICION, not pathology)",
            "binarization": ">=4 malignant, <=2 benign, ==3 dropped",
            "calibration": (f"isotonic cv={cv_cal}" if cv_cal >= 2 else "uncalibrated (too few samples)"),
            "conformal": thresholds}
    json.dump(meta, open(os.path.join(OUTDIR, "meta.json"), "w"), indent=2)
    print("TRAIN_RESULT " + json.dumps(meta))


if __name__ == "__main__":
    main()
