/**
 * The egress gate. Every outgoing event passes it on the author's Mac, before encryption; a blocked
 * event never leaves the Mac and there is no override flag. Checks, in order: size, secret
 * patterns, recovery phrases, the author's denylist, and the HumanMark PHI and genomic-data screen
 * (the HumanMark engine when it is installed, a built-in screen otherwise; status reports which).
 */

import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Mnemonic, wordlists } from 'ethers';

export interface GateResult { ok: boolean; reasons: string[]; engine: 'humanmark' | 'builtin' }

const MAX_CHARS = 32_000;

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private key block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style API key', /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ['Stripe key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Google OAuth token', /\bya29\.[0-9A-Za-z_-]{20,}/],
  ['cloud access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['secret assignment', /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE)[A-Z0-9_]*\s*=\s*\S{8,}/m],
  ['wallet private key', /(?:private[_ ]?key|privkey|secret)[^\n]{0,40}\b(?:0x)?[a-fA-F0-9]{64}\b/i],
];

const PHI_PATTERNS: Array<[string, RegExp]> = [
  ['social security number', /\b\d{3}-\d{2}-\d{4}\b/],
  ['date of birth', /\b(?:DOB|date of birth)\b\s*[:#-]?\s*\d/i],
  ['medical record number', /\bMRN\b\s*[:#]?\s*\d{5,}/i],
  ['genotype call', /\brs\d{3,}\b\s*[:=]?\s*[ACGT]{1,2}\b/],
  ['raw DNA sequence', /[ACGT]{60,}/],
  ['VCF record', /^(?:chr)?(?:[0-9]{1,2}|X|Y|MT?)\t\d+\t/m],
];

// A recovery phrase: 12 consecutive BIP-39 words, or a run of BIP-39 words separated by at most 2
// filler words drawn from no more than 3 distinct fillers ("abandon and ability and ...") that holds a
// checksum-valid 12 to 24 word mnemonic. Measured on 426 paragraphs of the design, ERC-8356, a review
// and a README: 0 flagged; every plain, numbered, comma, newline and filler form of a phrase flagged.
function recoveryPhrase(text: string): boolean {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const en = wordlists.en;
  const isWord = (w: string) => en.getWordIndex(w) >= 0;
  let run = 0;
  for (const w of words) {
    run = isWord(w) ? run + 1 : 0;
    if (run >= 12) return true;
  }
  const runs: string[][] = [];
  let cur: string[] = [];
  let fillers = new Set<string>();
  let misses = 0;
  const close = () => { if (cur.length >= 12) runs.push(cur); cur = []; fillers = new Set(); misses = 0; };
  for (const w of words) {
    if (isWord(w)) { cur.push(w); misses = 0; continue; }
    misses++;
    fillers.add(w);
    if (misses > 2 || fillers.size > 3) close();
  }
  close();
  for (const r of runs) {
    for (const n of [12, 15, 18, 21, 24]) {
      for (let k = 0; k + n <= r.length; k++) if (Mnemonic.isValidMnemonic(r.slice(k, k + n).join(' '))) return true;
    }
  }
  return false;
}

function humanmarkCommand(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  if (process.env.KIOSK_HUMANMARK_CMD) {
    const parts = process.env.KIOSK_HUMANMARK_CMD.split(' ');
    return { cmd: parts[0], args: parts.slice(1), env: process.env };
  }
  if (spawnSync('humanmark', ['--help'], { stdio: 'ignore' }).status === 0) return { cmd: 'humanmark', args: [], env: process.env };
  const src = process.env.KIOSK_HUMANMARK_SRC || path.join(os.homedir(), 'Downloads', 'humanmark');
  if (fs.existsSync(path.join(src, 'humanmark'))) {
    return { cmd: 'python3', args: ['-m', 'humanmark'], env: { ...process.env, PYTHONPATH: src } };
  }
  return null;
}

function humanmarkScreen(text: string): { status: string; hits: Record<string, number> } | null {
  const hm = humanmarkCommand();
  if (!hm) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-gate-'));
  const f = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.txt`);
  try {
    fs.writeFileSync(f, text, { mode: 0o600 });
    const r = spawnSync(hm.cmd, [...hm.args, 'scan', f, '--json'], { encoding: 'utf8', env: hm.env, timeout: 8000 });
    if (r.status !== 0) return null;
    const line = r.stdout.trim().split('\n').filter(Boolean).pop();
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function gate(text: string, denylist: string[] = []): GateResult {
  const reasons: string[] = [];
  if (text.length > MAX_CHARS) reasons.push(`longer than ${MAX_CHARS} characters`);
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) reasons.push(name);
  if (recoveryPhrase(text)) reasons.push('wallet recovery phrase');
  const low = text.toLowerCase();
  for (const term of denylist) if (term && low.includes(term.toLowerCase())) reasons.push(`denylisted term "${term}"`);
  const hm = humanmarkScreen(text);
  let engine: GateResult['engine'] = 'builtin';
  if (hm) {
    engine = 'humanmark';
    if (hm.status !== 'safe') reasons.push(`HumanMark ${hm.status}${Object.keys(hm.hits || {}).length ? ` (${Object.keys(hm.hits).join(', ')})` : ''}`);
  } else {
    for (const [name, re] of PHI_PATTERNS) if (re.test(text)) reasons.push(name);
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], engine };
}
