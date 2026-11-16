/**
 * biofs inventory-delegate <biocids...> --from <owner wallet> --to <new owner wallet> --attest "<basis>" [--operator <wallet...>] [--signature 0x..] [--nonce n --expires iso] [--yes]
 *
 * OWNERSHIP DELEGATION by signature. The current owner (a MetaMask wallet) signs one personal_sign message that hands the named biofiles to a new owner wallet while naming the operator
 * wallet(s) that keep the right to run bioinformatics pipelines on them and deliver the results into the new owner's tree. Two steps, one verb:
 *   1. without --signature: prints the exact message (and saves it) plus the nonce and expiry; nothing is sent.
 *   2. with --signature (the MetaMask personal_sign result), --nonce and --expires from step 1: biofs-node (POST /agent/inventory_delegate) rebuilds the same message, recovers the signer,
 *      and moves a row only when its present owner is that signer. Dry run unless --yes. Ownerless rows are refused, never given an owner. Previous values are kept (claim_prev).
 * A thin client: the message builder below must stay byte-identical to the node's src/lib/inventory_delegate.js (test vectors in both repos).
 */
import axios from 'axios';
import chalk from 'chalk';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCredentials } from '../../lib/auth/credentials';
import { nodeErrorMessage } from '../../lib/utils/node_roles';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;
const BIOCID_RE = /^biocid:\/\/[A-Za-z0-9_-]+\/0x[0-9a-fA-F]{40}\/[A-Za-z0-9_-]+\/\S+$/;
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

export interface DelegateOptions {
  from: string;
  to: string;
  attest: string;
  operator?: string[];
  signature?: string;
  nonce?: string;
  expires?: string;
  expiresHours?: string;
  yes?: boolean;
  json?: boolean;
}

export interface DelegationFields {
  from: string; to: string; operators: string[]; biocids: string[]; attestation: string; nonce: string; expires: string;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const lc = (s: string): string => String(s || '').toLowerCase();
export const biocidsDigest = (biocids: string[]): string => sha256([...biocids].sort().join('\n'));
export const attestationDigest = (text: string): string => sha256(String(text || '').replace(/\s+/g, ' ').trim());

export function buildMessage(f: DelegationFields): string {
  const ops = [...new Set(f.operators.map(lc))].sort().join(', ');
  return [
    'GenoBank.io ownership delegation v1',
    'Action: hand ownership of the listed biofiles to the new owner; the named operators keep the right to run pipelines on them and deliver results to the new owner',
    `From owner: ${lc(f.from)}`,
    `To owner: ${lc(f.to)}`,
    `Operators retained: ${ops}`,
    `Files: ${f.biocids.length}`,
    `Files digest (sha256 of the sorted biocids, one per line): ${biocidsDigest(f.biocids)}`,
    `Attestation digest (sha256): ${attestationDigest(f.attestation)}`,
    `Nonce: ${f.nonce}`,
    `Expires: ${f.expires}`,
  ].join('\n');
}

export function buildFields(biocids: string[], o: DelegateOptions, callerWallet: string, nowMs: number): DelegationFields {
  if (!biocids.length) throw new Error('give at least one biocid');
  if (biocids.length > 50) throw new Error('at most 50 biocids per delegation');
  if (new Set(biocids).size !== biocids.length) throw new Error('duplicate biocids');
  for (const b of biocids) if (!BIOCID_RE.test(b)) throw new Error(`not a biocid (a gs:// path, URL or file name is never accepted): ${b}`);
  if (!WALLET_RE.test(o.from || '')) throw new Error('--from must be the current owner\'s wallet (0x plus 40 hex)');
  if (!WALLET_RE.test(o.to || '')) throw new Error('--to must be the new owner\'s wallet (0x plus 40 hex)');
  if (lc(o.from) === lc(o.to)) throw new Error('--from and --to are the same wallet');
  const attestation = String(o.attest || '').replace(/\s+/g, ' ').trim();
  if (attestation.length < 20 || attestation.length > 600) throw new Error('--attest needs 20 to 600 characters: the basis on which the owner hands these files over');
  const operators = (o.operator && o.operator.length ? o.operator : [o.from, callerWallet]).filter(Boolean);
  for (const w of operators) if (!WALLET_RE.test(w)) throw new Error(`--operator is not a wallet: ${w}`);
  const nonce = o.nonce || randomBytes(16).toString('hex');
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error('--nonce must be 32 lowercase hex characters');
  let expires = o.expires;
  if (!expires) {
    const h = o.expiresHours === undefined ? 24 : parseFloat(o.expiresHours);
    if (!Number.isFinite(h) || h <= 0 || h > 168) throw new Error('--expires-hours must be between 0 and 168 (7 days)');
    expires = new Date(nowMs + Math.round(h * 3600 * 1000)).toISOString();
  }
  return { from: o.from, to: o.to, operators, biocids, attestation, nonce, expires };
}

export function buildDelegateBody(f: DelegationFields, signature: string, yes: boolean): Record<string, unknown> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('--signature must be the personal_sign result (0x plus 130 hex characters)');
  return { biocids: f.biocids, from: f.from, to: f.to, operators: f.operators, attestation: f.attestation, nonce: f.nonce, expires: f.expires, signature, dry_run: !yes };
}

