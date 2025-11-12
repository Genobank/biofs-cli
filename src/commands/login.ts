import { CallbackServer } from '../lib/auth/server';
import { BrowserLauncher } from '../lib/auth/browser';
import { CredentialsManager } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';
import { CONFIG } from '../lib/config/constants';
import { BioFilesCacheManager } from '../lib/storage/biofiles-cache';
import { BioCIDResolver } from '../lib/biofiles/resolver';
import chalk from 'chalk';

export interface LoginOptions {
  port?: number;
  browser?: boolean;
  timeout?: number;
  wallet?: string;
  signature?: string;
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const credManager = CredentialsManager.getInstance();

  // NEW: Direct authentication with provided credentials
  if (options.wallet && options.signature) {
    Logger.info('Using provided credentials for direct authentication...');
    
    // Validate wallet address format (Ethereum address)
    if (!options.wallet.match(/^0x[a-fA-F0-9]{40}$/)) {
      Logger.error('Invalid wallet address format. Expected Ethereum address (0x...)');
      process.exit(1);
    }
    
    // Validate signature format
    if (!options.signature.match(/^0x[a-fA-F0-9]{130}$/)) {
      Logger.error('Invalid signature format. Expected 65-byte signature (0x...)');
      process.exit(1);
    }
    
    // Save credentials directly
    await credManager.saveCredentials(options.wallet, options.signature);

    // Initialize biofiles cache
    await initializeBioFilesCache(options.wallet);

    // Show success message
    Logger.box(
      `Wallet: ${chalk.green(options.wallet)}\n\n` +
      `You can now use:\n` +
      `  ${chalk.cyan('biofs files')}      - List your BioFiles\n` +
      `  ${chalk.cyan('biofs download')}   - Download files\n` +
      `  ${chalk.cyan('biofs upload')}     - Upload files\n` +
      `  ${chalk.cyan('biofs whoami')}     - Show current wallet`,
      'Direct Authentication Successful'
    );

    Logger.success(`Credentials saved to: ~/.biofs/credentials.json`);
    return;
  }

  // Check if already authenticated
  if (await credManager.hasCredentials()) {
    const creds = await credManager.loadCredentials();
    if (creds) {
      Logger.info(`Already authenticated as: ${Logger.formatWallet(creds.wallet_address)}`);
      Logger.info('Run "biofs logout" to switch accounts');
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

    // Initialize biofiles cache
    await initializeBioFilesCache(result.wallet);

    // Show success message
    Logger.box(
      `Wallet: ${chalk.green(result.wallet)}\n\n` +
      `You can now use:\n` +
      `  ${chalk.cyan('biofs files')}      - List your BioFiles\n` +
      `  ${chalk.cyan('biofs download')}   - Download files\n` +
      `  ${chalk.cyan('biofs upload')}     - Upload files\n` +
      `  ${chalk.cyan('biofs whoami')}     - Show current wallet`,
      'Authentication Successful'
    );

    Logger.success(`Credentials saved to: ~/.biofs/credentials.json`);
  } catch (error) {
    spinner.fail('Authentication failed');
    Logger.error(`Error: ${error}`);
    process.exit(1);
  }
}

/**
 * Initialize biofiles cache after successful authentication
 */
async function initializeBioFilesCache(walletAddress: string): Promise<void> {
  const spinner = Logger.spinner('Discovering your BioFiles...');

  try {
    const resolver = new BioCIDResolver();
    const cacheManager = new BioFilesCacheManager();

    // Discover all biofiles from all sources
    const biofiles = await resolver.discoverAllBioFiles(false);

    // Convert to cache format
    const cacheBiofiles = biofiles.map(bf => ({
      filename: bf.filename,
      locations: {
        s3: bf.s3_path,
        biocid: bf.biocid,
        story_ip: bf.ip_asset,
        avalanche_biosample: bf.source === 'Avalanche' ? bf.biocid?.split('/').pop() : undefined,
        local_path: undefined
      },
      metadata: {
        file_type: bf.type,
        size: bf.size,
        created_at: bf.created_at,
        tokenized: !!bf.ip_asset,
        shared_with: bf.granted ? [bf.owner || ''] : undefined,
        license_type: bf.license_type
      }
    }));

    // Save to cache
    cacheManager.update(walletAddress, cacheBiofiles);

    spinner.succeed(`Discovered ${biofiles.length} BioFiles`);
    Logger.debug(`Cache saved to: ~/.biofs/cache/biofiles.json`);
  } catch (error) {
    spinner.warn('Failed to initialize BioFiles cache - will fetch on demand');
    Logger.debug(`Cache initialization error: ${error}`);
  }
}
