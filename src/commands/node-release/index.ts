/**
 * biofs node-release plan|submit|status <spec.json | release id>
 *
 * NODE OPERATOR verb: a governed code release of biofs-node and its worker agents (biofs-node POST /agent/node_release, 19 November 2026). The spec names the git commit, a
 * note, and per host (a VM name) its install root, its service and its files: each file's path under the root, the SHA-256 it replaces (null for a new file) and the local
 * file holding its new bytes. The CLI builds the manifest (file bytes are carried by their SHA-256), signs it with a node admin key (EIP-191 over
 * "biofs-node release:v1:<release_id>:<manifest sha256>") and, with --yes, sends it. The node checks the signer and every byte, then checks every host, installs one host at
 * a time (itself last) through each host's root applier, which verifies the signature and the hashes again, and seals the release record for anchoring. Nothing installs
 * unless every host holds exactly the files the release replaces.
 */
import axios from 'axios';
import chalk from 'chalk';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import { getCredentials } from '../../lib/auth/credentials';
import { nodeErrorMessage } from '../../lib/utils/node_roles';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;
export const RELEASE_SCHEMA = 'biofs-node-release/1';
const RELEASE_ID_RE = /^[a-z0-9][a-z0-9-]{3,63}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export interface ReleaseSpecFile { path: string; old_sha256: string | null; source: string }
export interface ReleaseSpecTarget { host: string; root: string; service: string; files: ReleaseSpecFile[] }
export interface ReleaseSpec { release_id: string; source_commit: string; note: string; targets: ReleaseSpecTarget[] }
export interface Release { manifest: Record<string, any>; contents: Record<string, string>; sha256: string }

