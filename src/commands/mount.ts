/**
 * Mount Command - Mount all granted BioFiles to local directory
 * Supports two methods:
 * - 'copy': Downloads files (default, GDPR compliant)
 * - 'nfs': Mounts via BioNFS server (true filesystem mount)
 */

import { FileDownloader } from '../lib/biofiles/downloader';
import { ConsentManager } from '../lib/consent/consent-manager';
import { ConsentPrompt } from '../lib/consent/consent-prompt';
import { CredentialsManager } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';
import { GenoBankAPIClient } from '../lib/api/client';
import { ErrorReporter } from '../utils/errorReporter';
import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs-extra';
import ora from 'ora';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

export interface MountOptions {
  readOnly?: boolean;
  quiet?: boolean;
  skipConsent?: boolean;
  method?: 'copy' | 'nfs'; // Mount method
  biocid?: string;          // Optional: specific BioCID to mount
  port?: number;            // NFS server port
}

export async function mountCommand(
  mountPoint: string,
  options: MountOptions = {}
): Promise<void> {
  const method = options.method || 'copy';

  if (method === 'nfs') {
    return mountViaNFS(mountPoint, options);
  } else {
    return mountViaCopy(mountPoint, options);
  }
}

/**
 * Mount via BioNFS server (true filesystem mount)
 */
async function mountViaNFS(
  mountPoint: string,
  options: MountOptions
): Promise<void> {
  const spinner = ora('Starting BioNFS server...').start();

  try {
    // 1. Load authentication
    const credManager = CredentialsManager.getInstance();
    const creds = await credManager.loadCredentials();

    if (!creds) {
      spinner.fail('Not authenticated');
      Logger.error('Please run: biofs login');
      throw new Error('Not authenticated. Please run: biofs login');
    }

    const { wallet_address: wallet, user_signature: signature } = creds;

    // 2. Check if BioNFS is installed
    try {
      await execAsync('which bionfs');
    } catch (error) {
      spinner.fail('BioNFS not installed');
      console.log('');
      console.log(chalk.yellow('BioNFS server is not installed.'));
      console.log('');
      console.log(chalk.bold('Installation:'));
      console.log(chalk.gray('  cd /home/ubuntu/bionfs'));
      console.log(chalk.gray('  make build'));
      console.log(chalk.gray('  sudo make install'));
      console.log('');
      throw new Error('BioNFS not installed. See installation instructions above.');
    }

    // 3. Create mount directory
    await fs.ensureDir(mountPoint);

    // 4. Start BioNFS server
    const port = options.port || 2049;
    const bionfsArgs = [
      'server',
      '--port', String(port),
      '--signature', signature,
      '--cache-dir', '/tmp/bionfs-cache'
    ];

    // Add BioCID if specified
    if (options.biocid) {
      bionfsArgs.push('--biocid', options.biocid);
      spinner.text = `Starting BioNFS server for ${options.biocid}...`;
    } else {
      spinner.text = 'Starting BioNFS server for all granted files...';
    }

    // Start server in background
    const bionfsProcess = spawn('bionfs', bionfsArgs, {
      detached: true,
      stdio: 'ignore'
    });
    bionfsProcess.unref();

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    spinner.succeed('BioNFS server started');

    // 5. Mount NFS filesystem
    spinner.start(`Mounting NFS to ${mountPoint}...`);

    try {
      await execAsync(`sudo mount -t nfs localhost:/ ${mountPoint}`);
      spinner.succeed(`✅ Mounted to ${mountPoint}`);
    } catch (error: any) {
      spinner.fail('Mount failed');
      console.log('');
      console.log(chalk.red('Failed to mount NFS filesystem.'));
      console.log('');
      console.log(chalk.bold('Possible issues:'));
      console.log(chalk.gray('  1. NFS client not installed'));
      console.log(chalk.gray('     Fix: sudo apt-get install nfs-common'));
      console.log('');
      console.log(chalk.gray('  2. Permission denied'));
      console.log(chalk.gray('     Fix: Run with sudo or add to /etc/fstab'));
      console.log('');
      console.log(chalk.gray('  3. Port 2049 already in use'));
      console.log(chalk.gray('     Fix: Use --port option'));
      console.log('');
      throw error;
    }

    // 6. Show usage info
    console.log('');
    console.log(chalk.bold('🎉 Filesystem mounted successfully!'));
    console.log('');
    console.log(chalk.bold('Your Files:'));
    try {
      const files = await fs.readdir(mountPoint);
      for (const file of files) {
        if (!file.startsWith('.')) {
          console.log(`  ${chalk.green('✓')} ${file}`);
        }
      }

      if (files.length > 0) {
        console.log('');
        console.log(chalk.bold('Usage Examples:'));
        const exampleFile = files.find(f => !f.startsWith('.'));
        if (exampleFile) {
          console.log(chalk.gray(`  # View VCF file`));
          console.log(`  bcftools view ${mountPoint}/${exampleFile} | head -20`);
          console.log('');
          console.log(chalk.gray(`  # Open in IGV`));
          console.log(`  igv ${mountPoint}/${exampleFile}`);
          console.log('');
          console.log(chalk.gray(`  # Get variant statistics`));
          console.log(`  bcftools stats ${mountPoint}/${exampleFile}`);
        }
      }
    } catch (error) {
      console.log(chalk.gray('  (Files will appear when accessed)'));
    }

    console.log('');
    console.log(chalk.yellow('💡 To unmount: ') + chalk.cyan(`biofs umount ${mountPoint}`));
    console.log(chalk.yellow('💡 Server logs: ') + chalk.cyan('journalctl -f | grep bionfs'));

  } catch (error: any) {
    spinner.fail('Mount failed');
    Logger.error(error.message || error);

    // Report error to telemetry
    const credManager = CredentialsManager.getInstance();
    const creds = await credManager.loadCredentials();
    await ErrorReporter.report(
      'mount --method nfs',
      error,
      creds?.wallet_address,
      {
        mount_point: mountPoint,
        method: 'nfs',
        port: options.port,
        biocid: options.biocid
      }
    );

    process.exit(1);
  }
}

