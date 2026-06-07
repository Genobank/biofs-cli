/**
 * biofs comethyl <serial> --modbam <gs://merged.ont.modBAM> --hifi-vcf <gs://het.vcf> --hifi-bam <csv>
 * biofs comethyl submit <serial> ...
 *
 * CLIENT verb: submits a single-molecule co-methylation analysis job to biofs-node.
 * This is the analysis sibling of `biofs methyl`: methyl PRODUCES the aligned modBAM +
 * bulk bedMethyl; comethyl ANALYZES the per-read 5mCG/5hmCG strings for the signal that
 * bulk averaging destroys (allele-split co-methylation at imprinted DMRs, the
 * co-methylation decay-length lambda, read entropy/PDR).
 *
 * The analysis is a chain of HALTING GATES, pre-registered (see the comethyl design +
 * the digital-twin whitepaper hypotheses H_null-A/H_lambda/H_floor/...):
 *   gate=floor (the first gate, this default): provenance + QC, phase the ONT reads by the
 *     genome's OWN HiFi het SNPs, then the GUARANTEED-FLOOR result, recover bimodal
 *     allele-split co-methylation at known imprinted DMRs (H19/IGF2, KCNQ1OT1, SNRPN,
 *     GNAS, MEST) that bulk averaging (~0.5) destroys, with the allele assignment AGREEING
 *     with the phased haplotypes (within-genome ground truth). PASS iff imprinted DMRs show
 *     the split and non-imprinted controls do not.
 *   later gates (lambda, null-a, ...) run only after the floor passes (separate submissions).
 *
 * Dispatched through the protocol surface (POST /api_biofs_node/job -> nginx ->
 * localhost:8787/agent/job -> processJob), NOT a raw curl. biofs-node verifies consent
 * (operator signature => admin-bypass), spawns `biofs comethyl exec` on the executor, and
 * anchors a ClaraJobNFT (pipeline label `ont-comethyl-floor`) on a PASS.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface ComethylSubmitOptions {
  modbam: string;        // gs:// merged aligned ONT modBAM (MM/ML), the comethyl input
  hifiVcf: string;       // gs:// HiFi het-SNP VCF (phased on the VM if no PS)
  hifiBam: string;       // CSV of gs:// HiFi BAM URIs (for whatshap phase if VCF unphased)
  gate?: string;         // 'floor' (default) | 'lambda' | 'null-a'
  ref?: string;          // 'GRCh38' | 'auto'
  json?: boolean;
}

export async function comethylSubmitCommand(serial: string, options: ComethylSubmitOptions): Promise<void> {
  const spinner = ora('Submitting comethyl analysis job to biofs-node...').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const apiBase = CONFIG.API_BASE_URL;

    if (!options.modbam || !options.modbam.startsWith('gs://')) throw new Error('--modbam must be a gs:// merged ONT modBAM URI');
    if (!options.hifiVcf || !options.hifiVcf.startsWith('gs://')) throw new Error('--hifi-vcf must be a gs:// het-SNP VCF URI');
    const hifiBams = (options.hifiBam || '').split(',').map((s) => s.trim()).filter(Boolean);
    const badBam = hifiBams.filter((u) => !u.startsWith('gs://'));
    if (badBam.length > 0) throw new Error(`--hifi-bam entries must be gs:// URIs. Offending: ${badBam.join(', ')}`);

    const gate = options.gate || 'floor';
    const jobId = `comethyl-${gate}-${serial}-${Date.now()}`;
    const reference = options.ref || 'auto';

    spinner.text = `Submitting comethyl gate=${gate} for ${serial} -> biofs-node...`;
    const response = await axios.post(`${apiBase}/api_biofs_node/job`, {
      jobId,
      biosampleId: serial,
      inputType: 'comethyl',          // discriminator; methyl/bam/fastq/align-shard untouched
      comethylGate: gate,
      comethylModbam: options.modbam,
      comethylHifiVcf: options.hifiVcf,
      comethylHifiBams: hifiBams.join(','),
      methylBiocid: '',               // operator-signed => admin-bypass consent
      reference,
      creatorWallet: credentials.wallet_address,
      creatorSig: credentials.user_signature,
      outputBucket: 'genobank-parabricks-output',
      refBucket: 'genobank-references',
      batchId: `comethyl-${new Date().toISOString().slice(0, 10)}`,
    }, { timeout: 300000 });

    spinner.succeed(chalk.green(`comethyl gate=${gate} submitted to biofs-node (manifest + ClaraJobNFT anchored on PASS)`));
    if (options.json) { console.log(JSON.stringify(response.data, null, 2)); return; }
    console.log();
    console.log(chalk.bold('Comethyl Job (biofs-node):'));
    console.log(`  ${chalk.cyan('Job ID:')}   ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}   ${serial}`);
    console.log(`  ${chalk.cyan('Gate:')}     ${gate}${gate === 'floor' ? ' (provenance + QC + imprinting/ASM allele-split floor)' : ''}`);
    console.log(`  ${chalk.cyan('modBAM:')}   ${options.modbam}`);
    console.log(`  ${chalk.cyan('Status:')}   ${response.data.status || 'accepted'}`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit comethyl job'));
    if (error.response) Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    else Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
