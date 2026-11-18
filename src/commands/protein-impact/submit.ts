/**
 * biofs protein-impact fetch | apply | probe | gate-sign | results
 *
 * CLIENT verbs for the protein-level impact pipeline. Research-grade analysis of KNOWN missense
 * substitutions in ITGA2B and ITGB3 (Glanzmann thrombasthenia genes). The verb cannot design anything:
 * the only input is (gene, ref, pos, alt) tuples, and a free sequence, FASTA, SMILES or structure is refused
 * by the no-design guard.
 *
 * Dispatch is the protocol path (POST /api_biofs_node/job -> biofs-node -> an executor), never a raw
 * curl. `apply` reads the sample's variants through the gated variants API (the sqlite never leaves the
 * server), refuses a variant the sample does not carry, and will not run without a passing, signed gate
 * document. GPU layers refuse to start without `--approve <estimate_id> --max-usd N` from `--estimate`.
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import { getCredentials } from '../../lib/auth/credentials';
import { FuseAPIClient, FuseVariantRow } from '../../lib/api/fuse-client';
import { CONFIG } from '../../lib/config/constants';
import { Logger } from '../../lib/utils/logger';
import {
  BIOCID_RE, GENES, GPU_LAYERS, INPUT_TYPE_CPU, INPUT_TYPE_GPU, LAYERS, MAX_SOURCES, SCHEMA_REQUEST, Layer,
} from './constants';
import { Estimate, estimate, verifyApproval } from './estimate';
import {
  GateBlockedError, GateDocument, evaluateGate, gateId, loadRules, rulesSha256, signGate, verifyGateForApply,
} from './gate';
import { ProteinImpactRequest, RequestTarget, validateRequest } from './guard';
import { Substitution, formatVariant, parseVariant } from './numbering';
import { jobIdFor } from './request';
import { toolsLockSha256 } from './tools_lock';

// ---- pure helpers (unit tested) ---------------------------------------------------------------

const oneLetter = (s: Substitution) => formatVariant(s, 'one');

/** Parse and group `GENE:p.Leu225Arg` strings into request targets. Duplicates collapse. */
export function groupTargets(variants: string[]): { targets: RequestTarget[]; subs: Substitution[] } {
  const subs = variants.map(parseVariant);
  const byGene = new Map<string, Map<string, Substitution>>();
  for (const s of subs) {
    if (!byGene.has(s.gene)) byGene.set(s.gene, new Map());
    byGene.get(s.gene)!.set(`${s.pos}${s.ref}${s.alt}`, s);
  }
  const targets: RequestTarget[] = [...byGene.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([gene, m]) => ({
    gene,
    uniprot: GENES[gene].uniprot,
    subs: [...m.values()].sort((a, b) => a.pos - b.pos || a.alt.localeCompare(b.alt)).map(s => ({ pos: s.pos, ref: s.ref, alt: s.alt })),
  }));
  return { targets, subs: [...byGene.values()].flatMap(m => [...m.values()]) };
}

export function parseLayers(csv: string | undefined, fallback: Layer[]): Layer[] {
  if (!csv) return fallback;
  const out = csv.split(',').map(s => s.trim()).filter(Boolean);
  for (const l of out) if (!LAYERS.includes(l as Layer)) throw new Error(`unknown layer "${l}" (layers: ${LAYERS.join(', ')})`);
  return out as Layer[];
}

export function parseGenes(csv: string | undefined): string[] {
  const genes = (csv || Object.keys(GENES).join(',')).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  for (const g of genes) if (!GENES[g]) throw new Error(`gene not supported: ${g} (supported: ${Object.keys(GENES).join(', ')})`);
  return [...new Set(genes)];
}

/** A well-formed placeholder so a GPU request can be built and priced before it is approved. */
const PLACEHOLDER_APPROVAL = { estimate_id: '0000000000000000', max_usd: 1 };

export interface ApplyBuild {
  serial: string;
  variants: string[];
  sources: string[];
  layers: Layer[];
  gate: GateDocument;
  approval?: { estimate_id: string; max_usd: number };
  diagnosisAssumption?: string;
}

export function buildApplyRequest(o: ApplyBuild): ProteinImpactRequest {
  const { targets } = groupTargets(o.variants);
  const gpu = o.layers.some(l => GPU_LAYERS.includes(l));
  const req: Record<string, unknown> = {
    schema: SCHEMA_REQUEST,
    mode: 'apply',
    serial: o.serial,
    sources: o.sources,
    targets,
    layers: o.layers,
    gate: gateId(o.gate),
  };
  if (gpu) req.approval = o.approval ?? PLACEHOLDER_APPROVAL;
  if (o.diagnosisAssumption) req.diagnosis_assumption = o.diagnosisAssumption;
  return validateRequest(req);
}

