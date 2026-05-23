/**
 * `biofs upload-fastq <file>` — thin wrapper around the Python `genobank-upload`
 * CLI. Reuses the battle-tested resumable upload + resume buffer instead of
 * duplicating that logic in TypeScript.
 *
 * Prerequisite:
 *   pip install genobank-uploader
 *
 * Env:
 *   GENOBANK_LAB_SIGNING_KEY      required — secp256k1 hex lab wallet key
 *   GENOBANK_LABORATORY_ID        required — numeric lab id
 *   GENOBANK_API_BASE             optional — default https://genobank.app
 */
import { spawn } from 'child_process';
import chalk from 'chalk';

export interface UploadFastqOptions {
  biosample: string;
  kind?: string;
  labId?: number;
  apiBase?: string;
  quiet?: boolean;
  json?: boolean;
}

export async function uploadFastqCommand(source: string, opts: UploadFastqOptions): Promise<void> {
  const args = [
    source,
    '--biosample', opts.biosample,
    '--kind', (opts.kind || 'FASTQ_R1').toUpperCase(),
  ];
  if (opts.labId) args.push('--lab-id', String(opts.labId));
  if (opts.apiBase) args.push('--api-base', opts.apiBase);
  if (opts.quiet) args.push('--quiet');
  if (opts.json) args.push('--json');

  const proc = spawn('genobank-upload', args, {
    stdio: 'inherit',
    env: process.env,
  });
  await new Promise<void>((resolve, reject) => {
    proc.on('error', (err: any) => {
      if (err.code === 'ENOENT') {
        console.error(chalk.red('\n`genobank-upload` not found on PATH.'));
        console.error(chalk.gray('  Install the companion Python library:'));
        console.error(chalk.cyan('    pip install genobank-uploader\n'));
        reject(new Error('genobank-uploader not installed'));
      } else {
        reject(err);
      }
    });
    proc.on('close', (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`genobank-upload exited with code ${code}`));
    });
  });
}
