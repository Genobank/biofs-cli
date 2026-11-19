/**
 * biofs neoantigen-evidence submit <caseId> --somatic-sqlite <biocid> --filtered-vcf <biocid> --tumor <biocid> --normal <biocid> [--second-dna <biocid>] [--rna <biocid>] [--tpm <biocid>]
 * biofs neoantigen-evidence status <job> [--wait]
 * biofs neoantigen-design   submit <caseId> --evidence <biocid> (--hla <alleles> | --hla-from <biocid> [--accept-low-confidence]) [--n 20] [--weights ...]
 * biofs neoantigen-hla      submit <caseId> --normal <biocid> [--rna <biocid>] [--depth-curve 0.5,0.25,0.1] [--include-unmapped]
 * biofs neoantigen-fusion   submit <caseId> --fusion-evidence <biocid> --five-gene <symbol> --three-gene <symbol> (--hla <alleles> | --hla-from <biocid>) [--min-templates 10]
 * biofs neoantigen-indel    submit <caseId> --somatic-sqlite <biocid> (--hla <alleles> | --hla-from <biocid>) [--tpm <biocid>] [--rna <biocid>] [--min-alt 8] [--genes TGFBR2,...]
 * biofs synapse-pull      submit <caseId> (--entities syn1,syn2 | --folder syn123 [--suffixes .fastq.gz,.bam]) [--project syn123] [--list-only] --access-basis "<approval>" [--max-total-bytes N]
 * biofs identity-concordance submit <caseId> --sample label=<gvcf biocid> ... --code-sha256 <hex> --protocol-sha256 <hex> --ledger-record <n>   are these samples the same individual (decision support)
 * biofs tesla-gate         submit <caseId> --outcomes <biocid> --features 1=<biocid> 2=<biocid> ... --code-sha256 <hex> --protocol-sha256 <hex> --ledger-record <n> [--selftest]
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
import * as fs from 'fs';
import { createHash } from 'crypto';
import chalk from 'chalk';
import { getCredentials } from '../../lib/auth/credentials';
import { nodeErrorMessage } from '../../lib/utils/node_roles';
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
  engine?: string;
  codeSha256?: string;
  protocolSha256?: string;
  ledgerRecord?: string;
  proteomeSha256?: string;
  modelsSha256?: string;
  executor?: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

export function requireBiocid(flag: string, value: string | undefined): string {
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
export interface NeoantigenIndelOptions { somaticSqlite: string; hla?: string; hlaFrom?: string; acceptLowConfidence?: boolean; proteome?: string; gtf?: string; transcripts?: string; tpm?: string; rna?: string; minAlt?: string; genes?: string; executor?: string; owner?: string; wait?: boolean; json?: boolean }

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
    rna_biocid: o.rna ? requireBiocid('--rna', o.rna) : '',
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
    ...v5aDesignFields(o),
  };
}

/** Engine v5a of the design kind (ledger record 40): engine v2's own code with the two v5 gate changes and the environment pin. The pins are required with it and refused without it. */
export function v5aDesignFields(o: NeoantigenDesignOptions): Record<string, unknown> {
  const pins = [o.codeSha256, o.protocolSha256, o.ledgerRecord, o.proteomeSha256, o.modelsSha256];
  if (o.engine !== undefined && o.engine !== 'v2' && o.engine !== 'v5a') throw new Error('--engine must be v2 or v5a');
  if (o.engine !== 'v5a') {
    if (pins.some((x) => x !== undefined)) throw new Error('--code-sha256, --protocol-sha256, --ledger-record, --proteome-sha256 and --models-sha256 apply only with --engine v5a');
    return {};
  }
  const rec = Number(o.ledgerRecord);
  if (!Number.isInteger(rec) || rec < 1) throw new Error('--ledger-record must be the pre-registration ledger record number');
  const out: Record<string, unknown> = {
    engine: 'v5a', code_sha256: parseSha256('--code-sha256', o.codeSha256 as string), protocol_sha256: parseSha256('--protocol-sha256', o.protocolSha256 as string), ledger_record: rec,
  };
  if (o.proteomeSha256 !== undefined) out.proteome_sha256 = parseSha256('--proteome-sha256', o.proteomeSha256);
  if (o.modelsSha256 !== undefined) out.models_sha256 = parseSha256('--models-sha256', o.modelsSha256);
  return out;
}

