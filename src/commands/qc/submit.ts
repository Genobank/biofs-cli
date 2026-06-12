/**
 * biofs qc <serial> --inputs <gs://a.bam,gs://b.fa.gz,...>
 * biofs qc submit <serial> ...
 *
 * CLIENT verb: submits a long-read QC job (read quality + coverage) to biofs-node.
 * For each input it streams the file from the gcsfuse RO mount on the executor (the BAMs are
 * NEVER downloaded), runs cramino on alignment/BAM inputs (read N50, yield, coverage, per-length
 * and per-quality coverage buckets, ultralong "whales") and seqkit on FASTA/FASTQ inputs, and for
 * PacBio HiFi BAMs additionally samples the `rq` predicted-accuracy tag to report mean QV and
 * %Q20/Q30/Q40. It assembles a uniform per-dataset manifest plus an aggregate verkko-readiness
 * verdict (total HiFi coverage, total ONT coverage, ONT ultralong >=100kb coverage).
 *
 * Dispatched through the protocol surface (POST /api_biofs_node/job -> biofs-node), NOT a raw curl.
 * biofs-node verifies consent (operator signature => admin-bypass), spawns `biofs qc exec`, persists
 * the QC manifest, and anchors a ClaraJobNFT (pipeline label `longread-qc`) on success.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface QcSubmitOptions {
  inputs: string;        // CSV of gs:// inputs (BAM/CRAM and/or FASTA/FASTQ.gz)
  genomeSize?: string;   // haploid genome size in bp for coverage (default 3.1e9)
  json?: boolean;
}

export async function qcSubmitCommand(serial: string, options: QcSubmitOptions): Promise<void> {
  const spinner = ora('Submitting long-read QC job to biofs-node...').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const apiBase = CONFIG.API_BASE_URL;

    const inputs = (options.inputs || '').split(',').map(s => s.trim()).filter(Boolean);
    if (inputs.length === 0) throw new Error('--inputs must list at least one gs:// file');
    for (const u of inputs) if (!u.startsWith('gs://')) throw new Error(`input is not a gs:// URI: ${u}`);

    const jobId = `qc-${serial}-${Date.now()}`;
    const genomeSize = options.genomeSize || '3100000000';

    spinner.text = `Submitting qc for ${serial} (${inputs.length} inputs) -> biofs-node...`;
    const response = await axios.post(`${apiBase}/api_biofs_node/job`, {
      jobId,
      biosampleId: serial,
      inputType: 'qc',
      qcInputs: inputs,
      genomeSize,
      methylBiocid: '',                // operator-signed => admin-bypass consent
      creatorWallet: credentials.wallet_address,
      creatorSig: credentials.user_signature,
      outputBucket: 'genobank-parabricks-output',
      batchId: `qc-${new Date().toISOString().slice(0, 10)}`,
    }, { timeout: 300000 });

    spinner.succeed(chalk.green('qc submitted to biofs-node (QC manifest + ClaraJobNFT anchored on success)'));
    if (options.json) { console.log(JSON.stringify(response.data, null, 2)); return; }
    console.log();
    console.log(chalk.bold('Long-read QC Job (biofs-node):'));
    console.log(`  ${chalk.cyan('Job ID:')}   ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}   ${serial}`);
    console.log(`  ${chalk.cyan('Inputs:')}   ${inputs.length} file(s)`);
    console.log(`  ${chalk.cyan('Metrics:')}  cramino (N50/coverage/length+quality buckets) + seqkit + HiFi rq-tag QV`);
    console.log(`  ${chalk.cyan('Status:')}   ${response.data.status || 'accepted'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit qc job'));
    if (error.response) Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    else Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
