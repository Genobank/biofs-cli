#!/usr/bin/env python3
"""medgemma_char_runner.py - Tier-2 method: MedGemma zero-shot interpretive read.

A medical VLM reads a windowed axial slice through each candidate and returns a short
characterization + a single benign/malignant LEAN. This is the INTERPRETIVE arm of the Tier-2
comparison (vs engineered radiomics + learned embeddings). Zero-shot, decision-support, NOT a
diagnosis, NOT a medical device. A 2D slice read by a general medical VLM is the weakest-grounded
of the methods and is included for cross-method perspective, not as a quantitative result.
"""
import os, sys, json, tempfile, traceback
os.environ.setdefault("HF_HOME", "/scratch/hf")
# With a token (the first cache run) load online; without one (executor runs) load the cached
# gated weights offline so no token has to flow through the pipeline at runtime.
if not os.getenv("HF_TOKEN"):
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import characterize_common as CC
log = CC.log


def roi_slice(ct_path, mask_path):
    import SimpleITK as sitk, numpy as np
    from PIL import Image
    ct = sitk.GetArrayFromImage(sitk.ReadImage(ct_path)).astype(np.float32)   # [z,y,x]
    mk = sitk.GetArrayFromImage(sitk.ReadImage(mask_path))
    areas = (mk > 0).sum(axis=(1, 2))
    z = int(areas.argmax()) if areas.max() > 0 else ct.shape[0] // 2
    lo, hi = -160.0, 240.0                                                    # soft-tissue window WL40/WW400
    img = (np.clip((ct[z] - lo) / (hi - lo), 0, 1) * 255.0).astype(np.uint8)
    im = Image.fromarray(img).convert("RGB")
    if max(im.size) < 224:
        s = 224.0 / max(im.size); im = im.resize((int(im.size[0] * s), int(im.size[1] * s)))
    return im


def parse_lean(text):
    low = text.lower(); im_, ib = low.find("malignant"), low.find("benign")
    if im_ == -1 and ib == -1: return "indeterminate"
    if im_ == -1: return "benign"
    if ib == -1: return "malignant"
    return "malignant" if im_ < ib else "benign"


def main():
    wallet = os.environ["WALLET"]; job = os.environ["FINDINGS_JOB"]
    wd = tempfile.mkdtemp(prefix="mg_")
    try:
        import torch
        from transformers import AutoProcessor, AutoModelForImageTextToText
        mid = os.getenv("MEDGEMMA_MODEL", "google/medgemma-4b-it")
        proc = AutoProcessor.from_pretrained(mid)
        model = AutoModelForImageTextToText.from_pretrained(mid, torch_dtype=torch.bfloat16,
                                                            device_map="cuda").eval()
        _, cands = CC.load_candidates(wallet, job, wd)
        out = []
        for c in cands:
            roi = c.get("followup") or c.get("baseline")
            if not roi:
                out.append({"id": c["id"], "organ": c["organ"], "tumor_class": c["tumor_class"],
                            "status": c["status"], "lean": None, "narrative": None, "note": "no ROI"})
                continue
            im = roi_slice(roi["ct"], roi["mask"])
            prompt = (f"This is a CT region containing a candidate {c['tumor_class'].replace('_',' ')} "
                      f"in the {c['organ']}. In 2 to 3 sentences, describe its imaging features and give a "
                      "single lean: more likely BENIGN or more likely MALIGNANT, with one reason. "
                      "Decision-support only, not a diagnosis.")
            messages = [
                {"role": "system", "content": [{"type": "text",
                    "text": "You are a radiology decision-support assistant. You never give a definitive diagnosis."}]},
                {"role": "user", "content": [{"type": "image", "image": im}, {"type": "text", "text": prompt}]},
            ]
            inputs = proc.apply_chat_template(messages, add_generation_prompt=True, tokenize=True,
                                              return_dict=True, return_tensors="pt").to(model.device)
            with torch.no_grad():
                gen = model.generate(**inputs, max_new_tokens=160, do_sample=False)
            text = proc.decode(gen[0][inputs["input_ids"].shape[-1]:], skip_special_tokens=True).strip()
            lean = parse_lean(text)
            out.append({"id": c["id"], "organ": c["organ"], "tumor_class": c["tumor_class"],
                        "status": c["status"], "timepoint": ("followup" if c.get("followup") else "baseline"),
                        "lean": lean, "narrative": text[:600]})
            log(f"{c['id']} ({c['tumor_class']}, {c['status']}): medgemma lean={lean}")
        print("MEDGEMMA_RESULT " + json.dumps({
            "method": "medgemma", "schema": "tier2-medgemma/1",
            "model": f"{os.getenv('MEDGEMMA_MODEL', 'google/medgemma-4b-it')}; zero-shot; not a medical device",
            "signal": "VLM benign/malignant lean + narrative on a windowed ROI slice",
            "caveat": "a 2D slice read by a general medical VLM, zero-shot, interpretive only, not quantitative",
            "n_candidates": len(out), "candidates": out}))
    except Exception as e:
        log("ERROR", e); traceback.print_exc()
        print("MEDGEMMA_RESULT " + json.dumps({"method": "medgemma", "status": "error", "error": str(e)[:300]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
