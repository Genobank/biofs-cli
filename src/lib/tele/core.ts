/**
 * TeleBioinformatics core — shared helpers for biofs stream / pipe / tele.
 *
 * Consent-gated bytes (htsget ticket → HTTP) pipe into local tools without
 * writing vault objects to disk. Heavy compute stays Tier C (biofs annotate /
 * skills); this module is Tier A (analyst laptop).
 */
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { CredentialsManager } from '../auth/credentials';
import { GenoBankAPIClient } from '../api/client';
import { resolveAlias } from '../aliases/store';
import {
  getTicket,
  guessKindFromFilename,
  parseGenomicRegion,
  HtsgetKind,
  HtsgetTicket,
  HtsgetClientOpts,
  DEFAULT_HTSGET_URL,
  USER_AGENT,
  streamableExtension,
} from '../htsget/client';

export type Layer = 'variants' | 'reads' | 'sequences' | 'unknown';

export interface TeleCommonOpts {
  kind?: HtsgetKind;
  quiet?: boolean;
  htsgetUrl?: string;
  annotated?: boolean;
  /** Genomic region chr:start-end (forwarded to htsget + client filter when possible) */
  region?: string;
  referenceName?: string;
  start?: number;
  end?: number;
  /** Force raw/byte stream (still via htsget inventory path) */
  raw?: boolean;
}

export interface ResolvedTele {
  id: string;
  cleanId: string;
  kind: HtsgetKind;
  layer: Layer;
  signature: string;
  ticket: HtsgetTicket;
  regionQuery: Record<string, string | number | undefined>;
  filenameHint: string;
}

export function isQuiet(opts: { quiet?: boolean }): boolean {
  return opts.quiet === true || (opts.quiet !== false && !process.stdout.isTTY);
}

export function which(cmd: string): string | null {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

export function requireTool(cmd: string, installHint: string): string {
  const p = which(cmd);
  if (!p) {
    throw new Error(`${cmd} not found on PATH. ${installHint}`);
  }
  return p;
}

export function layerFromId(id: string, kind: HtsgetKind): Layer {
  const lower = id.toLowerCase();
  if (
    lower.endsWith('.fastq') ||
    lower.endsWith('.fastq.gz') ||
    lower.endsWith('.fq') ||
    lower.endsWith('.fq.gz') ||
    lower.includes('/fastq/')
  ) {
    return 'sequences';
  }
  if (kind === 'reads') return 'reads';
  if (
    lower.endsWith('.vcf') ||
    lower.endsWith('.vcf.gz') ||
    lower.endsWith('.bcf') ||
    lower.endsWith('.g.vcf') ||
    lower.endsWith('.g.vcf.gz') ||
    lower.includes('/vcf/') ||
    lower.includes('/gvcf/')
  ) {
    return 'variants';
  }
  return kind === 'variants' ? 'variants' : 'reads';
}

export function buildRegionQuery(opts: TeleCommonOpts): Record<string, string | number | undefined> {
  const q: Record<string, string | number | undefined> = {};
  if (opts.annotated) q.annotated = 'true';
  if (opts.region) {
    const parsed = parseGenomicRegion(opts.region);
    if (parsed) {
      q.referenceName = parsed.referenceName;
      if (parsed.start !== undefined) q.start = parsed.start;
      if (parsed.end !== undefined) q.end = parsed.end;
    }
  }
  if (opts.referenceName) q.referenceName = opts.referenceName;
  if (opts.start !== undefined) q.start = opts.start;
  if (opts.end !== undefined) q.end = opts.end;
  return q;
}

export async function resolveTele(rawId: string, opts: TeleCommonOpts = {}): Promise<ResolvedTele> {
  const id = resolveAlias(rawId);
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds?.user_signature) {
    throw new Error('Not authenticated. Run: biofs login');
  }

  let kind: HtsgetKind = opts.kind ?? 'variants';
  let filenameHint = id;
  if (!opts.kind) {
    try {
      const api = GenoBankAPIClient.getInstance();
      const bioips = await api.getMyGrantedBioIPs();
      const match = bioips.find((b: any) => (b.ip_id || '').toLowerCase() === id.toLowerCase());
      if (match?.filename) {
        filenameHint = match.filename;
        kind = guessKindFromFilename(match.filename);
      }
    } catch {
      /* inventory-only ids are fine */
    }
    const guessed = guessKindFromFilename(id);
    if (guessed) kind = guessed;
    // sequences default to reads for htsget path (bytes still stream)
    if (layerFromId(id, kind) === 'sequences') kind = 'reads';
  }

  const regionQuery = buildRegionQuery(opts);
  const ticketOpts: HtsgetClientOpts = {
    baseUrl: opts.htsgetUrl || DEFAULT_HTSGET_URL,
    query: regionQuery,
  };

  let ticket: HtsgetTicket;
  try {
    ticket = await getTicket(kind, id, creds.user_signature, ticketOpts);
  } catch (e: any) {
    // Fallback: try the other kind once (filename ambiguity)
    if (!opts.kind) {
      const alt: HtsgetKind = kind === 'reads' ? 'variants' : 'reads';
      ticket = await getTicket(alt, id, creds.user_signature, ticketOpts);
      kind = alt;
    } else {
      throw e;
    }
  }

  const cleanId = id.startsWith('biocid://')
    ? id.replace(/\/+$/, '').split('/').pop() || id
    : id;

  return {
    id,
    cleanId,
    kind,
    layer: layerFromId(filenameHint, kind),
    signature: creds.user_signature,
    ticket,
    regionQuery,
    filenameHint,
  };
}

