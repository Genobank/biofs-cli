/**
 * biofs manifest — the aggregate collection manifest a consortium member publishes.
 *
 * The only artifact that crosses a member's perimeter: counts by biodata type, category,
 * assay and reference build, provenance months, conditions of use (DUO codes) and Passport
 * requirements. Never a sample, file, token, storage, owner, or record identifier; the node
 * refuses to build one that would carry any of those.
 *
 * Protocol surface (biofs-node):
 *   POST /agent/manifest/publish   (NODE_ADMIN signature: the principal investigator)
 *   GET  /agent/manifest           (public: the published aggregate)
 */
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';

const BIOFS_NODE_BASE =
  process.env.BIOFS_NODE_URL ||
  `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface ManifestOptions {
  json?: boolean;
  quiet?: boolean;
  institution?: string;
  labId?: string;
  contact?: string;
  conditions?: string;
  passport?: string;
  minCell?: string;
  node?: string;
}

function nodeBase(o: ManifestOptions): string {
  return (o.node || BIOFS_NODE_BASE).replace(/\/$/, '');
}

function splitList(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

function printManifest(m: Record<string, unknown>): void {
  const totals = (m.totals || {}) as Record<string, unknown>;
  const prov = (m.provenance || {}) as Record<string, unknown>;
  console.log(chalk.bold(`\nCollection manifest: ${String(m.institution || '')}`));
  console.log(`  version        ${String(m.manifest_version || '')}`);
  console.log(`  generated      ${String(m.generated_at || '')}`);
  console.log(`  biofiles       ${String(totals.biofiles ?? '')}`);
  console.log(`  data subjects  ${String(totals.data_subjects ?? '')}`);
  const table = (label: string, obj: unknown) => {
    const entries = Object.entries((obj || {}) as Record<string, unknown>);
    if (!entries.length) return;
    console.log(`  ${label}`);
    for (const [k, v] of entries) console.log(`    ${k.padEnd(18)} ${String(v)}`);
  };
  table('by biodata type', m.counts_by_biodata_type);
  table('by data category', m.counts_by_data_category);
  table('by assay', m.counts_by_assay);
  table('by reference build', m.counts_by_reference_build);
  console.log(`  provenance     ${String((prov.origin_labs as string[] | undefined || []).join(', '))}  ${String(prov.earliest_month || '')} to ${String(prov.latest_month || '')}`);
  console.log(`  conditions     ${String(((m.conditions_of_use as string[] | undefined) || []).join(', ') || 'none declared')}`);
  console.log(`  passport       ${String(((m.passport_requirements as string[] | undefined) || []).join('; '))}`);
  console.log(`  sha256         ${String(m.sha256 || '')}\n`);
}

/** Publish the aggregate collection manifest of this node (principal investigator only). */
export async function manifestPublishCommand(o: ManifestOptions): Promise<void> {
  const credentials = await getCredentials();
  if (!credentials) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }
  const body: Record<string, unknown> = {
    signature: credentials.user_signature,
    institution: o.institution,
    lab_id: o.labId,
    contact: o.contact,
    conditions_of_use: splitList(o.conditions),
    passport_requirements: splitList(o.passport),
  };
  if (o.minCell && /^\d+$/.test(o.minCell)) body.min_cell = parseInt(o.minCell, 10);
  const spinner = o.quiet ? null : ora('Building the aggregate manifest on the node').start();
  try {
    // The node's operator gate reads X-Biofs-Wallet and X-Biofs-Signature; the body signature is the NODE_ADMIN check.
    const r = await axios.post(`${nodeBase(o)}/manifest/publish`, body, {
      timeout: 120000,
      headers: { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature },
    });
    spinner?.succeed('Manifest published');
    const m = (r.data && r.data.manifest) || r.data;
    if (o.json) console.log(JSON.stringify(m, null, 2));
    else printManifest(m);
  } catch (e: unknown) {
    spinner?.fail('Publish failed');
    const err = e as { response?: { status?: number; data?: { error?: string } }; message?: string };
    const detail = err.response?.data?.error || err.message || String(e);
    Logger.error(`${err.response?.status ? `HTTP ${err.response.status}: ` : ''}${detail}`);
    process.exit(1);
  }
}

/** Show the manifest a node has published. Public; no login needed. */
export async function manifestShowCommand(o: ManifestOptions): Promise<void> {
  try {
    const r = await axios.get(`${nodeBase(o)}/manifest`, { timeout: 30000 });
    if (o.json) console.log(JSON.stringify(r.data, null, 2));
    else printManifest(r.data);
  } catch (e: unknown) {
    const err = e as { response?: { status?: number; data?: { error?: string } }; message?: string };
    const detail = err.response?.data?.error || err.message || String(e);
    Logger.error(`${err.response?.status ? `HTTP ${err.response.status}: ` : ''}${detail}`);
    process.exit(1);
  }
}
