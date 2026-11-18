/**
 * The validation benchmark (gt_benchmark_v1): known missense changes of ITGA2B and ITGB3 labelled from PUBLIC
 * data only (ClinVar at 2 stars or more, gnomAD v4). It is built by scripts/protein-impact/build_benchmark.py and
 * bundled as benchmark.json. No sample is read or written. The gate document pins the hash of this bundle, so
 * a validation always names exactly the labels it was scored against.
 */

import benchmarkJson from './benchmark_v1.json';
import { GENES } from './constants';
import { domainOf } from './domains';
import { formatVariant, toMature } from './numbering';
import { canonicalJson, sha256Hex } from './request';
import type { SubInfo } from './core';

export interface BenchRow {
  variant_id: string;   // e.g. ITGA2B:p.Q778P
  gene: string;
  pos: number;          // HGVS precursor numbering
  ref: string;
  alt: string;
  domain: string;
  label: 0 | 1;         // 1 = damaging (ClinVar Pathogenic or Likely pathogenic), 0 = tolerated
  tier: 'B' | 'C';
  evidence: string;
  clinvar_vcv: string;
  gnomad_af: number | null;
  gnomad_hom: number | null;
}

export interface Benchmark {
  name: string;
  rows: BenchRow[];
  /** sha256 of the canonical JSON of the bundled file: what a gate document pins. */
  sha256: string;
  tsv_sha256: string;
}

interface Bundle { schema: string; name: string; tsv_sha256: string; columns: string[]; rows: Array<Array<string | number | null>> }

export function loadBenchmark(): Benchmark {
  const b = benchmarkJson as unknown as Bundle;
  if (b.schema !== 'genobank.protein-impact.benchmark/v1') throw new Error('benchmark.json has the wrong schema');
  const rows = b.rows.map(r => {
    const o: Record<string, unknown> = {};
    b.columns.forEach((c, i) => { o[c] = r[i]; });
    return {
      variant_id: o.variant_id, gene: o.gene, pos: o.hgvs_pos, ref: o.ref, alt: o.alt, domain: o.domain,
      label: o.label, tier: o.tier, evidence: o.evidence, clinvar_vcv: o.clinvar_vcv, gnomad_af: o.gnomad_af, gnomad_hom: o.gnomad_hom,
    } as BenchRow;
  });
  return { name: b.name, rows, sha256: sha256Hex(canonicalJson(b)), tsv_sha256: b.tsv_sha256 };
}

/** Problems found in the benchmark; empty means it is internally consistent (and matches the sequences, if given). */
export function validateBenchmark(b: Benchmark, sequences?: Record<string, string>): string[] {
  const why: string[] = [];
  const seen = new Set<string>();
  for (const r of b.rows) {
    const g = GENES[r.gene];
    if (!g) { why.push(`${r.variant_id}: gene ${r.gene} is not supported`); continue; }
    if (seen.has(r.variant_id)) why.push(`${r.variant_id}: listed twice`);
    seen.add(r.variant_id);
    if (r.variant_id !== formatVariant({ gene: r.gene, ref: r.ref, pos: r.pos, alt: r.alt }, 'one')) why.push(`${r.variant_id}: id does not match its fields`);
    if (r.ref === r.alt) why.push(`${r.variant_id}: ref equals alt`);
    if (!(r.pos > g.signal && r.pos <= g.length)) { why.push(`${r.variant_id}: position outside the mature chain`); continue; }
    if (domainOf(r.gene, r.pos) !== r.domain) why.push(`${r.variant_id}: domain ${r.domain} disagrees with the domain table`);
    if (r.label !== 0 && r.label !== 1) why.push(`${r.variant_id}: label must be 0 or 1`);
    if (r.label === 0 && r.tier === 'B' && !r.evidence.startsWith('clinvar_blb')) why.push(`${r.variant_id}: tier B tolerated variant without ClinVar benign evidence`);
    if (r.label === 1 && r.evidence !== 'clinvar_plp') why.push(`${r.variant_id}: a damaging label needs ClinVar pathogenic evidence`);
    const seq = sequences?.[r.gene];
    if (seq && seq[r.pos - 1] !== r.ref) why.push(`${r.variant_id}: the pinned sequence has ${seq[r.pos - 1]} at ${r.pos}`);
  }
  return why;
}

/** The benchmark as the stage inputs the scoring layers take. */
export function benchmarkSubs(b: Benchmark, genes?: string[]): SubInfo[] {
  return b.rows
    .filter(r => !genes || genes.includes(r.gene))
    .map(r => ({ variant: formatVariant({ gene: r.gene, ref: r.ref, pos: r.pos, alt: r.alt }), gene: r.gene, pos: r.pos, mature_pos: toMature(r.gene, r.pos), ref: r.ref, alt: r.alt }));
}
