/**
 * biofs route anchor — instantiate bioroutes.inventory rows on Sequentia.
 *
 * For each pending inventory row (has a biocid, not yet route-registered)
 * belonging to the target owner, registers a route on BioRoutes.sol
 * (Sequentia, the "DNS of biodata") so the file is on-chain and resolvable,
 * then unifies the row's status fields (route_status=ACTIVE, chain_status=
 * registered, route_tx_hash, biocid_key). The route key is sha256(biocid) —
 * the exact key the resolver (`biofs resolve`) computes — so a freshly
 * anchored file resolves immediately.
 *
 * Runs through the protocol: POST /api_biofs_node/anchor_inventory (which the
 * nginx passthrough maps to biofs-node /agent/anchor_inventory). biofs-node
 * holds the Sequentia signer + the bioroutes.inventory mongo and does the
 * on-chain registerRoute + the mongo update. The operator wallet is the
 * bioroutes admin (can anchor any owner); a non-admin can only anchor its own.
 *
 * Idempotent: routes already on-chain (getRouteCount > 0) are skipped.
 * Processes in batches and loops until no pending rows remain, so a long
 * backlog never trips the proxy timeout. NOT a one-off script.
 *
 * Default scope is John's custodian wallet. Use --wallet / --serial / --all.
 *
 * Examples:
 *   biofs route anchor --dry-run
 *   biofs route anchor                              # John (default)
 *   biofs route anchor --wallet 0xabc... --filetypes vcf,bam
 *   biofs route anchor --all --batch 25
 */

import chalk from 'chalk';
import axios from 'axios';
import { CredentialsManager } from '../../lib/auth/credentials';
import { CONFIG } from '../../lib/config/constants';
import { Logger } from '../../lib/utils/logger';

// John's custodian biowallet (the default anchor scope). Public address only.
const JOHN_WALLET = '0x88110B7e4F56A53951461342298b468Ae68F15f1';

export interface RouteAnchorOptions {
  wallet?: string;
  serial?: string;
  all?: boolean;
  writes?: string;
  filetypes?: string;
  batch?: string;
  limit?: string;
  dryRun?: boolean;
  json?: boolean;
}

