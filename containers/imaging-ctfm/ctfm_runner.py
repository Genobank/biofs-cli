#!/usr/bin/env python3
"""ctfm_runner.py — Tier-2 method: CT-FM learned embedding-change.

For each candidate (localized + tracked upstream), extract the 512-d CT-FM feature embedding
of the baseline ROI and the follow-up ROI, and report the embedding-change (1 - cosine
similarity) as the LEARNED analog of the radiomics delta: how different the lesion looks to a
foundation model trained self-supervised on 148k CT scans. New/resolved lesions have one
timepoint only (no change). Decision-support, not a diagnosis.

Model: CT-FM SegResEncoder (project-lighter/ct_fm_feature_extractor, apache-2.0; CT-FM,
arXiv 2501.09001). Verified interface from the model card.
"""
import os, sys, json, tempfile, traceback
os.environ.setdefault("HF_HOME", "/scratch/hf")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import characterize_common as CC
log = CC.log


def embed(model, preprocess, ct_path, device):
    import torch
    t = preprocess(ct_path)
    with torch.no_grad():
        out = model(t.unsqueeze(0).to(device))[-1]
        v = torch.nn.functional.adaptive_avg_pool3d(out, 1).squeeze()
    return v.float().cpu().numpy()


def main():
    wallet = os.environ["WALLET"]; job = os.environ["FINDINGS_JOB"]
    wd = tempfile.mkdtemp(prefix="ctfm_")
    try:
        import torch, numpy as np
        from lighter_zoo import SegResEncoder
        from monai.transforms import (Compose, LoadImage, EnsureType, Orientation,
                                       ScaleIntensityRange, CropForeground)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = SegResEncoder.from_pretrained("project-lighter/ct_fm_feature_extractor").eval().to(device)
        preprocess = Compose([
            LoadImage(ensure_channel_first=True), EnsureType(), Orientation(axcodes="SPL"),
            ScaleIntensityRange(a_min=-1024, a_max=2048, b_min=0, b_max=1, clip=True),
            CropForeground(allow_smaller=True),
        ])
        _, cands = CC.load_candidates(wallet, job, wd)
        out = []
        for c in cands:
            be = embed(model, preprocess, c["baseline"]["ct"], device) if c.get("baseline") else None
            fe = embed(model, preprocess, c["followup"]["ct"], device) if c.get("followup") else None
            cos = change = None
            if be is not None and fe is not None:
                cos = float(np.dot(be, fe) / ((np.linalg.norm(be) * np.linalg.norm(fe)) + 1e-8))
                change = round(1.0 - cos, 4)
            out.append({"id": c["id"], "organ": c["organ"], "tumor_class": c["tumor_class"],
                        "status": c["status"], "embed_dim": 512,
                        "has_baseline": be is not None, "has_followup": fe is not None,
                        "embedding_change": change,
                        "cosine_similarity": (round(cos, 4) if cos is not None else None)})
            log(f"{c['id']} ({c['tumor_class']}, {c['status']}): ctfm embedding_change={change}")
        print("CTFM_RESULT " + json.dumps({
            "method": "ctfm", "schema": "tier2-ctfm/1",
            "model": "CT-FM SegResEncoder (project-lighter, apache-2.0)", "cite": "CT-FM (arXiv 2501.09001)",
            "signal": "embedding_change = 1 - cosine(baseline, followup) in CT-FM 512-d feature space",
            "n_candidates": len(out), "candidates": out}))
    except Exception as e:
        log("ERROR", e); traceback.print_exc()
        print("CTFM_RESULT " + json.dumps({"method": "ctfm", "status": "error", "error": str(e)[:300]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