export function buildProbeRequest(genes: string[], approval?: { estimate_id: string; max_usd: number }): ProteinImpactRequest {
  return validateRequest({
    schema: SCHEMA_REQUEST,
    mode: 'probe',
    targets: genes.map(g => ({ gene: g, uniprot: GENES[g].uniprot, subs: [] })),
    layers: ['probe'],
    approval: approval ?? PLACEHOLDER_APPROVAL,
  });
}

export function buildValidateRequest(genes: string[], layers: Layer[], approval?: { estimate_id: string; max_usd: number }): ProteinImpactRequest {
  const gpu = layers.some(l => GPU_LAYERS.includes(l));
  const req: Record<string, unknown> = {
    schema: SCHEMA_REQUEST,
    mode: 'validate',
    targets: genes.map(g => ({ gene: g, uniprot: GENES[g].uniprot, subs: [] })),
    layers,
  };
  if (gpu) req.approval = approval ?? PLACEHOLDER_APPROVAL;
  return validateRequest(req);
}

export function buildFetchRequest(genes: string[]): ProteinImpactRequest {
  return validateRequest({
    schema: SCHEMA_REQUEST,
    mode: 'fetch',
    targets: genes.map(g => ({ gene: g, uniprot: GENES[g].uniprot, subs: [] })),
    layers: ['fetch'],
  });
}

/** Which requested substitutions the sample's annotated missense variants actually carry. */
export function carrierMatches(rows: FuseVariantRow[], requested: Substitution[]): { found: Substitution[]; missing: Substitution[] } {
  const present = new Set<string>();
  for (const r of rows) {
    const gene = String(r.base__hugo || '').toUpperCase();
    const ach = String(r.base__achange || '').trim();
    if (!gene || !ach) continue;
    try {
      const s = parseVariant(`${gene}:${ach}`);
      present.add(`${s.gene}:${s.pos}${s.ref}${s.alt}`);
    } catch (_) { /* not a missense change in a supported gene */ }
  }
  const found: Substitution[] = [];
  const missing: Substitution[] = [];
  for (const s of requested) (present.has(`${s.gene}:${s.pos}${s.ref}${s.alt}`) ? found : missing).push(s);
  return { found, missing };
}

export interface JobSpec {
  jobId: string;
  biosampleId: string;
  inputType: string;
  proteinImpactRequest: ProteinImpactRequest;
  proteinImpactGate?: GateDocument;
  manifestUri: string;
  methylBiocid: '';
  creatorWallet: string;
  creatorSig: string;
  outputBucket: string;
  refBucket: string;
  batchId: string;
}

export function buildJobSpec(req: ProteinImpactRequest, gate: GateDocument | undefined, creds: { wallet_address: string; user_signature: string }, today: string): JobSpec {
  const jobId = jobIdFor(req);
  const outputBucket = 'genobank-parabricks-output';
  const gpu = req.layers.some(l => GPU_LAYERS.includes(l));
  return {
    jobId,
    biosampleId: req.serial ?? 'public',
    inputType: gpu ? INPUT_TYPE_GPU : INPUT_TYPE_CPU,
    proteinImpactRequest: req,
    ...(gate ? { proteinImpactGate: gate } : {}),
    manifestUri: `gs://${outputBucket}/biowallet/${creds.wallet_address.toLowerCase()}/protein-impact/${jobId}/manifest.json`,
    methylBiocid: '',
    creatorWallet: creds.wallet_address,
    creatorSig: creds.user_signature,
    outputBucket,
    refBucket: 'genobank-references',
    batchId: `protein-impact-${today}`,
  };
}

export function renderEstimate(e: Estimate): string {
  const rows = e.lines.map(l => `  ${l.layer.padEnd(10)} ${l.machine.padEnd(20)} ${String(l.hours).padStart(7)} h  ${('$' + l.usd.toFixed(2)).padStart(9)}  ${l.note}`);
  return [
    ...rows,
    `  ${'total'.padEnd(10)} ${''.padEnd(20)} ${String(e.total_hours).padStart(7)} h  ${('$' + e.total_usd.toFixed(2)).padStart(9)}`,
    '',
    `  estimate_id   ${e.estimate_id}   (valid until ${e.valid_until_utc})`,
    ...e.assumptions.map(a => `  note          ${a}`),
  ].join('\n');
}

