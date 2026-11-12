/**
 * biofs neoantigen-evidence submit <caseId> --somatic-sqlite <biocid> --filtered-vcf <biocid> --tumor <biocid> --normal <biocid> [--second-dna <biocid>] [--rna <biocid>] [--tpm <biocid>]
 * biofs neoantigen-evidence status <job> [--wait]
 * biofs neoantigen-design   submit <caseId> --evidence <biocid> --hla <alleles> [--n 20] [--weights ...]
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
 * Decision support for a human review, never a clinical device. Server routes: POST /neoantigen_evidence, /neoantigen_design; GET /neoantigen_evidence_status, /neoantigen_design_status.
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
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

export interface NeoantigenDesignOptions {
  evidence: string;
  hla: string;
  proteome?: string;
  n?: string;
  weights?: string;
  patient?: string;
  expect?: string;
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
  };
}

export interface NeoantigenHlaOptions { normal: string; rna?: string; owner?: string; wait?: boolean; json?: boolean }

export function buildHlaBody(caseId: string, o: NeoantigenHlaOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  return { wallet: ownerOr(o.owner, wallet), signature, case_id: caseId, normal_biocid: requireBiocid('--normal', o.normal), rna_biocid: o.rna ? requireBiocid('--rna', o.rna) : '' };
}

export function buildDesignBody(caseId: string, o: NeoantigenDesignOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  return {
    wallet: ownerOr(o.owner, wallet),
    signature,
    case_id: caseId,
    evidence_biocid: requireBiocid('--evidence', o.evidence),
    hla: parseHla(o.hla),
    proteome_biocid: o.proteome ? requireBiocid('--proteome', o.proteome) : '',
    n: parseCount(o.n, 20, 1, 50, '--n'),
    weights: parseWeights(o.weights),
    patient: o.patient || caseId,
    expect_genes: o.expect ? o.expect.split(',').map((s) => s.trim()).filter(Boolean) : [],
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

type Kind = 'evidence' | 'design' | 'hla';
const ROUTE: Record<Kind, { post: string; status: string; id: string; verb: string }> = {
  evidence: { post: 'neoantigen_evidence', status: 'neoantigen_evidence_status', id: 'neoantigen_job_id', verb: 'neoantigen-evidence' },
  design: { post: 'neoantigen_design', status: 'neoantigen_design_status', id: 'neoantigen_job_id', verb: 'neoantigen-design' },
  hla: { post: 'neoantigen_hla', status: 'neoantigen_hla_status', id: 'neoantigen_job_id', verb: 'neoantigen-hla' },
};

async function fetchStatus(kind: Kind, id: string, headers: Record<string, string>): Promise<any> {
  const r = await axios.get(`${BIOFS_NODE_BASE}/${ROUTE[kind].status}`, {
    params: { [ROUTE[kind].id]: id }, headers, timeout: 60_000, validateStatus: (s) => s < 500,
  });
  if (r.status >= 400) throw new Error(`status ${r.status}: ${r.data?.error || 'unknown'}`);
  return r.data;
}

function printSummary(kind: Kind, row: any): void {
  console.log(`${chalk.cyan('Job:')}     ${row[ROUTE[kind].id]}  ${row.status}`);
  if (row.progress) console.log(`${chalk.cyan('Progress:')} ${JSON.stringify(row.progress)}`);
  if (row.summary) console.log(`${chalk.cyan('Summary:')}  ${JSON.stringify(row.summary)}`);
  if (row.result_biocid) console.log(`${chalk.cyan('Result:')}   ${row.result_biocid}`);
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
