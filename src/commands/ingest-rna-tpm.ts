/**
 * biofs ingest rna-tpm <case-id>
 *
 * Canonical wrapper for ingesting a gene-level RNA TPM CSV from a lab partner
 * (Caris Life Sciences, AUGenomics, in-house RNA-seq pipelines) into the
 * GenoBank.io `caris_rna_tpm` MongoDB collection for downstream cohort
 * analysis and the Laplace-domain interpretation of §4.3 of the v3 paper.
 *
 * Closes a gap documented in the v2 audit (`AUDIT_for_Opus_4_6_2026-05-26.md`
 * §5 item 4): RNA TPM ingestion is currently performed as a one-off Python
 * gcsfuse + mongoimport command on prod. This verb is the thin client that
 * dispatches that ingestion through the canonical biofs-cli + biofs-node
 * protocol.
 *
 * Server-side API endpoint requirement: `/api_bioroutes/ingest_rna_tpm`
 * accepts the parameters below, mounts the source GCS path via gcsfuse,
 * streams the CSV, bulk-inserts into `caris_rna_tpm`. The endpoint is
 * documented in v3.8.0 of the biofs-cli release notes.
 */

import * as fs from 'fs';
import chalk from 'chalk';

import { CredentialsManager } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';

export interface IngestRnaTpmOptions {
  biocid?: string;
  gcsPath?: string;
  ownerWallet?: string;
  sourceLab?: string;
  dataCategory?: string;
  expectedColumns?: string;       // default 'Gene,TPM,NumReads'
  dropZeroTpm?: boolean;          // default true
  apiBase?: string;
  dryRun?: boolean;
  quiet?: boolean;
}

interface IngestPayload {
  case_id: string;
  biocid?: string;
  gcs_path?: string;
  owner_wallet: string;
  source_lab: string;
  data_category: string;
  expected_columns: string[];
  drop_zero_tpm: boolean;
  requested_at: string;
}

export async function ingestRnaTpmCommand(caseId: string, opts: IngestRnaTpmOptions): Promise<void> {
  if (!caseId) throw new Error('<case-id> is required (e.g., TN25-336147)');
  if (!opts.biocid && !opts.gcsPath) {
    throw new Error('Either --biocid <id> or --gcs-path <gs://...> is required to locate the RNA TPM CSV');
  }

  const credManager = CredentialsManager.getInstance();
  const creds = await credManager.loadCredentials();
  const ownerWallet = opts.ownerWallet || creds?.wallet_address;
  if (!ownerWallet) {
    throw new Error('No owner wallet. Pass --owner-wallet <addr> or run `biofs login` first.');
  }

  const payload: IngestPayload = {
    case_id: caseId,
    biocid: opts.biocid,
    gcs_path: opts.gcsPath,
    owner_wallet: ownerWallet,
    source_lab: opts.sourceLab || 'unknown',
    data_category: opts.dataCategory || 'rna',
    expected_columns: (opts.expectedColumns || 'Gene,TPM,NumReads').split(','),
    drop_zero_tpm: opts.dropZeroTpm !== false,
    requested_at: new Date().toISOString(),
  };

  if (opts.dryRun) {
    if (!opts.quiet) {
      console.error(chalk.cyan('\n📋 Ingest payload (dry run, no API call):'));
      console.error(JSON.stringify(payload, null, 2));
    } else {
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    }
    return;
  }

  const apiBase = opts.apiBase || process.env.GENOBANK_API || 'https://genobank.app';
  const url = `${apiBase}/api_bioroutes/ingest_rna_tpm`;
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
      throw new Error(`POST ${url} returned HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    const body: any = await resp.json();
    if (!opts.quiet) {
      console.error(chalk.green(`✓ Ingested RNA TPM for case ${caseId}`));
      console.error(`  case_id:        ${caseId}`);
      console.error(`  source_lab:     ${payload.source_lab}`);
      console.error(`  expected cols:  ${payload.expected_columns.join(',')}`);
      console.error(`  rows ingested:  ${body.n_rows_ingested ?? 'unknown'}`);
      console.error(`  zero-TPM dropped: ${body.n_zero_dropped ?? 'unknown'}`);
    } else {
      process.stdout.write(JSON.stringify(body, null, 2) + '\n');
    }
  } catch (e: any) {
    if (!opts.quiet) {
      Logger.warn(`API submission failed (${e.message}). Emitting payload:`);
      console.error(JSON.stringify(payload, null, 2));
      console.error(chalk.yellow('\n⚠ The `/api_bioroutes/ingest_rna_tpm` endpoint is documented for v3.8.0 of the biofs platform.'));
    }
    throw e;
  }
}
