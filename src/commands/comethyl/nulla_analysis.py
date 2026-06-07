#!/usr/bin/env python3
"""
comethyl gate=null-a analyzer (the pre-registered FALSIFIER).

Input  : TSV of bulk per-CpG methylation fraction inside windows: win_name <tab> pos <tab> frac
Output : JSON with a Lomb-Scargle periodogram + permutation null per window.

Pre-registered prediction (expected NULL, the direct port of the proteome sequence-Fourier
negative): the BULK 1-D methylation track carries NO periodicity above the windowed-mean
baseline. The ~10.5 bp helical and ~180 bp nucleosome periods are aliased out / already inside
the mean+NDR features; by Parseval the 0/1 track's spectral mass IS the mean, so a "peak" would
be the mean in costume. NULL-A is CONFIRMED if no window shows a periodogram peak that beats its
own permutation null (frac shuffled against position). A surprising REFUTATION (real periodicity)
would itself be a finding, scored honestly against this registration.

Lomb-Scargle (not interp-then-FFT) because CpG spacing is irregular. n=1 methods scope, no disease.
"""
import sys, json
from collections import defaultdict
import numpy as np
from scipy.signal import lombscargle

IN = sys.argv[1]
OUT = sys.argv[2]
TAB = chr(9)
N_PERM = 1000   # finer permutation resolution so a real peak can survive multiple-testing correction
SEED = 12345
FDR_ALPHA = 0.05

# probe periods (bp): dense in the helical band, sparser to the nucleosome scale
PERIODS = np.concatenate([np.arange(6.0, 40.0, 0.25), np.arange(40.0, 420.0, 1.0)])
ANG = 2.0 * np.pi / PERIODS

W = defaultdict(list)
with open(IN) as fh:
    for line in fh:
        p = line.rstrip("\n").split(TAB)
        if len(p) < 3:
            continue
        try:
            W[p[0]].append((int(p[1]), float(p[2])))
        except ValueError:
            continue


def band_peak(pg, lo, hi):
    m = (PERIODS >= lo) & (PERIODS <= hi)
    if not m.any():
        return None
    sub = pg[m]
    bi = int(np.argmax(sub))
    return {"period": float(PERIODS[m][bi]), "power": float(sub[bi])}


def analyze(points):
    pts = sorted(points)
    pos = np.array([p for p, _ in pts], dtype=float)
    frac = np.array([v for _, v in pts], dtype=float)
    if len(pos) < 30:
        return None
    y = frac - frac.mean()
    if np.allclose(y, 0.0):
        return None
    pg = lombscargle(pos, y, ANG, normalize=True)
    peak_i = int(np.argmax(pg))
    peak_pow = float(pg[peak_i])
    rng = np.random.default_rng(SEED)
    maxnull = np.empty(N_PERM)
    for k in range(N_PERM):
        maxnull[k] = float(np.max(lombscargle(pos, rng.permutation(y), ANG, normalize=True)))
    pval = float((np.sum(maxnull >= peak_pow) + 1) / (N_PERM + 1))
    return {"n": int(len(pos)), "peak_period": float(PERIODS[peak_i]), "peak_power": peak_pow,
            "perm_p": pval, "null_p95": float(np.quantile(maxnull, 0.95)),
            "helical_10_11": band_peak(pg, 10.0, 11.0),
            "nucleosome_170_200": band_peak(pg, 170.0, 200.0)}


res = {}
for w, pts in W.items():
    r = analyze(pts)
    if r:
        res[w] = r

# multiple-testing matters: with N windows tested, ~N*alpha hit p<alpha by chance. NULL-A is only
# refuted if a window survives Benjamini-Hochberg FDR correction across all windows.
sig_raw = [w for w, r in res.items() if r["perm_p"] < 0.01]
items = sorted(res.items(), key=lambda kv: kv[1]["perm_p"])
m = len(items)
kmax = 0
for i, (w, r) in enumerate(items, start=1):
    if r["perm_p"] <= (i / m) * FDR_ALPHA:
        kmax = i
sig_bh = [items[i][0] for i in range(kmax)]
verdict = "NULL-A_confirmed_no_periodicity" if not sig_bh else "NULL-A_REFUTED_periodicity_found"
note = ("permutation floor = 1/(N_PERM+1) = %.4f; %d windows; BH-FDR alpha=%.2f. "
        "Raw p<0.01 hits (uncorrected) do NOT refute the null; only BH-survivors do."
        % (1.0 / (N_PERM + 1), m, FDR_ALPHA))
out = {"gate": "null-a", "n_windows_analyzed": m, "n_perm": N_PERM,
       "significant_raw_p01": sig_raw, "significant_bh_fdr": sig_bh,
       "per_window": res, "verdict": verdict, "note": note}
json.dump(out, open(OUT, "w"), indent=2)
print(json.dumps({"verdict": verdict, "n_windows": m, "n_raw_p01": len(sig_raw),
                  "n_bh_fdr": len(sig_bh), "bh_significant": sig_bh[:10]}))
