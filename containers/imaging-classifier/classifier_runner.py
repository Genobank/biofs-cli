#!/usr/bin/env python3
"""classifier_runner.py — Tier-2 method 6: benign/malignant classifier HEAD on frozen embeddings.

Loads the trained head (StandardScaler + isotonic-calibrated logistic regression) and, per
candidate ROI, extracts the SAME 512-d CT-FM + 1024-d PASTA embedding the head was trained on,
scales, and predicts a calibrated p(malignant). The head is ORGAN-GATED: it is trained on lung
nodules (LIDC-IDRI), so it scores only lung candidates and returns scored=false / out_of_domain
for any other organ rather than a misleading number. Every score carries an OOD distance (how far
the candidate sits from the public training manifold) and the not-a-diagnosis / public-data
domain-shift caveat. Decision-support, NOT a diagnosis. CLASSIFIER_RESULT {...}.

Reuses the verified embedding extractors from the same image (ctfm_runner.embed, pasta_runner.embed)
so the inference embeddings are byte-for-byte the same pipeline as training. Built FROM
imaging-pasta:latest (which has CT-FM via lighter_zoo + PASTA + the checkpoint) plus scikit-learn.
"""
import os, sys, json, tempfile, traceback
import numpy as np
os.environ.setdefault("HF_HOME", "/scratch/hf")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import characterize_common as CC
log = CC.log

HEAD_DIR = os.getenv("CLASSIFIER_HEAD_DIR", "/scratch/characterize/classifier")
TRAIN_ORGANS = set(o.strip().lower() for o in os.getenv("CLASSIFIER_ORGANS", "lung").split(",") if o.strip())
CONFORMAL_ALPHA = os.getenv("CONFORMAL_ALPHA", "0.10")   # method 8: accept/reject at this risk level


def _build_extractors(device):
    """Identical CT-FM + PASTA embedding stack as ctfm_runner / pasta_runner (so train==inference)."""
    import ctfm_runner as CF, pasta_runner as PA
    from lighter_zoo import SegResEncoder
    from monai.transforms import (Compose, LoadImage, EnsureType, Orientation,
                                   ScaleIntensityRange, CropForeground)
    cf_model = SegResEncoder.from_pretrained("project-lighter/ct_fm_feature_extractor").eval().to(device)
    cf_pre = Compose([LoadImage(ensure_channel_first=True), EnsureType(), Orientation(axcodes="SPL"),
                      ScaleIntensityRange(a_min=-1024, a_max=2048, b_min=0, b_max=1, clip=True),
                      CropForeground(allow_smaller=True)])
    pa_net = PA.get_pasta(device).eval(); PA.load_pasta_weights(pa_net)
    return CF, PA, cf_model, cf_pre, pa_net


