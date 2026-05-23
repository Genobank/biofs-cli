/**
 * biofs cohort-acmg
 *
 * Batch ACMG / ClinGen-SVI-compliant pathogenicity report for a cohort of
 * biosample serials, served entirely server-side. The Mac CLI sends only
 * (serials, wallet, signature) and receives per-serial findings as JSON.
 * No genomic bytes ever touch the laptop.
 *
 * Per CLAUDE.md: "Daniel's MacBook is for codebase work only" + "MANDATORY:
 * Use gcsfuse for ALL Genomic Files — NEVER Download". Replaces the prior
 * pattern that did 51× `gcloud storage cp` of 250-MB sqlites into
 * ~/.biofs/cache/cravat/.
 *
 * Flow:
 *   1. Operator wallet signature verified once at request time.
 *   2. For each serial, the server resolves the OC sqlite via bioroutes,
 *      runs sqlite3 in-process against /mnt/gcsfuse-bioroutes/.../...sqlite,
 *      applies ACMG-SVI evidence stacks per Section 2.7 of the biofs-rrm
 *      paper, returns the ClinVar P+LP findings.
 *   3. The Mac client maps each serial to its operator-private biowallet
 *      from ~/.biofs/biowallets/index.json (chmod 600), mints one if absent,
 *      and writes per-biowallet JSON reports.
 *
 * Output files:
 *   - <output-dir>/<biowallet>.json   — per-proband ACMG-SVI report
 *   - <output-dir>/cohort_summary.json — cohort-wide aggregation
 *
 * Usage:
 *   biofs cohort-acmg --serials /tmp/aug_cohort_v1.txt
 *   biofs cohort-acmg --serials cohort.txt --output ~/cohort_reports/ --limit 5
 *   biofs cohort-acmg --serials cohort.txt --skip-existing
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import ora from 'ora';
import { FuseAPIClient, FuseCohortAcmgPerSerial, FuseVariantRow } from '../lib/api/fuse-client';
import { CredentialsManager } from '../lib/auth/credentials';

const BIOWALLET_INDEX = path.join(os.homedir(), '.biofs', 'biowallets', 'index.json');

export interface CohortAcmgOptions {
  serials?: string;
  output?: string;
  limit?: string;
  skipExisting?: boolean;
  quiet?: boolean;
  maxAf?: string;
}

interface BiowalletEntry {
  address: string;
  bound_biosamples: string[];
  status?: string;
  family_id?: string;
}

function loadBiowalletIndex(): BiowalletEntry[] {
  if (!fs.existsSync(BIOWALLET_INDEX)) return [];
  return JSON.parse(fs.readFileSync(BIOWALLET_INDEX, 'utf8'));
}

function findBiowalletForSerial(idx: BiowalletEntry[], serial: string): string | null {
  for (const e of idx) {
    if ((e.bound_biosamples || []).includes(serial)) return e.address;
  }
  return null;
}

function mintBiowalletForSerial(serial: string): string {
  const r = spawnSync('biofs', [
    'biowallet', 'create',
    '--label', 'Cohort proband (auto-bound to one biosample)',
    '--bind-biosample', serial,
    '--quiet',
  ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`biofs biowallet create failed: ${r.stderr || r.stdout}`);
  // Output line: "Address (EIP-55):        0x...". The literal "55" inside the
  // "(EIP-55)" label means any `[^0-9]*` regex short-circuits before the
  // address; grab the first 0x-prefixed 40-hex string on the Address line.
  let addrLine = r.stdout.split('\n').find(l => l.includes('Address (EIP-55)'));
  if (!addrLine) addrLine = r.stdout;
  const m = addrLine.match(/0x[0-9a-fA-F]{40}/);
  if (!m) throw new Error(`Could not parse biowallet address from output: ${r.stdout.slice(0, 300)}`);
  return m[0];
}

export async function cohortAcmgCommand(opts: CohortAcmgOptions): Promise<void> {
  if (!opts.serials) throw new Error('--serials <file> is required (one biosample serial per line)');
  if (!fs.existsSync(opts.serials)) throw new Error(`Serials file not found: ${opts.serials}`);
  const outDir = path.resolve(opts.output || './cohort_acmg_reports/');
  const limit = parseInt(opts.limit || '0', 10);
  const skipExisting = !!opts.skipExisting;

  const allSerials = fs.readFileSync(opts.serials, 'utf8')
    .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  const cohort = limit > 0 ? allSerials.slice(0, limit) : allSerials;

  fs.mkdirSync(outDir, { recursive: true });
  const biowalletIdx = loadBiowalletIndex();

  // Mint biowallets up front for any serial that doesn't have one. This keeps
  // the operator-private serial→biowallet mapping local; only biowallets are
  // returned to the API caller in summary outputs.
  const serialToBiowallet: Record<string, string> = {};
  for (const serial of cohort) {
    let biowallet = findBiowalletForSerial(biowalletIdx, serial);
    if (!biowallet) {
      biowallet = mintBiowalletForSerial(serial);
      // refresh index
      const updated = loadBiowalletIndex();
      biowalletIdx.length = 0;
      biowalletIdx.push(...updated);
    }
    serialToBiowallet[serial] = biowallet;
  }

  // Filter out serials whose biowallet report already exists if --skip-existing.
  const todoSerials: string[] = [];
  const reusedReports: Record<string, FuseCohortAcmgPerSerial> = {};
  for (const serial of cohort) {
    const biowallet = serialToBiowallet[serial];
    const outPath = path.join(outDir, `${biowallet}.json`);
    if (skipExisting && fs.existsSync(outPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        if (existing && (existing.status === 'ok' || existing.status === 'no_annotation')) {
          reusedReports[serial] = existing;
          continue;
        }
      } catch {
        // fallthrough to re-run
      }
    }
    todoSerials.push(serial);
  }

  if (!opts.quiet) {
    process.stderr.write(chalk.cyan(`\n🧬 biofs cohort-acmg  |  ${cohort.length} probands  |  ACMG-SVI evidence stacks per Section 2.7\n`));
    process.stderr.write(chalk.gray(`   biowallets known: ${biowalletIdx.length}; output dir: ${outDir}\n`));
    process.stderr.write(chalk.gray(`   server-side (NFT-gated gcsfuse on prod); zero genomic bytes on laptop\n`));
    process.stderr.write(chalk.gray(`   skipped (existing):  ${Object.keys(reusedReports).length}\n`));
    process.stderr.write(chalk.gray(`   to process:          ${todoSerials.length}\n\n`));
  }

  const credMgr = CredentialsManager.getInstance();
  const creds = await credMgr.loadCredentials();
  if (!creds) {
    throw new Error('Not authenticated. Run `biofs login` first.');
  }

  // Iterate per-proband against the /variants endpoint with clinvar=patho +
  // with_acmg=true. This avoids the Cloudflare 100s edge timeout that would
  // kill a batched cohort_acmg call once N×t_per_proband > 100 s. We process
  // 3 serials in parallel for throughput.
  const apiResults: Record<string, FuseCohortAcmgPerSerial> = {};
  if (todoSerials.length > 0) {
    const spinner = opts.quiet ? null : ora(`Querying ${todoSerials.length} probands on prod (NFT-gated, 3-way parallel)…`).start();
    const api = new FuseAPIClient();
    const CONCURRENCY = 2;
    let processed = 0;
    let okCount = 0;
    let totalFindings = 0;
    for (let i = 0; i < todoSerials.length; i += CONCURRENCY) {
      const chunk = todoSerials.slice(i, i + CONCURRENCY);
      // Promise.allSettled so one stuck/timed-out call doesn't block siblings
      // or the next chunk. Each call has its own 90 s AbortController in the
      // FuseAPIClient.
      await Promise.allSettled(chunk.map(async (serial) => {
        try {
          const r = await api.variants(serial, creds.wallet_address, creds.user_signature, {
            clinvar: 'patho',
            maxAf: opts.maxAf || '0.01',
            withAcmg: true,
          });
          apiResults[serial] = {
            status: 'ok',
            job_id: r.job_id,
            biocid: r.biocid,
            n_clinvar_p_lp_findings: r.count,
            findings: r.rows as FuseVariantRow[],
          };
          okCount += 1;
          totalFindings += r.count;
        } catch (e) {
          const msg = (e as Error).message;
          // "No OpenCRAVAT sqlite registered" → no_annotation; otherwise fetch_failed
          if (/No OpenCRAVAT sqlite|not mounted on prod/i.test(msg)) {
            apiResults[serial] = { status: 'no_annotation', error: msg };
          } else {
            apiResults[serial] = { status: 'failed', error: msg };
          }
        }
        processed += 1;
        if (spinner) {
          spinner.text = `[${processed}/${todoSerials.length}] proband processed; ok=${okCount}, findings=${totalFindings}`;
        }
      }));
    }
    if (spinner) {
      spinner.succeed(`Server processed ${okCount}/${todoSerials.length} probands ok, ${totalFindings} total findings`);
    }
  }

  // Merge reused + freshly fetched results, write per-biowallet JSON reports.
  const summary: {
    cohort_size: number;
    processed: number;
    ok: number;
    no_annotation: number;
    fetch_failed: number;
    skipped_existing: number;
    findings_per_proband: Record<string, number>;
    findings_per_gene: Record<string, number>;
    started_at: string;
    finished_at?: string;
    methodology: string;
  } = {
    cohort_size: cohort.length,
    processed: 0,
    ok: 0,
    no_annotation: 0,
    fetch_failed: 0,
    skipped_existing: Object.keys(reusedReports).length,
    findings_per_proband: {},
    findings_per_gene: {},
    started_at: new Date().toISOString(),
    methodology: 'Server-side sqlite3 query against NFT-gated gcsfuse mount on genobank.app/api_biofs_fuse/cohort_acmg. ACMG-SVI evidence per Section 2.7 of biofs-rrm paper (AlphaMissense single PP3, REVEL context-only, PVS1 canonical LoF, PM2 AF<1e-4).',
  };

  for (const serial of cohort) {
    const biowallet = serialToBiowallet[serial];
    const outPath = path.join(outDir, `${biowallet}.json`);
    let per: FuseCohortAcmgPerSerial | undefined = reusedReports[serial];
    let fromReuse = !!per;
    if (!per) {
      per = apiResults[serial];
    }
    if (!per) {
      // Server returned nothing for this serial — record as fetch_failed
      const rep = {
        biowallet,
        status: 'fetch_failed' as const,
        error: 'No server response for this serial',
        generated_at: new Date().toISOString(),
      };
      fs.writeFileSync(outPath, JSON.stringify(rep, null, 2));
      summary.processed += 1;
      summary.fetch_failed += 1;
      summary.findings_per_proband[biowallet] = 0;
      continue;
    }
    const report = {
      biowallet,
      status: per.status,
      job_id: per.job_id,
      biocid: per.biocid,
      n_clinvar_p_lp_findings: per.n_clinvar_p_lp_findings || 0,
      findings: per.findings || [],
      error: per.error,
      methodology: summary.methodology,
      generated_at: new Date().toISOString(),
      from_reused_cache: fromReuse,
    };
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    summary.processed += 1;
    if (per.status === 'ok') summary.ok += 1;
    else if (per.status === 'no_annotation') summary.no_annotation += 1;
    else summary.fetch_failed += 1;
    const n = report.n_clinvar_p_lp_findings;
    summary.findings_per_proband[biowallet] = n;
    for (const f of report.findings || []) {
      // Accept either new server schema (base__hugo) or legacy local schema (gene)
      const fr = f as Record<string, unknown>;
      const gene = String(fr.base__hugo || fr.gene || '-');
      summary.findings_per_gene[gene] = (summary.findings_per_gene[gene] || 0) + 1;
    }
  }

  summary.finished_at = new Date().toISOString();
  const summaryPath = path.join(outDir, 'cohort_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  if (!opts.quiet) {
    console.log('');
    console.log(chalk.cyan('═'.repeat(80)));
    console.log(chalk.bold('  COHORT ACMG SUMMARY'));
    console.log(chalk.cyan('═'.repeat(80)));
    console.log(`  cohort_size:                  ${summary.cohort_size}`);
    console.log(`  processed:                    ${summary.processed}`);
    console.log(`  ok:                           ${summary.ok}`);
    console.log(`  no_annotation:                ${summary.no_annotation}`);
    console.log(`  fetch_failed:                 ${summary.fetch_failed}`);
    console.log(`  skipped_existing:             ${summary.skipped_existing}`);
    console.log(chalk.cyan('─'.repeat(80)));
    const probandsWithFindings = Object.values(summary.findings_per_proband).filter(n => n > 0).length;
    console.log(`  probands with >=1 P+LP finding: ${probandsWithFindings}`);
    const totalFindings = Object.values(summary.findings_per_proband).reduce((a, b) => a + b, 0);
    console.log(`  total P+LP findings:          ${totalFindings}`);
    const topGenes = Object.entries(summary.findings_per_gene)
      .sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`  top genes by hit count:`);
    for (const [g, n] of topGenes) console.log(`    ${g.padEnd(14)}  ${n}`);
    console.log(chalk.cyan('═'.repeat(80)));
    console.log(chalk.green(`✓ Summary at ${summaryPath}`));
  }
}
