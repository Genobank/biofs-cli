#!/usr/bin/env python3
"""pyradiomics_runner.py — Tier-2 method: IBSI-conformant radiomics + delta-radiomics.

For each candidate (already localized + tracked by VISTA-3D + LesionLocator), extract a
compact, interpretable IBSI feature set (PyRadiomics) at baseline and follow-up, and the
baseline->follow-up DELTA. This is the engineered-quantitative arm of the Tier-2 comparison.
Decision-support, not a diagnosis. CRITICAL CAVEAT surfaced in the output: delta features are
sensitive to contrast-phase / acquisition differences between timepoints, so a candidate
whose interval has phase_match=false must be read with care (scanner change can masquerade
as biology). Grounded in Lambin 2012, Aerts 2014, IBSI (Zwanenburg 2020), van Griethuysen
2017 (PyRadiomics); delta-radiomics Fave 2017.
"""
import os, sys, json, tempfile, traceback
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import characterize_common as CC
log = CC.log

# Compact interpretable IBSI subset (first-order intensity + shape + texture).
KEY_FEATURES = [
    "original_firstorder_Mean", "original_firstorder_Median", "original_firstorder_Entropy",
    "original_firstorder_Skewness", "original_firstorder_Kurtosis",
    "original_firstorder_10Percentile", "original_firstorder_90Percentile",
    "original_shape_VoxelVolume", "original_shape_Sphericity",
    "original_shape_SurfaceVolumeRatio", "original_shape_Maximum3DDiameter",
    "original_glcm_Contrast", "original_glcm_Correlation", "original_glcm_JointEntropy",
    "original_glrlm_GrayLevelNonUniformity", "original_glszm_ZoneEntropy",
]


def _isnum(v):
    try:
        float(v); return True
    except Exception:
        return False


def extract(ct, mask):
    from radiomics import featureextractor
    import logging
    logging.getLogger("radiomics").setLevel(logging.ERROR)
    ex = featureextractor.RadiomicsFeatureExtractor()
    ex.settings["binWidth"] = 25                     # IBSI fixed-bin-width discretization
    ex.settings["label"] = 1
    res = ex.execute(ct, mask)
    return {k: round(float(v), 4) for k, v in res.items() if k in KEY_FEATURES and _isnum(v)}


def main():
    wallet = os.environ["WALLET"]; job = os.environ["FINDINGS_JOB"]
    wd = tempfile.mkdtemp(prefix="pyrad_")
    try:
        _, cands = CC.load_candidates(wallet, job, wd)
        out = []
        for c in cands:
            bf = extract(c["baseline"]["ct"], c["baseline"]["mask"]) if c.get("baseline") else None
            ff = extract(c["followup"]["ct"], c["followup"]["mask"]) if c.get("followup") else None
            delta = {k: round(ff[k] - bf[k], 4) for k in bf if k in ff} if (bf and ff) else None
            out.append({
                "id": c["id"], "organ": c["organ"], "tumor_class": c["tumor_class"],
                "status": c["status"], "phase_match": c.get("phase_match"),
                "baseline_features": bf, "followup_features": ff, "delta_features": delta,
                "delta_caveat": (None if c.get("phase_match") else
                                 "interval contrast phases differ; delta features may reflect "
                                 "acquisition change, not biology"),
            })
            log(f"{c['id']} ({c['tumor_class']}, {c['status']}): radiomics base={bool(bf)} foll={bool(ff)}")
        print("PYRADIOMICS_RESULT " + json.dumps({
            "method": "pyradiomics", "schema": "tier2-pyradiomics/1", "ibsi": True,
            "cite": "PyRadiomics (van Griethuysen 2017); IBSI (Zwanenburg 2020); delta-radiomics (Fave 2017)",
            "n_candidates": len(out), "candidates": out}))
    except Exception as e:
        log("ERROR", e); traceback.print_exc()
        print("PYRADIOMICS_RESULT " + json.dumps({"method": "pyradiomics", "status": "error",
              "error": str(e)[:300]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
