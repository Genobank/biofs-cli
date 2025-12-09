/**
 * GDPR Consent Prompt for Genomic Data Access
 * Displays interactive consent notice before file access
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import axios from 'axios';

export interface FileInfo {
  filename: string;
  owner: string;
  ip_id: string;
  license_type?: string;
  license_token_id?: number;
  wallet?: string;
}

export class ConsentPrompt {
  /**
   * Display GDPR consent notice and get user agreement
   */
  async showConsentNotice(
    fileInfo: FileInfo,
    action: 'download' | 'mount' = 'download'
  ): Promise<boolean> {
    console.log('\n');
    console.log(chalk.yellow('═'.repeat(72)));
    console.log(chalk.bold.yellow('          🔒 GENOMIC DATA ACCESS CONSENT'));
    console.log(chalk.yellow('═'.repeat(72)));
    console.log('');

    console.log(chalk.bold('FILE INFORMATION:'));
    console.log(`  Filename:     ${chalk.cyan(fileInfo.filename)}`);
    console.log(`  Owner:        ${chalk.cyan(this.truncateAddress(fileInfo.owner))}`);
    console.log(`  IP Asset:     ${chalk.gray(this.truncateAddress(fileInfo.ip_id))}`);
    console.log(`  License Type: ${chalk.green(fileInfo.license_type || 'non-commercial')}`);
    if (fileInfo.license_token_id) {
      console.log(`  License Token: ${chalk.gray(`#${fileInfo.license_token_id}`)}`);
    }
    console.log('');

    console.log(chalk.bold('YOU ARE ABOUT TO ACCESS:'));
    console.log('  • Genomic variants (VCF format)');
    console.log('  • Potentially identifying genetic information');
    console.log('  • Protected under GDPR Article 9 (Special Categories of Data)');
    console.log('');

    console.log(chalk.bold('PURPOSE OF ACCESS:'));
    console.log(`  ${action === 'mount' ? 'Mounting for' : 'Downloading for'} research and clinical analysis`);
    console.log('');

    console.log(chalk.bold.green('YOUR RIGHTS:'));
    console.log('  ✓ Revoke access anytime via: ' + chalk.cyan('biofs access revoke <ip_id>'));
    console.log('  ✓ All access is logged (audit trail)');
    console.log('  ✓ Data owner can revoke your license token');
    console.log('');

    console.log(chalk.bold('LICENSE TERMS:'));
    if (fileInfo.license_type === 'non-commercial' || !fileInfo.license_type) {
      console.log('  • Non-commercial use only');
      console.log('  • Attribution required');
      console.log('  • No redistribution without permission');
    } else if (fileInfo.license_type === 'commercial') {
      console.log('  • Commercial use permitted');
      console.log('  • Subject to license agreement terms');
    }
    console.log('');

    console.log(chalk.bold('GDPR COMPLIANCE:'));
    console.log('  This access will be recorded with:');
    console.log(`  • Your wallet: ${fileInfo.wallet ? this.truncateAddress(fileInfo.wallet) : 'authenticated'}`);
    console.log(`  • Timestamp: ${new Date().toISOString()}`);
    const ipAddress = await this.getPublicIP();
    console.log(`  • IP address: ${ipAddress}`);
    console.log('');

    console.log(chalk.yellow('─'.repeat(72)));
    console.log('');
    console.log(chalk.bold('By proceeding, you confirm:'));
    console.log('  1. You understand this is genomic data protected under GDPR');
    console.log('  2. You will use it only for the stated purpose');
    console.log('  3. You will comply with all license terms');
    console.log('  4. You acknowledge this access is being recorded');
    console.log('');

    // Require explicit "I AGREE"
    const answer = await inquirer.prompt([
      {
        type: 'input',
        name: 'consent',
        message: chalk.bold('Type "I AGREE" to confirm consent and proceed:'),
        validate: (input: string) => {
          const normalized = input.trim().toUpperCase();
          if (normalized === 'I AGREE') {
            return true;
          }
          if (normalized === 'NO' || normalized === 'N' || normalized === 'CANCEL') {
            return 'Consent declined';
          }
          return 'You must type "I AGREE" exactly to proceed (or "cancel" to abort)';
        }
      }
    ]);

    return answer.consent.trim().toUpperCase() === 'I AGREE';
  }

  /**
   * Get user's public IP address for audit trail
   */
  async getPublicIP(): Promise<string> {
    try {
      const response = await axios.get('https://api.ipify.org?format=json', {
        timeout: 3000
      });
      return response.data.ip;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Truncate Ethereum address for display
   */
  private truncateAddress(address: string): string {
    if (!address) return 'unknown';
    if (address.length !== 42) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}


