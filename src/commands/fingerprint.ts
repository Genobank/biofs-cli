/**
 * biofs fingerprint — submit async fingerprint jobs to the background worker.
 *
 * VCF / gVCF → 50-position-selected-SNP SHA-256 (paper-aligned canonical fingerprint)
 * BAM / FASTQ / other → file-SHA-256 streamed via gcsfuse
 *
 * The endpoint enqueues a job into bioroutes.fingerprint_jobs. A background
 * worker (fingerprint_runner.py) processes rows via gcsfuse — no Cloudflare
 * timeout. This command submits the job and polls until complete.
 *
 * By default operates only on canonical rows (skip SUPERSEDED).
 *
 * Examples:
 *   biofs fingerprint --serial FR724733315947-241101-A01_1
 *   biofs fingerprint --serials FR724...,FR736... --filetypes vcf,gvcf
 *   biofs fingerprint --biocid biocid://...
 *   biofs fingerprint ... --limit 100
 *   biofs fingerprint ... --dry-run
 */

import chalk from 'chalk';
import axios from 'axios';
import { CredentialsManager } from '../lib/auth/credentials';
import { CONFIG } from '../lib/config/constants';
import { Logger } from '../lib/utils/logger';

export interface FingerprintOptions {
  biocid?: string;
  serial?: string;
  serials?: string;
  filetypes?: string;
  bucket?: string;
  prefix?: string;
  includeSuperseded?: boolean;
  limit?: string;
  dryRun?: boolean;
  json?: boolean;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fingerprintCommand(options: FingerprintOptions): Promise<void> {
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }

  const body: Record<string, unknown> = {
    wallet: creds.wallet_address,
    signature: creds.user_signature,
    dry_run: !!options.dryRun,
    include_superseded: !!options.includeSuperseded,
  };

  if (options.biocid) body.biocids = [options.biocid];
  const serialList: string[] = [];
  if (options.serial) serialList.push(options.serial);
  if (options.serials) {
    options.serials.split(',').forEach((s) => {
      const trimmed = s.trim();
      if (trimmed) serialList.push(trimmed);
    });
  }
  if (serialList.length > 0) body.sample_serials = serialList;