def main():
    wallet = os.environ["WALLET"]; job = os.environ["FINDINGS_JOB"]
    wd = tempfile.mkdtemp(prefix="clf_")
    try:
        import torch, joblib
        device = "cuda" if torch.cuda.is_available() else "cpu"
        organ_dir = os.path.join(HEAD_DIR, "lung")
        for f in ("scaler.pkl", "head.pkl", "meta.json"):
            if not os.path.exists(os.path.join(organ_dir, f)):
                raise RuntimeError(f"trained head missing: {organ_dir}/{f} (train method 6 first)")
        scaler = joblib.load(os.path.join(organ_dir, "scaler.pkl"))
        head = joblib.load(os.path.join(organ_dir, "head.pkl"))
        meta = json.load(open(os.path.join(organ_dir, "meta.json")))
        tep = os.path.join(organ_dir, "train_emb.npy")
        train_emb = np.load(tep) if os.path.exists(tep) else None
        # method 8 (conformal): load the split-conformal threshold for the chosen alpha, if present
        conf = {}
        cfp = os.path.join(organ_dir, "conformal_thresholds.json")
        if os.path.exists(cfp):
            cj = json.load(open(cfp))
            conf = {"alpha": float(CONFORMAL_ALPHA), "transfer_status": cj.get("transfer_status"),
                    "guarantee": cj.get("guarantee"),
                    **(cj.get("alphas", {}).get(f"{float(CONFORMAL_ALPHA):.2f}", {}))}

        CF, PA, cf_model, cf_pre, pa_net = _build_extractors(device)
        _, cands = CC.load_candidates(wallet, job, wd)
        out = []
        for c in cands:
            roi = c.get("followup") or c.get("baseline")
            organ = (c.get("organ") or "").lower()
            base = {"id": c["id"], "organ": c["organ"], "tumor_class": c["tumor_class"], "status": c["status"]}
            in_domain = any(o in organ or organ in o for o in TRAIN_ORGANS) if organ else False
            if not roi:
                out.append({**base, "scored": False, "reason": "no ROI"}); continue
            if not in_domain:
                out.append({**base, "scored": False, "reason": "out_of_domain_organ",
                            "head_organ": sorted(TRAIN_ORGANS)})
                log(f"{c['id']} ({organ}): out-of-domain (head={sorted(TRAIN_ORGANS)})"); continue
            try:
                ce = CF.embed(cf_model, cf_pre, roi["ct"], device)   # 512
                pe = PA.embed(pa_net, roi["ct"], device)             # 1024
            except Exception as ee:
                out.append({**base, "scored": False, "reason": f"embed error: {str(ee)[:120]}"}); continue
            x = np.concatenate([np.asarray(ce, np.float32), np.asarray(pe, np.float32)])[None, :]
            xs = scaler.transform(x)
            p = float(head.predict_proba(xs)[0, 1])
            ood = None
            if train_emb is not None and train_emb.size:
                sims = (train_emb @ xs[0]) / ((np.linalg.norm(train_emb, axis=1) * np.linalg.norm(xs[0])) + 1e-8)
                ood = round(1.0 - float(np.max(sims)), 4)
            row = {**base, "scored": True, "timepoint": ("followup" if c.get("followup") else "baseline"),
                   "p_malignant": round(p, 4), "calibrated": True,
                   "ood_distance": ood, "ood_flag": (bool(ood is not None and ood > 0.5))}
            if conf.get("p_threshold") is not None:
                thr = conf["p_threshold"]
                row["conformal"] = {"alpha": conf["alpha"], "p_threshold": thr,
                                    "decision": ("flag_malignant" if p >= thr else "below_threshold"),
                                    "transfer_status": conf.get("transfer_status")}
            out.append(row)
            log(f"{c['id']} ({c['tumor_class']}, {organ}): p_malignant={p:.4f} ood={ood}"
                + (f" conformal={row['conformal']['decision']}" if "conformal" in row else ""))
        print("CLASSIFIER_RESULT " + json.dumps({
            "method": "classifier", "schema": "tier2-classifier/1",
            "model": "benign/malignant calibrated linear head on frozen CT-FM(512)+PASTA(1024) embeddings",
            "head_provenance": meta.get("label"), "trained_organ": sorted(TRAIN_ORGANS),
            "cv_auroc": meta.get("cv_auroc_mean"), "cv_auprc": meta.get("cv_auprc_mean"),
            "n_train": meta.get("n"),
            "conformal_layer": ({"alpha": conf.get("alpha"), "p_threshold": conf.get("p_threshold"),
                                 "transfer_status": conf.get("transfer_status"),
                                 "note": "method 8: distribution-free accept/reject; marginal, exchangeability-bound; "
                                         "calibrated on public LIDC so transfer to operator scans is unverified"}
                                if conf.get("p_threshold") is not None else None),
            "caveat": ("calibrated malignancy-likelihood TRIAGE score, trained on PUBLIC LIDC-IDRI "
                       "radiologist SUSPICION (1-5), NOT pathology, lung-only. Subject to domain shift "
                       "vs the operator's scanner/protocol/phase. Every score is a flagged candidate for "
                       "radiologist confirmation; out-of-domain organs are not scored. NOT a diagnosis."),
            "n_candidates": len(out), "candidates": out}))
    except Exception as e:
        log("ERROR", e); traceback.print_exc()
        print("CLASSIFIER_RESULT " + json.dumps({"method": "classifier", "status": "error", "error": str(e)[:300]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
