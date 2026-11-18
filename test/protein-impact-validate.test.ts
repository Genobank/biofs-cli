/**
 * biofs protein-impact: the benchmark, the gate statistics and validate mode. Scores are synthetic: a fake
 * scorer stands in for the language model, so what is tested is the mechanics and the gate logic, not biology.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EXIT, SCHEMA_REQUEST } from '../src/commands/protein-impact/constants';
import { Benchmark, benchmarkSubs, loadBenchmark, validateBenchmark } from '../src/commands/protein-impact/benchmark';
import { domainNames, domainOf } from '../src/commands/protein-impact/domains';
import {
  baselineScores, domainPrior, mulberry32, pooledAuroc, permutationNull, perDomain, rankAverage, ranks, assembleMetrics,
} from '../src/commands/protein-impact/metrics';
import { auroc } from '../src/commands/protein-impact/features';
import { evaluateGate, loadRules, rulesSha256 } from '../src/commands/protein-impact/gate';
import { validateRequest, GuardError } from '../src/commands/protein-impact/guard';
import { ExecDeps, Fetcher, StageInput, StageOutput, StageRunner, Storage, runProteinImpact } from '../src/commands/protein-impact/core';
import { jobIdFor } from '../src/commands/protein-impact/request';
import { loadToolsLock, toolsLockSha256 } from '../src/commands/protein-impact/tools_lock';

const fastaText = (acc: string) => fs.readFileSync(path.join(__dirname, 'fixtures', `${acc}.fasta`), 'utf8');
const bench = loadBenchmark();

describe('domains', () => {
  test('published variants land in the domains the structure says', () => {
    expect(domainOf('ITGA2B', 778)).toBe('calf');       // Q778P, mature 747, calf-2
    expect(domainOf('ITGA2B', 222)).toBe('propeller');  // F222L, mature 191
    expect(domainOf('ITGA2B', 33)).toBe('propeller');   // N33D, mature 2
    expect(domainOf('ITGB3', 59)).toBe('PSI');          // Leu59Pro, HPA-1, mature Leu33
    expect(domainOf('ITGB3', 200)).toBe('betaI');
    expect(domainOf('ITGB3', 730)).toBe('tm');
    expect(domainOf('ITGA2B', 1030)).toBe('cytoplasmic');
  });

  test('domain edges: no gaps, no overlaps, and the mature chain is covered end to end', () => {
    for (const [gene, first, last] of [['ITGA2B', 32, 1039], ['ITGB3', 27, 788]] as const) {
      let prev = '';
      for (let p = first; p <= last; p++) {
        const d = domainOf(gene, p);
        expect(d).toBeTruthy();
        prev = d;
      }
      expect(prev).toBeTruthy();
      expect(() => domainOf(gene, first - 1)).toThrow(/outside the domain table/);
      expect(() => domainOf(gene, last + 1)).toThrow(/outside the domain table/);
    }
    expect(domainNames()).toEqual(expect.arrayContaining(['propeller', 'calf', 'betaI', 'PSI']));
  });
});

describe('benchmark', () => {
  test('is consistent with itself and with the pinned sequences', () => {
    const seqs = {
      ITGA2B: fastaText('P08514').split('\n').filter(l => !l.startsWith('>')).join('').trim(),
      ITGB3: fastaText('P05106').split('\n').filter(l => !l.startsWith('>')).join('').trim(),
    };
    expect(validateBenchmark(bench, seqs)).toEqual([]);
  });

  test('is frozen: size, classes, hash, and enough variants in the required domains', () => {
    expect(bench.rows).toHaveLength(168);
    expect(bench.rows.filter(r => r.label === 1)).toHaveLength(131);
    expect(bench.rows.filter(r => r.label === 0)).toHaveLength(37);
    expect(bench.tsv_sha256).toBe('831a1f836136add44824976b290ae7a14572da155bb210581ab0f3da4951a60e');
    const rules = loadRules();
    const count = (dom: string, label: number) => bench.rows.filter(r => r.domain === dom && r.label === label).length;
    for (const dom of Object.keys(rules.min_domain_auroc)) {
      expect(count(dom, 1)).toBeGreaterThanOrEqual(rules.min_domain_n.pos);
      expect(count(dom, 0)).toBeGreaterThanOrEqual(rules.min_domain_n.neg);
    }
  });

  test('labels follow the written rules', () => {
    for (const r of bench.rows) {
      if (r.label === 1) expect(r.evidence).toBe('clinvar_plp');
      if (r.label === 0) expect(r.evidence).toMatch(/^(clinvar_blb|gnomad_af|gnomad_hom)/);
      if (r.evidence === 'gnomad_af') expect(r.gnomad_af!).toBeGreaterThanOrEqual(0.001);
      if (r.evidence === 'gnomad_hom') { expect(r.gnomad_hom!).toBeGreaterThanOrEqual(1); expect(r.gnomad_af!).toBeGreaterThan(0); }
    }
  });

  test('a corrupted benchmark is caught', () => {
    const bad: Benchmark = { ...bench, rows: bench.rows.map((r, i) => (i === 0 ? { ...r, ref: r.ref === 'A' ? 'C' : 'A' } : r)) };
    expect(validateBenchmark(bad).join(' ')).toMatch(/id does not match its fields/);
    const dup: Benchmark = { ...bench, rows: [...bench.rows, bench.rows[3]] };
    expect(validateBenchmark(dup).join(' ')).toMatch(/listed twice/);
    const dom: Benchmark = { ...bench, rows: bench.rows.map((r, i) => (i === 0 ? { ...r, domain: 'calf' } : r)) };
    expect(validateBenchmark(dom).join(' ')).toMatch(/disagrees with the domain table/);
    const seq = { ITGA2B: 'A'.repeat(1039) };
    expect(validateBenchmark(bench, seq).join(' ')).toMatch(/the pinned sequence has A/);
  });

  test('benchmarkSubs gives the stage inputs with mature numbering, optionally per gene', () => {
    const all = benchmarkSubs(bench);
    expect(all).toHaveLength(168);
    const q = all.find(s => s.variant === 'ITGA2B:p.Asn33Asp')!;
    expect(q.mature_pos).toBe(2);
    expect(benchmarkSubs(bench, ['ITGB3']).every(s => s.gene === 'ITGB3')).toBe(true);
  });
});

describe('statistics', () => {
  test('the PRNG is deterministic and well spread', () => {
    const a = mulberry32(7), b = mulberry32(7), c = mulberry32(8);
    const xs = Array.from({ length: 5 }, () => a()), ys = Array.from({ length: 5 }, () => b()), zs = Array.from({ length: 5 }, () => c());
    expect(xs).toEqual(ys);
    expect(xs).not.toEqual(zs);
    const big = mulberry32(1);
    const m = Array.from({ length: 20000 }, () => big()).reduce((x, y) => x + y, 0) / 20000;
    expect(m).toBeGreaterThan(0.49); expect(m).toBeLessThan(0.51);
  });

  test('ranks share tie ranks and rankAverage combines oriented components without weights', () => {
    expect(ranks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
    expect(rankAverage([[1, 2, 3], [3, 2, 1]])).toEqual([2, 2, 2]);
    expect(rankAverage([[1, 2, 3]])).toEqual([1, 2, 3]);
    expect(() => rankAverage([])).toThrow();
    expect(() => rankAverage([[1, 2], [1]])).toThrow(/differ in length/);
    expect(() => rankAverage([[1, NaN]])).toThrow(/non-finite/);
  });

  const labels = Array.from({ length: 60 }, (_, i) => (i < 20 ? 1 : 0));
  const strata = labels.map((_, i) => (i % 2 ? 'a' : 'b'));
  const rnd = mulberry32(3);
  const noisy = labels.map(l => l * 1.2 + rnd());

  test('the bootstrap interval brackets the point estimate and is reproducible', () => {
    const r1 = pooledAuroc(noisy, labels, strata, 400, 11);
    const r2 = pooledAuroc(noisy, labels, strata, 400, 11);
    expect(r1).toEqual(r2);
    expect(r1.ci_low).toBeLessThanOrEqual(r1.point);
    expect(r1.ci_high).toBeGreaterThanOrEqual(r1.point);
    expect(r1.point).toBeCloseTo(auroc(noisy, labels), 3);
    expect(r1.ci_low).toBeGreaterThan(0.5);
  });

  test('the permutation null is centred on one half whatever the scores are', () => {
    const n = permutationNull(noisy, labels, 500, 5);
    expect(n.ci_low).toBeLessThan(0.5); expect(n.ci_high).toBeGreaterThan(0.5);
    const perfect = permutationNull(labels.map(Number), labels, 500, 5);
    expect(perfect.ci_low).toBeLessThan(0.5); expect(perfect.ci_high).toBeGreaterThan(0.5);
  });

  test('per-domain AUROC reports counts and null when a domain has one class only', () => {
    const r = perDomain([3, 2, 1, 0.5, 9], [1, 0, 1, 0, 1], ['p', 'p', 'p', 'p', 'only']);
    expect(r.p).toEqual({ auroc: 0.75, pos: 2, neg: 2 });
    expect(r.only).toEqual({ auroc: null, pos: 1, neg: 0 });
  });

  test('the domain prior is the in-sample share and carries no information inside a domain', () => {
    const l = [1, 1, 0, 0, 1], d = ['x', 'x', 'x', 'y', 'y'];
    const s = domainPrior(l, d);
    expect(s[0]).toBeCloseTo(2 / 3); expect(s[3]).toBeCloseTo(0.5);
    expect(perDomain(s, l, d).x.auroc).toBe(0.5);
  });

  test('baselines on the frozen benchmark are the bar to beat (recorded 2026-10-21, before any model was run)', () => {
    const labelsB = bench.rows.map(r => r.label);
    const bs = baselineScores(bench.rows);
    const a = Object.fromEntries(Object.entries(bs).map(([k, v]) => [k, auroc(v, labelsB)]));
    expect(a.blosum62).toBeCloseTo(0.718, 2);
    expect(a.domain_prior).toBeCloseTo(0.712, 2);
    expect(Math.max(...Object.values(a))).toBeLessThan(0.75);
  });

  test('assembleMetrics: a perfect score passes the gate and a coin flip does not', () => {
    const rules = loadRules();
    const perfect = assembleMetrics(bench.rows, bench.rows.map(r => r.label + 0.001 * (r.pos % 7)));
    expect(perfect.pooled_auroc.point).toBeGreaterThan(0.99);
    expect(evaluateGate(rules, perfect)).toEqual({ pass: true, reasons: [] });
    const r = mulberry32(99);
    const coin = assembleMetrics(bench.rows, bench.rows.map(() => r()));
    const verdict = evaluateGate(rules, coin);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/pooled AUROC lower CI/);
  });

  test('a score that is only the domain label cannot pass: it does not beat the domain-prior baseline', () => {
    const prior = domainPrior(bench.rows.map(r => r.label), bench.rows.map(r => r.domain));
    const m = assembleMetrics(bench.rows, prior);
    const verdict = evaluateGate(loadRules(), m);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/margin over best baseline/);
  });
});

// ---- validate mode through the orchestrator --------------------------------------------------

class MemStorage implements Storage {
  files = new Map<string, string>();
  readText(uri: string) { return this.files.has(uri) ? this.files.get(uri)! : null; }
  writeText(uri: string, text: string) { this.files.set(uri, text); }
  copyIn(localPath: string, uri: string) { this.files.set(uri, fs.readFileSync(localPath, 'utf8')); }
}
const fetcher: Fetcher = { get: async url => {
  const acc = /uniprotkb\/(\w+)\.fasta/.exec(url)![1];
  return Buffer.from(fastaText(acc));
} };
const lock = loadToolsLock();
const NOW = new Date('2026-10-21T10:00:00Z');
const CREATOR = '0x0000000000000000000000000000000000000001';

const validateRaw = (layers = ['plm']) => ({
  schema: SCHEMA_REQUEST, mode: 'validate',
  targets: [{ gene: 'ITGA2B', uniprot: 'P08514', subs: [] }, { gene: 'ITGB3', uniprot: 'P05106', subs: [] }],
  layers,
});
const argsFor = (raw: Record<string, unknown>) => ({
  jobId: jobIdFor(validateRequest(raw)), creator: CREATOR, outBucket: 'genobank-parabricks-output', refBucket: 'genobank-references', request: raw, workDir: '/tmp/pi-validate-test',
});
/** A scorer that knows the labels: llr is low for damaging variants, plus noise. */
function informedRunner(noise: number): StageRunner {
  const labelOf = new Map(bench.rows.map(r => [`${r.gene}:p.${r.ref}${r.pos}${r.alt}`, r.label]));
  const rnd = mulberry32(42);
  return { run: async (input: StageInput): Promise<StageOutput> => ({
    records: input.subs.map(s => {
      const key = `${s.gene}:p.${s.ref}${s.pos}${s.alt}`;
      return { variant: s.variant, esm2_650m: { llr: -4 * (labelOf.get(key) ?? 0) + noise * (rnd() - 0.5) } };
    }),
  }) };
}
const deps = (runner: StageRunner): ExecDeps & { storage: MemStorage } => ({ storage: new MemStorage(), fetcher, runner, now: () => NOW, lock }) as any;

