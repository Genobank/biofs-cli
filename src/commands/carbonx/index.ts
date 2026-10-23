/**
 * biofs carbonx score <input_biocid> [--window 4096] [--max-vus 400] [--max-blb 300] [--plan-only] [--wait]
 * biofs carbonx status <carbonx_job_id> [--wait]
 *
 * CLIENT verb. Screens one biofile you own for variant pathogenicity with Carbon-X
 * (HuggingFaceBio/Carbon-X, a 14.8B DNA/text model served by vLLM on a GenoBank.io GPU VM).
 * Input is a biocid: a germline VCF (exome or genome, GRCh38 or GRCh37) or a SOMOS/23andMe
 * genotype file. biofs-node resolves it through biocid_registry and refuses it unless the
 * signer owns it. The executor keeps the alternate-allele calls that match a pinned ClinVar
 * release exactly, asks Carbon-X about each one without the gene name or the ClinVar label,
 * measures the answers against those labels, ranks the VUS, and registers a JSON and a
 * Markdown report as biocids (biodata_type carbonx-report) in the signer's biowallet.
 * No genomic bytes reach this machine. Research output, not a clinical test.
 */
import axios from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../../lib/auth/credentials';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface CarbonxScoreOptions {
  window?: string;
  maxPlp?: string;
  maxVus?: string;
  maxConflicting?: string;
  maxBlb?: string;
  planOnly?: boolean;
  noRationale?: boolean;
  label?: string;
  wait?: boolean;
  json?: boolean;
}

async function auth() {
  const credentials = await getCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "biofs login" first.');
  return {
    wallet: credentials.wallet_address,
    signature: credentials.user_signature,
    headers: { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature },
  };
}

async function fetchStatus(id: string, headers: Record<string, string>): Promise<any> {
  const r = await axios.get(`${BIOFS_NODE_BASE}/carbonx_status`, {
    params: { carbonx_job_id: id }, headers, timeout: 60_000, validateStatus: (s) => s < 500,
  });
  if (r.status >= 400) throw new Error(`status ${r.status}: ${r.data?.error || 'unknown'}`);
  return r.data;
}

function printSummary(row: any): void {
  console.log(`${chalk.cyan('Job:')}       ${row.carbonx_job_id}  ${row.status}${row.stage ? ` (${row.stage})` : ''}`);
  if (row.input_kind) console.log(`${chalk.cyan('Input:')}     ${row.input_biocid}  ${row.input_kind} ${row.build || ''}`);
  if (row.selection) console.log(`${chalk.cyan('Selection:')} ${JSON.stringify(row.selection)}`);
  if (row.progress) console.log(`${chalk.cyan('Progress:')}  ${row.progress.done}/${row.progress.total}`);
  if (row.summary) console.log(`${chalk.cyan('Summary:')}   ${JSON.stringify(row.summary)}`);
  for (const f of row.files || []) console.log(`${chalk.cyan('Report:')}    ${f.biocid}`);
  if (row.error) console.log(`${chalk.red('Error:')}     ${row.error}`);
}

async function waitFor(id: string, headers: Record<string, string>, json?: boolean): Promise<void> {
  let last = '';
  for (;;) {
    const row = await fetchStatus(id, headers);
    if (row.status === 'done' || row.status === 'failed') {
      if (json) console.log(JSON.stringify(row, null, 2)); else printSummary(row);
      if (row.status === 'failed') process.exit(1);
      return;
    }
    const line = `${row.stage || row.status} ${row.progress ? `${row.progress.done}/${row.progress.total}` : ''}`;
    if (!json && line !== last) { console.log(chalk.gray(`  ${line}`)); last = line; }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

export async function carbonxScoreCommand(inputBiocid: string, options: CarbonxScoreOptions): Promise<void> {
  if (!/^(biocid:\/\/|Biocid:)/.test(inputBiocid || '')) throw new Error('input must be a biocid');
  const a = await auth();
  const num = (v?: string) => (v === undefined ? undefined : Number(v));
  const body: Record<string, unknown> = {
    wallet: a.wallet, signature: a.signature, input_biocid: inputBiocid,
    window: num(options.window), max_plp: num(options.maxPlp), max_vus: num(options.maxVus),
    max_conflicting: num(options.maxConflicting), max_blb: num(options.maxBlb),
    plan_only: !!options.planOnly, verdict: !options.noRationale, label: options.label,
  };
  const r = await axios.post(`${BIOFS_NODE_BASE}/carbonx_score`, body, {
    headers: a.headers, timeout: 60_000, validateStatus: (s) => s < 500,
  });
  if (r.status >= 400) throw new Error(`carbonx_score ${r.status}: ${r.data?.error || 'unknown'}`);
  if (!options.json) console.log(`${chalk.green('submitted')} ${r.data.carbonx_job_id}`);
  if (options.wait) return waitFor(r.data.carbonx_job_id, a.headers, options.json);
  if (options.json) console.log(JSON.stringify(r.data, null, 2));
}

export async function carbonxStatusCommand(id: string, options: { wait?: boolean; json?: boolean }): Promise<void> {
  const a = await auth();
  if (options.wait) return waitFor(id, a.headers, options.json);
  const row = await fetchStatus(id, a.headers);
  if (options.json) console.log(JSON.stringify(row, null, 2)); else printSummary(row);
}

export async function carbonxReportCommand(id: string, options: { format?: string; out?: string }): Promise<void> {
  const a = await auth();
  const row = await fetchStatus(id, a.headers);
  if (row.status !== 'done') throw new Error(`job ${id} is ${row.status}${row.error ? `: ${row.error}` : ''}`);
  const ext = options.format === 'json' ? '.json' : '.md';
  const f = (row.files || []).find((x: any) => String(x.filename || '').endsWith(ext));
  if (!f) throw new Error(`job ${id} has no ${ext} report`);
  const r = await axios.get(`${BIOFS_NODE_BASE}/derived_read`, {
    params: { biocid: f.biocid }, headers: a.headers, timeout: 120_000,
    responseType: 'arraybuffer', validateStatus: (s) => s < 500,
  });
  if (r.status >= 400) throw new Error(`derived_read ${r.status}: ${Buffer.from(r.data).toString('utf8').slice(0, 200)}`);
  const body = Buffer.from(r.data);
  if (options.out) {
    const fs = await import('fs');
    fs.writeFileSync(options.out, body, { mode: 0o600 });
    console.log(`${chalk.green('saved')} ${options.out}  ${f.biocid}  sha256 ${r.headers['x-sha256']}`);
  } else {
    process.stdout.write(body.toString('utf8'));
  }
}
