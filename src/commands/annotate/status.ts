/**
 * biofs annotate status <job_id>
 *
 * Check the status of an OpenCRAVAT annotation job.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface AnnotateStatusOptions {
  watch?: boolean;
  json?: boolean;
}

const OPENCRAVAT_URL = 'https://cravat.genobank.app';

export async function annotateStatusCommand(
  jobId: string,
  options: AnnotateStatusOptions = {}
): Promise<void> {
  const spinner = ora('Checking annotation job status...').start();

  try {
    // Get credentials
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const userWallet = credentials.wallet_address;
    const userSignature = credentials.user_signature;

    // Create auth headers
    const authString = `${userWallet}:${userSignature}`;
    const authB64 = Buffer.from(authString).toString('base64');
    const authHeaders = {
      'Authorization': `Basic ${authB64}`
    };

    const checkStatus = async (): Promise<any> => {
      const response = await axios.get(
        `${OPENCRAVAT_URL}/submit/jobstatus/${jobId}`,
        { headers: authHeaders, timeout: 30000 }
      );
      return response.data;
    };

    if (options.watch) {
      spinner.stop();
      console.log(chalk.cyan('\n🔄 Watching job status (Ctrl+C to stop)...\n'));

      while (true) {
        try {
          const status = await checkStatus();
          const statusStr = status?.status || 'Unknown';
          const timestamp = new Date().toLocaleTimeString();

          process.stdout.write(`\r[${timestamp}] Status: ${getStatusEmoji(statusStr)} ${statusStr}     `);

          if (statusStr === 'Finished') {
            console.log(chalk.green('\n\n✅ Annotation completed!'));
            console.log(chalk.gray(`   Results: ${OPENCRAVAT_URL}/result/index.html?job_id=${jobId}`));
            break;
          } else if (statusStr === 'Error' || statusStr === 'Failed') {
            console.log(chalk.red(`\n\n❌ Annotation failed: ${status?.message || 'Unknown error'}`));
            break;
          }

          await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    } else {
      const status = await checkStatus();
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }

      const statusStr = status?.status || 'Unknown';

      console.log(chalk.cyan('\n📊 OpenCRAVAT Job Status'));
      console.log(chalk.gray('━'.repeat(50)));
      console.log(`\n${chalk.cyan('Job ID:')}     ${chalk.white(jobId)}`);
      console.log(`${chalk.cyan('Status:')}     ${getStatusEmoji(statusStr)} ${chalk.white(statusStr)}`);

      if (status?.num_input_var) {
        console.log(`${chalk.cyan('Variants:')}   ${chalk.white(status.num_input_var.toLocaleString())}`);
      }

      if (status?.annotators && status.annotators.length > 0) {
        console.log(`${chalk.cyan('Annotators:')} ${chalk.white(status.annotators.length)}`);
      }

      if (statusStr === 'Finished') {
        console.log(chalk.green('\n✅ Annotation completed!'));
        console.log(chalk.gray(`   View results: ${OPENCRAVAT_URL}/result/index.html?job_id=${jobId}`));
      } else if (statusStr === 'Error' || statusStr === 'Failed') {
        console.log(chalk.red(`\n❌ Annotation failed: ${status?.message || 'Unknown error'}`));
      } else if (statusStr === 'Running' || statusStr === 'Annotating') {
        console.log(chalk.yellow('\n⏳ Job is still running...'));
        console.log(chalk.gray(`   Use --watch to monitor: biofs annotate status ${jobId} --watch`));
      }

      console.log('');
    }

  } catch (error: any) {
    spinner.fail(chalk.red('Failed to check status'));

    if (error.response?.status === 404) {
      Logger.error(`Job not found: ${jobId}`);
    } else {
      Logger.error(`Error: ${error.message}`);
    }

    throw error;
  }
}

function getStatusEmoji(status: string): string {
  switch (status.toLowerCase()) {
    case 'finished':
      return '✅';
    case 'running':
    case 'annotating':
      return '🔄';
    case 'queued':
    case 'pending':
      return '⏳';
    case 'error':
    case 'failed':
      return '❌';
    default:
      return '❓';
  }
}
