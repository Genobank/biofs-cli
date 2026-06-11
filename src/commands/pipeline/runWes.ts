/**
 * biofs pipeline run-wes <biosample_serial>
 *
 * Spawns the Python orchestrator (pipeline_run_wes.py) and streams its
 * JSON-line progress events to the terminal as a live phase-by-phase
 * report. The Python side does all heavy lifting; this TS shim just
 * handles auth, argument forwarding, and pretty-printing.
 *
 * The orchestrator must be available on PATH or at one of the search
 * locations. On the production API host it lives at
 * /home/ubuntu/bioroutes_dryrun/pipeline_run_wes.py. On a developer
 * Mac with biorouter-contracts checked out at the canonical path, it
 * lives under scripts/bioroutes/.
 */

import chalk from 'chalk';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface PipelineRunWesOptions {
  mode?: 'WES' | 'WGS';
  bed?: string;
  watch?: boolean;
  dryRun?: boolean;
  skipTwin?: boolean;
  phase?: string;
  runId?: string;
  remote?: boolean;     // SSH to prod and run there (default true on dev Mac)
  mongoUri?: string;
  json?: boolean;
}

const REMOTE_HOST = 'genobank-production';
const REMOTE_ZONE = 'us-central1-a';
const REMOTE_ORCH = '/home/ubuntu/bioroutes_dryrun/pipeline_run_wes.py';

const LOCAL_CANDIDATES = [
  path.resolve(os.homedir(), 'Downloads/biorouter-contracts/scripts/bioroutes/pipeline_run_wes.py'),
  '/home/ubuntu/bioroutes_dryrun/pipeline_run_wes.py',
  path.resolve(__dirname, '../../../../biorouter-contracts/scripts/bioroutes/pipeline_run_wes.py'),
];


function locateLocalOrchestrator(): string | null {
  for (const p of LOCAL_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return null;
}


function buildArgs(serial: string, opts: PipelineRunWesOptions): string[] {
  const args: string[] = [serial];
  if (opts.mode) args.push('--mode', opts.mode);
  if (opts.bed) args.push('--bed', opts.bed);
  if (opts.watch) args.push('--watch');
  if (opts.dryRun) args.push('--dry-run');
  if (opts.skipTwin) args.push('--skip-twin');
  if (opts.phase) args.push('--phase', opts.phase);
  if (opts.runId) args.push('--run-id', opts.runId);
  if (opts.mongoUri) args.push('--mongo-uri', opts.mongoUri);
  // Always emit JSON-line events from the Python orchestrator so the TS shim
  // can parse + pretty-print them. The shim re-renders these for the user;
  // when --json is passed it forwards the raw lines instead.
  args.push('--json');
  return args;
}


/**
 * Render a single JSON-line event as a colorized one-liner. Returns the
 * raw object too so the caller can collect summary stats.
 */
function renderEvent(line: string, jsonOnly: boolean): { event: string; phase?: number; obj: any } {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    if (!jsonOnly) process.stderr.write(line + '\n');
    return { event: 'unparsed', obj: { raw: line } };
  }
  if (jsonOnly) {
    process.stdout.write(line + '\n');
    return { event: obj.event, phase: obj.phase, obj };
  }

  const phaseLabel = obj.phase !== undefined ? chalk.gray(`[${obj.phase}]`) : '';
  switch (obj.event) {
    case 'run_started':
      console.log(chalk.cyan('▶ run started'),
        chalk.gray(`run_id=${obj.run_id} biosample=${obj.biosample_serial}${obj.fresh ? ' (fresh)' : ' (resumed)'}`));
      break;
    case 'phase_started':
      console.log(chalk.blue('  ⋯'), phaseLabel, chalk.white(obj.name || ''));
      break;
    case 'phase_done':
      console.log(chalk.green('  ✓'), phaseLabel, chalk.white(obj.name || ''),
        chalk.gray(summarizeResult(obj.name, obj.result)));
      break;
    case 'phase_skipped':
      console.log(chalk.gray('  ↷'), phaseLabel, chalk.gray(`${obj.name} (already complete)`));
      break;
    case 'phase_failed':
      console.log(chalk.red('  ✗'), phaseLabel, chalk.red(obj.name || ''), chalk.red(obj.error || ''));
      break;
    case 'phase_dry_run':
      console.log(chalk.yellow('  …'), phaseLabel, chalk.yellow(`${obj.name} (dry-run)`));
      break;
    case 'run_done':
      console.log(chalk.green.bold('✔ run complete'), chalk.gray(`run_id=${obj.run_id}`));
      break;
    case 'fatal':
      console.error(chalk.red.bold('FATAL:'), chalk.red(obj.error || ''));
      break;
    case 'parabricks_started':
    case 'parabricks_running':
    case 'cravat_submitting':
    case 'vault_ingesting':
    case 'vm_starting':
      console.log(chalk.gray('    ·'), chalk.gray(obj.event), chalk.gray(JSON.stringify(obj).slice(0, 200)));
      break;
    default:
      console.log(chalk.gray('    ·'), chalk.gray(obj.event || '?'), chalk.gray(JSON.stringify(obj).slice(0, 160)));
  }
  return { event: obj.event, phase: obj.phase, obj };
}


