/**
 * biofs context verify <bionft_file>
 * Local verification: EIP-712 sig, all 4 hashes, Merkle proofs, deadline.
 */

import chalk from 'chalk';
import * as fs from 'fs-extra';
import { Logger } from '../../lib/utils/logger';
import { verifyManifest, SignedManifest } from '../../lib/context/manifest';

export async function contextVerifyCommand(
  bionftPath: string
): Promise<void> {
  if (!(await fs.pathExists(bionftPath))) {
    Logger.error(`File not found: ${bionftPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(
    await fs.readFile(bionftPath, 'utf-8')
  ) as SignedManifest;

  console.log('');
  console.log(chalk.bold(`Verifying: ${bionftPath}`));
  console.log('');

  const { verified, errors, recovered } = verifyManifest(manifest);

  console.log(`  caseId:       ${manifest.message.caseId}`);
  console.log(`  owner:        ${manifest.message.owner}`);
  console.log(`  recovered:    ${recovered || '?'}`);
  const match = recovered?.toLowerCase() === manifest.message.owner.toLowerCase();
  console.log(
    `  signer:       ${match ? chalk.green('✓ match') : chalk.red('✗ mismatch')}`
  );
  const deadlineValid = manifest.message.deadline >= Math.floor(Date.now() / 1000);
  console.log(
    `  deadline:     ${new Date(manifest.message.deadline * 1000).toISOString()}  ${deadlineValid ? chalk.green('(valid)') : chalk.red('(EXPIRED)')}`
  );
  console.log(`  assets:       ${manifest.assets.length}`);
  console.log(`  skills allow: ${manifest.skillsAllow.length}`);
  console.log(`  skills deny:  ${manifest.skillsDeny.length}`);
  console.log('');

  if (verified) {
    console.log(chalk.green.bold('✓ VERIFIED'));
    process.exit(0);
  }
  console.log(chalk.red.bold('✗ VERIFICATION FAILED'));
  errors.forEach(e => console.log(chalk.red(`  - ${e}`)));
  process.exit(1);
}
