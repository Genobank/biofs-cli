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

/** A biocid read with no region: the node streams the exact bytes of the owner's own registered BAM, VCF or BCF (20 November 2026), owner and consent checked. */
export function nodeWholeEligible(id: string, region?: string): boolean {
  return !region && /^biocid:\/\//i.test(String(id || ''));
}

/** Open a whole-file read at the node, or null when the node does not serve it (404: no registry row for this biocid; 415: a format it does not serve, such as FASTQ), so the
 *  caller keeps the htsget path for those. Any other refusal (consent revoked, a server error) is thrown with the node's reason. */
export async function tryOpenNodeWhole(biocid: string, base = BIOFS_NODE_BASE): Promise<{ stream: Readable; format: string; region: string } | null> {
  try {
    return await openNodeRegion(biocid, undefined, base);
  } catch (e: any) {
    // 400 "region must be contig:start-end" is a node that predates whole-file reads: htsget as before
    if (/region_read refused \((404|415)\)|region_read refused \(400\): region must be/.test(String(e?.message || ''))) return null;
    throw e;
  }
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** The node's response stream for one region, or an error carrying the node's status and reason. */
export async function openNodeRegion(biocid: string, region: string | undefined, base = BIOFS_NODE_BASE): Promise<{ stream: Readable; format: string; region: string }> {
  const creds = await getCredentials();
  if (!creds?.wallet_address || !creds?.user_signature) throw new Error('Not authenticated. Run: biofs login');
  const r = await axios.get(`${base}/region_read`, {
    params: region ? { biocid, region: region.trim() } : { biocid },
    headers: { 'X-Biofs-Wallet': creds.wallet_address, 'X-Biofs-Signature': creds.user_signature },
    responseType: 'stream', timeout: 0, maxContentLength: Infinity, maxBodyLength: Infinity, validateStatus: () => true,
  });
  if (r.status !== 200) {
    const body = await readAll(r.data as Readable);
    let msg = body.slice(0, 300);
    try { msg = JSON.parse(body).error || msg; } catch { /* not JSON */ }
    throw new Error(`biofs-node region_read refused (${r.status}): ${msg}`);
  }
  return { stream: r.data as Readable, format: String(r.headers['x-format'] || ''), region: String(r.headers['x-region'] || region || 'whole') };
}

/** Pipe the node's region into a local tool's stdin; resolves with the tool's exit code. */
export async function pipeNodeRegionToCommand(biocid: string, region: string | undefined, command: string, args: string[], opts: { quiet?: boolean; label?: string; opened?: { stream: Readable; format: string; region: string }; out?: NodeJS.WritableStream } = {}): Promise<number> {
  const { stream, format, region: cut } = opts.opened ?? await openNodeRegion(biocid, region);
  const out = opts.out ?? process.stdout;
  if (!opts.quiet) process.stderr.write(`${opts.label || `pipe → ${command} ${args.slice(0, 4).join(' ')}`} ← biofs-node region_read ${format} ${cut}\n`);
  return new Promise((resolve, reject) => {
    // The tool's stdout is copied here with backpressure instead of being inherited: an inherited stdout pipe shares Node's non-blocking flag, and a large result (found
    // 20 November 2026: bcftools view of a 3.6 MB bgzip VCF into `| wc`) stopped at 65,536 bytes with 'cannot write to (null)', a silent truncation of a count.
    const tool = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    tool.stdin!.on('error', () => { /* the tool closed its input early (head, -c): not an error of the stream */ });
    out.on('error', () => { /* the reader closed early (head): stop quietly */ tool.kill(); });
    stream.on('error', (e) => { tool.kill(); reject(e); });
    tool.on('error', reject);
    tool.stdout!.pipe(out, { end: false });
    tool.on('close', (code) => {
      const done = () => resolve(code ?? 0);
      // every byte of the tool is queued on `out` by now; wait until `out` has taken all of it (process.stdout writes synchronously to a pipe or file on POSIX, so this is immediate there)
      const settle = () => { if (!((out as any).writableLength > 0)) done(); else setTimeout(settle, 5); };
      settle();
    });
    stream.pipe(tool.stdin!);
  });
}

/** Write the node's region to stdout (binary safe). */
export async function streamNodeRegionToStdout(biocid: string, region: string | undefined, opts: { quiet?: boolean; opened?: { stream: Readable; format: string; region: string } } = {}): Promise<void> {
  const { stream, format, region: cut } = opts.opened ?? await openNodeRegion(biocid, region);
  if (!opts.quiet) process.stderr.write(`stream: biofs-node region_read ${format} ${cut}\n`);
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.on('end', () => resolve());
    stream.pipe(process.stdout);
  });
}
