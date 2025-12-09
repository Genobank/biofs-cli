/**
 * FUSE Command - Remote BioNFT-Gated File Access via BioFS-Node
 *
 * Connects to a remote biofs-node server to access BioNFT-gated files
 * with consent verification on the Sequentia blockchain.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import * as fs from 'fs-extra';
import * as path from 'path';
import { Logger } from '../lib/utils/logger';
import { getCredentials } from '../lib/auth/credentials';

const DEFAULT_SERVER = process.env.BIOFS_NODE_URL || 'http://localhost:8081';

export interface FuseOptions {
  server?: string;
  json?: boolean;
  verbose?: boolean;
  output?: string;
}

/**
 * Get server URL from options, env, or default
 */
function getServerUrl(options: FuseOptions): string {
  return options.server || process.env.BIOFS_NODE_URL || DEFAULT_SERVER;
}

/**
 * List files available in a biosample
 */
export async function fuseListCommand(
  biosampleId: string,
  options: FuseOptions = {}
): Promise<void> {
  const spinner = ora('Fetching file list...').start();
  const serverUrl = getServerUrl(options);

  try {
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const { wallet_address, user_signature } = credentials;

    // Call FUSE list endpoint
    const url = `${serverUrl}/api/v1/fuse/list`;
    const params = {
      biosample: biosampleId,
      wallet: wallet_address,
      signature: user_signature
    };

    if (options.verbose) {
      console.log(chalk.gray(`\nRequest: GET ${url}`));
      console.log(chalk.gray(`Params: ${JSON.stringify(params, null, 2)}`));
    }

    const response = await axios.get(url, { params, timeout: 30000 });

    spinner.succeed(chalk.green('✓ Files retrieved'));

    if (options.json) {
      console.log(JSON.stringify(response.data, null, 2));
      return;
    }

    const { files, count, biosample } = response.data;

    console.log('');
    console.log(chalk.bold(`📁 Biosample ${biosample} - ${count} file(s)`));
    console.log('');

    if (files && files.length > 0) {
      for (const file of files) {
        const sizeGB = (file.size_bytes / 1024 / 1024 / 1024).toFixed(2);
        console.log(`  ${chalk.green('•')} ${file.filename} ${chalk.gray(`(${sizeGB} GB)`)}`);
      }
    } else {
      console.log(chalk.yellow('  No files found'));
    }

    console.log('');
    console.log(chalk.gray(`Server: ${serverUrl}`));
    console.log(chalk.gray(`Wallet: ${wallet_address.substring(0, 10)}...`));

  } catch (error: any) {
    spinner.fail(chalk.red('✗ Failed to list files'));
    handleError(error, serverUrl);
    process.exit(1);
  }
}

/**
 * Verify BioNFT consent for a biosample
 */
export async function fuseMountCommand(
  biosampleId: string,
  options: FuseOptions = {}
): Promise<void> {
  const spinner = ora('Verifying BioNFT consent...').start();
  const serverUrl = getServerUrl(options);

  try {
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const { wallet_address, user_signature } = credentials;

    // Call FUSE mount endpoint (consent verification)
    const url = `${serverUrl}/api/v1/fuse/mount`;
    const params = {
      biosample: biosampleId,
      wallet: wallet_address,
      signature: user_signature
    };

    const response = await axios.get(url, { params, timeout: 30000 });

    if (!response.data.allowed) {
      spinner.fail(chalk.red('✗ BioNFT consent required'));
      console.log('');
      console.log(chalk.yellow('You do not have consent to access this biosample.'));
      if (response.data.consent_url) {
        console.log(chalk.gray(`Request access: ${response.data.consent_url}`));
      }
      process.exit(1);
    }

    spinner.succeed(chalk.green('✓ BioNFT consent verified'));

    if (options.json) {
      console.log(JSON.stringify(response.data, null, 2));
      return;
    }

    const { mount_id, operations, tx_hash, block_number } = response.data;

    console.log('');
    console.log(chalk.bold('🔐 BioNFT Consent Verified on Sequentia'));
    console.log('');
    console.log(`  ${chalk.cyan('Biosample:')} ${biosampleId}`);
    console.log(`  ${chalk.cyan('Mount ID:')} ${mount_id}`);
    console.log(`  ${chalk.cyan('Operations:')} ${operations?.join(', ') || 'read, download'}`);
    if (tx_hash) {
      console.log(`  ${chalk.cyan('TX Hash:')} ${tx_hash.substring(0, 20)}...`);
    }
    if (block_number) {
      console.log(`  ${chalk.cyan('Block:')} ${block_number}`);
    }
    console.log('');
    console.log(chalk.gray('💡 You can now list or stream files from this biosample'));
    console.log(chalk.gray(`💡 List files: biofs fuse list ${biosampleId} --server ${serverUrl}`));

  } catch (error: any) {
    spinner.fail(chalk.red('✗ Consent verification failed'));
    handleError(error, serverUrl);
    process.exit(1);
  }
}

