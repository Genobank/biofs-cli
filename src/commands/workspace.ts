/**
 * biofs workspace <verb> — the shared intra-LLM case workspace.
 *
 * Thin clients of biofs-node's /agent/workspace/* endpoints. Two LLM clients
 * (Claude Code + Grok Build) co-work one case through this append-only,
 * hash-chained log; biofs-node is the single authority for seq + chain. These
 * verbs let a human (or the `biofs duet` conductor) seed, inspect, and audit
 * the conversation from the CLI.
 *
 * Path convention matches `biofs annotate submit`: BIOFS_NODE_URL carries the
 * routing prefix (`.../api_biofs_node` via nginx → biofs-node /agent/*, or
 * `http://host:8787/agent` direct); the verb path appended here is bare.
 */

import axios from 'axios';
import chalk from 'chalk';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { ethers } from 'ethers';
import { Logger } from '../lib/utils/logger';
import { getCredentials } from '../lib/auth/credentials';

// ref format is biocid:content_hash:kind; biocid contains "://" so parse from the right.
function parseRefs(refs?: string[]): Array<{ biocid: string; content_hash?: string; kind?: string }> {
  return (refs || []).map((r: string) => {
    const parts = r.split(':');
    const kind = parts.length >= 3 ? parts.pop() : undefined;
    const content_hash = parts.length >= 2 ? parts.pop() : undefined;
    return { biocid: parts.join(':'), content_hash, kind };
  });
}

export interface WorkspaceOptions {
  node?: string;
  json?: boolean;
  quiet?: boolean;
  // open
  title?: string;
  biocid?: string[];
  // read
  sinceSeq?: string;
  limit?: string;
  // append
  as?: string;
  role?: string;
  content?: string;
  ref?: string[];
  // case
  status?: string;
  expectedVersion?: string;
  activeEditor?: string;
  // lease
  holder?: string;
  ttl?: string;
  release?: boolean;
  // anchor
  upToSeq?: string;
  // classify
  subject?: string;
  classification?: string;
  criteria?: string;
  confidence?: string;
  rationale?: string;
  strength?: string;
  // export/verify
  out?: string;
}

export function bioNodeBase(override?: string): string {
  return (
    override ||
    process.env.BIOFS_NODE_URL ||
    `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`
  ).replace(/\/$/, '');
}

interface NodeResult { status: number; data: any }

export async function wsNode(
  method: 'GET' | 'POST',
  path: string,
  body?: any,
  base?: string,
): Promise<NodeResult> {
  const url = `${bioNodeBase(base)}${path}`;
  try {
    const res = await axios({ method, url, data: body, timeout: 60_000, validateStatus: () => true });
    return { status: res.status, data: res.data };
  } catch (err: any) {
    return { status: 502, data: { error: 'biofs_node_unreachable', detail: err?.message, url } };
  }
}

function out(data: any, options: WorkspaceOptions): void {
  if (options.json) console.log(JSON.stringify(data, null, 2));
}

// ---- biofs workspace open <case_id> ---------------------------------------
export async function workspaceOpenCommand(caseId: string, options: WorkspaceOptions = {}): Promise<void> {
  const creds = await getCredentials().catch(() => null);
  const init: any = {};
  if (options.title) init.title = options.title;
  if (options.biocid && options.biocid.length) init.biocids = options.biocid;
  if (creds?.wallet_address) init.owner_wallet = creds.wallet_address;
  const { status, data } = await wsNode('POST', '/workspace/open', { case_id: caseId, init }, options.node);
  if (status >= 400) { Logger.error(`workspace open ${status}: ${data?.error || ''}`); process.exit(1); }
  if (options.json) return out(data, options);
  if (!options.quiet) {
    console.log(chalk.bold(`case ${data.case.case_id}`) + chalk.gray(`  v${data.case._version}  ${data.case.status}  (${data.durable ? 'durable' : 'memory'})`));
    console.log(chalk.gray(`  turns: ${data.turns.length}  cursor: ${data.cursor}`));
    if (data.case.biocids?.length) console.log(chalk.gray(`  biocids: ${data.case.biocids.join(', ')}`));
  }
}

// ---- biofs workspace read <case_id> ---------------------------------------
export async function workspaceReadCommand(caseId: string, options: WorkspaceOptions = {}): Promise<void> {
  const since = Number(options.sinceSeq) || 0;
  const limit = Number(options.limit) || 500;
  const { status, data } = await wsNode('GET', `/workspace/read?case_id=${encodeURIComponent(caseId)}&since_seq=${since}&limit=${limit}`, undefined, options.node);
  if (status >= 400) { Logger.error(`workspace read ${status}: ${data?.error || ''}`); process.exit(1); }
  if (options.json) return out(data, options);
  if (!options.quiet) {
    console.log(chalk.gray(`${data.count} turn(s) since seq ${since} (cursor ${data.cursor})`));
    for (const t of data.turns) printTurn(t);
  }
}

