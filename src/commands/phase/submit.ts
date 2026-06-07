/**
 * biofs phase <serial> --bam <gs://aligned.hifi.bam> --vcf <gs://small_variants.vcf.gz>
 * biofs phase submit <serial> ...
 *
 * CLIENT verb: submits a genome-wide read-backed phasing job (HiPhase) to biofs-node.
 * HiPhase phases small variants (SNVs + indels) using the aligned HiFi reads, emitting a
 * phased VCF (PS phase-set tags) plus a haplotagged BAM (HP tags) for downstream allele-
 * specific analysis. It streams the aligned BAM and the small-variant VCF straight from the
 * gcsfuse RO mounts; it NEVER downloads the BAM (gcsfuse-only on the executor).
 *
 * Dispatched through the protocol surface (POST /api_biofs_node/job -> nginx ->
 * localhost:8787/agent/job -> processJob), NOT a raw curl. biofs-node verifies consent
 * (operator signature => admin-bypass), spawns `biofs phase exec` on the executor, persists
 * the phased VCF + haplotagged BAM, and anchors a ClaraJobNFT (pipeline label `hifi-hiphase`)
 * on success.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface PhaseSubmitOptions {
  bam: string;      // gs:// aligned HiFi BAM (the read-backed phasing evidence)
  vcf: string;      // gs:// small-variant VCF to phase (e.g. the HiFi DeepVariant VCF)
  ref?: string;     // 'GRCh38' | 'auto'
  json?: boolean;
}

export async function phaseSubmitCommand(serial: string, options: PhaseSubmitOptions): Promise<void> {
  const spinner = ora('Submitting phase (HiPhase) job to biofs-node...').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const apiBase = CONFIG.API_BASE_URL;

    if (!options.bam || !options.bam.startsWith('gs://')) throw new Error('--bam must be a gs:// aligned HiFi BAM URI');
    if (!options.vcf || !options.vcf.startsWith('gs://')) throw new Error('--vcf must be a gs:// small-variant VCF URI');

    const jobId = `phase-${serial}-${Date.now()}`;
    const reference = options.ref || 'auto';

    spinner.text = `Submitting phase for ${serial} -> biofs-node...`;
    const response = await axios.post(`${apiBase}/api_biofs_node/job`, {
      jobId,
      biosampleId: serial,
      inputType: 'phase',           // discriminator; methyl/comethyl/align-shard/sv-call untouched
      phaseBam: options.bam,
      phaseVcf: options.vcf,
      methylBiocid: '',             // operator-signed => admin-bypass consent
      reference,
      creatorWallet: credentials.wallet_address,
      creatorSig: credentials.user_signature,
      outputBucket: 'genobank-parabricks-output',
      refBucket: 'genobank-references',
      batchId: `phase-${new Date().toISOString().slice(0, 10)}`,
    }, { timeout: 300000 });

    spinner.succeed(chalk.green('phase submitted to biofs-node (phased VCF + haplotagged BAM + ClaraJobNFT anchored on success)'));
    if (options.json) { console.log(JSON.stringify(response.data, null, 2)); return; }
    console.log();
    console.log(chalk.bold('Phase Job (biofs-node):'));
    console.log(`  ${chalk.cyan('Job ID:')}   ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}   ${serial}`);
    console.log(`  ${chalk.cyan('Phaser:')}   HiPhase (read-backed, genome-wide)`);
    console.log(`  ${chalk.cyan('BAM:')}      ${options.bam}`);
    console.log(`  ${chalk.cyan('VCF:')}      ${options.vcf}`);
    console.log(`  ${chalk.cyan('Status:')}   ${response.data.status || 'accepted'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit phase job'));
    if (error.response) Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    else Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
