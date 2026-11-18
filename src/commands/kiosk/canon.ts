/**
 * KSK1 canonical encoding, the member-side copy.
 *
 * An INDEPENDENT reimplementation of biofs-node src/lib/kiosk/canon.js, so a member verifies the
 * relay's receipts with code the relay did not supply. Byte-identical by contract: canonical JSON
 * (keys sorted, no whitespace, undefined dropped), keccak256 over UTF-8, EIP-191 signatures over
 * 32-byte digests, the request string, the ERC-8356 Grant struct and policy layout.
 */

import { createHash } from 'crypto';
import { ethers } from 'ethers';

export const ZERO32 = '0x' + '0'.repeat(64);
export const ZERO_ADDR = '0x' + '0'.repeat(40);

export function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
}

export const keccakText = (s: string): string => ethers.keccak256(ethers.toUtf8Bytes(s));
export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
export const lc = (a: unknown): string => String(a || '').toLowerCase();

export const EVENT_FIELDS = [
  'v', 'kiosk_id', 'epoch', 'author_key', 'author_wallet', 'author_seq', 'kind',
  'evidence', 'refs', 'seen_receipt', 'body_commit', 'ts_claimed',
];
export const RECEIPT_FIELDS = ['v', 'kiosk_id', 'seq', 'event_hash', 'prev_receipt', 'ts_relay'];

function pick(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of fields) out[k] = obj[k] === undefined ? null : obj[k];
  return out;
}

export interface EventHeader {
  v: 1;
  kiosk_id: string;
  epoch: number;
  author_key: string;
  author_wallet: string;
  author_seq: number;
  kind: string;
  evidence: 'presence-signed' | 'key-signed' | 'harness-attested';
  refs: number[];
  seen_receipt: string | null;
  body_commit: string | null;
  ts_claimed: string;
  sig?: string;
}

export interface Receipt {
  v: 1;
  kiosk_id: string;
  seq: number;
  event_hash: string;
  prev_receipt: string;
  ts_relay: string;
  receipt_hash: string;
  relay_sig: string;
}

export const eventHash = (ev: EventHeader): string => keccakText(canon(pick(ev as unknown as Record<string, unknown>, EVENT_FIELDS)));
export const receiptHash = (r: Receipt): string => keccakText(canon(pick(r as unknown as Record<string, unknown>, RECEIPT_FIELDS)));

export function recordHash(rec: Record<string, unknown>): string {
  const { sig, ...rest } = rec;
  void sig;
  return keccakText(canon(rest));
}

export function requestMessage(method: string, pathWithQuery: string, bodyStr: string, ts: number, nonce: string): string {
  return ['KSK1-REQ', method.toUpperCase(), pathWithQuery, sha256Hex(bodyStr || ''), String(ts), nonce].join('\n');
}

export const recoverHashSigner = (hash: string, sig: string): string => lc(ethers.verifyMessage(ethers.getBytes(hash), sig));

// ---- ERC-8356 grant record (Stage 1, off chain) -----------------------------------------------
export const GRANT_DOMAIN = { name: 'KioskGrantRecord', version: '1', chainId: 0, verifyingContract: ZERO_ADDR };
export const GRANT_TYPES = {
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
export const REVOKE_TYPES = {
  RevokeBySubject: [
    { name: 'grantId', type: 'bytes32' },
    { name: 'reasonCode', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
  ],
};

export interface PolicyFields {
  notBefore: number; expiresAt: number; ops: number; purposeCode: number; usesMax: number; agentKind: number; flags: number;
}

export function packPolicy(p: PolicyFields): bigint {
  const B = (x: number) => BigInt(x || 0);
  return B(p.notBefore) | (B(p.expiresAt) << 48n) | (B(p.ops) << 96n) | (B(p.purposeCode) << 128n)
    | (B(p.usesMax) << 160n) | (B(p.agentKind) << 176n) | (B(p.flags) << 184n);
}

export function subjectCommitOf(subjectSalt: string, subjectKey: string): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'address'], [subjectSalt, subjectKey]));
}

export const OPS = { READ: 0x01, QUERY: 0x02, DERIVE: 0x04, EXPORT: 0x08, TRAIN: 0x10 };
export const PURPOSE = { PARTICIPANT: 1, OBSERVER: 2 };

export const TERMS_V1 = [
  'Kiosk contributor terms, version 1.',
  'I contribute my own events to this Kiosk for its stated objective.',
  'Every current member of the Kiosk may read them for that objective only.',
  'No member may train a model on them, disclose them onward, or export them unless a grant says so.',
  'I may erase any event I authored at any time. A member under 18 and her guardian may erase hers.',
].join('\n');
export const TERMS_REF_V1 = keccakText(TERMS_V1);

export const PURPOSE_PROFILES: Record<number, Array<{ term: string; value: string }>> = {
  [PURPOSE.PARTICIPANT]: [
    { term: 'append', value: 'permitted' },
    { term: 'export', value: 'only_with_EXPORT_op' },
    { term: 'onward_disclosure', value: 'prohibited' },
    { term: 'purpose', value: 'joint_work_toward_the_stated_objective' },
    { term: 'training', value: 'prohibited' },
  ],
  [PURPOSE.OBSERVER]: [
    { term: 'append', value: 'not_permitted' },
    { term: 'export', value: 'only_with_EXPORT_op' },
    { term: 'onward_disclosure', value: 'prohibited' },
    { term: 'purpose', value: 'joint_work_toward_the_stated_objective' },
    { term: 'training', value: 'prohibited' },
  ],
};
export const purposeProfileRef = (code: number): string => keccakText(canon(PURPOSE_PROFILES[code]));
