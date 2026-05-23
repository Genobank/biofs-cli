/**
 * biofs cohort-train <gene_list>
 *
 * Run the full rrm-consensus → rrm-distribution → rrm-train pipeline across a
 * cohort of disease genes, producing a single benchmark table that quantifies
 * the incremental AUC value of Cosic-RRM features above the deep-learning-only
 * baseline for each gene. This is the Nature-grade scaling step that allows
 * the framework's applicability domain to be characterized quantitatively
 * rather than anecdotally.
 *
 * Inputs:
 *   - A comma-separated gene list (or @filename for one-per-line)
 *   - Optional --ortholog-source default 'orthologs' (TrEMBL mammalian)
 *   - Optional --min-train-set N to skip genes with fewer than N labeled variants
 *
 * For each gene:
 *   1. Compute or load the consensus characteristic frequency (rrm-consensus)
 *   2. Compute or load the ClinVar empirical distribution (rrm-distribution)
 *   3. Train the deep-learning-only and full-ensemble models (rrm-train)
 *   4. Record per-gene metrics: n_train, n_pos, n_neg, AM_AUC, DL_AUC, full_AUC, AUC_delta, fc_period, fc_snr
 *
 * Output:
 *   - JSON manifest at ~/.biofs/cache/rrm/cohort_<hash>.json
 *   - 3-panel PNG plot: per-gene AUC delta bar chart, fc_period distribution, AM AUC vs Cosic-augmented AUC scatter
 *
 * This verb does NOT implement parallel execution; it serializes the per-gene
 * pipeline calls to respect MyVariant.info and ClinVar E-utils rate limits.
 * For a 30-gene cohort, expected runtime is approximately 15 to 30 minutes
 * dominated by external API throughput.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import chalk from 'chalk';
import ora from 'ora';

const RRM_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'rrm');

export interface CohortTrainOptions {
  genes?: string;
  geneFile?: string;
  minTrain?: string;
  orthologSource?: string;
  refreshConsensus?: boolean;
  refreshDistribution?: boolean;
  output?: string;       // JSON output path
  plot?: string;         // PNG output path
  quiet?: boolean;
  // Pass-through to rrm-distribution for rare-disease genes whose ClinVar B+LB is empty
  gnomadBenigns?: string;
  gnomadMinAf?: string;
}

interface PerGeneResult {
  gene: string;
  status: 'ok' | 'skipped_low_n' | 'consensus_failed' | 'distribution_failed' | 'train_failed';
  status_detail?: string;
  n_train?: number;
  n_pos?: number;
  n_neg?: number;
  fc_period_aa?: number;
  fc_snr?: number;
  AM_alone_AUC?: number;
  Cosic_alone_AUC?: number;
  DL_only_AUC?: number;
  Full_ensemble_AUC?: number;
  AUC_delta_full_minus_DL?: number;
  raw_AM_AUC?: number;
}

function runBiofs(args: string[], opts: { quiet?: boolean; timeoutMs?: number } = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('biofs', args, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024, timeout: opts.timeoutMs || 900_000 });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function processOneGene(gene: string, opts: CohortTrainOptions): Promise<PerGeneResult> {
  const upper = gene.toUpperCase();
  const minN = parseInt(opts.minTrain || '8', 10);
  const source = opts.orthologSource || 'orthologs';

  // 1. Consensus
  const consensusPath = path.join(RRM_CACHE_DIR, `${upper}.json`);
  if (!fs.existsSync(consensusPath) || opts.refreshConsensus) {
    const consensusArgs = ['rrm-consensus', upper, '--source', source, '--no-reviewed', '--max', '50', '--taxonomy', '40674', '--quiet'];
    if (opts.refreshConsensus) consensusArgs.push('--refresh');
    const c = runBiofs(consensusArgs);
    if (c.code !== 0 || !fs.existsSync(consensusPath)) {
      return { gene: upper, status: 'consensus_failed', status_detail: (c.stderr || c.stdout).slice(-200) };
    }
  }
  const cons = JSON.parse(fs.readFileSync(consensusPath, 'utf8'));
  const fc_period = cons.characteristic_frequency_period_aa;
  const fc_snr = cons.signal_to_noise_ratio;

  // 2. Distribution. Pass --gnomad-benigns through to rrm-distribution so
  // rare-disease genes (e.g. COL3A1, COL7A1, FBN1) with empty ClinVar
  // benign-class get synthesized pseudo-benigns for AUC benchmarking.
  const distPath = path.join(RRM_CACHE_DIR, `${upper}-distribution.json`);
  if (!fs.existsSync(distPath) || opts.refreshDistribution) {
    const distArgs = ['rrm-distribution', upper, '--quiet'];
    if (opts.refreshDistribution) distArgs.push('--refresh');
    if (opts.gnomadBenigns) {
      distArgs.push('--gnomad-benigns', String(opts.gnomadBenigns));
    }
    if (opts.gnomadMinAf) {
      distArgs.push('--gnomad-min-af', String(opts.gnomadMinAf));
    }
    const d = runBiofs(distArgs);
    if (d.code !== 0 || !fs.existsSync(distPath)) {
      return { gene: upper, status: 'distribution_failed', status_detail: (d.stderr || d.stdout).slice(-200), fc_period_aa: fc_period, fc_snr };
    }
  }
  const dist = JSON.parse(fs.readFileSync(distPath, 'utf8'));
  const byClass = dist.by_classification || {};
  const n_pos = (byClass.pathogenic || 0) + (byClass.likely_pathogenic || 0);
  const n_neg = (byClass.benign || 0) + (byClass.likely_benign || 0);
  if (n_pos < 3 || n_neg < 3 || (n_pos + n_neg) < minN) {
    return { gene: upper, status: 'skipped_low_n', status_detail: `n_pos=${n_pos} n_neg=${n_neg} (need each >=3, total >=${minN})`, fc_period_aa: fc_period, fc_snr };
  }

  // 3. Train (no --predict, just run benchmark). Output JSON is cached by rrm-train at <gene>-train.json
  const trainCachePath = path.join(RRM_CACHE_DIR, `${upper}-train.json`);
  const trainArgs = ['rrm-train', upper, '--quiet'];
  const t = runBiofs(trainArgs, { timeoutMs: 1200_000 });
  if (t.code !== 0) {
    return { gene: upper, status: 'train_failed', status_detail: (t.stderr || t.stdout).slice(-200), fc_period_aa: fc_period, fc_snr };
  }
  // Read the cached JSON written by rrm-train
  let train: any;
  if (fs.existsSync(trainCachePath)) {
    try {
      train = JSON.parse(fs.readFileSync(trainCachePath, 'utf8'));
    } catch (e) {
      return { gene: upper, status: 'train_failed', status_detail: `Failed to parse train cache: ${(e as Error).message}`, fc_period_aa: fc_period, fc_snr };
    }
  } else {
    return { gene: upper, status: 'train_failed', status_detail: `Train cache not written at ${trainCachePath}`, fc_period_aa: fc_period, fc_snr };
  }
  if (train.error) {
    return { gene: upper, status: 'train_failed', status_detail: train.error, fc_period_aa: fc_period, fc_snr };
  }

  const results = train.results || {};
  const am = results.AM_alone;
  const cos = results.Cosic_alone;
  const dl = results['DL_only (AM+REVEL+PAI+EVE+ESM+CADD+MetaRNN)'];
  const full = results['Full_ensemble (DL + Cosic)'];
  return {
    gene: upper,
    status: 'ok',
    n_train: train.n_train,
    n_pos: train.n_positive,
    n_neg: train.n_negative,
    fc_period_aa: fc_period,
    fc_snr,
    AM_alone_AUC: am?.auc_mean ?? undefined,
    Cosic_alone_AUC: cos?.auc_mean ?? undefined,
    DL_only_AUC: dl?.auc_mean ?? undefined,
    Full_ensemble_AUC: full?.auc_mean ?? undefined,
    AUC_delta_full_minus_DL: (full?.auc_mean ?? null) !== null && (dl?.auc_mean ?? null) !== null
      ? full.auc_mean - dl.auc_mean
      : undefined,
    raw_AM_AUC: train.raw_alphamissense_auc ?? undefined,
  };
}

function plotCohort(results: PerGeneResult[], outPath: string, quiet: boolean): void {
  const py = `
import json, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

d = json.loads(sys.stdin.read())
results = [r for r in d['results'] if r['status'] == 'ok' and r.get('AUC_delta_full_minus_DL') is not None]
if not results:
    print('NO_VALID_RESULTS', file=sys.stderr); sys.exit(0)
results.sort(key=lambda r: r['AUC_delta_full_minus_DL'], reverse=True)

fig, axes = plt.subplots(1, 3, figsize=(18, 5.5))

# Panel A: per-gene AUC delta (full ensemble minus DL-only) bar chart
genes = [r['gene'] for r in results]
deltas = [r['AUC_delta_full_minus_DL'] for r in results]
colors = ['#2ca02c' if dd > 0.02 else '#d62728' if dd < -0.02 else '#7f7f7f' for dd in deltas]
ax = axes[0]
ax.barh(range(len(genes)), deltas, color=colors)
ax.set_yticks(range(len(genes))); ax.set_yticklabels(genes, fontsize=8)
ax.invert_yaxis()
ax.axvline(0, color='black', linewidth=0.6, alpha=0.5)
ax.set_xlabel('AUC delta  (full ensemble - DL-only)')
ax.set_title('Cosic incremental value per gene')
ax.grid(True, axis='x', alpha=0.3)

# Panel B: characteristic-frequency period distribution colored by AUC delta sign
ax = axes[1]
periods = [r['fc_period_aa'] for r in results if r.get('fc_period_aa')]
deltas_p = [r['AUC_delta_full_minus_DL'] for r in results if r.get('fc_period_aa')]
scc = ax.scatter(periods, deltas_p, c=deltas_p, cmap='RdYlGn', vmin=-0.1, vmax=0.1, s=70, edgecolor='black', linewidth=0.6)
ax.set_xscale('log')
ax.set_xlabel('characteristic frequency period (aa, log)')
ax.set_ylabel('AUC delta')
ax.set_title('Cosic value vs f_c periodicity')
ax.axhline(0, color='black', linewidth=0.6, alpha=0.5)
ax.grid(True, alpha=0.3)
plt.colorbar(scc, ax=ax, label='AUC delta')

# Panel C: AM-only AUC vs Full-ensemble AUC scatter (deviation from y=x = Cosic added value)
ax = axes[2]
am = [r.get('raw_AM_AUC') for r in results if r.get('raw_AM_AUC') is not None and r.get('Full_ensemble_AUC') is not None]
fe = [r.get('Full_ensemble_AUC') for r in results if r.get('raw_AM_AUC') is not None and r.get('Full_ensemble_AUC') is not None]
ax.scatter(am, fe, s=70, edgecolor='black', linewidth=0.6, color='#1f77b4')
mn = min(min(am, default=0), min(fe, default=0)) - 0.02
mx = max(max(am, default=1), max(fe, default=1)) + 0.02
ax.plot([mn, mx], [mn, mx], 'k--', alpha=0.5, label='y = x (no Cosic gain)')
ax.set_xlim(mn, mx); ax.set_ylim(mn, mx)
ax.set_xlabel('raw AlphaMissense AUC')
ax.set_ylabel('Full ensemble CV AUC')
ax.set_title('Cosic-augmented vs AM baseline')
ax.legend(loc='lower right')
ax.grid(True, alpha=0.3)

fig.suptitle(f"biofs cohort-train  |  {len(results)} genes  |  Cosic incremental signal characterization", y=1.0, fontsize=12)
fig.tight_layout()
fig.savefig(d['out_path'], dpi=150, bbox_inches='tight')
print(f"OK: {d['out_path']}", file=sys.stderr)
`;
  const r = spawnSync('python3', ['-c', py], {
    encoding: 'utf8',
    input: JSON.stringify({ results, out_path: outPath }),
    maxBuffer: 200 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(chalk.yellow(`Plot warning: ${r.stderr}`));
  } else if (!quiet) {
    console.error(chalk.green(`✓ Cohort benchmark plot saved to ${outPath}`));
  }
}

export async function cohortTrainCommand(opts: CohortTrainOptions): Promise<void> {
  let geneList: string[] = [];
  if (opts.genes) {
    geneList = opts.genes.split(',').map(s => s.trim()).filter(Boolean);
  } else if (opts.geneFile) {
    geneList = fs.readFileSync(opts.geneFile, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  } else {
    throw new Error('Pass either --genes <comma-list> or --gene-file <path>');
  }

  if (geneList.length === 0) throw new Error('Empty gene list');

  console.error(chalk.cyan(`\n🧠 biofs cohort-train  |  ${geneList.length} genes`));
  console.error(chalk.gray(`   This will take approximately ${Math.ceil(geneList.length * 60)}s end-to-end (~1 min/gene). External API throughput dominates.\n`));

  fs.mkdirSync(RRM_CACHE_DIR, { recursive: true });
  const cohortId = crypto.createHash('sha1').update(geneList.join(',')).digest('hex').slice(0, 10);
  const manifestPath = opts.output || path.join(RRM_CACHE_DIR, `cohort_${cohortId}.json`);

  const results: PerGeneResult[] = [];
  for (let i = 0; i < geneList.length; i++) {
    const gene = geneList[i];
    const spinner = opts.quiet ? null : ora(`[${i + 1}/${geneList.length}] ${gene}...`).start();
    const r = await processOneGene(gene, opts);
    if (spinner) {
      const status = r.status;
      const tag = status === 'ok'
        ? `n=${r.n_train} (P+LP=${r.n_pos}, B+LB=${r.n_neg}), ΔAUC=${(r.AUC_delta_full_minus_DL ?? 0).toFixed(3)}, raw AM AUC=${(r.raw_AM_AUC ?? 0).toFixed(3)}`
        : `${status}: ${r.status_detail || ''}`;
      if (status === 'ok') spinner.succeed(`${gene}  ${tag}`);
      else spinner.warn(`${gene}  ${tag}`);
    }
    results.push(r);
  }

  fs.writeFileSync(manifestPath, JSON.stringify({ generated_at: new Date().toISOString(), gene_list: geneList, results }, null, 2));
  console.error(chalk.green(`\n✓ Cohort manifest saved to ${manifestPath}`));

  // Summary table
  const ok = results.filter(r => r.status === 'ok');
  console.log('');
  console.log(chalk.cyan('═'.repeat(100)));
  console.log(chalk.bold('  COHORT BENCHMARK SUMMARY'));
  console.log(chalk.cyan('═'.repeat(100)));
  console.log(`  Processed:                 ${geneList.length}`);
  console.log(`  OK (trained successfully): ${ok.length}`);
  console.log(`  Skipped (low n):           ${results.filter(r => r.status === 'skipped_low_n').length}`);
  console.log(`  Consensus failed:          ${results.filter(r => r.status === 'consensus_failed').length}`);
  console.log(`  Distribution failed:       ${results.filter(r => r.status === 'distribution_failed').length}`);
  console.log(`  Train failed:              ${results.filter(r => r.status === 'train_failed').length}`);
  if (ok.length > 0) {
    const positive = ok.filter(r => (r.AUC_delta_full_minus_DL ?? 0) > 0.02);
    const negative = ok.filter(r => (r.AUC_delta_full_minus_DL ?? 0) < -0.02);
    console.log(chalk.cyan('─'.repeat(100)));
    console.log(`  Genes with Cosic adding >0.02 AUC:   ${positive.length}  ${positive.map(r => r.gene).join(', ')}`);
    console.log(`  Genes with Cosic hurting <-0.02 AUC: ${negative.length}  ${negative.map(r => r.gene).join(', ')}`);
    console.log(`  Mean AUC delta across ${ok.length} OK genes: ${(ok.reduce((a, r) => a + (r.AUC_delta_full_minus_DL ?? 0), 0) / ok.length).toFixed(4)}`);
  }
  console.log(chalk.cyan('═'.repeat(100)));

  if (opts.plot && ok.length > 0) {
    plotCohort(results, opts.plot, opts.quiet || false);
  }
}
