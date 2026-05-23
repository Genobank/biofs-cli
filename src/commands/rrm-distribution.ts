/**
 * biofs rrm-distribution <gene>
 *
 * Pull ClinVar-classified missense variants for a gene and compute Cosic-RRM
 * features for each, producing the empirical distribution that lets us rank
 * individual patient variants against known pathogenic vs known benign.
 *
 * Pipeline:
 *   1. NCBI E-utils esearch for ClinVar IDs in <gene> with germline missense
 *      classifications (P, LP, VUS, LB, B).
 *   2. esummary on each id for canonical_spdi + classification + HGVS.
 *   3. For each missense variant: pull WT residue from the cached UniProt
 *      FASTA, build MT sequence by single-residue swap, compute Cosic features
 *      (windowed Σ|ΔF|, full-protein L1 spectral distance, multi-peak
 *      weighted aggregate, ratio at primary f_c).
 *   4. Save to ~/.biofs/cache/rrm/<gene>-distribution.json.
 *   5. If --highlight is passed, render distribution plot with the highlighted
 *      variants marked, separated by classification class.
 *
 * Use case: validate that Cosic features discriminate pathogenic from benign,
 * and report the ranking percentile for n-of-1 variants.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import ora from 'ora';

const RRM_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'rrm');
const UNIPROT_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'uniprot');

import { GENE_TO_UNIPROT } from '../lib/gene-map';

export interface RrmDistributionOptions {
  highlight?: string;
  output?: string;
  plot?: string;
  refresh?: boolean;
  retmax?: string;
  quiet?: boolean;
  // Pseudo-benign synthesis: for rare-disease genes whose ClinVar entries are
  // entirely Pathogenic / Likely Pathogenic (no Benign or Likely Benign), draw
  // a set of N common-population missense variants from gnomAD (AF above the
  // threshold below) and label them as Likely Benign for AUC benchmarking
  // purposes. This unlocks ensemble training on COL3A1 / COL7A1 / FBN1 /
  // MLH1-class genes that would otherwise be skipped for low n.
  gnomadBenigns?: string;            // number of pseudo-benigns to synthesize (e.g., "40")
  gnomadMinAf?: string;              // gnomAD AF threshold for pseudo-benign eligibility (default 0.01)
}

interface ClinVarVariant {
  variation_id: string;
  hgvs_protein: string;
  position: number;
  ref: string;
  alt: string;
  classification: string;       // raw ClinVar germline classification text
  classification_simple: 'pathogenic' | 'likely_pathogenic' | 'vus' | 'likely_benign' | 'benign' | 'conflicting' | 'other';
  review_status?: string;
  last_evaluated?: string;
  // Genomic coordinates + xrefs for MyVariant.info / dbNSFP lookup
  chr?: string;
  genomic_pos?: number;
  cdna_change?: string;
  dbsnp_rsid?: string;
  hgvs_genomic?: string;        // chr17:g.44385073A>C
}

interface DistributionResult {
  gene: string;
  uniprot: string;
  total_clinvar_hits: number;
  parsed_missense: number;
  by_classification: Record<string, number>;
  variants: Array<ClinVarVariant & {
    windowedSumAbsDFDc?: number;
    fullSpectrumL1?: number;
    fcRatio?: number;
    weightedAggregateDeltaEPct?: number;
    totalEnergyChangePct?: number;
    error?: string;
  }>;
  generated_at: string;
}

const HGVS_3_TO_1: Record<string, string> = {
  Ala: 'A', Arg: 'R', Asn: 'N', Asp: 'D', Cys: 'C',
  Glu: 'E', Gln: 'Q', Gly: 'G', His: 'H', Ile: 'I',
  Leu: 'L', Lys: 'K', Met: 'M', Phe: 'F', Pro: 'P',
  Ser: 'S', Thr: 'T', Trp: 'W', Tyr: 'Y', Val: 'V',
  Ter: '*',
};

function simplifyClassification(s: string): ClinVarVariant['classification_simple'] {
  const t = (s || '').toLowerCase();
  if (t.includes('conflicting')) return 'conflicting';
  if (t.includes('likely pathogenic')) return 'likely_pathogenic';
  if (t.includes('pathogenic')) return 'pathogenic';
  if (t.includes('likely benign')) return 'likely_benign';
  if (t.includes('benign')) return 'benign';
  if (t.includes('uncertain')) return 'vus';
  return 'other';
}

const SINGLE_AA = 'ACDEFGHIKLMNPQRSTVWY';

function parseProteinHgvs(s: string): { pos: number; ref: string; alt: string } | null {
  if (!s) return null;
  // 3-letter form: p.Leu225Arg, NP_000410.2:p.Leu225Arg
  const m3 = s.match(/p\.([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2})/);
  if (m3) {
    const ref = HGVS_3_TO_1[m3[1]];
    const alt = HGVS_3_TO_1[m3[3]];
    if (ref && alt) return { pos: parseInt(m3[2], 10), ref, alt };
  }
  // Single-letter form: V779A (ClinVar esummary's protein_change field)
  const m1 = s.match(/^([A-Z])(\d+)([A-Z*])$/);
  if (m1 && SINGLE_AA.includes(m1[1]) && (SINGLE_AA.includes(m1[3]) || m1[3] === '*')) {
    return { pos: parseInt(m1[2], 10), ref: m1[1], alt: m1[3] };
  }
  // Multi-variant compound (e.g. "V779A;K989N") — take first
  if (s.includes(';') || s.includes(',')) {
    for (const part of s.split(/[;,]/)) {
      const r = parseProteinHgvs(part.trim());
      if (r) return r;
    }
  }
  return null;
}

function fetchClinVarIds(gene: string, retmax: number, quiet: boolean): string[] {
  // ClinVar E-utils search with VUS / Conflicting EXCLUDED at server side. The
  // earlier version of this function pulled the default-ordered first 996
  // entries which are dominated by Uncertain Significance and Conflicting
  // Classification submissions, leaving 1-12 trainable variants on heavily-
  // curated cancer genes like BRCA1 / BRCA2. The corrected query restricts
  // to clinsig_pathogenic, clinsig_likely_pathogenic, clinsig_benign, and
  // clinsig_likely_benign at the index level. We paginate via the retstart
  // parameter so all matching variants are retrieved, capped at retmax.
  // Reference: https://www.ncbi.nlm.nih.gov/clinvar/docs/api_search/
  const sigTerms = encodeURIComponent(
    '(clinsig_pathogenic[Properties] OR clinsig_likely_pathogenic[Properties] OR ' +
    'clinsig_benign[Properties] OR clinsig_likely_benign[Properties])'
  );
  const gene_term = encodeURIComponent(`${gene}[gene]`);
  const missense_term = encodeURIComponent('missense_variant[molecular consequence]');
  const term = `${gene_term}+AND+${sigTerms}+AND+${missense_term}`;
  const pageSize = Math.min(retmax, 5000);
  const allIds: string[] = [];
  let retstart = 0;
  while (allIds.length < retmax) {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=clinvar&term=${term}&retmax=${pageSize}&retstart=${retstart}&retmode=json`;
    const r = spawnSync('curl', ['-sS', '-A', 'biofs/3.2.0', '--max-time', '60', url], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`E-utils esearch failed: ${r.stderr}`);
    const data = JSON.parse(r.stdout);
    const idlist: string[] = data?.esearchresult?.idlist || [];
    if (idlist.length === 0) break;
    allIds.push(...idlist);
    const totalAvailable = parseInt(data?.esearchresult?.count || '0', 10);
    if (!quiet) {
      process.stderr.write(`  ClinVar esearch page: retstart=${retstart}, got ${idlist.length}, cumulative ${allIds.length}/${totalAvailable}\n`);
    }
    if (allIds.length >= totalAvailable) break;
    retstart += idlist.length;
    if (idlist.length < pageSize) break;
    // polite NCBI throttle (3 req/sec without API key)
    spawnSync('sleep', ['0.4']);
  }
  return allIds.slice(0, retmax);
}

function fetchClinVarSummaries(ids: string[], quiet: boolean): any[] {
  // Batch in chunks of 200 ids per esummary call
  const summaries: any[] = [];
  const chunkSize = 200;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=clinvar&id=${chunk.join(',')}&retmode=json`;
    const r = spawnSync('curl', ['-sS', '-A', 'biofs/3.2.0', '--max-time', '120', url], {
      encoding: 'utf8',
      maxBuffer: 200 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`E-utils esummary failed: ${r.stderr}`);
    const data = JSON.parse(r.stdout);
    const result = data?.result || {};
    for (const id of chunk) {
      if (result[id]) summaries.push(result[id]);
    }
  }
  return summaries;
}

function extractMissenseFromSummary(summary: any): ClinVarVariant | null {
  // ClinVar esummary places single-letter form in summary.protein_change (e.g. "V779A")
  // and 3-letter HGVS in variation_set[*].variation_name (e.g. "...(ITGA2B):c.2336T>C (p.Val779Ala)").
  const singleLetter = summary?.protein_change || '';
  const variationName = (summary?.variation_set || [])[0]?.variation_name || '';
  const proteinDescr = ((summary?.variation_set || [])[0]?.variation_loc || [])
    .map((l: any) => l?.protein_descr)
    .find(Boolean) || '';

  const parsed =
    parseProteinHgvs(singleLetter) ||
    parseProteinHgvs(variationName) ||
    parseProteinHgvs(proteinDescr);

  if (!parsed) return null;

  // Reject anything that isn't a single-residue substitution (e.g. nonsense / stop)
  if (parsed.alt === '*') return null;

  const cls =
    summary?.germline_classification?.description ||
    summary?.classification?.germline_classification?.description ||
    summary?.clinical_significance?.description ||
    '';

  // Genomic coordinates + dbSNP cross-reference for downstream MyVariant.info lookups.
  // Primary source is canonical_spdi (NC_xxx:0-based-pos:ref:alt). Fallback to
  // variation_loc / variation_xrefs.
  const vsFirst = (summary?.variation_set || [])[0];
  const loc = (vsFirst?.variation_loc || []).find((l: any) => l?.assembly_name === 'GRCh38') || (vsFirst?.variation_loc || [])[0];
  const xrefs = (vsFirst?.variation_xrefs || []);
  const dbsnp = xrefs.find((x: any) => x?.db_source === 'dbSNP');
  const cdnaChange = vsFirst?.cdna_change || '';
  const spdi = vsFirst?.canonical_spdi || '';

  let chr = String(loc?.chr || '');
  let gpos = parseInt(String(loc?.start || '0'), 10);
  let gRef = String(loc?.ref || '');
  let gAlt = String(loc?.alt || '');

  // Parse SPDI: NC_000017.11:44376319:A:G => chr 17, 1-based pos 44376320, ref A, alt G
  if (spdi) {
    const m = spdi.match(/^NC_0*(\d+|X|Y|M)\.\d+:(\d+):([ACGT]*):([ACGT]*)$/i);
    if (m) {
      const chrNum = m[1];
      chr = chr || chrNum;
      const spdiPos = parseInt(m[2], 10);
      if (!gpos) gpos = spdiPos + 1; // SPDI is 0-based
      gRef = gRef || m[3];
      gAlt = gAlt || m[4];
    }
  }

  let hgvsGenomic = '';
  if (chr && gpos && gRef && gAlt) {
    hgvsGenomic = `chr${chr}:g.${gpos}${gRef}>${gAlt}`;
  }

  return {
    variation_id: String(summary?.uid || ''),
    hgvs_protein: variationName || singleLetter,
    position: parsed.pos,
    ref: parsed.ref,
    alt: parsed.alt,
    classification: cls,
    classification_simple: simplifyClassification(cls),
    review_status: summary?.germline_classification?.review_status || '',
    last_evaluated: summary?.germline_classification?.last_evaluated || '',
    chr,
    genomic_pos: gpos || undefined,
    cdna_change: cdnaChange,
    dbsnp_rsid: dbsnp ? `rs${dbsnp.db_id}` : undefined,
    hgvs_genomic: hgvsGenomic || undefined,
  };
}

const EIIP: Record<string, number> = {
  A: 0.0373, R: 0.0959, N: 0.0036, D: 0.1263, C: 0.0829,
  E: 0.0058, Q: 0.0761, G: 0.0050, H: 0.0242, I: 0.0000,
  L: 0.0000, K: 0.0371, M: 0.0823, F: 0.0946, P: 0.0198,
  S: 0.0829, T: 0.0941, W: 0.0548, Y: 0.0516, V: 0.0057,
};

const PY_BATCH_SCORE = `
import json, sys, numpy as np

EIIP = ${JSON.stringify(EIIP)}

d = json.loads(sys.stdin.read())
seq = d['sequence']
common_length = d['common_length']
fc_freq = d['fc_freq']
peaks = d['peaks']

def encode_full(s):
    s = s[:common_length] + 'X' * max(0, common_length - len(s))
    v = np.array([EIIP.get(a, 0.0) for a in s], dtype=float)
    return v - v.mean()

def spec_full(s):
    v = encode_full(s)
    X = np.abs(np.fft.rfft(v))
    if X.sum() > 0: X = X / X.sum()
    return X

Xw = spec_full(seq)
N = len(Xw)
fc_bin = int(round(fc_freq * 2 * (N - 1)))
fc_bin = max(0, min(N - 1, fc_bin))

# Windowed (N=31) features
def encode_window(s, center, N=31):
    flank = N // 2
    start = center - 1 - flank
    end = center + flank
    w = ''
    for i in range(start, end):
        w += s[i] if 0 <= i < len(s) else 'X'
    return np.array([EIIP.get(a, 0.0) for a in w], dtype=float)

results = []
for v in d['variants']:
    pos, ref, alt = v['position'], v['ref'], v['alt']
    # Sanity check ref matches
    if pos < 1 or pos > len(seq) or seq[pos-1] != ref:
        results.append({**v, 'error': f'Reference mismatch at {pos}: seq has {seq[pos-1] if 0 < pos <= len(seq) else "?"}, HGVS expects {ref}'})
        continue
    mt_seq = seq[:pos-1] + alt + seq[pos:]
    Xm = spec_full(mt_seq)

    # Full-protein L1 distance + total energy change
    l1 = float(np.sum(np.abs(Xm - Xw)))
    eW = float(np.sum(Xw**2))
    eM = float(np.sum(Xm**2))
    total_de = 100.0 * (eM - eW) / eW if eW > 0 else 0
    fc_ratio = float(Xm[fc_bin] / Xw[fc_bin]) if Xw[fc_bin] > 0 else 0

    # Weighted aggregate across top peaks
    num = 0.0; den = 0.0
    for p in peaks:
        k = int(p['bin'])
        if k >= N: continue
        m = float(p.get('magnitude', 1))
        xw, xm = Xw[k], Xm[k]
        if xw > 0:
            num += m * 100 * (xm**2 - xw**2) / (xw**2)
            den += m
    wagg = num / den if den > 0 else 0

    # Windowed Σ|ΔF| (DC excluded)
    wt_win = encode_window(seq, pos, 31)
    mt_win = encode_window(mt_seq, pos, 31)
    Yw = np.abs(np.fft.rfft(wt_win))
    Ym = np.abs(np.fft.rfft(mt_win))
    delta = np.abs(Yw - Ym)
    win_sum = float(delta[1:].sum()) if len(delta) > 1 else 0

    results.append({
        **v,
        'windowedSumAbsDFDc': win_sum,
        'fullSpectrumL1': l1,
        'fcRatio': fc_ratio,
        'weightedAggregateDeltaEPct': wagg,
        'totalEnergyChangePct': total_de,
    })

print(json.dumps(results))
`;

/**
 * Synthesize pseudo-benign control variants from gnomAD common population
 * data. For rare-disease genes whose ClinVar entries are dominated by
 * pathogenic submissions (typical for genes like COL3A1, COL7A1, FBN1),
 * AUC benchmarking requires negative-class controls. We query MyVariant.info
 * for missense variants in the target gene with gnomAD exome OR genome AF
 * above `minAf` (default 1%), filter to those NOT already present as a
 * ClinVar entry in our parsed set, and return them with classification_simple
 * pre-labeled as 'likely_benign' and a 'source' marker so downstream consumers
 * know these are population-frequency-implied benigns rather than ACMG curated.
 */