// ---- biofs workspace append <case_id> -------------------------------------
export async function workspaceAppendCommand(caseId: string, options: WorkspaceOptions = {}): Promise<void> {
  const agentId = options.as || 'operator';
  const refs = parseRefs(options.ref);
  const turn = {
    agent_id: agentId,
    role: options.role || 'message',
    content: options.content ?? '',
    refs,
  };
  const { status, data } = await wsNode('POST', '/workspace/append', { case_id: caseId, turn }, options.node);
  if (status >= 400) { Logger.error(`workspace append ${status}: ${data?.error || ''}`); process.exit(1); }
  if (options.json) return out(data, options);
  if (!options.quiet) console.log(chalk.green(`appended seq ${data.turn.seq}`) + chalk.gray(` by ${data.turn.agent_id}  hash ${String(data.turn.turn_hash).slice(0, 12)}…`));
}

// ---- biofs workspace case <case_id> (CAS header update) -------------------
export async function workspaceCaseCommand(caseId: string, options: WorkspaceOptions = {}): Promise<void> {
  const patch: any = {};
  if (options.title) patch.title = options.title;
  if (options.status) patch.status = options.status;
  if (options.activeEditor) patch.active_editor = options.activeEditor;
  if (options.biocid && options.biocid.length) patch.biocids = options.biocid;
  const expected = Number(options.expectedVersion) || 0;
  const { status, data } = await wsNode('POST', '/workspace/case', { case_id: caseId, patch, expected_version: expected }, options.node);
  if (options.json) return out(data, options);
  if (data.conflict) { console.log(chalk.yellow(`conflict: header is at v${data.current_version}, you sent expected_version ${expected}. Re-read and retry.`)); process.exit(2); }
  if (!options.quiet) console.log(chalk.green(`case updated to v${data.case._version}`) + chalk.gray(`  status=${data.case.status}`));
}

// ---- biofs workspace lease <resource> -------------------------------------
export async function workspaceLeaseCommand(resource: string, options: WorkspaceOptions = {}): Promise<void> {
  const holder = options.holder || options.as || 'operator';
  const action = options.release ? 'release' : 'claim';
  const { status, data } = await wsNode('POST', '/workspace/lease', { action, resource, holder, ttl_sec: Number(options.ttl) || 60 }, options.node);
  if (status >= 400) { Logger.error(`workspace lease ${status}: ${data?.error || ''}`); process.exit(1); }
  if (options.json) return out(data, options);
  if (!options.quiet) {
    if (action === 'release') console.log(data.released ? chalk.green('lease released') : chalk.gray('no lease held'));
    else console.log(data.granted ? chalk.green(`lease granted to ${holder}`) : chalk.yellow(`denied — held by ${data.held_by}`));
  }
}

// ---- biofs workspace replay <case_id> -------------------------------------
export async function workspaceReplayCommand(caseId: string, options: WorkspaceOptions = {}): Promise<void> {
  const { status, data } = await wsNode('GET', `/workspace/replay?case_id=${encodeURIComponent(caseId)}`, undefined, options.node);
  if (status >= 400) { Logger.error(`workspace replay ${status}: ${data?.error || ''}`); process.exit(1); }
  if (options.json) return out(data, options);
  if (!options.quiet) {
    const ok = data.chain_valid;
    console.log(chalk.bold(`replay ${caseId}`) + chalk.gray(`  ${data.count} turns  (${data.durable ? 'durable' : 'memory'})`));
    console.log((ok ? chalk.green('  chain VALID') : chalk.red(`  chain BROKEN at seq ${data.break_at_seq}: ${(data.reasons || []).join('; ')}`)) + chalk.gray(`  head ${String(data.head_hash).slice(0, 12)}…`));
    for (const t of data.turns) printTurn(t);
  }
  if (!data.chain_valid) process.exit(3);
}

// ---- biofs workspace anchor <case_id> -------------------------------------
export async function workspaceAnchorCommand(caseId: string, options: WorkspaceOptions = {}): Promise<void> {
  const body: any = { case_id: caseId };
  if (options.upToSeq) body.up_to_seq = Number(options.upToSeq);
  const { status, data } = await wsNode('POST', '/workspace/anchor', body, options.node);
  if (status >= 400) { Logger.error(`workspace anchor ${status}: ${data?.error || ''}`); process.exit(1); }
  if (options.json) return out(data, options);
  if (!options.quiet) console.log(chalk.green(`anchored segment up_to_seq=${data.anchor.up_to_seq}`) + chalk.gray(`  segment_hash ${String(data.anchor.segment_hash).slice(0, 16)}…  on-chain: ${data.anchor.anchored}`));
}

