/**
 * Signed HTTP client for the Kiosk relay. Every request carries x-kiosk-key, x-kiosk-ts, x-kiosk-nonce
 * and x-kiosk-sig, an EIP-191 signature over (method, path, body hash, timestamp, nonce). The signed
 * path always starts at /agent/kiosk/, so a reverse-proxy prefix in the base URL (for example
 * https://genobank.app/api_kiosk) never changes what is signed. publicPost() is the one unsigned
 * call, for the invitation page endpoints that a browser also uses.
 */

import * as crypto from 'crypto';
import { ethers } from 'ethers';
import { requestMessage } from './canon';

export class RelayError extends Error {
  status: number;
  reason: string;
  data: Record<string, unknown>;
  constructor(status: number, reason: string, message: string, data: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.data = data;
  }
}

export class NetworkError extends Error {
  constructor(message: string) { super(message); }
}

type Params = Record<string, string | number | undefined>;

function query(params?: Params): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)] as [string, string]);
  return entries.length ? '?' + new URLSearchParams(entries).toString() : '';
}

/** Unsigned POST to the relay's public invitation endpoints (invite_info, pair/link). */
export async function publicPost<T = any>(base: string, endpoint: string, body: unknown, timeoutMs = 15_000): Promise<T> {
  const url = base.replace(/\/+$/, '') + `/agent/kiosk/${endpoint}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new NetworkError(`relay unreachable at ${base}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!res.ok) throw new RelayError(res.status, String(data.reason || res.status), `${data.reason || res.status}: ${data.error || ''}`, data);
  return data as T;
}

export class RelayClient {
  constructor(public base: string, private signer: ethers.Wallet, private timeoutMs = 20_000) {}

  private async headers(method: string, signedPath: string, bodyStr: string): Promise<Record<string, string>> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = await this.signer.signMessage(requestMessage(method, signedPath, bodyStr, ts, nonce));
    return {
      'content-type': 'application/json',
      'x-kiosk-key': this.signer.address.toLowerCase(),
      'x-kiosk-ts': String(ts),
      'x-kiosk-nonce': nonce,
      'x-kiosk-sig': sig,
    };
  }

  async call<T = any>(method: 'GET' | 'POST', endpoint: string, params?: Params, body?: unknown): Promise<T> {
    const signedPath = `/agent/kiosk/${endpoint}${query(params)}`;
    const bodyStr = method === 'POST' ? JSON.stringify(body ?? {}) : '';
    const url = this.base.replace(/\/+$/, '') + signedPath;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: await this.headers(method, signedPath, bodyStr),
        body: method === 'POST' ? bodyStr : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new NetworkError(`relay unreachable at ${this.base}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    if (!res.ok) throw new RelayError(res.status, String(data.reason || res.status), `${data.reason || res.status}: ${data.error || ''}`, data);
    return data as T;
  }

  /** Server-sent events: calls onRecord for every {event, receipt, body} until aborted or revoked. */
  async stream(kioskId: string, sinceSeq: number, onRecord: (rec: any) => void, signal?: AbortSignal): Promise<'revoked' | 'closed'> {
    const signedPath = `/agent/kiosk/stream${query({ kiosk_id: kioskId, since_seq: sinceSeq })}`;
    const url = this.base.replace(/\/+$/, '') + signedPath;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers: await this.headers('GET', signedPath, ''), signal });
    } catch (e) {
      throw new NetworkError(`relay unreachable at ${this.base}: ${(e as Error).message}`);
    }
    if (!res.ok || !res.body) {
      const t = await res.text();
      let d: any = {};
      try { d = JSON.parse(t); } catch { /* not json */ }
      throw new RelayError(res.status, String(d.reason || res.status), `${d.reason || res.status}: ${d.error || ''}`, d);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return 'closed';
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith('event: revoked')) return 'revoked';
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (line) onRecord(JSON.parse(line.slice(6)));
      }
    }
  }
}
