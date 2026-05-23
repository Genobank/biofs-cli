/**
 * biofs variants <biosample_serial>
 *
 * Query annotated variants from the latest OpenCRAVAT sqlite for a biosample,
 * via the NFT-gated server-side query API. The sqlite never leaves the prod
 * gcsfuse mount; only filtered rows transit to the client.
 *
 * Replaces the prior pattern that downloaded the sqlite to
 * ~/.biofs/cache/cravat/ via `gcloud storage cp` and queried locally — which
 * violated the "MacBook for codebase only" rule documented in CLAUDE.md.
 *
 * Resolution path (all server-side, behind https://genobank.app/api_biofs_fuse/variants):
 *   1. Wallet-signature verification on the request.
 *   2. Server runs route_mount.py to resolve the latest opencravat-typed file
 *      in bioroutes.inventory for the serial. Picks the latest job timestamp
 *      if multiple sqlites exist (or honours --job-id).
 *   3. Server runs sqlite3 in-process against the gcsfuse-mounted file path.
 *   4. Server returns {columns, rows, count} JSON.
 *
 * Filters: --gene, --region, --so, --max-af, --clinvar.
 * Output: pretty table (default), tsv, or json.
 * Trio zygosity from the sample table is included automatically when present.
 */

import * as fs from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import { FuseAPIClient } from '../lib/api/fuse-client';
import { CredentialsManager } from '../lib/auth/credentials';

export interface VariantsOptions {
  gene?: string;
  region?: string;
  so?: string;
  maxAf?: string;
  clinvar?: string;
  columns?: string;
  format?: string;
  output?: string;
  refresh?: boolean;    // kept for back-compat; no longer needed (no local cache)
  quiet?: boolean;
  debug?: boolean;
  sqliteUri?: string;   // gs:// override — currently unsupported via API; flagged as deprecated
  jobId?: string;       // pick a specific OC job timestamp when multiple sqlites exist
  withAcmg?: boolean;
  limit?: string;
}

interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown> & { zygosity?: Record<string, string> }>;
  n: number;
}

function shortColName(c: string): string {
  const map: Record<string, string> = {
    'base__chrom': 'CHR',
    'base__pos': 'POS',
    'base__ref_base': 'REF',
    'base__alt_base': 'ALT',
    'base__hugo': 'GENE',
    'base__so': 'EFFECT',
    'base__cchange': 'cDNA',
    'base__achange': 'PROT',
    'clinvar__sig': 'CLINVAR',
    'clinvar__rev_stat': 'CV_REV',
    'clinvar__id': 'CV_ID',
    'alphamissense__am_pathogenicity': 'AM_path',
    'alphamissense__am_class': 'AM_class',
    'revel__score': 'REVEL',
    'revel__rankscore': 'REVEL_rk',
    'primateai__score': 'PAI',
    'primateai__rankscore': 'PAI_rk',
    'gnomad3__af': 'gnomAD3',
    'gnomad4__af': 'gnomAD4',
    'allofus250k__gvs_all_af': 'AoU',
  };
  return map[c] || c.replace(/^[^_]+__/, '');
}

