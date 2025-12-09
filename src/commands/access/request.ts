import chalk from 'chalk';
import ora from 'ora';
import { GenoBankAPIClient } from '../../lib/api/client';
import { Logger } from '../../lib/utils/logger';

export interface AccessRequestOptions {
  message?: string;
  licenseType?: string;
}

export async function accessRequestCommand(
  biocidOrIpId: string,
  options: AccessRequestOptions
): Promise<void> {
  const spinner = ora('Requesting license token (GDPR consent)...').start();

  try {
    const api = GenoBankAPIClient.getInstance();

    // Step 1: Resolve BioCID or IP Asset ID
    let ipId: string;

    if (biocidOrIpId.startsWith('biocid://')) {
      spinner.text = 'Resolving BioCID...';
      // Extract registration ID from BioCID format: biocid://wallet/bioip/registration_id/...
      const registrationId = biocidOrIpId.split('/bioip/')[1]?.split('/')[0] || '';
      if (!registrationId) {
        throw new Error('Invalid BioCID format');
      }

      // Fetch IP ID from BioIP registry
      const bioips = await api.getMyBioIPs();
      const bioip = bioips.find((b: any) => b.registration_id === registrationId);
      if (!bioip) {
        throw new Error('BioIP asset not found');
      }
      ipId = bioip.ip_id;
    } else if (biocidOrIpId.startsWith('0x')) {
      ipId = biocidOrIpId;
    } else {
      throw new Error('Invalid format. Expected BioCID (biocid://...) or IP Asset ID (0x...)');
    }

    // Step 2: Submit license token request
    spinner.text = 'Submitting license token request...';
    const licenseType = options.licenseType || 'non-commercial';
    const result = await api.requestLicenseToken(ipId, licenseType, options.message);

    spinner.succeed(chalk.green('✓ License token request submitted successfully'));

    // Display confirmation
    console.log('\n' + chalk.cyan('═'.repeat(66)));
    console.log(chalk.bold('  License Token Request Details (GDPR Consent)'));
    console.log(chalk.cyan('═'.repeat(66)));
    console.log(chalk.gray('  IP Asset ID:'), ipId);
    console.log(chalk.gray('  License Type:'), licenseType === 'non-commercial' ?
      chalk.green('Non-Commercial (GDPR Research Consent)') :
      chalk.yellow('Commercial'));
    if (options.message) {
      console.log(chalk.gray('  Message:'), options.message);
    }
    if (result.request_id) {
      console.log(chalk.gray('  Request ID:'), result.request_id);
    }
    console.log(chalk.cyan('═'.repeat(66)));
    console.log();

    console.log(chalk.yellow('⏳ Waiting for owner to mint license token...'));
    console.log(chalk.gray('   Owner will mint a license token on blockchain to grant access.'));
    console.log();
    console.log(chalk.dim('   Check status: ') + chalk.cyan('biofs access list --mine'));

  } catch (error: any) {
    spinner.fail(chalk.red('✗ License token request failed'));

    if (error.message.includes('Already Has Access')) {
      console.log();
      console.log(chalk.green('✓ You already have an active license token for this asset.'));
      console.log(chalk.gray('   Download: ') + chalk.cyan('biofs s3 cp ' + biocidOrIpId + ' ./local-file'));
    } else if (error.message.includes('already requested')) {
      console.log();
      console.log(chalk.yellow('⚠  You have already requested a license token for this asset.'));
      console.log(chalk.gray('   Check status: ') + chalk.cyan('biofs access list --mine'));
    } else if (error.message.includes('own this asset')) {
      console.log();
      console.log(chalk.blue('ℹ  You own this asset - no license token needed.'));
    } else {
      Logger.error(`Error: ${error.message}`);
    }

    process.exit(1);
  }
}


