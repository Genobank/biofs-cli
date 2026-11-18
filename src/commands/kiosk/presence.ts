/**
 * User presence for privileged acts (create, invite, approve, revoke, rotate, leave, delete, seat
 * and device enrollment, final decisions). On a Mac it asks for Touch ID or the account password
 * through LocalAuthentication; elsewhere it asks the person to type CONFIRM in their own terminal.
 * It refuses outright inside a Claude Code shell (CLAUDECODE=1), so a seat cannot approve its own act.
 * In Stage 1, with a Keychain wallet on the same macOS user, presence is a deliberate step for the
 * person, not a cryptographic barrier against that user's own processes; Stage 2 wallets close that.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { kioskHome } from './home';

const SWIFT = `import Foundation
import LocalAuthentication
let reason = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "approve a Kiosk action"
let ctx = LAContext()
var err: NSError?
guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { exit(2) }
let sem = DispatchSemaphore(value: 0)
var ok = false
ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in ok = success; sem.signal() }
sem.wait()
exit(ok ? 0 : 1)
`;

function helperPath(): string | null {
  if (process.platform !== 'darwin') return null;
  // A helper shipped with the package (universal binary) avoids needing the Xcode tools on a new Mac.
  for (const p of [process.env.KIOSK_PRESENCE_HELPER, path.resolve(__dirname, '..', '..', '..', 'vendor', 'kiosk-presence')]) {
    if (p && fs.existsSync(p)) return p;
  }
  const bin = path.join(kioskHome(), 'bin', 'kiosk-presence');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(path.dirname(bin), { recursive: true, mode: 0o700 });
  const src = `${bin}.swift`;
  fs.writeFileSync(src, SWIFT, { mode: 0o600 });
  const r = spawnSync('swiftc', ['-O', '-o', bin, src], { encoding: 'utf8', timeout: 120_000 });
  return r.status === 0 && fs.existsSync(bin) ? bin : null;
}

async function typed(reason: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer: string = await new Promise((r) => rl.question(`Type CONFIRM to ${reason}: `, r));
  rl.close();
  return answer.trim() === 'CONFIRM';
}

export type PresenceKind = 'touchid' | 'typed' | 'test';

export async function requirePresence(reason: string): Promise<PresenceKind> {
  if (process.env.KIOSK_TEST_PRESENCE === 'auto' && process.env.KIOSK_KEYSTORE === 'file') return 'test';
  if (process.env.CLAUDECODE === '1') {
    throw new Error(`Refused: "${reason}" needs the person's own presence, and this is running inside a Claude Code session. Run it in your own terminal.`);
  }
  const helper = helperPath();
  if (helper) {
    const r = spawnSync(helper, [`Kiosk: ${reason}`], { stdio: 'inherit' });
    if (r.status === 0) return 'touchid';
    if (r.status === 1) throw new Error('Presence was not confirmed.');
  }
  if (await typed(reason)) return 'typed';
  throw new Error(`Presence required to ${reason}. Run this in your own terminal.`);
}