function fmt(n: number): string {
  return (n || 0).toLocaleString('en-US');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function routeAnchorCommand(options: RouteAnchorOptions): Promise<void> {
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }

  // Scope: --all (every pending wallet) | --wallet | --serial | default John.
  const owner = options.all ? undefined : (options.wallet || (options.serial ? undefined : JOHN_WALLET));
  const writes = (options.writes || 'route').split(',').map((s) => s.trim()).filter(Boolean);
  // Default 10: each batch is N sequential Sequentia txs (~1.5s each); keep a
  // batch well under the ~100s Cloudflare gateway timeout. The client also
  // retries gateway timeouts since the endpoint is idempotent + resumable.
  const batch = Math.max(1, Math.min(100, parseInt(options.batch || '10', 10)));
  const maxTotal = options.limit ? parseInt(options.limit, 10) : 0; // 0 = no cap

  const baseBody: Record<string, unknown> = {
    wallet: creds.wallet_address,
    signature: creds.user_signature,
    writes,
    batch,
  };
  if (owner) baseBody.owner = owner;
  if (options.serial) baseBody.sample_serials = [options.serial];
  if (options.filetypes) {
    baseBody.filetypes = options.filetypes.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const url = `${CONFIG.API_BASE_URL}/api_biofs_node/anchor_inventory`;

  if (!options.json) {
    console.log('');
    console.log(chalk.bold('BioRoutes Anchor — instantiate inventory on Sequentia'));
    console.log(chalk.gray('─'.repeat(64)));
    const scope = options.all ? chalk.yellow('ALL pending (every wallet)')
      : owner ? owner
      : `serial ${options.serial}`;
    console.log(`  Scope:    ${scope}`);
    if (options.filetypes) console.log(`  Filetype: ${options.filetypes}`);
    console.log(`  Writes:   ${writes.join(', ')}`);
    console.log(`  Mode:     ${options.dryRun ? chalk.yellow('DRY-RUN') : chalk.green('REGISTER (batched)')}`);
    console.log('');
  }

  // ── DRY-RUN: single call, report eligible count, no writes ──────────────
  if (options.dryRun) {
    try {
      const r = await axios.post(url, { ...baseBody, dry_run: true }, {
        timeout: 60_000,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: (s: number) => s < 500,
      });
      if (r.status === 403) {
        Logger.error(`Anchor denied: ${r.data?.error || 'unauthorized (not a bioroutes admin / not your wallet)'}`);
        process.exit(1);
      }
      if (r.status >= 400) {
        Logger.error(`Anchor dry-run failed (HTTP ${r.status}): ${r.data?.error || 'unknown'}`);
        process.exit(1);
      }
      if (options.json) {
        console.log(JSON.stringify(r.data, null, 2));
        return;
      }
      console.log(chalk.yellow('  [DRY-RUN] No routes registered.'));
      console.log(`  Eligible rows: ${chalk.green(fmt(r.data.eligible))}`);
      if (r.data.by_filetype && Object.keys(r.data.by_filetype).length > 0) {
        for (const [ft, n] of Object.entries(r.data.by_filetype)) {
          console.log(`    ${String(ft).padEnd(16)} ${fmt(n as number)}`);
        }
      }
      console.log('');
      return;
    } catch (e: any) {
      Logger.error(`Anchor dry-run failed: ${e.response?.data?.error || e.message}`);
      process.exit(1);
    }
  }

  // ── REAL RUN: batch loop until remaining_eligible == 0 ──────────────────
  let totReg = 0, totSkip = 0, totErr = 0, rounds = 0, gatewayFails = 0;
  const allResults: any[] = [];

  while (true) {
    rounds++;
    let r;
    try {
      r = await axios.post(url, { ...baseBody, dry_run: false }, {
        timeout: 180_000,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: (s: number) => s < 600,  // resolve 5xx so we can branch
      });
    } catch (e: any) {
      // Network-level timeout (no HTTP response). Endpoint is idempotent +
      // resumable, so retry the same round rather than abandoning progress.
      gatewayFails++;
      if (gatewayFails > 8) { Logger.error(`Anchor aborted after ${gatewayFails} consecutive network failures: ${e.message}`); process.exit(1); }
      Logger.warning(`network timeout (continuing — endpoint is resumable); retry ${gatewayFails}/8`);
      rounds--; await sleep(3000); continue;
    }
    // Cloudflare gateway timeouts (502/503/504/524) while a long batch is still
    // registering server-side. Wait + retry; already-registered rows are skipped.
    if ([502, 503, 504, 520, 521, 522, 523, 524].includes(r.status)) {
      gatewayFails++;
      if (gatewayFails > 8) { Logger.error(`Anchor aborted after ${gatewayFails} consecutive gateway timeouts (HTTP ${r.status})`); process.exit(1); }
      Logger.warning(`gateway timeout HTTP ${r.status} (continuing — endpoint is resumable); retry ${gatewayFails}/8`);
      rounds--; await sleep(4000); continue;
    }
    if (r.status === 403) {
      Logger.error(`Anchor denied: ${r.data?.error || 'unauthorized'}`);
      process.exit(1);
    }
    if (r.status >= 400) {
      Logger.error(`Anchor failed (HTTP ${r.status}): ${r.data?.error || 'unknown'}`);
      process.exit(1);
    }
    gatewayFails = 0;  // a clean round resets the failure counter

    const d = r.data;
    totReg += d.registered || 0;
    totSkip += d.skipped || 0;
    totErr += d.errors || 0;
    if (Array.isArray(d.results)) allResults.push(...d.results);

    if (!options.json) {
      const errStr = (d.errors || 0) > 0 ? chalk.red(` errors=${d.errors}`) : '';
      console.log(
        `  [round ${String(rounds).padStart(2)}] ` +
        `registered=${chalk.green(d.registered || 0)} skipped=${d.skipped || 0}${errStr} ` +
        `remaining=${chalk.yellow(fmt(d.remaining_eligible || 0))}`
      );
    }

    if ((d.remaining_eligible || 0) <= 0) break;
    if ((d.processed || 0) === 0) break;            // no progress — avoid infinite loop
    if (maxTotal && (totReg + totSkip) >= maxTotal) break;
    await sleep(500);
  }

  if (options.json) {
    console.log(JSON.stringify({
      registered: totReg, skipped: totSkip, errors: totErr, rounds, results: allResults,
    }, null, 2));
    return;
  }

  console.log('');
  console.log(chalk.bold('Summary'));
  console.log(chalk.gray('─'.repeat(64)));
  console.log(`  Registered: ${chalk.green(fmt(totReg))}`);
  console.log(`  Skipped:    ${fmt(totSkip)} (already on-chain)`);
  console.log(`  Errors:     ${totErr > 0 ? chalk.red(fmt(totErr)) : '0'}`);
  console.log('');
  if (totReg > 0) {
    console.log(chalk.gray(
      `  ${fmt(totReg)} route(s) registered on Sequentia. They now resolve via ` +
      `'biofs resolve <biocid>' and appear in 'biofs files'.`
    ));
    console.log('');
  }
}
