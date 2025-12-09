/**
 * GA4GH Researcher Status Command
 *
 * Displays detailed researcher profile and access permissions
 *
 * @author GenoBank.io
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ethers } from 'ethers';
import Table from 'cli-table3';
import boxen from 'boxen';
import * as path from 'path';
import * as fs from 'fs-extra';
import { ApiClient } from '../../lib/api/client';
import { loadCredentials } from '../../lib/auth/credentials';
import { logger } from '../../lib/utils/logger';
import { formatBytes, formatDate } from '../../lib/utils/format';

interface StatusOptions {
  wallet?: string;
  verbose?: boolean;
  export?: string;
  masterNode?: string;
}

/**
 * Display researcher status
 */
export async function researcherStatus(options: StatusOptions) {
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

    // Get researcher profile
    spinner.start('Fetching researcher profile...');
    let profile;
    try {
      profile = await apiClient.get(`/api/v1/researchers/${wallet}/profile`);
    } catch (error) {
      spinner.fail('Researcher not registered');
      console.log('\n' + chalk.yellow('This wallet is not registered with GA4GH Passport'));
      console.log(chalk.gray('To register, run: biofs-cli researcher register --jwt-file <passport.jwt>'));
      process.exit(0);
    }
    spinner.succeed('Profile loaded');

    // Check bona fide status
    spinner.start('Checking researcher status...');
    const bonafideResponse = await apiClient.get(`/api/v1/researchers/${wallet}/bonafide`);
    spinner.stop();

    // Display header
    console.log('\n' + boxen(
      chalk.bold('GA4GH Researcher Profile'),
      {
        padding: 1,
        margin: { top: 0, bottom: 1, left: 0, right: 0 },
        borderStyle: 'double',
        borderColor: 'cyan',
      }
    ));

    // Basic Information
    console.log(chalk.cyan('📋 Basic Information'));
    console.log(chalk.gray('━'.repeat(50)));

    const infoTable = new Table({
      chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
    });

    infoTable.push(
      [chalk.gray('Wallet Address:'), profile.wallet],
      [chalk.gray('Status:'), profile.active ? chalk.green('✓ Active') : chalk.red('✗ Inactive')],
      [chalk.gray('Bona Fide Researcher:'), bonafideResponse.is_bonafide ? chalk.green('✓ Verified') : chalk.yellow('⚠ Not Verified')],
      [chalk.gray('Passport Hash:'), profile.passport_hash?.substring(0, 20) + '...'],
      [chalk.gray('Issuer DID:'), profile.issuer_did || 'N/A']
    );

    console.log(infoTable.toString());

    // Dates
    console.log('\n' + chalk.cyan('📅 Validity Period'));
    console.log(chalk.gray('━'.repeat(50)));

    const dateTable = new Table({
      chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
    });

    const issuedDate = new Date(profile.issued_at * 1000);
    const expiresDate = new Date(profile.expires_at * 1000);
    const now = new Date();
    const daysRemaining = Math.ceil((expiresDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    dateTable.push(
      [chalk.gray('Issued:'), formatDate(issuedDate)],
      [chalk.gray('Expires:'), formatDate(expiresDate)],
      [chalk.gray('Days Remaining:'), daysRemaining > 0 ? chalk.green(`${daysRemaining} days`) : chalk.red('Expired')]
    );

    console.log(dateTable.toString());

    // Reputation & Activity
    console.log('\n' + chalk.cyan('⭐ Reputation & Activity'));
    console.log(chalk.gray('━'.repeat(50)));

    const reputationTable = new Table({
      chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
    });

    const reputationColor = profile.reputation >= 80 ? 'green' :
                           profile.reputation >= 50 ? 'yellow' : 'red';

    reputationTable.push(
      [chalk.gray('Reputation Score:'), chalk[reputationColor](`${profile.reputation}/100`)],
      [chalk.gray('Total Data Accesses:'), profile.total_accesses || 0],
      [chalk.gray('Policy Violations:'), profile.violations > 0 ? chalk.red(profile.violations) : chalk.green('0')]
    );

    console.log(reputationTable.toString());

    // Verify all visas
    if (options.verbose) {
      console.log('\n' + chalk.cyan('🎫 Visa Status'));
      console.log(chalk.gray('━'.repeat(50)));

      const visaTable = new Table({
        head: ['Visa Type', 'Status', 'Purpose'],
        style: { head: ['cyan'] },
      });

      const visaTypes = [
        { type: 'ResearcherStatus', purpose: 'Bona fide researcher certification' },
        { type: 'ControlledAccessGrants', purpose: 'Dataset-specific access permissions' },
        { type: 'AffiliationAndRole', purpose: 'Institutional affiliation' },
        { type: 'AcceptedTermsAndPolicies', purpose: 'Ethics and terms acceptance' },
        { type: 'LinkedIdentities', purpose: 'Cross-platform identity linking' },
      ];

      for (const visa of visaTypes) {
        try {
          const response = await apiClient.post('/api/v1/researchers/visa/verify', {
            researcher_wallet: wallet,
            visa_type: visa.type,
          });

          visaTable.push([
            visa.type,
            response.valid ? chalk.green('✓ Valid') : chalk.gray('- Not Present'),
            chalk.gray(visa.purpose),
          ]);
        } catch (error) {
          visaTable.push([
            visa.type,
            chalk.gray('- Error'),
            chalk.gray(visa.purpose),
          ]);
        }
      }

      console.log(visaTable.toString());
    }

    // Check local configuration
    const configPath = path.join(process.env.HOME || '~', '.biofs', 'ga4gh.json');
    if (await fs.pathExists(configPath)) {
      const config = await fs.readJson(configPath);

      console.log('\n' + chalk.cyan('⚙️  Local Configuration'));
      console.log(chalk.gray('━'.repeat(50)));

      const configTable = new Table({
        chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
      });

      configTable.push(
        [chalk.gray('Registered At:'), formatDate(new Date(config.registeredAt))],
        [chalk.gray('Transaction:'), config.txHash?.substring(0, 20) + '...']
      );

      console.log(configTable.toString());
    }

    // Export to file if requested
    if (options.export) {
      const exportPath = path.resolve(options.export);
      const exportData = {
        profile,
        bonafide: bonafideResponse.is_bonafide,
        exportedAt: new Date().toISOString(),
      };

      await fs.writeJson(exportPath, exportData, { spaces: 2 });
      console.log('\n' + chalk.green(`✅ Profile exported to: ${exportPath}`));
    }

    // Display tips
    if (!bonafideResponse.is_bonafide) {
      console.log('\n' + chalk.yellow('💡 Tips:'));
      console.log(chalk.gray('  • You need a ResearcherStatus visa to be recognized as a bona fide researcher'));
      console.log(chalk.gray('  • Contact your institution or GA4GH authorized issuer for visa issuance'));
      console.log(chalk.gray('  • Once you have a visa, add it using: biofs-cli researcher add-visa'));
    }

    if (profile.reputation < 50) {
      console.log('\n' + chalk.yellow('⚠️  Warning: Low reputation score'));
      console.log(chalk.gray('  • Reputation below 30 will prevent you from accessing data'));
      console.log(chalk.gray('  • Follow data use agreements to maintain good standing'));
    }

    if (daysRemaining < 30 && daysRemaining > 0) {
      console.log('\n' + chalk.yellow('⚠️  Warning: Passport expiring soon'));
      console.log(chalk.gray('  • Renew your passport before it expires'));
      console.log(chalk.gray('  • Contact your issuer for renewal procedures'));
    }

  } catch (error: any) {
    spinner.fail('Failed to fetch status');
    logger.error(error.message);
    process.exit(1);
  }
}

/**
 * Create the status command
 */
export function createStatusCommand(): Command {
  return new Command('status')
    .description('Display detailed researcher profile and status')
    .option(
      '-w, --wallet <address>',
      'Researcher wallet address (defaults to logged-in wallet)'
    )
    .option(
      '-v, --verbose',
      'Show detailed visa information'
    )
    .option(
      '-e, --export <file>',
      'Export profile to JSON file'
    )
    .option(
      '-m, --master-node <url>',
      'Master node URL',
      process.env.BIOFS_MASTER_NODE
    )
    .action(async (options: StatusOptions) => {
      await researcherStatus(options);
    });
}

