import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';
import { SEQUENTIA_NETWORK, API_CONFIG } from '../lib/config/constants';

export interface TokenizeFastqsOptions {
  recipient?: string;  // Wallet address to grant access to (e.g., approved lab)
  license?: string;    // License type (default: non-commercial)
  quiet?: boolean;
  yes?: boolean;
}

const API_BASE = API_CONFIG.base;

export async function tokenizeFastqsCommand(biosampleSerial: string, options: TokenizeFastqsOptions): Promise<void> {
  // Check credentials
  const credentials = await getCredentials();
  if (!credentials) {
    throw new Error('Not authenticated. Please run "biofs login" first.');
  }

  const network = SEQUENTIA_NETWORK;

  if (!options.quiet) {
    console.log(chalk.cyan('\n🧬 BioFS FASTQ Biosample Tokenization'));
    console.log(chalk.gray('━'.repeat(50)));
    console.log(`\n🔬 Biosample: ${chalk.white(biosampleSerial)}`);
    console.log(`🔐 Patient: ${chalk.white(credentials.wallet_address)}`);
    console.log(`🌐 Network: ${chalk.white(network.name)} (Chain ID: ${network.chainId})`);
    if (options.recipient) {
      console.log(`🏥 Recipient: ${chalk.white(options.recipient)}\n`);
    }
  }

  let spinner = ora('Step 1/2: ⛓️  Granting BioNFT consent on Sequentia...').start();

  try {
    // Step 1: Grant BioNFT consent on Sequentia (patient signs, GenoBank pays gas)
    if (!options.recipient) {
      spinner.fail('Recipient wallet required');
      throw new Error('Please specify --recipient <wallet> to grant consent to');
    }

    // Construct S3 vault path pattern
    const s3VaultPath = `biowallet/${biosampleSerial}/*`;

    const consentResponse = await axios.post(`${API_BASE}/api_sequentias/grant_biosample_consent`, {
      biosample_serial: biosampleSerial,
      patient_wallet: credentials.wallet_address,
      patient_signature: credentials.user_signature,
      agent_wallet: options.recipient,
      s3_vault_path: s3VaultPath,
      allowed_operations: ['read', 'download']  // Standard genomic data access
    });

    if (consentResponse.data.status !== 'Success') {
      spinner.fail('Failed to grant consent');
      throw new Error(consentResponse.data.status_details?.description || 'Consent grant failed');
    }

    const responseData = consentResponse.data.status_details?.data;
    const txHash = responseData?.tx_hash;
    const blockNumber = responseData?.block_number;
    const gasUsed = responseData?.gas_used;

    spinner.succeed('Step 1/2: ✓ BioNFT consent granted successfully!');

    // Step 2: Discover protected files (now that consent exists)
    spinner = ora('Step 2/2: 🔍 Discovering protected FASTQ files...').start();

    const s3Response = await axios.get(`${API_BASE}/api_biofs_fuse/list`, {
      params: {
        biosample: biosampleSerial,
        wallet: options.recipient,  // Agent wallet now has access
        signature: credentials.user_signature,  // Patient still signs for the list request
        rebuild_index: false
      }
    });

    let fastqFilenames: string[] = [];
    if (s3Response.data.error) {
      spinner.warn('Could not list files (consent granted but index may be building)');
      fastqFilenames = ['Files will be available via BioFS mount'];
    } else {
      const allFiles = s3Response.data.files || [];
      fastqFilenames = allFiles.filter((f: string) => f.includes('.fastq'));
      spinner.succeed(`Step 2/2: ✓ Discovered ${fastqFilenames.length} protected FASTQ files`);
    }

    // Display results
    console.log(chalk.gray('\n' + '━'.repeat(50)));
    console.log(chalk.green.bold('🎉 BioNFT Consent Granted!'));
    console.log(chalk.gray('━'.repeat(50) + '\n'));

    console.log(`${chalk.cyan('🔬 Biosample:')}     ${chalk.white(biosampleSerial)}`);
    console.log(`${chalk.cyan('👤 Patient:')}       ${chalk.white(credentials.wallet_address.substring(0, 10))}...`);
    console.log(`${chalk.cyan('🏥 Agent:')}         ${chalk.white(options.recipient.substring(0, 10))}...`);
    console.log(`${chalk.cyan('📁 Files:')}         ${chalk.white(fastqFilenames.length + ' FASTQ files')}`);
    console.log(`${chalk.cyan('🌐 Network:')}       ${chalk.white(network.name)} (Chain ID: ${network.chainId})`);

    if (txHash) {
      console.log(`${chalk.cyan('🔐 Transaction:')}  ${chalk.white(txHash)}`);
    }
    if (blockNumber) {
      console.log(`${chalk.cyan('📦 Block:')}         ${chalk.white(blockNumber)}`);
    }
    if (gasUsed) {
      console.log(`${chalk.cyan('⛽ Gas Used:')}      ${chalk.white(gasUsed.toLocaleString())} (paid by GenoBank)`);
    }

    console.log(`\n${chalk.cyan('📋 FASTQ files protected:')}`);
    fastqFilenames.forEach((filename: string) => {
      console.log(chalk.gray(`   • ${filename}`));
    });

    console.log(chalk.gray('\n💡 Next steps:'));
    console.log(chalk.gray(`   biofs mount /mnt/genomics                   # Mount files for ${options.recipient.substring(0, 10)}...`));
    console.log(chalk.gray(`   # Files will be accessible at /biofs/${biosampleSerial}/\n`));

  } catch (error: any) {
    spinner.fail('Tokenization failed');

    if (error.response?.data?.status_details?.description) {
      throw new Error(error.response.data.status_details.description);
    }

    if (error.response?.data) {
      Logger.debug(`API Response: ${JSON.stringify(error.response.data)}`);
    }

    throw error;
  }
}


