/**
 * biofs readcount submit|status: how many reads carry each allele at named positions in 1 to 8 alignments (biofs-node kind readcount, 20 November 2026).
 *
 * The worker counts with bcftools mpileup (overlapping mates once, BAQ off, duplicate, secondary and QC-failed reads never) and, for every SNV, checks the counts against
 * htslib's own per-base counter under the same thresholds; any difference fails the job. Each alignment is an owned BAM biocid and names the catalog genome it was aligned
 * to; every site's REF is checked against that genome first. Decision support for a human review, never a diagnosis.
 */
import * as fs from 'fs';
import { Logger } from '../../lib/utils/logger';
import { submitKindCommand, ownerOr, parseSha256, requireBiocid } from '../neoantigen-pipeline';

export const READCOUNT_REFERENCES = ['hg38_noalt', 'hg38', 'hs37d5', 'hg19'];
const LABEL_RE = /^[A-Za-z0-9_-]{1,32}$/;
const SITE_LABEL_RE = /^[A-Za-z0-9_.:>*+-]{1,64}$/;
const CONTIG_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ALLELE_RE = /^[ACGT]{1,50}$/;

export interface ReadcountSite { chrom: string; pos: number; ref: string; alt: string; label?: string }

export interface ReadcountOptions {
  bam: string[];
  ref?: string;
  refFor?: string[];
  site?: string[];
  sitesFile?: string;
  minMapq?: string;
  minBaseq?: string;
  codeSha256: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

/** label=biocid, 1 to 8, labels of letters, digits, _ and - (never a person name), no biocid twice. */
export function parseBams(items: string[] | string | undefined): Record<string, string> {
  const raw = ([] as string[]).concat(items || []).map((x) => String(x).trim()).filter(Boolean);
  if (raw.length < 1 || raw.length > 8) throw new Error('--bam needs 1 to 8 entries of label=biocid, for example tumor=biocid://genobank/0x.../bam/....bam');
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const r of raw) {
    const i = r.indexOf('=');
    const label = r.slice(0, i);
    if (i < 1 || !LABEL_RE.test(label)) throw new Error(`--bam entry "${r}" is not label=biocid (letters, digits, _ and - only)`);
    if (out[label]) throw new Error(`--bam names label ${label} twice`);
    const b = requireBiocid(`--bam ${label}`, r.slice(i + 1));
    if (seen.has(b.toLowerCase())) throw new Error(`--bam lists the same biocid twice (${label})`);
    seen.add(b.toLowerCase());
    out[label] = b;
  }
  return out;
}

/** The catalog genome of every alignment: --ref for all, --ref-for label=genome to override one. */
export function parseReferences(labels: string[], ref: string | undefined, refFor: string[] | string | undefined): Record<string, string> {
  const over: Record<string, string> = {};
  for (const r of ([] as string[]).concat(refFor || []).map((x) => String(x).trim()).filter(Boolean)) {
    const i = r.indexOf('=');
    const label = r.slice(0, i), g = r.slice(i + 1);
    if (i < 1 || !labels.includes(label)) throw new Error(`--ref-for "${r}" does not name a --bam label`);
    if (!READCOUNT_REFERENCES.includes(g)) throw new Error(`--ref-for ${label}: ${g} is not a catalog genome (${READCOUNT_REFERENCES.join(', ')})`);
    over[label] = g;
  }
  const out: Record<string, string> = {};
  for (const l of labels) {
    const g = over[l] || ref;
    if (!g) throw new Error(`alignment ${l} has no genome: give --ref <genome> (${READCOUNT_REFERENCES.join(', ')}) or --ref-for ${l}=<genome>`);
    if (!READCOUNT_REFERENCES.includes(g)) throw new Error(`--ref ${g} is not a catalog genome (${READCOUNT_REFERENCES.join(', ')})`);
    out[l] = g;
  }
  return out;
}

