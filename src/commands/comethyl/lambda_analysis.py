#!/usr/bin/env python3
"""
comethyl gate=lambda analyzer.

Input  : modkit `extract calls` TSV (per-read, per-CpG thresholded calls) + a windows BED.
Output : JSON with per-window co-methylation decay-length lambda + the pre-registered null
         discipline (4 baselines, the rho>0.97 kill-switch, the bulk-collapsed control, the
         aggregate 1-exp-vs-2-exp BIC gate).

Science (single exponential):  rho(d) = C + A*exp(-d/lambda)
  rho(d) = within-read concordance (same 5mCG state) of CpG pairs separated by d bp.
  C  ~ chance concordance p^2+(1-p)^2 ; lambda = the co-methylation correlation length.

Honest discipline ported from the proteome work:
  - lambda must NOT be a re-encoding of a trivial baseline. Kill-switch = Spearman(lambda, baseline)
    across windows; |rho| > 0.97 with ANY of {mean, variance, CpG-density, PDR} => NULL-B (redundant).
  - bulk-collapsed control: the per-CpG-fraction spatial autocorrelation length (computable from
    BULK) vs the single-molecule lambda. If equal, the long reads added nothing.
  - multi-exp BIC: does a 2nd pole (a real correlation-length spectrum) earn its keep over a scalar.

No disease claim, n=1 methods scope.
"""
import sys, json
from collections import defaultdict
import numpy as np
from scipy.optimize import curve_fit
from scipy.stats import spearmanr

EXTRACT = sys.argv[1]
WINBED  = sys.argv[2]
OUT     = sys.argv[3]

TAB = chr(9)
BINS = np.array([0, 50, 100, 150, 200, 300, 400, 600, 800, 1200, 1600, 2400, 3200], dtype=float)
CENTERS = 0.5 * (BINS[:-1] + BINS[1:])

# ---- windows ----
wins = []
with open(WINBED) as fh:
    for line in fh:
        p = line.rstrip("\n").split(TAB)
        if len(p) < 3:
            continue
        wins.append({
            "chrom": p[0], "start": int(p[1]), "end": int(p[2]),
            "name": p[3] if len(p) > 3 else (p[0] + ":" + p[1]),
            "imprinted": (len(p) > 4 and p[4] == "1"),
        })
bychrom = defaultdict(list)
for i, w in enumerate(wins):
    bychrom[w["chrom"]].append((w["start"], w["end"], i))


def win_of(chrom, pos):
    for s, e, i in bychrom.get(chrom, []):
        if s <= pos < e:
            return i
    return -1


# ---- parse modkit extract calls ----
reads_by_win = [defaultdict(list) for _ in wins]
with open(EXTRACT) as fh:
    header = fh.readline().rstrip("\n").split(TAB)
    idx = {c: i for i, c in enumerate(header)}
    ci, pi, ri, cc = idx.get("chrom"), idx.get("ref_position"), idx.get("read_id"), idx.get("call_code")
    if None in (ci, pi, ri, cc):
        json.dump({"error": "missing_columns", "header": header}, open(OUT, "w"))
        print(json.dumps({"verdict": "ERROR_missing_columns", "header": header}))
        sys.exit(0)
    mx = max(ci, pi, ri, cc)
    for line in fh:
        p = line.rstrip("\n").split(TAB)
        if len(p) <= mx:
            continue
        code = p[cc]
        if code == "m":
            st = 1
        elif code == "-":
            st = 0
        else:
            continue  # drop 5hmC ('h') and ambiguous; this gate is 5mCG co-methylation
        try:
            pos = int(p[pi])
        except ValueError:
            continue
        wi = win_of(p[ci], pos)
        if wi < 0:
            continue
        reads_by_win[wi][p[ri]].append((pos, st))


def rho_of_d(reads):
    conc = np.zeros(len(BINS) - 1)
    tot = np.zeros(len(BINS) - 1)
    for _rid, calls in reads.items():
        if len(calls) < 2:
            continue
        calls = sorted(calls)
        n = len(calls)
        for a in range(n):
            pa, sa = calls[a]
            for b in range(a + 1, n):
                pb, sb = calls[b]
                d = pb - pa
                if d <= 0 or d > BINS[-1]:
                    continue
                k = int(np.searchsorted(BINS, d, side="right") - 1)
                if 0 <= k < len(tot):
                    tot[k] += 1
                    if sa == sb:
                        conc[k] += 1
    with np.errstate(invalid="ignore", divide="ignore"):
        rho = np.where(tot > 0, conc / tot, np.nan)
    return rho, conc, tot


