/**
 * biofs upload <file> --biosample <serial> --originlab <lab> [--type bam|cram|fastq|vcf|gvcf] [--data-category dna|rna|cdna|other] [--lab-nft <serial>] [--chunk-mb 64] [--dry-run]
 *
 * Resumable upload straight into the owner's vault under the signer's wallet. The file is streamed from disk (never read whole into memory), md5 and sha256 are computed in one pass,
 * biofs-node opens a resumable GCS session (POST /agent/upload_session), the bytes go to GCS in chunks that can be resumed after any failure, and biofs-node then reads the object's
 * size and md5 back from GCS and registers the biocid in the inventory and the registry with the signer as owner (POST /agent/upload_complete).
 * The biosample serial and the lab of origin are required: lineage is never UNKNOWN. This replaces the removed /upload_dataset_chunk path.
 */
import axios from 'axios';
import chalk from 'chalk';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
const readAsync = promisify(fs.read);
import { getCredentials } from '../lib/auth/credentials';
import { nodeErrorMessage } from '../lib/utils/node_roles';

const BIOFS_NODE_BASE = () => process.env.BIOFS_NODE_URL || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;
export const CHUNK_MULTIPLE = 256 * 1024;
const KINDS = ['bam', 'cram', 'fastq', 'vcf', 'gvcf'];
const CATEGORIES = ['dna', 'rna', 'cdna', 'other'];
const PLACEHOLDER = /^(unknown|none|null|undefined|n\/a|na|tbd|test|todo|-+)$/i;

export interface UploadOptions {
  type?: string; biosample?: string; originlab?: string; dataCategory?: string; labNft?: string; chunkMb?: string | number; dryRun?: boolean; quiet?: boolean; owner?: string;
  tokenize?: boolean; shareWith?: string; public?: boolean;      // legacy flags, refused with a clear message
}

export function guessKind(file: string): string | null {
  const l = file.toLowerCase();
  if (l.endsWith('.bam')) return 'bam'; if (l.endsWith('.cram')) return 'cram';
  if (l.endsWith('.fastq.gz') || l.endsWith('.fq.gz') || l.endsWith('.fastq')) return 'fastq';
  if (l.endsWith('.g.vcf.gz') || l.endsWith('.gvcf.gz')) return 'gvcf';
  if (l.endsWith('.vcf') || l.endsWith('.vcf.gz')) return 'vcf';
  return null;
}

export function chunkBytes(chunkMb: string | number | undefined): number {
  const mb = chunkMb === undefined || chunkMb === '' ? 64 : Number(chunkMb);
  if (!Number.isFinite(mb) || mb < 1 || mb > 512) throw new Error('--chunk-mb must be between 1 and 512');
  return Math.floor((mb * 1024 * 1024) / CHUNK_MULTIPLE) * CHUNK_MULTIPLE;
}

export function validateUploadArgs(file: string, o: UploadOptions): { kind: string; biosample: string; originlab: string; category: string; chunk: number } {
  if (o.tokenize || o.shareWith || o.public) throw new Error('--tokenize, --share-with and --public are not part of the upload any more: upload first, then tokenize or share the registered biocid with its own verb');
  const kind = (o.type || guessKind(file) || '').toLowerCase();
  if (!KINDS.includes(kind)) throw new Error(`file type: pass --type with one of ${KINDS.join(', ')}`);
  const biosample = String(o.biosample || '').trim();
  if (!biosample || PLACEHOLDER.test(biosample)) throw new Error('--biosample <serial> is required: the origin sample serial from the lab (never UNKNOWN or a placeholder)');
  const originlab = String(o.originlab || '').trim().toLowerCase();
  if (!originlab || PLACEHOLDER.test(originlab)) throw new Error('--originlab <lab> is required: the lab of origin, for example signios (never UNKNOWN or a placeholder)');
  const category = String(o.dataCategory || 'dna').toLowerCase();
  if (!CATEGORIES.includes(category)) throw new Error(`--data-category must be one of ${CATEGORIES.join(', ')}`);
  return { kind, biosample, originlab, category, chunk: chunkBytes(o.chunkMb) };
}

export async function hashFile(file: string, onProgress?: (done: number) => void): Promise<{ md5: string; sha256: string; size: number }> {
  const md5 = crypto.createHash('md5'); const sha = crypto.createHash('sha256'); let size = 0;
  await new Promise<void>((resolve, reject) => {
    const s = fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 });
    s.on('data', (c: Buffer | string) => { const b = Buffer.isBuffer(c) ? c : Buffer.from(c); md5.update(b); sha.update(b); size += b.length; if (onProgress) onProgress(size); });
    s.on('end', () => resolve()); s.on('error', reject);
  });
  return { md5: md5.digest('hex'), sha256: sha.digest('hex'), size };
}

async function readChunk(fd: number, start: number, len: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(len); let off = 0;
  while (off < len) { const { bytesRead } = await readAsync(fd, buf, off, len - off, start + off); if (!bytesRead) break; off += bytesRead; }
  return off === len ? buf : buf.subarray(0, off);
}

