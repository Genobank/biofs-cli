/**
 * Local state of the Kiosk client: one directory per person and Mac (KIOSK_HOME, default
 * ~/.kiosk), one subdirectory per Kiosk, and a key store for every private key.
 *
 *   config.json                    relay URL, wallet address, label, key store backend
 *   keystore.json                  only with KIOSK_KEYSTORE=file (tests); otherwise the macOS Keychain
 *   rooms/<id>/state.json          cursor, receipt head, author sequence numbers, labels, repo
 *   rooms/<id>/cache.jsonl         verified {event, receipt, body}; bodies stay ciphertext at rest
 *   rooms/<id>/outbox/             signed events waiting for the relay, delivered once by author_seq
 *   rooms/<id>/claude/             the clean-room Claude Code profile (CLAUDE_CONFIG_DIR)
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ethers } from 'ethers';

export function kioskHome(): string {
  return path.resolve(process.env.KIOSK_HOME || path.join(os.homedir(), '.kiosk'));
}

function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

export function writeJsonAtomic(p: string, obj: unknown): void {
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return null; }
}

// ---- config ----------------------------------------------------------------------------------
export interface Config {
  v: 1;
  relay: string;
  wallet: string;          // lowercase; display with ethers.getAddress (EIP-55)
  wallet_kind: 'keychain' | 'file';
  label: string;
  keystore: 'keychain' | 'file';
  created_at: string;
}

/** GenoBank.io production relay on genobank-production, behind nginx at /api_kiosk/. */
export const DEFAULT_RELAY = 'https://genobank.app/api_kiosk';

export const configPath = (): string => path.join(kioskHome(), 'config.json');
export const loadConfig = (): Config | null => readJson<Config>(configPath()) || moveFromColloquy();
export const saveConfig = (c: Config): void => writeJsonAtomic(configPath(), c);

// ---- the move from Colloquy -------------------------------------------------------------------
// Kiosk was named Colloquy until October 18, 2026. On a Mac that had a Colloquy wallet, the first
// Kiosk command run in the person's own terminal copies that wallet (its key, address and label) into
// the Kiosk home and Keychain service, so the relay keeps knowing the same wallet. Rooms are not
// carried over. ~/.colloquy and its Keychain items are left as they were.
const COLLOQUY_HOME = path.join(os.homedir(), '.colloquy');
const COLLOQUY_RELAY = 'https://genobank.app/api_colloquy';

