/**
 * biofs erase-trial run|inspect|cleanup
 *
 * CLIENT verb. Exercises GDPR Article 17 erasure end to end on a SYNTHETIC biosample, so the
 * deployed `biofs erase` path can be measured without touching anyone's biology.
 *
 *   biofs erase-trial run              # build a synthetic serial, grant, read, erase, re-check
 *   biofs erase-trial inspect <serial> # what still exists for a trial serial
 *   biofs erase-trial cleanup <serial> # remove what erase left behind (synthetic rows only)
 *
 * `run` drives only production code paths: biofs-node builds the synthetic object and its
 * registry rows (POST /agent/erase_trial), the operator submits the grant through
 * /api_biofs_fuse/tokenize_biosample, reads go through the gated /api_biofs_fuse/stream, the
 * grant is checked on Sequentia with checkPermission, and erasure runs through the same
 * /api_biofs_fuse/erase that `biofs erase` calls. Every observation is written to a JSON report.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import { ethers } from 'ethers';
import { getCredentials } from '../lib/auth/credentials';
import { FuseAPIClient } from '../lib/api/fuse-client';
import { API_CONFIG } from '../lib/config/constants';
import { Logger } from '../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;
const FUSE = `${API_CONFIG.base}${API_CONFIG.fuse}`;
const RPC = process.env.SEQUENTIA_TRIAL_RPC || 'https://sequentias-test.genobank.io';
const REPORT_DIR = path.join(os.homedir(), '.biofs', 'erase-trial');

export interface EraseTrialOptions { json?: boolean }

async function node(action: string, serial: string | undefined, wallet: string, sig: string) {
  const r = await axios.post(`${BIOFS_NODE_BASE}/erase_trial`, { action, serial }, {
    headers: { 'Content-Type': 'application/json', 'X-Biofs-Wallet': wallet, 'X-Biofs-Signature': sig },
    timeout: 180_000, validateStatus: (s) => s < 600,
  });
  if (r.status >= 400) throw new Error(`erase_trial ${action}: ${r.status} ${r.data?.error || ''}`);
  return r.data;
}

async function streamRead(serial: string, filename: string, wallet: string, sig: string, offset: number, length: number) {
  const r = await axios.get(`${FUSE}/stream`, {
    params: { biosample: serial, filename, wallet, signature: sig, offset, length },
    responseType: 'arraybuffer', timeout: 60_000, validateStatus: () => true,
  });
  const buf = Buffer.from(r.data);
  const text = buf.toString('utf8');
  return { status: r.status, bytes: buf.length, head: text.slice(0, 60).replace(/\n/g, '\\n') };
}

async function checkPermission(contract: string, agent: string, p: string) {
  const provider = new ethers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(contract, ['function checkPermission(address,string) view returns (bool)'], provider);
  return Boolean(await c.checkPermission(agent, p));
}

async function txTarget(hash: string) {
  const provider = new ethers.JsonRpcProvider(RPC);
  const rc = await provider.getTransactionReceipt(hash);
  return rc ? { to: rc.to, block: rc.blockNumber, gasUsed: rc.gasUsed.toString(), status: rc.status } : null;
}

function save(serial: string, report: any) {
  fs.mkdirSync(REPORT_DIR, { recursive: true, mode: 0o700 });
  const f = path.join(REPORT_DIR, `${serial}.json`);
  fs.writeFileSync(f, JSON.stringify(report, null, 2));
  return f;
}

export async function eraseTrialRunCommand(options: EraseTrialOptions): Promise<void> {
  const step = (s: string) => { if (!options.json) console.log(chalk.cyan(`• ${s}`)); };
  try {
    const cred = await getCredentials();
    if (!cred) throw new Error('Not authenticated. Run "biofs login" first.');
    const wallet = cred.wallet_address; const sig = cred.user_signature;
    const fuse = new FuseAPIClient();
    const report: any = { started_at: new Date().toISOString(), wallet_role: 'owner (signer)', steps: {} };

    step('setup: synthetic serial, two object generations, registry rows');
    const setup = await node('setup', undefined, wallet, sig);
    const serial: string = setup.serial; const filename: string = setup.filename;
    report.serial = serial; report.steps.setup = setup;

    step('grant: operator submits grantPermission through tokenize_biosample');
    const tk = await axios.get(`${FUSE}/tokenize_biosample`, {
      params: { biosample: serial, wallet, signature: sig }, timeout: 120_000, validateStatus: () => true,
    });
    report.steps.grant = { status: tk.status, tx_hash: tk.data?.tx_hash, block_number: tk.data?.block_number, error: tk.data?.error };
    if (tk.status >= 400 || !tk.data?.tx_hash) throw new Error(`grant failed: ${tk.status} ${tk.data?.error || ''}`);
    const txHash = String(tk.data.tx_hash).startsWith('0x') ? String(tk.data.tx_hash) : `0x${tk.data.tx_hash}`;
    const tgt = await txTarget(txHash);
    report.steps.grant.receipt = tgt;
    const grantPath = `biowallet/${serial}/*`; // the exact pattern the grant records; checkPermission does not expand wildcards

    step('before erase: gated read, on-chain permission, registry state');
    report.steps.before = {
      read_first_chunk: await streamRead(serial, filename, wallet, sig, 0, 200),
      checkPermission: tgt?.to ? await checkPermission(tgt.to, wallet, grantPath) : null,
      state: await node('inspect', serial, wallet, sig),
    };

    step('erase: dry run');
    report.steps.dry_run = await fuse.erase({ biosample: serial, dryRun: true }, wallet, sig);

    step('erase: execute');
    const ex = await fuse.erase({ biosample: serial, dryRun: false, confirm: `ERASE-${serial}` }, wallet, sig);
    report.steps.execute = { status: ex.status, result: ex.result, erasure_id: ex.erasure_id || ex.certificate?.erasure_id, retained_until: ex.retained_until, certificate: ex.certificate, error: ex.error };

    step('after erase: second chunk of the open read, on-chain permission, registry state');
    report.steps.after = {
      read_second_chunk: await streamRead(serial, filename, wallet, sig, 200, 200),
      read_from_start: await streamRead(serial, filename, wallet, sig, 0, 200),
      checkPermission: tgt?.to ? await checkPermission(tgt.to, wallet, grantPath) : null,
      state: await node('inspect', serial, wallet, sig),
    };

    step('re-run: resume the completed erasure, then request a fresh erasure');
    const eid = report.steps.execute.erasure_id;
    const tryErase = async (opts: any) => { try { return await fuse.erase(opts, wallet, sig); } catch (e: any) { return { refused: e.message }; } };
    report.steps.rerun = {
      resume: eid ? await tryErase({ erasureId: eid, dryRun: false }) : null,
      fresh_request: await tryErase({ biosample: serial, dryRun: true }),
    };

    report.finished_at = new Date().toISOString();
    const f = save(serial, report);
    if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
    const a = report.steps.after; const b = report.steps.before;
    console.log(chalk.bold(`\nErase trial ${serial}`));
    console.log(`  read before          ${b.read_first_chunk.status} (${b.read_first_chunk.bytes} bytes)`);
    console.log(`  erase                ${report.steps.execute.status}`);
    console.log(`  read after (chunk 2) ${a.read_second_chunk.status}`);
    console.log(`  live object          ${a.state.gcs.live_exists}`);
    console.log(`  object generations   ${a.state.gcs.generations.length}`);
    console.log(`  soft-deleted copies  ${Array.isArray(a.state.gcs.soft_deleted) ? a.state.gcs.soft_deleted.length : a.state.gcs.soft_deleted}`);
    console.log(`  checkPermission      before=${b.checkPermission} after=${a.checkPermission}`);
    console.log(chalk.gray(`\n  report ${f}`));
  } catch (e: any) {
    Logger.error(`erase-trial failed: ${e.message}`);
    process.exit(1);
  }
}

export async function eraseTrialNodeCommand(action: 'inspect' | 'cleanup', serial: string, options: EraseTrialOptions): Promise<void> {
  try {
    const cred = await getCredentials();
    if (!cred) throw new Error('Not authenticated. Run "biofs login" first.');
    const r = await node(action, serial, cred.wallet_address, cred.user_signature);
    if (action === 'cleanup') {
      const f = path.join(REPORT_DIR, `${serial}.json`);
      if (fs.existsSync(f)) {
        const rep = JSON.parse(fs.readFileSync(f, 'utf8'));
        rep.steps.cleanup = r; save(serial, rep);
      }
    }
    console.log(JSON.stringify(r, null, 2));
  } catch (e: any) {
    Logger.error(`erase-trial ${action} failed: ${e.message}`);
    process.exit(1);
  }
}

/** `biofs erase-trial read <serial>`: one gated read of the trial object as the signer, so the
 *  gate's decision after an erasure is recorded (403 = refused by the gate; 500 carrying a
 *  storage not-found = admitted by the gate, bytes gone). Appended to the serial's report. */
