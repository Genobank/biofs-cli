/**
 * biofs pbsv <serial> --bam <gs://aligned_hifi.bam>
 * biofs pbsv submit <serial> ...
 *
 * CLIENT verb: submits a PacBio HiFi read-based structural-variant calling job (pbsv) to
 * biofs-node. pbsv is the PacBio-native long-read SV caller; it runs in two stages
 * (`pbsv discover` -> svsig.gz, then `pbsv call --hifi` -> VCF) over the aligned HiFi BAM
 * (the hifi-align output) and the matching reference. It streams the aligned BAM straight
 * from the gcsfuse RO mount; it NEVER downloads the BAM (gcsfuse-only on the executor).
 *
 * Dispatched through the protocol surface (POST /api_biofs_node/job -> nginx ->
 * localhost:8787/agent/job -> processJob), NOT a raw curl. biofs-node verifies consent
 * (operator signature => admin-bypass), spawns `biofs pbsv exec` on the executor, persists
 * the SV VCF, and anchors a ClaraJobNFT (pipeline label `hifi-pbsv-sv`) on success.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface PbsvSubmitOptions {
  bam: string;      // gs:// aligned HiFi BAM (the pbsv-calling input)
  ref?: string;     // 'GRCh38' | 'auto'
  json?: boolean;
}

export async function pbsvSubmitCommand(serial: string, options: PbsvSubmitOptions): Promise<void> {
  const spinner = ora('Submitting pbsv (PacBio HiFi SV) job to biofs-node...').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const apiBase = CONFIG.API_BASE_URL;

    if (!options.bam || !options.bam.startsWith('gs://')) throw new Error('--bam must be a gs:// aligned HiFi BAM URI');

    const jobId = `pbsv-${serial}-${Date.now()}`;
    const reference = options.ref || 'auto';

    spinner.text = `Submitting pbsv for ${serial} -> biofs-node...`;
    const response = await axios.post(`${apiBase}/api_biofs_node/job`, {
      jobId,
      biosampleId: serial,
      inputType: 'pbsv',            // discriminator; methyl/comethyl/align-shard/sv-call untouched
      pbsvBam: options.bam,
      methylBiocid: '',             // operator-signed => admin-bypass consent
      reference,
      creatorWallet: credentials.wallet_address,
      creatorSig: credentials.user_signature,
      outputBucket: 'genobank-parabricks-output',
      refBucket: 'genobank-references',
      batchId: `pbsv-${new Date().toISOString().slice(0, 10)}`,
    }, { timeout: 300000 });

    spinner.succeed(chalk.green('pbsv submitted to biofs-node (SV VCF + ClaraJobNFT anchored on success)'));
    if (options.json) { console.log(JSON.stringify(response.data, null, 2)); return; }
    console.log();
    console.log(chalk.bold('pbsv Job (biofs-node):'));
    console.log(`  ${chalk.cyan('Job ID:')}   ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}   ${serial}`);
    console.log(`  ${chalk.cyan('Caller:')}   pbsv (PacBio HiFi structural variants)`);
    console.log(`  ${chalk.cyan('BAM:')}      ${options.bam}`);
    console.log(`  ${chalk.cyan('Status:')}   ${response.data.status || 'accepted'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit pbsv job'));
    if (error.response) Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    else Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
