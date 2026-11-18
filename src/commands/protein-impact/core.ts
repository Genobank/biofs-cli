/**
 * Orchestrator of a protein-impact job. Pure of process and cloud calls: storage, network and the
 * heavy stages are injected, so the control flow (guard, approval, gate, caching, manifest) is unit tested
 * without GCP. `exec.ts` wires the production dependencies.
 *
 * Order of refusal, each before any stage runs:
 *   1. the request passes the no-design guard and its job id matches its content;
 *   2. GPU layers carry an approval that matches a fresh estimate;
 *   3. apply carries a gate document that matches the request's gate id, passes the committed rules,
 *      was computed with this tools lock, is signed off, and does not contain the variants being scored.
 */

import {
  EXIT, GENES, GPU_LAYERS, LAYERS, RESEARCH_BANNER, SCHEMA_GATE, SCHEMA_MANIFEST, Layer,
} from './constants';
import { GuardError, ProteinImpactRequest, validateRequest } from './guard';
import { assertResidue, formatVariant, toMature } from './numbering';
import { substitutionFeatures } from './features';
import { GateBlockedError, GateDocument, GateRules, evaluateGate, gateId, loadRules, rulesSha256, verifyGateForApply } from './gate';
import { Benchmark, benchmarkSubs, loadBenchmark, validateBenchmark } from './benchmark';
import { assembleMetrics, rankAverage } from './metrics';
import { ApprovalError, Estimate, MACHINES, estimate, verifyApproval } from './estimate';
import { canonicalJson, jobIdFor, requestHash, sha256Hex } from './request';
import { ToolsLock, loadToolsLock, toolsLockSha256 } from './tools_lock';

/** Bump a layer's version when its logic changes, so cached stage outputs are not reused. */
export const STAGE_VERSION: Record<Layer, number> = { fetch: 1, features: 1, plm: 1, structure: 1, complex: 1, probe: 1, md: 1 };

export interface Storage {
  /** The text at a gs:// uri, or null when it does not exist. */
  readText(uri: string): string | null;
  writeText(uri: string, text: string): void;
  /** Copy a local file up to a gs:// uri. */
  copyIn(localPath: string, uri: string): void;
}
export interface Fetcher { get(url: string): Promise<Buffer> }

export interface SeqInfo { uniprot: string; sequence: string; seq_sha256: string; uri: string }
export interface SubInfo { variant: string; gene: string; pos: number; mature_pos: number; ref: string; alt: string }

export interface StageInput {
  layer: Layer;
  request: ProteinImpactRequest;
  subs: SubInfo[];
  sequences: Record<string, SeqInfo>;
  workDir: string;
  /** Outputs of earlier stages of this job, by layer. */
  prior: Record<string, StageOutput>;
  tools_lock_sha256: string;
  /** Wall-clock limit for this stage in milliseconds (GPU stages: what is left of 1.5 x the approved total). */
  timeout_ms?: number;
}
export interface StageOutput {
  /** One record per variant; the orchestrator files each under results[variant].layers[layer]. */
  records?: Array<Record<string, unknown> & { variant: string }>;
  outputs?: Array<{ uri: string; sha256?: string }>;
  summary?: Record<string, unknown>;
}
export interface StageRunner { run(input: StageInput): Promise<StageOutput> }

export interface ExecDeps {
  storage: Storage;
  fetcher: Fetcher;
  runner: StageRunner;
  now?: () => Date;
  log?: (m: string) => void;
  lock?: ToolsLock;
  rules?: GateRules;
}

export interface ExecArgs {
  jobId: string;
  creator: string;
  outBucket: string;
  refBucket: string;
  request: unknown;
  gate?: unknown;
  workDir: string;
}