// ---- biofs workspace classify <case_id> -----------------------------------
export async function workspaceClassifyCommand(caseId: string, options: WorkspaceOptions = {}): Promise<void> {
  if (!options.subject || !options.classification) {
    Logger.error('--subject and --classification are required');
    process.exit(1);
  }
  const claim = {
    subject: options.subject,
    classification: options.classification,
    criteria: (options.criteria || '').split(',').map((s) => s.trim()).filter(Boolean),
    strength: options.strength || null,
    confidence: options.confidence != null ? Number(options.confidence) : null,
  };
  const turn = {
    agent_id: options.as || 'operator',
    role: 'classification',
    content: options.rationale || `${claim.classification} for ${claim.subject}` + (claim.criteria.length ? ` (${claim.criteria.join(',')})` : ''),
    refs: parseRefs(options.ref),
    claim,
  };
  const { status, data } = await wsNode('POST', '/workspace/append', { case_id: caseId, turn }, options.node);
  if (status >= 400) { Logger.error(`workspace classify ${status}: ${data?.error || ''}`); process.exit(1); }
  if (options.json) return out(data, options);
  if (!options.quiet) console.log(chalk.green(`classified seq ${data.turn.seq}`) + chalk.gray(`  ${claim.subject} => ${claim.classification} by ${data.turn.agent_id}`));
}

// ---- biofs workspace consensus <case_id> ----------------------------------
export async function workspaceConsensusCommand(caseId: string, options: WorkspaceOptions = {}): Promise<void> {
  const { status, data } = await wsNode('GET', `/workspace/consensus?case_id=${encodeURIComponent(caseId)}`, undefined, options.node);
  if (status >= 400) { Logger.error(`workspace consensus ${status}: ${data?.error || ''}`); process.exit(1); }
  if (options.json) return out(data, options);
  if (!options.quiet) {
    const rate = data.agreement_rate == null ? 'n/a' : (data.agreement_rate * 100).toFixed(0) + '%';
    console.log(chalk.bold(`consensus ${caseId}`) + chalk.gray(`  ${data.agreed}/${data.subjects_total} subjects agree  (rate ${rate})`));
    for (const s of data.subjects) {
      const head = s.agreement ? chalk.green('AGREE') : chalk.red('DISAGREE');
      console.log(`  ${head}  ${chalk.bold(s.subject)} => ${s.consensus_call || '?'}${s.agreement ? '' : chalk.gray('  {' + s.distinct_classifications.join(' | ') + '}')}`);
      for (const c of s.calls) console.log(chalk.gray(`      ${c.agent_id}: ${c.classification}${c.confidence != null ? ' @' + c.confidence : ''}${c.criteria && c.criteria.length ? ' [' + c.criteria.join(',') + ']' : ''}`));
    }
  }
}

// ---- biofs workspace export <case_id> -------------------------------------
export async function workspaceExportCommand(caseId: string, options: WorkspaceOptions = {}): Promise<void> {
  const { status, data } = await wsNode('GET', `/workspace/replay?case_id=${encodeURIComponent(caseId)}`, undefined, options.node);
  if (status >= 400) { Logger.error(`workspace export ${status}: ${data?.error || ''}`); process.exit(1); }
  const payload = JSON.stringify(data, null, 2);
  if (options.out) { fs.writeFileSync(options.out, payload); if (!options.quiet) console.log(chalk.green(`wrote ${options.out}`) + chalk.gray(`  ${data.count} turns, chain_valid=${data.chain_valid}`)); }
  else console.log(payload);
}

