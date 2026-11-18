"use strict";
/**
 * Kiosk client operations: create, invite, join, approve, post (signed, encrypted, queued,
 * delivered once), sync (every receipt and event verified before it is cached), leases,
 * revocation with key rotation, leaving, erasure, multi-device enrollment, export, verification
 * and contribution credits. The relay sees ciphertext, key wraps, signatures and receipts only.
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
exports.seatSigner = exports.deviceSigner = exports.walletSigner = exports.invitationUrl = exports.DEFAULT_RELAY = exports.display = exports.ForkError = exports.IntegrityError = void 0;
exports.verificationCode = verificationCode;
exports.context = context;
exports.init = init;
exports.post = post;
exports.flush = flush;
exports.syncLocked = syncLocked;
exports.sync = sync;
exports.readLocal = readLocal;
exports.verify = verify;
exports.create = create;
exports.invite = invite;
exports.parseInvitation = parseInvitation;
exports.join = join;
exports.pendingClaims = pendingClaims;
exports.approve = approve;
exports.revoke = revoke;
exports.rotate = rotate;
exports.leave = leave;
exports.deleteRoom = deleteRoom;
exports.erase = erase;
exports.ensureSeat = ensureSeat;
exports.deviceRequest = deviceRequest;
exports.deviceApprove = deviceApprove;
exports.lease = lease;
exports.info = info;
exports.exportRoom = exportRoom;
exports.credits = credits;
exports.openTasks = openTasks;
const child_process_1 = require("child_process");
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const ethers_1 = require("ethers");
const canon_1 = require("./canon");
const cryptobox_1 = require("./cryptobox");
const home_1 = require("./home");
Object.defineProperty(exports, "DEFAULT_RELAY", { enumerable: true, get: function () { return home_1.DEFAULT_RELAY; } });
const client_1 = require("./client");
const gate_1 = require("./gate");
const pairing_1 = require("./pairing");
const presence_1 = require("./presence");
class IntegrityError extends Error {
    constructor(seq, message) {
        super(`seq ${seq}: ${message}`);
        this.seq = seq;
    }
}
exports.IntegrityError = IntegrityError;
class ForkError extends Error {
    constructor(seq, message, evidence) {
        super(`FORK at seq ${seq}: ${message}`);
        this.seq = seq;
        this.evidence = evidence;
    }
}
exports.ForkError = ForkError;
const nowSec = () => Math.floor(Date.now() / 1000);
const rand32 = () => ethers_1.ethers.hexlify(crypto.randomBytes(32));
const display = (a) => { try {
    return ethers_1.ethers.getAddress(a);
}
catch {
    return a;
} };
exports.display = display;
/** The link the invitation QR code opens; the code rides in the fragment, which no server logs. */
const invitationUrl = (relay, code) => `${relay.replace(/\/+$/, '')}/agent/kiosk/i#${code}`;
exports.invitationUrl = invitationUrl;
/** Eight digits both terminals show for one claim, so the owner can confirm the right person claimed it. */
function verificationCode(wallet, deviceKey) {
    const n = BigInt((0, canon_1.keccakText)(`KSK1-VERIFY:${(0, canon_1.lc)(wallet)}:${(0, canon_1.lc)(deviceKey)}`)) % 100000000n;
    const s = n.toString().padStart(8, '0');
    return `${s.slice(0, 4)} ${s.slice(4)}`;
}
function context() {
    const cfg = (0, home_1.loadConfig)();
    if (!cfg)
        throw new Error('This Mac has no Kiosk wallet yet. Run: kiosk init');
    return { cfg, ks: (0, home_1.keyStore)(cfg) };
}
function keyWallet(c, name) {
    const k = c.ks.get(name);
    if (!k)
        throw new Error(`missing key ${name} in the ${c.ks.backend} key store`);
    return new ethers_1.ethers.Wallet(k);
}
const walletSigner = (c) => keyWallet(c, 'wallet');
exports.walletSigner = walletSigner;
const deviceSigner = (c, id) => keyWallet(c, `device:${id}`);
exports.deviceSigner = deviceSigner;
const seatSigner = (c, id) => keyWallet(c, `seat:${id}`);
exports.seatSigner = seatSigner;
function signerFor(c, st, key) {
    if (key === st.my_wallet)
        return (0, exports.walletSigner)(c);
    if (key === st.device_key)
        return (0, exports.deviceSigner)(c, st.kiosk_id);
    if (st.seat_key && key === st.seat_key)
        return (0, exports.seatSigner)(c, st.kiosk_id);
    throw new Error(`no local key for ${key}`);
}
async function signedRecord(signer, rec) {
    return { ...rec, sig: await signer.signMessage(ethers_1.ethers.getBytes((0, canon_1.recordHash)(rec))) };
}
function keyAuthRecord(id, wallet, key, role, extra) {
    return {
        v: 1, type: 'key_auth', kiosk_id: id, wallet, key, role, ...extra,
        not_after: extra.not_after ?? null, nonce: crypto.randomBytes(8).toString('hex'), issued_at: new Date().toISOString(),
    };
}
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code32(bytes) {
    let bits = 0, value = 0, out = '';
    for (const b of bytes) {
        value = (value << 8) | b;
        bits += 8;
        while (bits >= 5) {
            out += B32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0)
        out += B32[(value << (5 - bits)) & 31];
    return out.match(/.{1,4}/g).join('-');
}
// ---- init -------------------------------------------------------------------------------------
function init(opts) {
    const existing = (0, home_1.loadConfig)();
    if (existing) {
        if (opts.relay)
            existing.relay = opts.relay;
        if (opts.label)
            existing.label = opts.label;
        if (opts.walletKeyFile)
            throw new Error('This Mac already has a Kiosk wallet; refusing to replace it.');
        (0, home_1.saveConfig)(existing);
        return existing;
    }
    const backend = process.env.KIOSK_KEYSTORE || (process.platform === 'darwin' ? 'keychain' : 'file');
    const ks = (0, home_1.keyStore)({ keystore: backend });
    const pk = opts.walletKeyFile ? fs.readFileSync(opts.walletKeyFile, 'utf8').trim() : rand32();
    const w = new ethers_1.ethers.Wallet(pk);
    ks.set('wallet', w.privateKey);
    const cfg = {
        v: 1, relay: opts.relay || home_1.DEFAULT_RELAY, wallet: w.address.toLowerCase(),
        wallet_kind: backend === 'keychain' ? 'keychain' : 'file', label: opts.label || os.hostname().split('.')[0],
        keystore: backend, created_at: new Date().toISOString(),
    };
    (0, home_1.saveConfig)(cfg);
    return cfg;
}
// ---- epoch keys --------------------------------------------------------------------------------
const epochKeyOf = (c, id, epoch) => c.ks.get(`epoch:${id}:${epoch}`);
function takeWraps(c, st, wraps) {
    const priv = c.ks.get(`x25519:${st.kiosk_id}`);
    if (!priv)
        return;
    for (const [e, w] of Object.entries(wraps || {})) {
        const epoch = Number(e);
        if (epochKeyOf(c, st.kiosk_id, epoch))
            continue;
        try {
            c.ks.set(`epoch:${st.kiosk_id}:${epoch}`, (0, cryptobox_1.unwrapEpochKey)(w, priv, st.kiosk_id, epoch));
        }
        catch { /* not for this device */ }
    }
}
async function build(c, st, signer, d, seq) {
    const key = signer.address.toLowerCase();
    const authorSeq = seq ?? (st.author_seq[key] || 0) + 1;
    const payload = d.text === undefined ? null : { salt: (0, cryptobox_1.newSalt)(), text: d.text, meta: d.meta };
    const ev = {
        v: 1, kiosk_id: st.kiosk_id, epoch: st.epoch, author_key: key, author_wallet: st.my_wallet,
        author_seq: authorSeq, kind: d.kind, evidence: d.evidence, refs: d.refs || [],
        seen_receipt: st.head.seq > 0 ? st.head.receipt_hash : null,
        body_commit: payload ? (0, cryptobox_1.bodyCommit)(payload) : null, ts_claimed: new Date().toISOString(),
    };
    const h = (0, canon_1.eventHash)(ev);
    ev.sig = await signer.signMessage(ethers_1.ethers.getBytes(h));
    let body = null;
    if (payload) {
        const ek = epochKeyOf(c, st.kiosk_id, st.epoch);
        if (!ek)
            throw new Error(`no epoch ${st.epoch} key on this device; run kiosk sync`);
        body = (0, cryptobox_1.sealBody)(ek, h, payload);
    }
    st.author_seq[key] = Math.max(st.author_seq[key] || 0, authorSeq);
    return { event: ev, body, payload };
}
function gateText(text, meta) {
    return meta ? `${text}\n${JSON.stringify(meta)}` : text;
}
async function post(id, d) {
    const c = context();
    const st0 = (0, home_1.requireRoom)(id);
    if (d.text !== undefined) {
        const g = (0, gate_1.gate)(gateText(d.text, d.meta), [...(st0.denylist || []), ...(0, home_1.macDenylist)()]);
        if (!g.ok)
            return { status: 'blocked', reasons: g.reasons };
    }
    return (0, home_1.withRoomLock)(id, async () => {
        const st = (0, home_1.requireRoom)(id);
        const signer = d.as === 'wallet' ? (0, exports.walletSigner)(c) : d.as === 'seat' ? (0, exports.seatSigner)(c, id) : (0, exports.deviceSigner)(c, id);
        const built = await build(c, st, signer, d);
        const name = `${Date.now()}-${String(built.event.author_seq).padStart(8, '0')}-${built.event.author_key}.json`;
        (0, home_1.writeJsonAtomic)(path.join((0, home_1.outboxDir)(id), name), built);
        (0, home_1.saveRoom)(st);
        const results = await flushLocked(c, st);
        const mine = results.find((r) => r.file === name);
        if (!mine || mine.status === 'queued')
            return { status: 'queued' };
        if (mine.status === 'rejected')
            return { status: 'rejected', reasons: [mine.reason || 'rejected'] };
        return { status: 'delivered', seq: mine.receipt.seq, receipt: mine.receipt };
    });
}
async function refreshEpoch(c, st) {
    const info = await new client_1.RelayClient(st.relay, (0, exports.deviceSigner)(c, st.kiosk_id)).call('GET', 'info', { kiosk_id: st.kiosk_id });
    st.epoch = info.room.epoch;
    takeWraps(c, st, info.wraps);
}
async function flushLocked(c, st) {
    const dir = (0, home_1.outboxDir)(st.kiosk_id);
    const out = [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const p = path.join(dir, file);
        let rec = (0, home_1.readJson)(p);
        if (!rec)
            continue;
        const signer = signerFor(c, st, rec.event.author_key);
        const client = new client_1.RelayClient(st.relay, signer);
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const r = await client.call('POST', 'append', undefined, { kiosk_id: st.kiosk_id, event: rec.event, body: rec.body });
                fs.unlinkSync(p);
                out.push({ file, status: 'delivered', receipt: r.receipt });
                break;
            }
            catch (e) {
                if (e instanceof client_1.NetworkError) {
                    for (const rest of files.slice(i))
                        out.push({ file: rest, status: 'queued' });
                    return out;
                }
                const re = e;
                if (re.reason === 'stale_epoch' && rec.payload && attempt === 0) {
                    await refreshEpoch(c, st);
                    rec = await rebuild(c, st, signer, rec, rec.event.author_seq);
                    (0, home_1.writeJsonAtomic)(p, rec);
                    continue;
                }
                // A rejected event never consumed its number at the relay: renumber this key's later events.
                fs.mkdirSync(path.join(dir, 'rejected'), { recursive: true, mode: 0o700 });
                fs.renameSync(p, path.join(dir, 'rejected', file));
                fs.writeFileSync(path.join(dir, 'rejected', `${file}.reason`), `${re.reason}: ${re.message}\n`, { mode: 0o600 });
                out.push({ file, status: 'rejected', reason: re.reason });
                await renumberAfter(c, st, rec.event.author_key, rec.event.author_seq, files.slice(i + 1));
                break;
            }
        }
    }
    (0, home_1.saveRoom)(st);
    return out;
}
async function rebuild(c, st, signer, rec, seq) {
    const ev = rec.event;
    const d = { kind: ev.kind, evidence: ev.evidence, refs: ev.refs, text: rec.payload?.text, meta: rec.payload?.meta };
    const keep = st.author_seq[ev.author_key];
    const b = await build(c, st, signer, d, seq);
    st.author_seq[ev.author_key] = keep;
    return b;
}
async function renumberAfter(c, st, key, freedSeq, laterFiles) {
    const dir = (0, home_1.outboxDir)(st.kiosk_id);
    let next = freedSeq;
    const signer = signerFor(c, st, key);
    for (const f of laterFiles) {
        const p = path.join(dir, f);
        const rec = (0, home_1.readJson)(p);
        if (!rec || rec.event.author_key !== key)
            continue;
        const nb = await rebuild(c, st, signer, rec, next);
        (0, home_1.writeJsonAtomic)(p, nb);
        next++;
    }
    st.author_seq[key] = next - 1;
}
async function flush(id) {
    const c = context();
    return (0, home_1.withRoomLock)(id, async () => flushLocked(c, (0, home_1.requireRoom)(id)));
}
function readCache(id) {
    const p = (0, home_1.cachePath)(id);
    if (!fs.existsSync(p))
        return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function verifyOne(st, rec, room, known, cachedAt) {
    const R = rec.receipt;
    const E = rec.event;
    if (R.kiosk_id !== room.kiosk_id || E.kiosk_id !== room.kiosk_id)
        throw new IntegrityError(R.seq, 'record belongs to another Kiosk');
    const rh = (0, canon_1.receiptHash)(R);
    if (rh !== R.receipt_hash)
        throw new IntegrityError(R.seq, 'receipt hash does not match its fields');
    if ((0, canon_1.recoverHashSigner)(rh, R.relay_sig) !== (0, canon_1.lc)(room.relay_key))
        throw new IntegrityError(R.seq, 'receipt is not signed by the relay key');
    const cached = cachedAt.get(R.seq);
    if (cached && cached !== rh)
        throw new ForkError(R.seq, 'the relay signed 2 different receipts for this seq', { cached, served: R });
    if (R.seq !== st.head.seq + 1)
        throw new IntegrityError(R.seq, `expected seq ${st.head.seq + 1}`);
    if (R.prev_receipt !== st.head.receipt_hash)
        throw new ForkError(R.seq, 'receipt does not chain to the previous receipt', { prev: st.head, served: R });
    const eh = (0, canon_1.eventHash)(E);
    if (eh !== R.event_hash)
        throw new IntegrityError(R.seq, 'event does not match the receipt');
    if ((0, canon_1.recoverHashSigner)(eh, E.sig) !== E.author_key)
        throw new IntegrityError(R.seq, 'author signature does not verify');
    if (E.author_key !== E.author_wallet) {
        const k = room.keys.find((x) => x.key === E.author_key);
        if (!k || k.wallet !== E.author_wallet)
            throw new IntegrityError(R.seq, 'author key is not authorized by the author wallet');
    }
    else if (E.author_wallet !== room.owner && !room.members.some((m) => m.wallet === E.author_wallet)) {
        throw new IntegrityError(R.seq, 'author wallet is not a member');
    }
    if (E.evidence === 'presence-signed' && E.author_key !== E.author_wallet)
        throw new IntegrityError(R.seq, 'presence claimed by a non-wallet key');
    if (E.seen_receipt && !known.has(E.seen_receipt))
        throw new ForkError(R.seq, 'the author saw a receipt this client never received', { seen: E.seen_receipt });
    known.add(rh);
    st.head = { seq: R.seq, receipt_hash: rh };
}
function decrypt(c, st, rec, room) {
    const E = rec.event;
    const keyRow = room?.keys.find((k) => k.key === E.author_key);
    const keyRole = E.author_key === E.author_wallet ? 'wallet' : (keyRow?.role || st.key_roles?.[E.author_key] || 'device');
    const out = {
        seq: rec.receipt.seq, ts_relay: rec.receipt.ts_relay, kind: E.kind, author_wallet: E.author_wallet,
        author_key: E.author_key, key_role: keyRole, label: st.labels[E.author_wallet] || (0, exports.display)(E.author_wallet).slice(0, 10),
        evidence: E.evidence, refs: E.refs, erased: !!rec.erased || (!!E.body_commit && !rec.body), undecryptable: false, epoch: E.epoch,
    };
    if (E.body_commit && rec.body) {
        const ek = epochKeyOf(c, st.kiosk_id, E.epoch);
        if (!ek) {
            out.undecryptable = true;
            return out;
        }
        let p;
        try {
            p = (0, cryptobox_1.openBody)(ek, rec.receipt.event_hash, rec.body);
        }
        catch (e) {
            throw new IntegrityError(rec.receipt.seq, `body failed authentication (${e.message})`);
        }
        if ((0, cryptobox_1.bodyCommit)(p) !== E.body_commit)
            throw new IntegrityError(rec.receipt.seq, 'body does not match its commitment');
        out.text = p.text;
        out.meta = p.meta;
    }
    return out;
}
async function syncLocked(c, st) {
    const client = new client_1.RelayClient(st.relay, (0, exports.deviceSigner)(c, st.kiosk_id));
    const cache = readCache(st.kiosk_id);
    const known = new Set(cache.map((r) => r.receipt.receipt_hash));
    const cachedAt = new Map(cache.map((r) => [r.receipt.seq, r.receipt.receipt_hash]));
    const out = [];
    let room = null;
    let me = null;
    for (;;) {
        const r = await client.call('GET', 'read', { kiosk_id: st.kiosk_id, since_seq: st.cursor, limit: 500 });
        room = r.room;
        me = r.me;
        st.epoch = room.epoch;
        st.owner = room.owner;
        if (st.role === 'pending')
            st.role = st.delegated ? 'device' : me.role; // a delegated account never acts as the owner
        st.key_roles = Object.fromEntries(room.keys.map((k) => [k.key, k.role]));
        takeWraps(c, st, r.wraps);
        for (const rec of r.events) {
            try {
                verifyOne(st, rec, room, known, cachedAt);
            }
            catch (e) {
                if (e instanceof ForkError)
                    (0, home_1.writeJsonAtomic)(path.join((0, home_1.roomDir)(st.kiosk_id), 'fork_evidence.json'), { at: new Date().toISOString(), seq: e.seq, message: e.message, evidence: e.evidence });
                (0, home_1.saveRoom)(st);
                throw e;
            }
            fs.appendFileSync((0, home_1.cachePath)(st.kiosk_id), JSON.stringify({ event: rec.event, receipt: rec.receipt, body: rec.body, erased: rec.erased || false }) + '\n', { mode: 0o600 });
            st.cursor = rec.receipt.seq;
            const d = decrypt(c, st, rec, room);
            if (d.kind === 'member' && d.meta) {
                const m = d.meta;
                if (m.action === 'create') {
                    st.labels[d.author_wallet] = m.label || st.labels[d.author_wallet];
                    if (m.title)
                        st.title = m.title;
                }
                if (m.action === 'join' && m.wallet)
                    st.labels[(0, canon_1.lc)(m.wallet)] = m.label || st.labels[(0, canon_1.lc)(m.wallet)];
            }
            out.push(d);
        }
        if (r.events.length < 500)
            break;
    }
    (0, home_1.saveRoom)(st);
    return { events: out, room: room, me };
}
async function sync(id) {
    const c = context();
    return (0, home_1.withRoomLock)(id, async () => syncLocked(c, (0, home_1.requireRoom)(id)));
}
function readLocal(id, sinceSeq = 0) {
    const c = context();
    const st = (0, home_1.requireRoom)(id);
    return readCache(id).filter((r) => r.receipt.seq > sinceSeq).map((r) => {
        try {
            return decrypt(c, st, r);
        }
        catch (e) {
            return { ...decrypt(c, st, { ...r, body: null }), undecryptable: true, text: `[integrity failure: ${e.message}]` };
        }
    });
}
// Full re-verification from genesis against a fresh copy from the relay and the local cache.
async function verify(id) {
    const c = context();
    const st = (0, home_1.requireRoom)(id);
    const client = new client_1.RelayClient(st.relay, (0, exports.deviceSigner)(c, id));
    const cache = readCache(id);
    const cachedAt = new Map(cache.map((r) => [r.receipt.seq, r.receipt.receipt_hash]));
    const problems = [];
    const probe = { head: { seq: 0, receipt_hash: canon_1.ZERO32 } };
    const known = new Set();
    let since = 0;
    let count = 0;
    for (;;) {
        const r = await client.call('GET', 'read', { kiosk_id: id, since_seq: since, limit: 500 });
        takeWraps(c, st, r.wraps);
        for (const rec of r.events) {
            try {
                verifyOne(probe, rec, r.room, known, cachedAt);
                decrypt(c, st, rec, r.room);
            }
            catch (e) {
                problems.push(e.message);
                probe.head = { seq: rec.receipt.seq, receipt_hash: rec.receipt.receipt_hash };
                known.add(rec.receipt.receipt_hash);
            }
            since = rec.receipt.seq;
            count++;
        }
        if (r.events.length < 500)
            break;
    }
    return { ok: problems.length === 0, count, head: probe.head.receipt_hash, problems };
}
// ---- membership ---------------------------------------------------------------------------------
async function walletSeq(c, st) {
    const info = await new client_1.RelayClient(st.relay, (0, exports.walletSigner)(c)).call('GET', 'info', { kiosk_id: st.kiosk_id });
    st.author_seq[st.my_wallet] = info.me.author_seq;
    st.epoch = info.room.epoch;
}
async function create(opts) {
    const c = context();
    await (0, presence_1.requirePresence)('create a Kiosk');
    const id = 'kiosk_' + crypto.randomBytes(12).toString('hex');
    const wallet = (0, exports.walletSigner)(c);
    const W = wallet.address.toLowerCase();
    const device = new ethers_1.ethers.Wallet(rand32());
    const x = (0, cryptobox_1.x25519Generate)();
    c.ks.set(`device:${id}`, device.privateKey);
    c.ks.set(`x25519:${id}`, x.priv);
    const ek = (0, cryptobox_1.newEpochKey)();
    c.ks.set(`epoch:${id}:1`, ek);
    const auth = await signedRecord(wallet, keyAuthRecord(id, W, device.address.toLowerCase(), 'device', { x25519: x.pub, label: `${c.cfg.label} device` }));
    const st = {
        v: 1, kiosk_id: id, relay: c.cfg.relay, owner: W, role: 'owner', my_wallet: W,
        device_key: device.address.toLowerCase(), device_x25519: x.pub, author_seq: {}, cursor: 0,
        head: { seq: 0, receipt_hash: canon_1.ZERO32 }, inject_cursor: 0, labels: { [W]: c.cfg.label },
        repo: opts.repo ? path.resolve(opts.repo) : undefined, denylist: [], created_at: new Date().toISOString(), epoch: 1, title: opts.title,
    };
    fs.mkdirSync((0, home_1.roomDir)(id), { recursive: true, mode: 0o700 });
    const g = await build(c, st, wallet, { kind: 'member', evidence: 'presence-signed', text: '', meta: { action: 'create', title: opts.title, objective: opts.objective || null, label: c.cfg.label } });
    try {
        const r = await new client_1.RelayClient(c.cfg.relay, wallet).call('POST', 'create', undefined, {
            kiosk_id: id, owner_device_auth: auth, genesis: { event: g.event, body: g.body },
            wraps: { [auth.key]: (0, cryptobox_1.wrapEpochKey)(ek, x.pub, id, 1) },
        });
        (0, home_1.saveRoom)(st);
        await sync(id);
        return { id, seq: r.receipt.seq };
    }
    catch (e) {
        (0, home_1.wipeRoom)(id, c.ks);
        throw e;
    }
}
async function invite(id, o) {
    const c = context();
    const st = (0, home_1.requireRoom)(id);
    if (st.role !== 'owner')
        throw new Error('Only the owner invites.');
    await (0, presence_1.requirePresence)(`invite someone to ${id}`);
    const code = code32(crypto.randomBytes(16));
    const ops = canon_1.OPS.READ | (o.exportOp ? canon_1.OPS.EXPORT : 0) | (o.derive ? canon_1.OPS.DERIVE : 0);
    const expires = nowSec() + Math.round(o.hours * 3600);
    await new client_1.RelayClient(st.relay, (0, exports.walletSigner)(c)).call('POST', 'invite', undefined, {
        kiosk_id: id, invite_hash: (0, canon_1.sha256Hex)(code), role: o.role, ops, expires_at: expires,
        grant_expires_at: nowSec() + Math.round(o.grantDays * 86400), task_authority: !!o.taskAuthority, owner_label: c.cfg.label,
    });
    const token = 'KSK1-' + Buffer.from(JSON.stringify({ r: st.relay, c: id, k: code })).toString('base64url');
    return { token, code, url: (0, exports.invitationUrl)(st.relay, code), expires_at: new Date(expires * 1000).toISOString(), ops, role: o.role };
}
function parseToken(token) {
    const t = token.trim();
    if (!t.startsWith('KSK1-'))
        throw new Error('not a Kiosk invitation');
    const j = JSON.parse(Buffer.from(t.slice(5), 'base64url').toString('utf8'));
    if (!j.r || !/^kiosk_[0-9a-f]{16,32}$/.test(j.c) || !j.k)
        throw new Error('malformed Kiosk invitation');
    return j;
}
const CODE_RE = /^[A-Z2-9]{4}(-[A-Z2-9]{1,4})+$/;
/** A KSK1 token, the invitation link (its code in the fragment) or the bare code. */
function parseInvitation(input) {
    const t = input.trim();
    if (t.startsWith('KSK1-')) {
        const j = parseToken(t);
        return { relay: j.r, id: j.c, code: j.k };
    }
    if (/^https?:\/\//i.test(t)) {
        const u = new URL(t);
        const at = u.pathname.indexOf('/agent/kiosk/i');
        const code = decodeURIComponent(u.hash.replace(/^#/, '')).trim().toUpperCase();
        if (at < 0 || !CODE_RE.test(code))
            throw new Error('not a Kiosk invitation link');
        return { relay: u.origin + u.pathname.slice(0, at), code };
    }
    if (CODE_RE.test(t.toUpperCase()))
        return { code: t.toUpperCase() };
    throw new Error('not a Kiosk invitation');
}
/**
 * Join from an invitation link, code or token; or, with none, wait for the invitation page to hand
 * one to this terminal (Accept on this Mac, or the pairing code typed anywhere else).
 */
async function join(input, o) {
    const given = input ? parseInvitation(input) : null;
    if (!(0, home_1.loadConfig)())
        init({ relay: given?.relay || o.relay || home_1.DEFAULT_RELAY, label: o.label });
    const c = context();
    let inv;
    if (given) {
        inv = { relay: given.relay || o.relay || c.cfg.relay, id: given.id, code: given.code, via: 'argument' };
    }
    else {
        const relay = o.relay || c.cfg.relay;
        const got = await (0, pairing_1.waitForInvitation)(relay, (0, exports.walletSigner)(c), {
            label: o.label || c.cfg.label, timeoutSec: o.pairTimeoutSec ?? 1800, onPairing: o.onPairing || (() => { }),
        });
        inv = { relay, id: got.kioskId, code: got.code, via: got.via };
    }
    const info = await (0, client_1.publicPost)(inv.relay, 'invite_info', { code: inv.code });
    if (!info.ok)
        throw new Error(`This invitation was already ${info.reason === 'invite_used' ? 'used' : 'expired'}. Ask for a new one.`);
    if (inv.id && inv.id !== info.kiosk_id)
        throw new Error('This invitation does not belong to the Kiosk it names.');
    o.onInvitation?.({ ownerLabel: info.owner_label || null, owner: info.owner || null, role: info.role, via: inv.via });
    return joinWith(c, inv.relay, info.kiosk_id, inv.code, { ...o, ownerLabel: info.owner_label || null });
}
async function joinWith(c, relay, id, code, o) {
    if ((0, home_1.loadRoom)(id))
        throw new Error(`This Mac already joined ${id}.`);
    await (0, presence_1.requirePresence)(`join ${o.ownerLabel ? `${o.ownerLabel}'s` : 'this'} Kiosk and accept its contributor terms`);
    const wallet = (0, exports.walletSigner)(c);
    const W = wallet.address.toLowerCase();
    const device = new ethers_1.ethers.Wallet(rand32());
    const x = (0, cryptobox_1.x25519Generate)();
    c.ks.set(`device:${id}`, device.privateKey);
    c.ks.set(`x25519:${id}`, x.priv);
    const label = o.label || c.cfg.label;
    const auth = await signedRecord(wallet, keyAuthRecord(id, W, device.address.toLowerCase(), 'device', { x25519: x.pub, label: `${label} device` }));
    const consent = await signedRecord(wallet, {
        v: 1, type: 'contributor_terms', kiosk_id: id, wallet: W, terms_ref: canon_1.TERMS_REF_V1,
        guardian: o.guardian ? (0, canon_1.lc)(o.guardian) : undefined, ts: new Date().toISOString(),
    });
    let r;
    try {
        r = await new client_1.RelayClient(relay, wallet).call('POST', 'claim', undefined, { kiosk_id: id, code, device_auth: auth, consent, label });
    }
    catch (e) {
        (0, home_1.wipeRoom)(id, c.ks);
        throw e;
    }
    const verification = verificationCode(W, device.address);
    const st = {
        v: 1, kiosk_id: id, relay, owner: '', role: 'pending', my_wallet: W, device_key: device.address.toLowerCase(),
        device_x25519: x.pub, author_seq: {}, cursor: 0, head: { seq: 0, receipt_hash: canon_1.ZERO32 }, inject_cursor: 0,
        labels: { [W]: label }, denylist: [], created_at: new Date().toISOString(), claim_id: r.claim_id, epoch: 1,
    };
    (0, home_1.saveRoom)(st);
    o.onWaiting?.(`Claim ${r.claim_id} sent. Waiting for the owner to approve it.`, verification);
    const deadline = Date.now() + o.waitSec * 1000;
    const client = new client_1.RelayClient(relay, wallet);
    for (;;) {
        let s;
        try {
            s = await client.call('GET', 'claim_status', { kiosk_id: id, claim_id: r.claim_id });
        }
        catch (e) {
            if (!(e instanceof client_1.NetworkError))
                throw e;
            s = { status: 'pending' };
        }
        if (s.status === 'approved')
            break;
        if (s.status === 'denied') {
            (0, home_1.wipeRoom)(id, c.ks);
            throw new Error('The owner declined this claim.');
        }
        if (Date.now() > deadline)
            return { id, status: 'pending', claim_id: r.claim_id, verification };
        await new Promise((res) => setTimeout(res, 1500));
    }
    const res = await sync(id);
    return { id, status: 'joined', role: res.me.role, events: res.events.length, verification };
}
async function pendingClaims(id) {
    const c = context();
    const st = (0, home_1.requireRoom)(id);
    const list = (await new client_1.RelayClient(st.relay, (0, exports.walletSigner)(c)).call('GET', 'claims', { kiosk_id: id })).claims;
    return list.map((x) => ({ ...x, verification: verificationCode(x.wallet, x.device_key) }));
}
async function approve(id, o) {
    const c = context();
    const st0 = (0, home_1.requireRoom)(id);
    if (st0.role !== 'owner')
        throw new Error('Only the owner approves claims.');
    const deadline = Date.now() + o.waitSec * 1000;
    let claims = [];
    for (;;) {
        claims = (await pendingClaims(id)).filter((x) => !o.claimId || x.claim_id === o.claimId);
        if (claims.length || Date.now() > deadline)
            break;
        await new Promise((r) => setTimeout(r, 1500));
    }
    if (!claims.length)
        return [];
    o.onClaims?.(claims);
    await (0, presence_1.requirePresence)(`admit ${claims.map((x) => `${x.label || 'a new member'} (verification code ${x.verification})`).join(', ')} to ${st0.title || id}`);
    const approved = [];
    await (0, home_1.withRoomLock)(id, async () => {
        const st = (0, home_1.requireRoom)(id);
        const wallet = (0, exports.walletSigner)(c);
        const client = new client_1.RelayClient(st.relay, wallet);
        for (const cl of claims) {
            await walletSeq(c, st);
            const subject = new ethers_1.ethers.Wallet(rand32());
            const subjectSalt = rand32();
            const scopeSalt = rand32();
            const purposeCode = cl.role === 'observer' ? canon_1.PURPOSE.OBSERVER : canon_1.PURPOSE.PARTICIPANT;
            const policy = (0, canon_1.packPolicy)({ notBefore: nowSec() - 120, expiresAt: cl.grant_expires_at, ops: cl.ops, purposeCode, usesMax: 0, agentKind: 0, flags: 0 });
            const record = {
                scopeRef: ethers_1.ethers.keccak256(ethers_1.ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [scopeSalt, (0, canon_1.keccakText)(`kiosk:${id}`)])),
                purposeProfileRef: (0, canon_1.purposeProfileRef)(purposeCode), termsRef: canon_1.TERMS_REF_V1, assetTokenId: '0',
                subjectCommit: (0, canon_1.subjectCommitOf)(subjectSalt, subject.address), grantee: ethers_1.ethers.getAddress(cl.wallet), agent: canon_1.ZERO_ADDR,
                policy: policy.toString(), nonce: '0',
            };
            const subjectSig = await subject.signTypedData(canon_1.GRANT_DOMAIN, canon_1.GRANT_TYPES, { ...record, assetTokenId: 0n, policy, nonce: 0n });
            c.ks.set(`subject:${id}:${cl.wallet}`, JSON.stringify({ key: subject.privateKey, salt: subjectSalt, scope_salt: scopeSalt }));
            const ek = epochKeyOf(c, id, st.epoch);
            if (!ek)
                throw new Error('the owner device has no key for the current epoch');
            const m = await build(c, st, wallet, {
                kind: 'member', evidence: 'presence-signed', text: '',
                meta: { action: 'join', wallet: cl.wallet, label: cl.label, role: cl.role, ops: cl.ops, task_authority: cl.task_authority, guardian: cl.guardian },
            });
            try {
                const r = await client.call('POST', 'approve', undefined, {
                    kiosk_id: id, claim_id: cl.claim_id,
                    grant: { record, subject_salt: subjectSalt, subject_key: subject.address, subject_sig: subjectSig },
                    wraps: { [cl.device_key]: (0, cryptobox_1.wrapEpochKey)(ek, cl.device_x25519, id, st.epoch) },
                    member_event: { event: m.event, body: m.body },
                });
                st.labels[cl.wallet] = cl.label || st.labels[cl.wallet];
                approved.push({ wallet: cl.wallet, label: cl.label, seq: r.receipt.seq, verification: cl.verification });
            }
            finally {
                (0, home_1.saveRoom)(st);
            }
        }
    });
    await sync(id);
    return approved;
}
async function rotateLocked(c, st) {
    const wallet = (0, exports.walletSigner)(c);
    const client = new client_1.RelayClient(st.relay, wallet);
    const info = await client.call('GET', 'info', { kiosk_id: st.kiosk_id });
    const room = info.room;
    const activeWallets = new Set([room.owner, ...room.members.filter((m) => m.status === 1).map((m) => m.wallet)]);
    const ek = (0, cryptobox_1.newEpochKey)();
    const epoch = room.epoch + 1;
    const wraps = {};
    for (const k of room.keys) {
        if (k.role === 'device' && !k.revoked && activeWallets.has(k.wallet) && k.x25519)
            wraps[k.key] = (0, cryptobox_1.wrapEpochKey)(ek, k.x25519, st.kiosk_id, epoch);
    }
    await client.call('POST', 'rotate', undefined, { kiosk_id: st.kiosk_id, epoch, wraps });
    c.ks.set(`epoch:${st.kiosk_id}:${epoch}`, ek);
    st.epoch = epoch;
    return epoch;
}
async function revoke(id, o) {
    const c = context();
    const st0 = (0, home_1.requireRoom)(id);
    const target = o.member ? `member ${(0, exports.display)(o.member)}` : `device ${o.device}`;
    await (0, presence_1.requirePresence)(`revoke ${target} in ${id}`);
    return (0, home_1.withRoomLock)(id, async () => {
        const st = (0, home_1.requireRoom)(id);
        await walletSeq(c, st);
        const wallet = (0, exports.walletSigner)(c);
        // Removing a member is revokeBySubject on her grant record: the grant's subject key signs it.
        let subjectRevocation;
        if (o.member) {
            const W = (0, canon_1.lc)(o.member);
            const info = await new client_1.RelayClient(st.relay, wallet).call('GET', 'info', { kiosk_id: id });
            const m = info.room.members.find((x) => x.wallet === W);
            if (!m)
                throw new Error(`${(0, exports.display)(W)} is not a member of ${id}`);
            const secret = c.ks.get(`subject:${id}:${W}`);
            if (!secret)
                throw new Error(`the subject key for ${(0, exports.display)(W)} is not on this Mac; only the Mac that admitted her can revoke her grant`);
            const sk = JSON.parse(secret);
            const subject = new ethers_1.ethers.Wallet(sk.key);
            const reasonCode = (0, canon_1.keccakText)('kiosk:owner_removed');
            const nonce = Number(m.subject_nonce);
            subjectRevocation = {
                grant_id: m.grant_id, reason_code: reasonCode, nonce, subject_key: subject.address, subject_salt: sk.salt,
                subject_sig: await subject.signTypedData(canon_1.GRANT_DOMAIN, canon_1.REVOKE_TYPES, { grantId: m.grant_id, reasonCode, nonce: BigInt(nonce) }),
            };
        }
        const ev = await build(c, st, wallet, {
            kind: 'member', evidence: 'presence-signed', text: '',
            meta: o.member ? { action: 'revoke', wallet: (0, canon_1.lc)(o.member) } : { action: 'revoke_device', key: (0, canon_1.lc)(o.device) },
        });
        try {
            await new client_1.RelayClient(st.relay, wallet).call('POST', 'revoke', undefined, {
                kiosk_id: id, target_wallet: o.member ? (0, canon_1.lc)(o.member) : undefined, target_key: o.device ? (0, canon_1.lc)(o.device) : undefined,
                subject_revocation: subjectRevocation, event: { event: ev.event, body: ev.body },
            });
        }
        finally {
            (0, home_1.saveRoom)(st);
        }
        if (o.member)
            c.ks.del(`subject:${id}:${(0, canon_1.lc)(o.member)}`); // the grant is terminal; its opening is no longer needed
        let epoch = null;
        if (st0.role === 'owner')
            epoch = await rotateLocked(c, st);
        (0, home_1.saveRoom)(st);
        return { epoch };
    });
}
async function rotate(id) {
    const c = context();
    const st0 = (0, home_1.requireRoom)(id);
    if (st0.role !== 'owner')
        throw new Error('Only the owner rotates the room key.');
    await (0, presence_1.requirePresence)(`rotate the key of ${id}`);
    return (0, home_1.withRoomLock)(id, async () => { const st = (0, home_1.requireRoom)(id); const e = await rotateLocked(c, st); (0, home_1.saveRoom)(st); return e; });
}
async function leave(id, o = {}) {
    const c = context();
    const st0 = (0, home_1.requireRoom)(id);
    if (st0.role === 'owner')
        throw new Error('The owner deletes a Kiosk instead of leaving it: kiosk delete');
    await (0, presence_1.requirePresence)(`leave ${id}`);
    await (0, home_1.withRoomLock)(id, async () => {
        const st = (0, home_1.requireRoom)(id);
        await walletSeq(c, st);
        const wallet = (0, exports.walletSigner)(c);
        const ev = await build(c, st, wallet, { kind: 'member', evidence: 'presence-signed', text: '', meta: { action: 'leave' } });
        await new client_1.RelayClient(st.relay, wallet).call('POST', 'leave', undefined, { kiosk_id: id, event: { event: ev.event, body: ev.body } });
    });
    if (!o.keepLocal)
        (0, home_1.wipeRoom)(id, c.ks);
}
async function deleteRoom(id) {
    const c = context();
    const st = (0, home_1.requireRoom)(id);
    if (st.role !== 'owner')
        throw new Error('Only the owner deletes a Kiosk.');
    await (0, presence_1.requirePresence)(`delete ${id} for every member`);
    await new client_1.RelayClient(st.relay, (0, exports.walletSigner)(c)).call('POST', 'delete', undefined, { kiosk_id: id });
    (0, home_1.wipeRoom)(id, c.ks);
}
async function erase(id, seq) {
    const c = context();
    return (0, home_1.withRoomLock)(id, async () => {
        const st = (0, home_1.requireRoom)(id);
        const pending = await flushLocked(c, st);
        if (pending.some((p) => p.status === 'queued'))
            throw new Error('relay unreachable; erase needs the relay');
        const signer = (0, exports.deviceSigner)(c, id);
        const ev = await build(c, st, signer, { kind: 'erase', evidence: 'key-signed', refs: [seq] });
        try {
            const r = await new client_1.RelayClient(st.relay, signer).call('POST', 'erase', undefined, { kiosk_id: id, seq, event: { event: ev.event } });
            return r.receipt.seq;
        }
        catch (e) {
            st.author_seq[ev.event.author_key] -= 1;
            throw e;
        }
        finally {
            (0, home_1.saveRoom)(st);
        }
    });
}
// ---- seats and devices ---------------------------------------------------------------------------
async function ensureSeat(id, model) {
    const c = context();
    const st = (0, home_1.requireRoom)(id);
    if (st.seat_key && c.ks.get(`seat:${id}`))
        return st.seat_key;
    if (st.delegated)
        throw new Error('This account holds no wallet. Request a seat with: kiosk device-request <id> --wallet <owner wallet> --seat, and approve it from the owner account.');
    await (0, presence_1.requirePresence)(`authorize a Claude Code seat for ${id}`);
    const wallet = (0, exports.walletSigner)(c);
    const seat = new ethers_1.ethers.Wallet(rand32());
    const auth = await signedRecord(wallet, keyAuthRecord(id, st.my_wallet, seat.address.toLowerCase(), 'seat', {
        device: st.device_key, model, label: `${st.labels[st.my_wallet] || c.cfg.label} seat`,
    }));
    await new client_1.RelayClient(st.relay, wallet).call('POST', 'keys/authorize', undefined, { kiosk_id: id, key_auth: auth });
    c.ks.set(`seat:${id}`, seat.privateKey);
    await (0, home_1.withRoomLock)(id, async () => { const s = (0, home_1.requireRoom)(id); s.seat_key = seat.address.toLowerCase(); s.model = model; (0, home_1.saveRoom)(s); });
    return seat.address.toLowerCase();
}
/**
 * Enroll this account as a device of a wallet. The request carries only public keys and unsigned key
 * authorizations; the account that holds the wallet signs them in deviceApprove. With `wallet` set to
 * another account's wallet (a separate macOS user for the owner's seats), the wallet key never comes
 * here: this account can post and run a seat, and cannot invite, admit, revoke or rotate.
 */
async function deviceRequest(id, relay, o = {}) {
    const c = context();
    if ((0, home_1.loadRoom)(id))
        throw new Error(`This Mac account already has ${id}.`);
    const W = (0, canon_1.lc)(o.wallet || c.cfg.wallet);
    if (!/^0x[0-9a-f]{40}$/.test(W))
        throw new Error('--wallet must be a 0x wallet address');
    const delegated = W !== (0, canon_1.lc)(c.cfg.wallet);
    const label = o.label || c.cfg.label;
    const device = new ethers_1.ethers.Wallet(rand32());
    const x = (0, cryptobox_1.x25519Generate)();
    const d = keyAuthRecord(id, W, device.address.toLowerCase(), 'device', { x25519: x.pub, label: `${label} device` });
    let s = null;
    let seat = null;
    if (o.seat) {
        seat = new ethers_1.ethers.Wallet(rand32());
        s = keyAuthRecord(id, W, seat.address.toLowerCase(), 'seat', { device: device.address.toLowerCase(), model: o.model || 'claude', label: `${label} seat` });
    }
    const token = 'KSKD-' + Buffer.from(JSON.stringify({ v: 2, c: id, d, s })).toString('base64url');
    // The file is written before any key is stored, so a refused file leaves nothing behind and the
    // request can be made again. It must not exist yet: in a shared folder such as /Users/Shared, a file
    // another account created first could be rewritten by that account before the approval.
    if (o.out) {
        try {
            fs.writeFileSync(o.out, token + '\n', { flag: 'wx', mode: 0o644 });
        }
        catch (e) {
            if (e && e.code === 'EEXIST')
                throw new Error(`${o.out} already exists. Delete it, or choose another file name.`);
            throw e;
        }
    }
    c.ks.set(`device:${id}`, device.privateKey);
    c.ks.set(`x25519:${id}`, x.priv);
    if (seat)
        c.ks.set(`seat:${id}`, seat.privateKey);
    const st = {
        v: 1, kiosk_id: id, relay, owner: '', role: 'pending', my_wallet: W, device_key: device.address.toLowerCase(),
        device_x25519: x.pub, author_seq: {}, cursor: 0, head: { seq: 0, receipt_hash: canon_1.ZERO32 }, inject_cursor: 0,
        labels: { [W]: label }, denylist: [], created_at: new Date().toISOString(), epoch: 1,
        seat_key: seat ? seat.address.toLowerCase() : undefined, model: o.model || undefined, delegated: delegated || undefined,
    };
    (0, home_1.saveRoom)(st);
    return { token, verification: verificationCode(W, device.address) };
}
/**
 * On the account that holds the wallet: check a device request, confirm with presence, sign it.
 * The verification code, shown before presence and inside the Touch ID prompt, must match the code the
 * requesting account printed; a request swapped on its way between the two accounts shows another code.
 */
async function deviceApprove(id, token, onVerify) {
    const c = context();
    const st = (0, home_1.requireRoom)(id);
    if (st.delegated)
        throw new Error('This account holds no wallet; approve from the account that does.');
    const t = token.trim();
    if (!t.startsWith('KSKD-'))
        throw new Error('not a Kiosk device request');
    const j = JSON.parse(Buffer.from(t.slice(5), 'base64url').toString('utf8'));
    if (j.c !== id)
        throw new Error('this device request is for another Kiosk');
    const wallet = (0, exports.walletSigner)(c);
    const client = new client_1.RelayClient(st.relay, wallet);
    const wrapsFor = (x25519) => {
        const wraps = {};
        for (let e = 1; e <= st.epoch; e++) {
            const ek = epochKeyOf(c, id, e);
            if (ek)
                wraps[String(e)] = (0, cryptobox_1.wrapEpochKey)(ek, x25519, id, e);
        }
        return wraps;
    };
    if (j.a) { // a version 1 request, already signed by a copy of the same wallet
        if ((0, canon_1.lc)(j.a.wallet) !== st.my_wallet)
            throw new Error('this device request is for another wallet');
        const code1 = verificationCode(st.my_wallet, j.a.key);
        if (onVerify)
            onVerify(code1);
        await (0, presence_1.requirePresence)(`enroll device ${j.a.label || j.a.key} in ${id}, verification ${code1}`);
        await client.call('POST', 'keys/authorize', undefined, { kiosk_id: id, key_auth: j.a, wraps: wrapsFor(j.a.x25519) });
        return { device: j.a.key, seat: null, verification: code1 };
    }
    const d = j.d, s = j.s;
    const own = (r, role) => r && r.type === 'key_auth' && r.v === 1 && r.kiosk_id === id && (0, canon_1.lc)(r.wallet) === st.my_wallet && r.role === role && !r.sig;
    if (!own(d, 'device') || !/^[0-9a-f]{64}$/.test(String(d.x25519 || '')))
        throw new Error('this device request is for another wallet or is malformed');
    if (s && (!own(s, 'seat') || s.device !== d.key))
        throw new Error('the seat in this request does not belong to its device');
    const code = verificationCode(st.my_wallet, d.key);
    if (onVerify)
        onVerify(code);
    await (0, presence_1.requirePresence)(`enroll ${d.label || d.key}${s ? ` and its Claude Code seat (${s.model || 'claude'})` : ''} in ${st.title || id}, verification ${code}`);
    await client.call('POST', 'keys/authorize', undefined, { kiosk_id: id, key_auth: await signedRecord(wallet, d), wraps: wrapsFor(d.x25519) });
    if (s)
        await client.call('POST', 'keys/authorize', undefined, { kiosk_id: id, key_auth: await signedRecord(wallet, s) });
    return { device: d.key, seat: s ? s.key : null, verification: code };
}
// ---- leases, status, credits, export ------------------------------------------------------------
async function lease(id, relPath, o = {}) {
    const c = context();
    const st = (0, home_1.requireRoom)(id);
    const ek = epochKeyOf(c, id, st.epoch);
    if (!ek)
        throw new Error('no current room key on this device; run kiosk sync');
    const signer = o.as === 'seat' && st.seat_key ? (0, exports.seatSigner)(c, id) : (0, exports.deviceSigner)(c, id);
    const r = await new client_1.RelayClient(st.relay, signer).call('POST', 'lease', undefined, {
        kiosk_id: id, target_id: (0, cryptobox_1.leaseTarget)(ek, relPath), ttl_sec: o.ttlSec || 900, release: !!o.release,
    });
    return { ...r, holder_label: r.holder_wallet ? (st.labels[r.holder_wallet] || (0, exports.display)(r.holder_wallet)) : undefined };
}
async function info(id) {
    const c = context();
    const st = (0, home_1.requireRoom)(id);
    return new client_1.RelayClient(st.relay, (0, exports.deviceSigner)(c, id)).call('GET', 'info', { kiosk_id: id });
}
async function exportRoom(id, out) {
    const i = await info(id);
    if (!(i.me.ops & canon_1.OPS.EXPORT))
        throw new Error('Refused: this grant does not include EXPORT. Ask the owner for an invitation with --export.');
    await sync(id);
    const rows = readLocal(id);
    fs.writeFileSync(out, JSON.stringify({ kiosk_id: id, exported_at: new Date().toISOString(), events: rows }, null, 2), { mode: 0o600 });
    return rows.length;
}
function credits(id, repo) {
    const rows = readLocal(id);
    const by = {};
    for (const r of rows) {
        const k = `${r.label} (${(0, exports.display)(r.author_wallet)})`;
        by[k] = by[k] || { events: 0, by_kind: {}, by_key: { wallet: 0, device: 0, seat: 0 }, by_evidence: {}, seat_models: {} };
        const a = by[k];
        a.events++;
        a.by_kind[r.kind] = (a.by_kind[r.kind] || 0) + 1;
        a.by_key[r.key_role] = (a.by_key[r.key_role] || 0) + 1;
        a.by_evidence[r.evidence] = (a.by_evidence[r.evidence] || 0) + 1;
        const model = r.meta && typeof r.meta.model === 'string' ? `${r.meta.model} (attested)` : null;
        if (r.key_role === 'seat' && model)
            a.seat_models[model] = (a.seat_models[model] || 0) + 1;
    }
    let commits = null;
    if (repo) {
        const g = (0, child_process_1.spawnSync)('git', ['-C', repo, 'log', '--format=%an%x1f%(trailers:key=Kiosk-Event,valueonly,separator=%x2C)'], { encoding: 'utf8' });
        if (g.status === 0) {
            commits = {};
            for (const line of g.stdout.split('\n')) {
                const [an, tr] = line.split('\x1f');
                if (tr && tr.includes(id))
                    commits[an] = (commits[an] || 0) + 1;
            }
        }
    }
    return { kiosk_id: id, authors: by, commits_with_kiosk_trailer: commits, note: 'Model names and roles are attested by the local harness; key signatures prove which key signed, not which person typed.' };
}
function openTasks(id) {
    const rows = readLocal(id);
    const done = new Set();
    for (const r of rows)
        if (r.kind === 'task_done')
            for (const ref of r.refs)
                done.add(ref);
    return rows.filter((r) => r.kind === 'task' && !done.has(r.seq));
}
