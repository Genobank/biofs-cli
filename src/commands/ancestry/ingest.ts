/**
 * biofs ancestry ingest <file> --biowallet <address>
 *
 * Ingest a consumer DTC genotype (23andMe / AncestryDNA / MyHeritage / generic
 * tab-delimited, optionally zipped) into the SOMOS vault so that
 * `biofs ancestry somos <serial>` can resolve it.
 *
 * Dispatched through biofs-node (never a direct curl, never a one-off script):
 * the bytes are POSTed as application/octet-stream to
 * POST /agent/ancestry_ingest, which spawns dtc_ingest_exec.py. That executor
 * writes the object to the SOMOS vault bucket, derives a content-addressed
 * serial, and registers it into biocid_registry + bioroutes.inventory +
 * dtc_custodian_index.
 *
 * The serial is derived from the object path, which embeds sha256(bytes), so
 * re-ingesting identical bytes for the same owner is idempotent: it returns the
 * same serial rather than minting an orphan registration.
 *
 * --biowallet is the DATA OWNER (a custodial biowallet minted with
 * `biofs biowallet create`). The operator's own wallet/signature still
 * authenticate the call. Omit it only when ingesting your own genotype.
 *
 *   biofs biowallet create --label somos-dtc
 *   biofs ancestry ingest ./genome.txt --biowallet 0xAbC… --wait
 *   biofs ancestry somos DTC-5212746ceaa9 --biowallet 0xAbC… --wait
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

// biofs-node streams the body straight to disk, but nginx caps the server block
// at 200M and Cloudflare at 100M. Refuse early with a clear message rather than
// letting the proxy return an opaque 413.
const MAX_INGEST_BYTES = 90 * 1024 * 1024;

export interface AncestryIngestOptions {
  biowallet?: string;
  wait?: boolean;
  quiet?: boolean;
  json?: boolean;
}

interface SubmitResponse {
  ingest_job_id: string;
  status: string;
  error?: string;
}

interface StatusResponse {
  ingest_job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  serial?: string;
  biocid?: string;
  gs_uri?: string;
  bytes?: number;
  deduplicated?: boolean;   // true when these bytes were already in the vault
  error?: string;
}

export async function ancestryIngestCommand(
  filePath: string,
  options: AncestryIngestOptions = {},
): Promise<string | null> {
  const spinner = options.quiet || options.json ? null
    : ora(`biofs ancestry ingest ${path.basename(filePath)} → biofs-node`).start();
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      spinner?.fail(`File not found: ${filePath}`);
      process.exit(1);
    }
    const size = fs.statSync(filePath).size;
    if (size > MAX_INGEST_BYTES) {
      spinner?.fail(`File is ${(size / 1e6).toFixed(1)} MB; the ingest endpoint accepts up to ${MAX_INGEST_BYTES / 1e6} MB.`);
      process.exit(1);
    }

    const credentials = await getCredentials();
    if (!credentials) {
      spinner?.fail('Not authenticated. Run: biofs login');
      process.exit(1);
    }

    const owner = options.biowallet || credentials.wallet_address;
    const body = fs.readFileSync(filePath);

    if (spinner) spinner.text = `uploading ${(size / 1e6).toFixed(1)} MB → /agent/ancestry_ingest …`;
    const submitResp = await axios.post<SubmitResponse>(
      `${BIOFS_NODE_BASE}/ancestry_ingest`,
      body,
      {
        timeout: 300_000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: (s) => s < 500,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': path.basename(filePath),
          'X-Owner-Biowallet': owner,
          'X-Wallet': credentials.wallet_address,
          'X-Signature': credentials.user_signature,
        },
      },
    );
    if (submitResp.status >= 400) {
      spinner?.fail(`ancestry ingest ${submitResp.status}: ${submitResp.data?.error || 'unknown'}`);
      if (options.json) console.log(JSON.stringify(submitResp.data, null, 2));
      return null;
    }
    const submit = submitResp.data;
    spinner?.succeed(`ingest_job_id=${submit.ingest_job_id}`);
    if (!options.quiet && !options.json && options.biowallet) {
      console.log(chalk.gray(`  owner biowallet: ${owner}`));
    }

    if (options.json && !options.wait) console.log(JSON.stringify(submit, null, 2));

    if (options.wait) {
      const waitSpin = options.quiet ? null
        : ora(`registering genotype (ingest_job_id=${submit.ingest_job_id}) …`).start();
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5_000));
        const st = await axios.get<StatusResponse>(
          `${BIOFS_NODE_BASE}/ancestry_ingest_status`,
          { params: { ingest_job_id: submit.ingest_job_id }, timeout: 30_000, validateStatus: (s) => s < 500 },
        );
        if (st.status === 404) continue;
        const row = st.data;
        if (row.status === 'done') {
          waitSpin?.succeed(`registered ${row.serial}`);
          if (options.json) {
            console.log(JSON.stringify(row, null, 2));
          } else {
            console.log(chalk.cyan(`  serial: ${row.serial}`));
            if (row.biocid) console.log(chalk.gray(`  biocid: ${row.biocid}`));
            if (row.gs_uri) console.log(chalk.gray(`  object: ${row.gs_uri}`));
            if (row.deduplicated) console.log(chalk.yellow('  these bytes were already in the vault; returned the existing serial'));
            console.log(chalk.gray(`  next:   biofs ancestry somos ${row.serial}`
              + (options.biowallet ? ` --biowallet ${owner}` : '') + ' --wait'));
          }
          return row.serial || null;
        }
        if (row.status === 'failed') {
          waitSpin?.fail(`ingest failed: ${row.error || 'no error reported'}`);
          if (options.json) console.log(JSON.stringify(row, null, 2));
          return null;
        }
        if (waitSpin) waitSpin.text = `ingest ${row.status} (ingest_job_id=${submit.ingest_job_id})`;
      }
      waitSpin?.warn('wait timeout — the executor may still be running');
    }

    return null;
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err);
    spinner?.fail(`ancestry ingest failed: ${msg}`);
    Logger.error(`ancestry ingest failed: ${msg}`);
    return null;
  }
}
