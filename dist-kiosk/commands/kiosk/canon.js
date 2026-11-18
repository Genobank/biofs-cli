"use strict";
/**
 * KSK1 canonical encoding, the member-side copy.
 *
 * An INDEPENDENT reimplementation of biofs-node src/lib/kiosk/canon.js, so a member verifies the
 * relay's receipts with code the relay did not supply. Byte-identical by contract: canonical JSON
 * (keys sorted, no whitespace, undefined dropped), keccak256 over UTF-8, EIP-191 signatures over
 * 32-byte digests, the request string, the ERC-8356 Grant struct and policy layout.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.purposeProfileRef = exports.PURPOSE_PROFILES = exports.TERMS_REF_V1 = exports.TERMS_V1 = exports.PURPOSE = exports.OPS = exports.REVOKE_TYPES = exports.GRANT_TYPES = exports.GRANT_DOMAIN = exports.recoverHashSigner = exports.receiptHash = exports.eventHash = exports.RECEIPT_FIELDS = exports.EVENT_FIELDS = exports.lc = exports.sha256Hex = exports.keccakText = exports.ZERO_ADDR = exports.ZERO32 = void 0;
exports.canon = canon;
exports.recordHash = recordHash;
exports.requestMessage = requestMessage;
exports.packPolicy = packPolicy;
exports.subjectCommitOf = subjectCommitOf;
const crypto_1 = require("crypto");
const ethers_1 = require("ethers");
exports.ZERO32 = '0x' + '0'.repeat(64);
exports.ZERO_ADDR = '0x' + '0'.repeat(40);
function canon(v) {
    if (v === null || typeof v !== 'object')
        return JSON.stringify(v);
    if (Array.isArray(v))
        return '[' + v.map(canon).join(',') + ']';
    const o = v;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
}
const keccakText = (s) => ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(s));
exports.keccakText = keccakText;
const sha256Hex = (data) => (0, crypto_1.createHash)('sha256').update(data).digest('hex');
exports.sha256Hex = sha256Hex;
const lc = (a) => String(a || '').toLowerCase();
exports.lc = lc;
exports.EVENT_FIELDS = [
    'v', 'kiosk_id', 'epoch', 'author_key', 'author_wallet', 'author_seq', 'kind',
    'evidence', 'refs', 'seen_receipt', 'body_commit', 'ts_claimed',
];
exports.RECEIPT_FIELDS = ['v', 'kiosk_id', 'seq', 'event_hash', 'prev_receipt', 'ts_relay'];
function pick(obj, fields) {
    const out = {};
    for (const k of fields)
        out[k] = obj[k] === undefined ? null : obj[k];
    return out;
}
const eventHash = (ev) => (0, exports.keccakText)(canon(pick(ev, exports.EVENT_FIELDS)));
exports.eventHash = eventHash;
const receiptHash = (r) => (0, exports.keccakText)(canon(pick(r, exports.RECEIPT_FIELDS)));
exports.receiptHash = receiptHash;
function recordHash(rec) {
    const { sig, ...rest } = rec;
    void sig;
    return (0, exports.keccakText)(canon(rest));
}
function requestMessage(method, pathWithQuery, bodyStr, ts, nonce) {
    return ['KSK1-REQ', method.toUpperCase(), pathWithQuery, (0, exports.sha256Hex)(bodyStr || ''), String(ts), nonce].join('\n');
}
const recoverHashSigner = (hash, sig) => (0, exports.lc)(ethers_1.ethers.verifyMessage(ethers_1.ethers.getBytes(hash), sig));
exports.recoverHashSigner = recoverHashSigner;
// ---- ERC-8356 grant record (Stage 1, off chain) -----------------------------------------------
exports.GRANT_DOMAIN = { name: 'KioskGrantRecord', version: '1', chainId: 0, verifyingContract: exports.ZERO_ADDR };
exports.GRANT_TYPES = {
    Grant: [
        { name: 'scopeRef', type: 'bytes32' },
        { name: 'purposeProfileRef', type: 'bytes32' },
        { name: 'termsRef', type: 'bytes32' },
        { name: 'assetTokenId', type: 'uint256' },
        { name: 'subjectCommit', type: 'bytes32' },
        { name: 'grantee', type: 'address' },
        { name: 'agent', type: 'address' },
        { name: 'policy', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
    ],
};
/** revokeBySubject for a Stage 1 grant record, signed by the grant's subject key (same domain). */
exports.REVOKE_TYPES = {
    RevokeBySubject: [
        { name: 'grantId', type: 'bytes32' },
        { name: 'reasonCode', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
    ],
};
function packPolicy(p) {
    const B = (x) => BigInt(x || 0);
    return B(p.notBefore) | (B(p.expiresAt) << 48n) | (B(p.ops) << 96n) | (B(p.purposeCode) << 128n)
        | (B(p.usesMax) << 160n) | (B(p.agentKind) << 176n) | (B(p.flags) << 184n);
}
function subjectCommitOf(subjectSalt, subjectKey) {
    return ethers_1.ethers.keccak256(ethers_1.ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'address'], [subjectSalt, subjectKey]));
}
exports.OPS = { READ: 0x01, QUERY: 0x02, DERIVE: 0x04, EXPORT: 0x08, TRAIN: 0x10 };
exports.PURPOSE = { PARTICIPANT: 1, OBSERVER: 2 };
exports.TERMS_V1 = [
    'Kiosk contributor terms, version 1.',
    'I contribute my own events to this Kiosk for its stated objective.',
    'Every current member of the Kiosk may read them for that objective only.',
    'No member may train a model on them, disclose them onward, or export them unless a grant says so.',
    'I may erase any event I authored at any time. A member under 18 and her guardian may erase hers.',
].join('\n');
exports.TERMS_REF_V1 = (0, exports.keccakText)(exports.TERMS_V1);
exports.PURPOSE_PROFILES = {
    [exports.PURPOSE.PARTICIPANT]: [
        { term: 'append', value: 'permitted' },
        { term: 'export', value: 'only_with_EXPORT_op' },
        { term: 'onward_disclosure', value: 'prohibited' },
        { term: 'purpose', value: 'joint_work_toward_the_stated_objective' },
        { term: 'training', value: 'prohibited' },
    ],
    [exports.PURPOSE.OBSERVER]: [
        { term: 'append', value: 'not_permitted' },
        { term: 'export', value: 'only_with_EXPORT_op' },
        { term: 'onward_disclosure', value: 'prohibited' },
        { term: 'purpose', value: 'joint_work_toward_the_stated_objective' },
        { term: 'training', value: 'prohibited' },
    ],
};
const purposeProfileRef = (code) => (0, exports.keccakText)(canon(exports.PURPOSE_PROFILES[code]));
exports.purposeProfileRef = purposeProfileRef;
