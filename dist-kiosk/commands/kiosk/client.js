"use strict";
/**
 * Signed HTTP client for the Kiosk relay. Every request carries x-kiosk-key, x-kiosk-ts, x-kiosk-nonce
 * and x-kiosk-sig, an EIP-191 signature over (method, path, body hash, timestamp, nonce). The signed
 * path always starts at /agent/kiosk/, so a reverse-proxy prefix in the base URL (for example
 * https://genobank.app/api_kiosk) never changes what is signed. publicPost() is the one unsigned
 * call, for the invitation page endpoints that a browser also uses.
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
exports.RelayClient = exports.NetworkError = exports.RelayError = void 0;
exports.publicPost = publicPost;
const crypto = __importStar(require("crypto"));
const canon_1 = require("./canon");
class RelayError extends Error {
    constructor(status, reason, message, data) {
        super(message);
        this.status = status;
        this.reason = reason;
        this.data = data;
    }
}
exports.RelayError = RelayError;
class NetworkError extends Error {
    constructor(message) { super(message); }
}
exports.NetworkError = NetworkError;
function query(params) {
    if (!params)
        return '';
    const entries = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]);
    return entries.length ? '?' + new URLSearchParams(entries).toString() : '';
}
/** Unsigned POST to the relay's public invitation endpoints (invite_info, pair/link). */
async function publicPost(base, endpoint, body, timeoutMs = 15000) {
    const url = base.replace(/\/+$/, '') + `/agent/kiosk/${endpoint}`;
    let res;
    try {
        res = await fetch(url, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
            signal: AbortSignal.timeout(timeoutMs),
        });
    }
    catch (e) {
        throw new NetworkError(`relay unreachable at ${base}: ${e.message}`);
    }
    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    }
    catch {
        data = { error: text };
    }
    if (!res.ok)
        throw new RelayError(res.status, String(data.reason || res.status), `${data.reason || res.status}: ${data.error || ''}`, data);
    return data;
}
class RelayClient {
    constructor(base, signer, timeoutMs = 20000) {
        this.base = base;
        this.signer = signer;
        this.timeoutMs = timeoutMs;
    }
    async headers(method, signedPath, bodyStr) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const sig = await this.signer.signMessage((0, canon_1.requestMessage)(method, signedPath, bodyStr, ts, nonce));
        return {
            'content-type': 'application/json',
            'x-kiosk-key': this.signer.address.toLowerCase(),
            'x-kiosk-ts': String(ts),
            'x-kiosk-nonce': nonce,
            'x-kiosk-sig': sig,
        };
    }
    async call(method, endpoint, params, body) {
        const signedPath = `/agent/kiosk/${endpoint}${query(params)}`;
        const bodyStr = method === 'POST' ? JSON.stringify(body ?? {}) : '';
        const url = this.base.replace(/\/+$/, '') + signedPath;
        let res;
        try {
            res = await fetch(url, {
                method,
                headers: await this.headers(method, signedPath, bodyStr),
                body: method === 'POST' ? bodyStr : undefined,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        }
        catch (e) {
            throw new NetworkError(`relay unreachable at ${this.base}: ${e.message}`);
        }
        const text = await res.text();
        let data;
        try {
            data = JSON.parse(text);
        }
        catch {
            data = { error: text };
        }
        if (!res.ok)
            throw new RelayError(res.status, String(data.reason || res.status), `${data.reason || res.status}: ${data.error || ''}`, data);
        return data;
    }
    /** Server-sent events: calls onRecord for every {event, receipt, body} until aborted or revoked. */
    async stream(kioskId, sinceSeq, onRecord, signal) {
        const signedPath = `/agent/kiosk/stream${query({ kiosk_id: kioskId, since_seq: sinceSeq })}`;
        const url = this.base.replace(/\/+$/, '') + signedPath;
        let res;
        try {
            res = await fetch(url, { method: 'GET', headers: await this.headers('GET', signedPath, ''), signal });
        }
        catch (e) {
            throw new NetworkError(`relay unreachable at ${this.base}: ${e.message}`);
        }
        if (!res.ok || !res.body) {
            const t = await res.text();
            let d = {};
            try {
                d = JSON.parse(t);
            }
            catch { /* not json */ }
            throw new RelayError(res.status, String(d.reason || res.status), `${d.reason || res.status}: ${d.error || ''}`, d);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                return 'closed';
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
                const chunk = buf.slice(0, i);
                buf = buf.slice(i + 2);
                if (chunk.startsWith('event: revoked'))
                    return 'revoked';
                const line = chunk.split('\n').find((l) => l.startsWith('data: '));
                if (line)
                    onRecord(JSON.parse(line.slice(6)));
            }
        }
    }
}
exports.RelayClient = RelayClient;
