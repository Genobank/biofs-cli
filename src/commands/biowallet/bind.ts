/**
 * biofs biowallet bind <address> <biosample_serial>
 *
 * Bind an existing local biowallet to a biosample serial. Idempotent.
 * The address must already exist in the local biowallets index.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAddress } from 'ethers';
import chalk from 'chalk';

const BIOWALLET_DIR = path.join(os.homedir(), '.biofs', 'biowallets');

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

export interface BiowalletBindOptions {
  json?: boolean;
  quiet?: boolean;
}

export async function biowalletBindCommand(address: string, biosample: string, opts: BiowalletBindOptions): Promise<void> {
  // Canonicalize the address to EIP-55
  let checksum: string;
  try {
    checksum = getAddress(address);
  } catch {
    throw new Error(`Invalid Ethereum address: ${address}`);
  }

  const p = path.join(BIOWALLET_DIR, 'index.json');
  if (!fs.existsSync(p)) {
    throw new Error(`No biowallets index at ${p}. Run "biofs biowallet create" first.`);
  }
  const entries: BiowalletIndexEntry[] = JSON.parse(fs.readFileSync(p, 'utf8'));
  const idx = entries.findIndex(e => e.address.toLowerCase() === checksum.toLowerCase());
  if (idx < 0) {
    throw new Error(`Biowallet ${checksum} not found in local index. List with "biofs biowallet list".`);
  }
  const entry = entries[idx];

  if (entry.bound_biosamples.includes(biosample)) {
    if (!opts.quiet) console.error(chalk.gray(`Biosample ${biosample} already bound to ${checksum}; no-op.`));
    return;
  }

  entry.bound_biosamples.push(biosample);
  fs.writeFileSync(p, JSON.stringify(entries, null, 2));

  if (opts.json) {
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Bound biosample ${biosample} to ${checksum}`));
  console.log(chalk.gray(`  Now bound to: ${entry.bound_biosamples.join(', ')}`));
}