describe('validate mode', () => {
  test('rejects substitutions: the benchmark supplies them', () => {
    const raw = validateRaw();
    (raw.targets[0].subs as unknown[]).push({ pos: 778, ref: 'Q', alt: 'P' });
    expect(() => validateRequest(raw)).toThrow(GuardError);
    expect(() => validateRequest(raw)).toThrow(/takes no substitutions/);
  });

  test('scores all 168 benchmark variants, writes an unsigned gate document, and a good scorer passes', async () => {
    const d = deps(informedRunner(2));
    const res = await runProteinImpact(argsFor(validateRaw()), d);
    expect(res.status).toBe('OK');
    expect(res.exit).toBe(EXIT.OK);
    const m = res.manifest!;
    expect(m.results).toHaveLength(168);
    const doc = m.gate_document!;
    expect(doc.pass).toBe(true);
    expect(doc.reasons).toEqual([]);
    expect(doc.signed_off).toBeUndefined();
    expect(doc.benchmark_sha256).toBe(bench.sha256);
    expect(doc.tools_lock_sha256).toBe(toolsLockSha256(lock));
    expect(doc.rules_sha256).toBe(rulesSha256());
    expect(doc.components).toEqual(['esm2_650m']);
    expect(doc.benchmark_variants).toHaveLength(168);
    expect(doc.benchmark_variants).toContain('ITGA2B:p.N33D');
    expect(doc.metrics.n_pos).toBe(131);
    expect(doc.metrics.domain_n.propeller).toEqual({ pos: 51, neg: 7 });
    expect(JSON.parse(d.storage.readText(`${m.folder}/gate.json`)!)).toEqual(doc);
  });

  test('a scorer that cannot separate the classes yields a failing gate document, and the job still succeeds', async () => {
    const rnd = mulberry32(5);
    const useless: StageRunner = { run: async i => ({ records: i.subs.map(s => ({ variant: s.variant, esm2_650m: { llr: rnd() } })) }) };
    const res = await runProteinImpact(argsFor(validateRaw()), deps(useless));
    expect(res.status).toBe('OK');
    expect(res.manifest!.gate_document!.pass).toBe(false);
    expect(res.manifest!.gate_document!.reasons.length).toBeGreaterThan(0);
  });

  test('a scorer that returns nothing for a benchmark variant fails the job instead of guessing', async () => {
    const partial: StageRunner = { run: async i => ({ records: i.subs.slice(1).map(s => ({ variant: s.variant, esm2_650m: { llr: -1 } })) }) };
    const res = await runProteinImpact(argsFor(validateRaw()), deps(partial));
    expect(res.status).toBe('FAILED');
    expect(res.manifest!.errors.join(' ')).toMatch(/gave no score for/);
    expect(res.manifest!.gate_document).toBeNull();
  });

  test('validate with no scoring layer cannot produce a gate', async () => {
    const res = await runProteinImpact(argsFor(validateRaw(['features'])), deps(informedRunner(1)));
    expect(res.status).toBe('FAILED');
    expect(res.manifest!.errors.join(' ')).toMatch(/needs a scoring layer/);
  });

  test('the same request twice reuses the cached scores and writes an identical gate document', async () => {
    const storage = new MemStorage();
    const run1 = await runProteinImpact(argsFor(validateRaw()), { ...deps(informedRunner(2)), storage } as ExecDeps);
    let calls = 0;
    const counting: StageRunner = { run: async i => { calls++; return informedRunner(2).run(i); } };
    const run2 = await runProteinImpact(argsFor(validateRaw()), { ...deps(counting), storage } as ExecDeps);
    expect(calls).toBe(0);
    expect(run2.manifest!.gate_document!.metrics).toEqual(run1.manifest!.gate_document!.metrics);
  });
});