async function synthesizeGnomadPseudoBenigns(
  gene: string,
  uniprot: string,
  nWanted: number,
  minAf: number,
  existingClinVarVariants: any[],
  quiet: boolean,
): Promise<any[]> {
  // Build set of (chrom, pos, ref, alt) tuples we already have from ClinVar
  // so we don't double-count if a variant happens to be both ClinVar B+LB and
  // gnomAD common.
  const haveKeys = new Set<string>();
  for (const v of existingClinVarVariants) {
    if (v.hgvs_genomic) haveKeys.add(v.hgvs_genomic);
    if (v.hgvs_protein) haveKeys.add(`P:${v.hgvs_protein}`);
  }
  // MyVariant.info /query for gene-restricted common missense
  const fields = 'dbsnp.rsid,snpeff.ann.gene_name,snpeff.ann.hgvs_p,snpeff.ann.hgvs_c,snpeff.ann.putative_impact,gnomad_exome.af.af,gnomad_genome.af.af,chrom,vcf.position,vcf.ref,vcf.alt';
  const queryExpr = `snpeff.ann.gene_name:${gene} AND snpeff.ann.putative_impact:MODERATE AND _exists_:gnomad_exome.af.af AND gnomad_exome.af.af:>=${minAf}`;
  const pageSize = Math.min(nWanted * 3, 1000);  // pull 3x candidates to account for filtering loss
  const url = `https://myvariant.info/v1/query?q=${encodeURIComponent(queryExpr)}&fields=${encodeURIComponent(fields)}&size=${pageSize}&dotfield=true`;
  const r = spawnSync('curl', ['-sS', '-A', 'biofs/3.2.0', '--max-time', '60', url], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`MyVariant gnomAD query failed: ${r.stderr}`);
  const data = JSON.parse(r.stdout);
  const hits = (data?.hits || []) as any[];
  if (!quiet) process.stderr.write(`  gnomAD candidates retrieved: ${hits.length}\n`);

  const synthesized: any[] = [];
  for (const h of hits) {
    if (synthesized.length >= nWanted) break;
    const annArr = h?.['snpeff.ann.hgvs_p'];
    const geneArr = h?.['snpeff.ann.gene_name'];
    const impactArr = h?.['snpeff.ann.putative_impact'];
    const protHgvs = Array.isArray(annArr) ? annArr.find((x: any) => typeof x === 'string' && x.startsWith('p.')) : annArr;
    if (!protHgvs || typeof protHgvs !== 'string') continue;
    // Confirm this is actually in our gene (snpeff can return overlapping transcripts)
    const geneMatch = Array.isArray(geneArr)
      ? geneArr.some((g: any) => (g || '').toUpperCase() === gene.toUpperCase())
      : (geneArr || '').toUpperCase() === gene.toUpperCase();
    if (!geneMatch) continue;
    // Skip if not MODERATE impact (i.e., missense)
    const isMod = Array.isArray(impactArr) ? impactArr.includes('MODERATE') : impactArr === 'MODERATE';
    if (!isMod) continue;
    const protKey = `P:${protHgvs}`;
    if (haveKeys.has(protKey)) continue;
    const parsed = parseProteinHgvs(protHgvs);
    if (!parsed) continue;
    const af = (h?.['gnomad_exome.af.af'] ?? h?.['gnomad_genome.af.af']) as number | undefined;
    synthesized.push({
      variation_id: `gnomad_${h._id || synthesized.length}`,
      hgvs_protein: protHgvs,
      hgvs_genomic: h._id || null,
      position: parsed.pos,
      ref: parsed.ref,
      alt: parsed.alt,
      classification: 'population-common, presumed benign',
      classification_simple: 'likely_benign' as const,
      review_status: 'gnomad_pseudo_benign',
      dbsnp_rsid: h?.['dbsnp.rsid'] || null,
      gnomad_af: af,
    });
    haveKeys.add(protKey);
  }
  return synthesized;
}

