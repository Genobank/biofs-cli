/**
 * biofs imaging package | package-status: CN1 to CN3 of organ_package_verb_criteria-20261106.txt (with amendment 1).
 * axios, the credentials and the spinner are faked; the retry loop runs on jest's fake timers.
 */
import fs from 'fs';
import path from 'path';

const spin: any = { calls: [] as string[][], text: '' };
for (const m of ['start', 'succeed', 'fail', 'warn']) spin[m] = jest.fn((msg?: string) => { spin.calls.push([m, String(msg ?? '')]); return spin; });
jest.mock('ora', () => () => spin);
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../src/lib/auth/credentials', () => ({ getCredentials: jest.fn() }));
jest.mock('../src/lib/utils/logger', () => ({ Logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() } }));

import axios from 'axios';
import { getCredentials } from '../src/lib/auth/credentials';
import {
  imagingPackageCommand, imagingPackageStatusCommand, waitForPackage, printPackageRow, parseOrgans,
} from '../src/commands/imaging/package';

const post = axios.post as jest.Mock;
const get = axios.get as jest.Mock;
const creds = getCredentials as jest.Mock;

const WALLET = '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
const SIG = 'sig-' + 'c'.repeat(100);
const REG = 'register-11111111-1111-1111-1111-111111111111';
const PKG = 'package-aaaaaaaa-0000-0000-0000-000000000001';
const DONE_RESULT = { schema: 'organ-twin-package/1', files: 421, bytes: 442_000_000, verify: { ok: true }, floors_sha256: 'f0f1f2f3f4f5f6f7' + '0'.repeat(48), organs_built: 29 };
const doneRow = (over: any = {}) => ({ package_job_id: PKG, status: 'done', register_job_id: REG, organs: 'default', floors: true, gate_verdict: 'PASS_WITH_WARNINGS',
  output_biocid: `biocid://genobank/${WALLET.toLowerCase()}/imaging-organ-package/${PKG}`, result: DONE_RESULT, ...over });
const accepted = { status: 202, data: { package_job_id: PKG, status: 'running', register_job_id: REG, organs: 'default', floors: true, gate_verdict: 'PASS' } };

let logs: string[];
let errs: string[];
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

beforeEach(() => {
  jest.resetAllMocks();
  spin.calls.length = 0;
  for (const m of ['start', 'succeed', 'fail', 'warn']) spin[m].mockImplementation((msg?: string) => { spin.calls.push([m, String(msg ?? '')]); return spin; });
  creds.mockResolvedValue({ wallet_address: WALLET, user_signature: SIG });
  logs = []; errs = [];
  jest.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(strip(a.join(' '))); });
  jest.spyOn(console, 'error').mockImplementation((...a: any[]) => { errs.push(strip(a.join(' '))); });
  process.exitCode = undefined;
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  process.exitCode = undefined;
});

/** Drive a promise that sleeps on fake timers to its end. */
async function drive<T>(p: Promise<T>, stepMs = 20_000, maxSteps = 200): Promise<T> {
  let done = false; let out: T; let thrown: any;
  p.then((v) => { out = v; done = true; }, (e) => { thrown = e; done = true; });
  for (let i = 0; i < maxSteps && !done; i++) { await jest.advanceTimersByTimeAsync(stepMs); }
  if (!done) throw new Error('promise did not finish within the fake time');
  if (thrown) throw thrown;
  return out!;
}

