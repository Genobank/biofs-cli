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
  method?: 'copy' | 'nfs' | 'fuse'; // Mount method
  biocid?: string;          // Optional: specific BioCID to mount
  port?: number;            // NFS server port
  consentTtl?: number;      // seconds before the driver re-verifies consent
  apiUrl?: string;          // gateway base URL
  allowOther?: boolean;     // expose the mount to other local users
  foreground?: boolean;     // run in the foreground (debugging)
}

/**
 * `biofs mount`
 *
 *   biofs mount <biosample> <mount_point>   consent-gated FUSE mount (default)
 *   biofs mount <directory>                 legacy: copy granted files locally
 *
 * The two-argument form is the real one: it mounts a biosample as a read-only
 * filesystem where EVERY read is re-authorized server-side against the BioNFT
 * consent grant, so a patient's revocation reaches an already-mounted
 * filesystem within one consent-TTL window.
 */
export async function mountCommand(
  target: string,
  mountPoint?: string,
  options: MountOptions = {}
): Promise<void> {
  // Two positionals => the caller named a biosample and where to mount it.
  if (mountPoint) {
    if (options.method === 'nfs') return mountViaNFS(mountPoint, options);
    return mountViaFuse(target, mountPoint, options);
  }
  // One positional => the legacy copy-into-a-directory behaviour.
  if (options.method === 'nfs') return mountViaNFS(target, options);
  return mountViaCopy(target, options);
}

/**
 * Mount a biosample as a consent-gated read-only filesystem (biofs-fuse).
 *
 * Replaces the `bionfs` path, which gated on Story Protocol licences rather
 * than the Sequentia BioNFT consent the rest of the protocol enforces, and
 * which required a Go binary that is not distributed.
 */
async function mountViaFuse(
  biosample: string,
  mountPoint: string,
  options: MountOptions
): Promise<void> {
  const spinner = ora(`Verifying consent for ${biosample}...`).start();

  try {
    const credManager = CredentialsManager.getInstance();
    const creds = await credManager.loadCredentials();
    if (!creds) {
      spinner.fail('Not authenticated');
      throw new Error('Not authenticated. Please run: biofs login');
    }
    const { wallet_address: wallet, user_signature: signature } = creds;

    // Locate the driver.
    const driver = process.env.BIOFS_FUSE_BIN || 'biofs-fuse';
    try {
      await execAsync(`which ${driver}`);
    } catch {
      spinner.fail('biofs-fuse driver not found');
      console.log('');
      console.log(chalk.yellow('The BioFS FUSE driver is not installed.'));
      console.log('');
      console.log(chalk.bold('Install:'));
      console.log(chalk.gray('  sudo apt-get install -y fuse3 libfuse3-dev pkg-config'));
      console.log(chalk.gray('  cargo build --release   # in the biofs-fuse repo'));
      console.log(chalk.gray('  sudo install -m0755 target/release/biofs-fuse /usr/local/bin/'));
      console.log('');
      console.log(chalk.gray('Or set BIOFS_FUSE_BIN to its path.'));
      throw new Error('biofs-fuse not installed');
    }

    // A driver that died leaves the kernel mount in place but disconnected.
    // Every syscall on that path then fails with ENOTCONN, which surfaces as
    // ECONNREFUSED from Node and makes even mkdir/rm fail -- confusing, and
    // it blocks a retry. Clear it before doing anything else.
    try {
      const { stdout } = await execAsync(`stat -c %i ${JSON.stringify(mountPoint)} 2>&1 || true`);
      if (/Transport endpoint is not connected|Connection refused|ENOTCONN/i.test(stdout)) {
        await execAsync(`fusermount3 -uz ${JSON.stringify(mountPoint)} 2>/dev/null || true`);
      }
    } catch {
      await execAsync(`fusermount3 -uz ${JSON.stringify(mountPoint)} 2>/dev/null || true`).catch(() => {});
    }

    await fs.ensureDir(mountPoint);
    const existing = await fs.readdir(mountPoint);
    if (existing.length > 0) {
      spinner.fail(`Mount point is not empty: ${mountPoint}`);
      throw new Error(`Refusing to mount over a non-empty directory: ${mountPoint}`);
    }

    const apiUrl = options.apiUrl || process.env.GENOBANK_API_BASE || 'https://genobank.app';
    const ttl = String(options.consentTtl ?? 30);

    const args = [
      biosample,
      mountPoint,
      '--wallet', wallet,
      '--api-url', apiUrl,
      '--consent-ttl-secs', ttl,
    ];
    if (options.allowOther) args.push('--allow-other');
    if (options.foreground) args.push('--foreground');

    spinner.text = `Mounting ${biosample} at ${mountPoint}...`;

    // SECURITY: the signature is a 30-day bearer credential. Passing it in
    // argv (as the old NFS path did) publishes it to every local user via
    // `ps` for the whole life of a long-running mount. The driver reads
    // BIOFS_SIGNATURE from the environment, which is not world-readable.
    const child = spawn(driver, args, {
      detached: !options.foreground,
      stdio: options.foreground ? 'inherit' : 'ignore',
      env: { ...process.env, BIOFS_SIGNATURE: signature },
    });

    if (options.foreground) {
      spinner.stop();
      await new Promise<void>((resolve, reject) => {
        child.on('exit', (code) => (code === 0 ? resolve() : reject(
          new Error(`biofs-fuse exited with code ${code}`))));
        child.on('error', reject);
      });
      return;
    }

    child.unref();
    // Give the driver time to verify consent and hand the mount to the kernel.
    await new Promise((r) => setTimeout(r, 3000));

    const mounted = await isMounted(mountPoint);
    if (!mounted) {
      spinner.fail('Mount did not come up');
      console.log('');
      console.log(chalk.gray('The driver exited before the filesystem appeared. Common causes:'));
      console.log(chalk.gray('  • no active BioNFT consent for this wallet on this biosample'));
      console.log(chalk.gray('  • the biosample serial does not resolve to a file'));
      console.log(chalk.gray(`  • run with --foreground to see the driver's output`));
      throw new Error('mount failed');
    }

    spinner.succeed(`Mounted ${biosample} at ${mountPoint}`);
    console.log('');
    try {
      for (const f of await fs.readdir(mountPoint)) {
        const marker = f.startsWith('.') ? chalk.gray('·') : chalk.green('✓');
        console.log(`  ${marker} ${f}`);
      }
    } catch { /* listing is best-effort */ }
    console.log('');
    console.log(chalk.gray(`  Consent is re-checked every ${ttl}s and on every open().`));
    console.log(chalk.gray(`  If the owner revokes, reads fail with Permission denied.`));
    console.log(chalk.gray(`  Unmount: biofs umount ${mountPoint}`));
  } catch (error: any) {
    if (spinner.isSpinning) spinner.fail('Mount failed');
    try {
      const creds = await CredentialsManager.getInstance().loadCredentials();
      await ErrorReporter.report('mount', error, creds?.wallet_address, {
        method: 'fuse',
        biosample,
        mount_point: mountPoint,
      });
    } catch { /* telemetry must never mask the real error */ }
    throw error;
  }
}

/** True if `mountPoint` currently carries a mounted filesystem. */
async function isMounted(mountPoint: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`mount`);
    const resolved = path.resolve(mountPoint);
    return stdout.split('\n').some((l) => l.includes(` ${resolved} `));
  } catch {
    return false;
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


