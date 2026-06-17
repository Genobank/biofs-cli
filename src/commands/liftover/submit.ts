/**
 * biofs liftover <serial> --vcf <gs://CHM13 VCF> [--to GRCh38]
 * biofs liftover submit <serial> ...
 *
 * CLIENT verb: submits a cross-reference VCF liftover job (CrossMap, CHM13 -> GRCh38) to
 * biofs-node. CHM13 calls are lifted to GRCh38 so the authoritative ClinVar / OpenCRAVAT
 * coordinates apply for clinical annotation; the records that fail to lift (the CrossMap reject
 * set) are the T2T-specific candidates in CHM13 regions absent from GRCh38, and are persisted
 * first-class for the novel-regions track. Nothing is silently dropped.
 *
 * Dispatched through the protocol surface (POST /api_biofs_node/job), NOT a raw curl. biofs-node
 * verifies consent (operator signature => admin-bypass), routes inputType=liftover to the CPU
 * executor, spawns `biofs liftover exec`, persists the lifted VCF + reject, and anchors a
 * ClaraJobNFT (pipeline label `liftover-crossmap`) on success.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface LiftoverSubmitOptions {
  vcf: string;      // gs:// source VCF (CHM13 coordinates)
  to?: string;      // target assembly (default GRCh38)
  json?: boolean;
}

export async function liftoverSubmitCommand(serial: string, options: LiftoverSubmitOptions): Promise<void> {
  const spinner = ora('Submitting liftover (CrossMap CHM13->GRCh38) job to biofs-node...').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const apiBase = CONFIG.API_BASE_URL;

    if (!options.vcf || !options.vcf.startsWith('gs://')) throw new Error('--vcf must be a gs:// CHM13-coordinate VCF URI');

    const jobId = `liftover-${serial}-${Date.now()}`;
    const target = options.to || 'GRCh38';

    spinner.text = `Submitting liftover for ${serial} -> biofs-node...`;
    const response = await axios.post(`${apiBase}/api_biofs_node/job`, {
      jobId,
      biosampleId: serial,
      inputType: 'liftover',          // discriminator; front routes this to the CPU executor
      liftoverVcf: options.vcf,
      liftoverTo: target,
      methylBiocid: '',               // operator-signed => admin-bypass consent
      reference: 'auto',
      creatorWallet: credentials.wallet_address,
      creatorSig: credentials.user_signature,
      outputBucket: 'genobank-parabricks-output',
      refBucket: 'genobank-references',
      batchId: `liftover-${new Date().toISOString().slice(0, 10)}`,
    }, { timeout: 300000 });

    spinner.succeed(chalk.green('liftover submitted to biofs-node (GRCh38 VCF + reject + ClaraJobNFT on success)'));
    if (options.json) { console.log(JSON.stringify(response.data, null, 2)); return; }
    console.log();
    console.log(chalk.bold('Liftover Job (biofs-node):'));
    console.log(`  ${chalk.cyan('Job ID:')}   ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}   ${serial}`);
    console.log(`  ${chalk.cyan('Lift:')}     CHM13 -> ${target} (CrossMap)`);
    console.log(`  ${chalk.cyan('Source:')}   ${options.vcf}`);
    console.log(`  ${chalk.cyan('Status:')}   ${response.data.status || 'accepted'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit liftover job'));
    if (error.response) Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    else Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
