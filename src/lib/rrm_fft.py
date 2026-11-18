#!/usr/bin/env python3
"""Cosic RRM numerical core used by biofs fourier-score and rrm-consensus.

This module exists because the previous TS-embedded FFT had three scientific
bugs that made missense scoring uninformative:

1. Full-protein |X| was L1-normalized then ratioed. A single residue in a
   1000-aa chain cannot move that ratio off 1.00.
2. Window N=31 cannot resolve typical Cosic periods (20-50 aa). You need at
   least ~3 periods in the window.
3. Stop-gains were either rejected or treated as missense-to-EIIP-0, which
   is not a truncation.

What Cosic actually gives a variant:

- The family characteristic frequency f_c is a *period* (cycles/residue).
- A residue at index n contributes x[n] * exp(-2πi k n / L) to harmonic k.
- The mutation's *phase alignment* with the existing X(k) tells you whether
  it supports or opposes the conserved resonance (position-dependent).
- A stop-gain is scored by comparing |X(f_c)| of the truncated chain to the
  full chain at the same physical frequency (interpolated rfftfreq).

EIIP values: Cosic 1994 Rydberg table. Ile and Leu are 0 by construction.
"""
from __future__ import annotations

import json
import sys
from typing import Any

import numpy as np

EIIP = {
    "A": 0.0373, "R": 0.0959, "N": 0.0036, "D": 0.1263, "C": 0.0829,
    "E": 0.0058, "Q": 0.0761, "G": 0.0050, "H": 0.0242, "I": 0.0000,
    "L": 0.0000, "K": 0.0371, "M": 0.0823, "F": 0.0946, "P": 0.0198,
    "S": 0.0829, "T": 0.0941, "W": 0.0548, "Y": 0.0516, "V": 0.0057,
}

# Side-chain electric dipole moment (Debye). Avbelj 2000 / Cieplak 2009.
# This is the piezoelectric encoding: charged residues dominate, Asn is
# visible (3.50 D) unlike EIIP where Asn is nearly silent (0.0036).
PIEZO = {
    "A": 0.40, "R": 13.5, "N": 3.50, "D": 7.20, "C": 1.40,
    "E": 7.00, "Q": 3.60, "G": 0.00, "H": 2.30, "I": 0.13,
    "L": 0.13, "K": 8.30, "M": 1.20, "F": 0.13, "P": 0.00,
    "S": 1.70, "T": 1.70, "W": 2.10, "Y": 1.60, "V": 0.13,
}

ENCODINGS = {"eiip": EIIP, "piezo": PIEZO}
AA20 = list("ARNDCEQGHILKMFPSTWYV")


def table_for(encoding: str) -> dict[str, float]:
    t = ENCODINGS.get((encoding or "eiip").lower())
    if not t:
        raise ValueError(f"unknown encoding {encoding!r}; use eiip or piezo")
    return t


def encode(seq: str, encoding: str = "eiip") -> np.ndarray:
    tab = table_for(encoding)
    return np.array([tab.get(aa, 0.0) for aa in seq.upper()], dtype=float)


def mag_at_freq(seq: str, f: float, encoding: str = "eiip") -> dict[str, float]:
    """|X| interpolated at physical frequency f (cycles/residue), native length.

    Detrend then rfft. Do NOT L1-normalize: that is what hid 1-residue changes.
    """
    x = encode(seq, encoding)
    if x.size < 8:
        return {"mag": 0.0, "energy": 0.0, "length": int(x.size)}
    x = x - x.mean()
    X = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(x.size)
    mag = np.abs(X)
    energy = float(np.sum(mag ** 2))
    f = float(max(0.0, min(0.5, f)))
    interp = float(np.interp(f, freqs, mag))
    return {"mag": interp, "energy": energy, "length": int(x.size)}


