/**
 * Report Command - Generate diagnostic health check report
 * Useful for troubleshooting issues with GenoBank.io support
 */

import { CredentialsManager } from '../lib/auth/credentials';
import { GenoBankAPIClient } from '../lib/api/client';
import { Logger } from '../lib/utils/logger';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import * as os from 'os';
import * as fs from 'fs-extra';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

export interface ReportOptions {
  verbose?: boolean;
  json?: boolean;
}

export async function reportCommand(options: ReportOptions = {}): Promise<void> {
  const spinner = ora('Generating diagnostic report...').start();

  try {
    const report: any = {
      timestamp: new Date().toISOString(),
      biofs_version: '',
      system: {},
      authentication: {},
      connectivity: {},
      files: {},
      issues: []
    };

    // 1. Get BioFS version
    try {
      const packageJson = require('../../package.json');
      report.biofs_version = packageJson.version;
    } catch (error) {
      report.biofs_version = 'unknown';
    }

    // 2. System Information
    spinner.text = 'Collecting system information...';
    report.system = {
      platform: os.platform(),
      arch: os.arch(),
      node_version: process.version,
      os_version: os.release(),
      os_type: os.type(),
      total_memory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
      free_memory: `${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB`,
      cpus: os.cpus().length,
      home_dir: os.homedir().replace(os.homedir(), '~'), // Sanitized
      shell: process.env.SHELL || 'unknown'
    };

    // Check for common tools
    const tools = ['bcftools', 'samtools', 'igv', 'bionfs'];
    report.system.installed_tools = {};
    for (const tool of tools) {
      try {
        await execAsync(`which ${tool}`);
        report.system.installed_tools[tool] = 'installed';
      } catch (error) {
        report.system.installed_tools[tool] = 'not found';
      }
    }

    // 3. Authentication Status
    spinner.text = 'Checking authentication...';
    const credManager = CredentialsManager.getInstance();
    const creds = await credManager.loadCredentials();

    if (creds) {
      const expiresAt = new Date(creds.expires_at);
      const now = new Date();
      const daysUntilExpiry = Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      report.authentication = {
        status: 'authenticated',
        wallet_address: creds.wallet_address,
        expires_at: creds.expires_at,
        days_until_expiry: daysUntilExpiry,
        is_expired: daysUntilExpiry < 0
      };

      if (daysUntilExpiry < 0) {
        report.issues.push({
          severity: 'error',
          category: 'authentication',
          message: 'Authentication expired. Run: biofs login'
        });
      } else if (daysUntilExpiry < 7) {
        report.issues.push({
          severity: 'warning',
          category: 'authentication',
          message: `Authentication expires in ${daysUntilExpiry} days`
        });
      }
    } else {
      report.authentication = {
        status: 'not authenticated'
      };
      report.issues.push({
        severity: 'error',
        category: 'authentication',
        message: 'Not authenticated. Run: biofs login'
      });
    }

    // 4. API Connectivity
    spinner.text = 'Testing API connectivity...';
    const endpoints = [
      { name: 'Main API', url: 'https://genobank.app' },
      { name: 'Auth Service', url: 'https://auth.genobank.app' },
      { name: 'Telemetry', url: 'https://genobank.app/api_biofs_telemetry' }
    ];

    report.connectivity = {};
    for (const endpoint of endpoints) {
      try {
        const start = Date.now();
        const response = await axios.get(endpoint.url, { timeout: 5000 });
        const latency = Date.now() - start;
        report.connectivity[endpoint.name] = {
          status: 'reachable',
          http_status: response.status,
          latency_ms: latency
        };

        if (latency > 2000) {
          report.issues.push({
            severity: 'warning',
            category: 'connectivity',
            message: `Slow connection to ${endpoint.name} (${latency}ms)`
          });
        }
      } catch (error: any) {
        report.connectivity[endpoint.name] = {
          status: 'unreachable',
          error: error.message
        };
        report.issues.push({
          severity: 'error',
          category: 'connectivity',
          message: `Cannot reach ${endpoint.name}: ${error.message}`
        });
      }
    }

    // 5. BioFiles Status (if authenticated)
    if (creds) {
      spinner.text = 'Checking BioFiles access...';
      try {
        const api = GenoBankAPIClient.getInstance();
        const grantedFiles = await api.getMyGrantedBioIPs();
        report.files = {
          granted_count: grantedFiles.length,
          has_access: grantedFiles.length > 0
        };

        if (grantedFiles.length === 0) {
          report.issues.push({
            severity: 'info',
            category: 'files',
            message: 'No granted BioIP files found. Request access with: biofs access request <ip_id>'
          });
        }
      } catch (error: any) {
        report.files = {
          error: error.message
        };
        report.issues.push({
          severity: 'warning',
          category: 'files',
          message: `Failed to check BioFiles: ${error.message}`
        });
      }
    }

    // 6. Environment Variables
    report.environment = {
      biofs_telemetry: process.env.BIOFS_TELEMETRY !== 'false' ? 'enabled' : 'disabled',
      node_env: process.env.NODE_ENV || 'not set'
    };

    if (process.env.BIOFS_TELEMETRY === 'false') {
      report.issues.push({
        severity: 'info',
        category: 'configuration',
        message: 'Telemetry is disabled. Remote debugging unavailable.'
      });
    }

    spinner.stop();

    // Display Report
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    // Pretty format
    console.log('\n' + chalk.cyan('╔════════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║           BioFS Diagnostic Health Check Report                ║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════════╝\n'));

    console.log(chalk.bold('📦 BioFS Version:'), report.biofs_version);
    console.log(chalk.bold('📅 Report Time:'), report.timestamp);
    console.log();

    // System Info
    console.log(chalk.bold.blue('🖥️  System Information:'));
    console.log(`   Platform: ${report.system.platform} (${report.system.arch})`);
    console.log(`   OS: ${report.system.os_type} ${report.system.os_version}`);
    console.log(`   Node.js: ${report.system.node_version}`);
    console.log(`   Memory: ${report.system.free_memory} free / ${report.system.total_memory} total`);
    console.log(`   CPUs: ${report.system.cpus} cores`);
    console.log(`   Shell: ${report.system.shell}`);
    console.log();

    // Installed Tools
    console.log(chalk.bold.blue('🔧 Genomics Tools:'));
    for (const [tool, status] of Object.entries(report.system.installed_tools)) {
      const icon = status === 'installed' ? chalk.green('✓') : chalk.gray('✗');
      console.log(`   ${icon} ${tool}: ${status}`);
    }
    console.log();

    // Authentication
    console.log(chalk.bold.blue('🔐 Authentication:'));
    if (report.authentication.status === 'authenticated') {
      console.log(chalk.green(`   ✓ Authenticated`));
      console.log(`   Wallet: ${report.authentication.wallet_address}`);
      console.log(`   Expires: ${report.authentication.expires_at} (${report.authentication.days_until_expiry} days)`);
    } else {
      console.log(chalk.red(`   ✗ Not authenticated`));
      console.log(chalk.gray(`   Run: biofs login`));
    }
    console.log();

    // Connectivity
    console.log(chalk.bold.blue('🌐 API Connectivity:'));
    for (const [name, status] of Object.entries(report.connectivity)) {
      const statusInfo = status as any;
      if (statusInfo.status === 'reachable') {
        const latencyColor = statusInfo.latency_ms < 1000 ? chalk.green : statusInfo.latency_ms < 2000 ? chalk.yellow : chalk.red;
        console.log(`   ${chalk.green('✓')} ${name}: ${statusInfo.http_status} (${latencyColor(statusInfo.latency_ms + 'ms')})`);
      } else {
        console.log(`   ${chalk.red('✗')} ${name}: ${statusInfo.error}`);
      }
    }
    console.log();

    // Files
    if (report.files.granted_count !== undefined) {
      console.log(chalk.bold.blue('📁 BioFiles Access:'));
      if (report.files.granted_count > 0) {
        console.log(chalk.green(`   ✓ ${report.files.granted_count} granted file(s) available`));
      } else {
        console.log(chalk.gray(`   ℹ No granted files yet`));
      }
      console.log();
    }

    // Environment
    console.log(chalk.bold.blue('⚙️  Configuration:'));
    console.log(`   Telemetry: ${report.environment.biofs_telemetry === 'enabled' ? chalk.green('enabled') : chalk.yellow('disabled')}`);
    console.log();

    // Issues
    if (report.issues.length > 0) {
      console.log(chalk.bold.yellow('⚠️  Issues Detected:'));
      for (const issue of report.issues) {
        const icon = issue.severity === 'error' ? chalk.red('✗') : issue.severity === 'warning' ? chalk.yellow('⚠') : chalk.blue('ℹ');
        console.log(`   ${icon} [${issue.category}] ${issue.message}`);
      }
      console.log();
    } else {
      console.log(chalk.bold.green('✅ No Issues Detected\n'));
    }

    // Show what data will be transmitted (TRANSPARENCY)
    console.log(chalk.bold.cyan('📡 Data Being Transmitted to GenoBank.io:'));
    console.log(chalk.gray('─'.repeat(64)));

    const telemetryPayload = {
      biofs_version: report.biofs_version,
      command: 'report',
      report_type: 'health_check',
      wallet_address: report.authentication.wallet_address || 'not_authenticated',
      system_info: report.system,
      authentication: report.authentication,
      connectivity: report.connectivity,
      files: report.files,
      environment: report.environment,
      issues: report.issues,
      timestamp: report.timestamp
    };

    // Display payload for transparency
    console.log(chalk.gray(JSON.stringify(telemetryPayload, null, 2)));
    console.log(chalk.gray('─'.repeat(64)));
    console.log();
    console.log(chalk.yellow('✓ No sensitive data (passwords, keys, genomic data)'));
    console.log(chalk.yellow('✓ Paths sanitized (usernames removed)'));
    console.log(chalk.yellow('✓ Only system diagnostics for troubleshooting'));
    console.log();

    spinner.start('Sending report to GenoBank.io support...');

    try {
      const response = await axios.post(
        'https://genobank.app/api_biofs_health_report',
        telemetryPayload,
        {
          timeout: 5000,
          headers: { 'Content-Type': 'application/json' }
        }
      );

      spinner.succeed('Report automatically sent to GenoBank.io support');

      if (response.data.report_id) {
        console.log();
        console.log(chalk.bold.green('✅ Report Received!'));
        console.log(chalk.bold.green('📋 Report ID:'), chalk.cyan(response.data.report_id));
        console.log(chalk.gray('   GenoBank.io support can now see your diagnostics'));
        console.log(chalk.gray('   No need to manually share - we already have it!'));
      }
    } catch (error: any) {
      spinner.warn('Could not send report to GenoBank.io (telemetry may be disabled)');
      if (options.verbose) {
        console.log(chalk.gray(`   Error: ${error.message}`));
      }
      console.log();
      console.log(chalk.yellow('💡 Manual option: Save report locally'));
      console.log(chalk.cyan('   biofs report --json > biofs-report.json'));
      console.log(chalk.gray('   Then email biofs-report.json to support@genobank.io'));
    }

    console.log();
    console.log(chalk.bold('💡 Additional Options:'));
    console.log(chalk.gray('   • Save locally: ') + chalk.cyan('biofs report --json > biofs-report.json'));
    console.log(chalk.gray('   • Verbose mode: ') + chalk.cyan('biofs report --verbose'));
    console.log(chalk.gray('   • Support email: ') + chalk.cyan('support@genobank.io'));
    console.log();

  } catch (error: any) {
    spinner.fail('Failed to generate report');
    Logger.error(error.message || error);
    console.log();
    console.log(chalk.yellow('💡 Basic troubleshooting:'));
    console.log(chalk.gray('   1. Check internet connection'));
    console.log(chalk.gray('   2. Verify BioFS installation: npm list -g @genobank/biofs'));
    console.log(chalk.gray('   3. Reinstall: npm uninstall -g @genobank/biofs && npm install -g @genobank/biofs@latest'));
    console.log();
    process.exit(1);
  }
}

