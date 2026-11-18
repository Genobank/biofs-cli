/**
 * Residue numbering for protein-impact.
 *
 * HGVS protein positions count from the precursor Met. The GT literature and the PDB entries use the
 * mature chain, so every literature or structure comparison must convert first:
 *   ITGA2B (P08514): signal 1..31, mature = HGVS - 31   (Val779 = 748, Leu225 = 194, Asn2 = 33)
 *   ITGB3  (P05106): signal 1..26, mature = HGVS - 26   (ONE global offset would corrupt ITGB3 rows)
 * `structureOffset` derives the offset of a structure chain from its own sequence instead of assuming it.
 */

import { AA1_TO_3, AA3_TO_1, GENES, STANDARD_AA } from './constants';

export interface Substitution {
  gene: string;
  ref: string; // one-letter, precursor sequence residue
  pos: number; // HGVS precursor position
  alt: string; // one-letter
}

export class NumberingError extends Error {}

const THREE = /^p\.([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2})$/;
const ONE = /^p?\.?([A-Z])(\d+)([A-Z])$/;

function geneSpec(gene: string) {
  const g = GENES[gene.toUpperCase()];
  if (!g) throw new NumberingError(`gene not supported: ${gene} (supported: ${Object.keys(GENES).join(', ')})`);
  return g;
}

/** Parse `ITGA2B:p.Leu225Arg`, `ITGA2B:p.L225R` or `ITGA2B:L225R`. Missense only. */
export function parseVariant(spec: string): Substitution {
  const s = (spec || '').trim();
  const colon = s.indexOf(':');
  if (colon < 1) throw new NumberingError(`variant must look like GENE:p.Leu225Arg, got "${spec}"`);
  const g = geneSpec(s.slice(0, colon));
  const rest = s.slice(colon + 1).trim();
  let ref: string, pos: number, alt: string;
  const m3 = THREE.exec(rest);
  if (m3) {
    ref = AA3_TO_1[m3[1]]; alt = AA3_TO_1[m3[3]]; pos = parseInt(m3[2], 10);
    if (!ref || !alt) throw new NumberingError(`only missense substitutions are accepted (both residues must be standard amino acids; no stop, Ter or Sec): ${rest}`);
  } else {
    const m1 = ONE.exec(rest);
    if (!m1) throw new NumberingError(`only missense substitutions are accepted (no stop, frameshift, deletion or synonymous): ${rest}`);
    ref = m1[1]; pos = parseInt(m1[2], 10); alt = m1[3];
  }
  if (!STANDARD_AA.includes(ref) || !STANDARD_AA.includes(alt)) throw new NumberingError(`non-standard residue in ${rest}`);
  if (ref === alt) throw new NumberingError(`reference and alternate residue are identical: ${rest}`);
  if (!Number.isInteger(pos) || pos <= g.signal || pos > g.length) {
    throw new NumberingError(`position ${pos} is outside ${g.gene} mature protein (${g.signal + 1}..${g.length}, HGVS numbering)`);
  }
  return { gene: g.gene, ref, pos, alt };
}

export function formatVariant(s: Substitution, style: 'three' | 'one' = 'three'): string {
  return style === 'three'
    ? `${s.gene}:p.${AA1_TO_3[s.ref]}${s.pos}${AA1_TO_3[s.alt]}`
    : `${s.gene}:p.${s.ref}${s.pos}${s.alt}`;
}

/** HGVS (precursor) -> classical mature-chain numbering. */
export function toMature(gene: string, hgvsPos: number): number {
  const g = geneSpec(gene);
  if (!Number.isInteger(hgvsPos) || hgvsPos <= g.signal || hgvsPos > g.length) {
    throw new NumberingError(`${g.gene} position ${hgvsPos} is not in the mature chain`);
  }
  return hgvsPos - g.signal;
}

/** Classical mature-chain numbering -> HGVS (precursor). */
export function fromMature(gene: string, maturePos: number): number {
  const g = geneSpec(gene);
  const hgvs = maturePos + g.signal;
  if (!Number.isInteger(maturePos) || maturePos < 1 || hgvs > g.length) {
    throw new NumberingError(`${g.gene} mature position ${maturePos} is out of range`);
  }
  return hgvs;
}

/** Throw unless the pinned UniProt sequence has the stated reference residue at the stated position. */
export function assertResidue(sub: Substitution, sequence: string): void {
  const g = geneSpec(sub.gene);
  if (sequence.length !== g.length) {
    throw new NumberingError(`${g.gene} sequence has ${sequence.length} residues, expected ${g.length} (wrong UniProt release or isoform)`);
  }
  const found = sequence[sub.pos - 1];
  if (found !== sub.ref) {
    throw new NumberingError(`${formatVariant(sub)}: the reference sequence has ${found} (${AA1_TO_3[found] || '?'}) at ${sub.pos}, not ${sub.ref}`);
  }
}

/**
 * Offset between HGVS numbering and a structure chain: position_in_structure = hgvsPos - offset.
 * Found by locating the chain's own sequence inside the UniProt sequence (first 12 residues as the
 * anchor, then verified over the first 50), never assumed. Returns null when it cannot be anchored.
 */
export function structureOffset(uniprotSeq: string, chainSeq: string): number | null {
  const anchor = chainSeq.slice(0, 12);
  if (anchor.length < 12) return null;
  const first = uniprotSeq.indexOf(anchor);
  if (first < 0 || uniprotSeq.indexOf(anchor, first + 1) >= 0) return null;
  const n = Math.min(50, chainSeq.length, uniprotSeq.length - first);
  if (uniprotSeq.slice(first, first + n) !== chainSeq.slice(0, n)) return null;
  return first; // structure residue 1 is UniProt first + 1, so offset = first
}