def morlet_cwt(signal: np.ndarray, scales: np.ndarray, w: float = 6.0) -> np.ndarray:
    """|CWT| with a complex Morlet. scales in residue units."""
    n = len(signal)
    out = np.zeros((len(scales), n), dtype=float)
    for i, s in enumerate(scales):
        s = float(s)
        M = min(n, int(10 * s) + 1)
        if M < 4:
            M = 4
        x = np.linspace(-2 * np.pi, 2 * np.pi, M) * s
        psi = np.exp(1j * w * x / s) * np.exp(-0.5 * (x / s) ** 2) * (np.pi ** -0.25) / np.sqrt(s)
        psi -= np.exp(-0.5 * w ** 2) * np.exp(-0.5 * (x / s) ** 2) * (np.pi ** -0.25) / np.sqrt(s)
        conv = np.convolve(signal, np.conj(psi[::-1]), mode="same")
        out[i] = np.abs(conv)
    return out


def wavelet_at_residue(
    wt_seq: str,
    mt_seq: str,
    pos1: int,
    encoding: str = "eiip",
    scales: list[float] | None = None,
) -> dict[str, float]:
    """Spatial-spectral disruption at the mutated residue (Morlet CWT column)."""
    scales_a = np.array(scales or [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64], dtype=float)
    def col(seq: str) -> np.ndarray:
        x = encode(seq, encoding)
        if x.size < 16:
            return np.zeros(len(scales_a))
        x = x - x.mean()
        mag = morlet_cwt(x, scales_a)
        i = min(max(int(pos1) - 1, 0), mag.shape[1] - 1)
        return mag[:, i]
    w = col(wt_seq)
    m = col(mt_seq)
    d = np.abs(m - w)
    return {
        "l1": float(d.sum()),
        "max_delta": float(d.max()) if d.size else 0.0,
        "argmax_scale": float(scales_a[int(np.argmax(d))]) if d.size else 0.0,
        "wt_col_energy": float((w ** 2).sum()),
        "mt_col_energy": float((m ** 2).sum()),
    }


def window_for_period(period_aa: float, cap: int = 201) -> int:
    """Odd window long enough to resolve the family period (~3 cycles)."""
    if not period_aa or period_aa <= 0:
        return 31
    n = int(round(3 * period_aa))
    if n % 2 == 0:
        n += 1
    n = max(31, min(cap, n))
    if n % 2 == 0:
        n -= 1
    return n


def extract_window(seq: str, center1: int, n: int) -> str:
    flank = n // 2
    start = center1 - 1 - flank
    end = center1 - 1 + flank + 1
    out = []
    for i in range(start, end):
        out.append(seq[i] if 0 <= i < len(seq) else "X")
    return "".join(out)


def windowed_delta(wt_win: str, mt_win: str, encoding: str = "eiip") -> dict[str, float]:
    wt = encode(wt_win, encoding)
    mt = encode(mt_win, encoding)
    wt_dt = wt - wt.mean()
    mt_dt = mt - mt.mean()
    Xw = np.abs(np.fft.rfft(wt))
    Xm = np.abs(np.fft.rfft(mt))
    delta = np.abs(Xw - Xm)
    Xw_dt = np.abs(np.fft.rfft(wt_dt))
    Xm_dt = np.abs(np.fft.rfft(mt_dt))
    delta_dt = np.abs(Xw_dt - Xm_dt)
    no_dc = delta[1:] if delta.size > 1 else delta
    e_wt = float((Xw ** 2).sum())
    e_mt = float((Xm ** 2).sum())
    return {
        "sum_abs_delta": float(delta.sum()),
        "sum_abs_delta_nodc": float(no_dc.sum()) if no_dc.size else 0.0,
        "sum_abs_delta_detrended": float(delta_dt.sum()),
        "max_abs_delta_nodc": float(no_dc.max()) if no_dc.size else 0.0,
        "max_bin_nodc": int(np.argmax(no_dc) + 1) if no_dc.size else 0,
        "energy_change_ratio": float((e_mt - e_wt) / e_wt) if e_wt > 0 else 0.0,
        "k0_delta": float(delta[0]) if delta.size else 0.0,
    }


