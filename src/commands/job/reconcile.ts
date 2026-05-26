/**
 * biofs job reconcile — mark stale clara_jobs as failed.
 *
 * Wraps POST /api_bioroutes/jobs/reconcile. Useful after GPU spot preemption
 * left clara_jobs in 'processing' or 'queued' status indefinitely. Reconciling
 * is a prerequisite for fresh cohort-pipeline runs (otherwise the orchestrator
 * may treat stale rows as active and skip serials).
 *
 * Example:
 *   biofs job reconcile                            # older than 12h, statuses=processing,queued
 *   biofs job reconcile --older-than 6 --statuses processing
 */

import chalk from 'chalk';
import axios from 'axios';
import { CredentialsManager } from '../../lib/auth/credentials';
import { CONFIG } from '../../lib/config/constants';
import { Logger } from '../../lib/utils/logger';

export interface JobReconcileOptions {
  olderThan?: string;
  statuses?: string;
  json?: boolean;
}

export async function jobReconcileCommand(opts: JobReconcileOptions): Promise<void> {
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }

  const olderThanHours = parseInt(opts.olderThan || '12', 10);
  const statusesList = (opts.statuses || 'processing,queued').split(',').map(s => s.trim()).filter(Boolean);

  try {
    const url = `${CONFIG.API_BASE_URL}/api_bioroutes/jobs/reconcile`;
    const resp = await axios.post(url, {
      wallet: creds.wallet_address,
      signature: creds.user_signature,
      older_than_hours: olderThanHours,
      statuses: statusesList,
    }, { timeout: 60_000, validateStatus: (s: number) => s < 500 });

    if (resp.status === 403) {
      Logger.error('Reconcile denied: admin only');
      process.exit(1);
    }
    if (resp.status >= 400) {
      Logger.error(`Reconcile failed (HTTP ${resp.status}): ${resp.data?.error || 'unknown'}`);
      process.exit(1);
    }

    const d = resp.data;
    if (opts.json) { console.log(JSON.stringify(d, null, 2)); return; }
    console.log(chalk.green(`✓ Reconciled ${d.reconciled} stale clara_jobs`));
    console.log(chalk.gray(`  older_than: ${d.older_than_hours}h  statuses: ${d.statuses.join(', ')}`));
    console.log(chalk.gray(`  cutoff:     ${d.cutoff}`));
  } catch (err: any) {
    if (err.response) {
      Logger.error(`Reconcile failed (HTTP ${err.response.status}): ${err.response.data?.error || err.message}`);
    } else {
      Logger.error(`Reconcile failed: ${err.message}`);
    }
    process.exit(1);
  }
}