export function primaryUrl(ticket: HtsgetTicket): string {
  if (!ticket.urls?.length) throw new Error('htsget ticket has no URLs');
  return ticket.urls[0].url;
}

/** Stream all ticket URLs to stdout (binary-safe). */
export function streamTicketToStdout(ticket: HtsgetTicket, opts: { quiet?: boolean } = {}): void {
  const quiet = isQuiet(opts);
  if (!quiet) {
    process.stderr.write(
      `tele stream: format=${ticket.format ?? '?'} urls=${ticket.urls.length}\n`,
    );
  }
  for (const u of ticket.urls) {
    const result = spawnSync(
      'curl',
      ['-sSL', '--fail-with-body', '-A', USER_AGENT, u.url],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (result.status !== 0) {
      throw new Error(`stream failed: curl exit ${result.status}`);
    }
  }
}

export function spawnCurl(url: string): ChildProcess {
  return spawn(
    'curl',
    ['-sSL', '--fail-with-body', '-A', USER_AGENT, url],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
}

/**
 * curl | tool argv…  with stdin from the stream.
 * Resolves with the tool exit code.
 */
export function pipeUrlToCommand(
  url: string,
  command: string,
  args: string[],
  opts: { quiet?: boolean; label?: string } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (!isQuiet(opts) && opts.label) {
      process.stderr.write(`${opts.label}\n`);
    }
    const curl = spawnCurl(url);
    const tool = spawn(command, args, {
      stdio: [curl.stdout!, 'inherit', 'inherit'],
    });
    curl.on('error', reject);
    tool.on('error', reject);
    let curlCode: number | null = null;
    curl.on('exit', (code) => {
      curlCode = code;
      if (code !== 0 && tool.exitCode === null) {
        tool.kill();
        reject(new Error(`curl failed: exit ${code}`));
      }
    });
    tool.on('exit', (code) => {
      if (curlCode && curlCode !== 0) {
        resolve(curlCode);
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

/** High-level: resolve id → ticket → pipe into local tool. */
export async function telePipe(
  rawId: string,
  command: string,
  args: string[],
  opts: TeleCommonOpts & { label?: string } = {},
): Promise<number> {
  const resolved = await resolveTele(rawId, opts);
  const url = primaryUrl(resolved.ticket);
  const label =
    opts.label ||
    `tele: ${command} ${args.slice(0, 3).join(' ')}… ← htsget ${resolved.kind}/${resolved.cleanId} (${resolved.ticket.format})`;
  return pipeUrlToCommand(url, command, args, { quiet: opts.quiet, label });
}

export async function teleStreamStdout(
  rawId: string,
  opts: TeleCommonOpts = {},
): Promise<void> {
  const resolved = await resolveTele(rawId, opts);
  streamTicketToStdout(resolved.ticket, opts);
}

export const TOOL_CATALOG: Array<{
  id: string;
  tools: string[];
  layer: Layer | 'any';
  tier: 'A' | 'B' | 'C';
  tele?: string;
  note: string;
}> = [
  {
    id: 'bcftools-stats',
    tools: ['bcftools'],
    layer: 'variants',
    tier: 'A',
    tele: 'tele stats',
    note: 'VCF/BCF summary stats from stream',
  },
  {
    id: 'bcftools-header',
    tools: ['bcftools'],
    layer: 'variants',
    tier: 'A',
    tele: 'tele header',
    note: 'VCF header only',
  },
  {
    id: 'bcftools-query',
    tools: ['bcftools'],
    layer: 'variants',
    tier: 'A',
    tele: 'tele query',
    note: 'Custom field extract (-f)',
  },
  {
    id: 'bcftools-filter',
    tools: ['bcftools'],
    layer: 'variants',
    tier: 'A',
    tele: 'tele filter',
    note: 'Expression filter (-i/-e)',
  },
  {
    id: 'bcftools-view',
    tools: ['bcftools'],
    layer: 'variants',
    tier: 'A',
    tele: 'tele view / pipe',
    note: 'Generic view; region with -r',
  },
  {
    id: 'samtools-flagstat',
    tools: ['samtools'],
    layer: 'reads',
    tier: 'A',
    tele: 'tele flagstat',
    note: 'BAM/CRAM flagstat QC',
  },
  {
    id: 'samtools-stats',
    tools: ['samtools'],
    layer: 'reads',
    tier: 'A',
    tele: 'tele stats',
    note: 'Full samtools stats',
  },
  {
    id: 'samtools-view',
    tools: ['samtools'],
    layer: 'reads',
    tier: 'A',
    tele: 'tele view / pipe',
    note: 'View/filter SAM lines from stream',
  },
  {
    id: 'samtools-count',
    tools: ['samtools'],
    layer: 'reads',
    tier: 'A',
    tele: 'tele count',
    note: 'Count alignments (view -c)',
  },
  {
    id: 'seqkit-stats',
    tools: ['seqkit'],
    layer: 'sequences',
    tier: 'A',
    tele: 'tele seqkit',
    note: 'FASTQ/FASTA QC stats',
  },
  {
    id: 'seqtk',
    tools: ['seqtk'],
    layer: 'sequences',
    tier: 'A',
    tele: 'tele seqtk',
    note: 'FASTQ subsample / convert',
  },
  {
    id: 'bedtools',
    tools: ['bedtools'],
    layer: 'any',
    tier: 'A',
    tele: 'tele bedtools',
    note: 'Intersect stream with local BED',
  },
  {
    id: 'igv-desktop',
    tools: ['igv'],
    layer: 'any',
    tier: 'B',
    tele: 'tele igv',
    note: 'Emit ticket URL + IGV batch / web session',
  },
  {
    id: 'igvjs',
    tools: [],
    layer: 'any',
    tier: 'B',
    tele: 'tele igv --web',
    note: 'Write local IGV.js HTML session (open in browser)',
  },
  {
    id: 'jupyter-pysam',
    tools: ['python3'],
    layer: 'any',
    tier: 'A',
    tele: 'tele jupyter',
    note: 'Emit notebook / pysam cell using biofs stream',
  },
  {
    id: 'vt-normalize',
    tools: ['vt'],
    layer: 'variants',
    tier: 'A',
    tele: 'tele vt',
    note: 'Normalize/decompose VCF stream',
  },
  {
    id: 'mosdepth',
    tools: ['mosdepth'],
    layer: 'reads',
    tier: 'B',
    tele: 'tele mosdepth',
    note: 'Coverage (prefers indexed BAM; may need fuse)',
  },
  {
    id: 'opencravat',
    tools: [],
    layer: 'variants',
    tier: 'C',
    tele: 'annotate submit',
    note: 'Server-side annotation (not stream-to-laptop)',
  },
  {
    id: 'deepvariant-parabricks',
    tools: [],
    layer: 'reads',
    tier: 'C',
    tele: 'job / pipeline',
    note: 'GPU calling next to data',
  },
];

export function installHint(tool: string): string {
  const hints: Record<string, string> = {
    bcftools: 'Install: brew install bcftools   or   apt install bcftools',
    samtools: 'Install: brew install samtools   or   apt install samtools',
    seqkit: 'Install: brew install seqkit   or   conda install -c bioconda seqkit',
    seqtk: 'Install: brew install seqtk   or   conda install -c bioconda seqtk',
    bedtools: 'Install: brew install bedtools   or   apt install bedtools',
    vt: 'Install: brew install vt   or   conda install -c bioconda vt',
    mosdepth: 'Install: conda install -c bioconda mosdepth',
  };
  return hints[tool] || `Install ${tool} and ensure it is on PATH`;
}

export { streamableExtension, parseGenomicRegion, DEFAULT_HTSGET_URL, USER_AGENT };
