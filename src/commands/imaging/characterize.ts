/**
 * biofs imaging characterize — Tier 2: STUDY each tracked candidate from a findings job.
 *
 * Runs the Tier-2 method stack (PyRadiomics, CT-FM, Merlin, PASTA, MedGemma 1.5, and the
 * trained heads when available) against the candidates a `biofs imaging findings` job
 * localized + tracked, and assembles a per-candidate side-by-side comparison + agreement.
 * GPU job via biofs-node. Decision-support, NOT a diagnosis; detection is bounded to
 * VISTA-3D's tumor classes and trained methods carry an explicit public-data domain-shift
 * caveat.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface ImagingCharacterizeOptions {
  job?: string;
  methods?: string;
  alpha?: string;
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export async function imagingCharacterizeCommand(options: ImagingCharacterizeOptions = {}): Promise<string | null> {
  const spinner = options.quiet ? null : ora('biofs imaging characterize → biofs-node (GPU)').start();
  try {
    if (!options.job) { spinner?.fail('--job <findings_job_id> required'); process.exit(1); }
    const credentials = await getCredentials();
    if (!credentials) { spinner?.fail('Not authenticated. Run: biofs login'); process.exit(1); }
    const methods = (options.methods || 'pyradiomics,ctfm,merlin,pasta,medgemma')
      .split(',').map((m) => m.trim()).filter(Boolean);

    if (spinner) spinner.text = 'submitting to biofs-node /agent/submit_imaging_characterize ...';
    const submitResp = await axios.post<{ characterize_job_id?: string; status?: string; methods?: string[]; error?: string }>(
      `${BIOFS_NODE_BASE}/submit_imaging_characterize`,
      { wallet: credentials.wallet_address, signature: credentials.user_signature,
        findings_job: options.job, methods, alpha: options.alpha ? Number(options.alpha) : 0.1 },
      { timeout: 120_000, validateStatus: (s) => s < 500 },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`submit_imaging_characterize ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const job = submitResp.data.characterize_job_id;
    spinner?.succeed(`characterize_job_id=${job}  (methods: ${(submitResp.data.methods || methods).join(', ')})`);
    if (options.json && !options.wait) console.log(JSON.stringify(submitResp.data, null, 2));

    if (options.wait && job) {
      const waitSpin = options.quiet ? null : ora(`waiting for the Tier-2 methods (characterize_job_id=${job}) ...`).start();
      const deadline = Date.now() + 60 * 60_000;
      let pollErrs = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15_000));
        let st;
        try {
          st = await axios.get<any>(`${BIOFS_NODE_BASE}/imaging_characterize_status`,
            { params: { characterize_job_id: job }, timeout: 30_000, validateStatus: (s) => s < 500 });
        } catch (e: any) {
          pollErrs++; if (waitSpin) waitSpin.text = `waiting (poll retry ${pollErrs}: ${e?.code || 'network'}) ...`;
          if (pollErrs >= 40) throw e; continue;
        }
        pollErrs = 0;
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          const r = (row.result || {});
          waitSpin?.succeed(`characterize done — biocid ${row.output_biocid || ''}`);
          if (!options.quiet) {
            console.log(chalk.gray(`  methods run: ${(r.methods_run || []).join(', ') || 'none'}${(r.methods_failed||[]).length ? ' · failed ' + r.methods_failed.join(', ') : ''}`));
            console.log(chalk.gray('  decision-support, not a diagnosis; read radiology_characterize for the side-by-side + agreement.'));
          }
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return job;
        }
        if (row.status === 'error') {
          waitSpin?.fail(`characterize error: ${row.error || 'unknown'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return job;
        }
        if (waitSpin) waitSpin.text = `characterize ${row.status || 'running'} (characterize_job_id=${job})`;
      }
      waitSpin?.warn('wait timeout — may still be running. Poll imaging_characterize_status.');
    }
    return job || null;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`imaging characterize failed: ${msg}`);
    Logger.error(`imaging characterize failed: ${msg}`);
    return null;
  }
}