export async function inventoryDelegateCommand(biocids: string[], options: DelegateOptions): Promise<void> {
  const credentials = await getCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
  if (options.signature && !(options.nonce && options.expires)) throw new Error('with --signature give the --nonce and --expires printed by the first step (they are part of what was signed)');
  const f = buildFields(biocids, options, credentials.wallet_address, Date.now());
  const message = buildMessage(f);

  if (!options.signature) {
    const dir = path.join(os.homedir(), '.biofs', 'delegations');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${f.nonce}.txt`);
    fs.writeFileSync(file, message + '\n', { mode: 0o600 });
    console.log(chalk.bold('Step 1 of 2. Nothing was sent. Sign this exact message with personal_sign in the wallet of the current owner (MetaMask):'));
    console.log('');
    console.log(message);
    console.log('');
    console.log(chalk.gray(`Saved to ${file}. It is valid until ${f.expires}; the nonce can be used once.`));
    console.log(chalk.bold('Step 2: send it (dry run first, then add --yes):'));
    console.log(`  biofs inventory-delegate ${biocids.join(' ')} --from ${f.from} --to ${f.to} --operator ${f.operators.join(' ')} --attest "${f.attestation}" --nonce ${f.nonce} --expires ${f.expires} --signature <0x...>`);
    return;
  }

  const body = buildDelegateBody(f, options.signature, !!options.yes);
  const headers = { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature };
  const r = await axios.post(`${BIOFS_NODE_BASE}/inventory_delegate`, body, { headers, timeout: 60_000, validateStatus: (s) => s < 500 });
  if (r.status >= 400) throw new Error(nodeErrorMessage(r.status, r.data?.error));
  if (options.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
  const d = r.data;
  console.log(chalk.bold(d.dry_run ? 'Dry run: nothing was written. Add --yes to delegate.' : 'Delegated.'));
  for (const x of d.delegated || []) console.log(chalk.green(`  ${d.dry_run ? 'would delegate' : 'delegated'}  ${x.biocid}  ${x.previous_owner} -> ${x.new_owner}${x.registry_row ? '  (registry row too)' : ''}`));
  for (const x of d.exists || []) console.log(chalk.gray(`  already owned by the new owner  ${x}`));
  for (const x of d.errors || []) console.log(chalk.red(`  refused  ${x.biocid}: ${x.reason}`));
  if (d.refused_all) console.log(chalk.red('  Nothing was written: one refused file stops the whole delegation.'));
  if ((d.errors || []).length) process.exitCode = 1;
}
