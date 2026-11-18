/**
 * biofs mirror plan|run|status|jobs|schedule
 *
 * CLIENT verb for the GenoBank.io disaster-recovery biodata mirror. biofs-node (POST /agent/mirror, operator
 * wallets only) runs the executor on the production server: every primary object of the project's buckets is
 * Crypt4GH-encrypted to the DR recipient key and copied to Cloudflare R2, server to server, one blob per unique
 * file. A deletion in Google reaches the mirror on the next sync (GDPR Article 17). No biodata passes through
 * this machine.
 *
 *   biofs mirror plan [--targets a,b]            # what a run would copy and delete, with the egress estimate
 *   biofs mirror run [--targets a,b] [--allow-mass-delete] [--max-mbps N] [--workers N] [--wait]
 *   biofs mirror status [jobId]                  # progress of the latest job, or of one job
 *   biofs mirror jobs                            # the last 10 jobs and the daily schedule
 *   biofs mirror schedule --daily [--hour-utc 9] | --off
 *
 * Use the operator profile: BIOFS_PROFILE=operator biofs mirror plan
 */
import axios from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface MirrorOptions {
  json?: boolean;
  targets?: string;
  allowMassDelete?: boolean;
  maxMbps?: string;
  workers?: string;
  wait?: boolean;
  daily?: boolean;
  off?: boolean;
  hourUtc?: string;
}

async function call(body: Record<string, unknown>): Promise<any> {
  const cred = await getCredentials();
  if (!cred) throw new Error('Not authenticated. Run "BIOFS_PROFILE=operator biofs login" first.');
  const r = await axios.post(`${BIOFS_NODE_BASE}/mirror`, body, {
    headers: { 'Content-Type': 'application/json', 'X-Biofs-Wallet': cred.wallet_address, 'X-Biofs-Signature': cred.user_signature },
    timeout: 60_000, validateStatus: (s) => s < 600,
  });
  if (r.status === 401 || r.status === 403) {
    throw new Error(`the mirror is operator-only and ${cred.wallet_address} is not a node operator (use BIOFS_PROFILE=operator)`);
  }
  if (r.status >= 400) throw new Error(`mirror ${body.action}: ${r.status} ${r.data?.error || ''}`);
  return r.data;
}

function params(o: MirrorOptions): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (o.targets) p.targets = o.targets.split(',').map((s) => s.trim()).filter(Boolean);
  if (o.allowMassDelete) p.allow_mass_delete = true;
  if (o.maxMbps) p.max_mbps = Number(o.maxMbps);
  if (o.workers) p.workers = Number(o.workers);
  return p;
}

const gb = (n?: number) => `${((n || 0) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 1 })} GB`;

function printJob(j: any): void {
  const c = j.counters || {};
  const status = j.status === 'done' ? chalk.green(j.status)
    : j.status === 'failed' || j.status === 'done_with_errors' ? chalk.red(j.status) : chalk.cyan(j.status);
  console.log(`${chalk.bold(j._id)}  ${j.action}  ${status}  started ${j.started_at || j.created_at} by ${j.requested_by}`);
  if (c.primary_objects !== undefined) {
    console.log(`  primary objects ${c.primary_objects.toLocaleString('en-US')} (${gb(c.primary_bytes)}), `
      + `unique files ${c.unique_blobs.toLocaleString('en-US')} (${gb(c.unique_bytes)}), buckets ${c.buckets_listed}`
      + (c.buckets_failed ? chalk.yellow(`, ${c.buckets_failed} unreadable`) : ''));
    console.log(`  already mirrored ${c.present_blobs.toLocaleString('en-US')} files; to copy ${c.to_upload_blobs.toLocaleString('en-US')} `
      + `(${gb(c.to_upload_bytes)}), estimated Google egress $${c.est_egress_usd}`);
    console.log(`  to delete ${c.stale_objects} objects and ${c.orphan_blobs} blobs`
      + (c.deletions_blocked ? chalk.yellow(' (held by the 2 percent guard)') : ''));
  }
  if (j.action === 'run' && c.to_upload_bytes !== undefined) {
    const done = c.uploaded_bytes || 0;
    const total = c.to_upload_bytes || 0;
    const rate = c.rate_mb_s || 0;
    const left = rate > 0 && total > done ? `, about ${((total - done) / (rate * 1e6) / 3600).toFixed(1)} h left` : '';
    console.log(`  copied ${(c.uploaded_blobs || 0).toLocaleString('en-US')} files, ${gb(done)} of ${gb(total)} `
      + `(${total ? ((100 * done) / total).toFixed(1) : '100'}%) at ${rate} MB/s${left}`);
    if (c.deleted_blobs || c.deleted_objects) console.log(`  deleted ${c.deleted_objects || 0} objects and ${c.deleted_blobs || 0} blobs`);
    if (c.manifest_objects) console.log(`  encrypted map in R2: ${c.manifest_objects.toLocaleString('en-US')} objects`);
  }
  if (c.errors) console.log(chalk.yellow(`  errors ${c.errors}${j.errors?.length ? `: ${j.errors[0]}` : ''}`));
}

