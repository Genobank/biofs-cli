import chalk from 'chalk';
import ora from 'ora';
import { GenoBankAPIClient } from '../../lib/api/client';
import { Logger } from '../../lib/utils/logger';
import { CredentialsManager } from '../../lib/auth/credentials';

export async function accessCheckCommand(biocidOrIpId: string): Promise<void> {
  const spinner = ora('Checking access level (PIL license status)...').start();

  try {
    const api = GenoBankAPIClient.getInstance();
    const credManager = CredentialsManager.getInstance();

    // Get current user's wallet
    const creds = await credManager.loadCredentials();
    if (!creds) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }
    const myWallet = creds.wallet_address;

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
        throw new Error('BioIP asset not found');
      }
      ipId = bioip.ip_id;
    } else if (biocidOrIpId.startsWith('0x')) {
      ipId = biocidOrIpId;
    } else {
      throw new Error('Invalid format. Expected BioCID (biocid://...) or IP Asset ID (0x...)');
    }

    // Step 2: Check access level (calls new PIL endpoint)
    spinner.text = 'Checking PIL license status...';
    const accessInfo = await api.checkMyAccess(ipId);

    spinner.stop();

    // Display results
    console.log('\n' + chalk.cyan('═'.repeat(66)));
    console.log(chalk.bold('  Access Check Results (Story PIL License Status)'));
    console.log(chalk.cyan('═'.repeat(66)));
    console.log(chalk.gray('  IP Asset ID:'), ipId);
    console.log(chalk.gray('  Owner:'), accessInfo.owner);
    console.log(chalk.gray('  Your Wallet:'), myWallet);
    console.log(chalk.cyan('─'.repeat(66)));

    // Display access level with color coding
    if (accessInfo.access_level === 'owner') {
      console.log(chalk.bold('  ✓ ACCESS LEVEL:'), chalk.green('Owner'));
      console.log(chalk.gray('    You have full control over this asset.'));
      console.log();
      console.log(chalk.bold('  Available actions:'));
      console.log(chalk.cyan('    • Download:'), `biofs s3 cp ${biocidOrIpId} ./destination`);
      console.log(chalk.cyan('    • Upload:'), `biofs s3 cp ./file ${biocidOrIpId}`);
      console.log(chalk.cyan('    • Grant access:'), `biofs access grant ${biocidOrIpId} <wallet>`);
      console.log(chalk.cyan('    • List permittees:'), `biofs access list ${biocidOrIpId}`);

    } else if (accessInfo.access_level === 'licensed') {
      console.log(chalk.bold('  ✓ ACCESS LEVEL:'), chalk.yellow('Licensed Researcher'));
      console.log();
      console.log(chalk.bold('  License Details:'));

      const token = accessInfo.license_token;
      const licenseType = token?.license_type || 'non-commercial';

      console.log(chalk.gray('    • Type:'),
        licenseType === 'non-commercial' ?
          chalk.green('Non-Commercial (GDPR Research Consent)') :
          chalk.yellow('Commercial'));

      if (token?.license_token_id) {
        console.log(chalk.gray('    • Token ID:'), token.license_token_id);
      }
      if (token?.createdAt) {
        console.log(chalk.gray('    • Granted:'), new Date(token.createdAt).toLocaleDateString());
      }
      if (token?.status) {
        console.log(chalk.gray('    • Status:'),
          token.status === 'active' ? chalk.green('Active') : chalk.red('Revoked'));
      }

      console.log();
      console.log(chalk.bold('  Available actions:'));
      console.log(chalk.cyan('    • Download:'), `biofs s3 cp ${biocidOrIpId} ./destination`);
      console.log(chalk.cyan('    • View metadata:'), `biofs s3 stat ${biocidOrIpId}`);

      // Display PIL terms if available
      if (accessInfo.pil_terms) {
        console.log();
        console.log(chalk.bold('  License Terms (PIL):'));

        const commercialUse = accessInfo.pil_terms.commercial_use ||
          accessInfo.pil_terms.commercialUse;
        const derivativesAllowed = accessInfo.pil_terms.derivatives_allowed ||
          accessInfo.pil_terms.derivativesAllowed;
        const attribution = accessInfo.pil_terms.derivatives_attribution ||
          accessInfo.pil_terms.derivativesAttribution;

        console.log(chalk.gray('    • Commercial use:'),
          commercialUse ? chalk.yellow('✓ Allowed (minting fee paid)') : chalk.red('✗ Not allowed (GDPR consent for research only)'));
        console.log(chalk.gray('    • Derivatives:'),
          derivativesAllowed ? chalk.green('✓ Allowed') : chalk.red('✗ Not allowed'));
        console.log(chalk.gray('    • Attribution:'),
          attribution ? chalk.yellow('⚠ Required') : chalk.gray('Not required'));
      }

    } else {
      console.log(chalk.bold('  ✗ ACCESS LEVEL:'), chalk.red('No Access'));
      console.log(chalk.gray('    You do not have a license token for this asset.'));
      console.log();
      console.log(chalk.bold('  To request access:'));
      console.log(chalk.cyan(`    biofs access request ${biocidOrIpId} --message "Your reason"`));
    }

    console.log(chalk.cyan('═'.repeat(66)));

  } catch (error: any) {
    spinner.fail(chalk.red('✗ Access check failed'));

    if (error.message.includes('Not Found') || error.message.includes('not found')) {
      console.log();
      console.log(chalk.yellow('⚠  IP Asset not found.'));
      console.log(chalk.gray('   The asset may not exist or may not be registered in BioIP.'));
    } else if (error.message.includes('Not authenticated')) {
      console.log();
      console.log(chalk.yellow('⚠  ' + error.message));
    } else {
      Logger.error(`Error: ${error.message}`);
    }

    process.exit(1);
  }
}
