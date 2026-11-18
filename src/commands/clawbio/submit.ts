/**
 * biofs clawbio submit <biosample_serial>
 *
 * Independent consensus: ClawBio (Ensembl VEP REST + ClinVar + gnomAD) and
 * EVEE (Evo 2 foundation model) run on biofs-node. The genome stays on the
 * server. Only a small candidate allele list (rare coding / seed LoF) is
 * annotated. Research output is registered as a clinical-report biocid.
 *
 *   BIOFS_PROFILE=mva-custodian biofs clawbio submit EX2312012 --wait
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface ClawbioSubmitOptions {
  owner?: string;
  sqliteBiocid?: string;
  candidatesJson?: string;
  maxCandidates?: string;
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

const MVA_GENES = new Set([
  'BUB1B', 'BUB1', 'CEP57', 'TRIP13', 'CDC20', 'MAD1L1', 'MAD2L1', 'CENPE', 'KNL1',
]);
const LOF_SO = new Set(['STG', 'FSD', 'FSI', 'SPL', 'SSL', 'STL', 'SPL5', 'SPL3']);

interface SubmitResponse {
  clawbio_job_id?: string;
  status?: string;
  error?: string;
}

interface StatusResponse {
  clawbio_job_id: string;
  status: string;
  files?: Array<{ filename: string; biocid: string; gs_uri: string }>;
  summary?: Record<string, unknown>;
  error?: string;
  n_candidates?: number;
}

function defaultAcmgPath(): string {
  return path.join(os.homedir(), '.biofs', 'cases', 'MV26-000001',
    'proband-MV26-000001__clinical_acmg.json');
}

function extractCandidatesFromAcmg(acmgPath: string): unknown[] {
  if (!fs.existsSync(acmgPath)) return [];
  const data = JSON.parse(fs.readFileSync(acmgPath, 'utf8'));
  const variants = Array.isArray(data?.variants) ? data.variants : [];
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const v of variants) {
    const gene = String(v.gene || '');
    const so = String(v.so || '');
    const sig = String(v.clinvar_sig || '');
    const cls = String(v.classification || '');
    const keep = LOF_SO.has(so)
      || (MVA_GENES.has(gene) && (so === 'MIS' || LOF_SO.has(so)))
      || cls === 'Pathogenic' || cls === 'Likely Pathogenic'
      || (/athogenic/i.test(sig) && !/enign/i.test(sig) && !/onflict/i.test(sig));
    if (!keep || v.pos == null) continue;
    const key = `${v.chrom}:${v.pos}:${v.ref}:${v.alt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      chrom: v.chrom, pos: v.pos, ref: v.ref, alt: v.alt, gene,
      so, clinvar_id: v.clinvar_id || '', hgvs_p: v.achange || '',
      source: 'acmg_json',
    });
  }
  return out;
}

export async function clawbioSubmitCommand(
  serial: string,
  options: ClawbioSubmitOptions = {},
): Promise<string | null> {
  const spinner = options.quiet || options.json ? null
    : ora('biofs clawbio submit → biofs-node (ClawBio VEP + EVEE)').start();
  try {
    if (!serial || serial.toUpperCase() === 'UNKNOWN') {
      spinner?.fail('serial is required and must not be UNKNOWN');
      process.exit(1);
    }
    const credentials = await getCredentials();
    if (!credentials) {
      spinner?.fail('Not authenticated. Run: biofs login --wallet <addr> --signature <sig>');
      process.exit(1);
    }
    const owner = options.owner || credentials.wallet_address;
    if (!/^0x[a-fA-F0-9]{40}$/.test(owner)) {
      spinner?.fail('--owner must be an EIP-55 biowallet');
      process.exit(1);
    }

    let candidates: unknown[] = [];
    if (options.candidatesJson && fs.existsSync(options.candidatesJson)) {
      const raw = JSON.parse(fs.readFileSync(options.candidatesJson, 'utf8'));
      candidates = Array.isArray(raw) ? raw : (raw.candidates || raw.variants || []);
    } else {
      candidates = extractCandidatesFromAcmg(defaultAcmgPath());
    }

    const body: Record<string, unknown> = {
      wallet: credentials.wallet_address,
      signature: credentials.user_signature,
      owner,
      serial: serial.trim(),
      case_id: 'MV26-000001',
      originlab: 'mva-hackathon',
      candidates,
      max_candidates: Number(options.maxCandidates || 80),
    };
    if (options.sqliteBiocid) body.sqlite_biocid = options.sqliteBiocid;

    if (spinner) spinner.text = `submitting ${candidates.length} candidates to /agent/submit_clawbio ...`;
    const submitResp = await axios.post<SubmitResponse>(
      `${BIOFS_NODE_BASE}/submit_clawbio`,
      body,
      { timeout: 60_000, validateStatus: (s) => s < 500 },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`submit_clawbio ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const submit = submitResp.data;
    spinner?.succeed(`clawbio_job_id=${submit.clawbio_job_id} status=${submit.status}`);
    if (options.json && !options.wait) console.log(JSON.stringify(submit, null, 2));

    if (options.wait && submit.clawbio_job_id) {
      const waitSpin = options.quiet ? null
        : ora(`waiting for ClawBio+EVEE (${submit.clawbio_job_id}) ...`).start();
      const deadline = Date.now() + 45 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10_000));
        const st = await axios.get<StatusResponse>(
          `${BIOFS_NODE_BASE}/clawbio_status`,
          { params: { clawbio_job_id: submit.clawbio_job_id }, timeout: 30_000, validateStatus: (s) => s < 500 },
        );
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          waitSpin?.succeed(`consensus done — ${(row.files || []).length} reports registered`);
          if (!options.quiet && row.files) {
            for (const f of row.files) console.log(chalk.gray(`  ${f.biocid}`));
          }
          if (!options.quiet && row.summary) {
            console.log(chalk.gray('  summary: ' + JSON.stringify(row.summary).slice(0, 500)));
          }
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.clawbio_job_id;
        }
        if (row.status === 'failed') {
          waitSpin?.fail(`clawbio error: ${row.error || 'unknown'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return submit.clawbio_job_id;
        }
        if (waitSpin) waitSpin.text = `consensus ${row.status} n=${row.n_candidates ?? '?'} (${submit.clawbio_job_id})`;
      }
      waitSpin?.warn('wait timeout — poll: biofs clawbio status ' + submit.clawbio_job_id);
    }
    return submit.clawbio_job_id || null;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`clawbio submit failed: ${msg}`);
    Logger.error(`clawbio submit failed: ${msg}`);
    return null;
  }
}

export async function clawbioStatusCommand(jobId: string, options: { json?: boolean } = {}): Promise<void> {
  const st = await axios.get<StatusResponse>(
    `${BIOFS_NODE_BASE}/clawbio_status`,
    { params: { clawbio_job_id: jobId }, timeout: 30_000, validateStatus: (s) => s < 500 },
  );
  if (options.json || st.status >= 400) {
    console.log(JSON.stringify(st.data, null, 2));
    return;
  }
  const row = st.data;
  console.log(`${row.clawbio_job_id}  ${row.status}`);
  if (row.error) console.log(chalk.red(row.error));
  if (row.files) for (const f of row.files) console.log('  ' + f.biocid);
  if (row.summary) console.log(JSON.stringify(row.summary, null, 2));
}
