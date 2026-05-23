/**
 * biofs cohort-fourier-score
 *
 * Cohort-scale Cosic-RRM (EIIP + DFT) spectral scoring for the rare missense
 * variants observed across a cohort of biosample serials. Server-side, NFT-gated,
 * gcsfuse-mounted. Mac client sends only (serials, wallet, signature) and
 * receives per-serial per-variant spectral metrics as JSON.
 *
 * Per CLAUDE.md "ALL jobs originate and run through biofs-cli + biofs-node
 * protocol" + "Daniel's MacBook is for codebase work only": this verb is the
 * canonical entry point for the missing per-patient × per-variant Fourier score
 * matrix that Section 14.4 of the biofs-rrm internal paper proposes. No raw
 * gcloud SSH, no one-off sqlite scripts, no per-sample download.
 *
 * Flow:
 *   1. Operator wallet signature verified once at request time.
 *   2. For each serial, the server resolves the OC sqlite via bioroutes,
 *      runs sqlite3 in-process against /mnt/gcsfuse-bioroutes/.../...sqlite,
 *      extracts rare missense variants (AF ≤ --max-af, SO = missense_variant
 *      OR clinvar P/LP OR AlphaMissense ≥ --am-threshold), then for each
 *      variant looks up the gene's cached consensus characteristic frequency
 *      and computes the five Cosic-RRM metrics:
 *        - windowed Σ|ΔF|(k≥1)
 *        - windowed ΔE%
 *        - full-spectrum L1 distance
 *        - f_c ratio (mutant / wildtype magnitude at family f_c)
 *        - weighted aggregate ΔE% across top consensus peaks
 *   3. Per-variant rows are aggregated per biowallet and returned to the
 *      client. The client maps each serial to its operator-private biowallet
 *      from ~/.biofs/biowallets/index.json (chmod 600), mints one if absent.
 *
 * Output files:
 *   - <output-dir>/<biowallet>.json   — per-proband Cosic-RRM score matrix
 *   - <output-dir>/cohort_fourier_summary.json — cohort-wide aggregation
 *
 * Usage:
 *   biofs cohort-fourier-score --serials /tmp/aug_cohort_v1.txt
 *   biofs cohort-fourier-score --from-acmg ./cohort_acmg_reports/cohort_summary.json
 *   biofs cohort-fourier-score --serials cohort.txt --include-vus --include-high-am
 *   biofs cohort-fourier-score --serials cohort.txt --max-af 0.005 --am-threshold 0.5
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import ora from 'ora';
import {
  FuseAPIClient,
  FuseCohortFourierPerSerial,
  FuseFourierVariantRow,
} from '../lib/api/fuse-client';
import { CredentialsManager } from '../lib/auth/credentials';

const BIOWALLET_INDEX = path.join(os.homedir(), '.biofs', 'biowallets', 'index.json');

export interface CohortFourierScoreOptions {
  serials?: string;
  fromAcmg?: string;
  output?: string;
  limit?: string;
  skipExisting?: boolean;
  quiet?: boolean;
  maxAf?: string;
  amThreshold?: string;
  includeVus?: boolean;
  includeHighAm?: boolean;
  window?: string;
  windowTm?: string;
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

function findSerialForBiowallet(idx: BiowalletEntry[], address: string): string | null {
  const lower = address.toLowerCase();
  for (const e of idx) {
    if ((e.address || '').toLowerCase() === lower) {
      const s = (e.bound_biosamples || [])[0];
      return s || null;
    }
  }
  return null;
}

function mintBiowalletForSerial(serial: string): string {
  const r = spawnSync('biofs', [
    'biowallet', 'create',
    '--label', 'Cohort proband (auto-bound to one biosample, fourier-score scaffold)',
    '--bind-biosample', serial,
    '--quiet',
  ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`biofs biowallet create failed: ${r.stderr || r.stdout}`);
  let addrLine = r.stdout.split('\n').find(l => l.includes('Address (EIP-55)'));
  if (!addrLine) addrLine = r.stdout;
  const m = addrLine.match(/0x[0-9a-fA-F]{40}/);
  if (!m) throw new Error(`Could not parse biowallet address from output: ${r.stdout.slice(0, 300)}`);
  return m[0];
}

function loadSerialsFromAcmgSummary(summaryPath: string, idx: BiowalletEntry[]): string[] {
  // cohort_summary.json from `biofs cohort-acmg` is keyed on biowallet. The
  // operator-private biowallet→serial mapping lives in ~/.biofs/biowallets/index.json
  // so we recover the serials locally without ever round-tripping a name.
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const biowallets: string[] = Object.keys(summary.findings_per_proband || {});
  if (biowallets.length === 0) {
    throw new Error(`Could not extract biowallets from ${summaryPath} (findings_per_proband missing)`);
  }
  const serials: string[] = [];
  const missing: string[] = [];
  for (const bw of biowallets) {
    const s = findSerialForBiowallet(idx, bw);
    if (s) serials.push(s);
    else missing.push(bw);
  }
  if (missing.length > 0) {
    process.stderr.write(chalk.yellow(
      `   ⚠ ${missing.length} biowallets in ACMG summary have no local biowallet→serial mapping; skipping.\n`,
    ));
  }
  return serials;
}

export async function cohortFourierScoreCommand(opts: CohortFourierScoreOptions): Promise<void> {
  if (!opts.serials && !opts.fromAcmg) {
    throw new Error('Either --serials <file> or --from-acmg <cohort_summary.json> is required');
  }
  const outDir = path.resolve(opts.output || './cohort_fourier_reports/');
  const limit = parseInt(opts.limit || '0', 10);
  const skipExisting = !!opts.skipExisting;

  const biowalletIdx = loadBiowalletIndex();

  let allSerials: string[];
  if (opts.fromAcmg) {
    if (!fs.existsSync(opts.fromAcmg)) {
      throw new Error(`ACMG summary not found: ${opts.fromAcmg}`);
    }
    allSerials = loadSerialsFromAcmgSummary(opts.fromAcmg, biowalletIdx);
  } else {
    if (!fs.existsSync(opts.serials!)) {
      throw new Error(`Serials file not found: ${opts.serials}`);
    }
    allSerials = fs.readFileSync(opts.serials!, 'utf8')
      .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  }
  const cohort = limit > 0 ? allSerials.slice(0, limit) : allSerials;
  if (cohort.length === 0) {
    throw new Error('No serials to process (cohort is empty after filtering)');
  }

  fs.mkdirSync(outDir, { recursive: true });

  // Mint biowallets up front for any serial that doesn't have one.
  const serialToBiowallet: Record<string, string> = {};
  for (const serial of cohort) {
    let biowallet = findBiowalletForSerial(biowalletIdx, serial);
    if (!biowallet) {
      biowallet = mintBiowalletForSerial(serial);
      const updated = loadBiowalletIndex();
      biowalletIdx.length = 0;
      biowalletIdx.push(...updated);
    }
    serialToBiowallet[serial] = biowallet;
  }

  // Filter out serials whose report already exists if --skip-existing.
  const todoSerials: string[] = [];
  const reusedReports: Record<string, FuseCohortFourierPerSerial> = {};
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
    process.stderr.write(chalk.cyan(
      `\n🌊 biofs cohort-fourier-score  |  ${cohort.length} probands  |  Cosic-RRM EIIP/DFT spectral scoring\n`,
    ));
    process.stderr.write(chalk.gray(`   biowallets known: ${biowalletIdx.length}; output dir: ${outDir}\n`));
    process.stderr.write(chalk.gray(`   server-side (NFT-gated gcsfuse on prod); zero genomic bytes on laptop\n`));
    const filterDescBits: string[] = [];
    if (opts.includeVus) filterDescBits.push('include VUS');
    if (opts.includeHighAm) filterDescBits.push(`include AM ≥ ${opts.amThreshold || '0.5'}`);
    if (filterDescBits.length === 0) filterDescBits.push('ClinVar P/LP only');
    process.stderr.write(chalk.gray(
      `   variant filter:      ${filterDescBits.join(', ')}, max_af=${opts.maxAf || '0.01'}\n`,
    ));
    process.stderr.write(chalk.gray(`   skipped (existing):  ${Object.keys(reusedReports).length}\n`));
    process.stderr.write(chalk.gray(`   to process:          ${todoSerials.length}\n\n`));
  }

  const credMgr = CredentialsManager.getInstance();
  const creds = await credMgr.loadCredentials();
  if (!creds) {
    throw new Error('Not authenticated. Run `biofs login` first.');
  }

  const apiResults: Record<string, FuseCohortFourierPerSerial> = {};
  if (todoSerials.length > 0) {
    const spinner = opts.quiet ? null : ora(
      `Querying ${todoSerials.length} probands on prod (Cosic-RRM scoring, NFT-gated, 2-way parallel)…`,
    ).start();
    const api = new FuseAPIClient();
    // Concurrency 1: serialize so the server-side gene→UniProt cache warms
    // linearly. With concurrency=2, two cold-cache requests racing through
    // 100+ unique gene resolutions blow past Cloudflare's 100s edge timeout.
    // Serialized calls let later serials reuse the warm cache and finish in
    // 10-20s each.
    const CONCURRENCY = 1;
    let processed = 0;
    let okCount = 0;
    let totalVariants = 0;
    for (let i = 0; i < todoSerials.length; i += CONCURRENCY) {
      const chunk = todoSerials.slice(i, i + CONCURRENCY);
      await Promise.allSettled(chunk.map(async (serial) => {
        try {
          const r = await api.cohortFourierScorePerSerial(
            serial,
            creds.wallet_address,
            creds.user_signature,
            {
              maxAf: opts.maxAf,
              amThreshold: opts.amThreshold,
              includeVus: !!opts.includeVus,
              includeHighAm: !!opts.includeHighAm,
              window: opts.window,
              windowTm: opts.windowTm,
            },
          );
          apiResults[serial] = {
            status: 'ok',
            job_id: r.job_id,
            biocid: r.biocid,
            n_variants_scored: r.n_variants_scored,
            variants: r.variants as FuseFourierVariantRow[],
          };
          okCount += 1;
          totalVariants += r.n_variants_scored;
        } catch (e) {
          const msg = (e as Error).message;
          if (/No OpenCRAVAT sqlite|not mounted on prod/i.test(msg)) {
            apiResults[serial] = { status: 'no_annotation', error: msg };
          } else {
            apiResults[serial] = { status: 'failed', error: msg };
          }
        }
        processed += 1;
        if (spinner) {
          spinner.text = `[${processed}/${todoSerials.length}] proband scored; ok=${okCount}, variants=${totalVariants}`;
        }
      }));
    }
    if (spinner) {
      spinner.succeed(
        `Server scored ${okCount}/${todoSerials.length} probands ok, ${totalVariants} total variants`,
      );
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
    variants_per_proband: Record<string, number>;
    variants_per_gene: Record<string, number>;
    top_l1_per_biowallet: Record<string, { gene: string; protein: string; full_spectrum_l1: number } | null>;
    started_at: string;
    finished_at?: string;
    filter: {
      max_af: string;
      am_threshold: string;
      include_vus: boolean;
      include_high_am: boolean;
    };
    methodology: string;
  } = {
    cohort_size: cohort.length,
    processed: 0,
    ok: 0,
    no_annotation: 0,
    fetch_failed: 0,
    skipped_existing: Object.keys(reusedReports).length,
    variants_per_proband: {},
    variants_per_gene: {},
    top_l1_per_biowallet: {},
    started_at: new Date().toISOString(),
    filter: {
      max_af: opts.maxAf || '0.01',
      am_threshold: opts.amThreshold || '0.5',
      include_vus: !!opts.includeVus,
      include_high_am: !!opts.includeHighAm,
    },
    methodology: 'Server-side EIIP-encoded discrete Fourier transform of windowed protein neighborhoods (Cosic 1994 Rydberg values), plus full-protein L1 spectral distance and f_c ratio against the cached family consensus characteristic frequency. Per-variant rows return windowed Σ|ΔF|(k≥1), windowed ΔE%, full-spectrum L1, f_c ratio (M/W), and weighted aggregate ΔE% across the top consensus peaks. Identical scoring algorithm to `biofs fourier-score` + `biofs rrm-consensus`, executed cohort-scale on prod via the NFT-gated /api_biofs_fuse/cohort_fourier_score endpoint.',
  };

  for (const serial of cohort) {
    const biowallet = serialToBiowallet[serial];
    const outPath = path.join(outDir, `${biowallet}.json`);
    let per: FuseCohortFourierPerSerial | undefined = reusedReports[serial];
    const fromReuse = !!per;
    if (!per) per = apiResults[serial];
    if (!per) {
      const rep = {
        biowallet,
        status: 'fetch_failed' as const,
        error: 'No server response for this serial',
        generated_at: new Date().toISOString(),
      };
      fs.writeFileSync(outPath, JSON.stringify(rep, null, 2));
      summary.processed += 1;
      summary.fetch_failed += 1;
      summary.variants_per_proband[biowallet] = 0;
      summary.top_l1_per_biowallet[biowallet] = null;
      continue;
    }
    const report = {
      biowallet,
      status: per.status,
      job_id: per.job_id,
      biocid: per.biocid,
      n_variants_scored: per.n_variants_scored || 0,
      variants: per.variants || [],
      error: per.error,
      filter: summary.filter,
      methodology: summary.methodology,
      generated_at: new Date().toISOString(),
      from_reused_cache: fromReuse,
    };
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    summary.processed += 1;
    if (per.status === 'ok') summary.ok += 1;
    else if (per.status === 'no_annotation') summary.no_annotation += 1;
    else summary.fetch_failed += 1;
    const n = report.n_variants_scored;
    summary.variants_per_proband[biowallet] = n;
    let topRow: FuseFourierVariantRow | null = null;
    for (const v of report.variants || []) {
      const gene = String(v.gene || '-');
      summary.variants_per_gene[gene] = (summary.variants_per_gene[gene] || 0) + 1;
      const l1 = typeof v.full_spectrum_l1 === 'number' ? v.full_spectrum_l1 : -1;
      const topL1 = typeof topRow?.full_spectrum_l1 === 'number' ? topRow.full_spectrum_l1 : -1;
      if (l1 > topL1) topRow = v;
    }
    summary.top_l1_per_biowallet[biowallet] = topRow
      ? { gene: String(topRow.gene || '-'), protein: String(topRow.protein || '-'), full_spectrum_l1: Number(topRow.full_spectrum_l1) }
      : null;
  }

  summary.finished_at = new Date().toISOString();
  const summaryPath = path.join(outDir, 'cohort_fourier_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  if (!opts.quiet) {
    console.log('');
    console.log(chalk.cyan('═'.repeat(80)));
    console.log(chalk.bold('  COHORT FOURIER-SCORE SUMMARY'));
    console.log(chalk.cyan('═'.repeat(80)));
    console.log(`  cohort_size:                  ${summary.cohort_size}`);
    console.log(`  processed:                    ${summary.processed}`);
    console.log(`  ok:                           ${summary.ok}`);
    console.log(`  no_annotation:                ${summary.no_annotation}`);
    console.log(`  fetch_failed:                 ${summary.fetch_failed}`);
    console.log(`  skipped_existing:             ${summary.skipped_existing}`);
    console.log(chalk.cyan('─'.repeat(80)));
    const probandsWithVariants = Object.values(summary.variants_per_proband).filter(n => n > 0).length;
    console.log(`  probands with ≥1 scored variant: ${probandsWithVariants}`);
    const totalVariants = Object.values(summary.variants_per_proband).reduce((a, b) => a + b, 0);
    console.log(`  total variants scored:        ${totalVariants}`);
    const topGenes = Object.entries(summary.variants_per_gene)
      .sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`  top genes by variant count:`);
    for (const [g, n] of topGenes) console.log(`    ${g.padEnd(14)}  ${n}`);
    console.log(chalk.cyan('═'.repeat(80)));
    console.log(chalk.green(`✓ Summary at ${summaryPath}`));
  }
}
