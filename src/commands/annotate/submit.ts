/**
 * biofs annotate submit <biosample_serial>
 *
 * v3.6 — repointed to biofs-node v0.4 (BioRouter-compliant CRAVAT). The OC
 * sqlite now lands directly in a per-biowallet GCS path under the lab's
 * genovault bucket, and is registered as a derivative in bioroutes.inventory.
 *
 * Flow:
 *   1. POST /api_biofs_node/submit_cravat with {biosample_serial, signature, package}
 *   2. biofs-node resolves the latest VCF for the serial from inventory,
 *      pre-allocates the sqlite GCS path + biocid, spawns the OC worker
 *      container, and returns 202 with oc_job_id.
 *   3. (Optional --wait) poll /api_biofs_node/cravat_status?oc_job_id=...
 *      until status ∈ {done, failed}.
 *
 * The CLI surface is identical to v3.5: `biofs annotate submit <serial>` plus
 * the same options (--package, --wait). The backend swap is transparent to
 * orchestrators that subprocess this verb.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface AnnotateSubmitOptions {
  vcfPath?: string;   // legacy; ignored (biofs-node resolves from inventory)
  vcfUri?: string;    // explicit gs:// override; passes through as vcf_gs_uri
  annotators?: string;
  assembly?: string;
  quiet?: boolean;
  json?: boolean;
  wait?: boolean;
  package?: string;
  phenotype?: string;
  maxAf?: string;
}

// biofs-node v0.4 reachable via nginx proxy at /api_biofs_node/* on
// genobank.app, or directly at http://localhost:8787/agent/* in-VM (when
// the orchestrator subprocess-invokes this verb on prod).
const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

interface SubmitResponse {
  oc_job_id: string;
  status: string;
  sqlite_biocid: string;
  sqlite_biocid_key: string;
  output_gs_uri: string;
  expected_runtime_min: number;
  error?: string;
}

interface StatusResponse {
  oc_job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  sqlite_size_bytes?: number;
  n_variants?: number;
  exit_code?: number;
  error?: string;
  inventory_registered?: boolean;
  sqlite_biocid?: string;
  dest_gs_uri?: string;
}

export async function annotateSubmitCommand(
  biosampleSerial: string,
  options: AnnotateSubmitOptions = {}
): Promise<string | null> {
  const spinner = options.quiet ? null
    : ora(`biofs annotate submit ${biosampleSerial} → biofs-node v0.4`).start();
  try {
    const credentials = await getCredentials();
    if (!credentials) {
      spinner?.fail('Not authenticated. Run: biofs login');
      process.exit(1);
    }

    const pkg = options.package || 'wes_default';
    const body: Record<string, unknown> = {
      biosample_serial: biosampleSerial,
      wallet:           credentials.wallet_address,
      signature:        credentials.user_signature,
      package:          pkg,
      max_af:           options.maxAf || '0.01',
    };
    if (options.vcfUri) body.vcf_gs_uri = options.vcfUri;

    if (spinner) spinner.text = 'submitting to biofs-node /agent/submit_cravat ...';
    if (process.env.BIOFS_DEBUG) {
      process.stderr.write(`[debug] POST ${BIOFS_NODE_BASE}/submit_cravat\n[debug] body=${JSON.stringify(body).slice(0,200)}\n`);
    }
    const submitResp = await axios.post<SubmitResponse>(
      `${BIOFS_NODE_BASE}/submit_cravat`,
      body,
      { timeout: 60_000, validateStatus: (s) => s < 500 },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`submit_cravat ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const submit = submitResp.data;
    spinner?.succeed(`oc_job_id=${submit.oc_job_id}  sqlite=${submit.output_gs_uri}`);

    if (options.json) {
      console.log(JSON.stringify(submit, null, 2));
    } else if (!options.quiet) {
      console.log(chalk.gray('  pre-allocated biocid: ' + submit.sqlite_biocid));
      console.log(chalk.gray('  pre-allocated key:    ' + submit.sqlite_biocid_key.slice(0, 18) + '…'));
      console.log(chalk.gray('  ETA: ' + submit.expected_runtime_min + ' min'));
    }

    if (options.wait) {
      const waitSpin = options.quiet ? null
        : ora(`waiting for OC to finish (oc_job_id=${submit.oc_job_id}) ...`).start();
      const deadline = Date.now() + 90 * 60_000;   // 90 min max
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15_000));
        const st = await axios.get<StatusResponse>(
          `${BIOFS_NODE_BASE}/cravat_status`,
          {
            params: { oc_job_id: submit.oc_job_id },
            timeout: 30_000,
            validateStatus: (s) => s < 500,
          },
        );
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          waitSpin?.succeed(`OC done — sqlite ${row.sqlite_size_bytes ?? '?'} bytes, ${row.n_variants ?? '?'} variants annotated`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.oc_job_id;
        }
        if (row.status === 'failed') {
          waitSpin?.fail(`OC failed (exit_code=${row.exit_code}): ${row.error || 'no error reported'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.oc_job_id;
        }
        if (waitSpin) waitSpin.text = `OC ${row.status} (oc_job_id=${submit.oc_job_id})`;
      }
      waitSpin?.warn('wait timeout — job may still be running. Check with: biofs annotate status ' + submit.oc_job_id);
    }

    return submit.oc_job_id;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`annotate submit failed: ${msg}`);
    Logger.error(`annotate submit failed: ${msg}`);
    return null;
  }
}
