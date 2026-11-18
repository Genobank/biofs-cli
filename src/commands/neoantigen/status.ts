import chalk from 'chalk';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export async function neoantigenStatusCommand(
  jobId: string,
  options: { json?: boolean } = {},
): Promise<void> {
  try {
    const credentials = await getCredentials();
    if (!credentials) {
      console.error(chalk.red('Not authenticated. Run: biofs login'));
      process.exit(1);
    }
    const st = await axios.get(`${BIOFS_NODE_BASE}/cassette_status`, {
      params: {
        cassette_job_id: jobId,
        wallet: credentials.wallet_address,
        signature: credentials.user_signature,
      },
      headers: {
        'X-Biofs-Wallet': credentials.wallet_address,
        'X-Biofs-Signature': credentials.user_signature,
      },
      timeout: 30_000,
      validateStatus: (s) => s < 500,
    });
    if (st.status === 404) {
      console.error(chalk.red('cassette_job_id not found'));
      process.exit(1);
    }
    if (options.json) {
      console.log(JSON.stringify(st.data, null, 2));
      return;
    }
    const r = st.data || {};
    console.log(chalk.bold(`cassette_job_id: ${r.cassette_job_id || jobId}`));
    console.log(`status: ${r.status}`);
    if (r.stage) console.log(`stage: ${r.stage}`);
    if (r.n_epitopes != null) console.log(`n_epitopes: ${r.n_epitopes}`);
    if (r.cassette_biocid) console.log(`cassette_biocid: ${r.cassette_biocid}`);
    if (r.candidates_biocid) console.log(`candidates_biocid: ${r.candidates_biocid}`);
    if (r.error) console.log(chalk.red(`error: ${r.error}`));
    if (r.result?.epitopes) {
      console.log(chalk.bold('\nepitopes:'));
      for (const e of r.result.epitopes) {
        console.log(`  ${e.rank}. ${e.gene} ${e.change} ${e.peptide} HLA=${e.hla || '?'} IC50=${e.ic50_nM ?? '?'} score=${e.consensus_score ?? '?'}`);
      }
    }
    if (r.result?.align_hint) {
      console.log(chalk.green('\nnext:'), r.result.align_hint);
    }
  } catch (err: any) {
    Logger.error(`neoantigen status failed: ${err?.message || err}`);
    process.exit(1);
  }
}
