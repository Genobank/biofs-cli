/**
 * biofs onramp huggingface
 *
 * Pull a gated Hugging Face dataset SERVER-SIDE into BioRouter. Genomic bytes
 * never touch the laptop. The node streams each object to
 * gs://genobank-biorouter/biorouter/<owner>/<biodata_type>/<hf-oid-12>/<dataset>
 * and registers biorouter.biocid_registry + bioroutes.inventory with a
 * legitimate owner_wallet (custodian biowallet, claimable by the family).
 *
 * Auth: operator (or the owner) signs "I want to proceed". The owner wallet is
 * the data-subject/custodian, not the operator.
 *
 *   BIOFS_PROFILE=mva-custodian biofs login --wallet 0x… --signature 0x…
 *   biofs onramp huggingface \
 *     --repo SageBio/mva-hackathon-2026-data \
 *     --owner 0x9786… \
 *     --serial EX2312012 \
 *     --case-id MV26-000001 \
 *     --wait
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface HfOnrampOptions {
  repo: string;
  owner: string;
  serial: string;
  caseId?: string;
  originlab?: string;
  hfToken?: string;
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

interface SubmitResponse {
  onramp_job_id?: string;
  status?: string;
  error?: string;
}

interface StatusResponse {
  onramp_job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | string;
  files?: Array<{
    filename: string;
    biodata_type: string;
    biocid: string;
    gs_uri: string;
    size_bytes?: number;
  }>;
  error?: string;
  n_files?: number;
}

export async function hfOnrampCommand(options: HfOnrampOptions): Promise<string | null> {
  const spinner = options.quiet || options.json ? null
    : ora('biofs onramp huggingface → biofs-node').start();
  try {
    if (!options.repo || !options.owner || !options.serial) {
      spinner?.fail('--repo, --owner and --serial are required');
      process.exit(1);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(options.owner)) {
      spinner?.fail('--owner must be an EIP-55 biowallet');
      process.exit(1);
    }
    if (!options.serial.trim() || options.serial.toUpperCase() === 'UNKNOWN') {
      spinner?.fail('--serial is required and must be a real biosample serial (never UNKNOWN)');
      process.exit(1);
    }
    const credentials = await getCredentials();
    if (!credentials) {
      spinner?.fail('Not authenticated. Run: biofs login --wallet <addr> --signature <sig>');
      process.exit(1);
    }
    const token = options.hfToken || process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || '';
    if (!token) {
      spinner?.fail('HF_TOKEN (or --hf-token) is required. Create a read token at huggingface.co/settings/tokens');
      process.exit(1);
    }

    const body: Record<string, unknown> = {
      wallet: credentials.wallet_address,
      signature: credentials.user_signature,
      owner: options.owner,
      repo: options.repo,
      serial: options.serial.trim(),
      case_id: options.caseId || 'MV26-000001',
      originlab: options.originlab || 'mva-hackathon',
      hf_token: token,
    };

    if (spinner) spinner.text = 'submitting to biofs-node /agent/submit_hf_onramp ...';
    const submitResp = await axios.post<SubmitResponse>(
      `${BIOFS_NODE_BASE}/submit_hf_onramp`,
      body,
      { timeout: 60_000, validateStatus: (s) => s < 500 },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`submit_hf_onramp ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const submit = submitResp.data;
    spinner?.succeed(`onramp_job_id=${submit.onramp_job_id} status=${submit.status}`);
    if (options.json && !options.wait) console.log(JSON.stringify(submit, null, 2));

    if (options.wait && submit.onramp_job_id) {
      const waitSpin = options.quiet ? null
        : ora(`waiting for server-side on-ramp (${submit.onramp_job_id}) ...`).start();
      const deadline = Date.now() + 6 * 60 * 60_000; // 6h: 85 GB stream from HF → GCS
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15_000));
        const st = await axios.get<StatusResponse>(
          `${BIOFS_NODE_BASE}/hf_onramp_status`,
          { params: { onramp_job_id: submit.onramp_job_id }, timeout: 30_000, validateStatus: (s) => s < 500 },
        );
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          waitSpin?.succeed(`on-ramp done — ${row.n_files ?? (row.files || []).length} files registered`);
          if (!options.quiet && row.files) {
            for (const f of row.files) {
              console.log(chalk.gray(`  ${f.biocid}`));
            }
          }
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.onramp_job_id;
        }
        if (row.status === 'failed') {
          waitSpin?.fail(`on-ramp error: ${row.error || 'unknown'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.onramp_job_id;
        }
        if (waitSpin) waitSpin.text = `on-ramp ${row.status} files=${row.n_files ?? '?'} (${submit.onramp_job_id})`;
      }
      waitSpin?.warn('wait timeout — ingest may still be running. Poll hf_onramp_status with the onramp_job_id.');
    }
    return submit.onramp_job_id || null;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`huggingface on-ramp failed: ${msg}`);
    Logger.error(`huggingface on-ramp failed: ${msg}`);
    return null;
  }
}