export function parseSite(text: string, where: string): ReadcountSite {
  const p = text.trim().split(':');
  if (p.length < 4 || p.length > 5) throw new Error(`${where}: "${text}" is not chrom:pos:REF:ALT[:label]`);
  const [chrom, posText, refRaw, altRaw, label] = p;
  const pos = Number(posText);
  const ref = refRaw.toUpperCase(), alt = altRaw.toUpperCase();
  if (!CONTIG_RE.test(chrom) || !Number.isInteger(pos) || pos < 1 || pos > 400000000) throw new Error(`${where}: chrom must be a contig name and pos a 1-based integer`);
  if (!ALLELE_RE.test(ref) || !ALLELE_RE.test(alt) || ref === alt) throw new Error(`${where}: REF and ALT must be different A/C/G/T alleles`);
  const snv = ref.length === 1 && alt.length === 1;
  const indel = (ref.length === 1 || alt.length === 1) && ref[0] === alt[0];
  if (!snv && !indel) throw new Error(`${where}: an MNV or complex change; give SNVs or simple insertions and deletions (VCF style, with the anchor base)`);
  if (label !== undefined && label !== '' && !SITE_LABEL_RE.test(label)) throw new Error(`${where}: label must be letters, digits and _.:>*+- (never a person name)`);
  return label ? { chrom, pos, ref, alt, label } : { chrom, pos, ref, alt };
}

/** Sites from --site entries and a --sites-file (tab separated chrom, pos, REF, ALT and an optional label; lines starting with # and a "chrom" header are skipped). */
export function parseSites(site: string[] | string | undefined, sitesFile: string | undefined, read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): ReadcountSite[] {
  const out: ReadcountSite[] = [];
  for (const [i, s] of ([] as string[]).concat(site || []).map((x) => String(x).trim()).filter(Boolean).entries()) out.push(parseSite(s, `--site ${i + 1}`));
  if (sitesFile) {
    const lines = read(sitesFile).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.trim() || line.startsWith('#') || /^chrom\t/i.test(line)) return;
      const f = line.split('\t');
      if (f.length < 4) throw new Error(`--sites-file line ${i + 1}: needs chrom, pos, REF and ALT separated by tabs`);
      out.push(parseSite(f.slice(0, 5).join(':'), `--sites-file line ${i + 1}`));
    });
  }
  if (out.length < 1 || out.length > 200) throw new Error(`give 1 to 200 sites (--site chrom:pos:REF:ALT[:label] or --sites-file); got ${out.length}`);
  const keys = new Set<string>();
  for (const s of out) {
    const k = `${s.chrom}:${s.pos}:${s.ref}:${s.alt}`;
    if (keys.has(k)) throw new Error(`site ${k} is listed twice`);
    keys.add(k);
  }
  return out;
}

export function buildReadcountBody(caseId: string, o: ReadcountOptions, wallet: string, signature: string, read?: (p: string) => string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const bams = parseBams(o.bam);
  const labels = Object.keys(bams).sort();
  const num = (name: string, v: string | undefined, lo: number, hi: number, def: number): number => {
    const n = v === undefined ? def : Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name} must be an integer from ${lo} to ${hi}`);
    return n;
  };
  return {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId,
    bams_biocids: Object.fromEntries(labels.map((l) => [l, bams[l]])),
    references: parseReferences(labels, o.ref, o.refFor),
    sites: parseSites(o.site, o.sitesFile, read),
    min_mapq: num('--min-mapq', o.minMapq, 0, 60, 20),
    min_baseq: num('--min-baseq (at 0 both mates of an overlapping pair would be counted)', o.minBaseq, 1, 60, 20),
    code_sha256: parseSha256('--code-sha256', o.codeSha256),
    executor: 'worker',
  };
}

export async function readcountSubmitCommand(caseId: string, options: ReadcountOptions): Promise<void> {
  try {
    await submitKindCommand('readcount', (wallet, signature) => buildReadcountBody(caseId, options, wallet, signature), options);
  } catch (e: any) {
    Logger.error(`readcount submit failed: ${e.message}`);
    process.exit(1);
  }
}
