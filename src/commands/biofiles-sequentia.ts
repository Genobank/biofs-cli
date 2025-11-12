/**
 * biofs biofiles - Multi-Chain BioFile Discovery
 *
 * Discovers BioFiles across ALL sources:
 * 1. Sequentia BioCIDRegistry (primary)
 * 2. Story Protocol IP Assets (backward compatibility)
 * 3. GenoBank S3 (legacy non-tokenized files)
 * 4. BioIP Registry (legacy BioIP NFTs)
 *
 * Deduplicates via BioCID fingerprinting
 */

import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs/promises';
import * as path from 'path';
import { initializeSequentia } from '../lib/sequentia';
import { FileFormat } from '../lib/sequentia/BioCIDRegistry';
import { ConsentStatus } from '../lib/sequentia/ConsentManager';
import { GenoBankAPIClient } from '../lib/api/client';
import { Logger } from '../lib/utils/logger';
import { formatFileSize } from '../lib/utils/format';

export interface BiofilesSequentiaOptions {
    format?: string;          // Filter by format (vcf, bam, fastq, etc.)
    consent?: string;         // Filter by consent status
    shared?: boolean;         // Show only shared files
    json?: boolean;
    verbose?: boolean;
    debug?: boolean;
}

export async function biofilesCommandSequentia(
    options: BiofilesSequentiaOptions
): Promise<void> {
    const spinner = ora('Discovering BioFiles across all chains...').start();

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

        const discoveries = {
            sequentia: 0,
            story: 0,
            s3: 0,
            bioip: 0
        };

        // Source 1: Sequentia BioCIDRegistry (PRIMARY!)
        spinner.text = 'Querying Sequentia BioCIDRegistry...';

        const sequentiaBioCIDs = await sequentia.biocidRegistry.getUserFiles(config.wallet);
        discoveries.sequentia = sequentiaBioCIDs.length;

        spinner.text = 'Querying Story Protocol IP Assets...';

        // Source 2: Story Protocol (backward compatibility)
        let storyIPAssets: any[] = [];
        try {
            storyIPAssets = await api.getMyBioIPs(); // Gets Story Protocol IP Assets
            discoveries.story = storyIPAssets.length;
        } catch (error) {
            Logger.debug(`Story Protocol query failed: ${error}`);
        }

        spinner.text = 'Querying GenoBank S3...';

        // Source 3: GenoBank S3 (legacy non-tokenized)
        const s3Files = await api.getBiofiles();
        discoveries.s3 = s3Files.length;

        spinner.text = 'Querying BioIP Registry...';

        // Source 4: BioIP Registry (legacy BioIP NFTs)
        let bioipAssets: any[] = [];
        try {
            const bioipResponse = await api.getMyBioIPs();
            bioipAssets = bioipResponse.filter((asset: any) => asset.category === 'bioip');
            discoveries.bioip = bioipAssets.length;
        } catch (error) {
            Logger.debug(`BioIP query failed: ${error}`);
        }

        spinner.succeed(chalk.green('✅ Discovery complete'));

        console.log('');
        console.log(chalk.bold('🔍 Sources Searched:'));
        console.log(chalk.cyan(`   Sequentia BioCIDRegistry: ${discoveries.sequentia} file(s)`));
        console.log(chalk.gray(`   Story Protocol IP Assets: ${discoveries.story} file(s)`));
        console.log(chalk.gray(`   GenoBank S3: ${discoveries.s3} file(s)`));
        console.log(chalk.gray(`   BioIP Registry: ${discoveries.bioip} file(s)`));
        console.log('');

        // Merge and deduplicate via BioCID
        spinner.start('Deduplicating via BioCID fingerprints...');

        const allFiles = await deduplicateFiles([
            ...sequentiaBioCIDs.map((f: any) => ({ ...f, source: 'sequentia' })),
            ...storyIPAssets.map((f: any) => ({ ...f, source: 'story' })),
            ...s3Files.map((f: any) => ({ ...f, source: 's3' })),
            ...bioipAssets.map((f: any) => ({ ...f, source: 'bioip' }))
        ]);

        spinner.succeed(chalk.green(`✅ ${allFiles.length} unique file(s) after deduplication`));

        // Apply filters
        let filteredFiles = allFiles;

        if (options.format) {
            filteredFiles = filteredFiles.filter((f: any) =>
                FileFormat[f.format]?.toLowerCase() === options.format?.toLowerCase()
            );
        }

        if (options.shared) {
            filteredFiles = filteredFiles.filter((f: any) => f.sharedWith && f.sharedWith.length > 0);
        }

        // Fetch consent status for each file
        if (!options.consent) {
            spinner.start('Checking consent status...');

            for (const file of filteredFiles) {
                if (file.biocid) {
                    try {
                        file.consentStatus = await sequentia.consentManager.checkConsent(file.biocid);
                    } catch {
                        file.consentStatus = ConsentStatus.NotProvided;
                    }
                }
            }

            spinner.succeed(chalk.green('✅ Consent status checked'));
        }

        // Display files
        if (options.json) {
            console.log(JSON.stringify(filteredFiles, null, 2));
        } else {
            displayFiles(filteredFiles, discoveries);
        }

    } catch (error: any) {
        spinner.fail(chalk.red(`Error: ${error.message}`));
        throw error;
    }
}

