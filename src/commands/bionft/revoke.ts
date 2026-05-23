/**
 * `biofs bionft revoke <tokenId>` — patient-signed on-chain revoke of a BioNFT.
 *
 * Replaces the broken REST DELETE-with-body path (/api_biovault/burn_credential)
 * we hit earlier. Now it's a real ethers.Contract call — the patient's private
 * key submits a tx that atomically flips the on-chain state.
 *
 * For RENT_AGREEMENT → calls BioNFTCredentials.revokeRentAgreement.
 * For INGEST_TICKET  → calls BioNFTCredentials.burnIngestTicket.
 * (BIOSAMPLE_PARENT / DATA_FILE_CHILD use BioAssetVault.deactivateChild/Parent
 *  which is a separate future command; not in scope for this patch.)
 *
 * Requires: GENOBANK_OWNER_PRIVATE_KEY (or BIOFS_OWNER_PRIVATE_KEY).
 */
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import {
  createBioNFTClient,
  categoryOf,
  burnIngestTicket,
  revokeRentAgreement,
  DEFAULT_CREDS_ADDR,
} from '../../lib/bionft/client';

export interface BionftRevokeOptions {
  reason?: string;
  force?: boolean;
}

export async function bionftRevokeCommand(tokenIdStr: string, options: BionftRevokeOptions): Promise<void> {
  const tokenId = BigInt(tokenIdStr);
  const category = categoryOf(tokenId);
  const reason = options.reason || 'user_cli';

  if (category !== 'RENT_AGREEMENT' && category !== 'INGEST_TICKET') {
    throw new Error(
      `Cannot revoke BioNFT of category ${category}. ` +
      `Only RENT_AGREEMENT (2M+1..3M) and INGEST_TICKET (3M+1..) are revocable on-chain. ` +
      `For DATA_FILE_CHILD use 'biofs vault deactivate <tokenId>' (coming in phase G).`,
    );
  }

  const client = createBioNFTClient();
  if (!client.signer) {
    throw new Error(
      'on-chain revoke requires a signer. Set GENOBANK_OWNER_PRIVATE_KEY ' +
      '(or BIOFS_OWNER_PRIVATE_KEY) to the patient wallet private key.',
    );
  }
  console.log(chalk.gray(`owner wallet: ${client.signer.address}`));
  console.log(chalk.gray(`contract:     ${DEFAULT_CREDS_ADDR}`));

  if (!options.force) {
    const action = category === 'RENT_AGREEMENT' ? 'revoke' : 'burn';
    const { go } = await inquirer.prompt([{
      type: 'confirm',
      name: 'go',
      default: false,
      message: `On-chain ${action} BioNFT #${tokenId} (${category})? This is a real tx on Sequentia.`,
    }]);
    if (!go) {
      console.log(chalk.gray('aborted'));
      return;
    }
  }

  const spinner = ora(`Submitting ${category === 'RENT_AGREEMENT' ? 'revokeRentAgreement' : 'burnIngestTicket'}...`).start();
  try {
    const receipt = category === 'RENT_AGREEMENT'
      ? await revokeRentAgreement(client, tokenId, reason)
      : await burnIngestTicket(client, tokenId, reason);
    if (!receipt) throw new Error('tx receipt was null');

    spinner.succeed(chalk.green(`✓ on-chain ${category === 'RENT_AGREEMENT' ? 'revoked' : 'burned'}`));
    console.log(chalk.gray(`  tx hash:    ${receipt.hash}`));
    console.log(chalk.gray(`  block:      ${receipt.blockNumber}`));
    console.log(chalk.gray(`  gas used:   ${receipt.gasUsed?.toString()}`));
    console.log(chalk.gray(`  explorer:   https://explorer.sequentias-test.genobank.io/tx/${receipt.hash}`));
  } catch (err: any) {
    spinner.fail(chalk.red(`Revoke failed: ${err.shortMessage || err.message}`));
    if (err.reason) console.error(chalk.gray(`  reason: ${err.reason}`));
    throw err;
  }
}