// ===== Self-contained, zero-trust OFFLINE verifier =========================
// An INDEPENDENT reimplementation of the hash-chain spec (separate package +
// language path from biofs-node). If this agrees with the server, the record is
// reproducible by a third party with no access to GenoBank infra. This is the
// reproducibility artifact for publication. Spec MUST match biofs-node workspace.js.
const WS_HASH_FIELDS = ['case_id', 'seq', 'agent_id', 'model', 'role', 'ts', 'content', 'tool_calls', 'tool_results', 'refs', 'claim', 'meta', 'prev_hash'];
const WS_GENESIS = '0'.repeat(64);
function wsSortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(wsSortKeys);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((a: any, k) => { a[k] = wsSortKeys(v[k]); return a; }, {});
  return v;
}
function wsCanonical(o: any): string { return JSON.stringify(wsSortKeys(o)); }
function wsHashableBase(t: any): any { const b: any = {}; for (const k of WS_HASH_FIELDS) b[k] = t[k] === undefined ? null : t[k]; return b; }
function wsTurnHash(t: any): string { return createHash('sha256').update(wsCanonical(wsHashableBase(t))).digest('hex'); }
// MUST match biofs-node workspace.js signedPayloadString.
function wsSignedPayload(t: any): string {
  return wsCanonical({
    agent_id: String(t.agent_id),
    role: t.role || 'message',
    content: t.content ?? '',
    refs: Array.isArray(t.refs) ? t.refs : [],
    claim: t.claim || null,
  });
}
function verifyChainLocal(turns: any[]): { chain_valid: boolean; break_at_seq: number | null; reasons: string[]; count: number; head_hash: string; signed: number; sig_failures: number[] } {
  let prev = WS_GENESIS, valid = true, breakAt: number | null = null;
  const reasons: string[] = [];
  let signed = 0;
  const sigFailures: number[] = [];
  for (const t of turns) {
    if (t.prev_hash !== prev) { valid = false; breakAt = t.seq; reasons.push(`seq ${t.seq}: prev_hash link broken`); break; }
    if (wsTurnHash(t) !== t.turn_hash) { valid = false; breakAt = t.seq; reasons.push(`seq ${t.seq}: content hash mismatch (tampered)`); break; }
    if (t.sig && t.signer) {
      signed++;
      try {
        const recovered = ethers.verifyMessage(wsSignedPayload(t), t.sig);
        if (recovered.toLowerCase() !== String(t.signer).toLowerCase()) sigFailures.push(t.seq);
      } catch { sigFailures.push(t.seq); }
    }
    prev = t.turn_hash;
  }
  return { chain_valid: valid, break_at_seq: breakAt, reasons, count: turns.length, head_hash: turns.length ? turns[turns.length - 1].turn_hash : WS_GENESIS, signed, sig_failures: sigFailures };
}

// ---- biofs workspace verify <file> [--offline] ----------------------------
export async function workspaceVerifyCommand(file: string, options: WorkspaceOptions = {}): Promise<void> {
  let doc: any;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e: any) { Logger.error(`cannot read ${file}: ${e.message}`); process.exit(1); }
  const turns = Array.isArray(doc) ? doc : (doc.turns || []);
  if (!turns.length) { Logger.error('no turns found in file'); process.exit(1); }
  const r = verifyChainLocal(turns);
  if (options.json) return out({ ...r, file, independent: true }, options);
  console.log(chalk.bold(`offline verify ${file}`) + chalk.gray(`  ${r.count} turns  (independent reimplementation)`));
  console.log(r.chain_valid
    ? chalk.green(`  chain VALID`) + chalk.gray(`  head ${r.head_hash.slice(0, 16)}…`)
    : chalk.red(`  chain BROKEN at seq ${r.break_at_seq}: ${r.reasons.join('; ')}`));
  // signature provenance
  if (r.signed > 0) {
    console.log(r.sig_failures.length === 0
      ? chalk.green(`  signatures VALID`) + chalk.gray(`  ${r.signed}/${r.count} turns cryptographically signed`)
      : chalk.red(`  signature FAILURES at seq ${r.sig_failures.join(', ')}`) + chalk.gray(`  (${r.signed}/${r.count} signed)`));
  } else {
    console.log(chalk.gray('  signatures: none (turns unsigned)'));
  }
  // provenance summary: agents + cited biocids
  const agents: Record<string, number> = {}; const biocids = new Set<string>();
  for (const t of turns) { agents[t.agent_id] = (agents[t.agent_id] || 0) + 1; for (const ref of (t.refs || [])) if (ref.biocid) biocids.add(ref.biocid); }
  console.log(chalk.gray('  authors: ' + Object.entries(agents).map(([a, n]) => `${a}=${n}`).join('  ')));
  if (biocids.size) console.log(chalk.gray('  cited biocids: ' + [...biocids].join(', ')));
  process.exit((r.chain_valid && r.sig_failures.length === 0) ? 0 : 3);
}

function printTurn(t: any): void {
  const who = t.agent_id === 'claude-code' ? chalk.cyan(t.agent_id)
    : t.agent_id === 'grok-build' ? chalk.magenta(t.agent_id)
    : t.agent_id === 'conductor' ? chalk.gray(t.agent_id)
    : chalk.white(t.agent_id);
  console.log(`  ${chalk.gray('#' + String(t.seq).padStart(3))} ${who} ${chalk.gray('[' + t.role + ']')}`);
  const body = String(t.content || '').replace(/\n/g, '\n      ');
  if (body) console.log('      ' + body);
  if (t.refs?.length) console.log(chalk.gray('      refs: ' + t.refs.map((r: any) => `${r.biocid || '?'}@${String(r.content_hash || '').slice(0, 8)}`).join(', ')));
}
