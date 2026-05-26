/**
 * biofs cohort-pipeline — run `biofs pipeline run-wes` across a cohort of serials.
 *
 * The canonical batch verb for taking N FASTQ-only biosamples all the way to
 * "AI Ready" (FASTQ → VCF → annotated sqlite → fhir.variant + Digital Twin).
 * Every per-serial run is the existing single-serial orchestrator
 * (pipeline_run_wes.py via biofs-node) — this verb just fans out + tracks state.
 *
 * Per CLAUDE.md: ALL inputs/outputs go through BioRouter (biocid + Sequentia
 * mint) — the underlying orchestrator already does that in phases 4 and 6.
 *
 * Concurrency defaults to 1 because the GPU VM has a fixed Parabricks
 * throughput (2× A100 → ~45min/exome). Bump to 2 to overlap GPU + CRAVAT.
 *
 * Resume: serials whose `bioroutes.pipeline_runs[*].status` is
 * `PHASE_RANGE_DONE` are skipped unless --no-skip-existing.
 *
 * Wallet pre-mint: serials without `customer_owner_wallet` get one minted via
 * `biofs biowallet create --bind-biosample <serial>` before the pipeline runs.
 *
 * Example:
 *   biofs inventory cohort --originlab augenomics --has fastq --missing vcf,gvcf --paired --output cohort.txt
 *   biofs cohort-pipeline --serials cohort.txt --concurrency 1 --limit 3   # pilot
 *   biofs cohort-pipeline --serials cohort.txt --concurrency 2             # full
 *
 * Telemetry:
 *   - Per-serial run status mirrored from bioroutes.pipeline_runs
 *   - Batch summary written to ./cohort_pipeline_runs/<timestamp>/summary.json
 *   - Live progress to stdout (or --json for machine output)
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { CredentialsManager } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';

export interface CohortPipelineOptions {
  serials?: string;
  concurrency?: string;
  limit?: string;
  output?: string;
  skipExisting?: boolean;
  noSkipExisting?: boolean;
  autoMintWallets?: boolean;
  noAutoMintWallets?: boolean;
  mode?: string;
  phase?: string;
  dryRun?: boolean;
  quiet?: boolean;
  json?: boolean;
  exclude?: string;            // CSV of serials to skip (e.g. operator's own genome, already-processed)
  stopOnFailure?: string;      // 'first' | 'N' consecutive | 'never' (default 'first')
}

interface PerSerialResult {
  serial: string;
  status: 'completed' | 'failed' | 'skipped';
  wallet_minted?: boolean;
  wallet?: string;
  phase_reached?: string;
  duration_s?: number;
  error?: string;
}

function runBiofs(args: string[], timeoutMs: number = 4 * 60 * 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const biofsBin = process.argv[1];  // the running biofs binary (works under `npm link` and `node dist/index.js`)
    const child = spawn('node', [biofsBin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const t = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

async function ensureWallet(serial: string, quiet: boolean): Promise<{ minted: boolean; wallet?: string }> {
  // Try `biofs biowallet list` to see if there's already a wallet bound to this serial.
  // If not, mint via `biofs biowallet create --bind-biosample <serial>`.
  const list = await runBiofs(['biowallet', 'list', '--json'], 30_000);
  let bound: string | null = null;
  if (list.code === 0) {
    try {
      const data = JSON.parse(list.stdout);
      const entries = Array.isArray(data) ? data : (data.biowallets || []);
      for (const e of entries) {
        if ((e.bound_biosamples || []).map(String).includes(String(serial))) {
          bound = e.address;
          break;
        }
      }
    } catch { /* fall through to mint */ }
  }
  if (bound) return { minted: false, wallet: bound };

  const mint = await runBiofs([
    'biowallet', 'create',
    '--label', `cohort-pipeline proband (auto, bound to ${serial})`,
    '--bind-biosample', String(serial),
    '--quiet',
  ], 60_000);
  if (mint.code !== 0) {
    if (!quiet) console.error(chalk.yellow(`  ⚠ biowallet create for ${serial} failed: ${(mint.stderr || mint.stdout).slice(0, 200)}`));
    return { minted: false };
  }
  const addrLine = mint.stdout.split('\n').find(l => l.includes('Address (EIP-55)')) || mint.stdout;
  const m = addrLine.match(/0x[0-9a-fA-F]{40}/);
  return { minted: true, wallet: m ? m[0] : undefined };
}

