/**
 * biofs inventory-register <biocid...> --attest "<basis>" [--yes] [--json]
 *
 * NODE OPERATOR verb. Copies file rows that already sit in bioroutes.inventory into biocid_registry, the table jobs resolve their inputs through. Ownership is never changed: the
 * registry row carries the inventory row's own owner. The rows are marked consent "custodian" and carry the operator's attestation. A dry run is the default; --yes writes.
 * A thin client: biofs-node (POST /agent/inventory_register) checks the signer is a node operator, reads both tables and writes only what it validates.
 */
import axios from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../../lib/auth/credentials';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;
const BIOCID_RE = /^biocid:\/\/[A-Za-z0-9_-]+\/0x[0-9a-fA-F]{40}\/[A-Za-z0-9_-]+\/\S+$/;

export interface InventoryRegisterOptions {
  attest: string;
  yes?: boolean;
  json?: boolean;
}

export function buildInventoryRegisterBody(biocids: string[], options: InventoryRegisterOptions): Record<string, unknown> {
  if (!biocids.length) throw new Error('give at least one biocid');
  for (const b of biocids) if (!BIOCID_RE.test(b)) throw new Error(`not a biocid (a gs:// path, URL or file name is never accepted): ${b}`);
  const attestation = String(options.attest || '').replace(/\s+/g, ' ').trim();
  if (attestation.length < 20) throw new Error('--attest needs at least 20 characters: the basis on which GenoBank.io holds and uses these files');
  return { biocids, attestation, dry_run: !options.yes };
}

export async function inventoryRegisterCommand(biocids: string[], options: InventoryRegisterOptions): Promise<void> {
  const body = buildInventoryRegisterBody(biocids, options);
  const credentials = await getCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
  const headers = { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature };
  const r = await axios.post(`${BIOFS_NODE_BASE}/inventory_register`, body, { headers, timeout: 60_000, validateStatus: (s) => s < 500 });
  if (r.status >= 400) throw new Error(`${r.status}: ${r.data?.error || 'unknown'}`);
  if (options.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
  const d = r.data;
  console.log(chalk.bold(d.dry_run ? 'Dry run: nothing was written. Add --yes to register.' : 'Registered.'));
  for (const x of d.registered || []) console.log(chalk.green(`  ${d.dry_run ? 'would register' : 'registered'}  ${x.biocid}  owner ${x.owner_wallet}  ${x.file_size} bytes`));
  for (const x of d.exists || []) console.log(chalk.gray(`  already registered  ${x}`));
  for (const x of d.errors || []) console.log(chalk.red(`  refused  ${x.biocid}: ${x.reason}`));
  if ((d.errors || []).length) process.exitCode = 1;
}
