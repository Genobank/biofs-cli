import { CallbackServer } from '../../lib/auth/server';
import { BrowserLauncher } from '../../lib/auth/browser';
import { CredentialsManager } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';
import { ConfigPaths } from '../../lib/config/paths';
import { BioFilesCacheManager } from '../../lib/storage/biofiles-cache';
import { BioCIDResolver } from '../../lib/biofiles/resolver';
import { ErrorReporter } from '../../utils/errorReporter';
import chalk from 'chalk';
import * as readline from 'readline';
import * as fs from 'fs-extra';
import * as path from 'path';
import axios from 'axios';

export interface ResearcherRegisterOptions {
  port?: number;
  browser?: boolean;
  timeout?: number;
  provider?: string;
}

export interface ResearcherProfile {
  wallet_address: string;
  provider: string;
  registered_at: string;
  name?: string;
  email?: string;
  orcid_id?: string;
  institution?: string;
}

const RESEARCHER_PROFILE_FILE = 'researcher.json';

function getResearcherProfilePath(): string {
  // Profile-aware: ~/.biofs/profiles/<BIOFS_PROFILE>/researcher.json when set
  return path.join(ConfigPaths.getInstance().getConfigDir(), RESEARCHER_PROFILE_FILE);
}

export async function loadResearcherProfile(): Promise<ResearcherProfile | null> {
  const profilePath = getResearcherProfilePath();
  try {
    if (await fs.pathExists(profilePath)) {
      return await fs.readJson(profilePath);
    }
  } catch { /* ignore */ }
  return null;
}

