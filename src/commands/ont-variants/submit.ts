/**
 * biofs ont-variants <serial> --modbam <gs://merged.ont.modBAM>
 * biofs ont-variants submit <serial> ...
 *
 * CLIENT verb: submits an ONT small-variant calling job (Clair3) to biofs-node. Clair3 is the
 * ONT-native SNV/indel caller; it uses the R10.4.1 sup model matched to the dorado basecaller.
 * The aligned modBAM is read from the gcsfuse RO mount on the executor, never downloaded. The
 * ONT call set is orthogonal to the HiFi DeepVariant VCF (concordance is a twin-confidence signal).
 *
 * Dispatched through the protocol surface (POST /api_biofs_node/job -> nginx ->
 * localhost:8787/agent/job -> processJob), NOT a raw curl. biofs-node verifies consent
 * (operator signature => admin-bypass), spawns `biofs ont-variants exec`, persists the VCF, and
 * anchors a ClaraJobNFT (pipeline label `ont-clair3-snv`) on success.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface OntVariantsSubmitOptions {
  modbam: string;   // gs:// merged aligned ONT modBAM (the SNV/indel-calling input)
  model?: string;   // Clair3 model name (default: auto-pick R10.4.1 sup bundled in the image)
  ref?: string;     // 'GRCh38' | 'auto'
  json?: boolean;
}

export async function ontVariantsSubmitCommand(serial: string, options: OntVariantsSubmitOptions): Promise<void> {
  const spinner = ora('Submitting ont-variants (Clair3) job to biofs-node...').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const apiBase = CONFIG.API_BASE_URL;

    if (!options.modbam || !options.modbam.startsWith('gs://')) throw new Error('--modbam must be a gs:// aligned ONT modBAM URI');

    const jobId = `ontvar-${serial}-${Date.now()}`;
    const reference = options.ref || 'auto';

    spinner.text = `Submitting ont-variants for ${serial} -> biofs-node...`;
    const response = await axios.post(`${apiBase}/api_biofs_node/job`, {
      jobId,
      biosampleId: serial,
      inputType: 'ont-variants',    // discriminator; methyl/comethyl/sv-call/align-shard untouched
      ontModbam: options.modbam,
      ontModel: options.model || '',
      methylBiocid: '',             // operator-signed => admin-bypass consent
      reference,
      creatorWallet: credentials.wallet_address,
      creatorSig: credentials.user_signature,
      outputBucket: 'genobank-parabricks-output',
      refBucket: 'genobank-references',
      batchId: `ontvar-${new Date().toISOString().slice(0, 10)}`,
    }, { timeout: 300000 });

    spinner.succeed(chalk.green('ont-variants submitted to biofs-node (Clair3 VCF + ClaraJobNFT anchored on success)'));
    if (options.json) { console.log(JSON.stringify(response.data, null, 2)); return; }
    console.log();
    console.log(chalk.bold('ONT-variants Job (biofs-node):'));
    console.log(`  ${chalk.cyan('Job ID:')}   ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}   ${serial}`);
    console.log(`  ${chalk.cyan('Caller:')}   Clair3 (ONT SNV/indel)`);
    console.log(`  ${chalk.cyan('modBAM:')}   ${options.modbam}`);
    console.log(`  ${chalk.cyan('Status:')}   ${response.data.status || 'accepted'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit ont-variants job'));
    if (error.response) Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    else Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
