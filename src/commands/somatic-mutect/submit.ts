/**
 * biofs somatic-mutect <caseId> --tumor-bam <gs://...> --normal-bam <gs://...> [--ref-fasta gs://...]
 * biofs somatic-mutect submit <caseId> ...
 *
 * CLIENT verb: submits a tumor/normal somatic small-variant calling job (NVIDIA Parabricks
 * mutectcaller, GPU Mutect2) to biofs-node. Inputs are a pre-aligned tumor WES/WGS BAM and its
 * matched normal BAM (for example a lab vault casefile pair), both aligned to the SAME reference.
 * The somatic VCF is the panel-design source for tumor-informed MRD monitoring (clonal somatic
 * variant selection), so this verb is the sanctioned route from a tumor/normal pair to a
 * personalized tracking panel.
 *
 * Dispatched through the protocol surface (POST /api_biofs_node/job), NOT a raw curl. biofs-node
 * verifies consent (operator signature => admin-bypass), routes inputType=somatic-mutect to the
 * Parabricks GPU executor, spawns `biofs somatic-mutect exec`, persists the VCF, and anchors a
 * ClaraJobNFT (pipeline label `somatic-mutect2`) on success.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface SomaticMutectSubmitOptions {
  tumorBam: string;    // gs:// aligned tumor BAM
  normalBam: string;   // gs:// aligned matched-normal BAM (same reference as tumor)
  refFasta?: string;   // explicit gs:// reference fasta the BAMs were aligned to (else auto candidates)
  lowMemory?: boolean; // pbrun --mutect-low-memory (default true)
  json?: boolean;
}

export async function somaticMutectSubmitCommand(caseId: string, options: SomaticMutectSubmitOptions): Promise<void> {
  const spinner = ora('Submitting somatic-mutect (Parabricks Mutect2 tumor/normal) job to biofs-node...').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const apiBase = CONFIG.API_BASE_URL;

    if (!options.tumorBam || !options.tumorBam.startsWith('gs://')) throw new Error('--tumor-bam must be a gs:// aligned BAM URI');
    if (!options.normalBam || !options.normalBam.startsWith('gs://')) throw new Error('--normal-bam must be a gs:// aligned BAM URI');
    if (options.refFasta && !options.refFasta.startsWith('gs://')) throw new Error('--ref-fasta must be a gs:// fasta URI');

    const jobId = `somamu-${caseId}-${Date.now()}`;

    spinner.text = `Submitting somatic-mutect for case ${caseId} -> biofs-node...`;
    const response = await axios.post(`${apiBase}/api_biofs_node/job`, {
      jobId,
      biosampleId: caseId,
      inputType: 'somatic-mutect',  // discriminator; front routes this to the Parabricks GPU executor
      tumorBam: options.tumorBam,
      normalBam: options.normalBam,
      refFasta: options.refFasta || '',
      lowMemory: options.lowMemory !== false,
      creatorWallet: credentials.wallet_address,
      creatorSig: credentials.user_signature,
      outputBucket: 'genobank-parabricks-output',
      refBucket: 'deepvariant-fastq-to-vcf-genobank-app',
      batchId: `somamu-${new Date().toISOString().slice(0, 10)}`,
    }, { timeout: 300000 });

    spinner.succeed(chalk.green('somatic-mutect submitted to biofs-node (Mutect2 VCF + ClaraJobNFT anchored on success)'));
    if (options.json) { console.log(JSON.stringify(response.data, null, 2)); return; }
    console.log();
    console.log(chalk.bold('Somatic Mutect2 Job (biofs-node, GPU):'));
    console.log(`  ${chalk.cyan('Job ID:')}     ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Case:')}       ${caseId}`);
    console.log(`  ${chalk.cyan('Caller:')}     Parabricks mutectcaller (Mutect2 tumor/normal, GPU)`);
    console.log(`  ${chalk.cyan('Tumor BAM:')}  ${options.tumorBam}`);
    console.log(`  ${chalk.cyan('Normal BAM:')} ${options.normalBam}`);
    console.log(`  ${chalk.cyan('Reference:')}  ${options.refFasta || 'auto (hs37d5/b37 candidates)'}`);
    console.log(`  ${chalk.cyan('Status:')}     ${response.data.status || 'accepted'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit somatic-mutect job'));
    if (error.response) Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    else Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