def phase_at_fc(seq: str, pos1: int, alt: str, f: float, encoding: str = "eiip") -> dict[str, Any]:
    """Position-dependent Cosic metric: does this substitution oppose X(f_c)?

    For k != 0, a point mutation of size Δ at index n0 adds
        ΔX = Δ * exp(-2πi k n0 / L)
    to the unnormalized DFT. Alignment with the existing phasor X is
        cos(θ − φ) = Re(ΔX * conj(X)) / (|ΔX| |X|)
    Negative alignment means the mutation reduces the conserved harmonic.
    """
    seq = seq.upper()
    n0 = int(pos1) - 1
    if n0 < 0 or n0 >= len(seq):
        return {"error": "position out of range"}
    ref = seq[n0]
    tab = table_for(encoding)
    d_eiip = tab.get(alt, 0.0) - tab.get(ref, 0.0)
    x = encode(seq, encoding)
    x = x - x.mean()
    L = x.size
    freqs = np.fft.rfftfreq(L)
    k = int(np.argmin(np.abs(freqs - f)))
    X = np.fft.rfft(x)
    Xk = X[k]
    mag = float(np.abs(Xk))
    theta = -2.0 * np.pi * k * n0 / L
    dX = d_eiip * np.exp(1j * theta)
    if mag > 0 and abs(d_eiip) > 1e-15:
        alignment = float(np.real(dX * np.conj(Xk)) / (abs(dX) * mag))
    else:
        alignment = 0.0
    # Projection of the change onto the existing peak (same units as |X|).
    proj = float(np.real(dX * np.conj(Xk)) / mag) if mag > 0 else 0.0
    fractional = abs(d_eiip) / mag if mag > 0 else 0.0
    if alignment < -0.3:
        call = "destructive"
    elif alignment > 0.3:
        call = "constructive"
    else:
        call = "orthogonal"
    return {
        "ref": ref,
        "alt": alt,
        "delta_eiip": float(d_eiip),
        "fc_bin": int(k),
        "fc_freq_used": float(freqs[k]),
        "X_mag": mag,
        "alignment": alignment,
        "projection": proj,
        "fractional_perturbation": float(fractional),
        "call": call,
        "ref_eiip": float(tab.get(ref, 0.0)),
        "alt_eiip": float(tab.get(alt, 0.0)),
        "ref_is_eiip_silent": tab.get(ref, 0.0) < (0.01 if encoding == "eiip" else 0.5),
        "encoding": encoding,
    }


def truncation_at_fc(seq: str, stop1: int, f: float, encoding: str = "eiip") -> dict[str, Any]:
    """Compare informational spectrum of seq[:stop1-1] vs full seq at f_c."""
    seq = seq.upper()
    cut = max(1, min(int(stop1) - 1, len(seq)))
    wt = mag_at_freq(seq, f, encoding)
    mt = mag_at_freq(seq[:cut], f, encoding)
    ratio = (mt["mag"] / wt["mag"]) if wt["mag"] > 0 else 0.0
    lost = len(seq) - cut
    if ratio < 0.8:
        call = "truncation_disrupts_fc"
    elif ratio < 0.9:
        call = "truncation_mild_fc_loss"
    elif ratio > 1.2:
        call = "truncation_shifts_energy"
    else:
        call = "truncation_preserves_fc"
    return {
        "stop_pos": int(stop1),
        "kept_residues": cut,
        "lost_residues": lost,
        "wt_mag": wt["mag"],
        "mt_mag": mt["mag"],
        "fc_ratio": float(ratio),
        "wt_energy": wt["energy"],
        "mt_energy": mt["energy"],
        "energy_ratio": float(mt["energy"] / wt["energy"]) if wt["energy"] > 0 else 0.0,
        "call": call,
    }


