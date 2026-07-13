/**
 * biofs claim — reassign mis-owned inventory rows to the patient owner.
 *
 * Root cause it fixes: lab-custodian and legacy-ingest pipelines wrote
 * bioroutes.inventory rows under owner_wallet = the lab/legacy wallet (e.g.
 * the genobank legacy ingest wallet 0xcef484…) even though the GCS object
 * lives under biorouter/<patient_wallet>/… . Because biofs biofiles and the
 * /consent/biofile Dashboard query by the patient's wallet, those files are
 * invisible in the patient's own vault — so a Digital Twin can reference
 * datasets (e.g. UCSF pathology, Invitae reports) that never appear in the
 * Dashboard.
 *
 * This thin client POSTs to /api_bioroutes/claim, which reassigns
 * owner_wallet + data_owner_wallet + the biocid wallet-segment from the
 * custodian/legacy wallet to the patient, snapshotting the previous values
 * into `claim_prev` (reversible). Default is dry-run — pass --apply to write.
 *
 * Examples:
 *   biofs claim --owner 0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a
 *   biofs claim --owner 0x5f5a60… --exclude /dtc-genotype/,41221040804049
 *   biofs claim --owner 0x5f5a60… --exclude /dtc-genotype/,41221040804049 --apply
 */

import chalk from 'chalk';
import axios from 'axios';
import { CredentialsManager } from '../lib/auth/credentials';
import { CONFIG } from '../lib/config/constants';
import { Logger } from '../lib/utils/logger';

export interface ClaimOptions {
  owner?: string;
  from?: string;
  exclude?: string;
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
}

function fmt(n: number): string {
  return (n ?? 0).toLocaleString('en-US');
}

export async function claimCommand(options: ClaimOptions): Promise<void> {
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }

  const owner = (options.owner || creds.wallet_address || '').trim();
  if (!owner.toLowerCase().startsWith('0x') || owner.length !== 42) {
    Logger.error('--owner <patient EIP-55 wallet> is required (the wallet to claim files TO)');
    process.exit(1);
  }

  const body: Record<string, unknown> = {
    wallet: creds.wallet_address,
    signature: creds.user_signature,
    owner,
    dry_run: !options.apply,
  };
  if (options.from) body.from_wallets = options.from.split(',').map((s) => s.trim()).filter(Boolean);
  if (options.exclude) body.exclude = options.exclude.split(',').map((s) => s.trim()).filter(Boolean);

  if (!options.json) {
    console.log('');
    console.log(chalk.bold('BioRoutes Claim'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(`  Owner (to):  ${owner}`);
    console.log(`  Caller:      ${creds.wallet_address}`);
    if (options.from) console.log(`  From:        ${options.from}`);
    if (options.exclude) console.log(`  Exclude:     ${options.exclude}`);
    console.log(`  Mode:        ${options.apply ? chalk.green('APPLY (writing)') : chalk.yellow('DRY-RUN (no writes)')}`);
    console.log('');
    console.log(chalk.cyan('Reassigning mis-owned inventory rows...'));
  }

  try {
    const url = `${CONFIG.API_BASE_URL}/api_bioroutes/claim`;
    const resp = await axios.post(url, body, {
      timeout: 5 * 60_000,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: (s: number) => s < 500,
    });

    if (resp.status === 403) {
      Logger.error(`Claim denied: ${resp.data?.error || 'unauthorized'}`);
      console.log(chalk.gray('  Only bioroutes admins (the operator) can reassign ownership.'));
      process.exit(1);
    }
    if (resp.status >= 400) {
      Logger.error(`Claim failed (HTTP ${resp.status}): ${resp.data?.error || 'unknown'}`);
      process.exit(1);
    }

    const d = resp.data;
    if (options.json) {
      console.log(JSON.stringify(d, null, 2));
      return;
    }

    console.log(chalk.green(`✓ Claim complete (auth: ${d.auth_role})`));
    console.log('');
    console.log(chalk.bold('Results'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(`  Candidates under your path:  ${chalk.white(fmt(d.candidates))}`);
    console.log(`  Reassigned to you:           ${chalk.green(fmt(d.claimed))}`);
    console.log(`  Skipped (excluded):          ${chalk.gray(fmt(d.skipped_excluded))}`);
    if (d.by_filetype && Object.keys(d.by_filetype).length) {
      console.log('');
      console.log(chalk.bold('  By type:'));
      for (const [ft, n] of Object.entries(d.by_filetype)) {
        console.log(`    ${chalk.gray(ft.padEnd(18))} ${fmt(n as number)}`);
      }
    }
    if (Array.isArray(d.examples) && d.examples.length) {
      console.log('');
      console.log(chalk.bold('  Examples:'));
      for (const ex of d.examples.slice(0, 12)) {
        console.log(`    ${chalk.cyan((ex.object_name || '').split('/').slice(2).join('/'))}`);
        console.log(chalk.gray(`      ${(ex.from_owner || '').slice(0, 12)}… → ${(ex.to_owner || '').slice(0, 12)}…`));
      }
    }
    console.log('');
    if (!d.applied) {
      console.log(chalk.yellow('  [DRY-RUN] No rows were modified.'));
      console.log(chalk.gray('  Re-run with --apply to reassign ownership in MongoDB.'));
    } else {
      console.log(chalk.green('  ✓ Inventory updated. Run `biofs biofiles --update` to see them in your vault.'));
    }
    console.log('');
  } catch (err: any) {
    if (err.response) {
      Logger.error(`Claim failed (HTTP ${err.response.status}): ${err.response.data?.error || err.message}`);
    } else if (err.request) {
      Logger.error(`Cannot reach ${CONFIG.API_BASE_URL}/api_bioroutes/claim`);
    } else {
      Logger.error(`Claim failed: ${err.message}`);
    }
    process.exit(1);
  }
}
