/**
 * Waiting for an invitation the way Claude Code waits for a login. `kiosk join` with no argument
 * listens on 127.0.0.1:47115 and holds a pairing code from the relay at the same time:
 *   on the same Mac, Accept on the invitation page (opened from the email's QR code or link) is a
 *   top-level redirect to /kiosk/callback here, as an OAuth redirect is;
 *   anywhere else, the person types the pairing code on the page, and the relay hands the
 *   invitation to this terminal, to the key that asked for the code and to no one else.
 * Whichever arrives first wins. Only an invitation on the relay this terminal uses is accepted, and
 * joining still needs Touch ID on this Mac and the owner's own approval, which both show who it is.
 */

import { spawnSync } from 'child_process';
import * as http from 'http';
import { ethers } from 'ethers';
import { NetworkError, RelayClient, RelayError } from './client';

export const CALLBACK_PORT = Number(process.env.KIOSK_CALLBACK_PORT || 47115);

export interface PairingShown { pairCode: string; expiresAt: number; listening: boolean }
export interface Invitation { code: string; kioskId?: string; via: 'browser' | 'pairing' }

const trimSlash = (u: string): string => u.replace(/\/+$/, '').toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function returnPage(ok: boolean, message: string): string {
  const esc = message.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Kiosk</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#ffffff;'
    + 'color:#000000;max-width:560px;margin:40px auto;padding:0 16px"><h1 style="font-size:22px">Kiosk</h1>'
    + `<p style="color:${ok ? '#0a5c2a' : '#a3120a'};font-weight:600;font-size:18px">${esc}</p></body></html>`;
}

// Bring the terminal that runs `kiosk join` back to the front after the browser hands over.
function raiseTerminal(): void {
  const app = ({ Apple_Terminal: 'Terminal', 'iTerm.app': 'iTerm', WarpTerminal: 'Warp', ghostty: 'Ghostty' } as Record<string, string>)[process.env.TERM_PROGRAM || ''];
  if (process.platform === 'darwin' && app && !process.env.KIOSK_NO_RAISE) spawnSync('open', ['-a', app], { timeout: 5000 });
}

export async function waitForInvitation(
  relay: string,
  signer: ethers.Wallet,
  o: { label: string; timeoutSec: number; onPairing: (p: PairingShown) => void },
): Promise<Invitation> {
  let fromBrowser: Invitation | null = null;
  let wake: () => void = () => {};
  const arrived = new Promise<void>((r) => { wake = r; });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', `http://127.0.0.1:${CALLBACK_PORT}`);
    const host = String(req.headers.host || '');
    // A page may only reach this listener under its loopback name (no DNS rebinding).
    if (host !== `127.0.0.1:${CALLBACK_PORT}` && host !== `localhost:${CALLBACK_PORT}`) { res.writeHead(421); res.end(); return; }
    if (u.pathname === '/kiosk/callback' && req.method === 'GET') {
      const send = (code: number, ok: boolean, msg: string) => {
        res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end(returnPage(ok, msg));
      };
      const rel = String(u.searchParams.get('relay') || '');
      if (trimSlash(rel) !== trimSlash(relay)) { send(400, false, 'This invitation belongs to a different relay than the one your terminal uses.'); return; }
      const code = String(u.searchParams.get('code') || '').trim().toUpperCase();
      if (!/^[A-Z2-9]{4}(-[A-Z2-9]{1,4})+$/.test(code)) { send(400, false, 'This link is missing its invitation code.'); return; }
      if (fromBrowser) { send(200, true, 'Your terminal already has this invitation. Return to it.'); return; }
      fromBrowser = { code, via: 'browser' };
      send(200, true, 'Done. Return to your terminal; it asks for Touch ID next.');
      wake();
      raiseTerminal();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(CALLBACK_PORT, '127.0.0.1', () => resolve(true));
  });

  const client = new RelayClient(relay, signer);
  const deadline = Date.now() + o.timeoutSec * 1000;
  try {
    for (;;) {
      const s = await client.call('POST', 'pair/start', undefined, { label: o.label });
      o.onPairing({ pairCode: s.pair_code, expiresAt: s.expires_at, listening });
      for (;;) {
        if (fromBrowser) return fromBrowser;
        if (Date.now() > deadline) throw new Error('No invitation arrived in time. Run kiosk join again when the invitation is open.');
        await Promise.race([sleep(2000), arrived]);
        if (fromBrowser) return fromBrowser;
        let p: any;
        try {
          p = await client.call('GET', 'pair/poll', { session_id: s.session_id });
        } catch (e) {
          if (e instanceof RelayError && (e.reason === 'session_expired' || e.reason === 'unknown_session')) break; // new code
          if (e instanceof NetworkError) continue;
          throw e;
        }
        if (p.status === 'linked') return { code: p.code, kioskId: p.kiosk_id, via: 'pairing' };
      }
    }
  } finally {
    server.close();
    (server as any).closeAllConnections?.();
  }
}
