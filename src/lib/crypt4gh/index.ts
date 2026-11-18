/**
 * GA4GH crypt4gh file encryption standard, version 1.
 *
 * Spec: https://samtools.github.io/hts-specs/crypt4gh.pdf (21 Oct 2019)
 * Interop target: EGA crypt4gh 1.8.x (libsodium crypto_kx + ChaCha20-IETF-Poly1305).
 *
 * This is an optional envelope. BioNFT checkAccess plus the node-held
 * per-serial X25519 secret gate who may decrypt. crypt4gh itself has no
 * consent or revoke.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

export const MAGIC = Buffer.from('crypt4gh', 'ascii');
export const VERSION = 1;
export const PLAIN_SEGMENT = 65536;
export const CIPHER_OVERHEAD = 28; // 12-byte nonce + 16-byte Poly1305 tag
export const CIPHER_SEGMENT = PLAIN_SEGMENT + CIPHER_OVERHEAD;
export const METHOD_X25519_CHACHA20 = 0;
export const PACKET_DATA_ENC = 0;
export const PACKET_EDIT_LIST = 1;
export const KEY_MAGIC = Buffer.from('c4gh-v1', 'ascii');

export interface Crypt4ghKeyPair {
  secretKey: Buffer; // 32-byte X25519 scalar
  publicKey: Buffer; // 32-byte X25519 u-coordinate
}

export interface Crypt4ghInspect {
  magic: string;
  version: number;
  headerPackets: number;
  headerBytes: number;
  dataPackets: number;
  hasEditList: boolean;
  plaintextBytes?: number;
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function u16be(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n >>> 0, 0);
  return b;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function generateKeyPair(): Crypt4ghKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  return {
    publicKey: fromB64url(pubJwk.x),
    secretKey: fromB64url(privJwk.d),
  };
}

function pkcs8FromRawX25519(secretKey: Buffer): Buffer {
  return Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), secretKey]);
}

export function publicFromSecret(secretKey: Buffer): Buffer {
  if (secretKey.length !== 32) throw new Error('X25519 secret key must be 32 bytes');
  const sk = crypto.createPrivateKey({ key: pkcs8FromRawX25519(secretKey), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(sk);
  const jwk = pub.export({ format: 'jwk' }) as { x: string };
  return fromB64url(jwk.x);
}

function asPrivate(secretKey: Buffer) {
  if (secretKey.length !== 32) throw new Error('X25519 secret key must be 32 bytes');
  return crypto.createPrivateKey({ key: pkcs8FromRawX25519(secretKey), format: 'der', type: 'pkcs8' });
}

function asPublic(publicKey: Buffer) {
  if (publicKey.length !== 32) throw new Error('X25519 public key must be 32 bytes');
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: b64url(publicKey) },
    format: 'jwk',
  });
}

/**
 * Spec §3.3.1 / libsodium crypto_kx:
 * Kdh = X25519(sk, peerPk)
 * Kshared = Blake2b-512(Kdh || readerPk || writerPk)[0:32]
 */
export function sharedKey(opts: {
  secretKey: Buffer;
  publicKey: Buffer;
  peerPublicKey: Buffer;
  role: 'writer' | 'reader';
}): Buffer {
  const dh = crypto.diffieHellman({
    privateKey: asPrivate(opts.secretKey),
    publicKey: asPublic(opts.peerPublicKey),
  });
  const readerPk = opts.role === 'writer' ? opts.peerPublicKey : opts.publicKey;
  const writerPk = opts.role === 'writer' ? opts.publicKey : opts.peerPublicKey;
  const h = crypto.createHash('blake2b512');
  h.update(dh);
  h.update(readerPk);
  h.update(writerPk);
  return h.digest().subarray(0, 32);
}

function aeadEncrypt(key: Buffer, nonce: Buffer, plaintext: Buffer): Buffer {
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.alloc(0), { plaintextLength: plaintext.length });
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}

