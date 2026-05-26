/**
 * biofs psm-consensus <gene>
 *
 * Piezoelectric Signal Model — the same Cosic-RRM cross-spectrum pipeline,
 * but with the EIIP (Electron-Ion Interaction Potential) per-residue index
 * replaced by the PIEZO_INDEX: the side-chain electric dipole moment
 * (Debye), which is the static analog of the linear piezoelectric coefficient
 *
 *     d_ij = ∂P_i / ∂ε_j
 *
 * relating polarization change to mechanical strain. Whereas EIIP encodes a
 * residue's free-electron donation propensity, PIEZO_INDEX encodes its
 * mechanical-to-electrical coupling. The hypothesis is that for proteins that
 * function via conformational transduction (ion channels, transporters, force
 * sensors, mechanoreceptors), the piezoelectric spectrum may capture
 * resonances that EIIP misses.
 *
 * Reference tables:
 *   - Avbelj F (2000) J Mol Biol 300:1335-1359 — side-chain electric dipoles
 *   - Cieplak P et al. (2009) Phys Chem Chem Phys 11:5803-5824 — refined
 *     gas-phase + aqueous dipole moments per side chain.
 *
 * Output: cached JSON at ~/.biofs/cache/psm/<gene>.json with the f_c bin, the
 * normalized frequency, the period in residues, the SNR, and the full
 * consensus spectrum for downstream variant scoring by `biofs psm-train` and
 * `biofs cohort-psm-score`.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import ora from 'ora';

import { GENE_TO_PFAM, GENE_TO_UNIPROT } from '../lib/gene-map';

const PSM_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'psm');

export interface PsmConsensusOptions {
  source?: string;
  taxonomy?: string;
  reviewed?: boolean;
  max?: string;
  refresh?: boolean;
  plot?: string;
  quiet?: boolean;
  uniprot?: string;
  pfam?: string;
}

interface PeakInfo {
  bin: number;
  freq_normalized: number;
  magnitude: number;
}

export interface PsmConsensusResult {
  gene: string;
  uniprot: string;
  source: 'family' | 'orthologs';
  pfam?: string;
  taxonomy: string;
  signature_type: 'psm';
  encoding: 'side_chain_dipole_moment_debye';
  n_sequences: number;
  sequence_lengths: { min: number; max: number; mean: number };
  common_length: number;
  consensus_spectrum?: number[];
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

// PIEZO_INDEX — side-chain electric dipole moment in Debye units.
// Avbelj 2000 + Cieplak 2009 consensus values. Charged side chains (R,K,D,E)
// dominate the spectrum the way the electron-donor residues (D,F,M,T,N,...)
// dominate the EIIP table — the basis vectors are physically different, so
// the resulting f_c shifts diagnostically.
const PIEZO_INDEX_PY_LITERAL = `{
    'A': 0.40,  'R': 13.5,  'N': 3.50,  'D': 7.20,  'C': 1.40,
    'E': 7.00,  'Q': 3.60,  'G': 0.00,  'H': 2.30,  'I': 0.13,
    'L': 0.13,  'K': 8.30,  'M': 1.20,  'F': 0.13,  'P': 0.00,
    'S': 1.70,  'T': 1.70,  'W': 2.10,  'Y': 1.60,  'V': 0.13,
}`;

const PY_CONSENSUS = `
import sys, json, re
import numpy as np

PIEZO_INDEX = ${PIEZO_INDEX_PY_LITERAL}

fasta = sys.stdin.read()
entries = []
parts = re.split(r'^>([^\\n]+)\\n', fasta, flags=re.M)
parts = parts[1:]
for i in range(0, len(parts), 2):
    hdr = parts[i]
    seq = re.sub(r'\\s', '', parts[i+1] if i+1 < len(parts) else '').upper()
    acc_match = re.match(r'(sp|tr)\\|([A-Z0-9]+)\\|', hdr)
    acc = acc_match.group(2) if acc_match else hdr.split(' ')[0]
    if len(seq) >= 100:
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
    piezo = np.array([PIEZO_INDEX.get(aa, 0.0) for aa in s], dtype=float)
    piezo = piezo - piezo.mean()
    X = np.abs(np.fft.rfft(piezo))
    total = X.sum()
    if total > 0:
        X = X / total
    spectra.append(X)

S = np.stack(spectra)

# Cosic cross-product (same maths as EIIP, different physical meaning).
log_S = np.log(S + 1e-12)
consensus = np.exp(log_S.sum(axis=0))
csum = consensus.sum()
if csum > 0:
    consensus = consensus / csum

bg_mean = float(np.median(consensus))
bg_std = float(np.std(consensus))
threshold = bg_mean + 3 * bg_std

peaks = []
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

function plotConsensus(spectrum: number[], result: PsmConsensusResult, outPath: string, quiet: boolean): void {
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
ax.plot(freqs, S, color="#9467bd", linewidth=1.0)
ax.fill_between(freqs, 0, S, color="#9467bd", alpha=0.25)
ax.axvline(fc_freq, color="#d62728", linewidth=1.2, linestyle="--", label=f"f_c = {fc_freq:.4f} (period = {fc_period:.1f} aa)")
for p in d["top_peaks"][:5]:
    ax.scatter([p["freq_normalized"]], [p["magnitude"]], color="#d62728", zorder=10, s=40)
    ax.annotate(f"k={p['bin']}", (p["freq_normalized"], p["magnitude"]), xytext=(4, 4), textcoords="offset points", fontsize=8)
ax.set_xlabel("normalized frequency (cycles/residue)")
ax.set_ylabel("PSM consensus magnitude (piezo dipole cross-spectrum)")
ax.set_title(f"Piezoelectric Signal Model consensus  {gene}  ({source}, n={n_seq} sequences)")
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
  if (!quiet) console.error(chalk.green(`✓ PSM spectrum saved to ${outPath}`));
}

function printSummary(r: PsmConsensusResult): void {
  console.log(chalk.magenta(`\n⚡ Piezoelectric Signal Model Consensus  ${r.gene} (${r.uniprot})`));
  console.log(chalk.magenta('─'.repeat(72)));
  console.log(`  encoding:                    side-chain dipole moment (Debye)`);
  console.log(`  source:                      ${r.source}${r.pfam ? `, Pfam ${r.pfam}` : ''}`);
  console.log(`  taxonomy id:                 ${r.taxonomy}`);
  console.log(`  sequences:                   ${r.n_sequences}`);
  console.log(`  lengths:                     min ${r.sequence_lengths.min}, max ${r.sequence_lengths.max}, mean ${r.sequence_lengths.mean.toFixed(0)} aa`);
  console.log(`  common length:               ${r.common_length} aa`);
  console.log(chalk.magenta('─'.repeat(72)));
  console.log(chalk.bold(`  Characteristic frequency f_c (piezo):`));
  console.log(`    bin k                      ${r.characteristic_frequency_bin}`);
  console.log(`    normalized f               ${r.characteristic_frequency_normalized.toFixed(5)} cycles per residue`);
  console.log(`    period                     ${r.characteristic_frequency_period_aa.toFixed(2)} residues per cycle`);
  console.log(`    signal-to-noise            ${r.signal_to_noise_ratio.toFixed(2)} σ above background`);
  console.log(chalk.magenta('─'.repeat(72)));
  console.log('  Top peaks (cross-spectrum magnitude):');
  for (const p of r.consensus_peak_bins.slice(0, 5)) {
    console.log(`    bin ${String(p.bin).padStart(4)}    f=${p.freq_normalized.toFixed(5)}    period=${(1/p.freq_normalized).toFixed(2)} aa    magnitude=${p.magnitude.toExponential(3)}`);
  }
  console.log('');
}

export async function psmConsensusCommand(gene: string, opts: PsmConsensusOptions): Promise<void> {
  const upper = gene.toUpperCase();
  const uniprot = opts.uniprot || GENE_TO_UNIPROT[upper];
  if (!uniprot) {
    throw new Error(`No UniProt mapping for ${upper}. Pass --uniprot <ACC>. Built-in: ${Object.keys(GENE_TO_UNIPROT).join(', ')}`);
  }

  fs.mkdirSync(PSM_CACHE_DIR, { recursive: true });
  const cachePath = path.join(PSM_CACHE_DIR, `${upper}.json`);

  if (fs.existsSync(cachePath) && !opts.refresh) {
    if (!opts.quiet) console.error(chalk.gray(`✓ Cached at ${cachePath} (use --refresh to recompute)`));
    const cached: PsmConsensusResult = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
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
  const fastaResult = spawnSync('curl', ['-sS', '-A', 'biofs/3.6.0', '--max-time', '60', url], {
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
    throw new Error(`PSM spectrum computation failed: ${pyResult.stderr || pyResult.stdout}`);
  }

  const parsed = JSON.parse(pyResult.stdout);
  if (parsed.error) {
    throw new Error(`PSM computation: ${parsed.error}`);
  }

  const result: PsmConsensusResult = {
    gene: upper,
    uniprot,
    source,
    pfam,
    taxonomy,
    signature_type: 'psm',
    encoding: 'side_chain_dipole_moment_debye',
    ...parsed,
    generated_at: new Date().toISOString(),
  };

  fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
  if (!opts.quiet) console.error(chalk.green(`✓ Cached PSM consensus to ${cachePath}`));

  printSummary(result);

  if (opts.plot && parsed.consensus_spectrum) {
    plotConsensus(parsed.consensus_spectrum, result, opts.plot, opts.quiet || false);
  }
}
