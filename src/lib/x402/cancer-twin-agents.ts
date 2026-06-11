/**
 * Cancer Digital Twin — canonical x402 agent registry (single source of truth)
 *
 * The three ERC-8004 agents that turn a biosample into a Cancer Digital Twin,
 * mirroring the x402 BioData Router whitepaper's 5-step pipeline collapsed to the
 * three compute agents the patient actually pays:
 *
 *   Agent 1  clara-parabricks     FASTQ → BAM + VCF      (NVIDIA Clara Parabricks GPU)
 *   Agent 2  opencravat-annotator VCF  → annotated SQLite (146 OpenCRAVAT annotators)
 *   Agent 3  genoclaw-interpreter SQLite + context → Cancer Digital Twin report
 *
 * Every verb that touches the pipeline (agent register-sequentia, x402 submit,
 * x402 pipeline cancer-twin) imports these definitions so prices, endpoints,
 * service types and agent wallets never drift.
 *
 * Agent wallets are derived deterministically from BIOFS_AGENT_SEED so the same
 * three addresses are produced on every machine without storing three private
 * keys. The ERC-8004 registry enforces one-agent-per-wallet, so each agent MUST
 * have a distinct wallet — deterministic derivation gives exactly that.
 */

import { ethers } from 'ethers';

export type CancerTwinAgentKey = 'clara' | 'opencravat' | 'genoclaw';

export interface CancerTwinAgent {
  /** stable short key used on the CLI: --agent clara|opencravat|genoclaw */
  key: CancerTwinAgentKey;
  /** ERC-8004 agent name */
  name: string;
  /** ERC-8004 service classification */
  serviceType: string;
  /** pipeline step (2 = variant calling, 3 = annotation, 4 = interpretation) */
  step: number;
  /** seqUSDC price the patient pays this agent (whole USDC) */
  priceUsdc: number;
  /** file formats the agent advertises on the registry */
  supportedFormats: string[];
  /** BioRouter FileType this agent consumes */
  inputFileType: 'fastq' | 'vcf' | 'sqlite';
  /** BioRouter FileType this agent produces */
  outputFileType: 'vcf' | 'sqlite' | 'report';
  /** ERC-8004 agent registration file (agentURI) */
  agentURI: string;
  /** biofs-node endpoint path this agent's job is submitted to */
  endpointPath: string;
  description: string;
}

// Public registration files. These are static ERC-8004 registration JSONs served
// by GenoBank; the on-chain record stores the URI, not the file.
const REG_BASE = process.env.BIOFS_AGENT_REG_BASE
  || 'https://genobank.io/agents';

export const CANCER_TWIN_AGENTS: CancerTwinAgent[] = [
  {
    key: 'clara',
    name: 'clara-parabricks',
    serviceType: 'variant-calling',
    step: 2,
    priceUsdc: 10,
    supportedFormats: ['fastq', 'bam', 'vcf'],
    inputFileType: 'fastq',
    outputFileType: 'vcf',
    agentURI: `${REG_BASE}/clara-parabricks/registration.json`,
    endpointPath: '/submit-clara',
    description: 'NVIDIA Clara Parabricks GPU germline/somatic variant calling (FASTQ→BAM→VCF)',
  },
  {
    key: 'opencravat',
    name: 'opencravat-annotator',
    serviceType: 'variant-annotation',
    step: 3,
    priceUsdc: 4,
    supportedFormats: ['vcf', 'sqlite'],
    inputFileType: 'vcf',
    outputFileType: 'sqlite',
    agentURI: `${REG_BASE}/opencravat-annotator/registration.json`,
    endpointPath: '/submit_cravat',
    description: 'OpenCRAVAT annotation across 146 annotators (VCF→annotated SQLite)',
  },
  {
    key: 'genoclaw',
    name: 'genoclaw-interpreter',
    serviceType: 'clinical-interpretation',
    step: 4,
    priceUsdc: 135,
    supportedFormats: ['sqlite', 'fhir', 'report'],
    inputFileType: 'sqlite',
    outputFileType: 'report',
    agentURI: `${REG_BASE}/genoclaw-interpreter/registration.json`,
    endpointPath: '/interpret',
    description: 'GenoClaw clinical interpreter — Cancer Digital Twin report from annotated context',
  },
];

export function getCancerTwinAgent(key: string): CancerTwinAgent {
  const a = CANCER_TWIN_AGENTS.find((x) => x.key === key || x.name === key);
  if (!a) {
    const known = CANCER_TWIN_AGENTS.map((x) => x.key).join(', ');
    throw new Error(`unknown cancer-twin agent "${key}" (known: ${known})`);
  }
  return a;
}

/** Total seqUSDC cost of the full pipeline (all three agents). */
export function totalPipelineCostUsdc(): number {
  return CANCER_TWIN_AGENTS.reduce((s, a) => s + a.priceUsdc, 0);
}

/**
 * Deterministic agent wallet derived from BIOFS_AGENT_SEED. The same seed yields
 * the same three distinct addresses everywhere; each agent registers itself with
 * its own key (the ERC-8004 register() is msg.sender-bound).
 *
 * Override an individual agent's key with CLARA_AGENT_PRIVATE_KEY /
 * OPENCRAVAT_AGENT_PRIVATE_KEY / GENOCLAW_AGENT_PRIVATE_KEY when a real funded
 * wallet should be used instead of the derived one.
 */
export function agentPrivateKey(key: CancerTwinAgentKey): string {
  const envName = `${key.toUpperCase()}_AGENT_PRIVATE_KEY`;
  const override = process.env[envName];
  if (override) return override.startsWith('0x') ? override : `0x${override}`;
  const seed = process.env.BIOFS_AGENT_SEED
    || 'genobank.io/cancer-digital-twin/x402-agents/v1';
  return ethers.keccak256(ethers.toUtf8Bytes(`${seed}:agent:${key}`));
}

/** Deterministic agent wallet address (no RPC needed). */
export function agentAddress(key: CancerTwinAgentKey): string {
  return new ethers.Wallet(agentPrivateKey(key)).address;
}

/** Full agent + resolved wallet (address only; key derivable on demand). */
export function resolveAgent(key: string): CancerTwinAgent & { wallet: string } {
  const a = getCancerTwinAgent(key);
  return { ...a, wallet: agentAddress(a.key) };
}
