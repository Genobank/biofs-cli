/**
 * Umount Command - Unmount BioFiles filesystem
 * Supports both NFS mounts and local copies
 */

import chalk from 'chalk';
import * as fs from 'fs-extra';
import ora from 'ora';
import { promisify } from 'util';
import { exec } from 'child_process';
import * as path from 'path';
import { Logger } from '../lib/utils/logger';
import { ErrorReporter } from '../utils/errorReporter';
import { CredentialsManager } from '../lib/auth/credentials';

const execAsync = promisify(exec);

export interface UmountOptions {
  force?: boolean;
  quiet?: boolean;
}

export async function umountCommand(
  mountPoint: string,
  options: UmountOptions = {}
): Promise<void> {
  const spinner = ora('Unmounting...').start();

  try {
    // 1. Check if mount point exists
    if (!await fs.pathExists(mountPoint)) {
      spinner.fail('Mount point not found');
      Logger.error(`Path does not exist: ${mountPoint}`);
      throw new Error(`Mount point not found: ${mountPoint}`);
    }

    // 2. Check if it's an NFS mount
    const isNFS = await checkIfNFSMount(mountPoint);

    if (isNFS) {
      // Unmount NFS filesystem
      spinner.text = 'Unmounting NFS filesystem...';
      await umountNFS(mountPoint, options);
      spinner.succeed('✅ NFS filesystem unmounted');
    } else {
      // Check if it's a biofs copy mount
      const isBioFS = await checkIfBioFSMount(mountPoint);

      if (isBioFS) {
        // Clean up copy mount
        spinner.text = 'Cleaning up mount directory...';
        await cleanupCopyMount(mountPoint, options);
        spinner.succeed('✅ Mount directory cleaned up');
      } else {
        spinner.warn('Not a BioFS mount point');
        console.log('');
        console.log(chalk.yellow(`The path ${mountPoint} is not a BioFS mount.`));
        console.log('');
        console.log(chalk.gray('Expected either:'));
        console.log(chalk.gray('  1. NFS mount (created with --method nfs)'));
        console.log(chalk.gray('  2. Copy mount (contains .bionfs-cache directory)'));
        console.log('');
        throw new Error(`Not a BioFS mount point: ${mountPoint}`);
      }
    }

    // 3. Stop BioNFS server if it was started
    try {
      await execAsync('pkill -f "bionfs server"');
      console.log(chalk.green('✓ BioNFS server stopped'));
    } catch (error) {
      // Server might not be running, that's ok
    }

    console.log('');
    console.log(chalk.green('✅ Unmount complete!'));

  } catch (error: any) {
    spinner.fail('Unmount failed');
    Logger.error(error.message || error);

    // Report error to telemetry
    const credManager = CredentialsManager.getInstance();
    const creds = await credManager.loadCredentials();
    await ErrorReporter.report(
      'umount',
      error,
      creds?.wallet_address,
      {
        mount_point: mountPoint,
        force: options.force,
        is_nfs: await checkIfNFSMount(mountPoint),
        is_biofs: await checkIfBioFSMount(mountPoint)
      }
    );

    // Provide helpful error messages
    if (error.message.includes('device is busy')) {
      console.log('');
      console.log(chalk.red('Device is busy. Close any programs using files in the mount point.'));
      console.log('');
      console.log(chalk.bold('Troubleshooting:'));
      console.log(chalk.gray('  1. Close any terminals in the mount directory'));
      console.log(chalk.gray('  2. Close IGV or other programs viewing genomic files'));
      console.log(chalk.gray('  3. Try force unmount: ') + chalk.cyan(`biofs umount ${mountPoint} --force`));
      console.log('');
    }

    process.exit(1);
  }
}

/**
 * Check if path is an NFS mount
 */
async function checkIfNFSMount(mountPoint: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`mount | grep '${mountPoint}'`);
    return stdout.includes('type nfs');
  } catch (error) {
    return false;
  }
}

/**
 * Check if path is a BioFS copy mount
 */
async function checkIfBioFSMount(mountPoint: string): Promise<boolean> {
  const cacheDir = path.join(mountPoint, '.bionfs-cache');
  const manifestPath = path.join(cacheDir, 'manifest.json');
  return await fs.pathExists(manifestPath);
}

/**
 * Unmount NFS filesystem
 */
async function umountNFS(mountPoint: string, options: UmountOptions): Promise<void> {
  try {
    if (options.force) {
      // Force unmount
      await execAsync(`sudo umount -f ${mountPoint}`);
    } else {
      // Normal unmount
      await execAsync(`sudo umount ${mountPoint}`);
    }
  } catch (error: any) {
    // Try lazy unmount as fallback
    if (error.message.includes('busy')) {
      console.log(chalk.yellow('Device busy, attempting lazy unmount...'));
      await execAsync(`sudo umount -l ${mountPoint}`);
    } else {
      throw error;
    }
  }
}

/**
 * Clean up copy mount directory
 */
async function cleanupCopyMount(mountPoint: string, options: UmountOptions): Promise<void> {
  // Read manifest to show what's being removed
  const manifestPath = path.join(mountPoint, '.bionfs-cache', 'manifest.json');

  if (await fs.pathExists(manifestPath)) {
    const manifest = await fs.readJSON(manifestPath);

    console.log('');
    console.log(chalk.yellow('Files to be removed:'));
    for (const file of manifest.mounted_files || []) {
      console.log(`  ${chalk.gray('-')} ${file}`);
    }
    console.log('');
  }

  if (options.force) {
    // Remove entire directory
    await fs.remove(mountPoint);
  } else {
    // Remove only mounted files and cache
    const files = await fs.readdir(mountPoint);

    for (const file of files) {
      if (file !== '.bionfs-cache') {
        await fs.remove(path.join(mountPoint, file));
      }
    }

    // Remove cache
    await fs.remove(path.join(mountPoint, '.bionfs-cache'));
  }
}
