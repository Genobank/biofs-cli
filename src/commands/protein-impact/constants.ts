/**
 * biofs protein-impact: constants shared by the client (submit) and the executor (exec).
 *
 * Research-grade, NOT clinical. Only public reference data (UniProt, RCSB) is fetched here; the
 * proband's data enters only as (gene, ref, pos, alt) tuples from `biofs variants`. There is no
 * free-text sequence input anywhere in this verb (see guard.ts).
 */

export const SCHEMA_REQUEST = 'genobank.protein-impact.request/v1';
export const SCHEMA_MANIFEST = 'genobank.protein-impact.manifest/v1';
export const SCHEMA_GATE = 'genobank.protein-impact.gate/v1';
export const SCHEMA_GATE_RULES = 'genobank.protein-impact.gate-rules/v1';

export const INPUT_TYPE_CPU = 'protein-impact';
export const INPUT_TYPE_GPU = 'protein-impact-gpu';

export interface GeneSpec {
  gene: string;       // HGNC symbol
  uniprot: string;    // UniProt accession
  length: number;     // precursor length; HGVS protein numbering counts from the precursor Met
  signal: number;     // signal peptide length: classical (mature chain) numbering = HGVS - signal
  seq_sha256: string; // sha256 of the precursor residue string (no header, no newlines)
}

/**
 * Genes this verb accepts. Verified against UniProt release 2026_03 on 2026-10-21:
 * P08514 ITGA2B length 1039, signal 1..31; P05106 ITGB3 length 788, signal 1..26.
 * `fetch` refuses to continue if UniProt serves a sequence whose sha256 differs from the pin.
 * Adding a gene is a code change on purpose (nothing arbitrary can be scored).
 */
export const GENES: Record<string, GeneSpec> = {
  ITGA2B: { gene: 'ITGA2B', uniprot: 'P08514', length: 1039, signal: 31, seq_sha256: 'e85172b63418bae377c4c00c4dae573e7019ae1ee9f96a133c2be00977e1a9bb' },
  ITGB3: { gene: 'ITGB3', uniprot: 'P05106', length: 788, signal: 26, seq_sha256: 'dd1f27b57d8ba531160f0b9e03b9ae50533fbe1b3205765e545b0daa3c82bb52' },
};

/** `gate:sha256:<64 hex>`: the content hash of a gate document that travels with the apply job. */
export const GATE_ID_RE = /^gate:sha256:[a-f0-9]{64}$/;
/** Source biocids the variants were read from; consent is verified against these by biofs-node. */
export const BIOCID_RE = /^biocid:\/\/[A-Za-z0-9._:\/-]{3,300}$/;
export const MAX_SOURCES = 4;

export const RESEARCH_BANNER = 'Research-grade analysis of missense substitutions. Not a clinical test, not a diagnosis, not medical advice.';

/** Process exit codes of `exec`; biofs-node records any non-zero exit as a failed job. */
export const EXIT = { OK: 0, FAILED: 1, GUARD: 2, EMPTY: 7, GATE_BLOCKED: 8, APPROVAL: 9 } as const;

export const STANDARD_AA = 'ACDEFGHIKLMNPQRSTVWY';

export const AA3_TO_1: Record<string, string> = {
  Ala: 'A', Arg: 'R', Asn: 'N', Asp: 'D', Cys: 'C', Gln: 'Q', Glu: 'E', Gly: 'G', His: 'H', Ile: 'I',
  Leu: 'L', Lys: 'K', Met: 'M', Phe: 'F', Pro: 'P', Ser: 'S', Thr: 'T', Trp: 'W', Tyr: 'Y', Val: 'V',
};

export const AA1_TO_3: Record<string, string> = Object.fromEntries(
  Object.entries(AA3_TO_1).map(([three, one]) => [one, three]),
);

/** Layers a request may ask for. `features` and `fetch` are CPU-only and need no images. */
export const LAYERS = ['fetch', 'features', 'plm', 'structure', 'complex', 'probe', 'md'] as const;
export type Layer = (typeof LAYERS)[number];
export const GPU_LAYERS: ReadonlyArray<Layer> = ['complex', 'probe', 'md'];

export const MODES = ['fetch', 'validate', 'apply', 'probe'] as const;
export type Mode = (typeof MODES)[number];

export const MAX_SUBS_PER_REQUEST = 20;
export const MAX_GENES_PER_REQUEST = 2;
