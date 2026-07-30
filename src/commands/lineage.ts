/**
 * biofs lineage <biocid>
 *
 * Report the biodata METAMORPHOSIS for any biocid: what it was derived from, what has
 * been derived from it, who owns each piece, and what erases with what.
 *
 * This is the differentiator made inspectable. A derivative (an indexed sidecar, a
 * fluency rollup, an annotated sqlite) is not an untracked by-product: it is registered
 * to the DATA OWNER in biocid_registry, carries parent_biocid, records what transformed
 * it, and inherits its parent's consent so a revocation reaches it.
 *
 * Storage paths are deliberately absent from the output. Biodata is addressed by
 * biocid; a gs:// path handed to a human is an ungated, unrevocable bearer reference.
 * Where a stored field does not contain a biocid, it is reported as a data defect
 * rather than echoed.
 */
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface LineageOptions { json?: boolean; quiet?: boolean; }

interface Unresolved { unresolved: boolean; reason?: string; }
type BiocidRef = string | Unresolved | null;

interface Node {
  biocid?: BiocidRef;
  source?: string;
  role?: string;
  biodata_type?: string;
  owner_wallet?: string | null;
  parent_biocid?: BiocidRef;
  derived_by?: string | null;
  derivation?: string | null;
  consent_status?: string | null;
  erase_with_parent?: boolean | null;
  size_bytes?: number | null;
  note?: string;
}

interface LineageResp {
  verb?: string;
  subject?: Node;
  derived_from?: Node[];
  derivatives?: Node[];
  counts?: { ancestors?: number; derivatives?: number };
  note?: string;
  error?: string;
}

function ref(v: BiocidRef | undefined): string {
  if (!v) return chalk.gray('(none)');
  if (typeof v === 'string') return v;
  return chalk.red(`(unresolved: ${v.reason || 'not a biocid'})`);
}

function human(bytes?: number | null): string {
  if (!bytes) return '';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function printNode(n: Node, indent: string): void {
  console.log(`${indent}${chalk.bold(ref(n.biocid))}`);
  const bits: string[] = [];
  if (n.biodata_type) bits.push(n.biodata_type);
  if (n.role) bits.push(n.role);
  if (n.size_bytes) bits.push(human(n.size_bytes));
  if (bits.length) console.log(`${indent}  ${chalk.gray(bits.join(' · '))}`);
  if (n.owner_wallet) console.log(`${indent}  owner        ${n.owner_wallet}`);
  else console.log(`${indent}  owner        ${chalk.red('UNSET — an unowned derivative cannot be consent-gated or erased')}`);
  if (n.consent_status !== undefined && n.consent_status !== null) console.log(`${indent}  consent      ${n.consent_status}`);
  if (n.derived_by) console.log(`${indent}  derived by   ${n.derived_by}`);
  if (n.derivation) console.log(`${indent}  ${chalk.gray(n.derivation)}`);
  if (n.erase_with_parent) console.log(`${indent}  ${chalk.green('erases with its parent')}`);
  if (n.note) console.log(`${indent}  ${chalk.yellow(n.note)}`);
}

export async function lineageCommand(biocid: string, options: LineageOptions = {}): Promise<void> {
  if (!biocid || !biocid.startsWith('biocid://')) {
    Logger.error('a biocid:// reference is required (biodata is addressed by biocid, never by a storage path)');
    process.exit(1);
  }
  const spinner = options.quiet || options.json ? null : ora('biofs lineage → biofs-node').start();
  try {
    const c = await getCredentials();
    if (!c) { spinner?.fail('Not authenticated. Run: biofs login'); process.exit(1); }
    const r = await axios.get<LineageResp>(`${BIOFS_NODE_BASE}/lineage`, {
      params: { wallet: c.wallet_address, signature: c.user_signature, biocid },
      timeout: 60_000, validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) {
      spinner?.fail(`lineage ${r.status}: ${r.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(r.data, null, 2));
      process.exit(1);
    }
    const d = r.data;
    spinner?.succeed(`lineage: ${d.counts?.ancestors ?? 0} ancestor(s), ${d.counts?.derivatives ?? 0} derivative(s)`);
    if (options.json) { console.log(JSON.stringify(d, null, 2)); return; }

    if (d.derived_from?.length) {
      console.log(chalk.cyan('\n  derived from'));
      d.derived_from.forEach((n) => printNode(n, '    '));
    }
    if (d.subject) {
      console.log(chalk.cyan('\n  this biodata'));
      printNode(d.subject, '    ');
    }
    if (d.derivatives?.length) {
      console.log(chalk.cyan('\n  derivatives (owned by the patient, erase with the parent)'));
      d.derivatives.forEach((n) => printNode(n, '    '));
    } else {
      console.log(chalk.gray('\n  no derivatives yet — try: biofs fluency build <biocid>'));
    }
    if (d.note) console.log(chalk.gray(`\n  ${d.note}`));
  } catch (error) {
    spinner?.fail(`lineage failed: ${error}`);
    process.exit(1);
  }
}
