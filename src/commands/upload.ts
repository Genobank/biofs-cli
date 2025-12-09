import { FileUploader } from '../lib/biofiles/uploader';
import { Logger } from '../lib/utils/logger';
import chalk from 'chalk';
import * as fs from 'fs-extra';

export interface UploadOptions {
  type?: string;
  tokenize?: boolean;
  shareWith?: string;
  public?: boolean;
  quiet?: boolean;
}

export async function uploadCommand(
  filePath: string,
  options: UploadOptions = {}
): Promise<void> {
  const uploader = new FileUploader();

  // Check file exists
  if (!await fs.pathExists(filePath)) {
    Logger.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const stats = await fs.stat(filePath);
  if (!options.quiet) {
    Logger.info(`File: ${filePath}`);
    Logger.info(`Size: ${Logger.formatFileSize(stats.size)}`);
  }

  try {
    const result = await uploader.upload(filePath, {
      type: options.type,
      tokenize: options.tokenize,
      shareWith: options.shareWith,
      showProgress: !options.quiet
    });

    if (!options.quiet) {
      Logger.success('Upload successful!');

      console.log('\n' + chalk.cyan('File Details:'));
      console.log(`  BioCID: ${chalk.green(result.biocid)}`);

      if (result.ipId) {
        console.log(`  IP Asset: ${chalk.green(result.ipId)}`);
      }

      if (options.shareWith) {
        console.log(`  Shared with: ${chalk.green(options.shareWith)}`);
      }
    }
  } catch (error) {
    Logger.error(`Upload failed: ${error}`);
    process.exit(1);
  }
}
