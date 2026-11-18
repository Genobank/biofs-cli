/**
 * biofs protein-impact: numbering, no-design guard, baseline features, gate logic, request hash, estimate.
 * Uses synthetic identifiers and PUBLISHED GT variants only (Q778P VAR_003982, F222L VAR_030452, Asn2Asp):
 * no proband serial or proband variant appears in this repository.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  SCHEMA_GATE, SCHEMA_REQUEST, GENES,
} from '../src/commands/protein-impact/constants';
import {
  assertResidue, formatVariant, fromMature, NumberingError, parseVariant, structureOffset, toMature,
} from '../src/commands/protein-impact/numbering';
import { GuardError, validateRequest } from '../src/commands/protein-impact/guard';
import { auroc, blosum62, substitutionFeatures } from '../src/commands/protein-impact/features';
import {
  evaluateGate, GateBlockedError, GateDocument, gateId, GateMetrics, loadRules, rulesSha256, signGate, verifyGateForApply,
} from '../src/commands/protein-impact/gate';
import { jobIdFor, requestHash } from '../src/commands/protein-impact/request';
import { ApprovalError, estimate, verifyApproval } from '../src/commands/protein-impact/estimate';

const fasta = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8').split('\n').filter(l => !l.startsWith('>')).join('').trim();
const A = fasta('P08514.fasta'); // ITGA2B, UniProt precursor, 1039 residues
const B = fasta('P05106.fasta'); // ITGB3, 788 residues

const GATE = 'gate:sha256:' + 'a'.repeat(64);
const SOURCE = 'biocid://genobank/0x0000000000000000000000000000000000000001/vcf/abc123def456/sample.vcf';

describe('numbering', () => {
  test('reference sequences have the pinned lengths', () => {
    expect(A.length).toBe(GENES.ITGA2B.length);
    expect(B.length).toBe(GENES.ITGB3.length);
  });

  test('published GT residues sit where the HGVS numbering says (precursor numbering)', () => {
    expect(A[778 - 1]).toBe('Q'); // Q778P, VAR_003982
    expect(A[222 - 1]).toBe('F'); // F222L, VAR_030452
    expect(A[33 - 1]).toBe('N');  // Asn2Asp in mature numbering (Mansour 2011) is precursor 33
  });

  test('parseVariant accepts three-letter and one-letter missense', () => {
    expect(parseVariant('ITGA2B:p.Gln778Pro')).toEqual({ gene: 'ITGA2B', ref: 'Q', pos: 778, alt: 'P' });
    expect(parseVariant('itga2b:p.F222L')).toEqual({ gene: 'ITGA2B', ref: 'F', pos: 222, alt: 'L' });
    expect(parseVariant('ITGA2B:N33D')).toEqual({ gene: 'ITGA2B', ref: 'N', pos: 33, alt: 'D' });
    expect(formatVariant(parseVariant('ITGA2B:p.Q778P'))).toBe('ITGA2B:p.Gln778Pro');
    expect(formatVariant(parseVariant('ITGA2B:p.Gln778Pro'), 'one')).toBe('ITGA2B:p.Q778P');
  });

  test.each([
    ['ITGA2B:p.Gln778Ter', /only missense/],
    ['ITGA2B:p.Gln778fs', /only missense/],
    ['ITGA2B:p.Gln778=', /only missense/],
    ['ITGA2B:p.Gln778Gln', /identical/],
    ['ITGA2B:p.Met1Val', /outside/],
    ['ITGA2B:p.Gln2000Pro', /outside/],
    ['BRCA1:p.Gln778Pro', /not supported/],
    ['p.Gln778Pro', /GENE:/],
  ])('parseVariant rejects %s', (spec, re) => {
    expect(() => parseVariant(spec)).toThrow(re);
  });

  test('mature numbering: alpha-IIb offset is 31 and beta-3 offset is 26 (one global offset would be wrong)', () => {
    expect(toMature('ITGA2B', 778)).toBe(747);
    expect(toMature('ITGA2B', 222)).toBe(191);
    expect(toMature('ITGA2B', 33)).toBe(2);
    expect(toMature('ITGB3', 27)).toBe(1);
    expect(toMature('ITGB3', 100)).toBe(74);
    expect(fromMature('ITGA2B', 2)).toBe(33);
    expect(fromMature('ITGB3', 74)).toBe(100);
    expect(() => toMature('ITGA2B', 31)).toThrow(NumberingError);
    expect(() => toMature('ITGB3', 26)).toThrow(NumberingError);
    expect(() => fromMature('ITGB3', 0)).toThrow(NumberingError);
  });

  test('assertResidue checks the stated reference residue against the pinned sequence', () => {
    expect(() => assertResidue(parseVariant('ITGA2B:p.Gln778Pro'), A)).not.toThrow();
    expect(() => assertResidue(parseVariant('ITGA2B:p.Phe222Leu'), A)).not.toThrow();
    expect(() => assertResidue(parseVariant('ITGA2B:p.Ala778Pro'), A)).toThrow(/has Q/);
    expect(() => assertResidue(parseVariant('ITGA2B:p.Gln778Pro'), A.slice(0, 1000))).toThrow(/expected 1039/);
  });

  test('structureOffset derives the offset from the chain sequence itself', () => {
    expect(structureOffset(A, A.slice(31))).toBe(31);     // mature alpha-IIb chain
    expect(structureOffset(B, B.slice(26))).toBe(26);     // mature beta-3 chain
    expect(structureOffset(A, A.slice(31 + 40, 31 + 400))).toBe(71); // a truncated construct
    expect(structureOffset(A, 'MMMMMMMMMMMMMMMMMMMM')).toBeNull();
    expect(structureOffset(A, 'ACDEF')).toBeNull();
  });
});

describe('request guard (no-design)', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    schema: SCHEMA_REQUEST,
    mode: 'apply',
    serial: '99990000000001',
    sources: [SOURCE],
    targets: [{ gene: 'ITGA2B', uniprot: 'P08514', subs: [{ pos: 778, ref: 'Q', alt: 'P' }, { pos: 222, ref: 'F', alt: 'L' }] }],
    layers: ['features'],
    gate: GATE,
    diagnosis_assumption: 'GT/ITGA2B',
    ...over,
  });
  const publicReq = (mode: string, layers: string[], over: Record<string, unknown> = {}) => ({
    schema: SCHEMA_REQUEST, mode,
    targets: [{ gene: 'ITGA2B', uniprot: 'P08514', subs: [] }, { gene: 'ITGB3', uniprot: 'P05106', subs: [] }],
    layers, ...over,
  });

  test('a normal CPU apply request passes (a gate id made of one repeated hex letter is not a "sequence")', () => {
    expect(validateRequest(base()).targets[0].subs).toHaveLength(2);
  });

  test.each([
    ['unknown top-level field', { note: 'hello' }, /unknown field "note"/],
    ['sequence field', { sequence: 'MAKQ' }, /no-design guard/],
    ['fasta field', { fasta: 'x' }, /no-design guard/],
    ['smiles field', { smiles: 'CCO' }, /no-design guard/],
    ['generation field', { generate: true }, /no-design guard/],
    ['temperature field', { temperature: 1.0 }, /no-design guard/],
    ['protein-like value', { diagnosis_assumption: 'ACDEFGHIKLMNPQRSTVWYACDEFG' }, /looks like a protein sequence/],
    ['lowercase protein-like value', { diagnosis_assumption: 'acdefghiklmnpqrstvwyacdefg' }, /looks like a protein sequence/],
    ['protein-like value hidden in a source biocid', { sources: ['biocid://x/ACDEFGHIKLMNPQRSTVWYACDE'] }, /looks like a protein sequence/],
  ])('rejects %s', (_label, over, re) => {
    expect(() => validateRequest(base(over))).toThrow(re);
  });

  test('rejects nested design-like fields and unknown nested keys', () => {
    const t = [{ gene: 'ITGA2B', uniprot: 'P08514', subs: [{ pos: 778, ref: 'Q', alt: 'P', seq: 'MKQ' }] }];
    expect(() => validateRequest(base({ targets: t }))).toThrow(GuardError);
    const t2 = [{ gene: 'ITGA2B', uniprot: 'P08514', subs: [{ pos: 778, ref: 'Q', alt: 'P', extra: 1 }] }];
    expect(() => validateRequest(base({ targets: t2 }))).toThrow(/unknown field/);
  });

  test('a free sequence smuggled into the gate field is still refused (the hex exemption is only for the strict format)', () => {
    expect(() => validateRequest(base({ gate: 'ACDEFGHIKLMNPQRSTVWYACDEFGHIKLMNPQ' }))).toThrow(/apply requires gate/);
  });

  test('rejects bad substitutions', () => {
    const mk = (s: unknown) => base({ targets: [{ gene: 'ITGA2B', uniprot: 'P08514', subs: [s] }] });
    expect(() => validateRequest(mk({ pos: 778, ref: 'Q', alt: 'Q' }))).toThrow(/must differ/);
    expect(() => validateRequest(mk({ pos: 778, ref: 'Q', alt: 'X' }))).toThrow(/alt must be/);
    expect(() => validateRequest(mk({ pos: 5, ref: 'Q', alt: 'P' }))).toThrow(/pos must be/);
    expect(() => validateRequest(mk({ pos: 1040, ref: 'Q', alt: 'P' }))).toThrow(/pos must be/);
    expect(() => validateRequest(mk({ pos: 778.5, ref: 'Q', alt: 'P' }))).toThrow(/pos must be/);
    expect(() => validateRequest(base({ targets: [{ gene: 'ITGA2B', uniprot: 'P08514', subs: [{ pos: 778, ref: 'Q', alt: 'P' }, { pos: 778, ref: 'Q', alt: 'P' }] }] }))).toThrow(/duplicates/);
  });

  test('rejects unsupported genes, wrong accession, too many genes', () => {
    expect(() => validateRequest(base({ targets: [{ gene: 'TP53', uniprot: 'P04637', subs: [{ pos: 175, ref: 'R', alt: 'H' }] }] }))).toThrow(/not supported/);
    expect(() => validateRequest(base({ targets: [{ gene: 'ITGA2B', uniprot: 'P05106', subs: [{ pos: 778, ref: 'Q', alt: 'P' }] }] }))).toThrow(/uniprot must be P08514/);
    const three = [
      { gene: 'ITGA2B', uniprot: 'P08514', subs: [{ pos: 778, ref: 'Q', alt: 'P' }] },
      { gene: 'ITGB3', uniprot: 'P05106', subs: [{ pos: 100, ref: 'A', alt: 'V' }] },
      { gene: 'ITGB3', uniprot: 'P05106', subs: [{ pos: 101, ref: 'A', alt: 'V' }] },
    ];
    expect(() => validateRequest(base({ targets: three }))).toThrow(/at most 2 genes/);
  });

  test('mode rules: only apply touches a biosample, and apply needs serial, gate and sources', () => {
    expect(() => validateRequest(base({ serial: undefined }))).toThrow(/serial/);
    expect(() => validateRequest(base({ serial: 'x' }))).toThrow(/serial/);
    expect(() => validateRequest(base({ gate: undefined }))).toThrow(/apply requires gate/);
    expect(() => validateRequest(base({ gate: 'biocid://genobank/0x1/gate/abc' }))).toThrow(/apply requires gate/);
    expect(() => validateRequest(base({ sources: undefined }))).toThrow(/apply requires sources/);
    expect(() => validateRequest(base({ sources: ['gs://bucket/file.vcf'] }))).toThrow(/apply requires sources/);
    expect(() => validateRequest(base({ sources: [] }))).toThrow(/apply requires sources/);
    expect(() => validateRequest(base({ sources: [SOURCE, SOURCE, SOURCE, SOURCE, SOURCE] }))).toThrow(/apply requires sources/);

    expect(validateRequest(publicReq('fetch', ['fetch'])).mode).toBe('fetch');
    expect(() => validateRequest(publicReq('fetch', ['fetch'], { serial: '99990000000001' }))).toThrow(/public data only/);
    expect(() => validateRequest(publicReq('fetch', ['fetch'], { gate: GATE }))).toThrow(/gate is only accepted by apply/);
    expect(() => validateRequest(publicReq('fetch', ['fetch'], { sources: [SOURCE] }))).toThrow(/sources are only accepted by apply/);
  });

  test('empty substitution lists are allowed for fetch, probe and validate, never for apply', () => {
    expect(validateRequest(publicReq('fetch', ['fetch'])).targets[0].subs).toEqual([]);
    expect(validateRequest(publicReq('validate', ['features'])).mode).toBe('validate');
    expect(() => validateRequest(base({ targets: [{ gene: 'ITGA2B', uniprot: 'P08514', subs: [] }] }))).toThrow(/subs must be a non-empty array/);
  });

  test('GPU layers need a well-formed approval; CPU layers refuse one', () => {
    expect(() => validateRequest(base({ layers: ['complex'] }))).toThrow(/require approval/);
    expect(() => validateRequest(base({ layers: ['complex'], approval: { estimate_id: 'xyz', max_usd: 10 } }))).toThrow(/16-hex/);
    expect(() => validateRequest(base({ layers: ['complex'], approval: { estimate_id: 'a'.repeat(16), max_usd: 1e6 } }))).toThrow(/max_usd/);
    expect(validateRequest(base({ layers: ['complex'], approval: { estimate_id: 'a'.repeat(16), max_usd: 50 } })).layers).toEqual(['complex']);
    expect(() => validateRequest(base({ approval: { estimate_id: 'a'.repeat(16), max_usd: 50 } }))).toThrow(/only accepted with GPU/);
  });

  test('probe is public and takes exactly its own layer; fetch likewise', () => {
    const ok = { approval: { estimate_id: 'a'.repeat(16), max_usd: 5 } };
    expect(validateRequest(publicReq('probe', ['probe'], ok)).mode).toBe('probe');
    expect(() => validateRequest(publicReq('probe', ['probe'], { ...ok, serial: '99990000000001' }))).toThrow(/public data only/);
    expect(() => validateRequest(publicReq('probe', ['features']))).toThrow(/exactly the layer "probe"/);
    expect(() => validateRequest(publicReq('fetch', ['features']))).toThrow(/exactly the layer "fetch"/);
  });
});

describe('baseline features', () => {
  const AA = 'ARNDCQEGHILKMFPSTWYV';

  test('BLOSUM62 is symmetric and has the textbook diagonal and spot values', () => {
    for (const x of AA) for (const y of AA) expect(blosum62(x, y)).toBe(blosum62(y, x));
    expect([...AA].map(x => blosum62(x, x))).toEqual([4, 5, 6, 6, 9, 5, 5, 6, 8, 4, 4, 5, 5, 6, 7, 4, 5, 11, 7, 4]);
    expect(blosum62('I', 'V')).toBe(3);
    expect(blosum62('D', 'E')).toBe(2);
    expect(blosum62('W', 'C')).toBe(-2);
    expect(blosum62('Q', 'P')).toBe(-1);
    expect(blosum62('F', 'S')).toBe(-2);
  });

  test('substitution features for a published change (Gln778Pro) and a conservative one', () => {
    const f = substitutionFeatures('Q', 'P');
    expect(f.blosum62).toBe(-1);
    expect(f.to_proline).toBe(true);
    expect(f.delta_volume).toBeCloseTo(112.7 - 143.8, 2);
    expect(f.delta_hydropathy).toBeCloseTo(-1.6 - -3.5, 2);
    const g = substitutionFeatures('I', 'V');
    expect(g.blosum62).toBe(3);
    expect(g.to_proline).toBe(false);
    expect(substitutionFeatures('L', 'R').delta_charge).toBe(1);
    expect(substitutionFeatures('D', 'A').delta_charge).toBe(1);
  });

  test('AUROC: perfect, reversed, tied and single-class', () => {
    expect(auroc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auroc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
    expect(auroc([0.5, 0.5, 0.5, 0.5], [1, 1, 0, 0])).toBe(0.5);
    expect(auroc([1, 2], [1, 1])).toBeNaN();
    expect(() => auroc([1], [1, 0])).toThrow();
  });
});

describe('validation gate', () => {
  // The rules are committed before any proband run: changing gate_rules.json must be a deliberate edit
  // of this hash in the same change.
  const COMMITTED_RULES_SHA256 = '87bb822eeef9e1109ba34e71afd23c55e47e91f1f4cbf85c345fb926c87a0ae3';
  const LOCK = 'b'.repeat(64);

  const good = (): GateMetrics => ({
    n_pos: 40, n_neg: 60,
    pooled_auroc: { point: 0.86, ci_low: 0.78, ci_high: 0.93 },
    best_baseline: { name: 'REVEL', auroc: 0.8 },
    domain_auroc: { propeller: 0.84, calf: 0.76 },
    domain_n: { propeller: { pos: 51, neg: 7 }, calf: { pos: 15, neg: 11 } },
    shuffled_label: { ci_low: 0.42, ci_high: 0.58 },
  });
  const doc = (m: GateMetrics, over: Partial<GateDocument> = {}): GateDocument => ({
    schema: SCHEMA_GATE, created_at: '2026-10-21T00:00:00Z',
    rules_sha256: rulesSha256(), benchmark_sha256: 'a'.repeat(64), tools_lock_sha256: LOCK,
    benchmark_variants: ['ITGA2B:p.Q778P', 'ITGA2B:p.F222L', 'ITGB3:p.L196P'],
    metrics: m, pass: evaluateGate(loadRules(), m).pass, reasons: [],
    signed_off: { by: '0x0000000000000000000000000000000000000001', at: '2026-10-21T01:00:00Z' },
    ...over,
  });

  test('the committed rules file has the committed hash', () => {
    expect(rulesSha256()).toBe(COMMITTED_RULES_SHA256);
  });

  test('passes on good metrics', () => {
    expect(evaluateGate(loadRules(), good())).toEqual({ pass: true, reasons: [] });
  });

  test.each([
    ['too few positives', (m: GateMetrics) => { m.n_pos = 19; }, /n_pos 19/],
    ['too few negatives', (m: GateMetrics) => { m.n_neg = 5; }, /n_neg 5/],
    ['lower CI too low', (m: GateMetrics) => { m.pooled_auroc.ci_low = 0.7; }, /lower CI/],
    ['margin too small', (m: GateMetrics) => { m.best_baseline.auroc = 0.84; }, /margin/],
    ['propeller below floor', (m: GateMetrics) => { m.domain_auroc.propeller = 0.65; }, /propeller/],
    ['calf missing', (m: GateMetrics) => { delete m.domain_auroc.calf; }, /calf AUROC missing/],
    ['propeller has too few tolerated variants to evaluate', (m: GateMetrics) => { m.domain_n.propeller.neg = 4; }, /propeller cannot be evaluated: 51 damaging and 4 tolerated/],
    ['calf has no counts at all', (m: GateMetrics) => { delete m.domain_n.calf; }, /calf cannot be evaluated: no variants/],
    ['shuffled labels do not include 0.5', (m: GateMetrics) => { m.shuffled_label = { ci_low: 0.6, ci_high: 0.7 }; }, /shuffled-label/],
    ['NaN metric', (m: GateMetrics) => { m.pooled_auroc.ci_low = NaN; }, /lower CI/],
  ])('fails: %s', (_label, mutate, re) => {
    const m = good(); mutate(m);
    const r = evaluateGate(loadRules(), m);
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' | ')).toMatch(re);
  });

  test('apply accepts a passing, signed, matching document', () => {
    expect(() => verifyGateForApply(doc(good()))).not.toThrow();
    expect(() => verifyGateForApply(doc(good()), loadRules(), { tools_lock_sha256: LOCK, variants: ['ITGA2B:p.A100V'] })).not.toThrow();
  });

  test('apply refuses missing, unsigned, tampered or mismatched documents', () => {
    expect(() => verifyGateForApply(null)).toThrow(GateBlockedError);
    expect(() => verifyGateForApply(doc(good(), { signed_off: undefined }))).toThrow(/not signed off/);
    expect(() => verifyGateForApply(doc(good(), { rules_sha256: 'c'.repeat(64) }))).toThrow(/different rules/);
    expect(() => verifyGateForApply(doc(good(), { benchmark_sha256: 'short' }))).toThrow(/benchmark_sha256/);
    const bad = good(); bad.n_pos = 3;
    expect(() => verifyGateForApply(doc(bad, { pass: true }))).toThrow(/n_pos 3/);          // lies about its own verdict
    expect(() => verifyGateForApply(doc(good(), { pass: false }))).toThrow(/disagrees/);
    expect(() => verifyGateForApply(doc(good(), { schema: 'other' }))).toThrow(/no valid gate document/);
    expect(() => verifyGateForApply(doc(good(), { benchmark_variants: undefined as unknown as string[] }))).toThrow(/benchmark_variants/);
  });

  test('a gate computed with other tool versions cannot clear this run', () => {
    expect(() => verifyGateForApply(doc(good()), loadRules(), { tools_lock_sha256: 'd'.repeat(64) })).toThrow(/different tool versions/);
  });

  test('a variant that is in the validation benchmark is not held out and is refused', () => {
    expect(() => verifyGateForApply(doc(good()), loadRules(), { variants: ['ITGA2B:p.F222L'] })).toThrow(/ITGA2B:p.F222L is part of the validation benchmark/);
  });

  test('the gate id is the hash of the signed document, so any edit changes it', () => {
    const d = doc(good());
    const id = gateId(d);
    expect(id).toMatch(/^gate:sha256:[a-f0-9]{64}$/);
    expect(gateId(doc(good()))).toBe(id);                                              // stable
    expect(gateId(signGate(d, '0x0000000000000000000000000000000000000002', '2026-10-21T02:00:00Z'))).not.toBe(id); // sign-off changes it
    const m2 = good(); m2.n_pos = 41;
    expect(gateId(doc(m2))).not.toBe(id);                                              // metrics change it
  });
});

describe('request hash, job id and estimate', () => {
  const mk = (over: Record<string, unknown> = {}) => validateRequest({
    schema: SCHEMA_REQUEST, mode: 'apply', serial: '99990000000001', sources: [SOURCE],
    targets: [{ gene: 'ITGA2B', uniprot: 'P08514', subs: [{ pos: 778, ref: 'Q', alt: 'P' }, { pos: 222, ref: 'F', alt: 'L' }] }],
    layers: ['features', 'plm'], gate: GATE,
    ...over,
  });

  test('the hash ignores order and approval, and changes with the content', () => {
    const a = mk();
    const b = mk({ layers: ['plm', 'features'], targets: [{ gene: 'ITGA2B', uniprot: 'P08514', subs: [{ pos: 222, ref: 'F', alt: 'L' }, { pos: 778, ref: 'Q', alt: 'P' }] }] });
    expect(requestHash(a)).toBe(requestHash(b));
    const c = mk({ targets: [{ gene: 'ITGA2B', uniprot: 'P08514', subs: [{ pos: 778, ref: 'Q', alt: 'A' }] }] });
    expect(requestHash(a)).not.toBe(requestHash(c));
    const g = mk({ layers: ['complex'], approval: { estimate_id: 'a'.repeat(16), max_usd: 50 } });
    const g2 = mk({ layers: ['complex'], approval: { estimate_id: 'b'.repeat(16), max_usd: 99 } });
    expect(requestHash(g)).toBe(requestHash(g2));
    const s2 = 'biocid://genobank/0x0000000000000000000000000000000000000001/vcf/ffffffffffff/other.vcf';
    expect(requestHash(mk({ sources: [SOURCE, s2] }))).toBe(requestHash(mk({ sources: [s2, SOURCE] })));
    expect(requestHash(mk({ sources: [SOURCE, s2] }))).not.toBe(requestHash(a));
    expect(requestHash(mk({ gate: 'gate:sha256:' + 'c'.repeat(64) }))).not.toBe(requestHash(a));
  });

  test('job id format', () => {
    expect(jobIdFor(mk())).toMatch(/^pi-apply-99990000000001-[a-f0-9]{12}$/);
    expect(jobIdFor(validateRequest({ schema: SCHEMA_REQUEST, mode: 'fetch', targets: [{ gene: 'ITGB3', uniprot: 'P05106', subs: [] }], layers: ['fetch'] })))
      .toMatch(/^pi-fetch-public-[a-f0-9]{12}$/);
  });

  test('CPU estimate is cheap and not a GPU estimate', () => {
    const e = estimate(mk(), new Date('2026-10-21T10:00:00Z'));
    expect(e.gpu).toBe(false);
    expect(e.total_usd).toBeLessThan(10);
    expect(e.estimate_id).toMatch(/^[a-f0-9]{16}$/);
    expect(e.valid_until_utc).toBe('2026-10-21T23:59:59Z');
  });

  test('MD of 2 substitutions x wild type and mutant x 3 replicas x 100 ns is the planned 100 A100-hours', () => {
    const r = mk({ layers: ['md'], approval: { estimate_id: 'a'.repeat(16), max_usd: 500 } });
    const e = estimate(r, new Date('2026-10-21T10:00:00Z'));
    expect(e.gpu).toBe(true);
    expect(e.lines.find(l => l.layer === 'md')!.hours).toBeCloseTo(100, 1);
    expect(e.lines.find(l => l.layer === 'startup')!.hours).toBe(0.5);   // a stopped executor has to boot first
    expect(e.total_usd).toBeCloseTo(367 + 1.84, 1);
  });

  test('a validate request with no substitutions is priced on the benchmark size, not on zero', () => {
    const v = validateRequest({ schema: SCHEMA_REQUEST, mode: 'validate', targets: [{ gene: 'ITGA2B', uniprot: 'P08514', subs: [] }], layers: ['plm'] });
    const e = estimate(v, new Date('2026-10-21T10:00:00Z'));
    expect(e.lines[0].hours).toBeCloseTo(0.5 + (200 * 20) / 3600, 2);
  });

  test('approval must match a fresh estimate of the same request on the same UTC day', () => {
    const now = new Date('2026-10-21T10:00:00Z');
    const bare = mk({ layers: ['complex'], approval: { estimate_id: 'a'.repeat(16), max_usd: 500 } });
    const est = estimate(bare, now);
    const ok = mk({ layers: ['complex'], approval: { estimate_id: est.estimate_id, max_usd: Math.ceil(est.total_usd) } });
    expect(() => verifyApproval(ok, now)).not.toThrow();
    expect(() => verifyApproval(bare, now)).toThrow(ApprovalError);                                   // wrong id
    const low = mk({ layers: ['complex'], approval: { estimate_id: est.estimate_id, max_usd: 0.01 } });
    expect(() => verifyApproval(low, now)).toThrow(/below the estimated total/);
    expect(() => verifyApproval(ok, new Date('2026-10-22T00:00:01Z'))).toThrow(/expire/);              // next UTC day
    expect(() => verifyApproval(mk(), now)).not.toThrow();                                            // CPU-only needs none
  });
});
