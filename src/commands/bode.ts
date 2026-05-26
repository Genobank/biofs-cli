/**
 * biofs bode <gene>           — single-gene Bode magnitude plot
 * biofs bode --panel <list>   — multi-gene panel grid for paper figures
 *
 * Renders log-log |H(jω)| plots overlaying the RRM (EIIP) and PSM (piezo
 * dipole) consensus spectra computed by `biofs rrm-consensus` and
 * `biofs psm-consensus`. The consensus spectrum IS the empirical sampling
 * of the protein-family transfer function |H(jω)| on the imaginary axis,
 * so the Bode magnitude plot is the canonical way to read the dominant
 * resonances (poles) and silent zones (zeros) of the protein as a control
 * system.
 *
 * Optional --rna-tpm flag pulls operator's Caris RNA TPM from the
 * /api_caris/rna_tpm endpoint and overlays each gene's expression level
 * as an annotation (the magnitude of the system's output at the current
 * operating point).
 *
 * Output: PNG (or PDF with --pdf) at <output-path>, default
 *   ~/.biofs/cache/bode/<gene>.png      (single)
 *   ~/.biofs/cache/bode/panel-<hash>.png (panel)
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import chalk from 'chalk';

const RRM_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'rrm');
const PSM_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'psm');
const BODE_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'bode');

export interface BodeOptions {
  panel?: string;
  output?: string;
  pdf?: boolean;
  rnaTpm?: string;          // case_id to pull RNA TPM for (e.g. TN25-336147)
  apiBase?: string;
  noRrm?: boolean;
  noPsm?: boolean;
  cols?: string;
  quiet?: boolean;
}

interface ConsensusSpectrum {
  gene: string;
  consensus_spectrum: number[];
  characteristic_frequency_normalized: number;
  characteristic_frequency_period_aa: number;
  signal_to_noise_ratio: number;
  consensus_peak_bins: { bin: number; freq_normalized: number; magnitude: number }[];
  n_sequences: number;
  encoding?: string;
}

function loadSpectrum(dir: string, gene: string): ConsensusSpectrum | null {
  const p = path.join(dir, `${gene.toUpperCase()}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

async function fetchRnaTpm(apiBase: string, caseId: string, genes: string[]): Promise<Record<string, number>> {
  // Pull from /api_caris/rna_tpm — endpoint expected to return {gene, tpm}[]
  // for the case_id. Falls back to empty dict on any failure.
  const url = `${apiBase}/api_caris/rna_tpm?case_id=${encodeURIComponent(caseId)}&genes=${encodeURIComponent(genes.join(','))}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return {};
    const body: any = await resp.json();
    const out: Record<string, number> = {};
    for (const row of body.rows || body.results || body || []) {
      if (row.gene && typeof row.tpm === 'number') out[row.gene.toUpperCase()] = row.tpm;
    }
    return out;
  } catch {
    return {};
  }
}

const PY_BODE = `
import json, sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

d = json.loads(sys.stdin.read())
panel = d['panel']
out = d['out']
fmt = d.get('fmt', 'png')
cols = d.get('cols', 3)
rna = d.get('rna_tpm', {})

n = len(panel)
rows = (n + cols - 1) // cols if n > 1 else 1
cols_eff = min(cols, n) if n > 1 else 1
fig, axes = plt.subplots(rows, cols_eff,
    figsize=(5.0 * cols_eff, 3.4 * rows),
    squeeze=False)
axes = axes.flatten()

for i, p in enumerate(panel):
    ax = axes[i]
    gene = p['gene']
    have_rrm = p.get('rrm') is not None
    have_psm = p.get('psm') is not None

    if have_rrm:
        S = np.array(p['rrm']['spectrum'])
        # Skip k=0 (DC bin, which is ~0 after detrending and noisy as a denominator)
        f = np.linspace(0, 0.5, len(S))
        eps = 1e-15
        mag_db = 20.0 * np.log10(np.maximum(S, eps))
        ax.plot(f[1:], mag_db[1:], color='#1f77b4', linewidth=1.1, label=f"RRM (EIIP) σ={p['rrm']['snr']:.1f}")
        # mark f_c
        fc = p['rrm']['fc']
        if fc > 0:
            k = int(fc * 2 * (len(S) - 1))
            if 0 < k < len(S):
                ax.scatter([fc], [mag_db[k]], color='#1f77b4', s=44, zorder=10, edgecolors='black', linewidths=0.7)

    if have_psm:
        S = np.array(p['psm']['spectrum'])
        f = np.linspace(0, 0.5, len(S))
        eps = 1e-15
        mag_db = 20.0 * np.log10(np.maximum(S, eps))
        ax.plot(f[1:], mag_db[1:], color='#9467bd', linewidth=1.1, linestyle='-', alpha=0.85, label=f"PSM (piezo) σ={p['psm']['snr']:.1f}")
        fc = p['psm']['fc']
        if fc > 0:
            k = int(fc * 2 * (len(S) - 1))
            if 0 < k < len(S):
                ax.scatter([fc], [mag_db[k]], color='#9467bd', s=44, zorder=10, edgecolors='black', linewidths=0.7, marker='D')

    title = gene
    if gene in rna:
        title += f"  ({rna[gene]:,.1f} TPM)"
    ax.set_title(title, fontsize=10)
    ax.set_xlabel('normalized ω (cycles/residue)', fontsize=8)
    ax.set_ylabel('|H(jω)| (dB)', fontsize=8)
    ax.set_xscale('log')
    ax.grid(True, which='both', alpha=0.3)
    ax.legend(loc='lower left', fontsize=7, framealpha=0.85)
    ax.tick_params(labelsize=7)

for j in range(n, len(axes)):
    axes[j].axis('off')

fig.suptitle('Protein-family transfer function |H(jω)|  (RRM=EIIP electron-ion, PSM=piezo dipole)', fontsize=11, y=1.00)
fig.tight_layout(rect=(0, 0, 1, 0.97))
fig.savefig(out, dpi=180 if fmt == 'png' else None, bbox_inches='tight', format=fmt)
print('OK ' + out, file=sys.stderr)
`;

export async function bodeCommand(geneArg: string | undefined, opts: BodeOptions): Promise<void> {
  let genes: string[];
  let isPanel = false;
  if (opts.panel) {
    genes = opts.panel.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    isPanel = true;
  } else if (geneArg) {
    genes = [geneArg.toUpperCase()];
  } else {
    throw new Error('Either <gene> or --panel <list> is required');
  }

  fs.mkdirSync(BODE_CACHE_DIR, { recursive: true });

  const panelData = genes.map(g => {
    const rrm = opts.noRrm ? null : loadSpectrum(RRM_CACHE_DIR, g);
    const psm = opts.noPsm ? null : loadSpectrum(PSM_CACHE_DIR, g);
    return {
      gene: g,
      rrm: rrm ? {
        spectrum: rrm.consensus_spectrum,
        fc: rrm.characteristic_frequency_normalized,
        snr: rrm.signal_to_noise_ratio,
      } : null,
      psm: psm ? {
        spectrum: psm.consensus_spectrum,
        fc: psm.characteristic_frequency_normalized,
        snr: psm.signal_to_noise_ratio,
      } : null,
    };
  });

  const missing = panelData.filter(p => !p.rrm && !p.psm).map(p => p.gene);
  if (missing.length) {
    if (!opts.quiet) console.error(chalk.yellow(`⚠ no consensus cached for: ${missing.join(', ')} — run biofs rrm-consensus / psm-consensus first`));
  }

  let rnaTpm: Record<string, number> = {};
  if (opts.rnaTpm) {
    const apiBase = opts.apiBase || process.env.GENOBANK_API || 'https://genobank.app';
    if (!opts.quiet) console.error(chalk.gray(`Fetching Caris RNA TPM for ${opts.rnaTpm} from ${apiBase}…`));
    rnaTpm = await fetchRnaTpm(apiBase, opts.rnaTpm, genes);
  }

  const fmt = opts.pdf ? 'pdf' : 'png';
  let outPath: string;
  if (opts.output) {
    outPath = opts.output;
  } else if (isPanel) {
    const hash = crypto.createHash('sha1').update(genes.join(',')).digest('hex').slice(0, 10);
    outPath = path.join(BODE_CACHE_DIR, `panel-${hash}.${fmt}`);
  } else {
    outPath = path.join(BODE_CACHE_DIR, `${genes[0]}.${fmt}`);
  }

  const cols = opts.cols ? parseInt(opts.cols, 10) : (isPanel ? 3 : 1);

  const r = spawnSync('python3', ['-c', PY_BODE], {
    encoding: 'utf8',
    input: JSON.stringify({
      panel: panelData,
      out: outPath,
      fmt,
      cols,
      rna_tpm: rnaTpm,
    }),
    maxBuffer: 200 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`Bode plot failed: ${r.stderr || r.stdout}`);
  }
  if (!opts.quiet) {
    console.error(chalk.green(`✓ Bode plot saved: ${outPath}`));
    for (const p of panelData) {
      const rs = p.rrm ? `σ=${p.rrm.snr.toFixed(1)}` : '—';
      const ps = p.psm ? `σ=${p.psm.snr.toFixed(1)}` : '—';
      const tpm = rnaTpm[p.gene] !== undefined ? `  TPM=${rnaTpm[p.gene].toFixed(1)}` : '';
      console.log(`  ${p.gene.padEnd(8)}  RRM:${rs.padEnd(8)}  PSM:${ps.padEnd(8)}${tpm}`);
    }
  } else {
    console.log(outPath);
  }
}
