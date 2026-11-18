/**
 * biofs reference-register [biocid...] --attest "<source and basis>" [--yes] [--json]
 *
 * NODE OPERATOR verb. Writes the biocid_registry rows of the public reference datasets of the pbrun reference catalog: a genome with its index files, known-sites VCFs, a capture
 * design. Each biocid is an alias of a catalog entry pinned to the MD5 of every one of its objects; the node reads each object's metadata from the bucket and refuses a dataset
 * whose bytes are not the pinned bytes. Rows are owned by the catalog's reference custodian with consent "public_reference", so any job may read them and none of them can carry
 * a person's biodata. With no biocid every catalog dataset is planned. A dry run is the default and lists the biocids; --yes writes.
 * A thin client: biofs-node (POST /agent/reference_register) checks the signer is a node operator, reads the bucket and the registry, and writes only what it validates.
 */
import axios from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../../lib/auth/credentials';
import { nodeErrorMessage } from '../../lib/utils/node_roles';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;
const BIOCID_RE = /^biocid:\/\/genobank\/0x[0-9a-fA-F]{40}\/[a-z0-9-]+\/[A-Za-z0-9._-]+$/;

export interface ReferenceRegisterOptions {
  attest: string;
  yes?: boolean;
  json?: boolean;
}

export function buildReferenceRegisterBody(biocids: string[], options: ReferenceRegisterOptions): Record<string, unknown> {
  for (const b of biocids) if (!BIOCID_RE.test(b)) throw new Error(`not the biocid of a reference dataset (a gs:// path, URL or file name is never accepted): ${b}`);
  const attestation = String(options.attest || '').replace(/\s+/g, ' ').trim();
  if (attestation.length < 20) throw new Error('--attest needs at least 20 characters: the source of these reference datasets and on what basis GenoBank.io holds them');
  return { biocids, attestation, dry_run: !options.yes };
}

export async function referenceRegisterCommand(biocids: string[], options: ReferenceRegisterOptions): Promise<void> {
  const body = buildReferenceRegisterBody(biocids || [], options);
  const credentials = await getCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
  const headers = { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature };
  const r = await axios.post(`${BIOFS_NODE_BASE}/reference_register`, body, { headers, timeout: 120_000, validateStatus: (s) => s < 500 });
  if (r.status >= 400) throw new Error(nodeErrorMessage(r.status, r.data?.error));
  if (options.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
  const d = r.data;
  console.log(chalk.bold(d.dry_run ? 'Dry run: nothing was written. Add --yes to register.' : 'Registered.'));
  console.log(`  custodian ${d.custodian}  catalog sha256 ${d.registry_sha256}`);
  for (const x of d.registered || []) console.log(chalk.green(`  ${d.dry_run ? 'would register' : 'registered'}  ${x.biocid}  ${x.biodata_type}  ${x.file_size} bytes  +${x.companions} index files`));
  for (const x of d.exists || []) console.log(`  already registered  ${x}`);
  for (const x of d.errors || []) console.log(chalk.red(`  refused  ${x.biocid}: ${x.reason}`));
  if ((d.errors || []).length) process.exitCode = 1;
}
