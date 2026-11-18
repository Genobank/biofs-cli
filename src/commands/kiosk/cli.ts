/**
 * `kiosk` commands (Stage 1). registerKiosk() attaches them to a commander program, either the
 * standalone `kiosk` entry (main.ts) or, once Daniel decides to ship it, `biofs kiosk`.
 */

import * as readline from 'readline';
import { Command } from 'commander';
import chalk from 'chalk';
import { ethers } from 'ethers';
import { NetworkError, RelayClient, RelayError } from './client';
import { kioskHome, listRooms, loadConfig, loadRoom, macDenylist, outboxDir, requireRoom, roomDir, saveRoom, withRoomLock } from './home';
import { mailDraft, qrPng, qrTerminal } from './invitemail';
import { runHook } from './hooks';
import { serveMcp } from './mcp';
import { CHANNEL_ARGS, EntryPoint, openSeat } from './profile';
import * as room from './room';
import { gate } from './gate';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ok = (s: string) => console.log(chalk.green(s));
const dim = (s: string) => chalk.gray(s);

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

const invitationBody = (url: string, from: string): string =>
  `Scan the QR code, or open this link on your Mac:\n${url}\n\n${from}`;

function line(e: room.Decrypted): string {
  const who = `${e.label}${e.key_role === 'seat' ? ' seat' : ''}`;
  const body = e.erased ? dim('[erased by its author]') : e.undecryptable ? dim('[not readable with this device key]') : (e.text || dim(`(${e.kind}${e.meta && (e.meta as any).action ? ': ' + (e.meta as any).action : ''})`));
  return `${dim(`#${e.seq} ${e.ts_relay.slice(11, 19)}`)} ${chalk.bold(who)} ${dim(`${e.kind}, ${e.evidence}`)} ${body}`;
}

// ---- the live view of `kiosk chat`, drawn the way Claude Code draws a conversation ----------------
const termWidth = () => Math.max(40, Math.min(process.stdout.columns || 100, 110));

