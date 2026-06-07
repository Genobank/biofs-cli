/**
 * biofs methyl <serial> --bams <csv>   (DEFAULT subcommand of the `methyl` group)
 * biofs methyl submit <serial> --bams <csv>
 *
 * CLIENT verb: submits an Oxford-Nanopore 5mCG/5hmCG methylation job to
 * biofs-node. The job is dispatched through the protocol surface
 * (POST /api_biofs_node/job -> nginx alias -> localhost:8787/agent/job ->
 * processJob), NOT a raw curl. biofs-node verifies consent (operator
 * signature => admin-bypass, so no BioNFT is required), spawns the
 * VM-side runner `biofs methyl exec`, uploads the bedMethyl to GCS, and
 * anchors a ClaraJobNFT (pipeline label `ont-methylation-modkit`).
 *
 * Mirrors the canonical /api_biofs_node/job envelope used by
 * `biofs job recall` (the shipped dist recall.js), with the additive
 * `inputType: 'methyl'` discriminator and `methylBamUris` carrying the
 * CSV of gs:// ONT Dorado BAM URIs. bam/fastq job paths are untouched.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface MethylSubmitOptions {
  bams: string;          // CSV of gs:// ONT Dorado BAM URIs (carry MM/ML tags)
  ref?: string;          // 'GRCh38' | 'auto' (default 'auto')
  parentIpId?: string;   // optional parent BioIP / IP asset id
  json?: boolean;
}

export async function methylSubmitCommand(
  serial: string,
  options: MethylSubmitOptions
): Promise<void> {
  const spinner = ora('Submitting ONT methylation job to biofs-node...').start();

  try {
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Run "biofs login" first.');
    }

    const apiBase = CONFIG.API_BASE_URL;

    // Normalize + validate the BAM URI list. Every entry must be a gs:// URI;
    // these are the unaligned ONT Dorado BAMs that carry the MM/ML base-mod tags.
    const bamUris = (options.bams || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (bamUris.length === 0) {
      throw new Error('Provide --bams <csv of gs:// ONT Dorado BAM URIs>.');
    }
    const bad = bamUris.filter((u) => !u.startsWith('gs://'));
    if (bad.length > 0) {
      throw new Error(`--bams entries must be gs:// URIs. Offending: ${bad.join(', ')}`);
    }
    const methylBamUris = bamUris.join(',');

    const jobId = `methyl-${serial}-${Date.now()}`;
    const reference = options.ref || 'auto';

    spinner.text = `Submitting ONT 5mCG/5hmCG methylation for ${serial} (${bamUris.length} BAMs) -> biofs-node...`;

    const response = await axios.post(
      `${apiBase}/api_biofs_node/job`,
      {
        jobId,
        biosampleId: serial,
        inputType: 'methyl',          // NEW discriminator; bam/fastq untouched
        methylBamUris,                // CSV of gs:// URIs
        methylBiocid: '',             // operator-signed => admin-bypass consent
        reference,                    // 'GRCh38' resolves on the VM; 'auto' too
        creatorWallet: credentials.wallet_address,
        creatorSig: credentials.user_signature,
        parentIpId: options.parentIpId,
        outputBucket: 'genobank-parabricks-output',
        refBucket: 'genobank-references',
        batchId: `methyl-${new Date().toISOString().slice(0, 10)}`,
      },
      { timeout: 300000 }
    );

    spinner.succeed(
      chalk.green('ONT methylation job submitted to biofs-node (bedMethyl + ClaraJobNFT anchored on completion)')
    );

    if (options.json) {
      console.log(JSON.stringify(response.data, null, 2));
      return;
    }

    console.log();
    console.log(chalk.bold('Methylation Job (biofs-node):'));
    console.log(`  ${chalk.cyan('Job ID:')}    ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}    ${serial}`);
    console.log(`  ${chalk.cyan('Pipeline:')}  ont-methylation-modkit (5mCG + 5hmCG)`);
    console.log(`  ${chalk.cyan('BAMs:')}      ${bamUris.length} ONT Dorado URIs`);
    console.log(`  ${chalk.cyan('Reference:')} ${reference}`);
    console.log(`  ${chalk.cyan('Status:')}    ${response.data.status || 'accepted'}`);
    console.log();
    console.log(
      chalk.gray('Monitor: ') +
        chalk.cyan(`biofs job status ${response.data.jobId || jobId}`)
    );
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit ONT methylation job'));

    if (error.response) {
      Logger.error(
        `Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`
      );
    } else {
      Logger.error(`Error: ${error.message}`);
    }

    process.exit(1);
  }
}
