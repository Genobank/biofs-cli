#!/usr/bin/env python3
"""Gene-stratified ClinVar test of Cosic-RRM / piezoelectric wave features.

Does NOT download clinvar.tar.gz. Re-scores missense already pulled by
`biofs rrm-distribution` (P/LP vs B/LB within one protein) with the
native-length f_c metrics in rrm_fft.py, once with EIIP and once with
side-chain dipole (piezo).

Why gene-stratified: a pooled ClinVar dump confounds gene length, domain
class, and submission bias with pathogenicity. The Cosic claim is that a
mutation disrupts *that protein family's* resonance.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score, average_precision_score

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "lib"))
import rrm_fft  # noqa: E402

CACHE = Path.home() / ".biofs" / "cache"
POS = {"pathogenic", "likely_pathogenic"}
NEG = {"benign", "likely_benign"}

# Genes with both classes already in rrm-distribution caches.
PANEL = ["BRCA1", "BRCA2", "TP53", "MSH2", "MLH1", "COL7A1"]


def fasta_seq(path: Path) -> str:
    return "".join(path.read_text().splitlines()[1:]).replace(" ", "").upper()


def in_band_fc(seq: str, encoding: str) -> float | None:
    x = rrm_fft.encode(seq, encoding)
    x = x - x.mean()
    mag = np.abs(np.fft.rfft(x))
    freqs = np.fft.rfftfreq(x.size)
    best = None
    for k in range(2, len(mag) - 1):
        f = float(freqs[k])
        if f <= 0:
            continue
        per = 1.0 / f
        if 8.0 <= per <= 80.0 and (best is None or mag[k] > best[0]):
            best = (float(mag[k]), f)
    return None if best is None else best[1]


def auc_safe(y, s):
    y = np.asarray(y)
    s = np.asarray(s, dtype=float)
    if len(np.unique(y)) < 2 or np.all(np.isnan(s)):
        return None
    mask = ~np.isnan(s)
    if mask.sum() < 20 or len(np.unique(y[mask])) < 2:
        return None
    try:
        return float(roc_auc_score(y[mask], s[mask]))
    except Exception:
        return None


def score_gene(gene: str) -> dict:
    dist_p = CACHE / "rrm" / f"{gene}-distribution.json"
    cons_p = CACHE / "rrm" / f"{gene}.json"
    if not dist_p.exists() or not cons_p.exists():
        return {"gene": gene, "error": "missing distribution or consensus cache"}
    dist = json.loads(dist_p.read_text())
    cons = json.loads(cons_p.read_text())
    acc = cons.get("uniprot")
    fa = CACHE / "uniprot" / f"{acc}.fasta"
    if not fa.exists():
        return {"gene": gene, "error": f"no uniprot fasta {acc}"}
    seq = fasta_seq(fa)
    fc_eiip = float(cons["characteristic_frequency_normalized"])
    period = float(cons.get("characteristic_frequency_period_aa") or 0)
    fc_piezo = in_band_fc(seq, "piezo")
    y, feat = [], {k: [] for k in [
        "eiip_alignment_destructive", "eiip_native_fc_drop", "eiip_window_df",
        "piezo_alignment_destructive", "piezo_native_fc_drop", "piezo_window_df",
    ]}
    n_skip = 0
    for v in dist.get("variants") or []:
        lab = v.get("classification_simple")
        if lab in POS:
            label = 1
        elif lab in NEG:
            label = 0
        else:
            continue
        pos, ref, alt = v.get("position"), v.get("ref"), v.get("alt")
        if not pos or not ref or not alt or alt == "*":
            n_skip += 1
            continue
        if pos < 1 or pos > len(seq) or seq[pos - 1] != ref:
            n_skip += 1
            continue
        ei = rrm_fft.score({
            "sequence": seq, "pos": pos, "ref": ref, "alt": alt,
            "fc_freq": fc_eiip, "fc_period": period, "encoding": "eiip",
        })
        pz = rrm_fft.score({
            "sequence": seq, "pos": pos, "ref": ref, "alt": alt,
            "fc_freq": fc_piezo or fc_eiip, "fc_period": period, "encoding": "piezo",
        })
        if ei.get("error") or pz.get("error"):
            n_skip += 1
            continue
        y.append(label)
        # destructive alignment: more negative = more pathogenic under Cosic
        feat["eiip_alignment_destructive"].append(-(ei.get("fc") or {}).get("alignment") or np.nan)
        feat["eiip_native_fc_drop"].append(1.0 - (ei.get("native_fc_ratio") or np.nan))
        feat["eiip_window_df"].append(ei.get("window_sum_abs_delta_nodc") or np.nan)
        feat["piezo_alignment_destructive"].append(-(pz.get("fc") or {}).get("alignment") or np.nan)
        feat["piezo_native_fc_drop"].append(1.0 - (pz.get("native_fc_ratio") or np.nan))
        feat["piezo_window_df"].append(pz.get("window_sum_abs_delta_nodc") or np.nan)

    y = np.array(y)
    out = {
        "gene": gene,
        "uniprot": acc,
        "n_scored": int(y.size),
        "n_path": int((y == 1).sum()) if y.size else 0,
        "n_benign": int((y == 0).sum()) if y.size else 0,
        "n_skipped": n_skip,
        "eiip_fc_period": period,
        "piezo_fc": fc_piezo,
        "auc": {},
        "ap": {},
    }
    for name, s in feat.items():
        out["auc"][name] = auc_safe(y, s)
        s = np.asarray(s, dtype=float)
        mask = ~np.isnan(s)
        if mask.sum() >= 20 and len(np.unique(y[mask])) == 2:
            out["ap"][name] = float(average_precision_score(y[mask], s[mask]))
    return out


def main():
    genes = sys.argv[1:] or PANEL
    rows = [score_gene(g) for g in genes]
    print(json.dumps({"genes": rows}, indent=2, default=str))


if __name__ == "__main__":
    main()
