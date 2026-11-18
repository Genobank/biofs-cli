"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.profileDir = exports.outboxDir = exports.cachePath = exports.saveRoom = exports.loadRoom = exports.roomStatePath = exports.roomDir = exports.saveConfig = exports.loadConfig = exports.configPath = exports.DEFAULT_RELAY = void 0;
exports.kioskHome = kioskHome;
exports.writeJsonAtomic = writeJsonAtomic;
exports.readJson = readJson;
exports.keyStore = keyStore;
exports.macDenylist = macDenylist;
exports.listRooms = listRooms;
exports.requireRoom = requireRoom;
exports.withRoomLock = withRoomLock;
exports.wipeRoom = wipeRoom;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const ethers_1 = require("ethers");
function kioskHome() {
    return path.resolve(process.env.KIOSK_HOME || path.join(os.homedir(), '.kiosk'));
}
function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    return p;
}
function writeJsonAtomic(p, obj) {
    ensureDir(path.dirname(p));
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
}
function readJson(p) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
}
/** GenoBank.io production relay on genobank-production, behind nginx at /api_kiosk/. */
exports.DEFAULT_RELAY = 'https://genobank.app/api_kiosk';
const configPath = () => path.join(kioskHome(), 'config.json');
exports.configPath = configPath;
const loadConfig = () => readJson((0, exports.configPath)()) || moveFromColloquy();
exports.loadConfig = loadConfig;
const saveConfig = (c) => writeJsonAtomic((0, exports.configPath)(), c);
exports.saveConfig = saveConfig;
// ---- the move from Colloquy -------------------------------------------------------------------
// Kiosk was named Colloquy until October 18, 2026. On a Mac that had a Colloquy wallet, the first
// Kiosk command run in the person's own terminal copies that wallet (its key, address and label) into
// the Kiosk home and Keychain service, so the relay keeps knowing the same wallet. Rooms are not
// carried over. ~/.colloquy and its Keychain items are left as they were.
const COLLOQUY_HOME = path.join(os.homedir(), '.colloquy');
const COLLOQUY_RELAY = 'https://genobank.app/api_colloquy';
function readColloquyWallet(legacy) {
    if (legacy.keystore === 'file')
        return (readJson(path.join(COLLOQUY_HOME, 'keystore.json')) || {}).wallet ?? null;
    const acct = `${(0, crypto_1.createHash)('sha256').update(path.resolve(COLLOQUY_HOME)).digest('hex').slice(0, 10)}:wallet`;
    const r = (0, child_process_1.spawnSync)('security', ['find-generic-password', '-s', 'genobank.colloquy', '-a', acct, '-w'], { encoding: 'utf8' });
    if (r.status !== 0)
        return null;
    const v = r.stdout.trim();
    return v.startsWith('clqb64:') ? Buffer.from(v.slice('clqb64:'.length), 'base64').toString('utf8') : v;
}
function moveFromColloquy() {
    if (process.env.KIOSK_HOME)
        return null;
    const legacy = readJson(path.join(COLLOQUY_HOME, 'config.json'));
    if (!legacy || !/^0x[0-9a-f]{40}$/.test(String(legacy.wallet || '')))
        return null;
    if (process.env.CLAUDECODE === '1') {
        throw new Error('Your wallet is still under Colloquy, the former name of Kiosk. Run any kiosk command once in your own terminal to move it.');
    }
    const shown = ethers_1.ethers.getAddress(legacy.wallet);
    const key = readColloquyWallet(legacy);
    if (!key)
        throw new Error(`Found your Colloquy wallet ${shown} but could not read its key; nothing was moved. Unlock the Keychain and try again.`);
    let address = '';
    try {
        address = new ethers_1.ethers.Wallet(key).address.toLowerCase();
    }
    catch {
        address = '';
    }
    if (address !== legacy.wallet)
        throw new Error(`The key stored for your Colloquy wallet ${shown} does not match it; nothing was moved.`);
    const cfg = { ...legacy, relay: legacy.relay === COLLOQUY_RELAY ? exports.DEFAULT_RELAY : legacy.relay };
    const ks = keyStore(cfg);
    ks.set('wallet', key);
    if (ks.get('wallet') !== key)
        throw new Error('Moving the wallet from Colloquy failed: the Keychain did not keep the copy.');
    (0, exports.saveConfig)(cfg);
    process.stderr.write(`Moved your wallet ${shown} from Colloquy to Kiosk. Colloquy rooms are not carried over.\n`);
    return cfg;
}
function homeNamespace() {
    return (0, crypto_1.createHash)('sha256').update(kioskHome()).digest('hex').slice(0, 10);
}
class FileKeyStore {
    constructor() {
        this.backend = 'file';
        this.p = path.join(kioskHome(), 'keystore.json');
    }
    all() { return readJson(this.p) || {}; }
    get(name) { return this.all()[name] ?? null; }
    set(name, value) { const a = this.all(); a[name] = value; writeJsonAtomic(this.p, a); }
    del(name) { const a = this.all(); delete a[name]; writeJsonAtomic(this.p, a); }
}
// Secrets reach /usr/bin/security on stdin (`security -i`), never on argv, where any process of the
// same user could read them while the call runs. They are stored base64 under a prefix, so quotes in a
// JSON secret cannot break the command line; values written before the prefix existed still read.
const B64_PREFIX = 'kioskb64:';
const quote = (s) => `"${s.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
class KeychainStore {
    constructor() {
        this.backend = 'keychain';
        this.svc = 'genobank.kiosk';
    }
    acct(name) { return `${homeNamespace()}:${name}`; }
    get(name) {
        const r = (0, child_process_1.spawnSync)('security', ['find-generic-password', '-s', this.svc, '-a', this.acct(name), '-w'], { encoding: 'utf8' });
        if (r.status !== 0)
            return null;
        const v = r.stdout.trim();
        return v.startsWith(B64_PREFIX) ? Buffer.from(v.slice(B64_PREFIX.length), 'base64').toString('utf8') : v;
    }
    set(name, value) {
        const stored = B64_PREFIX + Buffer.from(value, 'utf8').toString('base64');
        const line = `add-generic-password -U -s ${quote(this.svc)} -a ${quote(this.acct(name))} -l ${quote(`Kiosk ${name}`)} -w ${quote(stored)}\n`;
        const r = (0, child_process_1.spawnSync)('security', ['-i'], { input: line, encoding: 'utf8' });
        if (r.status !== 0)
            throw new Error(`Keychain write failed for ${name}: ${(r.stderr || r.stdout).trim()}`);
    }
    del(name) {
        (0, child_process_1.spawnSync)('security', ['delete-generic-password', '-s', this.svc, '-a', this.acct(name)], { encoding: 'utf8' });
    }
}
function keyStore(cfg) {
    const want = process.env.KIOSK_KEYSTORE || cfg?.keystore || (process.platform === 'darwin' ? 'keychain' : 'file');
    return want === 'keychain' ? new KeychainStore() : new FileKeyStore();
}
// The author's own denylist on this Mac, one term per line ('#' starts a comment), kept outside any
// room so it covers every room this Mac joins. Read on every post; a missing file is an empty list.
function macDenylist() {
    const f = path.join(kioskHome(), 'denylist.txt');
    try {
        return fs.readFileSync(f, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
    }
    catch {
        return [];
    }
}
const roomDir = (id) => {
    if (!/^kiosk_[0-9a-f]{16,32}$/.test(id))
        throw new Error(`not a Kiosk id: ${id}`);
    return path.join(kioskHome(), 'rooms', id);
};
exports.roomDir = roomDir;
const roomStatePath = (id) => path.join((0, exports.roomDir)(id), 'state.json');
exports.roomStatePath = roomStatePath;
const loadRoom = (id) => readJson((0, exports.roomStatePath)(id));
exports.loadRoom = loadRoom;
const saveRoom = (s) => writeJsonAtomic((0, exports.roomStatePath)(s.kiosk_id), s);
exports.saveRoom = saveRoom;
const cachePath = (id) => path.join((0, exports.roomDir)(id), 'cache.jsonl');
exports.cachePath = cachePath;
const outboxDir = (id) => ensureDir(path.join((0, exports.roomDir)(id), 'outbox'));
exports.outboxDir = outboxDir;
const profileDir = (id) => path.join((0, exports.roomDir)(id), 'claude');
exports.profileDir = profileDir;
function listRooms() {
    const d = path.join(kioskHome(), 'rooms');
    if (!fs.existsSync(d))
        return [];
    return fs.readdirSync(d).filter((n) => /^kiosk_[0-9a-f]{16,32}$/.test(n) && fs.existsSync(path.join(d, n, 'state.json')));
}
function requireRoom(id) {
    const s = (0, exports.loadRoom)(id);
    if (!s)
        throw new Error(`This Mac has not joined ${id}. Run kiosk join with an invite, or kiosk create.`);
    return s;
}
// A mkdir lock: several hooks and the MCP server touch the same room state at once.
async function withRoomLock(id, fn) {
    ensureDir((0, exports.roomDir)(id));
    const lock = path.join((0, exports.roomDir)(id), '.lock');
    const started = Date.now();
    for (;;) {
        try {
            fs.mkdirSync(lock);
            break;
        }
        catch {
            try {
                const age = Date.now() - fs.statSync(lock).mtimeMs;
                if (age > 30000) {
                    fs.rmSync(lock, { recursive: true, force: true });
                    continue;
                }
            }
            catch { /* raced */ }
            if (Date.now() - started > 20000)
                throw new Error('room state is locked by another Kiosk process');
            await new Promise((r) => setTimeout(r, 15 + Math.random() * 25));
        }
    }
    try {
        return await fn();
    }
    finally {
        fs.rmSync(lock, { recursive: true, force: true });
    }
}
function wipeRoom(id, ks) {
    for (const k of ['device', 'x25519', 'seat'])
        ks.del(`${k}:${id}`);
    for (let e = 1; e <= 64; e++)
        ks.del(`epoch:${id}:${e}`);
    fs.rmSync((0, exports.roomDir)(id), { recursive: true, force: true });
}
