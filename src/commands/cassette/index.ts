/**
 * biofs cassette audit|simulate [biosample_serial]
 *
 * Audit a Cancer Digital Twin against the Nonprovisional 2 cassette inputs
 * and simulate de novo CD8 probability. Default is local (cassette_sim.py).
 * --remote posts to biofs-node POST /agent/cassette.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface CassetteOptions {
  wallet?: string;
  remote?: boolean;
  json?: boolean;
  html?: string;
  min?: string;
  max?: string;
}

function findSim(): string {
  const candidates = [
    process.env.CASSETTE_SIM,
    path.resolve(__dirname, '../../../../biofs-node/cassette/cassette_sim.py'),
    path.resolve(process.cwd(), 'biofs-node/cassette/cassette_sim.py'),
    '/opt/biofs-node-v0.4/cassette/cassette_sim.py',
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('cassette_sim.py not found; set CASSETTE_SIM');
}

export async function cassetteCommand(
  mode: 'audit' | 'simulate' | 'all',
  serial: string,
  options: CassetteOptions = {},
): Promise<void> {
  if (options.remote) {
    const credentials = await getCredentials();
    if (!credentials) {
      Logger.error('Not authenticated. Run: biofs login');
      process.exit(1);
    }
    const body = {
      mode,
      biosample_serial: serial,
      wallet: options.wallet || credentials.wallet_address,
      signature: credentials.user_signature,
      n_min: parseInt(options.min || '4', 10),
      n_max: parseInt(options.max || '8', 10),
    };
    const r = await axios.post(`${BIOFS_NODE_BASE}/cassette`, body, {
      timeout: 60_000,
      validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) {
      Logger.error(`cassette ${r.status}: ${r.data?.error || 'unknown'}`);
      process.exit(1);
    }
    if (options.json) console.log(JSON.stringify(r.data, null, 2));
    else console.log(chalk.green(`cassette_job_id=${r.data.cassette_job_id} status=${r.data.status}`));
    return;
  }

  const py = findSim();
  const args = ['--mode', mode, '--case-id', serial];
  if (options.wallet) args.push('--wallet', options.wallet);
  if (options.min) args.push('--min', options.min);
  if (options.max) args.push('--max', options.max);
  if (options.html) args.push('--html-out', options.html);
  const run = spawnSync('python3', [py, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (run.status !== 0) {
    Logger.error(run.stderr || `cassette_sim exited ${run.status}`);
    process.exit(run.status || 1);
  }
  if (options.json || !options.html) process.stdout.write(run.stdout);
  else {
    const doc = JSON.parse(run.stdout);
    console.log(chalk.bold(`cassette ${mode} ${serial}`));
    console.log(`  rnas: ${doc.simulation?.n_rnas ?? 'n/a'}`);
    console.log(`  html: ${options.html}`);
    if (doc.simulation?.P_blood_denovo_CD8_vaccine_naive) {
      const p = doc.simulation.P_blood_denovo_CD8_vaccine_naive;
      console.log(`  P(blood CD8 naive) mid=${p.mid} range=${p.low}..${p.high}`);
    }
  }
}