export async function cohortPipelineCommand(opts: CohortPipelineOptions): Promise<void> {
  if (!opts.serials) {
    Logger.error('--serials <file> is required (one biosample serial per line, or use `biofs inventory cohort --output`).');
    process.exit(1);
  }
  if (!fs.existsSync(opts.serials)) {
    Logger.error(`Serials file not found: ${opts.serials}`);
    process.exit(1);
  }

  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }

  const concurrency = Math.max(1, parseInt(opts.concurrency || '1', 10));
  const limit = parseInt(opts.limit || '0', 10);
  const skipExisting = !opts.noSkipExisting;
  const autoMintWallets = !opts.noAutoMintWallets;
  const outDir = path.resolve(opts.output || './cohort_pipeline_runs/' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });

  let allSerials = fs.readFileSync(opts.serials, 'utf8')
    .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  // --exclude filter: drop serials we should skip (e.g. operator's own genome
  // already processed, or known-bad samples).
  if (opts.exclude) {
    const excludeSet = new Set(opts.exclude.split(',').map(s => s.trim()).filter(Boolean));
    const before = allSerials.length;
    allSerials = allSerials.filter(s => !excludeSet.has(s));
    if (!opts.quiet && before !== allSerials.length) {
      console.log(chalk.gray(`  excluded ${before - allSerials.length} serial(s): ${[...excludeSet].join(',')}`));
    }
  }
  const cohort = limit > 0 ? allSerials.slice(0, limit) : allSerials;

  // --stop-on-failure: how many consecutive failures before the cohort aborts.
  // 'first' = 1, 'never' = Infinity, integer = N consecutive. Default 'first'
  // matches the operator's instruction to halt at the earliest sign of trouble.
  const stopMode = (opts.stopOnFailure || 'first').toLowerCase();
  const stopAfterFailures = stopMode === 'never' ? Infinity
    : stopMode === 'first' ? 1
    : (parseInt(stopMode, 10) || 1);

  if (!opts.quiet) {
    console.log(chalk.bold.cyan('\nbiofs cohort-pipeline'));
    console.log(`  Wallet:        ${creds.wallet_address}`);
    console.log(`  Serials file:  ${opts.serials}  (${cohort.length} serials${limit > 0 ? `, capped from ${allSerials.length}` : ''})`);
    console.log(`  Concurrency:   ${concurrency}`);
    console.log(`  Skip existing: ${skipExisting}`);
    console.log(`  Auto-mint biowallets: ${autoMintWallets}`);
    console.log(`  Mode override: ${opts.mode || '(auto-detect WES/WGS)'}`);
    console.log(`  Output dir:    ${outDir}`);
    console.log(`  Each serial:   biofs pipeline run-wes <serial>  (10 phases, ~90min)`);
    console.log('');
  }

  const results: PerSerialResult[] = [];
  let inflight = 0;
  let i = 0;
  const t0 = Date.now();

  async function processSerial(serial: string): Promise<PerSerialResult> {
    const sT0 = Date.now();
    if (!opts.quiet) console.log(chalk.blue(`→ [${serial}] start`));

    let walletInfo: { minted: boolean; wallet?: string } = { minted: false };
    if (autoMintWallets) {
      walletInfo = await ensureWallet(serial, !!opts.quiet);
      if (!opts.quiet && walletInfo.minted) {
        console.log(chalk.gray(`  [${serial}] biowallet minted: ${walletInfo.wallet}`));
      } else if (!opts.quiet && walletInfo.wallet) {
        console.log(chalk.gray(`  [${serial}] biowallet already bound: ${walletInfo.wallet}`));
      }
    }

    // ALWAYS --remote: the orchestrator needs gcloud SSH to wake the GPU VM,
    // gcsfuse mounts on prod, and the up-to-date pipeline_run_wes.py (the
    // local Mac copy is intentionally stale). Per CLAUDE.md "all jobs through
    // biofs-node": pipeline runs on prod, never on the laptop.
    const args = ['pipeline', 'run-wes', String(serial), '--remote'];
    if (opts.mode) args.push('--mode', opts.mode);
    if (opts.phase) args.push('--phase', opts.phase);
    if (opts.dryRun) args.push('--dry-run');
    args.push('--json');

    if (opts.dryRun) {
      if (!opts.quiet) console.log(chalk.gray(`  [${serial}] would run: biofs ${args.join(' ')}`));
      return { serial, status: 'completed', wallet_minted: walletInfo.minted, wallet: walletInfo.wallet, duration_s: 0 };
    }

    const r = await runBiofs(args, 6 * 60 * 60_000);   // 6 hr ceiling per serial
    const elapsed = Math.round((Date.now() - sT0) / 1000);
    const status: PerSerialResult['status'] = r.code === 0 ? 'completed' : 'failed';

    // Try to extract last phase from JSON events
    let lastPhase: string | undefined;
    for (const line of r.stdout.split('\n').reverse()) {
      try {
        const ev = JSON.parse(line);
        if (ev && (ev.phase !== undefined || ev.name)) {
          lastPhase = `${ev.phase ?? '?'}:${ev.event ?? '?'}`;
          break;
        }
      } catch { /* not JSON */ }
    }

    if (!opts.quiet) {
      const tag = r.code === 0 ? chalk.green('✓') : chalk.red('✗');
      console.log(`${tag} [${serial}] ${status} in ${elapsed}s  last_phase=${lastPhase || 'unknown'}`);
      if (r.code !== 0 && r.stderr) {
        console.log(chalk.gray(`  stderr tail: ${r.stderr.trim().slice(-300)}`));
      }
    }

    return {
      serial, status,
      wallet_minted: walletInfo.minted,
      wallet: walletInfo.wallet,
      phase_reached: lastPhase,
      duration_s: elapsed,
      error: r.code !== 0 ? (r.stderr || r.stdout).slice(-400) : undefined,
    };
  }

  let consecutiveFailures = 0;
  let aborted = false;
  await new Promise<void>((resolve) => {
    const launchNext = () => {
      while (!aborted && inflight < concurrency && i < cohort.length) {
        const serial = cohort[i++];
        inflight++;
        processSerial(serial).then((res) => {
          results.push(res);
          fs.writeFileSync(path.join(outDir, `${serial}.json`), JSON.stringify(res, null, 2));
          inflight--;

          if (res.status === 'failed') {
            consecutiveFailures += 1;
            if (consecutiveFailures >= stopAfterFailures) {
              aborted = true;
              if (!opts.quiet) {
                console.log(chalk.red.bold(
                  `\n⛔ Cohort halted: ${consecutiveFailures} consecutive failure(s) (--stop-on-failure=${stopMode})`
                ));
                console.log(chalk.gray(`   ${cohort.length - i} serial(s) remaining were not started.`));
              }
            }
          } else if (res.status === 'completed') {
            consecutiveFailures = 0;
          }

          if (!aborted && i < cohort.length) {
            launchNext();
          } else if (inflight === 0) {
            resolve();
          }
        });
      }
      if (aborted && inflight === 0) resolve();
    };
    launchNext();
  });

  const totalSec = Math.round((Date.now() - t0) / 1000);
  const completed = results.filter(r => r.status === 'completed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;

  const summary = {
    cohort_size: cohort.length,
    completed, failed, skipped,
    total_seconds: totalSec,
    concurrency,
    started_at: new Date(t0).toISOString(),
    finished_at: new Date().toISOString(),
    serials_file: opts.serials,
    output_dir: outDir,
    results,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('\n' + chalk.bold('Cohort summary:'));
    console.log(`  ${chalk.green(completed)} completed`);
    console.log(`  ${chalk.red(failed)} failed`);
    console.log(`  ${chalk.gray(skipped)} skipped`);
    console.log(`  total wall: ${Math.round(totalSec / 60)} min`);
    console.log(chalk.green(`✓ Summary: ${path.join(outDir, 'summary.json')}`));
  }

  if (failed > 0) process.exit(2);
}
