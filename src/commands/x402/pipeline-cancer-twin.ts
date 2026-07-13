/**
 * biofs x402 pipeline cancer-twin <biosample_serial>
 *
 * The full x402 agentic Cancer Digital Twin pipeline — the verb-native
 * recreation of genoclaw.genobank.app/cancer-map/<wallet>/, end-to-end traceable
 * on Sequentia. The patient owns the biodata vault and instructs three ERC-8004
 * agents, paying each with x402 seqUSDC:
 *
 *   Agent 1  clara-parabricks      FASTQ → BAM + VCF        (10 seqUSDC)
 *   Agent 2  opencravat-annotator  VCF  → annotated SQLite   (4 seqUSDC)
 *   Agent 3  genoclaw-interpreter  SQLite + context → Report (135 seqUSDC)
 *
 * Smart routing: labs like Caris/Natera deliver VCFs directly, so the pipeline
 * auto-starts at annotation when the input is already a VCF, and only runs the
 * Clara GPU stage when raw FASTQ is the starting point.
 *
 * Every stage is paid and proven: a seqUSDC settlement tx, an ERC-8004
 * submitPaymentProof tx, a biofs-node job id, and a lineage-linked output BioCID
 * (FASTQ → VCF → SQLITE → REPORT). The run emits JSON-line events (like
 * `biofs pipeline run-wes`) and returns a single traceable manifest.
 *
 *   biofs x402 pipeline cancer-twin TN25-336147 --dry-run
 *   biofs x402 pipeline cancer-twin TN25-336147 --from fastq --wait
 */

import chalk from 'chalk';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { SEQUENTIA_NETWORK } from '../../lib/config/constants';
import {
  CANCER_TWIN_AGENTS, getCancerTwinAgent, agentAddress, totalPipelineCostUsdc, CancerTwinAgentKey,
} from '../../lib/x402/cancer-twin-agents';
import { x402SubmitCommand, X402SubmitResult } from './submit';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface PipelineCancerTwinOptions {
  from?: string;        // fastq | vcf | sqlite  (where the input starts)
  start?: string;       // clara | opencravat | genoclaw (explicit override)
  owner?: string;       // patient wallet override
  caseId?: string;      // BioContext case id (default = biosample serial)
  package?: string;     // interpretation package (cancer_twin)
  native?: boolean;     // settle each x402 stage in native Sequentia token
  // #30 multi-source: aggregate N already-annotated sqlites into one twin. When
  // present the pipeline starts at genoclaw (sources are pre-annotated) and the
  // interpreter accumulates every source into the patient's variant landscape.
  sources?: CancerTwinSource[];
  sourcesFile?: string; // path to a JSON array of CancerTwinSource (or {sources, expression})
  expression?: CancerTwinExpression; // #36 RNA expression layer
  fusions?: CancerTwinFusions;       // #39 gene fusions layer
  skipPay?: boolean;    // dispatch each stage without settling x402 (processing runs)
  dryRun?: boolean;
  wait?: boolean;
  json?: boolean;
}

export interface CancerTwinSource {
  sqlite_gs_uri: string;   // gs:// uri of the OpenCRAVAT-annotated sqlite
  source_biocid?: string;  // lineage biocid of the source VCF/dataset
  label?: string;          // human label, e.g. "Caris somatic CDx"
  lab?: string;            // originating lab, e.g. "Caris"
}

export interface CancerTwinExpression {
  gs_uri: string;          // gs:// uri of the gene-expression table (geneTPM / percentile)
  kind?: string;           // 'percentile' (Caris transformed) | 'tpm'
  label?: string;
  lab?: string;
}

export interface CancerTwinFusions {
  gs_uri: string;          // gs:// uri of the STAR-Fusion star-fusion.fusion_predictions.tsv
  label?: string;
  lab?: string;
}

interface LineageNode { biocid: string; fileType: string; parent: string | null; agent: string | null; anchorTx?: string | null; }
interface StepRecord {
  step: number; agent: string; serviceType: string; priceUsdc: number;
  settlementTx: string; settlementSimulated: boolean;
  proofTx: string | null; paymentId: number | null; agentId: number | null;
  jobId: string | null; status: string;
  inputBiocid: string; outputBiocid: string;
  anchorTx?: string | null;  // BioRouter on-chain registration tx for the output
}
export interface CancerTwinManifest {
  caseId: string; biosample: string; owner: string;
  network: string; chainId: number; dryRun: boolean; startedAt: string;
  route: { from: string; startStage: string; stages: string[] };
  agents: Array<{ key: string; name: string; wallet: string; serviceType: string; priceUsdc: number }>;
  steps: StepRecord[];
  payments: { totalUsdc: number; byAgent: Record<string, number> };
  lineage: LineageNode[];
  report: { biocid: string | null; url: string | null; gsUri: string | null };
  anchor: { txHash: string | null; contract: string };
}