function plotDistribution(result: DistributionResult, outPath: string, highlight: string[], quiet: boolean): void {
  const py = `
import json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

d = json.loads(sys.stdin.read())
variants = [v for v in d['variants'] if v.get('fullSpectrumL1') is not None]
classes = ['pathogenic', 'likely_pathogenic', 'vus', 'likely_benign', 'benign']
colors = {
    'pathogenic': '#d62728',
    'likely_pathogenic': '#ff7f0e',
    'vus': '#7f7f7f',
    'likely_benign': '#bcbd22',
    'benign': '#2ca02c',
    'conflicting': '#9467bd',
    'other': '#cccccc',
}

fig, axes = plt.subplots(2, 2, figsize=(13, 9))

# Panel A: full-spectrum L1 distance by class
ax = axes[0, 0]
for cls in classes:
    xs = [v['fullSpectrumL1'] for v in variants if v.get('classification_simple') == cls]
    if not xs: continue
    ax.hist(xs, bins=20, alpha=0.6, label=f'{cls} (n={len(xs)})', color=colors[cls])
for hl in d['highlight']:
    if hl.get('fullSpectrumL1') is not None:
        ax.axvline(hl['fullSpectrumL1'], color='black', linestyle='--', linewidth=1.4)
        ax.annotate(f"  {hl['label']}", xy=(hl['fullSpectrumL1'], 0), xytext=(2, 4),
                    textcoords='offset points', rotation=90, fontsize=9, va='bottom')
ax.set_xlabel('full-spectrum L1 distance')
ax.set_ylabel('count')
ax.set_title('Cosic-RRM full-protein L1 distance distribution')
ax.legend(fontsize=8)

# Panel B: windowed Σ|ΔF| by class
ax = axes[0, 1]
for cls in classes:
    xs = [v['windowedSumAbsDFDc'] for v in variants if v.get('classification_simple') == cls]
    if not xs: continue
    ax.hist(xs, bins=20, alpha=0.6, label=f'{cls} (n={len(xs)})', color=colors[cls])
for hl in d['highlight']:
    if hl.get('windowedSumAbsDFDc') is not None:
        ax.axvline(hl['windowedSumAbsDFDc'], color='black', linestyle='--', linewidth=1.4)
        ax.annotate(f"  {hl['label']}", xy=(hl['windowedSumAbsDFDc'], 0), xytext=(2, 4),
                    textcoords='offset points', rotation=90, fontsize=9, va='bottom')
ax.set_xlabel('windowed Σ|ΔF| (k≥1), N=31')
ax.set_ylabel('count')
ax.set_title('Cosic-RRM windowed Σ|ΔF| distribution')
ax.legend(fontsize=8)

# Panel C: 2D scatter L1 vs windowed Σ|ΔF|
ax = axes[1, 0]
for cls in classes:
    xs = [v['fullSpectrumL1'] for v in variants if v.get('classification_simple') == cls]
    ys = [v['windowedSumAbsDFDc'] for v in variants if v.get('classification_simple') == cls]
    if not xs: continue
    ax.scatter(xs, ys, alpha=0.65, label=f'{cls} (n={len(xs)})', color=colors[cls], s=22)
for hl in d['highlight']:
    if hl.get('fullSpectrumL1') is not None and hl.get('windowedSumAbsDFDc') is not None:
        ax.scatter([hl['fullSpectrumL1']], [hl['windowedSumAbsDFDc']], color='black', marker='X', s=140, zorder=10, linewidths=1.4, edgecolor='white')
        ax.annotate(f"  {hl['label']}", (hl['fullSpectrumL1'], hl['windowedSumAbsDFDc']), xytext=(6, 0),
                    textcoords='offset points', fontsize=9)
ax.set_xlabel('full-spectrum L1 distance')
ax.set_ylabel('windowed Σ|ΔF|')
ax.set_title('Cosic feature space, full-protein vs windowed')
ax.legend(fontsize=8)
ax.grid(True, alpha=0.3)

# Panel D: f_c ratio MT/WT by class
ax = axes[1, 1]
for cls in classes:
    xs = [v['fcRatio'] for v in variants if v.get('classification_simple') == cls]
    if not xs: continue
    ax.hist(xs, bins=20, alpha=0.6, label=f'{cls} (n={len(xs)})', color=colors[cls])
for hl in d['highlight']:
    if hl.get('fcRatio') is not None:
        ax.axvline(hl['fcRatio'], color='black', linestyle='--', linewidth=1.4)
        ax.annotate(f"  {hl['label']}", xy=(hl['fcRatio'], 0), xytext=(2, 4),
                    textcoords='offset points', rotation=90, fontsize=9, va='bottom')
ax.set_xlabel(f'|X_MT(f_c)| / |X_WT(f_c)|  (f_c period {d["fc_period_aa"]:.1f} aa)')
ax.set_ylabel('count')
ax.set_title('Cosic-RRM ratio at family characteristic frequency')
ax.legend(fontsize=8)
ax.axvline(1.0, color='black', linewidth=0.6, alpha=0.5)

fig.suptitle(f"Cosic-RRM ClinVar distribution  |  {d['gene']} ({d['uniprot']})  |  n={len(variants)} classified missense", fontsize=12, y=1.0)
fig.tight_layout()
fig.savefig(d['out_path'], dpi=150, bbox_inches='tight')
print(f"OK: {d['out_path']}", file=sys.stderr)
`;
  // Compute Cosic features for highlighted variants too
  const cachePath = path.join(RRM_CACHE_DIR, `${result.gene}.json`);
  const cons = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const seqPath = path.join(UNIPROT_CACHE_DIR, `${result.uniprot}.fasta`);
  const seq = fs.readFileSync(seqPath, 'utf8').split('\n').slice(1).join('').replace(/\s/g, '').toUpperCase();

  const hl: Array<any> = [];
  for (const h of highlight) {
    const parsed = parseProteinHgvs(h);
    if (!parsed) continue;
    const scoreInput = {
      sequence: seq,
      common_length: cons.common_length,
      fc_freq: cons.characteristic_frequency_normalized,
      peaks: cons.consensus_peak_bins || [],
      variants: [{ position: parsed.pos, ref: parsed.ref, alt: parsed.alt }],
    };
    const r = spawnSync('python3', ['-c', PY_BATCH_SCORE], { encoding: 'utf8', input: JSON.stringify(scoreInput), maxBuffer: 100 * 1024 * 1024 });
    if (r.status === 0) {
      const arr = JSON.parse(r.stdout);
      if (arr[0]) {
        hl.push({ label: h, ...arr[0] });
      }
    }
  }

  const r = spawnSync('python3', ['-c', py], {
    encoding: 'utf8',
    input: JSON.stringify({
      ...result,
      highlight: hl,
      fc_period_aa: cons.characteristic_frequency_period_aa,
      out_path: outPath,
    }),
    maxBuffer: 200 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`Distribution plot failed: ${r.stderr || r.stdout}`);
  }
  if (!quiet) console.error(chalk.green(`✓ Distribution plot saved to ${outPath}`));
}

