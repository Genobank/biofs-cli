import { CallbackServer } from '../../lib/auth/server';
import { BrowserLauncher } from '../../lib/auth/browser';
import { CredentialsManager } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';
import chalk from 'chalk';

export interface LoginOptions {
  port?: number;
  browser?: boolean;
  timeout?: number;
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const credManager = CredentialsManager.getInstance();

  // Check if already authenticated
  if (await credManager.hasCredentials()) {
    const creds = await credManager.loadCredentials();
    if (creds) {
      Logger.info(`Already authenticated as: ${Logger.formatWallet(creds.wallet_address)}`);
      Logger.info('Run "genobank logout" to switch accounts');
      return;
    }
  }

  const config = await credManager.loadConfig();
  const port = options.port || config.callback_port || CONFIG.CALLBACK_PORT;

  // Start callback server
  const server = new CallbackServer();
  const callbackUrl = server.getCallbackUrl(port);
  const sessionId = server.getSessionId();

  // Generate auth URL
  const authUrl = BrowserLauncher.generateAuthUrl(
    config.auth_base_url || CONFIG.AUTH_BASE_URL,
    callbackUrl,
    sessionId
  );

  // Open browser
  if (options.browser !== false && config.auto_open_browser !== false) {
    Logger.info('Opening browser for authentication...');
    await BrowserLauncher.openAuthUrl(authUrl);
  } else {
    console.log('\n' + chalk.cyan('Please open this URL in your browser:'));
    console.log(chalk.underline(authUrl) + '\n');
  }

  // Wait for authentication
  const spinner = Logger.spinner('Waiting for authentication (timeout: 5 minutes)...');

  try {
    const result = await server.start(port);
    spinner.succeed('Authentication successful!');

    // Save credentials
    await credManager.saveCredentials(result.wallet, result.signature);

    // Show success message
    Logger.box(
      `Wallet: ${chalk.green(result.wallet)}\n\n` +
      `You can now use:\n` +
      `  ${chalk.cyan('genobank files')}      - List your BioFiles\n` +
      `  ${chalk.cyan('genobank download')}   - Download files\n` +
      `  ${chalk.cyan('genobank upload')}     - Upload files\n` +
      `  ${chalk.cyan('genobank whoami')}     - Show current wallet`,
      'Authentication Successful'
    );

    Logger.success(`Credentials saved to: ~/.genobank/credentials.json`);
  } catch (error) {
    spinner.fail('Authentication failed');
    Logger.error(`Error: ${error}`);
    process.exit(1);
  }
}