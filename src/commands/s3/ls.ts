import { BioCIDResolver } from '../../lib/biofiles/resolver';
import { Logger } from '../../lib/utils/logger';
import { BioFile } from '../../types/biofiles';
import chalk from 'chalk';
import boxen from 'boxen';

export interface FilesOptions {
  filter?: string;
  source?: string;
  json?: boolean;
  refresh?: boolean;
}

export async function filesCommand(options: FilesOptions): Promise<void> {
  const resolver = new BioCIDResolver();

  const spinner = Logger.spinner('Discovering your BioFiles...');

  try {
    const allFiles = await resolver.discoverAllBioFiles();
    spinner.stop();

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
  } catch (error) {
    spinner.fail('Failed to discover files');
    Logger.error(`Error: ${error}`);
    process.exit(1);
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
    case 'IPFS':
      return 'magenta';
    case 'Story':
      return 'green';
    default:
      return 'gray';
  }
}

function getSourceBadge(source: string): string {
  switch (source) {
    case 'S3':
      return chalk.bgBlue.white(` S3 `);
    case 'IPFS':
      return chalk.bgMagenta.white(` IPFS `);
    case 'Story':
      return chalk.bgGreen.white(` Story `);
    default:
      return chalk.bgGray.white(` ${source} `);
  }
}

