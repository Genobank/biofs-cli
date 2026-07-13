/**
 * biofs imaging attribute — organ-attribution cross-join for an Image Time Machine
 * comparison. Segments the compare job's reference CT (A.nii.gz) on the GPU and labels
 * every focal change in change_analysis.json with the anatomic organ it sits in, so the
 * imaging-radiology MCP can read "new 14mm focus in the right hepatic lobe".
 *
 * DICOM is biodata, so this is a biofs GPU job dispatched through biofs-node:
 *   1. POST /api_biofs_node/submit_imaging_attribute {wallet, signature, compare_job}
 *   2. (--wait) poll /api_biofs_node/imaging_attribute_status?attribute_job_id=...
 * Decision-support, not a diagnosis.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface ImagingAttributeOptions {
  compare?: string;
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export async function imagingAttributeCommand(options: ImagingAttributeOptions = {}): Promise<string | null> {
  const spinner = options.quiet ? null : ora('biofs imaging attribute → biofs-node (GPU)').start();
  try {
    const compareJob = String(options.compare || '').trim();
    if (!/^compare-[0-9A-Fa-f-]{8,64}$/.test(compareJob)) {
      spinner?.fail('--compare <compare_job_id> required (the id from `biofs imaging compare`).');
      process.exit(1);
    }
    const credentials = await getCredentials();
    if (!credentials) { spinner?.fail('Not authenticated. Run: biofs login'); process.exit(1); }

    if (spinner) spinner.text = 'submitting to biofs-node /agent/submit_imaging_attribute (starts a GPU executor) ...';
    const submitResp = await axios.post<{ attribute_job_id?: string; status?: string; error?: string }>(
      `${BIOFS_NODE_BASE}/submit_imaging_attribute`,
      { wallet: credentials.wallet_address, signature: credentials.user_signature, compare_job: compareJob },
      { timeout: 120_000, validateStatus: (s) => s < 500 },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`submit_imaging_attribute ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const submit = submitResp.data;
    spinner?.succeed(`attribute_job_id=${submit.attribute_job_id}  (GPU executor; segments the reference CT, ~3-8 min)`);
    if (options.json && !options.wait) console.log(JSON.stringify(submit, null, 2));

    if (options.wait && submit.attribute_job_id) {
      const waitSpin = options.quiet ? null
        : ora(`waiting for organ attribution (attribute_job_id=${submit.attribute_job_id}) ...`).start();
      const deadline = Date.now() + 45 * 60_000;
      let pollErrs = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15_000));
        let st;
        try {
          st = await axios.get<any>(`${BIOFS_NODE_BASE}/imaging_attribute_status`,
            { params: { attribute_job_id: submit.attribute_job_id }, timeout: 30_000, validateStatus: (s) => s < 500 });
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
          waitSpin?.succeed(`attribution done — biocid ${row.output_biocid || ''}`);
          if (!options.quiet) console.log(chalk.gray('  organ focus counts: ' + JSON.stringify(row.organ_focus_counts || {})));
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.attribute_job_id;
        }
        if (row.status === 'error') {
          waitSpin?.fail(`attribution error: ${row.error || 'unknown'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.attribute_job_id;
        }
        if (waitSpin) waitSpin.text = `attribution ${row.status} (attribute_job_id=${submit.attribute_job_id})`;
      }
      waitSpin?.warn('wait timeout — may still be running. Poll imaging_attribute_status.');
    }
    return submit.attribute_job_id || null;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`imaging attribute failed: ${msg}`);
    Logger.error(`imaging attribute failed: ${msg}`);
    return null;
  }
}