async function waitFor(jobId: string, json?: boolean): Promise<any> {
  for (;;) {
    const j = await call({ action: 'status', job_id: jobId });
    if (!['queued', 'running'].includes(j.status)) return j;
    if (!json) process.stdout.write(chalk.gray(`  ${j.status}: ${JSON.stringify(j.counters || {}).slice(0, 120)}\r`));
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

export async function mirrorSubmitCommand(action: 'plan' | 'run', options: MirrorOptions): Promise<void> {
  try {
    const r = await call({ action, ...params(options) });
    const wait = action === 'plan' ? options.wait !== false : options.wait === true;
    if (!wait) {
      if (options.json) console.log(JSON.stringify(r, null, 2));
      else console.log(`${action} started: ${chalk.bold(r.job_id)}. Follow it with: biofs mirror status ${r.job_id}`);
      return;
    }
    if (!options.json) console.log(`${action} started: ${chalk.bold(r.job_id)}; waiting...`);
    const j = await waitFor(r.job_id, options.json);
    if (options.json) console.log(JSON.stringify(j, null, 2));
    else { console.log(''); printJob(j); }
  } catch (e: any) {
    Logger.error(`mirror ${action} failed: ${e.message}`);
    process.exit(1);
  }
}

export async function mirrorStatusCommand(jobId: string | undefined, options: MirrorOptions): Promise<void> {
  try {
    const j = await call({ action: 'status', ...(jobId ? { job_id: jobId } : {}) });
    if (options.json) console.log(JSON.stringify(j, null, 2));
    else printJob(j);
  } catch (e: any) {
    Logger.error(`mirror status failed: ${e.message}`);
    process.exit(1);
  }
}

export async function mirrorJobsCommand(options: MirrorOptions): Promise<void> {
  try {
    const r = await call({ action: 'jobs' });
    if (options.json) { console.log(JSON.stringify(r, null, 2)); return; }
    const s = r.schedule;
    console.log(s ? `daily schedule: ${s.enabled ? chalk.green('on') : 'off'} at ${s.hour_utc}:00 UTC`
      + (s.last_job ? `, last ${s.last_job} on ${s.last_started_date}` : '') : 'daily schedule: not set');
    for (const j of r.jobs || []) printJob(j);
  } catch (e: any) {
    Logger.error(`mirror jobs failed: ${e.message}`);
    process.exit(1);
  }
}

export async function mirrorScheduleCommand(options: MirrorOptions): Promise<void> {
  try {
    if (!options.daily && !options.off) throw new Error('pass --daily or --off');
    const r = await call({ action: 'schedule', enabled: Boolean(options.daily), hour_utc: Number(options.hourUtc ?? 9), ...params(options) });
    if (options.json) console.log(JSON.stringify(r, null, 2));
    else console.log(r.enabled ? `daily mirror sync on at ${r.hour_utc}:00 UTC` : 'daily mirror sync off');
  } catch (e: any) {
    Logger.error(`mirror schedule failed: ${e.message}`);
    process.exit(1);
  }
}
