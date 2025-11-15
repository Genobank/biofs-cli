/**
 * biofs files - List BioNFT-gated files via FUSE API
 *
 * Discovers files across all biosamples accessible via BioNFT consent
 */

import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FuseAPIClient } from '../lib/api/fuse-client';
import { Logger } from '../lib/utils/logger';
import { formatFileSize } from '../lib/utils/format';
import Table from 'cli-table3';

export interface FilesOptions {
  biosample?: string;   // Filter by specific biosample
  json?: boolean;
  verbose?: boolean;
}

export async function filesCommand(options: FilesOptions): Promise<void> {
  const spinner = ora('Discovering accessible files...').start();

  try {
    // Get credentials
    const configPath = path.join(process.env.HOME || '', '.biofs', 'credentials.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));

    if (!config.wallet_address || !config.user_signature) {
      throw new Error('Not authenticated. Run: biofs login');
    }

    const fuseClient = new FuseAPIClient();
    const wallet = config.wallet_address;
    const signature = config.user_signature;

    if (options.biosample) {
      // List files for specific biosample
      spinner.text = `Listing files for biosample ${options.biosample}...`;
      const result = await fuseClient.list(options.biosample, wallet, signature);

      spinner.succeed(`Found ${result.count} files in biosample ${options.biosample}`);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.count === 0) {
        console.log(chalk.yellow('\nNo files found in this biosample'));
        return;
      }

      console.log(chalk.cyan(`\nFiles in biosample ${options.biosample}:`));
      result.files.forEach((file, idx) => {
        console.log(chalk.white(`  ${idx + 1}. ${file}`));
      });

    } else {
      // List files across all accessible biosamples
      spinner.text = 'Discovering accessible biosamples...';
      const allFiles = await fuseClient.getAllFiles(wallet, signature);

      const totalBiosamples = allFiles.length;
      const totalFiles = allFiles.reduce((sum, bs) => sum + bs.files.length, 0);

      spinner.succeed(`Found ${totalFiles} files across ${totalBiosamples} biosamples`);

      if (options.json) {
        console.log(JSON.stringify(allFiles, null, 2));
        return;
      }

      if (totalFiles === 0) {
        console.log(chalk.yellow('\nNo accessible files found'));
        console.log(chalk.dim('You need BioNFT consent to access biosample files'));
        return;
      }

      // Display as table
      const table = new Table({
        head: [
          chalk.cyan('Biosample'),
          chalk.cyan('Files'),
          chalk.cyan('Count')
        ],
        style: {
          head: [],
          border: []
        }
      });

      for (const biosample of allFiles) {
        const fileList = biosample.files.slice(0, 3).join('\n');
        const moreFiles = biosample.files.length > 3
          ? chalk.dim(`\n... and ${biosample.files.length - 3} more`)
          : '';

        table.push([
          chalk.white(biosample.biosample),
          chalk.dim(fileList + moreFiles),
          chalk.green(biosample.files.length.toString())
        ]);
      }

      console.log('\n' + table.toString());

      if (options.verbose) {
        console.log(chalk.cyan('\nDetailed file list:'));
        for (const biosample of allFiles) {
          console.log(chalk.white(`\n${biosample.biosample}:`));
          biosample.files.forEach((file, idx) => {
            console.log(chalk.dim(`  ${idx + 1}. ${file}`));
          });
        }
      }

      console.log(chalk.dim(`\nTo see files for a specific biosample:`));
      console.log(chalk.cyan(`  biofs files --biosample <serial>`));
    }

  } catch (error: any) {
    spinner.fail('Failed to list files');

    if (error.message.includes('BioNFT consent required')) {
      Logger.error('BioNFT consent required');
      console.log(chalk.yellow('\nYou need consent to access this biosample\'s files'));
      console.log(chalk.dim('Contact the biosample owner to request access'));
    } else if (error.message.includes('Invalid signature')) {
      Logger.error('Authentication failed');
      console.log(chalk.yellow('\nYour credentials may have expired'));
      console.log(chalk.dim('Run: biofs logout && biofs login'));
    } else {
      Logger.error(`Error: ${error.message}`);
      if (options.verbose) {
        console.error(error);
      }
    }

    process.exit(1);
  }
}
