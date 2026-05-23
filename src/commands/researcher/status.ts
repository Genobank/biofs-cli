import { CredentialsManager } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { CONFIG } from '../../lib/config/constants';
import { loadResearcherProfile, ResearcherProfile } from './register';
import chalk from 'chalk';
import * as fs from 'fs-extra';
import * as path from 'path';
import axios from 'axios';

export interface ResearcherStatusOptions {
  json?: boolean;
  refresh?: boolean;
}

export async function researcherStatusCommand(options: ResearcherStatusOptions): Promise<void> {
  const credManager = CredentialsManager.getInstance();
  const creds = await credManager.loadCredentials();

  if (!creds) {
    Logger.error('Not authenticated. Run "biofs researcher register" or "biofs login" first.');
    process.exit(1);
  }

  let profile = await loadResearcherProfile();

  // Refresh from API if requested or no local profile
  if (options.refresh || !profile) {
    try {
      const response = await axios.get(
        `${CONFIG.API_BASE_URL}/api_biofs_researcher_status`,
        { params: { wallet: creds.wallet_address }, timeout: 5000 }
      );

      if (response.data?.wallet_address) {
        profile = {
          wallet_address: response.data.wallet_address,
          provider: response.data.provider || profile?.provider || 'unknown',
          registered_at: response.data.registered_at || profile?.registered_at || creds.created_at,
          name: response.data.name || profile?.name,
          email: response.data.email || profile?.email,
          orcid_id: response.data.orcid_id || profile?.orcid_id,
          institution: response.data.institution || profile?.institution
        };

        const profilePath = path.join(CONFIG.HOME_DIR, CONFIG.CONFIG_DIR_NAME, 'researcher.json');
        await fs.writeJson(profilePath, profile, { spaces: 2 });
      }
    } catch {
      // API unavailable — use local profile
    }
  }

  if (options.json) {
    console.log(JSON.stringify({
      wallet_address: creds.wallet_address,
      credentials_expire: creds.expires_at,
      researcher: profile || null
    }, null, 2));
    return;
  }

  console.log('\n' + chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log(chalk.bold.white('  Researcher Profile'));
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════\n'));

  console.log(`  ${chalk.gray('Wallet:')}        ${chalk.green(creds.wallet_address)}`);
  console.log(`  ${chalk.gray('Expires:')}       ${creds.expires_at}`);

  if (profile) {
    console.log(`  ${chalk.gray('Provider:')}      ${chalk.yellow(profile.provider)}`);
    console.log(`  ${chalk.gray('Registered:')}    ${profile.registered_at}`);
    if (profile.name) console.log(`  ${chalk.gray('Name:')}          ${profile.name}`);
    if (profile.email) console.log(`  ${chalk.gray('Email:')}         ${profile.email}`);
    if (profile.orcid_id) console.log(`  ${chalk.gray('ORCID iD:')}      ${chalk.cyan(profile.orcid_id)}`);
    if (profile.institution) console.log(`  ${chalk.gray('Institution:')}   ${profile.institution}`);
  } else {
    console.log(`\n  ${chalk.yellow('No researcher profile found locally.')}`);
    console.log(`  ${chalk.gray('Run "biofs researcher register" to create one.')}`);
  }

  console.log('\n' + chalk.cyan('───────────────────────────────────────────────────────────────\n'));

  console.log(`  ${chalk.gray('Profile file:')} ~/.biofs/researcher.json`);
  console.log(`  ${chalk.gray('Credentials:')}  ~/.biofs/credentials.json\n`);
}
