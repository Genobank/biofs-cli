/**
 * biofs verkko <serial> --hifi <biocid,biocid> --nano <biocid,...>
 * biofs verkko submit <serial> ...
 *
 * CLIENT verb: submits a verkko T2T genome-assembly job to biofs-node. Inputs are BIOCIDS from
 * biorouter (NOT raw gs:// paths) so the BioNFT/consent gate is enforced: biofs-node resolves each
 * biocid -> gs:// via bioroutes.inventory AND verifies consent before any byte is read; only the
 * gated, resolved paths reach the executor. The executor downsamples HiFi, extracts ONT ultralong
 * (>= --ont-minlen) to fastq, runs verkko 2.3.2 (local), and persists the assembly to the biowallet
 * verkko/ folder. Multi-day job. Dispatched through the protocol surface
 * (POST /api_biofs_node/job -> biofs-node), NOT a raw script. biofs-node anchors a ClaraJobNFT
 * (pipeline label `verkko-t2t`) on success.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';

export interface VerkkoSubmitOptions {
  hifi: string;            // CSV of biocid:// HiFi reads (biorouter)
  nano: string;            // CSV of biocid:// ONT reads (biorouter)
  hifiProp?: string;       // keep this proportion of HiFi reads (downsample), default 1.0
  ontMinlen?: string;      // keep ONT reads >= this length (bp), default 100000 (ultralong)
  localMemory?: string;    // verkko --local-memory GB, default 320
  localCpus?: string;      // verkko --local-cpus, default 80
  json?: boolean;
}

function isBiocid(s: string): boolean { return /^BioCID:/i.test(s) || /^biocid:\/\//i.test(s); }

export async function verkkoSubmitCommand(serial: string, options: VerkkoSubmitOptions): Promise<void> {
  const spinner = ora('Submitting verkko T2T assembly job to biofs-node...').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    const apiBase = CONFIG.API_BASE_URL;

    const hifi = (options.hifi || '').split(',').map(s => s.trim()).filter(Boolean);
    const nano = (options.nano || '').split(',').map(s => s.trim()).filter(Boolean);
    if (hifi.length === 0) throw new Error('--hifi must list at least one biocid (from biorouter)');
    if (nano.length === 0) throw new Error('--nano must list at least one biocid (from biorouter)');
    for (const b of [...hifi, ...nano]) {
      if (b.startsWith('gs://')) throw new Error(`raw gs:// is not allowed — pass the biorouter biocid instead: ${b}`);
      if (!isBiocid(b)) throw new Error(`not a biocid (expected BioCID:... from biorouter): ${b}`);
    }

    const jobId = `verkko-${serial}-${Date.now()}`;
    const outputBucket = 'genobank-parabricks-output';
    const creatorLc = (credentials.wallet_address || '').toLowerCase();
    const manifestUri = `gs://${outputBucket}/biowallet/${creatorLc}/verkko/${jobId}/manifest.json`;

    spinner.text = `Submitting verkko for ${serial} (HiFi x${hifi.length}, ONT x${nano.length} biocids) -> biofs-node...`;
    const response = await axios.post(`${apiBase}/api_biofs_node/job`, {
      jobId,
      biosampleId: serial,
      inputType: 'verkko',
      verkkoHifiBiocids: hifi,
      verkkoNanoBiocids: nano,
      // consent: biofs-node verifyConsent runs over every input biocid (operator => admin-bypass)
      methylBiocid: [...hifi, ...nano].join(','),
      hifiProp: options.hifiProp || '1.0',
      ontMinlen: options.ontMinlen || '100000',
      localMemory: options.localMemory || '320',
      localCpus: options.localCpus || '80',
      manifestUri,
      creatorWallet: credentials.wallet_address,
      creatorSig: credentials.user_signature,
      outputBucket,
      batchId: `verkko-${new Date().toISOString().slice(0, 10)}`,
    }, { timeout: 300000 });

    spinner.succeed(chalk.green('verkko submitted to biofs-node (biocids gated via biorouter; ClaraJobNFT anchored on success)'));
    if (options.json) { console.log(JSON.stringify(response.data, null, 2)); return; }
    console.log();
    console.log(chalk.bold('Verkko T2T Assembly Job (biofs-node):'));
    console.log(`  ${chalk.cyan('Job ID:')}   ${response.data.jobId || jobId}`);
    console.log(`  ${chalk.cyan('Sample:')}   ${serial}`);
    console.log(`  ${chalk.cyan('HiFi:')}     ${hifi.length} biocid(s)  (keep prop ${options.hifiProp || '1.0'})`);
    console.log(`  ${chalk.cyan('ONT:')}      ${nano.length} biocid(s)  (ultralong >= ${options.ontMinlen || '100000'} bp)`);
    console.log(`  ${chalk.cyan('Gate:')}     biorouter biocid -> gs:// + verifyConsent (BioNFT)`);
    console.log(`  ${chalk.cyan('Verkko:')}   2.3.2  local-memory=${options.localMemory || '320'}G  local-cpus=${options.localCpus || '80'}`);
    console.log(`  ${chalk.cyan('Status:')}   ${response.data.status || 'accepted'} (multi-day run)`);
    console.log();
    console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs job status ${response.data.jobId || jobId}`));
    console.log();
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to submit verkko job'));
    if (error.response) Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.response.data?.message || error.message}`);
    else Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