function reportSummary(r: DistributionResult, highlightHgvs: string[]): void {
  console.log(chalk.cyan(`\n📊 Cosic-RRM ClinVar distribution  ${r.gene}`));
  console.log(chalk.cyan('─'.repeat(72)));
  console.log(`  total ClinVar hits:          ${r.total_clinvar_hits}`);
  console.log(`  parsed as missense:          ${r.parsed_missense}`);
  console.log(`  by classification:`);
  for (const [k, v] of Object.entries(r.by_classification)) {
    console.log(`    ${k.padEnd(22)} ${v}`);
  }
  console.log(chalk.cyan('─'.repeat(72)));

  const scored = r.variants.filter(v => v.fullSpectrumL1 !== undefined);
  const byClass = (cls: string) => scored.filter(v => v.classification_simple === cls);

  const stat = (xs: number[]) => {
    if (xs.length === 0) return { n: 0, mean: 0, median: 0, max: 0, min: 0 };
    const sorted = [...xs].sort((a, b) => a - b);
    return {
      n: xs.length,
      mean: xs.reduce((a, b) => a + b, 0) / xs.length,
      median: sorted[Math.floor(xs.length / 2)],
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  };

  console.log('  Per-class L1 distance summary:');
  for (const cls of ['pathogenic', 'likely_pathogenic', 'vus', 'likely_benign', 'benign']) {
    const xs = byClass(cls).map(v => v.fullSpectrumL1!);
    const s = stat(xs);
    if (s.n === 0) continue;
    console.log(`    ${cls.padEnd(22)} n=${s.n}, median=${s.median.toExponential(2)}, mean=${s.mean.toExponential(2)}, [${s.min.toExponential(2)}, ${s.max.toExponential(2)}]`);
  }
  console.log('');
}

export async function rrmDistributionCommand(gene: string, opts: RrmDistributionOptions): Promise<void> {
  const upper = gene.toUpperCase();
  const uniprot = GENE_TO_UNIPROT[upper];
  if (!uniprot) throw new Error(`No UniProt mapping for ${upper}. Built-in: ${Object.keys(GENE_TO_UNIPROT).join(', ')}`);

  fs.mkdirSync(RRM_CACHE_DIR, { recursive: true });
  const cachePath = path.join(RRM_CACHE_DIR, `${upper}-distribution.json`);

  if (fs.existsSync(cachePath) && !opts.refresh) {
    if (!opts.quiet) console.error(chalk.gray(`✓ Using cached distribution (use --refresh to recompute)`));
    const cached: DistributionResult = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    reportSummary(cached, (opts.highlight || '').split(',').map(s => s.trim()).filter(Boolean));
    if (opts.plot) {
      plotDistribution(cached, opts.plot, (opts.highlight || '').split(',').map(s => s.trim()).filter(Boolean), opts.quiet || false);
    }
    return;
  }

  // Consensus required
  const consensusPath = path.join(RRM_CACHE_DIR, `${upper}.json`);
  if (!fs.existsSync(consensusPath)) {
    throw new Error(`No consensus f_c cached for ${upper}. Run first: biofs rrm-consensus ${upper}`);
  }
  const cons = JSON.parse(fs.readFileSync(consensusPath, 'utf8'));

  // UniProt sequence (cached or fetch)
  fs.mkdirSync(UNIPROT_CACHE_DIR, { recursive: true });
  const fastaPath = path.join(UNIPROT_CACHE_DIR, `${uniprot}.fasta`);
  if (!fs.existsSync(fastaPath)) {
    const fr = spawnSync('curl', ['-sS', '-A', 'biofs/3.2.0', '--max-time', '60', `https://rest.uniprot.org/uniprotkb/${uniprot}.fasta`], { encoding: 'utf8' });
    if (fr.status !== 0) throw new Error(`UniProt fetch failed for ${uniprot}: ${fr.stderr}`);
    fs.writeFileSync(fastaPath, fr.stdout);
  }
  const seq = fs.readFileSync(fastaPath, 'utf8').split('\n').slice(1).join('').replace(/\s/g, '').toUpperCase();

  // Bumped default retmax from 1000 → 10000 since the new server-side VUS/Conflicting
  // exclusion means many genes (BRCA1, BRCA2, TP53, LDLR) need a larger window to
  // capture all P+LP+B+LB entries. Genes with fewer entries return their actual
  // total; genes with more pages are paginated.
  const retmax = parseInt(opts.retmax || '10000', 10);
  const spinner = opts.quiet ? null : ora(`Fetching ClinVar variants for ${upper}...`).start();
  const ids = fetchClinVarIds(upper, retmax, opts.quiet || false);
  if (spinner) spinner.succeed(`Found ${ids.length} ClinVar IDs`);

  const sp2 = opts.quiet ? null : ora(`Fetching ${ids.length} ClinVar summaries...`).start();
  const summaries = fetchClinVarSummaries(ids, opts.quiet || false);
  if (sp2) sp2.succeed(`Retrieved ${summaries.length} summaries`);

  const sp3 = opts.quiet ? null : ora(`Parsing missense variants...`).start();
  const parsed: ClinVarVariant[] = [];
  for (const s of summaries) {
    const v = extractMissenseFromSummary(s);
    if (v) parsed.push(v);
  }
  if (sp3) sp3.succeed(`Parsed ${parsed.length} missense variants`);

  // Batch score via python
  const sp4 = opts.quiet ? null : ora(`Computing Cosic-RRM features for ${parsed.length} variants...`).start();
  const scoreInput = {
    sequence: seq,
    common_length: cons.common_length,
    fc_freq: cons.characteristic_frequency_normalized,
    peaks: cons.consensus_peak_bins || [],
    // Pass the entire parsed object through; Python preserves keys via {**v, ...}
    variants: parsed,
  };
  const pyRes = spawnSync('python3', ['-c', PY_BATCH_SCORE], { encoding: 'utf8', input: JSON.stringify(scoreInput), maxBuffer: 500 * 1024 * 1024 });
  if (pyRes.status !== 0) {
    if (sp4) sp4.fail('Batch scoring failed');
    throw new Error(`Batch Cosic scoring failed: ${pyRes.stderr || pyRes.stdout}`);
  }
  const scored = JSON.parse(pyRes.stdout);
  if (sp4) sp4.succeed(`Scored ${scored.filter((v: any) => v.fullSpectrumL1 !== undefined).length} of ${scored.length} variants (some skipped on reference mismatch)`);

  const byClass: Record<string, number> = {};
  for (const v of scored) {
    byClass[v.classification_simple] = (byClass[v.classification_simple] || 0) + 1;
  }

  // === gnomAD pseudo-benign synthesis (optional) ===
  // For rare-disease genes whose ClinVar P+LP is large but B+LB is 0, AUC
  // benchmarking is infeasible without negative controls. We synthesize a
  // set of presumed-benign common population variants from gnomAD and label
  // them as likely_benign. These variants are NOT ACMG benign by ClinVar
  // curation; they are population-frequency-implied benigns for cohort-
  // benchmarking purposes only. This is clearly noted in the output JSON.
  let scoredWithBenigns = scored;
  let nSynthesized = 0;
  if (opts.gnomadBenigns) {
    const nWanted = parseInt(opts.gnomadBenigns, 10);
    const minAf = parseFloat(opts.gnomadMinAf || '0.01');
    if (nWanted > 0) {
      if (!opts.quiet) {
        process.stderr.write(`\n  Synthesizing up to ${nWanted} gnomAD pseudo-benigns (AF >= ${minAf})...\n`);
      }
      try {
        const synth = await synthesizeGnomadPseudoBenigns(upper, uniprot, nWanted, minAf, parsed, opts.quiet || false);
        nSynthesized = synth.length;
        // Score each synthesized variant via the same Cosic pipeline as ClinVar entries.
        if (nSynthesized > 0) {
          const synthScoreInput = {
            sequence: seq,
            common_length: cons.common_length,
            fc_freq: cons.characteristic_frequency_normalized,
            peaks: cons.consensus_peak_bins || [],
            variants: synth,
          };
          const synthPy = spawnSync('python3', ['-c', PY_BATCH_SCORE], { encoding: 'utf8', input: JSON.stringify(synthScoreInput), maxBuffer: 500 * 1024 * 1024 });
          if (synthPy.status === 0) {
            const scoredSynth = JSON.parse(synthPy.stdout).map((v: any) => ({ ...v, source: 'gnomad_pseudo_benign' }));
            scoredWithBenigns = [...scored, ...scoredSynth];
            for (const v of scoredSynth) {
              byClass[v.classification_simple] = (byClass[v.classification_simple] || 0) + 1;
            }
            if (!opts.quiet) {
              process.stderr.write(`  ✓ Added ${scoredSynth.length} pseudo-benigns to distribution\n`);
            }
          } else if (!opts.quiet) {
            process.stderr.write(`  ⚠ Pseudo-benign scoring failed: ${synthPy.stderr || synthPy.stdout}\n`);
          }
        }
      } catch (e) {
        if (!opts.quiet) process.stderr.write(`  ⚠ gnomAD pseudo-benign synthesis failed: ${(e as Error).message}\n`);
      }
    }
  }

  const result: DistributionResult = {
    gene: upper,
    uniprot,
    total_clinvar_hits: ids.length,
    parsed_missense: parsed.length,
    by_classification: byClass,
    variants: scoredWithBenigns,
    generated_at: new Date().toISOString(),
    gnomad_pseudo_benigns_synthesized: nSynthesized || undefined,
  } as any;

  fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
  if (!opts.quiet) console.error(chalk.green(`✓ Saved distribution to ${cachePath}${nSynthesized ? ` (incl. ${nSynthesized} gnomAD pseudo-benigns)` : ''}`));

  reportSummary(result, (opts.highlight || '').split(',').map(s => s.trim()).filter(Boolean));

  if (opts.plot) {
    plotDistribution(result, opts.plot, (opts.highlight || '').split(',').map(s => s.trim()).filter(Boolean), opts.quiet || false);
  }
}