  if (options.filetypes) {
    body.filetypes = options.filetypes.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (options.bucket) body.bucket = options.bucket;
  if (options.prefix) body.prefix = options.prefix;
  body.limit = parseInt(options.limit || '50', 10);

  const targetLimit = parseInt(options.limit || '50', 10);

  if (!options.json) {
    console.log('');
    console.log(chalk.bold('BioRoutes Fingerprint'));
    console.log(chalk.gray('─'.repeat(60)));
    if (options.biocid) console.log(`  Target:     biocid=${options.biocid}`);
    else if (serialList.length) console.log(`  Target:     ${serialList.length} sample(s)`);
    if (options.filetypes) console.log(`  Filetypes:  ${options.filetypes}`);
    console.log(`  Cap:        ${targetLimit} rows`);
    console.log(`  Mode:       ${options.dryRun ? chalk.yellow('DRY-RUN') : chalk.green('ASYNC (background worker)')}`);
    console.log('');
  }

  // Step 1: Submit the job
  const submitUrl = `${CONFIG.API_BASE_URL}/api_bioroutes/fingerprint`;

  try {
    const submitResp = await axios.post(submitUrl, body, {
      timeout: 30_000,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: (s: number) => s < 500,
    });

    if (submitResp.status === 403) {
      Logger.error(`Fingerprint denied: ${submitResp.data?.error || 'unauthorized'}`);
      process.exit(1);
    }
    if (submitResp.status >= 400) {
      Logger.error(`Fingerprint failed (HTTP ${submitResp.status}): ${submitResp.data?.error || 'unknown'}`);
      process.exit(1);
    }

    const d = submitResp.data;

    // Dry-run: show eligible count and exit
    if (options.dryRun) {
      if (options.json) {
        console.log(JSON.stringify(d, null, 2));
      } else {
        console.log(chalk.yellow('  [DRY-RUN] No job submitted.'));
        console.log(`  Eligible rows: ${chalk.green(fmt(d.eligible_rows))}`);
        console.log(`  Limit:         ${d.limit}`);
        console.log('');
      }
      return;
    }

    const jobId = d.job_id;
    if (!jobId) {
      Logger.error('No job_id returned from server');
      process.exit(1);
    }

    if (!options.json) {
      console.log(chalk.cyan(`  Job submitted: ${jobId}`));
      console.log(`  Eligible rows: ${fmt(d.eligible_rows)}`);
      console.log('');
      console.log(chalk.gray('  Polling for results (background worker processes via gcsfuse)...'));
      console.log('');
    }

    // Step 2: Poll for completion
    const statusUrl = `${CONFIG.API_BASE_URL}/api_bioroutes/fingerprint/status`;
    let lastPrinted = 0;
    const startTime = Date.now();
    const maxWaitMs = 30 * 60 * 1000; // 30 min max wait

    while (Date.now() - startTime < maxWaitMs) {
      await sleep(5000);

      try {
        const pollResp = await axios.get(statusUrl, {
          params: { job_id: jobId },
          timeout: 15_000,
          validateStatus: (s: number) => s < 500,
        });

        if (pollResp.status >= 400) {
          Logger.error(`Poll failed (HTTP ${pollResp.status}): ${pollResp.data?.error || 'unknown'}`);
          process.exit(1);
        }

        const job = pollResp.data;

        // Print progress
        if (!options.json && job.progress) {
          const p = job.progress;
          if (p.current > lastPrinted) {
            console.log(
              `  [${String(p.current).padStart(3)}/${p.total}] ` +
              `${chalk.green(String(p.processed) + ' ok')} ` +
              `${p.errors > 0 ? chalk.red(String(p.errors) + ' err') : ''}`
            );
            lastPrinted = p.current;
          }
        }

        if (job.status === 'complete') {
          if (options.json) {
            console.log(JSON.stringify(job, null, 2));
            return;
          }

          const r = job.result || {};
          console.log('');
          console.log(chalk.bold('Summary'));
          console.log(chalk.gray('─'.repeat(60)));
          console.log(`  Processed:           ${chalk.green(fmt(r.processed || 0))}`);
          console.log(`  Errors:              ${chalk.red(fmt(r.errors || 0))}`);
          console.log(`  Remaining eligible:  ${chalk.yellow(fmt(r.remaining_eligible || 0))}`);
          console.log('');

          if (r.by_algo && Object.keys(r.by_algo).length > 0) {
            console.log(chalk.bold('By algorithm'));
            for (const [algo, count] of Object.entries(r.by_algo)) {
              console.log(`    ${(algo as string).padEnd(22)} ${fmt(count as number)}`);
            }
            console.log('');
          }

          if (Array.isArray(r.samples)) {
            for (const s of r.samples.slice(0, 10)) {
              if (s.status === 'ok') {
                const fp = (s.fingerprint_hex || '').slice(0, 22);
                const tag = s.algo === '50-pos-snp-sha256' ? chalk.green(s.algo) : chalk.cyan(s.algo);
                console.log(`  ${tag.padEnd(30)} ${fp}…`);
                console.log(`    ${chalk.gray(s.biocid)}`);
              } else {
                console.log(`  ${chalk.red('error')}  ${(s.reason || '').slice(0, 60)}`);
                console.log(`    ${chalk.gray(s.biocid)}`);
              }
            }
            console.log('');
          }

          if ((r.remaining_eligible || 0) > 0) {
            console.log(chalk.gray(`  Tip: re-run to process the next ${Math.min(r.remaining_eligible, targetLimit)} eligible rows.`));
            console.log('');
          }
          return;
        }

        if (job.status === 'failed') {
          if (options.json) {
            console.log(JSON.stringify(job, null, 2));
          } else {
            Logger.error(`Job failed: ${job.error || 'unknown'}`);
          }
          process.exit(1);
        }

        // Still queued or running — continue polling
      } catch (pollErr: any) {
        if (pollErr.code === 'ECONNABORTED' || pollErr.code === 'ECONNREFUSED') {
          Logger.warning('Poll request failed — retrying...');
          continue;
        }
        throw pollErr;
      }
    }

    Logger.error(`Job ${jobId} did not complete within 30 minutes. Check server logs.`);
    process.exit(1);

  } catch (err: any) {
    const code = err.response?.status;
    const msg = err.response?.data?.error || err.message;
    Logger.error(`Fingerprint failed${code ? ` (HTTP ${code})` : ''}: ${msg}`);
    process.exit(1);
  }
}
