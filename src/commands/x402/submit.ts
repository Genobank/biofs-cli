/**
 * biofs x402 submit --agent <name> --biosample <serial>
 *
 * The x402 payment-gated single-agent job submission. One HTTP-native paid call,
 * faithful to the x402 BioData Router whitepaper:
 *
 *   1. resolve the agent from the Sequentia BioAgentRegistry (ERC-8004)
 *   2. settle the agent's price in seqUSDC   (patient → agent, on Sequentia)
 *   3. the agent records the payment proof    (submitPaymentProof on the registry)
 *   4. dispatch the job to the agent's biofs-node endpoint with an X-PAYMENT header
 *
 * Each step is on-chain traceable: the seqUSDC settlement tx, the ERC-8004
 * payment-proof tx, and the biofs-node job id. --dry-run simulates the whole
 * flow deterministically (no key, gas, or live node required).
 *
 * Returned object is consumed by `biofs x402 pipeline cancer-twin`.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { SEQUENTIA_NETWORK } from '../../lib/config/constants';
import { BioAgentRegistry } from '../../lib/sequentia/BioAgentRegistry';
import {
  resolveAgent, agentPrivateKey, CancerTwinAgent,
} from '../../lib/x402/cancer-twin-agents';
import {
  payAgentDirect, patientKeyFromEnv, usdcToUnits, PayRecipient,
} from '../../lib/x402/sequentia-pay';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface X402SubmitOptions {
  agent?: string;
  biosample?: string;
  amount?: string;       // override price (USDC)
  inputBiocid?: string;  // explicit asset id source
  package?: string;      // forwarded to opencravat/genoclaw
  // commander maps `--no-dispatch` to `dispatch=false`; `noDispatch` kept for
  // programmatic callers. Either being false/true(respectively) skips dispatch.
  dispatch?: boolean;
  noDispatch?: boolean;  // settle + proof only, skip the job call
  native?: boolean;      // settle in native Sequentia token instead of seqUSDC
  mode?: string;         // clara sequencing type: WES | WGS (selects WES model + capture interval)
  captureKit?: string;   // clara WES capture kit, e.g. agilent_v8 (resolves the interval BED)
  bamUri?: string;       // clara BAM-input: aligned BAM gs:// uri → pbrun deepvariant --in-bam
  r1Uri?: string;        // clara FASTQ-input: explicit R1 gs:// uri (e.g. --caller fusion / rna FASTQ)
  r2Uri?: string;        // clara FASTQ-input: explicit R2 gs:// uri
  vcfUri?: string;       // opencravat: explicit VCF gs:// uri to annotate (skips inventory resolution)
  sqliteUri?: string;    // clara --caller biomarkers: annotated sqlite gs:// uri (TMB nonsyn count)
  panelMb?: string;      // clara --caller biomarkers: panel size in Mb (TMB denominator)
  originlab?: string;    // opencravat: lab hint for sqlite path allocation (e.g. caris)
  caller?: string;       // clara caller: deepvariant (germline, default) | mutect (somatic tumor-only)
  somatic?: boolean;     // shorthand: --somatic ⇒ caller=mutect
  skipPay?: boolean;     // dispatch the job through biofs-node WITHOUT settling x402 (processing runs; /agent/job is unpaid)
  sources?: any[];       // genoclaw multi-source twin: [{sqlite_gs_uri, source_biocid, label, lab}]
  expression?: any;      // genoclaw RNA expression layer: {gs_uri, kind, label, lab}
  fusions?: any;         // genoclaw gene-fusions layer: {gs_uri (STAR-Fusion tsv), label, lab}
  dryRun?: boolean;
  json?: boolean;
  quiet?: boolean;
}

export interface X402SubmitResult {
  agent: string;
  biosample: string;
  assetId: string;
  priceUsdc: number;
  settlement: { txHash: string; payer: string; token: string; simulated: boolean };
  proof: { paymentId: number | null; txHash: string | null; agentId: number | null; simulated: boolean };
  paymentHeader: string;          // base64 X-PAYMENT
  dispatch: { endpoint: string; jobId: string | null; status: string; simulated: boolean } | null;
}

/** Public asset id tying the payment to this biosample + pipeline stage. */
function assetIdFor(agent: CancerTwinAgent, biosample: string, inputBiocid?: string): { biocid: string; assetId: string } {
  const biocid = inputBiocid || `biocid://x402/${agent.inputFileType}/${biosample}`;
  return { biocid, assetId: BioAgentRegistry.assetIdForBiocid(biocid) };
}

