/**
 * biofs scan — walk one or more GCS buckets and register every object in
 * bioroutes.inventory. Per-file `originlab` is INFERRED on the server using
 * the same logic as biocid_mint.py (BUCKET_LAB_MAP + PATH_LAB_HINTS).
 *
 * Default scope: the canonical 46-bucket fleet (G.0.1 DEFAULT_BUCKETS).
 * Use --bucket / --buckets / --prefix to constrain.
 *
 * Auth (server-enforced):
 *   - bioroutes admin → any bucket
 *   - lab custodian   → auto-scoped to their lab; scan walks all buckets
 *                       but only registers files whose inferred lab matches
 *
 * Examples:
 *   biofs scan                                    # full canonical fleet
 *   biofs scan --bucket genobank-parabricks-output
 *   biofs scan --bucket genobank-parabricks-output \\
 *              --prefix jobs/neochromosome-20260418/
 *   biofs scan --buckets genobank-demux,genobank-backups-gcp
 *   biofs scan --filter-lab neochromosome         # admin scoping a fleet scan
 *   biofs scan ... --dry-run --json
 */

import chalk from 'chalk';
import axios from 'axios';
import { CredentialsManager } from '../lib/auth/credentials';
import { CONFIG } from '../lib/config/constants';
import { Logger } from '../lib/utils/logger';

export interface ScanOptions {
  bucket?: string;
  buckets?: string;
  prefix?: string;
  filterLab?: string;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export async function scanCommand(options: ScanOptions): Promise<void> {
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }

  if (options.bucket && options.buckets) {
    Logger.error('Use --bucket OR --buckets, not both.');
    process.exit(1);
  }
  if (options.prefix && !options.bucket) {
    Logger.error('--prefix requires a single --bucket.');
    process.exit(1);
  }

  const requestBody: Record<string, unknown> = {
    wallet: creds.wallet_address,
    signature: creds.user_signature,
    dry_run: !!options.dryRun,
  };

  if (options.bucket) requestBody.bucket = options.bucket;
  if (options.buckets) requestBody.buckets = options.buckets.split(',').map(s => s.trim()).filter(Boolean);
  if (options.prefix) requestBody.prefix = options.prefix;
  if (options.filterLab) requestBody.filter_lab = options.filterLab;

  const scopeLabel = options.bucket
    ? `gs://${options.bucket}/${options.prefix ?? ''}`
    : options.buckets
      ? `${options.buckets.split(',').length} buckets`
      : 'full canonical fleet (~46 buckets)';

  if (!options.json) {
    console.log('');
    console.log(chalk.bold('BioRoutes Scan'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(`  Scope:      ${scopeLabel}`);
    if (options.filterLab) console.log(`  Filter lab: ${options.filterLab}`);
    console.log(`  Wallet:     ${creds.wallet_address}`);
    console.log(`  Mode:       ${options.dryRun ? chalk.yellow('DRY-RUN') : chalk.green('LIVE')}`);
    console.log('');
    console.log(chalk.cyan('Walking GCS — this may take several minutes for the full fleet...'));
  }

  try {
    const url = `${CONFIG.API_BASE_URL}/api_bioroutes/scan`;
    const resp = await axios.post(url, requestBody, {
      timeout: 30 * 60_000, // 30 min — full fleet scans are slow
      headers: { 'Content-Type': 'application/json' },
      validateStatus: (s: number) => s < 500,
    });

    if (resp.status === 403) {
      Logger.error(`Scan denied: ${resp.data?.error || 'unauthorized'}`);
      console.log(chalk.gray('  Only bioroutes admins or registered lab custodians can scan.'));
      process.exit(1);
    }
    if (resp.status >= 400) {
      Logger.error(`Scan failed (HTTP ${resp.status}): ${resp.data?.error || 'unknown'}`);
      process.exit(1);
    }

    const data = resp.data;

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(chalk.green(`✓ Scan complete (auth: ${data.auth_role}${data.scoped_lab ? `, scoped to ${data.scoped_lab}` : ''})`));
    console.log('');
    console.log(chalk.bold('Summary'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(`  Objects scanned:    ${chalk.white(data.scanned)}`);
    console.log(`  Newly inserted:     ${chalk.green(data.inserted)}`);
    console.log(`  Already existing:   ${chalk.gray(data.existing)}`);
    console.log(`  Skipped (scope):    ${chalk.yellow(data.skipped_scope)}`);
    console.log(`  Samples found:      ${chalk.white(data.sample_count)}`);
    console.log(`  Buckets walked:     ${chalk.white(data.buckets_walked.length)} / ${data.buckets_requested}`);

    if (Array.isArray(data.unreachable) && data.unreachable.length > 0) {
      console.log('');
      console.log(chalk.yellow(`  Unreachable buckets (${data.unreachable.length}):`));
      for (const u of data.unreachable.slice(0, 5)) {
        console.log(chalk.yellow(`    ${u.bucket}: ${u.error}`));
      }
      if (data.unreachable.length > 5) {
        console.log(chalk.gray(`    ... and ${data.unreachable.length - 5} more`));
      }
    }

    if (data.by_lab && Object.keys(data.by_lab).length > 0) {
      console.log('');
      console.log(chalk.bold('  Files by inferred originlab:'));
      const labs = Object.entries(data.by_lab as Record<string, number>)
        .sort(([, a], [, b]) => (b as number) - (a as number));
      for (const [lab, count] of labs) {
        console.log(`    ${lab.padEnd(20)} ${count}`);
      }
    }

    if (data.by_filetype && Object.keys(data.by_filetype).length > 0) {
      console.log('');
      console.log(chalk.bold('  Files by type:'));
      const entries = Object.entries(data.by_filetype as Record<string, number>)
        .sort(([, a], [, b]) => (b as number) - (a as number));
      for (const [ft, count] of entries.slice(0, 12)) {
        console.log(`    ${ft.padEnd(20)} ${count}`);
      }
      if (entries.length > 12) {
        console.log(chalk.gray(`    ... and ${entries.length - 12} more types`));
      }
    }

    if (Array.isArray(data.samples) && data.samples.length > 0 && data.samples.length <= 50) {
      console.log('');
      console.log(chalk.bold(`  Samples (${data.samples.length}):`));
      for (const s of data.samples) {
        console.log(`    ${chalk.cyan(s)}`);
      }
    } else if (Array.isArray(data.samples) && data.samples.length > 50) {
      console.log('');
      console.log(chalk.bold(`  Samples (${data.samples.length}, showing 10):`));
      for (const s of data.samples.slice(0, 10)) {
        console.log(`    ${chalk.cyan(s)}`);
      }
      console.log(chalk.gray(`    ... and ${data.samples.length - 10} more`));
    }

    if (data.dry_run) {
      console.log('');
      console.log(chalk.yellow('  [DRY-RUN] No rows were written. Re-run without --dry-run to persist.'));
    }
    console.log('');
  } catch (err: any) {
    if (err.response) {
      Logger.error(`Scan failed (HTTP ${err.response.status}): ${err.response.data?.error || err.message}`);
    } else if (err.request) {
      Logger.error(`Cannot reach ${CONFIG.API_BASE_URL}/api_bioroutes/scan`);
      console.log(chalk.gray('  Verify the bioroutes plugin is mounted on production.'));
    } else {
      Logger.error(`Scan failed: ${err.message}`);
    }
    process.exit(1);
  }
}