/** The canonical JSON every host hashes (Python: json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)); the manifest is ASCII only. */
export function canonical(v: unknown): string {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isInteger(v)) throw new Error('a release manifest carries no fractional numbers'); return JSON.stringify(v); }
  if (typeof v === 'string') {
    if (!/^[\x20-\x7e]*$/.test(v)) throw new Error(`a release manifest is printable ASCII only: ${JSON.stringify(v).slice(0, 60)}`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${canonical(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  throw new Error(`cannot put a ${typeof v} in a release manifest`);
}

export function manifestSha256(m: Record<string, any>): string {
  return crypto.createHash('sha256').update(canonical(m), 'ascii').digest('hex');
}

export function releaseMessage(m: Record<string, any>): string {
  return `biofs-node release:v1:${m.release_id}:${manifestSha256(m)}`;
}

export function buildRelease(spec: ReleaseSpec, baseDir: string, read: (p: string) => Buffer = (p) => fs.readFileSync(p)): Release {
  if (!spec || !RELEASE_ID_RE.test(String(spec.release_id))) throw new Error('release_id must be 4 to 64 of a-z, 0-9 and -');
  if (!/^[0-9a-f]{7,40}$/.test(String(spec.source_commit))) throw new Error('source_commit must be the git commit the files come from');
  if (!Array.isArray(spec.targets) || !spec.targets.length) throw new Error('targets must list the hosts');
  const contents: Record<string, string> = {};
  const targets = spec.targets.map((t) => {
    if (!t || !Array.isArray(t.files) || !t.files.length) throw new Error('every target needs files');
    return {
      host: t.host, root: t.root, service: t.service,
      files: t.files.map((f) => {
        if (!(f.old_sha256 === null || SHA_RE.test(String(f.old_sha256)))) throw new Error(`${t.host} ${f.path}: old_sha256 must be a sha256 or null`);
        const raw = read(path.resolve(baseDir, f.source));
        const h = crypto.createHash('sha256').update(raw).digest('hex');
        if (h === f.old_sha256) throw new Error(`${t.host} ${f.path}: the new file is the file it replaces`);
        contents[h] = raw.toString('base64');
        return { path: f.path, old_sha256: f.old_sha256, new_sha256: h };
      }),
    };
  });
  const manifest = { schema: RELEASE_SCHEMA, release_id: spec.release_id, source_commit: spec.source_commit, note: String(spec.note || ''), targets };
  return { manifest, contents, sha256: manifestSha256(manifest) };
}

export function loadKey(file: string): string {
  const text = fs.readFileSync(file, 'utf8').trim();
  let key = text;
  try { const j = JSON.parse(text); key = j.private_key || j.privateKey || ''; } catch (_) { /* a bare hex key */ }
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${file} holds no private key`);
  return key.startsWith('0x') ? key : `0x${key}`;
}

function readSpec(specPath: string): ReleaseSpec {
  return JSON.parse(fs.readFileSync(specPath, 'utf8'));
}

function printPlan(rel: Release, signer?: string): void {
  console.log(chalk.bold(`release ${rel.manifest.release_id}  manifest sha256 ${rel.sha256}`));
  console.log(`  source commit ${rel.manifest.source_commit}${signer ? `  signed by ${signer}` : ''}`);
  if (rel.manifest.note) console.log(`  note: ${rel.manifest.note}`);
  for (const t of rel.manifest.targets) {
    console.log(chalk.cyan(`  ${t.host}  ${t.root}  restarts ${t.service}`));
    for (const f of t.files) console.log(`    ${f.path}  ${f.old_sha256 ? f.old_sha256.slice(0, 12) : '(new file)'} -> ${f.new_sha256.slice(0, 12)}`);
  }
}

export async function nodeReleasePlan(specPath: string, options: { json?: boolean }): Promise<void> {
  const rel = buildRelease(readSpec(specPath), path.dirname(path.resolve(specPath)));
  if (options.json) { console.log(JSON.stringify({ manifest: rel.manifest, manifest_sha256: rel.sha256 }, null, 2)); return; }
  printPlan(rel);
}

export async function nodeReleaseSubmit(specPath: string, options: { keyFile: string; yes?: boolean; json?: boolean }): Promise<void> {
  const rel = buildRelease(readSpec(specPath), path.dirname(path.resolve(specPath)));
  const wallet = new ethers.Wallet(loadKey(options.keyFile));
  const signature = await wallet.signMessage(releaseMessage(rel.manifest));
  if (!options.yes) {
    printPlan(rel, wallet.address);
    console.log(chalk.bold('Dry run: nothing was sent. Add --yes to send the release to biofs-node.'));
    return;
  }
  const credentials = await getCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "BIOFS_PROFILE=operator biofs login" first.');
  const headers = { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature };
  const r = await axios.post(`${BIOFS_NODE_BASE}/node_release`, { manifest: rel.manifest, signature, contents: rel.contents },
    { headers, timeout: 180_000, maxBodyLength: 40 * 1024 * 1024, validateStatus: (s) => s < 500 });
  if (r.status >= 400) throw new Error(nodeErrorMessage(r.status, r.data?.error));
  if (options.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
  console.log(chalk.green(`release ${r.data.release_id} accepted (${r.data.status}); manifest ${r.data.manifest_sha256}, signed by ${r.data.signer}`));
  console.log(`  follow it: biofs node-release status ${r.data.release_id}`);
}

export async function nodeReleaseStatus(id: string, options: { json?: boolean }): Promise<void> {
  if (!RELEASE_ID_RE.test(id)) throw new Error('give a release id');
  const credentials = await getCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "BIOFS_PROFILE=operator biofs login" first.');
  const headers = { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature };
  const r = await axios.get(`${BIOFS_NODE_BASE}/node_release_status?id=${encodeURIComponent(id)}`, { headers, timeout: 60_000, validateStatus: (s) => s < 500 });
  if (r.status >= 400) throw new Error(nodeErrorMessage(r.status, r.data?.error));
  const d = r.data;
  if (options.json) { console.log(JSON.stringify(d, null, 2)); return; }
  console.log(chalk.bold(`release ${d.release_id}: ${d.status}${d.error ? `  (${d.error})` : ''}`));
  for (const [host, h] of Object.entries<any>(d.hosts || {})) {
    console.log(`  ${host}: check ${h.check?.status || '-'}, install ${h.install?.status || '-'}${h.install?.reason ? `  (${h.install.reason})` : ''}`);
  }
  for (const e of (d.events || []).slice(-8)) console.log(chalk.gray(`  ${new Date(e.at * 1000).toISOString()}  ${e.text}`));
  if (d.anchor_job) console.log(`  sealed as job ${d.anchor_job}; record ${d.record_object} (sha256 ${String(d.record_sha256).slice(0, 12)})`);
}
