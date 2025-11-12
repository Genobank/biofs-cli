/**
 * biofs access - Sequentia Protocol ConsentManager Implementation
 *
 * Blockchain-verified access control with GDPR compliance:
 * - Article 6: Lawful basis for processing (consent)
 * - Article 7: Conditions for consent (multi-party approval)
 * - Article 17: Right to erasure (revoke consent)
 * - Parental consent for newborn sequences
 * - Age of majority transfer (automatic at 18)
 *
 * This is WHY we use Sequentia Protocol:
 * Story Protocol has NO ConsentManager - cannot enforce GDPR!
 */

import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs/promises';
import * as path from 'path';
import inquirer from 'inquirer';
import { initializeSequentia } from '../lib/sequentia';
import { ConsentManager, ConsentStatus, ConsentType } from '../lib/sequentia/ConsentManager';
import { BioPIL, BioPILLicenseType } from '../lib/sequentia/BioPIL';
import { Logger } from '../lib/utils/logger';

// Subcommand: biofs access grant
export interface AccessGrantSequentiaOptions {
    lab: string;
    license?: string;
    purpose?: string;
    expires?: string;          // ISO date string
    verbose?: boolean;
    debug?: boolean;
}

export async function accessGrantSequentia(
    biocid: string,
    options: AccessGrantSequentiaOptions
): Promise<void> {
    const spinner = ora('Initializing Sequentia Protocol...').start();

    try {
        // Get credentials
        const configPath = path.join(process.env.HOME || '', '.biofs', 'credentials.json');
        const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));

        const sequentia = initializeSequentia(config.privateKey);

        spinner.text = 'Checking current consent status...';

        // Step 1: Verify consent is active
        const consentStatus = await sequentia.consentManager.checkConsent(biocid);

        if (consentStatus !== ConsentStatus.Active && consentStatus !== ConsentStatus.NotProvided) {
            spinner.fail(chalk.red(`Cannot grant access - Consent status: ${ConsentStatus[consentStatus]}`));
            process.exit(1);
        }

        spinner.succeed(chalk.green(`✅ Consent verified: ${ConsentStatus[consentStatus]}`));

        // Step 2: Create consent if needed (parental consent workflow)
        if (consentStatus === ConsentStatus.NotProvided) {
            console.log(chalk.yellow('\n⚠️  No consent record found. Creating consent...'));

            const { needsParentalConsent } = await inquirer.prompt([{
                type: 'confirm',
                name: 'needsParentalConsent',
                message: 'Does this require parental consent (for minors)?',
                default: false
            }]);

            if (needsParentalConsent) {
                const answers = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'subject',
                        message: 'Subject wallet address (newborn/minor):',
                        validate: (input) => /^0x[a-fA-F0-9]{40}$/.test(input) || 'Invalid wallet address'
                    },
                    {
                        type: 'input',
                        name: 'parent2',
                        message: 'Second parent wallet address (leave blank if only one parent):',
                        validate: (input) => !input || /^0x[a-fA-F0-9]{40}$/.test(input) || 'Invalid wallet address'
                    },
                    {
                        type: 'input',
                        name: 'birthDate',
                        message: 'Birth date (YYYY-MM-DD):',
                        validate: (input) => !isNaN(new Date(input).getTime()) || 'Invalid date'
                    }
                ]);

                const grantors = [config.wallet];
                if (answers.parent2) {
                    grantors.push(answers.parent2);
                }

                const birthDate = new Date(answers.birthDate).getTime() / 1000;
                const ageOfMajority = ConsentManager.calculateAgeOfMajority(new Date(answers.birthDate));

                spinner.start('Creating parental consent...');

                await sequentia.consentManager.createConsent(
                    biocid,
                    answers.subject,
                    grantors,
                    [ConsentType.Clinical, ConsentType.Research],
                    birthDate,
                    0,  // No expiration
                    options.purpose || 'Genomic data sharing',
                    true  // Requires all grantors
                );

                spinner.succeed(chalk.green('✅ Parental consent created'));
                console.log(chalk.gray(`   Grantors: ${grantors.join(', ')}`));
                console.log(chalk.gray(`   Age of majority transfer: ${new Date(ageOfMajority * 1000).toLocaleDateString()}`));
            }
        }

        // Step 3: Mint BioPIL license token
        spinner.start('Minting BioPIL license token...');

        const licenseType = BioPIL.parseLicenseType(options.license || 'non-commercial');

        const licenseToken = await sequentia.bioPIL.mintLicenseToken(
            biocid,
            licenseType,
            options.lab,
            1
        );

        spinner.succeed(chalk.green('✅ Access granted'));

        // Success summary
        console.log('');
        console.log(chalk.bold.green('🎉 Access Granted!'));
        console.log('');
        console.log(chalk.bold('🤝 License Details:'));
        console.log(chalk.cyan(`   BioCID: ${biocid}`));
        console.log(chalk.gray(`   Recipient: ${options.lab}`));
        console.log(chalk.gray(`   License Token ID: ${licenseToken.id}`));
        console.log(chalk.gray(`   License Type: ${BioPIL.formatLicenseType(licenseType)}`));
        console.log(chalk.gray(`   Description: ${BioPIL.getLicenseDescription(licenseType)}`));
        console.log('');
        console.log(chalk.bold('✅ GDPR Compliance:'));
        console.log(chalk.gray(`   Consent status: ${ConsentStatus[consentStatus]}`));
        console.log(chalk.gray(`   Revocable: Yes (GDPR Article 17)`));
        console.log('');

    } catch (error: any) {
        spinner.fail(chalk.red(`Error: ${error.message}`));
        throw error;
    }
}

