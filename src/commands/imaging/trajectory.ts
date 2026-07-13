/**
 * biofs imaging trajectory — 3-timepoint per-voxel TRAJECTORY classifier.
 *
 * Rigidly co-registers >=3 CT timepoints into the NEWEST grid and classifies every
 * voxel by the PATTERN of its trajectory across both intervals:
 *   persistent_progression (up,up) / persistent_regression (down,down) /
 *   transient (sign disagreement = breathing, positioning, fluid, contrast) / stable.
 * Persistence (consistent direction across BOTH intervals) is the filter that removes
 * the motion false-positives a single pairwise subtraction cannot. CPU job via
 * biofs-node -> api_imaging trajectory_run; writes a drop-in imaging-compare/<job>/
 * artifact, so the 2D/3D viewers, the radiology MCP, organ attribution and the HTML
 * report all consume it unchanged. Decision-support, not a diagnosis.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface ImagingTrajectoryOptions {
  timepoints?: string;            // JSON [{label,study,series}] or "label:study:series,..." (oldest -> newest)
  anatomy?: string;
  thrHu?: string;
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

export async function imagingTrajectoryCommand(options: ImagingTrajectoryOptions = {}): Promise<string | null> {
  const spinner = options.quiet ? null : ora('biofs imaging trajectory → biofs-node (CPU)').start();
  try {
    if (!options.timepoints) { spinner?.fail('--timepoints required (>=3, oldest→newest).'); process.exit(1); }
    let tps;
    try { tps = parseTimepoints(options.timepoints); }
    catch (e: any) { spinner?.fail(`--timepoints parse error: ${e.message}`); process.exit(1); }
    if (!tps || tps.length < 3 || tps.some((t) => !t.study)) {
      spinner?.fail('--timepoints needs >=3 entries, each with at least a study (series auto-resolved).'); process.exit(1);
    }
    const credentials = await getCredentials();
    if (!credentials) { spinner?.fail('Not authenticated. Run: biofs login'); process.exit(1); }

    if (spinner) spinner.text = 'submitting to biofs-node /agent/submit_imaging_trajectory ...';
    const submitResp = await axios.post<{ compare_job_id?: string; status?: string; n_timepoints?: number; error?: string }>(
      `${BIOFS_NODE_BASE}/submit_imaging_trajectory`,
      { wallet: credentials.wallet_address, signature: credentials.user_signature,
        anatomy: options.anatomy || 'chest', timepoints: tps,
        thr_hu: options.thrHu ? Number(options.thrHu) : undefined },
      { timeout: 120_000, validateStatus: (s) => s < 500 },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`submit_imaging_trajectory ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const job = submitResp.data.compare_job_id;
    spinner?.succeed(`compare_job_id=${job}  (${submitResp.data.n_timepoints} timepoints, rigid star registration, ~2-6 min)`);
    if (options.json && !options.wait) console.log(JSON.stringify(submitResp.data, null, 2));

    if (options.wait && job) {
      const waitSpin = options.quiet ? null : ora(`waiting for the trajectory classifier (compare_job_id=${job}) ...`).start();
      const deadline = Date.now() + 45 * 60_000;
      let pollErrs = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 12_000));
        let st;
        try {
          st = await axios.get<any>(`${BIOFS_NODE_BASE}/imaging_compare_status`,
            { params: { compare_job_id: job }, timeout: 30_000, validateStatus: (s) => s < 500 });
        } catch (e: any) {
          pollErrs++; if (waitSpin) waitSpin.text = `waiting (poll retry ${pollErrs}: ${e?.code || 'network'}) ...`;
          if (pollErrs >= 40) throw e; continue;
        }
        pollErrs = 0;
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          const cs = (row.result && row.result.change_summary) || {};
          waitSpin?.succeed(`trajectory done — biocid ${row.output_biocid || ''}`);
          if (!options.quiet) {
            console.log(chalk.gray(`  persistent: ${cs.n_persistent_progression ?? '?'} progression / ${cs.n_persistent_regression ?? '?'} regression`));
            console.log(chalk.gray(`  transient-significant: ${cs.n_transient_significant ?? '?'} · regional motion burden ${cs.regional_change_burden_ml ?? '?'} mL · thr ${cs.change_hu_threshold ?? '?'} HU`));
            console.log(chalk.gray(`  viewer: https://genobank.io/consent/biofile/compare/3d/?job=${job}`));
          }
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return job;
        }
        if (row.status === 'error') {
          waitSpin?.fail(`trajectory error: ${row.error || 'unknown'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return job;
        }
        if (waitSpin) waitSpin.text = `trajectory ${row.status || 'running'} (compare_job_id=${job})`;
      }
      waitSpin?.warn('wait timeout — may still be running. Poll imaging_compare_status.');
    }
    return job || null;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`imaging trajectory failed: ${msg}`);
    Logger.error(`imaging trajectory failed: ${msg}`);
    return null;
  }
}
