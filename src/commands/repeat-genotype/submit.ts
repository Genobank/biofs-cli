/**
 * biofs repeat-genotype <serial> --bam <gs://aligned.hifi.bam> --catalog <gs://repeats.bed>
 * biofs repeat-genotype submit <serial> ...
 *
 * CLIENT verb: submits a tandem-repeat / repeat-expansion genotyping job (TRGT) to biofs-node.
 * TRGT is the PacBio HiFi-native tandem-repeat genotyper: given a repeat catalog (BED of repeat
 * definitions) and an aligned HiFi BAM it emits per-locus allele lengths + motif structure as a
 * VCF, plus a spanning-reads BAM. It streams the aligned BAM and the matching reference; it NEVER
 * downloads the BAM (gcsfuse-only on the executor). (straglr is the ONT long-read alternative.)
 *
 * Dispatched through the protocol surface (POST /api_biofs_node/job -> nginx ->
 * localhost:8787/agent/job -> processJob), NOT a raw curl. biofs-node verifies consent
 * (operator signature => admin-bypass), spawns `biofs repeat-genotype exec` on the executor,
 * persists the repeat VCF, and anchors a ClaraJobNFT (pipeline label `hifi-trgt-repeats`) on success.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface RepeatGenotypeSubmitOptions {
  bam: string;       // gs:// aligned HiFi BAM (the genotyping input)
  catalog: string;   // gs:// repeat catalog BED (repeat definitions); REQUIRED
  ref?: string;      // 'GRCh38' | 'auto'
  json?: boolean;
}

export async function repeatGenotypeSubmitCommand(serial: string, options: RepeatGenotypeSubmitOptions): Promise<void> {
  const spinner = ora('Submitting repeat-genotype (TRGT) job to biofs-node...').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const apiBase = CONFIG.API_BASE_URL;

    if (!options.bam || !options.bam.startsWith('gs://')) throw new Error('--bam must be a gs:// aligned HiFi BAM URI');
    if (!options.catalog || !options.catalog.startsWith('gs://')) throw new Error('--catalog must be a gs:// repeat catalog BED URI (required)');

    const jobId = `repeatgt-${serial}-${Date.now()}`;
    const reference = options.ref || 'auto';

    spinner.text = `Submitting repeat-genotype for ${serial} -> biofs-node...`;
    const response = await axios.post(`${apiBase}/api_biofs_node/job`, {
      jobId,
      biosampleId: serial,
      inputType: 'repeat-genotype',   // discriminator; methyl/comethyl/align-shard/sv-call untouched
      repeatBam: options.bam,
      repeatCatalog: options.catalog,
      methylBiocid: '',               // operator-signed => admin-bypass consent
      reference,
      creatorWallet: credentials.wallet_address,
      creatorSig: credentials.user_signature,
      outputBucket: 'genobank-parabricks-output',
      refBucket: 'genobank-references',
      batchId: `repeatgt-${new Date().toISOString().slice(0, 10)}`,
    }, { timeout: 300000 });

    spinner.succeed(chalk.green('repeat-genotype submitted to biofs-node (repeat VCF + ClaraJobNFT anchored on success)'));
    if (options.json) { console.log(JSON.stringify(response.data, null, 2)); return; }
    console.log();
    console.log(chalk.bold('Repeat-genotype Job (biofs-node):'));
    console.log(`  ${chalk.cyan('Job ID:')}    ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}    ${serial}`);
    console.log(`  ${chalk.cyan('Tool:')}      TRGT (HiFi tandem-repeat genotyping)`);
    console.log(`  ${chalk.cyan('BAM:')}       ${options.bam}`);
    console.log(`  ${chalk.cyan('Catalog:')}   ${options.catalog}`);
    console.log(`  ${chalk.cyan('Status:')}    ${response.data.status || 'accepted'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit repeat-genotype job'));
    if (error.response) Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    else Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