/**
 * Mount via file copy (original implementation with GDPR consent)
 */
async function mountViaCopy(
  mountPoint: string,
  options: MountOptions
): Promise<void> {
  const spinner = ora('Preparing mount...').start();
  let grantedFiles: any[] = []; // Declare at function level for error reporting

  try {
    // 1. Load authentication
    const credManager = CredentialsManager.getInstance();
    const creds = await credManager.loadCredentials();

    if (!creds) {
      spinner.fail('Not authenticated');
      Logger.error('Please run: biofs login');
      throw new Error('Not authenticated. Please run: biofs login');
    }

    const { wallet_address: wallet, user_signature: signature } = creds;

    // 2. Get all granted files
    spinner.text = 'Discovering granted files...';
    const api = GenoBankAPIClient.getInstance();
    grantedFiles = await api.getMyGrantedBioIPs();

    if (grantedFiles.length === 0) {
      spinner.warn('No granted files found');
      console.log('');
      console.log(chalk.yellow('💡 You don\'t have access to any BioIP files yet.'));
      console.log(chalk.gray('   Request access with: ') + chalk.cyan('biofs access request <ip_id>'));
      process.exit(0);
    }

    spinner.stop();
    console.log(chalk.green(`✓ Found ${grantedFiles.length} granted file(s)`));
    console.log('');

    // 3. Check consent for each file
    const consentManager = new ConsentManager();
    const consentPrompt = new ConsentPrompt();
    const filesNeedingConsent: any[] = [];

    for (const file of grantedFiles) {
      const hasConsent = await consentManager.hasConsent(
        wallet,
        file.ip_id,
        'mount',
        signature
      );

      if (!hasConsent && !options.skipConsent) {
        filesNeedingConsent.push(file);
      }
    }

    // 4. Show consent for files that need it
    if (filesNeedingConsent.length > 0) {
      console.log(chalk.yellow(`⚠️  ${filesNeedingConsent.length} file(s) require consent before mounting`));
      console.log('');

      for (let i = 0; i < filesNeedingConsent.length; i++) {
        const file = filesNeedingConsent[i];

        console.log(chalk.bold(`\n📄 File ${i + 1} of ${filesNeedingConsent.length}:`));

        const fileInfo = {
          filename: file.filename,
          owner: file.owner,
          ip_id: file.ip_id,
          license_type: file.license_type,
          license_token_id: file.license_token_id,
          wallet: wallet
        };

        const agreed = await consentPrompt.showConsentNotice(fileInfo, 'mount');

        if (!agreed) {
          console.log(chalk.red(`❌ Consent declined for ${file.filename}. Skipping.`));
          continue;
        }

        // Record consent
        const ipAddress = await consentPrompt.getPublicIP();
        await consentManager.recordConsent(
          wallet,
          fileInfo,
          'mount',
          ipAddress,
          signature
        );
      }
    }

    // 5. Create mount directory
    await fs.ensureDir(mountPoint);

    // 6. Mount (download) all consented files
    spinner.start('Mounting files...');
    const downloader = new FileDownloader();
    let mountedCount = 0;
    const mountedFiles: string[] = [];

    for (const file of grantedFiles) {
      // Check consent again (some may have been declined)
      const hasConsent = await consentManager.hasConsent(
        wallet,
        file.ip_id,
        'mount',
        signature
      );

      if (!hasConsent && !options.skipConsent) {
        continue; // Skip files without consent
      }

      const localPath = path.join(mountPoint, file.filename);
      spinner.text = `Mounting ${file.filename}...`;

      try {
        // Use BioCID format for download
        const biocid = `biocid://${file.owner}/bioip/${file.ip_id}`;
        await downloader.download(biocid, localPath, false); // No progress bar
        mountedCount++;
        mountedFiles.push(file.filename);
      } catch (error: any) {
        console.log(chalk.yellow(`⚠️  Failed to mount ${file.filename}: ${error.message}`));
      }
    }

    spinner.succeed(`✅ Mounted ${mountedCount} file(s) to ${mountPoint}`);

    // 7. Create .bionfs-cache metadata
    const cacheDir = path.join(mountPoint, '.bionfs-cache');
    await fs.ensureDir(cacheDir);
    await fs.writeJSON(
      path.join(cacheDir, 'manifest.json'),
      {
        files: grantedFiles,
        mounted_files: mountedFiles,
        mounted_at: new Date().toISOString(),
        wallet: wallet
      },
      { spaces: 2 }
    );

    // 8. Show usage info
    console.log('');
    console.log(chalk.bold('Your Files:'));
    for (const filename of mountedFiles) {
      console.log(`  ${chalk.green('✓')} ${filename}`);
    }

    if (mountedFiles.length > 0) {
      console.log('');
      console.log(chalk.bold('Usage Examples:'));
      const exampleFile = mountedFiles[0];
      console.log(chalk.gray(`  # View VCF file`));
      console.log(`  bcftools view ${mountPoint}/${exampleFile} | head -20`);
      console.log('');
      console.log(chalk.gray(`  # Open in IGV`));
      console.log(`  IGV ${mountPoint}/${exampleFile}`);
      console.log('');
      console.log(chalk.gray(`  # Get variant statistics`));
      console.log(`  bcftools stats ${mountPoint}/${exampleFile}`);
    }

    console.log('');
    console.log(chalk.yellow('💡 To revoke access to all files: ') + chalk.cyan('biofs access revoke --all'));

  } catch (error: any) {
    spinner.fail('Mount failed');
    Logger.error(error.message || error);

    // Report error to telemetry
    const credManager = CredentialsManager.getInstance();
    const creds = await credManager.loadCredentials();
    await ErrorReporter.report(
      'mount --method copy',
      error,
      creds?.wallet_address,
      {
        mount_point: mountPoint,
        method: 'copy',
        biocid: options.biocid,
        files_count: grantedFiles.length
      }
    );

    process.exit(1);
  }
}