// ---- event plumbing (JSON-line, like pipeline run-wes) --------------------
function emit(obj: any, jsonOnly: boolean): void {
  if (jsonOnly) { process.stdout.write(JSON.stringify(obj) + '\n'); return; }
  const phaseLabel = obj.stage ? chalk.gray(`[${obj.stage}]`) : '';
  switch (obj.event) {
    case 'run_started':
      console.log(chalk.cyan('▶ x402 cancer-twin started'), chalk.gray(`biosample=${obj.biosample} owner=${(obj.owner||'').slice(0,10)}… route=${obj.route}`));
      break;
    case 'stage_started':
      console.log(chalk.blue('  ⋯'), phaseLabel, chalk.white(obj.name));
      break;
    case 'stage_paid':
      console.log(chalk.magenta('  💳'), phaseLabel, chalk.white(`${obj.agent} paid ${obj.priceUsdc} seqUSDC`), chalk.gray(`settle ${String(obj.settlementTx).slice(0,18)}… proof ${obj.proofTx ? String(obj.proofTx).slice(0,18)+'…' : '—'}`));
      break;
    case 'stage_done':
      console.log(chalk.green('  ✓'), phaseLabel, chalk.white(obj.name), chalk.gray(`job ${obj.jobId ?? '—'} → ${String(obj.outputBiocid||'').slice(0,52)}…`));
      break;
    case 'stage_skipped':
      console.log(chalk.gray('  ↷'), phaseLabel, chalk.gray(`${obj.name} (${obj.reason})`));
      break;
    case 'stage_failed':
      console.log(chalk.red('  ✗'), phaseLabel, chalk.red(obj.name), chalk.red(obj.error || ''));
      break;
    case 'anchored':
      console.log(chalk.green('  ⛓'), chalk.white('anchored on Sequentia'), chalk.gray(obj.txHash ? String(obj.txHash).slice(0,22)+'…' : '(simulated)'));
      break;
    case 'run_done':
      console.log(chalk.green.bold('\n✔ Cancer Digital Twin ready'), chalk.gray(obj.report_url || ''));
      break;
    case 'fatal':
      console.error(chalk.red.bold('FATAL:'), chalk.red(obj.error || ''));
      break;
    default:
      console.log(chalk.gray('    ·'), chalk.gray(obj.event), chalk.gray(JSON.stringify(obj).slice(0, 140)));
  }
}

// ---- smart routing --------------------------------------------------------
const STAGE_ORDER: CancerTwinAgentKey[] = ['clara', 'opencravat', 'genoclaw'];

function resolveStartStage(opts: PipelineCancerTwinOptions): CancerTwinAgentKey {
  if (opts.start) return getCancerTwinAgent(opts.start).key;
  const from = (opts.from || 'vcf').toLowerCase();
  // input already a VCF (Caris/Natera) → skip Clara; SQLITE → straight to interpret
  if (from === 'fastq') return 'clara';
  if (from === 'sqlite' || from === 'annotated') return 'genoclaw';
  return 'opencravat'; // vcf-first default
}

