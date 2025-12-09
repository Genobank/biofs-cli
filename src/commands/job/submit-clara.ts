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

export async function submitClaraCommand(
  biosampleId: string,
  fastqR1?: string,
  fastqR2?: string,
  options: ClaraJobOptions = {}
): Promise<void> {
  const spinner = ora('Submitting Clara Parabricks job...').start();

  try {
    // Get credentials
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    // Load config (check multiple locations)
    let config: any;
    const localConfigPath = path.join(process.cwd(), 'config.json');
    const homeConfigPath = path.join(process.env.HOME || '~', '.biofsrc');

    if (fs.existsSync(localConfigPath)) {
      config = JSON.parse(fs.readFileSync(localConfigPath, 'utf-8'));
    } else if (fs.existsSync(homeConfigPath)) {
      config = JSON.parse(fs.readFileSync(homeConfigPath, 'utf-8'));
    } else {
      throw new Error('Config not found. Create config.json or ~/.biofsrc with biofsNode.url');
    }

    const biofsNodeUrl = config.biofsNode?.url || process.env.BIOFS_NODE_URL;

    if (!biofsNodeUrl) {
      throw new Error('BioFS-Node URL not configured. Set biofsNode.url in config.json or BIOFS_NODE_URL in .env');
    }

    const userWallet = credentials.wallet_address;
    const userSignature = credentials.user_signature;

    // Step 1: Query consent record (optional - will use defaults if not found)
    spinner.text = 'Querying biosample consent record...';
    const bionft = BioNFTClient.getInstance();

    let agentWallet = '0x0f93777fd0dd3ba0b0b834a7ad5680f146ced3f1'; // Default agent wallet
    let consent: any = null;

    try {
      const { isTokenized, consent: consentData } = await bionft.checkBiosampleTokenization(biosampleId);
      if (isTokenized && consentData && consentData.agent_wallet) {
        agentWallet = consentData.agent_wallet;
        consent = consentData;
        Logger.info(`✓ Found consent record with agent wallet: ${agentWallet}`);
      } else {
        Logger.info(`✓ Using default agent wallet: ${agentWallet}`);
      }
    } catch (error: any) {
      // Consent check failed - use defaults
      Logger.info(`✓ Consent check skipped, using default agent wallet`);
    }

    // Step 2: FASTQ files (BioFS-Node will auto-discover from QUIC mount)
    let finalFastqR1 = fastqR1;
    let finalFastqR2 = fastqR2;

    if (!fastqR1 || !fastqR2) {
      // BioFS-Node processor will auto-discover from /biofs/<biosample_id>/
      Logger.info('✓ FASTQ files will be auto-discovered by BioFS-Node');
      finalFastqR1 = 'auto';
      finalFastqR2 = 'auto';
    }

    // Use Clara defaults from config
    const claraConfig = config.services?.clara || {};
    const jobData = {
      jobId: options.jobId || uuidv4(),
      biosampleId,
      fastqR1: finalFastqR1,
      fastqR2: finalFastqR2,
      userWallet,  // Patient wallet (biofs-node expects 'userWallet' not 'patientWallet')
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
    console.log(chalk.bold('Consent Details:'));
    console.log(`  ${chalk.cyan('Patient Wallet:')} ${userWallet.substring(0, 10)}...`);
    console.log(`  ${chalk.cyan('Processing Agent:')} ${(agentWallet || 'None').substring(0, 10)}...`);
    console.log();
    console.log(chalk.bold('Input Files:'));
    console.log(`  ${chalk.cyan('R1:')} ${finalFastqR1}`);
    console.log(`  ${chalk.cyan('R2:')} ${finalFastqR2}`);
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


