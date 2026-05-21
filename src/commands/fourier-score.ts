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
const GENE_TO_UNIPROT: Record<string, string> = {
  ITGA2B: 'P08514',
  ITGB3: 'P05106',
  // Extend as needed; users can pass --uniprot to override
};

// UniProt-feature TM regions for known genes (inclusive 1-based residue ranges).
// Variants inside these ranges get the wider N=51 window by default.
const TM_REGIONS: Record<string, [number, number]> = {
  ITGA2B: [988, 1009],
  ITGB3: [716, 738],
};

export interface FourierScoreOptions {
  window?: string;        // override N for non-TM windows (default 31)
  windowTm?: string;      // override N for TM windows (default 51)
  uniprot?: string;       // override UniProt accession (single-variant mode)
  format?: string;        // table | tsv | json
  output?: string;
  plot?: string;          // path to write |ΔF| spectrum PNG (one panel per variant)
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

  return {
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

  if (opts.output) {
    fs.writeFileSync(opts.output, rendered.replace(/\x1b\[[0-9;]*m/g, ''));
    if (!opts.quiet) {
      console.error(chalk.green(`✓ Wrote scores for ${rows.length} variant(s) to ${opts.output}`));
    }
  } else {
    console.log(rendered);
  }

  if (opts.plot) {
    plotSpectra(rows, opts.plot, opts.quiet || false);
  }
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
