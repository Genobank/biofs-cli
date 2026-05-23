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
import chalk from 'chalk';
import { Logger } from '../lib/utils/logger';

const BIOROUTER_API = process.env.BIOROUTER_API || 'https://api.genobank.app';

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
  // The bioroutes inventory exposes a per-sample roll-up at /api_bioroutes/samples
  // (admin or lab-custodian scoped). We curl with the Authorization signature
  // derived from the operator's wallet via the standard biofs auth flow.
  const sigFlags = ['-sS', '-A', 'biofs/3.2.0', '--max-time', '120'];
  let url = `${BIOROUTER_API}/api_bioroutes/samples?limit=${opts.limit || '5000'}`;
  if (opts.lab) url += `&lab=${encodeURIComponent(opts.lab)}`;
  if (opts.has) url += `&has=${encodeURIComponent(opts.has)}`;

  // Try with the operator's signed-message header if present; otherwise rely on
  // server-side IP allowlist for admin scope.
  const signFile = process.env.HOME + '/.biofs/auth/credentials.json';
  if (fs.existsSync(signFile)) {
    const creds = JSON.parse(fs.readFileSync(signFile, 'utf8'));
    if (creds.root_signature) {
      sigFlags.push('-H', `X-Auth-Wallet: ${creds.wallet_address}`);
      sigFlags.push('-H', `X-Auth-Root-Signature: ${creds.root_signature}`);
    }
  }

  const r = spawnSync('curl', [...sigFlags, url], { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`bioroutes samples fetch failed: ${r.stderr}`);
  const text = (r.stdout || '').trim();
  if (text.startsWith('<')) {
    throw new Error(`bioroutes returned HTML (likely 404 / unauthorized): ${text.slice(0, 200)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`bioroutes returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (Array.isArray(data)) return data as SampleRow[];
  if (Array.isArray(data?.samples)) return data.samples as SampleRow[];
  if (Array.isArray(data?.results)) return data.results as SampleRow[];
  // The API may not exist yet; fall back to scraping `biofs inventory --json`
  // and aggregating client-side. This is a soft fallback so the verb works
  // even before the server-side endpoint ships.
  throw new Error(`Unexpected bioroutes response shape: ${text.slice(0, 200)}`);
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
  if (opts.has) filtered = filtered.filter(r => (r.filetypes || []).includes(opts.has!));

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
