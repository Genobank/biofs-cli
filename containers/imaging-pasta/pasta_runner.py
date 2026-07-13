#!/usr/bin/env python3
"""pasta_runner.py — Tier-2 method: PASTA pan-tumor learned embedding-change.

For each candidate (localized + tracked upstream), extract the PASTA feature embedding of the
baseline ROI and the follow-up ROI, and report the embedding-change (1 - cosine similarity), the
PASTA analog of the CT-FM / Merlin embedding-change: how different the lesion looks to a
pan-tumor foundation model trained on 30k synthetic CT volumes. New/resolved lesions have one
timepoint only (no change). Decision-support, not a diagnosis.

Model: PASTA (Pan-tumor Analysis with Synthetic Training Augmentation), Liu et al., arXiv
2502.06171; github.com/LWHYC/PASTA. The architecture (Generic_UNet_classify) is loaded from the
official repo so the checkpoint state_dict matches; the checkpoint PASTA_final.pth (Google Drive
id 1A_PjIAqKg0y_Z986HSfTsYKLhc99EMkD) is mounted from /scratch, not baked in. Interface and the
SLF intensity normalization are copied verbatim from the repo's feature_extraction.py /
classification/dataloaders/data_process_func.py (Apache-2.0), verified live before wiring.
"""
import os, sys, json, tempfile, traceback, importlib.util
os.environ.setdefault("HF_HOME", "/scratch/hf")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import characterize_common as CC
log = CC.log

PASTA_DIR = os.getenv("PASTA_DIR", "/opt/PASTA")
PASTA_CKPT = os.getenv("PASTA_CKPT", "/scratch/pasta/PASTA_final.pth")
THRESH_LS = [-1000, -200, 200, 1000]   # PASTA SLF thresholds (HU)
NORM_LS = [0, 0.2, 0.9, 1]             # PASTA SLF normalized values


