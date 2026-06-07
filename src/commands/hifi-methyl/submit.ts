/**
 * biofs hifi-methyl <serial> --bam <gs://aligned.hifi.modBAM>
 * biofs hifi-methyl submit <serial> ...
 *
 * CLIENT verb: submits a PacBio HiFi 5mC methylome job (pb-CpG-tools) to biofs-node.
 * pb-CpG-tools (aligned_bam_to_cpg_scores) reads the aligned HiFi BAM carrying MM/ML 5mC tags
 * and emits per-CpG 5mC scores (combined.bed.gz / .bw). This is the ORTHOGONAL HiFi methylome
 * used for the comethyl H_concordance gate vs the ONT bedMethyl. It streams the aligned modBAM
 * and the matching reference; it NEVER downloads the BAM (gcsfuse-only on the executor).
 *
 * Dispatched through the protocol surface (POST /api_biofs_node/job -> nginx ->
 * localhost:8787/agent/job -> processJob), NOT a raw curl. biofs-node verifies consent
 * (operator signature => admin-bypass), spawns `biofs hifi-methyl exec` on the executor, persists
 * the 5mCG bedMethyl, and anchors a ClaraJobNFT (pipeline label `hifi-pbcpg-methyl`) on success.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface HifiMethylSubmitOptions {
  bam: string;      // gs:// aligned HiFi BAM carrying MM/ML 5mC tags (the methyl-calling input)
  ref?: string;     // 'GRCh38' | 'auto'
  json?: boolean;
}

export async function hifiMethylSubmitCommand(serial: string, options: HifiMethylSubmitOptions): Promise<void> {
  const spinner = ora('Submitting hifi-methyl (pb-CpG-tools) job to biofs-node...').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const apiBase = CONFIG.API_BASE_URL;

    if (!options.bam || !options.bam.startsWith('gs://')) throw new Error('--bam must be a gs:// aligned HiFi modBAM URI');

    const jobId = `hifimethyl-${serial}-${Date.now()}`;
    const reference = options.ref || 'auto';

    spinner.text = `Submitting hifi-methyl for ${serial} -> biofs-node...`;
    const response = await axios.post(`${apiBase}/api_biofs_node/job`, {
      jobId,
      biosampleId: serial,
      inputType: 'hifi-methyl',       // discriminator; methyl/comethyl/align-shard untouched
      hifiMethylBam: options.bam,
      methylBiocid: '',               // operator-signed => admin-bypass consent
      reference,
      creatorWallet: credentials.wallet_address,
      creatorSig: credentials.user_signature,
      outputBucket: 'genobank-parabricks-output',
      refBucket: 'genobank-references',
      batchId: `hifimethyl-${new Date().toISOString().slice(0, 10)}`,
    }, { timeout: 300000 });

    spinner.succeed(chalk.green('hifi-methyl submitted to biofs-node (5mCG bedMethyl + ClaraJobNFT anchored on success)'));
    if (options.json) { console.log(JSON.stringify(response.data, null, 2)); return; }
    console.log();
    console.log(chalk.bold('HiFi-methyl Job (biofs-node):'));
    console.log(`  ${chalk.cyan('Job ID:')}   ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}   ${serial}`);
    console.log(`  ${chalk.cyan('Caller:')}   pb-CpG-tools (HiFi 5mC methylome)`);
    console.log(`  ${chalk.cyan('modBAM:')}   ${options.bam}`);
    console.log(`  ${chalk.cyan('Status:')}   ${response.data.status || 'accepted'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit hifi-methyl job'));
    if (error.response) Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    else Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