// ---- network commands ---------------------------------------------------------------------------

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

async function postJob(spec: JobSpec, label: string, json: boolean | undefined): Promise<void> {
  const spinner = ora(`Submitting ${label} to biofs-node...`).start();
  const r = await axios.post(`${CONFIG.API_BASE_URL}/api_biofs_node/job`, spec, { timeout: 300_000 });
  spinner.succeed(chalk.green(`${label} submitted to biofs-node`));
  if (json) { console.log(JSON.stringify(r.data, null, 2)); return; }
  console.log();
  console.log(`  ${chalk.cyan('Job ID:')}   ${r.data.jobId || spec.jobId}`);
  console.log(`  ${chalk.cyan('Mode:')}     ${spec.proteinImpactRequest.mode}   (${spec.inputType})`);
  console.log(`  ${chalk.cyan('Layers:')}   ${spec.proteinImpactRequest.layers.join(', ')}`);
  console.log(`  ${chalk.cyan('Status:')}   ${r.data.status || 'accepted'}`);
  console.log(`  ${chalk.cyan('Result:')}   ${spec.manifestUri}`);
  console.log();
  console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${r.data.jobId || spec.jobId}`));
  console.log(chalk.gray('Fetch:   ') + chalk.cyan(`biofs protein-impact results ${r.data.jobId || spec.jobId}`));
  console.log();
}

function failWith(spinnerLabel: string, error: any): never {
  if (error.response) Logger.error(`${spinnerLabel}: server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
  else Logger.error(`${spinnerLabel}: ${error.message}`);
  process.exit(1);
}

function approvalFrom(o: { approve?: string; maxUsd?: string }): { estimate_id: string; max_usd: number } | undefined {
  if (!o.approve && !o.maxUsd) return undefined;
  if (!o.approve || !o.maxUsd) throw new Error('--approve <estimate_id> and --max-usd <N> go together');
  const max = Number(o.maxUsd);
  if (!Number.isFinite(max)) throw new Error('--max-usd must be a number');
  return { estimate_id: o.approve, max_usd: max };
}

/** Print the price of a GPU request; true when the caller should stop (estimate-only, or approval missing). */
function priceGate(req: ProteinImpactRequest, o: { estimate?: boolean; approve?: string }): boolean {
  const e = estimate(req);
  if (!e.gpu) {
    if (!o.estimate) return false;
    console.log(chalk.bold('CPU only, no approval needed:\n') + renderEstimate(e));
    return true;
  }
  console.log(chalk.bold('GPU estimate (a planning figure; the node stops a job at 1.5 x the approved total):\n'));
  console.log(renderEstimate(e));
  console.log();
  if (o.estimate) return true;
  if (!o.approve) {
    console.log(chalk.yellow('No job was submitted. To run it, repeat the command with:'));
    console.log(chalk.cyan(`  --approve ${e.estimate_id} --max-usd ${Math.ceil(e.total_usd)}`));
    process.exitCode = 1;
    return true;
  }
  return false;
}

export interface FetchOptions { genes?: string; json?: boolean }

export async function fetchCommand(o: FetchOptions): Promise<void> {
  try {
    const creds = await getCredentials();
    if (!creds) throw new Error('Not authenticated. Run "biofs login" first.');
    const req = buildFetchRequest(parseGenes(o.genes));
    await postJob(buildJobSpec(req, undefined, creds, new Date().toISOString().slice(0, 10)), 'protein-impact fetch', o.json);
  } catch (e: any) { failWith('protein-impact fetch failed', e); }
}

export interface ValidateOptions { genes?: string; layers?: string; approve?: string; maxUsd?: string; estimate?: boolean; json?: boolean }

export async function validateCommand(o: ValidateOptions): Promise<void> {
  try {
    const creds = await getCredentials();
    if (!creds) throw new Error('Not authenticated. Run "biofs login" first.');
    const genes = parseGenes(o.genes);
    const layers = parseLayers(o.layers, ['plm']);
    if (priceGate(buildValidateRequest(genes, layers), o)) return;
    const req = buildValidateRequest(genes, layers, approvalFrom(o));
    verifyApproval(req);
    await postJob(buildJobSpec(req, undefined, creds, new Date().toISOString().slice(0, 10)), 'protein-impact validate', o.json);
  } catch (e: any) { failWith('protein-impact validate failed', e); }
}

