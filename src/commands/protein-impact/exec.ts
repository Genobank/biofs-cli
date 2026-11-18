/**
 * biofs protein-impact exec --job-id <id> --creator <wallet> (--request-b64 <b64> | --request-file <path>)
 *                          [--gate-b64 <b64> | --gate-file <path>] [--sample <serial>] ...
 *
 * EXECUTOR verb: spawned by biofs-node on the compute node; there is no orphan script. It re-checks
 * everything the client and the front node checked (no-design guard, job id, GPU approval, gate), runs the
 * requested stages with per-stage caching, and writes manifest.json and run.log to
 *   gs://<out-bucket>/biowallet/<creator>/protein-impact/<jobId>/
 * Exit codes: 0 OK, 1 failed, 2 guard refused, 7 empty, 8 gate blocked, 9 approval refused.
 *
 * Heavy stages (plm, structure, complex, probe, md) run in digest-pinned containers named in
 * tools.lock.json; a stage whose image or model revision is not pinned refuses to run. The containers
 * score and measure; none of them generates or designs anything.
 */

import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { Logger } from '../../lib/utils/logger';
import { EXIT, GENES, GPU_LAYERS } from './constants';
import { ExecDeps, Fetcher, StageInput, StageOutput, StageRunner, Storage, runProteinImpact } from './core';
import { ToolsLock, imageForLayer, loadToolsLock, modelRevision } from './tools_lock';

export interface ProteinImpactExecOptions {
  sample?: string;
  ref?: string;
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
  requestB64?: string;
  requestFile?: string;
  gateB64?: string;
  gateFile?: string;
  workDir?: string;
  /** Dry run: map gs://bucket/path to <localRoot>/bucket/path instead of calling gcloud. */
  localRoot?: string;
}

/** Storage over `gcloud storage` (the executor VM uses its attached service account). */
export class GcsStorage implements Storage {
  readText(uri: string): string | null {
    const r = spawnSync('gcloud', ['storage', 'cat', uri], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  }
  writeText(uri: string, text: string): void {
    const tmp = path.join(os.tmpdir(), `pi-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    try { this.copyIn(tmp, uri); } finally { try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ } }
  }
  copyIn(localPath: string, uri: string): void {
    const r = spawnSync('gcloud', ['storage', 'cp', localPath, uri], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`gcloud storage cp to ${uri} failed: ${(r.stderr || '').slice(-300)}`);
  }
}

/** Storage in a local directory, for dry runs on a workstation with public data only. */
export class LocalStorage implements Storage {
  constructor(private root: string) {}
  private p(uri: string): string {
    const m = /^gs:\/\/(.+)$/.exec(uri);
    if (!m) throw new Error(`not a gs:// uri: ${uri}`);
    const full = path.resolve(this.root, m[1]);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error(`path escapes the local root: ${uri}`);
    return full;
  }
  readText(uri: string): string | null {
    const f = this.p(uri); // a malformed or escaping uri is an error, not a missing file
    try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
  }
  writeText(uri: string, text: string): void { const f = this.p(uri); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
  copyIn(localPath: string, uri: string): void { const f = this.p(uri); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.copyFileSync(localPath, f); }
}

export class HttpFetcher implements Fetcher {
  async get(url: string): Promise<Buffer> {
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000, headers: { 'User-Agent': 'biofs-protein-impact' } });
    return Buffer.from(r.data);
  }
}

/** Runs a heavy stage in its digest-pinned container: job.json in, out.json out. */
export class DockerRunner implements StageRunner {
  constructor(private lock: ToolsLock, private log: (m: string) => void, private hfCache = '/mnt/scratch/protein-impact-hf') {}

  async run(input: StageInput): Promise<StageOutput> {
    const image = imageForLayer(input.layer, this.lock); // throws unless the digest is pinned
    const dir = path.join(input.workDir, input.layer);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(this.hfCache, { recursive: true });
    const models: Record<string, { hf_repo: string; revision: string }> = {};
    for (const key of this.lock.layer_models?.[input.layer] ?? []) models[key] = modelRevision(key, this.lock); // throws unless pinned
    const job = {
      schema: 'genobank.protein-impact.container-job/v1',
      layer: input.layer,
      subs: input.subs,
      models,
      sequences: Object.fromEntries(Object.entries(input.sequences).map(([g, s]) => [g, { uniprot: s.uniprot, signal: GENES[g].signal, length: GENES[g].length, seq_sha256: s.seq_sha256, sequence: s.sequence }])),
    };
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));
    try { fs.unlinkSync(path.join(dir, 'out.json')); } catch (_) { /* none yet */ }
    const gpu = GPU_LAYERS.includes(input.layer);
    const args = ['run', '--rm', ...(gpu ? ['--gpus', 'all'] : []), '-v', `${dir}:/work`, '-v', `${this.hfCache}:/hf`, '-e', 'HF_HOME=/hf', image, '/work/job.json', '/work/out.json'];
    this.log(`[protein-impact] docker ${args.join(' ')}`);
    const r = spawnSync('docker', args, { encoding: 'utf8', timeout: input.timeout_ms, maxBuffer: 256 * 1024 * 1024 });
    if (r.stdout) this.log(r.stdout.slice(-4000));
    if (r.stderr) this.log(r.stderr.slice(-4000));
    if (r.error) throw new Error(`container ${input.layer} could not run: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`container ${input.layer} exited ${r.status}`);
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')) as StageOutput;
    const known = new Set(input.subs.map(s => s.variant));
    for (const rec of out.records ?? []) {
      if (typeof rec.variant !== 'string' || !known.has(rec.variant)) throw new Error(`container ${input.layer} returned a record for an unrequested variant`);
    }
    return { records: out.records ?? [], outputs: out.outputs ?? [], summary: out.summary };
  }
}

function readJson(b64: string | undefined, file: string | undefined, what: string): unknown {
  if (b64) return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  throw new Error(`${what} missing`);
}

export async function proteinImpactExecCommand(opts: ProteinImpactExecOptions): Promise<void> {
  const jobId = opts.jobId || '';
  const creator = opts.creator || '';
  if (!jobId || !creator) { Logger.error('protein-impact exec needs --job-id and --creator'); process.exit(EXIT.GUARD); }

  const scratch = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || os.tmpdir();
  const work = opts.workDir || path.join(scratch, `protein-impact-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const logPath = path.join(work, 'run.log');
  const log = (m: string) => { Logger.info(m); try { fs.appendFileSync(logPath, m + '\n'); } catch (_) { /* log is best effort */ } };

  let request: unknown;
  let gate: unknown;
  try {
    request = readJson(opts.requestB64 || process.env.PROTEIN_IMPACT_REQUEST_B64, opts.requestFile, 'request');
    const gb = opts.gateB64 || process.env.PROTEIN_IMPACT_GATE_B64;
    if (gb || opts.gateFile) gate = readJson(gb, opts.gateFile, 'gate');
  } catch (e: any) {
    log(`[protein-impact] could not read the request: ${e.message}`);
    process.exit(EXIT.GUARD);
  }

  const lock = loadToolsLock();
  const deps: ExecDeps = {
    storage: opts.localRoot ? new LocalStorage(opts.localRoot) : new GcsStorage(),
    fetcher: new HttpFetcher(),
    runner: new DockerRunner(lock, log),
    log,
    lock,
  };
  const res = await runProteinImpact({
    jobId,
    creator,
    outBucket: opts.outBucket || 'genobank-parabricks-output',
    refBucket: opts.refBucket || 'genobank-references',
    request,
    gate,
    workDir: work,
  }, deps);
  process.exit(res.exit);
}