function aeadDecrypt(key: Buffer, nonce: Buffer, ciphertextAndTag: Buffer): Buffer {
  if (ciphertextAndTag.length < 16) throw new Error('crypt4gh AEAD ciphertext too short');
  const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
  const ct = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  d.setAAD(Buffer.alloc(0), { plaintextLength: ct.length });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export function isCrypt4gh(buf: Buffer): boolean {
  return buf.length >= 16 && buf.subarray(0, 8).equals(MAGIC) && buf.readUInt32LE(8) === VERSION;
}

function encodeC4ghString(s: Buffer | null): Buffer {
  const body = s ?? Buffer.from('none');
  return Buffer.concat([u16be(body.length), body]);
}

export function serializePublicKeyPem(publicKey: Buffer): string {
  return (
    '-----BEGIN CRYPT4GH PUBLIC KEY-----\n' +
    publicKey.toString('base64') +
    '\n-----END CRYPT4GH PUBLIC KEY-----\n'
  );
}

export function serializePrivateKeyPem(secretKey: Buffer): string {
  const inner = Buffer.concat([
    KEY_MAGIC,
    encodeC4ghString(null),
    encodeC4ghString(null),
    encodeC4ghString(secretKey),
  ]);
  return (
    '-----BEGIN CRYPT4GH PRIVATE KEY-----\n' +
    inner.toString('base64') +
    '\n-----END CRYPT4GH PRIVATE KEY-----\n'
  );
}

function pemBody(text: string): Buffer {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3 || !lines[0].startsWith('-----BEGIN ') || !lines[lines.length - 1].startsWith('-----END ')) {
    throw new Error('Not a PEM key');
  }
  return Buffer.from(lines.slice(1, -1).join(''), 'base64');
}

