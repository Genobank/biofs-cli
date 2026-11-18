/**
 * End-to-end encryption for a Kiosk, built only on Node's own crypto:
 *   bodies     ChaCha20-Poly1305 (IETF, random 96-bit nonce) under the room's epoch key, with the
 *              event hash as associated data, so a body cannot be moved to another event;
 *   key wraps  an X25519 sealed box: ephemeral X25519, HKDF-SHA256 over (ephemeral, recipient),
 *              ChaCha20-Poly1305 over the epoch key with (kiosk id, epoch) as associated data;
 *   commits    keccak256(salt || sha256(content)), the salt living only inside the ciphertext.
 * The relay stores wraps and ciphertext and can open neither.
 */

import * as crypto from 'crypto';
import { ethers } from 'ethers';
import { canon } from './canon';

const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

const pubKeyObj = (rawHex: string) => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(rawHex, 'hex')]), format: 'der', type: 'spki' });
const privKeyObj = (rawHex: string) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(rawHex, 'hex')]), format: 'der', type: 'pkcs8' });

export function x25519Generate(): { pub: string; priv: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    pub: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex'),
    priv: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32).toString('hex'),
  };
}

export function x25519PubFromPriv(privHex: string): string {
  return (crypto.createPublicKey(privKeyObj(privHex)).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): { nonce: string; ct: string } {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: plaintext.length });
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { nonce: nonce.toString('base64'), ct: ct.toString('base64') };
}

function open(key: Buffer, nonceB64: string, ctB64: string, aad: Buffer): Buffer {
  const nonce = Buffer.from(nonceB64, 'base64');
  const data = Buffer.from(ctB64, 'base64');
  if (data.length < 16) throw new Error('ciphertext too short');
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  d.setAAD(aad, { plaintextLength: data.length - 16 });
  d.setAuthTag(data.subarray(-16));
  return Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
}

function wrapKey(shared: Buffer, ephPub: string, recipientPub: string): Buffer {
  const salt = Buffer.concat([Buffer.from(ephPub, 'hex'), Buffer.from(recipientPub, 'hex')]);
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from('KSK1 epoch key wrap'), 32));
}

export interface Wrap { v: 1; eph: string; nonce: string; ct: string }

export function wrapEpochKey(epochKeyHex: string, recipientPubHex: string, kioskId: string, epoch: number): Wrap {
  const eph = crypto.generateKeyPairSync('x25519');
  const ephPub = (eph.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubKeyObj(recipientPubHex) });
  const s = seal(wrapKey(shared, ephPub, recipientPubHex), Buffer.from(epochKeyHex, 'hex'), Buffer.from(`${kioskId}:${epoch}`));
  return { v: 1, eph: ephPub, nonce: s.nonce, ct: s.ct };
}

export function unwrapEpochKey(wrap: Wrap, myPrivHex: string, kioskId: string, epoch: number): string {
  const myPub = x25519PubFromPriv(myPrivHex);
  const shared = crypto.diffieHellman({ privateKey: privKeyObj(myPrivHex), publicKey: pubKeyObj(wrap.eph) });
  return open(wrapKey(shared, wrap.eph, myPub), wrap.nonce, wrap.ct, Buffer.from(`${kioskId}:${epoch}`)).toString('hex');
}

export const newEpochKey = (): string => crypto.randomBytes(32).toString('hex');
export const newSalt = (): string => crypto.randomBytes(16).toString('hex');

export interface Payload { salt: string; text: string; meta?: Record<string, unknown> }

export function contentOf(p: Payload): string {
  return canon({ text: p.text, meta: p.meta === undefined ? null : p.meta });
}

export function bodyCommit(p: Payload): string {
  const sh = crypto.createHash('sha256').update(contentOf(p), 'utf8').digest();
  return ethers.keccak256(Buffer.concat([Buffer.from(p.salt, 'hex'), sh]));
}

export function sealBody(epochKeyHex: string, eventHashHex: string, p: Payload): { nonce: string; ct: string } {
  return seal(Buffer.from(epochKeyHex, 'hex'), Buffer.from(JSON.stringify(p), 'utf8'), Buffer.from(eventHashHex.slice(2), 'hex'));
}

export function openBody(epochKeyHex: string, eventHashHex: string, body: { nonce: string; ct: string }): Payload {
  return JSON.parse(open(Buffer.from(epochKeyHex, 'hex'), body.nonce, body.ct, Buffer.from(eventHashHex.slice(2), 'hex')).toString('utf8'));
}

// Lease targets reach the relay only as a keyed hash of the repository path.
export function leaseTarget(epochKeyHex: string, relPath: string): string {
  return '0x' + crypto.createHmac('sha256', Buffer.from(epochKeyHex, 'hex')).update(`lease:${relPath}`).digest('hex');
}