export async function eraseTrialReadCommand(serial: string, options: EraseTrialOptions): Promise<void> {
  try {
    const cred = await getCredentials();
    if (!cred) throw new Error('Not authenticated. Run "biofs login" first.');
    const filename = `synthetic_erase_trial_${serial}.vcf`;
    const r = { at: new Date().toISOString(), serial, filename,
      read_from_start: await streamRead(serial, filename, cred.wallet_address, cred.user_signature, 0, 200) };
    const f = path.join(REPORT_DIR, `${serial}.json`);
    if (fs.existsSync(f)) {
      const rep = JSON.parse(fs.readFileSync(f, 'utf8'));
      rep.steps.reads = rep.steps.reads || []; rep.steps.reads.push(r); save(serial, rep);
    }
    console.log(JSON.stringify(r, null, 2));
  } catch (e: any) {
    Logger.error(`erase-trial read failed: ${e.message}`);
    process.exit(1);
  }
}

/** `biofs erase-trial grantee`: what revocation blocks while the data remain available.
 *
 *  Builds a synthetic biosample, grants it to the signer (the owner), then to a throwaway
 *  grantee wallet generated for this run (its key is never written anywhere), and records:
 *  the grantee's read admitted, the SAME captured signature presented again admitted (the
 *  fixed message has no nonce), the owner's read, a never-granted control wallet refused,
 *  then revokes the grantee and records the grantee's read (expect 403 from the gate while
 *  the live object still exists), the replayed signature, the control, the owner's read
 *  (expect admitted: the owner path does not depend on the grant), checkPermission for the
 *  grantee on both path shapes, and the object and grant state. Nothing is erased. */
