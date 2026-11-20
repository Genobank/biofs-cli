/**
 * biofs register-derived gcs <gs-uri> --type <biodata type> --parent <biocid...> [--case-id <id>] [--filename <name>] [--category dna|rna|clinical]
 *
 * CLIENT verb. Gives a biocid, with lineage, to a job output that already sits in the signer's own GCS prefix
 * (gs://genobank-parabricks-output/biowallet/<owner>/... or gs://genobank-vault/<owner>/...). biofs-node hashes the object on
 * the server and registers it IN PLACE in biorouter.biocid_registry and bioroutes.inventory; no byte moves and none reaches this
 * client. Every parent biocid must be owned by the signer and not revoked or erased. The node refuses an object outside the
 * signer's own prefix. Route: POST /api_biofs_node/register_derived_gcs.
 */
import axios from 'axios';
import * as crypto from 'crypto';
import * as fs from 'fs';
import chalk from 'chalk';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface RegisterDerivedGcsOptions {
  type: string;
  parent: string[];
  caseId?: string;
  filename?: string;
  category?: string;
  json?: boolean;
}

const BIOCID_RE = /^biocid(:\/\/|:)[A-Za-z0-9_-]+\/0x[0-9a-fA-F]{40}\/[A-Za-z0-9_-]+\/\S+$/i;

export function buildRegisterDerivedGcsBody(gcsUri: string, o: RegisterDerivedGcsOptions): Record<string, unknown> {
  if (!/^gs:\/\/[a-z0-9._-]+\/[^\s]+$/.test(gcsUri)) throw new Error('the argument must be a gs:// object URI inside your own biowallet prefix');
  if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(o.type || '')) throw new Error('--type must be lowercase letters, digits, - or _ (for example vcf, annotation, report)');
  const parents = (o.parent || []).map((p) => p.trim()).filter(Boolean);
  if (parents.length < 1 || parents.length > 8) throw new Error('--parent: 1 to 8 parent biocids are required (a derived biofile always carries its lineage)');
  for (const p of parents) if (!BIOCID_RE.test(p)) throw new Error(`--parent "${p}" is not a biocid`);
  const filename = o.filename || gcsUri.split('/').pop() || '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(filename)) throw new Error('--filename has unsupported characters');
  if (o.caseId && !/^[A-Za-z0-9_-]{1,64}$/.test(o.caseId)) throw new Error('--case-id must be a case identifier (never a person name)');
  if (o.category && !/^(dna|rna|clinical|imaging|protein)$/.test(o.category)) throw new Error('--category must be dna, rna, clinical, imaging or protein');
  return { gcs_uri: gcsUri, filename, biodata_type: o.type, parent_biocids: parents, case_id: o.caseId || '', data_category: o.category || 'dna' };
}

export async function registerDerivedGcsCommand(gcsUri: string, options: RegisterDerivedGcsOptions): Promise<void> {
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const body = buildRegisterDerivedGcsBody(gcsUri, options);
    const r = await axios.post(`${BIOFS_NODE_BASE}/register_derived_gcs`, body, {
      headers: { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature },
      timeout: 660_000,
      validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) throw new Error(`${r.status}: ${r.data?.error || 'unknown'}`);
    if (options.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
    console.log(chalk.green(`registered ${r.data.biocid}`));
    console.log(`  sha256 ${r.data.sha256}  size ${r.data.size}  consent ${r.data.consent_status}`);
  } catch (e: any) {
    Logger.error(`register-derived gcs failed: ${e.message}`);
    process.exit(1);
  }
}

export function validateReadArgs(biocid: string, out?: string): void {
  if (!BIOCID_RE.test(biocid || '')) throw new Error('the argument must be a biocid (biocid://<bioagent>/<owner wallet>/<biodata type>/<dataset>)');
  if (out && !/^[^\0]+$/.test(out)) throw new Error('--out must be a file path');
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Read a small derived biofile of your own back through biofs-node (owner match, consent not revoked, 5 MB cap, SHA-256 checked by the node);
 *  the bytes are checked here against the node's X-Sha256 header before anything is written. Primary biodata is never served this way. */
/** The bytes of a small derived biofile (a job report, a table, a stats file) through biofs-node: the node checks owner or operator, consent, the 5 MB cap and the
 *  registered SHA-256; the bytes are checked again here against the node's X-Sha256 header. Throws with the node's status and message on any refusal. */
export async function fetchDerivedBytes(biocid: string): Promise<{ body: Buffer; sha256: string }> {
  if (!BIOCID_RE.test(biocid || '')) throw new Error('not a biocid');
  const credentials = await getCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
  const r = await axios.get(`${BIOFS_NODE_BASE}/derived_read`, {
    params: { biocid },
    headers: { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature },
    timeout: 120_000, responseType: 'arraybuffer', validateStatus: (s) => s < 500,
  });
  if (r.status >= 400) throw new Error(`${r.status}: ${Buffer.from(r.data).toString('utf8').slice(0, 200)}`);
  const body = Buffer.from(r.data);
  const got = sha256Hex(body);
  const want = String(r.headers['x-sha256'] || '');
  if (!want) throw new Error('the node sent no X-Sha256: refusing to trust unverified bytes');
  if (got !== want) throw new Error(`SHA-256 mismatch: node says ${want}, received ${got}`);
  return { body, sha256: got };
}

export async function readDerivedCommand(biocid: string, options: { out?: string }): Promise<void> {
  try {
    validateReadArgs(biocid, options.out);
    const { body, sha256: got } = await fetchDerivedBytes(biocid);
    if (options.out) {
      fs.writeFileSync(options.out, body, { mode: 0o600 });
      console.log(`${chalk.green('saved')} ${options.out}  sha256 ${got}  ${body.length} bytes`);
    } else {
      process.stdout.write(body.toString('utf8'));
    }
  } catch (e: any) {
    Logger.error(`register-derived read failed: ${e.message}`);
    process.exit(1);
  }
}
