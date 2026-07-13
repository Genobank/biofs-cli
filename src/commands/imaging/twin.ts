/**
 * biofs imaging twin — the "3D Organ TimeMachine".
 *
 * Submit a longitudinal CT imaging-twin job: register two timepoints of the same
 * anatomy into one space, segment organs, and compute per-organ / per-voxel change
 * (volumes, Jacobian growth/shrink, delta-radiomics, meshes). DICOM is biodata, so
 * this is a biofs GPU job dispatched through biofs-node (CLAUDE.md 2026-06-20):
 * biofs-node resolves the baseline/followup studies by biocid:// (biorouter),
 * starts/stops the GPU executor, runs the imaging container, and registers the
 * result as biocid://…/imaging-twin. Decision-support, not diagnosis.
 *
 * Inputs are biocid-addressed: --baseline / --followup accept a biocid
 * (biocid://genobank/<wallet>/dicom/<studyUID>) OR a bare studyUID (biofs-node
 * resolves/ mints the dicom biocid). Flow:
 *   1. POST /api_biofs_node/submit_imaging_twin {wallet, signature, anatomy,
 *      baseline, followup, baseline_series?, followup_series?}
 *   2. (--wait) poll /api_biofs_node/imaging_twin_status?twin_job_id=... until done.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface ImagingTwinOptions {
  anatomy?: string;
  baseline?: string;
  followup?: string;
  baselineSeries?: string;
  followupSeries?: string;
  // N-timepoint: a JSON array of {label, study, series} (ordered; first = reference),
  // or the shorthand "label:study:series,label:study:series,...". When given, it
  // supersedes --baseline/--followup. >=2 timepoints required.
  timepoints?: string;
  // "deformable" (default, SyNRA + Jacobian) or "rigid" (strict 6-DOF, spot-faithful;
  // each organ mesh is an exact isometry resampled into the reference grid).
  registration?: string;
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

function parseTimepoints(raw: string): Array<{ label: string; study: string; series: string }> {
  const s = raw.trim();
  if (s.startsWith('[')) {
    const arr = JSON.parse(s);
    return arr.map((t: any, i: number) => ({
      label: String(t.label || `t${i}`), study: String(t.study), series: String(t.series),
    }));
  }
  // shorthand: label:study:series,label:study:series
  return s.split(',').map((chunk, i) => {
    const parts = chunk.split(':');
    if (parts.length < 3) throw new Error(`timepoint "${chunk}" must be label:study:series`);
    return { label: parts[0] || `t${i}`, study: parts[1], series: parts.slice(2).join(':') };
  });
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

interface TwinSubmitResponse {
  twin_job_id?: string;
  status?: string;
  baseline_biocid?: string;
  followup_biocid?: string;
  error?: string;
}

interface TwinStatusResponse {
  twin_job_id: string;
  status: string;
  anatomy?: string;
  output_biocid?: string;
  output_gcs?: string;
  organ_volumes?: Record<string, any>;
  registration_qc_dice?: Record<string, any>;
  resection_bed_flag?: Record<string, any>;
  elapsed_sec?: number;
  error?: string;
}

export async function imagingTwinCommand(options: ImagingTwinOptions = {}): Promise<string | null> {
  const spinner = options.quiet ? null : ora('biofs imaging twin → biofs-node (GPU)').start();
  try {
    let tps: Array<{ label: string; study: string; series: string }> | null = null;
    if (options.timepoints) {
      try { tps = parseTimepoints(options.timepoints); }
      catch (e: any) { spinner?.fail(`--timepoints parse error: ${e.message}`); process.exit(1); }
      if (!tps || tps.length < 2 || tps.some((t) => !t.study || !t.series)) {
        spinner?.fail('--timepoints needs >=2 entries, each with study + series.');
        process.exit(1);
      }
    } else if (!options.baseline || !options.followup) {
      spinner?.fail('Provide --timepoints, or both --baseline and --followup (a biocid://…/dicom/<studyUID> or a studyUID).');
      process.exit(1);
    }
    const credentials = await getCredentials();
    if (!credentials) {
      spinner?.fail('Not authenticated. Run: biofs login');
      process.exit(1);
    }

    const reg = (options.registration || 'deformable').toLowerCase();
    if (reg !== 'deformable' && reg !== 'rigid') {
      spinner?.fail("--registration must be 'deformable' or 'rigid'."); process.exit(1);
    }
    const body: Record<string, unknown> = {
      wallet:    credentials.wallet_address,
      signature: credentials.user_signature,
      anatomy:   options.anatomy || 'abdomen',
      registration: reg,
    };
    if (tps) {
      body.timepoints = tps;                       // N-timepoint path
      body.baseline = tps[0].study;                // back-compat hints for biofs-node resolution
      body.followup = tps[tps.length - 1].study;
    } else {
      body.baseline = options.baseline;
      body.followup = options.followup;
      if (options.baselineSeries) body.baseline_series = options.baselineSeries;
      if (options.followupSeries) body.followup_series = options.followupSeries;
    }

    if (spinner) spinner.text = 'submitting to biofs-node /agent/submit_imaging_twin (starts a GPU executor) ...';
    const submitResp = await axios.post<TwinSubmitResponse>(
      `${BIOFS_NODE_BASE}/submit_imaging_twin`,
      body,
      { timeout: 120_000, validateStatus: (s) => s < 500 },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`submit_imaging_twin ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const submit = submitResp.data;
    spinner?.succeed(`twin_job_id=${submit.twin_job_id}  (GPU executor starting; ~5-15 min cold)`);
    if (options.json && !options.wait) console.log(JSON.stringify(submit, null, 2));

    if (options.wait && submit.twin_job_id) {
      const waitSpin = options.quiet ? null
        : ora(`waiting for the GPU pipeline (twin_job_id=${submit.twin_job_id}) ...`).start();
      const deadline = Date.now() + 60 * 60_000;   // 60 min max (cold GPU + seg + reg)
      let pollErrs = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15_000));
        let st;
        try {
          st = await axios.get<TwinStatusResponse>(
            `${BIOFS_NODE_BASE}/imaging_twin_status`,
            { params: { twin_job_id: submit.twin_job_id }, timeout: 30_000, validateStatus: (s) => s < 500 },
          );
        } catch (e: any) {
          // A transient poll-connection error (ETIMEDOUT / ECONNRESET / socket hang up)
          // must NOT abort the wait — the GPU job keeps running server-side, and the
          // status route finalizes the biocid on the next successful poll. Retry.
          pollErrs++;
          if (waitSpin) waitSpin.text = `waiting (poll retry ${pollErrs}: ${e?.code || 'network'}) ...`;
          if (pollErrs >= 40) throw e;   // ~10 min of unbroken failures -> give up
          continue;
        }
        pollErrs = 0;
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          waitSpin?.succeed(`twin done in ${row.elapsed_sec ?? '?'}s — biocid ${row.output_biocid || ''}`);
          if (!options.quiet) {
            const qc = row.registration_qc_dice || {};
            console.log(chalk.gray('  registration QC (Dice): ' + JSON.stringify(qc)));
            console.log(chalk.gray('  output: ' + (row.output_gcs || row.output_biocid || '')));
          }
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.twin_job_id;
        }
        if (row.status === 'error') {
          waitSpin?.fail(`twin error: ${row.error || 'unknown'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.twin_job_id;
        }
        if (waitSpin) waitSpin.text = `twin ${row.status} (twin_job_id=${submit.twin_job_id})`;
      }
      waitSpin?.warn('wait timeout — pipeline may still be running. Poll imaging_twin_status.');
    }

    return submit.twin_job_id || null;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`imaging twin failed: ${msg}`);
    Logger.error(`imaging twin failed: ${msg}`);
    return null;
  }
}
