/**
 * biofs align-shard <serial> --bams <csv>            (DEFAULT subcommand)
 * biofs align-shard submit <serial> --bams <csv>
 *
 * CLIENT verb: submits a SHARDED long-read alignment job to biofs-node. This is
 * the faster, methylation-native sibling of `biofs methyl`:
 *
 *   - Aligns ONT modBAMs with `dorado aligner` (modBAM in -> aligned modBAM out),
 *     which preserves the Dorado 5mCG/5hmCG MM/ML tags NATIVELY. No `samtools
 *     fastq -T MM,ML | minimap2 -y` round-trip, so no fragile FASTQ comment seam
 *     and no `bam_tag2cigar CG-tag` warnings.
 *   - Runs W concurrent aligner workers (default chosen on the VM from nproc) so a
 *     few ultra-long reads cannot pin one core while 50 sit idle. minimap2/dorado
 *     chaining only saturates ~30 cores per process on ultra-long ONT, so W>1 fills
 *     an 88-core box that a single process leaves ~60% idle.
 *   - PERSISTS the merged aligned modBAM (MM/ML intact) to the biowallet GCS folder.
 *     That merged modBAM is the durable input the `comethyl` single-molecule pass
 *     and any re-pileup need, so the alignment is never thrown away.
 *   - Optional `--modkit` continues to a 5mCG/5hmCG bedMethyl pileup with the same
 *     hard QC gates as `biofs methyl`.
 *
 * Dispatched through the protocol surface (POST /api_biofs_node/job -> nginx alias
 * -> localhost:8787/agent/job -> processJob), NOT a raw curl. biofs-node verifies
 * consent (operator signature => admin-bypass), spawns `biofs align-shard exec` on
 * the executor, and anchors a ClaraJobNFT (pipeline label `ont-align-shard-dorado`)
 * on a QC pass.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface AlignShardSubmitOptions {
  bams: string;          // CSV of gs:// ONT Dorado modBAM URIs (carry MM/ML tags)
  shards?: string;       // requested concurrent aligner workers; '' => VM auto from nproc
  ref?: string;          // 'GRCh38' | 'auto' (default 'auto')
  modkit?: boolean;      // also produce the 5mCG/5hmCG bedMethyl pileup
  parentIpId?: string;
  json?: boolean;
}

export async function alignShardSubmitCommand(
  serial: string,
  options: AlignShardSubmitOptions
): Promise<void> {
  const spinner = ora('Submitting sharded ONT alignment job to biofs-node...').start();

  try {
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Run "biofs login" first.');
    }

    const apiBase = CONFIG.API_BASE_URL;

    const bamUris = (options.bams || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (bamUris.length === 0) {
      throw new Error('Provide --bams <csv of gs:// ONT Dorado modBAM URIs>.');
    }
    const bad = bamUris.filter((u) => !u.startsWith('gs://'));
    if (bad.length > 0) {
      throw new Error(`--bams entries must be gs:// URIs. Offending: ${bad.join(', ')}`);
    }
    const methylBamUris = bamUris.join(',');

    // Optional explicit worker count; blank => the executor picks from nproc.
    let workers = 0;
    if (options.shards && String(options.shards).trim() !== '') {
      workers = parseInt(String(options.shards), 10);
      if (!Number.isFinite(workers) || workers < 1) {
        throw new Error('--shards must be a positive integer (concurrent aligner workers).');
      }
    }

    const jobId = `alignshard-${serial}-${Date.now()}`;
    const reference = options.ref || 'auto';

    spinner.text = `Submitting sharded ONT alignment for ${serial} (${bamUris.length} modBAMs) -> biofs-node...`;

    const response = await axios.post(
      `${apiBase}/api_biofs_node/job`,
      {
        jobId,
        biosampleId: serial,
        inputType: 'align-shard',     // discriminator; bam/fastq/methyl untouched
        methylBamUris,                // CSV of gs:// ONT modBAM URIs (carry MM/ML)
        methylBiocid: '',             // operator-signed => admin-bypass consent
        reference,
        alignWorkers: workers || undefined,  // 0 => executor auto
        runModkit: !!options.modkit,          // also produce bedMethyl pileup
        creatorWallet: credentials.wallet_address,
        creatorSig: credentials.user_signature,
        parentIpId: options.parentIpId,
        outputBucket: 'genobank-parabricks-output',
        refBucket: 'genobank-references',
        batchId: `alignshard-${new Date().toISOString().slice(0, 10)}`,
      },
      { timeout: 300000 }
    );

    spinner.succeed(
      chalk.green('Sharded ONT alignment job submitted to biofs-node (merged aligned modBAM + ClaraJobNFT anchored on completion)')
    );

    if (options.json) {
      console.log(JSON.stringify(response.data, null, 2));
      return;
    }

    console.log();
    console.log(chalk.bold('Align-Shard Job (biofs-node):'));
    console.log(`  ${chalk.cyan('Job ID:')}    ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}    ${serial}`);
    console.log(`  ${chalk.cyan('Pipeline:')}  ont-align-shard-dorado (MM/ML preserved)`);
    console.log(`  ${chalk.cyan('modBAMs:')}   ${bamUris.length} ONT Dorado URIs`);
    console.log(`  ${chalk.cyan('Workers:')}   ${workers || 'auto (from nproc)'}`);
    console.log(`  ${chalk.cyan('Modkit:')}    ${options.modkit ? 'yes (bedMethyl pileup)' : 'no (align only)'}`);
    console.log(`  ${chalk.cyan('Reference:')} ${reference}`);
    console.log(`  ${chalk.cyan('Status:')}    ${response.data.status || 'accepted'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit sharded alignment job'));
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
