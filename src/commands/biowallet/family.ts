/**
 * biofs biowallet family
 *
 * Manage a Family Vault: a single BIP-32 HD master seed from which N child
 * biowallets are derived along the Ethereum standard derivation path
 * (m/44'/60'/0'/0/index). One mnemonic recovers the entire family, which is
 * useful both for biological coherence (relatives sharing a custodial root
 * before each member self-custodializes their child branch) and for operator
 * key management (one master key per household instead of N independent keys).
 *
 * Members are assigned conventional indices:
 *   index 0 = head / mother (often the genealogical anchor)
 *   index 1 = father / second parent
 *   index 2..N = children
 *
 * Storage layout under ~/.biofs/biowallets/families/<family_id>/:
 *   - master.mnemonic.txt        plaintext BIP-39 mnemonic (chmod 600)
 *   - master.keystore.json       AES-encrypted Ethereum keystore of the path-0 key (chmod 600)
 *   - family.json                metadata: family_id, label, members[{index,address,role,biosamples,status}]
 *
 * Subcommands:
 *   family create [--label] [--password] [--members <comma-list of "role:biosample">]
 *   family derive <family_id> <index> [--role] [--bind-biosample]
 *   family list  [<family_id>]
 *   family rotate <family_id>  (placeholder — re-derive after rotation)
 */

import { Mnemonic, HDNodeWallet, Wallet, getAddress, randomBytes } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import chalk from 'chalk';
import ora from 'ora';
import { getCredentials } from '../../lib/auth/credentials';

const FAMILIES_DIR = path.join(os.homedir(), '.biofs', 'biowallets', 'families');
const BIOWALLETS_INDEX = path.join(os.homedir(), '.biofs', 'biowallets', 'index.json');

const ETH_PATH_PREFIX = "m/44'/60'/0'/0/";  // index appended

export interface FamilyCreateOptions {
  label?: string;
  password?: string;
  members?: string;     // comma-separated "role:biosample[:label]" tuples
  json?: boolean;
  quiet?: boolean;
  noMnemonicFile?: boolean;
}

export interface FamilyDeriveOptions {
  role?: string;
  bindBiosample?: string;
  label?: string;
  json?: boolean;
  quiet?: boolean;
}

export interface FamilyListOptions {
  json?: boolean;
}

interface FamilyMember {
  index: number;
  derivation_path: string;
  address: string;
  role?: string;       // mother | father | child_1 | child_2 | self | ...
  label?: string;
  bound_biosamples: string[];
  created_at: string;
  status: 'operator-custodial' | 'patient-claimed';
}

interface FamilyVaultMeta {
  family_id: string;
  label?: string;
  master_address: string;   // address derived at path m/44'/60'/0'/0/0 (head)
  members: FamilyMember[];
  operator_wallet: string;
  created_at: string;
  mnemonic_on_disk: boolean;
}

interface FlatBiowalletEntry {
  address: string;
  label?: string;
  bound_biosamples: string[];
  created_at: string;
  operator_wallet: string;
  status: 'operator-custodial' | 'patient-claimed';
  mnemonic_on_disk: boolean;
  keystore_path: string;
  family_id?: string;
  derivation_path?: string;
}

function appendToFlatIndex(entry: FlatBiowalletEntry): void {
  const dir = path.dirname(BIOWALLETS_INDEX);
  fs.mkdirSync(dir, { recursive: true });
  const list: FlatBiowalletEntry[] = fs.existsSync(BIOWALLETS_INDEX)
    ? JSON.parse(fs.readFileSync(BIOWALLETS_INDEX, 'utf8'))
    : [];
  list.push(entry);
  fs.writeFileSync(BIOWALLETS_INDEX, JSON.stringify(list, null, 2));
}

function randFamilyId(): string {
  return 'fam_' + crypto.randomBytes(6).toString('hex');
}

