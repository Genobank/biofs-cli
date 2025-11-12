import { FileDownloader } from '../lib/biofiles/downloader';
import { Logger } from '../lib/utils/logger';
import chalk from 'chalk';
import * as path from 'path';

export interface DownloadOptions {
  output?: string;
  stream?: boolean;
  quiet?: boolean;
}

export async function downloadCommand(
  biocidOrFilename: string,
  destination?: string,
  options: DownloadOptions = {}
): Promise<void> {
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

      // Show file info
      const filename = path.basename(outputPath);
      const dirname = path.dirname(outputPath);
      console.log(chalk.gray(`  Directory: ${dirname}`));
      console.log(chalk.gray(`  Filename: ${filename}`));
    }
  } catch (error) {
    Logger.error(`Download failed: ${error}`);
    process.exit(1);
  }
}