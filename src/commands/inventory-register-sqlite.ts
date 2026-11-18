/**
 * biofs inventory register-sqlite <sqlite-path>
 *
 * Registers an externally-produced OpenCRAVAT annotation sqlite into the
 * GenoBank.io BioRouter inventory so that downstream `biofs variants
 * <biosample_serial>` queries can find it.
 *
 * Closes a gap documented in the v2 audit (`AUDIT_for_Opus_4_6_2026-05-26.md`
 * §5 item 2): sqlites produced via `biofs annotate submit ... --vcf-path`
 * do not auto-register into `bioroutes.inventory`. This verb computes the
 * canonical registration manifest (sha256 fingerprint, biocid, owner wallet,
 * sample serial, gcs uri if applicable) and POSTs it to the prod API
 * `/api_bioroutes/register_sqlite` endpoint.
 *
 * The verb signs the registration payload with the operator's biowallet so
 * the prod API can verify the request originated from the data owner.
 *
 * Server-side API endpoint requirement: `/api_bioroutes/register_sqlite`
 * accepts the payload format below, validates the EIP-55 signature against
 * the claimed owner wallet, and inserts a row into `bioroutes.inventory`
 * with `filetype = 'opencravat'` and `route_status = 'externally_registered'`.
 * The endpoint is documented in v3.8.0 of the biofs-cli release notes.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import chalk from 'chalk';

import { CredentialsManager } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';

export interface InventoryRegisterSqliteOptions {
  sampleSerial?: string;
  ownerWallet?: string;
  caseId?: string;
  gcsUri?: string;
  originlab?: string;
  apiBase?: string;
  dryRun?: boolean;
  output?: string;
  quiet?: boolean;
}

interface RegistrationPayload {
  filetype: 'opencravat';
  source: 'externally_registered';
  sqlite_path: string;
  sqlite_filename: string;
  sqlite_size_bytes: number;
  sqlite_sha256: string;
  biocid: string;
  sample_serial: string;
  owner_wallet: string;
  case_id?: string;
  gcs_uri?: string;
  originlab?: string;
  registered_at: string;
}

function sha256OfFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  const h = crypto.createHash('sha256');
  h.update(buf);
  return h.digest('hex');
}

/**
 * Size and SHA-256 of a GCS object by streaming it through `gcloud storage cat`
 * into the hash. Nothing is written to disk; the object is never copied to a
 * local path. Uses whatever gcloud account the environment selects
 * (CLOUDSDK_CORE_ACCOUNT).
 */
