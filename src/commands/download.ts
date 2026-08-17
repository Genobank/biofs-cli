import { FileDownloader } from '../lib/biofiles/downloader';
import { BioRoutesClient, biocidToKey } from '../lib/bioroutes/client';
import { calculateSnpFingerprint } from '../lib/biofiles/fingerprint';
import { Logger } from '../lib/utils/logger';
import { isHeavyGenomicName } from '../lib/biofiles/filetype';
import { BioCIDParser } from '../lib/biofiles/biocid';
import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';

export interface DownloadOptions {
  output?: string;
  stream?: boolean;
  quiet?: boolean;
  skipVerify?: boolean;
  gsUri?: string;       // bypass BioFiles discovery and fetch directly from gs://...
  skipConsent?: boolean;
}

export async function downloadCommand(
  biocidOrFilename: string,
  destination?: string,
  options: DownloadOptions = {}
): Promise<void> {
  // Direct gs:// URI path — bypasses BioFiles discovery for files that resolve
  // via `biofs route check` (bioroutes.inventory) but aren't in the API index.
  // The biosample serial passed as positional arg is used only for the default
  // local destination filename; auth is via the local gcloud service account.
  const parsed = BioCIDParser.parse(biocidOrFilename);
  const heavyName = parsed?.identifier || biocidOrFilename;
  if (isHeavyGenomicName(heavyName) || ['bam', 'cram', 'fastq', 'vcf', 'gvcf', 'sqlite'].includes(parsed?.type || '')) {
    Logger.error('Refusing to copy BAM/CRAM/FASTQ/VCF/sqlite bytes onto this machine.');
    console.log(chalk.yellow('Use `biofs stream` or `biofs query`. Heavy biodata stays on the server behind the biocid.'));
    process.exit(2);
  }

  if (options.gsUri || biocidOrFilename.startsWith('gs://')) {
    const gsPath = options.gsUri || biocidOrFilename;
    if (!gsPath.startsWith('gs://')) {
      throw new Error(`--gs-uri must start with gs://, got: ${gsPath}`);
    }
    const defaultName = gsPath.split('/').pop() || 'download.bin';
    if (isHeavyGenomicName(defaultName)) {
      Logger.error('Refusing to `gcloud storage cp` genomic bytes onto this machine.');
      process.exit(2);
    }
    const target = destination || options.output || defaultName;
    if (!options.quiet) {
      Logger.info(`Direct GCS fetch (bypassing BioFiles discovery): ${gsPath}`);
    }
    const r = spawnSync('gcloud', ['storage', 'cp', gsPath, target], {
      encoding: 'utf8',
      stdio: options.quiet ? 'pipe' : 'inherit',
      maxBuffer: 50 * 1024 * 1024,
    });
    if (r.status !== 0) {
      Logger.error(`gcloud storage cp failed: ${r.stderr || r.stdout || 'unknown'}`);
      process.exit(1);
    }
    if (!options.quiet) {
      const sz = fs.existsSync(target) ? fs.statSync(target).size : 0;
      Logger.success(`Downloaded to: ${chalk.green(target)} (${(sz / 1e6).toFixed(1)} MB)`);
    }
    return;
  }

  const downloader = new FileDownloader();

  if (!options.quiet) {
    Logger.info(`Resolving: ${biocidOrFilename}`);
  }

  try {
    const outputPath = await downloader.download(
      biocidOrFilename,
      destination || options.output,
      !options.quiet
    );

    if (!options.quiet) {
      Logger.success(`Downloaded to: ${chalk.green(outputPath)}`);
      const filename = path.basename(outputPath);
      const dirname = path.dirname(outputPath);
      console.log(chalk.gray(`  Directory: ${dirname}`));
      console.log(chalk.gray(`  Filename: ${filename}`));
    }

    // G.3: Post-download integrity check against on-chain contentHash
    if (!options.skipVerify && biocidOrFilename.startsWith('biocid://')) {
      await verifyDownloadIntegrity(biocidOrFilename, outputPath, options.quiet);
    }
  } catch (error) {
    Logger.error(`Download failed: ${error}`);
    process.exit(1);
  }
}

async function verifyDownloadIntegrity(biocid: string, localPath: string, quiet?: boolean): Promise<void> {
  try {
    const client = new BioRoutesClient();
    const result = await client.resolveBiocid(biocid);

    if (!result.primary?.contentHash) return;
    const onChainHash = result.primary.contentHash;

    // Compute fingerprint of downloaded file
    let localHash: string;
    const ext = localPath.toLowerCase();
    if (ext.includes('.vcf') || ext.endsWith('.txt') || ext.endsWith('.csv')) {
      const { fingerprint } = await calculateSnpFingerprint(localPath);
      localHash = '0x' + fingerprint;
    } else {
      const bytes = await readFile(localPath);
      localHash = '0x' + createHash('sha256').update(bytes).digest('hex');
    }

    if (localHash.toLowerCase() === onChainHash.toLowerCase()) {
      if (!quiet) console.log(chalk.green('  Integrity verified against on-chain contentHash.'));
    } else {
      Logger.warning('Downloaded file fingerprint does NOT match on-chain contentHash!');
      console.log(chalk.red(`  On-chain:  ${onChainHash.slice(0, 20)}...`));
      console.log(chalk.red(`  Local:     ${localHash.slice(0, 20)}...`));
      console.log(chalk.yellow('  Auto-disputing stale route...'));

      if (client.hasSigner()) {
        const proof = {
          storageURI: result.primary.storageURI,
          claimedHash: onChainHash,
          observedHash: localHash,
          byteRangeStart: 0,
          byteRangeEnd: 4 * 1024 * 1024,
          sampleHash: localHash,
        };
        try {
          const dispute = await client.disputeRoute(result.biocidKey, result.primary.index, proof);
          console.log(chalk.green(`  RouteDisputed tx: ${dispute.txHash}`));
        } catch (err: any) {
          Logger.debug(`Auto-dispute failed (non-fatal): ${err.message}`);
        }
      } else {
        console.log(chalk.gray('  Set BIOFS_OWNER_PRIVATE_KEY to auto-dispute mismatches.'));
      }
    }
  } catch {
    // Integrity check is best-effort; don't fail the download
  }
}