function readColloquyWallet(legacy: Config): string | null {
  if (legacy.keystore === 'file') return (readJson<Record<string, string>>(path.join(COLLOQUY_HOME, 'keystore.json')) || {}).wallet ?? null;
  const acct = `${createHash('sha256').update(path.resolve(COLLOQUY_HOME)).digest('hex').slice(0, 10)}:wallet`;
  const r = spawnSync('security', ['find-generic-password', '-s', 'genobank.colloquy', '-a', acct, '-w'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const v = r.stdout.trim();
  return v.startsWith('clqb64:') ? Buffer.from(v.slice('clqb64:'.length), 'base64').toString('utf8') : v;
}

function moveFromColloquy(): Config | null {
  if (process.env.KIOSK_HOME) return null;
  const legacy = readJson<Config>(path.join(COLLOQUY_HOME, 'config.json'));
  if (!legacy || !/^0x[0-9a-f]{40}$/.test(String(legacy.wallet || ''))) return null;
  if (process.env.CLAUDECODE === '1') {
    throw new Error('Your wallet is still under Colloquy, the former name of Kiosk. Run any kiosk command once in your own terminal to move it.');
  }
  const shown = ethers.getAddress(legacy.wallet);
  const key = readColloquyWallet(legacy);
  if (!key) throw new Error(`Found your Colloquy wallet ${shown} but could not read its key; nothing was moved. Unlock the Keychain and try again.`);
  let address = '';
  try { address = new ethers.Wallet(key).address.toLowerCase(); } catch { address = ''; }
  if (address !== legacy.wallet) throw new Error(`The key stored for your Colloquy wallet ${shown} does not match it; nothing was moved.`);
  const cfg: Config = { ...legacy, relay: legacy.relay === COLLOQUY_RELAY ? DEFAULT_RELAY : legacy.relay };
  const ks = keyStore(cfg);
  ks.set('wallet', key);
  if (ks.get('wallet') !== key) throw new Error('Moving the wallet from Colloquy failed: the Keychain did not keep the copy.');
  saveConfig(cfg);
  process.stderr.write(`Moved your wallet ${shown} from Colloquy to Kiosk. Colloquy rooms are not carried over.\n`);
  return cfg;
}

// ---- key store -------------------------------------------------------------------------------
export interface KeyStore {
  get(name: string): string | null;
  set(name: string, value: string): void;
  del(name: string): void;
  backend: 'keychain' | 'file';
}

function homeNamespace(): string {
  return createHash('sha256').update(kioskHome()).digest('hex').slice(0, 10);
}

class FileKeyStore implements KeyStore {
  backend = 'file' as const;
  private p = path.join(kioskHome(), 'keystore.json');
  private all(): Record<string, string> { return readJson<Record<string, string>>(this.p) || {}; }
  get(name: string) { return this.all()[name] ?? null; }
  set(name: string, value: string) { const a = this.all(); a[name] = value; writeJsonAtomic(this.p, a); }
  del(name: string) { const a = this.all(); delete a[name]; writeJsonAtomic(this.p, a); }
}

// Secrets reach /usr/bin/security on stdin (`security -i`), never on argv, where any process of the
// same user could read them while the call runs. They are stored base64 under a prefix, so quotes in a
// JSON secret cannot break the command line; values written before the prefix existed still read.
const B64_PREFIX = 'kioskb64:';
const quote = (s: string): string => `"${s.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;

class KeychainStore implements KeyStore {
  backend = 'keychain' as const;
  private svc = 'genobank.kiosk';
  private acct(name: string) { return `${homeNamespace()}:${name}`; }
  get(name: string) {
    const r = spawnSync('security', ['find-generic-password', '-s', this.svc, '-a', this.acct(name), '-w'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const v = r.stdout.trim();
    return v.startsWith(B64_PREFIX) ? Buffer.from(v.slice(B64_PREFIX.length), 'base64').toString('utf8') : v;
  }
  set(name: string, value: string) {
    const stored = B64_PREFIX + Buffer.from(value, 'utf8').toString('base64');
    const line = `add-generic-password -U -s ${quote(this.svc)} -a ${quote(this.acct(name))} -l ${quote(`Kiosk ${name}`)} -w ${quote(stored)}\n`;
    const r = spawnSync('security', ['-i'], { input: line, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`Keychain write failed for ${name}: ${(r.stderr || r.stdout).trim()}`);
  }
  del(name: string) {
    spawnSync('security', ['delete-generic-password', '-s', this.svc, '-a', this.acct(name)], { encoding: 'utf8' });
  }
}

export function keyStore(cfg?: Config | null): KeyStore {
  const want = process.env.KIOSK_KEYSTORE || cfg?.keystore || (process.platform === 'darwin' ? 'keychain' : 'file');
  return want === 'keychain' ? new KeychainStore() : new FileKeyStore();
}

// ---- per-Kiosk state ------------------------------------------------------------------------
export interface RoomState {
  v: 1;
  kiosk_id: string;
  relay: string;
  owner: string;
  role: 'owner' | 'participant' | 'observer' | 'pending';
  my_wallet: string;
  device_key: string;
  device_x25519: string;
  seat_key?: string;
  author_seq: Record<string, number>;
  cursor: number;
  head: { seq: number; receipt_hash: string };
  epoch: number;
  inject_cursor: number;
  labels: Record<string, string>;
  title?: string;
  delegated?: boolean;     // this account holds device and seat keys for another account's wallet, never the wallet
  key_roles?: Record<string, 'device' | 'seat'>;
  repo?: string;
  model?: string;
  claim_id?: string;
  denylist: string[];
  created_at: string;
  codrivers?: string[];        // wallets this seat's human lets talk to the seat directly (local to this Mac)
  channel_pushed?: number[];   // seqs the live channel pushed into this seat's Claude Code session (newest 300)
  channel_through?: number;    // the channel has looked at every event up to this seq
  pending_refs?: number[];     // pushed seqs not yet answered; the next shared answer refers to them
}

// The author's own denylist on this Mac, one term per line ('#' starts a comment), kept outside any
// room so it covers every room this Mac joins. Read on every post; a missing file is an empty list.
export function macDenylist(): string[] {
  const f = path.join(kioskHome(), 'denylist.txt');
  try {
    return fs.readFileSync(f, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  } catch { return []; }
}

export const roomDir = (id: string): string => {
  if (!/^kiosk_[0-9a-f]{16,32}$/.test(id)) throw new Error(`not a Kiosk id: ${id}`);
  return path.join(kioskHome(), 'rooms', id);
};
export const roomStatePath = (id: string): string => path.join(roomDir(id), 'state.json');
export const loadRoom = (id: string): RoomState | null => readJson<RoomState>(roomStatePath(id));
export const saveRoom = (s: RoomState): void => writeJsonAtomic(roomStatePath(s.kiosk_id), s);
export const cachePath = (id: string): string => path.join(roomDir(id), 'cache.jsonl');
export const outboxDir = (id: string): string => ensureDir(path.join(roomDir(id), 'outbox'));
export const profileDir = (id: string): string => path.join(roomDir(id), 'claude');

export function listRooms(): string[] {
  const d = path.join(kioskHome(), 'rooms');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => /^kiosk_[0-9a-f]{16,32}$/.test(n) && fs.existsSync(path.join(d, n, 'state.json')));
}

export function requireRoom(id: string): RoomState {
  const s = loadRoom(id);
  if (!s) throw new Error(`This Mac has not joined ${id}. Run kiosk join with an invite, or kiosk create.`);
  return s;
}

// A mkdir lock: several hooks and the MCP server touch the same room state at once.
export async function withRoomLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  ensureDir(roomDir(id));
  const lock = path.join(roomDir(id), '.lock');
  const started = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch {
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > 30_000) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      } catch { /* raced */ }
      if (Date.now() - started > 20_000) throw new Error('room state is locked by another Kiosk process');
      await new Promise((r) => setTimeout(r, 15 + Math.random() * 25));
    }
  }
  try { return await fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

export function wipeRoom(id: string, ks: KeyStore): void {
  for (const k of ['device', 'x25519', 'seat']) ks.del(`${k}:${id}`);
  for (let e = 1; e <= 64; e++) ks.del(`epoch:${id}:${e}`);
  fs.rmSync(roomDir(id), { recursive: true, force: true });
}
