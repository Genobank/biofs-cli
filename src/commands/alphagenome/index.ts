/**
 * biofs alphagenome score --variant chr:pos:ref:alt [...] --ontology UBERON:... --source-biocid <biocid> --accept-alphagenome-terms [--out file] [--json]
 *
 * Thin client of the GenoBank.io AlphaGenome service (/api_alphagenome): register_analysis (no auto processing), then submit_variant_scoring for each variant, then
 * get_job_status and get_results. Variants are VCF-style (left-anchored indels: the first base of ref is the shared anchor base). Only coordinates and alleles are sent
 * to the service; the lineage source is recorded as a biocid, never a storage path.
 * Google's terms for AlphaGenome apply (non-commercial research, no clinical use, no training of variant-effect models); acceptance is an explicit flag.
 */
import axios from 'axios';
import chalk from 'chalk';
import * as fs from 'fs';
import { getCredentials } from '../../lib/auth/credentials';

const API_BASE = process.env.GENOBANK_API_URL || 'https://genobank.app';
const BIOCID_RE = /^biocid:\/\/[A-Za-z0-9_-]+\/0x[0-9a-fA-F]{40}\/[A-Za-z0-9_-]+\/\S+$/;
const CHROMS = new Set([...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`), 'chrX', 'chrY', 'chrM']);
export const INTERVAL_LENGTHS = [16384, 131072, 524288, 1048576];
export const OUTPUTS = ['RNA_SEQ', 'CAGE', 'DNASE', 'ATAC', 'CHIP_HISTONE', 'CHIP_TF', 'SPLICE_SITES', 'SPLICE_SITE_USAGE', 'SPLICE_JUNCTIONS', 'CONTACT_MAPS', 'PROCAP'];

export interface Variant { chromosome: string; position: number; reference_bases: string; alternate_bases: string }
export interface AlphaGenomeOptions {
  variant: string[];
  ontology: string[];
  outputs?: string[];
  intervalLength?: string;
  sourceBiocid: string;
  acceptAlphagenomeTerms?: boolean;
  out?: string;
  json?: boolean;
  pollSeconds?: string;
  timeoutMinutes?: string;
}

/** "chr7:83961823:TG:T" -> Variant. Refuses the "-" allele of OpenCRAVAT and anything that is not plain bases. */
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
  return { chromosome, position, reference_bases, alternate_bases };
}

/** A window of the given length centred on the variant, clamped at the chromosome start (the service rejects a negative start). */
export function buildInterval(v: Variant, length: number): { chromosome: string; start: number; end: number } {
  if (!INTERVAL_LENGTHS.includes(length)) throw new Error(`--interval-length must be one of ${INTERVAL_LENGTHS.join(', ')}`);
  let start = v.position - Math.floor(length / 2);
  if (start < 0) start = 0;
  return { chromosome: v.chromosome, start, end: start + length };
}

export function buildRegisterBody(signature: string, sourceBiocid: string, variants: Variant[]): Record<string, string> {
  if (!BIOCID_RE.test(sourceBiocid)) throw new Error(`--source-biocid must be a biocid, never a storage path or URL: ${sourceBiocid}`);
  return {
    user_signature: signature,
    vcf_file_path: sourceBiocid,
    analysis_type: 'variant_scoring',
    auto_process: 'false',
    accept_alphagenome_terms: 'true',
    phenotype: '',
    max_variants: String(variants.length),
  };
}

export function buildSubmitBody(signature: string, registrationId: string, v: Variant, length: number, ontology: string[], outputs: string[]): Record<string, unknown> {
  return {
    user_signature: signature,
    registration_id: registrationId,
    variant: v,
    interval: buildInterval(v, length),
    ontology_terms: ontology,
    requested_outputs: outputs,
  };
}

export function validateOptions(o: AlphaGenomeOptions): { variants: Variant[]; length: number; outputs: string[] } {
  if (!o.acceptAlphagenomeTerms) throw new Error('add --accept-alphagenome-terms: AlphaGenome is for non-commercial research only, not for clinical use or medical advice, and its outputs may not be used to train variant-effect models (Google AlphaGenome terms)');
  if (!o.variant || !o.variant.length) throw new Error('give at least one --variant chr:pos:ref:alt');
  if (!o.ontology || !o.ontology.length) throw new Error('give at least one --ontology term (for example UBERON:... or CL:...); it selects the tissue or cell type the prediction is made for');
  const variants = o.variant.map(parseVariant);
  const length = Number(o.intervalLength || 131072);
  const outputs = (o.outputs && o.outputs.length ? o.outputs : ['RNA_SEQ']).map((x) => x.toUpperCase());
  for (const x of outputs) if (!OUTPUTS.includes(x)) throw new Error(`unknown output ${x}; use one of ${OUTPUTS.join(', ')}`);
  buildRegisterBody('x', o.sourceBiocid || '', variants);
  for (const v of variants) buildInterval(v, length);
  return { variants, length, outputs };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function alphagenomeScoreCommand(options: AlphaGenomeOptions): Promise<void> {
  const { variants, length, outputs } = validateOptions(options);
  const credentials = await getCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
  const sig = credentials.user_signature;
  const reg = await axios.post(`${API_BASE}/api_alphagenome/register_analysis`, new URLSearchParams(buildRegisterBody(sig, options.sourceBiocid, variants)).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 60_000, validateStatus: () => true,
  });
  if (reg.data?.status !== 'Success') throw new Error(`register failed: ${reg.data?.message || `HTTP ${reg.status}`}`);
  const registrationId: string = reg.data.registration_id;
  const pollMs = Math.max(2, Number(options.pollSeconds || 5)) * 1000;
  const deadline = Date.now() + Math.max(1, Number(options.timeoutMinutes || 20)) * 60_000;
  const results: any[] = [];
  for (const v of variants) {
    const label = `${v.chromosome}:${v.position}:${v.reference_bases}:${v.alternate_bases}`;
    const sub = await axios.post(`${API_BASE}/api_alphagenome/submit_variant_scoring`, buildSubmitBody(sig, registrationId, v, length, options.ontology, outputs), { timeout: 60_000, validateStatus: () => true });
    if (sub.data?.status !== 'Success') { results.push({ variant: label, status: 'refused', message: sub.data?.message || `HTTP ${sub.status}` }); continue; }
    const jobId: string = sub.data.job_id;
    let state = 'submitted'; let message = '';
    while (Date.now() < deadline) {
      const st = await axios.get(`${API_BASE}/api_alphagenome/get_job_status`, { params: { user_signature: sig, job_id: jobId }, timeout: 60_000, validateStatus: () => true });
      if (st.data?.status !== 'Success') { state = 'error'; message = st.data?.message || `HTTP ${st.status}`; break; }
      state = st.data.job_status; message = st.data.message || '';
      if (state === 'completed' || state === 'failed') break;
      await sleep(pollMs);
    }
    if (state !== 'completed') { results.push({ variant: label, job_id: jobId, status: state === 'submitted' || state === 'processing' ? 'timeout' : state, message }); continue; }
    const res = await axios.get(`${API_BASE}/api_alphagenome/get_results`, { params: { user_signature: sig, job_id: jobId }, timeout: 120_000, validateStatus: () => true });
    if (res.data?.status !== 'Success') { results.push({ variant: label, job_id: jobId, status: 'no_results', message: res.data?.message || `HTTP ${res.status}` }); continue; }
    results.push({ variant: label, job_id: jobId, status: 'completed', results: res.data.results });
  }
  const report = { registration_id: registrationId, source_biocid: options.sourceBiocid, interval_length: length, ontology_terms: options.ontology, requested_outputs: outputs, variants: results };
  if (options.out) fs.writeFileSync(options.out, JSON.stringify(report, null, 2), { mode: 0o600 });
  if (options.json) { console.log(JSON.stringify(report, null, 2)); }
  else {
    for (const r of results) {
      const colour = r.status === 'completed' ? chalk.green : chalk.red;
      console.log(colour(`${r.variant}  ${r.status}${r.message ? '  ' + r.message : ''}`));
      const sc = r.results?.scores || {};
      if (sc.n_rows !== undefined) console.log(`   ${sc.n_rows} score rows; strongest in the requested tissues (quantile score, raw score):`);
      for (const x of (sc.top_requested_ontology || sc.top_overall || []).slice(0, 6)) console.log(`     ${x.output_type} ${x.gene_name || ''} ${x.biosample_name || ''} q=${Number(x.quantile_score).toFixed(3)} raw=${Number(x.raw_score).toFixed(3)}`);
    }
    if (options.out) console.log(chalk.gray(`full results written to ${options.out}`));
  }
  if (results.some((r) => r.status !== 'completed')) process.exitCode = 1;
}
