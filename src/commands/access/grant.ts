import chalk from 'chalk';
import ora from 'ora';
import { GenoBankAPIClient } from '../../lib/api/client';
import { Logger } from '../../lib/utils/logger';

export interface AccessGrantOptions {
  expiresIn?: string;
}

export async function accessGrantCommand(
  biocidOrIpId: string,
  walletAddress: string,
  options: AccessGrantOptions
): Promise<void> {
  const spinner = ora('Minting license token (granting GDPR consent)...').start();

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

    let result: any;
    let grantType = 'direct';
    let licenseType = 'non-commercial';

    // Step 2: Try direct grant first (no request needed)
    try {
      spinner.text = 'Minting license token directly (owner-initiated)...';
      result = await api.directGrantLicenseToken(ipId, walletAddress, licenseType);
      grantType = 'direct';
    } catch (directGrantError: any) {
      // If direct grant fails, try request-based grant
      if (directGrantError.message.includes('Already Has Access')) {
        throw directGrantError; // Re-throw if already has access
      }

      spinner.text = 'Finding license token request...';
      const requests = await api.getPendingLicenseRequests(ipId);
      const pendingRequest = requests.find((r: any) =>
        r.requester?.toLowerCase() === walletAddress.toLowerCase()
      );

      if (!pendingRequest) {
        throw new Error('No pending license token request found for this wallet address. The researcher must request access first, or you can use the direct grant flow.');
      }

      // Step 3: Mint license token on blockchain (request-based)
      spinner.text = 'Minting license token on blockchain (request-based)...';
      result = await api.grantLicenseToken(pendingRequest._id, walletAddress);
      grantType = 'request-based';
      licenseType = pendingRequest.license_type || 'non-commercial';
    }

    spinner.succeed(chalk.green('✓ License token minted successfully on blockchain'));

    // Display confirmation
    console.log('\n' + chalk.cyan('═'.repeat(66)));
    console.log(chalk.bold('  License Token Grant Confirmation (GDPR Consent)'));
    console.log(chalk.cyan('═'.repeat(66)));
    console.log(chalk.gray('  Grant Type:'), grantType === 'direct' ?
      chalk.green('Direct Grant (owner-initiated)') :
      chalk.blue('Request-Based (researcher-requested)'));
    console.log(chalk.gray('  IP Asset ID:'), ipId);
    console.log(chalk.gray('  Granted To:'), walletAddress);
    console.log(chalk.gray('  License Type:'),
      licenseType === 'non-commercial' ?
        chalk.green('Non-Commercial (GDPR Research Consent)') :
        chalk.yellow('Commercial'));
    if (result.license_token_id) {
      console.log(chalk.gray('  License Token ID:'), result.license_token_id);
    }
    if (result.tx_hash) {
      console.log(chalk.gray('  Blockchain TX:'), chalk.blue(result.tx_hash));
    }
    console.log(chalk.cyan('═'.repeat(66)));
    console.log();

    console.log(chalk.green('✓ The researcher can now download files using:'));
    console.log(chalk.cyan(`  biofs s3 cp ${biocidOrIpId} ./destination`));

  } catch (error: any) {
    spinner.fail(chalk.red('✗ License token minting failed'));

    if (error.message.includes('Unauthorized') || error.message.includes('not the owner')) {
      console.log();
      console.log(chalk.yellow('⚠  You must be the IP asset owner to mint license tokens.'));
      console.log(chalk.gray('   Only the wallet that owns this IP asset can grant access.'));
    } else if (error.message.includes('No pending license token request')) {
      console.log();
      console.log(chalk.yellow('⚠  No pending license token request from this wallet address.'));
      console.log(chalk.gray('   List pending requests: ') + chalk.cyan('biofs access list ' + biocidOrIpId));
    } else if (error.message.includes('No License Terms')) {
      console.log();
      console.log(chalk.yellow('⚠  This IP asset does not have PIL terms attached yet.'));
      console.log(chalk.gray('   PIL terms must be attached before granting access.'));
    } else {
      Logger.error(`Error: ${error.message}`);
    }

    process.exit(1);
  }
}
