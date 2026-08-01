/**
 * Htsget client — GA4GH htsget v1.2 protocol.
 *
 * Fetches a ticket (a JSON pointer to one or more byte-range URLs) from the
 * htsget endpoint, then the caller is responsible for streaming those URLs
 * in order. This keeps us aligned with bcftools/samtools/pysam/IGV which all
 * speak htsget natively.
 *
 * See: https://samtools.github.io/hts-specs/htsget.html
 */

export const DEFAULT_HTSGET_URL = process.env.BIOFS_HTSGET_URL || 'https://htsget.genobank.app';
export const USER_AGENT = 'biofs/3.18.0 (+https://genobank.io; telebioinformatics)';

export type HtsgetKind = 'variants' | 'reads';

export interface HtsgetTicketUrl {
  url: string;
  headers?: Record<string, string>;
}

export interface HtsgetTicket {
  format?: string; // 'VCF' | 'BAM' | 'CRAM'
  urls: HtsgetTicketUrl[];
  md5?: string;
  error?: string;
  message?: string;
}

export interface HtsgetServiceInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  organization?: { name?: string; url?: string };
  type?: { group?: string; artifact?: string; version?: string };
  htsget?: { datatype?: string[]; formats?: string[] };
}

export interface HtsgetClientOpts {
  /** Base URL of htsget service. Default: https://htsget.genobank.app */
  baseUrl?: string;
  /** Optional override for query params (e.g. referenceName, start, end, annotated). */
  query?: Record<string, string | number | undefined>;
}

export interface GenomicRegion {
  referenceName: string;
  start?: number; // 0-based inclusive per htsget; we accept 1-based user input and convert
  end?: number; // 0-based exclusive in htsget; we pass through user end as given if 1-based UI
  raw: string;
}

/**
 * Parse regions like:
 *   chr17
 *   chr17:7661779
 *   chr17:7661779-7687538
 *   17:7661779-7687538
 *
 * User coordinates are treated as 1-based inclusive (VCF/IGV style).
 * htsget wants 0-based half-open; we convert start-=1 when start is set.
 */
export function parseGenomicRegion(region: string): GenomicRegion | null {
  const raw = (region || '').trim();
  if (!raw) return null;
  // chr:start-end | chr:start | chr
  const m = raw.match(/^([^:]+)(?::(\d+)(?:-(\d+))?)?$/);
  if (!m) return null;
  const referenceName = m[1];
  const start1 = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
  const end1 = m[3] !== undefined ? parseInt(m[3], 10) : undefined;
  const out: GenomicRegion = { referenceName, raw };
  if (start1 !== undefined && !Number.isNaN(start1)) {
    // htsget: 0-based inclusive start
    out.start = Math.max(0, start1 - 1);
  }
  if (end1 !== undefined && !Number.isNaN(end1)) {
    // htsget: 0-based exclusive end ≈ 1-based inclusive end
    out.end = end1;
  }
  return out;
}

/** Guess `variants` vs `reads` from a filename or biocid. */
export function guessKindFromFilename(filename: string): HtsgetKind {
  const lower = filename.toLowerCase();
  if (
    lower.endsWith('.bam') ||
    lower.endsWith('.cram') ||
    lower.endsWith('.sam') ||
    lower.endsWith('.fastq') ||
    lower.endsWith('.fastq.gz') ||
    lower.endsWith('.fq') ||
    lower.endsWith('.fq.gz') ||
    lower.includes('/bam/') ||
    lower.includes('/cram/') ||
    lower.includes('/fastq/')
  ) {
    return 'reads';
  }
  return 'variants';
}

/** Whether this name is streamable via htsget reads/variants. */
export function streamableExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    lower.endsWith('.vcf') ||
    lower.endsWith('.vcf.gz') ||
    lower.endsWith('.bcf') ||
    lower.endsWith('.g.vcf') ||
    lower.endsWith('.g.vcf.gz') ||
    lower.endsWith('.bam') ||
    lower.endsWith('.cram') ||
    lower.endsWith('.sam') ||
    lower.endsWith('.fastq') ||
    lower.endsWith('.fastq.gz') ||
    lower.endsWith('.fq') ||
    lower.endsWith('.fq.gz')
  );
}

/** Fetch the GA4GH service-info JSON. No auth required. */
export async function getServiceInfo(opts: HtsgetClientOpts = {}): Promise<HtsgetServiceInfo> {
  const base = (opts.baseUrl || DEFAULT_HTSGET_URL).replace(/\/+$/, '');
  const res = await fetch(`${base}/service-info`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`htsget service-info → HTTP ${res.status}`);
  }
  return (await res.json()) as HtsgetServiceInfo;
}

/** Fetch a ticket. `id` is usually a filename / ip_id but can also be a full BioCID URL. */
export async function getTicket(
  kind: HtsgetKind,
  id: string,
  signature: string,
  opts: HtsgetClientOpts = {},
): Promise<HtsgetTicket> {
  const base = (opts.baseUrl || DEFAULT_HTSGET_URL).replace(/\/+$/, '');

  // If caller passed a full BioCID URL, pull the last segment as the id.
  let cleanId = id;
  if (id.startsWith('biocid://') || id.startsWith('Biocid:')) {
    const parts = id.replace(/^Biocid:/i, 'biocid://').replace(/\/+$/, '').split('/');
    cleanId = parts[parts.length - 1];
  }

  const qs = new URLSearchParams();
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
  }
  const url = `${base}/${kind}/${encodeURIComponent(cleanId)}${qs.toString() ? '?' + qs.toString() : ''}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      Authorization: `Bearer ${signature}`,
    },
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`htsget ${kind}/${cleanId} → HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
  }
  let parsed: { htsget?: HtsgetTicket };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`htsget ticket not JSON: ${bodyText.slice(0, 200)}`);
  }
  if (!parsed.htsget || !parsed.htsget.urls) {
    throw new Error(`htsget ticket malformed: ${bodyText.slice(0, 200)}`);
  }
  return parsed.htsget;
}

/** Build a bookmarkable ticket request URL (without Bearer; for debugging). */
export function buildTicketRequestUrl(
  kind: HtsgetKind,
  id: string,
  opts: HtsgetClientOpts = {},
): string {
  const base = (opts.baseUrl || DEFAULT_HTSGET_URL).replace(/\/+$/, '');
  let cleanId = id;
  if (id.startsWith('biocid://')) {
    cleanId = id.replace(/\/+$/, '').split('/').pop() || id;
  }
  const qs = new URLSearchParams();
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
  }
  return `${base}/${kind}/${encodeURIComponent(cleanId)}${qs.toString() ? '?' + qs.toString() : ''}`;
}
