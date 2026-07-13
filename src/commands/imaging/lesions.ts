/**
 * biofs imaging lesions — PER-LESION VOLUMETRIC TRACKING (true RECIST + volume doubling time).
 *
 * Segments candidate lesions INDEPENDENTLY at each timepoint with VISTA-3D (never seeded
 * from the density subtraction, so iso-attenuating growth is caught), rigidly co-registers
 * the timepoints, links the same lesion across them, and produces a per-lesion volume
 * trajectory -> RECIST 1.1 response (CR/PR/SD/PD, flagged candidate) + doubling time. GPU
 * job via biofs-node; drop-in imaging-compare/<job>/ artifact. Decision-support, not a
 * diagnosis. Reads StudyDate for the real day-axis; pass --treatment so a treated patient
 * is never auto-reassured.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface ImagingLesionsOptions {
  timepoints?: string;
  anatomy?: string;
  treatment?: string;
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

function parseTimepoints(raw: string): Array<{ label: string; study: string; series?: string }> {
  const s = raw.trim();
  if (s.startsWith('[')) {
    return JSON.parse(s).map((t: any, i: number) => ({
      label: String(t.label || `t${i}`), study: String(t.study), series: t.series ? String(t.series) : undefined,
    }));
  }
  return s.split(',').map((chunk, i) => {
    const parts = chunk.split(':');
    if (parts.length < 2) throw new Error(`timepoint "${chunk}" must be label:study[:series]`);
    return { label: parts[0] || `t${i}`, study: parts[1], series: parts[2] ? parts.slice(2).join(':') : undefined };
  });
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export async function imagingLesionsCommand(options: ImagingLesionsOptions = {}): Promise<string | null> {
  const spinner = options.quiet ? null : ora('biofs imaging lesions → biofs-node (GPU)').start();
  try {
    if (!options.timepoints) { spinner?.fail('--timepoints required (>=2, oldest→newest).'); process.exit(1); }
    let tps;
    try { tps = parseTimepoints(options.timepoints); }
    catch (e: any) { spinner?.fail(`--timepoints parse error: ${e.message}`); process.exit(1); }
    if (!tps || tps.length < 2 || tps.some((t) => !t.study)) {
      spinner?.fail('--timepoints needs >=2 entries, each with at least a study.'); process.exit(1);
    }
    const credentials = await getCredentials();
    if (!credentials) { spinner?.fail('Not authenticated. Run: biofs login'); process.exit(1); }

    if (spinner) spinner.text = 'submitting to biofs-node /agent/submit_imaging_lesions (starts a GPU executor) ...';
    const submitResp = await axios.post<{ compare_job_id?: string; status?: string; n_timepoints?: number; error?: string }>(
      `${BIOFS_NODE_BASE}/submit_imaging_lesions`,
      { wallet: credentials.wallet_address, signature: credentials.user_signature,
        anatomy: options.anatomy || 'chest', treatment_context: options.treatment || 'unknown', timepoints: tps },
      { timeout: 120_000, validateStatus: (s) => s < 500 },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`submit_imaging_lesions ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const job = submitResp.data.compare_job_id;
    spinner?.succeed(`compare_job_id=${job}  (${submitResp.data.n_timepoints} timepoints, VISTA-3D per timepoint, ~6-12 min)`);
    if (options.json && !options.wait) console.log(JSON.stringify(submitResp.data, null, 2));

    if (options.wait && job) {
      const waitSpin = options.quiet ? null : ora(`waiting for the lesion tracker (compare_job_id=${job}) ...`).start();
      const deadline = Date.now() + 60 * 60_000;
      let pollErrs = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15_000));
        let st;
        try {
          st = await axios.get<any>(`${BIOFS_NODE_BASE}/imaging_lesions_status`,
            { params: { lesions_job_id: job }, timeout: 30_000, validateStatus: (s) => s < 500 });
        } catch (e: any) {
          pollErrs++; if (waitSpin) waitSpin.text = `waiting (poll retry ${pollErrs}: ${e?.code || 'network'}) ...`;
          if (pollErrs >= 40) throw e; continue;
        }
        pollErrs = 0;
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          const r = (row.result || {});
          const rr = r.recist_response || {};
          waitSpin?.succeed(`lesion tracking done — biocid ${row.output_biocid || ''}`);
          if (!options.quiet) {
            console.log(chalk.gray(`  RECIST: ${rr.category} (assessable=${rr.response_assessable}) · targets ${(r.target_lesions||[]).length} · new ${(r.new_lesions||[]).length} · iso-attenuating ${(r.iso_attenuating_candidates||[]).length}`));
            console.log(chalk.gray(`  flagged candidate, radiologist confirmation required · ${(r.segmentation||{}).lesion_class_available ? 'lesion class available' : 'NO automated lesion class for this anatomy'}`));
          }
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return job;
        }
        if (row.status === 'error') {
          waitSpin?.fail(`lesion tracking error: ${row.error || 'unknown'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return job;
        }
        if (waitSpin) waitSpin.text = `lesion tracking ${row.status || 'running'} (compare_job_id=${job})`;
      }
      waitSpin?.warn('wait timeout — may still be running. Poll imaging_lesions_status.');
    }
    return job || null;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`imaging lesions failed: ${msg}`);
    Logger.error(`imaging lesions failed: ${msg}`);
    return null;
  }
}
