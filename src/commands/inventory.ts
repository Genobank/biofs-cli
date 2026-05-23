/**
 * biofs inventory — fast read-only summary of bioroutes.inventory.
 *
 * Returns counts/breakdowns from MongoDB without walking GCS. Use this
 * when you want "what's under management right now" instantly. For
 * "go discover new files in GCS", run `biofs scan`.
 *
 * Auth: admin (sees full fleet) or lab custodian (auto-scoped to their lab).
 *
 * Examples:
 *   biofs inventory              # full pretty summary
 *   biofs inventory --json       # machine-readable
 *   biofs inventory --buckets    # show all buckets, not top-N
 */

import chalk from 'chalk';
import axios from 'axios';
import { CredentialsManager } from '../lib/auth/credentials';
import { CONFIG } from '../lib/config/constants';
import { Logger } from '../lib/utils/logger';

export interface InventoryOptions {
  json?: boolean;
  buckets?: boolean;
  verbose?: boolean;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export async function inventoryCommand(options: InventoryOptions): Promise<void> {
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }

  try {
    const url = `${CONFIG.API_BASE_URL}/api_bioroutes/inventory/summary`;
    const resp = await axios.get(url, {
      params: {
        wallet: creds.wallet_address,
        signature: creds.user_signature,
      },
      timeout: 60_000,
      validateStatus: (s: number) => s < 500,
    });

    if (resp.status === 403) {
      Logger.error(`Inventory denied: ${resp.data?.error || 'unauthorized'}`);
      console.log(chalk.gray('  Only bioroutes admins or lab custodians can view inventory.'));
      process.exit(1);
    }
    if (resp.status >= 400) {
      Logger.error(`Inventory failed (HTTP ${resp.status}): ${resp.data?.error || 'unknown'}`);
      process.exit(1);
    }

    const d = resp.data;

    if (options.json) {
      console.log(JSON.stringify(d, null, 2));
      return;
    }

    const scopeLabel = d.scoped_lab ? `lab=${d.scoped_lab}` : 'full fleet';
    console.log('');
    console.log(chalk.bold('BioRoutes Inventory'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(`  Wallet:    ${creds.wallet_address}`);
    console.log(`  Auth:      ${d.auth_role} (${scopeLabel})`);
    console.log('');

    console.log(chalk.bold('  Files under management'));
    console.log(`    Total files:      ${chalk.green(fmt(d.total_files))}`);
    console.log(`    Total size:       ${chalk.green(fmt(d.total_gb))} GB`);
    console.log(`    Largest file:     ${chalk.gray(fmt(d.largest_file_gb))} GB`);
    console.log(`    Distinct buckets: ${chalk.white(fmt(d.buckets))}`);
    console.log(`    Samples:          ${chalk.white(fmt(d.samples))}`);
    console.log('');

    console.log(chalk.bold('  Pipeline progress'));
    const biocidPct = d.total_files ? Math.round((d.with_biocid / d.total_files) * 100) : 0;
    const onChainPct = d.total_files ? Math.round((d.on_chain / d.total_files) * 100) : 0;
    console.log(`    With biocid:      ${chalk.white(fmt(d.with_biocid))} / ${fmt(d.total_files)} (${biocidPct}%)`);
    console.log(`    On-chain (route): ${chalk.white(fmt(d.on_chain))} / ${fmt(d.total_files)} (${onChainPct}%)`);
    console.log('');

    if (d.by_lab && Object.keys(d.by_lab).length > 0) {
      console.log(chalk.bold('  By originlab'));
      const labs = Object.entries(d.by_lab as Record<string, number>)
        .sort(([, a], [, b]) => (b as number) - (a as number));
      for (const [lab, count] of labs) {
        console.log(`    ${lab.padEnd(20)} ${fmt(count as number)}`);
      }
      console.log('');
    }

    if (d.by_filetype && Object.keys(d.by_filetype).length > 0) {
      console.log(chalk.bold('  By filetype (top 12)'));
      const entries = Object.entries(d.by_filetype as Record<string, number>)
        .sort(([, a], [, b]) => (b as number) - (a as number))
        .slice(0, 12);
      for (const [ft, count] of entries) {
        console.log(`    ${ft.padEnd(20)} ${fmt(count as number)}`);
      }
      console.log('');
    }

    if (d.by_bucket && Object.keys(d.by_bucket).length > 0) {
      const all = Object.entries(d.by_bucket as Record<string, number>)
        .sort(([, a], [, b]) => (b as number) - (a as number));
      const showAll = options.buckets;
      const display = showAll ? all : all.slice(0, 15);
      console.log(chalk.bold(`  By bucket (${showAll ? all.length : `top ${display.length} of ${all.length}`})`));
      for (const [bucket, count] of display) {
        console.log(`    ${bucket.padEnd(50)} ${fmt(count as number)}`);
      }
      if (!showAll && all.length > 15) {
        console.log(chalk.gray(`    ... and ${all.length - 15} more (use --buckets to show all)`));
      }
      console.log('');
    }

    if (d.by_fingerprint_status && Object.keys(d.by_fingerprint_status).length > 0) {
      console.log(chalk.bold('  Fingerprint status'));
      for (const [s, count] of Object.entries(d.by_fingerprint_status as Record<string, number>)) {
        console.log(`    ${s.padEnd(20)} ${fmt(count as number)}`);
      }
      console.log('');
    }
  } catch (err: any) {
    if (err.response) {
      Logger.error(`Inventory failed (HTTP ${err.response.status}): ${err.response.data?.error || err.message}`);
    } else if (err.request) {
      Logger.error(`Cannot reach ${CONFIG.API_BASE_URL}/api_bioroutes/inventory/summary`);
    } else {
      Logger.error(`Inventory failed: ${err.message}`);
    }
    process.exit(1);
  }
}
