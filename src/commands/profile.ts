/**
 * biofs profile — dual-role credential hygiene for patient vs researcher E2E.
 *
 * Profiles store credentials under ~/.biofs/profiles/<name>/ so the same laptop
 * can hold the anonymized patient vault session and a known researcher session
 * without overwriting each other.
 *
 * Activation is via environment (preferred for scripts):
 *   export BIOFS_PROFILE=researcher
 *   biofs whoami
 *
 * Or print shell exports: biofs profile use researcher --print
 */
import chalk from 'chalk';
import * as fs from 'fs-extra';
import * as path from 'path';
import { ConfigPaths, getActiveProfileName } from '../lib/config/paths';
import { CONFIG } from '../lib/config/constants';
import { CredentialsManager } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';

export interface ProfileOptions {
  json?: boolean;
  print?: boolean;
}

export async function profileListCommand(options: ProfileOptions = {}): Promise<void> {
  const paths = ConfigPaths.getInstance();
  const root = paths.getProfilesRoot();
  const defaultDir = path.join(CONFIG.HOME_DIR, CONFIG.CONFIG_DIR_NAME);
  const active = getActiveProfileName();

  const profiles: Array<{ name: string; path: string; has_credentials: boolean; wallet?: string }> = [];

  // Default (legacy) profile
  const defCred = path.join(defaultDir, CONFIG.CREDENTIALS_FILE);
  let defWallet: string | undefined;
  if (await fs.pathExists(defCred)) {
    try {
      const c = await fs.readJson(defCred);
      defWallet = c.wallet_address;
    } catch { /* ignore */ }
  }
  profiles.push({
    name: 'default',
    path: defaultDir,
    has_credentials: await fs.pathExists(defCred),
    wallet: defWallet,
  });

  if (await fs.pathExists(root)) {
    const entries = await fs.readdir(root);
    for (const name of entries) {
      const p = path.join(root, name);
      const st = await fs.stat(p).catch(() => null);
      if (!st?.isDirectory()) continue;
      const credPath = path.join(p, CONFIG.CREDENTIALS_FILE);
      let wallet: string | undefined;
      if (await fs.pathExists(credPath)) {
        try {
          const c = await fs.readJson(credPath);
          wallet = c.wallet_address;
        } catch { /* ignore */ }
      }
      profiles.push({
        name,
        path: p,
        has_credentials: await fs.pathExists(credPath),
        wallet,
      });
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ active, profiles }, null, 2));
    return;
  }

  console.log(chalk.cyan('\nBioFS profiles\n'));
  console.log(chalk.gray('  Active:'), chalk.bold(active));
  console.log(chalk.gray('  Tip:'), 'export BIOFS_PROFILE=patient|researcher  (or BIOFS_HOME=...)');
  console.log();
  for (const p of profiles) {
    const mark = p.name === active || (active === 'default' && p.name === 'default') ? '*' : ' ';
    const wallet = p.wallet ? chalk.green(p.wallet) : chalk.gray('(no credentials)');
    console.log(`  ${mark} ${chalk.bold(p.name.padEnd(14))} ${wallet}`);
    console.log(chalk.gray(`      ${p.path}`));
  }
  console.log();
}

export async function profileUseCommand(name: string, options: ProfileOptions = {}): Promise<void> {
  if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    Logger.error('Profile name must be 1-64 chars: letters, digits, _ or -');
    process.exit(1);
  }
  if (name === 'default') {
    if (options.print) {
      console.log('unset BIOFS_PROFILE BIOFS_HOME');
      return;
    }
    console.log(chalk.yellow('To use the default profile, unset BIOFS_PROFILE:'));
    console.log(chalk.cyan('  unset BIOFS_PROFILE BIOFS_HOME'));
    return;
  }

  const paths = ConfigPaths.getInstance();
  const profileDir = path.join(paths.getProfilesRoot(), name);
  await fs.ensureDir(profileDir);

  if (options.print) {
    console.log(`export BIOFS_PROFILE=${name}`);
    console.log('unset BIOFS_HOME');
    return;
  }

  console.log(chalk.green(`\nProfile ready: ${name}`));
  console.log(chalk.gray(`  Directory: ${profileDir}`));
  console.log(chalk.white('\nActivate in this shell:'));
  console.log(chalk.cyan(`  export BIOFS_PROFILE=${name}`));
  console.log(chalk.white('\nThen authenticate as that role:'));
  if (name === 'researcher') {
    console.log(chalk.cyan('  biofs researcher register --provider orcid   # or linkedin, twitter, google, metamask'));
  } else if (name === 'patient') {
    console.log(chalk.cyan('  biofs login   # patient / vault owner wallet'));
  } else {
    console.log(chalk.cyan('  biofs login'));
  }
  console.log(chalk.white('\nVerify:'));
  console.log(chalk.cyan('  biofs whoami'));
  console.log(chalk.cyan('  biofs profile list'));
  console.log();
}

export async function profileStatusCommand(options: ProfileOptions = {}): Promise<void> {
  const active = getActiveProfileName();
  const paths = ConfigPaths.getInstance();
  const creds = await CredentialsManager.getInstance().loadCredentials();
  const payload = {
    active_profile: active,
    config_dir: paths.getConfigDir(),
    credentials_path: paths.getCredentialsPath(),
    authenticated: !!creds,
    wallet: creds?.wallet_address || null,
    expires_at: creds?.expires_at || null,
  };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(chalk.cyan('\nActive BioFS profile\n'));
  console.log(chalk.gray('  Profile:'), chalk.bold(payload.active_profile));
  console.log(chalk.gray('  Config: '), payload.config_dir);
  if (payload.authenticated) {
    console.log(chalk.gray('  Wallet: '), chalk.green(payload.wallet));
    console.log(chalk.gray('  Expires:'), payload.expires_at);
  } else {
    console.log(chalk.yellow('  Not authenticated in this profile. Run: biofs login'));
  }
  console.log();
}
