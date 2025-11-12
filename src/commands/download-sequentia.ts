/**
 * biofs download - Sequentia Protocol Implementation with GDPR Compliance
 *
 * Downloads files with full GDPR consent verification:
 * - Article 15: Right to access (audit trail)
 * - Article 17: Right to erasure (respects revoked consent)
 * - ConsentManager verification before download
 * - BioCID access control via BioPIL
 *
 * This is WHY we use Sequentia Protocol:
 * Story Protocol has NO consent management - cannot enforce GDPR
 */

import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs/promises';
import * as path from 'path';
import { initializeSequentia } from '../lib/sequentia';
import { ConsentStatus, ConsentManager } from '../lib/sequentia/ConsentManager';
import { BioPIL } from '../lib/sequentia/BioPIL';
import { GenoBankAPIClient } from '../lib/api/client';
import { Logger } from '../lib/utils/logger';
import { formatFileSize } from '../lib/utils/format';

export interface DownloadSequentiaOptions {
    output?: string;
    verbose?: boolean;
    debug?: boolean;
}

export async function downloadCommandSequentia(
    biocidOrFilename: string,
    destination: string | undefined,
    options: DownloadSequentiaOptions
): Promise<void> {
    const spinner = ora('Initializing Sequentia Protocol...').start();

    try {
        // Get credentials
        const configPath = path.join(process.env.HOME || '', '.biofs', 'credentials.json');
        const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));

        if (!config.privateKey) {
            throw new Error('Private key not found. Run: biofs login');
        }

        // Initialize Sequentia Protocol
        const sequentia = initializeSequentia(config.privateKey);
        const api = GenoBankAPIClient.getInstance();

        spinner.text = 'Resolving BioCID...';

        // Step 1: Resolve BioCID
        let biocidMetadata: any;

        if (biocidOrFilename.startsWith('biocid://')) {
            biocidMetadata = await sequentia.biocidRegistry.resolve(biocidOrFilename);
        } else {
            biocidMetadata = await sequentia.biocidRegistry.resolve(biocidOrFilename, config.wallet);
        }

        spinner.succeed(chalk.green(`✅ BioCID resolved: ${biocidMetadata.biocid}`));

        // Step 2: Verify GDPR consent (CRITICAL!)
        spinner.start('Step 1/4: Verifying GDPR consent...');

        const consentStatus = await sequentia.consentManager.checkConsent(biocidMetadata.biocid);

        if (consentStatus === ConsentStatus.Revoked) {
            spinner.fail(chalk.red('❌ GDPR Article 17: Consent Revoked'));
            console.log(chalk.yellow('\nAccess denied - data subject has exercised right to erasure'));
            console.log(chalk.gray('This file should be deleted from S3 within 24 hours'));
            process.exit(1);
        }

        if (consentStatus === ConsentStatus.Expired) {
            spinner.fail(chalk.red('❌ Consent Expired'));
            console.log(chalk.yellow('\nAccess denied - time-limited consent has expired'));
            process.exit(1);
        }

        if (consentStatus === ConsentStatus.NotProvided) {
            spinner.warn(chalk.yellow('⚠️  No consent record found'));
            console.log(chalk.yellow('Proceeding with owner access only...'));
        } else {
            spinner.succeed(chalk.green(`✅ Consent: ${ConsentStatus[consentStatus]}`));
        }

        // Step 3: Check BioPIL access
        spinner.start('Step 2/4: Checking BioPIL license...');

        const accessResult = await sequentia.bioPIL.checkAccess(biocidMetadata.biocid, config.wallet);

        if (!accessResult.granted) {
            spinner.fail(chalk.red('❌ Access Denied'));
            console.log(chalk.yellow(`\nReason: ${accessResult.reason}`));
            console.log(chalk.gray('\n💡 Possible solutions:'));
            console.log(chalk.gray('   1. Request access from file owner'));
            console.log(chalk.gray('   2. Purchase a license'));
            console.log(chalk.gray('   3. Contact the lab that created this file'));
            process.exit(1);
        }

        spinner.succeed(chalk.green(`✅ Access granted: ${accessResult.reason}`));

        if (accessResult.licenseType) {
            console.log(chalk.gray(`   License: ${BioPIL.formatLicenseType(accessResult.licenseType)}`));
        }

        // Step 4: Download from S3
        spinner.start('Step 3/4: Downloading from S3...');

        const outputPath = destination || `./${biocidMetadata.filename}`;
        await api.downloadFile(biocidOrFilename, outputPath);

        const fileStats = await fs.stat(outputPath);

        spinner.succeed(chalk.green('✅ Download complete'));
        console.log(chalk.gray(`   Size: ${formatFileSize(fileStats.size)}`));
        console.log(chalk.gray(`   Path: ${outputPath}`));

        // Step 5: Log access (GDPR Article 15: Right to access audit trail)
        spinner.start('Step 4/4: Logging access (GDPR Article 15)...');

        await sequentia.consentManager.logAccess(
            biocidMetadata.biocid,
            config.wallet,
            'download',
            new Date()
        );

        spinner.succeed(chalk.green('✅ Access logged'));

        // Success summary
        console.log('');
        console.log(chalk.bold.green('🎉 Download Complete!'));
        console.log('');
        console.log(chalk.bold('📁 File:'));
        console.log(chalk.cyan(`   ${biocidMetadata.filename}`));
        console.log(chalk.gray(`   BioCID: ${biocidMetadata.biocid}`));
        console.log(chalk.gray(`   Size: ${formatFileSize(fileStats.size)}`));
        console.log('');
        console.log(chalk.bold('✅ GDPR Compliance:'));
        console.log(chalk.gray(`   Consent: ${ConsentStatus[consentStatus]}`));
        console.log(chalk.gray(`   Access logged: ${new Date().toLocaleString()}`));
        if (accessResult.licenseType) {
            console.log(chalk.gray(`   License: ${BioPIL.formatLicenseType(accessResult.licenseType)}`));
        }
        console.log('');

    } catch (error: any) {
        spinner.fail(chalk.red(`Error: ${error.message}`));

        if (error.message.includes('not found')) {
            console.log(chalk.yellow('\n💡 Tip: File might not be tokenized yet.'));
            console.log(chalk.gray('   Run: biofs biofiles (to list available files)'));
            console.log(chalk.gray('   Run: biofs tokenize <file> (to tokenize)'));
        }

        throw error;
    }
}
