/**
 * biofs rrm-validate clinvar
 *
 * Dispatch the ClinVar GRCh38 wave benchmark to biofs-node. The node streams
 * the public allele VCF, Swiss-Prot, and AlphaMissense (MyVariant). The laptop
 * never holds ClinVar or a patient genome. Primary endpoint is per-gene ΔAUC
 * versus AlphaMissense, with a collagen/repeat vs globular/channel hold-out.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';

export interface RrmValidateOptions {
  owner?: string;
  minStars?: string;
  minN?: string;
  maxGenes?: string;
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export async function rrmValidateClinvarCommand(options: RrmValidateOptions = {}): Promise<string | null> {
  const spinner = options.quiet || options.json ? null
    : ora('biofs rrm-validate clinvar → biofs-node').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) {
      spinner?.fail('Not authenticated. Run: biofs login');
      process.exit(1);
    }
    const owner = options.owner || credentials.wallet_address;
    const body = {
      wallet: credentials.wallet_address,
      signature: credentials.user_signature,
      owner,
      min_stars: Number(options.minStars || 1),
      min_n: Number(options.minN || 15),
      max_genes: Number(options.maxGenes || 0),
    };
    const submitResp = await axios.post(
      `${BIOFS_NODE_BASE}/submit_clinvar_wave`,
      body,
      { timeout: 60_000, validateStatus: (s) => s < 500 },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`submit_clinvar_wave ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const submit = submitResp.data;
    spinner?.succeed(`wave_job_id=${submit.wave_job_id} status=${submit.status}`);
    if (options.json && !options.wait) console.log(JSON.stringify(submit, null, 2));
    if (options.wait && submit.wave_job_id) {
      const waitSpin = options.quiet ? null
        : ora(`waiting for ClinVar wave job ${submit.wave_job_id} ...`).start();
      const deadline = Date.now() + 6 * 60 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20_000));
        const st = await axios.get(
          `${BIOFS_NODE_BASE}/clinvar_wave_status`,
          { params: { wave_job_id: submit.wave_job_id }, timeout: 30_000, validateStatus: (s) => s < 500 },
        );
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          waitSpin?.succeed('ClinVar wave benchmark done');
          if (!options.quiet && row.summary) {
            console.log(chalk.gray(JSON.stringify(row.summary, null, 2).slice(0, 2000)));
          }
          if (row.biocid) console.log(chalk.gray('  ' + row.biocid));
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.wave_job_id;
        }
        if (row.status === 'failed') {
          waitSpin?.fail(row.error || 'failed');
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.wave_job_id;
        }
        if (waitSpin) {
          waitSpin.text = `wave ${row.status} stage=${row.stage || '?'} genes=${row.scored_genes ?? row.n_powered_genes ?? '?'} (${submit.wave_job_id})`;
        }
      }
      waitSpin?.warn('wait timeout — poll: biofs rrm-validate status ' + submit.wave_job_id);
    }
    return submit.wave_job_id || null;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`rrm-validate failed: ${msg}`);
    Logger.error(`rrm-validate failed: ${msg}`);
    return null;
  }
}

export async function rrmValidateStatusCommand(jobId: string, options: { json?: boolean } = {}): Promise<void> {
  const st = await axios.get(
    `${BIOFS_NODE_BASE}/clinvar_wave_status`,
    { params: { wave_job_id: jobId }, timeout: 30_000, validateStatus: (s) => s < 500 },
  );
  if (options.json || st.status >= 400) {
    console.log(JSON.stringify(st.data, null, 2));
    return;
  }
  const row = st.data;
  console.log(`${row.wave_job_id}  ${row.status}  stage=${row.stage || ''}`);
  if (row.error) console.log(chalk.red(row.error));
  if (row.biocid) console.log(row.biocid);
  if (row.summary) console.log(JSON.stringify(row.summary, null, 2));
}
