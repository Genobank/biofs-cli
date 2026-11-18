import chalk from 'chalk';
import ora from 'ora';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { Logger } from '../../lib/utils/logger';
import { getCredentials } from '../../lib/auth/credentials';
import { BioNFTClient } from '../../lib/api/bionft-client';
import * as fs from 'fs';
import * as path from 'path';

export interface ClaraJobOptions {
  jobId?: string;
  reference?: string;          // hg38, hg19
  captureKit?: string;         // agilent_v8, etc.
  sequencingType?: string;     // WES, WGS
  intervalFile?: string;       // BED file path
  json?: boolean;              // JSON output format
}

function claraSubmitUrl(biofsNodeUrl: string): string {
  const base = biofsNodeUrl.replace(/\/$/, '');
  // Public nginx maps /api_biofs_node/X → /agent/X. GPU jobs must hit /job
  // so the front node can discover a GPU executor. The legacy
  // /api/v1/clara/submit-job path is only valid on a node that is reached
  // without that rewrite (direct :8787).
  if (/api_biofs_node/i.test(base)) {
    return `${base}/job`;
  }
  return `${base}/api/v1/clara/submit-job`;
}

function loadBiofsConfig(): any {
  const localConfigPath = path.join(process.cwd(), 'config.json');
  const homeConfigPath = path.join(process.env.HOME || '~', '.biofsrc');
  if (fs.existsSync(localConfigPath)) {
    return JSON.parse(fs.readFileSync(localConfigPath, 'utf-8'));
  }
  if (fs.existsSync(homeConfigPath)) {
    return JSON.parse(fs.readFileSync(homeConfigPath, 'utf-8'));
  }
  throw new Error('Config not found. Create config.json or ~/.biofsrc with biofsNode.url');
}

export async function submitClaraCommand(
  biosampleId: string,
  fastqR1?: string,
  fastqR2?: string,
  options: ClaraJobOptions = {}
): Promise<void> {
  const spinner = ora('Submitting Clara Parabricks job...').start();

  try {
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const config = loadBiofsConfig();
    const biofsNodeUrl = config.biofsNode?.url || process.env.BIOFS_NODE_URL;
    if (!biofsNodeUrl) {
      throw new Error('BioFS-Node URL not configured. Set biofsNode.url in config.json or BIOFS_NODE_URL in .env');
    }

    const userWallet = credentials.wallet_address;
    const userSignature = credentials.user_signature;
    const sequencingType = (options.sequencingType || config.services?.clara?.defaultSequencingType || 'WES').toUpperCase();
    const isWgs = sequencingType === 'WGS';

    spinner.text = 'Querying biosample consent record...';
    const bionft = BioNFTClient.getInstance();

    let agentWallet = '0x0f93777fd0dd3ba0b0b834a7ad5680f146ced3f1';
    try {
      const { isTokenized, consent: consentData } = await bionft.checkBiosampleTokenization(biosampleId);
      if (isTokenized && consentData && consentData.agent_wallet) {
        agentWallet = consentData.agent_wallet;
        Logger.info(`✓ Found consent record with agent wallet: ${agentWallet}`);
      } else {
        Logger.info(`✓ Using default agent wallet: ${agentWallet}`);
      }
    } catch {
      Logger.info(`✓ Consent check skipped, using default agent wallet`);
    }

    let finalFastqR1 = fastqR1;
    let finalFastqR2 = fastqR2;
    if (!fastqR1 || !fastqR2) {
      Logger.info('✓ FASTQ files will be auto-discovered by BioFS-Node');
      finalFastqR1 = 'auto';
      finalFastqR2 = 'auto';
    }

    const claraConfig = config.services?.clara || {};
    const jobId = options.jobId || uuidv4();
    const jobData: Record<string, unknown> = {
      jobId,
      biosampleId,
      biosample_serial: biosampleId,
      fastqR1: finalFastqR1,
      fastqR2: finalFastqR2,
      r1Uri: finalFastqR1,
      r2Uri: finalFastqR2,
      r1_uri: finalFastqR1,
      r2_uri: finalFastqR2,
      userWallet,
      creatorWallet: userWallet,
      userSignature,
      user_signature: userSignature,
      creatorSig: userSignature,
      signature: userSignature,
      sequencingType,
      reference: options.reference || claraConfig.defaultReference || 'hg38',
      captureKit: options.captureKit || (isWgs ? 'wgs' : (claraConfig.defaultCaptureKit || 'agilent_v8')),
      intervalFile: options.intervalFile || (isWgs ? '' : (claraConfig.defaultIntervalFile || '/Samples1/hg38/Agilent_V8_SureSelect_hg38.bed')),
      inputType: 'fastq',
    };

    const submitUrl = claraSubmitUrl(biofsNodeUrl);
    spinner.text = `Connecting to BioFS-Node (${submitUrl})...`;

    const response = await axios.post(
      submitUrl,
      jobData,
      {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          'X-Biofs-Signature': userSignature,
        },
      }
    );

    if (response.data.success === false) {
      throw new Error(response.data.error || 'Job submission failed');
    }

    spinner.succeed(chalk.green('✓ Clara job submitted successfully'));

    const payload = {
      success: true,
      jobId: response.data.jobId || jobId,
      biosampleId,
      status: response.data.status || 'accepted',
      sequencingType,
      reference: jobData.reference,
      captureKit: jobData.captureKit,
      fastqR1: finalFastqR1,
      fastqR2: finalFastqR2,
      submittedTo: submitUrl,
      forwarded: response.data.forwarded,
      subsidized: response.data.subsidized,
    };

    if (options.json) {
      console.log(JSON.stringify({ ...response.data, ...payload }, null, 2));
      return;
    }

    console.log();
    console.log(chalk.bold('Clara Parabricks Job Submitted:'));
    console.log(`  ${chalk.cyan('Job ID:')} ${payload.jobId}`);
    console.log(`  ${chalk.cyan('Biosample:')} ${biosampleId}`);
    console.log(`  ${chalk.cyan('Status:')} ${payload.status}`);
    console.log(`  ${chalk.cyan('Sequencing Type:')} ${sequencingType}`);
    console.log(`  ${chalk.cyan('Reference:')} ${jobData.reference}`);
    console.log();
    console.log(chalk.gray('Monitor status: ') + chalk.cyan(`biofs job status ${payload.jobId}`));
    console.log();

  } catch (error: any) {
    spinner.fail(chalk.red('✗ Failed to submit Clara job'));

    if (error.response) {
      Logger.error(`Server error (${error.response.status}): ${JSON.stringify(error.response.data) || error.message}`);
    } else if (error.request) {
      Logger.error(`Cannot connect to BioFS-Node. Is it running at ${error.config?.baseURL || 'configured URL'}?`);
    } else {
      Logger.error(`Error: ${error.message}`);
    }

    process.exit(1);
  }
}
