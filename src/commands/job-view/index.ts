/**
 * biofs jobs [--limit n] [--json]                         the governed jobs you may see (as owner, submitter, node operator or node viewer), newest first
 * biofs job-log <job> [--follow] [--from n] [--json]      the run log of a job (pbrun's own output), live with --follow; also: biofs pbrun logs <job>
 *
 * Read-only CLIENT verbs over biofs-node (GET /agent/jobs_recent, GET /agent/job_log). The node decides who may see a job; a job you may not see is "not found".
 */
import axios from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../../lib/auth/credentials';
import { nodeErrorMessage } from '../../lib/utils/node_roles';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;
const JOB_RE = /^neo-[0-9a-f-]{36}$/;

export interface JobsOptions { limit?: string; json?: boolean }
export interface JobLogOptions { follow?: boolean; from?: string; json?: boolean }

export function buildJobsPath(o: JobsOptions): string {
  if (o.limit === undefined) return '/jobs_recent';
  const n = parseInt(o.limit, 10);
  if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error('--limit must be between 1 and 100');
  return `/jobs_recent?limit=${n}`;
}

export function buildLogPath(job: string, from: number): string {
  if (!JOB_RE.test(job)) throw new Error('give a job id of the form neo-<uuid>');
  if (!Number.isInteger(from) || from < 0) throw new Error('--from must be a non-negative integer');
  return `/job_log?neoantigen_job_id=${job}&from=${from}`;
}

export function elapsed(a?: string | number | null, b?: string | number | null): string {
  if (!a) return '';
  const t0 = typeof a === 'number' ? a * 1000 : Date.parse(a);
  const t1 = b ? (typeof b === 'number' ? b * 1000 : Date.parse(b)) : Date.now();
  const s = Math.max(0, Math.round((t1 - t0) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

async function get(path: string): Promise<any> {
  const credentials = await getCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
  const headers = { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature };
  const r = await axios.get(`${BIOFS_NODE_BASE}${path}`, { headers, timeout: 30_000, validateStatus: (s) => s < 500 });
  if (r.status >= 400) throw new Error(nodeErrorMessage(r.status, r.data?.error));
  return r.data;
}

export async function jobsCommand(o: JobsOptions): Promise<void> {
  const d = await get(buildJobsPath(o));
  if (o.json) { console.log(JSON.stringify(d, null, 2)); return; }
  for (const j of d.jobs) {
    const st = j.status === 'done' ? chalk.green(j.status) : j.status === 'failed' ? chalk.red(j.status) : chalk.yellow(j.status || '?');
    console.log(`${j.neoantigen_job_id}  ${st.padEnd(9)} ${(j.tool || j.kind || '').padEnd(14)} ${(j.case_id || '').padEnd(14)} ${elapsed(j.started_at || j.created_at, j.finished_at).padEnd(8)} ${j.stage || j.error || ''}`);
  }
  console.log(chalk.gray(`${d.count} jobs`));
}

export async function jobLogCommand(job: string, o: JobLogOptions, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  let from = o.from === undefined ? 0 : parseInt(o.from, 10);
  for (;;) {
    const d = await get(buildLogPath(job, from));
    if (o.json) console.log(JSON.stringify(d));
    else if (d.text) process.stdout.write(d.text);
    from = d.next;
    if (!o.follow) { if (!o.json && !d.finished) console.error(chalk.gray(`\n[${d.status}${d.stage ? ': ' + d.stage : ''}; next offset ${d.next}; add --follow to stream]`)); return; }
    if (d.finished && !d.text) return;
    await sleep(d.text ? 500 : 3000);
  }
}
