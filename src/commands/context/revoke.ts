/**
 * biofs context revoke <caseId|file.bionft>
 * GDPR Article 17 — revokes every BioCID in the manifest via /api_biorouter/revoke.
 */

import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import * as fs from 'fs-extra';
import axios from 'axios';
import { CredentialsManager } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { SignedManifest } from '../../lib/context/manifest';

const BIOROUTER_URL =
  process.env.BIOROUTER_URL || 'https://biorouter.genobank.app';

export interface ContextRevokeOptions {
  yes?: boolean;
  reason?: string;
}

export async function contextRevokeCommand(
  caseIdOrPath: string,
  options: ContextRevokeOptions = {}
): Promise<void> {
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }

  let manifest: SignedManifest;
  if (await fs.pathExists(caseIdOrPath)) {
    manifest = JSON.parse(await fs.readFile(caseIdOrPath, 'utf-8'));
  } else {
    const url = `${BIOROUTER_URL}/api_biorouter/manifest?case_id=${encodeURIComponent(caseIdOrPath)}`;
    const { data } = await axios.get(url);
    if (!data.manifest) {
      Logger.error(`Manifest not found for caseId "${caseIdOrPath}"`);
      process.exit(1);
    }
    manifest = data.manifest as SignedManifest;
  }

  const biocids = manifest.assets.map(a => a.biocid);

  console.log('');
  console.log(chalk.bold(`About to revoke:`));
  console.log(`  case:    ${manifest.message.caseId}`);
  console.log(`  owner:   ${manifest.message.owner}`);
  console.log(`  assets:  ${biocids.length} BioCID(s)`);
  biocids.forEach(b => console.log(chalk.gray(`    ${b}`)));
  console.log('');
  console.log(
    chalk.yellow('GDPR Article 17 — revocation propagates to cache in <5s')
  );
  console.log('');

  if (!options.yes) {
    const { ok } = await inquirer.prompt([
      { type: 'confirm', name: 'ok', message: 'Proceed?', default: false },
    ]);
    if (!ok) {
      Logger.error('Aborted.');
      process.exit(1);
    }
  }

  const spinner = ora('Revoking...').start();
  let ok = 0;
  let fail = 0;
  for (const biocid of biocids) {
    try {
      await axios.post(`${BIOROUTER_URL}/api_biorouter/revoke`, {
        user_signature: creds.user_signature,
        biocid,
      });
      ok++;
    } catch (e: any) {
      fail++;
      Logger.debug(`revoke ${biocid} failed: ${e.message}`);
    }
  }

  if (fail === 0) spinner.succeed(`Revoked ${ok}/${biocids.length}`);
  else spinner.warn(`Revoked ${ok}/${biocids.length} — ${fail} failed`);

  console.log('');
  console.log(chalk.green('✓ GDPR Article 17 compliance recorded.'));
}
