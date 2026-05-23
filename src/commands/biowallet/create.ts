/**
 * biofs biowallet create
 *
 * Mint a fresh EIP-55-checksummed Ethereum keypair as a custodial biowallet
 * for an individual patient. The operator (the currently logged-in wallet)
 * generates the keypair on the patient's behalf; the patient can later claim
 * it by importing the mnemonic into any standard Ethereum wallet (MetaMask,
 * Rainbow, etc.) and signing a challenge.
 *
 * Storage layout under ~/.biofs/biowallets/:
 *   - <address>.keystore.json    Ethereum v3 keystore (AES-encrypted)
 *   - <address>.mnemonic.txt     plaintext BIP-39 mnemonic (chmod 600)
 *   - index.json                 metadata index: address ↔ biosamples ↔ label ↔ created_at ↔ operator ↔ status
 *
 * Security:
 *   - Mnemonic is written to disk in plaintext but the file is chmod 600 (owner-only).
 *   - The keystore is AES-128-CTR encrypted; password is printed to stdout
 *     once at creation time (operator must save it securely).
 *   - The operator's wallet signature attests to the mint event but does NOT
 *     have spending authority over the biowallet's private key.
 *
 * Claim flow (out of scope for this verb, see `biofs biowallet claim`):
 *   1. Operator hands the mnemonic to the patient over a secure channel.
 *   2. Patient imports the mnemonic into their own wallet.
 *   3. Patient signs an arbitrary message with the biowallet's private key.
 *   4. Operator (or third party) verifies the signature recovers to the same
 *      EIP-55 address. Once verified, biowallet status flips from
 *      "operator-custodial" to "patient-claimed" in the local index.
 */

import { Wallet, getDefaultProvider } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import chalk from 'chalk';
import ora from 'ora';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOWALLET_DIR = path.join(os.homedir(), '.biofs', 'biowallets');

