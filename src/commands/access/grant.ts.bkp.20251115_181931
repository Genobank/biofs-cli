import chalk from 'chalk';
import ora from 'ora';
import { GenoBankAPIClient } from '../../lib/api/client';
import { Logger } from '../../lib/utils/logger';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import { ethers } from 'ethers';

export interface AccessGrantOptions {
  expiresIn?: string;
}

export async function accessGrantCommand(
  bioSampleOrIpId: string,
  agentWalletAddress: string,
  options: AccessGrantOptions
): Promise<void> {
  const spinner = ora('Granting Sequentia biosample consent...').start();

  try {
    const api = GenoBankAPIClient.getInstance();

    // Validate wallet address format
    if (!agentWalletAddress.startsWith('0x') || agentWalletAddress.length !== 42) {
      throw new Error('Invalid wallet address format. Expected 0x... (42 characters)');
    }

    // Determine if this is a biosample serial or Story Protocol IP asset
    const isBioSample = /^\d{11,}$/.test(bioSampleOrIpId); // Biosample serials are numeric
    const isStoryProtocolId = bioSampleOrIpId.startsWith('0x') || bioSampleOrIpId.startsWith('biocid://');

    if (isBioSample) {
      // SEQUENTIA FLOW: Grant biosample consent on Sequentia blockchain
      spinner.text = 'Obtaining patient signature for Sequentia consent...';

      // Get patient wallet from stored credentials or ask user
      let patientWallet: string | null = null;
      let patientSignature: string | null = null;

      // Try to get from stored credentials
      const credPath = `${os.homedir()}/.biofs/credentials.json`;
      if (fs.existsSync(credPath)) {
        try {
          const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
          patientWallet = creds.wallet;
        } catch (e) {
          // Ignore parse errors
        }
      }

      if (!patientWallet) {
        throw new Error(
          'Patient wallet not found. Please ensure you are logged in: biofs login'
        );
      }

      spinner.text = 'Requesting patient signature (message: "I want to proceed")...';
      spinner.info(
        chalk.yellow(
          '\n⚠️  Patient signature required (FREE - no gas fee):\n' +
          '   Message: "I want to proceed"\n' +
          `   To: ${agentWalletAddress}\n`
        )
      );

      // In production, this would open a MetaMask prompt
      // For now, provide interactive prompt
      patientSignature = await promptForSignature();

      if (!patientSignature) {
        throw new Error('Patient signature required to grant consent');
      }

      spinner.start('Submitting consent to Sequentia blockchain...');

      // Call Sequentia API endpoint
      const consentResponse = await fetch('https://genobank.app/api_sequentias/grant_biosample_consent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          biosample_serial: bioSampleOrIpId,
          patient_wallet: patientWallet,
          patient_signature: patientSignature,
          agent_wallet: agentWalletAddress,
          s3_vault_path: `biowallet/${bioSampleOrIpId}/*`,
          allowed_operations: ['read', 'download']
        })
      });

      if (!consentResponse.ok) {
        const errorData = await consentResponse.json() as any;
        throw new Error(
          `Consent grant failed: ${errorData?.status_details?.description || consentResponse.statusText}`
        );
      }

      const result = await consentResponse.json() as any;

      if (result.status !== 'Success') {
        throw new Error(
          `Consent grant failed: ${result.status_details?.description || 'Unknown error'}`
        );
      }

      spinner.succeed(
        chalk.green('✓ Biosample consent granted on Sequentia blockchain')
      );

      // Display confirmation
      const txData = result.status_details?.data as any;
      console.log('\n' + chalk.cyan('═'.repeat(70)));
      console.log(chalk.bold('  Sequentia Biosample Consent - Transaction Confirmation'));
      console.log(chalk.cyan('═'.repeat(70)));
      console.log(chalk.gray('  Blockchain:'), chalk.blue('Sequentia L1 (Chain ID: 15132025)'));
      console.log(chalk.gray('  Biosample Serial:'), bioSampleOrIpId);
      console.log(chalk.gray('  Patient Wallet:'), patientWallet);
      console.log(chalk.gray('  Agent Wallet:'), agentWalletAddress);
      if (txData?.tx_hash) {
        console.log(chalk.gray('  Transaction Hash:'), chalk.cyan(txData.tx_hash));
        console.log(chalk.gray('  Block Number:'), txData.block_number);
        console.log(chalk.gray('  Gas Used:'), `${txData.gas_used || 'N/A'}`);
      }
      console.log(chalk.gray('  Status:'), chalk.green('✅ ACTIVE'));
      console.log(chalk.cyan('═'.repeat(70)));
      console.log();

      console.log(chalk.green('✓ Agent can now access FASTQ files via BioNFT-gated SSHFS mount:'));
      console.log(chalk.cyan(`  biofs mount biocid://${bioSampleOrIpId} /mnt/biofs`));

    } else if (isStoryProtocolId) {
      // STORY PROTOCOL FLOW: Legacy support for BioIP assets
      spinner.text = 'Resolving Story Protocol IP asset...';

      let ipId: string;

      if (bioSampleOrIpId.startsWith('biocid://')) {
        spinner.text = 'Resolving BioCID...';
        const registrationId = bioSampleOrIpId.split('/bioip/')[1]?.split('/')[0] || '';
        if (!registrationId) {
          throw new Error('Invalid BioCID format');
        }

        const bioips = await api.getMyBioIPs();
        const bioip = bioips.find((b: any) => b.registration_id === registrationId);
        if (!bioip) {
          throw new Error('BioIP asset not found or you are not the owner');
        }
        ipId = bioip.ip_id;
      } else {
        ipId = bioSampleOrIpId;
      }

      spinner.text = 'Minting Story Protocol license token...';
      const result = await api.directGrantLicenseToken(ipId, agentWalletAddress, 'non-commercial');

      spinner.succeed(chalk.green('✓ License token minted on Story Protocol'));

      console.log('\n' + chalk.cyan('═'.repeat(66)));
      console.log(chalk.bold('  Story Protocol License Grant (Legacy)'));
      console.log(chalk.cyan('═'.repeat(66)));
      console.log(chalk.gray('  IP Asset ID:'), ipId);
      console.log(chalk.gray('  Granted To:'), agentWalletAddress);
      console.log(chalk.gray('  License Type:'), chalk.green('Non-Commercial'));
      if (result.tx_hash) {
        console.log(chalk.gray('  Transaction:'), chalk.blue(result.tx_hash));
      }
      console.log(chalk.cyan('═'.repeat(66)));
      console.log();

      console.log(chalk.green('✓ The researcher can now download files using:'));
      console.log(chalk.cyan(`  biofs s3 cp ${bioSampleOrIpId} ./destination`));

    } else {
      throw new Error(
        'Invalid format. Expected:\n' +
        '  - Biosample serial (11+ digits, e.g., 55052008714000)\n' +
        '  - BioCID (biocid://...)\n' +
        '  - Story Protocol IP ID (0x...)'
      );
    }

  } catch (error: any) {
    spinner.fail(chalk.red('✗ Consent grant failed'));
    Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

async function promptForSignature(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(
      chalk.yellow('Enter signed message (0x...): '),
      (signature: string) => {
        rl.close();
        resolve(signature.trim());
      }
    );
  });
}