export interface RankV5Options {
  design: string;
  evidence: string;
  indel: string;
  fusion?: string;
  n?: string;
  patient?: string;
  codeSha256: string;
  protocolSha256: string;
  ledgerRecord: string;
  executor?: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

/** The registered v5 ranking over a registered v5-gates design, the features table that design read, the indel result and (optionally) the fusion result; every input is a biocid and the code, protocol and ledger record are the frozen ones. */
export function buildRankV5Body(caseId: string, o: RankV5Options, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const rec = Number(o.ledgerRecord);
  if (!Number.isInteger(rec) || rec < 1) throw new Error('--ledger-record must be the pre-registration ledger record number');
  const body: Record<string, unknown> = {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId,
    design_biocid: requireBiocid('--design', o.design), evidence_biocid: requireBiocid('--evidence', o.evidence), indel_biocid: requireBiocid('--indel', o.indel),
    n: parseCount(o.n, 20, 1, 50, '--n'), patient: o.patient || caseId,
    code_sha256: parseSha256('--code-sha256', o.codeSha256), protocol_sha256: parseSha256('--protocol-sha256', o.protocolSha256), ledger_record: rec,
    executor: parseExecutor(o.executor),
  };
  if (o.fusion) body.fusion_biocid = requireBiocid('--fusion', o.fusion);
  return body;
}

export async function rankV5SubmitCommand(caseId: string, options: RankV5Options): Promise<void> {
  try {
    const a = await auth();
    await submit('rank_v5', buildRankV5Body(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`rank-v5 submit failed: ${e.message}`);
    process.exit(1);
  }
}

export interface SynapsePullOptions {
  entities?: string;
  folder?: string;
  suffixes?: string;
  project?: string;
  listOnly?: boolean;
  accessBasis?: string;
  maxTotalBytes?: string;
  executor?: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

export interface PublicFetchOptions {
  accession?: string;
  outName?: string;
  pairs?: string;
  maxTotalBytes?: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

export interface TeslaGateOptions {
  outcomes: string;
  features: string[];
  codeSha256: string;
  protocolSha256: string;
  ledgerRecord: string;
  proteome?: string;
  selftest?: boolean;
  executor?: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

export const SYN_RE = /^syn[0-9]{1,12}$/;

export function parseSynId(flag: string, v: string): string {
  if (!SYN_RE.test((v || '').trim())) throw new Error(`${flag} must be a Synapse id such as syn21048999; a URL or file path is never accepted`);
  return v.trim();
}

export function parseSynIds(list: string | undefined, flag: string): string[] {
  const ids = (list || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => parseSynId(flag, x));
  if (ids.length > 500) throw new Error(`${flag} takes up to 500 Synapse ids per job`);
  return Array.from(new Set(ids));
}

export function parseSuffixes(list: string | undefined): string[] {
  const out = (list || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (out.length > 10 || out.some((x) => !/^\.[A-Za-z0-9.]{1,20}$/.test(x))) throw new Error('--suffixes takes up to 10 file name endings such as .fastq.gz,.bam');
  return out;
}

/** Third-party controlled-access data from Synapse onto a worker: the Synapse token lives only on the worker, never in this request, and the job never runs on the node that holds the registry. */
export function buildSynapseBody(caseId: string, o: SynapsePullOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  if (o.executor !== undefined && o.executor !== '' && o.executor !== 'worker') throw new Error('--executor must be worker for a Synapse pull: the token exists only on a worker');
  const entities = parseSynIds(o.entities, '--entities');
  if (!entities.length && !o.folder) throw new Error('give --entities (Synapse file ids) or --folder');
  const basis = (o.accessBasis || '').trim();
  if (!o.listOnly && basis.length < 10) throw new Error('--access-basis is required to download controlled-access data: name the approval the job runs under (10 to 300 characters)');
  if (basis.length > 300) throw new Error('--access-basis is at most 300 characters');
  const body: Record<string, unknown> = {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId, executor: 'worker', list_only: !!o.listOnly,
  };
  if (entities.length) body.entities = entities;
  if (o.folder) body.folder = parseSynId('--folder', o.folder);
  if (o.suffixes) body.suffixes = parseSuffixes(o.suffixes);
  if (o.project) body.project = parseSynId('--project', o.project);
  if (basis) body.access_basis = basis;
  if (o.maxTotalBytes !== undefined && o.maxTotalBytes !== '') {
    const n = Number(o.maxTotalBytes);
    if (!Number.isInteger(n) || n < 1 || n > 2e12) throw new Error('--max-total-bytes must be a positive integer up to 2000000000000');
    body.max_total_bytes = n;
  }
  return body;
}

/** biofs public-fetch: a PUBLIC ENA paired FASTQ run onto a governed worker. The body names an accession and nothing that names a place (no URL, no host): the worker asks the archive. */
export function buildPublicFetchBody(caseId: string, o: PublicFetchOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const acc = (o.accession || '').trim();
  if (!/^[SED]RR[0-9]{6,9}$/.test(acc)) throw new Error('--accession must be an ENA run accession like SRR1234567');
  const body: Record<string, unknown> = { wallet: ownerOr(o.owner, wallet), signature, case_id: caseId, executor: 'worker', accession: acc };
  if (o.outName) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(o.outName)) throw new Error('--out-name must be letters, digits, _ or -, starting with a letter, up to 41 characters');
    body.out_name = o.outName;
  }
  if (o.pairs !== undefined && o.pairs !== '') {
    const n = Number(o.pairs);
    if (!Number.isInteger(n) || n < 1000 || n > 50_000_000) throw new Error('--pairs must be an integer from 1000 to 50000000');
    body.subsample_pairs = n;
  }
  const cap = Number(o.maxTotalBytes);
  if (o.maxTotalBytes === undefined || o.maxTotalBytes === '' || !Number.isInteger(cap) || cap < 1 || cap > 2e12) throw new Error('--max-total-bytes is required: a positive integer up to 2000000000000 (the download is refused above it)');
  body.max_total_bytes = cap;
  return body;
}

export function parseSha256(flag: string, v: string): string {
  const x = (v || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(x)) throw new Error(`${flag} must be a SHA-256 (64 hex characters): the registered, frozen value`);
  return x;
}

/** "1=biocid://...,2=biocid://..." (repeatable): TESLA patient id to the biocid of that subject's neoantigen-evidence features table. */
export function parseFeatures(items: string[] | string | undefined): Record<string, string> {
  const raw = ([] as string[]).concat(items || []).flatMap((x) => String(x).split(/,(?=[A-Za-z0-9_-]{1,16}=)/)).map((x) => x.trim()).filter(Boolean);
  if (raw.length < 1 || raw.length > 20) throw new Error('--features needs 1 to 20 entries of patient=biocid, for example 1=biocid://genobank/0x.../neoantigen-evidence/...');
  const out: Record<string, string> = {};
  for (const r of raw) {
    const i = r.indexOf('=');
    const id = r.slice(0, i);
    if (i < 1 || !/^[A-Za-z0-9_-]{1,16}$/.test(id)) throw new Error(`--features entry "${r}" is not patient=biocid`);
    if (out[id]) throw new Error(`--features names patient ${id} twice`);
    out[id] = requireBiocid(`--features ${id}`, r.slice(i + 1));
  }
  return out;
}

/** The registered test of the case 1 evidence gate on the TESLA subjects. The code hash, protocol hash and ledger record must be the frozen ones; the worker refuses code that differs. */
export function buildTeslaGateBody(caseId: string, o: TeslaGateOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const rec = Number(o.ledgerRecord);
  if (!Number.isInteger(rec) || rec < 1) throw new Error('--ledger-record must be the pre-registration ledger record number');
  const body: Record<string, unknown> = {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId,
    outcomes_biocid: requireBiocid('--outcomes', o.outcomes),
    features_biocids: parseFeatures(o.features),
    code_sha256: parseSha256('--code-sha256', o.codeSha256),
    protocol_sha256: parseSha256('--protocol-sha256', o.protocolSha256),
    ledger_record: rec,
    proteome_biocid: o.proteome ? requireBiocid('--proteome', o.proteome) : '',
    executor: parseExecutor(o.executor),
  };
  if (o.selftest) body.selftest = true;
  return body;
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

type Kind = 'evidence' | 'design' | 'hla' | 'fusion' | 'indel' | 'synapse' | 'tesla_gate' | 'parabricks' | 'public_fetch' | 'identity' | 'capture' | 'windows' | 'rescore' | 'acmg' | 'refindex' | 'vcfcompare' | 'alphagenome' | 'twin' | 'library_profile' | 'rank_v5';
const ROUTE: Record<Kind, { post: string; status: string; id: string; verb: string }> = {
  evidence: { post: 'neoantigen_evidence', status: 'neoantigen_evidence_status', id: 'neoantigen_job_id', verb: 'neoantigen-evidence' },
  design: { post: 'neoantigen_design', status: 'neoantigen_design_status', id: 'neoantigen_job_id', verb: 'neoantigen-design' },
  hla: { post: 'neoantigen_hla', status: 'neoantigen_hla_status', id: 'neoantigen_job_id', verb: 'neoantigen-hla' },
  fusion: { post: 'neoantigen_fusion', status: 'neoantigen_fusion_status', id: 'neoantigen_job_id', verb: 'neoantigen-fusion' },
  indel: { post: 'neoantigen_indel', status: 'neoantigen_indel_status', id: 'neoantigen_job_id', verb: 'neoantigen-indel' },
  synapse: { post: 'neoantigen_synapse', status: 'neoantigen_synapse_status', id: 'neoantigen_job_id', verb: 'synapse-pull' },
  tesla_gate: { post: 'neoantigen_tesla_gate', status: 'neoantigen_tesla_gate_status', id: 'neoantigen_job_id', verb: 'tesla-gate' },
  parabricks: { post: 'neoantigen_parabricks', status: 'neoantigen_parabricks_status', id: 'neoantigen_job_id', verb: 'pbrun' },
  public_fetch: { post: 'neoantigen_public_fetch', status: 'neoantigen_public_fetch_status', id: 'neoantigen_job_id', verb: 'public-fetch' },
  identity: { post: 'neoantigen_identity', status: 'neoantigen_identity_status', id: 'neoantigen_job_id', verb: 'identity-concordance' },
  capture: { post: 'neoantigen_capture', status: 'neoantigen_capture_status', id: 'neoantigen_job_id', verb: 'capture-compare' },
  windows: { post: 'neoantigen_windows', status: 'neoantigen_windows_status', id: 'neoantigen_job_id', verb: 'windows-geometry' },
  rescore: { post: 'neoantigen_rescore', status: 'neoantigen_rescore_status', id: 'neoantigen_job_id', verb: 'rescore' },
  acmg: { post: 'neoantigen_acmg', status: 'neoantigen_acmg_status', id: 'neoantigen_job_id', verb: 'acmg-triage' },
  refindex: { post: 'neoantigen_refindex', status: 'neoantigen_refindex_status', id: 'neoantigen_job_id', verb: 'reference-index' },
  vcfcompare: { post: 'neoantigen_vcfcompare', status: 'neoantigen_vcfcompare_status', id: 'neoantigen_job_id', verb: 'vcf-compare' },
  alphagenome: { post: 'neoantigen_alphagenome', status: 'neoantigen_alphagenome_status', id: 'neoantigen_job_id', verb: 'alphagenome' },
  twin: { post: 'neoantigen_twin', status: 'neoantigen_twin_status', id: 'neoantigen_job_id', verb: 'twin' },
  library_profile: { post: 'neoantigen_library_profile', status: 'neoantigen_library_profile_status', id: 'neoantigen_job_id', verb: 'library-profile' },
  rank_v5: { post: 'neoantigen_rank_v5', status: 'neoantigen_rank_v5_status', id: 'neoantigen_job_id', verb: 'rank-v5' },
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
  if (r.status >= 400) throw new Error(nodeErrorMessage(r.status, r.data?.error, typeof body.wallet === 'string' ? body.wallet : undefined));
  const id = r.data[ROUTE[kind].id];
  if (!opts.wait) {
    if (opts.json) console.log(JSON.stringify(r.data, null, 2));
    else {
      console.log(chalk.green(`${ROUTE[kind].id}=${id} status=${r.data.status}`));
      console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs ${ROUTE[kind].verb} status ${id} --wait`));
    }
    return;
  }
  console.error(`${ROUTE[kind].id}=${id} status=${r.data.status} (waiting; also: biofs ${ROUTE[kind].verb} status ${id})`);       // stderr: the id is known before the wait, --json stdout stays one document
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

export async function synapsePullSubmitCommand(caseId: string, options: SynapsePullOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('synapse', buildSynapseBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`synapse-pull submit failed: ${e.message}`);
    process.exit(1);
  }
}

export async function publicFetchSubmitCommand(caseId: string, options: PublicFetchOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('public_fetch', buildPublicFetchBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`public-fetch submit failed: ${e.message}`);
    process.exit(1);
  }
}

export interface IdentityOptions {
  sample: string[];
  codeSha256: string;
  protocolSha256: string;
  ledgerRecord: string;
  minDepth?: string;
  minGq?: string;
  executor?: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

/** label=biocid entries, 2 to 8, labels of letters, digits, _ and - (never a person name), no biocid twice. */
export function parseSamples(items: string[] | string | undefined): Record<string, string> {
  const raw = ([] as string[]).concat(items || []).flatMap((x) => String(x).split(/,(?=[A-Za-z0-9_-]{1,32}=)/)).map((x) => x.trim()).filter(Boolean);
  if (raw.length < 2 || raw.length > 8) throw new Error('--sample needs 2 to 8 entries of label=biocid, for example L13972=biocid://genobank/0x.../gvcf/neo-....g.vcf.gz');
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const r of raw) {
    const i = r.indexOf('=');
    const id = r.slice(0, i);
    if (i < 1 || !/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error(`--sample entry "${r}" is not label=biocid (letters, digits, _ and - only)`);
    if (out[id]) throw new Error(`--sample names label ${id} twice`);
    const b = requireBiocid(`--sample ${id}`, r.slice(i + 1));
    if (seen.has(b.toLowerCase())) throw new Error(`--sample lists the same biocid twice (${id})`);
    seen.add(b.toLowerCase());
    out[id] = b;
  }
  return out;
}

/** Are these samples the same individual? The registered identity protocol: the code hash, protocol hash and ledger record must be the frozen ones; the worker refuses code that differs. */
export function buildIdentityBody(caseId: string, o: IdentityOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const rec = Number(o.ledgerRecord);
  if (!Number.isInteger(rec) || rec < 1) throw new Error('--ledger-record must be the pre-registration ledger record number');
  const num = (name: string, v: string | undefined, lo: number, hi: number, def: number): number => {
    const n = v === undefined ? def : Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name} must be an integer from ${lo} to ${hi}`);
    return n;
  };
  return {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId,
    samples_biocids: parseSamples(o.sample),
    min_depth: num('--min-depth', o.minDepth, 1, 200, 10), min_gq: num('--min-gq', o.minGq, 0, 99, 20),
    code_sha256: parseSha256('--code-sha256', o.codeSha256),
    protocol_sha256: parseSha256('--protocol-sha256', o.protocolSha256),
    ledger_record: rec,
    executor: parseExecutor(o.executor),
  };
}

export async function identitySubmitCommand(caseId: string, options: IdentityOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('identity', buildIdentityBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`identity-concordance submit failed: ${e.message}`);
    process.exit(1);
  }
}

export interface CaptureOptions {
  bam: string;
  design?: string[];
  designBiocid?: string[];
  pad?: string;
  codeSha256: string;
  protocolSha256: string;
  ledgerRecord: string;
  executor?: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

/** label=biocid entries for BED designs (labels of letters, digits, _ and -). */
export function parseDesignBiocids(items: string[] | string | undefined): Record<string, string> {
  const raw = ([] as string[]).concat(items || []).map((x) => String(x).trim()).filter(Boolean);
  const out: Record<string, string> = {};
  for (const r of raw) {
    const i = r.indexOf('=');
    const id = r.slice(0, i);
    if (i < 1 || !/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error(`--design-biocid entry "${r}" is not label=biocid (letters, digits, _ and - only)`);
    if (out[id]) throw new Error(`--design-biocid names label ${id} twice`);
    out[id] = requireBiocid(`--design-biocid ${id}`, r.slice(i + 1));
  }
  return out;
}

/** Which capture design does this alignment come from? The registered protocol capture_compare_v1: the code hash, protocol hash and ledger record must be the frozen ones. */
export function buildCaptureBody(caseId: string, o: CaptureOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const rec = Number(o.ledgerRecord);
  if (!Number.isInteger(rec) || rec < 1) throw new Error('--ledger-record must be the pre-registration ledger record number');
  const designs = ([] as string[]).concat(o.design || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  for (const d of designs) if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(d)) throw new Error(`--design ${d} is not a catalog design name`);
  if (new Set(designs).size !== designs.length) throw new Error('--design lists a name twice');
  const db = parseDesignBiocids(o.designBiocid);
  if (designs.length + Object.keys(db).length < 1) throw new Error('give at least one candidate design (--design <catalog name> or --design-biocid label=biocid)');
  const pad = o.pad === undefined ? 0 : Number(o.pad);
  if (!Number.isInteger(pad) || pad < 0 || pad > 1000) throw new Error('--pad must be an integer from 0 to 1000');
  return {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId,
    bam_biocid: requireBiocid('--bam', o.bam), designs, designs_biocids: db, pad,
    code_sha256: parseSha256('--code-sha256', o.codeSha256),
    protocol_sha256: parseSha256('--protocol-sha256', o.protocolSha256),
    ledger_record: rec,
    executor: parseExecutor(o.executor),
  };
}

export async function captureSubmitCommand(caseId: string, options: CaptureOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('capture', buildCaptureBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`capture-compare submit failed: ${e.message}`);
    process.exit(1);
  }
}

/** The HPO releases whose files are in gs://genobank-references/hpo/<release>/, with the SHA-256 of each file as read in the session that uploaded them. A release not listed needs both hashes on the command line. */
export const HPO_RELEASES: Record<string, { obo: string; genes: string }> = {
  '2026-09-01': { obo: '93dace952fcb3ec4728818857f6ba76bc2d5312f4d83266519b8694b8e798f22', genes: '507a17bff9c49e6329fbd88b1f91734fa7e9fdea5c06304044c0892eb6ab248c' },
};

export interface AcmgOptions {
  sqlite?: string;
  coverage?: boolean;
  smn?: boolean;
  support?: boolean;
  listAll?: boolean;
  reportBiocid?: string;
  scope?: string;
  constraintObject?: string;
  constraintSha256?: string;
  reference?: string;
  bam?: string;
  gtfBucket?: string;
  gtfObject?: string;
  gtfSha256?: string;
  genes?: string[];
  vcf?: string;
  schema?: boolean;
  hpo?: string[];
  panel?: string;
  maxAf?: string;
  hpoRelease?: string;
  hpoOboSha256?: string;
  hpoGenesSha256?: string;
  codeSha256: string;
  caseLabel?: string;
  executor?: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

/** Phenotype-driven variant triage with an ACMG/AMP points classification over an annotation sqlite (and its VCF). --schema only profiles the sqlite's columns and classifies nothing. */
export function buildAcmgBody(caseId: string, o: AcmgOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  if ([o.coverage, o.schema, o.smn, o.support].filter(Boolean).length > 1) throw new Error('--coverage, --schema, --smn and --support are different modes: give one');
  const body: Record<string, unknown> = {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId,
    code_sha256: parseSha256('--code-sha256', o.codeSha256),
    executor: parseExecutor(o.executor),
    mode: o.support ? 'support' : o.smn ? 'smn' : o.coverage ? 'coverage' : o.schema ? 'schema' : 'classify',
  };
  if (o.support) {
    body.bam_biocid = requireBiocid('--bam', o.bam);
    body.report_biocid = requireBiocid('--report-biocid', o.reportBiocid);
    if (o.reference !== 'hg38_noalt') throw new Error('--reference must be hg38_noalt (the catalog reference whose FASTA is checked by its recorded MD5)');
    body.reference = o.reference;
    if (o.scope !== undefined && !['all', 'vus'].includes(o.scope)) throw new Error('--scope must be all or vus');
    body.scope = o.scope || 'all';
    body.case_label = o.caseLabel || caseId;
    return body;
  }
  if (o.coverage || o.smn) {
    body.bam_biocid = requireBiocid('--bam', o.bam);
    if (!o.gtfBucket || !o.gtfObject) throw new Error('--gtf-bucket and --gtf-object name the pinned gene annotation (a reference object)');
    body.gtf_bucket = o.gtfBucket;
    body.gtf_object = o.gtfObject;
    body.gtf_sha256 = parseSha256('--gtf-sha256', o.gtfSha256 as string);
    const genes = ([] as string[]).concat(o.genes || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
    if (genes.length) body.genes = genes;
    if (o.smn) {
      if (o.reference !== 'hg38_noalt') throw new Error('--reference must be hg38_noalt (the catalog reference whose FASTA is checked by its recorded MD5)');
      body.reference = o.reference;
      body.panel = o.panel || 'skeletal_dysplasia';
      body.case_label = o.caseLabel || caseId;
      delete body.genes;
      return body;
    }
  } else {
    body.sqlite_biocid = requireBiocid('--sqlite', o.sqlite);
  }
  if (o.schema) return body;
  if (o.vcf && !o.coverage) body.vcf_biocid = requireBiocid('--vcf', o.vcf);
  const terms = ([] as string[]).concat(o.hpo || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  if (!terms.length) throw new Error('give the patient HPO terms with --hpo HP:0002757,HP:0000924');
  for (const t of terms) if (!/^HP:[0-9]{7}$/.test(t)) throw new Error(`--hpo ${t} is not an HPO id like HP:0002757`);
  if (new Set(terms).size !== terms.length) throw new Error('--hpo lists a term twice');
  body.hpo_terms = terms;
  body.panel = o.panel || 'none';
  if (o.maxAf !== undefined && !o.coverage) {
    const m = Number(o.maxAf);
    if (!(m > 0 && m <= 0.5)) throw new Error('--max-af must be above 0 and at most 0.5');
    body.max_af = m;
  }
  const rel = o.hpoRelease;
  if (!rel) throw new Error('--hpo-release is required (the folder under genobank-references/hpo, for example 2026-09-01)');
  const known = HPO_RELEASES[rel];
  const obo = o.hpoOboSha256 || (known && known.obo);
  const genes = o.hpoGenesSha256 || (known && known.genes);
  if (!obo || !genes) throw new Error(`HPO release ${rel} has no recorded file hashes: give --hpo-obo-sha256 and --hpo-genes-sha256`);
  if (o.constraintObject) {
    body.constraint_object = o.constraintObject;
    body.constraint_sha256 = parseSha256('--constraint-sha256', o.constraintSha256 as string);
  } else if (o.constraintSha256) {
    throw new Error('--constraint-sha256 needs --constraint-object');
  }
  if (o.listAll) body.list_all = true;
  body.hpo_release = rel;
  body.hpo_obo_sha256 = parseSha256('--hpo-obo-sha256', obo);
  body.hpo_genes_sha256 = parseSha256('--hpo-genes-sha256', genes);
  body.case_label = o.caseLabel || caseId;
  return body;
}

export async function acmgSubmitCommand(caseId: string, options: AcmgOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('acmg', buildAcmgBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`acmg-triage submit failed: ${e.message}`);
    process.exit(1);
  }
}

export interface VcfCompareOptions {
  a: string;
  b: string;
  labelA?: string;
  labelB?: string;
  bed?: string;
  minDp?: string;
  minGq?: string;
  codeSha256: string;
  executor?: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

/** How two callers' VCFs of one sample agree (shared and private calls, genotype concordance, Ti/Tv, the evidence of every private call). Descriptive: it never says which caller is right. */
export function buildVcfCompareBody(caseId: string, o: VcfCompareOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const body: Record<string, unknown> = {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId,
    vcf_a_biocid: requireBiocid('--a', o.a), vcf_b_biocid: requireBiocid('--b', o.b),
    label_a: o.labelA || 'a', label_b: o.labelB || 'b',
    code_sha256: parseSha256('--code-sha256', o.codeSha256), executor: parseExecutor(o.executor),
  };
  if (body.vcf_a_biocid === body.vcf_b_biocid) throw new Error('--a and --b are the same file');
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(String(body.label_a)) || !/^[A-Za-z0-9_-]{1,30}$/.test(String(body.label_b))) throw new Error('labels are letters, digits, _ or - (up to 30)');
  if (body.label_a === body.label_b) throw new Error('--label-a and --label-b must differ');
  if (o.bed) body.bed_biocid = requireBiocid('--bed', o.bed);
  for (const [flag, key, v] of [['--min-dp', 'min_dp', o.minDp], ['--min-gq', 'min_gq', o.minGq]] as const) {
    if (v !== undefined) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 200) throw new Error(`${flag} must be an integer from 0 to 200`);
      body[key] = n;
    }
  }
  return body;
}

export async function vcfCompareSubmitCommand(caseId: string, options: VcfCompareOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('vcfcompare', buildVcfCompareBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`vcf-compare submit failed: ${e.message}`);
    process.exit(1);
  }
}

export interface RefIndexOptions {
  reference: string;
  codeSha256: string;
  executor?: string;
  owner?: string;
  mode?: string;
  sources?: string[];
  wait?: boolean;
  json?: boolean;
}

/** Build and verify the BWA-MEM index and sequence dictionary of a catalog reference that has none (a node operator only: it writes beside the reference FASTA, create-only). */
export function buildRefIndexBody(caseId: string, o: RefIndexOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or -');
  if (!['hg38_noalt'].includes(String(o.reference))) throw new Error('--reference must be a catalog reference without an index: hg38_noalt');
  const body: Record<string, unknown> = { wallet: ownerOr(o.owner, wallet), signature, case_id: caseId, reference: o.reference, code_sha256: parseSha256('--code-sha256', o.codeSha256), executor: 'worker' };
  if (o.mode && o.mode !== 'index') {
    // known_sites: copies of catalog known-sites VCFs restricted to the reference's contigs, checked record by record and written create-only beside the reference
    // intervals: copies of catalog capture designs (target Regions BEDs) restricted to the reference's contigs, checked line by line, written create-only beside the reference
    // design (19 November 2026): vendor capture designs fetched from their publisher over https, pinned by sha256 and size, restricted to the reference's contigs, checked, written create-only
    const SOURCES: Record<string, string[]> = { known_sites: ['dbsnp138', 'known_indels', 'mills_1000g', 'gnomad_af_only'], intervals: ['agilent_v8_regions'], design: ['twist_comprehensive_exome', 'twist_comprehensive_exome_ucsc2021', 'twist_exome_v2'] };
    const known = SOURCES[String(o.mode)];
    if (!known) throw new Error('--mode must be index (default), known_sites, intervals or design');
    const src = (o.sources || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
    if (!src.length || src.some((x) => !known.includes(x)) || new Set(src).size !== src.length) throw new Error(`--sources must be distinct names of ${known.join(', ')}`);
    body.mode = String(o.mode);
    body.sources = src;
  }
  return body;
}

export async function refIndexSubmitCommand(caseId: string, options: RefIndexOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('refindex', buildRefIndexBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`reference-index submit failed: ${e.message}`);
    process.exit(1);
  }
}

export interface LibraryProfileOptions {
  fastq: string[];
  records?: string;
  single?: boolean;
  codeSha256: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

/** What the reads of one library say about how it was sequenced: the first N records of each FASTQ (read lengths, Illumina read-name fields, index sequences, quality range, pair order).
 *  Descriptive only: it never names the capture kit or the laboratory's protocol. Runs on a CPU worker through biofs-node. */
export function buildLibraryProfileBody(caseId: string, o: LibraryProfileOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const fq = (o.fastq || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  for (const b of fq) if (!BIOCID_RE.test(b)) throw new Error(`--fastq: ${b} is not a biocid (a gs:// path, URL or file name is never accepted)`);
  if (fq.length < 1 || fq.length > 16 || new Set(fq.map((b) => b.toLowerCase())).size !== fq.length) throw new Error('--fastq takes 1 to 16 distinct FASTQ biocids');
  const paired = o.single !== true;
  if (paired && fq.length % 2) throw new Error('--fastq takes the two mates of each pair, R1 then R2 (an even number), or use --single');
  const records = o.records === undefined ? 10000 : Number(o.records);
  if (!Number.isInteger(records) || records < 100 || records > 200000) throw new Error('--records must be an integer from 100 to 200000');
  return { wallet: ownerOr(o.owner, wallet), signature, case_id: caseId, fastq_biocids: fq, paired, records, code_sha256: parseSha256('--code-sha256', o.codeSha256), executor: 'worker' };
}

export async function libraryProfileSubmitCommand(caseId: string, options: LibraryProfileOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('library_profile', buildLibraryProfileBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`library-profile submit failed: ${e.message}`);
    process.exit(1);
  }
}

export interface TwinOptions {
  apply?: boolean;
  codeSha256: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

/** Classify every object of a vault into the patient-owned cancer digital twin (layer, specimen, timepoint, matched set) and compute the vaccine-readiness table.
 *  Report only unless --apply writes the twin block onto the owner's rows. Runs on the node that holds the registry (executor local), never on a worker. */
export function buildTwinBody(caseId: string, o: TwinOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  return {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId,
    apply: o.apply === true,
    code_sha256: parseSha256('--code-sha256', o.codeSha256),
    executor: 'local',
  };
}

export async function twinClassifySubmitCommand(caseId: string, options: TwinOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('twin', buildTwinBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`twin classify submit failed: ${e.message}`);
    process.exit(1);
  }
}

export interface WindowsOptions {
  items: string;
  flank?: string;
  codeSha256: string;
  protocolSha256: string;
  ledgerRecord: string;
  executor?: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

/** The GENCODE window, CDS and exon geometry of a list of substitutions (the registered window_geometry code). items: [{id, gene, change}] read from a local JSON file. */
export function buildWindowsBody(caseId: string, o: WindowsOptions, wallet: string, signature: string, items: unknown): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  if (!Array.isArray(items) || items.length < 1 || items.length > 200) throw new Error('--items must be a JSON file holding a list of 1 to 200 {id, gene, change}');
  const flank = o.flank === undefined ? 40 : Number(o.flank);
  if (!Number.isInteger(flank) || flank < 1 || flank > 100) throw new Error('--flank must be an integer from 1 to 100');
  const rec = Number(o.ledgerRecord);
  if (!Number.isInteger(rec) || rec < 1) throw new Error('--ledger-record must be the pre-registration ledger record number');
  return {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId,
    items: (items as any[]).map((i) => ({ id: String(i.id), gene: String(i.gene), change: String(i.change) })), flank,
    code_sha256: parseSha256('--code-sha256', o.codeSha256),
    protocol_sha256: parseSha256('--protocol-sha256', o.protocolSha256),
    ledger_record: rec,
    executor: parseExecutor(o.executor),
  };
}

export async function windowsSubmitCommand(caseId: string, options: WindowsOptions): Promise<void> {
  try {
    const a = await auth();
    let items: unknown;
    try { items = JSON.parse(fs.readFileSync(options.items, 'utf8')); } catch (e: any) { throw new Error(`--items could not be read as JSON: ${e.message}`); }
    await submit('windows', buildWindowsBody(caseId, options, a.wallet, a.signature, items), a.headers, options);
  } catch (e: any) {
    Logger.error(`windows-geometry submit failed: ${e.message}`);
    process.exit(1);
  }
}

export interface RescoreOptions {
  peptides: string;
  class1?: string[];
  class2?: string[];
  codeSha256: string;
  protocolSha256: string;
  ledgerRecord: string;
  executor?: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

/** Peptides from a TSV with the header peptide_id<TAB>peptide. Nothing is repaired: a malformed row is an error. */
export function parsePeptidesTsv(text: string): { id: string; peptide: string }[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error('--peptides must be a TSV with the header peptide_id<TAB>peptide and at least one row');
  const head = lines[0].split('\t');
  if (head[0] !== 'peptide_id' || head[1] !== 'peptide') throw new Error('--peptides: the first line must be the header peptide_id<TAB>peptide');
  return lines.slice(1).map((l, i) => {
    const f = l.split('\t');
    if (f.length < 2 || !f[0] || !f[1]) throw new Error(`--peptides: row ${i + 2} has no peptide_id and peptide`);
    return { id: f[0], peptide: f[1].trim().toUpperCase() };
  });
}

/** SHA-256 of the distinct peptide strings, sorted, one per line: the same value the worker recomputes (rescore.peptides_sha256). */
export function peptidesSha256(peps: { peptide: string }[]): string {
  const h = createHash('sha256');
  for (const p of [...new Set(peps.map((q) => q.peptide))].sort()) h.update(`${p}\n`);
  return h.digest('hex');
}

/** Binding of caller peptides on caller alleles (MHCflurry class I) and molecules (MHCnuggets class II), under the registered rescore protocol. */
export function buildRescoreBody(caseId: string, o: RescoreOptions, wallet: string, signature: string, peps: { id: string; peptide: string }[]): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const split = (v?: string[]) => ([] as string[]).concat(v || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  const c1 = split(o.class1), c2 = split(o.class2);
  if (c1.length + c2.length < 1) throw new Error('give at least one --class1 allele (HLA-A*02:01) or --class2 molecule (HLA-DRB104:02)');
  const rec = Number(o.ledgerRecord);
  if (!Number.isInteger(rec) || rec < 1) throw new Error('--ledger-record must be the pre-registration ledger record number');
  return {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId,
    peptides: peps, peptides_sha256: peptidesSha256(peps), class1_alleles: c1, class2_molecules: c2,
    code_sha256: parseSha256('--code-sha256', o.codeSha256),
    protocol_sha256: parseSha256('--protocol-sha256', o.protocolSha256),
    ledger_record: rec,
    executor: parseExecutor(o.executor),
  };
}

export async function rescoreSubmitCommand(caseId: string, options: RescoreOptions): Promise<void> {
  try {
    const a = await auth();
    const peps = parsePeptidesTsv(fs.readFileSync(options.peptides, 'utf8'));
    await submit('rescore', buildRescoreBody(caseId, options, a.wallet, a.signature, peps), a.headers, options);
  } catch (e: any) {
    Logger.error(`rescore submit failed: ${e.message}`);
    process.exit(1);
  }
}

export async function teslaGateSubmitCommand(caseId: string, options: TeslaGateOptions): Promise<void> {
  try {
    const a = await auth();
    await submit('tesla_gate', buildTeslaGateBody(caseId, options, a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`tesla-gate submit failed: ${e.message}`);
    process.exit(1);
  }
}

/** Used by the pbrun verbs (commands/parabricks): sign, submit the job body, optionally wait. The body is built and checked by the caller. */
export async function parabricksSubmit(buildBody: (wallet: string, signature: string) => Record<string, unknown>, options: { wait?: boolean; json?: boolean }): Promise<void> {
  const a = await auth();
  await submit('parabricks', buildBody(a.wallet, a.signature), a.headers, options);
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

/** Submit a job of any kind with the signer's credentials; the body builder gets the signer's wallet and signature. Used by verbs that live in their own module. */
export async function submitKindCommand(kind: Kind, build: (wallet: string, signature: string) => Record<string, unknown>, options: { wait?: boolean; json?: boolean }): Promise<void> {
  try {
    const a = await auth();
    await submit(kind, build(a.wallet, a.signature), a.headers, options);
  } catch (e: any) {
    Logger.error(`${ROUTE[kind].verb} submit failed: ${e.message}`);
    process.exit(1);
  }
}