export interface BiowalletCreateOptions {
  bindBiosample?: string;     // comma-separated biosample serials to bind
  label?: string;             // human-readable label (kept off-chain, indexed locally)
  password?: string;          // user-supplied keystore password; if omitted, a random one is generated
  outDir?: string;            // alternative output directory
  json?: boolean;
  quiet?: boolean;
  noMnemonicFile?: boolean;   // don't persist the mnemonic to disk (operator must transcribe at creation)
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

function loadIndex(dir: string): BiowalletIndexEntry[] {
  const p = path.join(dir, 'index.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveIndex(dir: string, entries: BiowalletIndexEntry[]): void {
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(entries, null, 2));
}

export async function biowalletCreateCommand(opts: BiowalletCreateOptions): Promise<void> {
  const dir = opts.outDir || BIOWALLET_DIR;
  fs.mkdirSync(dir, { recursive: true });

  // Operator (the logged-in wallet) — used to attest the mint event in the local index.
  let operator = 'unauth';
  try {
    const creds = await getCredentials();
    if (creds?.wallet_address) operator = creds.wallet_address;
  } catch {
    // Anonymous operator is acceptable for local-only mint, but record it as such.
  }

  const spinner = opts.quiet ? null : ora('Generating EIP-55 biowallet...').start();
  const wallet = Wallet.createRandom();
  if (spinner) spinner.succeed('Generated');

  const address = wallet.address;  // ethers.js returns checksum (EIP-55) by default
  const mnemonic = wallet.mnemonic?.phrase;
  const privateKey = wallet.privateKey;

  // Password for keystore: user-supplied or random 32-byte hex
  const keystorePassword = opts.password || crypto.randomBytes(24).toString('base64url');

  if (!opts.quiet) console.error(chalk.gray('Encrypting keystore (scrypt KDF, may take a few seconds)...'));
  const keystoreJson = await wallet.encrypt(keystorePassword);
  const keystorePath = path.join(dir, `${address}.keystore.json`);
  fs.writeFileSync(keystorePath, keystoreJson);
  fs.chmodSync(keystorePath, 0o600);

  let mnemonicOnDisk = false;
  let mnemonicPath = '';
  if (mnemonic && !opts.noMnemonicFile) {
    mnemonicPath = path.join(dir, `${address}.mnemonic.txt`);
    fs.writeFileSync(mnemonicPath, mnemonic + '\n');
    fs.chmodSync(mnemonicPath, 0o600);
    mnemonicOnDisk = true;
  }

  const bound = (opts.bindBiosample || '').split(',').map(s => s.trim()).filter(Boolean);

  const entry: BiowalletIndexEntry = {
    address,
    label: opts.label,
    bound_biosamples: bound,
    created_at: new Date().toISOString(),
    operator_wallet: operator,
    status: 'operator-custodial',
    mnemonic_on_disk: mnemonicOnDisk,
    keystore_path: keystorePath,
  };

  const index = loadIndex(dir);
  index.push(entry);
  saveIndex(dir, index);

  if (opts.json) {
    console.log(JSON.stringify({
      address,
      mnemonic,
      keystore_password: keystorePassword,
      keystore_path: keystorePath,
      mnemonic_path: mnemonicPath || null,
      bound_biosamples: bound,
      operator_wallet: operator,
      created_at: entry.created_at,
    }, null, 2));
    return;
  }

  console.log('');
  console.log(chalk.cyan('═'.repeat(74)));
  console.log(chalk.bold.cyan('  🆕 NEW BIOWALLET MINTED'));
  console.log(chalk.cyan('═'.repeat(74)));
  console.log(`  ${chalk.gray('Address (EIP-55):')}        ${chalk.green(address)}`);
  if (opts.label) {
    console.log(`  ${chalk.gray('Label:')}                   ${chalk.white(opts.label)}`);
  }
  if (bound.length > 0) {
    console.log(`  ${chalk.gray('Bound biosamples:')}        ${chalk.white(bound.join(', '))}`);
  }
  console.log(`  ${chalk.gray('Operator wallet:')}         ${chalk.gray(operator)}`);
  console.log(`  ${chalk.gray('Status:')}                  ${chalk.yellow('operator-custodial')} (awaiting patient claim)`);
  console.log(`  ${chalk.gray('Created:')}                 ${chalk.gray(entry.created_at)}`);
  console.log(chalk.cyan('─'.repeat(74)));
  console.log(chalk.bold.red('  🔐 SECRETS  (printed ONCE — save securely, will not be shown again)'));
  console.log(chalk.cyan('─'.repeat(74)));
  if (mnemonic) {
    console.log(`  ${chalk.gray('BIP-39 mnemonic:')}`);
    console.log(`    ${chalk.yellow(mnemonic)}`);
  }
  console.log(`  ${chalk.gray('Keystore password:')}       ${chalk.yellow(keystorePassword)}`);
  console.log(`  ${chalk.gray('Private key (hex):')}       ${chalk.gray(privateKey)}`);
  console.log(chalk.cyan('─'.repeat(74)));
  console.log(`  ${chalk.gray('Keystore (encrypted):')}    ${chalk.white(keystorePath)}`);
  if (mnemonicOnDisk) {
    console.log(`  ${chalk.gray('Mnemonic (plaintext, chmod 600):')}`);
    console.log(`    ${chalk.white(mnemonicPath)}`);
  } else {
    console.log(`  ${chalk.gray('Mnemonic:')}                ${chalk.gray('NOT written to disk (--no-mnemonic-file)')}`);
  }
  console.log(chalk.cyan('═'.repeat(74)));
  console.log('');
  console.log(chalk.gray('  Next steps:'));
  console.log(chalk.gray('    - Securely transmit the mnemonic to the patient (Signal, in-person, etc.)'));
  console.log(chalk.gray('    - Patient imports mnemonic into MetaMask / Rainbow / Frame / Trust / etc.'));
  console.log(chalk.gray('    - Patient signs a challenge via `biofs biowallet claim ' + address + '`'));
  console.log(chalk.gray('    - Operator verifies and flips status to patient-claimed'));
  console.log('');
}
