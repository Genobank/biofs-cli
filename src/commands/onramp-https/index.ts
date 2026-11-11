/**
 * biofs onramp-https submit --owner <biowallet> --serial <biosample serial> --case-id <case id> --originlab <lab or source tag> --manifest <manifest.json> [--wait]
 * biofs onramp-https status <job> [--wait]
 *
 * CLIENT verb. biofs-node streams each public HTTPS object into the BioRouter vault under the owner biowallet (a custodial biowallet is claimable) and registers
 * its biocid in biocid_registry and bioroutes.inventory. No biodata passes through this machine and none is staged on the node disk. Every object in the manifest
 * carries the SHA-256 and byte size its source published; the node registers an object only when the streamed bytes reproduce both, otherwise it deletes the copy.
 * The node refuses non-https sources, credentials in a URL, redirects and hosts that resolve to private addresses. The caller must be a node operator or the owner.
 *
 * Manifest: {"objects": [{"url": "https://...", "sha256": "<64 hex>", "bytes": 123, "dataset": "optional name"}]}
 * (A source catalog works too: pass --base-url and --key-prefix, and each object with "key", "sha256", "bytes" becomes base-url/key.)
 */
import * as fs from 'fs';
import axios from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface OnrampHttpsObject { url: string; sha256: string; bytes: number; dataset?: string }
export interface OnrampHttpsOptions {
  owner: string; serial: string; caseId: string; originlab: string; manifest: string;
  baseUrl?: string; keyPrefix?: string; wait?: boolean; json?: boolean;
}

export function loadObjects(manifestPath: string, baseUrl?: string, keyPrefix?: string): OnrampHttpsObject[] {
  const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const list: any[] = Array.isArray(doc) ? doc : (doc.objects || []);
  const out: OnrampHttpsObject[] = [];
  for (const o of list) {
    let url: string = o.url || '';
    if (!url && o.key && baseUrl) {
      if (keyPrefix && !String(o.key).startsWith(keyPrefix)) continue;
      url = `${baseUrl.replace(/\/+$/, '')}/${String(o.key).split('/').map(encodeURIComponent).join('/')}`;
    }
    if (!url) continue;
    out.push(validateObject({ url, sha256: String(o.sha256 || ''), bytes: Number(o.bytes ?? o.size), dataset: o.dataset }));
  }
  if (out.length < 1 || out.length > 50) throw new Error(`the manifest selects ${out.length} objects; 1 to 50 are accepted`);
  return out;
}

export function validateObject(o: OnrampHttpsObject): OnrampHttpsObject {
  let u: URL;
  try { u = new URL(o.url); } catch { throw new Error(`not a url: ${o.url.slice(0, 80)}`); }
  if (u.protocol !== 'https:') throw new Error('only https sources are accepted');
  if (u.username || u.password) throw new Error('a url with credentials is never accepted');
  if (!/^[0-9a-f]{64}$/i.test(o.sha256)) throw new Error(`${u.pathname}: the published sha256 is required`);
  if (!Number.isInteger(o.bytes) || o.bytes <= 0) throw new Error(`${u.pathname}: the byte size is required`);
  return { url: u.toString(), sha256: o.sha256.toLowerCase(), bytes: o.bytes, dataset: o.dataset };
}

export function buildOnrampBody(o: OnrampHttpsOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(o.owner)) throw new Error('--owner must be an EIP-55 biowallet address');
  if (!o.serial || o.serial.toUpperCase() === 'UNKNOWN' || !/^[A-Za-z0-9._-]{1,64}$/.test(o.serial)) throw new Error('--serial must be the origin biosample serial (never UNKNOWN)');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(o.caseId)) throw new Error('--case-id must be a case identifier of letters, digits, _ or - (never a person name)');
  if (!/^[a-z0-9_-]{2,40}$/.test(o.originlab)) throw new Error('--originlab must be 2 to 40 lowercase letters, digits, _ or -');
  return { wallet, signature, owner: o.owner, serial: o.serial, case_id: o.caseId, originlab: o.originlab, objects: loadObjects(o.manifest, o.baseUrl, o.keyPrefix) };
}

async function auth() {
  const c = await getCredentials();
  if (!c) throw new Error('Not authenticated. Run "biofs login" first (an operator profile for a custodial biowallet).');
  return { wallet: c.wallet_address, signature: c.user_signature, headers: { 'X-Biofs-Wallet': c.wallet_address, 'X-Biofs-Signature': c.user_signature } };
}

async function fetchStatus(id: string, headers: Record<string, string>): Promise<any> {
  const r = await axios.get(`${BIOFS_NODE_BASE}/https_onramp_status`, { params: { onramp_job_id: id }, headers, timeout: 60_000, validateStatus: (s) => s < 500 });
  if (r.status >= 400) throw new Error(`status ${r.status}: ${r.data?.error || 'unknown'}`);
  return r.data;
}

function summary(row: any): void {
  console.log(`${chalk.cyan('Job:')}      ${row.onramp_job_id}  ${row.status}`);
  if (row.current) console.log(`${chalk.cyan('Now:')}      ${row.current.dataset} ${(row.current.bytes_done / 1e9).toFixed(2)} of ${(row.current.bytes_total / 1e9).toFixed(2)} GB at ${row.current.mb_per_s} MB/s`);
  console.log(`${chalk.cyan('Objects:')}  ${row.n_files || 0} of ${(row.objects || []).length || row.n_listed || '?'} verified and registered`);
  for (const f of row.files || []) console.log(`  ${f.biocid}`);
  if (row.error) console.log(`${chalk.red('Error:')}     ${row.error}`);
}

async function waitFor(id: string, headers: Record<string, string>, json?: boolean): Promise<void> {
  for (;;) {
    const row = await fetchStatus(id, headers);
    if (row.status === 'done' || row.status === 'failed') {
      if (json) console.log(JSON.stringify(row, null, 2)); else summary(row);
      if (row.status === 'failed') process.exit(1);
      return;
    }
    await new Promise((res) => setTimeout(res, 30_000));
  }
}

export async function onrampHttpsSubmitCommand(options: OnrampHttpsOptions): Promise<void> {
  try {
    const a = await auth();
    const body = buildOnrampBody(options, a.wallet, a.signature);
    const r = await axios.post(`${BIOFS_NODE_BASE}/submit_https_onramp`, body, { headers: a.headers, timeout: 60_000, validateStatus: (s) => s < 500 });
    if (r.status >= 400) throw new Error(`${r.status}: ${r.data?.error || 'unknown'}`);
    const id = r.data.onramp_job_id;
    if (!options.wait) {
      if (options.json) console.log(JSON.stringify(r.data, null, 2));
      else { console.log(chalk.green(`onramp_job_id=${id} status=${r.data.status} objects=${r.data.n_objects}`)); console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs onramp-https status ${id} --wait`)); }
      return;
    }
    await waitFor(id, a.headers, options.json);
  } catch (e: any) { Logger.error(`onramp-https submit failed: ${e.message}`); process.exit(1); }
}

export async function onrampHttpsStatusCommand(id: string, options: { wait?: boolean; json?: boolean }): Promise<void> {
  try {
    const a = await auth();
    if (options.wait) return await waitFor(id, a.headers, options.json);
    const row = await fetchStatus(id, a.headers);
    if (options.json) console.log(JSON.stringify(row, null, 2)); else summary(row);
  } catch (e: any) { Logger.error(`onramp-https status failed: ${e.message}`); process.exit(1); }
}