function summarizeResult(name: string, result: any): string {
  if (!result || typeof result !== 'object') return '';
  if (name === 'resolve') {
    return `${result.originlab || ''} customer=${(result.customer_owner_wallet || '').slice(0, 10)}…`;
  }
  if (name === 'locate_fastq') {
    return `${result.bucket}/…  ${(result.total_size_gb || 0).toFixed(2)}GB`;
  }
  if (name === 'detect_mode') {
    return `${result.mode} (source: ${result.source})`;
  }
  if (name === 'wake_gpu') {
    return result.started ? `instance=${result.instance} (started)` : `instance=${result.instance} (already running)`;
  }
  if (name === 'parabricks') {
    return `gvcf=${(result.gvcf_uri || '').slice(0, 60)}…`;
  }
  if (name === 'mint_children') {
    return `children=${(result.children || []).length} parent=${(result.parent_biocid || '').slice(0, 50)}…`;
  }
  if (name === 'recovery_fp') {
    return `${result.snp_count_present}/96 partial=${result.partial_96} ${(result.fingerprint_hex || '').slice(0, 14)}…`;
  }
  if (name === 'recovery_queue') {
    return result.queued ? 'queued' : `skipped (${result.reason})`;
  }
  if (name === 'submit_cravat') {
    return `oc_job=${result.opencravat_job_id} pkg=${result.package}`;
  }
  if (name === 'wait_sqlite') {
    return `${result.sqlite_uri}`.slice(0, 80);
  }
  if (name === 'mint_grandchild') {
    return `${(result.sqlite_biocid || '').slice(0, 60)}…`;
  }
  if (name === 'ingest_vault') {
    return `agent_id=${result.agent_id} variants=${result.n_variants ?? '?'} chunks=${result.n_chunks ?? '?'}`;
  }
  if (name === 'render_twin') {
    return `${result.url}`;
  }
  if (name === 'notify_customer') {
    return `${result.twin_url}`;
  }
  if (name === 'stop_gpu') {
    return result.stopped ? 'stopped' : (result.already_stopped ? 'already stopped' : 'stop failed');
  }
  return JSON.stringify(result).slice(0, 80);
}


export async function pipelineRunWesCommand(
  biosampleSerial: string,
  options: PipelineRunWesOptions = {},
): Promise<number> {
  // Decide local vs remote. Default: if local file exists, run locally;
  // else SSH to prod. --remote forces SSH even if local exists.
  const localOrch = locateLocalOrchestrator();
  const useRemote = options.remote || !localOrch;

  if (!options.json) {
    console.log(chalk.cyan('\n🧬 BioFS Pipeline — FASTQ → Digital Twin'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(`  biosample: ${chalk.white(biosampleSerial)}`);
    console.log(`  mode:      ${chalk.white(options.mode || 'auto-detect')}`);
    console.log(`  phases:    ${chalk.white(options.phase || '1-10')}`);
    console.log(`  exec:      ${chalk.white(useRemote ? `ssh ${REMOTE_HOST}` : `local (${localOrch})`)}`);
    console.log(chalk.gray('─'.repeat(60)) + '\n');
  }

  const argsForPython = buildArgs(biosampleSerial, options);

  let command: string;
  let cmdArgs: string[];
  if (useRemote) {
    // Run on the production host via gcloud compute ssh
    // -u: unbuffered stdout/stderr so JSON events stream live over SSH pipes
    // (without -u, Python block-buffers stdout when stdout is a pipe and we'd
    // see nothing until the process exits or the buffer fills ~4KB).
    const remoteCmd = ['sudo', '-u', 'ubuntu', 'python3.12', '-u', REMOTE_ORCH, ...argsForPython].join(' ');
    command = 'gcloud';
    // --tunnel-through-iap: the prod VM is reachable only via IAP (no public SSH).
    cmdArgs = ['compute', 'ssh', REMOTE_HOST, `--zone=${REMOTE_ZONE}`, '--tunnel-through-iap', '--', remoteCmd];
  } else {
    command = 'python3';
    cmdArgs = [localOrch as string, ...argsForPython];
  }

  return new Promise<number>((resolve) => {
    const child = spawn(command, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) renderEvent(line, !!options.json);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (!options.json) process.stderr.write(chalk.gray(chunk.toString('utf8')));
    });
    child.on('close', (code) => {
      if (buf.trim()) renderEvent(buf.trim(), !!options.json);
      const rc = code ?? 1;
      if (!options.json) {
        if (rc === 0) {
          console.log(chalk.green.bold('\n✔ pipeline complete'));
        } else {
          console.log(chalk.red.bold(`\n✗ pipeline exited with code ${rc}`));
        }
      }
      resolve(rc);
    });
    child.on('error', (err) => {
      Logger.error(`pipeline spawn failed: ${err.message}`);
      resolve(2);
    });
  });
}
