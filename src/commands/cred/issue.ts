/**
 * `biofs cred issue` — mint a scoped write-only credential for one upload slot.
 *
 * Primary caller: researchers / labs running their own uploader manually.
 * Production labs should prefer the Python `genobank-upload` CLI (pip install
 * genobank-uploader) which drops into cron-style scripts; this TS command is
 * the interactive companion for sanity-checking a delegation or issuing a
 * credential before a manual PUT.
 *
 * Requires:
 *   BIOFS_LAB_PRIVATE_KEY      secp256k1 hex of the lab wallet (stored in env)
 *   GENOBANK_LABORATORY_ID     numeric lab id registered in GenoBank
 */
import chalk from 'chalk';
import ora from 'ora';
import { createHash } from 'crypto';
import fs from 'fs';
import { apiPost, signLabBody, signerFromEnv } from './lib';
import { Logger } from '../../lib/utils/logger';

export interface CredIssueOptions {
  biosample: string;
  kind: string;       // FASTQ | FASTQ_R1 | FASTQ_R2 | BAM | VCF | GVCF
  labId?: number;
  size?: number;
  sha256?: string;
  filename?: string;
  sourceFile?: string;   // if provided, compute size + sha256 from disk
  json?: boolean;
}

async function sha256OfFile(path: string): Promise<{ sha: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hasher = createHash('sha256');
    let size = 0;
    const stream = fs.createReadStream(path);
    stream.on('data', (chunk: any) => { hasher.update(chunk); size += chunk.length; });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha: hasher.digest('hex'), size }));
  });
}

export async function credIssueCommand(opts: CredIssueOptions): Promise<void> {
  const labId = opts.labId ?? parseInt(process.env.GENOBANK_LABORATORY_ID || '0', 10);
  if (!labId) {
    throw new Error('--lab-id required (or set GENOBANK_LABORATORY_ID env var)');
  }

  let size = opts.size;
  let sha = opts.sha256;
  let filename = opts.filename;

  if (opts.sourceFile) {
    const spinner = ora(`Hashing ${opts.sourceFile}...`).start();
    const { sha: computedSha, size: computedSize } = await sha256OfFile(opts.sourceFile);
    spinner.succeed(`sha256 ${computedSha.substring(0, 16)}... (${computedSize} bytes)`);
    sha = computedSha;
    size = computedSize;
    filename = filename || opts.sourceFile.split('/').pop();
  }
  if (!size || !sha || !filename) {
    throw new Error('Provide --source-file or all of: --size, --sha256, --filename');
  }

  const signer = signerFromEnv('BIOFS_LAB_PRIVATE_KEY');
  Logger.info(`Lab wallet: ${signer.address}`);

  const body = await signLabBody(
    {
      biosample_serial: String(opts.biosample),
      laboratory_id: labId,
      file_kind: opts.kind.toUpperCase(),
      filename,
      estimated_size_bytes: size,
      sha256_claimed: sha.toLowerCase(),
    },
    signer,
  );

  const spinner = ora('Requesting write credential...').start();
  try {
    const data = await apiPost('/api_biovault/issue_write_credential', body);
    spinner.succeed(chalk.green('✓ credential issued'));

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const line = (k: string, v: any) => console.log(chalk.gray(`  ${k.padEnd(32)}`), v);
    console.log('\n' + chalk.cyan('═'.repeat(66)));
    console.log(chalk.bold('  Scoped Write Credential'));
    console.log(chalk.cyan('═'.repeat(66)));
    line('cred_id', chalk.yellow(data.cred_id));
    line('object_path', data.object_path);
    line('initiate_url', data.initiate_signed_url.substring(0, 80) + '...');
    line('session expires', data.gcs_session_expires_at);
    line('recommended chunk size', `${(data.recommended_chunk_size_bytes / 1024 / 1024).toFixed(0)} MiB`);
    line('delegation remaining (bytes)', data.delegation_remaining_bytes?.toLocaleString() ?? 'n/a');
    console.log(chalk.cyan('═'.repeat(66)));
    console.log(
      '\n' + chalk.dim('To upload directly (skipping the resumable dance):')
        + '\n' + chalk.dim(`  curl -X POST -H "X-Goog-Resumable: start" -H "Content-Type: application/gzip" "${data.initiate_signed_url.substring(0, 60)}..."`)
        + '\n' + chalk.dim('Prefer `genobank-upload` (pip install genobank-uploader) for real files — it handles resume.'),
    );
  } catch (err: any) {
    spinner.fail(chalk.red(`Failed: ${err.message}`));
    if (err.payload) console.error(chalk.gray(JSON.stringify(err.payload, null, 2)));
    throw err;
  }
}
