/**
 * biofs register-derived <file> --type <biodata_type> --parent <biocid> [--parent <biocid> ...]
 *
 * CLIENT verb. Files a small derived biofile (a peptide list, a variant table, a report you
 * computed from your own biodata) into YOUR vault and gives it a biocid. The signer is always
 * the owner. biofs-node refuses the upload unless every parent biocid is registered to the
 * signer and none is revoked, so a derived file never exists without its lineage and never
 * becomes more permissive than its source. Bytes are content-addressed in the vault; the
 * biocid is registered in biorouter.biocid_registry and bioroutes.inventory. Limit 5 MB.
 */
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface RegisterDerivedOptions {
  type: string;
  parent: string[];
  caseId?: string;
  category?: string;
  json?: boolean;
}

export async function registerDerivedCommand(file: string, options: RegisterDerivedOptions): Promise<void> {
  try {
    const credentials = await getCredentials();
    if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
    if (!options.parent || options.parent.length === 0) throw new Error('at least one --parent biocid is required');
    const st = fs.statSync(file);
    if (st.size > 5 * 1024 * 1024) throw new Error('file exceeds 5 MB; derived registration is for small files');
    const body = fs.readFileSync(file);
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-Biofs-Wallet': credentials.wallet_address,
      'X-Biofs-Signature': credentials.user_signature,
      'X-Filename': path.basename(file),
      'X-Biodata-Type': options.type,
      'X-Parent-Biocids': options.parent.join(','),
      'X-Data-Category': options.category || 'clinical',
    };
    if (options.caseId) headers['X-Case-Id'] = options.caseId;
    const r = await axios.post(`${BIOFS_NODE_BASE}/register_derived`, body, {
      headers, timeout: 180_000, maxBodyLength: 6 * 1024 * 1024, validateStatus: (s) => s < 600,
    });
    if (r.status >= 400) throw new Error(`${r.status}: ${r.data?.error || 'unknown'}`);
    if (options.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
    console.log(chalk.green('registered'));
    console.log(`  ${chalk.cyan('biocid:')}  ${r.data.biocid}`);
    console.log(`  ${chalk.cyan('sha256:')}  ${r.data.sha256}`);
    console.log(`  ${chalk.cyan('bytes:')}   ${r.data.size}`);
    console.log(`  ${chalk.cyan('consent:')} ${r.data.consent_status}`);
    console.log(`  ${chalk.cyan('parents:')} ${(r.data.parents || []).join(', ')}`);
  } catch (e: any) {
    Logger.error(`register-derived failed: ${e.message}`);
    process.exit(1);
  }
}
