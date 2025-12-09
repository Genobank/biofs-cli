import { BioCIDResolver } from '../lib/biofiles/resolver';
import { BioFilesCacheManager } from '../lib/storage/biofiles-cache';
import { CredentialsManager } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';
import { BioFile } from '../types/biofiles';
import chalk from 'chalk';
import boxen from 'boxen';

export interface FilesOptions {
  filter?: string;
  source?: string;
  json?: boolean;
  update?: boolean;  // Force refresh from API
  verbose?: boolean;
}

export async function filesCommand(options: FilesOptions): Promise<void> {
  const cacheManager = new BioFilesCacheManager();
  const credManager = CredentialsManager.getInstance();

  let allFiles: BioFile[] = [];

  // Check if we should use cache or force update
  const useCache = !options.update && !cacheManager.needsUpdate();

  if (useCache) {
    // Load from cache
    const spinner = Logger.spinner('Loading BioFiles from cache...');
    try {
      const cachedBiofiles = cacheManager.getAll();

      if (cachedBiofiles.length > 0) {
        // Convert cache format back to BioFile format
        allFiles = cachedBiofiles.map(cbf => ({
          filename: cbf.filename,
          biocid: cbf.locations.biocid || '',
          type: cbf.metadata.file_type || 'unknown',
          source: cbf.locations.story_ip ? 'Sequentia' :
                  cbf.locations.avalanche_biosample ? 'Avalanche' :
                  cbf.locations.s3 ? 'S3' : 'BioFS',
          size: cbf.metadata.size,
          created_at: cbf.metadata.created_at,
          s3_path: cbf.locations.s3,
          ip_asset: cbf.locations.story_ip,
          granted: cbf.metadata.shared_with && cbf.metadata.shared_with.length > 0,
          owner: cbf.metadata.shared_with?.[0],
          license_type: cbf.metadata.license_type
        }));

        const cacheStats = cacheManager.getStats();
        spinner.succeed(`Loaded ${allFiles.length} BioFiles from cache (updated ${new Date(cacheStats.last_updated || '').toLocaleString()})`);
        Logger.debug(`Use --update to refresh from blockchain and S3`);
      } else {
        spinner.warn('Cache is empty - fetching from API...');
        allFiles = await fetchAndCacheBioFiles(cacheManager, credManager, options.verbose);
      }
    } catch (error) {
      spinner.warn('Cache unavailable - fetching from API...');
      allFiles = await fetchAndCacheBioFiles(cacheManager, credManager, options.verbose);
    }
  } else {
    // Force refresh from API
    allFiles = await fetchAndCacheBioFiles(cacheManager, credManager, options.verbose);
  }

  // Apply filters
  let files = allFiles;

  if (options.filter) {
    files = files.filter(f => f.type.toLowerCase() === options.filter?.toLowerCase());
  }

  if (options.source) {
    files = files.filter(f => f.source.toLowerCase() === options.source?.toLowerCase());
  }

  if (files.length === 0) {
    Logger.info('No files found matching your criteria');
    return;
  }

  // Output results
  if (options.json) {
    console.log(JSON.stringify(files, null, 2));
  } else {
    displayFilesTable(files, options.filter);
  }
}

/**
 * Fetch biofiles from API and update cache
 */
async function fetchAndCacheBioFiles(
  cacheManager: BioFilesCacheManager,
  credManager: CredentialsManager,
  verbose: boolean = false
): Promise<BioFile[]> {
  const spinner = Logger.spinner('Discovering BioFiles from all sources...');

  try {
    const resolver = new BioCIDResolver();
    const allFiles = await resolver.discoverAllBioFiles(verbose);

    // Get wallet address for cache
    const creds = await credManager.loadCredentials();
    if (creds) {
      // Convert to cache format and save
      const cacheBiofiles = allFiles.map(bf => ({
        filename: bf.filename,
        locations: {
          s3: bf.s3_path,
          biocid: bf.biocid,
          story_ip: bf.ip_asset,
          avalanche_biosample: bf.source === 'Avalanche' ? bf.biocid?.split('/').pop() : undefined,
          local_path: undefined
        },
        metadata: {
          file_type: bf.type,
          size: bf.size,
          created_at: bf.created_at,
          tokenized: !!bf.ip_asset,
          shared_with: bf.granted ? [bf.owner || ''] : undefined,
          license_type: bf.license_type
        }
      }));

      cacheManager.update(creds.wallet_address, cacheBiofiles);
      spinner.succeed(`Discovered ${allFiles.length} BioFiles (cache updated)`);
    } else {
      spinner.succeed(`Discovered ${allFiles.length} BioFiles`);
    }

    return allFiles;
  } catch (error) {
    spinner.fail('Failed to discover files');
    throw error;
  }
}

function displayFilesTable(files: BioFile[], filterType?: string): void {
  const totalCount = files.length;
  const typeDescription = filterType ? ` ${filterType.toUpperCase()}` : '';

  console.log(chalk.cyan(`\n📁 Your BioFiles (${totalCount}${typeDescription} files)\n`));

  // Group files by type
  const filesByType = files.reduce((acc, file) => {
    if (!acc[file.type]) acc[file.type] = [];
    acc[file.type].push(file);
    return acc;
  }, {} as Record<string, BioFile[]>);

  // Display each type
  for (const [type, typeFiles] of Object.entries(filesByType)) {
    console.log(chalk.yellow(`\n${type.toUpperCase()} Files (${typeFiles.length}):`));

    for (const file of typeFiles) {
      const box = boxen(
        formatFileInfo(file),
        {
          padding: 1,
          borderStyle: 'round',
          borderColor: getSourceColor(file.source)
        }
      );
      console.log(box);
    }
  }
}

function formatFileInfo(file: BioFile): string {
  const lines: string[] = [];

  lines.push(`${chalk.bold('BioCID:')} ${chalk.cyan(file.biocid)}`);
  lines.push(`${chalk.bold('Filename:')} ${file.filename}`);
  lines.push(`${chalk.bold('Type:')} ${file.type.toUpperCase()}`);
  lines.push(`${chalk.bold('Source:')} ${getSourceBadge(file.source)}`);

  if (file.size) {
    lines.push(`${chalk.bold('Size:')} ${Logger.formatFileSize(file.size)}`);
  }

  if (file.created_at) {
    lines.push(`${chalk.bold('Created:')} ${new Date(file.created_at).toLocaleDateString()}`);
  }

  if (file.ip_asset) {
    lines.push(`${chalk.bold('IP Asset:')} ${Logger.formatWallet(file.ip_asset)}`);
  }

  return lines.join('\n');
}

function getSourceColor(source: string): string {
  switch (source) {
    case 'S3':
      return 'blue';
    case 'BioFS':
      return 'cyan';  // BioNFT-Gated S3 storage
    case 'IPFS':
      return 'magenta';
    case 'Sequentia':
      return 'green';
    default:
      return 'gray';
  }
}

function getSourceBadge(source: string): string {
  switch (source) {
    case 'S3':
      return chalk.bgBlue.white(` S3 `);
    case 'BioFS':
      return chalk.bgCyan.black(` BioFS 🧬 `);  // BioNFT-Gated S3 - our proprietary protocol
    case 'IPFS':
      return chalk.bgMagenta.white(` IPFS `);
    case 'Sequentia':
      return chalk.bgGreen.white(` Sequentia `);
    default:
      return chalk.bgGray.white(` ${source} `);
  }
}