/**
 * Stream a file from a biosample
 */
export async function fuseStreamCommand(
  biosampleId: string,
  filename: string,
  options: FuseOptions = {}
): Promise<void> {
  const serverUrl = getServerUrl(options);
  const outputPath = options.output || filename;

  const spinner = ora(`Streaming ${filename}...`).start();

  try {
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const { wallet_address, user_signature } = credentials;

    // First get file info
    const infoUrl = `${serverUrl}/api/v1/fuse/info`;
    const infoParams = {
      biosample: biosampleId,
      filename,
      wallet: wallet_address,
      signature: user_signature
    };

    const infoResponse = await axios.get(infoUrl, { params: infoParams, timeout: 30000 });
    const fileSize = infoResponse.data.size;
    const fileSizeGB = (fileSize / 1024 / 1024 / 1024).toFixed(2);

    spinner.text = `Streaming ${filename} (${fileSizeGB} GB)...`;

    // Stream file in chunks
    const chunkSize = 10 * 1024 * 1024; // 10MB chunks
    let offset = 0;
    const writeStream = fs.createWriteStream(outputPath);

    while (offset < fileSize) {
      const length = Math.min(chunkSize, fileSize - offset);
      const progress = Math.round((offset / fileSize) * 100);
      spinner.text = `Streaming ${filename} (${progress}% - ${(offset / 1024 / 1024).toFixed(0)}MB / ${(fileSize / 1024 / 1024).toFixed(0)}MB)...`;

      const streamUrl = `${serverUrl}/api/v1/fuse/stream`;
      const streamParams = {
        biosample: biosampleId,
        filename,
        wallet: wallet_address,
        signature: user_signature,
        offset,
        length
      };

      const response = await axios.get(streamUrl, {
        params: streamParams,
        responseType: 'arraybuffer',
        timeout: 60000
      });

      writeStream.write(Buffer.from(response.data));
      offset += length;
    }

    writeStream.end();

    spinner.succeed(chalk.green(`✓ Downloaded to ${outputPath}`));

    console.log('');
    console.log(chalk.bold('📥 File Downloaded'));
    console.log(`  ${chalk.cyan('File:')} ${filename}`);
    console.log(`  ${chalk.cyan('Size:')} ${fileSizeGB} GB`);
    console.log(`  ${chalk.cyan('Output:')} ${path.resolve(outputPath)}`);
    console.log('');

  } catch (error: any) {
    spinner.fail(chalk.red(`✗ Failed to stream ${filename}`));
    handleError(error, serverUrl);
    process.exit(1);
  }
}

/**
 * Download sample of file (for FastQC preview)
 */