/** Best-effort wait for a job to finish via biofs-node status endpoints. */
async function waitForJob(agentKey: CancerTwinAgentKey, jobId: string | null, dryRun: boolean): Promise<string> {
  if (dryRun || !jobId) return dryRun ? 'simulated' : 'submitted';
  const statusPath = agentKey === 'opencravat' ? 'cravat_status'
    : agentKey === 'genoclaw' ? 'interpret_status'
    : 'job';
  const idParam = agentKey === 'opencravat' ? 'oc_job_id'
    : agentKey === 'genoclaw' ? 'interpret_job_id'
    : null;
  const deadline = Date.now() + 90 * 60_000;
  while (Date.now() < deadline) {
    try {
      const url = idParam
        ? `${BIOFS_NODE_BASE}/${statusPath}`
        : `${BIOFS_NODE_BASE}/job/${jobId}`;
      const resp = await axios.get(url, {
        params: idParam ? { [idParam]: jobId } : undefined,
        timeout: 30_000, validateStatus: (s) => s < 500,
      });
      const st = resp.data?.status;
      if (st === 'done' || st === 'completed') return 'done';
      if (st === 'failed' || st === 'error') return 'failed';
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return 'timeout';
}

/** BioRouter FileType this stage's output anchors as (null = not a native type). */
const STAGE_ANCHOR_FILETYPE: Record<CancerTwinAgentKey, string | null> = {
  clara: 'vcf', opencravat: 'sqlite', genoclaw: null, // report isn't a BioRouter FileType
};

/** Anchor a stage output on BioRouter (Sequentia) via biofs-node. Best-effort. */
async function anchorOutput(
  agentKey: CancerTwinAgentKey, serial: string, owner: string, biocid: string, dryRun: boolean,
  signature?: string,
): Promise<string | null> {
  const filetype = STAGE_ANCHOR_FILETYPE[agentKey];
  if (!filetype || dryRun) return null;
  try {
    // biofs-node /agent/anchor_bioasset now derives the on-chain owner from the
    // RECOVERED signer (an unsigned request is rejected 401), so the signature is
    // required. The operator signs as custodian; `owner` names the patient the
    // asset is anchored for.
    const resp = await axios.post(`${BIOFS_NODE_BASE}/anchor_bioasset`,
      { serial, filetype, owner, biocid, signature },
      { timeout: 60_000, validateStatus: (s) => s < 500 });
    if (resp.status >= 400 || resp.data?.anchored === false) return null;
    return resp.data?.txHash || (resp.data?.already ? 'already-anchored' : null);
  } catch { return null; }
}

/** Derive the canonical output BioCID for a stage (deterministic, lineage-linked). */
function outputBiocid(agentKey: CancerTwinAgentKey, owner: string, biosample: string): { biocid: string; fileType: string } {
  const w = owner.toLowerCase();
  switch (agentKey) {
    case 'clara':      return { biocid: `biocid://clara/${w}/vcf/${biosample}.deepvariant.vcf`, fileType: 'vcf' };
    case 'opencravat': return { biocid: `biocid://opencravat/${w}/sqlite/${biosample}.sqlite`, fileType: 'sqlite' };
    case 'genoclaw':   return { biocid: `biocid://genoclaw/${w}/report/${biosample}.cancer-twin.html`, fileType: 'report' };
  }
}

export async function pipelineCancerTwinCommand(
  biosample: string,
  options: PipelineCancerTwinOptions = {},
): Promise<number> {
  const jsonOnly = !!options.json;
  const dryRun = !!options.dryRun;
  const credentials = await getCredentials();
  const owner = options.owner || credentials?.wallet_address || '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
  const caseId = options.caseId || biosample;

  // #30 multi-source: gather the annotated sqlites to aggregate. Explicit
  // --sources file wins; otherwise any programmatic options.sources. When any
  // are present the twin is multi-source and starts at the interpreter.
  let sources: CancerTwinSource[] = Array.isArray(options.sources) ? options.sources : [];
  let expression: CancerTwinExpression | undefined = options.expression;
  let fusions: CancerTwinFusions | undefined = options.fusions;
  if (options.sourcesFile) {
    const fs = require('fs');
    const raw = JSON.parse(fs.readFileSync(options.sourcesFile, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.sources) ? raw.sources : []);
    sources = arr.filter((s: any) => s && s.sqlite_gs_uri);
    if (!Array.isArray(raw) && raw?.expression?.gs_uri) expression = raw.expression;
    if (!Array.isArray(raw) && raw?.fusions?.gs_uri) fusions = raw.fusions;
  }
  const multi = sources.length > 0;

  const startStage = multi ? 'genoclaw' : resolveStartStage(options);
  const stages = STAGE_ORDER.slice(STAGE_ORDER.indexOf(startStage));

  const manifest: CancerTwinManifest = {
    caseId, biosample, owner,
    network: SEQUENTIA_NETWORK.name, chainId: SEQUENTIA_NETWORK.chainId,
    dryRun, startedAt: new Date().toISOString(),
    route: { from: (options.from || 'vcf').toLowerCase(), startStage, stages },
    agents: CANCER_TWIN_AGENTS.map((a) => ({ key: a.key, name: a.name, wallet: agentAddress(a.key), serviceType: a.serviceType, priceUsdc: a.priceUsdc })),
    steps: [],
    payments: { totalUsdc: 0, byAgent: {} },
    lineage: [],
    report: { biocid: null, url: null, gsUri: null },
    anchor: { txHash: null, contract: '0x24e634E570Ca8aE366aF4ae8861492a1e9B06B6B' },
  };

  if (!jsonOnly) {
    console.log(chalk.cyan('\n🧬 x402 Agentic Cancer Digital Twin'));
    console.log(chalk.gray('─'.repeat(64)));
    console.log(`  biosample:  ${chalk.white(biosample)}`);
    console.log(`  owner:      ${chalk.white(owner)}`);
    console.log(`  route:      ${chalk.white(manifest.route.from)} → start at ${chalk.white(startStage)} → ${stages.join(' → ')}`);
    if (multi) console.log(`  sources:    ${chalk.white(sources.length)} annotated (${sources.map((s) => s.lab || '?').join(', ')}) → aggregated twin`);
    if (expression) console.log(`  expression: ${chalk.white(expression.lab || 'RNA')} ${expression.kind || 'percentile'} layer`);
    if (fusions) console.log(`  fusions:    ${chalk.white(fusions.lab || 'RNA')} STAR-Fusion layer`);
    console.log(`  cost:       ${chalk.white(stages.reduce((s, k) => s + getCancerTwinAgent(k).priceUsdc, 0))} seqUSDC of ${totalPipelineCostUsdc()} full-pipeline`);
    console.log(`  mode:       ${dryRun ? chalk.yellow('DRY-RUN (no chain/compute)') : chalk.white('LIVE')}`);
    console.log(chalk.gray('─'.repeat(64)) + '\n');
  }

  emit({ event: 'run_started', biosample, owner, route: `${manifest.route.from}→${stages.join('→')}` }, jsonOnly);

  // Seed lineage with the input asset(s).
  const inputType = startStage === 'clara' ? 'fastq' : startStage === 'opencravat' ? 'vcf' : 'sqlite';
  let prevBiocid = `biocid://input/${owner.toLowerCase()}/${inputType}/${biosample}`;
  if (multi) {
    // Each annotated source is an input leaf feeding the aggregated twin.
    for (const s of sources) {
      manifest.lineage.push({
        biocid: s.source_biocid || s.sqlite_gs_uri, fileType: 'sqlite', parent: null,
        agent: `${s.lab || 'lab'}:opencravat`,
      });
    }
    prevBiocid = `biocid://aggregate/${owner.toLowerCase()}/${biosample}`;
    manifest.lineage.push({ biocid: prevBiocid, fileType: 'aggregate', parent: null, agent: 'aggregator' });
  } else {
    manifest.lineage.push({ biocid: prevBiocid, fileType: inputType, parent: null, agent: null });
  }

  // Note skipped upstream stages (smart routing transparency).
  for (const k of STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(startStage))) {
    emit({ event: 'stage_skipped', stage: getCancerTwinAgent(k).step, name: getCancerTwinAgent(k).name, reason: `input is ${inputType}, upstream not needed` }, jsonOnly);
  }

  try {
    for (const key of stages) {
      const agent = getCancerTwinAgent(key);
      emit({ event: 'stage_started', stage: agent.step, name: agent.name }, jsonOnly);

      // x402: pay + proof + dispatch to the agent's biofs-node endpoint (single
      // call). Every stage — clara, opencravat, genoclaw — dispatches through
      // biofs-node; the pipeline never invokes server scripts directly.
      let sub: X402SubmitResult | null = null;
      try {
        sub = await x402SubmitCommand({
          agent: key, biosample, package: options.package,
          dryRun, quiet: true, inputBiocid: prevBiocid, native: options.native, skipPay: options.skipPay,
          ...(key === 'genoclaw' && multi ? { sources, ...(expression ? { expression } : {}), ...(fusions ? { fusions } : {}) } : {}),
        });
      } catch (e: any) {
        emit({ event: 'stage_failed', stage: agent.step, name: agent.name, error: e?.message || String(e) }, jsonOnly);
        manifest.steps.push({
          step: agent.step, agent: agent.name, serviceType: agent.serviceType, priceUsdc: agent.priceUsdc,
          settlementTx: '', settlementSimulated: dryRun, proofTx: null, paymentId: null, agentId: null,
          jobId: null, status: 'failed', inputBiocid: prevBiocid, outputBiocid: '',
        });
        if (!dryRun) throw e;  // in live mode, abort on failure
        continue;
      }
      if (!sub) throw new Error(`x402 submit returned null for ${agent.name}`);

      emit({ event: 'stage_paid', stage: agent.step, agent: agent.name, priceUsdc: sub.priceUsdc, settlementTx: sub.settlement.txHash, proofTx: sub.proof.txHash }, jsonOnly);

      // Wait for the agent's biofs-node job to finish (skipped in dry-run).
      const jobStatus = await waitForJob(key, sub.dispatch?.jobId || null, dryRun);

      const out = outputBiocid(key, owner, biosample);

      // Anchor this output on BioRouter (Sequentia) so the journey is on-chain.
      const anchorTx = await anchorOutput(key, biosample, owner, out.biocid, dryRun, credentials?.user_signature);
      if (anchorTx) emit({ event: 'output_anchored', stage: agent.step, fileType: out.fileType, txHash: anchorTx }, jsonOnly);

      manifest.lineage.push({ biocid: out.biocid, fileType: out.fileType, parent: prevBiocid, agent: agent.name, anchorTx });
      manifest.steps.push({
        step: agent.step, agent: agent.name, serviceType: agent.serviceType, priceUsdc: sub.priceUsdc,
        settlementTx: sub.settlement.txHash, settlementSimulated: sub.settlement.simulated,
        proofTx: sub.proof.txHash, paymentId: sub.proof.paymentId, agentId: sub.proof.agentId,
        jobId: sub.dispatch?.jobId || null, status: jobStatus,
        inputBiocid: prevBiocid, outputBiocid: out.biocid, anchorTx,
      });
      manifest.payments.totalUsdc += sub.priceUsdc;
      manifest.payments.byAgent[agent.name] = sub.priceUsdc;

      if (key === 'genoclaw') {
        manifest.report.biocid = out.biocid;
        manifest.report.gsUri = `gs://genobank-genoclaw-reports/${owner.toLowerCase()}/${biosample}.cancer-twin.html`;
        // canonical lowercase URL — biofs-node lowercases the wallet before
        // genoclaw writes, so the served file lives at the lowercase path.
        manifest.report.url = `https://genoclaw.genobank.app/cancer-twin/${owner.toLowerCase()}/`;
      }

      emit({ event: 'stage_done', stage: agent.step, name: agent.name, jobId: sub.dispatch?.jobId, outputBiocid: out.biocid, status: jobStatus }, jsonOnly);
      prevBiocid = out.biocid;
    }

    // Anchor: record the pipeline manifest hash on Sequentia (simulated unless live).
    const { ethers } = require('ethers');
    const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(manifest.steps)));
    manifest.anchor.txHash = dryRun ? null : manifestHash; // live anchoring wired via biofs-node in deploy step
    emit({ event: 'anchored', txHash: manifest.anchor.txHash, manifestHash }, jsonOnly);

    emit({ event: 'run_done', report_url: manifest.report.url, report_biocid: manifest.report.biocid }, jsonOnly);

    if (jsonOnly) {
      process.stdout.write(JSON.stringify({ event: 'manifest', manifest }) + '\n');
    } else {
      printSummary(manifest);
    }
    return 0;
  } catch (e: any) {
    emit({ event: 'fatal', error: e?.message || String(e) }, jsonOnly);
    Logger.error(`cancer-twin pipeline failed: ${e?.message || e}`);
    if (jsonOnly) process.stdout.write(JSON.stringify({ event: 'manifest', manifest }) + '\n');
    return 1;
  }
}

