/**
 * GA4GH Researcher Verification Command
 *
 * Verifies researcher credentials and visa status
 *
 * @author GenoBank.io
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ethers } from 'ethers';
import Table from 'cli-table3';
import { ApiClient } from '../../lib/api/client';
import { loadCredentials } from '../../lib/auth/credentials';
import { logger } from '../../lib/utils/logger';

interface VerifyOptions {
  wallet?: string;
  visaType?: string;
  datasetId?: string;
  masterNode?: string;
}

const VISA_TYPES = [
  'ResearcherStatus',
  'ControlledAccessGrants',
  'AffiliationAndRole',
  'AcceptedTermsAndPolicies',
  'LinkedIdentities'
];

/**
 * Verify researcher credentials
 */
export async function verifyResearcher(options: VerifyOptions) {
  const spinner = ora();

  try {
    // Load credentials
    const credentials = await loadCredentials();
    const wallet = options.wallet || credentials?.wallet;

    if (!wallet) {
      logger.error('Please specify wallet address or login first');
      process.exit(1);
    }

    // Validate wallet address
    if (!ethers.isAddress(wallet)) {
      logger.error(`Invalid wallet address: ${wallet}`);
      process.exit(1);
    }

    // Initialize API client
    const apiClient = new ApiClient({
      baseUrl: options.masterNode || process.env.BIOFS_MASTER_NODE || 'http://localhost:3000',
      credentials,
    });

    // Check if bona fide researcher
    spinner.start('Checking researcher status...');
    const bonafideResponse = await apiClient.get(`/api/v1/researchers/${wallet}/bonafide`);
    spinner.stop();

    console.log('\n' + chalk.cyan('🔍 Researcher Verification Results'));
    console.log(chalk.gray('━'.repeat(50)));

    // Display bona fide status
    if (bonafideResponse.is_bonafide) {
      console.log(chalk.green('✅ Bona Fide Researcher Status: VERIFIED'));
    } else {
      console.log(chalk.red('❌ Bona Fide Researcher Status: NOT VERIFIED'));
      console.log(chalk.yellow('   You need a ResearcherStatus visa to be recognized as a bona fide researcher'));
    }

    // If specific visa type requested
    if (options.visaType) {
      spinner.start(`Verifying ${options.visaType} visa...`);

      const verifyResponse = await apiClient.post('/api/v1/researchers/visa/verify', {
        researcher_wallet: wallet,
        visa_type: options.visaType,
        dataset_id: options.datasetId,
      });

      spinner.stop();

      if (verifyResponse.valid) {
        console.log('\n' + chalk.green(`✅ ${options.visaType}: VALID`));
        if (options.datasetId) {
          console.log(chalk.gray(`   Dataset ${options.datasetId}: ACCESS GRANTED`));
        }
      } else {
        console.log('\n' + chalk.red(`❌ ${options.visaType}: INVALID`));
        if (options.datasetId) {
          console.log(chalk.gray(`   Dataset ${options.datasetId}: ACCESS DENIED`));
        }
      }
    } else {
      // Verify all visa types
      console.log('\n' + chalk.cyan('📋 Visa Status:'));

      const table = new Table({
        head: ['Visa Type', 'Status'],
        style: {
          head: ['cyan'],
        },
      });

      for (const visaType of VISA_TYPES) {
        spinner.start(`Checking ${visaType}...`);

        try {
          const response = await apiClient.post('/api/v1/researchers/visa/verify', {
            researcher_wallet: wallet,
            visa_type: visaType,
          });

          spinner.stop();

          table.push([
            visaType,
            response.valid
              ? chalk.green('✓ Valid')
              : chalk.gray('- Not Present'),
          ]);
        } catch (error) {
          spinner.stop();
          table.push([visaType, chalk.gray('- Error')]);
        }
      }

      console.log(table.toString());
    }

    // Get researcher profile
    try {
      spinner.start('Fetching researcher profile...');
      const profile = await apiClient.get(`/api/v1/researchers/${wallet}/profile`);
      spinner.stop();

      if (profile) {
        console.log('\n' + chalk.cyan('👤 Researcher Profile:'));
        console.log(chalk.gray('  Wallet:'), profile.wallet);
        console.log(chalk.gray('  Active:'), profile.active ? chalk.green('Yes') : chalk.red('No'));
        console.log(chalk.gray('  Reputation:'), profile.reputation + '/100');
        console.log(chalk.gray('  Total Accesses:'), profile.total_accesses);
        console.log(chalk.gray('  Violations:'), profile.violations || 0);
        console.log(chalk.gray('  Issued:'), new Date(profile.issued_at * 1000).toLocaleDateString());
        console.log(chalk.gray('  Expires:'), new Date(profile.expires_at * 1000).toLocaleDateString());
      }
    } catch (error) {
      // Profile not found is okay
    }

    console.log('\n' + chalk.gray('Use "biofs-cli researcher status" for detailed information'));
  } catch (error: any) {
    spinner.fail('Verification failed');
    logger.error(error.message);
    process.exit(1);
  }
}

/**
 * Create the verify command
 */
export function createVerifyCommand(): Command {
  return new Command('verify')
    .description('Verify researcher credentials and visa status')
    .option(
      '-w, --wallet <address>',
      'Researcher wallet address (defaults to logged-in wallet)'
    )
    .option(
      '-t, --visa-type <type>',
      'Specific visa type to verify',
      (value) => {
        if (!VISA_TYPES.includes(value)) {
          logger.error(`Invalid visa type. Must be one of: ${VISA_TYPES.join(', ')}`);
          process.exit(1);
        }
        return value;
      }
    )
    .option(
      '-d, --dataset-id <id>',
      'Dataset ID for ControlledAccessGrants verification'
    )
    .option(
      '-m, --master-node <url>',
      'Master node URL',
      process.env.BIOFS_MASTER_NODE
    )
    .action(async (options: VerifyOptions) => {
      await verifyResearcher(options);
    });
}