/** Build the base64 X-PAYMENT header the agent endpoint validates. */
function buildPaymentHeader(args: {
  agent: CancerTwinAgent; agentWallet: string; payer: string; assetId: string;
  settlementTx: string; proofTx: string | null; paymentId: number | null; agentId: number | null;
  amountUsdc: number;
}): string {
  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: 'sequentia',
    chainId: SEQUENTIA_NETWORK.chainId,
    asset: args.assetId,
    payTo: args.agentWallet,
    payer: args.payer,
    maxAmountRequired: usdcToUnits(args.amountUsdc).toString(),
    payload: {
      settlementTxHash: args.settlementTx,
      proofTxHash: args.proofTx,
      paymentId: args.paymentId,
      agentId: args.agentId,
      service: args.agent.serviceType,
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/** Per-agent dispatch: maps the canonical agent to its biofs-node job endpoint. */
async function dispatchJob(
  agent: CancerTwinAgent,
  biosample: string,
  wallet: string,
  signature: string,
  paymentHeader: string,
  opts: { package?: string; dryRun: boolean; mode?: string; captureKit?: string; bamUri?: string; r1Uri?: string; r2Uri?: string; vcfUri?: string; sqliteUri?: string; panelMb?: string; originlab?: string; caller?: string; sources?: any[]; expression?: any; fusions?: any },
): Promise<{ endpoint: string; jobId: string | null; status: string; simulated: boolean }> {
  // BIOFS_NODE_BASE maps to biofs-node /agent/* via nginx (/api_biofs_node/X → /agent/X).
  const routeFor: Record<string, { path: string; body: () => Record<string, unknown>; jobIdField: string }> = {
    clara: {
      path: '/job',
      // inputType:'fastq' tells the front biofs-node to forward this to a GPU
      // executor (discoverGpuExecutor) for Clara Parabricks variant calling.
      // sequencingType/captureKit select the runner's WES recipe (WES model +
      // capture interval) for exome samples; default WGS when --mode is omitted.
      body: () => ({
        biosampleId: biosample, creatorWallet: wallet, creatorSig: signature,
        // bamUri → the runner runs pbrun deepvariant --in-bam on the aligned BAM
        // (skip fq2bam); else FASTQ→VCF. inputType drives the front's GPU forward.
        inputType: opts.bamUri ? 'bam' : 'fastq',
        ...(opts.bamUri ? { bamUri: opts.bamUri } : {}),
        ...(opts.r1Uri ? { r1Uri: opts.r1Uri } : {}),
        ...(opts.r2Uri ? { r2Uri: opts.r2Uri } : {}),
        ...(opts.vcfUri ? { vcfUri: opts.vcfUri } : {}),
        ...(opts.sqliteUri ? { sqliteUri: opts.sqliteUri } : {}),
        ...(opts.panelMb ? { panelMb: opts.panelMb } : {}),
        ...(opts.caller ? { caller: opts.caller } : {}),
        ...(opts.mode ? { sequencingType: String(opts.mode).toUpperCase() } : {}),
        ...(opts.captureKit ? { captureKit: opts.captureKit } : {}),
      }),
      jobIdField: 'jobId',
    },
    opencravat: {
      path: '/submit_cravat',
      // vcf_gs_uri (when provided) annotates that VCF directly, skipping inventory
      // resolution; originlab hints the sqlite-path bucket allocation.
      body: () => ({ biosample_serial: biosample, wallet, signature, package: opts.package || 'wes_default',
        ...(opts.vcfUri ? { vcf_gs_uri: opts.vcfUri } : {}),
        ...(opts.originlab ? { originlab: opts.originlab } : {}) }),
      jobIdField: 'oc_job_id',
    },
    genoclaw: {
      path: '/interpret',
      // sources (when present) makes this a MULTI-SOURCE twin: biofs-node forwards
      // the list to genoclaw /interpret, which accumulates every annotated sqlite
      // into the patient's fhir.variant before synthesizing the aggregated report.
      body: () => ({ biosample_serial: biosample, wallet, signature, package: opts.package || 'cancer_twin',
        ...(opts.sources && opts.sources.length ? { sources: opts.sources } : {}),
        ...(opts.expression ? { expression: opts.expression } : {}),
        ...(opts.fusions ? { fusions: opts.fusions } : {}) }),
      jobIdField: 'interpret_job_id',
    },
  };
  const route = routeFor[agent.key];
  const endpoint = `${BIOFS_NODE_BASE}${route.path}`;
  if (opts.dryRun) {
    return { endpoint, jobId: `${agent.key}-dryrun-${biosample}`, status: 'simulated', simulated: true };
  }
  const resp = await axios.post(endpoint, route.body(), {
    timeout: 60_000,
    headers: { 'X-PAYMENT': paymentHeader, 'Content-Type': 'application/json' },
    validateStatus: (s) => s < 500,
  });
  if (resp.status >= 400) {
    return { endpoint, jobId: null, status: `error_${resp.status}: ${resp.data?.error || 'unknown'}`, simulated: false };
  }
  return {
    endpoint,
    jobId: resp.data?.[route.jobIdField] || resp.data?.jobId || null,
    status: resp.data?.status || 'accepted',
    simulated: false,
  };
}

export async function x402SubmitCommand(options: X402SubmitOptions = {}): Promise<X402SubmitResult | null> {
  if (!options.agent) throw new Error('--agent required (clara | opencravat | genoclaw)');
  if (!options.biosample) throw new Error('--biosample required');
  if (options.somatic && !options.caller) options.caller = 'mutect';
  const dryRun = !!options.dryRun;
  const skipPay = !!options.skipPay;  // dispatch live, skip x402 settlement (unpaid /agent/job)
  const agent = resolveAgent(options.agent);
  const priceUsdc = options.amount ? parseFloat(options.amount) : agent.priceUsdc;
  const { biocid, assetId } = assetIdFor(agent, options.biosample, options.inputBiocid);

  const credentials = await getCredentials();
  const wallet = credentials?.wallet_address || '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
  const signature = credentials?.user_signature || 'dry-run-no-signature';

  const spinner = options.json || options.quiet ? null
    : ora(`x402 ${agent.name} — ${priceUsdc} seqUSDC for ${options.biosample}`).start();

  // 1. Settle payment: patient → agent. (--skip-pay dispatches without settling:
  // the front /agent/job path is unpaid, so processing runs don't need a patient
  // key or to spend seqUSDC; the job still flows verb → biofs-node → executor.)
  const recipient: PayRecipient = { recipient: agent.wallet, amountUsdc: priceUsdc, description: `${agent.name} (${agent.serviceType})` };
  let settlement;
  if (skipPay) {
    settlement = { txHash: '0x' + 'ee'.repeat(32), payer: wallet, token: options.native ? 'native' : 'seqUSDC', simulated: true };
    if (spinner) spinner.text = `dispatch-only (x402 settlement skipped) → ${agent.wallet.slice(0, 10)}…`;
  } else {
    const patientKey = patientKeyFromEnv();
    if (spinner) spinner.text = `settling ${priceUsdc} ${options.native ? 'native' : 'seqUSDC'} → ${agent.wallet.slice(0, 10)}…`;
    settlement = await payAgentDirect(recipient, patientKey, dryRun, options.native);
  }

  // 2. Agent records the ERC-8004 payment proof (agent-keyed).
  let proof = { paymentId: null as number | null, txHash: null as string | null, agentId: null as number | null, simulated: true };
  if (!dryRun && !skipPay) {
    try {
      const agentKey = agentPrivateKey(agent.key);
      const reg = new BioAgentRegistry(agentKey);
      const agentId = await reg.agentIdOf(reg.walletAddress!);
      if (agentId > 0) {
        if (spinner) spinner.text = 'recording ERC-8004 payment proof…';
        // submitPaymentProof.usdcAmount is documented 6-decimal USDC (the
        // contract's convertUSDCtoBIOIP divides by 1e6), independent of the
        // 18-decimal seqUSDC settlement transfer amount.
        const proofUsdc6 = BigInt(Math.round(priceUsdc * 1e6));
        const pp = await reg.submitPaymentProof(assetId, settlement.txHash, SEQUENTIA_NETWORK.chainId, proofUsdc6);
        proof = { paymentId: pp.paymentId, txHash: pp.proofTxHash, agentId, simulated: false };
      } else {
        Logger.warn(`agent ${agent.name} not registered on BioAgentRegistry — run: biofs agent register-sequentia --all`);
        proof = { paymentId: null, txHash: null, agentId: 0, simulated: false };
      }
    } catch (e: any) {
      Logger.warn(`payment proof submission failed (continuing): ${e?.message || e}`);
    }
  } else {
    // simulated proof for dry-run
    proof = { paymentId: 1, txHash: BioAgentRegistry.assetIdForBiocid('proof:' + assetId), agentId: null, simulated: true };
  }

  // 3. Build X-PAYMENT and dispatch the job.
  const paymentHeader = buildPaymentHeader({
    agent, agentWallet: agent.wallet, payer: settlement.payer, assetId,
    settlementTx: settlement.txHash, proofTx: proof.txHash, paymentId: proof.paymentId, agentId: proof.agentId,
    amountUsdc: priceUsdc,
  });

  let dispatch = null as X402SubmitResult['dispatch'];
  const skipDispatch = options.noDispatch === true || options.dispatch === false;
  if (!skipDispatch) {
    if (spinner) spinner.text = `dispatching to ${agent.name}…`;
    dispatch = await dispatchJob(agent, options.biosample, wallet, signature, paymentHeader, { package: options.package, dryRun, mode: options.mode, captureKit: options.captureKit, bamUri: options.bamUri, r1Uri: options.r1Uri, r2Uri: options.r2Uri, vcfUri: options.vcfUri, sqliteUri: options.sqliteUri, panelMb: options.panelMb, originlab: options.originlab, caller: options.caller, sources: options.sources, expression: options.expression, fusions: options.fusions });
  }

  spinner?.succeed(`x402 ${agent.name}: paid ${priceUsdc} seqUSDC${dispatch?.jobId ? `, job ${dispatch.jobId}` : ''}${dryRun ? ' (dry-run)' : ''}`);

  const result: X402SubmitResult = {
    agent: agent.name,
    biosample: options.biosample,
    assetId,
    priceUsdc,
    settlement: { txHash: settlement.txHash, payer: settlement.payer, token: settlement.token, simulated: settlement.simulated },
    proof,
    paymentHeader,
    dispatch,
  };

  if (options.json) {
    console.log(JSON.stringify({ ...result, biocid }, null, 2));
  } else if (!options.quiet) {
    console.log(chalk.gray(`  settlement: ${settlement.txHash.slice(0, 22)}…  payer ${settlement.payer.slice(0, 10)}…`));
    console.log(chalk.gray(`  proof:      ${proof.txHash ? proof.txHash.slice(0, 22) + '…' : '(skipped)'}  paymentId ${proof.paymentId ?? '—'}`));
    if (dispatch) console.log(chalk.gray(`  dispatch:   ${dispatch.endpoint}  job ${dispatch.jobId ?? '—'} (${dispatch.status})`));
  }
  return result;
}