export function wrapText(text: string, indent = '  ', width = termWidth()): string {
  const max = Math.max(20, width - indent.length);
  const out: string[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (!raw.trim()) { out.push(''); continue; }
    const lead = raw.match(/^\s*/)![0];
    let cur = '';
    for (const w of raw.trim().split(/\s+/)) {
      if (cur && (lead.length + cur.length + 1 + w.length) > max) { out.push(lead + cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
    }
    out.push(lead + cur);
  }
  return out.map((l) => (l ? indent + l : '')).join('\n');
}

// Bold, inline code and headings, the 3 marks an answer uses most; everything else is left as typed.
export function markdownLite(text: string): string {
  return text
    .split('\n')
    .map((l) => (/^#{1,6}\s+/.test(l) ? chalk.bold(l.replace(/^#{1,6}\s+/, '')) : l))
    .join('\n')
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, t) => chalk.bold(t))
    .replace(/`([^`\n]+)`/g, (_m, t) => chalk.cyan(t));
}

export function renderLive(e: room.Decrypted): string | null {
  const m = (e.meta || {}) as Record<string, any>;
  if (e.kind === 'erase') return null;
  if (e.erased) return dim(`  ${e.label}: [erased by its author]`);
  if (e.undecryptable) return dim(`  ${e.label}: [not readable with this device key]`);
  if (e.kind === 'member') return dim(`  · ${e.label} ${m.action === 'join' ? `admitted ${m.label || ''}`.trim() : m.action || ''}`);
  if (e.kind === 'file_touch') return `  ${dim('⎿')}  Edited ${m.path || ''}`;
  if (e.kind === 'commit_ref') return `  ${dim('⎿')}  Committed ${String(m.hash || '').slice(0, 10)} ${m.subject || ''}`;
  const text = e.text || '';
  if (e.key_role === 'seat') {
    const who = `${chalk.bold('⏺')} ${chalk.bold('Claude')} ${dim(`· ${e.label}'s seat${m.model ? ` · ${m.model}` : ''}${e.kind === 'answer' ? '' : ` · ${e.kind}`}`)}`;
    if (e.kind === 'task_done') return `  ${dim('⎿')}  Done: ${text}`;
    return `\n${who}\n${wrapText(markdownLite(text))}`;
  }
  if (e.kind === 'prompt') return `\n${chalk.bold(`> ${e.label}`)} ${dim('to Claude')}\n${wrapText(text)}\n${dim('  ✻ Claude is working…')}`;
  if (e.kind === 'answer') return `\n${chalk.bold('⏺')} ${chalk.bold(e.label)}\n${wrapText(markdownLite(text))}`;
  return `\n${chalk.bold.cyan(`> ${e.label}`)}${e.kind === 'note' ? '' : dim(` · ${e.kind}`)}\n${wrapText(text)}`;
}

async function guard(fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (e) {
    if (e instanceof room.ForkError) console.error(chalk.red.bold(`FORK ALARM: ${e.message}. Evidence saved in the room folder (fork_evidence.json). Stop and compare head fingerprints with the other members.`));
    else if (e instanceof RelayError) console.error(chalk.red(`Relay refused: ${e.reason}${e.data && (e.data as any).relay_sig ? ' (signed by the relay)' : ''}. ${e.message}`));
    else if (e instanceof NetworkError) console.error(chalk.yellow(e.message));
    else console.error(chalk.red((e as Error).message));
    process.exitCode = 1;
  }
}

export function registerKiosk(program: Command, entry: EntryPoint): Command {
  program
    .command('init')
    .description('Create this Mac\'s Kiosk wallet (seedless, kept in the macOS Keychain) and set the relay')
    .option('--relay <url>', 'relay base URL')
    .option('--label <name>', 'your display name in rooms')
    .option('--wallet-key-file <path>', 'import an existing wallet key from a file instead of creating one')
    .action((o) => guard(async () => {
      const cfg = room.init({ relay: o.relay, label: o.label, walletKeyFile: o.walletKeyFile });
      ok(`wallet ${room.display(cfg.wallet)} (${cfg.keystore} key store), label ${cfg.label}, relay ${cfg.relay}`);
    }));

  program
    .command('create')
    .description('Create a Kiosk owned by this wallet')
    .requiredOption('--title <title>', 'name of the conversation')
    .option('--objective <text>', 'the common objective')
    .option('--repo <path>', 'team repository on this Mac')
    .action((o) => guard(async () => {
      const r = await room.create({ title: o.title, objective: o.objective, repo: o.repo });
      ok(`created ${r.id} (genesis receipt seq ${r.seq})`);
      console.log(r.id);
    }));

  program
    .command('invite <id>')
    .description('Invite one person: an invitation link, or its QR code in an Apple Mail draft you review and send')
    .option('--role <role>', 'participant or observer', 'participant')
    .option('--export', 'grant EXPORT (plaintext export of the log)')
    .option('--derive', 'grant DERIVE (mint derived artifacts)')
    .option('--hours <n>', 'hours the invitation stays valid', '24')
    .option('--grant-days <n>', 'days the membership lasts', '9')
    .option('--task-authority', 'let this member assign tasks to the owner\'s seat (only for a member who could hold a seat)')
    .option('--email <address>', 'open an Apple Mail draft to this address with the QR code; nothing is sent')
    .option('--from <address>', 'sender account for the draft')
    .option('--subject <text>', 'subject of the draft', 'Kiosk invitation')
    .option('--show-qr', 'draw the QR code in this terminal')
    .option('--qr-out <path>', 'save the QR code PNG here')
    .option('--wait', 'stay until the invitee claims, then admit her with Touch ID')
    .option('--json', 'print JSON')
    .action((id, o) => guard(async () => {
      const hours = Number(o.hours);
      const r = await room.invite(id, { role: o.role === 'observer' ? 'observer' : 'participant', exportOp: !!o.export, derive: !!o.derive, hours, grantDays: Number(o.grantDays), taskAuthority: !!o.taskAuthority });
      let qrFile: string | null = null;
      if (o.email || o.qrOut) {
        const tag = crypto.createHash('sha256').update(r.code).digest('hex').slice(0, 10);
        qrFile = o.qrOut ? path.resolve(o.qrOut) : path.join(roomDir(id), 'invites', tag, 'KioskInvitation.png');
        fs.mkdirSync(path.dirname(qrFile), { recursive: true, mode: 0o700 });
        qrPng(r.url, qrFile);
      }
      if (o.email) mailDraft({ to: o.email, from: o.from, subject: o.subject, body: invitationBody(r.url, room.context().cfg.label), attachment: qrFile as string });
      if (o.json) {
        console.log(JSON.stringify({ ...r, qr_file: qrFile, draft: !!o.email }));
      } else {
        ok(`invitation for one ${r.role}, valid until ${r.expires_at}`);
        if (o.email) ok(`Apple Mail draft to ${o.email} is open with the QR code. Review it and send it yourself.`);
        console.log(`\nInvitation link:\n\n  ${r.url}\n`);
        if (o.showQr) { const q = qrTerminal(r.url); if (q) console.log(q); }
        console.log(dim(`The invitee runs kiosk join on her Mac, then opens the link (or: kiosk join ${r.token}).`));
      }
      if (o.wait) {
        if (!o.json) console.log(dim('Waiting for the claim; keep this terminal open.'));
        const admitted = await room.approve(id, {
          waitSec: Math.round(hours * 3600),
          onClaims: (cs) => {
            for (const c of cs) {
              if (o.json) console.log(JSON.stringify({ claim: c.claim_id, label: c.label, verification: c.verification }));
              else console.log(`Claim from ${chalk.bold(c.label || 'a new member')} ${room.display(c.wallet)}, verification code ${chalk.bold(c.verification)}. Check that her screen shows the same code, then confirm with Touch ID.`);
            }
          },
        });
        for (const a of admitted) {
          if (o.json) console.log(JSON.stringify({ admitted: a.wallet, seq: a.seq }));
          else ok(`admitted ${a.label} (${room.display(a.wallet)}) at seq ${a.seq}`);
        }
        if (!admitted.length && !o.json) console.log(chalk.yellow('The invitation expired before anyone claimed it.'));
      }
    }));

  program
    .command('join [invitation]')
    .description('Join a Kiosk. With no argument it waits for the invitation page: press Accept on this Mac, or type the pairing code it shows on another device. Also takes the invitation link, code or token.')
    .option('--name <name>', 'your display name in the room')
    .option('--label <name>', 'same as --name')
    .option('--relay <url>', 'relay to use (default: this Mac\'s relay, else GenoBank.io production)')
    .option('--guardian <wallet>', 'guardian wallet for a member under 18')
    .option('--wait-sec <n>', 'seconds to wait for the owner to admit you', '1800')
    .option('--pair-minutes <n>', 'minutes to wait for the invitation page', '30')
    .option('--json', 'print JSON lines')
    .action((invitation, o) => guard(async () => {
      let label: string | undefined = o.name || o.label;
      if (!label && !loadConfig() && process.stdin.isTTY && !o.json) label = (await ask('Your name, as the others in the room will see it: ')) || undefined;
      const r = await room.join(invitation, {
        label, guardian: o.guardian, relay: o.relay, waitSec: Number(o.waitSec), pairTimeoutSec: Math.round(Number(o.pairMinutes) * 60),
        onPairing: (p) => {
          if (o.json) { console.log(JSON.stringify({ waiting: true, pair_code: p.pairCode, expires_at: p.expiresAt, listening: p.listening })); return; }
          console.log('\nOpen the invitation email and scan its QR code, or click its link.');
          if (p.listening) console.log('On this Mac, press Accept on the page and it returns here by itself.');
          console.log(`On a phone or another computer, type this pairing code on the page:  ${chalk.bold(p.pairCode)}`);
          console.log(dim('Waiting. A new pairing code appears every 10 minutes.'));
        },
        onInvitation: (i) => {
          if (o.json) console.log(JSON.stringify({ invitation: true, owner_label: i.ownerLabel, owner: i.owner, role: i.role, via: i.via }));
          else console.log(`\nInvitation from ${chalk.bold(i.ownerLabel || 'the owner')}${i.owner ? ` (${room.display(i.owner)})` : ''} to join as a ${i.role}. Confirm with Touch ID to join and accept the contributor terms.`);
        },
        onWaiting: (m, v) => {
          if (o.json) { console.log(JSON.stringify({ claimed: true, verification: v })); return; }
          console.log(dim(m));
          console.log(`Your verification code is ${chalk.bold(v)}. The owner sees the same code before admitting you.`);
        },
      });
      if (o.json) { console.log(JSON.stringify(r)); return; }
      if (r.status === 'pending') {
        console.log(chalk.yellow(`Still waiting for the owner. Later, run: kiosk sync ${r.id}`));
      } else {
        ok(`Joined ${r.id} as ${r.role}.`);
        console.log(`\nTalk in the room:  kiosk chat ${r.id}`);
        console.log(`Work in a project folder with a Claude Code seat:  kiosk open ${r.id} --repo <folder>`);
      }
    }));

  program
    .command('approve <id>')
    .description('Admit pending claims (Touch ID), signing each grant record with a fresh subject key')
    .option('--claim <claim_id>', 'approve only this claim')
    .option('--wait-sec <n>', 'seconds to wait for a claim to arrive', '0')
    .action((id, o) => guard(async () => {
      const r = await room.approve(id, { claimId: o.claim, waitSec: Number(o.waitSec) });
      if (!r.length) { console.log('no pending claims'); return; }
      for (const a of r) ok(`admitted ${a.label} (${room.display(a.wallet)}) at seq ${a.seq}`);
    }));

  program
    .command('claims <id>')
    .description('List pending claims (owner)')
    .action((id) => guard(async () => {
      for (const c of await room.pendingClaims(id)) console.log(`${c.claim_id} ${c.label} ${room.display(c.wallet)} ${c.role} verification ${c.verification} device ${c.device_key}`);
    }));

  program
    .command('post <id> <text...>')
    .description('Post to the Kiosk from this device (or as this Mac\'s seat)')
    .option('--kind <kind>', 'note, task, decision or task_done', 'note')
    .option('--as <who>', 'device or seat', 'device')
    .option('--refs <seqs>', 'comma-separated events this answers')
    .option('--json', 'print JSON')
    .action((id, words, o) => guard(async () => {
      const kind = String(o.kind);
      if (!['note', 'task', 'decision', 'task_done', 'prompt', 'answer'].includes(kind)) throw new Error('unknown kind');
      const refs = o.refs ? String(o.refs).split(',').map((x) => Number(x.trim())).filter((x) => x > 0) : [];
      const r = await room.post(id, { kind, evidence: o.as === 'seat' ? 'harness-attested' : 'key-signed', text: words.join(' '), refs, as: o.as === 'seat' ? 'seat' : 'device', meta: o.as === 'seat' ? { model: requireRoom(id).model || 'claude' } : undefined });
      if (o.json) { console.log(JSON.stringify(r)); return; }
      if (r.status === 'delivered') ok(`posted #${r.seq}`);
      else if (r.status === 'queued') console.log(chalk.yellow('relay unreachable; queued, will deliver once'));
      else console.log(chalk.red(`not posted: ${r.status} (${(r.reasons || []).join(', ')})`));
    }));

  program
    .command('decide <id> <text...>')
    .description('Record a final decision, signed by your wallet with Touch ID')
    .option('--refs <seqs>', 'comma-separated events this settles')
    .action((id, words, o) => guard(async () => {
      const { requirePresence } = await import('./presence');
      await requirePresence(`record a final decision in ${id}`);
      const refs = o.refs ? String(o.refs).split(',').map((x) => Number(x.trim())).filter((x) => x > 0) : [];
      const r = await room.post(id, { kind: 'decision', evidence: 'presence-signed', text: words.join(' '), refs, meta: { status: 'final' }, as: 'wallet' });
      if (r.status === 'delivered') ok(`decision #${r.seq} (presence-signed)`); else console.log(chalk.red(`not posted: ${r.status} ${(r.reasons || []).join(', ')}`));
    }));

  program
    .command('sync <id>')
    .description('Fetch, verify and cache new events')
    .option('--json', 'print JSON')
    .action((id, o) => guard(async () => {
      await room.flush(id);
      const r = await room.sync(id);
      if (o.json) { console.log(JSON.stringify({ new_events: r.events.length, head: requireRoom(id).head })); return; }
      for (const e of r.events) console.log(line(e));
      ok(`${r.events.length} new, verified; head ${requireRoom(id).head.receipt_hash.slice(0, 10)} at seq ${requireRoom(id).head.seq}`);
    }));

  program
    .command('log <id>')
    .description('Print the verified local log')
    .option('--since <seq>', 'start after this seq', '0')
    .option('--json', 'print JSON')
    .action((id, o) => guard(async () => {
      const rows = room.readLocal(id, Number(o.since));
      if (o.json) { console.log(JSON.stringify(rows)); return; }
      for (const e of rows) console.log(line(e));
    }));

  program
    .command('tail <id>')
    .description('Stream the room live in this terminal')
    .action((id) => guard(async () => {
      const c = room.context();
      const st = requireRoom(id);
      await room.sync(id);
      for (const e of room.readLocal(id, Math.max(0, st.cursor - 20))) console.log(line(e));
      const client = new RelayClient(st.relay, room.deviceSigner(c, id), 0);
      for (;;) {
        try {
          const how = await client.stream(id, requireRoom(id).cursor, () => {
            room.sync(id).then((r) => r.events.forEach((e) => console.log(line(e)))).catch((e) => console.error(chalk.red(e.message)));
          });
          if (how === 'revoked') { console.log(chalk.red('access revoked')); return; }
        } catch (e) {
          if (!(e instanceof NetworkError)) throw e;
          console.error(chalk.yellow('relay unreachable, retrying in 5 s'));
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }));

  program
    .command('chat <id>')
    .description('The live room in this terminal, drawn like Claude Code: read everyone and write to the room; for a member with no Claude seat')
    .action((id) => guard(async () => {
      const c = room.context();
      const st = requireRoom(id);
      await room.sync(id);
      const me = st.labels[st.my_wallet] || 'you';
      const tty = !!process.stdout.isTTY;
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: chalk.bold('> ') });
      // Print above the input line and redraw it, so an incoming message never scrambles what is being typed.
      const out = (s: string) => {
        if (tty) { readline.cursorTo(process.stdout, 0); readline.clearLine(process.stdout, 0); }
        process.stdout.write(s + '\n');
        if (tty) rl.prompt(true);
      };
      console.log(chalk.bold(`Kiosk ${st.title || id}`) + dim(` · live · you are ${me}`));
      console.log(dim('Write and press Enter: everyone in the room reads it, and a Claude seat whose human made you a co-driver answers you. /quit leaves.'));
      for (const e of room.readLocal(id, Math.max(0, st.cursor - 20))) { const r = renderLive(e); if (r !== null) console.log(r); }
      let shown = requireRoom(id).cursor;
      const client = new RelayClient(st.relay, room.deviceSigner(c, id), 0);
      const ac = new AbortController();
      let chain: Promise<unknown> = Promise.resolve();
      const pull = () => {
        chain = chain.then(async () => {
          await room.sync(id);
          for (const e of room.readLocal(id, shown)) {
            shown = Math.max(shown, e.seq);
            if (e.author_key === st.device_key) continue;
            const r = renderLive(e);
            if (r !== null) out(r);
          }
        }).catch(() => {});
      };
      (async () => {
        while (!ac.signal.aborted) {
          try {
            pull();
            const how = await client.stream(id, requireRoom(id).cursor, pull, ac.signal);
            if (how === 'revoked') { out(chalk.red('Your access to this Kiosk was revoked.')); rl.close(); return; }
          } catch (e) {
            if (ac.signal.aborted) return;
            if (e instanceof NetworkError) out(chalk.yellow('  relay unreachable, retrying in 5 s'));
          }
          await new Promise((r) => setTimeout(r, 5000));
        }
      })().catch(() => {});
      rl.prompt();
      rl.on('line', async (text) => {
        const t = text.trim();
        if (t === '/quit') { ac.abort(); rl.close(); return; }
        if (t) {
          if (tty) {
            const rows = Math.max(1, Math.ceil((2 + text.length) / (process.stdout.columns || 80)));
            readline.moveCursor(process.stdout, 0, -rows);
            readline.cursorTo(process.stdout, 0);
            readline.clearScreenDown(process.stdout);
          }
          process.stdout.write(`\n${chalk.bold.cyan(`> ${me}`)}\n${wrapText(t)}\n`);
          const r = await room.post(id, { kind: 'note', evidence: 'key-signed', text: t, as: 'device' });
          if (r.status === 'blocked') out(chalk.red(`  not shared: ${(r.reasons || []).join(', ')}`));
          else if (r.status === 'queued') out(chalk.yellow('  queued; it goes out when the relay is back'));
          else if (r.status === 'rejected') out(chalk.red(`  refused by the relay: ${(r.reasons || []).join(', ')}`));
        }
        rl.prompt();
      });
      await new Promise((r) => rl.on('close', r));
      ac.abort();
    }));

  program
    .command('codrive <id> [member]')
    .description('Let a member talk to your Claude Code seat directly while it is open (this Mac only); with no member, list the co-drivers')
    .option('--off', 'stop co-driving')
    .action((id, member, o) => guard(async () => {
      const st0 = requireRoom(id);
      const name = (w: string) => st0.labels[w] || room.display(w).slice(0, 10);
      if (!member) {
        const list = (st0.codrivers || []).map(name);
        console.log(list.length ? `Co-drivers of your seat: ${list.join(', ')}` : 'No co-drivers; members\' messages reach your seat as data for you to confirm.');
        return;
      }
      const i = await room.info(id);
      const active = [{ wallet: i.room.owner, guardian: null as string | null }, ...i.room.members.filter((m: any) => m.status === 1)];
      const want = String(member).toLowerCase();
      const hit = active.find((m) => m.wallet.toLowerCase() === want || (st0.labels[m.wallet] || '').toLowerCase() === want);
      if (!hit) throw new Error(`${member} is not an active member of this Kiosk. Members: ${active.map((m) => name(m.wallet)).join(', ')}.`);
      if (hit.wallet.toLowerCase() === st0.my_wallet.toLowerCase()) throw new Error('You already drive your own seat.');
      if (hit.guardian && hit.guardian.toLowerCase() !== st0.my_wallet.toLowerCase()) {
        throw new Error(`${name(hit.wallet)} joined under a guardian; only her guardian's seat can make her a co-driver.`);
      }
      await withRoomLock(id, async () => {
        const s = requireRoom(id);
        const set = new Set(s.codrivers || []);
        if (o.off) set.delete(hit.wallet); else set.add(hit.wallet);
        s.codrivers = [...set];
        saveRoom(s);
      });
      const me = name(st0.my_wallet);
      const note = o.off
        ? `${me} ended co-driving for ${name(hit.wallet)}: ${me}'s Claude now reads ${name(hit.wallet)}'s messages as notes for ${me}.`
        : `${me} made ${name(hit.wallet)} a co-driver of ${me}'s Claude Code seat: write here and Claude answers you directly while the seat is open.`;
      const r = await room.post(id, { kind: 'note', evidence: 'key-signed', text: note, as: 'device' });
      ok(o.off ? `${name(hit.wallet)} is no longer a co-driver.` : `${name(hit.wallet)} is a co-driver of your seat. Restart the seat (kiosk open) if it is running, so Claude learns it.`);
      if (r.status !== 'delivered') console.log(chalk.yellow(`The room was not told (${r.status}).`));
    }));

  program
    .command('status <id>')
    .description('Relay, head, epoch, role, outbox and gate engine')
    .option('--json', 'print JSON')
    .action((id, o) => guard(async () => {
      const st = requireRoom(id);
      let relay: any = null;
      try { relay = await room.info(id); } catch (e) { relay = { error: (e as Error).message }; }
      const queued = fs.readdirSync(outboxDir(id)).filter((f) => f.endsWith('.json')).length;
      const g = gate('status probe');
      const out = {
        kiosk_id: id, relay: st.relay, role: st.role, wallet: room.display(st.my_wallet), device_key: st.device_key, seat_key: st.seat_key || null,
        local_head: st.head, relay_head: relay?.room?.head || null, epoch: relay?.room?.epoch ?? st.epoch, outbox_queued: queued,
        gate_engine: g.engine, profile: `${kioskHome()}/rooms/${id}/claude`, error: relay?.error || null,
      };
      if (o.json) { console.log(JSON.stringify(out)); return; }
      for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(14)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }));

  program
    .command('list')
    .description('Kiosks this wallet owns or is a member of (from the relay), and those on this Mac')
    .option('--json', 'print JSON')
    .action((o) => guard(async () => {
      const cfg = loadConfig();
      const rows: any[] = [];
      const relays = new Set<string>(listRooms().map((r) => loadRoom(r)!.relay));
      if (cfg) relays.add(cfg.relay);
      if (cfg) {
        const c = room.context();
        for (const relay of relays) {
          try {
            const r = await new RelayClient(relay, room.walletSigner(c)).call('GET', 'list');
            for (const x of r.kiosks) rows.push({ ...x, relay, on_this_mac: !!loadRoom(x.kiosk_id) });
          } catch (e) { rows.push({ relay, error: (e as Error).message }); }
        }
      }
      if (o.json) { console.log(JSON.stringify(rows)); return; }
      for (const r of rows) console.log(r.error ? chalk.yellow(`${r.relay}: ${r.error}`) : `${r.kiosk_id} ${r.role}${r.active ? '' : ' (inactive)'} head ${r.head_seq}${r.on_this_mac ? '' : dim(' not on this Mac')}`);
    }));

  program
    .command('members <id>')
    .description('Members and their keys')
    .action((id) => guard(async () => {
      const i = await room.info(id);
      const st = requireRoom(id);
      const rows = [{ wallet: i.room.owner, role: 'owner', status: 1 }, ...i.room.members];
      for (const m of rows) {
        console.log(`${chalk.bold(st.labels[m.wallet] || room.display(m.wallet))} ${room.display(m.wallet)} ${m.role}${m.status === 1 ? '' : chalk.red(' inactive')}`);
        for (const k of i.room.keys.filter((x: any) => x.wallet === m.wallet)) console.log(`   ${k.role} ${k.key} ${k.label || ''}${k.model ? ` model ${k.model} (attested)` : ''}${k.revoked ? chalk.red(' revoked') : ''}`);
      }
    }));

  program
    .command('tasks <id>')
    .description('Open tasks')
    .action((id) => guard(async () => {
      for (const t of room.openTasks(id)) console.log(`#${t.seq} ${t.label}: ${t.text}`);
    }));

  program
    .command('lease <id> <path>')
    .description('Claim, renew or release an advisory lease on a repository path')
    .option('--release', 'release it')
    .action((id, p, o) => guard(async () => {
      const l = await room.lease(id, p, { release: !!o.release, as: 'device' });
      console.log(o.release ? (l.released ? 'released' : 'no lease of yours') : l.granted ? `lease until ${l.expires_at}` : `held by ${l.holder_label} until ${l.expires_at}`);
    }));

  program
    .command('revoke <id>')
    .description('Revoke a member (owner) or a device of yours; the owner rotates the room key')
    .option('--member <wallet>', 'member wallet (owner only)')
    .option('--device <key>', 'device key (your own, or any as owner)')
    .action((id, o) => guard(async () => {
      if (!o.member && !o.device) throw new Error('give --member or --device');
      const r = await room.revoke(id, { member: o.member, device: o.device });
      ok(`revoked${r.epoch ? `; room key rotated to epoch ${r.epoch}` : ''}`);
    }));

  program
    .command('rotate <id>')
    .description('Rotate the room key (owner)')
    .action((id) => guard(async () => { ok(`epoch ${await room.rotate(id)}`); }));

  program
    .command('leave <id>')
    .description('Leave a Kiosk and wipe its keys and cache from this Mac')
    .action((id) => guard(async () => { await room.leave(id); ok(`left ${id}; local keys and cache wiped`); }));

  program
    .command('delete <id>')
    .description('Delete a Kiosk for every member (owner): ciphertext, wraps and keys')
    .action((id) => guard(async () => { await room.deleteRoom(id); ok(`deleted ${id}`); }));

  program
    .command('erase <id> <seq>')
    .description('Erase one of your own events (or, as guardian, one of hers)')
    .action((id, seq) => guard(async () => { ok(`erased #${seq} (erase event #${await room.erase(id, Number(seq))})`); }));

  program
    .command('device-request <id>')
    .description('Request enrollment of this Mac account as a device of a wallet; the account holding the wallet approves it')
    .option('--relay <url>', 'relay base URL (default: this account\'s relay)')
    .option('--label <name>', 'device label')
    .option('--wallet <address>', 'enroll under this wallet held by another Mac account (a separate macOS user for your seats); the wallet key never comes here')
    .option('--seat', 'also request a Claude Code seat key for this account')
    .option('--model <name>', 'model label for the seat', 'claude')
    .option('--out <file>', 'also write the request to this new file, for example in /Users/Shared when the approving account is another user on this Mac')
    .action((id, o) => guard(async () => {
      const relay = o.relay || room.context().cfg.relay;
      const r = await room.deviceRequest(id, relay, { label: o.label, wallet: o.wallet, seat: !!o.seat, model: o.model, out: o.out });
      console.error(`Verification code ${r.verification}. The account that approves must show the same code before Touch ID.`);
      if (o.out) console.error(`Request written to ${o.out}. On the account that holds the wallet run: kiosk device-approve ${id} ${o.out}`);
      console.log(r.token);
    }));

  program
    .command('device-approve <id> <request>')
    .description('On the account that holds the wallet: approve a device request (the token, or the file that holds it), and its seat if it asks for one (Touch ID)')
    .action((id, req) => guard(async () => {
      let token = String(req);
      if (!token.trim().startsWith('KSKD-') && fs.existsSync(token)) {
        if (fs.statSync(token).size > 65536) throw new Error(`${token} is too large to be a device request`);
        token = fs.readFileSync(token, 'utf8');
      }
      const r = await room.deviceApprove(id, token, (code) => console.error(`Verification code ${code}. Approve only if the account that made the request shows the same code; otherwise cancel.`));
      ok(`enrolled device ${r.device}${r.seat ? ` and seat ${r.seat}` : ''}, verification ${r.verification}`);
    }));

  program
    .command('credits <id>')
    .description('Contribution report per author, with the evidence level of every count')
    .option('--repo <path>', 'also count commits carrying the Kiosk-Event trailer')
    .action((id, o) => guard(async () => { console.log(JSON.stringify(room.credits(id, o.repo), null, 2)); }));

  program
    .command('export <id>')
    .description('Write the decrypted log to a file; refuses unless your grant includes EXPORT')
    .requiredOption('--out <file>', 'output file')
    .action((id, o) => guard(async () => { ok(`exported ${await room.exportRoom(id, o.out)} events to ${o.out}`); }));

  program
    .command('verify <id>')
    .description('Re-verify the whole log from genesis against a fresh copy from the relay')
    .option('--json', 'print JSON')
    .action((id, o) => guard(async () => {
      const r = await room.verify(id);
      if (o.json) { console.log(JSON.stringify(r)); return; }
      if (r.ok) ok(`VALID: ${r.count} events, every receipt, signature and body checked; head ${r.head.slice(0, 10)}`);
      else { console.log(chalk.red(`INVALID: ${r.problems.length} problem(s)`)); r.problems.forEach((p) => console.log(chalk.red(`  ${p}`))); process.exitCode = 2; }
    }));

  program
    .command('gate <text...>')
    .description('Show what the egress gate would do with a text')
    .action((words) => guard(async () => { console.log(JSON.stringify(gate(words.join(' '), macDenylist()))); }));

  program
    .command('repo-setup <id>')
    .description('Prepare the team repository: your own branch, and CODEOWNERS for the files a teammate could use to instruct your seat')
    .requiredOption('--repo <path>', 'team repository on this Mac')
    .requiredOption('--handle <name>', 'short name for your branch (hack/<name>)')
    .option('--reviewer <github_user>', 'GitHub user who must review CLAUDE.md, .claude/, .mcp.json and hooks')
    .action((id, o) => guard(async () => {
      const { spawnSync } = await import('child_process');
      const path = await import('path');
      requireRoom(id);
      const git = (...a: string[]) => spawnSync('git', ['-C', o.repo, ...a], { encoding: 'utf8' });
      if (git('rev-parse', '--is-inside-work-tree').stdout.trim() !== 'true') throw new Error(`${o.repo} is not a git repository`);
      const branch = `hack/${String(o.handle).replace(/[^A-Za-z0-9._-]/g, '')}`;
      const exists = git('rev-parse', '--verify', '--quiet', branch).status === 0;
      const r = exists ? git('checkout', branch) : git('checkout', '-b', branch);
      if (r.status !== 0) throw new Error(r.stderr.trim());
      ok(`working on ${branch}; commit only here, and merge into main through review`);
      const lines = ['CLAUDE.md', '**/CLAUDE.md', '.claude/', '.mcp.json', '.githooks/', 'package.json', '**/package.json'].map((p) => `${p} @${o.reviewer || '<reviewer>'}`);
      const co = path.join(o.repo, '.github', 'CODEOWNERS');
      if (!fs.existsSync(co) && o.reviewer) {
        fs.mkdirSync(path.dirname(co), { recursive: true });
        fs.writeFileSync(co, ['# A change to these files reaches every seat as instructions or code, so it needs review.', ...lines, ''].join('\n'));
        ok(`wrote ${co}; commit it on ${branch} and merge it first`);
      } else {
        console.log(`Add these lines to .github/CODEOWNERS (the file is ${fs.existsSync(co) ? 'already there; edit it yourself' : 'not written without --reviewer'}):`);
        lines.forEach((l) => console.log(`  ${l}`));
      }
      console.log('Then protect main on GitHub (Settings, Branches): require a pull request with review from code owners, and block force pushes.');
    }));

  program
    .command('open <id>')
    .description('Start a Claude Code seat in the clean-room profile of this Kiosk')
    .option('--repo <path>', 'team repository (default: the current directory)')
    .option('--allow-domain <host...>', 'extra hosts the seat\'s shell may reach')
    .option('--private <path...>', 'extra private trees the seat may not read')
    .option('--model <name>', 'model name recorded as attested on seat events', 'claude')
    .option('--print', 'write the profile and print the launch command, but do not launch')
    .option('--no-channel', 'start the seat without the live room (remote messages arrive only with your next prompt)')
    .action((id, o) => guard(async () => {
      if (o.channel !== false && !o.print) {
        console.log(chalk.bold('The room is live in this seat.') + ' Claude Code will show a warning about a development channel: choose "I am using this for local development".');
      }
      const r = await openSeat(id, { repo: o.repo || process.cwd(), allowDomains: o.allowDomain, privateTrees: o.private, model: o.model, launch: !o.print, entry, channel: o.channel !== false });
      if (o.print) {
        console.log(JSON.stringify({ profile: r.dir, settings: r.settingsPath, mcp: r.mcpPath, claude_md: r.claudeMd, repo: r.repo }, null, 2));
        console.log(`\ncd ${r.repo} && ${o.channel !== false ? 'KIOSK_CHANNEL=1 ' : ''}CLAUDE_CONFIG_DIR=${r.dir} claude --setting-sources user --strict-mcp-config --mcp-config ${r.mcpPath}${o.channel !== false ? ' ' + CHANNEL_ARGS.join(' ') : ''}`);
      }
    }));

  program
    .command('hook <name>')
    .description('Claude Code hook entry (used by the room profile)')
    .requiredOption('--room <id>', 'Kiosk id')
    .action(async (name, o) => { process.exitCode = await runHook(name, o.room); });

  program
    .command('mcp')
    .description('Kiosk MCP server on stdio (used by the room profile)')
    .requiredOption('--room <id>', 'Kiosk id')
    .action((o) => { serveMcp(o.room); });

  void withRoomLock; void saveRoom; void ethers;
  return program;
}
