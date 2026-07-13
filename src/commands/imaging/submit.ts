/**
 * biofs imaging pull
 *
 * Pull a UCSF eUnity DICOM study into the patient's GenoBank vault via the
 * biofs protocol. DICOM is biodata, so acquisition is a biofs job dispatched
 * through biofs-node (CLAUDE.md 2026-06-19: biofs governs ANY biological
 * dataset, imaging included). The browser (web3-chrome MCP, ucsf_eunity_resolve_study)
 * resolves the short-lived eUnity download URL + /e JSESSIONID cookie + the
 * studyUID; this verb hands them to biofs-node, which streams the study
 * SERVER-SIDE into the vault + biorouter registry. The ~hundreds-of-MB study
 * never touches the client.
 *
 * Flow:
 *   1. POST /api_biofs_node/submit_imaging
 *      {wallet, signature, eunity_url, cookie, study_uid?, source?, force?}
 *   2. biofs-node dedupes (skip if already in vault unless --force), dispatches
 *      to the api_imaging eUnity executor, returns 202 with imaging_job_id.
 *   3. (--wait) poll /api_biofs_node/imaging_status?imaging_job_id=... until
 *      status ∈ {done, error, skipped}.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface ImagingPullOptions {
  eunityUrl?: string;
  cookie?: string;
  studyUid?: string;
  source?: string;
  force?: boolean;
  quiet?: boolean;
  json?: boolean;
  wait?: boolean;
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

interface ImagingSubmitResponse {
  imaging_job_id?: string;
  status?: string;
  upload_id?: string;
  study_uid?: string;
  note?: string;
  error?: string;
}

interface ImagingStatusResponse {
  imaging_job_id: string;
  status: string;
  study_uid?: string;
  num_instances?: number;
  num_series?: number;
  description?: string;
  modality?: string;
  biocid?: string;
  error?: string;
}

export async function imagingPullCommand(options: ImagingPullOptions = {}): Promise<string | null> {
  const spinner = options.quiet ? null : ora('biofs imaging pull → biofs-node').start();
  try {
    if (!options.eunityUrl || !options.cookie) {
      spinner?.fail('--eunity-url and --cookie are required (resolve them with the web3-chrome MCP ucsf_eunity_resolve_study tool).');
      process.exit(1);
    }
    const credentials = await getCredentials();
    if (!credentials) {
      spinner?.fail('Not authenticated. Run: biofs login');
      process.exit(1);
    }

    const body: Record<string, unknown> = {
      wallet:     credentials.wallet_address,
      signature:  credentials.user_signature,
      eunity_url: options.eunityUrl,
      cookie:     options.cookie,
      study_uid:  options.studyUid,
      source:     options.source || 'eunity-mychart',
      force:      !!options.force,
    };

    if (spinner) spinner.text = 'submitting to biofs-node /agent/submit_imaging ...';
    if (process.env.BIOFS_DEBUG) {
      // never log the full cookie/signature
      process.stderr.write(`[debug] POST ${BIOFS_NODE_BASE}/submit_imaging study=${options.studyUid || '?'}\n`);
    }
    const submitResp = await axios.post<ImagingSubmitResponse>(
      `${BIOFS_NODE_BASE}/submit_imaging`,
      body,
      { timeout: 60_000, validateStatus: (s) => s < 500 },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`submit_imaging ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const submit = submitResp.data;

    if (submit.status === 'skipped') {
      spinner?.succeed(`already in vault — study ${submit.study_uid} skipped (pass --force to re-pull)`);
      if (options.json) console.log(JSON.stringify(submit, null, 2));
      return submit.imaging_job_id || null;
    }
    spinner?.succeed(`imaging_job_id=${submit.imaging_job_id}  study=${submit.study_uid}`);
    // When --wait is set, emit only the terminal status JSON below (one object on
    // stdout), so a caller (the MCP) can JSON.parse stdout directly.
    if (options.json && !options.wait) console.log(JSON.stringify(submit, null, 2));

    if (options.wait && submit.imaging_job_id) {
      const waitSpin = options.quiet ? null
        : ora(`waiting for server-side ingest (imaging_job_id=${submit.imaging_job_id}) ...`).start();
      const deadline = Date.now() + 30 * 60_000;   // 30 min max
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5_000));
        const st = await axios.get<ImagingStatusResponse>(
          `${BIOFS_NODE_BASE}/imaging_status`,
          { params: { imaging_job_id: submit.imaging_job_id }, timeout: 30_000, validateStatus: (s) => s < 500 },
        );
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          waitSpin?.succeed(`ingest done — ${row.num_instances ?? '?'} images / ${row.num_series ?? '?'} series (${row.description || ''})`);
          if (!options.quiet && row.biocid) console.log(chalk.gray('  biocid: ' + row.biocid));
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.imaging_job_id;
        }
        if (row.status === 'error') {
          waitSpin?.fail(`ingest error: ${row.error || 'unknown'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.imaging_job_id;
        }
        if (waitSpin) waitSpin.text = `ingest ${row.status} (imaging_job_id=${submit.imaging_job_id})`;
      }
      waitSpin?.warn('wait timeout — ingest may still be running. Check imaging_status with the imaging_job_id.');
    }

    return submit.imaging_job_id || null;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`imaging pull failed: ${msg}`);
    Logger.error(`imaging pull failed: ${msg}`);
    return null;
  }
}
