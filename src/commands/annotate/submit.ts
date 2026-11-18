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
import { signedHeaders } from './signed_headers';
import { Logger } from '../../lib/utils/logger';

export interface AnnotateSubmitOptions {
  vcfPath?: string;   // legacy; ignored (biofs-node resolves from inventory)
  vcfUri?: string;    // explicit gs:// override; passes through as vcf_gs_uri (discouraged: biodata is named by biocid)
  vcfBiocid?: string; // the input named by its biocid; biofs-node resolves it through biocid_registry
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

const BIOCID_RE = /^biocid:\/\/[A-Za-z0-9_-]+\/0x[0-9a-fA-F]{40}\/[A-Za-z0-9_-]+\/\S+$/;

/** The request body. Exactly one way to name the input: a sample serial, or a biocid (never a storage path). */
export function buildAnnotateBody(biosampleSerial: string | undefined, options: AnnotateSubmitOptions, wallet: string, signature: string): Record<string, unknown> {
  if (options.vcfBiocid && !BIOCID_RE.test(options.vcfBiocid)) throw new Error(`--vcf-biocid is not a biocid (a gs:// path, URL or file name is never accepted): ${options.vcfBiocid}`);
  if (!biosampleSerial && !options.vcfBiocid) throw new Error('give a sample serial or --vcf-biocid');
  if (options.vcfBiocid && options.vcfUri) throw new Error('give --vcf-biocid or --vcf-uri, not both');
  const body: Record<string, unknown> = {
    wallet, signature, package: options.package || 'wes_default', max_af: options.maxAf || '0.01',
  };
  if (options.annotators) {
    // a chosen annotator set runs as package=custom (the worker reads ANNOTATOR_LIST only for that package); the option used to be accepted and dropped
    const names = String(options.annotators).split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    const bad = names.find((n) => !/^[a-z0-9_]{2,40}$/.test(n));
    if (!names.length) throw new Error('--annotators: give at least one annotator module name');
    if (bad) throw new Error(`--annotators: not an annotator module name: ${bad.slice(0, 60)}`);
    if (new Set(names).size !== names.length) throw new Error('--annotators: duplicate annotator');
    if (options.package && !['custom', 'rare_coding'].includes(options.package)) throw new Error(`--annotators runs as package custom; it cannot be combined with --package ${options.package}`);
    body.package = 'custom';
    body.annotator_list = names.join(' ');
  }
  if (biosampleSerial) body.biosample_serial = biosampleSerial;
  if (options.vcfBiocid) body.vcf_biocid = options.vcfBiocid;
  if (options.vcfUri) body.vcf_gs_uri = options.vcfUri;
  return body;
}

export async function annotateSubmitCommand(
  biosampleSerial: string | undefined,
  options: AnnotateSubmitOptions = {}
): Promise<string | null> {
  const spinner = options.quiet ? null
    : ora(`biofs annotate submit ${biosampleSerial || options.vcfBiocid} → biofs-node v0.4`).start();
  try {
    const credentials = await getCredentials();
    if (!credentials) {
      spinner?.fail('Not authenticated. Run: biofs login');
      process.exit(1);
    }

    const body = buildAnnotateBody(biosampleSerial, options, credentials.wallet_address, credentials.user_signature);

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
    spinner?.succeed(`oc_job_id=${submit.oc_job_id}  sqlite=${submit.sqlite_biocid}`);

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
            headers: signedHeaders(credentials),
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
