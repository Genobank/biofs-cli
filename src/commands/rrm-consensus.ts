/**
 * biofs rrm-consensus <gene>
 *
 * Compute the Cosic Resonant Recognition Model characteristic frequency f_c
 * for a gene's functional family. This is the missing-piece-of-the-puzzle
 * upgrade over raw windowed |ΔF| scoring: f_c represents the spectral
 * frequency that is shared (cross-multiplicatively) across all members of a
 * protein's functional family. Pathogenic missense variants are hypothesized
 * to disrupt the EIIP signal at f_c specifically, whereas benign variants
 * leave f_c intact.
 *
 * Method (Cosic 1994, 2007):
 *   1. Pull functionally related sequences for the gene. Default source is
 *      the Pfam family (e.g. PF08441 Integrin_alpha for ITGA2B), reviewed
 *      vertebrate entries from UniProt. Override with --source orthologs to
 *      use direct same-name orthologs instead.
 *   2. EIIP-encode each (Rydberg potential per Cosic), pad/truncate to common
 *      length (median), detrend, take rfft.
 *   3. Normalize each |X_k| to unit total energy.
 *   4. Compute the cross-product spectrum (log-sum across sequences then
 *      exponentiate) so that only frequencies present in ALL sequences pop
 *      above background.
 *   5. Identify peaks above (median + 3σ); the dominant peak is f_c.
 *
 * Output: cached JSON at ~/.biofs/cache/rrm/<gene>.json with the f_c bin, the
 * normalized frequency, the period in residues, the SNR, and the full
 * consensus spectrum for downstream variant scoring by `biofs fourier-score
 * --consensus-fc`.
 *
 * Optional --plot writes a PNG of the consensus spectrum with f_c annotated.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import ora from 'ora';

const RRM_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'rrm');

import { GENE_TO_PFAM, GENE_TO_UNIPROT } from '../lib/gene-map';


export interface RrmConsensusOptions {
  source?: string;          // 'family' (Pfam) | 'orthologs' (gene name) — default family
  taxonomy?: string;        // NCBI taxonomy id (default 7742 = Vertebrata)
  reviewed?: boolean;       // restrict to Swiss-Prot (default true)
  max?: string;             // cap sequence count (default 100)
  refresh?: boolean;        // re-fetch and recompute
  plot?: string;            // PNG path for consensus spectrum
  quiet?: boolean;
  uniprot?: string;         // override UniProt accession for novel genes
  pfam?: string;            // override Pfam family for novel genes
}

interface PeakInfo {
  bin: number;
  freq_normalized: number;
  magnitude: number;
}

export interface RrmConsensusResult {
  gene: string;
  uniprot: string;
  source: 'family' | 'orthologs';
  pfam?: string;
  taxonomy: string;
  n_sequences: number;
  sequence_lengths: { min: number; max: number; mean: number };
  common_length: number;
  consensus_spectrum?: number[];   // only saved on disk, omitted from print
  consensus_peak_bins: PeakInfo[];
  characteristic_frequency_bin: number;
  characteristic_frequency_normalized: number;
  characteristic_frequency_period_aa: number;
  background_mean: number;
  background_std: number;
  signal_to_noise_ratio: number;
  generated_at: string;
  uniprot_ids: string[];
}

const PY_CONSENSUS = `
import sys, json, re
import numpy as np

EIIP = {
    'A': 0.0373, 'R': 0.0959, 'N': 0.0036, 'D': 0.1263, 'C': 0.0829,
    'E': 0.0058, 'Q': 0.0761, 'G': 0.0050, 'H': 0.0242, 'I': 0.0000,
    'L': 0.0000, 'K': 0.0371, 'M': 0.0823, 'F': 0.0946, 'P': 0.0198,
    'S': 0.0829, 'T': 0.0941, 'W': 0.0548, 'Y': 0.0516, 'V': 0.0057,
}

fasta = sys.stdin.read()
entries = []
parts = re.split(r'^>([^\\n]+)\\n', fasta, flags=re.M)
parts = parts[1:]  # drop pre-header
for i in range(0, len(parts), 2):
    hdr = parts[i]
    seq = re.sub(r'\\s', '', parts[i+1] if i+1 < len(parts) else '').upper()
    acc_match = re.match(r'(sp|tr)\\|([A-Z0-9]+)\\|', hdr)
    acc = acc_match.group(2) if acc_match else hdr.split(' ')[0]
    if len(seq) >= 100:  # reject very short fragments
        entries.append({'accession': acc, 'sequence': seq, 'length': len(seq)})

if len(entries) < 5:
    print(json.dumps({'error': f'too few sequences ({len(entries)}); need at least 5'}))
    sys.exit(2)

lengths = [e['length'] for e in entries]
common_length = int(np.median(lengths))

spectra = []
for e in entries:
    s = e['sequence'][:common_length]
    if len(s) < common_length:
        s = s + 'X' * (common_length - len(s))
    eiip = np.array([EIIP.get(aa, 0.0) for aa in s], dtype=float)
    eiip = eiip - eiip.mean()
    X = np.abs(np.fft.rfft(eiip))
    total = X.sum()
    if total > 0:
        X = X / total
    spectra.append(X)

S = np.stack(spectra)  # (M, N/2+1)

# Cosic cross-product spectrum (log-domain for numeric stability)
log_S = np.log(S + 1e-12)
consensus = np.exp(log_S.sum(axis=0))
csum = consensus.sum()
if csum > 0:
    consensus = consensus / csum

bg_mean = float(np.median(consensus))
bg_std = float(np.std(consensus))
threshold = bg_mean + 3 * bg_std

peaks = []
# skip k=0 (DC) and k=1 (often dominates due to length-scale)
for k in range(2, len(consensus) - 1):
    if consensus[k] > consensus[k-1] and consensus[k] > consensus[k+1] and consensus[k] > threshold:
        peaks.append({
            'bin': int(k),
            'freq_normalized': float(k / (2 * (len(consensus) - 1))),
            'magnitude': float(consensus[k]),
        })

peaks.sort(key=lambda p: p['magnitude'], reverse=True)
top_peaks = peaks[:8] if peaks else []

if not top_peaks:
    fc_bin = int(np.argmax(consensus[2:]) + 2)
    top_peaks = [{
        'bin': fc_bin,
        'freq_normalized': float(fc_bin / (2 * (len(consensus) - 1))),
        'magnitude': float(consensus[fc_bin]),
    }]

fc = top_peaks[0]
snr = float((fc['magnitude'] - bg_mean) / (bg_std + 1e-12))

result = {
    'n_sequences': len(entries),
    'sequence_lengths': {
        'min': int(min(lengths)),
        'max': int(max(lengths)),
        'mean': float(np.mean(lengths)),
    },
    'common_length': common_length,
    'consensus_spectrum': consensus.tolist(),
    'consensus_peak_bins': top_peaks,
    'characteristic_frequency_bin': fc['bin'],
    'characteristic_frequency_normalized': fc['freq_normalized'],
    'characteristic_frequency_period_aa': (1.0 / fc['freq_normalized']) if fc['freq_normalized'] > 0 else 0.0,
    'background_mean': bg_mean,
    'background_std': bg_std,
    'signal_to_noise_ratio': snr,
    'uniprot_ids': [e['accession'] for e in entries],
}
print(json.dumps(result))
`;

function plotConsensus(spectrum: number[], result: RrmConsensusResult, outPath: string, quiet: boolean): void {
  const py = `
import json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

d = json.loads(sys.stdin.read())
S = np.array(d["spectrum"])
fc_bin = d["fc_bin"]
fc_freq = d["fc_freq"]
fc_period = d["fc_period"]
n_seq = d["n_seq"]
gene = d["gene"]
source = d["source"]

freqs = np.linspace(0, 0.5, len(S))

fig, ax = plt.subplots(figsize=(11, 5))
ax.plot(freqs, S, color="#1f77b4", linewidth=1.0)
ax.fill_between(freqs, 0, S, color="#1f77b4", alpha=0.25)
ax.axvline(fc_freq, color="#d62728", linewidth=1.2, linestyle="--", label=f"f_c = {fc_freq:.4f} (period = {fc_period:.1f} aa)")
for p in d["top_peaks"][:5]:
    ax.scatter([p["freq_normalized"]], [p["magnitude"]], color="#d62728", zorder=10, s=40)
    ax.annotate(f"k={p['bin']}", (p["freq_normalized"], p["magnitude"]), xytext=(4, 4), textcoords="offset points", fontsize=8)
ax.set_xlabel("normalized frequency (cycles/residue)")
ax.set_ylabel("consensus magnitude (cross-spectrum)")
ax.set_title(f"Cosic-RRM consensus spectrum  {gene}  ({source}, n={n_seq} sequences)")
ax.set_xlim(0, 0.5)
ax.grid(True, alpha=0.3)
ax.legend(loc="upper right")
fig.tight_layout()
fig.savefig(d["out_path"], dpi=150, bbox_inches="tight")
print(f"OK: {d['out_path']}", file=sys.stderr)
`;
  const r = spawnSync('python3', ['-c', py], {
    encoding: 'utf8',
    input: JSON.stringify({
      spectrum,
      fc_bin: result.characteristic_frequency_bin,
      fc_freq: result.characteristic_frequency_normalized,
      fc_period: result.characteristic_frequency_period_aa,
      top_peaks: result.consensus_peak_bins,
      n_seq: result.n_sequences,
      gene: result.gene,
      source: result.source + (result.pfam ? ` ${result.pfam}` : ''),
      out_path: outPath,
    }),
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`Plot failed: ${r.stderr || r.stdout}`);
  }
  if (!quiet) console.error(chalk.green(`✓ Consensus spectrum saved to ${outPath}`));
}

function printSummary(r: RrmConsensusResult): void {
  console.log(chalk.cyan(`\n🌊 Cosic-RRM Consensus Spectrum  ${r.gene} (${r.uniprot})`));
  console.log(chalk.cyan('─'.repeat(72)));
  console.log(`  source:                      ${r.source}${r.pfam ? `, Pfam ${r.pfam}` : ''}`);
  console.log(`  taxonomy id:                 ${r.taxonomy}`);
  console.log(`  sequences:                   ${r.n_sequences}`);
  console.log(`  lengths:                     min ${r.sequence_lengths.min}, max ${r.sequence_lengths.max}, mean ${r.sequence_lengths.mean.toFixed(0)} aa`);
  console.log(`  common length:               ${r.common_length} aa`);
  console.log(chalk.cyan('─'.repeat(72)));
  console.log(chalk.bold(`  Characteristic frequency f_c:`));
  console.log(`    bin k                      ${r.characteristic_frequency_bin}`);
  console.log(`    normalized f               ${r.characteristic_frequency_normalized.toFixed(5)} cycles per residue`);
  console.log(`    period                     ${r.characteristic_frequency_period_aa.toFixed(2)} residues per cycle`);
  console.log(`    signal-to-noise            ${r.signal_to_noise_ratio.toFixed(2)} σ above background`);
  console.log(chalk.cyan('─'.repeat(72)));
  console.log('  Top peaks (cross-spectrum magnitude):');
  for (const p of r.consensus_peak_bins.slice(0, 5)) {
    console.log(`    bin ${String(p.bin).padStart(4)}    f=${p.freq_normalized.toFixed(5)}    period=${(1/p.freq_normalized).toFixed(2)} aa    magnitude=${p.magnitude.toExponential(3)}`);
  }
  console.log('');
}

export async function rrmConsensusCommand(gene: string, opts: RrmConsensusOptions): Promise<void> {
  const upper = gene.toUpperCase();
  const uniprot = opts.uniprot || GENE_TO_UNIPROT[upper];
  if (!uniprot) {
    throw new Error(`No UniProt mapping for ${upper}. Pass --uniprot <ACC>. Built-in: ${Object.keys(GENE_TO_UNIPROT).join(', ')}`);
  }

  fs.mkdirSync(RRM_CACHE_DIR, { recursive: true });
  const cachePath = path.join(RRM_CACHE_DIR, `${upper}.json`);

  if (fs.existsSync(cachePath) && !opts.refresh) {
    if (!opts.quiet) console.error(chalk.gray(`✓ Cached at ${cachePath} (use --refresh to recompute)`));
    const cached: RrmConsensusResult = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    printSummary(cached);
    if (opts.plot && cached.consensus_spectrum) {
      plotConsensus(cached.consensus_spectrum, cached, opts.plot, opts.quiet || false);
    }
    return;
  }

  const source = (opts.source as 'family' | 'orthologs') || 'family';
  const taxonomy = opts.taxonomy || '7742';
  const reviewed = opts.reviewed !== false;
  const maxN = parseInt(opts.max || '100', 10);
  const pfam = opts.pfam || GENE_TO_PFAM[upper];

  let query: string;
  if (source === 'family') {
    if (!pfam) throw new Error(`No Pfam mapping for ${upper}. Pass --pfam <PFXXXXX>.`);
    query = `xref:pfam-${pfam}+AND+taxonomy_id:${taxonomy}`;
  } else {
    query = `gene_exact:${upper}+AND+taxonomy_id:${taxonomy}`;
  }
  if (reviewed) query += '+AND+reviewed:true';

  const url = `https://rest.uniprot.org/uniprotkb/search?query=${query}&format=fasta&size=${maxN}`;
  const spinner = opts.quiet ? null : ora(`Fetching ${source} sequences from UniProt (taxonomy ${taxonomy})...`).start();
  const fastaResult = spawnSync('curl', ['-sS', '-A', 'biofs/3.2.0', '--max-time', '60', url], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (fastaResult.status !== 0 || !fastaResult.stdout.startsWith('>')) {
    if (spinner) spinner.fail('UniProt fetch failed');
    throw new Error(`UniProt fetch failed (HTTP/curl): ${fastaResult.stderr || 'no FASTA returned'}`);
  }
  const seqCount = (fastaResult.stdout.match(/^>/gm) || []).length;
  if (spinner) spinner.succeed(`Fetched ${seqCount} sequences`);

  const pyResult = spawnSync('python3', ['-c', PY_CONSENSUS], {
    encoding: 'utf8',
    input: fastaResult.stdout,
    maxBuffer: 100 * 1024 * 1024,
  });
  if (pyResult.status !== 0) {
    throw new Error(`Consensus spectrum computation failed: ${pyResult.stderr || pyResult.stdout}`);
  }

  const parsed = JSON.parse(pyResult.stdout);
  if (parsed.error) {
    throw new Error(`Consensus computation: ${parsed.error}`);
  }

  const result: RrmConsensusResult = {
    gene: upper,
    uniprot,
    source,
    pfam,
    taxonomy,
    ...parsed,
    generated_at: new Date().toISOString(),
  };

  fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
  if (!opts.quiet) console.error(chalk.green(`✓ Cached consensus to ${cachePath}`));

  printSummary(result);

  if (opts.plot && parsed.consensus_spectrum) {
    plotConsensus(parsed.consensus_spectrum, result, opts.plot, opts.quiet || false);
  }
}