export type JobStatus = 'OK' | 'EMPTY' | 'GATE_BLOCKED' | 'FAILED';
export interface StageRecord {
  layer: Layer; status: 'done' | 'cached' | 'failed'; stage_hash: string;
  started_at: string; finished_at: string; out_uri?: string; out_sha256?: string; error?: string;
}
export interface Manifest {
  schema: string; pipeline: 'protein-impact'; research_banner: string;
  jobId: string; mode: string; biosampleId: string | null; creator: string; status: JobStatus;
  request_hash: string; request: ProteinImpactRequest | null; diagnosis_assumption: string | null;
  tools_lock_sha256: string; rules_sha256: string;
  estimate: Estimate | null; gate: Record<string, unknown> | null;
  /** validate only: the unsigned gate document (the verdict is inside it); sign it with `gate-sign`. */
  gate_document: GateDocument | null;
  stages: StageRecord[]; results: Array<{ variant: string; gene: string; hgvs_pos: number; mature_pos: number; ref: string; alt: string; layers: Record<string, unknown> }>;
  errors: string[]; folder: string; createdAt: string;
}
export interface ExecResult { status: JobStatus | 'GUARD' | 'APPROVAL'; exit: number; manifest: Manifest | null; log: string[] }

export function jobFolder(a: { outBucket: string; creator: string; jobId: string }): string {
  return `gs://${a.outBucket}/biowallet/${a.creator.toLowerCase()}/protein-impact/${a.jobId}`;
}
const refStoreOf = (bucket: string) => `gs://${bucket}/protein`;

export function parseFasta(text: string): string {
  const seq = text.split('\n').filter(l => l.trim() && !l.startsWith('>')).map(l => l.trim()).join('').toUpperCase();
  if (!/^[ACDEFGHIKLMNPQRSTVWY]+$/.test(seq)) throw new Error('FASTA holds residues outside the 20 standard amino acids');
  return seq;
}

/** Sequences of the requested genes, from the reference store when cached, else UniProt; always hash checked. */
export async function ensureSequences(genes: string[], d: ExecDeps, refStore: string, log: (m: string) => void): Promise<Record<string, SeqInfo>> {
  const out: Record<string, SeqInfo> = {};
  for (const gene of genes) {
    const g = GENES[gene];
    const uri = `${refStore}/uniprot/${g.uniprot}/${g.seq_sha256.slice(0, 12)}.fasta`;
    let text = d.storage.readText(uri);
    const cached = text !== null;
    if (text === null) {
      log(`[protein-impact] fetching ${g.uniprot} from UniProt`);
      text = (await d.fetcher.get(`https://rest.uniprot.org/uniprotkb/${g.uniprot}.fasta`)).toString('utf8');
    }
    const sequence = parseFasta(text);
    const sha = sha256Hex(sequence);
    if (sha !== g.seq_sha256 || sequence.length !== g.length) {
      throw new Error(`${g.uniprot} (${gene}): the sequence differs from the pinned UniProt 2026_03 entry (length ${sequence.length}, sha256 ${sha.slice(0, 12)}); stop and re-pin deliberately`);
    }
    if (!cached) d.storage.writeText(uri, text);
    out[gene] = { uniprot: g.uniprot, sequence, seq_sha256: sha, uri };
  }
  return out;
}

function variantsOf(req: ProteinImpactRequest): SubInfo[] {
  const out: SubInfo[] = [];
  for (const t of req.targets) for (const s of t.subs) {
    out.push({ variant: formatVariant({ gene: t.gene, ref: s.ref, pos: s.pos, alt: s.alt }), gene: t.gene, pos: s.pos, mature_pos: toMature(t.gene, s.pos), ref: s.ref, alt: s.alt });
  }
  return out;
}
const oneLetter = (s: SubInfo) => formatVariant({ gene: s.gene, ref: s.ref, pos: s.pos, alt: s.alt }, 'one');

/** The scores the validation ranks. Each is oriented so that a higher number means "more likely damaging". */
const COMPONENTS: Array<{ name: string; layer: Layer; value: (rec: Record<string, any>) => unknown; sign: 1 | -1 }> = [
  { name: 'esm2_650m', layer: 'plm', value: r => r.esm2_650m?.llr, sign: -1 }, // a lower log-likelihood ratio = less expected = more damaging
];

