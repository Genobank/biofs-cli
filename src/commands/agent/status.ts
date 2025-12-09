/**
 * biofs agent status
 *
 * Check status and health of registered agents
 */

import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { getAgentManager } from '../../lib/kite/agent';
import { Logger } from '../../lib/utils/logger';
import { KiteNetwork, KITE_NETWORKS } from '../../types/kite';

export interface AgentStatusOptions {
  did?: string;        // Specific agent DID
  network?: KiteNetwork;
  namespace?: string;
  json?: boolean;
}

export async function agentStatusCommand(options: AgentStatusOptions = {}): Promise<void> {
  const spinner = ora('Checking agent status...').start();

  try {
    const network = options.network || 'kite-testnet';
    const namespace = options.namespace || 'genobank.eth';
    const manager = getAgentManager(network, namespace);

    const agents = await manager.listAgents();

    if (agents.length === 0) {
      spinner.stop();
      console.log(chalk.yellow('\nNo agents registered.'));
      console.log('Run "biofs agent register --all" to register BioFS agents.\n');
      return;
    }

    // Filter to specific agent if DID provided
    const targetAgents = options.did
      ? agents.filter(a => a.passport.did === options.did || a.passport.name === options.did)
      : agents;

    if (targetAgents.length === 0) {
      spinner.stop();
      console.log(chalk.yellow(`\nAgent not found: ${options.did}\n`));
      return;
    }

    // Check health for each agent
    const healthResults: Array<{
      agent: typeof agents[0];
      health: { online: boolean; responseTime?: number; error?: string };
      slaCompliance: { compliant: boolean; violations: string[] };
    }> = [];

    for (const agent of targetAgents) {
      spinner.text = `Checking ${agent.passport.name}...`;
      const health = await manager.checkAgentHealth(agent.passport.did);
      const slaCompliance = manager.checkSLACompliance(agent, health.responseTime || 0);
      healthResults.push({ agent, health, slaCompliance });
    }

    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify({
        network,
        networkConfig: KITE_NETWORKS[network],
        agents: healthResults.map(r => ({
          did: r.agent.passport.did,
          name: r.agent.passport.name,
          status: r.agent.status,
          online: r.health.online,
          responseTime: r.health.responseTime,
          error: r.health.error,
          slaCompliant: r.slaCompliance.compliant,
          violations: r.slaCompliance.violations,
          reputation: r.agent.reputation,
          sla: r.agent.sla
        }))
      }, null, 2));
      return;
    }

    console.log(chalk.green('\n Agent Status Report'));
    console.log(chalk.gray('━'.repeat(70)));
    console.log(`${chalk.cyan('Network:')}     ${KITE_NETWORKS[network].chainName}`);
    console.log(`${chalk.cyan('Chain ID:')}    ${KITE_NETWORKS[network].chainId}`);
    console.log(`${chalk.cyan('RPC URL:')}     ${KITE_NETWORKS[network].rpcUrl}`);
    console.log(`${chalk.cyan('Explorer:')}    ${KITE_NETWORKS[network].explorerUrl}`);
    console.log('');

    const table = new Table({
      head: [
        chalk.cyan('Agent'),
        chalk.cyan('Online'),
        chalk.cyan('Response'),
        chalk.cyan('SLA'),
        chalk.cyan('Rep'),
        chalk.cyan('Jobs'),
        chalk.cyan('Success')
      ],
      colWidths: [22, 10, 12, 10, 8, 10, 10],
      style: { head: [], border: [] }
    });

    for (const result of healthResults) {
      const { agent, health, slaCompliance } = result;

      const onlineStatus = health.online
        ? chalk.green('✓ Yes')
        : chalk.red('✗ No');

      const responseTime = health.responseTime
        ? `${health.responseTime}ms`
        : health.error || 'N/A';

      const slaStatus = slaCompliance.compliant
        ? chalk.green('✓ OK')
        : chalk.red('✗ Fail');

      const repColor = agent.reputation.score >= 700 ? chalk.green :
        agent.reputation.score >= 400 ? chalk.yellow : chalk.red;

      const successRate = agent.reputation.totalJobs > 0
        ? ((agent.reputation.successfulJobs / agent.reputation.totalJobs) * 100).toFixed(0) + '%'
        : 'N/A';

      table.push([
        agent.passport.name,
        onlineStatus,
        responseTime,
        slaStatus,
        repColor(agent.reputation.score.toString()),
        agent.reputation.totalJobs.toString(),
        successRate
      ]);
    }

    console.log(table.toString());

    // Show detailed info for each agent
    for (const result of healthResults) {
      const { agent, health, slaCompliance } = result;

      console.log(chalk.yellow(`\n${agent.passport.name}`));
      console.log(chalk.gray('─'.repeat(50)));

      console.log(`${chalk.gray('DID:')}          ${agent.passport.did}`);
      console.log(`${chalk.gray('Wallet:')}       ${agent.passport.walletAddress}`);
      console.log(`${chalk.gray('Endpoint:')}     ${agent.endpoint}`);
      console.log(`${chalk.gray('Type:')}         ${agent.serviceType}`);
      console.log(`${chalk.gray('Price:')}        ${agent.pricing.basePrice}`);

      console.log(chalk.gray('\nSLA Guarantees:'));
      console.log(`  Response Time: ${agent.sla.responseTime}ms`);
      console.log(`  Availability:  ${(agent.sla.availability * 100).toFixed(1)}%`);
      console.log(`  Accuracy:      ${(agent.sla.accuracy * 100).toFixed(1)}%`);
      console.log(`  Throughput:    ${agent.sla.throughput} req/hr`);

      if (!slaCompliance.compliant && slaCompliance.violations.length > 0) {
        console.log(chalk.red('\nSLA Violations:'));
        for (const violation of slaCompliance.violations) {
          console.log(chalk.red(`  ✗ ${violation}`));
        }
      }

      console.log(chalk.gray('\nCapabilities:'));
      console.log(`  ${agent.passport.capabilities.join(', ')}`);
    }

    console.log(chalk.gray('\n--- Commands ---'));
    console.log('Check specific agent:  biofs agent status --did <agent-name>');
    console.log('Update status:         biofs agent update <did> --status active');
    console.log('View on explorer:      ' + chalk.gray(KITE_NETWORKS[network].explorerUrl));
    console.log('');

  } catch (error: any) {
    spinner.fail(chalk.red('Status check failed'));
    Logger.error(`Error: ${error.message}`);
    throw error;
  }
}


