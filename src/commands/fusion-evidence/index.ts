/**
 * biofs fusion-evidence submit --five-exon chr:s-e --three-exon chr:s-e [--rna <biocid>] [--tumor <biocid> --normal <biocid>]
 * biofs fusion-evidence status <fusion_job_id> [--wait]
 *
 * CLIENT verb. Tests one candidate fusion transcript (a 5' partner exon donor joined to a 3'
 * partner exon acceptor) on the server, against the caller's own data:
 *   RNA     every read of the RNA BAM, mapped and unmapped, searched for the exact exon-exon
 *           junction and for the two canonical junctions it competes with;
 *   DNA CN  tumor vs matched-normal read depth across the segment a genomic rearrangement
 *           would change, with the step at each breakpoint intron;
 *   DNA SV  discordant pairs and split reads joining the two breakpoint introns.
 * Inputs are biocids; biofs-node resolves them through biocid_registry and refuses any it
 * does not find owned by the signer. No read leaves the server. The result is registered as
 * its own biocid (biodata_type fusion_evidence) in the signer's biowallet.
 */
import axios from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface FusionSubmitOptions {
  fiveExon: string;
  threeExon: string;
  fiveNextExon?: string;
  threePrevExon?: string;
  fiveStrand?: string;
  threeStrand?: string;
  rna?: string;
  tumor?: string;
  normal?: string;
  extraDna?: string[];
  dnaJunction?: string;
  rnaBuild?: string;
  dnaBuild?: string;
  label?: string;
  caseId?: string;
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
  const r = await axios.get(`${BIOFS_NODE_BASE}/fusion_evidence_status`, {
    params: { fusion_job_id: id }, headers, timeout: 60_000, validateStatus: (s) => s < 500,
  });
  if (r.status >= 400) throw new Error(`status ${r.status}: ${r.data?.error || 'unknown'}`);
  return r.data;
}

function printSummary(row: any): void {
  console.log(`${chalk.cyan('Job:')}     ${row.fusion_job_id}  ${row.status}`);
  if (row.progress) console.log(`${chalk.cyan('Progress:')} ${JSON.stringify(row.progress)}`);
  if (row.summary) console.log(`${chalk.cyan('Summary:')}  ${JSON.stringify(row.summary)}`);
  if (row.result_biocid) console.log(`${chalk.cyan('Result:')}   ${row.result_biocid}`);
  if (row.error) console.log(`${chalk.red('Error:')}    ${row.error}`);
}

async function waitFor(id: string, headers: Record<string, string>, json?: boolean): Promise<void> {
  for (;;) {
    const row = await fetchStatus(id, headers);
    if (row.status === 'done' || row.status === 'failed') {
      if (json) console.log(JSON.stringify(row, null, 2)); else printSummary(row);
      if (row.status === 'failed') process.exit(1);
      return;
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

export async function fusionEvidenceSubmitCommand(options: FusionSubmitOptions): Promise<void> {
  try {
    const a = await auth();
    if (!options.rna && !(options.tumor && options.normal)) {
      throw new Error('give --rna and/or both --tumor and --normal');
    }
    const body = {
      wallet: a.wallet,
      signature: a.signature,
      five_exon: options.fiveExon,
      three_exon: options.threeExon,
      five_next_exon: options.fiveNextExon || '',
      three_prev_exon: options.threePrevExon || '',
      five_strand: options.fiveStrand || '+',
      three_strand: options.threeStrand || '+',
      rna_biocid: options.rna || '',
      tumor_biocid: options.tumor || '',
      normal_biocid: options.normal || '',
      extra_dna_biocid: options.extraDna || [],
      dna_junction: options.dnaJunction || '',
      rna_build: options.rnaBuild || 'hg38',
      dna_build: options.dnaBuild || 'hs37d5',
      label: options.label || '',
      case_id: options.caseId || '',
    };
    const r = await axios.post(`${BIOFS_NODE_BASE}/fusion_evidence`, body, {
      headers: a.headers, timeout: 60_000, validateStatus: (s) => s < 500,
    });
    if (r.status >= 400) throw new Error(`${r.status}: ${r.data?.error || 'unknown'}`);
    const id = r.data.fusion_job_id;
    if (!options.wait) {
      if (options.json) console.log(JSON.stringify(r.data, null, 2));
      else {
        console.log(chalk.green(`fusion_job_id=${id} status=${r.data.status}`));
        console.log(chalk.gray('Monitor: ') + chalk.cyan(`biofs fusion-evidence status ${id} --wait`));
      }
      return;
    }
    await waitFor(id, a.headers, options.json);
  } catch (e: any) {
    Logger.error(`fusion-evidence submit failed: ${e.message}`);
    process.exit(1);
  }
}

export async function fusionEvidenceStatusCommand(id: string, options: { wait?: boolean; json?: boolean }): Promise<void> {
  try {
    const a = await auth();
    if (options.wait) return await waitFor(id, a.headers, options.json);
    const row = await fetchStatus(id, a.headers);
    if (options.json) console.log(JSON.stringify(row, null, 2)); else printSummary(row);
  } catch (e: any) {
    Logger.error(`fusion-evidence status failed: ${e.message}`);
    process.exit(1);
  }
}
