/**
 * `biofs cred revoke <cred_id>` — owner-signed burn of an unused credential.
 *
 * The owner wallet signs the canonical message `BURN <cred_id>`; the server
 * recovers the signer and confirms it matches owner_wallet on the credential
 * before flipping status=burned and refunding the reserved bytes to the
 * patient's Permittee Delegation budget.
 *
 * Private key source:
 *   GENOBANK_OWNER_PRIVATE_KEY    secp256k1 hex (set locally; never committed)
 *
 * A future version will read from the biofs credentials store (activated kit
 * mnemonic) so the user doesn't have to export their private key.
 */
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { ethers } from 'ethers';
import { apiDelete, signerFromEnv } from './lib';

export interface CredRevokeOptions {
  reason?: string;
  force?: boolean;
}

export async function credRevokeCommand(credId: string, options: CredRevokeOptions): Promise<void> {
  const signer = signerFromEnv('GENOBANK_OWNER_PRIVATE_KEY');
  console.log(chalk.gray(`owner wallet: ${signer.address}`));

  if (!options.force) {
    const { go } = await inquirer.prompt([{
      type: 'confirm',
      name: 'go',
      default: false,
      message: `Burn credential ${credId}? The lab will no longer be able to use it for any new upload.`,
    }]);
    if (!go) {
      console.log(chalk.gray('aborted'));
      return;
    }
  }

  const signature = await signer.signMessage(`BURN ${credId}`);
  const spinner = ora(`Revoking ${credId}...`).start();
  try {
    const data = await apiDelete(
      '/api_biovault/burn_credential',
      {
        owner_wallet: signer.address.toLowerCase(),
        owner_signature: signature,
        reason: options.reason || 'user_cli',
      },
      { cred_id: credId },
    );
    spinner.succeed(chalk.green('✓ credential burned'));
    console.log(chalk.gray(`  biosample_id:    ${data.biosample_id}`));
    console.log(chalk.gray(`  laboratory_id:   ${data.laboratory_id}`));
    console.log(chalk.gray(`  bytes refunded:  ${(data.bytes_to_refund || 0).toLocaleString()}`));
  } catch (err: any) {
    spinner.fail(chalk.red(`Revoke failed: ${err.message}`));
    if (err.payload) console.error(chalk.gray(JSON.stringify(err.payload, null, 2)));
    throw err;
  }
}