describe('CN1 package: the submit', () => {
  test('posts exactly {wallet, signature, register_job_id, floors} to submit_organ_package, no organs key', async () => {
    post.mockResolvedValue(accepted);
    const id = await imagingPackageCommand(REG, {});
    expect(id).toBe(PKG);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toMatch(/\/api_biofs_node\/submit_organ_package$/);
    expect(body).toStrictEqual({ wallet: WALLET, signature: SIG, register_job_id: REG, floors: true });
    expect('organs' in body).toBe(false);
    expect(get).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test('--organs is split on commas and trimmed; empty entries are dropped', async () => {
    post.mockResolvedValue(accepted);
    await imagingPackageCommand(REG, { organs: ' liver , spleen,,kidney_left ' });
    expect(post.mock.calls[0][1].organs).toStrictEqual(['liver', 'spleen', 'kidney_left']);
    expect(parseOrgans(undefined)).toBeUndefined();
    expect(parseOrgans('a,b')).toStrictEqual(['a', 'b']);
  });

  test('--no-floors gives floors false; the default and an explicit true give floors true', async () => {
    post.mockResolvedValue(accepted);
    await imagingPackageCommand(REG, { floors: false });
    expect(post.mock.calls[0][1].floors).toBe(false);
    await imagingPackageCommand(REG, { floors: true });
    expect(post.mock.calls[1][1].floors).toBe(true);
    await imagingPackageCommand(REG, {});
    expect(post.mock.calls[2][1].floors).toBe(true);
  });

  test.each([
    ['empty', ''], ['a package id', PKG], ['a job id', 'job-1'], ['a path', REG + '/../x'], ['upper case hex', 'register-ABCDEFAB-1111-1111-1111-111111111111'],
  ])('an id that is not register-<uuid> (%s) stops before any network call', async (_n, id) => {
    const r = await imagingPackageCommand(id, {});
    expect(r).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('not logged in stops before any network call', async () => {
    creds.mockResolvedValue(null);
    const r = await imagingPackageCommand(REG, {});
    expect(r).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(spin.calls.some(([m, t]) => m === 'fail' && /Not authenticated/.test(t))).toBe(true);
  });

  test('--organs with no organ name in it stops before any network call', async () => {
    for (const bad of [',', ' , ,', '']) {
      const r = await imagingPackageCommand(REG, { organs: bad });
      expect(r).toBeNull();
    }
    expect(post).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('a node answer of 400 or more returns null and prints the error text', async () => {
    for (const [status, error] of [[400, 'organs must be "default"'], [403, 'not the owner of this register job'], [404, 'register job not found'], [409, 'register job is running, not done']] as const) {
      spin.calls.length = 0; process.exitCode = undefined;
      post.mockResolvedValue({ status, data: { error } });
      const r = await imagingPackageCommand(REG, {});
      expect(r).toBeNull();
      expect(process.exitCode).toBe(1);
      expect(spin.calls.some(([m, t]) => m === 'fail' && t.includes(String(status)) && t.includes(error))).toBe(true);
    }
    expect(get).not.toHaveBeenCalled();
  });

  test('--json prints the node answer on an error and the submit answer on success', async () => {
    post.mockResolvedValue({ status: 409, data: { error: 'busy', package_job_id: PKG } });
    expect(await imagingPackageCommand(REG, { json: true })).toBeNull();
    expect(JSON.parse(logs.join('\n'))).toStrictEqual({ error: 'busy', package_job_id: PKG });
    logs.length = 0;
    post.mockResolvedValue(accepted);
    expect(await imagingPackageCommand(REG, { json: true })).toBe(PKG);
    expect(JSON.parse(logs.join('\n')).package_job_id).toBe(PKG);
  });

  test('without --wait it prints how to follow and makes no status call', async () => {
    post.mockResolvedValue(accepted);
    await imagingPackageCommand(REG, {});
    expect(logs.join('\n')).toContain(`biofs imaging package-status ${PKG} --wait`);
    expect(get).not.toHaveBeenCalled();
  });

  test('a network failure on submit returns null and sets the exit code', async () => {
    post.mockRejectedValue(new Error('ECONNRESET'));
    expect(await imagingPackageCommand(REG, {})).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  test('--wait follows with the status call: signature in the header, job id in the params, summary printed', async () => {
    post.mockResolvedValue(accepted);
    get.mockResolvedValue({ status: 200, data: doneRow() });
    const id = await imagingPackageCommand(REG, { wait: true });
    expect(id).toBe(PKG);
    expect(get).toHaveBeenCalledTimes(1);
    const [url, cfg] = get.mock.calls[0];
    expect(url).toMatch(/\/api_biofs_node\/organ_package_status$/);
    expect(cfg.params).toStrictEqual({ package_job_id: PKG });
    expect(cfg.headers).toStrictEqual({ 'x-biofs-signature': SIG });
    expect(logs.join('\n')).toContain('biocid://genobank/');
  });
});

describe('CN2 package-status and the wait', () => {
  beforeEach(() => { jest.useFakeTimers(); });

  test('the first answer of 400 or more ends a wait at once, with no sleep', async () => {
    for (const status of [400, 403, 404]) {
      get.mockReset(); spin.calls.length = 0;
      get.mockResolvedValue({ status, data: { error: 'nope' } });
      const r = await waitForPackage(PKG, SIG);
      expect(r).toBeNull();
      expect(get).toHaveBeenCalledTimes(1);
      expect(spin.calls.some(([m, t]) => m === 'fail' && t.includes(String(status)))).toBe(true);
    }
  });

  test('done and error on the first answer end the wait and return the row', async () => {
    get.mockResolvedValue({ status: 200, data: doneRow() });
    expect((await waitForPackage(PKG, SIG))!.status).toBe('done');
    expect(get).toHaveBeenCalledTimes(1);
    get.mockReset();
    get.mockResolvedValue({ status: 200, data: { package_job_id: PKG, status: 'error', error: 'package failed its own verify' } });
    const row = await waitForPackage(PKG, SIG);
    expect(row!.status).toBe('error');
    expect(spin.calls.some(([m, t]) => m === 'fail' && t.includes('package failed its own verify'))).toBe(true);
  });

  test('a running job is polled again every 20 s until done', async () => {
    get.mockResolvedValueOnce({ status: 200, data: { package_job_id: PKG, status: 'running' } })
      .mockResolvedValueOnce({ status: 200, data: { package_job_id: PKG, status: 'running' } })
      .mockResolvedValueOnce({ status: 200, data: doneRow() });
    const r = await drive(waitForPackage(PKG, SIG));
    expect(r!.status).toBe('done');
    expect(get).toHaveBeenCalledTimes(3);
  });

  test('after one answer, error replies are retried: 29 in a row and then done succeeds', async () => {
    get.mockResolvedValueOnce({ status: 200, data: { package_job_id: PKG, status: 'running' } });
    for (let i = 0; i < 29; i++) get.mockResolvedValueOnce(i % 2 ? { status: 403, data: { error: 'cannot recover signer' } } : Promise.reject(new Error('socket hang up')));
    get.mockResolvedValueOnce({ status: 200, data: doneRow() });
    const r = await drive(waitForPackage(PKG, SIG));
    expect(r!.status).toBe('done');
    expect(get).toHaveBeenCalledTimes(1 + 29 + 1);
  });

  test('30 error replies in a row end the wait with null', async () => {
    get.mockResolvedValueOnce({ status: 200, data: { package_job_id: PKG, status: 'running' } });
    get.mockResolvedValue({ status: 500, data: { error: 'down' } });
    const r = await drive(waitForPackage(PKG, SIG));
    expect(r).toBeNull();
    expect(get).toHaveBeenCalledTimes(1 + 30);
    expect(spin.calls.some(([m, t]) => m === 'fail' && t.includes('organ_package_status'))).toBe(true);
  });

  test('a good answer resets the failure count', async () => {
    get.mockResolvedValueOnce({ status: 200, data: { package_job_id: PKG, status: 'running' } });
    for (let i = 0; i < 25; i++) get.mockResolvedValueOnce({ status: 403, data: { error: 'x' } });
    get.mockResolvedValueOnce({ status: 200, data: { package_job_id: PKG, status: 'running' } });
    for (let i = 0; i < 25; i++) get.mockResolvedValueOnce({ status: 403, data: { error: 'x' } });
    get.mockResolvedValueOnce({ status: 200, data: doneRow() });
    const r = await drive(waitForPackage(PKG, SIG));
    expect(r!.status).toBe('done');
  });

  test('the wait gives up after 3 hours and says the job may still be running', async () => {
    get.mockResolvedValue({ status: 200, data: { package_job_id: PKG, status: 'running' } });
    const r = await drive(waitForPackage(PKG, SIG), 600_000, 40);
    expect(r).toBeNull();
    expect(spin.calls.some(([m, t]) => m === 'warn' && t.includes(`package-status ${PKG}`))).toBe(true);
  });

  test('package-status without --wait: one call, row printed; 400 or more returns null', async () => {
    get.mockResolvedValue({ status: 200, data: doneRow() });
    const row = await imagingPackageStatusCommand(PKG, {});
    expect(row!.status).toBe('done');
    expect(get).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toContain(`package job ${PKG}: done`);
    get.mockReset(); logs.length = 0;
    get.mockResolvedValue({ status: 404, data: { error: 'package_job_id not found' } });
    expect(await imagingPackageStatusCommand(PKG, {})).toBeNull();
    expect(errs.join('\n')).toContain('package_job_id not found');
    expect(process.exitCode).toBe(1);
  });

  test('package-status refuses an id that is not package-<uuid> before any network call', async () => {
    for (const id of ['', REG, 'package-x', PKG + '/x']) {
      expect(await imagingPackageStatusCommand(id, {})).toBeNull();
    }
    expect(get).not.toHaveBeenCalled();
    creds.mockResolvedValue(null);
    expect(await imagingPackageStatusCommand(PKG, {})).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  test('package-status --wait follows the job; --json prints the row only', async () => {
    get.mockResolvedValueOnce({ status: 200, data: { package_job_id: PKG, status: 'running' } }).mockResolvedValueOnce({ status: 200, data: doneRow() });
    const row = await drive(imagingPackageStatusCommand(PKG, { wait: true, json: true }));
    expect(row!.status).toBe('done');
    expect(JSON.parse(logs.join('\n')).package_job_id).toBe(PKG);
  });
});

describe('CN2 the printed summary', () => {
  test('a done row names the organs, files, bytes, verify, floors hash and the biocid', () => {
    printPackageRow(doneRow() as any);
    const t = logs.join('\n');
    expect(t).toContain(`package job ${PKG}: done`);
    expect(t).toContain('29 organs');
    expect(t).toContain('421 files');
    expect(t).toContain('442.0 MB');
    expect(t).toContain('verify OK');
    expect(t).toContain('floors f0f1f2f3f4f5f6f7');
    expect(t).toContain(`biocid://genobank/${WALLET.toLowerCase()}/imaging-organ-package/${PKG}`);
    expect(t).toContain('gate PASS_WITH_WARNINGS');
  });

  test('without organs_built it prints what was requested', () => {
    const r = { ...DONE_RESULT } as any; delete r.organs_built;
    printPackageRow(doneRow({ result: r, organs: ['liver', 'spleen'] }) as any);
    expect(logs.join('\n')).toContain('2 named organs');
    logs.length = 0;
    printPackageRow(doneRow({ result: r }) as any);
    expect(logs.join('\n')).toContain('default organ list');
  });

  test('without floors there is no floors hash and the row says floors off', () => {
    const r = { ...DONE_RESULT, floors_sha256: null };
    printPackageRow(doneRow({ result: r, floors: false }) as any);
    const t = logs.join('\n');
    expect(t).toContain('floors off');
    expect(t).not.toMatch(/, floors [0-9a-f]/);
  });

  test('verify false prints FAILED; an error row prints the error; a registry problem is shown', () => {
    printPackageRow(doneRow({ result: { ...DONE_RESULT, verify: { ok: false } } }) as any);
    expect(logs.join('\n')).toContain('verify FAILED');
    logs.length = 0;
    printPackageRow({ package_job_id: PKG, status: 'error', error: 'input_gcs not found', register_job_id: REG } as any);
    expect(logs.join('\n')).toContain('error: input_gcs not found');
    logs.length = 0;
    printPackageRow(doneRow({ registry_error: 'mongo write refused' }) as any);
    expect(logs.join('\n')).toContain('biocid registration: mongo write refused');
  });

  test('the summary never calls a change clinically relevant or significant', () => {
    printPackageRow(doneRow() as any);
    expect(logs.join('\n')).not.toMatch(/clinically (relevant|significant)/i);
  });
});

describe('CN3 registration in src/index.ts', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const block = (name: string) => { const i = src.indexOf(`.command('${name}`); return i < 0 ? '' : src.slice(i, i + 900); };

  test('imaging package is registered once with its options', () => {
    expect(src.split(".command('package <registerJobId>')").length - 1).toBe(1);
    const b = block('package <registerJobId>');
    for (const o of ["'--organs <list>'", "'--no-floors'", "'--wait'", "'--quiet'", "'--json'"]) expect(b).toContain(o);
    expect(b).toContain('imagingPackageCommand(registerJobId, options)');
  });

  test('imaging package-status is registered once with its options', () => {
    expect(src.split(".command('package-status <packageJobId>')").length - 1).toBe(1);
    const b = block('package-status <packageJobId>');
    for (const o of ["'--wait'", "'--quiet'", "'--json'"]) expect(b).toContain(o);
    expect(b).toContain('imagingPackageStatusCommand(packageJobId, options)');
  });

  test('the import comes from the package module', () => {
    expect(src).toContain("from './commands/imaging/package'");
  });
});
