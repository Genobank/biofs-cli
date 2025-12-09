/**
 * biofs agent list
 *
 * List registered agents on Kite network
 */

import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { getAgentManager } from '../../lib/kite/agent';
import { Logger } from '../../lib/utils/logger';
import { KiteNetwork, AgentServiceType } from '../../types/kite';

export interface AgentListOptions {
  network?: KiteNetwork;
  namespace?: string;
  type?: AgentServiceType;
  json?: boolean;
}

export async function agentListCommand(options: AgentListOptions = {}): Promise<void> {
  const spinner = ora('Loading agents...').start();

  try {
    const network = options.network || 'kite-testnet';
    const namespace = options.namespace || 'genobank.eth';
    const manager = getAgentManager(network, namespace);

    let agents = await manager.listAgents();

    // Filter by type if specified
    if (options.type) {
      agents = agents.filter(a => a.serviceType === options.type);
    }

    spinner.stop();

    if (agents.length === 0) {
      console.log(chalk.yellow('\nNo agents registered.'));
      console.log('Run "biofs agent register --all" to register BioFS agents.\n');
      return;
    }

    if (options.json) {
      console.log(JSON.stringify({
        network,
        namespace,
        count: agents.length,
        agents: agents.map(a => ({
          did: a.passport.did,
          name: a.passport.name,
          type: a.serviceType,
          wallet: a.passport.walletAddress,
          endpoint: a.endpoint,
          status: a.status,
          reputation: a.reputation,
          pricing: a.pricing
        }))
      }, null, 2));
      return;
    }

    console.log(chalk.green(`\n Registered Agents (${agents.length})`));
    console.log(chalk.gray('━'.repeat(100)));

    const table = new Table({
      head: [
        chalk.cyan('Name'),
        chalk.cyan('Type'),
        chalk.cyan('Status'),
        chalk.cyan('Rep'),
        chalk.cyan('Price'),
        chalk.cyan('Jobs'),
        chalk.cyan('Success Rate')
      ],
      colWidths: [25, 15, 10, 8, 10, 10, 15],
      style: { head: [], border: [] }
    });

    for (const agent of agents) {
      const successRate = agent.reputation.totalJobs > 0
        ? ((agent.reputation.successfulJobs / agent.reputation.totalJobs) * 100).toFixed(0) + '%'
        : 'N/A';

      const statusColor = agent.status === 'active' ? chalk.green :
        agent.status === 'inactive' ? chalk.yellow : chalk.red;

      const repColor = agent.reputation.score >= 700 ? chalk.green :
        agent.reputation.score >= 400 ? chalk.yellow : chalk.red;

      table.push([
        agent.passport.name,
        agent.serviceType,
        statusColor(agent.status),
        repColor(agent.reputation.score.toString()),
        agent.pricing.basePrice,
        agent.reputation.totalJobs.toString(),
        successRate
      ]);
    }

    console.log(table.toString());

    console.log(chalk.gray('\n--- Agent Details ---'));
    for (const agent of agents) {
      console.log(`\n${chalk.yellow(agent.passport.name)}`);
      console.log(`  ${chalk.gray('DID:')}      ${agent.passport.did}`);
      console.log(`  ${chalk.gray('Wallet:')}   ${agent.passport.walletAddress}`);
      console.log(`  ${chalk.gray('Endpoint:')} ${agent.endpoint}`);
    }

    console.log('');

  } catch (error: any) {
    spinner.fail(chalk.red('Failed to load agents'));
    Logger.error(`Error: ${error.message}`);
    throw error;
  }
}