def _f1(d, C, A, lam):
    return C + A * np.exp(-d / lam)


def fit_lambda(rho, tot):
    m = (tot > 20) & np.isfinite(rho)
    if m.sum() < 4:
        return None
    x, y = CENTERS[m], rho[m]
    try:
        popt, _ = curve_fit(_f1, x, y,
                            p0=[float(np.nanmin(y)), max(1e-3, float(np.nanmax(y) - np.nanmin(y))), 200.0],
                            bounds=([0, 0, 1], [1, 1, 1e5]), maxfev=30000)
        resid = y - _f1(x, *popt)
        ss = float(np.sum(resid ** 2))
        sst = float(np.sum((y - np.mean(y)) ** 2))
        r2 = 1 - ss / sst if sst > 0 else 0.0
        return {"C": float(popt[0]), "A": float(popt[1]), "lambda": float(popt[2]), "r2": float(r2), "n": int(m.sum())}
    except Exception:
        return None


def baselines(reads):
    allstates = []
    cpgs = set()
    percpg = defaultdict(list)
    ndisc = nspan = 0
    for _rid, calls in reads.items():
        states = [s for _, s in calls]
        if len(calls) >= 2:
            nspan += 1
            if 0 in states and 1 in states:
                ndisc += 1
        for pos, s in calls:
            cpgs.add(pos)
            percpg[pos].append(s)
            allstates.append(s)
    mean = float(np.mean(allstates)) if allstates else float("nan")
    fr = [float(np.mean(v)) for v in percpg.values() if v]
    var = float(np.var(fr)) if fr else float("nan")
    return mean, var, len(cpgs), (float(ndisc / nspan) if nspan > 0 else float("nan")), percpg


def bulk_decay_length(percpg):
    """bulk-collapsed control: spatial autocorrelation length of the per-CpG mean fraction."""
    fr = {pos: float(np.mean(v)) for pos, v in percpg.items() if len(v) >= 3}
    pos = sorted(fr)
    if len(pos) < 12:
        return None
    vals = np.array([fr[p] for p in pos])
    mu = float(np.mean(vals))
    cov = np.zeros(len(BINS) - 1)
    tot = np.zeros(len(BINS) - 1)
    for a in range(len(pos)):
        for b in range(a + 1, len(pos)):
            d = pos[b] - pos[a]
            if d <= 0 or d > BINS[-1]:
                continue
            k = int(np.searchsorted(BINS, d, side="right") - 1)
            if 0 <= k < len(tot):
                tot[k] += 1
                cov[k] += (fr[pos[a]] - mu) * (fr[pos[b]] - mu)
    with np.errstate(invalid="ignore", divide="ignore"):
        ac = np.where(tot > 0, cov / tot, np.nan)
    v0 = float(np.nanmax(ac)) if np.isfinite(ac).any() else 0.0
    if v0 <= 0:
        return None
    norm = ac / v0
    m = (tot > 10) & np.isfinite(norm) & (norm > 0)
    if m.sum() < 4:
        return None
    try:
        popt, _ = curve_fit(lambda d, A, lam: A * np.exp(-d / lam), CENTERS[m], norm[m],
                            p0=[1.0, 200.0], bounds=([0, 1], [2, 1e5]), maxfev=20000)
        return float(popt[1])
    except Exception:
        return None


# ---- per-window pass + aggregate accumulation ----
per = []
agg_conc = np.zeros(len(BINS) - 1)
agg_tot = np.zeros(len(BINS) - 1)
bulk_lams = []
for wi, w in enumerate(wins):
    reads = reads_by_win[wi]
    nread = sum(1 for r in reads.values() if len(r) >= 2)
    rec = {"name": w["name"], "chrom": w["chrom"], "imprinted": w["imprinted"], "nreads": nread}
    if nread < 10:
        rec.update({"lambda": None, "reason": "low_read_support"})
        per.append(rec)
        continue
    rho, conc, tot = rho_of_d(reads)
    agg_conc += conc
    agg_tot += tot
    mean, var, dens, pdr, percpg = baselines(reads)
    rec.update({"mean": mean, "var": var, "cpg_density": dens, "pdr": pdr})
    fit = fit_lambda(rho, tot)
    if fit:
        rec.update({"lambda": fit["lambda"], "A": fit["A"], "C": fit["C"], "r2": fit["r2"]})
    else:
        rec.update({"lambda": None, "reason": "fit_failed"})
    bl = bulk_decay_length(percpg)
    rec["bulk_lambda"] = bl
    if fit and bl is not None:
        bulk_lams.append((fit["lambda"], bl))
    per.append(rec)

