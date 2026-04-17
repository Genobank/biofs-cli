/**
 * Htsget client — GA4GH htsget v1.2 protocol.
 *
 * Fetches a ticket (a JSON pointer to one or more byte-range URLs) from the
 * htsget endpoint, then the caller is responsible for streaming those URLs
 * in order. This keeps us aligned with bcftools/samtools/pysam which all
 * speak htsget natively.
 *
 * See: https://samtools.github.io/hts-specs/htsget.html
 */

const DEFAULT_HTSGET_URL = process.env.BIOFS_HTSGET_URL || 'https://htsget.genobank.app';
const USER_AGENT = 'biofs/2.7.0 (+https://genobank.io)';

export type HtsgetKind = 'variants' | 'reads';

export interface HtsgetTicketUrl {
  url: string;
  headers?: Record<string, string>;
}

export interface HtsgetTicket {
  format?: string;        // 'VCF' | 'BAM' | 'CRAM'
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
  /** Optional override for query params (e.g. referenceName, start, end). */
  query?: Record<string, string | number | undefined>;
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

/** Fetch a ticket. `id` is usually an ip_id but can also be a full BioCID URL. */
export async function getTicket(
  kind: HtsgetKind,
  id: string,
  signature: string,
  opts: HtsgetClientOpts = {},
): Promise<HtsgetTicket> {
  const base = (opts.baseUrl || DEFAULT_HTSGET_URL).replace(/\/+$/, '');

  // If caller passed a full BioCID URL, pull the last segment as the id.
  let cleanId = id;
  if (id.startsWith('biocid://')) {
    const parts = id.replace(/\/+$/, '').split('/');
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
  } catch (e) {
    throw new Error(`htsget ticket not JSON: ${bodyText.slice(0, 200)}`);
  }
  if (!parsed.htsget || !parsed.htsget.urls) {
    throw new Error(`htsget ticket malformed: ${bodyText.slice(0, 200)}`);
  }
  return parsed.htsget;
}

/** Guess `variants` vs `reads` from a filename. */
export function guessKindFromFilename(filename: string): HtsgetKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.bam') || lower.endsWith('.cram') || lower.endsWith('.sam')) return 'reads';
  return 'variants';
}