function printSummary(m: CancerTwinManifest): void {
  console.log(chalk.cyan('\n📋 x402 Provenance Ledger'));
  console.log(chalk.gray('━'.repeat(64)));
  console.log(`${chalk.cyan('Case:')} ${m.caseId}   ${chalk.cyan('Owner:')} ${m.owner.slice(0, 12)}…   ${chalk.cyan('Network:')} ${m.network}`);
  console.log(`${chalk.cyan('Total paid:')} ${m.payments.totalUsdc} seqUSDC across ${m.steps.length} agent(s)\n`);
  for (const s of m.steps) {
    const ok = s.status === 'done' || s.status === 'simulated' || s.status === 'submitted';
    console.log(`${ok ? chalk.green('✓') : chalk.yellow('•')} ${chalk.white.bold(s.agent)} ${chalk.gray('(' + s.serviceType + ')')} — ${s.priceUsdc} seqUSDC`);
    console.log(`   ${chalk.gray('settle:')} ${s.settlementTx.slice(0, 26)}…  ${chalk.gray('proof:')} ${s.proofTx ? s.proofTx.slice(0, 26) + '…' : '—'} ${chalk.gray('pid')} ${s.paymentId ?? '—'}`);
    console.log(`   ${chalk.gray('job:')} ${s.jobId ?? '—'} (${s.status})  ${chalk.gray('→')} ${s.outputBiocid}`);
  }
  console.log(chalk.cyan('\n🔗 BioAsset lineage'));
  console.log('   ' + m.lineage.map((l) => l.fileType.toUpperCase()).join(' → '));
  if (m.report.url) {
    console.log(chalk.cyan('\n🧬 Cancer Digital Twin: ') + chalk.white(m.report.url));
  }
  console.log(chalk.gray('\nAnchor: ') + (m.anchor.txHash ? m.anchor.txHash : chalk.yellow('simulated (dry-run)')) + chalk.gray(`  registry ${m.anchor.contract.slice(0, 12)}…`));
}