def null_alts_at_site(
    seq: str,
    pos1: int,
    observed_alt: str,
    f: float | None,
    encoding: str = "eiip",
    window: int | None = None,
) -> dict[str, Any]:
    """Rank the observed alt among the 19 substitutions at this site.

    Windowed Σ|ΔF|(k≥1) percentile: 100 means louder than every other amino
    acid here. If consensus f is given, also rank destructive projection.
    The window must match scoring (3× family period), not a hardcoded N=31.
    """
    seq = seq.upper()
    n0 = int(pos1) - 1
    ref = seq[n0]
    period_aa = (1.0 / float(f)) if f else 0.0
    if window is not None:
        n_win = int(window)
        if n_win % 2 == 0:
            n_win += 1
        n_win = max(31, min(201, n_win))
    else:
        n_win = window_for_period(period_aa)
    wt_win = extract_window(seq, pos1, n_win)
    rows = []
    for aa in AA20:
        if aa == ref:
            continue
        mt_win = wt_win[: n_win // 2] + aa + wt_win[n_win // 2 + 1 :]
        w = windowed_delta(wt_win, mt_win, encoding)
        rec: dict[str, Any] = {"alt": aa, "sum_abs_delta_nodc": w["sum_abs_delta_nodc"]}
        if f is not None:
            ph = phase_at_fc(seq, pos1, aa, f, encoding)
            rec["alignment"] = ph["alignment"]
            rec["projection"] = ph["projection"]
        rows.append(rec)
    observed = [r for r in rows if r["alt"] == observed_alt]
    def percentile(key: str, higher_is_more: bool) -> float | None:
        if not observed:
            return None
        val = observed[0][key]
        if higher_is_more:
            n_le = sum(1 for r in rows if r[key] <= val)
        else:
            n_le = sum(1 for r in rows if r[key] >= val)
        return 100.0 * n_le / len(rows)

    out: dict[str, Any] = {
        "n_alts": len(rows),
        "window": n_win,
        "windowed_dF_percentile": percentile("sum_abs_delta_nodc", True),
    }
    if f is not None and observed:
        # more destructive = more negative alignment
        out["destructive_percentile"] = percentile("alignment", False)
        out["observed_alignment"] = observed[0]["alignment"]
    return out


def score(payload: dict[str, Any]) -> dict[str, Any]:
    seq = payload["sequence"].upper().replace(" ", "")
    pos = int(payload["pos"])
    alt = str(payload.get("alt") or "")
    kind = payload.get("kind") or "auto"
    f = payload.get("fc_freq")
    period = payload.get("fc_period")
    encoding = str(payload.get("encoding") or "eiip").lower()
    tab = table_for(encoding)
    if alt in ("*", "Ter", "Stop", "X"):
        alt_aa = "*"
    else:
        alt_aa = alt
    if kind == "auto":
        kind = "truncation" if alt_aa == "*" else "missense"
    if pos < 1 or pos > len(seq):
        return {"error": f"position {pos} out of range for length {len(seq)}"}
    ref = seq[pos - 1]
    expected = payload.get("ref")
    if expected and expected not in ("*", "Ter") and expected != ref:
        return {"error": f"reference mismatch: sequence has {ref}, HGVS has {expected}"}

    if kind == "truncation":
        if f is None:
            return {"error": "truncation scoring needs fc_freq from rrm-consensus"}
        tr = truncation_at_fc(seq, pos, float(f), encoding)
        tr["kind"] = "truncation"
        tr["ref"] = ref
        tr["gene"] = payload.get("gene")
        tr["variant"] = payload.get("variant")
        return tr

    period_aa = float(period) if period else 0.0
    n_win = int(payload["window"]) if payload.get("window") else window_for_period(period_aa)
    wt_win = extract_window(seq, pos, n_win)
    mt_win = wt_win[: n_win // 2] + alt_aa + wt_win[n_win // 2 + 1 :]
    w = windowed_delta(wt_win, mt_win, encoding)
    d_eiip = abs(tab.get(alt_aa, 0.0) - tab.get(ref, 0.0))
    # Residual: spectral shape beyond the trivial |ΔEIIP| amplitude.
    # Single-point DFT magnitude is ~ |Δ|; divide it out.
    residual = (w["sum_abs_delta_nodc"] / d_eiip) if d_eiip > 1e-9 else None

    out: dict[str, Any] = {
        "kind": "missense",
        "gene": payload.get("gene"),
        "variant": payload.get("variant"),
        "ref": ref,
        "alt": alt_aa,
        "pos": pos,
        "window": n_win,
        "window_reason": "3x_fc_period" if period_aa else "default_31",
        "delta_eiip": d_eiip,
        "encoding": encoding,
        "ref_eiip": float(tab.get(ref, 0.0)),
        "alt_eiip": float(tab.get(alt_aa, 0.0)),
        "ref_is_eiip_silent": tab.get(ref, 0.0) < (0.01 if encoding == "eiip" else 0.5),
        "wt_window": wt_win,
        "mt_window": mt_win,
        **{f"window_{k}": v for k, v in w.items()},
        "eiip_normalized_residual": residual,
    }
    if f is not None:
        ph = phase_at_fc(seq, pos, alt_aa, float(f), encoding)
        out["fc"] = ph
        wt_m = mag_at_freq(seq, float(f), encoding)
        mt_seq = seq[: pos - 1] + alt_aa + seq[pos:]
        mt_m = mag_at_freq(mt_seq, float(f), encoding)
        out["native_fc_ratio"] = (mt_m["mag"] / wt_m["mag"]) if wt_m["mag"] > 0 else 0.0
        out["native_fc_wt_mag"] = wt_m["mag"]
        out["native_fc_mt_mag"] = mt_m["mag"]
        if payload.get("null_model"):
            out["null_model"] = null_alts_at_site(
                seq, pos, alt_aa, float(f), encoding, window=n_win
            )
        # Combined call. Dest percentile gate is a rank, not a P/LP probability.
        if ph.get("ref_is_eiip_silent") and d_eiip < 0.02:
            out["fourier_call"] = "eiip_blind_residue"
        elif ph.get("call") == "destructive" and (out.get("null_model") or {}).get("destructive_percentile", 50) >= 70:
            out["fourier_call"] = "destructive_at_fc"
        elif ph.get("call") == "destructive":
            out["fourier_call"] = "weakly_destructive_at_fc"
        elif ph.get("call") == "constructive":
            out["fourier_call"] = "constructive_at_fc"
        else:
            out["fourier_call"] = "orthogonal_to_fc"
    elif payload.get("null_model"):
        out["null_model"] = null_alts_at_site(
            seq, pos, alt_aa, None, encoding, window=n_win
        )
        out["fourier_call"] = "windowed_only"
    else:
        out["fourier_call"] = "windowed_only"
    mt_full = seq[: pos - 1] + alt_aa + seq[pos:]
    out["wavelet"] = wavelet_at_residue(seq, mt_full, pos, encoding)
    return out


def consensus_from_fasta(fasta: str, encoding: str = "eiip") -> dict[str, Any]:
    import re

    encoding = (encoding or "eiip").lower()
    table_for(encoding)  # raise early on unknown encoding
    entries = []
    parts = re.split(r"^>([^\n]+)\n", fasta, flags=re.M)
    parts = parts[1:]
    for i in range(0, len(parts), 2):
        hdr = parts[i]
        seq = re.sub(r"\s", "", parts[i + 1] if i + 1 < len(parts) else "").upper()
        acc_m = re.match(r"(sp|tr)\|([A-Z0-9]+)\|", hdr)
        acc = acc_m.group(2) if acc_m else hdr.split(" ")[0]
        if len(seq) >= 100:
            entries.append({"accession": acc, "sequence": seq, "length": len(seq)})
    if len(entries) < 5:
        return {"error": f"too few sequences ({len(entries)}); need at least 5"}

    lengths = [e["length"] for e in entries]
    common_length = int(np.median(lengths))
    spectra = []
    for e in entries:
        s = e["sequence"][:common_length]
        if len(s) < common_length:
            s = s + "X" * (common_length - len(s))
        x = encode(s, encoding)
        x = x - x.mean()
        X = np.abs(np.fft.rfft(x))
        total = X.sum()
        if total > 0:
            X = X / total
        spectra.append(X)
    S = np.stack(spectra)
    log_S = np.log(S + 1e-12)
    consensus = np.exp(log_S.sum(axis=0))
    csum = consensus.sum()
    if csum > 0:
        consensus = consensus / csum
    freqs = np.fft.rfftfreq(common_length)
    bg_mean = float(np.median(consensus))
    bg_std = float(np.std(consensus))
    threshold = bg_mean + 3 * bg_std
    peaks = []
    for k in range(2, len(consensus) - 1):
        if consensus[k] > consensus[k - 1] and consensus[k] > consensus[k + 1] and consensus[k] > threshold:
            f = float(freqs[k])
            peaks.append({
                "bin": int(k),
                "freq_normalized": f,
                "magnitude": float(consensus[k]),
            })
    peaks.sort(key=lambda p: p["magnitude"], reverse=True)

    def _period(p: dict) -> float:
        f = float(p.get("freq_normalized") or 0)
        return (1.0 / f) if f > 0 else 0.0

    # Cosic functional periods are typically 8-80 aa. ~3.6 aa is alpha-helix
    # pitch and dominates coiled-coil proteins if left unfiltered.
    in_band = [p for p in peaks if 8.0 <= _period(p) <= 80.0]
    helical = [p for p in peaks if 0 < _period(p) < 8.0]
    top_peaks = (in_band or peaks)[:8]
    fc_band = "functional" if in_band else ("helical_artifact" if helical and not in_band else "unfiltered")
    if not top_peaks:
        k = int(np.argmax(consensus[2:]) + 2)
        top_peaks = [{
            "bin": k,
            "freq_normalized": float(freqs[k]),
            "magnitude": float(consensus[k]),
        }]
        fc_band = "argmax_fallback"
    fc = top_peaks[0]
    snr = float((fc["magnitude"] - bg_mean) / (bg_std + 1e-12))
    return {
        "n_sequences": len(entries),
        "sequence_lengths": {
            "min": int(min(lengths)),
            "max": int(max(lengths)),
            "mean": float(np.mean(lengths)),
        },
        "common_length": common_length,
        "rfft_n": int(len(consensus)),
        "consensus_spectrum": consensus.tolist(),
        "consensus_peak_bins": top_peaks,
        "characteristic_frequency_bin": fc["bin"],
        "characteristic_frequency_normalized": fc["freq_normalized"],
        "characteristic_frequency_period_aa": (1.0 / fc["freq_normalized"]) if fc["freq_normalized"] > 0 else 0.0,
        "background_mean": bg_mean,
        "background_std": bg_std,
        "signal_to_noise_ratio": snr,
        "uniprot_ids": [e["accession"] for e in entries],
        "length_cv": float(np.std(lengths) / np.mean(lengths)) if np.mean(lengths) else 0.0,
        "fc_band": fc_band,
        "encoding": encoding,
    }


def selftest() -> None:
    # Pure cosine period 20 should peak near f=0.05
    n = 400
    t = np.arange(n)
    seq = "".join("D" if np.cos(2 * np.pi * t[i] / 20) > 0 else "I" for i in range(n))
    x = encode(seq)
    x = x - x.mean()
    mag = np.abs(np.fft.rfft(x))
    freqs = np.fft.rfftfreq(n)
    k = int(np.argmax(mag[2:]) + 2)
    f = float(freqs[k])
    assert abs(f - 0.05) < 0.01, f
    # Truncating away half the oscillator should drop mag at f
    tr = truncation_at_fc(seq, n // 2, f)
    assert tr["fc_ratio"] < 0.9, tr
    # Window rule
    assert window_for_period(37.7) >= 111
    nm = null_alts_at_site(seq, n // 2, "A", f)
    assert nm["window"] == window_for_period(1.0 / f), nm
    print(json.dumps({"ok": True, "synth_f": f, "trunc_ratio": tr["fc_ratio"], "auto_window": window_for_period(37.7), "null_window": nm["window"]}))


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "selftest":
        selftest()
        return
    payload = json.loads(sys.stdin.read())
    op = payload.get("op", "score")
    if op == "consensus":
        print(json.dumps(consensus_from_fasta(payload["fasta"], payload.get("encoding") or "eiip")))
        return
    print(json.dumps(score(payload)))


if __name__ == "__main__":
    main()
