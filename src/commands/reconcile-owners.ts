/**
 * biofs reconcile-owners
 *
 * Gives every inventory row that has no owner (or a custodial placeholder) its true
 * owner, as resolved by the server: the vault path first, then the registry, a sibling
 * row of the same sample serial, or a matching fingerprint. It never invents an owner:
 * a row that resolves to nothing is left untouched and listed. Admin only. Dry run by
 * default; --apply writes.
 *
 * Thin client of POST /api_bioroutes/reconcile_owners.
 */

import chalk from 'chalk';
import axios from 'axios';
import { CredentialsManager } from '../lib/auth/credentials';
import { CONFIG } from '../lib/config/constants';
import { Logger } from '../lib/utils/logger';

export interface ReconcileOwnersOptions {
  owner?: string;
  prefix?: string;
  limit?: string;
  apply?: boolean;
  json?: boolean;
}

export function buildReconcileBody(
  wallet: string,
  signature: string,
  options: ReconcileOwnersOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = { wallet, signature, dry_run: !options.apply };
  if (options.owner) {
    const o = options.owner.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(o)) throw new Error('--owner must be a 0x wallet address (42 characters)');
    body.owner = o;
  }
  if (options.prefix) body.prefix = options.prefix.trim();
  if (options.limit !== undefined) {
    const n = parseInt(options.limit, 10);
    if (!Number.isFinite(n) || n < 1 || n > 5000) throw new Error('--limit must be an integer from 1 to 5000');
    body.limit = n;
  }
  return body;
}

export async function reconcileOwnersCommand(options: ReconcileOwnersOptions): Promise<void> {
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }
  const body = buildReconcileBody(creds.wallet_address, creds.user_signature as string, options);

  const url = `${CONFIG.API_BASE_URL}/api_bioroutes/reconcile_owners`;
  let resp;
  try {
    resp = await axios.post(url, body, {
      timeout: 5 * 60_000,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: (s: number) => s < 500,
    });
  } catch (err: any) {
    Logger.error(`Cannot reach ${url}: ${err?.message || err}`);
    process.exit(1);
  }
  if (resp.status === 403) {
    Logger.error(`reconcile-owners denied: ${resp.data?.error || 'unauthorized'} (node operator only: BIOFS_PROFILE=operator)`);
    process.exit(1);
  }
  if (resp.status >= 400) {
    Logger.error(`reconcile-owners failed (HTTP ${resp.status}): ${resp.data?.error || 'unknown'}`);
    process.exit(1);
  }

  const d = resp.data;
  if (options.json) {
    console.log(JSON.stringify(d, null, 2));
    return;
  }
  console.log(chalk.bold('Reconcile owners'));
  console.log(`  Mode:                ${d.dry_run ? chalk.yellow('DRY-RUN (no writes)') : chalk.green('APPLIED')}`);
  console.log(`  Rows examined:       ${d.examined}`);
  console.log(`  Resolved:            ${d.resolved_total}  (${JSON.stringify(d.resolved_by)})`);
  console.log(`  Resolved to another owner (not changed here): ${d.resolved_to_other_owner}`);
  console.log(`  Unresolved (left untouched): ${d.unresolved_count}`);
  for (const ex of (d.examples || []).slice(0, 25)) console.log(`    ${ex.object_name} -> ${ex.to_owner} [${ex.method}]`);
  if (d.dry_run) console.log(chalk.gray('  Re-run with --apply to write.'));
}