export async function fuseSampleCommand(
  biosampleId: string,
  filename: string,
  options: FuseOptions & { size?: string } = {}
): Promise<void> {
  const serverUrl = getServerUrl(options);
  const sampleSize = parseSampleSize(options.size || '100MB');
  const outputPath = options.output || `sample_${filename}`;

  const spinner = ora(`Downloading ${formatBytes(sampleSize)} sample of ${filename}...`).start();

  try {
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const { wallet_address, user_signature } = credentials;

    // Stream sample in chunks
    const chunkSize = 10 * 1024 * 1024; // 10MB chunks
    let offset = 0;
    const writeStream = fs.createWriteStream(outputPath);

    while (offset < sampleSize) {
      const length = Math.min(chunkSize, sampleSize - offset);
      const progress = Math.round((offset / sampleSize) * 100);
      spinner.text = `Downloading sample (${progress}%)...`;

      const streamUrl = `${serverUrl}/api/v1/fuse/stream`;
      const streamParams = {
        biosample: biosampleId,
        filename,
        wallet: wallet_address,
        signature: user_signature,
        offset,
        length
      };

      const response = await axios.get(streamUrl, {
        params: streamParams,
        responseType: 'arraybuffer',
        timeout: 60000
      });

      writeStream.write(Buffer.from(response.data));
      offset += length;
    }

    writeStream.end();

    spinner.succeed(chalk.green(`✓ Sample downloaded to ${outputPath}`));

    console.log('');
    console.log(chalk.bold('📥 Sample Downloaded'));
    console.log(`  ${chalk.cyan('File:')} ${filename}`);
    console.log(`  ${chalk.cyan('Sample Size:')} ${formatBytes(sampleSize)}`);
    console.log(`  ${chalk.cyan('Output:')} ${path.resolve(outputPath)}`);
    console.log('');
    console.log(chalk.gray('💡 Run FastQC: fastqc ' + outputPath));

  } catch (error: any) {
    spinner.fail(chalk.red(`✗ Failed to download sample`));
    handleError(error, serverUrl);
    process.exit(1);
  }
}

/**
 * Parse sample size string (e.g., "100MB", "1GB")
 */
function parseSampleSize(sizeStr: string): number {
  const match = sizeStr.match(/^(\d+)(KB|MB|GB)?$/i);
  if (!match) {
    return 100 * 1024 * 1024; // Default 100MB
  }
  const num = parseInt(match[1]);
  const unit = (match[2] || 'MB').toUpperCase();
  switch (unit) {
    case 'KB': return num * 1024;
    case 'MB': return num * 1024 * 1024;
    case 'GB': return num * 1024 * 1024 * 1024;
    default: return num * 1024 * 1024;
  }
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/**
 * Handle API errors
 */
function handleError(error: any, serverUrl: string): void {
  if (error.response) {
    const status = error.response.status;
    const data = error.response.data;

    if (status === 403) {
      if (data.error === 'Invalid signature') {
        Logger.error('Invalid signature. Try re-running: biofs login');
      } else if (data.error === 'BioNFT consent required') {
        Logger.error('BioNFT consent required. You need access to this biosample.');
        if (data.consent_url) {
          console.log(chalk.gray(`Request access: ${data.consent_url}`));
        }
      } else {
        Logger.error(`Access denied: ${data.error || 'Unknown error'}`);
      }
    } else if (status === 400) {
      Logger.error(`Bad request: ${data.error || 'Missing parameters'}`);
    } else if (status === 404) {
      Logger.error(`Not found: ${data.error || 'Resource not found'}`);
    } else {
      Logger.error(`Server error (${status}): ${data.error || error.message}`);
    }
  } else if (error.code === 'ECONNREFUSED') {
    Logger.error(`Cannot connect to BioFS-Node at ${serverUrl}`);
    console.log(chalk.gray('Is the server running? Check with: curl ' + serverUrl + '/health'));
  } else if (error.code === 'ETIMEDOUT') {
    Logger.error(`Connection timed out to ${serverUrl}`);
  } else {
    Logger.error(`Error: ${error.message}`);
  }
}