function renderTable(result: QueryResult, opts: VariantsOptions): string {
  if (result.n === 0) {
    return chalk.yellow('No variants match filters.');
  }

  const fmt = opts.format || 'table';

  if (fmt === 'json') {
    return JSON.stringify(result, null, 2);
  }

  if (fmt === 'tsv') {
    const hdrs = [...result.columns, 'zygosity'];
    const lines = [hdrs.join('\t')];
    for (const row of result.rows) {
      const vals: string[] = result.columns.map(c => {
        const v = row[c];
        return v === null || v === undefined ? '' : String(v);
      });
      vals.push(row.zygosity ? JSON.stringify(row.zygosity) : '');
      lines.push(vals.join('\t'));
    }
    return lines.join('\n');
  }

  const headers = result.columns.map(shortColName);
  const widths = headers.map((h, i) => {
    const c = result.columns[i];
    const maxLen = Math.max(
      h.length,
      ...result.rows.map(r => {
        const v = r[c];
        return v === null || v === undefined ? 0 : String(v).length;
      })
    );
    return Math.min(maxLen, 36);
  });

  const sepLen = widths.reduce((a, b) => a + b, 0) + headers.length * 2 + 2;
  const sep = '─'.repeat(Math.min(sepLen, 180));

  const lines: string[] = [];
  lines.push(chalk.cyan(sep));
  lines.push(headers.map((h, i) => chalk.bold(h.padEnd(widths[i]))).join('  '));
  lines.push(chalk.cyan(sep));

  for (const row of result.rows) {
    const cells = result.columns.map((c, i) => {
      const v = row[c];
      const s = v === null || v === undefined ? '' : String(v);
      const t = s.length > widths[i] ? s.slice(0, widths[i] - 1) + '…' : s;
      return t.padEnd(widths[i]);
    });
    lines.push(cells.join('  '));
    if (row.zygosity) {
      const zStr = Object.entries(row.zygosity)
        .map(([k, v]) => `${k.slice(0, 18)}=${v}`)
        .join('  ');
      lines.push(chalk.gray(`    ↳ zygosity: ${zStr}`));
    }
  }
  lines.push(chalk.cyan(sep));
  lines.push(chalk.gray(`${result.n} variant(s) match filters.`));
  return lines.join('\n');
}

export async function variantsCommand(serial: string, opts: VariantsOptions): Promise<void> {
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(serial)) {
    throw new Error(`Invalid biosample serial: ${serial} (expected 4-32 alphanumeric characters)`);
  }

  if (opts.sqliteUri) {
    throw new Error(
      '--sqlite-uri is no longer supported. The variants query now runs server-side ' +
      'against the NFT-gated gcsfuse mount on prod. Use --job-id to select a specific ' +
      'OC job timestamp from the bioroutes inventory.'
    );
  }

  const quiet = opts.quiet || false;

  if (!quiet) {
    console.error(chalk.cyan(`\n🧬 biofs variants — ${serial}`));
    if (opts.gene) console.error(chalk.gray(`   gene:    ${opts.gene}`));
    if (opts.region) console.error(chalk.gray(`   region:  ${opts.region}`));
    if (opts.so) console.error(chalk.gray(`   so:      ${opts.so}`));
    console.error(chalk.gray(`   max-af:  ${opts.maxAf !== undefined ? opts.maxAf : '0.01'}`));
    if (opts.clinvar) console.error(chalk.gray(`   clinvar: ${opts.clinvar}`));
    console.error('');
  }

  const credMgr = CredentialsManager.getInstance();
  const creds = await credMgr.loadCredentials();
  if (!creds) {
    throw new Error('Not authenticated. Run `biofs login` first.');
  }

  const spinner = quiet ? null : ora('Querying NFT-gated sqlite on prod (no local download)…').start();
  const api = new FuseAPIClient();
  let response;
  try {
    response = await api.variants(serial, creds.wallet_address, creds.user_signature, {
      gene: opts.gene,
      region: opts.region,
      so: opts.so,
      maxAf: opts.maxAf !== undefined ? opts.maxAf : '0.01',
      clinvar: opts.clinvar,
      columns: opts.columns,
      jobId: opts.jobId,
      withAcmg: opts.withAcmg,
      limit: opts.limit,
    });
  } catch (e) {
    if (spinner) spinner.fail((e as Error).message);
    throw e;
  }
  if (spinner) {
    const jt = response.job_id ? ` (job ${response.job_id})` : '';
    spinner.succeed(`${response.count} variants${jt}`);
  }

  const result: QueryResult = {
    columns: response.columns ?? [],
    rows: (response.rows ?? []) as QueryResult['rows'],
    n: response.count,
  };

  const rendered = renderTable(result, opts);

  if (opts.output) {
    fs.writeFileSync(opts.output, rendered.replace(/\x1b\[[0-9;]*m/g, ''));
    if (!quiet) {
      console.error(chalk.green(`✓ Wrote ${result.n} variant(s) to ${opts.output}`));
    }
    return;
  }

  console.log(rendered);
}