// Ask GCS how much of the session it has already persisted (resumable protocol: an empty PUT with Content-Range bytes */total).
export async function persistedOffset(sessionUri: string, total: number): Promise<{ done: boolean; offset: number }> {
  const r = await axios.put(sessionUri, '', { headers: { 'Content-Length': '0', 'Content-Range': `bytes */${total}` }, validateStatus: (s) => [200, 201, 308].includes(s), maxBodyLength: Infinity });
  if (r.status === 200 || r.status === 201) return { done: true, offset: total };
  const range = String(r.headers['range'] || '');
  const m = /bytes=0-(\d+)/.exec(range);
  return { done: false, offset: m ? Number(m[1]) + 1 : 0 };
}

export async function putChunks(file: string, sessionUri: string, total: number, chunk: number, start: number, onProgress?: (n: number) => void, sleepMs = 2000): Promise<void> {
  const fd = fs.openSync(file, 'r');
  try {
    let offset = start; let attempts = 0;
    while (offset < total) {
      const len = Math.min(chunk, total - offset);
      const buf = await readChunk(fd, offset, len);
      const end = offset + buf.length - 1;
      try {
        const r = await axios.put(sessionUri, buf, { headers: { 'Content-Length': String(buf.length), 'Content-Range': `bytes ${offset}-${end}/${total}` }, validateStatus: (s) => [200, 201, 308].includes(s), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 10 * 60_000 });
        if (r.status === 200 || r.status === 201) offset = total;
        else { const m = /bytes=0-(\d+)/.exec(String(r.headers['range'] || '')); offset = m ? Number(m[1]) + 1 : offset; }
        attempts = 0;
      } catch (e: any) {
        if (++attempts > 6) throw new Error(`chunk at byte ${offset} failed after 6 attempts: ${e.message}`);
        await new Promise((res) => setTimeout(res, sleepMs * attempts));
        offset = (await persistedOffset(sessionUri, total)).offset;           // resume from what GCS really has
      }
      if (onProgress) onProgress(Math.min(offset, total));
    }
  } finally { fs.closeSync(fd); }
}

export async function uploadCommand(filePath: string, options: UploadOptions = {}): Promise<void> {
  const file = path.resolve(filePath);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`File not found: ${filePath}`);
  const a = validateUploadArgs(file, options);
  const quiet = !!options.quiet; const say = (s: string) => { if (!quiet) console.log(s); };
  const credentials = await getCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
  const filename = path.basename(file);
  say(chalk.cyan(`Hashing ${filename} (md5 and sha256, streamed)...`));
  const h = await hashFile(file);
  say(`  size ${h.size} bytes\n  md5 ${h.md5}\n  sha256 ${h.sha256}`);
  const owner = String(options.owner || credentials.wallet_address);
  if (options.dryRun) { say(chalk.yellow(`Dry run: would upload to the vault of ${owner} as lab ${a.originlab}, sample ${a.biosample}, ${a.kind}, ${a.category}, chunks of ${a.chunk} bytes. Nothing was sent.`)); return; }
  const headers = { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature };
  const body: Record<string, unknown> = { filename, kind: a.kind, size_bytes: h.size, md5: h.md5, sha256: h.sha256, biosample: a.biosample, originlab: a.originlab, data_category: a.category, owner };
  if (options.labNft) body.lab_nft_serial = options.labNft;
  const s = await axios.post(`${BIOFS_NODE_BASE()}/upload_session`, body, { headers, timeout: 60_000, validateStatus: (st) => st < 500 });
  if (s.status >= 400) throw new Error(nodeErrorMessage(s.status, s.data?.error));
  if (s.data.status === 'exists') { say(chalk.green(`Already registered: ${s.data.biocid}`)); return; }
  const stateFile = `${file}.biofs-upload.json`;
  say(chalk.cyan(`Uploading to ${s.data.bucket}/${s.data.object}`));
  let lastPct = -1;
  const progress = (n: number) => { const pct = Math.floor((100 * n) / h.size); if (!quiet && pct !== lastPct && pct % 5 === 0) { lastPct = pct; process.stdout.write(`  ${pct}%\r`); } };
  fs.writeFileSync(stateFile, JSON.stringify({ upload_id: s.data.upload_id, md5: h.md5, size: h.size, saved_at: new Date().toISOString() }));
  const start = (await persistedOffset(s.data.session_uri, h.size)).offset;
  await putChunks(file, s.data.session_uri, h.size, a.chunk, start, progress, Number(process.env.BIOFS_UPLOAD_RETRY_MS || 2000));
  const c = await axios.post(`${BIOFS_NODE_BASE()}/upload_complete`, { upload_id: s.data.upload_id }, { headers, timeout: 5 * 60_000, validateStatus: (st) => st < 500 });
  if (c.status >= 400) throw new Error(nodeErrorMessage(c.status, c.data?.error));
  try { fs.unlinkSync(stateFile); } catch (_) { /* state file already gone */ }
  say(chalk.green('\nUpload complete and registered.'));
  say(`  BioCID:  ${chalk.green(c.data.biocid)}\n  Owner:   ${c.data.owner_wallet}\n  Lab:     ${c.data.originlab}   Sample: ${c.data.biosample}\n  Object:  gs://${c.data.bucket}/${c.data.object}  (${c.data.size_bytes} bytes, md5 verified by the node)`);
}