def _load_generic_unet():
    """Import Generic_UNet_classify directly from the cloned repo file (provenance), without
    triggering the classification package __init__ (which pulls matplotlib/torchio)."""
    p = os.path.join(PASTA_DIR, "classification", "networks", "generic_UNet.py")
    spec = importlib.util.spec_from_file_location("pasta_generic_unet", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.Generic_UNet_classify


def get_pasta(device):
    """Replica of the repo's get_pasta() (feature_extraction.py): the exact architecture the
    PASTA_final.pth checkpoint was trained with, so the state_dict loads."""
    import torch.nn as nn
    GUC = _load_generic_unet()
    net = GUC(1, 64, 1, 5,
              2, 2, nn.Conv3d, nn.InstanceNorm3d, {"eps": 1e-5, "affine": True},
              nn.Dropout3d, {"p": 0, "inplace": True},
              nn.LeakyReLU, {"negative_slope": 1e-2, "inplace": True}, True, False,
              None, None, False, True, True).float().to(device)
    return net


def load_pasta_weights(net):
    import torch
    ckpt = torch.load(PASTA_CKPT, map_location="cpu")
    # the checkpoint may be the raw state_dict (as in the repo example) or wrapped
    if isinstance(ckpt, dict) and not any(hasattr(v, "shape") for v in ckpt.values()):
        for key in ("state_dict", "network_weights", "model", "net"):
            if key in ckpt and isinstance(ckpt[key], dict):
                ckpt = ckpt[key]; break
    md = net.state_dict()

    def _filter(sd):
        return {k: v for k, v in sd.items() if k in md and hasattr(v, "shape") and v.shape == md[k].shape}
    filt = _filter(ckpt)
    if not filt:                                          # try stripping a DataParallel 'module.' prefix
        stripped = {k[len("module."):]: v for k, v in ckpt.items() if k.startswith("module.")}
        filt = _filter(stripped)
    md.update(filt)
    net.load_state_dict(md, strict=False)
    skipped = len([k for k in ckpt if k not in filt]) if isinstance(ckpt, dict) else 0
    log(f"PASTA weights: loaded {len(filt)} tensors, skipped {skipped} "
        f"(head/seg layers are expected to skip for feature extraction)")
    return len(filt)


def pad_to_divisible_by_32(img):
    """Copied from the repo feature_extraction.py: pad (B,C,D,H,W) so D,H,W are divisible by 32
    (PASTA has 5 pooling stages)."""
    import torch.nn.functional as F
    B, C, D, H, W = img.shape
    pad = (0, (32 - W % 32) % 32, 0, (32 - H % 32) % 32, 0, (32 - D % 32) % 32)
    return F.pad(img, pad, mode="constant", value=0), pad


def img_multi_thresh_normalized_torch(file, thresh_lis, norm_lis, data_type=None):
    """Verbatim from the repo classification/dataloaders/data_process_func.py: a Segmental
    Linear Function (SLF) intensity transform (Lei et al., Neurocomputing 2021). Clamps to
    norm_lis[0] below thresh_lis[0] and to norm_lis[-1] above thresh_lis[-1], linear between."""
    import torch
    data_type = data_type or torch.float32
    thresh_lis = torch.tensor(thresh_lis, dtype=data_type, device=file.device)
    norm_lis = torch.tensor(norm_lis, dtype=data_type, device=file.device)
    slopes = (norm_lis[1:] - norm_lis[:-1]) / (thresh_lis[1:] - thresh_lis[:-1])
    intercepts = norm_lis[:-1]
    new_file = torch.zeros_like(file, dtype=data_type) + norm_lis[0]
    for i in reversed(range(len(thresh_lis) - 1)):
        mask = (file >= thresh_lis[i]) & (file < thresh_lis[i + 1])
        new_val = slopes[i] * (file - thresh_lis[i]) + intercepts[i]
        new_file = torch.where(mask, new_val, new_file)
    new_file[file >= thresh_lis[-1]] = norm_lis[-1]
    return new_file


def embed(net, ct_path, device):
    import SimpleITK as sitk, numpy as np, torch
    arr = sitk.GetArrayFromImage(sitk.ReadImage(ct_path)).astype(np.float32)   # [z,y,x] HU
    x = torch.from_numpy(arr)[None, None].to(device)                           # [1,1,D,H,W]
    x, _ = pad_to_divisible_by_32(x)
    x = img_multi_thresh_normalized_torch(x, THRESH_LS, NORM_LS)
    with torch.no_grad():
        feat = net(x, output_feature=True)
        if hasattr(feat, "dim") and feat.dim() == 5:
            v = torch.nn.functional.adaptive_avg_pool3d(feat, 1).flatten()
        else:
            v = feat.flatten()
    return v.float().cpu().numpy()


def main():
    wallet = os.environ["WALLET"]; job = os.environ["FINDINGS_JOB"]
    wd = tempfile.mkdtemp(prefix="pasta_")
    try:
        import torch, numpy as np
        if not os.path.exists(PASTA_CKPT):
            raise RuntimeError(f"PASTA checkpoint not found at {PASTA_CKPT} (mount /scratch)")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        net = get_pasta(device).eval()
        n_loaded = load_pasta_weights(net)
        net.eval()
        _, cands = CC.load_candidates(wallet, job, wd)
        out = []
        for c in cands:
            be = fe = None
            try:
                be = embed(net, c["baseline"]["ct"], device) if c.get("baseline") else None
                fe = embed(net, c["followup"]["ct"], device) if c.get("followup") else None
            except Exception as ce:
                log(f"{c['id']}: embed error {ce}")
            cos = change = None
            if be is not None and fe is not None:
                cos = float(np.dot(be, fe) / ((np.linalg.norm(be) * np.linalg.norm(fe)) + 1e-8))
                change = round(1.0 - cos, 4)
            out.append({"id": c["id"], "organ": c["organ"], "tumor_class": c["tumor_class"],
                        "status": c["status"], "embed_dim": (int(be.shape[0]) if be is not None
                                                             else (int(fe.shape[0]) if fe is not None else None)),
                        "has_baseline": be is not None, "has_followup": fe is not None,
                        "embedding_change": change,
                        "cosine_similarity": (round(cos, 4) if cos is not None else None)})
            log(f"{c['id']} ({c['tumor_class']}, {c['status']}): pasta embedding_change={change}")
        print("PASTA_RESULT " + json.dumps({
            "method": "pasta", "schema": "tier2-pasta/1",
            "model": "PASTA pan-tumor foundation model (LWHYC/PASTA)", "cite": "PASTA (arXiv 2502.06171)",
            "weights_loaded": n_loaded,
            "signal": "embedding_change = 1 - cosine(baseline, followup) in the PASTA feature space",
            "preprocess": f"SLF normalize thresh={THRESH_LS} norm={NORM_LS}, pad to /32 (verbatim from repo)",
            "n_candidates": len(out), "candidates": out}))
    except Exception as e:
        log("ERROR", e); traceback.print_exc()
        print("PASTA_RESULT " + json.dumps({"method": "pasta", "status": "error", "error": str(e)[:300]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
