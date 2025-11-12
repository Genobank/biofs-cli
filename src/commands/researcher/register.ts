/**
 * GA4GH Researcher Registration Command
 *
 * Registers a researcher with their GA4GH Passport on Sequentia Network
 *
 * @author GenoBank.io
 */

import { Command } from 'commander';
import * as fs from 'fs-extra';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { ethers } from 'ethers';
import { ApiClient } from '../../lib/api/client';
import { loadCredentials } from '../../lib/auth/credentials';
import { logger } from '../../lib/utils/logger';

interface RegisterOptions {
  jwtFile: string;
  wallet?: string;
  visaFiles?: string[];
  masterNode?: string;
}

/**
 * Register researcher with GA4GH Passport
 */
export async function registerResearcher(options: RegisterOptions) {
  const spinner = ora();

  try {
    // Load credentials
    const credentials = await loadCredentials();
    if (!credentials || !credentials.wallet) {
      logger.error('Please login first using: biofs-cli auth login');
      process.exit(1);
    }

    const wallet = options.wallet || credentials.wallet;

    // Validate wallet address
    if (!ethers.isAddress(wallet)) {
      logger.error(`Invalid wallet address: ${wallet}`);
      process.exit(1);
    }

    // Read passport JWT
    spinner.start('Reading GA4GH Passport JWT...');
    const passportPath = path.resolve(options.jwtFile);
    if (!await fs.pathExists(passportPath)) {
      spinner.fail(`JWT file not found: ${passportPath}`);
      process.exit(1);
    }

    const passportJWT = await fs.readFile(passportPath, 'utf-8');
    spinner.succeed('Passport JWT loaded');

    // Read visa JWTs if provided
    const visaJWTs: string[] = [];
    if (options.visaFiles && options.visaFiles.length > 0) {
      spinner.start('Reading visa JWTs...');
      for (const visaFile of options.visaFiles) {
        const visaPath = path.resolve(visaFile);
        if (await fs.pathExists(visaPath)) {
          const visaJWT = await fs.readFile(visaPath, 'utf-8');
          visaJWTs.push(visaJWT);
        } else {
          logger.warn(`Visa file not found: ${visaPath}`);
        }
      }
      spinner.succeed(`Loaded ${visaJWTs.length} visa JWTs`);
    }

    // Decode passport to show summary
    try {
      const passportData = JSON.parse(
        Buffer.from(passportJWT.split('.')[1], 'base64').toString()
      );

      console.log('\n' + chalk.cyan('📋 Passport Summary:'));
      console.log(chalk.gray('  Issuer:'), passportData.iss);
      console.log(chalk.gray('  Subject:'), passportData.sub);
      console.log(chalk.gray('  Issued:'), new Date(passportData.iat * 1000).toISOString());
      console.log(chalk.gray('  Expires:'), new Date(passportData.exp * 1000).toISOString());

      if (passportData.ga4gh_passport_v1) {
        console.log(chalk.gray('  Visas:'), passportData.ga4gh_passport_v1.length);
        passportData.ga4gh_passport_v1.forEach((visa: any) => {
          console.log(chalk.gray(`    - ${visa.type}:`), visa.value);
        });
      }
    } catch (error) {
      logger.warn('Could not decode passport for preview');
    }

    // Confirm registration
    console.log('\n' + chalk.yellow('⚠️  This will register your GA4GH Passport on-chain'));
    console.log(chalk.gray('   The passport hash will be permanently stored on Sequentia Network'));
    console.log(chalk.gray('   The full JWT will be encrypted and stored in S3'));

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Do you want to proceed with registration?',
        default: false,
      },
    ]);

    if (!confirm) {
      console.log(chalk.gray('Registration cancelled'));
      process.exit(0);
    }

    // Initialize API client
    const apiClient = new ApiClient({
      baseUrl: options.masterNode || process.env.BIOFS_MASTER_NODE || 'http://localhost:3000',
      credentials,
    });

    // Register with master node
    spinner.start('Registering GA4GH Passport on Sequentia Network...');

    const response = await apiClient.post('/api/v1/researchers/register', {
      wallet,
      ga4gh_passport_jwt: passportJWT,
      visas: visaJWTs,
    });

    if (response.success) {
      spinner.succeed('GA4GH Passport registered successfully!');
      console.log('\n' + chalk.green('✅ Registration Complete'));
      console.log(chalk.gray('  Transaction:'), response.txHash);
      console.log(chalk.gray('  Wallet:'), wallet);
      console.log(chalk.gray('  Explorer:'), `https://explorer.sequentia.network/tx/${response.txHash}`);

      // Save registration info
      const configPath = path.join(process.env.HOME || '~', '.biofs', 'ga4gh.json');
      await fs.ensureDir(path.dirname(configPath));
      await fs.writeJson(configPath, {
        wallet,
        registeredAt: new Date().toISOString(),
        txHash: response.txHash,
      }, { spaces: 2 });

      console.log('\n' + chalk.cyan('💡 Next Steps:'));
      console.log('  1. Verify your registration: biofs-cli researcher verify');
      console.log('  2. Check your profile: biofs-cli researcher status');
      console.log('  3. Request dataset access: biofs-cli data request-access');
    } else {
      spinner.fail('Registration failed');
      logger.error(response.error || 'Unknown error');
      process.exit(1);
    }
  } catch (error: any) {
    spinner.fail('Registration failed');
    logger.error(error.message);
    process.exit(1);
  }
}

/**
 * Create the register command
 */
export function createRegisterCommand(): Command {
  return new Command('register')
    .description('Register researcher with GA4GH Passport')
    .requiredOption(
      '-j, --jwt-file <file>',
      'Path to GA4GH Passport JWT file'
    )
    .option(
      '-w, --wallet <address>',
      'Researcher wallet address (defaults to logged-in wallet)'
    )
    .option(
      '-v, --visa-files <files...>',
      'Additional visa JWT files'
    )
    .option(
      '-m, --master-node <url>',
      'Master node URL',
      process.env.BIOFS_MASTER_NODE
    )
    .action(async (options: RegisterOptions) => {
      await registerResearcher(options);
    });
}