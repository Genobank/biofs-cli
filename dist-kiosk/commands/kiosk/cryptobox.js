"use strict";
/**
 * End-to-end encryption for a Kiosk, built only on Node's own crypto:
 *   bodies     ChaCha20-Poly1305 (IETF, random 96-bit nonce) under the room's epoch key, with the
 *              event hash as associated data, so a body cannot be moved to another event;
 *   key wraps  an X25519 sealed box: ephemeral X25519, HKDF-SHA256 over (ephemeral, recipient),
 *              ChaCha20-Poly1305 over the epoch key with (kiosk id, epoch) as associated data;
 *   commits    keccak256(salt || sha256(content)), the salt living only inside the ciphertext.
 * The relay stores wraps and ciphertext and can open neither.
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
exports.newSalt = exports.newEpochKey = void 0;
exports.x25519Generate = x25519Generate;
exports.x25519PubFromPriv = x25519PubFromPriv;
exports.wrapEpochKey = wrapEpochKey;
exports.unwrapEpochKey = unwrapEpochKey;
exports.contentOf = contentOf;
exports.bodyCommit = bodyCommit;
exports.sealBody = sealBody;
exports.openBody = openBody;
exports.leaseTarget = leaseTarget;
const crypto = __importStar(require("crypto"));
const ethers_1 = require("ethers");
const canon_1 = require("./canon");
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const pubKeyObj = (rawHex) => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(rawHex, 'hex')]), format: 'der', type: 'spki' });
const privKeyObj = (rawHex) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(rawHex, 'hex')]), format: 'der', type: 'pkcs8' });
function x25519Generate() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    return {
        pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
        priv: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex'),
    };
}
function x25519PubFromPriv(privHex) {
    return crypto.createPublicKey(privKeyObj(privHex)).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
}
function seal(key, plaintext, aad) {
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    c.setAAD(aad, { plaintextLength: plaintext.length });
    const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
    return { nonce: nonce.toString('base64'), ct: ct.toString('base64') };
}
function open(key, nonceB64, ctB64, aad) {
    const nonce = Buffer.from(nonceB64, 'base64');
    const data = Buffer.from(ctB64, 'base64');
    if (data.length < 16)
        throw new Error('ciphertext too short');
    const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    d.setAAD(aad, { plaintextLength: data.length - 16 });
    d.setAuthTag(data.subarray(-16));
    return Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
}
function wrapKey(shared, ephPub, recipientPub) {
    const salt = Buffer.concat([Buffer.from(ephPub, 'hex'), Buffer.from(recipientPub, 'hex')]);
    return Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from('KSK1 epoch key wrap'), 32));
}
function wrapEpochKey(epochKeyHex, recipientPubHex, kioskId, epoch) {
    const eph = crypto.generateKeyPairSync('x25519');
    const ephPub = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubKeyObj(recipientPubHex) });
    const s = seal(wrapKey(shared, ephPub, recipientPubHex), Buffer.from(epochKeyHex, 'hex'), Buffer.from(`${kioskId}:${epoch}`));
    return { v: 1, eph: ephPub, nonce: s.nonce, ct: s.ct };
}
function unwrapEpochKey(wrap, myPrivHex, kioskId, epoch) {
    const myPub = x25519PubFromPriv(myPrivHex);
    const shared = crypto.diffieHellman({ privateKey: privKeyObj(myPrivHex), publicKey: pubKeyObj(wrap.eph) });
    return open(wrapKey(shared, wrap.eph, myPub), wrap.nonce, wrap.ct, Buffer.from(`${kioskId}:${epoch}`)).toString('hex');
}
const newEpochKey = () => crypto.randomBytes(32).toString('hex');
exports.newEpochKey = newEpochKey;
const newSalt = () => crypto.randomBytes(16).toString('hex');
exports.newSalt = newSalt;
function contentOf(p) {
    return (0, canon_1.canon)({ text: p.text, meta: p.meta === undefined ? null : p.meta });
}
function bodyCommit(p) {
    const sh = crypto.createHash('sha256').update(contentOf(p), 'utf8').digest();
    return ethers_1.ethers.keccak256(Buffer.concat([Buffer.from(p.salt, 'hex'), sh]));
}
function sealBody(epochKeyHex, eventHashHex, p) {
    return seal(Buffer.from(epochKeyHex, 'hex'), Buffer.from(JSON.stringify(p), 'utf8'), Buffer.from(eventHashHex.slice(2), 'hex'));
}
function openBody(epochKeyHex, eventHashHex, body) {
    return JSON.parse(open(Buffer.from(epochKeyHex, 'hex'), body.nonce, body.ct, Buffer.from(eventHashHex.slice(2), 'hex')).toString('utf8'));
}
// Lease targets reach the relay only as a keyed hash of the repository path.
function leaseTarget(epochKeyHex, relPath) {
    return '0x' + crypto.createHmac('sha256', Buffer.from(epochKeyHex, 'hex')).update(`lease:${relPath}`).digest('hex');
}