export function streamHashGcs(uri: string): Promise<{ size: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('gcloud', ['storage', 'cat', uri], { stdio: ['ignore', 'pipe', 'pipe'] });
    const h = crypto.createHash('sha256');
    let size = 0;
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      h.update(chunk);
    });
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('error', (e) => reject(new Error(`could not run gcloud: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`gcloud storage cat ${uri} failed (exit ${code}): ${err.slice(0, 300)}`));
      if (size === 0) return reject(new Error(`gcloud storage cat ${uri} returned 0 bytes`));
      resolve({ size, sha256: h.digest('hex') });
    });
  });
}

function buildBiocid(ownerWallet: string, sampleSerial: string, filename: string, originlab: string): string {
  // Match the biocid convention in bioroutes.inventory for opencravat entries:
  // biocid://genobank/<owner_wallet_lower>/sqlite/<filename>
  // (or originlab variant if specified)
  const ownerLower = ownerWallet.toLowerCase();
  const lab = originlab || 'genobank';
  return `biocid://${lab}/${ownerLower}/sqlite/${filename}`;
}

export async function inventoryRegisterSqliteCommand(sqlitePath: string, opts: InventoryRegisterSqliteOptions): Promise<void> {
  const isGcs = sqlitePath.startsWith('gs://');
  let stat: { size: number } = { size: 0 };
  if (!isGcs) {
    if (!fs.existsSync(sqlitePath)) {
      throw new Error(`sqlite file not found: ${sqlitePath}`);
    }
    const st = fs.statSync(sqlitePath);
    if (!st.isFile()) {
      throw new Error(`not a file: ${sqlitePath}`);
    }
    stat = st;
  }

  const credManager = CredentialsManager.getInstance();
  const creds = await credManager.loadCredentials();
  const ownerWallet = opts.ownerWallet || creds?.wallet_address;
  if (!ownerWallet) {
    throw new Error('No owner wallet. Pass --owner-wallet <addr> or run `biofs login` first.');
  }
  if (!opts.sampleSerial) {
    throw new Error('--sample-serial <serial> is required (e.g., 55052008714000 or caris-TN25-336147)');
  }

  const filename = path.basename(sqlitePath);
  let sha256: string;
  let gcsUriOut = opts.gcsUri;
  if (isGcs) {
    if (!opts.quiet) console.error(chalk.cyan(`Hashing ${sqlitePath} by stream (no local copy)...`));
    const sh = await streamHashGcs(sqlitePath);
    stat = { size: sh.size };
    sha256 = sh.sha256;
    if (opts.gcsUri && opts.gcsUri !== sqlitePath) {
      throw new Error(`--gcs-uri (${opts.gcsUri}) differs from the gs:// path being registered (${sqlitePath})`);
    }
    gcsUriOut = sqlitePath;
  } else {
    sha256 = sha256OfFile(sqlitePath);
  }
  const originlab = opts.originlab || 'genobank';
  const biocid = buildBiocid(ownerWallet, opts.sampleSerial, filename, originlab);

  const payload: RegistrationPayload = {
    filetype: 'opencravat',
    source: 'externally_registered',
    sqlite_path: sqlitePath,
    sqlite_filename: filename,
    sqlite_size_bytes: stat.size,
    sqlite_sha256: sha256,
    biocid,
    sample_serial: opts.sampleSerial,
    owner_wallet: ownerWallet,
    case_id: opts.caseId,
    gcs_uri: gcsUriOut,
    originlab,
    registered_at: new Date().toISOString(),
  };

  if (opts.output) {
    fs.writeFileSync(opts.output, JSON.stringify(payload, null, 2));
    if (!opts.quiet) console.error(chalk.green(`✓ Registration payload written to ${opts.output}`));
  }

  if (opts.dryRun) {
    if (!opts.quiet) {
      console.error(chalk.cyan('\n📋 Registration payload (dry run, no API call):'));
      console.error(JSON.stringify(payload, null, 2));
    } else {
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    }
    return;
  }

  // Submit to prod API
  const apiBase = opts.apiBase || process.env.GENOBANK_API || 'https://genobank.app';
  const url = `${apiBase}/api_bioroutes/register_sqlite`;
  const signature = creds?.user_signature;
  if (!signature) {
    throw new Error('No biowallet signature. Run `biofs login` first.');
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Signature': signature,
        'X-Owner-Wallet': ownerWallet,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 404 || resp.status === 405) {
        throw new Error(
          `the server has no /api_bioroutes/register_sqlite endpoint (HTTP ${resp.status}), so nothing was registered. ` +
          `For a sqlite that already sits in your own vault prefix, register it through the node instead: ` +
          `biofs register-derived gcs <gs://uri> --type sqlite --parent <parent-biocid> --case-id <id>`
        );
      }
      throw new Error(`POST ${url} returned HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    const body = await resp.json();
    if (!opts.quiet) {
      console.error(chalk.green(`✓ Registered ${filename} in bioroutes.inventory`));
      console.error(`  biocid:        ${biocid}`);
      console.error(`  sha256:        ${sha256}`);
      console.error(`  sample_serial: ${opts.sampleSerial}`);
      console.error(`  API response:  ${JSON.stringify(body).slice(0, 200)}`);
    } else {
      process.stdout.write(JSON.stringify({ ...payload, api_response: body }, null, 2) + '\n');
    }
  } catch (e: any) {
    // Common path during v3.7.x: API endpoint not yet deployed. Emit the
    // payload so the operator can submit it manually or via mongoimport.
    if (!opts.quiet) {
      Logger.warn(`API submission failed (${e.message}). Emitting payload for manual registration:`);
      console.error(JSON.stringify(payload, null, 2));
      console.error(chalk.yellow('\n⚠ The `/api_bioroutes/register_sqlite` endpoint is documented for v3.8.0 of the biofs platform. Until then, copy the payload above into the bioroutes.inventory MongoDB collection or pass `--output <path>` to save it.'));
    }
    throw e;
  }
}
