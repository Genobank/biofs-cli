import chalk from 'chalk';
import { GenoBankAPIClient } from '../lib/api/client';
import { BioCIDResolver } from '../lib/biofiles/resolver';
import { calculateFileFingerprint } from '../lib/biofiles/fingerprint';
import { Logger } from '../lib/utils/logger';
import { existsSync } from 'fs';

export interface VerifyOptions {
  verbose?: boolean;
  json?: boolean;
}

/**
 * Verify file integrity using DNA fingerprint (Bloom filter)
 */
export async function verifyCommand(
  biocidOrFilename: string,
  localFile: string,
  options: VerifyOptions
): Promise<void> {
  const api = GenoBankAPIClient.getInstance();

  try {
    // Validate local file exists
    if (!existsSync(localFile)) {
      throw new Error(`Local file not found: ${localFile}`);
    }

    if (options.verbose) {
      Logger.debug(`Verifying: ${biocidOrFilename}`);
      Logger.debug(`Against local file: ${localFile}`);
    }

    // Step 1: Download remote file to temp location
    console.log(chalk.cyan('🔍 Downloading remote file for comparison...'));
    const tempFile = `/tmp/biofs_verify_${Date.now()}.tmp`;

    // Use the download functionality to get the file
    const resolver = new BioCIDResolver();
    const remoteFile = await resolver.resolve(biocidOrFilename);

    if (!remoteFile.presigned_url) {
      throw new Error('Cannot access remote file - no presigned URL available');
    }

    // Download the remote file
    const axios = (await import('axios')).default;
    const response = await axios.get(remoteFile.presigned_url, {
      responseType: 'arraybuffer'
    });

    const fs = await import('fs/promises');
    await fs.writeFile(tempFile, response.data);

    // Step 2: Generate fingerprints for both files
    console.log(chalk.cyan('🧬 Generating DNA fingerprints...'));
    const [remoteFingerprint, localFingerprint] = await Promise.all([
      calculateFileFingerprint(tempFile),
      calculateFileFingerprint(localFile)
    ]);

    // Clean up temp file
    await fs.unlink(tempFile);

    // Step 3: Compare fingerprints
    const match = localFingerprint === remoteFingerprint;

    if (options.json) {
      console.log(JSON.stringify({
        match,
        remote: {
          file: biocidOrFilename,
          fingerprint: remoteFingerprint
        },
        local: {
          file: localFile,
          fingerprint: localFingerprint
        }
      }, null, 2));
      return;
    }

    // Display results
    console.log('');
    console.log(chalk.bold('DNA Fingerprint Verification'));
    console.log('═'.repeat(60));
    console.log('');

    console.log(chalk.gray('Remote File:'));
    console.log(`  ${remoteFile.filename || biocidOrFilename}`);
    console.log(`  Fingerprint: ${chalk.blue(remoteFingerprint.substring(0, 32) + '...')}`);
    console.log('');

    console.log(chalk.gray('Local File:'));
    console.log(`  ${localFile}`);
    console.log(`  Fingerprint: ${chalk.blue(localFingerprint.substring(0, 32) + '...')}`);
    console.log('');

    if (match) {
      console.log(chalk.green('✅ MATCH - Files are identical!'));
      console.log(chalk.gray('The local file matches the remote file exactly.'));
      console.log(chalk.gray('DNA fingerprints (Bloom filters) are consistent.'));
    } else {
      console.log(chalk.red('❌ MISMATCH - Files differ!'));
      console.log(chalk.yellow('⚠️  The local file does NOT match the remote file.'));
      console.log(chalk.gray('Possible causes:'));
      console.log(chalk.gray('  • File has been modified'));
      console.log(chalk.gray('  • Downloaded file is corrupted'));
      console.log(chalk.gray('  • Wrong file selected for comparison'));
    }

    console.log('');

  } catch (error) {
    if (options.json) {
      console.error(JSON.stringify({ error: String(error) }, null, 2));
    } else {
      Logger.error(`Verification failed: ${error}`);
    }
    throw error;
  }
}

