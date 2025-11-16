/**
 * biofs access grant (BioNFT Implementation)
 *
 * This is the CORRECT implementation for Clara Parabricks jobs.
 * Uses BioNFT contract + MongoDB sequentia_bionfts, NOT ConsentManager.
 *
 * Workflow:
 * 1. Check if biosample is tokenized (has patient_wallet)
 * 2. If not tokenized:
 *    - Query /api_biofs_fuse/ for biosample info
 *    - Prompt user to tokenize (claim ownership)
 *    - Register S3 paths in MongoDB
 *    - Mint BioNFT on Sequentia
 * 3. Check if agent already has access
 * 4. If not, grant access via BioNFT.grantPermission()
 */

import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { BioNFTClient } from '../lib/api/bionft-client';
import { Logger } from '../lib/utils/logger';

export interface AccessGrantBioNFTOptions {
  agent: string;  // Agent wallet address (e.g., Nebius Lab)
  verbose?: boolean;
  debug?: boolean;
}

export async function accessGrantBioNFT(
  biosampleSerial: string,
  options: AccessGrantBioNFTOptions
): Promise<void> {
  const spinner = ora('Initializing BioNFT client...').start();

  try {
    const bionft = BioNFTClient.getInstance();

    // Step 1: Check if biosample is tokenized
    spinner.text = 'Checking biosample tokenization status...';

    const { isTokenized, consent } = await bionft.checkBiosampleTokenization(biosampleSerial);

    if (!isTokenized) {
      spinner.info(chalk.yellow(`⚠️  Biosample ${biosampleSerial} is not yet tokenized`));
      console.log('');

      // Prompt user to tokenize
      const { shouldTokenize } = await inquirer.prompt([{
        type: 'confirm',
        name: 'shouldTokenize',
        message: chalk.cyan(`Biosample not yet tokenized. Proceed to tokenize (claim ownership)?`),
        default: true
      }]);

      if (!shouldTokenize) {
        spinner.fail(chalk.yellow('❌ Cannot grant access to untokenized biosample'));
        console.log('');
        console.log(chalk.gray('To tokenize this biosample, run:'));
        console.log(chalk.cyan(`  biofs access grant ${biosampleSerial} --agent ${options.agent}`));
        console.log(chalk.gray('and confirm when prompted.'));
        console.log('');
        process.exit(1);
      }

      // Step 2: Tokenize biosample
      spinner.start('Querying biosample files from S3...');

      const files = await bionft.listBiosampleFiles(biosampleSerial);

      if (files.length === 0) {
        spinner.fail(chalk.red(`❌ No files found for biosample ${biosampleSerial}`));
        console.log('');
        console.log(chalk.yellow('Possible reasons:'));
        console.log(chalk.gray('  1. Biosample serial number is incorrect'));
        console.log(chalk.gray('  2. Files have not been uploaded to S3'));
        console.log(chalk.gray('  3. S3 index needs to be rebuilt'));
        console.log('');
        console.log(chalk.cyan('To rebuild S3 index:'));
        console.log(chalk.gray('  curl https://genobank.app/api_biofs_fuse/rebuild_index'));
        console.log('');
        process.exit(1);
      }

      spinner.succeed(chalk.green(`✅ Found ${files.length} file(s) in biosample`));

      // Display files
      console.log('');
      console.log(chalk.bold('📁 Files to be tokenized:'));
      for (const file of files) {
        console.log(chalk.gray(`  - ${file.filename}`));
      }
      console.log('');

      // Confirm tokenization
      const { confirmTokenize } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmTokenize',
        message: chalk.yellow('⚠️  This will claim ownership of these files. Continue?'),
        default: true
      }]);

      if (!confirmTokenize) {
        spinner.fail(chalk.yellow('❌ Tokenization cancelled'));
        process.exit(1);
      }

      spinner.start('Tokenizing biosample (minting BioNFT on Sequentia)...');

      const tokenizeResult = await bionft.tokenizeBiosample(biosampleSerial);

      if (!tokenizeResult.success) {
        spinner.fail(chalk.red('❌ Tokenization failed'));
        console.log('');
        console.log(chalk.red(`Error: ${tokenizeResult.error}`));
        console.log('');
        console.log(chalk.cyan('Manual tokenization:'));
        console.log(chalk.gray('  1. Go to https://genobank.io/consent/tokenize-biosample.html'));
        console.log(chalk.gray(`  2. Enter biosample serial: ${biosampleSerial}`));
        console.log(chalk.gray('  3. Connect wallet and sign transaction'));
        console.log('');
        process.exit(1);
      }

      spinner.succeed(chalk.green('✅ Biosample tokenized successfully'));
      console.log(chalk.gray(`   TX Hash: ${tokenizeResult.tx_hash}`));
      console.log('');
    } else {
      spinner.succeed(chalk.green(`✅ Biosample already tokenized`));
      if (consent) {
        console.log(chalk.gray(`   Owner: ${consent.patient_wallet}`));
        console.log(chalk.gray(`   TX Hash: ${consent.tx_hash}`));
      }
      console.log('');
    }

    // Step 3: Check if agent already has access
    spinner.start('Checking existing access permissions...');

    const accessCheck = await bionft.checkAccess(biosampleSerial, options.agent);

    if (accessCheck.hasAccess) {
      spinner.succeed(chalk.green('✅ Agent already has access'));
      console.log('');
      console.log(chalk.bold.green('🎉 Access Already Granted!'));
      console.log('');
      console.log(chalk.bold('🤝 Permission Details:'));
      console.log(chalk.cyan(`   Biosample: ${biosampleSerial}`));
      console.log(chalk.gray(`   Agent: ${options.agent}`));
      console.log(chalk.gray(`   Operations: ${accessCheck.operations.join(', ')}`));
      console.log(chalk.gray(`   TX Hash: ${accessCheck.consent?.tx_hash}`));
      console.log(chalk.gray(`   Block: ${accessCheck.consent?.block_number}`));
      console.log('');
      console.log(chalk.bold('✅ GDPR Compliance:'));
      console.log(chalk.gray(`   Consent status: Active`));
      console.log(chalk.gray(`   Revocable: Yes (GDPR Article 17)`));
      console.log('');
      console.log(chalk.cyan('Agent can now access files:'));
      console.log(chalk.gray(`   biofs mount /mnt/genomics --biosample ${biosampleSerial}`));
      console.log('');
      return;
    }

    spinner.info(chalk.yellow('⚠️  Agent does not have access yet'));
    console.log('');

    // Step 4: Grant access
    const { confirmGrant } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmGrant',
      message: chalk.cyan(`Grant access to agent ${options.agent}?`),
      default: true
    }]);

    if (!confirmGrant) {
      spinner.fail(chalk.yellow('❌ Access grant cancelled'));
      process.exit(1);
    }

    spinner.start('Granting access (minting BioNFT permission)...');

    const grantResult = await bionft.grantAccess(
      biosampleSerial,
      options.agent,
      ['read', 'download', 'process']
    );

    if (!grantResult.success) {
      spinner.fail(chalk.red('❌ Access grant failed'));
      console.log('');
      console.log(chalk.red(`Error: ${grantResult.error}`));
      console.log('');
      console.log(chalk.cyan('Manual access grant:'));
      console.log(chalk.gray('  1. Go to https://genobank.io/consent/grant-access.html'));
      console.log(chalk.gray(`  2. Enter biosample serial: ${biosampleSerial}`));
      console.log(chalk.gray(`  3. Enter agent wallet: ${options.agent}`));
      console.log(chalk.gray('  4. Connect wallet and sign transaction'));
      console.log('');
      process.exit(1);
    }

    spinner.succeed(chalk.green('✅ Access granted successfully'));
    console.log('');
    console.log(chalk.bold.green('🎉 Access Granted!'));
    console.log('');
    console.log(chalk.bold('🤝 Permission Details:'));
    console.log(chalk.cyan(`   Biosample: ${biosampleSerial}`));
    console.log(chalk.gray(`   Agent: ${options.agent}`));
    console.log(chalk.gray(`   Operations: read, download, process`));
    console.log(chalk.gray(`   TX Hash: ${grantResult.tx_hash}`));
    console.log('');
    console.log(chalk.bold('✅ GDPR Compliance:'));
    console.log(chalk.gray(`   Consent status: Active`));
    console.log(chalk.gray(`   Revocable: Yes (GDPR Article 17)`));
    console.log('');
    console.log(chalk.cyan('Agent can now access files:'));
    console.log(chalk.gray(`   biofs mount /mnt/genomics --biosample ${biosampleSerial}`));
    console.log(chalk.gray(`   biofs job submit-clara ${biosampleSerial}`));
    console.log('');

  } catch (error: any) {
    spinner.fail(chalk.red(`Error: ${error.message}`));
    if (options.debug) {
      console.error(error);
    }
    throw error;
  }
}
