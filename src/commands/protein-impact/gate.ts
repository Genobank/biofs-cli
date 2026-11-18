/**
 * Validation gate for protein-impact. NO proband score is produced unless a gate document passes the
 * rules in gate_rules.json, was computed against that exact rules file and the same tool versions, was
 * signed off by the operator, and does not contain the variants being scored. `apply` recomputes the
 * verdict from the metrics; it never trusts the document's own `pass`.
 *
 * Rules (committed before any model was run; the hash is asserted in test/protein-impact.test.ts):
 *   n_pos and n_neg at least 20; pooled AUROC lower CI at least 0.75 and the point estimate at least 0.03 above
 *   the best uncontaminated baseline; propeller and calf AUROC at least 0.70, each with at least 5 variants of
 *   each class; the shuffled-label CI includes 0.5. The scoring has no fitted weights, so there is no
 *   train/test split to leave a domain out of: the pooled AUROC and the per-domain AUROCs are the checks.
 *
 * The gate travels with the apply job as a document; the request carries only its content hash
 * (`gate:sha256:<hex>`), so the document an apply job ran under is exactly the one that was signed.
 */

import rulesJson from './gate_rules.json';
import { SCHEMA_GATE, SCHEMA_GATE_RULES } from './constants';
import { canonicalJson, sha256Hex } from './request';

export interface GateRules {
  schema: string;
  min_pos: number;
  min_neg: number;
  min_auroc_lower_ci: number;
  min_margin_over_best_baseline: number;
  min_domain_auroc: Record<string, number>;
  /** A required domain is only evaluated when it has at least this many variants of each class. */
  min_domain_n: { pos: number; neg: number };
  shuffled_label_ci_must_include: number;
}

export interface Auc { point: number; ci_low: number; ci_high: number }

export interface GateMetrics {
  n_pos: number;
  n_neg: number;
  /** AUROC of the rank-averaged score over the whole benchmark, with a stratified bootstrap 95% CI. */
  pooled_auroc: Auc;
  best_baseline: { name: string; auroc: number };
  domain_auroc: Record<string, number>;
  domain_n: Record<string, { pos: number; neg: number }>;
  shuffled_label: { ci_low: number; ci_high: number };
}

export interface GateDocument {
  schema: string;
  created_at: string;
  rules_sha256: string;
  benchmark_sha256: string;
  tools_lock_sha256: string;
  /** Every variant that was part of the benchmark, one-letter HGVS (e.g. ITGA2B:p.Q778P). */
  benchmark_variants: string[];
  /** The scoring components that were ranked and averaged (e.g. esm2_650m). */
  components?: string[];
  metrics: GateMetrics;
  pass: boolean;
  reasons: string[];
  signed_off?: { by: string; at: string };
}

export interface ApplyExpectations {
  /** The tools lock the apply run is about to use; the gate must have been computed with the same one. */
  tools_lock_sha256?: string;
  /** The one-letter HGVS of every variant the apply run will score; none may be in the benchmark. */
  variants?: string[];
}

export class GateBlockedError extends Error {
  constructor(public reasons: string[]) {
    super(`GATE_BLOCKED: ${reasons.join('; ')}`);
  }
}

export function loadRules(): GateRules {
  const r = rulesJson as unknown as GateRules;
  if (r.schema !== SCHEMA_GATE_RULES) throw new Error('gate_rules.json has the wrong schema');
  return r;
}

export function rulesSha256(rules: GateRules = loadRules()): string {
  return sha256Hex(canonicalJson(rules));
}

/** Content id of a gate document: the hash of its canonical JSON, sign-off included. */
export function gateId(doc: GateDocument): string {
  return `gate:sha256:${sha256Hex(canonicalJson(doc))}`;
}

