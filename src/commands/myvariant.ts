/**
 * biofs myvariant <id_or_query>
 *
 * Standalone interface to the MyVariant.info v1 API, exposing the same data
 * source that the rrm-train and cohort-train verbs use internally for batch
 * deep-learning-predictor lookups (AlphaMissense, REVEL, PrimateAI, EVE,
 * ESM1b, CADD, MetaRNN), plus the broader catalog (ClinVar, COSMIC, gnomAD,
 * 1000 Genomes, ExAC, dbSNP, dbNSFP, MutationTaster, FATHMM, etc.).
 *
 * Modes (selected by flags):
 *   default        single variant lookup by HGVS or dbSNP rsID
 *   --batch FILE   batch lookup from a file of one identifier per line
 *   --gene SYM     fetch all variants in a gene (paginated via /query)
 *   --query        treat the positional argument as a raw /query expression
 *
 * Field-set presets:
 *   --predictors   AM, REVEL, PrimateAI, EVE, ESM1b, CADD, MetaRNN, BayesDel,
 *                  ClinPred — the deep-learning ensemble inputs used by biofs
 *                  rrm-train
 *   --clinical     ClinVar, COSMIC, gnomAD, 1000G, ExAC, EMV
 *   --basic        dbSNP rsID, HGVS protein/genomic, VCF columns
 *   --all          predictors + clinical + basic
 *
 * Output:
 *   default        rich table per variant
 *   --json         raw MyVariant.info JSON response
 *   --csv          CSV with flattened columns
 *   --tsv          tab-separated, easy to pipe into other tools
 *
 * Examples:
 *   biofs myvariant chr17:g.44376320A>G --assembly hg38 --predictors
 *   biofs myvariant rs746840580
 *   biofs myvariant --gene ITGA2B --clinical --limit 200 --json
 *   biofs myvariant --batch ./rsids.txt --predictors --csv > scores.csv
 *   biofs myvariant --query 'clinvar.gene.symbol:ITGA2B AND clinvar.rcv.clinical_significance:pathogenic'
 *
 * Endpoints (with backoff and chunking):
 *   GET  https://myvariant.info/v1/variant/<id>?fields=<list>
 *   POST https://myvariant.info/v1/variant   body: ids=...&fields=...
 *   GET  https://myvariant.info/v1/query?q=...&fields=...&size=N&from=M
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { Logger } from '../lib/utils/logger';

const MV_BASE = 'https://myvariant.info/v1';
const USER_AGENT = 'biofs/3.2.0';

const FIELD_PRESETS: Record<string, string> = {
  predictors: 'dbnsfp.alphamissense,dbnsfp.revel,dbnsfp.primateai,dbnsfp.eve,dbnsfp.esm1b,dbnsfp.cadd.phred,dbnsfp.metarnn,dbnsfp.bayesdel.addaf,dbnsfp.clinpred',
  clinical:   'clinvar.rcv.clinical_significance,clinvar.rcv.review_status,clinvar.variant_id,clinvar.allele_id,clinvar.hgvs.coding,clinvar.hgvs.protein,cosmic,gnomad_genome.af,gnomad_exome.af,exac.af,1000g.af,emv',
  basic:      'dbsnp.rsid,dbsnp.gene.symbol,hgvs,vcf,chrom,pos,snpeff.ann.feature_id,snpeff.ann.hgvs_p,snpeff.ann.gene_name,snpeff.ann.putative_impact',
};
FIELD_PRESETS.all = `${FIELD_PRESETS.predictors},${FIELD_PRESETS.clinical},${FIELD_PRESETS.basic}`;

export interface MyVariantOptions {
  batch?: string;
  gene?: string;
  query?: boolean;
  fields?: string;
  predictors?: boolean;
  clinical?: boolean;
  basic?: boolean;
  all?: boolean;
  assembly?: string;        // hg19 | hg38 (informational; MyVariant uses hg19 by default)
  json?: boolean;
  csv?: boolean;
  tsv?: boolean;
  limit?: string;
  quiet?: boolean;
  outFile?: string;
}

interface MvSingle {
  query?: string;
  _id?: string;
  notfound?: boolean;
  [key: string]: any;
}

function resolveFieldList(opts: MyVariantOptions): string {
  const parts: string[] = [];
  if (opts.all) {
    parts.push(FIELD_PRESETS.all);
  } else {
    if (opts.predictors) parts.push(FIELD_PRESETS.predictors);
    if (opts.clinical)   parts.push(FIELD_PRESETS.clinical);
    if (opts.basic)      parts.push(FIELD_PRESETS.basic);
  }
  if (opts.fields) parts.push(opts.fields);
  if (parts.length === 0) parts.push(FIELD_PRESETS.basic);  // sensible default
  return parts.join(',');
}

async function mvGet(url: string): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!r.ok) {
        const text = await r.text();
        if (r.status === 429) {
          await new Promise(res => setTimeout(res, 1000 * (attempt + 1) * 2));
          continue;
        }
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      }
      return await r.json();
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
    }
  }
}

async function mvPostBatch(ids: string[], fields: string): Promise<MvSingle[]> {
  const out: MvSingle[] = [];
  const chunkSize = 100;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const body = `ids=${chunk.map(encodeURIComponent).join(',')}&fields=${encodeURIComponent(fields)}&dotfield=true`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${MV_BASE}/variant`, {
          method: 'POST',
          headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        });
        if (!r.ok) {
          if (r.status === 429) {
            await new Promise(res => setTimeout(res, 1000 * (attempt + 1) * 2));
            continue;
          }
          throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        }
        const data = await r.json();
        const arr = Array.isArray(data) ? data : [data];
        out.push(...arr);
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
      }
    }
    await new Promise(res => setTimeout(res, 150));  // polite throttle
  }
  return out;
}

function flatGet(obj: any, dotPath: string): any {
  if (!obj) return null;
  const parts = dotPath.split('.');
  let cur: any = obj;
  for (const p of parts) {
    if (cur === undefined || cur === null) return null;
    cur = cur[p];
  }
  if (Array.isArray(cur)) {
    // collapse to mean for numeric arrays, first element for object/string arrays
    if (cur.length === 0) return null;
    if (typeof cur[0] === 'number') {
      const nums = cur.filter((x: any) => typeof x === 'number');
      return nums.length ? nums.reduce((a: number, b: number) => a + b, 0) / nums.length : null;
    }
    return cur[0];
  }
  return cur;
}

function renderSingle(mv: MvSingle, fields: string): void {
  console.log(chalk.cyan('═'.repeat(80)));
  console.log(chalk.bold.cyan(`  ${mv._id || mv.query || '(unknown id)'}`));
  if (mv.notfound) {
    console.log(chalk.gray('  not found in MyVariant.info'));
    console.log(chalk.cyan('═'.repeat(80)));
    return;
  }
  console.log(chalk.cyan('─'.repeat(80)));
  // Pretty-print the most common predictor fields if present
  const ROWS: [string, string[]][] = [
    ['Chrom:pos',           ['chrom', 'pos']],
    ['dbSNP rsID',          ['dbsnp.rsid']],
    ['Gene',                ['dbnsfp.genename', 'dbsnp.gene.symbol', 'snpeff.ann.gene_name']],
    ['HGVS protein',        ['snpeff.ann.hgvs_p', 'clinvar.hgvs.protein']],
    ['HGVS coding',         ['clinvar.hgvs.coding']],
    ['ClinVar significance', ['clinvar.rcv.clinical_significance']],
    ['ClinVar variant_id',  ['clinvar.variant_id']],
    ['AlphaMissense',       ['dbnsfp.alphamissense.score', 'dbnsfp.alphamissense']],
    ['REVEL',               ['dbnsfp.revel.score', 'dbnsfp.revel']],
    ['PrimateAI',           ['dbnsfp.primateai.score', 'dbnsfp.primateai']],
    ['EVE',                 ['dbnsfp.eve.score', 'dbnsfp.eve']],
    ['ESM1b',               ['dbnsfp.esm1b.score', 'dbnsfp.esm1b']],
    ['CADD phred',          ['dbnsfp.cadd.phred', 'dbnsfp.cadd']],
    ['MetaRNN',             ['dbnsfp.metarnn.score', 'dbnsfp.metarnn']],
    ['gnomAD genome AF',    ['gnomad_genome.af.af', 'gnomad_genome.af']],
    ['gnomAD exome AF',     ['gnomad_exome.af.af', 'gnomad_exome.af']],
    ['1000G AF',            ['1000g.af']],
  ];
  for (const [label, paths] of ROWS) {
    let val: any = null;
    for (const p of paths) {
      val = flatGet(mv, p);
      if (val !== null && val !== undefined) break;
    }
    if (val === null || val === undefined) continue;
    let display: string;
    if (typeof val === 'number') {
      display = Math.abs(val) < 1e-3 || Math.abs(val) >= 1e4 ? val.toExponential(4) : val.toFixed(4);
    } else if (Array.isArray(val)) {
      display = JSON.stringify(val);
    } else {
      display = String(val);
    }
    console.log(`  ${chalk.gray(label.padEnd(22))} ${chalk.white(display)}`);
  }
  console.log(chalk.cyan('═'.repeat(80)));
}

function flatten(mv: MvSingle, prefix = ''): Record<string, any> {
  const out: Record<string, any> = {};
  const seen = new WeakSet<object>();
  function _walk(obj: any, path: string) {
    if (obj === null || obj === undefined) {
      out[path] = obj;
      return;
    }
    if (typeof obj !== 'object') {
      out[path] = obj;
      return;
    }
    if (Array.isArray(obj)) {
      if (obj.length === 0) {
        out[path] = null;
      } else if (typeof obj[0] !== 'object') {
        out[path] = obj.join(';');
      } else {
        out[path] = JSON.stringify(obj).slice(0, 500);
      }
      return;
    }
    if (seen.has(obj)) return;
    seen.add(obj);
    for (const k of Object.keys(obj)) {
      _walk(obj[k], path ? `${path}.${k}` : k);
    }
  }
  _walk(mv, prefix);
  return out;
}

function renderCsv(records: MvSingle[], sep = ','): string {
  // Determine column union across all records (preserve insertion order)
  const cols: string[] = [];
  const seen = new Set<string>();
  const flat: Record<string, any>[] = records.map(r => flatten(r));
  for (const row of flat) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  const esc = (v: any): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (sep === ',' && (s.includes(',') || s.includes('"') || s.includes('\n'))) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [cols.join(sep)];
  for (const row of flat) {
    lines.push(cols.map(c => esc(row[c])).join(sep));
  }
  return lines.join('\n');
}

async function singleMode(id: string, opts: MyVariantOptions): Promise<void> {
  const fields = resolveFieldList(opts);
  const spinner = opts.quiet ? null : ora(`Querying MyVariant.info for ${id}...`).start();
  const url = `${MV_BASE}/variant/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}&dotfield=true`;
  let mv: MvSingle;
  try {
    mv = await mvGet(url);
    if (spinner) spinner.succeed('Fetched');
  } catch (e) {
    if (spinner) spinner.fail((e as Error).message);
    throw e;
  }
  emitOutput([mv], opts, fields);
}

async function batchMode(file: string, opts: MyVariantOptions): Promise<void> {
  const ids = fs.readFileSync(file, 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const fields = resolveFieldList(opts);
  const spinner = opts.quiet ? null : ora(`Batch-querying ${ids.length} IDs from MyVariant.info...`).start();
  let results: MvSingle[];
  try {
    results = await mvPostBatch(ids, fields);
    if (spinner) spinner.succeed(`Fetched ${results.filter(r => !r.notfound).length} of ${ids.length}`);
  } catch (e) {
    if (spinner) spinner.fail((e as Error).message);
    throw e;
  }
  emitOutput(results, opts, fields);
}

async function geneMode(gene: string, opts: MyVariantOptions): Promise<void> {
  const fields = resolveFieldList(opts);
  const limit = parseInt(opts.limit || '500', 10);
  const pageSize = Math.min(limit, 1000);
  const queryExpr = `dbnsfp.genename:${gene} OR clinvar.gene.symbol:${gene} OR snpeff.ann.gene_name:${gene}`;
  const spinner = opts.quiet ? null : ora(`Querying MyVariant.info for gene ${gene} (limit ${limit})...`).start();
  const results: MvSingle[] = [];
  let from = 0;
  try {
    while (results.length < limit) {
      const size = Math.min(pageSize, limit - results.length);
      const url = `${MV_BASE}/query?q=${encodeURIComponent(queryExpr)}&fields=${encodeURIComponent(fields)}&size=${size}&from=${from}&dotfield=true`;
      const page = await mvGet(url);
      const hits = (page && page.hits) || [];
      if (!hits.length) break;
      results.push(...hits);
      from += hits.length;
      if (spinner) spinner.text = `Querying gene ${gene}... ${results.length}/${limit}`;
      if (hits.length < size) break;
      await new Promise(res => setTimeout(res, 200));
    }
    if (spinner) spinner.succeed(`Fetched ${results.length} variants for ${gene}`);
  } catch (e) {
    if (spinner) spinner.fail((e as Error).message);
    throw e;
  }
  emitOutput(results, opts, fields);
}

async function rawQueryMode(query: string, opts: MyVariantOptions): Promise<void> {
  const fields = resolveFieldList(opts);
  const limit = parseInt(opts.limit || '200', 10);
  const url = `${MV_BASE}/query?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}&size=${limit}&dotfield=true`;
  const spinner = opts.quiet ? null : ora(`Running /query: ${query.slice(0, 60)}...`).start();
  let data: any;
  try {
    data = await mvGet(url);
    if (spinner) spinner.succeed(`Fetched ${(data?.hits || []).length} hits`);
  } catch (e) {
    if (spinner) spinner.fail((e as Error).message);
    throw e;
  }
  emitOutput(data?.hits || [], opts, fields);
}

function emitOutput(records: MvSingle[], opts: MyVariantOptions, fields: string): void {
  let payload: string;
  if (opts.json) {
    payload = JSON.stringify(records.length === 1 ? records[0] : records, null, 2);
  } else if (opts.csv) {
    payload = renderCsv(records, ',');
  } else if (opts.tsv) {
    payload = renderCsv(records, '\t');
  } else {
    // Rich-table per record (default)
    for (const r of records) renderSingle(r, fields);
    return;
  }
  if (opts.outFile) {
    fs.writeFileSync(opts.outFile, payload);
    if (!opts.quiet) console.error(chalk.green(`✓ Wrote ${records.length} records to ${opts.outFile}`));
  } else {
    console.log(payload);
  }
}

export async function myvariantCommand(idArg: string | undefined, opts: MyVariantOptions): Promise<void> {
  if (opts.batch) {
    if (!fs.existsSync(opts.batch)) throw new Error(`Batch file not found: ${opts.batch}`);
    return batchMode(opts.batch, opts);
  }
  if (opts.gene) return geneMode(opts.gene, opts);
  if (opts.query && idArg) return rawQueryMode(idArg, opts);
  if (idArg) return singleMode(idArg, opts);
  throw new Error('Pass a HGVS/rsID positional argument, or use --batch <file>, --gene <symbol>, or --query "<expression>"');
}
