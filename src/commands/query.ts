/**
 * biofs query <target> [sql]
 *
 * The Phase-1 flagship of the BioFS consented query surface over QUERYABLE
 * biodata. `<target>` is a queryable-biodata biocid
 * (biocid://<lab>/<wallet>/sqlite/<file>.sqlite) or a biosample serial; `[sql]`
 * is a single read-only SELECT run SERVER-SIDE against the NFT-gated
 * OpenCRAVAT-annotated sqlite. The sqlite never leaves the prod gcsfuse mount;
 * only result rows transit. Every query passes the BioNFT consent gate and is
 * logged as a governed event.
 *
 * This is deliberately NOT for opaque biodata: FASTQ/BAM/CRAM make no sense as a
 * database and are served by `biofs mount`/`stream`, not here. The resolver only
 * accepts `sqlite`-type (queryable) biodata.
 *
 * The server enforces a SQLite authorizer: writes, ATTACH, write-pragmas,
 * extension loading, and multi-statement injection are rejected; a row cap and
 * a wall-clock budget bound every query.
 *
 * Examples:
 *   biofs query biocid://genobank/0xabc.../sqlite/NA12878.sqlite \
 *     "SELECT base__hugo, base__so, clinvar__sig FROM variant WHERE clinvar__sig LIKE '%Pathogenic%' LIMIT 50"
 *   biofs query TN25-336147 "SELECT COUNT(*) n FROM variant" --json
 *   biofs query TN25-336147 --schema        # list tables in the annotated sqlite
 */

import * as fs from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import { FuseAPIClient, FuseQueryResponse } from '../lib/api/fuse-client';
import { CredentialsManager } from '../lib/auth/credentials';

export interface QueryOptions {
  schema?: boolean;
  format?: string;       // table | tsv | csv | json
  output?: string;
  rowCap?: string;
  timeoutMs?: string;
  jobId?: string;
  async?: boolean;       // submit-then-poll (heavy full-table scans over gcsfuse)
  quiet?: boolean;
}

function isBiocid(s: string): boolean {
  return /^biocid:\/\//i.test(s);
}

function renderRows(resp: FuseQueryResponse, fmt: string): string {
  const columns = resp.columns ?? [];
  const rows = (resp.rows ?? []) as unknown[][];

  if (fmt === 'json') {
    // Emit objects keyed by column for easy agent/jq consumption.
    const objs = rows.map(r => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])));
    return JSON.stringify({
      biocid: resp.biocid, biosample: resp.biosample, columns,
      count: resp.count, truncated: !!resp.truncated, rows: objs,
    }, null, 2);
  }

  const cell = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

  if (fmt === 'tsv' || fmt === 'csv') {
    const sep = fmt === 'csv' ? ',' : '\t';
    const esc = (s: string) =>
      (fmt === 'csv' && /[",\n]/.test(s)) ? `"${s.replace(/"/g, '""')}"` : s;
    const lines = [columns.map(esc).join(sep)];
    for (const r of rows) lines.push(columns.map((_, i) => esc(cell(r[i]))).join(sep));
    return lines.join('\n');
  }

  // Pretty table (default)
  if (resp.count === 0) return chalk.yellow('0 rows.');
  const widths = columns.map((c, i) =>
    Math.min(36, Math.max(c.length, ...rows.map(r => cell(r[i]).length))));
  const sepLen = Math.min(180, widths.reduce((a, b) => a + b, 0) + columns.length * 2 + 2);
  const sep = '─'.repeat(sepLen);
  const out: string[] = [chalk.cyan(sep),
    columns.map((c, i) => chalk.bold(c.padEnd(widths[i]))).join('  '), chalk.cyan(sep)];
  for (const r of rows) {
    out.push(columns.map((_, i) => {
      const s = cell(r[i]);
      return (s.length > widths[i] ? s.slice(0, widths[i] - 1) + '…' : s).padEnd(widths[i]);
    }).join('  '));
  }
  out.push(chalk.cyan(sep));
  out.push(chalk.gray(`${resp.count} row(s)${resp.truncated ? ' (truncated at row cap)' : ''}` +
    (resp.elapsed_ms !== undefined ? `, ${resp.elapsed_ms} ms server-side` : '')));
  return out.join('\n');
}

export async function queryCommand(target: string, sql: string | undefined, opts: QueryOptions): Promise<void> {
  if (!target) throw new Error('A queryable-biodata biocid or biosample serial is required.');
  if (!opts.schema && !sql) {
    throw new Error('Pass a SQL SELECT (in quotes), or use --schema to introspect the tables first.');
  }

  const ref = isBiocid(target) ? { biocid: target } : { biosample: target };
  const fmt = (opts.format || 'table').toLowerCase();
  const quiet = opts.quiet || false;

  const credMgr = CredentialsManager.getInstance();
  const creds = await credMgr.loadCredentials();
  if (!creds) throw new Error('Not authenticated. Run `biofs login` first.');

  const spinner = quiet ? null
    : ora(opts.async
        ? 'Submitting consent-gated query as a background job (server-side, no download)…'
        : 'Running consent-gated query on the NFT-gated sqlite (server-side, no download)…').start();
  const api = new FuseAPIClient();
  const qopts = { schema: opts.schema, rowCap: opts.rowCap, timeoutMs: opts.timeoutMs, jobId: opts.jobId };
  const sqlArg = opts.schema ? null : (sql as string);
  let resp: FuseQueryResponse;
  try {
    resp = opts.async
      ? await api.querySqlPolled(ref, sqlArg, creds.wallet_address, creds.user_signature, qopts,
          (elapsed, status) => { if (spinner) spinner.text = `Async query running… ${elapsed}s server-side (${status})`; })
      : await api.query(ref, sqlArg, creds.wallet_address, creds.user_signature, qopts);
  } catch (e) {
    if (spinner) spinner.fail((e as Error).message);
    throw e;
  }

  if (opts.schema) {
    if (spinner) spinner.succeed(`${(resp.tables ?? []).length} table(s) in the annotated sqlite`);
    const payload = fmt === 'json'
      ? JSON.stringify({ biocid: resp.biocid, biosample: resp.biosample, tables: resp.tables ?? [] }, null, 2)
      : (resp.tables ?? []).join('\n');
    console.log(payload);
    if (!quiet) {
      console.error(chalk.gray('\nIntrospect columns with:  ' +
        chalk.white(`biofs query ${target} "PRAGMA table_info(variant)"`)));
    }
    return;
  }

  if (spinner) {
    const jt = resp.job_id ? ` (job ${resp.job_id})` : '';
    spinner.succeed(`${resp.count} row(s)${jt}`);
  }

  const rendered = renderRows(resp, fmt);
  if (opts.output) {
    fs.writeFileSync(opts.output, rendered.replace(/\x1b\[[0-9;]*m/g, ''));
    if (!quiet) console.error(chalk.green(`✓ Wrote ${resp.count} row(s) to ${opts.output}`));
    return;
  }
  console.log(rendered);
}
