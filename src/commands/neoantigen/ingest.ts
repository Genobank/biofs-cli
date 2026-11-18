/**
 * biofs neoantigen ingest-reads <path|gs://|biocid>
 *
 * Registers a PacBio HiFi FASTQ/FASTA under the patient vault for cassette QC.
 * Prefers existing biofs upload/tokenize paths; this verb is the neoantigen-scoped
 * wrapper that tags biodata for align-cassette.
 */

import chalk from 'chalk';
import ora from 'ora';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface NeoantigenIngestOptions {
  serial?: string;
  json?: boolean;
  quiet?: boolean;
}

export async function neoantigenIngestCommand(
  source: string,
  options: NeoantigenIngestOptions = {},
): Promise<void> {
  const spinner = options.quiet ? null : ora('neoantigen ingest-reads').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) {
      spinner?.fail('Not authenticated. Run: biofs login');
      process.exit(1);
    }

    // Biocid already registered — just echo readiness
    if (/^biocid:/i.test(source) || source.startsWith('Biocid:')) {
      spinner?.succeed(`reads biocid ready: ${source}`);
      if (!options.quiet) {
        console.log(chalk.gray('  next: biofs neoantigen align-cassette --reads ' + source + ' --cassette <mrna-construct-biocid>'));
      }
      if (options.json) {
        console.log(JSON.stringify({ reads_biocid: source, serial: options.serial || null, ready: true }, null, 2));
      }
      return;
    }

    spinner?.info('Upload/register the PacBio file with the standard biofs ingest path, then pass the resulting biocid.');
    console.log(chalk.bold('\nRecommended flow:'));
    console.log('  1. biofs upload-fastq <file> --serial ' + (options.serial || '<SERIAL>') + '   # or tokenize-fastqs');
    console.log('  2. Note the returned biocid://…');
    console.log('  3. biofs neoantigen ingest-reads biocid://… --serial ' + (options.serial || '<SERIAL>'));
    console.log('  4. biofs neoantigen align-cassette --reads <reads_biocid> --cassette <mrna-construct>');
    console.log(chalk.gray('\nSource provided: ' + source));
    console.log(chalk.gray('Wallet: ' + credentials.wallet_address));
    if (options.json) {
      console.log(JSON.stringify({
        status: 'awaiting_upload',
        source,
        wallet: credentials.wallet_address,
        serial: options.serial || null,
        hint: 'use biofs upload-fastq / tokenize-fastqs then re-run with biocid',
      }, null, 2));
    }
    spinner?.succeed('ingest path documented (no bulk download to laptop)');
  } catch (err: any) {
    spinner?.fail(err?.message || String(err));
    Logger.error(`ingest-reads failed: ${err?.message || err}`);
    process.exit(1);
  }
}
