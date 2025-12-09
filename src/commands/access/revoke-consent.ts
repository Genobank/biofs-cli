/**
 * Revoke Consent Command - GDPR Right to Withdraw Consent (User Side)
 * Allows users to revoke their own consent for accessing genomic data
 *
 * NOTE: This is different from revoking license tokens (which owners do)
 * This is for users to withdraw their own consent for data access
 */

import { ConsentManager } from '../../lib/consent/consent-manager';
import { CredentialsManager } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';

export interface RevokeConsentOptions {
  all?: boolean;
  force?: boolean; // Skip confirmation
}

export async function revokeConsentCommand(
  ipId?: string,
  options: RevokeConsentOptions = {}
): Promise<void> {
  const spinner = ora('Loading consent records...').start();

  try {
    // 1. Load authentication
    const credManager = CredentialsManager.getInstance();
    const creds = await credManager.loadCredentials();

    if (!creds) {
      spinner.fail('Not authenticated');
      Logger.error('Please run: biofs login');
      process.exit(1);
    }

    const { wallet_address: wallet, user_signature: signature } = creds;
    const consentManager = new ConsentManager();

    if (options.all) {
      // Revoke all consents
      spinner.text = 'Loading all consents...';
      const consents = await consentManager.getMyConsents(signature);
      spinner.stop();

      if (consents.length === 0) {
        console.log(chalk.yellow('No consent records found'));
        process.exit(0);
      }

      if (!options.force) {
        console.log('');
        console.log(chalk.yellow('⚠️  You are about to revoke consent for ALL genomic files'));
        console.log('');
        console.log(chalk.bold('Affected files:'));
        for (const consent of consents) {
          console.log(`  ${chalk.gray('•')} ${consent.filename} (${consent.action})`);
        }
        console.log('');
        console.log(chalk.gray('This will:'));
        console.log(chalk.gray('  • Remove all consent records'));
        console.log(chalk.gray('  • Require re-consent for future downloads'));
        console.log(chalk.gray('  • Be logged in the audit trail'));
        console.log('');

        const answer = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Revoke consent for ${consents.length} file(s)?`,
            default: false
          }
        ]);

        if (!answer.confirm) {
          console.log(chalk.gray('Cancelled'));
          process.exit(0);
        }
      }

      spinner.start('Revoking all consents...');

      const success = await consentManager.revokeConsent(wallet, null, signature);

      if (success) {
        spinner.succeed(chalk.green(`✅ Revoked consent for ${consents.length} file(s)`));
        console.log('');
        console.log(chalk.gray('All consent records have been revoked.'));
        console.log(chalk.gray('You will need to provide consent again for future downloads.'));
      } else {
        spinner.fail('Failed to revoke consents');
        Logger.error('Please try again or contact support');
        process.exit(1);
      }

    } else if (ipId) {
      // Revoke specific IP asset consent
      spinner.text = 'Checking consent records...';

      // Get consents to show what will be revoked
      const consents = await consentManager.getMyConsents(signature);
      const relevantConsents = consents.filter(c => c.ip_id.toLowerCase() === ipId.toLowerCase());

      spinner.stop();

      if (relevantConsents.length === 0) {
        console.log(chalk.yellow('⚠️  No consent records found for this IP asset'));
        console.log(chalk.gray(`IP Asset: ${ipId}`));
        console.log('');
        console.log(chalk.gray('💡 You may not have consented to access this file yet.'));
        process.exit(0);
      }

      if (!options.force) {
        console.log('');
        console.log(chalk.yellow('⚠️  You are about to revoke consent for:'));
        console.log('');
        console.log(chalk.gray('IP Asset:'), chalk.cyan(truncateAddress(ipId)));
        console.log(chalk.gray('Consents:'), `${relevantConsents.length} record(s)`);
        console.log('');

        for (const consent of relevantConsents) {
          console.log(`  ${chalk.gray('•')} ${consent.action} - ${consent.filename}`);
          console.log(chalk.gray(`    Granted: ${new Date(consent.consent_given_at).toLocaleString()}`));
          console.log(chalk.gray(`    Access count: ${consent.access_count}`));
        }

        console.log('');

        const answer = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: 'Revoke consent for this IP asset?',
            default: false
          }
        ]);

        if (!answer.confirm) {
          console.log(chalk.gray('Cancelled'));
          process.exit(0);
        }
      }

      spinner.start('Revoking consent...');

      const success = await consentManager.revokeConsent(wallet, ipId, signature);

      if (success) {
        spinner.succeed(chalk.green(`✅ Revoked consent for IP asset`));
        console.log('');
        console.log(chalk.gray('IP Asset:'), truncateAddress(ipId));
        console.log(chalk.gray(`${relevantConsents.length} consent record(s) updated`));
        console.log('');
        console.log(chalk.gray('You will need to provide consent again to access this file.'));
      } else {
        spinner.fail('Failed to revoke consent');
        Logger.error('Please try again or contact support');
        process.exit(1);
      }

    } else {
      // No IP ID provided and not --all
      spinner.stop();
      console.log('');
      console.log(chalk.yellow('Usage:'));
      console.log('  biofs access revoke-consent <ip_id>        ' + chalk.gray('Revoke consent for specific file'));
      console.log('  biofs access revoke-consent --all          ' + chalk.gray('Revoke all consents'));
      console.log('');
      console.log(chalk.gray('Example:'));
      console.log('  biofs access revoke-consent 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7');
      console.log('');
      console.log(chalk.yellow('Note:'));
      console.log(chalk.gray('  This revokes YOUR consent to access files.'));
      console.log(chalk.gray('  To revoke someone else\'s access (as owner), use: ') + chalk.cyan('biofs access revoke'));
      console.log('');
      process.exit(1);
    }

  } catch (error: any) {
    spinner.fail('Revoke consent failed');
    Logger.error(error.message || error);
    process.exit(1);
  }
}

// Helper function
function truncateAddress(address: string): string {
  if (!address) return 'unknown';
  if (address.length !== 42) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}


