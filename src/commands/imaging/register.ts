/**
 * biofs imaging register | register-status
 *
 * Staged 3D registration of N CT timepoints into one reference frame, with a quality
 * gate, dispatched through biofs-node to the GPU executor. For every non-reference
 * timepoint the executor aligns coarse to fine: a rigid fit to the vertebrae segmented
 * consistently in both scans, rigid refinement on the vertebral column, then a piecewise
 * deformable stage in which the lungs, the viscera that move with the diaphragm (heart and
 * abdominal organs) and the rest of the body are registered separately, so organs can slide
 * against the rib cage. Each stage is
 * measured: surface distance of the whole spine, of each lung, of the liver and of the
 * spleen, per-structure Dice from TotalSegmentator masks,
 * vertebral landmark error, Jacobian folding, bone rigidity, and, with three or more
 * timepoints, agreement of A->B->C with A->C. The gate verdict (PASS, PASS_WITH_WARNINGS,
 * FAIL) is computed against thresholds written into the result, so a later lesion or
 * organ comparison knows how far the alignment can be trusted.
 *
 * biofs-node checks that every study belongs to the signer and picks each series by
 * comparability with the reference (axial, original, soft-tissue kernel, closest
 * thickness, same kernel family), recording why. Pass --series to override.
 *
 * Flow:
 *   POST /api_biofs_node/submit_imaging_register {signature, timepoints, reference, anatomy, protocol_mode}
 *   GET  /api_biofs_node/imaging_register_status?register_job_id=...  (owner signature in a header)
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface ImagingRegisterOptions {
  tp?: string[];
  series?: string[];
  reference?: string;
  anatomy?: string;
  protocolMode?: string;
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

export interface ImagingRegisterStatusOptions {
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

interface GateCheck { stage: string; metric: string; value: number | null; op: string; threshold: number; severity: string; pass: boolean | null; }
interface RegisterPair {
  pair: string; verdict: string; hard_failures?: string[]; warnings?: string[];
  deformable?: Record<string, number | null>;
}
interface RegisterResult {
  status?: string; schema?: string; output_gcs?: string; reference?: string; protocol_mode?: string;
  gate?: { verdict: string; by_pair?: Record<string, string>; note?: string };
  pairs?: RegisterPair[]; transitivity?: number | null; elapsed_sec?: number; error?: string;
}
interface RegisterRow {
  register_job_id: string; status: string; reference?: string; error?: string; output_biocid?: string;
  timepoints?: { label: string; study: string; study_date?: string; series: string; selection?: { description?: string; kernel?: string; thickness_mm?: number; rationale?: string[] } }[];
  result?: RegisterResult;
}

/** Parse repeated `label=value` options in the order given. */
function parsePairs(values: string[] | undefined, what: string): { label: string; value: string }[] {
  return (values || []).map((v) => {
    const i = v.indexOf('=');
    if (i <= 0 || i === v.length - 1) throw new Error(`${what} must be label=value (got "${v}")`);
    return { label: v.slice(0, i).trim(), value: v.slice(i + 1).trim() };
  });
}

function printRow(row: RegisterRow): void {
  console.log(chalk.bold(`register job ${row.register_job_id}: ${row.status}`));
  for (const t of row.timepoints || []) {
    const sel = t.selection || {};
    console.log(`  ${t.label.padEnd(10)} ${t.study_date || '????????'}  ${(sel.description || '').padEnd(26).slice(0, 26)} ${sel.kernel || ''} ${sel.thickness_mm ?? ''} mm`
      + (t.label === row.reference ? chalk.cyan('  (reference)') : ''));
  }
  const r = row.result;
  if (!r) return;
  if (r.error) { console.log(chalk.red(`  error: ${r.error}`)); return; }
  const verdict = r.gate?.verdict || '?';
  const color = verdict === 'PASS' ? chalk.green : verdict === 'FAIL' ? chalk.red : chalk.yellow;
  console.log(`  gate: ${color(verdict)}  protocol: ${r.protocol_mode}  transitivity Dice: ${r.transitivity ?? '-'}`);
  for (const p of r.pairs || []) {
    const d = p.deformable || {};
    const pc = p.verdict === 'PASS' ? chalk.green : p.verdict === 'FAIL' ? chalk.red : chalk.yellow;
    console.log(`  ${p.pair.padEnd(18)} ${pc(p.verdict.padEnd(18))} spine ${d.spine_assd_mm ?? '-'} mm (HD95 ${d.spine_hd95_mm ?? '-'})  `
      + `lungs Dice ${d.lung_dice_min ?? '-'}, HD95 ${d.lung_hd95_max_mm ?? '-'} mm  liver/spleen HD95 ${d.abdominal_organ_hd95_max_mm ?? '-'} mm  `
      + `heart ${d.heart_dice ?? '-'}  folds ${d.jacobian_fold_fraction ?? '-'}`);
    for (const h of p.hard_failures || []) console.log(chalk.red(`      fail: ${h}`));
    for (const w of p.warnings || []) console.log(chalk.yellow(`      warn: ${w}`));
  }
  if (r.gate?.note) console.log(chalk.yellow(`  ${r.gate.note}`));
  if (row.output_biocid) console.log(chalk.gray(`  biocid: ${row.output_biocid}`));
}

