/**
 * biofs dipcall <serial> --hap1 <gs://hap1.fa> --hap2 <gs://hap2.fa> [--ref CHM13]
 * biofs dipcall submit <serial> ...
 *
 * CLIENT verb: submits an assembly-based variant-calling job (dipcall, Li 2018) to biofs-node.
 * Study 2 of the long-read multiomic design: a PHASED diploid assembly (two haplotype FASTAs)
 * is aligned to the reference and dipcall emits a haplotype-resolved VCF + a confident-region BED.
 * This callset is orthogonal to the read-based callers of Study 1 and is the substrate for the
 * combine / orthogonal-confirmation step.
 *
 * Dispatched through the protocol surface (POST /api_biofs_node/job), NOT a raw curl. biofs-node
 * verifies consent (operator signature => admin-bypass), routes inputType=dipcall to the CPU
 * executor, spawns `biofs dipcall exec`, and persists the dip VCF + confident BED + manifest.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface DipcallSubmitOptions {
  hap1: string;     // gs:// haplotype-1 assembly FASTA
  hap2: string;     // gs:// haplotype-2 assembly FASTA
  ref?: string;     // reference: CHM13 | GRCh38 (default auto -> CHM13 when 'CHM13' passed)
  json?: boolean;
}

export async function dipcallSubmitCommand(serial: string, options: DipcallSubmitOptions): Promise<void> {
  const spinner = ora('Submitting dipcall (assembly-based variant calling) job to biofs-node...').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const apiBase = CONFIG.API_BASE_URL;

    if (!options.hap1 || !options.hap1.startsWith('gs://')) throw new Error('--hap1 must be a gs:// assembly FASTA URI');
    if (!options.hap2 || !options.hap2.startsWith('gs://')) throw new Error('--hap2 must be a gs:// assembly FASTA URI');

    const jobId = `dipcall-${serial}-${Date.now()}`;
    const reference = options.ref || 'auto';

    spinner.text = `Submitting dipcall for ${serial} -> biofs-node...`;
    const response = await axios.post(`${apiBase}/api_biofs_node/job`, {
      jobId,
      biosampleId: serial,
      inputType: 'dipcall',           // discriminator; front routes this to the CPU executor
      dipcallHap1: options.hap1,
      dipcallHap2: options.hap2,
      methylBiocid: '',               // operator-signed => admin-bypass consent
      reference,
      creatorWallet: credentials.wallet_address,
      creatorSig: credentials.user_signature,
      outputBucket: 'genobank-parabricks-output',
      refBucket: 'genobank-references',
      batchId: `dipcall-${new Date().toISOString().slice(0, 10)}`,
    }, { timeout: 300000 });

    spinner.succeed(chalk.green('dipcall submitted to biofs-node (assembly-based VCF + confident BED on success)'));
    if (options.json) { console.log(JSON.stringify(response.data, null, 2)); return; }
    console.log();
    console.log(chalk.bold('Dipcall Job (biofs-node, assembly-based):'));
    console.log(`  ${chalk.cyan('Job ID:')}   ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}   ${serial}`);
    console.log(`  ${chalk.cyan('Reference:')} ${reference}`);
    console.log(`  ${chalk.cyan('Hap1:')}     ${options.hap1}`);
    console.log(`  ${chalk.cyan('Hap2:')}     ${options.hap2}`);
    console.log(`  ${chalk.cyan('Status:')}   ${response.data.status || 'accepted'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit dipcall job'));
    if (error.response) Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    else Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
