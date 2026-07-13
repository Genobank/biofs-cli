/**
 * biofs imaging compare — the "Image Time Machine" (slice-by-slice comparator).
 *
 * Register two timepoints of the same anatomy into ONE coordinate grid with RIGID
 * registration ONLY (no deformation -> a real new focal spot is never smeared away),
 * and emit three geometry-identical volumes (A = follow-up, B = baseline aligned
 * into A, diff = A - B) so the 2D viewer can blink / crossfade / diff each axial
 * slice. DICOM is biodata, so this is a biofs job dispatched through biofs-node
 * (CLAUDE.md): biofs-node recovers + verifies the wallet, runs the CPU engine via
 * api_imaging/compare_run, and registers biocid://…/imaging-compare/<job>.
 *
 * Unlike the deformable twin, one rigid transform cannot fit a flexing spine across
 * a whole abdomen+pelvis, so --region (with --zlo/--zhi) restricts the alignment to
 * one z-band (e.g. the pelvis), which a single rigid transform aligns tightly while
 * still preserving every focal spot. Decision-support, not a diagnosis.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface ImagingCompareOptions {
  baseline?: string;        // baseline studyUID (the earlier scan)
  baselineSeries?: string;
  followup?: string;        // follow-up studyUID (the later scan, the reference grid)
  followupSeries?: string;
  baselineLabel?: string;
  followupLabel?: string;
  anatomy?: string;
  region?: string;          // optional region label (e.g. "pelvis"); needs zlo/zhi
  zlo?: string;             // region z-fraction lower bound [0..1]
  zhi?: string;             // region z-fraction upper bound [0..1]
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

interface CompareSubmitResponse { compare_job_id?: string; status?: string; error?: string; }
interface CompareStatusResponse {
  compare_job_id: string; status: string; output_biocid?: string; output_gcs?: string;
  n_slices?: number; registration?: Record<string, any>; error?: string;
}

export async function imagingCompareCommand(options: ImagingCompareOptions = {}): Promise<string | null> {
  const spinner = options.quiet ? null : ora('biofs imaging compare → biofs-node (CPU)').start();
  try {
    if (!options.baseline || !options.baselineSeries || !options.followup || !options.followupSeries) {
      spinner?.fail('Need --baseline, --baseline-series, --followup, --followup-series (study + series UIDs).');
      process.exit(1);
    }
    if ((options.region || options.zlo || options.zhi) && !(options.zlo && options.zhi)) {
      spinner?.fail('A region needs both --zlo and --zhi (z-fractions, e.g. --region pelvis --zlo 0 --zhi 0.45).');
      process.exit(1);
    }
    const credentials = await getCredentials();
    if (!credentials) { spinner?.fail('Not authenticated. Run: biofs login'); process.exit(1); }

    const body: Record<string, unknown> = {
      wallet: credentials.wallet_address,
      signature: credentials.user_signature,
      baseline_study: options.baseline,
      baseline_series: options.baselineSeries,
      followup_study: options.followup,
      followup_series: options.followupSeries,
      baseline_label: options.baselineLabel || 'baseline',
      followup_label: options.followupLabel || 'follow-up',
      anatomy: options.anatomy || 'abdomen',
    };
    if (options.region && options.zlo && options.zhi) {
      body.region = options.region;
      body.zlo = parseFloat(options.zlo);
      body.zhi = parseFloat(options.zhi);
    }

    if (spinner) spinner.text = 'submitting to biofs-node /agent/submit_imaging_compare ...';
    const submitResp = await axios.post<CompareSubmitResponse>(
      `${BIOFS_NODE_BASE}/submit_imaging_compare`, body,
      { timeout: 60_000, validateStatus: (s) => s < 500 });
    if (submitResp.status >= 400) {
      spinner?.fail(`submit_imaging_compare ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const submit = submitResp.data;
    spinner?.succeed(`compare_job_id=${submit.compare_job_id}  (rigid registration, ~2-4 min)`);
    if (options.json && !options.wait) console.log(JSON.stringify(submit, null, 2));

    if (options.wait && submit.compare_job_id) {
      const waitSpin = options.quiet ? null
        : ora(`waiting for the comparator (compare_job_id=${submit.compare_job_id}) ...`).start();
      const deadline = Date.now() + 15 * 60_000;
      let pollErrs = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 12_000));
        let st;
        try {
          st = await axios.get<CompareStatusResponse>(
            `${BIOFS_NODE_BASE}/imaging_compare_status`,
            { params: { compare_job_id: submit.compare_job_id }, timeout: 30_000, validateStatus: (s) => s < 500 });
        } catch (e: any) {
          pollErrs++;
          if (waitSpin) waitSpin.text = `waiting (poll retry ${pollErrs}: ${e?.code || 'network'}) ...`;
          if (pollErrs >= 40) throw e;
          continue;
        }
        pollErrs = 0;
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          const reg = row.registration || {};
          waitSpin?.succeed(`compare done — biocid ${row.output_biocid || ''}`);
          if (!options.quiet) {
            console.log(chalk.gray(`  bone-Dice ${reg.bone_dice ?? '?'} (${reg.reliable ? 'reliable' : 'low'}), ${row.n_slices ?? '?'} slices`));
            console.log(chalk.gray(`  viewer: https://genobank.io/consent/biofile/compare/?job=${submit.compare_job_id}`));
          }
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.compare_job_id;
        }
        if (row.status === 'error') {
          waitSpin?.fail(`compare error: ${row.error || 'unknown'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.compare_job_id;
        }
        if (waitSpin) waitSpin.text = `compare ${row.status} (${submit.compare_job_id})`;
      }
      waitSpin?.warn('wait timeout — may still be running. Poll imaging_compare_status.');
    }
    return submit.compare_job_id || null;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`imaging compare failed: ${msg}`);
    Logger.error(`imaging compare failed: ${msg}`);
    return null;
  }
}
