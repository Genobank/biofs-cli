/**
 * biofs annotate status <job_id>
 *
 * Check the status of an OpenCRAVAT annotation job.
 *
 * Resolution priority:
 *   1. If job_id matches OC native format (YYMMDD-HHMMSS), read .status.json
 *      directly from the OC job dir on genobank-production via gcloud IAP.
 *      This is reliable; the GenoBank API and OC HTTP endpoints are flaky.
 *   2. Otherwise try OC HTTP endpoint /submit/jobstatus/<id>.
 *   3. Otherwise try GenoBank API /api_vcf_annotator/get_job_status.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { spawnSync } from 'child_process';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface AnnotateStatusOptions {
  watch?: boolean;
  json?: boolean;
}

const OPENCRAVAT_URL = 'https://cravat.genobank.app';
const OC_JOBS_BASE = '/home/ubuntu/Genobank_APIs/open-cravat-production/open-cravat-production/cravat/jobs';

function isOcNativeId(s: string): boolean {
  return /^\d{6}-\d{6}$/.test(s);
}

interface OcStatus {
  status: string;
  num_input_var?: number;
  num_unique_var?: number;
  num_error_input?: number;
  annotators?: string[];
  submission_time?: string;
  finished_time?: string;
  viewable?: boolean;
  message?: string;
  sqlite_path?: string;
  source?: 'oc-statusjson' | 'oc-http' | 'genobank-api';
}

function fetchStatusFromOcJobDir(walletAddr: string, ocJobId: string): OcStatus | null {
  // Glob expansion happens server-side. Pull the first *.status.json in the job dir.
  const cmd = [
    'compute', 'ssh', 'genobank-production',
    '--zone=us-central1-a', '--tunnel-through-iap',
    '--command',
    `cat ${OC_JOBS_BASE}/${walletAddr.toLowerCase()}/${ocJobId}/*.status.json 2>/dev/null | head -200`,
  ];
  const res = spawnSync('gcloud', cmd, { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 30000 });
  if (res.status !== 0 || !res.stdout.trim()) return null;
  try {
    const obj = JSON.parse(res.stdout);
    return { ...obj, source: 'oc-statusjson' };
  } catch {
    return null;
  }
}

export async function annotateStatusCommand(
  jobId: string,
  options: AnnotateStatusOptions = {}
): Promise<void> {
  const spinner = ora('Checking annotation job status...').start();

  try {
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const userWallet = credentials.wallet_address;
    const userSignature = credentials.user_signature;

    const authString = `${userWallet}:${userSignature}`;
    const authB64 = Buffer.from(authString).toString('base64');
    const authHeaders = { 'Authorization': `Basic ${authB64}` };

    const checkStatus = async (): Promise<OcStatus> => {
      if (isOcNativeId(jobId)) {
        const direct = fetchStatusFromOcJobDir(userWallet, jobId);
        if (direct) return direct;
      }
      try {
        const response = await axios.get(
          `${OPENCRAVAT_URL}/submit/jobstatus/${jobId}`,
          { headers: authHeaders, timeout: 30000 }
        );
        return { ...(response.data || {}), source: 'oc-http' };
      } catch (e: any) {
        Logger.debug(`OC HTTP /jobstatus failed: ${e?.message || e}`);
      }
      try {
        const gbResp = await axios.get(
          `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_vcf_annotator/get_job_status`,
          { params: { user_signature: userSignature }, timeout: 30000 }
        );
        const d = gbResp.data?.status_details?.data || gbResp.data;
        return { ...d, source: 'genobank-api' };
      } catch (e: any) {
        Logger.debug(`GenoBank API /get_job_status failed: ${e?.message || e}`);
      }
      throw new Error(`Could not determine status for job ${jobId} via any backend`);
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
  const s = status.toLowerCase();
  if (s === 'finished' || s.startsWith('finished')) return '✅';
  if (s.startsWith('running') || s.startsWith('annotating') || s.startsWith('aggregat')) return '🔄';
  if (s === 'queued' || s === 'pending' || s.startsWith('submit')) return '⏳';
  if (s === 'error' || s === 'failed' || s.startsWith('error') || s.startsWith('fail')) return '❌';
  return '❓';
}


