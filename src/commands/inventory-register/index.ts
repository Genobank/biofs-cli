/**
 * biofs inventory-register [biocid...] [--object <bucket/path...> [--lab L] [--serial S] [--type T]] --attest "<basis>" [--yes] [--json]
 *
 * NODE OPERATOR verb. Copies file rows that already sit in bioroutes.inventory into biocid_registry, the table jobs resolve their inputs through. Ownership is never changed: the
 * registry row carries the inventory row's own owner. The rows are marked consent "custodian" and carry the operator's attestation. A dry run is the default; --yes writes.
 * --object names an inventory row that has no biocid yet by its bucket and object path (bucket/path or gs://bucket/path, only to select the row): the node mints the biocid from the row's
 * owner, the vendor folder of the path (or --lab), the file type and the file name, sets the sample serial from the casefile folder (or --serial), registers it, and writes the biocid back to the
 * inventory row where it had none. The owner is read from the row, never from the request.
 * A thin client: biofs-node (POST /agent/inventory_register) checks the signer is a node operator, reads both tables and writes only what it validates.
 */
import axios from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../../lib/auth/credentials';
import { nodeErrorMessage } from '../../lib/utils/node_roles';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;
const BIOCID_RE = /^biocid:\/\/[A-Za-z0-9_-]+\/0x[0-9a-fA-F]{40}\/[A-Za-z0-9_-]+\/\S+$/;

export interface InventoryRegisterOptions {
  attest: string;
  yes?: boolean;
  json?: boolean;
  object?: string[];
  lab?: string;
  serial?: string;
  type?: string;
}

// bucket/path/to/file or gs://bucket/path/to/file; the storage location only selects an inventory row, it is never used as the way to read the file
export function parseObjectArg(arg: string): { bucket: string; object: string } {
  const m = /^(?:gs:\/\/)?([a-z0-9][a-z0-9._-]{2,62})\/(.+)$/.exec(String(arg || '').trim());
  if (!m || m[2].startsWith('/') || m[2].split('/').some((x) => x === '' || x === '..')) throw new Error(`not a bucket/object path: ${arg}`);
  return { bucket: m[1], object: m[2] };
}

export function buildInventoryRegisterBody(biocids: string[], options: InventoryRegisterOptions): Record<string, unknown> {
  const objectArgs = options.object || [];
  if (!biocids.length && !objectArgs.length) throw new Error('give at least one biocid or --object');
  for (const b of biocids) if (!BIOCID_RE.test(b)) throw new Error(`not a biocid (a gs:// path, URL or file name is never accepted here; use --object to select an inventory row that has no biocid): ${b}`);
  if (!objectArgs.length && (options.lab || options.serial || options.type)) throw new Error('--lab, --serial and --type apply to --object rows only');
  const attestation = String(options.attest || '').replace(/\s+/g, ' ').trim();
  if (attestation.length < 20) throw new Error('--attest needs at least 20 characters: the basis on which GenoBank.io holds and uses these files');
  const objects = objectArgs.map((a) => {
    const o: Record<string, string> = parseObjectArg(a);
    if (options.lab) o.lab = options.lab;
    if (options.serial) o.serial = options.serial;
    if (options.type) o.type = options.type;
    return o;
  });
  return objects.length ? { biocids, objects, attestation, dry_run: !options.yes } : { biocids, attestation, dry_run: !options.yes };
}

export async function inventoryRegisterCommand(biocids: string[], options: InventoryRegisterOptions): Promise<void> {
  const body = buildInventoryRegisterBody(biocids, options);
  const credentials = await getCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
  const headers = { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature };
  const r = await axios.post(`${BIOFS_NODE_BASE}/inventory_register`, body, { headers, timeout: 60_000, validateStatus: (s) => s < 500 });
  if (r.status >= 400) throw new Error(nodeErrorMessage(r.status, r.data?.error));
  if (options.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
  const d = r.data;
  console.log(chalk.bold(d.dry_run ? 'Dry run: nothing was written. Add --yes to register.' : 'Registered.'));
  for (const x of d.registered || []) console.log(chalk.green(`  ${d.dry_run ? 'would register' : 'registered'}  ${x.biocid}  owner ${x.owner_wallet}  ${x.file_size} bytes`));
  for (const x of d.exists || []) console.log(chalk.gray(`  already registered  ${x}`));
  for (const x of d.minted || []) console.log(chalk.cyan(`  ${d.dry_run ? 'would mint' : 'minted'}  ${x.biocid}  serial ${x.sample_serial || 'none'}  from ${x.object}`));
  for (const x of d.errors || []) console.log(chalk.red(`  refused  ${x.biocid || x.object}: ${x.reason}`));
  if ((d.errors || []).length) process.exitCode = 1;
}
