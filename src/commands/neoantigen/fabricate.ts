/**
 * biofs neoantigen fabricate-cassette <biosample_serial>
 *
 * Submits a cassette fabrication job to biofs-node /agent/cassette (mode=fabricate).
 * Polls /agent/cassette_status until done when --wait is set.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface NeoantigenFabricateOptions {
  top?: string;
  cassetteMin?: string;
  cassetteMax?: string;
  linker?: string;
  binders?: string;
  wait?: boolean;
  json?: boolean;
  quiet?: boolean;
  skipGcsVcf?: boolean;
  mode?: string;
}

interface SubmitResponse {
  cassette_job_id: string;
  status: string;
  expected_runtime_min?: number;
  error?: string;
}

interface StatusResponse {
  cassette_job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  result?: any;
  cassette_biocid?: string;
  candidates_biocid?: string;
  n_epitopes?: number;
  error?: string;
  stage?: string;
}

export async function neoantigenFabricateCommand(
  biosampleSerial: string,
  options: NeoantigenFabricateOptions = {},
): Promise<string | null> {
  const spinner = options.quiet ? null
    : ora(`biofs neoantigen fabricate-cassette ${biosampleSerial}`).start();
  try {
    const credentials = await getCredentials();
    if (!credentials) {
      spinner?.fail('Not authenticated. Run: biofs login');
      process.exit(1);
    }

    const body: Record<string, unknown> = {
      biosample_serial: biosampleSerial,
      case_id: biosampleSerial,
      wallet: credentials.wallet_address,
      signature: credentials.user_signature,
      mode: options.mode || 'fabricate',
      top: Number(options.top || 16),
      cassette_min: Number(options.cassetteMin || 4),
      cassette_max: Number(options.cassetteMax || 8),
      linker: options.linker || 'GPGPG',
      binders: options.binders || 'mhcflurry,netmhcpan,curated',
      skip_gcs_vcf: !!options.skipGcsVcf,
    };

    if (spinner) spinner.text = `POST ${BIOFS_NODE_BASE}/cassette ...`;
    const submitResp = await axios.post<SubmitResponse>(
      `${BIOFS_NODE_BASE}/cassette`,
      body,
      {
        timeout: 60_000,
        validateStatus: (s) => s < 500,
        headers: {
          'X-Biofs-Wallet': credentials.wallet_address,
          'X-Biofs-Signature': credentials.user_signature,
        },
      },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`cassette ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const submit = submitResp.data;
    spinner?.succeed(`cassette_job_id=${submit.cassette_job_id}`);

    if (options.json && !options.wait) {
      console.log(JSON.stringify(submit, null, 2));
    } else if (!options.quiet) {
      console.log(chalk.gray(`  ETA ~${submit.expected_runtime_min ?? 5} min`));
      console.log(chalk.gray(`  status: biofs neoantigen status ${submit.cassette_job_id}`));
    }

    if (options.wait) {
      const waitSpin = options.quiet ? null
        : ora(`waiting for fabricate (${submit.cassette_job_id}) ...`).start();
      const deadline = Date.now() + 60 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10_000));
        const st = await axios.get<StatusResponse>(
          `${BIOFS_NODE_BASE}/cassette_status`,
          {
            params: {
              cassette_job_id: submit.cassette_job_id,
              wallet: credentials.wallet_address,
              signature: credentials.user_signature,
            },
            headers: {
              'X-Biofs-Wallet': credentials.wallet_address,
              'X-Biofs-Signature': credentials.user_signature,
            },
            timeout: 30_000,
            validateStatus: (s) => s < 500,
          },
        );
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          waitSpin?.succeed(
            `done — epitopes=${row.n_epitopes ?? '?'} cassette=${row.cassette_biocid || '(see result)'}`,
          );
          if (options.json) console.log(JSON.stringify(row, null, 2));
          else if (!options.quiet && row.result) {
            console.log(chalk.green('  align next:'));
            console.log(chalk.gray(`  ${row.result.align_hint || 'biofs neoantigen align-cassette --reads <biocid> --cassette <mrna-construct>'}`));
          }
          return submit.cassette_job_id;
        }
        if (row.status === 'failed') {
          waitSpin?.fail(`failed: ${row.error || 'no error'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.cassette_job_id;
        }
        if (waitSpin) waitSpin.text = `fabricate ${row.status}${row.stage ? '/' + row.stage : ''} (${submit.cassette_job_id})`;
      }
      waitSpin?.warn('wait timeout — check: biofs neoantigen status ' + submit.cassette_job_id);
    }

    return submit.cassette_job_id;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`fabricate-cassette failed: ${msg}`);
    Logger.error(`fabricate-cassette failed: ${msg}`);
    return null;
  }
}
