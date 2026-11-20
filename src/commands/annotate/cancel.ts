/**
 * biofs annotate cancel <oc_job_id>
 *
 * Stops a running OpenCRAVAT annotation job: biofs-node (POST /agent/cravat_cancel) checks that the caller owns the job (or is the node admin), records who asked, keeps a diagnostic
 * snapshot of the container on the job row and stops the container; the job then ends as failed with "cancelled by <wallet>". A finished job is left alone. The node also stops, by
 * itself, a job that uses no CPU and writes no file for 30 minutes (OC_STALL_SECONDS) or runs past 12 hours (OC_MAX_RUNTIME_SECONDS).
 */

import chalk from 'chalk';
import axios from 'axios';
import { Logger } from '../../lib/utils/logger';
import { getCredentials } from '../../lib/auth/credentials';
import { signedHeaders } from './signed_headers';

export interface AnnotateCancelOptions {
  json?: boolean;
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface CancelAnswer {
  oc_job_id: string;
  ok: boolean;
  cancel: 'cancelling' | 'not_running' | 'no_container' | 'stop_failed' | string;
  status?: string;
}

/** The body and headers of one cancel request (exported for tests). */
export function buildCancelRequest(ocJobId: string, credentials: { wallet_address: string; user_signature: string }): { body: { oc_job_id: string }; headers: Record<string, string> } {
  if (!/^oc-[0-9a-f-]{36}$/.test(ocJobId)) throw new Error(`not an annotation job id: ${ocJobId} (expected oc-<uuid>)`);
  return { body: { oc_job_id: ocJobId }, headers: { ...signedHeaders(credentials), 'Content-Type': 'application/json' } };
}

/** One line for the person: what the node did. */
export function describeCancel(a: CancelAnswer): string {
  switch (a.cancel) {
    case 'cancelling': return `${a.oc_job_id}: the container was stopped; the job ends as failed (cancelled by you).`;
    case 'not_running': return `${a.oc_job_id}: already finished (status ${a.status}); nothing to cancel.`;
    case 'no_container': return `${a.oc_job_id}: no container was running for this job; the job is closed as failed (cancelled).`;
    case 'stop_failed': return `${a.oc_job_id}: the node could not stop the container.`;
    default: return `${a.oc_job_id}: ${a.cancel}`;
  }
}

export async function annotateCancelCommand(ocJobId: string, options: AnnotateCancelOptions = {}): Promise<void> {
  const credentials = await getCredentials();
  if (!credentials) throw new Error('Not authenticated. Run: biofs login');
  const { body, headers } = buildCancelRequest(ocJobId, credentials);
  const r = await axios.post<CancelAnswer | { error: string }>(`${BIOFS_NODE_BASE}/cravat_cancel`, body, { headers, timeout: 90_000, validateStatus: () => true });
  if (r.status === 200 || r.status === 502) {
    const a = r.data as CancelAnswer;
    if (options.json) console.log(JSON.stringify(a, null, 2));
    else console.log(r.status === 200 ? chalk.green(describeCancel(a)) : chalk.red(describeCancel(a)));
    if (r.status !== 200) process.exit(1);
    return;
  }
  const msg = (r.data as { error?: string })?.error || `HTTP ${r.status}`;
  Logger.error(`cancel refused (${r.status}): ${msg}`);
  process.exit(1);
}
