/**
 * biofs agent register-sequentia
 *
 * Register the Cancer Digital Twin agents on the Sequentia BioAgentRegistry
 * (ERC-8004 Identity + Reputation Registry, 0x24e634…). This is the proper verb
 * replacement for the missing scripts/register-clara-agent.cjs that biofs-node
 * expects at startup.
 *
 *   biofs agent register-sequentia --all          register clara + opencravat + genoclaw
 *   biofs agent register-sequentia --agent clara   register a single canonical agent
 *   biofs agent register-sequentia --name x --uri … --formats vcf,sqlite   ad-hoc agent
 *
 * Each agent registers with ITS OWN wallet (register() is msg.sender-bound). The
 * canonical agents use deterministic wallets derived from BIOFS_AGENT_SEED (or a
 * per-agent *_AGENT_PRIVATE_KEY override). Registration is idempotent — an agent
 * already on-chain is reported and skipped, never re-submitted.
 *
 * --dry-run shows exactly which wallets would be registered with which URIs and
 * formats, without touching the chain (no key/gas required).
 */

import chalk from 'chalk';
import ora from 'ora';
import { BioAgentRegistry, BIOAGENT_REGISTRY_ADDRESS } from '../../lib/sequentia/BioAgentRegistry';
import {
  CANCER_TWIN_AGENTS,
  getCancerTwinAgent,
  agentPrivateKey,
  agentAddress,
  CancerTwinAgentKey,
} from '../../lib/x402/cancer-twin-agents';
import { SEQUENTIA_NETWORK } from '../../lib/config/constants';
import { Logger } from '../../lib/utils/logger';

export interface AgentRegisterSequentiaOptions {
  all?: boolean;
  agent?: string;       // single canonical agent key
  name?: string;        // ad-hoc agent name
  uri?: string;         // ad-hoc agentURI
  formats?: string;     // ad-hoc comma list
  privateKey?: string;  // ad-hoc agent key
  noX402?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

interface RegOutcome {
  key: string;
  name: string;
  wallet: string;
  agentURI: string;
  supportedFormats: string[];
  x402Enabled: boolean;
  agentId: number | null;
  alreadyRegistered: boolean;
  txHash: string | null;
  error?: string;
}

async function registerOne(
  def: { key: string; name: string; agentURI: string; supportedFormats: string[] },
  privateKey: string,
  x402Enabled: boolean,
  dryRun: boolean,
): Promise<RegOutcome> {
  const wallet = agentAddressFromKey(privateKey);
  const base: RegOutcome = {
    key: def.key,
    name: def.name,
    wallet,
    agentURI: def.agentURI,
    supportedFormats: def.supportedFormats,
    x402Enabled,
    agentId: null,
    alreadyRegistered: false,
    txHash: null,
  };
  if (dryRun) return base;
  try {
    const reg = new BioAgentRegistry(privateKey);
    const r = await reg.register(def.agentURI, def.supportedFormats, x402Enabled);
    return { ...base, agentId: r.agentId, alreadyRegistered: r.alreadyRegistered, txHash: r.txHash };
  } catch (e: any) {
    return { ...base, error: e?.message || String(e) };
  }
}

function agentAddressFromKey(privateKey: string): string {
  // lazy import to avoid pulling ethers at module top in dry-run-only paths
  const { ethers } = require('ethers');
  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  return new ethers.Wallet(pk).address;
}

export async function agentRegisterSequentiaCommand(
  options: AgentRegisterSequentiaOptions = {},
): Promise<void> {
  const dryRun = !!options.dryRun;
  const x402Enabled = !options.noX402;

  // Build the work list.
  const jobs: Array<{ def: { key: string; name: string; agentURI: string; supportedFormats: string[] }; privateKey: string }> = [];

  if (options.name) {
    // ad-hoc single agent
    if (!options.uri) throw new Error('--name requires --uri (agentURI)');
    const pk = options.privateKey || agentPrivateKey('clara'); // ad-hoc still needs a key
    if (!options.privateKey) {
      Logger.warn('no --private-key for ad-hoc agent; using derived key (set --private-key for a real wallet)');
    }
    jobs.push({
      def: {
        key: options.name,
        name: options.name,
        agentURI: options.uri,
        supportedFormats: (options.formats || 'vcf').split(',').map((s) => s.trim()).filter(Boolean),
      },
      privateKey: pk,
    });
  } else {
    const keys: CancerTwinAgentKey[] = options.all
      ? CANCER_TWIN_AGENTS.map((a) => a.key)
      : [getCancerTwinAgent(options.agent || 'clara').key];
    for (const k of keys) {
      const a = getCancerTwinAgent(k);
      jobs.push({
        def: { key: a.key, name: a.name, agentURI: a.agentURI, supportedFormats: a.supportedFormats },
        privateKey: agentPrivateKey(k),
      });
    }
  }

  const spinner = options.json ? null
    : ora(`${dryRun ? 'Planning' : 'Registering'} ${jobs.length} agent(s) on BioAgentRegistry ${BIOAGENT_REGISTRY_ADDRESS.slice(0, 10)}…`).start();

  const outcomes: RegOutcome[] = [];
  for (const j of jobs) {
    if (spinner) spinner.text = `${dryRun ? 'plan' : 'register'} ${j.def.name} (${agentAddressFromKey(j.privateKey).slice(0, 10)}…)`;
    outcomes.push(await registerOne(j.def, j.privateKey, x402Enabled, dryRun));
  }
  spinner?.stop();

  if (options.json) {
    console.log(JSON.stringify({
      registry: BIOAGENT_REGISTRY_ADDRESS,
      network: SEQUENTIA_NETWORK.name,
      chainId: SEQUENTIA_NETWORK.chainId,
      dryRun,
      agents: outcomes,
    }, null, 2));
    return;
  }

  console.log(chalk.cyan('\n🤖 ERC-8004 Agent Registration — Sequentia BioAgentRegistry'));
  console.log(chalk.gray('━'.repeat(64)));
  console.log(`${chalk.cyan('Registry:')} ${BIOAGENT_REGISTRY_ADDRESS}`);
  console.log(`${chalk.cyan('Network:')}  ${SEQUENTIA_NETWORK.name} (chain ${SEQUENTIA_NETWORK.chainId})`);
  if (dryRun) console.log(chalk.yellow('Mode:     DRY-RUN (no chain writes)'));
  console.log('');

  for (const o of outcomes) {
    const status = o.error
      ? chalk.red(`✗ ${o.error}`)
      : dryRun
        ? chalk.yellow('… would register')
        : o.alreadyRegistered
          ? chalk.gray(`✓ already #${o.agentId}`)
          : chalk.green(`✓ registered #${o.agentId}`);
    console.log(chalk.white.bold(o.name) + '  ' + status);
    console.log(`  ${chalk.gray('wallet:')}  ${o.wallet}`);
    console.log(`  ${chalk.gray('uri:')}     ${o.agentURI}`);
    console.log(`  ${chalk.gray('formats:')} ${o.supportedFormats.join(', ')}  ${chalk.gray('x402:')} ${o.x402Enabled}`);
    if (o.txHash) console.log(`  ${chalk.gray('tx:')}      ${o.txHash}`);
    console.log('');
  }

  if (dryRun) {
    console.log(chalk.gray('Run without --dry-run to broadcast. Each agent wallet needs Sequentia gas;'));
    console.log(chalk.gray('fund the addresses above, or set CLARA/OPENCRAVAT/GENOCLAW_AGENT_PRIVATE_KEY.'));
  }
}
