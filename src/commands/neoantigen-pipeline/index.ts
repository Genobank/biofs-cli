/**
 * biofs neoantigen-evidence submit <caseId> --somatic-sqlite <biocid> --filtered-vcf <biocid> --tumor <biocid> --normal <biocid> [--second-dna <biocid>] [--rna <biocid>] [--tpm <biocid>]
 * biofs neoantigen-evidence status <job> [--wait]
 * biofs neoantigen-design   submit <caseId> --evidence <biocid> (--hla <alleles> | --hla-from <biocid> [--accept-low-confidence]) [--n 20] [--weights ...]
 * biofs neoantigen-hla      submit <caseId> --normal <biocid> [--rna <biocid>] [--depth-curve 0.5,0.25,0.1] [--include-unmapped]
 * biofs neoantigen-fusion   submit <caseId> --fusion-evidence <biocid> --five-gene <symbol> --three-gene <symbol> (--hla <alleles> | --hla-from <biocid>) [--min-templates 10]
 * biofs neoantigen-indel    submit <caseId> --somatic-sqlite <biocid> (--hla <alleles> | --hla-from <biocid>) [--tpm <biocid>] [--min-alt 8] [--genes TGFBR2,...]
 * every submit verb takes [--executor auto|worker|local]: auto (default) runs on a healthy neoantigen worker agent and otherwise on the node, worker never falls back, local never uses a worker.
 * biofs neoantigen-design   status <job> [--wait]
 *
 * CLIENT verbs. Evidence: for every somatic missense call of the caller's own annotation sqlite, the FilterMutectCalls status and read-level evidence (depth, ref/alt/other
 * counts after MAPQ and BQ filters, strand, F1R2/F2R1 orientation, read-end distance, mate-overlap counted once) in the tumor, the matched normal, an optional second tumor
 * assay and optional RNA, merged with gene TPM into one features table. Design: that features table, the patient's HLA and the GENCODE proteome through the genobank
 * neoantigen engine v2 (evidence gate, paired wild type, rank-based allele choice, processing-aware presentation, 27-mer windows, per-junction linker choice) into a ranked
 * table, a reserve list, the gate failures with reasons, the cassette protein and the junction scan.
 *
 * Every biodata input is a biocid. biofs-node resolves each one through biocid_registry and refuses any it does not find owned by the signer; no read leaves the server.
 * A raw gs:// path, an https URL or a file path is rejected here, before anything is sent. Each result is registered as its own biocid in the signer's biowallet.
 * Fusion: the junction-spanning peptides of an RNA-confirmed in-frame fusion (reading frame found from the data, hybrid codon kept, proteome-novel peptides only, class I scored).
 * Indel: the mutant protein of every somatic frameshift and in-frame indel rebuilt from the transcript and checked against the annotation, with NMD flagged and class I scored.
 * Decision support for a human review, never a clinical device. Server routes: POST /neoantigen_evidence, _hla, _design, _fusion, _indel; GET the same names with _status.
 */
import axios from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export const BIOCID_RE = /^biocid(:\/\/|:)[A-Za-z0-9_-]+\/0x[0-9a-fA-F]{40}\/[A-Za-z0-9_-]+\/\S+$/i;
export const HLA_RE = /^HLA-(A|B|C)\*\d{2,3}:\d{2,3}$/;