/**
 * Deduplicate files by BioCID fingerprint
 */
async function deduplicateFiles(files: any[]): Promise<any[]> {
    const seen = new Map<string, any>();

    for (const file of files) {
        const key = file.biocid || file.fingerprint || file.filename;

        if (!seen.has(key)) {
            seen.set(key, file);
        } else {
            // Merge sources
            const existing = seen.get(key);
            if (!existing.sources) {
                existing.sources = [existing.source];
            }
            existing.sources.push(file.source);
        }
    }

    return Array.from(seen.values());
}

/**
 * Display files in a user-friendly table
 */
function displayFiles(files: any[], discoveries: any): void {
    if (files.length === 0) {
        console.log(chalk.yellow('\nNo BioFiles found'));
        console.log(chalk.gray('Run "biofs upload <file>" to add files'));
        console.log(chalk.gray('Run "biofs tokenize <file>" to tokenize existing files'));
        return;
    }

    console.log('');
    console.log(chalk.bold('📁 Your BioFiles:'));
    console.log('');

    files.forEach((file, index) => {
        const num = chalk.gray(`${index + 1}.`);
        const filename = chalk.cyan(file.filename || file.name || 'Unknown');

        console.log(`${num} ${filename}`);

        // BioCID
        if (file.biocid) {
            console.log(chalk.gray(`   BioCID: ${file.biocid}`));
        }

        // Type and size
        const fileType = FileFormat[file.format] || file.type || 'Unknown';
        const size = file.filesize || file.size;
        console.log(chalk.gray(`   Type: ${fileType} | Size: ${size ? formatFileSize(size) : 'Unknown'}`));

        // Consent status
        if (file.consentStatus !== undefined) {
            const statusStr = ConsentStatus[file.consentStatus];
            const statusColor = file.consentStatus === ConsentStatus.Active ? 'green' :
                               file.consentStatus === ConsentStatus.Revoked ? 'red' :
                               'yellow';
            console.log(chalk[statusColor](`   Consent: ${statusStr}`));
        }

        // Tokenization
        console.log(chalk.gray(`   Tokenized: ${file.biocid ? 'Yes ✅' : 'No ❌'}`));

        // Source
        if (file.sources) {
            console.log(chalk.gray(`   Sources: ${file.sources.join(', ')}`));
        } else if (file.source) {
            console.log(chalk.gray(`   Source: ${file.source}`));
        }

        // S3 path
        if (file.s3Path || file.path) {
            const s3 = file.s3Path || file.path;
            console.log(chalk.gray(`   S3: ${s3.substring(0, 60)}...`));
        }

        console.log('');
    });

    // Summary
    console.log(chalk.bold('📊 Summary:'));
    console.log(chalk.gray(`   Total Files: ${files.length}`));
    console.log(chalk.gray(`   Tokenized: ${files.filter(f => f.biocid).length}`));
    console.log(chalk.gray(`   With Consent: ${files.filter(f => f.consentStatus === ConsentStatus.Active).length}`));
    console.log('');
}
