/**
 * biofs ancestry share <biosample_serial>   — mint a BioCID-gated report link
 * biofs ancestry shares [--serial <s>]      — list active shares
 * biofs ancestry revoke <share_id>          — kill a link immediately
 *
 * The link is NOT a storage URL. It is an opaque token that biofs-node resolves
 * to a `biocid://`, re-checking consent, expiry and revocation on every view,
 * then rendering the report on demand. Nothing is written to a bucket, so there
 * is no orphan object and no signed GCS/S3 URL to leak. A signed storage URL
 * cannot be revoked and survives consent withdrawal; this can and does not.
 *
 * The token is shown exactly once — biofs-node stores only its SHA-256.
 *
 *   biofs ancestry share DTC-245b4f8e75dd --days 7
 *   biofs ancestry shares --serial DTC-245b4f8e75dd
 *   biofs ancestry revoke shr-1f2e…
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface AncestryShareOptions {
  days?: string;
  json?: boolean;
  quiet?: boolean;
}
export interface AncestrySharesOptions {
  serial?: string;
  json?: boolean;
}
export interface AncestryRevokeOptions {
  json?: boolean;
}

interface ShareResponse {
  share_id: string;
  biocid: string;
  serial: string;
  url: string;
  expires_at: string;
  note?: string;
  error?: string;
}

export async function ancestryShareCommand(serial: string, options: AncestryShareOptions = {}): Promise<void> {
  const spinner = options.quiet || options.json ? null : ora(`minting BioCID-gated share for ${serial} …`).start();
  try {
    const credentials = await getCredentials();
    if (!credentials) { spinner?.fail('Not authenticated. Run: biofs login'); process.exit(1); }

    const days = options.days ? Number(options.days) : 7;
    if (!Number.isFinite(days) || days <= 0 || days > 30) {
      spinner?.fail('--days must be between 0 and 30');
      process.exit(1);
    }

    const resp = await axios.post<ShareResponse>(`${BIOFS_NODE_BASE}/ancestry_share`, {
      biosample_serial: serial,
      wallet: credentials.wallet_address,
      signature: credentials.user_signature,
      days,
    }, { timeout: 30_000, validateStatus: (s) => s < 500 });

    if (resp.status >= 400) {
      spinner?.fail(`share ${resp.status}: ${resp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(resp.data, null, 2));
      process.exit(1);
    }
    const r = resp.data;
    spinner?.succeed(`share ${r.share_id}`);

    if (options.json) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log();
    console.log(chalk.gray('  biocid : ') + chalk.cyan(r.biocid));
    console.log(chalk.gray('  expires: ') + r.expires_at);
    console.log(chalk.gray('  revoke : ') + `biofs ancestry revoke ${r.share_id}`);
    console.log();
    console.log(chalk.bold('  Share this link:'));
    console.log('  ' + chalk.green(r.url));
    console.log();
    console.log(chalk.yellow('  The token is shown once. biofs-node stores only its SHA-256.'));
    console.log(chalk.gray('  Consent, expiry and revocation are re-checked on every view.'));
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`ancestry share failed: ${msg}`);
    Logger.error(`ancestry share failed: ${msg}`);
    process.exit(1);
  }
}

export async function ancestrySharesCommand(options: AncestrySharesOptions = {}): Promise<void> {
  try {
    const credentials = await getCredentials();
    if (!credentials) { Logger.error('Not authenticated. Run: biofs login'); process.exit(1); }
    // POST with the signature in the BODY — never a query string. The signature
    // is the whole-account bearer credential; nginx/Cloudflare log query strings.
    const reqBody: Record<string, unknown> = {
      wallet: credentials.wallet_address,
      signature: credentials.user_signature,
    };
    if (options.serial) reqBody.biosample_serial = options.serial;

    const resp = await axios.post(`${BIOFS_NODE_BASE}/ancestry_shares`, reqBody, { timeout: 30_000, validateStatus: (s) => s < 500 });
    if (resp.status >= 400) { Logger.error(`shares ${resp.status}: ${resp.data?.error}`); process.exit(1); }

    const rows = resp.data?.shares || [];
    if (options.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (!rows.length) { console.log('no shares'); return; }
    console.log();
    for (const r of rows) {
      const state = r.revoked ? chalk.red('revoked') : r.expired ? chalk.yellow('expired') : chalk.green('active');
      console.log(`  ${chalk.bold(r.share_id)}  ${state}`);
      console.log(`    ${chalk.gray('biocid ')} ${r.biocid}`);
      console.log(`    ${chalk.gray('serial ')} ${r.serial}   ${chalk.gray('views')} ${r.views ?? 0}   ${chalk.gray('expires')} ${r.expires_at}`);
    }
    console.log();
  } catch (err: any) {
    Logger.error(`ancestry shares failed: ${err?.response?.data?.error || err?.message}`);
    process.exit(1);
  }
}

export async function ancestryRevokeCommand(shareId: string, options: AncestryRevokeOptions = {}): Promise<void> {
  const spinner = options.json ? null : ora(`revoking ${shareId} …`).start();
  try {
    const credentials = await getCredentials();
    if (!credentials) { spinner?.fail('Not authenticated. Run: biofs login'); process.exit(1); }
    const resp = await axios.post(`${BIOFS_NODE_BASE}/ancestry_revoke`, {
      share_id: shareId,
      wallet: credentials.wallet_address,
      signature: credentials.user_signature,
    }, { timeout: 30_000, validateStatus: (s) => s < 500 });

    if (resp.status >= 400) {
      spinner?.fail(`revoke ${resp.status}: ${resp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(resp.data, null, 2));
      process.exit(1);
    }
    spinner?.succeed(`revoked ${shareId} — the link is dead immediately`);
    if (options.json) console.log(JSON.stringify(resp.data, null, 2));
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`ancestry revoke failed: ${msg}`);
    process.exit(1);
  }
}