export interface ProbeOptions { genes?: string; approve?: string; maxUsd?: string; estimate?: boolean; json?: boolean }

export async function probeCommand(o: ProbeOptions): Promise<void> {
  try {
    const creds = await getCredentials();
    if (!creds) throw new Error('Not authenticated. Run "biofs login" first.');
    const genes = parseGenes(o.genes);
    if (priceGate(buildProbeRequest(genes), o)) return;
    const req = buildProbeRequest(genes, approvalFrom(o));
    verifyApproval(req);
    await postJob(buildJobSpec(req, undefined, creds, new Date().toISOString().slice(0, 10)), 'protein-impact probe', o.json);
  } catch (e: any) { failWith('protein-impact probe failed', e); }
}

export interface ApplyOptions {
  variant: string[];
  source: string[];
  gateFile: string;
  layers?: string;
  approve?: string;
  maxUsd?: string;
  estimate?: boolean;
  diagnosisAssumption?: string;
  json?: boolean;
}

export async function applyCommand(serial: string, o: ApplyOptions): Promise<void> {
  try {
    const creds = await getCredentials();
    if (!creds) throw new Error('Not authenticated. Run "biofs login" first.');
    if (!o.variant || o.variant.length === 0) throw new Error('at least one --variant GENE:p.Leu225Arg is required');
    if (!o.source || o.source.length === 0 || o.source.length > MAX_SOURCES) throw new Error(`--source <biocid> is required (1 to ${MAX_SOURCES}): the biocid(s) the variants were read from`);
    for (const s of o.source) if (!BIOCID_RE.test(s)) throw new Error(`--source is not a biocid: ${s}`);
    if (!o.source.some(s => s.includes(serial))) Logger.warn(`none of the --source biocids mentions ${serial}; check that they belong to this sample`);

    const gate = JSON.parse(fs.readFileSync(o.gateFile, 'utf8')) as GateDocument;
    const { targets, subs } = groupTargets(o.variant);
    const layers = parseLayers(o.layers, ['features']);

    // the gate must pass before anything is sent
    verifyGateForApply(gate, loadRules(), { tools_lock_sha256: toolsLockSha256(), variants: subs.map(oneLetter) });

    // the sample must carry every variant (read through the gated variants API; the sqlite stays on the server)
    const api = new FuseAPIClient();
    const spinner = ora('Checking that the sample carries the variants (gated API, no download)...').start();
    const rows: FuseVariantRow[] = [];
    for (const t of targets) {
      const r = await api.variantsPolled(serial, creds.wallet_address, creds.user_signature, { gene: t.gene, so: 'MIS', maxAf: '1', limit: 500 });
      rows.push(...r.rows);
    }
    const { missing } = carrierMatches(rows, subs);
    if (missing.length) {
      spinner.fail(chalk.red('Variant not found in the sample'));
      throw new Error(`${missing.map(s => formatVariant(s)).join(', ')} not among the annotated missense variants of ${serial}; nothing was submitted`);
    }
    spinner.succeed(chalk.green(`Sample ${serial} carries all ${subs.length} requested variant(s)`));

    const base: ApplyBuild = { serial, variants: o.variant, sources: o.source, layers, gate, diagnosisAssumption: o.diagnosisAssumption };
    if (priceGate(buildApplyRequest(base), o)) return;
    const req = buildApplyRequest({ ...base, approval: approvalFrom(o) });
    verifyApproval(req);
    await postJob(buildJobSpec(req, gate, creds, new Date().toISOString().slice(0, 10)), 'protein-impact apply', o.json);
  } catch (e: any) {
    if (e instanceof GateBlockedError) { Logger.error(e.message); process.exit(8); }
    failWith('protein-impact apply failed', e);
  }
}

export interface GateSignOptions { yes?: boolean; out?: string }

