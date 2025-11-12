/**
 * biofs verify - Sequentia Protocol Bloom Filter Verification
 *
 * DNA-specific integrity verification using Bloom Filter fingerprinting.
 * Replaces simple hash comparison with SNP-level verification.
 *
 * Key features:
 * - Bloom Filter (10,000 SNPs, 0.001 error rate)
 * - Deduplication detection
 * - Cross-format tracking (FASTQ → BAM → VCF → SQLite)
 * - On-chain tamper-proof verification
 */

import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs/promises';
import * as path from 'path';
import { initializeSequentia } from '../lib/sequentia';
import { calculateFingerprint } from '../lib/sequentia/BloomFilter';
import { Logger } from '../lib/utils/logger';

export interface VerifySequentiaOptions {
    verbose?: boolean;
    debug?: boolean;
}

export async function verifyCommandSequentia(
    biocidOrFilename: string,
    localFilePath: string,
    options: VerifySequentiaOptions
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

        spinner.text = 'Resolving BioCID...';

        // Step 1: Resolve BioCID
        let biocidMetadata: any;

        if (biocidOrFilename.startsWith('biocid://')) {
            biocidMetadata = await sequentia.biocidRegistry.resolve(biocidOrFilename);
        } else {
            biocidMetadata = await sequentia.biocidRegistry.resolve(biocidOrFilename, config.wallet);
        }

        spinner.succeed(chalk.green(`✅ BioCID resolved: ${biocidMetadata.biocid}`));

        // Step 2: Calculate local Bloom Filter fingerprint
        spinner.start('Calculating local DNA fingerprint...');

        const localFingerprint = await calculateFingerprint(localFilePath);

        spinner.succeed(chalk.green('✅ Local fingerprint calculated'));
        console.log(chalk.gray(`   Fingerprint: 0x${Buffer.from(localFingerprint).toString('hex').substring(0, 16)}...`));

        // Step 3: Get on-chain fingerprint
        spinner.start('Fetching on-chain fingerprint...');

        const onchainFingerprint = biocidMetadata.fingerprint;

        spinner.succeed(chalk.green('✅ On-chain fingerprint fetched'));

        // Step 4: Compare fingerprints
        spinner.start('Comparing DNA fingerprints...');

        const localHex = Buffer.from(localFingerprint).toString('hex');
        const onchainHex = Buffer.from(onchainFingerprint).toString('hex');

        if (localHex === onchainHex) {
            spinner.succeed(chalk.bold.green('✅ FILE INTEGRITY VERIFIED'));

            console.log('');
            console.log(chalk.bold('🧬 Verification Details:'));
            console.log(chalk.gray(`   BioCID: ${biocidMetadata.biocid}`));
            console.log(chalk.gray(`   Method: Bloom Filter (10,000 SNPs, 0.001 error rate)`));
            console.log(chalk.gray(`   Fingerprint: 0x${localHex.substring(0, 32)}...`));
            console.log(chalk.gray(`   Status: ✅ Matches on-chain fingerprint`));
            console.log('');

            // Check for duplicates
            spinner.start('Checking for duplicates...');

            const duplicates = await sequentia.biocidRegistry.findDuplicates(localFingerprint);

            if (duplicates.length > 1) {
                spinner.warn(chalk.yellow(`⚠️  ${duplicates.length} file(s) with identical DNA fingerprint:`));
                console.log('');

                duplicates.forEach((dup: any, index: number) => {
                    console.log(chalk.yellow(`   ${index + 1}. ${dup.biocid}`));
                    console.log(chalk.gray(`      Owner: ${dup.owner}`));
                    console.log(chalk.gray(`      Created: ${new Date(dup.createdAt * 1000).toLocaleString()}`));
                    console.log(chalk.gray(`      S3: ${dup.s3Path}`));
                    console.log('');
                });

                console.log(chalk.yellow('💡 These files have identical SNP content (deduplication opportunity)'));
                console.log('');
            } else {
                spinner.succeed(chalk.green('✅ No duplicates found'));
            }

        } else {
            spinner.fail(chalk.bold.red('❌ FILE CORRUPTED OR MODIFIED'));

            console.log('');
            console.log(chalk.bold.red('⚠️  Integrity Check Failed:'));
            console.log(chalk.gray(`   BioCID: ${biocidMetadata.biocid}`));
            console.log(chalk.red(`   Local:    0x${localHex.substring(0, 32)}...`));
            console.log(chalk.green(`   On-chain: 0x${onchainHex.substring(0, 32)}...`));
            console.log('');
            console.log(chalk.yellow('❌ Fingerprints do not match!'));
            console.log(chalk.yellow('This file has been modified or corrupted.'));
            console.log('');
            console.log(chalk.gray('💡 Possible causes:'));
            console.log(chalk.gray('   - File was edited after tokenization'));
            console.log(chalk.gray('   - Transmission error during download'));
            console.log(chalk.gray('   - Different file with same name'));
            console.log('');

            process.exit(1);
        }

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
