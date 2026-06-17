/**
 * biofs hifi-deepvariant <serial> --bam <gs://CHM13-aligned HiFi BAM> [--ref CHM13] [--gvcf]
 * biofs hifi-deepvariant submit <serial> ...
 *
 * CLIENT verb: submits a HiFi small-variant calling job (NVIDIA Parabricks DeepVariant,
 * --mode pacbio) to biofs-node. DeepVariant is the reference-standard HiFi SNV/indel caller.
 * The input is the aligned HiFi BAM produced by `hifi-align --ref CHM13` (read from the gcsfuse
 * RO mount on the GPU executor, never downloaded). The HiFi DeepVariant VCF is the clinical spine
 * of the read-based call set; concordance with the ONT Clair3 VCF is a twin-confidence signal.
 *
 * Dispatched through the protocol surface (POST /api_biofs_node/job), NOT a raw curl. biofs-node
 * verifies consent (operator signature => admin-bypass), routes inputType=hifi-deepvariant to the
 * Parabricks GPU executor, spawns `biofs hifi-deepvariant exec`, persists the VCF, and anchors a
 * ClaraJobNFT (pipeline label `hifi-deepvariant-snv`) on success.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface HifiDeepvariantSubmitOptions {
  bam: string;      // gs:// CHM13-aligned HiFi BAM (output of hifi-align --ref CHM13)
  ref?: string;     // 'CHM13' | 'GRCh38' | 'auto'
  gvcf?: boolean;   // also emit a gVCF
  json?: boolean;
}

export async function hifiDeepvariantSubmitCommand(serial: string, options: HifiDeepvariantSubmitOptions): Promise<void> {
  const spinner = ora('Submitting hifi-deepvariant (Parabricks DeepVariant) job to biofs-node...').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const apiBase = CONFIG.API_BASE_URL;

    if (!options.bam || !options.bam.startsWith('gs://')) throw new Error('--bam must be a gs:// aligned HiFi BAM URI (from hifi-align)');

    const jobId = `hifidv-${serial}-${Date.now()}`;
    const reference = options.ref || 'auto';

    spinner.text = `Submitting hifi-deepvariant for ${serial} -> biofs-node...`;
    const response = await axios.post(`${apiBase}/api_biofs_node/job`, {
      jobId,
      biosampleId: serial,
      inputType: 'hifi-deepvariant',  // discriminator; front routes this to the Parabricks GPU executor
      hifiBam: options.bam,
      gvcf: !!options.gvcf,
      methylBiocid: '',               // operator-signed => admin-bypass consent
      reference,
      creatorWallet: credentials.wallet_address,
      creatorSig: credentials.user_signature,
      outputBucket: 'genobank-parabricks-output',
      refBucket: 'genobank-references',
      batchId: `hifidv-${new Date().toISOString().slice(0, 10)}`,
    }, { timeout: 300000 });

    spinner.succeed(chalk.green('hifi-deepvariant submitted to biofs-node (DeepVariant VCF + ClaraJobNFT anchored on success)'));
    if (options.json) { console.log(JSON.stringify(response.data, null, 2)); return; }
    console.log();
    console.log(chalk.bold('HiFi-DeepVariant Job (biofs-node, GPU):'));
    console.log(`  ${chalk.cyan('Job ID:')}   ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}   ${serial}`);
    console.log(`  ${chalk.cyan('Caller:')}   Parabricks DeepVariant (--mode pacbio)`);
    console.log(`  ${chalk.cyan('Reference:')} ${reference}`);
    console.log(`  ${chalk.cyan('HiFi BAM:')} ${options.bam}`);
    console.log(`  ${chalk.cyan('Status:')}   ${response.data.status || 'accepted'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit hifi-deepvariant job'));
    if (error.response) Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    else Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
