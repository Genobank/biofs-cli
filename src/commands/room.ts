/**
 * biofs room — Researcher Biodata Room (investor data-room metaphor for biocids).
 *
 * Protocol surface (nginx → biofs-node):
 *   POST /api_biofs_node/room/create
 *   POST /api_biofs_node/room/request
 *   GET  /api_biofs_node/room/status
 *   POST /api_biofs_node/room/admit
 *   POST /api_biofs_node/room/revoke
 *   GET  /api_biofs_node/room/list
 *   GET  /api_biofs_node/room/files
 *   GET  /api_biofs_node/room/signing_url
 *
 * Roles:
 *   Owner (patient vault) creates / admits / revokes
 *   Researcher requests / enters / lists scoped files
 */
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import * as fs from 'fs-extra';
import { getCredentials } from '../lib/auth/credentials';
import { ConfigPaths } from '../lib/config/paths';
import { Logger } from '../lib/utils/logger';

const BIOFS_NODE_BASE =
  process.env.BIOFS_NODE_URL ||
  `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface RoomOptions {
  json?: boolean;
  quiet?: boolean;
  purpose?: string;
  skills?: string;
  days?: string;
  biocids?: string;
  researcher?: string;
  message?: string;
  admitMessage?: string;
  signature?: string;
}

async function authHeaders(): Promise<{ wallet: string; signature: string }> {
  const credentials = await getCredentials();
  if (!credentials) {
    Logger.error('Not authenticated. Run: biofs login  (or set BIOFS_PROFILE and login in that profile)');
    process.exit(1);
  }
  return {
    wallet: credentials.wallet_address,
    signature: credentials.user_signature,
  };
}

function parseBiocids(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('biocid://'));
}

function parseSkills(raw?: string): string[] {
  if (!raw) return ['list', 'resolve', 'stream', 'view', 'htsget', 'annotate'];
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

async function saveActiveRoom(roomId: string, room: unknown): Promise<void> {
  const paths = ConfigPaths.getInstance();
  await paths.ensureDirectories();
  await fs.writeJson(
    paths.getRoomSessionPath(),
    { room_id: roomId, entered_at: new Date().toISOString(), room },
    { spaces: 2 }
  );
}

async function clearActiveRoom(): Promise<void> {
  const paths = ConfigPaths.getInstance();
  const p = paths.getRoomSessionPath();
  if (await fs.pathExists(p)) await fs.remove(p);
}

export async function loadActiveRoomId(): Promise<string | null> {
  const paths = ConfigPaths.getInstance();
  const p = paths.getRoomSessionPath();
  try {
    if (!(await fs.pathExists(p))) return null;
    const j = await fs.readJson(p);
    return j.room_id || null;
  } catch {
    return null;
  }
}

/** Owner: open a room shell over selected biocids (status draft until request/admit). */
export async function roomCreateCommand(options: RoomOptions = {}): Promise<void> {
  const spinner = options.quiet ? null : ora('Creating biodata room...').start();
  try {
    const auth = await authHeaders();
    const biocids = parseBiocids(options.biocids);
    if (biocids.length === 0) {
      spinner?.fail('At least one biocid:// is required (--biocids)');
      process.exit(1);
    }
    const body = {
      wallet: auth.wallet,
      signature: auth.signature,
      biocids,
      purpose: options.purpose || 'research deep dive',
      skills: parseSkills(options.skills),
      ttl_days: Math.min(30, Math.max(1, parseInt(options.days || '7', 10) || 7)),
      researcher_wallet: options.researcher || null,
    };
    const r = await axios.post(`${BIOFS_NODE_BASE}/room/create`, body, {
      timeout: 60_000,
      validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) {
      spinner?.fail(r.data?.error || `HTTP ${r.status}`);
      process.exit(1);
    }
    spinner?.succeed(chalk.green(`Room created: ${r.data.room_id}`));
    if (options.json) {
      console.log(JSON.stringify(r.data, null, 2));
      return;
    }
    printRoomCard(r.data.room || r.data);
    if (r.data.signing_url) {
      console.log(chalk.gray('  Signing URL:'), chalk.underline(r.data.signing_url));
    }
    console.log(chalk.dim('\n  Next: invite a researcher → biofs room request --room ' + r.data.room_id));
    console.log(chalk.dim('  Or admit after they request: biofs room admit --room ' + r.data.room_id));
    console.log();
  } catch (e: any) {
    spinner?.fail(e.message);
    process.exit(1);
  }
}

/** Researcher: request admission to an existing room (or owner-attached invite). */
export async function roomRequestCommand(roomId: string, options: RoomOptions = {}): Promise<void> {
  const spinner = options.quiet ? null : ora(`Requesting access to room ${roomId}...`).start();
  try {
    const auth = await authHeaders();
    const body = {
      wallet: auth.wallet,
      signature: auth.signature,
      room_id: roomId,
      message: options.message || options.purpose || 'Requesting research access for bioinformatics deep dive',
      purpose: options.purpose,
      skills: options.skills ? parseSkills(options.skills) : undefined,
    };
    const r = await axios.post(`${BIOFS_NODE_BASE}/room/request`, body, {
      timeout: 60_000,
      validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) {
      spinner?.fail(r.data?.error || `HTTP ${r.status}`);
      process.exit(1);
    }
    spinner?.succeed(chalk.green('Access request recorded (pending owner admit)'));
    if (options.json) {
      console.log(JSON.stringify(r.data, null, 2));
      return;
    }
    printRoomCard(r.data.room || r.data);
    if (r.data.signing_url) {
      console.log(chalk.yellow('\n  Patient should open / receive this signing URL:'));
      console.log(chalk.underline(r.data.signing_url));
      console.log(chalk.dim('  Telegram: use telegram_send_consent_request with room_id + signing_url'));
    }
    console.log();
  } catch (e: any) {
    spinner?.fail(e.message);
    process.exit(1);
  }
}

export async function roomStatusCommand(roomId: string, options: RoomOptions = {}): Promise<void> {
  try {
    const auth = await authHeaders();
    const r = await axios.get(`${BIOFS_NODE_BASE}/room/status`, {
      params: { room_id: roomId, wallet: auth.wallet, signature: auth.signature },
      timeout: 30_000,
      validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) {
      Logger.error(r.data?.error || `HTTP ${r.status}`);
      process.exit(1);
    }
    if (options.json) {
      console.log(JSON.stringify(r.data, null, 2));
      return;
    }
    printRoomCard(r.data.room || r.data);
    console.log();
  } catch (e: any) {
    Logger.error(e.message);
    process.exit(1);
  }
}

/**
 * Owner admits researcher. By default uses the owner's login signature as proof of
 * key possession plus a room-specific admit_message the node also records.
 * For full EIP-712 subject grants, use biofs consent payload/submit first, then admit.
 */
export async function roomAdmitCommand(roomId: string, options: RoomOptions = {}): Promise<void> {
  const spinner = options.quiet ? null : ora(`Admitting researcher to room ${roomId}...`).start();
  try {
    const auth = await authHeaders();
    const admitMessage =
      options.admitMessage ||
      `I admit biodata room ${roomId} as owner ${auth.wallet.toLowerCase()}`;
    const body = {
      wallet: auth.wallet,
      signature: auth.signature,
      room_id: roomId,
      admit_message: admitMessage,
      // Optional: pass through a prior consent_session grant_id if available
      grant_tx: process.env.BIOFS_ROOM_GRANT_TX || undefined,
    };
    const r = await axios.post(`${BIOFS_NODE_BASE}/room/admit`, body, {
      timeout: 60_000,
      validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) {
      spinner?.fail(r.data?.error || `HTTP ${r.status}`);
      process.exit(1);
    }
    spinner?.succeed(chalk.green(`Room OPEN: ${roomId}`));
    if (options.json) {
      console.log(JSON.stringify(r.data, null, 2));
      return;
    }
    printRoomCard(r.data.room || r.data);
    console.log(chalk.dim('\n  Researcher: BIOFS_PROFILE=researcher biofs room enter ' + roomId));
    console.log();
  } catch (e: any) {
    spinner?.fail(e.message);
    process.exit(1);
  }
}

export async function roomRevokeCommand(roomId: string, options: RoomOptions = {}): Promise<void> {
  const spinner = options.quiet ? null : ora(`Revoking room ${roomId}...`).start();
  try {
    const auth = await authHeaders();
    const r = await axios.post(
      `${BIOFS_NODE_BASE}/room/revoke`,
      { wallet: auth.wallet, signature: auth.signature, room_id: roomId },
      { timeout: 60_000, validateStatus: (s) => s < 500 }
    );
    if (r.status >= 400) {
      spinner?.fail(r.data?.error || `HTTP ${r.status}`);
      process.exit(1);
    }
    const active = await loadActiveRoomId();
    if (active === roomId) await clearActiveRoom();
    spinner?.succeed(chalk.yellow(`Room revoked: ${roomId}`));
    if (options.json) console.log(JSON.stringify(r.data, null, 2));
  } catch (e: any) {
    spinner?.fail(e.message);
    process.exit(1);
  }
}

export async function roomListCommand(options: RoomOptions = {}): Promise<void> {
  try {
    const auth = await authHeaders();
    const r = await axios.get(`${BIOFS_NODE_BASE}/room/list`, {
      params: { wallet: auth.wallet, signature: auth.signature },
      timeout: 30_000,
      validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) {
      Logger.error(r.data?.error || `HTTP ${r.status}`);
      process.exit(1);
    }
    if (options.json) {
      console.log(JSON.stringify(r.data, null, 2));
      return;
    }
    const rooms = r.data.rooms || [];
    console.log(chalk.cyan(`\nBiodata rooms (${rooms.length})\n`));
    if (!rooms.length) {
      console.log(chalk.gray('  None yet. Owner: biofs room create --biocids biocid://...'));
      console.log();
      return;
    }
    for (const room of rooms) {
      const st =
        room.status === 'open'
          ? chalk.green(room.status)
          : room.status === 'revoked'
            ? chalk.red(room.status)
            : chalk.yellow(room.status);
      console.log(`  ${chalk.bold(room.room_id)}  ${st}`);
      console.log(
        chalk.gray(
          `    owner ${short(room.owner_wallet)}  researcher ${short(room.researcher_wallet)}  biocids ${room.biocids?.length || 0}`
        )
      );
      if (room.purpose) console.log(chalk.gray(`    purpose: ${room.purpose}`));
    }
    console.log();
  } catch (e: any) {
    Logger.error(e.message);
    process.exit(1);
  }
}

export async function roomEnterCommand(roomId: string, options: RoomOptions = {}): Promise<void> {
  const spinner = options.quiet ? null : ora(`Entering room ${roomId}...`).start();
  try {
    const auth = await authHeaders();
    const r = await axios.get(`${BIOFS_NODE_BASE}/room/status`, {
      params: { room_id: roomId, wallet: auth.wallet, signature: auth.signature },
      timeout: 30_000,
      validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) {
      spinner?.fail(r.data?.error || `HTTP ${r.status}`);
      process.exit(1);
    }
    const room = r.data.room || r.data;
    if (room.status !== 'open') {
      spinner?.fail(`Room is not OPEN (status=${room.status}). Wait for owner admit.`);
      process.exit(1);
    }
    const me = auth.wallet.toLowerCase();
    const isMember =
      me === String(room.owner_wallet || '').toLowerCase() ||
      me === String(room.researcher_wallet || '').toLowerCase();
    if (!isMember) {
      spinner?.fail('Your wallet is not a member of this room');
      process.exit(1);
    }
    await saveActiveRoom(roomId, room);
    process.env.BIOFS_ROOM_ID = roomId;
    spinner?.succeed(chalk.green(`Entered Biodata Room ${roomId}`));
    if (options.json) {
      console.log(JSON.stringify({ room_id: roomId, room }, null, 2));
      return;
    }
    printRoomCard(room);
    console.log(chalk.white('\n  Deep dive:'));
    console.log(chalk.cyan('    biofs room files'));
    console.log(chalk.cyan('    biofs stream <biocid> | bcftools stats -'));
    console.log(chalk.cyan('    biofs annotate submit <serial>'));
    console.log(chalk.dim('  Leave: biofs room leave'));
    console.log();
  } catch (e: any) {
    spinner?.fail(e.message);
    process.exit(1);
  }
}

export async function roomLeaveCommand(options: RoomOptions = {}): Promise<void> {
  const id = await loadActiveRoomId();
  await clearActiveRoom();
  delete process.env.BIOFS_ROOM_ID;
  if (options.json) {
    console.log(JSON.stringify({ left: id }, null, 2));
    return;
  }
  console.log(chalk.green(id ? `Left room ${id}` : 'No active room session'));
}

export async function roomFilesCommand(roomId: string | undefined, options: RoomOptions = {}): Promise<void> {
  try {
    const auth = await authHeaders();
    const id = roomId || (await loadActiveRoomId()) || process.env.BIOFS_ROOM_ID;
    if (!id) {
      Logger.error('No room id. Pass <room_id> or biofs room enter first.');
      process.exit(1);
    }
    const r = await axios.get(`${BIOFS_NODE_BASE}/room/files`, {
      params: { room_id: id, wallet: auth.wallet, signature: auth.signature },
      timeout: 60_000,
      validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) {
      Logger.error(r.data?.error || `HTTP ${r.status}`);
      process.exit(1);
    }
    if (options.json) {
      console.log(JSON.stringify(r.data, null, 2));
      return;
    }
    const files = r.data.files || [];
    console.log(chalk.cyan(`\nRoom ${id} — ${files.length} biocid(s)\n`));
    for (const f of files) {
      const type = f.filetype || f.file_type_guess || f.biodata_type || '?';
      const serial = f.sample_serial || f.biosample_serial || '';
      console.log(`  ${chalk.bold(type.padEnd(10))} ${f.biocid || ''}`);
      if (serial) console.log(chalk.gray(`             serial ${serial}`));
    }
    if (!files.length) console.log(chalk.gray('  (empty scope or inventory rows not found)'));
    console.log(chalk.dim('\n  No gs:// paths shown by design. Address data only via biocid://'));
    console.log();
  } catch (e: any) {
    Logger.error(e.message);
    process.exit(1);
  }
}

export async function roomSigningUrlCommand(roomId: string, options: RoomOptions = {}): Promise<void> {
  try {
    const auth = await authHeaders();
    const r = await axios.get(`${BIOFS_NODE_BASE}/room/signing_url`, {
      params: { room_id: roomId, wallet: auth.wallet, signature: auth.signature },
      timeout: 30_000,
      validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) {
      Logger.error(r.data?.error || `HTTP ${r.status}`);
      process.exit(1);
    }
    if (options.json) {
      console.log(JSON.stringify(r.data, null, 2));
      return;
    }
    console.log(chalk.cyan('\nPatient signing URL (Telegram / browser)\n'));
    console.log(chalk.underline(r.data.signing_url));
    if (r.data.telegram_startapp) {
      console.log(chalk.gray('\nTelegram Mini App startapp:'));
      console.log(r.data.telegram_startapp);
    }
    console.log();
  } catch (e: any) {
    Logger.error(e.message);
    process.exit(1);
  }
}

function short(w?: string): string {
  if (!w) return '(none)';
  const s = String(w);
  if (s.length < 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function printRoomCard(room: any): void {
  if (!room) return;
  console.log('\n' + chalk.cyan('═'.repeat(64)));
  console.log(chalk.bold('  Researcher Biodata Room'));
  console.log(chalk.cyan('═'.repeat(64)));
  console.log(chalk.gray('  Room ID:    '), room.room_id);
  console.log(
    chalk.gray('  Status:     '),
    room.status === 'open' ? chalk.green(room.status) : chalk.yellow(room.status)
  );
  console.log(chalk.gray('  Owner:      '), room.owner_wallet);
  console.log(chalk.gray('  Researcher:'), room.researcher_wallet || '(pending request)');
  console.log(chalk.gray('  Purpose:   '), room.purpose || '');
  console.log(chalk.gray('  Skills:    '), (room.skills || []).join(', '));
  console.log(chalk.gray('  Biocids:   '), (room.biocids || []).length);
  if (room.expires_at) console.log(chalk.gray('  Expires:   '), room.expires_at);
  if (room.opened_at) console.log(chalk.gray('  Opened:    '), room.opened_at);
  console.log(chalk.cyan('═'.repeat(64)));
}
