#!/usr/bin/env python3
"""merlin_char_runner.py - Tier-2 method: Merlin learned embedding-change.

Merlin (Stanford CT vision-language foundation, Nature 2026) image encoder. Per candidate,
embed the baseline + follow-up ROI and report the embedding-change (1 - cosine) - a DIFFERENT
learned backbone than CT-FM, so concordance between them is informative. New/resolved lesions
have one timepoint only. Decision-support, not a diagnosis.
"""
import os, sys, json, tempfile, traceback
os.environ.setdefault("HF_HOME", "/scratch/hf")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import characterize_common as CC
log = CC.log


def reduce_emb(out):
    import numpy as np
    if isinstance(out, dict):
        out = out.get("image_embedding") or out.get("image") or next(iter(out.values()))
    if hasattr(out, "detach"):
        return out.detach().float().cpu().numpy().squeeze().reshape(-1)
    raise RuntimeError(f"unexpected Merlin output type {type(out)}")


def embed(nii_path, model, transforms):
    import torch
    img = transforms({"image": nii_path})["image"]
    if img.ndim != 4:
        raise RuntimeError(f"Merlin transform rank {img.ndim} (expected 4 = C,H,W,D)")
    with torch.no_grad():
        out = model(img.unsqueeze(0).cuda())
    return reduce_emb(out)


def main():
    wallet = os.environ["WALLET"]; job = os.environ["FINDINGS_JOB"]
    wd = tempfile.mkdtemp(prefix="merlin_")
    try:
        import numpy as np, merlin
        from merlin.data.monai_transforms import ImageTransforms
        model = merlin.Merlin(ImageEmbedding=True).eval().cuda()
        _, cands = CC.load_candidates(wallet, job, wd)
        out = []
        for c in cands:
            be = embed(c["baseline"]["ct"], model, ImageTransforms) if c.get("baseline") else None
            fe = embed(c["followup"]["ct"], model, ImageTransforms) if c.get("followup") else None
            cos = change = None
            if be is not None and fe is not None:
                cos = float(np.dot(be, fe) / ((np.linalg.norm(be) * np.linalg.norm(fe)) + 1e-8))
                change = round(1.0 - cos, 4)
            out.append({"id": c["id"], "organ": c["organ"], "tumor_class": c["tumor_class"],
                        "status": c["status"],
                        "embed_dim": int(be.shape[0]) if be is not None else (int(fe.shape[0]) if fe is not None else None),
                        "has_baseline": be is not None, "has_followup": fe is not None,
                        "embedding_change": change,
                        "cosine_similarity": (round(cos, 4) if cos is not None else None)})
            log(f"{c['id']} ({c['tumor_class']}, {c['status']}): merlin embedding_change={change}")
        print("MERLIN_RESULT " + json.dumps({
            "method": "merlin", "schema": "tier2-merlin/1",
            "model": "Merlin (Stanford CT vision-language foundation, Nature 2026)",
            "signal": "embedding_change = 1 - cosine(baseline, followup) in the Merlin image-embedding space",
            "n_candidates": len(out), "candidates": out}))
    except Exception as e:
        log("ERROR", e); traceback.print_exc()
        print("MERLIN_RESULT " + json.dumps({"method": "merlin", "status": "error", "error": str(e)[:300]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
