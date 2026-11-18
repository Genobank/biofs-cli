/**
 * Pair crypt4gh with BioNFT rights on the CLI side.
 *
 * The X25519 reader secret is not consent and is not derived from an
 * Ethereum wallet (secp256k1) or from the login signature. Encrypt against
 * a biosample serial must first pass BioNFTClient.checkAccess. The node
 * mints the per-serial X25519 pair, returns only the public key, and
 * releases the secret only while the envelope is active and BioNFT consent
 * still holds.
 */
import { BioNFTClient } from '../api/bionft-client';
import { CredentialsManager } from '../auth/credentials';
import { generateKeyPair, encrypt, decrypt } from './index';

export class Crypt4ghBindError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'Crypt4ghBindError';
    this.code = code;
  }
}

export interface BioNftSession {
  wallet: string;
  signature: string;
  hasAccess: boolean;
  operations: string[];
}

export async function requireBioNftAccess(serial: string): Promise<BioNftSession> {
  const ser = String(serial || '').trim();
  if (!ser) throw new Crypt4ghBindError('BAD_REQUEST', 'biosample serial required');
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) throw new Crypt4ghBindError('UNAUTHENTICATED', 'Not authenticated. Run: biofs login');
  const bionft = BioNFTClient.getInstance();
  const access = await bionft.checkAccess(ser, creds.wallet_address);
  if (!access.hasAccess) {
    throw new Crypt4ghBindError(
      'DENIED',
      `No active BioNFT consent for serial ${ser} and wallet ${creds.wallet_address}`,
    );
  }
  return {
    wallet: creds.wallet_address,
    signature: creds.user_signature,
    hasAccess: true,
    operations: access.operations || [],
  };
}

export function encryptToRecipientKeys(
  plaintext: Buffer,
  recipientPublicKeys: Buffer[],
): Buffer {
  if (!recipientPublicKeys.length) {
    throw new Crypt4ghBindError('BAD_REQUEST', 'at least one crypt4gh recipient public key is required');
  }
  return encrypt(plaintext, recipientPublicKeys);
}

/** Local-only helper for tests. Production encrypt asks the node for the PK. */
export function encryptBoundToObjectKey(
  plaintext: Buffer,
  extraRecipientPublicKeys: Buffer[] = [],
): { ciphertext: Buffer; publicKey: Buffer; secretKey: Buffer } {
  const objectKey = generateKeyPair();
  const recipients = [objectKey.publicKey, ...extraRecipientPublicKeys];
  const ciphertext = encrypt(plaintext, recipients);
  return { ciphertext, publicKey: objectKey.publicKey, secretKey: objectKey.secretKey };
}

export function decryptWithReleasedKey(ciphertext: Buffer, secretKey: Buffer): Buffer {
  return decrypt(ciphertext, secretKey);
}

export function nodeBaseUrl(): string {
  return (process.env.BIOFS_NODE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
}

function nodeHeaders(wallet: string, signature: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-biofs-signature': signature,
    'x-biofs-wallet': wallet,
  };
}

async function nodeJson(
  path: string,
  opts: { method: string; wallet: string; signature: string; body?: unknown },
): Promise<Record<string, any>> {
  const res = await fetch(`${nodeBaseUrl()}${path}`, {
    method: opts.method,
    headers: nodeHeaders(opts.wallet, opts.signature),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    const code = String(body.code || 'NODE');
    throw new Crypt4ghBindError(code, String(body.error || `${path} HTTP ${res.status}`));
  }
  return body;
}

export async function ensureEnvelopeOnNode(opts: {
  serial: string;
  wallet: string;
  signature: string;
  biocid?: string;
}): Promise<{ serial: string; public_key_hex: string; status: string; owner_wallet: string; created?: boolean }> {
  const body = await nodeJson('/agent/crypt4gh/register', {
    method: 'POST',
    wallet: opts.wallet,
    signature: opts.signature,
    body: { serial: opts.serial, biocid: opts.biocid || null },
  });
  if (!body.public_key_hex) {
    throw new Crypt4ghBindError('NODE', 'node did not return a crypt4gh public key');
  }
  if (body.secret_key_hex) {
    throw new Crypt4ghBindError('NODE', 'node leaked a crypt4gh secret on register; refusing');
  }
  return {
    serial: String(body.serial || opts.serial),
    public_key_hex: String(body.public_key_hex),
    status: String(body.status || 'active'),
    owner_wallet: String(body.owner_wallet || ''),
    created: Boolean(body.created),
  };
}

/** @deprecated use ensureEnvelopeOnNode; the node mints the pair */
export const registerEnvelopeOnNode = ensureEnvelopeOnNode;

export async function releaseKeyFromNode(opts: {
  serial: string;
  wallet: string;
  signature: string;
}): Promise<{ secret_key_hex: string; public_key_hex: string }> {
  const body = await nodeJson('/agent/crypt4gh/release-key', {
    method: 'POST',
    wallet: opts.wallet,
    signature: opts.signature,
    body: { serial: opts.serial },
  });
  if (!body.secret_key_hex) throw new Crypt4ghBindError('NODE', 'node did not return a reader secret');
  return {
    secret_key_hex: String(body.secret_key_hex),
    public_key_hex: String(body.public_key_hex || ''),
  };
}

export async function revokeEnvelopeOnNode(opts: {
  serial: string;
  wallet: string;
  signature: string;
}): Promise<{ serial: string; status: string }> {
  const body = await nodeJson('/agent/crypt4gh/revoke', {
    method: 'POST',
    wallet: opts.wallet,
    signature: opts.signature,
    body: { serial: opts.serial },
  });
  return {
    serial: String(body.serial || opts.serial),
    status: String(body.status || 'revoked'),
  };
}
