/**
 * biofs annotate status <oc_job_id>
 *
 * v3.6 — repointed to biofs-node v0.4 `/agent/cravat_status`. Returns the full
 * oc_jobs row (status, exit_code, sqlite_size, n_variants, inventory_registered).
 *
 * --wait blocks (polls every 15s) until status ∈ {done, failed} or the 90-min
 * ceiling is hit. Suitable for use in pipeline_run_wes.py Phase 5b.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { Logger } from '../../lib/utils/logger';

export interface AnnotateStatusOptions {
  json?: boolean;
  wait?: boolean;
  watch?: boolean;          // legacy alias for --wait
  quiet?: boolean;
  maxWaitMin?: string;
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

interface StatusRow {
  oc_job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  exit_code?: number;
  sqlite_size_bytes?: number;
  n_variants?: number;
  error?: string;
  inventory_registered?: boolean;
  sqlite_biocid?: string;
  dest_gs_uri?: string;
  customer_biowallet?: string;
  package?: string;
  parent_chain_token_id?: number | null;
}

async function fetchStatus(ocJobId: string): Promise<StatusRow | null> {
  const r = await axios.get<StatusRow>(`${BIOFS_NODE_BASE}/cravat_status`, {
    params: { oc_job_id: ocJobId },
    timeout: 30_000,
    validateStatus: (s) => s < 500,
  });
  return r.status === 200 ? r.data : null;
}

export async function annotateStatusCommand(
  ocJobId: string,
  options: AnnotateStatusOptions = {}
): Promise<void> {
  const wait = options.wait || options.watch;
  try {
    if (!wait) {
      const row = await fetchStatus(ocJobId);
      if (!row) {
        Logger.error(`oc_job_id=${ocJobId} not found`);
        process.exit(1);
      }
      if (options.json) {
        console.log(JSON.stringify(row, null, 2));
      } else {
        console.log(`${chalk.bold(ocJobId)}  status=${row.status}`);
        if (row.n_variants !== undefined) console.log(`  variants annotated: ${row.n_variants}`);
        if (row.sqlite_size_bytes !== undefined) console.log(`  sqlite size: ${(row.sqlite_size_bytes / 1e6).toFixed(1)} MB`);
        if (row.inventory_registered) console.log(`  ✓ bioroutes.inventory row written (biocid=${row.sqlite_biocid?.slice(0, 80) || '?'})`);
        if (row.error) console.log(chalk.red(`  error: ${row.error.slice(0, 200)}`));
        if (row.dest_gs_uri) console.log(chalk.gray(`  output: ${row.dest_gs_uri}`));
      }
      return;
    }

    const maxMin = parseInt(options.maxWaitMin || '90', 10);
    const spinner = options.quiet ? null
      : ora(`waiting for ${ocJobId} (up to ${maxMin} min)`).start();
    const deadline = Date.now() + maxMin * 60_000;
    while (Date.now() < deadline) {
      const row = await fetchStatus(ocJobId);
      if (row) {
        if (row.status === 'done') {
          spinner?.succeed(`done — ${row.n_variants ?? '?'} variants, ${row.sqlite_size_bytes ?? '?'} bytes${row.inventory_registered ? ', inventory registered' : ''}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return;
        }
        if (row.status === 'failed') {
          spinner?.fail(`failed exit_code=${row.exit_code}: ${row.error || 'no detail'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          process.exit(2);
        }
        if (spinner) spinner.text = `${row.status} (${ocJobId})`;
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    spinner?.warn('wait timeout');
    process.exit(3);
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    Logger.error(`annotate status failed: ${msg}`);
    process.exit(1);
  }
}
