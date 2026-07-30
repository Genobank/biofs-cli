/**
 * biofs fluency build <biocid>
 * biofs fluency state <biocid>
 *
 * Make a genomics store CONVERSABLE, and report whether it is.
 *
 * A raw annotated sqlite answers "anything pathogenic in HNF1B?" only by scanning
 * millions of rows and streaming a page of variant records back. `fluency build`
 * dispatches through biofs-node to precompute the rollups that collapse that to a
 * single indexed row: per-contig coverage, and per-gene counts with pathogenic/likely
 * kept SEPARATE from conflicting classifications.
 *
 * The derivative is registered to the DATA OWNER in biocid_registry with
 * parent_biocid lineage and erase_with_parent, so the transformation is auditable and
 * disappears with its parent under GDPR Art. 17. Bytes are written server-side; only
 * the biocid ever crosses this boundary.
 *
 * Idempotent: an existing valid artifact is adopted rather than rebuilt.
 */
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface FluencyOptions { json?: boolean; quiet?: boolean; }

interface FluencyResp {
  verb?: string;
  biocid?: string;
  sidecar_key?: string;
  state?: 'fresh' | 'building' | 'absent' | string;
  sidecar_present?: boolean;
  meta_fresh?: boolean;
  build_in_flight?: boolean;
  registration_repaired?: boolean | null;
  schema_version?: number;
  note?: string;
  error?: string;
}

function requireBiocid(biocid: string): void {
  if (!biocid || !biocid.startsWith('biocid://')) {
    Logger.error('a biocid:// reference is required (biodata is addressed by biocid, never by a storage path)');
    process.exit(1);
  }
}

function renderState(d: FluencyResp): void {
  const s = String(d.state || 'unknown');
  const colour = s === 'fresh' ? chalk.green : s === 'building' ? chalk.yellow : chalk.red;
  console.log(`  state          ${colour(s)}`);
  if (d.sidecar_present !== undefined) console.log(`  artifact       ${d.sidecar_present ? 'present' : 'absent'}`);
  if (d.meta_fresh !== undefined) console.log(`  freshness      ${d.meta_fresh ? 'current' : 'stale/unknown'}`);
  if (d.build_in_flight) console.log(chalk.gray('  a build is in flight (liveness confirmed by heartbeat)'));
  if (d.registration_repaired) console.log(chalk.gray('  registration repaired in place (no rebuild)'));
  if (d.schema_version !== undefined) console.log(chalk.gray(`  schema         v${d.schema_version}`));
}

export async function fluencyBuildCommand(biocid: string, options: FluencyOptions = {}): Promise<void> {
  requireBiocid(biocid);
  const spinner = options.quiet || options.json ? null : ora('biofs fluency build → biofs-node').start();
  try {
    const c = await getCredentials();
    if (!c) { spinner?.fail('Not authenticated. Run: biofs login'); process.exit(1); }
    // Never echo user_signature: it is a long-lived bearer credential over biology.
    const body = { wallet: c.wallet_address, signature: c.user_signature, biocid };
    const r = await axios.post<FluencyResp>(`${BIOFS_NODE_BASE}/fluency_build`, body,
      { timeout: 120_000, validateStatus: (s) => s < 500 });
    if (r.status >= 400) {
      spinner?.fail(`fluency_build ${r.status}: ${r.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(r.data, null, 2));
      process.exit(1);
    }
    const d = r.data;
    spinner?.succeed(d.state === 'fresh' ? 'store is fluent' : 'build dispatched');
    if (options.json) { console.log(JSON.stringify(d, null, 2)); return; }
    renderState(d);
    if (d.note) console.log(chalk.gray(`  ${d.note}`));
    if (d.state !== 'fresh') {
      console.log(chalk.gray(`  poll with: biofs fluency state ${biocid}`));
    }
  } catch (error) {
    spinner?.fail(`fluency build failed: ${error}`);
    process.exit(1);
  }
}

export async function fluencyStateCommand(biocid: string, options: FluencyOptions = {}): Promise<void> {
  requireBiocid(biocid);
  const spinner = options.quiet || options.json ? null : ora('biofs fluency state → biofs-node').start();
  try {
    const c = await getCredentials();
    if (!c) { spinner?.fail('Not authenticated. Run: biofs login'); process.exit(1); }
    const r = await axios.get<FluencyResp>(`${BIOFS_NODE_BASE}/fluency_state`, {
      params: { wallet: c.wallet_address, signature: c.user_signature, biocid },
      timeout: 60_000, validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) {
      spinner?.fail(`fluency_state ${r.status}: ${r.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(r.data, null, 2));
      process.exit(1);
    }
    spinner?.succeed('fluency state');
    if (options.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
    renderState(r.data);
  } catch (error) {
    spinner?.fail(`fluency state failed: ${error}`);
    process.exit(1);
  }
}
