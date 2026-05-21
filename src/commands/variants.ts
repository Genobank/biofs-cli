/**
 * biofs variants <biosample_serial>
 *
 * Query annotated variants from the latest OpenCRAVAT sqlite for a biosample.
 *
 * Resolution path:
 *   1. `gcloud compute ssh genobank-production` runs route_mount.py to discover
 *      the most recent opencravat-typed file in bioroutes.inventory for the
 *      serial. Picks the latest job timestamp if multiple sqlites exist.
 *   2. Downloads (or uses cached) sqlite to ~/.biofs/cache/cravat/<serial>.sqlite
 *      via `gcloud storage cp` with the local service account.
 *   3. Spawns python3 to run the filtered query on the sqlite (sqlite3 stdlib —
 *      no native node deps to compile per-platform).
 *
 * Filters: --gene, --region, --so, --max-af, --clinvar.
 * Output: pretty table (default), tsv, or json.
 * Trio zygosity from the sample table is included automatically when present.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import ora from 'ora';

const CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'cravat');

export interface VariantsOptions {
  gene?: string;
  region?: string;
  so?: string;
  maxAf?: string;
  clinvar?: string;
  columns?: string;
  format?: string;
  output?: string;
  refresh?: boolean;
  quiet?: boolean;
  debug?: boolean;
  sqliteUri?: string;   // gs:// override — bypass biorouter resolution
  jobId?: string;       // pick a specific OC job timestamp (e.g. 260411-053533) when multiple sqlites exist
}

interface SqliteRef {
  gsPath: string;
  filename: string;
  serial: string;
  jobTime: string;
}

interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown> & { zygosity?: Record<string, string> }>;
  n: number;
}

function ensureCacheDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function resolveOpencravatSqlite(serial: string, debug = false): SqliteRef {
  const result = spawnSync(
    'gcloud',
    [
      'compute', 'ssh', 'genobank-production',
      '--zone=us-central1-a', '--tunnel-through-iap',
      '--command',
      `/home/ubuntu/Genobank_APIs/production_api/plugins/genoclaw/.venv/bin/python3 /home/ubuntu/bioroutes_dryrun/route_mount.py check ${serial} 2>&1`,
    ],
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );

  if (result.status !== 0) {
    throw new Error(`route resolver exited ${result.status}: ${result.stderr || result.stdout}`);
  }

  if (debug) {
    console.error(chalk.gray('--- route resolver output ---'));
    console.error(result.stdout);
    console.error(chalk.gray('--- end ---'));
  }

  const lines = result.stdout.split('\n');
  const candidates: SqliteRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/\[opencravat\s*\]/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const m = lines[j].match(/gs:\/\/[^\s]+\.sqlite\b/);
      if (m) {
        const jt = m[0].match(/\/(\d{6}-\d{6})\//);
        candidates.push({
          gsPath: m[0],
          filename: m[0].split('/').pop()!,
          serial,
          jobTime: jt ? jt[1] : '000000-000000',
        });
        break;
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `No OpenCRAVAT sqlite found in bioroutes.inventory for biosample ${serial}.\n` +
      `Submit annotation first: biofs annotate submit ${serial}`
    );
  }

  candidates.sort((a, b) => (a.jobTime < b.jobTime ? 1 : -1));
  return candidates[0];
}

function downloadSqlite(ref: SqliteRef, refresh = false, quiet = false): string {
  ensureCacheDir();
  // Job-scoped cache filename so different OC runs don't overwrite each other
  const target = path.join(
    CACHE_DIR,
    ref.jobTime && ref.jobTime !== 'manual'
      ? `${ref.serial}-${ref.jobTime}.sqlite`
      : `${ref.serial}.sqlite`
  );

  if (fs.existsSync(target) && !refresh) {
    if (!quiet) console.error(chalk.gray(`✓ cached: ${target}`));
    return target;
  }

  const spinner = quiet ? null : ora(`Downloading ${ref.filename}…`).start();
  const result = spawnSync(
    'gcloud',
    ['storage', 'cp', ref.gsPath, target],
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );

  if (result.status !== 0) {
    if (spinner) spinner.fail('Download failed');
    throw new Error(`gcloud storage cp failed: ${result.stderr || result.stdout}`);
  }
  if (spinner) spinner.succeed(`Cached: ${target} (${(fs.statSync(target).size / 1e6).toFixed(1)} MB)`);
  return target;
}

const DEFAULT_COLUMNS = [
  'base__chrom', 'base__pos', 'base__ref_base', 'base__alt_base',
  'base__hugo', 'base__so', 'base__cchange', 'base__achange',
  'clinvar__sig', 'clinvar__rev_stat', 'clinvar__id',
  'alphamissense__am_pathogenicity', 'alphamissense__am_class',
  'revel__score', 'revel__rankscore',
  'primateai__score', 'primateai__rankscore',
  'gnomad3__af', 'gnomad4__af', 'allofus250k__gvs_all_af',
];

const DEFAULT_SO = 'missense_variant,inframe_deletion,inframe_insertion,stop_gained,start_lost,frameshift_variant,splice_acceptor_variant,splice_donor_variant';

interface QueryPayload {
  sqlite: string;
  wantCols: string[];
  genes: string[];
  region: { chrom: string; start: number; end: number } | null;
  soList: string[];
  maxAf: number | null;
  clinvar: string;
}

function buildPayload(sqlitePath: string, opts: VariantsOptions): QueryPayload {
  const cols = opts.columns ? opts.columns.split(',').map(c => c.trim()) : DEFAULT_COLUMNS;
  const soList = (opts.so || DEFAULT_SO).split(',').map(s => s.trim());
  const wantAllSo = soList.length === 1 && soList[0].toLowerCase() === 'all';

  let region: { chrom: string; start: number; end: number } | null = null;
  if (opts.region) {
    const m = opts.region.match(/^(chr[0-9XYM]+):(\d+)-(\d+)$/i);
    if (!m) throw new Error(`Invalid --region. Use chrN:start-end (e.g. chr17:44372210-44511666)`);
    region = { chrom: m[1], start: parseInt(m[2], 10), end: parseInt(m[3], 10) };
  }

  const maxAf = opts.maxAf !== undefined && opts.maxAf !== '' ? parseFloat(opts.maxAf) : 0.01;

  return {
    sqlite: sqlitePath,
    wantCols: cols,
    genes: opts.gene ? opts.gene.split(',').map(g => g.trim().toUpperCase()) : [],
    region,
    soList: wantAllSo ? [] : soList,
    maxAf: isNaN(maxAf) ? null : maxAf,
    clinvar: opts.clinvar || 'all',
  };
}

const PY_QUERY_SCRIPT = `
import sqlite3, json, sys

cfg = json.loads(sys.stdin.read())
con = sqlite3.connect(cfg["sqlite"])
cur = con.cursor()

# Detect available columns
cur.execute("PRAGMA table_info(variant)")
variant_cols = [r[1] for r in cur.fetchall()]
have = set(variant_cols)
sel = [c for c in cfg["wantCols"] if c in have]
missing = [c for c in cfg["wantCols"] if c not in have]
if missing:
    print(f"# note: skipped missing columns: {missing}", file=sys.stderr)

# Always include uid for sample-table join
needed = ["base__uid"] + sel
needed_sql = ", ".join(f'v."{c}"' for c in needed)

# Build WHERE clause
where = []
params = []

if cfg["genes"]:
    placeholders = ",".join(["?"] * len(cfg["genes"]))
    where.append(f"UPPER(v.base__hugo) IN ({placeholders})")
    params.extend(cfg["genes"])

if cfg["region"]:
    r = cfg["region"]
    where.append("v.base__chrom = ? AND v.base__pos BETWEEN ? AND ?")
    params.extend([r["chrom"], r["start"], r["end"]])

if cfg["soList"]:
    so_clauses = []
    for s in cfg["soList"]:
        so_clauses.append("v.base__so LIKE ?")
        params.append(f"%{s}%")
    where.append("(" + " OR ".join(so_clauses) + ")")

# Population AF cap — only apply if columns exist
af_cols = [c for c in ["gnomad3__af", "gnomad4__af", "allofus250k__gvs_all_af", "gnomad__af"] if c in have]
if cfg["maxAf"] is not None and af_cols:
    af_clauses = []
    for c in af_cols:
        af_clauses.append(f"(v.\\"{c}\\" IS NULL OR v.\\"{c}\\" <= ?)")
        params.append(cfg["maxAf"])
    where.append("(" + " AND ".join(af_clauses) + ")")

# ClinVar filter
cv = cfg["clinvar"]
if cv and cv != "all" and "clinvar__sig" in have:
    if cv == "patho":
        where.append("(v.clinvar__sig LIKE '%Pathogenic%' OR v.clinvar__sig LIKE '%Likely_pathogenic%')")
    elif cv == "likely":
        where.append("v.clinvar__sig LIKE '%Likely_pathogenic%'")
    elif cv == "vus":
        where.append("v.clinvar__sig LIKE '%Uncertain_significance%'")
    elif cv == "benign":
        where.append("(v.clinvar__sig LIKE '%Benign%' OR v.clinvar__sig LIKE '%Likely_benign%')")

where_sql = ("WHERE " + " AND ".join(where)) if where else ""
order_sql = "ORDER BY v.base__chrom, v.base__pos"

sql = f"SELECT {needed_sql} FROM variant v {where_sql} {order_sql}"
cur.execute(sql, params)
rows = cur.fetchall()

# Detect sample-table schema for trio zygosity
cur.execute("PRAGMA table_info(sample)")
sample_schema = [r[1] for r in cur.fetchall()]
sid_col = next((c for c in ["base__sample_id", "sample_id"] if c in sample_schema), None)
zyg_col = next((c for c in ["base__zygosity", "zygosity"] if c in sample_schema), None)
uid_col = next((c for c in ["base__uid", "uid"] if c in sample_schema), None)

# Enumerate full set of trio/cohort members so we can distinguish "ref" from "missing"
all_samples = []
if sid_col:
    cur.execute(f'SELECT DISTINCT "{sid_col}" FROM sample ORDER BY "{sid_col}"')
    all_samples = [str(r[0]) for r in cur.fetchall() if r[0] is not None]

out = []
for r in rows:
    uid = r[0]
    rec = dict(zip(sel, r[1:]))
    if sid_col and zyg_col and uid_col:
        cur.execute(f'SELECT "{sid_col}", "{zyg_col}" FROM sample WHERE "{uid_col}" = ?', (uid,))
        called = {}
        for sr in cur.fetchall():
            called[str(sr[0])] = str(sr[1]) if sr[1] is not None else ""
        # Build full trio map: samples not in the called dict are reference (0/0)
        zy = {}
        for s in all_samples:
            zy[s] = called.get(s, "ref")
        if zy:
            rec["zygosity"] = zy
    out.append(rec)

print(json.dumps({"columns": sel, "rows": out, "n": len(out)}))
con.close()
`;

function querySqlite(sqlitePath: string, opts: VariantsOptions): QueryResult {
  const payload = JSON.stringify(buildPayload(sqlitePath, opts));

  const result = spawnSync('python3', ['-c', PY_QUERY_SCRIPT], {
    encoding: 'utf8',
    input: payload,
    maxBuffer: 200 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(`sqlite query failed: ${result.stderr || result.stdout}`);
  }
  if (result.stderr && !opts.quiet) {
    process.stderr.write(chalk.gray(result.stderr));
  }
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(`Failed to parse query JSON: ${(e as Error).message}\nstdout: ${result.stdout.slice(0, 500)}`);
  }
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

  // Pretty table
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
  if (!/^\d{14}$/.test(serial)) {
    throw new Error(`Invalid biosample serial: ${serial} (expected 14 digits)`);
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

  let ref: SqliteRef;
  if (opts.sqliteUri) {
    if (!opts.sqliteUri.startsWith('gs://') || !opts.sqliteUri.endsWith('.sqlite')) {
      throw new Error(`--sqlite-uri must be a gs://...sqlite URI, got: ${opts.sqliteUri}`);
    }
    const filename = opts.sqliteUri.split('/').pop()!;
    const jt = opts.sqliteUri.match(/\/(\d{6}-\d{6})\//);
    ref = {
      gsPath: opts.sqliteUri,
      filename,
      serial,
      jobTime: jt ? jt[1] : 'manual',
    };
    if (!quiet) console.error(chalk.gray(`1/3 Using --sqlite-uri override: ${opts.sqliteUri}`));
  } else {
    if (!quiet) console.error(chalk.gray('1/3 Resolving annotated sqlite via bioroutes…'));
    const candidate = resolveOpencravatSqlite(serial, opts.debug);
    if (opts.jobId && candidate.jobTime !== opts.jobId) {
      throw new Error(
        `--job-id ${opts.jobId} requested but bioroutes only returned job ${candidate.jobTime}. ` +
        `Pass --sqlite-uri gs://... to query a specific run not yet in inventory.`
      );
    }
    ref = candidate;
    if (!quiet) console.error(chalk.gray(`    ${ref.gsPath} (job ${ref.jobTime})`));
  }

  if (!quiet) console.error(chalk.gray('2/3 Fetching sqlite…'));
  const sqlitePath = downloadSqlite(ref, opts.refresh, quiet);

  if (!quiet) console.error(chalk.gray('3/3 Querying variants…\n'));
  const result = querySqlite(sqlitePath, opts);

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
