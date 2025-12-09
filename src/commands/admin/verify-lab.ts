/**
 * Admin Verify Lab Command - Sequentia Network
 *
 * Verifies lab registration and LabNFT ownership on-chain.
 * Checks:
 * - LabNFT ownership
 * - Lab verification status
 * - MongoDB registration
 * - Lab details
 *
 * @author GenoBank.io - BioFS CLI Team
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { LabNFT } from '../../lib/sequentia';
import * as dotenv from 'dotenv';

// Load environment variables (try production API path, then local)
const envPath = process.env.BIOFS_ENV_PATH || '/home/ubuntu/Genobank_APIs/production_api/.env';
dotenv.config({ path: envPath });

const SEQUENTIA_EXECUTOR_KEY = process.env.SEQUENTIA_EXECUTOR_KEY;

/**
 * Verify lab registration
 */
export async function verifyLab(wallet: string): Promise<void> {
  const spinner = ora();

  try {
    console.log(chalk.cyan.bold('\n🔍 Lab Verification - Sequentia Network\n'));

    if (!SEQUENTIA_EXECUTOR_KEY) {
      throw new Error('SEQUENTIA_EXECUTOR_KEY not found in environment');
    }

    // Initialize LabNFT client
    const labNFT = new LabNFT(SEQUENTIA_EXECUTOR_KEY);

    // Step 1: Check if wallet has LabNFT
    spinner.start('Checking LabNFT ownership...');
    const isRegistered = await labNFT.isLabRegistered(wallet);

    if (!isRegistered) {
      spinner.fail('Lab not registered');
      console.log(chalk.yellow('\n⚠️  This wallet does not have a LabNFT'));
      console.log(chalk.gray('  Register with: biofs admin register-lab <website_url>'));
      process.exit(1);
    }

    spinner.succeed('LabNFT found');

    // Step 2: Get lab serial
    spinner.start('Retrieving lab information...');
    const serial = await labNFT.getSerialByWallet(wallet);
    const labInfo = await labNFT.getLabBySerial(serial);
    spinner.succeed('Lab information retrieved');

    // Display lab details
    console.log(chalk.green.bold('\n✅ Lab Verified!\n'));
    console.log(chalk.cyan('LabNFT Details:'));
    console.log(chalk.gray('  Serial:'), chalk.white(`#${labInfo.serial}`));
    console.log(chalk.gray('  Contract:'), chalk.white(LabNFT.getContractAddress()));
    console.log(chalk.gray('  Owner:'), chalk.white(labInfo.owner));

    console.log(chalk.cyan('\nLab Information:'));
    console.log(chalk.gray('  Name:'), chalk.white(labInfo.name));
    console.log(chalk.gray('  Type:'), chalk.white(getLabTypeName(labInfo.labType)));
    console.log(chalk.gray('  Specialization:'), chalk.white(labInfo.specialization));
    console.log(chalk.gray('  Location:'), chalk.white(labInfo.location || 'N/A'));
    console.log(chalk.gray('  Website:'), chalk.white(labInfo.website || 'N/A'));
    console.log(chalk.gray('  Email:'), chalk.white(labInfo.email || 'N/A'));

    console.log(chalk.cyan('\nAccess Control:'));
    console.log(chalk.gray('  Access Level:'), chalk.white(getAccessLevelName(labInfo.accessLevel)));
    console.log(chalk.gray('  GA4GH Level:'), chalk.white(getGA4GHLevelName(labInfo.ga4ghLevel)));
    console.log(chalk.gray('  Verified:'), labInfo.verified ? chalk.green('✅ Yes') : chalk.yellow('⏳ Pending'));
    console.log(chalk.gray('  Active:'), labInfo.active ? chalk.green('✅ Yes') : chalk.red('❌ No'));

    console.log(chalk.cyan('\nGDPR Consent:'));
    console.log(chalk.gray('  Biodata Consent:'), chalk.white(labInfo.biodataConsentHash));
    console.log(chalk.gray('  Commercial Consent:'), chalk.white(labInfo.commercialConsentHash));

    console.log(chalk.cyan('\nNetwork:'));
    console.log(chalk.gray('  Network:'), chalk.white('Sequentia L1'));
    console.log(chalk.gray('  Chain ID:'), chalk.white('15132025'));
    console.log(chalk.gray('  RPC:'), chalk.white('http://52.90.163.112:8545'));

  } catch (error: any) {
    spinner.fail('Verification failed');
    console.error(chalk.red(`\n❌ Error: ${error.message}`));

    if (process.env.DEBUG) {
      console.error(chalk.gray('\nStack trace:'));
      console.error(error.stack);
    }

    process.exit(1);
  }
}

/**
 * Helper functions for human-readable names
 */
function getLabTypeName(labType: number): string {
  const types = ['Lab', 'Researcher', 'Institution'];
  return types[labType] || 'Unknown';
}

function getAccessLevelName(level: number): string {
  const levels = [
    'Research Only',
    'Clinical Non-Critical',
    'Clinical Critical',
    'Commercial'
  ];
  return levels[level] || 'Unknown';
}

function getGA4GHLevelName(level: number): string {
  const levels = ['None', 'Basic', 'Lite', 'Full'];
  return levels[level] || 'Unknown';
}

/**
 * Create the verify-lab command
 */
export function createVerifyLabCommand(): Command {
  return new Command('verify-lab')
    .description('Verify lab registration and LabNFT ownership on Sequentia Network')
    .argument('<wallet>', 'Lab wallet address')
    .action(async (wallet: string) => {
      await verifyLab(wallet);
    });
}


