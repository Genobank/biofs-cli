/**
 * biofs cancermap regen [wallet]
 *
 * Thin client over biofs-node POST /agent/cancermap. Use only when the
 * grounded generator should replace the published map. Do not fire this
 * against TN25-336147 until interpret prefers arcasHLA over kallisto.
 */
import axios from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface CancermapRegenOptions {
  serial?: string;
  caseId?: string;
  json?: boolean;
}

export async function cancermapRegenCommand(
  walletArg?: string,
  options: CancermapRegenOptions = {},
): Promise<void> {
  const credentials = await getCredentials();
  if (!credentials) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }
  const wallet = walletArg || credentials.wallet_address;
  const body = {
    wallet,
    customer_biowallet: wallet,
    signature: credentials.user_signature,
    biosample_serial: options.serial,
    case_id: options.caseId,
  };
  const r = await axios.post(`${BIOFS_NODE_BASE}/cancermap`, body, {
    timeout: 60_000,
    validateStatus: (s) => s < 500,
  });
  if (r.status >= 400) {
    Logger.error(`cancermap ${r.status}: ${r.data?.error || 'unknown'}`);
    process.exit(1);
  }
  if (options.json) console.log(JSON.stringify(r.data, null, 2));
  else console.log(chalk.green(`cancermap_job_id=${r.data.cancermap_job_id} status=${r.data.status}`));
}
