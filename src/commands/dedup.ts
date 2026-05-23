/**
 * biofs dedup — collapse duplicate biocid registrations to one canonical row.
 *
 * The legacy oracle minted each logical file under multiple
 * (bucket, originlab, owner_wallet) combinations. This command picks one
 * canonical biocid per (sample_serial, filetype, basename) tuple using a
 * deterministic priority and marks the rest as `route_status: SUPERSEDED`
 * (with a `superseded_by` pointer back to the canonical row).
 *
 * Default is dry-run — must pass --apply to write.
 *
 * Examples:
 *   biofs dedup --serial FR724733315947-241101-A01_1
 *   biofs dedup --serials FR724...,FR736...
 *   biofs dedup --lab neochromosome
 *   biofs dedup --lab neochromosome --apply
 *   biofs dedup --json
 */

import chalk from 'chalk';
import axios from 'axios';
import { CredentialsManager } from '../lib/auth/credentials';
import { CONFIG } from '../lib/config/constants';
import { Logger } from '../lib/utils/logger';

export interface DedupOptions {
  serial?: string;
  serials?: string;
  lab?: string;
  bucket?: string;
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export async function dedupCommand(options: DedupOptions): Promise<void> {
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }

  const body: Record<string, unknown> = {
    wallet: creds.wallet_address,
    signature: creds.user_signature,
    dry_run: !options.apply,
  };

  const serialList: string[] = [];
  if (options.serial) serialList.push(options.serial);
  if (options.serials) {
    options.serials.split(',').forEach((s) => {
      const trimmed = s.trim();
      if (trimmed) serialList.push(trimmed);
    });
  }
  if (serialList.length > 0) body.sample_serials = serialList;
  if (options.lab) body.originlab = options.lab;
  if (options.bucket) body.bucket = options.bucket;

  const scopeLabel = serialList.length > 0
    ? `${serialList.length} sample(s)`
    : options.lab
      ? `lab=${options.lab}`
      : options.bucket
        ? `bucket=${options.bucket}`
        : 'full inventory';

  if (!options.json) {
    console.log('');
    console.log(chalk.bold('BioRoutes Dedup'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(`  Scope:   ${scopeLabel}`);
    console.log(`  Wallet:  ${creds.wallet_address}`);
    console.log(`  Mode:    ${options.apply ? chalk.green('APPLY (writing)') : chalk.yellow('DRY-RUN (no writes)')}`);
    console.log('');
    console.log(chalk.cyan('Computing canonical biocids...'));
  }

  try {
    const url = `${CONFIG.API_BASE_URL}/api_bioroutes/dedup`;
    const resp = await axios.post(url, body, {
      timeout: 5 * 60_000,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: (s: number) => s < 500,
    });

    if (resp.status === 403) {
      Logger.error(`Dedup denied: ${resp.data?.error || 'unauthorized'}`);
      process.exit(1);
    }
    if (resp.status >= 400) {
      Logger.error(`Dedup failed (HTTP ${resp.status}): ${resp.data?.error || 'unknown'}`);
      process.exit(1);
    }

    const d = resp.data;

    if (options.json) {
      console.log(JSON.stringify(d, null, 2));
      return;
    }

    console.log(chalk.green(`✓ Dedup analysis complete (auth: ${d.auth_role})`));
    console.log('');
    console.log(chalk.bold('Results'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(`  Rows examined:        ${chalk.white(fmt(d.rows_total))}`);
    console.log(`  Logical groups:       ${chalk.white(fmt(d.groups_total))}`);
    console.log(`  Groups with dupes:    ${chalk.yellow(fmt(d.groups_with_dups))}`);
    console.log(`  Canonical rows:       ${chalk.green(fmt(d.rows_canonical))}`);
    console.log(`  Superseded rows:      ${chalk.gray(fmt(d.rows_superseded))}`);
    if (d.rows_total > 0) {
      const pct = Math.round((d.rows_superseded / d.rows_total) * 100);
      console.log(`  Compression ratio:    ${chalk.cyan(`${pct}% of rows now SUPERSEDED`)}`);
    }
    console.log('');

    if (Array.isArray(d.examples) && d.examples.length > 0) {
      console.log(chalk.bold('Top examples (canonical → superseded)'));
      for (const ex of d.examples) {
        console.log('');
        console.log(`  ${chalk.cyan(ex.sample_serial)}  ${chalk.gray(ex.filetype)}  ${ex.basename}`);
        console.log(chalk.green(`    canonical: ${ex.canonical_biocid}`));
        console.log(chalk.gray(`      bucket=${ex.canonical_bucket}  lab=${ex.canonical_lab}  owner=${(ex.canonical_owner || '').slice(0, 12)}...`));
        const supN = ex.superseded_count;
        if (Array.isArray(ex.superseded_biocids)) {
          console.log(chalk.yellow(`    superseded (${supN}):`));
          for (const b of ex.superseded_biocids.slice(0, 3)) {
            console.log(chalk.yellow(`      ${b}`));
          }
          if (ex.superseded_biocids.length > 3) {
            console.log(chalk.gray(`      ... and ${ex.superseded_biocids.length - 3} more`));
          }
        }
      }
      console.log('');
    }

    if (!d.applied) {
      console.log(chalk.yellow('  [DRY-RUN] No rows were modified.'));
      console.log(chalk.gray('  Re-run with --apply to mark canonical/superseded in MongoDB.'));
    } else {
      console.log(chalk.green('  ✓ Inventory updated. Resolver and downstream tools will use canonical biocids.'));
    }
    console.log('');
  } catch (err: any) {
    if (err.response) {
      Logger.error(`Dedup failed (HTTP ${err.response.status}): ${err.response.data?.error || err.message}`);
    } else if (err.request) {
      Logger.error(`Cannot reach ${CONFIG.API_BASE_URL}/api_bioroutes/dedup`);
    } else {
      Logger.error(`Dedup failed: ${err.message}`);
    }
    process.exit(1);
  }
}
