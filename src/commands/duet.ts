/**
 * biofs duet <case_id> — the intra-LLM conductor.
 *
 * Drives Claude Code (Opus 4.8) and Grok Build through their SUBSCRIPTION CLIs
 * in headless mode (`claude -p`, `grok -p`). No billed APIs: both authenticate
 * from their stored logins (~/.claude, ~/.grok/auth.json); the conductor strips
 * ANTHROPIC_API_KEY / XAI_API_KEY from the child env so subscription auth is used.
 *
 * The conversation is NOT passed in the prompt. Each turn prompt is tiny; the
 * model hydrates the shared conversation from biofs-node via its biofs MCP
 * (workspace_read), inspects the immutable data (bio_resolve/variants), then
 * appends exactly one turn (workspace_append). The record lives server-side in
 * biofs-node (append-only, hash-chained), which is what makes it reproducible.
 *
 * The conductor itself only sequences turns and writes a `conductor` meta turn
 * per CLI invocation (cmd + exit_code + duration), so the orchestration is
 * reproducible too. Use --mock to exercise the loop without spawning the CLIs.
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import chalk from 'chalk';
import { Logger } from '../lib/utils/logger';
import { bioNodeBase, wsNode } from './workspace';

export interface DuetOptions {
  task?: string;
  biocid?: string;
  rounds?: string;
  mode?: 'alternate' | 'parallel' | 'consensus';
  models?: string;
  node?: string;
  biorouter?: string;
  mcpDist?: string;
  claudeBin?: string;
  grokBin?: string;
  geminiBin?: string;
  geminiModel?: string;
  mock?: boolean;
  dryRun?: boolean;
  json?: boolean;
  timeout?: string;   // per-CLI-invocation timeout, seconds (grok startup is slow)
  referee?: string;   // model key that adjudicates disagreements into a final call
}

// Parse token/cost telemetry from a model CLI's --output-format json blob.
function parseUsage(modelKey: string, stdout: string): any {
  try {
    const last = (stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
    const obj = JSON.parse(last);
    const u = obj?.usage || obj?.usageMetadata || obj?.stats?.usage || obj?.stats || {};
    return {
      tokens_in: u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount ?? null,
      tokens_out: u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount ?? null,
      cost_usd: obj?.total_cost_usd ?? null,
    };
  } catch { return {}; }
}

// Resolve via BIOFS_MCP_DIST or --mcp-dist; no machine-local absolute paths in the published package.
const DEFAULT_MCP_DIST = process.env.BIOFS_MCP_DIST || '';

interface ModelDef {
  key: string;
  label: string;       // agent_id stamped into turns
  modelId: string;
  bin: string;
  // resume=true on rounds > 1: Claude needs --resume for an existing session
  // (--session-id errors "already in use"); Grok's -s creates-or-resumes either way.
  buildArgs: (prompt: string, cfgPath: string, session: string, resume: boolean) => string[];
}

function uuidFrom(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function subscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // force subscription auth, never billed API keys
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.XAI_API_KEY;
  delete env.GROK_API_KEY;
  return env;
}

function ensureClaudeMcpConfig(nodeBase: string, mcpDist: string, biorouter: string): string {
  const dir = path.join(os.homedir(), '.biofs', 'duet');
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, 'claude.biofs.mcp.json');
  const cfg = {
    mcpServers: {
      biofs: {
        command: 'node',
        args: [mcpDist],
        env: {
          BIOFS_AGENT_ID: 'claude-code',
          BIOFS_NODE_BASE: nodeBase,
          BIOROUTER_URL: biorouter,
        },
      },
    },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

function runCmd(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 300_000): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stdout = '', stderr = '', done = false;
    const child = spawn(bin, args, { env });
    const finish = (r: { code: number; stdout: string; stderr: string; ms: number }) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } finish({ code: 124, stdout, stderr: stderr + `\n[conductor] killed after ${timeoutMs}ms timeout`, ms: Date.now() - t0 }); }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => finish({ code: 127, stdout, stderr: stderr + String((e as Error).message), ms: Date.now() - t0 }));
    child.on('close', (code) => finish({ code: code ?? 0, stdout, stderr, ms: Date.now() - t0 }));
  });
}

function buildPrompt(label: string, other: string, caseId: string, task: string, biocid?: string): string {
  return [
    `You are ${label}, co-working clinical case ${caseId} with another AI (${other}) on a shared biofs workspace.`,
    `Use the biofs MCP tools. First call workspace_open then workspace_read (since_seq = the cursor) to load the conversation so far.`,
    biocid ? `The data under discussion is ${biocid}; inspect it with bio_resolve / variants and cite biocid + content_hash for every claim.` : `Cite biocid + content_hash for every data-backed claim.`,
    `Then call workspace_append EXACTLY ONCE with your contribution (a clear role and content, plus refs).`,
    `When you reach a verdict on a variant, ALSO call workspace_classify (subject, classification, criteria[], confidence 0-1) so your call is machine-comparable; you may call workspace_consensus to see where you and ${other} disagree.`,
    `Do not repeat what was already said; advance the analysis or challenge ${other}. Then stop.`,
    `Task: ${task}`,
  ].join(' ');
}

const MOCK_LINES: Record<string, string> = {
  'claude-code': 'KRAS G12C present (VAF 0.34); recommend confirming with orthogonal calling. Proposing it as actionable (sotorasib).',
  'grok-build': 'Concur on KRAS G12C; I re-resolved the same biocid and the content_hash matches. Also flag TP53 R175H as co-occurring.',
  'gemini-cli': 'Agree KRAS G12C is the driver, though I would hold it at Likely pathogenic pending segregation; STK11 co-loss would change immunotherapy expectations.',
};

const MOCK_CLAIM: Record<string, { classification: string; confidence: number }> = {
  'claude-code': { classification: 'Pathogenic', confidence: 0.9 },
  'grok-build': { classification: 'Pathogenic', confidence: 0.7 },
  'gemini-cli': { classification: 'Likely pathogenic', confidence: 0.8 },
};

export async function duetCommand(caseId: string, options: DuetOptions = {}): Promise<void> {
  const nodeBase = bioNodeBase(options.node);
  const biorouter = options.biorouter || process.env.BIOROUTER_URL || 'https://bioip.genobank.app';
  const mcpDist = options.mcpDist || process.env.BIOFS_MCP_DIST || DEFAULT_MCP_DIST;
  const rounds = Math.max(1, Number(options.rounds) || 3);
  const mode = options.mode || 'alternate';
  const task = options.task || 'Interpret the variants and agree on the top actionable findings.';
  const order = (options.models || 'claude,grok').split(',').map((s) => s.trim()).filter(Boolean);
  const timeoutMs = Math.max(30, Number(options.timeout) || 300) * 1000;

  const MODELS: Record<string, ModelDef> = {
    claude: {
      key: 'claude', label: 'claude-code', modelId: 'claude-opus-4-8', bin: options.claudeBin || 'claude',
      buildArgs: (prompt, cfgPath, session, resume) => [
        '-p', prompt, '--model', 'claude-opus-4-8', '--output-format', 'json',
        '--mcp-config', cfgPath, '--strict-mcp-config',
        '--allowedTools', 'mcp__biofs__*', '--permission-mode', 'acceptEdits',
        ...(resume ? ['--resume', session] : ['--session-id', session]),
      ],
    },
    grok: {
      key: 'grok', label: 'grok-build', modelId: 'grok-build', bin: options.grokBin || 'grok',
      // --always-approve is auto-approval for unattended runs, but scoped: strip
      // the dangerous built-ins (shell, file writes, subagent spawning) and deny
      // destructive Bash, so Grok can only read + call the biofs MCP tools.
      buildArgs: (prompt, _cfg, session, _resume) => [
        '-p', prompt, '-m', 'grok-build', '--output-format', 'json',
        '-s', session, '--always-approve',
        '--disallowed-tools', 'run_terminal_cmd,write_file,search_replace,create_file,delete_file,apply_patch,Agent',
        '--deny', 'Bash(rm*)', '--deny', 'Bash(sudo*)',
      ],
    },
    gemini: {
      key: 'gemini', label: 'gemini-cli', modelId: options.geminiModel || 'gemini-3-flash-preview', bin: options.geminiBin || 'gemini',
      // --allowed-mcp-server-names biofs scopes Gemini to ONLY our MCP server
      // (fast startup, no other tools); --approval-mode yolo auto-approves for
      // unattended runs. Gemini hydrates the convo from the workspace each turn,
      // so it needs no cross-round session handle.
      buildArgs: (prompt, _cfg, _session, _resume) => [
        '-p', prompt, '-m', options.geminiModel || 'gemini-3-flash-preview', '-o', 'json',
        '--approval-mode', 'yolo', '--allowed-mcp-server-names', 'biofs',
      ],
    },
  };

  // ---- preflight ----------------------------------------------------------
  const pre: any = { node: nodeBase, mode, rounds, models: order, mock: !!options.mock, checks: {} };
  // probe a real workspace endpoint (healthz lives at root, not under the /agent base)
  const probe = await wsNode('GET', '/workspace/read?case_id=__duet_preflight__&limit=1', undefined, options.node).catch(() => ({ status: 0, data: null }));
  pre.checks.biofs_node = probe.status === 200 ? 'reachable' : `unreachable (${probe.status})`;
  pre.checks.api_keys_present = {
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    XAI_API_KEY: !!process.env.XAI_API_KEY,
  };
  if (process.env.ANTHROPIC_API_KEY || process.env.XAI_API_KEY) {
    Logger.warn('An API key env var is set; the conductor strips it from the child env to force SUBSCRIPTION auth.');
  }
  if (!options.mock) {
    for (const k of order) {
      const m = MODELS[k];
      if (!m) { Logger.error(`unknown model "${k}" (use claude,grok,gemini)`); process.exit(1); }
      pre.checks[`${k}_bin`] = which(m.bin) || 'NOT FOUND';
    }
    if (order.includes('grok')) {
      const grokCfg = path.join(os.homedir(), '.grok', 'config.toml');
      pre.checks.grok_config_has_biofs = fs.existsSync(grokCfg) && /\[mcp_servers\.biofs\]/.test(fs.readFileSync(grokCfg, 'utf8'))
        ? 'yes' : 'MISSING — run: grok mcp add biofs … (BIOFS_AGENT_ID=grok-build)';
    }
    if (order.includes('gemini')) {
      const gemCfg = path.join(os.homedir(), '.gemini', 'settings.json');
      let ok = false;
      try { ok = fs.existsSync(gemCfg) && !!JSON.parse(fs.readFileSync(gemCfg, 'utf8'))?.mcpServers?.biofs; } catch { ok = false; }
      pre.checks.gemini_config_has_biofs = ok ? 'yes' : 'MISSING — run: gemini mcp add biofs node <dist> --scope user --trust -e BIOFS_AGENT_ID=gemini-cli …';
    }
  }

  if (options.dryRun || options.json) {
    console.log(JSON.stringify(pre, null, 2));
    if (options.dryRun) return;
  }
  if (!options.json) {
    console.log(chalk.bold(`biofs duet ${caseId}`) + chalk.gray(`  mode=${mode} rounds=${rounds} models=${order.join('+')} ${options.mock ? '(MOCK)' : ''}`));
    console.log(chalk.gray(`  node: ${nodeBase}   biofs-node: ${pre.checks.biofs_node}`));
  }

  const claudeCfg = ensureClaudeMcpConfig(nodeBase, mcpDist, biorouter);

  // ---- open + seed --------------------------------------------------------
  const init: any = { title: task };
  if (options.biocid) init.biocids = [options.biocid];
  const opened = await wsNode('POST', '/workspace/open', { case_id: caseId, init }, options.node);
  if (opened.status >= 400) { Logger.error(`open failed: ${opened.data?.error}`); process.exit(1); }

  await appendConductor(caseId, options.node, `duet start: mode=${mode} rounds=${rounds} models=${order.join('+')} task="${task}"${options.biocid ? ` biocid=${options.biocid}` : ''}`);

  // ---- rounds -------------------------------------------------------------
  for (let round = 1; round <= rounds; round++) {
    if (!options.json) console.log(chalk.bold(`\n── round ${round}/${rounds} ──`));
    if (mode === 'parallel') {
      await Promise.all(order.map((k) => runTurn(k, round)));
    } else {
      for (const k of order) await runTurn(k, round);   // alternate / consensus
    }
  }

  // ---- optional referee adjudication --------------------------------------
  if (options.referee && !options.mock) {
    const rk = options.referee;
    const rm = MODELS[rk];
    if (rm) {
      if (!options.json) console.log(chalk.bold(`\n── referee (${rm.label}) ──`));
      const refPrompt = `You are the REFEREE for case ${caseId}. Call workspace_consensus to see where the agents disagree, review their claims via workspace_read, then for each DISAGREED subject call workspace_classify with your adjudicated final classification (cite ACMG criteria + confidence), and finish with one workspace_append summarizing the adjudication. Be decisive.`;
      const session = rk === 'claude' ? uuidFrom(`biofs-duet-${caseId}-referee`) : `biofs-duet-${caseId}-referee`;
      const res = await runCmd(rm.bin, rm.buildArgs(refPrompt, claudeCfg, session, false), subscriptionEnv(), timeoutMs);
      await appendConductor(caseId, options.node, `referee ${rm.label}: exit=${res.code} ${res.ms}ms`, { model: rm.modelId, exit_code: res.code, duration_ms: res.ms, role: 'referee', usage: parseUsage(rk, res.stdout) });
      if (!options.json) console.log((res.code === 0 ? chalk.green('    ok') : chalk.red(`    exit ${res.code}`)) + chalk.gray(` ${res.ms}ms`));
    }
  }

  // ---- replay (the reproducible record) + consensus -----------------------
  const rep = await wsNode('GET', `/workspace/replay?case_id=${encodeURIComponent(caseId)}`, undefined, options.node);
  const con = await wsNode('GET', `/workspace/consensus?case_id=${encodeURIComponent(caseId)}`, undefined, options.node);
  if (options.json) { console.log(JSON.stringify({ replay: rep.data, consensus: con.data }, null, 2)); return; }
  const d = rep.data;
  const byAgent: Record<string, number> = {};
  for (const t of d.turns) byAgent[t.agent_id] = (byAgent[t.agent_id] || 0) + 1;
  console.log(chalk.bold(`\n── record ──`));
  console.log((d.chain_valid ? chalk.green('  chain VALID') : chalk.red(`  chain BROKEN at seq ${d.break_at_seq}`)) + chalk.gray(`  ${d.count} turns  head ${String(d.head_hash).slice(0, 12)}…`));
  console.log(chalk.gray('  by agent: ' + Object.entries(byAgent).map(([a, n]) => `${a}=${n}`).join('  ')));
  const c = con.data || {};
  if (c.subjects_total) {
    const rate = c.agreement_rate == null ? 'n/a' : (c.agreement_rate * 100).toFixed(0) + '%';
    console.log(chalk.bold('── consensus ──') + chalk.gray(`  ${c.agreed}/${c.subjects_total} agree (${rate})`));
    for (const s of c.subjects) console.log((s.agreement ? chalk.green('  AGREE ') : chalk.red('  DIFFER')) + `  ${s.subject} => ${s.consensus_call || '?'}` + (s.agreement ? '' : chalk.gray('  {' + s.distinct_classifications.join(' | ') + '}')));
  }
  console.log(chalk.gray(`  audit:  biofs workspace replay ${caseId}  |  biofs workspace consensus ${caseId}`));

  // ---- helpers (closure over caseId/options) ------------------------------
  async function runTurn(k: string, round: number): Promise<void> {
    const m = MODELS[k];
    if (!m) return;
    const otherLabel = order.filter((o) => o !== k).map((o) => MODELS[o]?.label || o).join('+') || 'the other AI';
    const prompt = buildPrompt(m.label, otherLabel, caseId, task, options.biocid);
    const session = k === 'claude' ? uuidFrom(`biofs-duet-${caseId}-claude`) : `biofs-duet-${caseId}-grok`;

    // cursor before, to detect whether the model actually appended a turn
    const before = await wsNode('GET', `/workspace/read?case_id=${encodeURIComponent(caseId)}&since_seq=0&limit=1`, undefined, options.node);

    if (options.mock) {
      // simulate the model appending via its MCP (so the loop is testable w/o subscriptions)
      const refs = options.biocid ? [{ biocid: options.biocid, content_hash: 'synthetic', kind: 'vcf' }] : [];
      // mock classification so consensus is demonstrable: agents differ
      const mc = MOCK_CLAIM[m.label];
      const mockClaim = (options.biocid && mc)
        ? { subject: options.biocid, classification: mc.classification, criteria: ['PVS1', 'PM2'], confidence: mc.confidence }
        : undefined;
      await wsNode('POST', '/workspace/append', { case_id: caseId, turn: { agent_id: m.label, model: { name: m.modelId, version: null }, role: mockClaim ? 'classification' : 'analysis', content: MOCK_LINES[m.label] || `(${m.label} mock turn)`, refs, claim: mockClaim } }, options.node);
      await appendConductor(caseId, options.node, `invoked ${m.label} (MOCK) — appended 1 turn`);
      if (!options.json) console.log(chalk.gray(`  ${m.label}: mock turn appended`));
      return;
    }

    const args = m.buildArgs(prompt, claudeCfg, session, round > 1);
    if (!options.json) console.log(chalk.gray(`  ${m.label}: ${m.bin} -p … (headless, subscription)`));
    const res = await runCmd(m.bin, args, subscriptionEnv(), timeoutMs);
    const after = await wsNode('GET', `/workspace/read?case_id=${encodeURIComponent(caseId)}&since_seq=0&limit=1000`, undefined, options.node);
    const appended = (after.data?.count || 0) - (before.data?.count || 0);
    const usage = parseUsage(k, res.stdout);
    const tail = (res.stdout || res.stderr || '').replace(/\s+/g, ' ').slice(-180);
    await appendConductor(caseId, options.node,
      `invoked ${m.label}: ${m.bin} -p (exit=${res.code}, ${res.ms}ms, appended=${appended}). out_tail="${tail}"`,
      { model: m.modelId, exit_code: res.code, duration_ms: res.ms, appended, usage });
    const costStr = usage.cost_usd != null ? ` $${Number(usage.cost_usd).toFixed(4)}` : '';
    const tokStr = (usage.tokens_in != null || usage.tokens_out != null) ? ` tok ${usage.tokens_in ?? '?'}/${usage.tokens_out ?? '?'}` : '';
    if (!options.json) console.log((res.code === 0 ? chalk.green('    ok') : chalk.red(`    exit ${res.code}`)) + chalk.gray(` ${res.ms}ms  appended=${appended}${tokStr}${costStr}`));
    if (res.code !== 0 && tail) console.log(chalk.gray('    ' + tail));
  }
}

async function appendConductor(caseId: string, node: string | undefined, content: string, meta?: any): Promise<void> {
  await wsNode('POST', '/workspace/append', {
    case_id: caseId,
    turn: { agent_id: 'conductor', model: { name: 'biofs-duet', version: null }, role: 'system', content, meta: meta || null },
  }, node).catch(() => {});
}
