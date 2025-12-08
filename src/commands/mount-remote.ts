/**
 * Remote Mount Command - Mount biosample files on GPU processing agent
 * Calls BioFS-Node mount endpoint to orchestrate remote filesystem mounting
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../lib/utils/logger';
import { getCredentials } from '../lib/auth/credentials';

export interface MountRemoteOptions {
  mountPoint?: string;
  json?: boolean;
  verbose?: boolean;
}

export async function mountRemoteCommand(
  biosampleId: string,
  options: MountRemoteOptions = {}
): Promise<void> {
  const spinner = ora('Requesting remote mount...').start();

  try {
    // Get credentials
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    // Load config (check multiple locations)
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

    const userWallet = credentials.wallet_address;
    const mountPoint = options.mountPoint || '/biofs';

    spinner.text = `Mounting biosample ${biosampleId} on agent...`;

    // Call mount endpoint
    const response = await axios.post(
      `${biofsNodeUrl}/api/v1/clara/mount`,
      {
        biosampleId,
        mountPoint,
        userWallet
      },
      {
        timeout: 60000,  // 60 seconds for mount operation
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.data.success) {
      throw new Error(response.data.error || 'Mount failed');
    }

    spinner.succeed(chalk.green('✓ Remote mount successful'));

    if (options.json) {
      console.log(JSON.stringify(response.data, null, 2));
      return;
    }

    const result = response.data;

    console.log('');
    console.log(chalk.bold('🎉 Biosample Mounted on Agent:'));
    console.log(`  ${chalk.cyan('Biosample:')} ${biosampleId}`);
    console.log(`  ${chalk.cyan('Mount Point:')} ${result.mountPoint}`);
    console.log(`  ${chalk.cyan('Manifest:')} ${result.manifest}`);
    console.log(`  ${chalk.cyan('Files:')} ${result.files?.length || 0}`);
    console.log('');

    if (result.files && result.files.length > 0) {
      console.log(chalk.bold('Mounted Files:'));
      for (const file of result.files) {
        const filename = path.basename(file);
        console.log(`  ${chalk.green('✓')} ${filename}`);
      }
      console.log('');
    }

    if (result.consent) {
      console.log(chalk.bold('Consent Validation:'));
      console.log(`  ${chalk.cyan('Patient:')} ${result.consent.patient?.substring(0, 10)}...`);
      console.log(`  ${chalk.cyan('Agent:')} ${result.consent.agent?.substring(0, 10)}...`);
      console.log(`  ${chalk.cyan('Block:')} ${result.consent.block}`);
      console.log('');
    }

    if (options.verbose) {
      console.log(chalk.bold('Debug Information:'));
      console.log(chalk.gray('  BioFS-Node URL: ') + biofsNodeUrl);
      console.log(chalk.gray('  User Wallet: ') + userWallet);
      console.log(chalk.gray('  Full Response:'));
      console.log(JSON.stringify(result, null, 2).split('\n').map(line => '    ' + line).join('\n'));
      console.log('');
    }

    console.log(chalk.gray('💡 Files are mounted on the agent and ready for processing'));
    console.log(chalk.gray('💡 Submit Clara job: ') + chalk.cyan(`biofs job submit-clara ${biosampleId}`));
    console.log('');

  } catch (error: any) {
    spinner.fail(chalk.red('✗ Remote mount failed'));

    if (error.response) {
      Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.message}`);

      if (error.response.data?.stderr) {
        console.log('');
        console.log(chalk.red('Error details:'));
        console.log(error.response.data.stderr);
      }
    } else if (error.request) {
      Logger.error(`Cannot connect to BioFS-Node. Is it running at ${error.config?.baseURL || 'configured URL'}?`);
    } else {
      Logger.error(`Error: ${error.message}`);
    }

    process.exit(1);
  }
}
