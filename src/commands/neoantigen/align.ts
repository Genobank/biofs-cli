/**
 * biofs neoantigen align-cassette
 *
 * Align PacBio HiFi reads (biocid) to a fabricated mrna-construct cassette FASTA.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface NeoantigenAlignOptions {
  reads: string;
  cassette: string;
  decoy?: string;
  wait?: boolean;
  json?: boolean;
  quiet?: boolean;
}

export async function neoantigenAlignCommand(
  options: NeoantigenAlignOptions,
): Promise<string | null> {
  const spinner = options.quiet ? null : ora('biofs neoantigen align-cassette').start();
  try {
    const credentials = await getCredentials();
    if (!credentials) {
      spinner?.fail('Not authenticated. Run: biofs login');
      process.exit(1);
    }
    if (!options.reads || !options.cassette) {
      spinner?.fail('--reads and --cassette biocids are required');
      process.exit(1);
    }

    const body = {
      wallet: credentials.wallet_address,
      signature: credentials.user_signature,
      reads_biocid: options.reads,
      cassette_biocid: options.cassette,
      decoy: options.decoy || '',
      mode: 'align',
    };

    const resp = await axios.post(
      `${BIOFS_NODE_BASE}/cassette_align`,
      body,
      {
        timeout: 60_000,
        validateStatus: (s) => s < 500,
        headers: {
          'X-Biofs-Wallet': credentials.wallet_address,
          'X-Biofs-Signature': credentials.user_signature,
        },
      },
    );
    if (resp.status === 404) {
      spinner?.warn('cassette_align endpoint not yet deployed on this node; fabricate first, then redeploy align route');
      if (options.json) console.log(JSON.stringify({ error: 'cassette_align not found', body }, null, 2));
      return null;
    }
    if (resp.status >= 400) {
      spinner?.fail(`align ${resp.status}: ${resp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(resp.data, null, 2));
      return null;
    }
    const jobId = resp.data?.align_job_id || resp.data?.cassette_job_id;
    spinner?.succeed(`align_job_id=${jobId}`);
    if (options.json) console.log(JSON.stringify(resp.data, null, 2));
    else console.log(chalk.gray('  poll with node cassette_align_status when available'));
    return jobId || null;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`align-cassette failed: ${msg}`);
    Logger.error(`align-cassette failed: ${msg}`);
    return null;
  }
}
