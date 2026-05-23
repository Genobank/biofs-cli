import chalk from 'chalk';
import { BioRoutesClient, biocidToKey, OnChainRoute, MismatchProof } from '../lib/bioroutes/client';
import { CredentialsManager } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';
import { createHash } from 'crypto';
import * as readline from 'readline';

export interface ResolveOptions {
  byFingerprint?: boolean;
  verify?: boolean;
  dispute?: boolean;
  json?: boolean;
  verbose?: boolean;
}

function formatTimestamp(epoch: number): string {
  if (!epoch) return 'never';
  return new Date(epoch * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');
}

function formatRoute(route: OnChainRoute, idx: number): string {
  const statusColor = route.status === 0 ? chalk.green : route.status === 1 ? chalk.yellow : chalk.red;
  const lines = [
    `  Route #${route.index}`,
    `    URI:          ${route.storageURI}`,
    `    Tier:         ${route.tierLabel}`,
    `    Status:       ${statusColor(route.statusLabel)}`,
    `    ContentHash:  ${route.contentHash.slice(0, 20)}...`,
    `    RegisteredBy: ${route.registeredBy}`,
    `    RegisteredAt: ${formatTimestamp(route.registeredAt)}`,
    `    LastVerified:  ${formatTimestamp(route.lastVerifiedAt)}`,
  ];
  return lines.join('\n');
}

export async function resolveCommand(
  identifier: string,
  options: ResolveOptions
): Promise<void> {
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }

  const client = new BioRoutesClient();

  try {
    let result;

    if (options.byFingerprint) {
      if (!options.json) console.log(chalk.cyan(`Resolving by fingerprint: ${identifier.slice(0, 16)}...`));
      result = await client.resolveByFingerprint(identifier);
      if (!result) {
        result = await client.resolveByKey(identifier);
      }
    } else {
      const biocidKey = biocidToKey(identifier);
      if (options.verbose) {
        Logger.debug(`BioCID: ${identifier}`);
        Logger.debug(`Key (SHA-256): ${biocidKey}`);
      }
      if (!options.json) console.log(chalk.cyan(`Resolving: ${identifier}`));
      result = await client.resolveBiocid(identifier);
    }

    if (!result || result.routeCount === 0) {
      if (options.json) {
        console.log(JSON.stringify({ found: false, identifier }, null, 2));
      } else {
        Logger.warning(`No routes found for: ${identifier}`);
        console.log(chalk.gray('  This biocid has no routes registered on BioRoutes (Sequentia chain 15132025).'));
        console.log(chalk.gray('  The file may exist in legacy storage — try: biofs files'));
      }
      return;
    }

    if (options.json) {
      console.log(JSON.stringify({
        found: true,
        biocidKey: result.biocidKey,
        routeCount: result.routeCount,
        primaryURI: result.primary?.storageURI || null,
        contentHash: result.contentHash,
        routes: result.routes,
      }, null, 2));
      return;
    }

    // Header
    console.log('');
    console.log(chalk.bold('BioRoutes Resolution'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(`  Identifier:  ${identifier}`);
    console.log(`  BioCID Key:  ${result.biocidKey.slice(0, 20)}...`);
    console.log(`  Routes:      ${result.routeCount}`);
    console.log(`  Chain:       Sequentia (15132025)`);
    console.log(`  Contract:    0xF758...14bAD`);

    if (result.primary) {
      console.log('');
      console.log(chalk.green.bold('  Best route:'));
      console.log(chalk.green(`    ${result.primary.storageURI}`));
      console.log(chalk.gray(`    ContentHash: ${result.primary.contentHash.slice(0, 20)}...`));
      console.log(chalk.gray(`    Registered:  ${formatTimestamp(result.primary.registeredAt)}`));
    }

    // Route table
    console.log('');
    console.log(chalk.bold('  All routes:'));
    for (let i = 0; i < result.routes.length; i++) {
      console.log(formatRoute(result.routes[i], i));
    }
    console.log('');

    // Verification pass — fetch bytes, compute fingerprint, compare to on-chain hash
    if ((options.verify || options.dispute) && result.primary) {
      console.log(chalk.cyan('Verifying route integrity...'));
      const url = await client.getPresignedUrl(result.primary.storageURI);
      if (!url) {
        Logger.warning('Could not generate presigned URL for the primary route.');
        console.log(chalk.gray('  The storage URI may require direct GCS access or the backend presigned-link endpoint.'));
      } else {
        try {
          const axios = (await import('axios')).default;
          const SAMPLE_SIZE = 4 * 1024 * 1024; // 4 MiB
          const resp = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: { Range: `bytes=0-${SAMPLE_SIZE - 1}` },
            timeout: 30000,
            validateStatus: (s: number) => s < 400 || s === 416,
          });

          const sampleBytes = Buffer.from(resp.data);
          const sampleHash = '0x' + createHash('sha256').update(sampleBytes).digest('hex');
          const onChainHash = result.primary.contentHash;

          console.log(chalk.gray(`  Fetched ${sampleBytes.length} bytes from primary route`));
          console.log(chalk.gray(`  Sample SHA-256:  ${sampleHash.slice(0, 20)}...`));
          console.log(chalk.gray(`  On-chain hash:   ${onChainHash.slice(0, 20)}...`));

          if (sampleHash.toLowerCase() === onChainHash.toLowerCase()) {
            console.log(chalk.green('  Integrity OK — sample hash matches on-chain contentHash.'));
          } else {
            console.log(chalk.red('  MISMATCH — sample hash does NOT match on-chain contentHash!'));

            if (options.dispute) {
              await submitDispute(client, result.biocidKey, result.primary, sampleHash, sampleBytes.length);
            } else {
              console.log(chalk.yellow('  Run with --dispute to submit a RouteDisputed tx on-chain.'));
            }
          }
        } catch (fetchErr: any) {
          Logger.warning(`Fetch failed: ${fetchErr.message}`);
          console.log(chalk.gray('  Could not download sample bytes for verification.'));
        }
      }
    }

  } catch (error: any) {
    if (error.code === 'NETWORK_ERROR' || error.code === 'SERVER_ERROR') {
      Logger.error(`Cannot reach Sequentia RPC: ${error.message}`);
      console.log(chalk.gray('  Check: https://seqrpc.genobank.app'));
    } else {
      Logger.error(`Resolution failed: ${error.message}`);
    }
    process.exit(1);
  }
}

async function submitDispute(
  client: BioRoutesClient,
  biocidKey: string,
  route: OnChainRoute,
  observedHash: string,
  sampleSize: number
): Promise<void> {
  if (!client.hasSigner()) {
    Logger.error('Cannot dispute: no signer. Set BIOFS_OWNER_PRIVATE_KEY or GENOBANK_OWNER_PRIVATE_KEY.');
    return;
  }

  const confirm = await askConfirm('Submit RouteDisputed tx on-chain? (y/n): ');
  if (!confirm) {
    console.log(chalk.gray('  Dispute cancelled.'));
    return;
  }

  console.log(chalk.cyan('  Submitting dispute...'));
  const proof: MismatchProof = {
    storageURI: route.storageURI,
    claimedHash: route.contentHash,
    observedHash,
    byteRangeStart: 0,
    byteRangeEnd: sampleSize,
    sampleHash: observedHash,
  };

  try {
    const result = await client.disputeRoute(biocidKey, route.index, proof);
    console.log(chalk.green(`  Dispute submitted! tx: ${result.txHash}`));
    console.log(chalk.gray(`  disputeId: ${result.disputeId}`));
  } catch (err: any) {
    Logger.error(`Dispute tx failed: ${err.message}`);
  }
}

function askConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}
