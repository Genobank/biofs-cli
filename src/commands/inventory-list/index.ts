/**
 * biofs inventory-list (--serial <s...> | --lab <name>) [--type <t...>] [--limit n] [--json]
 *
 * NODE OPERATOR verb, read-only. Lists the file rows of bioroutes.inventory for given sample serials or one lab (never the whole inventory), so a pipeline can name its inputs by
 * biocid. Copies of one file in several buckets are grouped. A thin client: biofs-node (POST /agent/inventory_list) checks the signer is a node operator and reads the table.
 */
import axios from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../../lib/auth/credentials';
import { nodeErrorMessage } from '../../lib/utils/node_roles';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface InventoryListOptions {
  serial?: string[];
  lab?: string;
  type?: string[];
  limit?: string;
  json?: boolean;
}

export interface InventoryRow {
  biocid: string | null; sample_serial: string | null; filetype: string | null; owner_wallet: string | null; originlab: string | null;
  bucket: string | null; object: string | null; size: number | null; hierarchy_role: string | null; orphan_status: string | null;
}

export function buildInventoryListBody(options: InventoryListOptions): Record<string, unknown> {
  const serials = options.serial || [];
  if (!serials.length && !options.lab) throw new Error('give --serial <serial...> or --lab <name> (the whole inventory is never listed)');
  const body: Record<string, unknown> = { serials, types: (options.type || []).map((t) => t.toLowerCase()) };
  if (options.lab) body.lab = options.lab;
  if (options.limit !== undefined) {
    const n = parseInt(options.limit, 10);
    if (!Number.isFinite(n) || n < 1) throw new Error('--limit must be a positive number');
    body.limit = n;
  }
  return body;
}

/** One line per distinct file (serial, type, object name); the number of copies and the distinct buckets are kept. */
export function groupRows(rows: InventoryRow[]): Array<{ serial: string; type: string; name: string; size: number | null; owner: string | null; copies: number; buckets: string[]; biocids: string[] }> {
  const m = new Map<string, { serial: string; type: string; name: string; size: number | null; owner: string | null; copies: number; buckets: string[]; biocids: string[] }>();
  for (const r of rows) {
    const name = (r.object || '').split('/').pop() || '';
    const key = `${r.sample_serial}|${r.filetype}|${name}|${r.size}`;
    let g = m.get(key);
    if (!g) { g = { serial: r.sample_serial || '', type: r.filetype || '', name, size: r.size, owner: r.owner_wallet, copies: 0, buckets: [], biocids: [] }; m.set(key, g); }
    g.copies += 1;
    if (r.bucket && !g.buckets.includes(r.bucket)) g.buckets.push(r.bucket);
    if (r.biocid) g.biocids.push(r.biocid);
  }
  return [...m.values()].sort((a, b) => (a.serial + a.type + a.name).localeCompare(b.serial + b.type + b.name));
}

export async function inventoryListCommand(options: InventoryListOptions): Promise<void> {
  const body = buildInventoryListBody(options);
  const credentials = await getCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
  const headers = { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature };
  const r = await axios.post(`${BIOFS_NODE_BASE}/inventory_list`, body, { headers, timeout: 60_000, validateStatus: (s) => s < 500 });
  if (r.status >= 400) throw new Error(nodeErrorMessage(r.status, r.data?.error));
  if (options.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
  const groups = groupRows(r.data.rows as InventoryRow[]);
  for (const g of groups) {
    console.log(`${chalk.bold(g.serial)}  ${g.type.padEnd(8)} ${g.name}  ${g.size ?? '?'} bytes  owner ${g.owner}  ${g.copies} cop${g.copies === 1 ? 'y' : 'ies'} in ${g.buckets.join(', ')}`);
  }
  console.log(chalk.gray(`${r.data.count} rows, ${groups.length} distinct files${r.data.truncated ? ' (truncated: raise --limit)' : ''}. Use --json for the biocids.`));
}