function loadFamily(familyId: string): { meta: FamilyVaultMeta; dir: string } {
  const dir = path.join(FAMILIES_DIR, familyId);
  const metaPath = path.join(dir, 'family.json');
  if (!fs.existsSync(metaPath)) {
    throw new Error(`Family vault ${familyId} not found at ${dir}`);
  }
  return { meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')), dir };
}

function saveFamily(meta: FamilyVaultMeta, dir: string): void {
  fs.writeFileSync(path.join(dir, 'family.json'), JSON.stringify(meta, null, 2));
}

function loadMasterMnemonic(dir: string): string {
  const p = path.join(dir, 'master.mnemonic.txt');
  if (!fs.existsSync(p)) {
    throw new Error(`Master mnemonic missing at ${p} (was --no-mnemonic-file used at creation?). Cannot derive new members.`);
  }
  return fs.readFileSync(p, 'utf8').trim();
}

export async function familyCreateCommand(opts: FamilyCreateOptions): Promise<void> {
  const familyId = randFamilyId();
  const familyDir = path.join(FAMILIES_DIR, familyId);
  fs.mkdirSync(familyDir, { recursive: true });

  // Operator
  let operator = 'unauth';
  try {
    const creds = await getCredentials();
    if (creds?.wallet_address) operator = creds.wallet_address;
  } catch {}

  const spinner = opts.quiet ? null : ora('Generating Family Vault master seed (BIP-39 + BIP-32)...').start();
  const root = HDNodeWallet.createRandom();
  const mnemonic = root.mnemonic?.phrase;
  if (!mnemonic) throw new Error('Failed to generate mnemonic');
  if (spinner) spinner.succeed('Generated');

  const keystorePassword = opts.password || crypto.randomBytes(24).toString('base64url');

  // Parse member specs: "mother:56102007614179:Mother-pseudonym,father:56102007614180,..."
  const memberSpecs = (opts.members || '').split(',').map(s => s.trim()).filter(Boolean);
  const members: FamilyMember[] = [];

  for (let i = 0; i < memberSpecs.length; i++) {
    const parts = memberSpecs[i].split(':');
    const role = parts[0] || `member_${i}`;
    const biosample = parts[1] || '';
    const label = parts[2] || undefined;
    const derivePath = ETH_PATH_PREFIX + i;
    const child = HDNodeWallet.fromPhrase(mnemonic, undefined, derivePath);
    const member: FamilyMember = {
      index: i,
      derivation_path: derivePath,
      address: getAddress(child.address),
      role,
      label,
      bound_biosamples: biosample ? [biosample] : [],
      created_at: new Date().toISOString(),
      status: 'operator-custodial',
    };
    members.push(member);

    // Also encrypt and persist the child keystore for direct access
    const childWallet = new Wallet(child.privateKey);
    const childKeystore = await childWallet.encrypt(keystorePassword);
    const ksPath = path.join(familyDir, `${member.address}.keystore.json`);
    fs.writeFileSync(ksPath, childKeystore);
    fs.chmodSync(ksPath, 0o600);

    // Mirror into the flat biowallets index so `biofs biowallet list` shows family members too
    appendToFlatIndex({
      address: member.address,
      label: label || `${familyId}:${role}`,
      bound_biosamples: member.bound_biosamples,
      created_at: member.created_at,
      operator_wallet: operator,
      status: 'operator-custodial',
      mnemonic_on_disk: !opts.noMnemonicFile,
      keystore_path: ksPath,
      family_id: familyId,
      derivation_path: derivePath,
    });
  }

  // Save the master mnemonic + encrypted root keystore
  let mnemonicOnDisk = false;
  if (!opts.noMnemonicFile) {
    const mp = path.join(familyDir, 'master.mnemonic.txt');
    fs.writeFileSync(mp, mnemonic + '\n');
    fs.chmodSync(mp, 0o600);
    mnemonicOnDisk = true;
  }
  const rootKs = await new Wallet(root.privateKey).encrypt(keystorePassword);
  const rootKsPath = path.join(familyDir, 'master.keystore.json');
  fs.writeFileSync(rootKsPath, rootKs);
  fs.chmodSync(rootKsPath, 0o600);

  const meta: FamilyVaultMeta = {
    family_id: familyId,
    label: opts.label,
    master_address: getAddress(root.address),
    members,
    operator_wallet: operator,
    created_at: new Date().toISOString(),
    mnemonic_on_disk: mnemonicOnDisk,
  };
  saveFamily(meta, familyDir);

  if (opts.json) {
    console.log(JSON.stringify({
      ...meta,
      master_mnemonic: mnemonic,
      keystore_password: keystorePassword,
      master_keystore_path: rootKsPath,
    }, null, 2));
    return;
  }

  console.log('');
  console.log(chalk.cyan('═'.repeat(80)));
  console.log(chalk.bold.cyan(`  🏠 FAMILY VAULT MINTED:  ${familyId}`));
  console.log(chalk.cyan('═'.repeat(80)));
  if (opts.label) console.log(`  ${chalk.gray('Label:')}                  ${chalk.white(opts.label)}`);
  console.log(`  ${chalk.gray('Master address:')}         ${chalk.green(meta.master_address)}`);
  console.log(`  ${chalk.gray('Operator wallet:')}        ${chalk.gray(operator)}`);
  console.log(`  ${chalk.gray('Created:')}                ${chalk.gray(meta.created_at)}`);
  console.log(`  ${chalk.gray('Family dir:')}             ${chalk.white(familyDir)}`);
  console.log(chalk.cyan('─'.repeat(80)));
  console.log(chalk.bold(`  Members (${members.length}):`));
  for (const m of members) {
    console.log(`    ${chalk.gray('[' + m.index + ']')} ${chalk.green(m.address)}  ${chalk.yellow(m.role?.padEnd(12) || '')}  ${(m.bound_biosamples.join(',') || chalk.gray('(none)'))}`);
    console.log(`        path: ${m.derivation_path}`);
  }
  console.log(chalk.cyan('─'.repeat(80)));
  console.log(chalk.bold.red('  🔐 SECRETS  (printed ONCE — save securely)'));
  console.log(chalk.cyan('─'.repeat(80)));
  console.log(`  ${chalk.gray('Master BIP-39 mnemonic:')}`);
  console.log(`    ${chalk.yellow(mnemonic)}`);
  console.log(`  ${chalk.gray('Keystore password:')}      ${chalk.yellow(keystorePassword)}`);
  console.log(`  ${chalk.gray('Derivation:')}             ${chalk.gray("m/44'/60'/0'/0/<index> (Ethereum BIP-44)")}`);
  console.log(chalk.cyan('═'.repeat(80)));
  console.log('');
  console.log(chalk.gray('  Derive additional members later:'));
  console.log(chalk.gray(`    biofs biowallet family derive ${familyId} <index> --role <role> --bind-biosample <serial>`));
  console.log('');
}

export async function familyDeriveCommand(familyId: string, indexArg: string, opts: FamilyDeriveOptions): Promise<void> {
  const { meta, dir } = loadFamily(familyId);
  const index = parseInt(indexArg, 10);
  if (isNaN(index) || index < 0 || index > 1000) {
    throw new Error(`Invalid index: ${indexArg} (expected 0..1000)`);
  }
  if (meta.members.some(m => m.index === index)) {
    throw new Error(`Index ${index} already exists in family ${familyId}`);
  }
  const mnemonic = loadMasterMnemonic(dir);
  const derivePath = ETH_PATH_PREFIX + index;
  const child = HDNodeWallet.fromPhrase(mnemonic, undefined, derivePath);

  // Encrypt with same password? We don't have it stored. Generate a fresh password for this child's keystore.
  const keystorePassword = crypto.randomBytes(24).toString('base64url');
  const childWallet = new Wallet(child.privateKey);
  const ks = await childWallet.encrypt(keystorePassword);
  const ksPath = path.join(dir, `${getAddress(child.address)}.keystore.json`);
  fs.writeFileSync(ksPath, ks);
  fs.chmodSync(ksPath, 0o600);

  const member: FamilyMember = {
    index,
    derivation_path: derivePath,
    address: getAddress(child.address),
    role: opts.role,
    label: opts.label,
    bound_biosamples: opts.bindBiosample ? opts.bindBiosample.split(',').map(s => s.trim()).filter(Boolean) : [],
    created_at: new Date().toISOString(),
    status: 'operator-custodial',
  };
  meta.members.push(member);
  meta.members.sort((a, b) => a.index - b.index);
  saveFamily(meta, dir);

  appendToFlatIndex({
    address: member.address,
    label: opts.label || `${familyId}:${opts.role || 'member_' + index}`,
    bound_biosamples: member.bound_biosamples,
    created_at: member.created_at,
    operator_wallet: meta.operator_wallet,
    status: 'operator-custodial',
    mnemonic_on_disk: meta.mnemonic_on_disk,
    keystore_path: ksPath,
    family_id: familyId,
    derivation_path: derivePath,
  });

  if (opts.json) {
    console.log(JSON.stringify({ ...member, keystore_password: keystorePassword, keystore_path: ksPath }, null, 2));
    return;
  }
  console.log(chalk.green(`✓ Derived member [${index}] ${member.address} in family ${familyId}`));
  console.log(chalk.gray(`  path: ${derivePath}`));
  if (member.role) console.log(chalk.gray(`  role: ${member.role}`));
  if (member.bound_biosamples.length) console.log(chalk.gray(`  biosamples: ${member.bound_biosamples.join(', ')}`));
  console.log(chalk.gray(`  keystore: ${ksPath}`));
  console.log(chalk.yellow(`  keystore password: ${keystorePassword}`));
}

export async function familyListCommand(familyId: string | undefined, opts: FamilyListOptions): Promise<void> {
  fs.mkdirSync(FAMILIES_DIR, { recursive: true });
  const ids = familyId ? [familyId] : fs.readdirSync(FAMILIES_DIR).filter(d => fs.statSync(path.join(FAMILIES_DIR, d)).isDirectory());

  const families: FamilyVaultMeta[] = [];
  for (const id of ids) {
    const metaPath = path.join(FAMILIES_DIR, id, 'family.json');
    if (fs.existsSync(metaPath)) families.push(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
  }

  if (opts.json) {
    console.log(JSON.stringify(families, null, 2));
    return;
  }

  for (const f of families) {
    console.log('');
    console.log(chalk.cyan(`🏠 ${f.family_id}${f.label ? ' (' + f.label + ')' : ''}`));
    console.log(chalk.gray(`   master ${f.master_address}, ${f.members.length} members, created ${f.created_at}`));
    for (const m of f.members) {
      console.log(`   [${m.index}] ${chalk.green(m.address)}  ${chalk.yellow((m.role || '').padEnd(12))}  ${(m.bound_biosamples.join(',') || chalk.gray('(none)'))}`);
    }
  }
  console.log('');
}
