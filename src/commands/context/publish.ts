/**
 * biofs context publish <bionft_file>
 * Uploads a signed .bionft to biorouter.genobank.app (/manifest_publish).
 */

import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs-extra';
import axios from 'axios';
import { Logger } from '../../lib/utils/logger';
import { verifyManifest, SignedManifest } from '../../lib/context/manifest';

export interface ContextPublishOptions {
  force?: boolean;
}

const BIOROUTER_URL =
  process.env.BIOROUTER_URL || 'https://biorouter.genobank.app';

export async function contextPublishCommand(
  bionftPath: string,
  options: ContextPublishOptions = {}
): Promise<void> {
  const spinner = ora('Loading manifest...').start();

  if (!(await fs.pathExists(bionftPath))) {
    spinner.fail(`File not found: ${bionftPath}`);
    process.exit(1);
  }

  const raw = await fs.readFile(bionftPath, 'utf-8');
  const manifest = JSON.parse(raw) as SignedManifest;

  spinner.text = 'Verifying signature locally...';
  const { verified, errors, recovered } = verifyManifest(manifest);
  if (!verified && !options.force) {
    spinner.fail('Local verification failed');
    errors.forEach(e => console.log(chalk.red(`  ✗ ${e}`)));
    console.log(chalk.yellow('\nUse --force to publish anyway (not recommended)'));
    process.exit(1);
  }
  spinner.succeed(`Verified (signer: ${chalk.cyan(recovered || '?')})`);

  spinner.start(`Publishing to ${BIOROUTER_URL}...`);
  try {
    const { data } = await axios.post(
      `${BIOROUTER_URL}/api_biorouter/manifest_publish`,
      {
        manifest: {
          domain: manifest.domain,
          message: manifest.message,
          assets: manifest.assets,
          skillsAllow: manifest.skillsAllow,
          skillsDeny: manifest.skillsDeny,
          deniedPurposes: manifest.deniedPurposes,
        },
        signature: manifest.signature,
      },
      { timeout: 30000 }
    );

    spinner.succeed('Published');
    console.log('');
    console.log(chalk.bold('BioContext is live:'));
    console.log(`  API:     ${chalk.cyan(data.url)}`);
    console.log(`  Case:    ${manifest.message.caseId}`);
    console.log(`  Owner:   ${manifest.message.owner}`);
    console.log(
      `  Expires: ${new Date(manifest.message.deadline * 1000).toISOString()}`
    );
    console.log('');
    console.log(
      chalk.yellow('💡 To revoke: ') +
        chalk.cyan(`biofs context revoke ${manifest.message.caseId}`)
    );
  } catch (e: any) {
    spinner.fail(
      `Publish failed: ${e.response?.data?.error || e.message}`
    );
    if (e.response?.data) {
      console.log(chalk.gray(JSON.stringify(e.response.data, null, 2)));
    }
    process.exit(1);
  }
}
