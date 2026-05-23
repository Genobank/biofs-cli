/**
 * biofs fourier-score <variants>
 *
 * Compute the Cosic-RRM Discrete Fourier Transform of EIIP-encoded protein
 * windows for one or more missense variants, returning the |ΔF| spectrum
 * between wildtype and mutant sequence as a biophysical signal that complements
 * REVEL / AlphaMissense / PrimateAI-3D.
 *
 * Pipeline:
 *   1. Parse HGVS protein-level descriptors (e.g. ITGA2B:p.Val779Ala).
 *   2. Fetch (and cache) the gene's canonical UniProt sequence.
 *   3. Extract a sliding window of N residues centered on the mutation site.
 *      N defaults to 31 for the integrin headpiece, 51 for transmembrane
 *      regions (TM dominated by ~3.6-residue helical pitch).
 *   4. Map residues to Electron-Ion Interaction Potential (Cosic 1994 Rydberg
 *      values). Out-of-range residues use 0.
 *   5. Run rfft via numpy; magnitude spectrum on WT and MT; ΔF = | |X_WT| - |X_MT| |.
 *      Truncate to N/2+1 bins (one-sided real spectrum).
 *   6. Output: ΔF vector, Σ|ΔF|, max-bin index, max |ΔF|, k=0 magnitude delta.
 *
 * Future (Sprint 2): characteristic-frequency f_c from ortholog consensus
 * spectrum, E(f_c)_MT / E(f_c)_WT ratio, plot to PNG.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';

const UNIPROT_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'uniprot');

// Electron-Ion Interaction Potential (Rydberg, Cosic 1994)
const EIIP: Record<string, number> = {
  A: 0.0373, R: 0.0959, N: 0.0036, D: 0.1263, C: 0.0829,
  E: 0.0058, Q: 0.0761, G: 0.0050, H: 0.0242, I: 0.0000,
  L: 0.0000, K: 0.0371, M: 0.0823, F: 0.0946, P: 0.0198,
  S: 0.0829, T: 0.0941, W: 0.0548, Y: 0.0516, V: 0.0057,
};

const AA_3_TO_1: Record<string, string> = {
  Ala: 'A', Arg: 'R', Asn: 'N', Asp: 'D', Cys: 'C',
  Glu: 'E', Gln: 'Q', Gly: 'G', His: 'H', Ile: 'I',
  Leu: 'L', Lys: 'K', Met: 'M', Phe: 'F', Pro: 'P',
  Ser: 'S', Thr: 'T', Trp: 'W', Tyr: 'Y', Val: 'V',
  Ter: '*', Stop: '*',
};

// Canonical UniProt accessions for genes we support out-of-the-box
import { GENE_TO_UNIPROT } from '../lib/gene-map';


// UniProt-feature TM regions for known genes (inclusive 1-based residue ranges).
// Variants inside these ranges get the wider N=51 window by default.
const TM_REGIONS: Record<string, [number, number]> = {
  ITGA2B: [988, 1009],
  ITGB3:  [716, 738],
  // Tetraspanin-6 has four TM helices (UniProt O43657 feature lines)
  TSPAN6: [12, 32],     // TM1 (we annotate the first; runtime widening for any in the protein)
  // COL27A1 is secreted, no TM
  // NRCAM single-pass TM
  NRCAM:  [1117, 1137],
  // PGAP1 is an ER-membrane multipass
  PGAP1:  [11, 31],
};

export interface FourierScoreOptions {
  window?: string;        // override N for non-TM windows (default 31)
  windowTm?: string;      // override N for TM windows (default 51)
  uniprot?: string;       // override UniProt accession (single-variant mode)
  format?: string;        // table | tsv | json
  output?: string;
  plot?: string;          // path to write |ΔF| windowed-spectrum PNG (one panel per variant)
  consensusFc?: boolean;  // also compute full-protein DFT at consensus f_c (requires `biofs rrm-consensus` cache)
  plotFull?: string;      // path to write full-protein |X(k)| spectrum PNG with f_c annotated
  quiet?: boolean;
}

interface ParsedHGVS {
  gene: string | null;
  uniprot: string | null;
  pos: number;
  ref: string;
  alt: string;
  original: string;
}

function parseHgvs(s: string, fallbackUniprot?: string): ParsedHGVS {
  // Accept any of:
  //   ITGA2B:p.Val779Ala
  //   ITGA2B p.Val779Ala
  //   ITGA2B:Val779Ala
  //   p.Val779Ala  (gene from --uniprot)
  const m = s.match(/^(?:([A-Za-z][A-Za-z0-9-]*)[:\s]+)?(?:p\.)?([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2})$/);
  if (!m) throw new Error(`Cannot parse "${s}". Use ITGA2B:p.Val779Ala`);
  const [, geneRaw, ref3, posStr, alt3] = m;
  const ref = AA_3_TO_1[ref3];
  const alt = AA_3_TO_1[alt3];
  if (!ref || !alt) throw new Error(`Unknown amino acid 3-letter code in "${s}"`);
  const gene = geneRaw ? geneRaw.toUpperCase() : null;
  let uniprot: string | null = null;
  if (gene && GENE_TO_UNIPROT[gene]) uniprot = GENE_TO_UNIPROT[gene];
  else if (fallbackUniprot) uniprot = fallbackUniprot;
  return { gene, uniprot, pos: parseInt(posStr, 10), ref, alt, original: s };
}

function fetchUniprotFasta(uniprot: string): string {
  fs.mkdirSync(UNIPROT_CACHE_DIR, { recursive: true });
  const cachePath = path.join(UNIPROT_CACHE_DIR, `${uniprot}.fasta`);
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, 'utf8');
  }
  const r = spawnSync('curl', ['-fsSL', `https://rest.uniprot.org/uniprotkb/${uniprot}.fasta`], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.startsWith('>')) {
    throw new Error(`UniProt FASTA fetch failed for ${uniprot}: ${r.stderr || 'no output'}`);
  }
  fs.writeFileSync(cachePath, r.stdout);
  return r.stdout;
}

function fastaSequence(fasta: string): string {
  return fasta.split('\n').slice(1).join('').replace(/\s/g, '').toUpperCase();
}

function extractWindow(seq: string, center1: number, N: number): string {
  const flank = Math.floor(N / 2);
  const start = center1 - 1 - flank;
  const end = center1 - 1 + flank + 1;
  let w = '';
  for (let i = start; i < end; i++) {
    w += i >= 0 && i < seq.length ? seq[i] : 'X';
  }
  return w;
}

function toEIIPVector(window: string): number[] {
  return Array.from(window).map(aa => EIIP[aa] ?? 0);
}

// FFT via embedded python+numpy. Reports both raw and detrended (DC-removed)
// spectra — the detrended Σ|ΔF| is the biophysically interpretable signal
// since k=0 is just the net potential change and dominates trivially.
interface FftResult {
  wtMag: number[];
  mtMag: number[];
  deltaMag: number[];
  deltaMagDetrended: number[];
  sumAbsDelta: number;
  sumAbsDeltaNoDc: number;
  sumAbsDeltaDetrended: number;
  maxAbsDelta: number;
  maxAbsDeltaBin: number;
  maxAbsDeltaNoDc: number;
  maxAbsDeltaBinNoDc: number;
  k0Delta: number;
  energyChangeRatio: number;
}

function computeFft(wtVec: number[], mtVec: number[]): FftResult {
  const py = `
import json, sys, numpy as np
d = json.loads(sys.stdin.read())
wt = np.array(d["wt"], dtype=float)
mt = np.array(d["mt"], dtype=float)
wt_dt = wt - wt.mean()
mt_dt = mt - mt.mean()
Xw = np.abs(np.fft.rfft(wt))
Xm = np.abs(np.fft.rfft(mt))
delta = np.abs(Xw - Xm)
Xw_dt = np.abs(np.fft.rfft(wt_dt))
Xm_dt = np.abs(np.fft.rfft(mt_dt))
delta_dt = np.abs(Xw_dt - Xm_dt)
energy_wt = float((Xw ** 2).sum())
energy_mt = float((Xm ** 2).sum())
no_dc = delta[1:] if len(delta) > 1 else delta
out = {
    "wtMag": Xw.tolist(),
    "mtMag": Xm.tolist(),
    "deltaMag": delta.tolist(),
    "deltaMagDetrended": delta_dt.tolist(),
    "sumAbsDelta": float(delta.sum()),
    "sumAbsDeltaNoDc": float(no_dc.sum()),
    "sumAbsDeltaDetrended": float(delta_dt.sum()),
    "maxAbsDelta": float(delta.max()),
    "maxAbsDeltaBin": int(np.argmax(delta)),
    "maxAbsDeltaNoDc": float(no_dc.max()) if len(no_dc) > 0 else 0.0,
    "maxAbsDeltaBinNoDc": int(np.argmax(no_dc) + 1) if len(no_dc) > 0 else 0,
    "k0Delta": float(delta[0]),
    "energyChangeRatio": float((energy_mt - energy_wt) / energy_wt) if energy_wt > 0 else 0.0,
}
print(json.dumps(out))
`;
  const result = spawnSync('python3', ['-c', py], {
    encoding: 'utf8',
    input: JSON.stringify({ wt: wtVec, mt: mtVec }),
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`numpy FFT failed: ${result.stderr || result.stdout}\n(install: python3 -m pip install numpy)`);
  }
  return JSON.parse(result.stdout);
}

function isInTmRegion(gene: string | null, pos: number): boolean {
  if (!gene) return false;
  const range = TM_REGIONS[gene];
  if (!range) return false;
  return pos >= range[0] && pos <= range[1];
}

interface ScoreRow {
  variant: string;
  gene: string | null;
  pos: number;
  ref: string;
  alt: string;
  windowSize: number;
  domainHint: string;
  refEIIP: number;
  altEIIP: number;
  deltaEIIP: number;
  sumAbsDeltaF: number;
  sumAbsDeltaFNoDc: number;
  sumAbsDeltaFDetrended: number;
  maxAbsDeltaF: number;
  maxBin: number;
  maxAbsDeltaFNoDc: number;
  maxBinNoDc: number;
  k0Delta: number;
  energyChangeRatio: number;
  deltaVector: number[];
  deltaVectorDetrended: number[];
  wtSeq: string;
  mtSeq: string;
  // Full-protein f_c scoring (Cosic's canonical RRM metric, only set when --consensus-fc)
  fcBin?: number;
  fcFreqNormalized?: number;
  fcPeriodAa?: number;
  fullXwtAtFc?: number;
  fullXmtAtFc?: number;
  fcRatio?: number;            // |X_MT(f_c)| / |X_WT(f_c)| — values <1 indicate loss-of-function signature
  fcDelta?: number;            // |X_WT(f_c)| - |X_MT(f_c)|
  fcEnergyChangePct?: number;  // 100 × (|X_MT(f_c)|² - |X_WT(f_c)|²) / |X_WT(f_c)|²
  fullSpectrumWt?: number[];   // saved for plot
  fullSpectrumMt?: number[];
}

interface ConsensusCache {
  gene: string;
  uniprot: string;
  characteristic_frequency_bin: number;
  characteristic_frequency_normalized: number;
  characteristic_frequency_period_aa: number;
  common_length: number;
  consensus_peak_bins: Array<{ bin: number; freq_normalized: number; magnitude: number }>;
  signal_to_noise_ratio: number;
}

function loadConsensus(gene: string): ConsensusCache {
  const cachePath = path.join(os.homedir(), '.biofs', 'cache', 'rrm', `${gene}.json`);
  if (!fs.existsSync(cachePath)) {
    throw new Error(
      `No consensus f_c cached for ${gene}. Run first: biofs rrm-consensus ${gene}\n` +
      `(expected at ${cachePath})`
    );
  }
  return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
}

interface FullProteinFftResult {
  wtMag: number[];
  mtMag: number[];
  wtAtFc: number;
  mtAtFc: number;
  fcBinInProteinSpectrum: number;
}

interface MultiPeakScore {
  bin: number;
  period: number;
  consensusSnr: number;
  consensusMagnitude: number;
  wtMagnitude: number;
  mtMagnitude: number;
  ratio: number;
  energyChangePct: number;
}

interface ExtendedFullProteinFftResult extends FullProteinFftResult {
  multiPeakScores?: MultiPeakScore[];
  weightedAggregateDeltaEPct?: number;
  fullSpectrumL1?: number;
  totalEnergyChangePct?: number;
}

function computeFullProteinFft(
  fullWt: string,
  fullMt: string,
  fcFreqNormalized: number,
  commonLength: number,
  consensusPeaks?: Array<{ bin: number; freq_normalized: number; magnitude: number; snr?: number }>,
  consensusSpectrum?: number[],
): ExtendedFullProteinFftResult {
  const py = `
import json, sys, numpy as np

EIIP = {
    'A': 0.0373, 'R': 0.0959, 'N': 0.0036, 'D': 0.1263, 'C': 0.0829,
    'E': 0.0058, 'Q': 0.0761, 'G': 0.0050, 'H': 0.0242, 'I': 0.0000,
    'L': 0.0000, 'K': 0.0371, 'M': 0.0823, 'F': 0.0946, 'P': 0.0198,
    'S': 0.0829, 'T': 0.0941, 'W': 0.0548, 'Y': 0.0516, 'V': 0.0057,
}

d = json.loads(sys.stdin.read())

def encode(seq, target_len):
    s = seq[:target_len]
    if len(s) < target_len:
        s = s + 'X' * (target_len - len(s))
    v = np.array([EIIP.get(aa, 0.0) for aa in s], dtype=float)
    return v - v.mean()

wt_eiip = encode(d['wt'], d['common_length'])
mt_eiip = encode(d['mt'], d['common_length'])

Xw = np.abs(np.fft.rfft(wt_eiip))
Xm = np.abs(np.fft.rfft(mt_eiip))
# Normalize each to unit total energy so the result is comparable to the
# consensus magnitudes (which were also unit-normalized).
if Xw.sum() > 0: Xw = Xw / Xw.sum()
if Xm.sum() > 0: Xm = Xm / Xm.sum()

# The consensus f_c was computed on a spectrum of length common_length // 2 + 1
# in the same normalization (cycles/residue). Our full-protein DFT has the
# same axis, so we look up the bin directly.
N = len(Xw)
fc_bin = int(round(d['fc_freq'] * 2 * (N - 1)))
fc_bin = max(0, min(N - 1, fc_bin))

# Multi-peak scoring: if the caller passed consensus_peaks, score at each.
multi_peak = []
weighted_num = 0.0
weighted_den = 0.0
consensus_peaks = d.get('consensus_peaks') or []
for p in consensus_peaks:
    k = int(p['bin'])
    if k >= N: continue
    xw, xm = float(Xw[k]), float(Xm[k])
    ratio = xm / xw if xw > 0 else 0.0
    de = 100.0 * (xm*xm - xw*xw) / (xw*xw) if xw > 0 else 0.0
    mag = float(p.get('magnitude', 0))
    snr = float(p.get('snr', 0))
    multi_peak.append({
        'bin': k,
        'period': 1.0 / (k / (2*(N-1))) if k > 0 else 0,
        'consensusSnr': snr,
        'consensusMagnitude': mag,
        'wtMagnitude': xw,
        'mtMagnitude': xm,
        'ratio': ratio,
        'energyChangePct': de,
    })
    weighted_num += mag * de
    weighted_den += mag

weighted_agg = weighted_num / weighted_den if weighted_den > 0 else 0.0

# Full-spectrum integrated metrics (Cosic-style "informational spectrum distance")
spec_l1 = float(np.sum(np.abs(Xm - Xw)))
total_e_wt = float(np.sum(Xw**2))
total_e_mt = float(np.sum(Xm**2))
total_de_pct = 100.0 * (total_e_mt - total_e_wt) / total_e_wt if total_e_wt > 0 else 0.0

out = {
    'wtMag': Xw.tolist(),
    'mtMag': Xm.tolist(),
    'wtAtFc': float(Xw[fc_bin]),
    'mtAtFc': float(Xm[fc_bin]),
    'fcBinInProteinSpectrum': fc_bin,
    'multiPeakScores': multi_peak,
    'weightedAggregateDeltaEPct': weighted_agg,
    'fullSpectrumL1': spec_l1,
    'totalEnergyChangePct': total_de_pct,
}
print(json.dumps(out))
`;
  const r = spawnSync('python3', ['-c', py], {
    encoding: 'utf8',
    input: JSON.stringify({
      wt: fullWt,
      mt: fullMt,
      common_length: commonLength,
      fc_freq: fcFreqNormalized,
      consensus_peaks: consensusPeaks || [],
    }),
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`Full-protein FFT failed: ${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
}

function scoreOne(parsed: ParsedHGVS, opts: FourierScoreOptions): ScoreRow {
  if (!parsed.uniprot) {
    throw new Error(`No UniProt accession for "${parsed.original}". Pass --uniprot.`);
  }
  const fasta = fetchUniprotFasta(parsed.uniprot);
  const seq = fastaSequence(fasta);
  if (parsed.pos < 1 || parsed.pos > seq.length) {
    throw new Error(`Position ${parsed.pos} out of range for ${parsed.uniprot} (length ${seq.length})`);
  }
  const observedRef = seq[parsed.pos - 1];
  if (observedRef !== parsed.ref) {
    throw new Error(
      `Reference mismatch at ${parsed.uniprot}:${parsed.pos} — sequence has "${observedRef}", HGVS expects "${parsed.ref}"`
    );
  }

  const inTm = isInTmRegion(parsed.gene, parsed.pos);
  const defaultN = inTm ? 51 : 31;
  const Nstr = inTm ? opts.windowTm : opts.window;
  const N = Nstr ? parseInt(Nstr, 10) : defaultN;
  if (N < 5 || N > 201 || N % 2 === 0) {
    throw new Error(`Window N must be odd and 5≤N≤201, got ${N}`);
  }

  const wtSeq = extractWindow(seq, parsed.pos, N);
  const mtSeq = wtSeq.slice(0, Math.floor(N / 2)) + parsed.alt + wtSeq.slice(Math.floor(N / 2) + 1);
  const wtVec = toEIIPVector(wtSeq);
  const mtVec = toEIIPVector(mtSeq);
  const fft = computeFft(wtVec, mtVec);

  const row: ScoreRow = {
    variant: parsed.original,
    gene: parsed.gene,
    pos: parsed.pos,
    ref: parsed.ref,
    alt: parsed.alt,
    windowSize: N,
    domainHint: inTm ? 'transmembrane' : 'extracellular',
    refEIIP: EIIP[parsed.ref] ?? 0,
    altEIIP: EIIP[parsed.alt] ?? 0,
    deltaEIIP: Math.abs((EIIP[parsed.ref] ?? 0) - (EIIP[parsed.alt] ?? 0)),
    sumAbsDeltaF: fft.sumAbsDelta,
    sumAbsDeltaFNoDc: fft.sumAbsDeltaNoDc,
    sumAbsDeltaFDetrended: fft.sumAbsDeltaDetrended,
    maxAbsDeltaF: fft.maxAbsDelta,
    maxBin: fft.maxAbsDeltaBin,
    maxAbsDeltaFNoDc: fft.maxAbsDeltaNoDc,
    maxBinNoDc: fft.maxAbsDeltaBinNoDc,
    k0Delta: fft.k0Delta,
    energyChangeRatio: fft.energyChangeRatio,
    deltaVector: fft.deltaMag,
    deltaVectorDetrended: fft.deltaMagDetrended,
    wtSeq,
    mtSeq,
  };

  // Cosic RRM canonical scoring at the family characteristic frequency
  // (with multi-peak + full-spectrum integrated metrics).
  if (opts.consensusFc) {
    if (!parsed.gene) {
      throw new Error(`--consensus-fc requires a gene name in the HGVS (e.g. ITGA2B:p.Val779Ala)`);
    }
    const cons = loadConsensus(parsed.gene);
    const consensusSpectrum: number[] | undefined = (cons as any).consensus_spectrum;
    // Surface the top consensus peaks as scoring sites. If the cached file
    // only has one (strict 3σ threshold filtered the rest), augment by
    // walking the full consensus spectrum and grabbing the top-10 bins.
    let peaksWithSnr = (cons.consensus_peak_bins || []).map(p => ({
      bin: p.bin,
      freq_normalized: p.freq_normalized,
      magnitude: p.magnitude,
      snr: 0,
    }));
    if (peaksWithSnr.length < 10 && consensusSpectrum) {
      const ranked = consensusSpectrum
        .map((m, k) => ({ k, m }))
        .filter(({ k }) => k >= 2)
        .sort((a, b) => b.m - a.m)
        .slice(0, 10);
      const N = consensusSpectrum.length;
      const median = ((arr: number[]) => {
        const s = [...arr].sort((a, b) => a - b);
        return s.length % 2 === 0 ? (s[s.length / 2 - 1] + s[s.length / 2]) / 2 : s[(s.length - 1) / 2];
      })(consensusSpectrum);
      const mean = consensusSpectrum.reduce((a, b) => a + b, 0) / consensusSpectrum.length;
      const sd = Math.sqrt(consensusSpectrum.reduce((a, b) => a + (b - mean) ** 2, 0) / consensusSpectrum.length);
      peaksWithSnr = ranked.map(({ k, m }) => ({
        bin: k,
        freq_normalized: k / (2 * (N - 1)),
        magnitude: m,
        snr: (m - median) / (sd + 1e-12),
      }));
    }

    // Build the full mutant sequence by swapping the one residue at parsed.pos.
    const mtFull = seq.slice(0, parsed.pos - 1) + parsed.alt + seq.slice(parsed.pos);
    const full = computeFullProteinFft(
      seq,
      mtFull,
      cons.characteristic_frequency_normalized,
      cons.common_length,
      peaksWithSnr,
      consensusSpectrum,
    );

    row.fcBin = full.fcBinInProteinSpectrum;
    row.fcFreqNormalized = cons.characteristic_frequency_normalized;
    row.fcPeriodAa = cons.characteristic_frequency_period_aa;
    row.fullXwtAtFc = full.wtAtFc;
    row.fullXmtAtFc = full.mtAtFc;
    row.fcRatio = full.wtAtFc > 0 ? full.mtAtFc / full.wtAtFc : 0;
    row.fcDelta = full.wtAtFc - full.mtAtFc;
    row.fcEnergyChangePct = full.wtAtFc > 0
      ? 100 * (full.mtAtFc * full.mtAtFc - full.wtAtFc * full.wtAtFc) / (full.wtAtFc * full.wtAtFc)
      : 0;
    row.fullSpectrumWt = full.wtMag;
    row.fullSpectrumMt = full.mtMag;
    (row as any).multiPeakScores = full.multiPeakScores;
    (row as any).weightedAggregateDeltaEPct = full.weightedAggregateDeltaEPct;
    (row as any).fullSpectrumL1 = full.fullSpectrumL1;
    (row as any).totalEnergyChangePct = full.totalEnergyChangePct;
  }

  return row;
}

function renderFcSection(rows: ScoreRow[]): string {
  if (!rows.some(r => r.fcRatio !== undefined)) return '';
  const lines: string[] = [];
  const sep = '━'.repeat(120);
  lines.push('');
  lines.push(chalk.magenta(sep));
  lines.push(chalk.bold.magenta('  Cosic-RRM full-protein scoring at family characteristic frequency f_c'));
  lines.push(chalk.magenta(sep));
  lines.push(
    chalk.bold(
      'variant'.padEnd(30) +
        'f_c bin'.padEnd(10) +
        'period (aa)'.padEnd(13) +
        '|X_WT(f_c)|'.padEnd(14) +
        '|X_MT(f_c)|'.padEnd(14) +
        'ratio MT/WT'.padEnd(13) +
        'ΔE @ f_c'
    )
  );
  lines.push(chalk.magenta('-'.repeat(120)));
  for (const r of rows) {
    if (r.fcRatio === undefined) continue;
    const ratio = r.fcRatio;
    const ratioStr = ratio.toFixed(4);
    const ratioColor = ratio < 0.8 ? chalk.red : ratio > 1.2 ? chalk.yellow : chalk.white;
    lines.push(
      r.variant.padEnd(30) +
        String(r.fcBin).padEnd(10) +
        (r.fcPeriodAa ?? 0).toFixed(2).padEnd(13) +
        (r.fullXwtAtFc ?? 0).toExponential(3).padEnd(14) +
        (r.fullXmtAtFc ?? 0).toExponential(3).padEnd(14) +
        ratioColor(ratioStr.padEnd(13)) +
        ((r.fcEnergyChangePct ?? 0).toFixed(2) + '%')
    );
  }
  lines.push(chalk.magenta(sep));
  lines.push(chalk.gray('   ratio MT/WT  <0.8 = significant loss of energy at characteristic frequency (LoF signature)'));
  lines.push(chalk.gray('                ≈1.0 = no perturbation of family-conserved resonance'));
  lines.push(chalk.gray('                >1.2 = energy gain (rare, may indicate altered specificity)'));

  // Multi-peak + full-spectrum integrated metrics (Cosic's "informational spectrum distance")
  for (const r of rows) {
    const mps = (r as any).multiPeakScores as MultiPeakScore[] | undefined;
    if (!mps || mps.length === 0) continue;
    lines.push('');
    lines.push(chalk.magenta('-'.repeat(120)));
    lines.push(chalk.bold(`  Per-peak Cosic-RRM scoring  ${r.variant}`));
    lines.push(
      chalk.gray(
        '    ' +
          'k'.padStart(5) +
          'period'.padStart(10) +
          'SNR'.padStart(8) +
          '|X_WT|'.padStart(14) +
          '|X_MT|'.padStart(14) +
          'ratio'.padStart(10) +
          'ΔE%'.padStart(10)
      )
    );
    for (const p of mps.slice(0, 10)) {
      const ratioStr = p.ratio.toFixed(4);
      const deStr = (p.energyChangePct >= 0 ? '+' : '') + p.energyChangePct.toFixed(2) + '%';
      const color = Math.abs(p.energyChangePct) > 5 ? chalk.red : Math.abs(p.energyChangePct) > 2 ? chalk.yellow : chalk.gray;
      lines.push(
        '    ' +
          String(p.bin).padStart(5) +
          p.period.toFixed(1).padStart(10) +
          (p.consensusSnr.toFixed(2) + 'σ').padStart(8) +
          p.wtMagnitude.toExponential(2).padStart(14) +
          p.mtMagnitude.toExponential(2).padStart(14) +
          color(ratioStr.padStart(10)) +
          color(deStr.padStart(10))
      );
    }
    const wagg = (r as any).weightedAggregateDeltaEPct;
    const l1 = (r as any).fullSpectrumL1;
    const tde = (r as any).totalEnergyChangePct;
    if (wagg !== undefined) {
      lines.push('');
      lines.push(chalk.magenta('    Summary metrics:'));
      lines.push(`      weighted aggregate ΔE% (top-N peaks): ${(wagg >= 0 ? '+' : '') + wagg.toFixed(4)}%`);
      lines.push(`      full-spectrum L1 distance:            ${l1.toExponential(4)}`);
      lines.push(`      total energy change:                  ${(tde >= 0 ? '+' : '') + tde.toFixed(4)}%`);
    }
  }
  return lines.join('\n');
}

function renderTable(rows: ScoreRow[]): string {
  const lines: string[] = [];
  const sep = '─'.repeat(160);
  lines.push(chalk.cyan(sep));
  lines.push(
    chalk.bold(
      'variant'.padEnd(28) +
        'pos'.padEnd(6) +
        'ref→alt'.padEnd(10) +
        'ΔEIIP'.padEnd(10) +
        'N'.padEnd(4) +
        'domain'.padEnd(15) +
        'Σ|ΔF|(k≥1)'.padEnd(13) +
        'max|ΔF|(k≥1)'.padEnd(14) +
        'max-bin'.padEnd(10) +
        'Σ|ΔF|det'.padEnd(12) +
        'ΔE%'
    )
  );
  lines.push(chalk.cyan(sep));
  for (const r of rows) {
    lines.push(
      r.variant.padEnd(28) +
        String(r.pos).padEnd(6) +
        `${r.ref}→${r.alt}`.padEnd(10) +
        r.deltaEIIP.toFixed(4).padEnd(10) +
        String(r.windowSize).padEnd(4) +
        r.domainHint.padEnd(15) +
        r.sumAbsDeltaFNoDc.toFixed(4).padEnd(13) +
        r.maxAbsDeltaFNoDc.toFixed(4).padEnd(14) +
        String(r.maxBinNoDc).padEnd(10) +
        r.sumAbsDeltaFDetrended.toFixed(4).padEnd(12) +
        (r.energyChangeRatio * 100).toFixed(2) + '%'
    );
    lines.push(chalk.gray(`    WT: ${r.wtSeq}`));
    lines.push(chalk.gray(`    MT: ${r.mtSeq}`));
  }
  lines.push(chalk.cyan(sep));
  lines.push(chalk.gray('   Σ|ΔF|(k≥1)   = total spectral disruption with DC excluded'));
  lines.push(chalk.gray('   max|ΔF|(k≥1) = strongest non-DC bin (biophysical signature)'));
  lines.push(chalk.gray('   Σ|ΔF|det     = detrended spectrum (both signals zero-mean before DFT)'));
  lines.push(chalk.gray('   ΔE%          = (E_MT − E_WT) / E_WT × 100, total spectral energy change'));
  return lines.join('\n');
}

function renderTsv(rows: ScoreRow[]): string {
  const headers = ['variant', 'gene', 'pos', 'ref', 'alt', 'window', 'domain', 'refEIIP', 'altEIIP', 'deltaEIIP', 'sumAbsDeltaF', 'maxAbsDeltaF', 'maxBin', 'k0Delta', 'wtSeq', 'mtSeq', 'deltaVector'];
  const lines = [headers.join('\t')];
  for (const r of rows) {
    lines.push(
      [
        r.variant,
        r.gene ?? '',
        r.pos,
        r.ref,
        r.alt,
        r.windowSize,
        r.domainHint,
        r.refEIIP.toFixed(4),
        r.altEIIP.toFixed(4),
        r.deltaEIIP.toFixed(6),
        r.sumAbsDeltaF.toFixed(6),
        r.maxAbsDeltaF.toFixed(6),
        r.maxBin,
        r.k0Delta.toFixed(6),
        r.wtSeq,
        r.mtSeq,
        r.deltaVector.map(x => x.toFixed(6)).join(','),
      ].join('\t')
    );
  }
  return lines.join('\n');
}

export async function fourierScoreCommand(variantsArg: string, opts: FourierScoreOptions): Promise<void> {
  if (!variantsArg || variantsArg.trim() === '') {
    throw new Error('Provide at least one HGVS variant (e.g. ITGA2B:p.Val779Ala). Multiple comma-separated.');
  }
  const inputs = variantsArg.split(',').map(s => s.trim()).filter(Boolean);
  const parsed = inputs.map(s => parseHgvs(s, opts.uniprot));

  if (!opts.quiet) {
    console.error(chalk.cyan(`\n🌊 biofs fourier-score — ${parsed.length} variant(s)`));
    for (const p of parsed) {
      console.error(
        chalk.gray(`   ${p.original}  →  ${p.gene || '?'} (${p.uniprot || '?'})  pos ${p.pos}  ${p.ref}→${p.alt}`)
      );
    }
    console.error('');
  }

  const rows = parsed.map(p => scoreOne(p, opts));

  const fmt = opts.format || 'table';
  let rendered: string;
  if (fmt === 'json') {
    rendered = JSON.stringify(rows, null, 2);
  } else if (fmt === 'tsv') {
    rendered = renderTsv(rows);
  } else {
    rendered = renderTable(rows);
  }

  // Append the Cosic-RRM f_c section if any rows have it
  const fcSection = renderFcSection(rows);

  if (opts.output) {
    fs.writeFileSync(opts.output, (rendered + '\n' + fcSection).replace(/\x1b\[[0-9;]*m/g, ''));
    if (!opts.quiet) {
      console.error(chalk.green(`✓ Wrote scores for ${rows.length} variant(s) to ${opts.output}`));
    }
  } else {
    console.log(rendered);
    if (fcSection) console.log(fcSection);
  }

  if (opts.plot) {
    plotSpectra(rows, opts.plot, opts.quiet || false);
  }
  if (opts.plotFull && rows.some(r => r.fullSpectrumWt)) {
    plotFullProteinSpectra(rows, opts.plotFull, opts.quiet || false);
  }
}

function plotFullProteinSpectra(rows: ScoreRow[], outPath: string, quiet: boolean): void {
  const py = `
import json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

d = json.loads(sys.stdin.read())
rows = [r for r in d["rows"] if r.get("fullSpectrumWt")]
n = len(rows)
fig, axes = plt.subplots(n, 1, figsize=(12, 3.8 * n), squeeze=False)

for i, r in enumerate(rows):
    ax = axes[i, 0]
    Xw = np.array(r["fullSpectrumWt"])
    Xm = np.array(r["fullSpectrumMt"])
    freqs = np.linspace(0, 0.5, len(Xw))
    ax.plot(freqs, Xw, color="#1f77b4", linewidth=0.9, label="|X_WT(k)|", alpha=0.9)
    ax.plot(freqs, Xm, color="#d62728", linewidth=0.9, label="|X_MT(k)|", alpha=0.9, linestyle="--")
    fc_freq = r["fcFreqNormalized"]
    ax.axvline(fc_freq, color="#2ca02c", linewidth=1.2, linestyle=":", label=f"f_c = {fc_freq:.4f} (period {r['fcPeriodAa']:.1f} aa)")
    # Zoom in to the low-frequency region where f_c lives
    ax.set_xlim(0, max(0.05, fc_freq * 8))
    ax.set_xlabel("normalized frequency (cycles/residue)")
    ax.set_ylabel("|X(k)| (unit-energy normalized)")
    ratio = r["fcRatio"]
    de = r["fcEnergyChangePct"]
    ax.set_title(
        f"{r['variant']}  ({r['ref']}{r['pos']}{r['alt']})    "
        f"|X_WT(f_c)|={r['fullXwtAtFc']:.3e}  |X_MT(f_c)|={r['fullXmtAtFc']:.3e}  "
        f"ratio MT/WT={ratio:.4f}  ΔE@f_c={de:+.2f}%"
    )
    ax.legend(loc="upper right", fontsize=9)
    ax.grid(True, alpha=0.3)

fig.suptitle("Cosic-RRM full-protein DFT at family characteristic frequency  |  biofs fourier-score --consensus-fc", y=1.0, fontsize=11)
fig.tight_layout()
fig.savefig(d["out_path"], dpi=150, bbox_inches="tight")
print(f"OK: {d['out_path']}", file=sys.stderr)
`;
  const r = spawnSync('python3', ['-c', py], {
    encoding: 'utf8',
    input: JSON.stringify({ rows, out_path: outPath }),
    maxBuffer: 200 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`Full-protein plot failed: ${r.stderr || r.stdout}`);
  }
  if (!quiet) console.error(chalk.green(`✓ Full-protein f_c spectrum saved to ${outPath}`));
}

function plotSpectra(rows: ScoreRow[], outPath: string, quiet: boolean): void {
  const py = `
import json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

d = json.loads(sys.stdin.read())
rows = d["rows"]
out_path = d["out_path"]
n = len(rows)
fig, axes = plt.subplots(n, 1, figsize=(11, 3.5 * n), squeeze=False)

for i, r in enumerate(rows):
    ax = axes[i, 0]
    delta = np.array(r["deltaVector"])
    delta_dt = np.array(r["deltaVectorDetrended"])
    bins = np.arange(len(delta))
    ax.bar(bins - 0.18, delta, width=0.36, color="#1f77b4", label="|ΔF|")
    ax.bar(bins + 0.18, delta_dt, width=0.36, color="#d62728", alpha=0.85, label="|ΔF| (detrended)")
    ax.set_xlabel("frequency bin k")
    ax.set_ylabel("|ΔF|")
    ax.set_title(
        f'{r["variant"]}  ({r["ref"]}{r["pos"]}{r["alt"]}, N={r["windowSize"]}, {r["domainHint"]})  '
        f'Σ|ΔF|(k≥1)={r["sumAbsDeltaFNoDc"]:.3f}  ΔE={r["energyChangeRatio"]*100:.1f}%'
    )
    ax.legend(loc="upper right")
    ax.set_xticks(bins)
    ax.grid(True, axis="y", alpha=0.3)
    # Mark the maximum non-DC bin
    if r["maxBinNoDc"] > 0:
        ax.annotate(
            f'max k={r["maxBinNoDc"]}',
            xy=(r["maxBinNoDc"], r["maxAbsDeltaFNoDc"]),
            xytext=(r["maxBinNoDc"] + 1.5, r["maxAbsDeltaFNoDc"] * 1.1),
            fontsize=9,
            arrowprops=dict(arrowstyle="->", color="black", lw=0.7),
        )

fig.suptitle("Cosic-RRM ΔF spectra (EIIP+DFT)  |  biofs fourier-score", y=1.0, fontsize=12)
fig.tight_layout()
fig.savefig(out_path, dpi=150, bbox_inches="tight")
print(f"OK: {out_path}", file=sys.stderr)
`;
  const result = spawnSync('python3', ['-c', py], {
    encoding: 'utf8',
    input: JSON.stringify({ rows, out_path: outPath }),
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Plot rendering failed: ${result.stderr || result.stdout}\n(install: python3 -m pip install matplotlib)`);
  }
  if (!quiet) {
    console.error(chalk.green(`✓ ΔF spectrum saved to ${outPath}`));
  }
}
