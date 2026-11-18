/**
 * Statistics for the validation gate. Deterministic (seeded) and dependency free.
 *
 * The score under test has no fitted weights: the components are oriented so that a higher number means
 * "more likely damaging" and are combined by averaging their ranks. So there is no train/test split to leave a
 * domain out of; the checks are the pooled AUROC with a stratified bootstrap interval, the AUROC inside each
 * structural domain, the comparison with simple baselines, and a permutation null as a sanity check of the
 * evaluation code itself.
 */

import { auroc, substitutionFeatures } from './features';
import { Auc, GateMetrics } from './gate';
import type { BenchRow } from './benchmark';

export const GATE_SEED = 20261021;
export const BOOTSTRAP_B = 2000;
export const PERMUTATION_B = 1000;

const round = (x: number) => Math.round(x * 10000) / 10000;

/** Small seeded PRNG (mulberry32): the same seed always gives the same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Average ranks (1 = smallest); ties share their mean rank. */
export function ranks(values: number[]): number[] {
  const idx = values.map((v, i) => [v, i] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const mean = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = mean;
    i = j + 1;
  }
  return out;
}

/** Rank-average of oriented components (each: higher = more damaging). No weights are learned. */
export function rankAverage(components: number[][]): number[] {
  if (components.length === 0) throw new Error('no components to combine');
  const n = components[0].length;
  const rs = components.map(c => {
    if (c.length !== n) throw new Error('components differ in length');
    if (c.some(v => !Number.isFinite(v))) throw new Error('a component holds a non-finite score');
    return ranks(c);
  });
  return Array.from({ length: n }, (_, i) => rs.reduce((a, r) => a + r[i], 0) / rs.length);
}

const percentile = (sorted: number[], p: number) => {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/** AUROC with a bootstrap 95% interval; resampling is stratified by (stratum, label) so every domain keeps its size. */
export function pooledAuroc(scores: number[], labels: number[], strata: string[], B = BOOTSTRAP_B, seed = GATE_SEED): Auc {
  const point = auroc(scores, labels);
  const cells = new Map<string, number[]>();
  labels.forEach((l, i) => {
    const k = `${strata[i]}|${l}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k)!.push(i);
  });
  const rnd = mulberry32(seed);
  const draws: number[] = [];
  for (let b = 0; b < B; b++) {
    const s: number[] = [], l: number[] = [];
    for (const members of cells.values()) {
      for (let k = 0; k < members.length; k++) {
        const i = members[Math.floor(rnd() * members.length)];
        s.push(scores[i]); l.push(labels[i]);
      }
    }
    const a = auroc(s, l);
    if (Number.isFinite(a)) draws.push(a);
  }
  draws.sort((x, y) => x - y);
  return { point: round(point), ci_low: round(percentile(draws, 0.025)), ci_high: round(percentile(draws, 0.975)) };
}

/** AUROC under randomly permuted labels: a sanity check of the evaluation, centred on 0.5. */
export function permutationNull(scores: number[], labels: number[], B = PERMUTATION_B, seed = GATE_SEED + 1): { ci_low: number; ci_high: number } {
  const rnd = mulberry32(seed);
  const draws: number[] = [];
  const perm = [...labels];
  for (let b = 0; b < B; b++) {
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const a = auroc(scores, perm);
    if (Number.isFinite(a)) draws.push(a);
  }
  draws.sort((x, y) => x - y);
  return { ci_low: round(percentile(draws, 0.025)), ci_high: round(percentile(draws, 0.975)) };
}

export function perDomain(scores: number[], labels: number[], domains: string[]): Record<string, { auroc: number | null; pos: number; neg: number }> {
  const groups = new Map<string, number[]>();
  domains.forEach((d, i) => {
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push(i);
  });
  const res: Record<string, { auroc: number | null; pos: number; neg: number }> = {};
  for (const [d, idx] of groups) {
    const l = idx.map(i => labels[i]);
    const a = auroc(idx.map(i => scores[i]), l);
    res[d] = { auroc: Number.isFinite(a) ? round(a) : null, pos: l.filter(x => x === 1).length, neg: l.filter(x => x === 0).length };
  }
  return res;
}

/**
 * Domain prior: the share of damaging variants in the variant's own domain, computed on the benchmark itself. This
 * is deliberately optimistic (it has seen the labels), so it is an upper bound for any score that only knows which
 * domain a variant is in; the model has to beat it, not just chance. (A leave-one-out version is anti-informative
 * inside a domain by construction, so it would be a bad bar.)
 */
export function domainPrior(labels: number[], domains: string[]): number[] {
  const tot = new Map<string, number>(), pos = new Map<string, number>();
  domains.forEach((d, i) => { tot.set(d, (tot.get(d) ?? 0) + 1); pos.set(d, (pos.get(d) ?? 0) + labels[i]); });
  return domains.map(d => (pos.get(d) ?? 0) / (tot.get(d) ?? 1));
}

/** Uncontaminated baselines: nothing here was trained on ClinVar. Higher = more damaging. */
export function baselineScores(rows: BenchRow[]): Record<string, number[]> {
  const f = rows.map(r => substitutionFeatures(r.ref, r.alt));
  return {
    blosum62: f.map(x => -x.blosum62),
    hydropathy_change: f.map(x => Math.abs(x.delta_hydropathy)),
    volume_change: f.map(x => Math.abs(x.delta_volume)),
    domain_prior: domainPrior(rows.map(r => r.label), rows.map(r => r.domain)),
  };
}

/** Everything the gate rules read, from the benchmark rows and the combined score under test. */
export function assembleMetrics(rows: BenchRow[], ensemble: number[], baselines: Record<string, number[]> = baselineScores(rows)): GateMetrics {
  const labels = rows.map(r => r.label);
  const domains = rows.map(r => r.domain);
  const base = Object.entries(baselines).map(([name, s]) => ({ name, auroc: round(auroc(s, labels)) }));
  const best = base.reduce((a, b) => (b.auroc > a.auroc ? b : a));
  const dom = perDomain(ensemble, labels, domains);
  const domain_auroc: Record<string, number> = {};
  const domain_n: Record<string, { pos: number; neg: number }> = {};
  for (const [d, v] of Object.entries(dom)) {
    domain_n[d] = { pos: v.pos, neg: v.neg };
    if (v.auroc !== null) domain_auroc[d] = v.auroc;
  }
  return {
    n_pos: labels.filter(l => l === 1).length,
    n_neg: labels.filter(l => l === 0).length,
    pooled_auroc: pooledAuroc(ensemble, labels, domains),
    best_baseline: best,
    domain_auroc,
    domain_n,
    shuffled_label: permutationNull(ensemble, labels),
  };
}