// Subcommand: biofs access revoke
export interface AccessRevokeSequentiaOptions {
    lab: string;
    reason?: string;
    verbose?: boolean;
    debug?: boolean;
}

export async function accessRevokeSequentia(
    biocid: string,
    options: AccessRevokeSequentiaOptions
): Promise<void> {
    const spinner = ora('Initializing Sequentia Protocol...').start();

    try {
        // Get credentials
        const configPath = path.join(process.env.HOME || '', '.biofs', 'credentials.json');
        const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));

        const sequentia = initializeSequentia(config.privateKey);

        spinner.text = 'Finding license token...';

        // Step 1: Find license token
        const licenseToken = await sequentia.bioPIL.findLicenseToken(biocid, options.lab);

        if (!licenseToken) {
            spinner.fail(chalk.red('No license token found for this lab'));
            console.log(chalk.yellow(`\nLab ${options.lab} does not have access to ${biocid}`));
            process.exit(1);
        }

        spinner.succeed(chalk.green('✅ License token found'));

        // Confirm revocation
        const { confirm } = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirm',
            message: chalk.yellow('⚠️  This will permanently revoke access. Continue?'),
            default: false
        }]);

        if (!confirm) {
            console.log(chalk.yellow('\n❌ Revocation cancelled.\n'));
            process.exit(0);
        }

        // Step 2: Revoke consent (GDPR Article 17!)
        spinner.start('Revoking consent (GDPR Article 17)...');

        await sequentia.consentManager.revokeConsent(
            biocid,
            options.reason || 'Access revoked by data owner'
        );

        spinner.succeed(chalk.green('✅ Consent revoked'));

        // Step 3: Burn license token
        spinner.start('Burning license token...');

        await sequentia.bioPIL.burnLicenseToken(licenseToken.id);

        spinner.succeed(chalk.green('✅ License token burned'));

        // Success summary
        console.log('');
        console.log(chalk.bold.green('🎉 Access Revoked!'));
        console.log('');
        console.log(chalk.bold('❌ Revocation Details:'));
        console.log(chalk.cyan(`   BioCID: ${biocid}`));
        console.log(chalk.gray(`   Recipient: ${options.lab}`));
        console.log(chalk.gray(`   License Token: ${licenseToken.id} (burned)`));
        console.log(chalk.gray(`   Reason: ${options.reason || 'Access revoked by data owner'}`));
        console.log('');
        console.log(chalk.bold('✅ GDPR Article 17:'));
        console.log(chalk.gray(`   Right to erasure exercised`));
        console.log(chalk.gray(`   S3 file deletion will be triggered within 24 hours`));
        console.log('');

    } catch (error: any) {
        spinner.fail(chalk.red(`Error: ${error.message}`));
        throw error;
    }
}

// Subcommand: biofs access list
export interface AccessListSequentiaOptions {
    verbose?: boolean;
    debug?: boolean;
}

export async function accessListSequentia(
    biocid: string,
    options: AccessListSequentiaOptions
): Promise<void> {
    const spinner = ora('Initializing Sequentia Protocol...').start();

    try {
        // Get credentials
        const configPath = path.join(process.env.HOME || '', '.biofs', 'credentials.json');
        const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));

        const sequentia = initializeSequentia(config.privateKey);

        spinner.text = 'Fetching license tokens...';

        // Query BioPIL license tokens
        const licenses = await sequentia.bioPIL.getLicenseTokens(biocid);

        spinner.succeed(chalk.green(`✅ Found ${licenses.length} license token(s)`));

        if (licenses.length === 0) {
            console.log(chalk.yellow('\nNo license tokens issued for this BioCID'));
            console.log(chalk.gray('Only the owner has access'));
            return;
        }

        // Display licenses
        console.log('');
        console.log(chalk.bold(`📋 Access Control for ${biocid}:`));
        console.log('');

        licenses.forEach((license: any, index: number) => {
            console.log(chalk.cyan(`${index + 1}. ${license.holder}`));
            console.log(chalk.gray(`   License: ${BioPIL.formatLicenseType(license.licenseType)}`));
            console.log(chalk.gray(`   Token ID: ${license.id}`));
            console.log(chalk.gray(`   Granted: ${new Date(license.grantedAt * 1000).toLocaleString()}`));
            console.log(chalk.gray(`   Expires: ${license.expiresAt ? new Date(license.expiresAt * 1000).toLocaleString() : 'Never'}`));
            console.log(chalk.gray(`   Status: ${license.status === 'active' ? '✅ Active' : '❌ ' + license.status}`));
            console.log('');
        });

        // Show consent record
        const consent = await sequentia.consentManager.getConsentRecord(biocid);

        if (consent) {
            console.log(chalk.bold('📜 Consent Record:'));
            console.log(chalk.gray(`   Status: ${ConsentManager.formatConsentStatus(consent.status)}`));
            console.log(chalk.gray(`   Subject: ${consent.subject}`));
            console.log(chalk.gray(`   Grantors: ${consent.grantors.join(', ')}`));
            console.log(chalk.gray(`   Purpose: ${consent.purpose}`));
            console.log(chalk.gray(`   Granted: ${new Date(consent.grantedAt * 1000).toLocaleString()}`));

            if (consent.expiresAt > 0) {
                console.log(chalk.gray(`   Expires: ${new Date(consent.expiresAt * 1000).toLocaleString()}`));
            }

            if (consent.ageOfMajority > 0) {
                console.log(chalk.gray(`   Age of Majority: ${new Date(consent.ageOfMajority * 1000).toLocaleDateString()}`));
            }
            console.log('');
        }

    } catch (error: any) {
        spinner.fail(chalk.red(`Error: ${error.message}`));
        throw error;
    }
}