export async function gateSignCommand(file: string, o: GateSignOptions): Promise<void> {
  try {
    const creds = await getCredentials();
    if (!creds) throw new Error('Not authenticated. Run "biofs login" first.');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as GateDocument;
    const rules = loadRules();
    const ev = evaluateGate(rules, doc.metrics);
    const m = doc.metrics;
    console.log(chalk.bold('Gate document'));
    console.log(`  benchmark          ${m.n_pos} damaging, ${m.n_neg} tolerated`);
    console.log(`  AUROC (pooled)     ${m.pooled_auroc.point}   95% CI ${m.pooled_auroc.ci_low} to ${m.pooled_auroc.ci_high}`);
    console.log(`  best baseline      ${m.best_baseline.name} ${m.best_baseline.auroc}`);
    console.log(`  by domain          ${Object.entries(m.domain_auroc).map(([k, v]) => `${k} ${v} (${m.domain_n?.[k]?.pos ?? '?'} damaging, ${m.domain_n?.[k]?.neg ?? '?'} tolerated)`).join(', ')}`);
    console.log(`  shuffled labels    95% CI ${m.shuffled_label.ci_low} to ${m.shuffled_label.ci_high}`);
    console.log(`  verdict            ${ev.pass ? chalk.green('PASS') : chalk.red('FAIL')}`);
    for (const r of ev.reasons) console.log(chalk.red(`    ${r}`));
    if (doc.rules_sha256 !== rulesSha256(rules)) throw new Error('the gate was computed against different rules than gate_rules.json; it cannot be signed');
    if (doc.tools_lock_sha256 !== toolsLockSha256()) throw new Error('the gate was computed with different tool versions than tools.lock.json; re-validate');
    if (!ev.pass) throw new Error('the gate does not pass; it is not signed');
    if (!o.yes) { console.log(chalk.yellow('\nReview the numbers above, then repeat with --yes to sign.')); process.exitCode = 2; return; }
    const signed = signGate(doc, creds.wallet_address.toLowerCase(), new Date().toISOString());
    const out = o.out || file.replace(/\.json$/, '') + '.signed.json';
    fs.writeFileSync(out, JSON.stringify(signed, null, 2));
    console.log(chalk.green(`\nSigned by ${signed.signed_off!.by} at ${signed.signed_off!.at}`));
    console.log(`  file      ${path.resolve(out)}`);
    console.log(`  gate id   ${gateId(signed)}`);
  } catch (e: any) { failWith('protein-impact gate-sign failed', e); }
}

export interface ResultsOptions { out?: string; json?: boolean }

export async function resultsCommand(jobId: string, o: ResultsOptions): Promise<void> {
  try {
    const creds = await getCredentials();
    if (!creds) throw new Error('Not authenticated. Run "biofs login" first.');
    if (!/^pi-[a-z]+-[A-Za-z0-9]+-[a-f0-9]{12}$/.test(jobId)) throw new Error(`not a protein-impact job id: ${jobId}`);
    const r = await axios.get(`${BIOFS_NODE_BASE}/protein_impact_result`, {
      params: { job_id: jobId },
      headers: { 'X-Biofs-Wallet': creds.wallet_address, 'X-Biofs-Signature': creds.user_signature },
      timeout: 60_000,
      validateStatus: s => s < 600,
    });
    if (r.status === 404) throw new Error('no result yet (the job may still be running, or the node does not have the result endpoint)');
    if (r.status >= 400) throw new Error(`${r.status}: ${r.data?.error || 'unknown'}`);
    const out = o.out || `protein-impact-${jobId}.json`;
    fs.writeFileSync(out, JSON.stringify(r.data, null, 2));
    let gateFile: string | null = null;
    if (r.data.gate_document) {
      gateFile = out.replace(/\.json$/, '') + '.gate.json';
      fs.writeFileSync(gateFile, JSON.stringify(r.data.gate_document, null, 2));
    }
    if (o.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
    const m = r.data;
    console.log(chalk.bold(`protein-impact ${m.jobId}  ${m.status}`));
    console.log(chalk.gray(m.research_banner || ''));
    for (const s of m.stages || []) console.log(`  stage ${String(s.layer).padEnd(10)} ${s.status}${s.error ? '  ' + s.error : ''}`);
    for (const v of m.results || []) console.log(`  ${v.variant}  mature ${v.mature_pos}  layers: ${Object.keys(v.layers).join(', ') || 'none'}`);
    for (const e of m.errors || []) console.log(chalk.red(`  ${e}`));
    if (r.data.gate_document) {
      const g = r.data.gate_document;
      console.log(`  gate document: ${g.pass ? chalk.green('PASS') : chalk.red('FAIL')}${(g.reasons || []).map((x: string) => '\n    ' + x).join('')}`);
    }
    console.log(`\n  saved ${path.resolve(out)}`);
    if (gateFile) console.log(`  gate   ${path.resolve(gateFile)}   (review it, then: biofs protein-impact gate-sign ${gateFile} --yes)`);
    console.log(chalk.gray('  To file it with lineage: ') + chalk.cyan(`biofs register-derived ${out} --type protein-impact-report --parent <source biocid>`));
  } catch (e: any) { failWith('protein-impact results failed', e); }
}