/** Returns a copy of the document with the operator's sign-off added. */
export function signGate(doc: GateDocument, by: string, at: string): GateDocument {
  return { ...doc, signed_off: { by, at } };
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function evaluateGate(rules: GateRules, m: GateMetrics): { pass: boolean; reasons: string[] } {
  const why: string[] = [];
  if (!num(m.n_pos) || m.n_pos < rules.min_pos) why.push(`n_pos ${m.n_pos} < ${rules.min_pos}`);
  if (!num(m.n_neg) || m.n_neg < rules.min_neg) why.push(`n_neg ${m.n_neg} < ${rules.min_neg}`);
  const lo = m.pooled_auroc?.ci_low;
  if (!num(lo) || lo < rules.min_auroc_lower_ci) why.push(`pooled AUROC lower CI ${lo} < ${rules.min_auroc_lower_ci}`);
  const best = m.best_baseline?.auroc;
  const pt = m.pooled_auroc?.point;
  if (!num(pt) || !num(best) || pt - best < rules.min_margin_over_best_baseline) {
    why.push(`margin over best baseline ${num(pt) && num(best) ? (pt - best).toFixed(3) : 'n/a'} < ${rules.min_margin_over_best_baseline}`);
  }
  for (const [dom, floor] of Object.entries(rules.min_domain_auroc)) {
    const n = m.domain_n?.[dom];
    if (!n || !num(n.pos) || !num(n.neg) || n.pos < rules.min_domain_n.pos || n.neg < rules.min_domain_n.neg) {
      why.push(`${dom} cannot be evaluated: ${n ? `${n.pos} damaging and ${n.neg} tolerated variants` : 'no variants'}, needs ${rules.min_domain_n.pos} and ${rules.min_domain_n.neg}`);
      continue;
    }
    const a = m.domain_auroc?.[dom];
    if (!num(a) || a < floor) why.push(`${dom} AUROC ${a === undefined ? 'missing' : a} < ${floor}`);
  }
  const s = m.shuffled_label;
  const h = rules.shuffled_label_ci_must_include;
  if (!s || !num(s.ci_low) || !num(s.ci_high) || !(s.ci_low <= h && h <= s.ci_high)) {
    why.push(`shuffled-label CI does not include ${h} (the pipeline may be leaking labels)`);
  }
  return { pass: why.length === 0, reasons: why };
}

/** Throws GateBlockedError unless `apply` may run. Recomputes everything it relies on. */
export function verifyGateForApply(
  doc: GateDocument | null | undefined,
  rules: GateRules = loadRules(),
  expect: ApplyExpectations = {},
): void {
  const why: string[] = [];
  if (!doc || doc.schema !== SCHEMA_GATE) throw new GateBlockedError(['no valid gate document']);
  if (doc.rules_sha256 !== rulesSha256(rules)) why.push('gate was computed against different rules than the committed gate_rules.json');
  for (const k of ['benchmark_sha256', 'tools_lock_sha256'] as const) {
    if (typeof doc[k] !== 'string' || !/^[a-f0-9]{64}$/.test(doc[k])) why.push(`${k} missing or malformed`);
  }
  if (expect.tools_lock_sha256 !== undefined && doc.tools_lock_sha256 !== expect.tools_lock_sha256) {
    why.push('gate was computed with different tool versions than this run (re-validate after any change to tools.lock.json)');
  }
  if (!Array.isArray(doc.benchmark_variants) || doc.benchmark_variants.some(x => typeof x !== 'string')) {
    why.push('benchmark_variants missing or malformed');
  } else if (expect.variants) {
    const inBench = new Set(doc.benchmark_variants);
    for (const v of expect.variants) if (inBench.has(v)) why.push(`${v} is part of the validation benchmark, so its score would not be held out (rebuild the benchmark without it and re-validate)`);
  }
  const ev = evaluateGate(rules, doc.metrics);
  if (!ev.pass) why.push(...ev.reasons);
  if (doc.pass !== ev.pass) why.push('document verdict disagrees with its own metrics');
  if (!doc.signed_off || !doc.signed_off.by || !doc.signed_off.at) why.push('not signed off by the operator (milestone G3)');
  if (why.length) throw new GateBlockedError(why);
}
