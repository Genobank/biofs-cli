/**
 * biofs imaging findings — longitudinal CT PATHOGENIC-FINDINGS read (no volumes).
 *
 * Pairwise, baseline-forward, exactly the clinical "current vs prior": for 3 studies it
 * locks on study[0] and finds what changed in study[1], then re-baselines on study[1] and
 * finds what changed in study[2]. Per interval: rigid lock (SimpleITK Mattes-MI) -> detect
 * (VISTA-3D auto tumor-class, zero-shot) -> track (LesionLocator prev_mask propagation,
 * overlap fallback) -> classify new/enlarged/shrunk/resolved in RECIST long-axis mm ->
 * RECIST 1.1 response (CR/PR/SD/PD, diameter-based, no volume, no doubling time). GPU job
 * via biofs-node. Decision-support, NOT a diagnosis; every finding is a candidate for
 * radiologist confirmation, and detection is bounded to VISTA-3D's tumor classes.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface ImagingFindingsOptions {
  timepoints?: string;
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

export async function imagingFindingsCommand(options: ImagingFindingsOptions = {}): Promise<string | null> {
  const spinner = options.quiet ? null : ora('biofs imaging findings → biofs-node (GPU)').start();
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

    if (spinner) spinner.text = 'submitting to biofs-node /agent/submit_imaging_findings (starts a GPU executor) ...';
    const submitResp = await axios.post<{ findings_job_id?: string; status?: string; n_timepoints?: number; error?: string }>(
      `${BIOFS_NODE_BASE}/submit_imaging_findings`,
      { wallet: credentials.wallet_address, signature: credentials.user_signature,
        treatment_context: options.treatment || 'unknown', timepoints: tps },
      { timeout: 120_000, validateStatus: (s) => s < 500 },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`submit_imaging_findings ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const job = submitResp.data.findings_job_id;
    spinner?.succeed(`findings_job_id=${job}  (${submitResp.data.n_timepoints} timepoints, pairwise baseline-forward, ~8-15 min)`);
    if (options.json && !options.wait) console.log(JSON.stringify(submitResp.data, null, 2));

    if (options.wait && job) {
      const waitSpin = options.quiet ? null : ora(`waiting for the findings pipeline (findings_job_id=${job}) ...`).start();
      const deadline = Date.now() + 60 * 60_000;
      let pollErrs = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15_000));
        let st;
        try {
          st = await axios.get<any>(`${BIOFS_NODE_BASE}/imaging_findings_status`,
            { params: { findings_job_id: job }, timeout: 30_000, validateStatus: (s) => s < 500 });
        } catch (e: any) {
          pollErrs++; if (waitSpin) waitSpin.text = `waiting (poll retry ${pollErrs}: ${e?.code || 'network'}) ...`;
          if (pollErrs >= 40) throw e; continue;
        }
        pollErrs = 0;
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          const r = (row.result || {});
          waitSpin?.succeed(`findings done — biocid ${row.output_biocid || ''}`);
          if (!options.quiet) {
            console.log(chalk.gray(`  detector: ${r.detector || 'VISTA-3D auto'} · tracker: ${r.tracker || ''}`));
            console.log(chalk.gray(`  classes: ${(r.detected_classes || []).join(', ') || 'none'}${(r.dropped_classes||[]).length ? ' · dropped ' + r.dropped_classes.join(', ') : ''}`));
            for (const s of (r.interval_summaries || [])) console.log(chalk.gray(`  · ${s}`));
            console.log(chalk.gray('  decision-support, not a diagnosis; bounded to VISTA-3D tumor classes; confirm against the radiology read.'));
          }
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return job;
        }
        if (row.status === 'error') {
          waitSpin?.fail(`findings error: ${row.error || 'unknown'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return job;
        }
        if (waitSpin) waitSpin.text = `findings ${row.status || 'running'} (findings_job_id=${job})`;
      }
      waitSpin?.warn('wait timeout — may still be running. Poll imaging_findings_status.');
    }
    return job || null;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`imaging findings failed: ${msg}`);
    Logger.error(`imaging findings failed: ${msg}`);
    return null;
  }
}