/** Stages that need no container: the numbering check and the baseline substitution features. */
async function runCpuStage(input: StageInput): Promise<StageOutput> {
  if (input.layer === 'features') {
    const records = input.subs.map(s => {
      assertResidue({ gene: s.gene, ref: s.ref, pos: s.pos, alt: s.alt }, input.sequences[s.gene].sequence);
      return { variant: s.variant, ...substitutionFeatures(s.ref, s.alt), mature_pos: s.mature_pos, ref_residue_checked: true };
    });
    return { records };
  }
  throw new Error(`layer ${input.layer} has no built-in implementation`);
}

export async function runProteinImpact(args: ExecArgs, d: ExecDeps): Promise<ExecResult> {
  const lines: string[] = [];
  const log = (m: string) => { lines.push(m); d.log?.(m); };
  const now = d.now ?? (() => new Date());
  const lock = d.lock ?? loadToolsLock();
  const rules = d.rules ?? loadRules();
  const lockSha = toolsLockSha256(lock);
  const folder = jobFolder(args);

  // 1. guard, and the job id must be the one this request hashes to
  let req: ProteinImpactRequest;
  try {
    req = validateRequest(args.request);
    if (jobIdFor(req) !== args.jobId) throw new GuardError([`job id ${args.jobId} does not match the request (expected ${jobIdFor(req)})`]);
  } catch (e: any) {
    log(`[protein-impact] REFUSED: ${e.message}`);
    return { status: 'GUARD', exit: EXIT.GUARD, manifest: null, log: lines };
  }
  const rh = requestHash(req);
  const bench: Benchmark | null = req.mode === 'validate' ? loadBenchmark() : null;
  const genes = req.targets.map(t => t.gene);
  const subs = bench ? benchmarkSubs(bench, genes) : variantsOf(req);
  const base = {
    schema: SCHEMA_MANIFEST, pipeline: 'protein-impact' as const, research_banner: RESEARCH_BANNER,
    jobId: args.jobId, mode: req.mode, biosampleId: req.serial ?? null, creator: args.creator.toLowerCase(),
    request_hash: rh, request: req, diagnosis_assumption: req.diagnosis_assumption ?? null,
    tools_lock_sha256: lockSha, rules_sha256: rulesSha256(rules), folder, createdAt: now().toISOString(),
  };
  const writeManifest = (m: Manifest) => {
    d.storage.writeText(`${folder}/manifest.json`, JSON.stringify(m, null, 2));
    d.storage.writeText(`${folder}/run.log`, lines.join('\n') + '\n');
  };
  const early = (status: JobStatus, result: ExecResult['status'], exit: number, errors: string[], est: Estimate | null, gate: Record<string, unknown> | null): ExecResult => {
    const m: Manifest = { ...base, status, estimate: est && est.gpu ? est : null, gate, gate_document: null, stages: [], results: [], errors };
    writeManifest(m);
    return { status: result, exit, manifest: m, log: lines };
  };

  // 2. approval for GPU layers (the client and biofs-node checked it too; a forged forward stops here)
  let est: Estimate | null = null;
  try {
    est = estimate(req, now());
    verifyApproval(req, now());
  } catch (e: any) {
    if (e instanceof ApprovalError) {
      log(`[protein-impact] APPROVAL REFUSED: ${e.message}`);
      return early('FAILED', 'APPROVAL', EXIT.APPROVAL, [e.message], est, null);
    }
    throw e;
  }

  // 3. gate (apply only)
  let gateInfo: Record<string, unknown> | null = null;
  if (req.mode === 'apply') {
    try {
      const doc = args.gate as GateDocument | undefined;
      if (!doc) throw new GateBlockedError(['no gate document was supplied with the job']);
      if (gateId(doc) !== req.gate) throw new GateBlockedError(['the gate document does not match the request\'s gate id (it was altered or is a different document)']);
      verifyGateForApply(doc, rules, { tools_lock_sha256: lockSha, variants: subs.map(oneLetter) });
      gateInfo = { id: req.gate, rules_sha256: doc.rules_sha256, benchmark_sha256: doc.benchmark_sha256, tools_lock_sha256: doc.tools_lock_sha256, signed_off: doc.signed_off, metrics: doc.metrics };
    } catch (e: any) {
      if (e instanceof GateBlockedError) {
        log(`[protein-impact] ${e.message}`);
        return early('GATE_BLOCKED', 'GATE_BLOCKED', EXIT.GATE_BLOCKED, e.reasons, est, { id: req.gate ?? null, blocked: true });
      }
      throw e;
    }
  }

  // 3b. validate: the benchmark must be consistent and match the pinned sequences before anything is scored
  let sequences: Record<string, SeqInfo> = {};
  if (bench) {
    try {
      sequences = await ensureSequences(genes, d, refStoreOf(args.refBucket), log);
      const problems = validateBenchmark(bench, Object.fromEntries(Object.entries(sequences).map(([g, sq]) => [g, sq.sequence])));
      if (problems.length) throw new Error(`benchmark problems: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ''}`);
    } catch (e: any) {
      log(`[protein-impact] validate cannot start: ${e.message}`);
      return early('FAILED', 'FAILED', EXIT.FAILED, [String(e.message)], est, null);
    }
  }

  // 4. stages in canonical order
  const stages: StageRecord[] = [];
  const prior: Record<string, StageOutput> = {};
  const errors: string[] = [];
  const ordered = LAYERS.filter(l => req.layers.includes(l));
  let gpuSpentUsd = 0;
  const priciest = Math.max(...Object.values(MACHINES).filter(m => m.gpu).map(m => m.usd_per_hour));

  for (const layer of ordered) {
    const stageHash = sha256Hex(canonicalJson({ request_hash: rh, layer, tools_lock_sha256: lockSha, version: STAGE_VERSION[layer] }));
    const dir = `${folder}/stages/${layer}`;
    const started = now().toISOString();
    // cache: an identical request does zero compute
    const done = d.storage.readText(`${dir}/DONE`);
    const outText = done ? d.storage.readText(`${dir}/out.json`) : null;
    if (done && outText) {
      try {
        const meta = JSON.parse(done);
        if (meta.stage_hash === stageHash && meta.out_sha256 === sha256Hex(outText)) {
          prior[layer] = JSON.parse(outText);
          stages.push({ layer, status: 'cached', stage_hash: stageHash, started_at: started, finished_at: started, out_uri: `${dir}/out.json`, out_sha256: meta.out_sha256 });
          log(`[protein-impact] ${layer}: cached (${stageHash.slice(0, 12)})`);
          continue;
        }
      } catch (_) { /* fall through and recompute */ }
    }
    try {
      let out: StageOutput;
      if (layer === 'fetch') {
        sequences = await ensureSequences(genes, d, refStoreOf(args.refBucket), log);
        out = { summary: { sequences: Object.fromEntries(Object.entries(sequences).map(([g, s]) => [g, { uniprot: s.uniprot, length: s.sequence.length, seq_sha256: s.seq_sha256, uri: s.uri }])) } };
      } else {
        if (!Object.keys(sequences).length) sequences = await ensureSequences(genes, d, refStoreOf(args.refBucket), log);
        const input: StageInput = { layer, request: req, subs, sequences, workDir: args.workDir, prior: { ...prior }, tools_lock_sha256: lockSha };
        if (GPU_LAYERS.includes(layer)) {
          const approved = req.approval!.max_usd;
          const leftUsd = approved * 1.5 - gpuSpentUsd;
          if (leftUsd <= 0) throw new Error('the 1.5 x approved budget is spent; the job stops here');
          input.timeout_ms = Math.floor((leftUsd / priciest) * 3600 * 1000);
        }
        out = layer === 'features' ? await runCpuStage(input) : await d.runner.run(input);
        if (GPU_LAYERS.includes(layer)) gpuSpentUsd += ((now().getTime() - new Date(started).getTime()) / 3.6e6) * priciest;
      }
      const text = JSON.stringify(out, null, 2);
      const outSha = sha256Hex(text);
      d.storage.writeText(`${dir}/out.json`, text);
      d.storage.writeText(`${dir}/DONE`, JSON.stringify({ stage_hash: stageHash, finished_at: now().toISOString(), out_sha256: outSha }));
      prior[layer] = out;
      stages.push({ layer, status: 'done', stage_hash: stageHash, started_at: started, finished_at: now().toISOString(), out_uri: `${dir}/out.json`, out_sha256: outSha });
      log(`[protein-impact] ${layer}: done`);
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      stages.push({ layer, status: 'failed', stage_hash: stageHash, started_at: started, finished_at: now().toISOString(), error: msg });
      errors.push(`${layer}: ${msg}`);
      log(`[protein-impact] ${layer}: FAILED ${msg}`);
      break;
    }
  }

  // 4b. validate: rank the benchmark with the scoring layers and write the unsigned gate document
  let gateDocument: GateDocument | null = null;
  if (bench && !stages.some(st => st.status === 'failed')) {
    try {
      const comps = COMPONENTS.filter(c => prior[c.layer]);
      if (!comps.length) throw new Error('validate needs a scoring layer (plm)');
      const columns = comps.map(c => {
        const byVariant = new Map((prior[c.layer].records ?? []).map(r => [r.variant, r]));
        return subs.map(sb => {
          const rec = byVariant.get(sb.variant);
          const v = rec ? c.value(rec) : undefined;
          if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${c.name} gave no score for ${sb.variant}`);
          return c.sign * v;
        });
      });
      const metrics = assembleMetrics(bench.rows, rankAverage(columns));
      const verdict = evaluateGate(rules, metrics);
      gateDocument = {
        schema: SCHEMA_GATE, created_at: now().toISOString(), rules_sha256: rulesSha256(rules), benchmark_sha256: bench.sha256,
        tools_lock_sha256: lockSha, benchmark_variants: bench.rows.map(r => r.variant_id), components: comps.map(c => c.name),
        metrics, pass: verdict.pass, reasons: verdict.reasons,
      };
      d.storage.writeText(`${folder}/gate.json`, JSON.stringify(gateDocument, null, 2));
      log(`[protein-impact] gate document written: ${verdict.pass ? 'PASS' : 'FAIL'}${verdict.reasons.length ? ' (' + verdict.reasons.join('; ') + ')' : ''}`);
    } catch (e: any) {
      errors.push(`gate: ${e.message}`);
      log(`[protein-impact] gate document FAILED: ${e.message}`);
    }
  }

  // 5. results by variant
  const results = subs.map(s => ({ variant: s.variant, gene: s.gene, hgvs_pos: s.pos, mature_pos: s.mature_pos, ref: s.ref, alt: s.alt, layers: {} as Record<string, unknown> }));
  for (const [layer, out] of Object.entries(prior)) {
    for (const rec of out.records ?? []) {
      const row = results.find(r => r.variant === rec.variant);
      if (row) { const { variant: _v, ...rest } = rec; row.layers[layer] = rest; }
    }
  }
  const anyRecords = results.some(r => Object.keys(r.layers).length > 0);
  const failed = stages.some(st => st.status === 'failed') || (!!bench && !gateDocument);
  const wantsRecords = req.mode === 'apply' || req.mode === 'validate';
  const status: JobStatus = failed ? 'FAILED' : (wantsRecords && !anyRecords ? 'EMPTY' : 'OK');
  const m: Manifest = { ...base, status, estimate: est.gpu ? est : null, gate: gateInfo, gate_document: gateDocument, stages, results, errors };
  writeManifest(m);
  log(`[protein-impact] ${status}: ${stages.length} stage(s), ${results.length} variant(s)`);
  return { status, exit: status === 'OK' ? EXIT.OK : status === 'EMPTY' ? EXIT.EMPTY : EXIT.FAILED, manifest: m, log: lines };
}