export interface NeoantigenEvidenceOptions {
  somaticSqlite: string;
  filteredVcf: string;
  tumor: string;
  normal: string;
  secondDna?: string[];
  rna?: string;
  tpm?: string;
  minMapq?: string;
  minBq?: string;
  label?: string;
  executor?: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

export interface NeoantigenDesignOptions {
  evidence: string;
  hla?: string;
  hlaFrom?: string;
  acceptLowConfidence?: boolean;
  proteome?: string;
  n?: string;
  weights?: string;
  patient?: string;
  expect?: string;
  executor?: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

export function requireBiocid(flag: string, value: string): string {
  if (!value || !BIOCID_RE.test(value)) {
    throw new Error(`${flag} must be a biocid (biocid://<bioagent>/<owner wallet>/<biodata type>/<dataset>); a gs:// path, URL or file path is never accepted`);
  }
  return value;
}

export function parseHla(list: string): string[] {
  const alleles = (list || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (alleles.length < 1 || alleles.length > 6) throw new Error('--hla needs 1 to 6 class I alleles, for example HLA-A*02:01,HLA-A*29:02,HLA-B*38:01');
  for (const a of alleles) {
    if (!HLA_RE.test(a)) throw new Error(`--hla allele "${a}" is not a class I allele in the form HLA-A*02:01`);
  }
  return Array.from(new Set(alleles));
}

export function parseWeights(w?: string): number[] {
  const parts = (w || '0.45,0.25,0.20,0.10').split(',').map((x) => parseFloat(x));
  if ((parts.length !== 4 && parts.length !== 5) || parts.some((x) => !isFinite(x) || x < 0)) {
    throw new Error('--weights needs 4 values (presentation,foreignness,expression,clonality) or 5 (adds evidence), all non-negative');
  }
  const sum = parts.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.011) throw new Error(`--weights must sum to 1 (got ${sum.toFixed(3)})`);
  return parts;
}

/** Where the job runs: a healthy neoantigen worker agent when there is one (auto, the default), only on a worker (worker: never falls back to the node), or only on the node (local). */
export function parseExecutor(v?: string): 'auto' | 'worker' | 'local' {
  const x = (v === undefined || v === '' ? 'auto' : v);
  if (x !== 'auto' && x !== 'worker' && x !== 'local') throw new Error('--executor must be auto, worker or local');
  return x;
}

export function ownerOr(owner: string | undefined, signer: string): string {
  if (!owner) return signer;
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error('--owner must be an EIP-55 biowallet address');
  return owner;
}

export function parseCount(n: string | undefined, def: number, lo: number, hi: number, flag: string): number {
  const v = n === undefined || n === '' ? def : parseInt(n, 10);
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${flag} must be an integer from ${lo} to ${hi}`);
  return v;
}

export function buildEvidenceBody(caseId: string, o: NeoantigenEvidenceOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  return {
    wallet: ownerOr(o.owner, wallet),
    signature,
    case_id: caseId,
    somatic_sqlite_biocid: requireBiocid('--somatic-sqlite', o.somaticSqlite),
    filtered_vcf_biocid: requireBiocid('--filtered-vcf', o.filteredVcf),
    tumor_biocid: requireBiocid('--tumor', o.tumor),
    normal_biocid: requireBiocid('--normal', o.normal),
    second_dna_biocid: (o.secondDna || []).map((b) => requireBiocid('--second-dna', b)),
    rna_biocid: o.rna ? requireBiocid('--rna', o.rna) : '',
    tpm_biocid: o.tpm ? requireBiocid('--tpm', o.tpm) : '',
    min_mapq: parseCount(o.minMapq, 20, 0, 60, '--min-mapq'),
    min_bq: parseCount(o.minBq, 20, 0, 60, '--min-bq'),
    label: o.label || '',
    executor: parseExecutor(o.executor),
  };
}

export interface NeoantigenHlaOptions { normal: string; rna?: string; depthCurve?: string; includeUnmapped?: boolean; executor?: string; owner?: string; wait?: boolean; json?: boolean }

/** Fractions of the typed read pairs to retype at (the depth curve), 1 to 5 values strictly between 0 and 1, largest first. */
export function parseDepthCurve(list: string): number[] {
  const parts = (list || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 5) throw new Error('--depth-curve needs 1 to 5 fractions, for example 0.5,0.25,0.1');
  const nums = parts.map((x) => Number(x));
  if (nums.some((x) => !isFinite(x) || x <= 0 || x >= 1)) throw new Error('--depth-curve fractions must be strictly between 0 and 1');
  return Array.from(new Set(nums)).sort((a, b) => b - a);
}

export function buildHlaBody(caseId: string, o: NeoantigenHlaOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const body: Record<string, unknown> = {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId, normal_biocid: requireBiocid('--normal', o.normal), rna_biocid: o.rna ? requireBiocid('--rna', o.rna) : '',
    include_unmapped: !!o.includeUnmapped,
    executor: parseExecutor(o.executor),
  };
  if (o.depthCurve !== undefined) body.depth_curve = parseDepthCurve(o.depthCurve);
  return body;
}

export const GENE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;

/** The HLA part of a request body, shared by design, fusion and indel: --hla (class I alleles) or --hla-from (an HLA typing report biocid), never both, never neither. */
export function hlaFieldsOf(o: { hla?: string; hlaFrom?: string; acceptLowConfidence?: boolean }): Record<string, unknown> {
  if (o.hla && o.hlaFrom) throw new Error('give --hla or --hla-from, not both');
  if (!o.hla && !o.hlaFrom) throw new Error('--hla (class I alleles) or --hla-from (the biocid of an HLA typing report) is required');
  if (o.acceptLowConfidence && !o.hlaFrom) throw new Error('--accept-low-confidence applies only with --hla-from');
  return o.hlaFrom
    ? { hla: [] as string[], hla_biocid: requireBiocid('--hla-from', o.hlaFrom), accept_low_confidence: !!o.acceptLowConfidence }
    : { hla: parseHla(o.hla as string) };
}

export function parseGene(flag: string, v: string | undefined): string {
  if (!v || !GENE_RE.test(v)) throw new Error(`${flag} must be a gene symbol such as CDH1`);
  return v;
}

export function parseGenes(list: string | undefined): string[] {
  const genes = (list || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (genes.length > 50) throw new Error('--genes takes at most 50 gene symbols');
  for (const g of genes) parseGene('--genes', g);
  return Array.from(new Set(genes));
}

export interface NeoantigenFusionOptions { fusionEvidence: string; fiveGene: string; threeGene: string; hla?: string; hlaFrom?: string; acceptLowConfidence?: boolean; proteome?: string; minTemplates?: string; executor?: string; owner?: string; wait?: boolean; json?: boolean }
export interface NeoantigenIndelOptions { somaticSqlite: string; hla?: string; hlaFrom?: string; acceptLowConfidence?: boolean; proteome?: string; gtf?: string; transcripts?: string; tpm?: string; minAlt?: string; genes?: string; executor?: string; owner?: string; wait?: boolean; json?: boolean }

export function buildFusionBody(caseId: string, o: NeoantigenFusionOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  return {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId,
    fusion_evidence_biocid: requireBiocid('--fusion-evidence', o.fusionEvidence),
    five_gene: parseGene('--five-gene', o.fiveGene), three_gene: parseGene('--three-gene', o.threeGene),
    ...hlaFieldsOf(o),
    proteome_biocid: o.proteome ? requireBiocid('--proteome', o.proteome) : '',
    min_templates: parseCount(o.minTemplates, 10, 1, 1000, '--min-templates'),
    executor: parseExecutor(o.executor),
  };
}

export function buildIndelBody(caseId: string, o: NeoantigenIndelOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const body: Record<string, unknown> = {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId,
    somatic_sqlite_biocid: requireBiocid('--somatic-sqlite', o.somaticSqlite),
    ...hlaFieldsOf(o),
    proteome_biocid: o.proteome ? requireBiocid('--proteome', o.proteome) : '',
    gtf_biocid: o.gtf ? requireBiocid('--gtf', o.gtf) : '',
    transcripts_biocid: o.transcripts ? requireBiocid('--transcripts', o.transcripts) : '',
    tpm_biocid: o.tpm ? requireBiocid('--tpm', o.tpm) : '',
    min_alt: parseCount(o.minAlt, 8, 1, 200, '--min-alt'),
    executor: parseExecutor(o.executor),
  };
  if (o.genes !== undefined) body.genes = parseGenes(o.genes);
  return body;
}

export function buildDesignBody(caseId: string, o: NeoantigenDesignOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const hlaFields = hlaFieldsOf(o);
  return {
    wallet: ownerOr(o.owner, wallet),
    signature,
    case_id: caseId,
    evidence_biocid: requireBiocid('--evidence', o.evidence),
    ...hlaFields,
    proteome_biocid: o.proteome ? requireBiocid('--proteome', o.proteome) : '',
    n: parseCount(o.n, 20, 1, 50, '--n'),
    weights: parseWeights(o.weights),
    patient: o.patient || caseId,
    expect_genes: o.expect ? o.expect.split(',').map((s) => s.trim()).filter(Boolean) : [],
    executor: parseExecutor(o.executor),
  };
}

async function auth() {
  const credentials = await getCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
  return {
    wallet: credentials.wallet_address,
    signature: credentials.user_signature,
    headers: { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature },
  };
}

type Kind = 'evidence' | 'design' | 'hla' | 'fusion' | 'indel';
const ROUTE: Record<Kind, { post: string; status: string; id: string; verb: string }> = {
  evidence: { post: 'neoantigen_evidence', status: 'neoantigen_evidence_status', id: 'neoantigen_job_id', verb: 'neoantigen-evidence' },
  design: { post: 'neoantigen_design', status: 'neoantigen_design_status', id: 'neoantigen_job_id', verb: 'neoantigen-design' },
  hla: { post: 'neoantigen_hla', status: 'neoantigen_hla_status', id: 'neoantigen_job_id', verb: 'neoantigen-hla' },
  fusion: { post: 'neoantigen_fusion', status: 'neoantigen_fusion_status', id: 'neoantigen_job_id', verb: 'neoantigen-fusion' },
  indel: { post: 'neoantigen_indel', status: 'neoantigen_indel_status', id: 'neoantigen_job_id', verb: 'neoantigen-indel' },
};

async function fetchStatus(kind: Kind, id: string, headers: Record<string, string>): Promise<any> {
  const r = await axios.get(`${BIOFS_NODE_BASE}/${ROUTE[kind].status}`, {
    params: { [ROUTE[kind].id]: id }, headers, timeout: 60_000, validateStatus: (s) => s < 500,
  });
  if (r.status >= 400) throw new Error(`status ${r.status}: ${r.data?.error || 'unknown'}`);
  return r.data;
}

/** One line about the on-chain proof of a finished job. Never blank for a finished job: an unanchored job must not look anchored. */
export function anchorLine(row: any): string | null {
  if (!row || row.status !== 'done') return null;
  const a = row.anchor;
  if (a && a.anchored === true) {
    return `token ${a.tokenId} on chain ${a.chain_id || '?'}${a.tx ? `, tx ${a.tx}` : ''}${a.idempotent ? ' (already on chain)' : ''}, manifest ${row.manifest_biocid || '?'}`;
  }
  if (a && a.anchored === false) return `NOT anchored: ${a.reason || 'no reason recorded'}`;
  if (row.anchor_request) return `pending (sealed in ${row.manifest_biocid || 'a manifest'}; the node anchors it within a minute)`;
  return 'NOT anchored: no manifest was sealed for this job';
}

function printSummary(kind: Kind, row: any): void {
  console.log(`${chalk.cyan('Job:')}     ${row[ROUTE[kind].id]}  ${row.status}`);
  if (row.executor) console.log(`${chalk.cyan('Executor:')} ${row.executor}${row.executor_note ? ` (${row.executor_note})` : ''}`);
  if (row.progress) console.log(`${chalk.cyan('Progress:')} ${JSON.stringify(row.progress)}`);
  if (row.summary) console.log(`${chalk.cyan('Summary:')}  ${JSON.stringify(row.summary)}`);
  if (row.result_biocid) console.log(`${chalk.cyan('Result:')}   ${row.result_biocid}`);
  const anchor = anchorLine(row);
  if (anchor) console.log(`${chalk.cyan('Anchor:')}   ${anchor}`);
  if (row.error) console.log(`${chalk.red('Error:')}    ${row.error}`);
}

async function waitFor(kind: Kind, id: string, headers: Record<string, string>, json?: boolean): Promise<void> {
  for (;;) {
    const row = await fetchStatus(kind, id, headers);
    if (row.status === 'done' || row.status === 'failed') {
      if (json) console.log(JSON.stringify(row, null, 2)); else printSummary(kind, row);
      if (row.status === 'failed') process.exit(1);
      return;
    }
    await new Promise((res) => setTimeout(res, 30_000));
  }
}

async function submit(kind: Kind, body: Record<string, unknown>, headers: Record<string, string>, opts: { wait?: boolean; json?: boolean }): Promise<void> {
  const r = await axios.post(`${BIOFS_NODE_BASE}/${ROUTE[kind].post}`, body, { headers, timeout: 60_000, validateStatus: (s) => s < 500 });
  if (r.status >= 400) throw new Error(`${r.status}: ${r.data?.error || 'unknown'}`);
  const id = r.data[ROUTE[kind].id];
  if (!opts.wait) {
    if (opts.json) console.log(JSON.stringify(r.data, null, 2));
    else {
      console.log(chalk.green(`${ROUTE[kind].id}=${id} status=${r.data.status}`));
      console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs ${ROUTE[kind].verb} status ${id} --wait`));
    }
    return;
  }
  await waitFor(kind, id, headers, opts.json);
}