export function loadPublicKey(source: string | Buffer): Buffer {
  if (Buffer.isBuffer(source) && source.length === 32) return Buffer.from(source);
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : fs.readFileSync(source, 'utf8');
  const trimmed = text.trim();
  if (trimmed.includes('BEGIN CRYPT4GH PUBLIC KEY')) {
    const raw = pemBody(trimmed);
    if (raw.length !== 32) throw new Error('CRYPT4GH public key must decode to 32 bytes');
    return raw;
  }
  const hex = trimmed.replace(/\s+/g, '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  const buf = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  if (buf.length === 32) return buf;
  throw new Error('Unsupported crypt4gh public key format');
}

function parseUnencryptedC4ghPrivate(inner: Buffer): Buffer {
  if (!inner.subarray(0, KEY_MAGIC.length).equals(KEY_MAGIC)) {
    throw new Error('Not a c4gh-v1 private key');
  }
  let off = KEY_MAGIC.length;
  const readStr = (): Buffer => {
    const len = inner.readUInt16BE(off);
    off += 2;
    const s = inner.subarray(off, off + len);
    off += len;
    return s;
  };
  const kdf = readStr();
  if (kdf.toString() !== 'none') {
    throw new Error('Passphrase-protected crypt4gh private keys are not opened here; export an unencrypted key');
  }
  const cipher = readStr();
  if (cipher.toString() !== 'none') {
    throw new Error('Encrypted crypt4gh private key is not supported in this loader');
  }
  const material = readStr();
  if (material.length !== 32) throw new Error('crypt4gh private key material must be 32 bytes');
  return material;
}

export function loadPrivateKey(source: string | Buffer): Buffer {
  if (Buffer.isBuffer(source) && source.length === 32) return Buffer.from(source);
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : fs.readFileSync(source, 'utf8');
  const trimmed = text.trim();
  if (trimmed.includes('BEGIN CRYPT4GH PRIVATE KEY')) {
    return parseUnencryptedC4ghPrivate(pemBody(trimmed));
  }
  const hex = trimmed.replace(/\s+/g, '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  const buf = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  if (buf.length === 32) return buf;
  throw new Error('Unsupported crypt4gh private key format');
}

function encryptHeaderPacket(plaintext: Buffer, recipientPk: Buffer, writer?: Crypt4ghKeyPair): Buffer {
  const w = writer ?? generateKeyPair();
  const kshared = sharedKey({
    secretKey: w.secretKey,
    publicKey: w.publicKey,
    peerPublicKey: recipientPk,
    role: 'writer',
  });
  const nonce = crypto.randomBytes(12);
  const sealed = aeadEncrypt(kshared, nonce, plaintext);
  const inner = Buffer.concat([u32le(METHOD_X25519_CHACHA20), w.publicKey, nonce, sealed]);
  return Buffer.concat([u32le(inner.length + 4), inner]);
}

function tryDecryptHeaderPacket(packet: Buffer, readerSk: Buffer): Buffer | null {
  if (packet.length < 4 + 4 + 32 + 12 + 16) return null;
  const method = packet.readUInt32LE(4);
  if (method !== METHOD_X25519_CHACHA20) return null;
  const writerPk = packet.subarray(8, 40);
  const nonce = packet.subarray(40, 52);
  const sealed = packet.subarray(52);
  const readerPk = publicFromSecret(readerSk);
  const kshared = sharedKey({
    secretKey: readerSk,
    publicKey: readerPk,
    peerPublicKey: writerPk,
    role: 'reader',
  });
  try {
    return aeadDecrypt(kshared, nonce, sealed);
  } catch {
    return null;
  }
}

export function encrypt(plaintext: Buffer, recipientPublicKeys: Buffer[], writer?: Crypt4ghKeyPair): Buffer {
  if (!recipientPublicKeys.length) throw new Error('crypt4gh encrypt needs at least one recipient public key');
  const kdata = crypto.randomBytes(32);
  const payload = Buffer.concat([u32le(PACKET_DATA_ENC), u32le(METHOD_X25519_CHACHA20), kdata]);
  const packets = recipientPublicKeys.map((pk) => encryptHeaderPacket(payload, pk, writer));
  const header = Buffer.concat([MAGIC, u32le(VERSION), u32le(packets.length), ...packets]);
  const chunks: Buffer[] = [header];
  for (let off = 0; off < plaintext.length; off += PLAIN_SEGMENT) {
    const slice = plaintext.subarray(off, Math.min(off + PLAIN_SEGMENT, plaintext.length));
    const nonce = crypto.randomBytes(12);
    chunks.push(nonce, aeadEncrypt(kdata, nonce, slice));
  }
  return Buffer.concat(chunks);
}

export function decrypt(ciphertext: Buffer, readerSecretKey: Buffer): Buffer {
  if (!isCrypt4gh(ciphertext)) throw new Error('Not a crypt4gh v1 file');
  const packetCount = ciphertext.readUInt32LE(12);
  let off = 16;
  const dataKeys: Buffer[] = [];
  let editLists = 0;
  for (let i = 0; i < packetCount; i++) {
    if (off + 4 > ciphertext.length) throw new Error('Truncated crypt4gh header');
    const plen = ciphertext.readUInt32LE(off);
    if (plen < 4 || off + plen > ciphertext.length) throw new Error('Invalid crypt4gh packet length');
    const packet = ciphertext.subarray(off, off + plen);
    off += plen;
    const plain = tryDecryptHeaderPacket(packet, readerSecretKey);
    if (!plain || plain.length < 4) continue;
    const ptype = plain.readUInt32LE(0);
    if (ptype === PACKET_DATA_ENC) {
      if (plain.length < 40) continue;
      if (plain.readUInt32LE(4) !== METHOD_X25519_CHACHA20) {
        throw new Error('Unsupported crypt4gh data encryption method');
      }
      dataKeys.push(plain.subarray(8, 40));
    } else if (ptype === PACKET_EDIT_LIST) {
      editLists += 1;
    }
  }
  if (editLists > 1) throw new Error('Invalid crypt4gh file: more than one edit list');
  if (!dataKeys.length) throw new Error('No crypt4gh header packet decrypted for this reader key');
  const out: Buffer[] = [];
  while (off < ciphertext.length) {
    if (off + CIPHER_OVERHEAD > ciphertext.length) throw new Error('Truncated crypt4gh data segment');
    const nonce = ciphertext.subarray(off, off + 12);
    const remaining = ciphertext.length - (off + 12 + 16);
    const ctLen = Math.min(PLAIN_SEGMENT, remaining);
    const sealed = ciphertext.subarray(off + 12, off + 12 + ctLen + 16);
    off += 12 + ctLen + 16;
    let ok: Buffer | null = null;
    let lastErr: Error | null = null;
    for (const k of dataKeys) {
      try {
        ok = aeadDecrypt(k, nonce, sealed);
        break;
      } catch (e) {
        lastErr = e as Error;
      }
    }
    if (!ok) throw lastErr || new Error('crypt4gh data segment MAC failed');
    out.push(ok);
  }
  return Buffer.concat(out);
}

export function inspect(ciphertext: Buffer): Crypt4ghInspect {
  if (!isCrypt4gh(ciphertext)) throw new Error('Not a crypt4gh v1 file');
  const packetCount = ciphertext.readUInt32LE(12);
  let off = 16;
  for (let i = 0; i < packetCount; i++) {
    const plen = ciphertext.readUInt32LE(off);
    off += plen;
  }
  const headerBytes = off;
  const dataBytes = ciphertext.length - headerBytes;
  const fullSegments = Math.floor(dataBytes / CIPHER_SEGMENT);
  const rem = dataBytes % CIPHER_SEGMENT;
  let plaintextBytes: number | undefined;
  if (rem === 0) plaintextBytes = fullSegments * PLAIN_SEGMENT;
  else if (rem >= CIPHER_OVERHEAD) plaintextBytes = fullSegments * PLAIN_SEGMENT + (rem - CIPHER_OVERHEAD);
  return {
    magic: 'crypt4gh',
    version: VERSION,
    headerPackets: packetCount,
    headerBytes,
    dataPackets: packetCount,
    hasEditList: false,
    plaintextBytes,
  };
}

export function unwrapIfCrypt4gh(buf: Buffer, readerSecretKey?: Buffer): Buffer {
  if (!isCrypt4gh(buf)) return buf;
  if (!readerSecretKey) throw new Error('Object is crypt4gh; pass a reader secret key');
  return decrypt(buf, readerSecretKey);
}
