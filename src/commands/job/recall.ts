import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { Logger } from '../../lib/utils/logger';
import { getCredentials } from '../../lib/auth/credentials';
import { CONFIG } from '../../lib/config/constants';

export interface RecallOptions {
  bam: string;
  json?: boolean;
}

export async function recallCommand(
  sampleId: string,
  options: RecallOptions
): Promise<void> {
  const spinner = ora('Submitting naive recall job...').start();

  try {
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const apiBase = CONFIG.API_BASE_URL;

    spinner.text = `Submitting BAM recall for ${sampleId}...`;

    const response = await axios.post(
      `${apiBase}/api_clara/recall_bam`,
      null,
      {
        params: {
          user_signature: credentials.user_signature,
          sample_id: sampleId,
          bam_vm_path: options.bam,
        },
        timeout: 300000,
      }
    );

    if (!response.data.success) {
      throw new Error(response.data.error || 'Recall submission failed');
    }

    spinner.succeed(chalk.green('Naive recall job started'));

    if (options.json) {
      console.log(JSON.stringify(response.data, null, 2));
      return;
    }

    console.log();
    console.log(chalk.bold('Recall Job:'));
    console.log(`  ${chalk.cyan('Job ID:')} ${response.data.job_id}`);
    console.log(`  ${chalk.cyan('Sample:')} ${sampleId}`);
    console.log(`  ${chalk.cyan('BAM:')} ${options.bam}`);
    console.log(`  ${chalk.cyan('Container:')} ${response.data.processing_result?.container_name || 'starting...'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.job_id}`));
    console.log();

  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit recall'));

    if (error.response) {
      Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    } else {
      Logger.error(`Error: ${error.message}`);
    }

    process.exit(1);
  }
}
