import chalk from 'chalk';
import ora from 'ora';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { Logger } from '../../lib/utils/logger';
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

export async function submitClaraCommand(
  biosampleId: string,
  fastqR1: string,
  fastqR2: string,
  options: ClaraJobOptions = {}
): Promise<void> {
  const spinner = ora('Submitting Clara Parabricks job...').start();

  try {
    // Load config
    const configPath = path.join(process.cwd(), 'config.json');
    if (!fs.existsSync(configPath)) {
      throw new Error('config.json not found. Please run in biofs-cli directory.');
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const biofsNodeUrl = config.biofsNode?.url || process.env.BIOFS_NODE_URL;
    const userWallet = config.wallet?.address || process.env.BIOFS_NODE_WALLET;

    if (!biofsNodeUrl) {
      throw new Error('BioFS-Node URL not configured. Set biofsNode.url in config.json or BIOFS_NODE_URL in .env');
    }

    if (!userWallet) {
      throw new Error('Wallet address not configured. Set wallet.address in config.json or BIOFS_NODE_WALLET in .env');
    }

    // Use Clara defaults from config
    const claraConfig = config.services?.clara || {};
    const jobData = {
      jobId: options.jobId || uuidv4(),
      biosampleId,
      fastqR1,
      fastqR2,
      userWallet,
      sequencingType: options.sequencingType || claraConfig.defaultSequencingType || 'WES',
      reference: options.reference || claraConfig.defaultReference || 'hg38',
      captureKit: options.captureKit || claraConfig.defaultCaptureKit || 'agilent_v8',
      intervalFile: options.intervalFile || claraConfig.defaultIntervalFile || '/Samples1/hg38/Agilent_V8_SureSelect_hg38.bed'
    };

    spinner.text = 'Connecting to BioFS-Node...';

    // Submit job to BioFS-Node
    const response = await axios.post(
      `${biofsNodeUrl}/api/v1/clara/submit-job`,
      jobData,
      {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.data.success) {
      throw new Error(response.data.error || 'Job submission failed');
    }

    spinner.succeed(chalk.green('✓ Clara job submitted successfully'));

    if (options.json) {
      console.log(JSON.stringify(response.data, null, 2));
      return;
    }

    console.log();
    console.log(chalk.bold('Clara Parabricks Job Submitted:'));
    console.log(`  ${chalk.cyan('Job ID:')} ${response.data.jobId}`);
    console.log(`  ${chalk.cyan('Biosample:')} ${biosampleId}`);
    console.log(`  ${chalk.cyan('Status:')} ${response.data.status}`);
    console.log(`  ${chalk.cyan('Sequencing Type:')} ${jobData.sequencingType}`);
    console.log(`  ${chalk.cyan('Reference:')} ${jobData.reference}`);
    console.log(`  ${chalk.cyan('Capture Kit:')} ${jobData.captureKit}`);
    console.log();
    console.log(chalk.bold('Input Files:'));
    console.log(`  ${chalk.cyan('R1:')} ${fastqR1}`);
    console.log(`  ${chalk.cyan('R2:')} ${fastqR2}`);
    console.log();
    console.log(chalk.gray('Monitor status: ') + chalk.cyan(`biofs job status ${response.data.jobId}`));
    console.log(chalk.gray('Or via API: ') + chalk.cyan(`curl ${biofsNodeUrl}/api/v1/clara/job/${response.data.jobId}`));
    console.log();

  } catch (error: any) {
    spinner.fail(chalk.red('✗ Failed to submit Clara job'));

    if (error.response) {
      Logger.error(`Server error (${error.response.status}): ${error.response.data?.error || error.message}`);
    } else if (error.request) {
      Logger.error(`Cannot connect to BioFS-Node. Is it running at ${error.config?.baseURL || 'configured URL'}?`);
    } else {
      Logger.error(`Error: ${error.message}`);
    }

    process.exit(1);
  }
}
