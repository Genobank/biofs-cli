/**
 * biofs alphagenome score <caseId> --variant chr:pos:ref:alt [...] --ontology UBERON:... --source-biocid <biocid> --code-sha256 <hex> --accept-alphagenome-terms [--owner <biowallet>] [--wait]
 *
 * A governed biofs-node job (kind alphagenome): the node checks the signer, the owner and the consent of the source biocid, runs Google's AlphaGenome SDK on the node that holds the service key, and registers the
 * report as a derived biofile under the owner with the source as lineage. Only coordinates and alleles reach AlphaGenome; no wallet, case label or biocid is sent.
 * Variants are VCF-style (left-anchored indels: the first base of ref is the shared anchor base). Google's terms apply (non-commercial research, no clinical use, no training of variant-effect models):
 * acceptance is an explicit flag. AlphaGenome models regulation and splicing; it is not a missense predictor. Score only variants with read support (acmg-triage --support).
 */
import { ownerOr, parseSha256, requireBiocid, submitKindCommand } from '../neoantigen-pipeline';

const CHROMS = new Set([...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`), 'chrX', 'chrY', 'chrM']);
export const WINDOWS = [16384, 131072, 524288, 1048576];
export const OUTPUTS = ['RNA_SEQ', 'CAGE', 'DNASE', 'ATAC', 'CHIP_HISTONE', 'CHIP_TF', 'SPLICE_SITES', 'SPLICE_SITE_USAGE', 'SPLICE_JUNCTIONS', 'CONTACT_MAPS', 'PROCAP'];

export interface Variant { chromosome: string; position: number; reference_bases: string; alternate_bases: string }
export interface AlphaGenomeOptions {
  variant: string[];
  ontology: string[];
  outputs?: string[];
  window?: string;
  sourceBiocid: string;
  codeSha256: string;
  acceptAlphagenomeTerms?: boolean;
  owner?: string;
  caseLabel?: string;
  wait?: boolean;
  json?: boolean;
}

/** "chr7:83961822:CTG:C" -> Variant. Refuses the "-" allele of OpenCRAVAT and anything that is not plain bases. */
export function parseVariant(text: string): Variant {
  const m = /^(chr[0-9XYM]+):(\d+):([ACGT]+):([ACGT]+)$/i.exec(String(text).trim());
  if (!m) {
    if (/:-|-:/.test(String(text))) throw new Error(`"${text}": the "-" allele is OpenCRAVAT notation. Give the VCF form with the anchor base (for a deletion, position one base earlier and ref and alt both start with the anchor base)`);
    throw new Error(`"${text}" is not chr:pos:ref:alt with plain A, C, G, T bases`);
  }
  const chromosome = m[1].replace(/^CHR/, 'chr');
  if (!CHROMS.has(chromosome)) throw new Error(`"${text}": unknown chromosome ${chromosome}`);
  const position = Number(m[2]);
  if (!Number.isSafeInteger(position) || position < 1) throw new Error(`"${text}": bad position`);
  const reference_bases = m[3].toUpperCase();
  const alternate_bases = m[4].toUpperCase();
  if (reference_bases === alternate_bases) throw new Error(`"${text}": ref and alt are identical`);
  if (reference_bases.length > 64 || alternate_bases.length > 64) throw new Error(`"${text}": alleles longer than 64 bases are not scored`);
  return { chromosome, position, reference_bases, alternate_bases };
}

export function buildAlphagenomeBody(caseId: string, o: AlphaGenomeOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  if (!o.acceptAlphagenomeTerms) throw new Error('add --accept-alphagenome-terms: AlphaGenome is for non-commercial research only, not for clinical use or medical advice, and its outputs may not be used to train variant-effect models (Google AlphaGenome terms)');
  const variants = (o.variant || []).map(parseVariant);
  if (variants.length < 1 || variants.length > 50) throw new Error('give 1 to 50 --variant values');
  if (!o.ontology || !o.ontology.length) throw new Error('give at least one --ontology term (for example UBERON:0001134 or CL:0000062); it selects the tissue or cell type the prediction is made for');
  for (const t of o.ontology) if (!/^[A-Z]{2,8}:[0-9]{3,9}$/.test(t)) throw new Error(`--ontology ${t} is not an ontology term like UBERON:0001134`);
  const outputs = (o.outputs && o.outputs.length ? o.outputs : ['RNA_SEQ']).map((x) => x.toUpperCase());
  for (const x of outputs) if (!OUTPUTS.includes(x)) throw new Error(`unknown output ${x}; use one of ${OUTPUTS.join(', ')}`);
  const window = Number(o.window || 131072);
  if (!WINDOWS.includes(window)) throw new Error(`--window must be one of ${WINDOWS.join(', ')}`);
  return {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId,
    variants, ontology_terms: o.ontology, requested_outputs: outputs, window_bp: window,
    source_biocid: requireBiocid('--source-biocid', o.sourceBiocid),
    code_sha256: parseSha256('--code-sha256', o.codeSha256),
    accept_alphagenome_terms: true, executor: 'local', case_label: o.caseLabel || caseId,
  };
}

export async function alphagenomeSubmitCommand(caseId: string, options: AlphaGenomeOptions): Promise<void> {
  await submitKindCommand('alphagenome', (wallet, signature) => buildAlphagenomeBody(caseId, options, wallet, signature), options);
}
