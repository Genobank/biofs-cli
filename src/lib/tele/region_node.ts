/**
 * One region of an owned, indexed BAM or bgzipped VCF, cut by biofs-node (GET /agent/region_read, 20 November 2026) instead of the whole file the htsget facade returns.
 * The node checks the signer against the registry row and consent, cuts the region on its read-only mounts with the index beside the object (samtools view -b -h -X,
 * bcftools view -r -Oz) and streams a valid file of the same format with its header. The HTTP status is checked before any byte reaches a local tool, so a refusal prints
 * the node's reason instead of feeding an error body into bcftools or samtools.
 */
import axios from 'axios';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { getCredentials } from '../auth/credentials';

export const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;
const REGION_RE = /^[A-Za-z0-9_.-]{1,64}:[\d,]+-[\d,]+$/;

/** A region read goes through biofs-node when the id is a biocid and the region names a start and an end (a bare contig still uses htsget). */
export function nodeRegionEligible(id: string, region?: string): boolean {
  return !!region && /^biocid:\/\//i.test(String(id || '')) && REGION_RE.test(region.trim());
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** The node's response stream for one region, or an error carrying the node's status and reason. */
export async function openNodeRegion(biocid: string, region: string, base = BIOFS_NODE_BASE): Promise<{ stream: Readable; format: string; region: string }> {
  const creds = await getCredentials();
  if (!creds?.wallet_address || !creds?.user_signature) throw new Error('Not authenticated. Run: biofs login');
  const r = await axios.get(`${base}/region_read`, {
    params: { biocid, region: region.trim() },
    headers: { 'X-Biofs-Wallet': creds.wallet_address, 'X-Biofs-Signature': creds.user_signature },
    responseType: 'stream', timeout: 0, maxContentLength: Infinity, maxBodyLength: Infinity, validateStatus: () => true,
  });
  if (r.status !== 200) {
    const body = await readAll(r.data as Readable);
    let msg = body.slice(0, 300);
    try { msg = JSON.parse(body).error || msg; } catch { /* not JSON */ }
    throw new Error(`biofs-node region_read refused (${r.status}): ${msg}`);
  }
  return { stream: r.data as Readable, format: String(r.headers['x-format'] || ''), region: String(r.headers['x-region'] || region) };
}

/** Pipe the node's region into a local tool's stdin; resolves with the tool's exit code. */
export async function pipeNodeRegionToCommand(biocid: string, region: string, command: string, args: string[], opts: { quiet?: boolean; label?: string } = {}): Promise<number> {
  const { stream, format, region: cut } = await openNodeRegion(biocid, region);
  if (!opts.quiet) process.stderr.write(`${opts.label || `pipe → ${command} ${args.slice(0, 4).join(' ')}`} ← biofs-node region_read ${format} ${cut}\n`);
  return new Promise((resolve, reject) => {
    const tool = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'] });
    tool.stdin!.on('error', () => { /* the tool closed its input early (head, -c): not an error of the stream */ });
    stream.on('error', (e) => { tool.kill(); reject(e); });
    tool.on('error', reject);
    tool.on('exit', (code) => resolve(code ?? 0));
    stream.pipe(tool.stdin!);
  });
}

/** Write the node's region to stdout (binary safe). */
export async function streamNodeRegionToStdout(biocid: string, region: string, opts: { quiet?: boolean } = {}): Promise<void> {
  const { stream, format, region: cut } = await openNodeRegion(biocid, region);
  if (!opts.quiet) process.stderr.write(`stream: biofs-node region_read ${format} ${cut}\n`);
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.on('end', () => resolve());
    stream.pipe(process.stdout);
  });
}
