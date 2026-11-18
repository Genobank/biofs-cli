/**
 * biofs protein-impact: orchestrator (guard -> approval -> gate -> cached stages -> manifest), tools lock,
 * storage, and the client-side request builders. Storage, network and the heavy stages are fakes, so no
 * cloud call is made. Published GT variants and synthetic identifiers only.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EXIT, SCHEMA_GATE, SCHEMA_REQUEST } from '../src/commands/protein-impact/constants';
import {
  ExecDeps, Fetcher, StageInput, StageOutput, StageRunner, Storage, ensureSequences, jobFolder, parseFasta, runProteinImpact,
} from '../src/commands/protein-impact/core';
import { estimate } from '../src/commands/protein-impact/estimate';
import { GateDocument, gateId, GateMetrics, rulesSha256, signGate } from '../src/commands/protein-impact/gate';
import { validateRequest } from '../src/commands/protein-impact/guard';
import { jobIdFor } from '../src/commands/protein-impact/request';
import {
  ToolsLock, ToolsLockError, imageForLayer, loadToolsLock, modelRevision, toolsLockSha256,
} from '../src/commands/protein-impact/tools_lock';
import { LocalStorage } from '../src/commands/protein-impact/exec';
import {
  buildApplyRequest, buildFetchRequest, buildJobSpec, buildProbeRequest, buildValidateRequest, carrierMatches, groupTargets, parseGenes, parseLayers, renderEstimate,
} from '../src/commands/protein-impact/submit';

const FASTA_DIR = path.join(__dirname, 'fixtures');
const fastaText = (acc: string) => fs.readFileSync(path.join(FASTA_DIR, `${acc}.fasta`), 'utf8');
const NOW = new Date('2026-10-21T10:00:00Z');
const CREATOR = '0x0000000000000000000000000000000000000001';
const SOURCE = 'biocid://genobank/0x0000000000000000000000000000000000000001/vcf/abc123def456/99990000000001.sample.vcf';

class MemStorage implements Storage {
  files = new Map<string, string>();
  readText(uri: string) { return this.files.has(uri) ? this.files.get(uri)! : null; }
  writeText(uri: string, text: string) { this.files.set(uri, text); }
  copyIn(localPath: string, uri: string) { this.files.set(uri, fs.readFileSync(localPath, 'utf8')); }
}
class FakeFetcher implements Fetcher {
  calls: string[] = [];
  constructor(private texts: Record<string, string> = { P08514: fastaText('P08514'), P05106: fastaText('P05106') }) {}
  async get(url: string) {
    this.calls.push(url);
    const acc = /uniprotkb\/(\w+)\.fasta/.exec(url)?.[1];
    if (!acc || !this.texts[acc]) throw new Error(`404 ${url}`);
    return Buffer.from(this.texts[acc]);
  }
}
class FakeRunner implements StageRunner {
  calls: StageInput[] = [];
  constructor(private impl?: (i: StageInput) => StageOutput) {}
  async run(input: StageInput) {
    this.calls.push(input);
    return this.impl ? this.impl(input) : { records: input.subs.map(s => ({ variant: s.variant, llr: -3.2 })) };
  }
}

const lock = loadToolsLock();
const LOCK = toolsLockSha256(lock);
const metrics = (): GateMetrics => ({
  n_pos: 40, n_neg: 60,
  pooled_auroc: { point: 0.86, ci_low: 0.78, ci_high: 0.93 },
  best_baseline: { name: 'REVEL', auroc: 0.8 },
  domain_auroc: { propeller: 0.84, calf: 0.76 },
  domain_n: { propeller: { pos: 51, neg: 7 }, calf: { pos: 15, neg: 11 } },
  shuffled_label: { ci_low: 0.42, ci_high: 0.58 },
});
const unsignedGate = (over: Partial<GateDocument> = {}): GateDocument => ({
  schema: SCHEMA_GATE, created_at: '2026-10-21T00:00:00Z', rules_sha256: rulesSha256(), benchmark_sha256: 'a'.repeat(64),
  tools_lock_sha256: LOCK, benchmark_variants: ['ITGA2B:p.N33D', 'ITGB3:p.L196P'], metrics: metrics(), pass: true, reasons: [], ...over,
});
const gateDoc = (over: Partial<GateDocument> = {}): GateDocument => signGate(unsignedGate(over), CREATOR, '2026-10-21T01:00:00Z');

const SUBS = [{ pos: 778, ref: 'Q', alt: 'P' }, { pos: 222, ref: 'F', alt: 'L' }];
const applyRaw = (g: GateDocument, over: Record<string, unknown> = {}) => ({
  schema: SCHEMA_REQUEST, mode: 'apply', serial: '99990000000001', sources: [SOURCE],
  targets: [{ gene: 'ITGA2B', uniprot: 'P08514', subs: SUBS }],
  layers: ['features'], gate: gateId(g), ...over,
});
const argsFor = (raw: Record<string, unknown>, gate?: unknown, jobId?: string) => ({
  jobId: jobId ?? jobIdFor(validateRequest(raw)),
  creator: CREATOR, outBucket: 'genobank-parabricks-output', refBucket: 'genobank-references',
  request: raw, gate, workDir: '/tmp/pi-test',
});
const deps = (over: Partial<ExecDeps> = {}) => ({
  storage: new MemStorage(), fetcher: new FakeFetcher(), runner: new FakeRunner(), now: () => NOW, lock, ...over,
}) as ExecDeps & { storage: MemStorage; fetcher: FakeFetcher; runner: FakeRunner };

describe('orchestrator', () => {
  test('a CPU apply job runs the numbering check and the baseline features, and writes the manifest', async () => {
    const g = gateDoc();
    const d = deps();
    const res = await runProteinImpact(argsFor(applyRaw(g), g), d);
    expect(res.exit).toBe(EXIT.OK);
    expect(res.status).toBe('OK');
    const folder = jobFolder({ outBucket: 'genobank-parabricks-output', creator: CREATOR, jobId: res.manifest!.jobId });
    const m = JSON.parse(d.storage.readText(`${folder}/manifest.json`)!);
    expect(m.status).toBe('OK');
    expect(m.research_banner).toMatch(/Not a clinical test/);
    expect(m.gate.id).toBe(gateId(g));
    expect(m.stages.map((s: any) => [s.layer, s.status])).toEqual([['features', 'done']]);
    const q778p = m.results.find((r: any) => r.variant === 'ITGA2B:p.Gln778Pro');
    expect(q778p.mature_pos).toBe(747);
    expect(q778p.layers.features.blosum62).toBe(-1);
    expect(q778p.layers.features.ref_residue_checked).toBe(true);
    expect(d.storage.readText('gs://genobank-references/protein/uniprot/P08514/e85172b63418.fasta')).toMatch(/^>sp\|P08514/);
    expect(d.fetcher.calls).toEqual(['https://rest.uniprot.org/uniprotkb/P08514.fasta']);
    expect(d.runner.calls).toHaveLength(0);
  });

  test('an identical request does zero compute: stages are cached and nothing is fetched again', async () => {
    const g = gateDoc();
    const storage = new MemStorage();
    await runProteinImpact(argsFor(applyRaw(g), g), deps({ storage }));
    const d2 = deps({ storage });
    const res = await runProteinImpact(argsFor(applyRaw(g), g), d2);
    expect(res.status).toBe('OK');
    expect(res.manifest!.stages.map(s => s.status)).toEqual(['cached']);
    expect(d2.fetcher.calls).toHaveLength(0);
    expect(d2.runner.calls).toHaveLength(0);
  });

  test('a corrupted cache entry is recomputed, not trusted', async () => {
    const g = gateDoc();
    const storage = new MemStorage();
    const first = await runProteinImpact(argsFor(applyRaw(g), g), deps({ storage }));
    const folder = first.manifest!.folder;
    storage.writeText(`${folder}/stages/features/out.json`, '{"records":[]}'); // bytes no longer match the DONE marker
    const res = await runProteinImpact(argsFor(applyRaw(g), g), deps({ storage }));
    expect(res.manifest!.stages.map(s => s.status)).toEqual(['done']);
    expect(res.manifest!.results[0].layers.features).toBeDefined();
  });

  test('no gate document: GATE_BLOCKED, nothing runs, no scores are written', async () => {
    const g = gateDoc();
    const d = deps();
    const res = await runProteinImpact(argsFor(applyRaw(g), undefined), d);
    expect(res.status).toBe('GATE_BLOCKED');
    expect(res.exit).toBe(EXIT.GATE_BLOCKED);
    expect(res.manifest!.results).toEqual([]);
    expect(res.manifest!.stages).toEqual([]);
    expect(d.fetcher.calls).toHaveLength(0);
    expect(d.runner.calls).toHaveLength(0);
    expect(JSON.parse(d.storage.readText(`${res.manifest!.folder}/manifest.json`)!).status).toBe('GATE_BLOCKED');
  });

  const blocked = async (named: GateDocument, shipped: GateDocument | undefined): Promise<string> => {
    const d = deps();
    const res = await runProteinImpact(argsFor(applyRaw(named), shipped), d);
    expect(res.status).toBe('GATE_BLOCKED');
    expect(res.exit).toBe(EXIT.GATE_BLOCKED);
    expect(d.runner.calls).toHaveLength(0);
    expect(res.manifest!.results).toEqual([]);
    return res.manifest!.errors.join(' | ');
  };

  test('GATE_BLOCKED when the shipped gate is not the document the request names', async () => {
    const named = gateDoc();
    expect(await blocked(named, signGate(named, CREATOR, '2026-10-21T05:00:00Z'))).toMatch(/does not match the request/);
  });

  test('GATE_BLOCKED when the gate benchmark contains a variant being scored (not held out)', async () => {
    const g = gateDoc({ benchmark_variants: ['ITGA2B:p.F222L'] });
    expect(await blocked(g, g)).toMatch(/part of the validation benchmark/);
  });

  test('GATE_BLOCKED when the gate was computed with other tools', async () => {
    const g = gateDoc({ tools_lock_sha256: 'c'.repeat(64) });
    expect(await blocked(g, g)).toMatch(/different tool versions/);
  });

  test('GATE_BLOCKED when the gate is not signed off', async () => {
    const g = unsignedGate();
    expect(await blocked(g, g)).toMatch(/not signed off/);
  });

  test('GATE_BLOCKED when the metrics do not pass, even if the document says they do', async () => {
    const m = metrics(); m.pooled_auroc.ci_low = 0.6;
    const g = gateDoc({ metrics: m, pass: true });
    expect(await blocked(g, g)).toMatch(/lower CI/);
  });

  test('a request that fails the no-design guard, or whose job id does not match, writes nothing', async () => {
    const g = gateDoc();
    const d = deps();
    const r1 = await runProteinImpact(argsFor({ ...applyRaw(g), sequence: 'MAKQ' }, g, 'pi-apply-99990000000001-aaaaaaaaaaaa'), d);
    expect(r1.exit).toBe(EXIT.GUARD);
    const r2 = await runProteinImpact(argsFor(applyRaw(g), g, 'pi-apply-99990000000001-aaaaaaaaaaaa'), d);
    expect(r2.exit).toBe(EXIT.GUARD);
    expect(r2.log.join('\n')).toMatch(/does not match the request/);
    expect(d.storage.files.size).toBe(0);
  });

  test('GPU layers without a matching approval are refused before anything runs', async () => {
    const g = gateDoc();
    const raw = applyRaw(g, { layers: ['complex'], approval: { estimate_id: 'a'.repeat(16), max_usd: 50 } });
    const d = deps();
    const res = await runProteinImpact(argsFor(raw, g), d);
    expect(res.status).toBe('APPROVAL');
    expect(res.exit).toBe(EXIT.APPROVAL);
    expect(d.runner.calls).toHaveLength(0);
    expect(d.fetcher.calls).toHaveLength(0);
  });

  test('GPU layers with the approved estimate run with a time limit of 1.5 x the approved budget', async () => {
    const g = gateDoc();
    const placeholder = applyRaw(g, { layers: ['complex'], approval: { estimate_id: '0'.repeat(16), max_usd: 1 } });
    const est = estimate(validateRequest(placeholder), NOW);
    const maxUsd = Math.ceil(est.total_usd);
    const raw = applyRaw(g, { layers: ['complex'], approval: { estimate_id: est.estimate_id, max_usd: maxUsd } });
    const d = deps();
    const res = await runProteinImpact(argsFor(raw, g), d);
    expect(res.status).toBe('OK');
    expect(d.runner.calls).toHaveLength(1);
    const limit = d.runner.calls[0].timeout_ms!;
    expect(limit).toBeGreaterThan(Math.floor(((maxUsd * 1.5) / 7.35) * 3.6e6) - 2000);
    expect(limit).toBeLessThanOrEqual(Math.floor(((maxUsd * 1.5) / 7.35) * 3.6e6));
    expect(res.manifest!.estimate!.estimate_id).toBe(est.estimate_id);
  });

  test('a stage receives mature numbering and the pinned sequence, and its records are filed under the variant', async () => {
    const g = gateDoc();
    const runner = new FakeRunner(i => ({ records: i.subs.map(s => ({ variant: s.variant, llr: s.pos / 1000 })) }));
    const d = deps({ runner });
    const res = await runProteinImpact(argsFor(applyRaw(g, { layers: ['features', 'plm'] }), g), d);
    expect(res.status).toBe('OK');
    const input = runner.calls[0];
    expect(input.layer).toBe('plm');
    expect(input.subs.find(s => s.pos === 778)!.mature_pos).toBe(747);
    expect(input.sequences.ITGA2B.sequence).toHaveLength(1039);
    expect(Object.keys(input.prior)).toEqual(['features']);
    const row = res.manifest!.results.find(r => r.variant === 'ITGA2B:p.Gln778Pro')!;
    expect(Object.keys(row.layers).sort()).toEqual(['features', 'plm']);
    expect((row.layers.plm as any).llr).toBeCloseTo(0.778, 3);
  });

  test('a failing stage stops the job, later stages do not run, and the error is recorded', async () => {
    const g = gateDoc();
    const runner = new FakeRunner(() => { throw new Error('container plm exited 137'); });
    const d = deps({ runner });
    const res = await runProteinImpact(argsFor(applyRaw(g, { layers: ['features', 'plm', 'structure'] }), g), d);
    expect(res.status).toBe('FAILED');
    expect(res.exit).toBe(EXIT.FAILED);
    expect(res.manifest!.stages.map(s => `${s.layer}:${s.status}`)).toEqual(['features:done', 'plm:failed']);
    expect(res.manifest!.errors).toEqual(['plm: container plm exited 137']);
    expect(runner.calls).toHaveLength(1);
  });

  test('a UniProt sequence that differs from the pin fails the job', async () => {
    const g = gateDoc();
    const tampered = fastaText('P08514').replace('MARALCPLQALWLLEW', 'MARALCPLQALWLLEA');
    const d = deps({ fetcher: new FakeFetcher({ P08514: tampered }) });
    const res = await runProteinImpact(argsFor(applyRaw(g), g), d);
    expect(res.status).toBe('FAILED');
    expect(res.manifest!.errors.join(' ')).toMatch(/differs from the pinned UniProt/);
  });

  test('a stated reference residue that is not in the pinned sequence fails the job', async () => {
    const g = gateDoc();
    const raw = applyRaw(g, { targets: [{ gene: 'ITGA2B', uniprot: 'P08514', subs: [{ pos: 778, ref: 'A', alt: 'P' }] }] });
    const res = await runProteinImpact(argsFor(raw, g), deps());
    expect(res.status).toBe('FAILED');
    expect(res.manifest!.errors.join(' ')).toMatch(/has Q/);
  });

  test('public modes need no gate: fetch pins both sequences', async () => {
    const raw = { schema: SCHEMA_REQUEST, mode: 'fetch', targets: [{ gene: 'ITGA2B', uniprot: 'P08514', subs: [] }, { gene: 'ITGB3', uniprot: 'P05106', subs: [] }], layers: ['fetch'] };
    const d = deps();
    const res = await runProteinImpact(argsFor(raw), d);
    expect(res.status).toBe('OK');
    expect(res.manifest!.biosampleId).toBeNull();
    const summary = JSON.parse(d.storage.readText(`${res.manifest!.folder}/stages/fetch/out.json`)!).summary.sequences;
    const residues = fastaText('P05106').split('\n').filter(l => !l.startsWith('>')).join('').trim();
    expect(summary.ITGB3).toMatchObject({ uniprot: 'P05106', length: 788, seq_sha256: crypto.createHash('sha256').update(residues).digest('hex') });
  });

  test('an apply job whose stages produce no records is EMPTY, not OK', async () => {
    const g = gateDoc();
    const runner = new FakeRunner(() => ({ records: [] }));
    const res = await runProteinImpact(argsFor(applyRaw(g, { layers: ['plm'] }), g), deps({ runner }));
    expect(res.status).toBe('EMPTY');
    expect(res.exit).toBe(EXIT.EMPTY);
  });

  test('the job folder is under the creator\'s biowallet, lowercased', () => {
    expect(jobFolder({ outBucket: 'b', creator: '0xAbC', jobId: 'j1' })).toBe('gs://b/biowallet/0xabc/protein-impact/j1');
  });
});

describe('sequences', () => {
  test('parseFasta joins lines and rejects anything outside the 20 standard residues', () => {
    expect(parseFasta('>x\nACD\nEF\n')).toBe('ACDEF');
    expect(() => parseFasta('>x\nACDXF\n')).toThrow(/outside the 20 standard/);
    expect(() => parseFasta('>x\nACD*\n')).toThrow();
  });

  test('ensureSequences prefers the reference store and stores what it fetches', async () => {
    const d = deps();
    const log = jest.fn();
    await ensureSequences(['ITGB3'], d, 'gs://genobank-references/protein', log);
    expect(d.fetcher.calls).toHaveLength(1);
    await ensureSequences(['ITGB3'], d, 'gs://genobank-references/protein', log);
    expect(d.fetcher.calls).toHaveLength(1); // second call is served from the store
    expect(d.storage.readText('gs://genobank-references/protein/uniprot/P05106/dd1f27b57d8b.fasta')).toMatch(/^>sp\|P05106/);
  });
});

describe('tools lock', () => {
  const pinned = (): ToolsLock => ({
    ...lock,
    images: { ...lock.images, plm: { ...lock.images.plm, digest: 'sha256:' + '1'.repeat(64) } },
    models: { ...lock.models, esm2_650m: { ...lock.models.esm2_650m, revision: '2'.repeat(40) } },
  });

  test('the committed lock hashes stably, assigns each layer to at most one image, and names real layers', () => {
    expect(toolsLockSha256()).toMatch(/^[a-f0-9]{64}$/);
    expect(toolsLockSha256()).toBe(toolsLockSha256(loadToolsLock()));
    const layers = Object.values(lock.images).flatMap(i => i.layers);
    expect(new Set(layers).size).toBe(layers.length);
    for (const l of layers) expect(['plm', 'structure', 'complex', 'probe', 'md']).toContain(l);
  });

  test('a stage refuses to run from an image that is not pinned by digest', () => {
    expect(() => imageForLayer('md', { ...lock, images: { ...lock.images, md: { ...lock.images.md, digest: null } } })).toThrow(ToolsLockError);
    expect(() => imageForLayer('plm', { ...lock, images: { ...lock.images, plm: { ...lock.images.plm, digest: 'latest' } } })).toThrow(/no pinned digest/);
    expect(() => imageForLayer('nonsense')).toThrow(/no image is assigned/);
    expect(imageForLayer('plm', pinned())).toBe(`${lock.images.plm.name}@sha256:${'1'.repeat(64)}`);
  });

  test('a model needs a 40-hex commit', () => {
    expect(() => modelRevision('esm2_650m', { ...lock, models: { ...lock.models, esm2_650m: { ...lock.models.esm2_650m, revision: 'main' } } })).toThrow(/no pinned commit/);
    expect(modelRevision('esm2_650m', pinned())).toEqual({ hf_repo: 'facebook/esm2_t33_650M_UR50D', revision: '2'.repeat(40) });
    expect(() => modelRevision('nope', pinned())).toThrow(/not in tools.lock.json/);
  });

  test('changing any pin changes the lock hash, so earlier validation no longer applies', () => {
    expect(toolsLockSha256(pinned())).not.toBe(toolsLockSha256(lock));
  });
});

describe('local storage (dry runs)', () => {
  test('round-trips text and files, and cannot escape its root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-local-'));
    const s = new LocalStorage(root);
    expect(s.readText('gs://b/a/x.json')).toBeNull();
    s.writeText('gs://b/a/x.json', '{"a":1}');
    expect(s.readText('gs://b/a/x.json')).toBe('{"a":1}');
    const f = path.join(root, 'src.txt'); fs.writeFileSync(f, 'hi');
    s.copyIn(f, 'gs://b/c/y.txt');
    expect(s.readText('gs://b/c/y.txt')).toBe('hi');
    expect(() => s.writeText('gs://b/../../escape.txt', 'x')).toThrow(/escapes/);
    expect(() => s.readText('/etc/passwd')).toThrow(/not a gs:\/\//);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('client builders', () => {
  test('groupTargets parses, groups by gene, sorts and collapses duplicates', () => {
    const { targets, subs } = groupTargets(['ITGB3:p.Leu196Pro', 'ITGA2B:p.Q778P', 'ITGA2B:p.Gln778Pro', 'ITGA2B:p.F222L']);
    expect(targets.map(t => t.gene)).toEqual(['ITGA2B', 'ITGB3']);
    expect(targets[0].subs).toEqual([{ pos: 222, ref: 'F', alt: 'L' }, { pos: 778, ref: 'Q', alt: 'P' }]);
    expect(targets[0].uniprot).toBe('P08514');
    expect(subs).toHaveLength(3);
    expect(() => groupTargets(['ITGA2B:p.Gln778Ter'])).toThrow(/only missense/);
  });

  test('layers and genes', () => {
    expect(parseLayers('features, plm', ['features'])).toEqual(['features', 'plm']);
    expect(parseLayers(undefined, ['features'])).toEqual(['features']);
    expect(() => parseLayers('features,magic', [])).toThrow(/unknown layer/);
    expect(parseGenes(undefined)).toEqual(['ITGA2B', 'ITGB3']);
    expect(parseGenes('itgb3,ITGB3')).toEqual(['ITGB3']);
    expect(() => parseGenes('TP53')).toThrow(/not supported/);
  });

  test('buildApplyRequest names the gate by its id and attaches a placeholder approval only for GPU layers', () => {
    const g = gateDoc();
    const base = { serial: '99990000000001', variants: ['ITGA2B:p.Gln778Pro', 'ITGA2B:p.F222L'], sources: [SOURCE], gate: g };
    const cpu = buildApplyRequest({ ...base, layers: ['features'] });
    expect(cpu.gate).toBe(gateId(g));
    expect(cpu.approval).toBeUndefined();
    const gpu = buildApplyRequest({ ...base, layers: ['complex'] });
    expect(gpu.approval).toBeDefined();
    const real = buildApplyRequest({ ...base, layers: ['complex'], approval: { estimate_id: 'f'.repeat(16), max_usd: 12 } });
    expect(real.approval).toEqual({ estimate_id: 'f'.repeat(16), max_usd: 12 });
    expect(() => buildApplyRequest({ ...base, sources: [] , layers: ['features'] })).toThrow(/apply requires sources/);
  });

  test('a validate request names genes and layers only, and is a CPU job unless a GPU layer is asked for', () => {
    const v = buildValidateRequest(['ITGA2B', 'ITGB3'], ['plm']);
    expect(v.mode).toBe('validate');
    expect(v.targets.every(t => t.subs.length === 0)).toBe(true);
    expect(v.approval).toBeUndefined();
    const spec = buildJobSpec(v, undefined, { wallet_address: CREATOR, user_signature: '0xsig' }, '2026-10-21');
    expect(spec.inputType).toBe('protein-impact');
    expect(spec.biosampleId).toBe('public');
    const g = buildValidateRequest(['ITGA2B'], ['plm', 'complex']);
    expect(g.approval).toBeDefined();
    expect(buildJobSpec(g, undefined, { wallet_address: CREATOR, user_signature: '0xsig' }, '2026-10-21').inputType).toBe('protein-impact-gpu');
  });

  test('probe and fetch requests are public', () => {
    expect(buildProbeRequest(['ITGA2B', 'ITGB3']).serial).toBeUndefined();
    expect(buildFetchRequest(['ITGA2B']).layers).toEqual(['fetch']);
  });

  test('carrierMatches accepts the annotation formats and reports what the sample lacks', () => {
    const rows = [
      { base__hugo: 'ITGA2B', base__achange: 'p.Gln778Pro' },
      { base__hugo: 'ITGA2B', base__achange: 'F222L' },
      { base__hugo: 'ITGB3', base__achange: 'p.Ter100Gln' }, // not a missense change
      { base__hugo: 'FERMT3', base__achange: 'p.Ala1Val' },  // not a supported gene
      { base__hugo: null, base__achange: null },
    ];
    const want = groupTargets(['ITGA2B:p.Q778P', 'ITGA2B:p.F222L', 'ITGA2B:p.Leu300Pro', 'ITGB3:p.Leu196Pro']).subs;
    const { found, missing } = carrierMatches(rows as any, want);
    expect(found.map(s => `${s.gene}${s.pos}${s.alt}`).sort()).toEqual(['ITGA2B222L', 'ITGA2B778P']);
    expect(missing.map(s => `${s.gene}${s.pos}${s.alt}`).sort()).toEqual(['ITGA2B300P', 'ITGB3196P']);
  });

  test('buildJobSpec routes by layer and keeps the manifest under the creator\'s folder', () => {
    const g = gateDoc();
    const cred = { wallet_address: '0xAbCdEf0000000000000000000000000000000001', user_signature: '0xsig' };
    const cpu = buildJobSpec(buildApplyRequest({ serial: '99990000000001', variants: ['ITGA2B:p.F222L'], sources: [SOURCE], layers: ['features'], gate: g }), g, cred, '2026-10-21');
    expect(cpu.inputType).toBe('protein-impact');
    expect(cpu.biosampleId).toBe('99990000000001');
    expect(cpu.jobId).toBe(jobIdFor(cpu.proteinImpactRequest));
    expect(cpu.manifestUri).toBe(`gs://genobank-parabricks-output/biowallet/0xabcdef0000000000000000000000000000000001/protein-impact/${cpu.jobId}/manifest.json`);
    expect(cpu.proteinImpactGate).toBe(g);
    const gpu = buildJobSpec(buildProbeRequest(['ITGA2B', 'ITGB3']), undefined, cred, '2026-10-21');
    expect(gpu.inputType).toBe('protein-impact-gpu');
    expect(gpu.biosampleId).toBe('public');
    expect(gpu.proteinImpactGate).toBeUndefined();
  });

  test('renderEstimate prints the id, the total and the lines', () => {
    const e = estimate(buildProbeRequest(['ITGA2B', 'ITGB3']), NOW);
    const text = renderEstimate(e);
    expect(text).toContain(e.estimate_id);
    expect(text).toContain(`$${e.total_usd.toFixed(2)}`);
    expect(text).toContain('probe');
  });
});
