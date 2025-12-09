/**
 * GDPR-Compliant Download Command with Consent Flow
 * Shows consent notice before downloading genomic data
 */

import { FileDownloader } from '../lib/biofiles/downloader';
import { BioCIDResolver } from '../lib/biofiles/resolver';
import { ConsentManager } from '../lib/consent/consent-manager';
import { ConsentPrompt } from '../lib/consent/consent-prompt';
import { CredentialsManager } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';
import chalk from 'chalk';
import * as path from 'path';

export interface DownloadOptions {
  output?: string;
  stream?: boolean;
  quiet?: boolean;
  skipConsent?: boolean; // For automated/batch operations
}

export async function downloadCommandWithConsent(
  biocidOrFilename: string,
  destination?: string,
  options: DownloadOptions = {}
): Promise<void> {
  const downloader = new FileDownloader();
  const resolver = new BioCIDResolver();
  const consentManager = new ConsentManager();
  const consentPrompt = new ConsentPrompt();

  if (!options.quiet) {
    Logger.info(`Resolving: ${biocidOrFilename}`);
  }

  try {
    // 1. Load authentication
    const credManager = CredentialsManager.getInstance();
    const creds = await credManager.loadCredentials();

    if (!creds) {
      Logger.error('Not authenticated. Run: biofs login');
      process.exit(1);
    }

    const { wallet_address: wallet, user_signature: signature } = creds;

    // 2. Resolve file to get metadata
    const fileLocation = await resolver.resolve(biocidOrFilename);

    // 3. Check if this is a granted BioIP file (has IP asset ID)
    if (fileLocation.ip_id && !options.skipConsent) {
      // GDPR Consent Flow

      // Check if consent already given
      const hasConsent = await consentManager.hasConsent(
        wallet,
        fileLocation.ip_id,
        'download',
        signature
      );

      if (!hasConsent) {
        // Show GDPR consent notice
        if (!options.quiet) {
          console.log(''); // Blank line
        }

        const fileInfo = {
          filename: fileLocation.filename || path.basename(biocidOrFilename),
          owner: fileLocation.owner || 'unknown',
          ip_id: fileLocation.ip_id,
          license_type: fileLocation.license_type,
          license_token_id: fileLocation.license_token_id,
          wallet: wallet
        };

        const agreed = await consentPrompt.showConsentNotice(fileInfo, 'download');

        if (!agreed) {
          Logger.error('Consent declined. Download cancelled.');
          process.exit(1);
        }

        // Record consent
        const ipAddress = await consentPrompt.getPublicIP();
        await consentManager.recordConsent(
          wallet,
          fileInfo,
          'download',
          ipAddress,
          signature
        );
      } else if (!options.quiet) {
        console.log(chalk.green('✓ Using existing consent'));
      }
    }

    // 4. Proceed with download
    if (!options.quiet) {
      Logger.info('Starting download...');
    }

    const outputPath = await downloader.download(
      biocidOrFilename,
      destination || options.output,
      !options.quiet
    );

    if (!options.quiet) {
      Logger.success(`Downloaded to: ${chalk.green(outputPath)}`);

      // Show file info
      const filename = path.basename(outputPath);
      const dirname = path.dirname(outputPath);
      console.log(chalk.gray(`  Directory: ${dirname}`));
      console.log(chalk.gray(`  Filename: ${filename}`));

      // Show revoke info
      if (fileLocation.ip_id) {
        console.log('');
        console.log(chalk.yellow('💡 To revoke access: ') + chalk.cyan(`biofs access revoke ${fileLocation.ip_id}`));
      }
    }
  } catch (error: any) {
    Logger.error(`Download failed: ${error.message || error}`);
    process.exit(1);
  }
}

