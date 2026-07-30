/**
 * biofs erase <biosample>
 *
 * GDPR Article 17 — the right to erasure, executed rather than recorded.
 *
 * Until this verb existed, revoking consent only flipped a database flag while
 * the biodata stayed in the vault. This destroys the bytes, the registry rows
 * across all three registries, the derived sidecar, and the derived genomic
 * copies that live outside the vault (inline query results, the query audit's
 * SQL), then leaves a tombstone certificate that proves the erasure happened
 * using hashed identifiers only.
 *
 * DRY RUN BY DEFAULT. Nothing is destroyed unless you pass --execute, and the
 * server additionally requires a typed confirmation token, because this cannot
 * be undone. Only an owner/custodian may erase; a consented third-party agent
 * explicitly may not destroy data it was merely granted to read.
 *
 *   biofs erase 55052008714000                 # show exactly what would go
 *   biofs erase 55052008714000 --execute       # irreversible; prompts to confirm
 *   biofs erase --resume er_<uuid>             # finish an interrupted erasure
 */

import chalk from 'chalk';
import ora from 'ora';
import * as readline from 'readline';
import { FuseAPIClient } from '../lib/api/fuse-client';
import { CredentialsManager } from '../lib/auth/credentials';

export interface EraseOptions {
  execute?: boolean;
  resume?: string;
  yes?: boolean;
  json?: boolean;
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

export async function eraseCommand(biosample: string | undefined, opts: EraseOptions): Promise<void> {
  const credMgr = CredentialsManager.getInstance();
  const creds = await credMgr.loadCredentials();
  if (!creds) throw new Error('Not authenticated. Run `biofs login` first.');
  const api = new FuseAPIClient();

  if (opts.resume) {
    const spinner = ora('Resuming interrupted erasure…').start();
    const r = await api.erase({ erasureId: opts.resume, dryRun: false }, creds.wallet_address, creds.user_signature);
    spinner.succeed(`erasure ${opts.resume}: ${r.status}`);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (!biosample) throw new Error('A biosample serial is required (or --resume <erasure_id>).');

  // 1. Always plan first, even when --execute was passed. The operator sees the
  //    blast radius before anything is destroyed.
  const spinner = ora('Enumerating everything that would be erased…').start();
  const plan = await api.erase({ biosample, dryRun: true }, creds.wallet_address, creds.user_signature);
  spinner.stop();

  if (opts.json && !opts.execute) { console.log(JSON.stringify(plan, null, 2)); return; }

  const c = plan.would_delete || {};
  console.log(chalk.bold(`\nErasure plan for biosample ${biosample}`));
  console.log(`  GCS objects (bytes)      ${chalk.red(String(plan.gcs_objects_total ?? 0))}`);
  console.log(`  inventory rows           ${c.inventory_rows ?? 0}`);
  console.log(`  biocid registry (api)    ${c.biocid_registry_api ?? 0}`);
  console.log(`  biocid registry (router) ${c.biocid_registry_router ?? 0}`);
  console.log(`  query jobs (inline rows) ${c.query_jobs ?? 0}`);
  console.log(`  query audit events       ${c.query_events ?? 0}`);
  console.log(`  consent grants           ${c.consent_grants ?? 0} ${chalk.gray('(revoked, not deleted — evidence of withdrawal)')}`);

  if (!opts.execute) {
    console.log(chalk.gray('\nDry run. Nothing was changed.'));
    console.log(chalk.gray(`To execute: biofs erase ${biosample} --execute`));
    return;
  }

  // 2. Irreversible from here. Require a typed acknowledgement unless --yes.
  console.log(chalk.red.bold('\n⚠  This is IRREVERSIBLE. The bytes and their registry rows will be destroyed.'));
  if (!opts.yes) {
    const a = await ask(chalk.bold(`Type the serial (${biosample}) to confirm: `));
    if (a !== biosample) { console.log(chalk.yellow('Aborted — input did not match.')); return; }
  }

  const s2 = ora('Erasing (durable saga; safe to re-run if interrupted)…').start();
  const r = await api.erase(
    { biosample, dryRun: false, confirm: `ERASE-${biosample}` },
    creds.wallet_address, creds.user_signature,
  );
  if (r.error) { s2.fail(r.error); throw new Error(r.error); }
  s2.succeed('Erasure complete');
  const res = r.result || {};
  console.log(`  bytes deleted   ${res.gcs_deleted ?? 0}  (already absent: ${res.gcs_missing ?? 0}, failed: ${res.gcs_failed ?? 0})`);
  console.log(`  inventory rows  ${res.inventory_deleted ?? 0}`);
  console.log(`  derived copies  jobs=${res.query_jobs_deleted ?? 0} events=${res.query_events_deleted ?? 0}`);
  console.log(`  consent grants  ${res.consent_revoked ?? 0} revoked`);
  if (r.certificate?.erasure_id) {
    console.log(chalk.gray(`\n  certificate ${r.certificate.erasure_id} (hashed identifiers only)`));
  }
  if ((res.gcs_failed ?? 0) > 0) {
    console.log(chalk.yellow(`\n  ${res.gcs_failed} object(s) failed — re-run: biofs erase --resume ${r.certificate?.erasure_id}`));
  }
}
