import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { GenoBankAPIClient } from '../../lib/api/client';
import { Logger } from '../../lib/utils/logger';

export interface AccessRevokeOptions {
  yes?: boolean; // Skip confirmation prompt
}

export async function accessRevokeCommand(
  biocidOrIpId: string,
  walletAddress: string,
  options: AccessRevokeOptions
): Promise<void> {
  const spinner = ora('Preparing to revoke license token (GDPR right to erasure)...').start();

  try {
    const api = GenoBankAPIClient.getInstance();

    // Validate wallet address format
    if (!walletAddress.startsWith('0x') || walletAddress.length !== 42) {
      throw new Error('Invalid wallet address format. Expected 0x... (42 characters)');
    }

    // Step 1: Resolve BioCID to IP Asset ID
    let ipId: string;

    if (biocidOrIpId.startsWith('biocid://')) {
      spinner.text = 'Resolving BioCID...';
      const registrationId = biocidOrIpId.split('/bioip/')[1]?.split('/')[0] || '';
      if (!registrationId) {
        throw new Error('Invalid BioCID format');
      }

      const bioips = await api.getMyBioIPs();
      const bioip = bioips.find((b: any) => b.registration_id === registrationId);
      if (!bioip) {
        throw new Error('BioIP asset not found or you are not the owner');
      }
      ipId = bioip.ip_id;
    } else if (biocidOrIpId.startsWith('0x')) {
      ipId = biocidOrIpId;
    } else {
      throw new Error('Invalid format. Expected BioCID (biocid://...) or IP Asset ID (0x...)');
    }

    // Step 2: Verify active license token exists
    spinner.text = 'Checking for active license token...';
    const accessInfo = await api.checkMyAccess(ipId);

    if (!accessInfo.has_license) {
      throw new Error('No active license token found for this wallet address');
    }

    spinner.stop();

    // Step 3: Confirmation prompt
    if (!options.yes) {
      console.log();
      console.log(chalk.yellow('⚠  WARNING: GDPR Right to Erasure'));
      console.log(chalk.gray('   This action will revoke the license token and deny future access.'));
      console.log(chalk.gray('   IP Asset:'), ipId);
      console.log(chalk.gray('   Wallet:'), walletAddress);
      console.log();

      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Are you sure you want to revoke access?',
          default: false
        }
      ]);

      if (!confirm) {
        console.log(chalk.gray('\n✓ Revocation cancelled'));
        return;
      }
    }

    // Step 4: Revoke license token
    spinner.start('Revoking license token...');
    const result = await api.revokeLicenseToken(ipId, walletAddress);

    spinner.succeed(chalk.green('✓ License token revoked successfully'));

    // Display confirmation
    console.log('\n' + chalk.cyan('═'.repeat(66)));
    console.log(chalk.bold('  License Token Revocation (GDPR Right to Erasure)'));
    console.log(chalk.cyan('═'.repeat(66)));
    console.log(chalk.gray('  IP Asset ID:'), ipId);
    console.log(chalk.gray('  Revoked From:'), walletAddress);
    if (result.license_token_id) {
      console.log(chalk.gray('  License Token ID:'), result.license_token_id);
    }
    console.log(chalk.gray('  Status:'), chalk.red('Consent Withdrawn (GDPR Article 17)'));
    console.log(chalk.cyan('═'.repeat(66)));
    console.log();

    console.log(chalk.yellow('⚠  The researcher can no longer download files from this asset.'));
    console.log(chalk.gray('   GDPR right to erasure has been exercised.'));

  } catch (error: any) {
    spinner.fail(chalk.red('✗ License token revocation failed'));

    if (error.message.includes('Unauthorized') || error.message.includes('not the owner')) {
      console.log();
      console.log(chalk.yellow('⚠  You must be the IP asset owner to revoke license tokens.'));
      console.log(chalk.gray('   Only the wallet that owns this IP asset can revoke access.'));
    } else if (error.message.includes('No active license token')) {
      console.log();
      console.log(chalk.yellow('⚠  No active license token found for this wallet address.'));
      console.log(chalk.gray('   The wallet may not have access, or it was already revoked.'));
    } else {
      Logger.error(`Error: ${error.message}`);
    }

    process.exit(1);
  }
}