# ---- kill-switch: Spearman(lambda, baseline) across windows ----
L = [r for r in per if r.get("lambda") is not None and np.isfinite(r.get("mean", float("nan")))]


def spear(key):
    xs = [r["lambda"] for r in L]
    ys = [r[key] for r in L]
    if len(xs) < 6:
        return None
    rho, p = spearmanr(xs, ys)
    return {"rho": float(rho), "p": float(p), "n": len(xs)}


killswitch = {k: spear(k) for k in ("mean", "var", "cpg_density", "pdr")}
redundant = [k for k, v in killswitch.items() if v and abs(v["rho"]) > 0.97]

# ---- bulk-collapsed control: single-molecule lambda vs bulk autocorrelation length ----
bulk_control = None
if len(bulk_lams) >= 6:
    sm = np.array([a for a, _ in bulk_lams])
    bk = np.array([b for _, b in bulk_lams])
    rho, p = spearmanr(sm, bk)
    ratio = float(np.median(sm / np.where(bk > 0, bk, np.nan)))
    bulk_control = {"spearman_sm_vs_bulk": float(rho), "p": float(p),
                    "median_ratio_sm_over_bulk": ratio, "n": len(bulk_lams),
                    "single_molecule_adds_signal": bool(abs(rho) < 0.97 or not (0.8 < ratio < 1.25))}

# ---- aggregate 1-exp vs 2-exp BIC ----
with np.errstate(invalid="ignore", divide="ignore"):
    agg_rho = np.where(agg_tot > 0, agg_conc / agg_tot, np.nan)
bic = {"note": "aggregate rho(d): 1-exp vs 2-exp"}
m = (agg_tot > 50) & np.isfinite(agg_rho)
if m.sum() >= 6:
    X, Y, N = CENTERS[m], agg_rho[m], int(m.sum())
    try:
        p1, _ = curve_fit(_f1, X, Y, p0=[float(np.nanmin(Y)), 0.3, 200.0],
                          bounds=([0, 0, 1], [1, 1, 1e5]), maxfev=40000)
        ss1 = float(np.sum((Y - _f1(X, *p1)) ** 2))
        bic1 = N * np.log(ss1 / N) + 3 * np.log(N)
        bic = {"bic1": float(bic1), "lambda1": float(p1[2]), "ss1": ss1, "n": N}
        try:
            def _f2(d, C, A1, l1, A2, l2):
                return C + A1 * np.exp(-d / l1) + A2 * np.exp(-d / l2)
            p2, _ = curve_fit(_f2, X, Y, p0=[float(np.nanmin(Y)), 0.2, 80.0, 0.2, 800.0],
                              bounds=([0, 0, 1, 0, 1], [1, 1, 1e5, 1, 1e5]), maxfev=60000)
            ss2 = float(np.sum((Y - _f2(X, *p2)) ** 2))
            bic2 = N * np.log(ss2 / N) + 5 * np.log(N)
            bic.update({"bic2": float(bic2),
                        "lambda2_fast": float(min(p2[2], p2[4])),
                        "lambda2_slow": float(max(p2[2], p2[4])),
                        "ss2": ss2,
                        "two_pole_earns_keep": bool(bic2 < bic1 - 10)})
        except Exception:
            pass
    except Exception:
        pass

n_lambda = len(L)
if redundant:
    verdict = "NULL-B_lambda_redundant_with_" + "+".join(redundant)
elif n_lambda >= 6:
    verdict = "lambda_survives_killswitch"
else:
    verdict = "insufficient_windows"

out = {"gate": "lambda", "n_windows": len(wins), "n_windows_with_lambda": n_lambda,
       "per_window": per, "killswitch": killswitch, "killswitch_redundant_with": redundant,
       "bulk_collapsed_control": bulk_control, "aggregate_bic": bic, "verdict": verdict}
json.dump(out, open(OUT, "w"), indent=2)
print(json.dumps({"verdict": verdict, "n_lambda": n_lambda, "killswitch": killswitch,
                  "redundant": redundant, "bulk_control": bulk_control,
                  "bic_two_pole": bic.get("two_pole_earns_keep")}))
