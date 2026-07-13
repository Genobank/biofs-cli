#!/usr/bin/env python3
"""fpreader_runner.py — Tier-2 method 7: real-lesion-vs-artifact second-reader, MULTI-ORGAN.

Per candidate ROI, predicts p_true_lesion (vs detection artifact / non-lesion tissue) using a
TRAINED calibrated head on the frozen CT-FM+PASTA embeddings. The head is ORGAN-ROUTED: it loads
whatever per-organ heads exist under HEAD_DIR (lung trained on LUNA16 true-vs-FP candidates;
liver / pancreas trained on real MSD tumor-vs-non-lesion masks) and scores each candidate against
the head for ITS organ, returning out_of_domain when no head exists for that organ. This is a
real-LESION-PRESENCE signal (is this a true lesion or an artifact), NOT a malignancy assessment.
Every output carries an OOD distance + the public-data domain-shift caveat and is a flagged
candidate for radiologist confirmation, NOT an autonomous rejection. FPREADER_RESULT {...}.
"""
import os, sys, json, tempfile, traceback, glob
import numpy as np
os.environ.setdefault("HF_HOME", "/scratch/hf")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import characterize_common as CC
log = CC.log

HEAD_DIR = os.getenv("FPREADER_HEAD_DIR", "/scratch/characterize/fpreader")


def _build_extractors(device):
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


def _load_heads():
    """Discover every per-organ head dir with scaler+head+meta -> {organ: {...}}."""
    import joblib
    heads = {}
    for d in sorted(glob.glob(os.path.join(HEAD_DIR, "*"))):
        if not os.path.isdir(d):
            continue
        organ = os.path.basename(d).lower()
        if not all(os.path.exists(os.path.join(d, f)) for f in ("scaler.pkl", "head.pkl", "meta.json")):
            continue
        tep = os.path.join(d, "train_emb.npy")
        heads[organ] = {"scaler": joblib.load(os.path.join(d, "scaler.pkl")),
                        "head": joblib.load(os.path.join(d, "head.pkl")),
                        "meta": json.load(open(os.path.join(d, "meta.json"))),
                        "train_emb": (np.load(tep) if os.path.exists(tep) else None)}
    return heads


def _route(organ, heads):
    o = (organ or "").lower()
    for ho in heads:
        if ho in o or o in ho:
            return ho
    return None


def main():
    wallet = os.environ["WALLET"]; job = os.environ["FINDINGS_JOB"]
    wd = tempfile.mkdtemp(prefix="fpr_")
    try:
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
        heads = _load_heads()
        if not heads:
            raise RuntimeError(f"no trained heads under {HEAD_DIR} (train method 7 first)")
        log(f"loaded heads for organs: {sorted(heads)}")
        CF, PA, cf_model, cf_pre, pa_net = _build_extractors(device)
        _, cands = CC.load_candidates(wallet, job, wd)
        out = []
        for c in cands:
            roi = c.get("followup") or c.get("baseline")
            organ = (c.get("organ") or "").lower()
            base = {"id": c["id"], "organ": c["organ"], "tumor_class": c["tumor_class"], "status": c["status"]}
            ho = _route(organ, heads)
            if not roi:
                out.append({**base, "scored": False, "reason": "no ROI"}); continue
            if ho is None:
                out.append({**base, "scored": False, "reason": "out_of_domain_organ",
                            "available_organs": sorted(heads)})
                log(f"{c['id']} ({organ}): no head (have {sorted(heads)})"); continue
            H = heads[ho]
            try:
                ce = CF.embed(cf_model, cf_pre, roi["ct"], device)
                pe = PA.embed(pa_net, roi["ct"], device)
            except Exception as ee:
                out.append({**base, "scored": False, "reason": f"embed error: {str(ee)[:120]}"}); continue
            x = np.concatenate([np.asarray(ce, np.float32), np.asarray(pe, np.float32)])[None, :]
            xs = H["scaler"].transform(x)
            p_true = float(H["head"].predict_proba(xs)[0, 1])
            ood = None
            te = H["train_emb"]
            if te is not None and te.size:
                sims = (te @ xs[0]) / ((np.linalg.norm(te, axis=1) * np.linalg.norm(xs[0])) + 1e-8)
                ood = round(1.0 - float(np.max(sims)), 4)
            out.append({**base, "scored": True, "head_organ": ho,
                        "timepoint": ("followup" if c.get("followup") else "baseline"),
                        "p_true_lesion": round(p_true, 4), "p_false_positive": round(1.0 - p_true, 4),
                        "calibrated": True, "ood_distance": ood, "ood_flag": bool(ood is not None and ood > 0.5),
                        "head_provenance": H["meta"].get("label"), "head_cv_auroc": H["meta"].get("cv_auroc_mean")})
            log(f"{c['id']} ({c['tumor_class']}, {organ}->{ho}): p_true_lesion={p_true:.4f} ood={ood}")
        organ_summary = {o: {"cv_auroc": heads[o]["meta"].get("cv_auroc_mean"),
                             "provenance": heads[o]["meta"].get("label"), "n_train": heads[o]["meta"].get("n")}
                         for o in heads}
        print("FPREADER_RESULT " + json.dumps({
            "method": "fpreader", "schema": "tier2-fpreader/2",
            "model": "real-lesion-vs-artifact calibrated head on frozen CT-FM(512)+PASTA(1024) embeddings, organ-routed",
            "organ_heads": organ_summary, "trained_organ": sorted(heads),
            "caveat": ("real-lesion-vs-artifact (lesion PRESENCE) second-reader score, organ-routed, trained on "
                       "PUBLIC data (lung = LUNA16 true-vs-FP candidates; liver/pancreas = MSD real tumor-vs-non-lesion "
                       "masks). This is NOT a malignancy assessment. Subject to domain shift vs the operator's scanner; "
                       "out-of-domain organs are not scored. A flagged candidate for radiologist confirmation, NOT an "
                       "autonomous rejection. NOT a diagnosis."),
            "n_candidates": len(out), "candidates": out}))
    except Exception as e:
        log("ERROR", e); traceback.print_exc()
        print("FPREADER_RESULT " + json.dumps({"method": "fpreader", "status": "error", "error": str(e)[:300]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
