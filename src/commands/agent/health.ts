import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

export interface AgentHealthOptions {
  json?: boolean;
  verbose?: boolean;
}

export async function agentHealthCommand(options: AgentHealthOptions = {}): Promise<void> {
  const spinner = ora('Checking agent health...').start();

  try {
    // Load config to get BioFS-Node URL (check multiple locations)
    let config: any;
    const localConfigPath = path.join(process.cwd(), 'config.json');
    const homeConfigPath = path.join(process.env.HOME || '~', '.biofsrc');

    if (fs.existsSync(localConfigPath)) {
      config = JSON.parse(fs.readFileSync(localConfigPath, 'utf-8'));
    } else if (fs.existsSync(homeConfigPath)) {
      config = JSON.parse(fs.readFileSync(homeConfigPath, 'utf-8'));
    } else {
      throw new Error('Config not found. Create config.json or ~/.biofsrc with biofsNode.url');
    }

    const biofsNodeUrl = config.biofsNode?.url || process.env.BIOFS_NODE_URL;

    if (!biofsNodeUrl) {
      throw new Error('BioFS-Node URL not configured. Set biofsNode.url in config.json or BIOFS_NODE_URL in .env');
    }

    // Query health endpoint
    const response = await axios.get(`${biofsNodeUrl}/api/v1/clara/health`, {
      timeout: 10000
    });

    const health = response.data;

    if (options.json) {
      console.log(JSON.stringify(health, null, 2));
      return;
    }

    spinner.stop();

    // Display health status
    const statusColor = health.healthy ? chalk.green : chalk.red;
    const statusIcon = health.healthy ? '✅' : '❌';

    console.log();
    console.log(chalk.cyan('═'.repeat(70)));
    console.log(chalk.bold(`  ${statusIcon} GenoBank Processing Agent Health`));
    console.log(chalk.cyan('═'.repeat(70)));
    console.log();

    // Overall status
    console.log(chalk.bold('Status:'));
    console.log(`  ${chalk.gray('Service:')} ${statusColor(health.status.toUpperCase())}`);
    console.log(`  ${chalk.gray('Healthy:')} ${statusColor(health.healthy ? 'YES' : 'NO')}`);
    console.log(`  ${chalk.gray('Timestamp:')} ${health.timestamp}`);
    console.log();

    // Queue status
    console.log(chalk.bold('Job Queue:'));
    console.log(`  ${chalk.gray('Total Jobs:')} ${health.queue.total_jobs}`);
    console.log(`  ${chalk.cyan('Queued:')} ${health.queue.queued}`);
    console.log(`  ${chalk.yellow('Processing:')} ${health.queue.processing}`);
    console.log(`  ${chalk.green('Completed:')} ${health.queue.completed}`);
    console.log(`  ${chalk.red('Failed:')} ${health.queue.failed}`);

    if (health.queue.queued > 0) {
      console.log(`  ${chalk.gray('Estimated Wait:')} ${health.queue.estimated_wait_minutes} minutes`);
    }
    console.log();

    // GPU status
    const gpuStatusColor = health.gpu.available ? chalk.green : chalk.red;
    const gpuIcon = health.gpu.available ? '🟢' : '🔴';

    console.log(chalk.bold('GPU Status:'));
    console.log(`  ${chalk.gray('Status:')} ${gpuIcon} ${gpuStatusColor(health.gpu.status.toUpperCase())}`);
    console.log(`  ${chalk.gray('Memory Free:')} ${(health.gpu.memory_free_mb / 1024).toFixed(1)} GB`);
    console.log(`  ${chalk.gray('Memory Total:')} ${(health.gpu.memory_total_mb / 1024).toFixed(1)} GB`);
    console.log(`  ${chalk.gray('Memory Used:')} ${health.gpu.memory_used_percent}%`);
    console.log(`  ${chalk.gray('GPU Utilization:')} ${health.gpu.utilization_percent}%`);
    console.log();

    // Clara Parabricks status
    const claraStatusColor = health.clara.available ? chalk.green : chalk.red;
    const claraIcon = health.clara.available ? '✅' : '❌';

    console.log(chalk.bold('Clara Parabricks:'));
    console.log(`  ${chalk.gray('Available:')} ${claraIcon} ${claraStatusColor(health.clara.available ? 'YES' : 'NO')}`);
    console.log(`  ${chalk.gray('Version:')} ${health.clara.version}`);
    if (health.clara.docker_image) {
      console.log(`  ${chalk.gray('Docker Image:')} ${health.clara.docker_image}`);
    }
    console.log();

    // Security
    console.log(chalk.bold('Security:'));
    console.log(`  ${chalk.gray('BioNFT Validation:')} ${chalk.green(health.bionft_validation)}`);
    console.log(`  ${chalk.gray('Consent Required:')} ${chalk.green(health.consent_required ? 'YES' : 'NO')}`);
    console.log();

    if (options.verbose) {
      // Server info
      console.log(chalk.bold('Server Info:'));
      console.log(`  ${chalk.gray('Hostname:')} ${health.server.hostname}`);
      console.log(`  ${chalk.gray('Uptime:')} ${(health.server.uptime_seconds / 3600).toFixed(1)} hours`);
      console.log(`  ${chalk.gray('Node Version:')} ${health.server.node_version}`);
      console.log(`  ${chalk.gray('Platform:')} ${health.server.platform}`);
      console.log();
    }

    // Summary
    console.log(chalk.cyan('═'.repeat(70)));
    if (health.healthy) {
      console.log(chalk.green.bold('  ✅ Agent is healthy and ready to receive jobs'));
      if (health.queue.queued > 0) {
        console.log(chalk.yellow(`  ⏳ ${health.queue.queued} job(s) in queue - estimated wait: ${health.queue.estimated_wait_minutes} minutes`));
      }
    } else {
      console.log(chalk.red.bold('  ❌ Agent is not healthy - do not submit jobs'));
      if (!health.gpu.available) {
        console.log(chalk.red('  • GPU is unavailable'));
      }
      if (!health.clara.available) {
        console.log(chalk.red('  • Clara Parabricks is not available'));
      }
    }
    console.log(chalk.cyan('═'.repeat(70)));
    console.log();

  } catch (error: any) {
    spinner.fail(chalk.red('Failed to check agent health'));

    if (error.code === 'ECONNREFUSED') {
      console.log();
      console.log(chalk.red('❌ Cannot connect to BioFS-Node'));
      console.log(chalk.gray(`   URL: ${error.config?.url || 'unknown'}`));
      console.log();
      console.log(chalk.yellow('Troubleshooting:'));
      console.log(chalk.gray('  1. Verify BioFS-Node is running on GPU server'));
      console.log(chalk.gray('  2. Check network connectivity'));
      console.log(chalk.gray('  3. Verify config.json has correct biofsNode.url'));
      console.log();
    } else if (error.code === 'ETIMEDOUT') {
      console.log();
      console.log(chalk.red('❌ Connection timeout'));
      console.log(chalk.gray('   The server did not respond within 10 seconds'));
      console.log();
    } else {
      console.log();
      console.log(chalk.red(`Error: ${error.message}`));
      console.log();
    }

    process.exit(1);
  }
}

