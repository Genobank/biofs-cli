/**
 * biofs agent list-sequentia
 *
 * Query the on-chain ERC-8004 status of the Cancer Digital Twin agents (or any
 * wallet/agentId) from the Sequentia BioAgentRegistry. Read-only — no key needed.
 *
 *   biofs agent list-sequentia                 status of clara + opencravat + genoclaw
 *   biofs agent list-sequentia --wallet 0x…    status of an arbitrary wallet
 *   biofs agent list-sequentia --agent-id 3    status of an arbitrary agentId
 */

import chalk from 'chalk';
import ora from 'ora';
import { BioAgentRegistry, BIOAGENT_REGISTRY_ADDRESS, AgentRecord } from '../../lib/sequentia/BioAgentRegistry';
import { CANCER_TWIN_AGENTS, agentAddress } from '../../lib/x402/cancer-twin-agents';
import { SEQUENTIA_NETWORK } from '../../lib/config/constants';

export interface AgentListSequentiaOptions {
  wallet?: string;
  agentId?: string;
  json?: boolean;
}

interface Row {
  key?: string;
  name?: string;
  wallet: string;
  onChain: AgentRecord | null;
  error?: string;
}

export async function agentListSequentiaCommand(
  options: AgentListSequentiaOptions = {},
): Promise<void> {
  const reg = new BioAgentRegistry(); // read-only
  const spinner = options.json ? null : ora('Querying BioAgentRegistry…').start();
  const rows: Row[] = [];

  try {
    if (options.agentId) {
      const id = parseInt(options.agentId, 10);
      const rec = await reg.getAgent(id);
      rows.push({ wallet: rec?.agentWallet || '?', onChain: rec });
    } else if (options.wallet) {
      const rec = await reg.getAgentByWallet(options.wallet);
      rows.push({ wallet: options.wallet, onChain: rec });
    } else {
      for (const a of CANCER_TWIN_AGENTS) {
        const wallet = agentAddress(a.key);
        try {
          const rec = await reg.getAgentByWallet(wallet);
          rows.push({ key: a.key, name: a.name, wallet, onChain: rec });
        } catch (e: any) {
          rows.push({ key: a.key, name: a.name, wallet, onChain: null, error: e?.message });
        }
      }
    }
  } catch (e: any) {
    spinner?.fail(`registry query failed: ${e?.message || e}`);
    if (options.json) console.log(JSON.stringify({ error: e?.message || String(e) }, null, 2));
    return;
  }
  spinner?.stop();

  if (options.json) {
    console.log(JSON.stringify({
      registry: BIOAGENT_REGISTRY_ADDRESS,
      network: SEQUENTIA_NETWORK.name,
      chainId: SEQUENTIA_NETWORK.chainId,
      agents: rows,
    }, null, 2));
    return;
  }

  console.log(chalk.cyan('\n🤖 BioAgentRegistry — on-chain agent status'));
  console.log(chalk.gray('━'.repeat(64)));
  console.log(`${chalk.cyan('Registry:')} ${BIOAGENT_REGISTRY_ADDRESS}  ${chalk.gray('(' + SEQUENTIA_NETWORK.name + ')')}\n`);

  for (const r of rows) {
    const label = r.name ? chalk.white.bold(r.name) : chalk.white.bold(r.wallet.slice(0, 12) + '…');
    if (r.error) {
      console.log(label + '  ' + chalk.red('✗ ' + r.error));
    } else if (!r.onChain || r.onChain.agentId === 0) {
      console.log(label + '  ' + chalk.yellow('not registered'));
      console.log(`  ${chalk.gray('wallet:')} ${r.wallet}`);
    } else {
      const a = r.onChain;
      console.log(label + '  ' + (a.active ? chalk.green(`✓ agent #${a.agentId}`) : chalk.gray(`inactive #${a.agentId}`)));
      console.log(`  ${chalk.gray('wallet:')}     ${a.agentWallet}`);
      console.log(`  ${chalk.gray('uri:')}        ${a.agentURI}`);
      console.log(`  ${chalk.gray('x402:')}       ${a.x402Enabled}   ${chalk.gray('reputation:')} ${a.reputationScore}   ${chalk.gray('spent:')} ${a.totalSpent} BIOIP`);
    }
    console.log('');
  }
}
