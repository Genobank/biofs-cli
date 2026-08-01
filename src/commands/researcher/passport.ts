/**
 * biofs researcher passport — publish / show known-identity card for room admits.
 */
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { loadResearcherProfile } from './register';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE =
  process.env.BIOFS_NODE_URL ||
  `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface PassportOptions {
  json?: boolean;
  quiet?: boolean;
  name?: string;
  provider?: string;
  orcid?: string;
  linkedin?: string;
  twitter?: string;
  institution?: string;
  ga4gh?: string;
  wallet?: string;
}

export async function researcherPassportPublishCommand(options: PassportOptions = {}): Promise<void> {
  const spinner = options.quiet ? null : ora('Publishing researcher passport…').start();
  try {
    const creds = await getCredentials();
    if (!creds) {
      spinner?.fail('Not authenticated');
      process.exit(1);
    }
    const local = await loadResearcherProfile();
    const body = {
      wallet: creds.wallet_address,
      signature: creds.user_signature,
      name: options.name || local?.name || undefined,
      provider: options.provider || local?.provider || 'unknown',
      orcid_id: options.orcid || local?.orcid_id || undefined,
      linkedin_url: options.linkedin || undefined,
      twitter: options.twitter || undefined,
      institution: options.institution || local?.institution || undefined,
      ga4gh_level: (options.ga4gh || 'BASIC').toUpperCase(),
    };
    const r = await axios.post(`${BIOFS_NODE_BASE}/researcher/passport`, body, {
      timeout: 30_000,
      validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) {
      spinner?.fail(r.data?.error || `HTTP ${r.status}`);
      process.exit(1);
    }
    spinner?.succeed(chalk.green('Passport published'));
    if (options.json) {
      console.log(JSON.stringify(r.data, null, 2));
      return;
    }
    const p = r.data.passport || r.data;
    console.log(chalk.cyan('\nResearcher passport\n'));
    console.log(chalk.gray('  Wallet:  '), p.wallet);
    console.log(chalk.gray('  Name:    '), p.name || '—');
    console.log(chalk.gray('  Provider:'), p.provider);
    console.log(chalk.gray('  ORCID:   '), p.orcid_id || '—');
    console.log(chalk.gray('  LinkedIn:'), p.linkedin_url || '—');
    console.log(chalk.gray('  GA4GH:   '), p.ga4gh_level);
    console.log();
  } catch (e: any) {
    spinner?.fail(e.message);
    process.exit(1);
  }
}

export async function researcherPassportShowCommand(options: PassportOptions = {}): Promise<void> {
  try {
    const creds = await getCredentials();
    const wallet = options.wallet || creds?.wallet_address;
    if (!wallet) {
      Logger.error('wallet required (login or --wallet)');
      process.exit(1);
    }
    const r = await axios.get(`${BIOFS_NODE_BASE}/researcher/passport`, {
      params: { wallet },
      timeout: 30_000,
      validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) {
      Logger.error(r.data?.error || `HTTP ${r.status}`);
      process.exit(1);
    }
    if (options.json) {
      console.log(JSON.stringify(r.data, null, 2));
      return;
    }
    const p = r.data.passport || r.data;
    console.log(chalk.cyan('\nResearcher passport\n'));
    console.log(JSON.stringify(p, null, 2));
    console.log();
  } catch (e: any) {
    Logger.error(e.message);
    process.exit(1);
  }
}
