/**
 * biofs hifi-align <serial> --bams <csv of gs:// unaligned HiFi BAMs>
 * biofs hifi-align submit <serial> ...
 *
 * CLIENT verb: submits a PacBio HiFi read-alignment job (pbmm2) to biofs-node. The raw HiFi
 * reads ship as UNALIGNED BAMs that carry per-read 5mC base-modification tags (MM/ML). pbmm2
 * aligns each SMRT cell to the SAME reference the ONT modBAM was aligned to (assembly38) and
 * preserves the MM/ML tags, then the cells are merged. The aligned HiFi BAM is the KEYSTONE
 * artifact: it unblocks read-based SV (pbsv), repeat-expansion genotyping (TRGT), genome-wide
 * phasing (HiPhase), and the orthogonal HiFi 5mC methylome (pb-CpG-tools).
 *
 * Dispatched through the protocol surface (POST /api_biofs_node/job), NOT a raw curl. biofs-node
 * verifies consent (operator signature => admin-bypass), spawns `biofs hifi-align exec`, persists
 * the aligned+indexed BAM, and anchors a ClaraJobNFT (pipeline label `hifi-pbmm2-align`).
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface HifiAlignSubmitOptions {
  bams: string;     // CSV of gs:// unaligned HiFi BAM URIs (carry MM/ML 5mC tags)
  ref?: string;     // 'GRCh38' | 'auto'
  json?: boolean;
}

export async function hifiAlignSubmitCommand(serial: string, options: HifiAlignSubmitOptions): Promise<void> {
  const spinner = ora('Submitting hifi-align (pbmm2) job to biofs-node...').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const apiBase = CONFIG.API_BASE_URL;

    const bams = (options.bams || '').split(',').map((s) => s.trim()).filter(Boolean);
    const bad = bams.filter((u) => !u.startsWith('gs://'));
    if (bams.length === 0) throw new Error('--bams must list one or more gs:// unaligned HiFi BAM URIs');
    if (bad.length > 0) throw new Error(`--bams entries must be gs:// URIs. Offending: ${bad.join(', ')}`);

    const jobId = `hifialign-${serial}-${Date.now()}`;
    const reference = options.ref || 'auto';

    spinner.text = `Submitting hifi-align for ${serial} -> biofs-node...`;
    const response = await axios.post(`${apiBase}/api_biofs_node/job`, {
      jobId,
      biosampleId: serial,
      inputType: 'hifi-align',       // discriminator
      hifiBams: bams.join(','),
      methylBiocid: '',              // operator-signed => admin-bypass consent
      reference,
      creatorWallet: credentials.wallet_address,
      creatorSig: credentials.user_signature,
      outputBucket: 'genobank-parabricks-output',
      refBucket: 'genobank-references',
      batchId: `hifialign-${new Date().toISOString().slice(0, 10)}`,
    }, { timeout: 300000 });

    spinner.succeed(chalk.green('hifi-align submitted to biofs-node (aligned HiFi BAM + ClaraJobNFT on success)'));
    if (options.json) { console.log(JSON.stringify(response.data, null, 2)); return; }
    console.log();
    console.log(chalk.bold('HiFi-align Job (biofs-node):'));
    console.log(`  ${chalk.cyan('Job ID:')}   ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}   ${serial}`);
    console.log(`  ${chalk.cyan('Aligner:')}  pbmm2 (HIFI preset, MM/ML preserved)`);
    console.log(`  ${chalk.cyan('Cells:')}    ${bams.length}`);
    console.log(`  ${chalk.cyan('Status:')}   ${response.data.status || 'accepted'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit hifi-align job'));
    if (error.response) Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    else Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
