/**
 * biofs interpret submit <biosample_serial>
 *
 * Agent 3 of the Cancer Digital Twin pipeline: hand the annotated context
 * (OpenCRAVAT SQLite + FHIR + multi-lab variants) to the GenoClaw interpreter,
 * which synthesizes the clinical narrative and renders the Cancer Digital Twin
 * report. Thin client over biofs-node POST /agent/interpret (which proxies the
 * genoclaw-api /interpret endpoint), mirroring `biofs annotate submit`.
 *
 *   biofs interpret submit TN25-336147 --package cancer_twin --wait
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface InterpretSubmitOptions {
  package?: string;        // cancer_twin (default) | rare_disease | pharmgx
  sqliteBiocid?: string;   // explicit annotated-sqlite override
  contextBiocids?: string; // comma list of extra context biocids
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
  paymentHeader?: string;  // X-PAYMENT (set by `x402 pipeline cancer-twin`)
}

interface SubmitResponse {
  interpret_job_id: string;
  status: string;
  report_biocid: string;
  report_gs_uri: string;
  report_url?: string;
  expected_runtime_min: number;
  error?: string;
}

interface StatusResponse {
  interpret_job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  report_biocid?: string;
  report_url?: string;
  report_gs_uri?: string;
  n_findings?: number;
  error?: string;
  inventory_registered?: boolean;
}

export async function interpretSubmitCommand(
  biosampleSerial: string,
  options: InterpretSubmitOptions = {},
): Promise<string | null> {
  const spinner = options.quiet || options.json ? null
    : ora(`biofs interpret submit ${biosampleSerial} → genoclaw-interpreter`).start();
  try {
    const credentials = await getCredentials();
    if (!credentials) {
      spinner?.fail('Not authenticated. Run: biofs login');
      process.exit(1);
    }
    const body: Record<string, unknown> = {
      biosample_serial: biosampleSerial,
      wallet: credentials.wallet_address,
      signature: credentials.user_signature,
      package: options.package || 'cancer_twin',
    };
    if (options.sqliteBiocid) body.sqlite_biocid = options.sqliteBiocid;
    if (options.contextBiocids) body.context_biocids = options.contextBiocids.split(',').map((s) => s.trim()).filter(Boolean);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.paymentHeader) headers['X-PAYMENT'] = options.paymentHeader;

    if (spinner) spinner.text = 'submitting to biofs-node /agent/interpret …';
    const submitResp = await axios.post<SubmitResponse>(
      `${BIOFS_NODE_BASE}/interpret`,
      body,
      { timeout: 60_000, headers, validateStatus: (s) => s < 500 },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`interpret ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const submit = submitResp.data;
    spinner?.succeed(`interpret_job_id=${submit.interpret_job_id}  report=${submit.report_gs_uri}`);

    if (options.json) {
      console.log(JSON.stringify(submit, null, 2));
    } else if (!options.quiet) {
      console.log(chalk.gray('  report biocid: ' + submit.report_biocid));
      if (submit.report_url) console.log(chalk.gray('  report url:    ' + submit.report_url));
      console.log(chalk.gray('  ETA: ' + submit.expected_runtime_min + ' min'));
    }

    if (options.wait) {
      const waitSpin = options.quiet ? null
        : ora(`waiting for interpretation (interpret_job_id=${submit.interpret_job_id}) …`).start();
      const deadline = Date.now() + 30 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10_000));
        const st = await axios.get<StatusResponse>(
          `${BIOFS_NODE_BASE}/interpret_status`,
          { params: { interpret_job_id: submit.interpret_job_id }, timeout: 30_000, validateStatus: (s) => s < 500 },
        );
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          waitSpin?.succeed(`interpretation done — ${row.n_findings ?? '?'} findings, report ${row.report_url || row.report_gs_uri}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.interpret_job_id;
        }
        if (row.status === 'failed') {
          waitSpin?.fail(`interpretation failed: ${row.error || 'no error reported'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.interpret_job_id;
        }
        if (waitSpin) waitSpin.text = `interpretation ${row.status} (interpret_job_id=${submit.interpret_job_id})`;
      }
      waitSpin?.warn('wait timeout — check with: biofs interpret status ' + submit.interpret_job_id);
    }

    return submit.interpret_job_id;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`interpret submit failed: ${msg}`);
    Logger.error(`interpret submit failed: ${msg}`);
    return null;
  }
}