export async function researcherRegisterCommand(options: ResearcherRegisterOptions): Promise<void> {
  const credManager = CredentialsManager.getInstance();

  // Check if already registered
  if (await credManager.hasCredentials()) {
    const creds = await credManager.loadCredentials();
    if (creds) {
      const profile = await loadResearcherProfile();
      if (profile) {
        Logger.info(`Already registered as researcher: ${Logger.formatWallet(creds.wallet_address)}`);
        Logger.info(`Provider: ${profile.provider}`);
        Logger.info('Run "biofs logout" to switch accounts, or "biofs researcher status" for details');
        return;
      }
    }
  }

  // Headless mode (--no-browser)
  if (options.browser !== undefined && options.browser === false) {
    await headlessResearcherRegister();
    return;
  }

  const config = await credManager.loadConfig();
  const port = options.port || config.callback_port || CONFIG.CALLBACK_PORT;

  const server = new CallbackServer();
  const callbackUrl = server.getCallbackUrl(port);
  const sessionId = server.getSessionId();

  const params = new URLSearchParams({
    returnUrl: callbackUrl,
    sessionId: sessionId,
    cli: 'true',
    mode: 'researcher'
  });
  if (options.provider) {
    params.set('provider', options.provider);
  }
  const registerUrl = `${CONFIG.RESEARCHER_REGISTER_URL}?${params.toString()}`;

  console.log('\n' + chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log(chalk.bold.white('  BioFS Researcher Registration'));
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════\n'));

  console.log(chalk.white('Choose your sign-in method in the browser:\n'));
  console.log(`  ${chalk.green('●')} ${chalk.white('ORCID iD')}        — Academic identity verification`);
  console.log(`  ${chalk.green('●')} ${chalk.white('Google')}          — Google account`);
  console.log(`  ${chalk.green('●')} ${chalk.white('LinkedIn')}        — Professional identity`);
  console.log(`  ${chalk.green('●')} ${chalk.white('Twitter / X')}     — Social identity`);
  console.log(`  ${chalk.green('●')} ${chalk.white('Apple')}           — Apple ID`);
  console.log(`  ${chalk.green('●')} ${chalk.white('MetaMask')}        — Existing Ethereum wallet\n`);

  console.log(chalk.gray('  A custodial Research Biowallet (EIP-55) will be provisioned'));
  console.log(chalk.gray('  for social sign-ins. MetaMask uses your existing wallet.\n'));

  console.log(chalk.cyan('───────────────────────────────────────────────────────────────\n'));

  if ((options.browser === undefined || options.browser === true) && config.auto_open_browser !== false) {
    Logger.info('Opening browser for researcher registration...');
    await BrowserLauncher.openAuthUrl(registerUrl);
  } else {
    console.log(chalk.cyan('Please open this URL in your browser:'));
    console.log(chalk.underline(registerUrl) + '\n');
  }

  const spinner = Logger.spinner('Waiting for registration (timeout: 5 minutes)...');

  try {
    const result = await server.start(port);
    spinner.succeed('Registration successful!');

    await credManager.saveCredentials(result.wallet, result.signature);

    const profile = await fetchAndSaveResearcherProfile(result.wallet);

    await initializeBioFilesCache(result.wallet);

    ErrorReporter.reportEvent('session_start', 'researcher register', result.wallet, {
      flow: 'browser',
      provider: profile?.provider || 'unknown'
    }).catch(() => {});

    showSuccessBox(result.wallet, profile);

    Logger.success('Credentials saved to: ~/.biofs/credentials.json');

    setImmediate(() => process.exit(0));
  } catch (error) {
    spinner.fail('Registration failed');
    Logger.error(`Error: ${error}`);
    process.exit(1);
  }
}

async function headlessResearcherRegister(): Promise<void> {
  const credManager = CredentialsManager.getInstance();

  console.log('\n' + chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log(chalk.bold.yellow('  Headless Researcher Registration'));
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════\n'));

  console.log(chalk.white('Since you\'re on a server without a browser, follow these steps:\n'));

  console.log(chalk.yellow('1.') + chalk.white(' Open this URL on a machine with a browser:'));
  console.log(chalk.cyan.underline(`\n   ${CONFIG.RESEARCHER_REGISTER_URL}?headless=true\n`));

  console.log(chalk.yellow('2.') + chalk.white(' Sign in using ORCID, Google, LinkedIn, Twitter, Apple, or MetaMask'));
  console.log(chalk.yellow('3.') + chalk.white(' Copy the wallet address and signature shown after registration'));
  console.log(chalk.yellow('4.') + chalk.white(' Paste them below\n'));

  console.log(chalk.cyan('───────────────────────────────────────────────────────────────\n'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve));

  try {
    const wallet = await question(chalk.green('Enter wallet address: '));
    if (!wallet?.trim()) { Logger.error('Wallet address is required'); rl.close(); process.exit(1); }
    if (!wallet.trim().match(/^0x[a-fA-F0-9]{40}$/)) {
      Logger.error('Invalid wallet address format. Expected Ethereum address (0x...)');
      rl.close(); process.exit(1);
    }

    const signature = await question(chalk.green('Enter signature: '));
    if (!signature?.trim()) { Logger.error('Signature is required'); rl.close(); process.exit(1); }
    if (!signature.trim().match(/^0x[a-fA-F0-9]{130}$/)) {
      Logger.error('Invalid signature format. Expected 65-byte signature (0x...)');
      rl.close(); process.exit(1);
    }

    rl.close();
    console.log('\n' + chalk.cyan('───────────────────────────────────────────────────────────────\n'));

    const spinner = Logger.spinner('Saving credentials...');
    await credManager.saveCredentials(wallet.trim(), signature.trim());
    spinner.succeed('Credentials saved!');

    const profile = await fetchAndSaveResearcherProfile(wallet.trim());
    await initializeBioFilesCache(wallet.trim());

    ErrorReporter.reportEvent('session_start', 'researcher register', wallet.trim(), {
      flow: 'headless',
      provider: profile?.provider || 'unknown'
    }).catch(() => {});

    showSuccessBox(wallet.trim(), profile);
    Logger.success('Credentials saved to: ~/.biofs/credentials.json');
  } catch (error) {
    rl.close();
    Logger.error(`Registration failed: ${error}`);
    process.exit(1);
  }
}

async function fetchAndSaveResearcherProfile(wallet: string): Promise<ResearcherProfile | null> {
  try {
    const response = await axios.get(
      `${CONFIG.API_BASE_URL}/api_biofs_researcher_status`,
      { params: { wallet }, timeout: 5000 }
    );

    if (response.data?.wallet_address) {
      const profile: ResearcherProfile = {
        wallet_address: response.data.wallet_address,
        provider: response.data.provider || 'metamask',
        registered_at: response.data.registered_at || new Date().toISOString(),
        name: response.data.name,
        email: response.data.email,
        orcid_id: response.data.orcid_id,
        institution: response.data.institution
      };

      await fs.writeJson(getResearcherProfilePath(), profile, { spaces: 2 });
      return profile;
    }
  } catch { /* API may not have the endpoint yet */ }

  const profile: ResearcherProfile = {
    wallet_address: wallet,
    provider: 'unknown',
    registered_at: new Date().toISOString()
  };

  await ConfigPaths.getInstance().ensureDirectories();
  await fs.writeJson(getResearcherProfilePath(), profile, { spaces: 2 });
  return profile;
}

async function initializeBioFilesCache(walletAddress: string): Promise<void> {
  const spinner = Logger.spinner('Discovering your BioFiles...');

  try {
    const resolver = new BioCIDResolver();
    const cacheManager = new BioFilesCacheManager();
    const biofiles = await resolver.discoverAllBioFiles(false);

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

    cacheManager.update(walletAddress, cacheBiofiles);
    spinner.succeed(`Discovered ${biofiles.length} BioFiles`);
  } catch (error) {
    spinner.warn('Failed to initialize BioFiles cache - will fetch on demand');
  }
}

function showSuccessBox(wallet: string, profile: ResearcherProfile | null): void {
  const providerLine = profile?.provider && profile.provider !== 'unknown'
    ? `\nProvider: ${chalk.yellow(profile.provider)}`
    : '';
  const orcidLine = profile?.orcid_id
    ? `\nORCID iD: ${chalk.yellow(profile.orcid_id)}`
    : '';

  Logger.box(
    `Research Biowallet: ${chalk.green(wallet)}${providerLine}${orcidLine}\n\n` +
    `You can now use:\n` +
    `  ${chalk.cyan('biofs files')}              - List available BioFiles\n` +
    `  ${chalk.cyan('biofs access request')}     - Request access to datasets\n` +
    `  ${chalk.cyan('biofs download')}           - Download files\n` +
    `  ${chalk.cyan('biofs mount')}              - Mount BioNFT-gated files\n` +
    `  ${chalk.cyan('biofs researcher status')}  - View your researcher profile`,
    'Researcher Registration Complete'
  );
}
