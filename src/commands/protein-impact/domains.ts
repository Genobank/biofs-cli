/**
 * Structural domains of ITGA2B and ITGB3 in HGVS numbering, from CATH boundaries of the 3FCS ectodomain
 * structure (see domains.json). The validation gate reports AUROC per domain and requires floors for the
 * beta-propeller and the calf domains of alpha-IIb, so a score that only works in one region cannot pass.
 */

import domainsJson from './domain_table.json';
import { GENES } from './constants';

interface Range { domain: string; start: number; end: number }
const TABLE = (domainsJson as unknown as { genes: Record<string, Range[]> }).genes;

export function domainOf(gene: string, hgvsPos: number): string {
  const g = GENES[gene.toUpperCase()];
  if (!g) throw new Error(`gene not supported: ${gene}`);
  const hit = (TABLE[g.gene] || []).find(r => hgvsPos >= r.start && hgvsPos <= r.end);
  if (!hit) throw new Error(`${g.gene} position ${hgvsPos} is outside the domain table`);
  return hit.domain;
}

/** Every domain name used by either gene, for reporting. */
export function domainNames(): string[] {
  return [...new Set(Object.values(TABLE).flatMap(rs => rs.map(r => r.domain)))];
}
