/**
 * biofs route — diagnostics + healing for BioRouter mount routes.
 *
 *   biofs route check <serial...>
 *       Resolve every route for the given biosample(s) from bioroutes.inventory
 *       and report per-file status (canonical mount path, expected size, OK /
 *       MISSING / SIZE_MISMATCH). Read-only — never mounts anything.
 *
 *   biofs route heal <node> <serial...>
 *       Same resolution, then ensure every required bucket is mounted on the
 *       target node (parabricks-gpu-spot, genobank-production, etc.) via
 *       gcsfuse. Idempotent. Refreshes legacy /gcsmnt/{input,output,ref,t2t}
 *       symlinks for back-compat.
 *
 * Both subcommands shell out to route_mount.py on the production host —
 * bioroutes.inventory and the SSH key to the GPU live there.
 */

import chalk from 'chalk';
import { spawn } from 'child_process';
import { Logger } from '../../lib/utils/logger';

const REMOTE_HOST = 'genobank-production';
const REMOTE_ZONE = 'us-central1-a';
const REMOTE_RESOLVER = '/home/ubuntu/bioroutes_dryrun/route_mount.py';
const REMOTE_PY = '/home/ubuntu/Genobank_APIs/production_api/plugins/genoclaw/.venv/bin/python3';


function runRemote(scriptArgs: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const cmd = ['compute', 'ssh', REMOTE_HOST,
      `--zone=${REMOTE_ZONE}`, '--tunnel-through-iap',
      '--command', [REMOTE_PY, REMOTE_RESOLVER, ...scriptArgs].join(' '),
    ];
    const proc = spawn('gcloud', cmd);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d); });
    proc.stderr.on('data', (d) => { err += d.toString(); process.stderr.write(d); });
    proc.on('close', (code) => resolve({ code: code ?? 0, out, err }));
  });
}


export interface RouteCheckOptions { json?: boolean; }
export interface RouteHealOptions { node?: string; json?: boolean; }


export async function routeCheckCommand(serials: string[], opts: RouteCheckOptions = {}) {
  if (serials.length === 0) {
    Logger.error('Provide at least one biosample serial.');
    process.exit(2);
  }
  if (!opts.json) {
    console.log(chalk.cyan(`\n🔍 biofs route check — ${serials.length} biosample(s)\n`));
  }
  const res = await runRemote(['check', ...serials]);
  process.exit(res.code);
}


export async function routeHealCommand(serials: string[], opts: RouteHealOptions = {}) {
  if (serials.length === 0) {
    Logger.error('Provide at least one biosample serial.');
    process.exit(2);
  }
  // route_mount.heal command reads SSH_TARGET from env. By default we heal the
  // GPU instance (parabricks-gpu-spot) via its internal IP — the production
  // host already has the right SSH key. Use --node to override.
  const node = opts.node || 'parabricks-gpu-spot@10.128.0.7';
  if (!opts.json) {
    console.log(chalk.cyan(`\n🩺 biofs route heal — ${serials.length} biosample(s) on ${node}\n`));
  }
  // We need to pass SSH_TARGET as env to the remote python invocation.
  const cmdInline = `SSH_TARGET=danieluribe@${node.split('@').pop()} ${REMOTE_PY} ${REMOTE_RESOLVER} heal ${serials.join(' ')}`;
  const proc = spawn('gcloud', [
    'compute', 'ssh', REMOTE_HOST,
    `--zone=${REMOTE_ZONE}`, '--tunnel-through-iap',
    '--command', cmdInline,
  ]);
  let code = 0;
  proc.stdout.on('data', (d) => process.stdout.write(d));
  proc.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise<void>((res) => { proc.on('close', (c) => { code = c ?? 0; res(); }); });
  process.exit(code);
}