export async function neoantigenEvidenceSubmitCommand(caseId: string, options: NeoantigenEvidenceOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('evidence', buildEvidenceBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`neoantigen-evidence submit failed: ${e.message}`);
    process.exit(1);
  }
}

export async function neoantigenDesignSubmitCommand(caseId: string, options: NeoantigenDesignOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('design', buildDesignBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`neoantigen-design submit failed: ${e.message}`);
    process.exit(1);
  }
}

export async function neoantigenHlaSubmitCommand(caseId: string, options: NeoantigenHlaOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('hla', buildHlaBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`neoantigen-hla submit failed: ${e.message}`);
    process.exit(1);
  }
}

export async function neoantigenFusionSubmitCommand(caseId: string, options: NeoantigenFusionOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('fusion', buildFusionBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`neoantigen-fusion submit failed: ${e.message}`);
    process.exit(1);
  }
}

export async function neoantigenIndelSubmitCommand(caseId: string, options: NeoantigenIndelOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('indel', buildIndelBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`neoantigen-indel submit failed: ${e.message}`);
    process.exit(1);
  }
}

export async function neoantigenStatusCommand(kind: Kind, id: string, options: { wait?: boolean; json?: boolean }): Promise<void> {
  try {
    const a = await auth();
    if (options.wait) return await waitFor(kind, id, a.headers, options.json);
    const row = await fetchStatus(kind, id, a.headers);
    if (options.json) console.log(JSON.stringify(row, null, 2)); else printSummary(kind, row);
  } catch (e: any) {
    Logger.error(`${ROUTE[kind].verb} status failed: ${e.message}`);
    process.exit(1);
  }
}
