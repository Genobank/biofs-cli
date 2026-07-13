/**
 * biofs ancestry status <ancestry_job_id>
 *
 * Check a SOMOS ancestry job's status / fetch the 24-population result.
 * Thin client over biofs-node GET /agent/ancestry_status.
 */

import chalk from 'chalk';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface AncestryStatusOptions {
  watch?: boolean;
  wait?: boolean;
  maxWaitMin?: string;
  json?: boolean;
}

interface StatusResponse {
  ancestry_job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  mode?: string;
  ancestry?: Record<string, number>;
  result_biocid?: string;
  result_gs_uri?: string;
  result_url?: string;
  fidelity?: string;
  error?: string;
}

function render(row: StatusResponse): void {
  console.log(chalk.bold(`ancestry_job_id ${row.ancestry_job_id}  [${row.mode || '?'}]  ${row.status}`));
  if (row.ancestry) {
    const sorted = Object.entries(row.ancestry).sort((a, b) => b[1] - a[1]);
    for (const [k, v] of sorted) {
      if (v >= 0.005) console.log('  ' + k.padEnd(14) + (v * 100).toFixed(2).padStart(6) + '%');
    }
  }
  if (row.result_url || row.result_gs_uri) console.log(chalk.gray('  result: ' + (row.result_url || row.result_gs_uri)));
  if (row.fidelity) console.log(chalk.yellow('  ' + row.fidelity));
  if (row.error) console.log(chalk.red('  error: ' + row.error));
}

export async function ancestryStatusCommand(
  jobId: string,
  options: AncestryStatusOptions = {},
): Promise<void> {
  const maxWaitMin = parseInt(options.maxWaitMin || '40', 10);
  const deadline = Date.now() + maxWaitMin * 60_000;
  const poll = options.watch || options.wait;
  // biofs-node releases the 24-population result only to the job's owner or the
  // operator who submitted it; sign the poll so an authorized caller sees it.
  const credentials = await getCredentials().catch(() => null);
  const authParams = credentials?.user_signature ? { signature: credentials.user_signature } : {};
  try {
    do {
      const st = await axios.get<StatusResponse>(
        `${BIOFS_NODE_BASE}/ancestry_status`,
        { params: { ancestry_job_id: jobId, ...authParams }, timeout: 30_000, validateStatus: (s) => s < 500 },
      );
      if (st.status === 404) {
        if (!poll) { console.log(chalk.yellow('job not found yet')); return; }
      } else {
        const row = st.data;
        if (options.json) {
          console.log(JSON.stringify(row, null, 2));
        } else {
          render(row);
        }
        if (!poll || row.status === 'done' || row.status === 'failed') return;
      }
      await new Promise((r) => setTimeout(r, 10_000));
    } while (Date.now() < deadline);
    if (poll) console.log(chalk.yellow('wait timeout'));
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    Logger.error(`ancestry status failed: ${msg}`);
    process.exit(1);
  }
}
