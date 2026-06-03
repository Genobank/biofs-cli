/**
 * biofs benchmark <dataset.jsonl> — the ACMG evaluation harness.
 *
 * Tests the central scientific claim: does cross-vendor multi-agent debate
 * reduce ACMG variant misclassification, relative to single-model and
 * same-model-debate baselines? Three arms are run over a gold-standard set:
 *
 *   single        each model classifies alone (per-model accuracy)
 *   same-model    one model debates itself for N rounds (final call)
 *   cross-vendor  the panel debates, then a confidence-weighted consensus
 *
 * Every classification is written to the shared workspace as a signed,
 * hash-chained turn, so the benchmark run is itself an auditable record.
 * `--mock` exercises the full harness deterministically without spawning CLIs;
 * live mode drives the subscription CLIs (claude -p / grok -p / gemini -p).
 *
 * The truth label is used ONLY for scoring; agents see gene/hgvs/protein only.
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import chalk from 'chalk';
import { Logger } from '../lib/utils/logger';
import { bioNodeBase, wsNode } from './workspace';

export interface BenchmarkOptions {
  arms?: string;
  models?: string;
  rounds?: string;
  sameModel?: string;
  node?: string;
  biorouter?: string;
  mcpDist?: string;
  claudeBin?: string;
  grokBin?: string;
  geminiBin?: string;
  geminiModel?: string;
  mock?: boolean;
  mockError?: string;
  limit?: string;
  out?: string;
  timeout?: string;
  json?: boolean;
}

type Tier = 'P' | 'LP' | 'VUS' | 'LB' | 'B';
const TIERS: Tier[] = ['P', 'LP', 'VUS', 'LB', 'B'];
const TIER_LABEL: Record<Tier, string> = { P: 'Pathogenic', LP: 'Likely pathogenic', VUS: 'VUS', LB: 'Likely benign', B: 'Benign' };
const DEFAULT_MCP_DIST = '/Users/danieluribe/Downloads/bio-context-sprint/mcp-bio-context/dist/index.js';

interface Variant { variant_id: string; gene: string; hgvs: string; protein?: string; truth: Tier; note?: string }
interface Call { agent_id: string; model: string; tier: Tier | null; raw: string | null; confidence: number | null; ms?: number; usage?: any }

// ---- classification normalization -----------------------------------------
function normTier(s: any): Tier | null {
  const t = String(s == null ? '' : s).toLowerCase().trim();
  if (!t) return null;
  if (/benign/.test(t)) return /likely/.test(t) ? 'LB' : 'B';
  if (/pathogenic/.test(t)) return /likely/.test(t) ? 'LP' : 'P';
  if (/uncertain|^vus$|\bvus\b/.test(t)) return 'VUS';
  const up = String(s).toUpperCase().trim();
  return (TIERS as string[]).includes(up) ? (up as Tier) : null;
}
function groupOf(c: Tier | null): 'PATH' | 'VUS' | 'BENIGN' | null {
  if (c === 'P' || c === 'LP') return 'PATH';
  if (c === 'B' || c === 'LB') return 'BENIGN';
  if (c === 'VUS') return 'VUS';
  return null;
}
const isActionable = (c: Tier | null) => c === 'P' || c === 'LP';

// ---- model invocation (live) ----------------------------------------------
interface ModelDef { key: string; label: string; modelId: string; bin: string; args: (prompt: string, cfg: string) => string[] }
function buildModels(opts: BenchmarkOptions): Record<string, ModelDef> {
  return {
    claude: {
      key: 'claude', label: 'claude-code', modelId: 'claude-opus-4-8', bin: opts.claudeBin || 'claude',
      args: (prompt, cfg) => ['-p', prompt, '--model', 'claude-opus-4-8', '--output-format', 'json', '--mcp-config', cfg, '--strict-mcp-config', '--allowedTools', 'mcp__biofs__*', '--permission-mode', 'acceptEdits'],
    },
    grok: {
      key: 'grok', label: 'grok-build', modelId: 'grok-build', bin: opts.grokBin || 'grok',
      args: (prompt) => ['-p', prompt, '-m', 'grok-build', '--output-format', 'json', '--always-approve', '--disallowed-tools', 'run_terminal_cmd,write_file,search_replace,create_file,delete_file,apply_patch,Agent'],
    },
    gemini: {
      key: 'gemini', label: 'gemini-cli', modelId: opts.geminiModel || 'gemini-3-flash-preview', bin: opts.geminiBin || 'gemini',
      args: (prompt) => ['-p', prompt, '-m', opts.geminiModel || 'gemini-3-flash-preview', '-o', 'json', '--approval-mode', 'yolo', '--allowed-mcp-server-names', 'biofs'],
    },
  };
}
function subscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.XAI_API_KEY; delete env.GROK_API_KEY;
  return env;
}
function runCmd(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now(); let stdout = '', stderr = '', done = false;
    const child = spawn(bin, args, { env });
    const finish = (r: any) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } finish({ code: 124, stdout, stderr: stderr + ' [timeout]', ms: Date.now() - t0 }); }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => finish({ code: 127, stdout, stderr: stderr + String((e as Error).message), ms: Date.now() - t0 }));
    child.on('close', (code) => finish({ code: code ?? 0, stdout, stderr, ms: Date.now() - t0 }));
  });
}
function parseUsage(stdout: string): any {
  try {
    const obj = JSON.parse((stdout || '').trim().split('\n').filter(Boolean).pop() || '{}');
    const u = obj?.usage || obj?.usageMetadata || obj?.stats?.usage || {};
    return { tokens_in: u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount ?? null, tokens_out: u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount ?? null, cost_usd: obj?.total_cost_usd ?? null };
  } catch { return {}; }
}
function ensureClaudeCfg(nodeBase: string, mcpDist: string, biorouter: string): string {
  const dir = path.join(os.homedir(), '.biofs', 'duet'); fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, 'claude.biofs.mcp.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: { biofs: { command: 'node', args: [mcpDist], env: { BIOFS_AGENT_ID: 'claude-code', BIOFS_NODE_BASE: nodeBase, BIOROUTER_URL: biorouter } } } }, null, 2));
  return cfgPath;
}

// ---- deterministic mock ----------------------------------------------------
function det(s: string): number { return parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16); }
function mockCall(modelKey: string, v: Variant, errorRate: number): Call {
  const h = det(`${v.variant_id}|${modelKey}`);
  const errs = (h % 100) < errorRate;
  if (!errs) return { agent_id: modelKey, model: modelKey, tier: v.truth, raw: TIER_LABEL[v.truth], confidence: 0.82 + (h % 12) / 100 };
  // deterministic plausible wrong neighbor
  const order: Tier[] = ['P', 'LP', 'VUS', 'LB', 'B'];
  const i = order.indexOf(v.truth);
  const shift = (h % 2 === 0 ? 1 : -1) * (1 + (h % 2));
  const wrong = order[Math.max(0, Math.min(order.length - 1, i + (i === 0 ? Math.abs(shift) : i === order.length - 1 ? -Math.abs(shift) : shift)))];
  return { agent_id: modelKey, model: modelKey, tier: wrong, raw: TIER_LABEL[wrong], confidence: 0.5 + (h % 18) / 100 };
}

// ---- workspace helpers -----------------------------------------------------
async function emitClaim(caseId: string, agentId: string, modelId: string, v: Variant, tier: Tier, confidence: number, node?: string): Promise<void> {
  await wsNode('POST', '/workspace/append', { case_id: caseId, turn: { agent_id: agentId, model: { name: modelId, version: null }, role: 'classification', content: `${TIER_LABEL[tier]} for ${v.variant_id}`, claim: { subject: v.variant_id, classification: TIER_LABEL[tier], confidence, criteria: [] } } }, node);
}
async function readCallsForSubject(caseId: string, subject: string, node?: string): Promise<Call[]> {
  const { data } = await wsNode('GET', `/workspace/consensus?case_id=${encodeURIComponent(caseId)}`, undefined, node);
  const subj = (data?.subjects || []).find((s: any) => s.subject === subject);
  if (!subj) return [];
  return (subj.calls || []).map((c: any) => ({ agent_id: c.agent_id, model: c.agent_id, tier: normTier(c.classification), raw: c.classification, confidence: typeof c.confidence === 'number' ? c.confidence : null }));
}
async function consensusCall(caseId: string, subject: string, node?: string): Promise<{ tier: Tier | null; raw: string | null; calls: Call[] }> {
  const { data } = await wsNode('GET', `/workspace/consensus?case_id=${encodeURIComponent(caseId)}`, undefined, node);
  const subj = (data?.subjects || []).find((s: any) => s.subject === subject);
  const calls = subj ? (subj.calls || []).map((c: any) => ({ agent_id: c.agent_id, model: c.agent_id, tier: normTier(c.classification), raw: c.classification, confidence: typeof c.confidence === 'number' ? c.confidence : null })) : [];
  return { tier: subj ? normTier(subj.consensus_call) : null, raw: subj ? subj.consensus_call : null, calls };
}

// ---- prompts ---------------------------------------------------------------
function classifyPrompt(v: Variant, agentLabel: string, debateNote?: string): string {
  return [
    `You are ${agentLabel}, classifying ONE germline variant under the ACMG/AMP 2015 guidelines (with ClinGen sequence-variant-interpretation refinements).`,
    `Variant: gene ${v.gene}, ${v.hgvs}${v.protein ? ` (${v.protein})` : ''}.`,
    debateNote || '',
    `Use the biofs MCP. ${debateNote ? 'Call workspace_read first to see prior calls, then reconsider critically.' : ''} Call workspace_classify EXACTLY ONCE with: subject="${v.variant_id}", classification (one of Pathogenic, Likely pathogenic, VUS, Likely benign, Benign), the ACMG criteria you invoke, and a confidence between 0 and 1. Do not call any other tool. Then stop.`,
  ].filter(Boolean).join(' ');
}

// ---- scoring ---------------------------------------------------------------
interface PerVariant { variant_id: string; truth: Tier; final: Tier | null; exact: boolean; collapsed: boolean; actionable: boolean; calls?: Call[] }
function scoreArm(rows: PerVariant[]) {
  const n = rows.length;
  const c = (f: (r: PerVariant) => boolean) => rows.filter(f).length;
  return {
    n,
    exact: n ? +(c((r) => r.exact) / n).toFixed(4) : null,
    collapsed: n ? +(c((r) => r.collapsed) / n).toFixed(4) : null,
    actionable: n ? +(c((r) => r.actionable) / n).toFixed(4) : null,
    abstain: c((r) => r.final == null),
  };
}
function mcnemar(aCorrect: boolean[], bCorrect: boolean[]) {
  let b = 0, cc = 0;
  for (let i = 0; i < aCorrect.length; i++) { if (aCorrect[i] && !bCorrect[i]) b++; else if (!aCorrect[i] && bCorrect[i]) cc++; }
  const denom = b + cc;
  const chi2 = denom > 0 ? Math.pow(Math.abs(b - cc) - 1, 2) / denom : 0;
  // p-value approx from chi2 with 1 df (survival of chi-square)
  const p = denom > 0 ? Math.exp(-chi2 / 2) : 1; // upper-tail approx for 1df (e^{-x/2})
  return { b_only_a: b, c_only_b: cc, chi2: +chi2.toFixed(3), p_approx: +p.toFixed(4) };
}

// ===========================================================================
export async function benchmarkCommand(datasetFile: string, options: BenchmarkOptions = {}): Promise<void> {
  const nodeBase = bioNodeBase(options.node);
  const biorouter = options.biorouter || process.env.BIOROUTER_URL || 'https://bioip.genobank.app';
  const mcpDist = options.mcpDist || process.env.BIOFS_MCP_DIST || DEFAULT_MCP_DIST;
  const order = (options.models || 'claude,grok,gemini').split(',').map((s) => s.trim()).filter(Boolean);
  const arms = (options.arms || 'single,same-model,cross-vendor').split(',').map((s) => s.trim()).filter(Boolean);
  const rounds = Math.max(1, Number(options.rounds) || 2);
  const sameModelKey = options.sameModel || order[0] || 'claude';
  const timeoutMs = Math.max(30, Number(options.timeout) || 300) * 1000;
  const mockError = Math.max(0, Math.min(90, Number(options.mockError) || 22));
  const MODELS = buildModels(options);

  // load dataset
  if (!fs.existsSync(datasetFile)) { Logger.error(`dataset not found: ${datasetFile}`); process.exit(1); }
  let variants: Variant[] = fs.readFileSync(datasetFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  variants = variants.filter((v) => v.variant_id && v.hgvs && normTier(v.truth)).map((v) => ({ ...v, truth: normTier(v.truth) as Tier }));
  if (options.limit) variants = variants.slice(0, Number(options.limit));
  if (!variants.length) { Logger.error('no usable variants in dataset'); process.exit(1); }

  // reachability
  const probe = await wsNode('GET', '/workspace/read?case_id=__bench_preflight__&limit=1', undefined, options.node);
  if (probe.status !== 200) { Logger.error(`biofs-node unreachable at ${nodeBase} (${probe.status})`); process.exit(1); }

  const runId = det(`${datasetFile}|${variants.length}|${Date.now()}`).toString(16);
  const claudeCfg = ensureClaudeCfg(nodeBase, mcpDist, biorouter);
  if (!options.json) {
    console.log(chalk.bold(`biofs benchmark`) + chalk.gray(`  ${variants.length} variants  arms=[${arms.join(',')}]  models=[${order.join(',')}]  ${options.mock ? 'MOCK' : 'LIVE'}  run=${runId}`));
    console.log(chalk.gray(`  node: ${nodeBase}`));
  }

  // produce one classification for a (model, variant) into a case (live or mock)
  async function classifyInto(caseId: string, m: ModelDef, v: Variant, debateNote?: string): Promise<void> {
    if (options.mock) {
      const mc = mockCall(m.key, v, mockError);
      if (mc.tier) await emitClaim(caseId, m.label, m.modelId, v, mc.tier, mc.confidence ?? 0.7, options.node);
      return;
    }
    const which = spawnSync('which', [m.bin], { encoding: 'utf8' });
    if (which.status !== 0) { Logger.warn(`${m.bin} not found; skipping ${m.label}`); return; }
    const prompt = classifyPrompt(v, m.label, debateNote);
    await runCmd(m.bin, m.args(prompt, claudeCfg), subscriptionEnv(), timeoutMs);
  }

  const armResults: Record<string, { rows: PerVariant[]; perModel?: Record<string, PerVariant[]> }> = {};

  for (const arm of arms) {
    if (!options.json) console.log(chalk.bold(`\n── arm: ${arm} ──`));
    if (arm === 'single') {
      const perModel: Record<string, PerVariant[]> = {};
      for (const mk of order) perModel[mk] = [];
      for (let vi = 0; vi < variants.length; vi++) {
        const v = variants[vi];
        for (const mk of order) {
          const m = MODELS[mk]; if (!m) continue;
          const caseId = `bench-${runId}-single-${mk}-${vi}`;
          await wsNode('POST', '/workspace/open', { case_id: caseId, init: { title: `${arm}:${mk}:${v.variant_id}`, biocids: [] } }, options.node);
          await classifyInto(caseId, m, v);
          const calls = await readCallsForSubject(caseId, v.variant_id, options.node);
          const mine = calls.find((c) => c.agent_id === m.label) || calls[0] || null;
          const final = mine ? mine.tier : null;
          perModel[mk].push({ variant_id: v.variant_id, truth: v.truth, final, exact: final === v.truth, collapsed: groupOf(final) === groupOf(v.truth), actionable: isActionable(final) === isActionable(v.truth), calls: mine ? [mine] : [] });
        }
        if (!options.json) process.stdout.write(`\r  classified ${vi + 1}/${variants.length}   `);
      }
      if (!options.json) process.stdout.write('\n');
      // arm-level rows = best single model per variant is not "the arm"; single arm reports per-model.
      armResults[arm] = { rows: [], perModel };
    } else if (arm === 'same-model') {
      const m = MODELS[sameModelKey]; const rows: PerVariant[] = [];
      if (m) for (let vi = 0; vi < variants.length; vi++) {
        const v = variants[vi];
        const caseId = `bench-${runId}-same-${sameModelKey}-${vi}`;
        await wsNode('POST', '/workspace/open', { case_id: caseId, init: { title: `${arm}:${v.variant_id}` } }, options.node);
        for (let r = 1; r <= rounds; r++) {
          await classifyInto(caseId, m, v, r > 1 ? `This is debate round ${r} of ${rounds}; you previously classified this variant.` : undefined);
        }
        const calls = await readCallsForSubject(caseId, v.variant_id, options.node);
        const mine = calls.find((c) => c.agent_id === m.label) || calls[0] || null;
        const final = mine ? mine.tier : null;
        rows.push({ variant_id: v.variant_id, truth: v.truth, final, exact: final === v.truth, collapsed: groupOf(final) === groupOf(v.truth), actionable: isActionable(final) === isActionable(v.truth), calls: mine ? [mine] : [] });
        if (!options.json) process.stdout.write(`\r  classified ${vi + 1}/${variants.length}   `);
      }
      if (!options.json) process.stdout.write('\n');
      armResults[arm] = { rows };
    } else if (arm === 'cross-vendor') {
      const rows: PerVariant[] = [];
      for (let vi = 0; vi < variants.length; vi++) {
        const v = variants[vi];
        const caseId = `bench-${runId}-cross-${vi}`;
        await wsNode('POST', '/workspace/open', { case_id: caseId, init: { title: `${arm}:${v.variant_id}` } }, options.node);
        for (let r = 1; r <= rounds; r++) {
          for (const mk of order) {
            const m = MODELS[mk]; if (!m) continue;
            await classifyInto(caseId, m, v, r > 1 ? `Debate round ${r}; another AI may have classified this. Reconsider in light of the others.` : undefined);
          }
        }
        const cons = await consensusCall(caseId, v.variant_id, options.node);
        const final = cons.tier;
        rows.push({ variant_id: v.variant_id, truth: v.truth, final, exact: final === v.truth, collapsed: groupOf(final) === groupOf(v.truth), actionable: isActionable(final) === isActionable(v.truth), calls: cons.calls });
        if (!options.json) process.stdout.write(`\r  classified ${vi + 1}/${variants.length}   `);
      }
      if (!options.json) process.stdout.write('\n');
      armResults[arm] = { rows };
    } else {
      Logger.warn(`unknown arm "${arm}" (use single,same-model,cross-vendor)`);
    }
  }

  // ---- analysis ----
  const summary: any = { dataset: datasetFile, n_variants: variants.length, run_id: runId, mock: !!options.mock, models: order, arms: {} };
  // per-model (single)
  if (armResults['single']?.perModel) {
    summary.arms['single'] = { per_model: {} as any };
    for (const mk of order) summary.arms['single'].per_model[mk] = scoreArm(armResults['single'].perModel[mk]);
    // best single by collapsed accuracy
    let best: string | null = null, bestAcc = -1;
    for (const mk of order) { const a = summary.arms['single'].per_model[mk].collapsed ?? -1; if (a > bestAcc) { bestAcc = a; best = mk; } }
    summary.arms['single'].best_model = best;
  }
  if (armResults['same-model']) summary.arms['same-model'] = { model: sameModelKey, rounds, ...scoreArm(armResults['same-model'].rows) };
  if (armResults['cross-vendor']) summary.arms['cross-vendor'] = { rounds, ...scoreArm(armResults['cross-vendor'].rows) };

  // comparison: cross-vendor vs best single
  if (armResults['cross-vendor'] && armResults['single']?.perModel && summary.arms['single'].best_model) {
    const cv = armResults['cross-vendor'].rows;
    const bs = armResults['single'].perModel[summary.arms['single'].best_model];
    const byId = (rows: PerVariant[]) => Object.fromEntries(rows.map((r) => [r.variant_id, r]));
    const cvm = byId(cv), bsm = byId(bs);
    let rescued = 0, harmed = 0; const aCorrect: boolean[] = [], bCorrect: boolean[] = [];
    for (const v of variants) {
      const cr = cvm[v.variant_id], br = bsm[v.variant_id]; if (!cr || !br) continue;
      aCorrect.push(br.collapsed); bCorrect.push(cr.collapsed);
      if (!br.collapsed && cr.collapsed) rescued++;
      if (br.collapsed && !cr.collapsed) harmed++;
    }
    summary.comparison = { cross_vs_best_single: summary.arms['single'].best_model, rescued_by_debate: rescued, broken_by_debate: harmed, net_errors_caught: rescued - harmed, mcnemar: mcnemar(aCorrect, bCorrect) };
  }

  // calibration (cross-vendor per-agent calls)
  if (armResults['cross-vendor']) {
    const bins = [[0, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.01]];
    const cal = bins.map(([lo, hi]) => {
      let n = 0, correct = 0;
      for (const r of armResults['cross-vendor'].rows) for (const c of (r.calls || [])) {
        if (c.confidence == null || c.tier == null) continue;
        if (c.confidence >= lo && c.confidence < hi) { n++; if (groupOf(c.tier) === groupOf(r.truth)) correct++; }
      }
      return { range: `${lo}-${hi >= 1 ? 1 : hi}`, n, accuracy: n ? +(correct / n).toFixed(3) : null };
    });
    summary.calibration = cal;
  }

  // ---- output ----
  const outDir = options.out || path.join('bench', `results-${runId}`);
  fs.mkdirSync(outDir, { recursive: true });
  const full = { summary, per_variant: { single: armResults['single']?.perModel, 'same-model': armResults['same-model']?.rows, 'cross-vendor': armResults['cross-vendor']?.rows } };
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(full, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.md'), renderReport(summary));

  if (options.json) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log('\n' + renderReport(summary));
  console.log(chalk.gray(`\nresults: ${path.join(outDir, 'results.json')}  |  report: ${path.join(outDir, 'report.md')}`));
}

function pct(x: number | null | undefined): string { return x == null ? 'n/a' : (x * 100).toFixed(1) + '%'; }
function renderReport(s: any): string {
  const L: string[] = [];
  L.push(`# BioFS benchmark report`);
  L.push(``);
  L.push(`Dataset: \`${s.dataset}\`  ·  ${s.n_variants} variants  ·  ${s.mock ? 'MOCK (deterministic, harness validation)' : 'LIVE (subscription CLIs)'}  ·  run \`${s.run_id}\``);
  L.push(``);
  L.push(`## Accuracy by arm`);
  L.push(``);
  L.push(`| Arm | n | Exact (5-tier) | Collapsed (path/VUS/benign) | Actionable (P/LP vs not) |`);
  L.push(`|---|---|---|---|---|`);
  if (s.arms.single?.per_model) {
    for (const mk of Object.keys(s.arms.single.per_model)) {
      const a = s.arms.single.per_model[mk];
      L.push(`| single: ${mk}${s.arms.single.best_model === mk ? ' (best)' : ''} | ${a.n} | ${pct(a.exact)} | ${pct(a.collapsed)} | ${pct(a.actionable)} |`);
    }
  }
  if (s.arms['same-model']) { const a = s.arms['same-model']; L.push(`| same-model: ${a.model} ×${a.rounds} | ${a.n} | ${pct(a.exact)} | ${pct(a.collapsed)} | ${pct(a.actionable)} |`); }
  if (s.arms['cross-vendor']) { const a = s.arms['cross-vendor']; L.push(`| cross-vendor ×${a.rounds} | ${a.n} | ${pct(a.exact)} | ${pct(a.collapsed)} | ${pct(a.actionable)} |`); }
  L.push(``);
  if (s.comparison) {
    const c = s.comparison;
    L.push(`## Cross-vendor vs best single (${c.cross_vs_best_single})`);
    L.push(``);
    L.push(`- Errors the debate **rescued** (best single wrong, cross-vendor right): **${c.rescued_by_debate}**`);
    L.push(`- Errors the debate **introduced** (best single right, cross-vendor wrong): **${c.broken_by_debate}**`);
    L.push(`- **Net errors caught: ${c.net_errors_caught}**`);
    L.push(`- McNemar (paired): chi-square ${c.mcnemar.chi2}, p approx ${c.mcnemar.p_approx} (discordant b=${c.mcnemar.b_only_a}, c=${c.mcnemar.c_only_b})`);
    L.push(``);
  }
  if (s.calibration) {
    L.push(`## Confidence calibration (cross-vendor agent calls)`);
    L.push(``);
    L.push(`| Confidence | n | Collapsed accuracy |`);
    L.push(`|---|---|---|`);
    for (const b of s.calibration) L.push(`| ${b.range} | ${b.n} | ${pct(b.accuracy)} |`);
    L.push(``);
  }
  L.push(`Every classification is a signed, hash-chained turn; export any case with \`biofs ws export\` and re-verify with \`biofs ws verify\`.`);
  return L.join('\n');
}

// ===========================================================================
// biofs benchmark-prepare <variant_summary.txt[.gz]> — build the publication
// dataset from a ClinVar variant_summary export. Streams the file (handles
// .gz), filters to >= N gold stars and an unambiguous classification, parses
// HGVS/gene/protein from the Name column, and emits a stratified, deterministic
// JSONL sample (reservoir per tier). Truth labels come from ClinVar; they are
// only ever used for scoring, never shown to an agent.
// ===========================================================================
export interface PrepareOptions {
  out?: string; perTier?: string; max?: string; genes?: string; tiers?: string;
  assembly?: string; minStars?: string; json?: boolean;
}

function clinvarStars(reviewStatus: string): number {
  const r = String(reviewStatus || '').toLowerCase();
  if (r.includes('practice guideline')) return 4;
  if (r.includes('expert panel')) return 3;
  if (r.includes('multiple submitters') && r.includes('no conflict')) return 2;
  if (r.includes('conflict')) return 1;
  if (r.includes('single submitter')) return 1;
  return 0;
}
function clinvarTier(sig: string): Tier | null {
  const s = String(sig || '').toLowerCase().trim();
  if (!s || s.includes('conflict')) return null;
  if (s.startsWith('pathogenic/likely pathogenic')) return 'LP';
  if (s.startsWith('likely pathogenic')) return 'LP';
  if (s.startsWith('pathogenic')) return 'P';
  if (s.startsWith('benign/likely benign')) return 'LB';
  if (s.startsWith('likely benign')) return 'LB';
  if (s.startsWith('benign')) return 'B';
  if (s.startsWith('uncertain significance')) return 'VUS';
  return null; // drug response, risk factor, association, protective, other, not provided
}
function parseClinvarName(name: string): { transcript: string; gene: string; cpart: string; protein: string } | null {
  // e.g. "NM_007294.4(BRCA1):c.68_69del (p.Glu23ValfsTer17)"
  const m = String(name || '').match(/^([NXM_0-9.]+)\(([^)]+)\):(c\.[^ ]+)(?:\s*\(([^)]+)\))?/);
  if (!m) return null;
  return { transcript: m[1].trim(), gene: m[2].trim(), cpart: m[3].trim(), protein: (m[4] || '').trim() };
}

export async function benchmarkPrepareCommand(clinvarFile: string, options: PrepareOptions = {}): Promise<void> {
  if (!fs.existsSync(clinvarFile)) { Logger.error(`file not found: ${clinvarFile}`); process.exit(1); }
  const minStars = Math.max(0, Number(options.minStars) || 2);
  const perTier = Math.max(1, Number(options.perTier) || 100);
  const maxTotal = options.max ? Number(options.max) : Infinity;
  const assembly = (options.assembly || 'GRCh38').toUpperCase();
  const tierFilter = options.tiers ? new Set(options.tiers.split(',').map((s) => s.trim().toUpperCase())) : null;
  const geneFilter = options.genes ? new Set(options.genes.split(',').map((s) => s.trim().toUpperCase())) : null;
  const outFile = options.out || path.join('bench', 'clinvar.jsonl');

  let stream: NodeJS.ReadableStream = fs.createReadStream(clinvarFile);
  if (/\.gz$/i.test(clinvarFile)) stream = stream.pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let header: string[] | null = null;
  const idx: Record<string, number> = {};
  const reservoir: Record<string, any[]> = { P: [], LP: [], VUS: [], LB: [], B: [] };
  const seen: Record<string, number> = { P: 0, LP: 0, VUS: 0, LB: 0, B: 0 };
  const dedup = new Set<string>();
  let scanned = 0;

  for await (const line of rl) {
    if (!line) continue;
    if (header === null) {
      header = line.replace(/^#/, '').split('\t');
      header.forEach((h, i) => { idx[h.trim()] = i; });
      for (const need of ['Name', 'GeneSymbol', 'ClinicalSignificance', 'ReviewStatus']) {
        if (!(need in idx)) { Logger.error(`ClinVar header missing column "${need}" (is this variant_summary.txt?)`); process.exit(1); }
      }
      continue;
    }
    scanned++;
    const cols = line.split('\t');
    const asm = (cols[idx['Assembly']] || '').toUpperCase();
    if (idx['Assembly'] !== undefined && asm && asm !== assembly) continue;
    if (clinvarStars(cols[idx['ReviewStatus']]) < minStars) continue;
    const tier = clinvarTier(cols[idx['ClinicalSignificance']]);
    if (!tier) continue;
    if (tierFilter && !tierFilter.has(tier)) continue;
    const parsed = parseClinvarName(cols[idx['Name']]);
    if (!parsed) continue;
    const gene = (cols[idx['GeneSymbol']] || parsed.gene).trim();
    if (!gene || gene === '-') continue;
    if (geneFilter && !geneFilter.has(gene.toUpperCase())) continue;
    const variant_id = `${gene}_${parsed.cpart.replace(/[^a-zA-Z0-9]/g, '')}`;
    if (dedup.has(variant_id)) continue;
    dedup.add(variant_id);
    const rec = { variant_id, gene, hgvs: `${parsed.transcript}:${parsed.cpart}`, protein: parsed.protein, truth: tier, note: `ClinVar ${cols[idx['ClinicalSignificance']]} (${cols[idx['ReviewStatus']]})` };
    // deterministic reservoir sample per tier
    seen[tier]++;
    if (reservoir[tier].length < perTier) reservoir[tier].push(rec);
    else { const j = det(`${variant_id}|${seen[tier]}`) % seen[tier]; if (j < perTier) reservoir[tier][j] = rec; }
  }

  let out: any[] = [];
  for (const t of TIERS) out = out.concat(reservoir[t]);
  if (out.length > maxTotal) out = out.slice(0, maxTotal);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, out.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const counts: Record<string, number> = {};
  for (const r of out) counts[r.truth] = (counts[r.truth] || 0) + 1;
  const result = { input: clinvarFile, scanned, min_stars: minStars, assembly, per_tier: perTier, written: out.length, by_tier: counts, out: outFile };
  if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(chalk.bold('benchmark-prepare') + chalk.gray(`  scanned ${scanned} rows  ≥${minStars}★ ${assembly}`));
  console.log(chalk.green(`  wrote ${out.length} variants`) + chalk.gray(`  to ${outFile}`));
  console.log(chalk.gray('  by tier: ' + TIERS.map((t) => `${t}=${counts[t] || 0}`).join('  ')));
  console.log(chalk.gray(`  run:  biofs benchmark ${outFile} --models claude,grok,gemini`));
}
