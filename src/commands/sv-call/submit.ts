/**
 * biofs sv-call <serial> --modbam <gs://merged.ont.modBAM>
 * biofs sv-call submit <serial> ...
 *
 * CLIENT verb: submits an ONT structural-variant calling job (Sniffles2) to biofs-node.
 * Sniffles2 is the ONT-native long-read SV caller (DEL/INS/DUP/INV/BND, breakpoint-resolved,
 * tandem-repeat aware). It streams the aligned modBAM (MM/ML tags ignored) and the matching
 * reference; it NEVER downloads the BAM (gcsfuse-only on the executor).
 *
 * Dispatched through the protocol surface (POST /api_biofs_node/job -> nginx ->
 * localhost:8787/agent/job -> processJob), NOT a raw curl. biofs-node verifies consent
 * (operator signature => admin-bypass), spawns `biofs sv-call exec` on the executor, persists
 * the SV VCF, and anchors a ClaraJobNFT (pipeline label `ont-sniffles-sv`) on success.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface SvCallSubmitOptions {
  modbam: string;   // gs:// merged aligned ONT modBAM (the SV-calling input)
  ref?: string;     // 'GRCh38' | 'auto'
  json?: boolean;
}

export async function svCallSubmitCommand(serial: string, options: SvCallSubmitOptions): Promise<void> {
  const spinner = ora('Submitting sv-call (Sniffles2) job to biofs-node...').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const apiBase = CONFIG.API_BASE_URL;

    if (!options.modbam || !options.modbam.startsWith('gs://')) throw new Error('--modbam must be a gs:// aligned ONT modBAM URI');

    const jobId = `svcall-${serial}-${Date.now()}`;
    const reference = options.ref || 'auto';

    spinner.text = `Submitting sv-call for ${serial} -> biofs-node...`;
    const response = await axios.post(`${apiBase}/api_biofs_node/job`, {
      jobId,
      biosampleId: serial,
      inputType: 'sv-call',         // discriminator; methyl/comethyl/align-shard untouched
      svModbam: options.modbam,
      methylBiocid: '',             // operator-signed => admin-bypass consent
      reference,
      creatorWallet: credentials.wallet_address,
      creatorSig: credentials.user_signature,
      outputBucket: 'genobank-parabricks-output',
      refBucket: 'genobank-references',
      batchId: `svcall-${new Date().toISOString().slice(0, 10)}`,
    }, { timeout: 300000 });

    spinner.succeed(chalk.green('sv-call submitted to biofs-node (SV VCF + ClaraJobNFT anchored on success)'));
    if (options.json) { console.log(JSON.stringify(response.data, null, 2)); return; }
    console.log();
    console.log(chalk.bold('SV-call Job (biofs-node):'));
    console.log(`  ${chalk.cyan('Job ID:')}   ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}   ${serial}`);
    console.log(`  ${chalk.cyan('Caller:')}   Sniffles2 (ONT structural variants)`);
    console.log(`  ${chalk.cyan('modBAM:')}   ${options.modbam}`);
    console.log(`  ${chalk.cyan('Status:')}   ${response.data.status || 'accepted'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit sv-call job'));
    if (error.response) Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    else Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
