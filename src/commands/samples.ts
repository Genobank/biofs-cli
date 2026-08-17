/**
 * biofs samples list
 *
 * List distinct biosample serials in the bioroutes inventory, with optional
 * filters by lab, file-type, and on-chain status. This is the inventory-level
 * companion to `biofs route check` (per-sample) and `biofs inventory` (summary
 * statistics). Use this verb to discover cohorts for batch processing.
 *
 * Examples:
 *   biofs samples list --lab augenomics                 # all AUGenomics probands
 *   biofs samples list --lab augenomics --has opencravat # only those with OC annotation
 *   biofs samples list --lab augenomics --csv > cohort.csv
 *   biofs samples list --lab augenomics --short > cohort.txt
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import axios from 'axios';
import chalk from 'chalk';
import { Logger } from '../lib/utils/logger';
import { CredentialsManager } from '../lib/auth/credentials';
import { CONFIG } from '../lib/config/constants';
import { fileMatchesTypeFilter } from '../lib/biofiles/filetype';
import { BIOFS_VERSION } from '../version';

export interface SamplesListOptions {
  lab?: string;
  has?: string;
  json?: boolean;
  csv?: boolean;
  short?: boolean;
  limit?: string;
  outFile?: string;
}

interface SampleRow {
  biosample_serial: string;
  lab: string;
  filetypes: string[];
  total_files: number;
  has_biocid: number;
  on_chain: number;
}

async function fetchSamples(opts: SamplesListOptions): Promise<SampleRow[]> {
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) throw new Error('Not authenticated. Run: biofs login');
  const base = process.env.BIOROUTER_API || CONFIG.API_BASE_URL;
  const url = `${base}/api_bioroutes/samples`;
  const resp = await axios.get(url, {
    params: {
      limit: opts.limit || '5000',
      lab: opts.lab,
      has: opts.has,
      wallet: creds.wallet_address,
      signature: creds.user_signature,
    },
    timeout: 120_000,
    headers: {
      'User-Agent': `biofs/${BIOFS_VERSION}`,
      'X-Auth-Wallet': creds.wallet_address,
    },
    validateStatus: (s) => s < 500,
  });
  if (resp.status >= 400) {
    throw new Error(`bioroutes samples HTTP ${resp.status}: ${resp.data?.error || 'unauthorized'}`);
  }
  const data = resp.data;
  if (Array.isArray(data)) return data as SampleRow[];
  if (Array.isArray(data?.samples)) return data.samples as SampleRow[];
  if (Array.isArray(data?.results)) return data.results as SampleRow[];
  throw new Error(`Unexpected bioroutes samples shape`);
}

async function fallbackFromInventoryJson(opts: SamplesListOptions): Promise<SampleRow[]> {
  // Fallback: query `biofs inventory --json --verbose` and aggregate.
  const r = spawnSync('biofs', ['inventory', '--json', '--verbose'], {
    encoding: 'utf8',
    maxBuffer: 500 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`biofs inventory fallback failed: ${r.stderr}`);
  const data = JSON.parse(r.stdout);
  // The verbose inventory may include per-sample rows under data.samples_detail
  const rows = data?.samples_detail || data?.per_sample || data?.rows;
  if (!Array.isArray(rows)) {
    throw new Error(`biofs inventory --verbose does not expose per-sample rows. Add the /api_bioroutes/samples endpoint on prod, or query MongoDB directly.`);
  }
  return rows as SampleRow[];
}

export async function samplesListCommand(opts: SamplesListOptions): Promise<void> {
  let rows: SampleRow[];
  try {
    rows = await fetchSamples(opts);
  } catch (e) {
    Logger.warn(`Primary samples endpoint failed: ${(e as Error).message}`);
    Logger.warn(`Falling back to local inventory aggregation...`);
    rows = await fallbackFromInventoryJson(opts);
  }

  // Apply client-side filters if the server didn't
  let filtered = rows;
  if (opts.lab) filtered = filtered.filter(r => (r.lab || '').toLowerCase() === opts.lab!.toLowerCase());
  if (opts.has) {
    filtered = filtered.filter(r =>
      (r.filetypes || []).some(t => fileMatchesTypeFilter(opts.has as string, { type: t, filename: t }))
    );
  }

  // Emit
  if (opts.short) {
    const text = filtered.map(r => r.biosample_serial).join('\n');
    if (opts.outFile) fs.writeFileSync(opts.outFile, text);
    else console.log(text);
    return;
  }
  if (opts.json) {
    const out = JSON.stringify(filtered, null, 2);
    if (opts.outFile) fs.writeFileSync(opts.outFile, out);
    else console.log(out);
    return;
  }
  if (opts.csv) {
    const cols = ['biosample_serial', 'lab', 'total_files', 'has_biocid', 'on_chain', 'filetypes'];
    const lines = [cols.join(',')];
    for (const r of filtered) {
      lines.push([
        r.biosample_serial,
        r.lab,
        r.total_files,
        r.has_biocid,
        r.on_chain,
        `"${(r.filetypes || []).join(';')}"`,
      ].join(','));
    }
    const out = lines.join('\n');
    if (opts.outFile) fs.writeFileSync(opts.outFile, out);
    else console.log(out);
    return;
  }
  // Rich table
  console.log(chalk.cyan(`\n  ${filtered.length} sample(s)${opts.lab ? ` (lab=${opts.lab})` : ''}${opts.has ? ` (has=${opts.has})` : ''}`));
  console.log(chalk.cyan('─'.repeat(100)));
  console.log(`  ${chalk.gray('SERIAL'.padEnd(20))} ${chalk.gray('LAB'.padEnd(14))} ${chalk.gray('FILES'.padStart(6))}  ${chalk.gray('BIOCID'.padStart(7))}  ${chalk.gray('CHAIN'.padStart(6))}  ${chalk.gray('FILETYPES')}`);
  for (const r of filtered.slice(0, 200)) {
    console.log(`  ${(r.biosample_serial || '?').padEnd(20)} ${(r.lab || '-').padEnd(14)} ${String(r.total_files || 0).padStart(6)}  ${String(r.has_biocid || 0).padStart(7)}  ${String(r.on_chain || 0).padStart(6)}  ${(r.filetypes || []).join(',').slice(0, 50)}`);
  }
  if (filtered.length > 200) {
    console.log(chalk.gray(`  … truncated (${filtered.length - 200} more)`));
  }
}
