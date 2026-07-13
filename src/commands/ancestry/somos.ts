/**
 * biofs ancestry somos <biosample_serial>
 *
 * SOMOS 24-population admixture for a genotype already in the user's vault,
 * dispatched through biofs-node (never a direct curl / one-off). Thin client
 * over biofs-node POST /agent/ancestry, mirroring `biofs interpret submit`.
 *
 * Modes (privacy tiers, see genobank-he-ancestry):
 *   default            server-side projection in the vault. Reproduces the
 *                      production supervised-ADMIXTURE result exactly.
 *   --encrypted        Tier-1 BlindDot: the genotype is CKKS-encrypted and the
 *                      server projects it blind against the SOMOS reference
 *                      model (the raw genome is never decrypted). Dominant
 *                      ancestries match; fine proportions among genetically
 *                      collinear populations may differ (admixture is
 *                      ill-conditioned), so this is the privacy-max estimate.
 *   --fully-blind      Tier-2 (optional): also hides the 24-number result from
 *                      the server. Requires the CKKS bootstrapping backend; off
 *                      by default because users typically make the result public.
 *
 *   biofs ancestry somos DTC-5212746ceaa9 --wait
 *   biofs ancestry somos DTC-5212746ceaa9 --encrypted --wait
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface AncestrySomosOptions {
  encrypted?: boolean;     // Tier-1 BlindDot (genome encrypted, server blind)
  fullyBlind?: boolean;    // Tier-2 (also hides the result) — optional
  biowallet?: string;      // data owner; result is filed under this wallet
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
  paymentHeader?: string;
}

interface SubmitResponse {
  ancestry_job_id: string;
  status: string;
  mode: string;
  result_biocid?: string;
  result_gs_uri?: string;
  expected_runtime_min?: number;
  error?: string;
}

interface StatusResponse {
  ancestry_job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  mode?: string;
  ancestry?: Record<string, number>;   // 24-population admixture
  result_biocid?: string;
  result_gs_uri?: string;
  result_url?: string;
  fidelity?: string;                    // honest note for encrypted/static-model
  error?: string;
  inventory_registered?: boolean;
}

function mode(o: AncestrySomosOptions): string {
  if (o.fullyBlind) return 'fully_blind';
  if (o.encrypted) return 'encrypted';
  return 'projection';
}

function topLine(a: Record<string, number>, n = 6): string {
  return Object.entries(a)
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`)
    .join(', ');
}

export async function ancestrySomosCommand(
  biosampleSerial: string,
  options: AncestrySomosOptions = {},
): Promise<string | null> {
  const m = mode(options);
  const spinner = options.quiet || options.json ? null
    : ora(`biofs ancestry somos ${biosampleSerial} [${m}] → biofs-node`).start();
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
      mode: m,
    };
    // The DATA OWNER, when it is not the operator: the 24-population result is
    // filed under this wallet in genobank-somos.ancestry-results. biofs-node
    // prefers customer_biowallet over wallet; wallet stays the authenticated
    // caller. Without this, a custodial sample would be filed under the
    // operator's own wallet.
    if (options.biowallet) body.customer_biowallet = options.biowallet;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.paymentHeader) headers['X-PAYMENT'] = options.paymentHeader;

    if (spinner) spinner.text = 'submitting to biofs-node /agent/ancestry …';
    const submitResp = await axios.post<SubmitResponse>(
      `${BIOFS_NODE_BASE}/ancestry`,
      body,
      { timeout: 60_000, headers, validateStatus: (s) => s < 500 },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`ancestry ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const submit = submitResp.data;
    spinner?.succeed(`ancestry_job_id=${submit.ancestry_job_id} [${submit.mode}]`);

    if (options.json) {
      console.log(JSON.stringify(submit, null, 2));
    } else if (!options.quiet) {
      if (options.biowallet) {
        console.log(chalk.gray('  owner biowallet: ' + options.biowallet + ' (result filed here, not under the operator)'));
      }
      if (m !== 'projection') {
        console.log(chalk.gray('  mode: ' + m + (m === 'encrypted'
          ? ' (genome CKKS-encrypted; server projects blind)'
          : ' (also hides the 24-pop result; bootstrapping backend)')));
      }
      if (submit.expected_runtime_min) console.log(chalk.gray('  ETA: ' + submit.expected_runtime_min + ' min'));
    }

    if (options.wait) {
      const waitSpin = options.quiet ? null
        : ora(`computing admixture (ancestry_job_id=${submit.ancestry_job_id}) …`).start();
      const deadline = Date.now() + 40 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10_000));
        const st = await axios.get<StatusResponse>(
          `${BIOFS_NODE_BASE}/ancestry_status`,
          // sign the poll: the result is released only to the job's owner/caller
          { params: { ancestry_job_id: submit.ancestry_job_id, signature: credentials.user_signature },
            timeout: 30_000, validateStatus: (s) => s < 500 },
        );
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          waitSpin?.succeed('admixture done');
          if (options.json) {
            console.log(JSON.stringify(row, null, 2));
          } else {
            if (row.ancestry) console.log(chalk.cyan('  ' + topLine(row.ancestry)));
            if (row.result_url || row.result_gs_uri) console.log(chalk.gray('  result: ' + (row.result_url || row.result_gs_uri)));
            if (row.fidelity) console.log(chalk.yellow('  ' + row.fidelity));
          }
          return submit.ancestry_job_id;
        }
        if (row.status === 'failed') {
          waitSpin?.fail(`admixture failed: ${row.error || 'no error reported'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.ancestry_job_id;
        }
        if (waitSpin) waitSpin.text = `admixture ${row.status} (ancestry_job_id=${submit.ancestry_job_id})`;
      }
      waitSpin?.warn('wait timeout — check with: biofs ancestry status ' + submit.ancestry_job_id);
    }

    return submit.ancestry_job_id;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`ancestry somos failed: ${msg}`);
    Logger.error(`ancestry somos failed: ${msg}`);
    return null;
  }
}