async function fetchStatus(jobId: string, signature: string): Promise<{ status: number; data: RegisterRow }> {
  const resp = await axios.get<RegisterRow>(`${BIOFS_NODE_BASE}/imaging_register_status`, {
    params: { register_job_id: jobId },
    headers: { 'x-biofs-signature': signature },
    timeout: 30_000, validateStatus: (s) => s < 500,
  });
  return { status: resp.status, data: resp.data };
}

async function waitFor(jobId: string, signature: string, quiet?: boolean): Promise<RegisterRow | null> {
  const spin = quiet ? null : ora(`waiting for register job ${jobId} on the GPU executor ...`).start();
  const deadline = Date.now() + 3 * 60 * 60_000;   // 3 h ceiling
  let failures = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20_000));
    let status: number; let data: RegisterRow;
    try {
      ({ status, data } = await fetchStatus(jobId, signature));
      failures = 0;
    } catch (e: any) {
      // a dropped connection during a long wait is not a job failure: keep retrying for about 10 minutes
      if (++failures >= 30) { spin?.fail(`imaging_register_status unreachable: ${e?.message || e}`); return null; }
      if (spin) spin.text = `register job ${jobId}: status unreachable (${e?.message || e}), retrying`;
      continue;
    }
    if (status >= 400) { spin?.fail(`imaging_register_status ${status}: ${(data as any)?.error || 'unknown'}`); return null; }
    if (data.status === 'done' || data.status === 'error') {
      if (data.status === 'done') spin?.succeed(`register job done: gate ${data.result?.gate?.verdict}`);
      else spin?.fail(`register job error: ${data.error || data.result?.error || 'unknown'}`);
      return data;
    }
    if (spin) spin.text = `register job ${jobId}: ${data.status}`;
  }
  spin?.warn('wait timeout; the job may still be running. Check with: biofs imaging register-status ' + jobId);
  return null;
}

export async function imagingRegisterCommand(options: ImagingRegisterOptions = {}): Promise<string | null> {
  const spinner = options.quiet || options.json ? null : ora('biofs imaging register → biofs-node').start();
  try {
    const tps = parsePairs(options.tp, '--tp');
    if (tps.length < 2) { spinner?.fail('give at least two timepoints: --tp <label>=<StudyInstanceUID or dicom biocid> (in time order)'); process.exit(1); }
    const series = new Map(parsePairs(options.series, '--series').map((s) => [s.label, s.value]));
    for (const l of series.keys()) if (!tps.some((t) => t.label === l)) throw new Error(`--series ${l}=... names no --tp label`);
    const credentials = await getCredentials();
    if (!credentials) { spinner?.fail('Not authenticated. Run: biofs login'); process.exit(1); }
    const body = {
      wallet: credentials.wallet_address,
      signature: credentials.user_signature,
      anatomy: options.anatomy || 'chest',
      reference: options.reference || tps[0].label,
      protocol_mode: options.protocolMode || 'auto',
      timepoints: tps.map((t) => ({ label: t.label, study: t.value, ...(series.get(t.label) ? { series: series.get(t.label) } : {}) })),
    };
    const resp = await axios.post<RegisterRow & { error?: string }>(`${BIOFS_NODE_BASE}/submit_imaging_register`, body,
      { timeout: 120_000, validateStatus: (s) => s < 500 });
    if (resp.status >= 400) {
      spinner?.fail(`submit_imaging_register ${resp.status}: ${resp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(resp.data, null, 2));
      return null;
    }
    const sub = resp.data;
    spinner?.succeed(`register_job_id=${sub.register_job_id} (${(sub.timepoints || []).length} timepoints, reference ${sub.reference})`);
    if (!options.json && !options.quiet) {
      for (const t of sub.timepoints || []) {
        const why = (t.selection?.rationale || []).join('; ');
        console.log(chalk.gray(`  ${t.label}: ${t.selection?.description} (${t.selection?.kernel}, ${t.selection?.thickness_mm} mm): ${why}`));
      }
    }
    if (!options.wait) {
      if (options.json) console.log(JSON.stringify(sub, null, 2));
      else if (!options.quiet) console.log(chalk.cyan(`  follow with: biofs imaging register-status ${sub.register_job_id} --wait`));
      return sub.register_job_id;
    }
    const row = await waitFor(sub.register_job_id, credentials.user_signature, options.quiet || options.json);
    if (row) { if (options.json) console.log(JSON.stringify(row, null, 2)); else if (!options.quiet) printRow(row); }
    return sub.register_job_id;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`imaging register failed: ${msg}`);
    Logger.error(`imaging register failed: ${msg}`);
    return null;
  }
}

export async function imagingRegisterStatusCommand(jobId: string, options: ImagingRegisterStatusOptions = {}): Promise<RegisterRow | null> {
  try {
    const credentials = await getCredentials();
    if (!credentials) { console.error('Not authenticated. Run: biofs login'); process.exit(1); }
    let row: RegisterRow | null;
    if (options.wait) row = await waitFor(jobId, credentials.user_signature, options.quiet || options.json);
    else {
      const { status, data } = await fetchStatus(jobId, credentials.user_signature);
      if (status >= 400) { console.error(chalk.red(`imaging_register_status ${status}: ${(data as any)?.error || 'unknown'}`)); return null; }
      row = data;
    }
    if (row) { if (options.json) console.log(JSON.stringify(row, null, 2)); else if (!options.quiet) printRow(row); }
    return row;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    Logger.error(`imaging register-status failed: ${msg}`);
    return null;
  }
}
