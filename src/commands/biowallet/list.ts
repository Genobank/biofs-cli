/**
 * biofs biowallet list
 *
 * List all biowallets minted locally by `biofs biowallet create`, with their
 * bound biosamples, status, and operator attestation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';

const BIOWALLET_DIR = path.join(os.homedir(), '.biofs', 'biowallets');

export interface BiowalletListOptions {
  json?: boolean;
  operator?: string;  // filter by operator wallet
  status?: string;    // filter by status (operator-custodial | patient-claimed)
  biosample?: string; // filter by bound biosample
  short?: boolean;    // only print addresses, one per line
}

interface BiowalletIndexEntry {
  address: string;
  label?: string;
  bound_biosamples: string[];
  created_at: string;
  operator_wallet: string;
  status: 'operator-custodial' | 'patient-claimed';
  mnemonic_on_disk: boolean;
  keystore_path: string;
}

export async function biowalletListCommand(opts: BiowalletListOptions): Promise<void> {
  const p = path.join(BIOWALLET_DIR, 'index.json');
  const entries: BiowalletIndexEntry[] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];

  let filtered = entries;
  if (opts.operator) filtered = filtered.filter(e => e.operator_wallet === opts.operator);
  if (opts.status) filtered = filtered.filter(e => e.status === opts.status);
  if (opts.biosample) filtered = filtered.filter(e => e.bound_biosamples.includes(opts.biosample!));

  if (opts.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (opts.short) {
    for (const e of filtered) console.log(e.address);
    return;
  }

  console.log(chalk.cyan(`\n  ${filtered.length} biowallet(s) at ${BIOWALLET_DIR}`));
  console.log(chalk.cyan('─'.repeat(110)));
  for (const e of filtered) {
    const statusColor = e.status === 'patient-claimed' ? chalk.green : chalk.yellow;
    console.log(`  ${chalk.green(e.address)}  ${statusColor(e.status.padEnd(20))}  ${(e.label || '').padEnd(20)}`);
    console.log(chalk.gray(`    biosamples: ${e.bound_biosamples.join(', ') || '(none bound)'}`));
    console.log(chalk.gray(`    operator: ${e.operator_wallet}   created: ${e.created_at}`));
    console.log(chalk.gray(`    mnemonic_on_disk: ${e.mnemonic_on_disk}   keystore: ${e.keystore_path}`));
    console.log('');
  }
}
