/**
 * biofs agent register
 *
 * Register a new agent on Kite network
 */

import chalk from 'chalk';
import ora from 'ora';
import { getAgentManager } from '../../lib/kite/agent';
import { Logger } from '../../lib/utils/logger';
import { KiteNetwork, AgentServiceType, KITE_NETWORKS } from '../../types/kite';
import { getCredentials } from '../../lib/auth/credentials';

export interface AgentRegisterOptions {
  name?: string;
  type?: AgentServiceType;
  endpoint?: string;
  price?: string;
  network?: KiteNetwork;
  namespace?: string;
  all?: boolean;  // Register all BioFS agents
  json?: boolean;
}

export async function agentRegisterCommand(options: AgentRegisterOptions = {}): Promise<void> {
  const spinner = ora('Registering agent on Kite...').start();

  try {
    // Check credentials
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const network = options.network || 'kite-testnet';
    const namespace = options.namespace || 'genobank.eth';
    const manager = getAgentManager(network, namespace);

    // Register all BioFS agents if --all flag
    if (options.all) {
      spinner.text = 'Registering all BioFS agents...';
      const agents = await manager.registerBioFSAgents();

      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify({
          success: true,
          network,
          namespace,
          agents: agents.map(a => ({
            did: a.passport.did,
            name: a.passport.name,
            type: a.serviceType,
            wallet: a.passport.walletAddress,
            endpoint: a.endpoint,
            pricing: a.pricing,
            status: a.status
          }))
        }, null, 2));
        return;
      }

      console.log(chalk.green('\n✓ BioFS Agents Registered on Kite'));
      console.log(chalk.gray('━'.repeat(60)));
      console.log(`${chalk.cyan('Network:')}     ${network}`);
      console.log(`${chalk.cyan('Namespace:')}   ${namespace}`);
      console.log('');

      for (const agent of agents) {
        console.log(chalk.yellow(`\n${agent.passport.name}`));
        console.log(`  ${chalk.gray('DID:')}      ${agent.passport.did}`);
        console.log(`  ${chalk.gray('Wallet:')}   ${agent.passport.walletAddress}`);
        console.log(`  ${chalk.gray('Type:')}     ${agent.serviceType}`);
        console.log(`  ${chalk.gray('Endpoint:')} ${agent.endpoint}`);
        console.log(`  ${chalk.gray('Price:')}    ${agent.pricing.basePrice}`);
        console.log(`  ${chalk.gray('Status:')}   ${chalk.green(agent.status)}`);
      }

      console.log(chalk.gray('\n--- Next Steps ---'));
      console.log('1. View agents: biofs agent list');
      console.log('2. Check health: biofs agent status');
      console.log('3. Start services: biofs agent start');
      console.log('');

      return;
    }

    // Register single agent
    if (!options.name || !options.type || !options.endpoint) {
      throw new Error('Please provide --name, --type, and --endpoint, or use --all to register all BioFS agents');
    }

    spinner.text = `Registering ${options.name}...`;

    const agent = await manager.registerAgent(
      options.name,
      options.type,
      options.endpoint,
      {
        pricing: options.price ? { basePrice: options.price } : undefined
      }
    );

    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify({
        success: true,
        network,
        namespace,
        agent: {
          did: agent.passport.did,
          name: agent.passport.name,
          type: agent.serviceType,
          wallet: agent.passport.walletAddress,
          endpoint: agent.endpoint,
          pricing: agent.pricing,
          sla: agent.sla,
          status: agent.status
        }
      }, null, 2));
      return;
    }

    console.log(chalk.green('\n✓ Agent Registered on Kite'));
    console.log(chalk.gray('━'.repeat(50)));
    console.log(`${chalk.cyan('DID:')}        ${agent.passport.did}`);
    console.log(`${chalk.cyan('Name:')}       ${agent.passport.name}`);
    console.log(`${chalk.cyan('Type:')}       ${agent.serviceType}`);
    console.log(`${chalk.cyan('Wallet:')}     ${agent.passport.walletAddress}`);
    console.log(`${chalk.cyan('Endpoint:')}   ${agent.endpoint}`);
    console.log(`${chalk.cyan('Price:')}      ${agent.pricing.basePrice}`);
    console.log(`${chalk.cyan('Status:')}     ${chalk.green(agent.status)}`);

    console.log(chalk.gray('\n--- SLA Guarantees ---'));
    console.log(`Response Time: ${agent.sla.responseTime}ms`);
    console.log(`Availability:  ${(agent.sla.availability * 100).toFixed(1)}%`);
    console.log(`Accuracy:      ${(agent.sla.accuracy * 100).toFixed(1)}%`);
    console.log(`Throughput:    ${agent.sla.throughput} req/hr`);

    console.log('');

  } catch (error: any) {
    spinner.fail(chalk.red('Registration failed'));
    Logger.error(`Error: ${error.message}`);
    throw error;
  }
}
