/**
 * biofs imaging enrich — Phase 3 enrichment of a finished imaging-twin.
 *
 * Runs one foundation model against the twin's two CT timepoints and writes a
 * sidecar into the twin's GCS dir that the twin surface (twin.imaging) merges:
 *   --model merlin    whole-scan change score (Merlin CT VLM embedding distance)
 *   --model vista3d   resection-bed / lymph-node segmentation (MONAI VISTA-3D)
 *   --model medgemma  draft clinical impression (MedGemma; assistive, not a dx)
 *
 * DICOM is biodata, so this is a biofs GPU job dispatched through biofs-node
 * (CLAUDE.md 2026-06-20): biofs-node looks up the twin job for its wallet + CT
 * series, starts/uses the GPU executor, runs the imaging-<model> container, and
 * registers the sidecar as biocid://…/imaging-twin/<job>/<model>. Decision-support.
 *
 * Flow:
 *   1. POST /api_biofs_node/submit_imaging_enrich {wallet, signature, twin_job_id, model, hf_token?}
 *   2. (--wait) poll /api_biofs_node/imaging_enrich_status?enrich_job_id=... until done.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface ImagingEnrichOptions {
  job?: string;
  model?: string;
  hfToken?: string;
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

const MODELS = ['merlin', 'vista3d', 'medgemma'];

interface EnrichSubmitResponse { enrich_job_id?: string; model?: string; twin_job_id?: string; status?: string; error?: string; }
interface EnrichStatusResponse { enrich_job_id?: string; model?: string; status: string; output_biocid?: string; result?: Record<string, any>; error?: string; }

export async function imagingEnrichCommand(options: ImagingEnrichOptions = {}): Promise<string | null> {
  const spinner = options.quiet ? null : ora('biofs imaging enrich → biofs-node (GPU)').start();
  try {
    const model = String(options.model || '').toLowerCase();
    if (!options.job) { spinner?.fail('--job <twin_job_id> is required (from `biofs imaging twin`).'); process.exit(1); }
    if (!MODELS.includes(model)) { spinner?.fail(`--model must be one of: ${MODELS.join(' | ')}`); process.exit(1); }

    const credentials = await getCredentials();
    if (!credentials) { spinner?.fail('Not authenticated. Run: biofs login'); process.exit(1); }

    const body: Record<string, unknown> = {
      wallet: credentials.wallet_address,
      signature: credentials.user_signature,
      twin_job_id: options.job,
      model,
    };
    // MedGemma is gated; the HF token is passed transiently to the executor only.
    const hf = options.hfToken || process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
    if (model === 'medgemma' && hf) body.hf_token = hf;

    if (spinner) spinner.text = `submitting ${model} enrichment to biofs-node ...`;
    const submitResp = await axios.post<EnrichSubmitResponse>(
      `${BIOFS_NODE_BASE}/submit_imaging_enrich`, body,
      { timeout: 120_000, validateStatus: (s) => s < 500 },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`submit_imaging_enrich ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const submit = submitResp.data;
    spinner?.succeed(`enrich_job_id=${submit.enrich_job_id} (${model}; GPU executor starting)`);
    if (options.json && !options.wait) console.log(JSON.stringify(submit, null, 2));

    if (options.wait && submit.enrich_job_id) {
      const waitSpin = options.quiet ? null : ora(`waiting for the ${model} GPU job ...`).start();
      const deadline = Date.now() + 45 * 60_000;
      let pollErrs = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 12_000));
        let st;
        try {
          st = await axios.get<EnrichStatusResponse>(
            `${BIOFS_NODE_BASE}/imaging_enrich_status`,
            { params: { enrich_job_id: submit.enrich_job_id }, timeout: 30_000, validateStatus: (s) => s < 500 },
          );
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
          waitSpin?.succeed(`${model} done — biocid ${row.output_biocid || ''}`);
          if (!options.quiet && row.result) {
            const r = row.result;
            if (model === 'merlin') console.log(chalk.gray(`  change score ${r.change_score} (cos sim ${r.cosine_similarity})`));
            else if (model === 'vista3d') console.log(chalk.gray(`  resection-bed ${r.resection_bed_ml ?? r.volume_ml} mL`));
            else if (model === 'medgemma') console.log(chalk.gray('  draft impression written (assistive, not a diagnosis)'));
          }
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.enrich_job_id;
        }
        if (row.status === 'error') {
          waitSpin?.fail(`${model} error: ${row.error || (row.result && row.result.error) || 'unknown'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.enrich_job_id;
        }
        if (waitSpin) waitSpin.text = `${model} ${row.status} (enrich_job_id=${submit.enrich_job_id})`;
      }
      waitSpin?.warn('wait timeout — job may still be running. Poll imaging_enrich_status.');
    }
    return submit.enrich_job_id || null;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`imaging enrich failed: ${msg}`);
    Logger.error(`imaging enrich failed: ${msg}`);
    return null;
  }
}
