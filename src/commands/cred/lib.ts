/**
 * Shared helpers for the `biofs cred *` subcommand group.
 * Talks to the /api_biovault/* endpoints; keeps signing + HTTP setup in one place.
 */
import axios, { AxiosRequestConfig } from 'axios';
import { ethers } from 'ethers';

export const BIOVAULT_BASE = process.env.GENOBANK_API_BASE || 'https://genobank.app';
export const USER_AGENT = 'biofs/2.8.0';

/**
 * Canonical JSON serialization (sorted keys, no whitespace). MUST match
 * Python's json.dumps(sort_keys=True, separators=(',', ':')) byte-for-byte.
 */
export function canonicalStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

export function randomNonceHex(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  (globalThis as any).crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive a signer from BIOFS_LAB_PRIVATE_KEY (lab-signing flow) or
 * GENOBANK_OWNER_PRIVATE_KEY (owner-signing flow for burn).
 */
export function signerFromEnv(envVar: string): ethers.Wallet {
  const key = process.env[envVar];
  if (!key) {
    throw new Error(`Set ${envVar} to a secp256k1 hex private key (with or without 0x prefix).`);
  }
  const normalized = key.startsWith('0x') ? key : '0x' + key;
  return new ethers.Wallet(normalized);
}

/**
 * Sign a body object and attach lab_signature + lab_nonce + lab_timestamp
 * matching the server's CredentialService.verify_lab_signature expectations.
 */
export async function signLabBody(
  body: Record<string, any>,
  signer: ethers.Wallet,
): Promise<Record<string, any>> {
  const withMeta = {
    ...body,
    lab_nonce: randomNonceHex(16),
    lab_timestamp: Math.floor(Date.now() / 1000),
  };
  const canonical = canonicalStringify(withMeta);
  const signature = await signer.signMessage(canonical);
  return { ...withMeta, lab_signature: signature };
}

export function apiGet(path: string, params?: Record<string, any>): Promise<any> {
  return api({ method: 'GET', url: path, params });
}
export function apiPost(path: string, data?: any, params?: Record<string, any>): Promise<any> {
  return api({ method: 'POST', url: path, params, data });
}
export function apiDelete(path: string, data?: any, params?: Record<string, any>): Promise<any> {
  // Use POST for bodied requests — axios + CherryPy's json_in tool don't play
  // nicely with DELETE bodies. The /api_biovault/burn_credential endpoint
  // accepts both DELETE and POST (see api_biovault.py @allow(methods=...)).
  return api({ method: 'POST', url: path, params, data });
}

async function api(cfg: AxiosRequestConfig): Promise<any> {
  const full: AxiosRequestConfig = {
    baseURL: BIOVAULT_BASE,
    timeout: 30000,
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
    validateStatus: () => true,
    ...cfg,
  };
  const r = await axios.request(full);
  if (r.status >= 400) {
    const msg = (r.data && (r.data.error || r.data.message)) || `HTTP ${r.status}`;
    const err = new Error(`${r.status}: ${msg}`) as any;
    err.status = r.status;
    err.payload = r.data;
    throw err;
  }
  return r.data;
}
