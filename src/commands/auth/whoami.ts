import { CredentialsManager } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import chalk from 'chalk';

export interface WhoamiOptions {
  json?: boolean;
}

export async function whoamiCommand(options: WhoamiOptions): Promise<void> {
  const credManager = CredentialsManager.getInstance();
  const creds = await credManager.loadCredentials();

  if (!creds) {
    Logger.error('Not authenticated. Please run "genobank login" first.');
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify({
      wallet: creds.wallet_address,
      authenticated_at: creds.created_at,
      expires_at: creds.expires_at,
      last_used: creds.last_used
    }, null, 2));
  } else {
    const now = new Date();
    const createdAt = new Date(creds.created_at);
    const expiresAt = new Date(creds.expires_at);

    const timeSinceAuth = now.getTime() - createdAt.getTime();
    const timeUntilExpiry = expiresAt.getTime() - now.getTime();

    console.log(chalk.cyan('Current Authentication:'));
    console.log(`Wallet: ${chalk.green(creds.wallet_address)}`);
    console.log(`Authenticated: ${Logger.formatDate(createdAt)} (${Logger.formatDuration(timeSinceAuth)} ago)`);
    console.log(`Expires: ${Logger.formatDate(expiresAt)} (in ${Logger.formatDuration(timeUntilExpiry)})`);

    if (creds.last_used) {
      console.log(`Last used: ${Logger.formatDate(creds.last_used)}`);
    }
  }
}