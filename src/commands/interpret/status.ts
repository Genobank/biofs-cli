/**
 * biofs interpret status <interpret_job_id>
 *
 * Poll the GenoClaw interpretation job on biofs-node (GET /agent/interpret_status),
 * mirroring `biofs annotate status`.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface InterpretStatusOptions {
  watch?: boolean;
  wait?: boolean;
  maxWaitMin?: string;
  json?: boolean;
}

interface StatusRow {
  interpret_job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  report_biocid?: string;
  report_url?: string;
  report_gs_uri?: string;
  n_findings?: number;
  error?: string;
  inventory_registered?: boolean;
  customer_biowallet?: string;
  package?: string;
}

async function fetchStatus(jobId: string): Promise<StatusRow | null> {
  const r = await axios.get<StatusRow>(`${BIOFS_NODE_BASE}/interpret_status`, {
    params: { interpret_job_id: jobId },
    timeout: 30_000,
    validateStatus: (s) => s < 500,
  });
  return r.status === 200 ? r.data : null;
}

function render(row: StatusRow): void {
  const color = row.status === 'done' ? chalk.green : row.status === 'failed' ? chalk.red : chalk.yellow;
  console.log(`${chalk.cyan('interpret_job_id:')} ${row.interpret_job_id}`);
  console.log(`${chalk.cyan('status:')}           ${color(row.status)}`);
  if (row.n_findings !== undefined) console.log(`${chalk.cyan('findings:')}         ${row.n_findings}`);
  if (row.report_biocid) console.log(`${chalk.cyan('report biocid:')}    ${row.report_biocid}`);
  if (row.report_url) console.log(`${chalk.cyan('report url:')}       ${row.report_url}`);
  if (row.report_gs_uri) console.log(`${chalk.cyan('report gs uri:')}    ${row.report_gs_uri}`);
  if (row.inventory_registered !== undefined) console.log(`${chalk.cyan('registered:')}       ${row.inventory_registered}`);
  if (row.error) console.log(`${chalk.red('error:')}            ${row.error}`);
}

export async function interpretStatusCommand(
  jobId: string,
  options: InterpretStatusOptions = {},
): Promise<void> {
  const wait = options.wait || options.watch;
  const maxMin = parseInt(options.maxWaitMin || '30', 10);
  const deadline = Date.now() + maxMin * 60_000;

  try {
    if (!wait) {
      const row = await fetchStatus(jobId);
      if (!row) { Logger.error('job not found'); process.exit(1); }
      if (options.json) console.log(JSON.stringify(row, null, 2));
      else render(row);
      return;
    }
    const spinner = options.json ? null : ora(`watching ${jobId}…`).start();
    while (Date.now() < deadline) {
      const row = await fetchStatus(jobId);
      if (row && (row.status === 'done' || row.status === 'failed')) {
        spinner?.stop();
        if (options.json) console.log(JSON.stringify(row, null, 2));
        else render(row);
        return;
      }
      if (spinner && row) spinner.text = `${jobId}: ${row.status}`;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    spinner?.warn('wait timeout');
  } catch (err: any) {
    Logger.error(`interpret status failed: ${err?.message || err}`);
    process.exit(1);
  }
}