export async function eraseTrialGranteeCommand(options: EraseTrialOptions): Promise<void> {
  const step = (s: string) => { if (!options.json) console.log(chalk.cyan(`• ${s}`)); };
  const MSG = 'I want to proceed';
  try {
    const cred = await getCredentials();
    if (!cred) throw new Error('Not authenticated. Run "biofs login" first.');
    const wallet = cred.wallet_address; const sig = cred.user_signature;
    const grantee = ethers.Wallet.createRandom();
    const control = ethers.Wallet.createRandom();
    const gSig = await grantee.signMessage(MSG);
    const cSig = await control.signMessage(MSG);
    const report: any = {
      started_at: new Date().toISOString(), mode: 'grantee',
      wallet_role: 'owner (signer); grantee and control are throwaway wallets, keys discarded',
      grantee_wallet: grantee.address, control_wallet: control.address, steps: {},
    };
    const get = async (p: string, params: any) =>
      axios.get(`${FUSE}/${p}`, { params, timeout: 120_000, validateStatus: () => true });
    const state = async () => { const s = await node('inspect', report.serial, wallet, sig);
      return { live_exists: s.gcs?.live_exists, generations: s.gcs?.generations?.length, grants: s.grants }; };

    step('setup: synthetic serial, two object generations, registry rows');
    const setup = await node('setup', undefined, wallet, sig);
    const serial: string = setup.serial; const filename: string = setup.filename;
    report.serial = serial; report.steps.setup = setup;

    step('owner grant: operator submits grantPermission through tokenize_biosample');
    const tk = await get('tokenize_biosample', { biosample: serial, wallet, signature: sig });
    report.steps.owner_grant = { status: tk.status, tx_hash: tk.data?.tx_hash, block_number: tk.data?.block_number, error: tk.data?.error };
    if (tk.status >= 400 || !tk.data?.tx_hash) throw new Error(`owner grant failed: ${tk.status} ${tk.data?.error || ''}`);
    const ownerTx = String(tk.data.tx_hash).startsWith('0x') ? String(tk.data.tx_hash) : `0x${tk.data.tx_hash}`;
    const tgt = await txTarget(ownerTx);
    const contract = tgt?.to as string;

    step('grantee grant: owner-signed grant_access to the throwaway wallet');
    const ga = await get('grant_access', {
      biosample: serial, owner_wallet: wallet, owner_signature: sig,
      agent_wallet: grantee.address, operations: JSON.stringify(['read']), expires_days: 1,
    });
    report.steps.grantee_grant = { status: ga.status, success: ga.data?.success, tx_hash: ga.data?.tx_hash, block_number: ga.data?.block_number, access_record: ga.data?.access_record, error: ga.data?.error };
    if (ga.status >= 400 || !ga.data?.success) throw new Error(`grantee grant failed: ${ga.status} ${ga.data?.error || ''}`);

    const patterns = [`biowallet/${serial}/${filename}`, `biowallet/${serial}/*`];
    const perm = async () => { const o: any = {};
      for (const p of patterns) o[p] = contract ? await checkPermission(contract, grantee.address, p) : null; return o; };

    step('before revocation: grantee read, same signature again, owner read, control, permission, state');
    report.steps.before = {
      grantee_read: await streamRead(serial, filename, grantee.address, gSig, 0, 200),
      grantee_read_same_signature_again: await streamRead(serial, filename, grantee.address, gSig, 200, 200),
      owner_read: await streamRead(serial, filename, wallet, sig, 0, 200),
      control_read: await streamRead(serial, filename, control.address, cSig, 0, 200),
      checkPermission_grantee: await perm(),
      state: await state(),
    };

    step('revoke: owner-signed revoke_access for the grantee');
    const rv = await get('revoke_access', { biosample: serial, owner_wallet: wallet, owner_signature: sig, agent_wallet: grantee.address });
    report.steps.revoke = { status: rv.status, data: rv.data };
    const revokeAt = Date.now();

    step('after revocation: grantee read, replayed signature, owner read, control, permission, state');
    report.steps.after = {
      seconds_after_revoke_request: Math.round((Date.now() - revokeAt) / 1000),
      grantee_read: await streamRead(serial, filename, grantee.address, gSig, 0, 200),
      grantee_read_same_signature_again: await streamRead(serial, filename, grantee.address, gSig, 200, 200),
      owner_read: await streamRead(serial, filename, wallet, sig, 0, 200),
      control_read: await streamRead(serial, filename, control.address, cSig, 0, 200),
      checkPermission_grantee: await perm(),
      state: await state(),
    };

    report.finished_at = new Date().toISOString();
    const f = save(serial, report);
    if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
    const b = report.steps.before; const a = report.steps.after;
    console.log(chalk.bold(`\nGrantee trial ${serial}`));
    console.log(`  before: grantee ${b.grantee_read.status}, replay ${b.grantee_read_same_signature_again.status}, owner ${b.owner_read.status}, control ${b.control_read.status}`);
    console.log(`  after:  grantee ${a.grantee_read.status}, replay ${a.grantee_read_same_signature_again.status}, owner ${a.owner_read.status}, control ${a.control_read.status}`);
    console.log(`  live object ${a.state.live_exists}, grants ${JSON.stringify(a.state.grants)}`);
    console.log(chalk.gray(`\n  report ${f}`));
  } catch (e: any) {
    Logger.error(`erase-trial grantee failed: ${e.message}`);
    process.exit(1);
  }
}
