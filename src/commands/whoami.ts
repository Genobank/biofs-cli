import { CredentialsManager } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';
import chalk from 'chalk';
import { ethers } from 'ethers';

export interface WhoamiOptions {
  json?: boolean;
  verify?: boolean;     // Verify signature validity
  check?: string;       // Check against specific wallet address
}

export async function whoamiCommand(options: WhoamiOptions): Promise<void> {
  const credManager = CredentialsManager.getInstance();
  const creds = await credManager.loadCredentials();

  if (!creds) {
    Logger.error('Not authenticated. Please run "biofs login" first.');
    process.exit(1);
  }

  // Verify signature if requested
  let signatureValid = false;
  let recoveredWallet = '';

  if (options.verify || options.check) {
    try {
      const message = 'I want to proceed';
      recoveredWallet = ethers.verifyMessage(message, creds.user_signature);
      signatureValid = recoveredWallet.toLowerCase() === creds.wallet_address.toLowerCase();
    } catch (error) {
      signatureValid = false;
    }
  }

  // Check against specific wallet if requested
  let matchesWallet = false;
  if (options.check) {
    matchesWallet = creds.wallet_address.toLowerCase() === options.check.toLowerCase();
  }

  if (options.json) {
    const result: any = {
      wallet: creds.wallet_address,
      authenticated_at: creds.created_at,
      expires_at: creds.expires_at,
      last_used: creds.last_used
    };

    if (options.verify || options.check) {
      result.signature_valid = signatureValid;
      result.recovered_wallet = recoveredWallet;
    }

    if (options.check) {
      result.matches_wallet = matchesWallet;
      result.expected_wallet = options.check;
    }

    console.log(JSON.stringify(result, null, 2));
  } else {
    const now = new Date();
    const createdAt = new Date(creds.created_at);
    const expiresAt = new Date(creds.expires_at);

    const timeSinceAuth = now.getTime() - createdAt.getTime();
    const timeUntilExpiry = expiresAt.getTime() - now.getTime();
    const isExpired = timeUntilExpiry < 0;

    console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║              BioFS Authentication Status                      ║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════════╝\n'));

    console.log(chalk.gray('Wallet Address:'));
    console.log(`  ${chalk.green(creds.wallet_address)}\n`);

    console.log(chalk.gray('Authentication:'));
    console.log(`  Created: ${Logger.formatDate(createdAt)} (${Logger.formatDuration(timeSinceAuth)} ago)`);
    console.log(`  Expires: ${Logger.formatDate(expiresAt)} ${isExpired ? chalk.red('(EXPIRED!)') : chalk.green(`(in ${Logger.formatDuration(timeUntilExpiry)})`)}\n`);

    if (creds.last_used) {
      const lastUsed = new Date(creds.last_used);
      const timeSinceLastUse = now.getTime() - lastUsed.getTime();
      console.log(chalk.gray('Last Used:'));
      console.log(`  ${Logger.formatDate(lastUsed)} (${Logger.formatDuration(timeSinceLastUse)} ago)\n`);
    }

    // Show signature verification if requested
    if (options.verify || options.check) {
      console.log(chalk.gray('Signature Verification:'));
      if (signatureValid) {
        console.log(`  ${chalk.green('✓ Signature is valid')}`);
        console.log(`  ${chalk.gray('Recovered wallet:')} ${recoveredWallet}`);
      } else {
        console.log(`  ${chalk.red('✗ Signature is INVALID or does not match wallet!')}`);
        console.log(`  ${chalk.gray('Recovered wallet:')} ${recoveredWallet || 'Could not recover'}`);
        console.log(`  ${chalk.gray('Stored wallet:   ')} ${creds.wallet_address}`);
        console.log(`\n  ${chalk.yellow('⚠ Please re-authenticate:')} ${chalk.cyan('biofs login')}\n`);
      }
      console.log();
    }

    // Check against specific wallet if requested
    if (options.check) {
      console.log(chalk.gray('Wallet Check:'));
      if (matchesWallet) {
        console.log(`  ${chalk.green('✓ Matches expected wallet')}`);
        console.log(`  ${chalk.gray('Expected:')} ${options.check}`);
      } else {
        console.log(`  ${chalk.red('✗ Does NOT match expected wallet!')}`);
        console.log(`  ${chalk.gray('Expected:')} ${options.check}`);
        console.log(`  ${chalk.gray('Current: ')} ${creds.wallet_address}`);
        console.log(`\n  ${chalk.yellow('⚠ You are authenticated as a different wallet')}\n`);
      }
      console.log();
    }

    // Show status summary
    if (isExpired) {
      console.log(chalk.red('⚠ Your authentication has expired. Please re-authenticate:'));
      console.log(chalk.cyan('  biofs login\n'));
    } else if (options.verify && !signatureValid) {
      console.log(chalk.red('⚠ Invalid signature detected. Please re-authenticate:'));
      console.log(chalk.cyan('  biofs login\n'));
    } else if (options.check && !matchesWallet) {
      console.log(chalk.yellow('⚠ You are authenticated as a different wallet.'));
      console.log(chalk.gray('  To authenticate as the expected wallet:'));
      console.log(chalk.cyan('  biofs login\n'));
    } else {
      console.log(chalk.green('✓ Authentication is valid and active\n'));
    }
  }
}
