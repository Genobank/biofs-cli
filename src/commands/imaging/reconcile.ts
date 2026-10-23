/**
 * biofs imaging reconcile
 *
 * Bring the registry rows of the signer's already-vaulted DICOM studies into
 * order. Studies pulled before biofs-node wrote both registries (June 2026) have
 * no bioroutes.inventory row, and some biorouter.biocid_registry rows are
 * missing or carry no metadata. biofs-node asks the api_imaging executor which
 * studies it actually ingested for the signer, then inserts a missing row with
 * the same shape a pull writes and fills a metadata field only where the row
 * has none. Existing values are never overwritten: chain status stays as it
 * is, and a consent status of active, revoked or erased is never changed; a
 * registry row with no consent status at all gets 'active', the value a pull
 * writes. A row held by another owner is reported, never touched.
 *
 * Flow:
 *   POST /api_biofs_node/imaging_reconcile {wallet, signature, apply}
 *   Dry run by default; --apply writes.
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface ImagingReconcileOptions {
  apply?: boolean;
  quiet?: boolean;
  json?: boolean;
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

interface ReconcileAction {
  study_uid: string;
  biocid?: string;
  study_date?: string | null;
  description?: string | null;
  inventory?: string;
  registry?: string;
  error?: string;
}

interface ReconcileCounts { ok: number; insert: number; fill: number; conflict: number; skipped: number }

interface ImagingReconcileResponse {
  wallet?: string;
  apply?: boolean;
  studies?: number;
  truncated?: boolean;
  summary?: { inventory: ReconcileCounts; registry: ReconcileCounts; errors: number };
  actions?: ReconcileAction[];
  error?: string;
}

export async function imagingReconcileCommand(options: ImagingReconcileOptions = {}): Promise<ImagingReconcileResponse | null> {
  const mode = options.apply ? 'apply' : 'dry run';
  const spinner = options.quiet || options.json ? null : ora(`biofs imaging reconcile (${mode}) → biofs-node`).start();
  try {
    const credentials = await getCredentials();
    if (!credentials) {
      spinner?.fail('Not authenticated. Run: biofs login');
      process.exit(1);
    }
    const resp = await axios.post<ImagingReconcileResponse>(
      `${BIOFS_NODE_BASE}/imaging_reconcile`,
      { wallet: credentials.wallet_address, signature: credentials.user_signature, apply: !!options.apply },
      { timeout: 120_000, validateStatus: (s) => s < 500 },
    );
    const out = resp.data;
    if (resp.status >= 400) {
      spinner?.fail(`imaging_reconcile ${resp.status}: ${out?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(out, null, 2));
      return null;
    }
    if (options.json) {
      console.log(JSON.stringify(out, null, 2));
      return out;
    }
    const s = out.summary;
    spinner?.succeed(`${out.studies ?? 0} studies checked for ${out.wallet} (${mode})`);
    for (const a of out.actions || []) {
      const label = `${a.study_date || '????????'}  ${(a.description || '').padEnd(48).slice(0, 48)}  ${a.study_uid}`;
      if (a.error) { console.log(chalk.red(`  ${label}  error: ${a.error}`)); continue; }
      const clean = a.inventory === 'ok' && a.registry === 'ok';
      const line = `  ${label}  inventory: ${a.inventory}  registry: ${a.registry}`;
      console.log(clean ? chalk.gray(line) : line);
    }
    if (s) {
      console.log(`  inventory  ok ${s.inventory.ok}  insert ${s.inventory.insert}  fill ${s.inventory.fill}  conflict ${s.inventory.conflict}  skipped ${s.inventory.skipped}`);
      console.log(`  registry   ok ${s.registry.ok}  insert ${s.registry.insert}  fill ${s.registry.fill}  conflict ${s.registry.conflict}  skipped ${s.registry.skipped}`);
    }
    if (out.truncated) console.log(chalk.yellow('  the executor listed 200 studies, its page limit; run again after this pass to cover the rest'));
    if (!options.apply && s && (s.inventory.insert + s.inventory.fill + s.registry.insert + s.registry.fill) > 0) {
      console.log(chalk.cyan('  dry run: nothing was written. Re-run with --apply to write these rows.'));
    }
    return out;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`imaging reconcile failed: ${msg}`);
    Logger.error(`imaging reconcile failed: ${msg}`);
    return null;
  }
}
