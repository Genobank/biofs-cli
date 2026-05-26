/**
 * biofs lab refresh-coverage
 *
 * Stream higher-coverage FASTQ replacements from a lab's S3 origin bucket into
 * the local GCS mirror, supersede the prior lower-coverage inventory rows,
 * optionally invalidate downstream BAM/VCF/sqlite so the pipeline re-runs.
 *
 * The AUGenomics case: `Demux/20240412_ExomeGB_ExtraReadsCombined/` in
 * `s3://genobank/` carries 3.2x deeper re-sequencing for 11 samples that the
 * original `20240412_ExomeGB/` batch under-covered. Without this verb the only
 * way to upgrade was a manual gsutil dance.
 *
 * Flow:
 *   1. Resolve the lab + source spec.
 *   2. POST `/api_biofs_node/refresh_coverage` with a job manifest
 *      `{ lab, source_uri, serials[], invalidate_downstream, re_run_pipeline }`.
 *   3. biofs-node spawns a worker container that pipes
 *        aws s3 cp - | gsutil cp -
 *      for each file (no local landing on the prod VM), verifies bytes,
 *      supersedes old rows, inserts new canonical rows.
 *   4. (Optional --wait) poll `/api_biofs_node/refresh_coverage_status`
 *      until status in {done, failed}.
 *
 * Per CLAUDE.md "all jobs through biofs-cli + biofs-node" — the CLI is a
 * thin client; biofs-node does the actual streaming + minting.
 *
 * Usage:
 *   biofs lab refresh-coverage \
 *     --lab augenomics \
 *     --source s3://genobank/Demux/20240412_ExomeGB_ExtraReadsCombined \
 *     --aws-profile augenomics \
 *     --serials FR110238042704,FR086988354196,... \
 *     --invalidate-downstream \
 *     --wait
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface LabRefreshCoverageOptions {
  lab?: string;
  source?: string;
  awsProfile?: string;
  serials?: string;
  serialsFile?: string;
  invalidateDownstream?: boolean;
  reRunPipeline?: boolean;
  dryRun?: boolean;
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

const BIOFS_NODE_BASE = (
  process.env.BIOFS_NODE_URL ||
  `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`
).replace(/\/$/, '');

interface ManifestSerial {
  serial: string;
  source_objects: string[];   // e.g. ['Demux/.../FR1102.._R1.fastq.gz', '...R2...']
  dest_bucket: string;        // e.g. 'augenomicsadvancedsequencinglab-mirror-genobank'
  dest_prefix: string;        // e.g. 'biosamples/110238042704/fastq/'
}

export async function labRefreshCoverageCommand(options: LabRefreshCoverageOptions): Promise<void> {
  const lab = (options.lab || '').toLowerCase().trim();
  if (!lab) {
    Logger.error('--lab is required (e.g. --lab augenomics)');
    process.exit(1);
  }
  if (!options.source) {
    Logger.error('--source is required (e.g. --source s3://genobank/Demux/20240412_ExomeGB_ExtraReadsCombined)');
    process.exit(1);
  }
  if (!/^s3:\/\//.test(options.source)) {
    Logger.error('--source must be an s3:// URI');
    process.exit(1);
  }

  // Resolve serials list (csv flag or file). At least one required.
  let serials: string[] = [];
  if (options.serials) {
    serials = options.serials.split(',').map(s => s.trim()).filter(Boolean);
  } else if (options.serialsFile) {
    const fs = await import('fs/promises');
    const raw = await fs.readFile(options.serialsFile, 'utf-8');
    serials = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  if (serials.length === 0) {
    Logger.error('--serials <csv> or --serials-file <path> required');
    process.exit(1);
  }

  const creds = await getCredentials();
  if (!creds || !creds.wallet_address || !creds.user_signature) {
    Logger.error('Not authenticated. Run `biofs login` first.');
    process.exit(1);
  }

  const manifest = {
    lab,
    source_uri:            options.source,
    aws_profile:           options.awsProfile || 'augenomics',
    serials,
    invalidate_downstream: !!options.invalidateDownstream,
    re_run_pipeline:       !!options.reRunPipeline,
    dry_run:               !!options.dryRun,
    requester_wallet:      creds.wallet_address,
    signature:             creds.user_signature,
  };

  if (!options.quiet) {
    Logger.info('');
    Logger.info(chalk.bold.cyan('biofs lab refresh-coverage'));
    Logger.info(chalk.gray('─'.repeat(60)));
    Logger.info(`  lab:                   ${chalk.cyan(lab)}`);
    Logger.info(`  source:                ${options.source}`);
    Logger.info(`  aws_profile:           ${manifest.aws_profile} (server-side)`);
    Logger.info(`  serials:               ${serials.length}`);
    Logger.info(`  invalidate_downstream: ${manifest.invalidate_downstream}`);
    Logger.info(`  re_run_pipeline:       ${manifest.re_run_pipeline}`);
    Logger.info(`  dry_run:               ${manifest.dry_run}`);
    Logger.info(chalk.gray('─'.repeat(60)));
  }

  const spinner = options.quiet ? null : ora('Submitting refresh job to biofs-node').start();
  let submitResp: any;
  try {
    const r = await axios.post(`${BIOFS_NODE_BASE}/refresh_coverage`, manifest, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
    });
    submitResp = r.data;
    if (spinner) spinner.succeed(`Job accepted: ${chalk.green(submitResp.job_id)}`);
  } catch (e: any) {
    if (spinner) spinner.fail('Submit failed');
    const detail = e?.response?.data || e.message;
    Logger.error(`refresh_coverage submit failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(submitResp, null, 2));
    if (!options.wait) return;
  } else if (!options.quiet) {
    Logger.info('');
    Logger.info(`job_id:            ${chalk.cyan(submitResp.job_id)}`);
    Logger.info(`status:            ${submitResp.status}`);
    Logger.info(`expected_bytes:    ${submitResp.expected_bytes_human || '?'}`);
    Logger.info(`expected_objects:  ${submitResp.expected_objects ?? '?'}`);
  }

  if (!options.wait) {
    if (!options.quiet) {
      Logger.info('');
      Logger.info(`Poll status:`);
      Logger.info(chalk.gray(`  biofs lab refresh-coverage-status ${submitResp.job_id}`));
    }
    return;
  }

  // --wait: poll status until terminal
  const pollSpinner = options.quiet ? null : ora('Waiting for refresh job').start();
  const deadlineMs = Date.now() + 90 * 60 * 1000;  // 90-min ceiling
  let last: any = submitResp;
  while (Date.now() < deadlineMs) {
    await new Promise(r => setTimeout(r, 10_000));
    try {
      const sr = await axios.get(
        `${BIOFS_NODE_BASE}/refresh_coverage_status?job_id=${encodeURIComponent(submitResp.job_id)}`,
        { timeout: 15_000 }
      );
      last = sr.data;
      const phase = `${last.status} · ${last.serials_done || 0}/${last.serials_total || serials.length}`;
      if (pollSpinner) pollSpinner.text = `Refresh: ${phase}`;
      if (last.status === 'done' || last.status === 'failed') break;
    } catch (e: any) {
      if (pollSpinner) pollSpinner.text = `Refresh: poll error (${e.message}), retrying`;
    }
  }

  if (last.status === 'done') {
    if (pollSpinner) pollSpinner.succeed(`Refresh complete: ${last.serials_done}/${last.serials_total} serials, ${last.bytes_transferred_human || '?'} streamed`);
    if (options.json) console.log(JSON.stringify(last, null, 2));
  } else {
    if (pollSpinner) pollSpinner.fail(`Refresh ${last.status}: ${last.error || 'see biofs-node logs'}`);
    if (options.json) console.log(JSON.stringify(last, null, 2));
    process.exit(1);
  }
}

export async function labRefreshCoverageStatusCommand(jobId: string, options: { json?: boolean }): Promise<void> {
  try {
    const r = await axios.get(
      `${BIOFS_NODE_BASE}/refresh_coverage_status?job_id=${encodeURIComponent(jobId)}`,
      { timeout: 15_000 }
    );
    if (options.json) {
      console.log(JSON.stringify(r.data, null, 2));
      return;
    }
    const d = r.data;
    Logger.info('');
    Logger.info(chalk.bold(`refresh_coverage job ${jobId}`));
    Logger.info(chalk.gray('─'.repeat(60)));
    Logger.info(`  status:           ${d.status}`);
    Logger.info(`  serials:          ${d.serials_done || 0} / ${d.serials_total || '?'}`);
    Logger.info(`  bytes:            ${d.bytes_transferred_human || '?'}`);
    Logger.info(`  started_at:       ${d.started_at || '?'}`);
    if (d.ended_at) Logger.info(`  ended_at:         ${d.ended_at}`);
    if (d.error) Logger.info(`  error:            ${chalk.red(d.error)}`);
    if (Array.isArray(d.per_serial) && d.per_serial.length) {
      Logger.info(chalk.gray('─'.repeat(60)));
      Logger.info('per-serial:');
      for (const r of d.per_serial.slice(0, 20)) {
        Logger.info(`  ${r.serial.padEnd(18)} ${r.status.padEnd(10)} ${r.bytes_human || ''}`);
      }
    }
  } catch (e: any) {
    Logger.error(`status fetch failed: ${e?.response?.data?.error || e.message}`);
    process.exit(1);
  }
}
