/**
 * biofs imaging package | package-status
 *
 * Builds the organ package of a finished imaging-register job on the GPU executor, through biofs-node.
 * For every organ and timepoint the package holds the native volume, the organ cut out of the CT with its
 * mask, a per-slice table, surface meshes (GLB) in three placements (native, rigid spine frame, and the
 * deformable frame where the register gate allows it) and the volume change between timepoints from the
 * native volumes. With floors (the default) each change carries the measured repeatability floor and a flag
 * saying whether the change is larger than it. The package is decision support for a radiologist, never a
 * diagnosis, and it never calls a change clinically relevant.
 *
 * The result is registered as biocid://genobank/<wallet>/imaging-organ-package/<job>, derived from the register job.
 *
 * Flow:
 *   POST /api_biofs_node/submit_organ_package {wallet, signature, register_job_id, floors, organs?}
 *   GET  /api_biofs_node/organ_package_status?package_job_id=...  (owner signature in a header)
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface ImagingPackageOptions {
  organs?: string;
  floors?: boolean;   // commander sets this to false with --no-floors
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

export interface ImagingPackageStatusOptions {
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export const REGISTER_ID_RE = /^register-[0-9a-f-]{36}$/;
export const PACKAGE_ID_RE = /^package-[0-9a-f-]{36}$/;

interface PackageResult {
  schema?: string; output_gcs?: string; files?: number; bytes?: number; verify?: { ok?: boolean };
  floors_sha256?: string | null; organs_built?: number; built_at?: string; error?: string;
}
export interface PackageRow {
  package_job_id: string; status: string; register_job_id?: string; organs?: string | string[]; floors?: boolean;
  gate_verdict?: string | null; error?: string; output_biocid?: string; registry_error?: string; result?: PackageResult;
}

/** "liver, spleen" to ["liver", "spleen"]; empty entries dropped. */
export function parseOrgans(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function megabytes(b?: number): string {
  return typeof b === 'number' ? `${(b / 1e6).toFixed(1)} MB` : '-';
}

export function printPackageRow(row: PackageRow): void {
  console.log(chalk.bold(`package job ${row.package_job_id}: ${row.status}`));
  const org = Array.isArray(row.organs) ? `${row.organs.length} named organs` : 'default organ list';
  console.log(`  register job ${row.register_job_id || '-'}  gate ${row.gate_verdict || '-'}  floors ${row.floors === false ? 'off' : 'on'}  requested: ${org}`);
  const r = row.result;
  if (row.status === 'error') { console.log(chalk.red(`  error: ${row.error || r?.error || 'unknown'}`)); return; }
  if (!r) return;
  const built = typeof r.organs_built === 'number' ? `${r.organs_built} organs` : org;
  const ok = r.verify?.ok === true;
  console.log(`  ${built}, ${r.files ?? '-'} files, ${megabytes(r.bytes)}, verify ${ok ? chalk.green('OK') : chalk.red('FAILED')}`
    + (r.floors_sha256 ? `, floors ${r.floors_sha256.slice(0, 16)}` : ''));
  if (row.output_biocid) console.log(chalk.gray(`  biocid: ${row.output_biocid}`));
  if (row.registry_error) console.log(chalk.yellow(`  biocid registration: ${row.registry_error}`));
}

async function fetchStatus(jobId: string, signature: string): Promise<{ status: number; data: PackageRow }> {
  const resp = await axios.get<PackageRow>(`${BIOFS_NODE_BASE}/organ_package_status`, {
    params: { package_job_id: jobId },
    headers: { 'x-biofs-signature': signature },
    timeout: 30_000, validateStatus: (s) => s < 500,
  });
  return { status: resp.status, data: resp.data };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitForPackage(jobId: string, signature: string, quiet?: boolean): Promise<PackageRow | null> {
  const spin = quiet ? null : ora(`waiting for package job ${jobId} on the GPU executor ...`).start();
  // A wrong id or a job of another wallet fails at once. After the job has answered once, a dropped connection or an
  // error reply is retried for about 10 minutes (30 tries, 20 s apart) before the wait gives up.
  const first = await fetchStatus(jobId, signature);
  if (first.status >= 400) { spin?.fail(`organ_package_status ${first.status}: ${(first.data as any)?.error || 'unknown'}`); return null; }
  if (first.data.status === 'done' || first.data.status === 'error') {
    if (first.data.status === 'done') spin?.succeed('package job done');
    else spin?.fail(`package job error: ${first.data.error || first.data.result?.error || 'unknown'}`);
    return first.data;
  }
  const deadline = Date.now() + 3 * 60 * 60_000;   // 3 h ceiling
  let failures = 0;
  while (Date.now() < deadline) {
    await sleep(20_000);
    let status = 0; let data = {} as PackageRow; let problem = '';
    try {
      ({ status, data } = await fetchStatus(jobId, signature));
      if (status >= 400) problem = `organ_package_status ${status}: ${(data as any)?.error || 'unknown'}`;
    } catch (e: any) {
      problem = `organ_package_status unreachable: ${e?.message || e}`;
    }
    if (problem) {
      if (++failures >= 30) { spin?.fail(problem); return null; }
      if (spin) spin.text = `package job ${jobId}: ${problem}, retrying`;
      continue;
    }
    failures = 0;
    if (data.status === 'done' || data.status === 'error') {
      if (data.status === 'done') spin?.succeed('package job done');
      else spin?.fail(`package job error: ${data.error || data.result?.error || 'unknown'}`);
      return data;
    }
    if (spin) spin.text = `package job ${jobId}: ${data.status}`;
  }
  spin?.warn('wait timeout; the job may still be running. Check with: biofs imaging package-status ' + jobId);
  return null;
}

export async function imagingPackageCommand(registerJobId: string, options: ImagingPackageOptions = {}): Promise<string | null> {
  const quiet = !!(options.quiet || options.json);
  const fail = (msg: string): null => {
    if (!quiet) console.error(chalk.red(msg)); else Logger.error(msg);
    process.exitCode = 1;
    return null;
  };
  if (!REGISTER_ID_RE.test(String(registerJobId || ''))) return fail('give the id of a finished register job: register-<uuid>');
  const organs = parseOrgans(options.organs);
  if (organs !== undefined && organs.length === 0) return fail('--organs needs at least one organ name, comma separated (for example liver,spleen)');
  const spinner = quiet ? null : ora('biofs imaging package → biofs-node').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) { spinner?.fail('Not authenticated. Run: biofs login'); process.exitCode = 1; return null; }
    const body: Record<string, unknown> = {
      wallet: credentials.wallet_address,
      signature: credentials.user_signature,
      register_job_id: registerJobId,
      floors: options.floors !== false,
    };
    if (organs !== undefined) body.organs = organs;
    const resp = await axios.post<PackageRow & { error?: string }>(`${BIOFS_NODE_BASE}/submit_organ_package`, body,
      { timeout: 120_000, validateStatus: (s) => s < 500 });
    if (resp.status >= 400) {
      spinner?.fail(`submit_organ_package ${resp.status}: ${resp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(resp.data, null, 2));
      process.exitCode = 1;
      return null;
    }
    const sub = resp.data;
    spinner?.succeed(`package_job_id=${sub.package_job_id} (register ${sub.register_job_id}, gate ${sub.gate_verdict ?? '-'}, floors ${sub.floors === false ? 'off' : 'on'})`);
    if (!options.wait) {
      if (options.json) console.log(JSON.stringify(sub, null, 2));
      else if (!options.quiet) console.log(chalk.cyan(`  follow with: biofs imaging package-status ${sub.package_job_id} --wait`));
      return sub.package_job_id;
    }
    const row = await waitForPackage(sub.package_job_id, credentials.user_signature, quiet);
    if (row) { if (options.json) console.log(JSON.stringify(row, null, 2)); else if (!options.quiet) printPackageRow(row); }
    return sub.package_job_id;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`imaging package failed: ${msg}`);
    Logger.error(`imaging package failed: ${msg}`);
    process.exitCode = 1;
    return null;
  }
}

export async function imagingPackageStatusCommand(jobId: string, options: ImagingPackageStatusOptions = {}): Promise<PackageRow | null> {
  try {
    if (!PACKAGE_ID_RE.test(String(jobId || ''))) { console.error(chalk.red('give a package job id: package-<uuid>')); process.exitCode = 1; return null; }
    const credentials = await getCredentials();
    if (!credentials) { console.error('Not authenticated. Run: biofs login'); process.exitCode = 1; return null; }
    let row: PackageRow | null;
    if (options.wait) row = await waitForPackage(jobId, credentials.user_signature, options.quiet || options.json);
    else {
      const { status, data } = await fetchStatus(jobId, credentials.user_signature);
      if (status >= 400) { console.error(chalk.red(`organ_package_status ${status}: ${(data as any)?.error || 'unknown'}`)); process.exitCode = 1; return null; }
      row = data;
    }
    if (row) { if (options.json) console.log(JSON.stringify(row, null, 2)); else if (!options.quiet) printPackageRow(row); }
    return row;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    Logger.error(`imaging package-status failed: ${msg}`);
    process.exitCode = 1;
    return null;
  }
}
