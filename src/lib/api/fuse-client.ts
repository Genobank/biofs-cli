/**
 * BioFS FUSE API Client
 *
 * Client for interacting with BioFS FUSE API for BioNFT-gated file access
 */

import axios from 'axios';
import { API_CONFIG } from '../config/constants';
import { Logger } from '../utils/logger';

export interface FuseBiosample {
  biosample_serial: string;
  granted_at: string;
  operations: string[];
  tx_hash: string;
  block_number: number;
}

export interface FuseDiscoverResponse {
  wallet: string;
  biosamples: FuseBiosample[];
  count: number;
}

export interface FuseListResponse {
  biosample: string;
  files: string[];
  count: number;
  source: string;
}

export interface FuseIndexStats {
  status: string;
  total_files: number;
  biosamples_count: number;
  biosamples: string[];
  bucket: string;
  prefix: string;
}

export interface FuseVariantRow {
  base__hugo?: string | null;
  base__chrom?: string | null;
  base__pos?: number | null;
  base__ref_base?: string | null;
  base__alt_base?: string | null;
  base__so?: string | null;
  base__cchange?: string | null;
  base__achange?: string | null;
  clinvar__sig?: string | null;
  clinvar__id?: string | null;
  alphamissense__am_pathogenicity?: number | null;
  revel__score?: number | null;
  gnomad3__af?: number | null;
  acmg_evidence_stack?: Array<{ code: string; weight: string; rationale: string }>;
  [key: string]: unknown;
}

export interface FuseVariantsResponse {
  biosample: string;
  job_id: string | null;
  biocid: string | null;
  gs_uri: string | null;
  columns: string[];
  count: number;
  rows: FuseVariantRow[];
  methodology?: string | null;
  // Genomi -> biofs Campaign B: typed honesty contract, present when the prod
  // analyzer is envelope-aware. A zero `count` is NOT a clinical negative unless
  // evidence_envelope.negative_inference_permitted === true.
  evidence_envelope?: Record<string, unknown> | null;
}

export interface FuseQuerySubmitResponse {
  query_job_id?: string;
  status?: string;
  joined?: boolean;
  fallback?: boolean; // set by the client when the prod endpoint is absent (old prod)
  error?: string;
}

/**
 * Consent-gated arbitrary read-only SQL over an NFT-gated queryable-biodata
 * sqlite. `rows` are arrays aligned to `columns` (unlike variants(), which
 * returns dict rows). `tables` is present when the request was schema=true.
 */
export interface FuseQueryResponse {
  biocid: string | null;
  biosample: string | null;
  job_id: string | null;
  gs_uri: string | null;
  columns: string[];
  count: number;
  truncated?: boolean;
  elapsed_ms?: number;
  rows: unknown[][];
  tables?: string[];
  methodology?: string | null;
  error?: string;
}

export interface FuseCohortAcmgPerSerial {
  status: 'ok' | 'no_annotation' | 'failed';
  error?: string;
  job_id?: string | null;
  biocid?: string | null;
  n_clinvar_p_lp_findings?: number;
  findings?: FuseVariantRow[];
}

export interface FuseCohortAcmgResponse {
  cohort_size: number;
  ok: number;
  no_annotation: number;
  failed: number;
  total_findings: number;
  results: Record<string, FuseCohortAcmgPerSerial>;
  methodology?: string;
}

/**
 * Cosic-RRM per-variant scored row (cohort-fourier-score output).
 * Mirrors the single-variant `biofs fourier-score --consensus-fc` summary
 * fields plus the source-variant identifiers needed for downstream joins.
 */
export interface FuseFourierVariantRow {
  // Source variant identifiers
  gene?: string | null;
  chrom?: string | null;
  pos?: number | null;
  ref?: string | null;
  alt?: string | null;
  cdna?: string | null;
  protein?: string | null;        // e.g. p.Val779Ala
  uniprot?: string | null;
  // Variant context
  so?: string | null;
  clinvar_significance?: string | null;
  clinvar_id?: string | null;
  alphamissense?: number | null;
  revel?: number | null;
  gnomad3_af?: number | null;
  // Cosic-RRM spectral metrics
  eiip_delta?: number | null;            // |EIIP(alt) - EIIP(ref)|
  window_size?: number | null;           // 31 default, 51 if TM-overlap
  window_sum_abs_df?: number | null;     // Σ|ΔF|(k≥1) in the centered window
  window_delta_energy_pct?: number | null;  // % energy change in the window
  full_spectrum_l1?: number | null;      // L1 distance across all bins, full protein
  fc_period_aa?: number | null;          // family characteristic period (aa per cycle)
  fc_snr?: number | null;                // consensus SNR (σ above background)
  fc_ratio_mw?: number | null;           // |X_MT(f_c)| / |X_WT(f_c)|
  fc_delta_energy_pct?: number | null;   // % energy change at f_c
  weighted_agg_delta_energy_pct?: number | null;  // weighted across top peaks
  fc_cache_hit?: boolean | null;         // true if the gene's consensus was cached
  scoring_status?: string | null;        // 'ok' | 'no_consensus' | 'parse_error' | etc.
  [key: string]: unknown;
}

export interface FuseCohortFourierPerSerial {
  status: 'ok' | 'no_annotation' | 'failed';
  error?: string;
  job_id?: string | null;
  biocid?: string | null;
  n_variants_scored?: number;
  variants?: FuseFourierVariantRow[];
}

export interface FuseCohortFourierResponse {
  cohort_size: number;
  ok: number;
  no_annotation: number;
  failed: number;
  total_variants_scored: number;
  results: Record<string, FuseCohortFourierPerSerial>;
  methodology?: string;
}

export class FuseAPIClient {
  private baseUrl: string;

  constructor() {
    // Construct full URL: base API + FUSE endpoint
    this.baseUrl = `${API_CONFIG.base}${API_CONFIG.fuse}`;
  }

  /**
   * Discover all biosamples accessible to a wallet
   */
  async discover(wallet: string, signature: string): Promise<FuseDiscoverResponse> {
    try {
      const response = await axios.get(`${this.baseUrl}/discover`, {
        params: { wallet, signature }
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 403) {
        throw new Error('Invalid signature or no BioNFT consent found');
      }
      throw new Error(`FUSE API discover failed: ${error.message}`);
    }
  }

  /**
   * List files in a biosample
   */
  async list(
    biosample: string,
    wallet: string,
    signature: string,
    rebuildIndex: boolean = false
  ): Promise<FuseListResponse> {
    try {
      const response = await axios.get(`${this.baseUrl}/list`, {
        params: {
          biosample,
          wallet,
          signature,
          rebuild_index: rebuildIndex
        }
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 403) {
        throw new Error('BioNFT consent required for this biosample');
      }
      throw new Error(`FUSE API list failed: ${error.message}`);
    }
  }

  /**
   * Rebuild S3 file index (admin)
   */
  async rebuildIndex(): Promise<FuseIndexStats> {
    try {
      const response = await axios.get(`${this.baseUrl}/rebuild_index`);
      return response.data;
    } catch (error: any) {
      throw new Error(`FUSE API rebuild_index failed: ${error.message}`);
    }
  }

  /**
   * Query variants from an NFT-gated OpenCRAVAT sqlite, server-side.
   * No genomic bytes touch the client; only filtered rows transit.
   * Replaces the legacy local-cache + `gcloud storage cp` approach.
   */
  async variants(
    biosample: string,
    wallet: string,
    signature: string,
    opts: {
      gene?: string;
      region?: string;
      so?: string;
      maxAf?: string;
      clinvar?: string;
      columns?: string;
      limit?: number | string;
      jobId?: string;
      withAcmg?: boolean;
    } = {}
  ): Promise<FuseVariantsResponse> {
    try {
      const params: Record<string, string> = { biosample, wallet, signature };
      if (opts.gene) params.gene = opts.gene;
      if (opts.region) params.region = opts.region;
      if (opts.so) params.so = opts.so;
      if (opts.maxAf !== undefined) params.max_af = String(opts.maxAf);
      if (opts.clinvar) params.clinvar = opts.clinvar;
      if (opts.columns) params.columns = opts.columns;
      if (opts.limit !== undefined) params.limit = String(opts.limit);
      if (opts.jobId) params.job_id = opts.jobId;
      if (opts.withAcmg) params.with_acmg = 'true';
      // Hard deadline via AbortController. Server-side sqlite queries against
      // gcsfuse-mounted 100-MB+ OpenCRAVAT databases can take 2-3 min when
      // doing a full-table ClinVar scan (no index on clinvar__sig). 240 s
      // leaves headroom but still bails on truly stuck calls.
      const TIMEOUT_MS = 240_000;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await axios.get(`${this.baseUrl}/variants`, {
          params,
          timeout: TIMEOUT_MS,
          signal: controller.signal,
        });
        return response.data;
      } finally {
        clearTimeout(t);
      }
    } catch (error: any) {
      if (error.code === 'ERR_CANCELED' || error.name === 'CanceledError') {
        throw new Error('variants API timeout after 240 s (server-side sqlite scan timeout)');
      }
      const status = error.response?.status;
      const serverMsg = error.response?.data?.error;
      if (status === 403) throw new Error(serverMsg || 'BioNFT consent / signature rejected');
      if (status === 404) throw new Error(serverMsg || 'No OpenCRAVAT sqlite registered for this biosample');
      if (status === 503) throw new Error(serverMsg || 'Sqlite path not mounted on prod (transient — try again)');
      throw new Error(`variants API failed: ${serverMsg || error.message}`);
    }
  }

  /**
   * Consent-gated, read-only SQL query over an NFT-gated queryable-biodata
   * sqlite (an OpenCRAVAT-annotated VCF). The agent sends a biocid (or
   * biosample) + a single SELECT; the sqlite never leaves the prod gcsfuse
   * mount and only result rows transit. The server enforces a SQLite authorizer
   * (writes / ATTACH / PRAGMA-writes / extensions / multi-statement are
   * rejected) plus a row cap and time budget. Pass `schema=true` to introspect
   * the tables instead of running a query. This is the Phase-1 flagship of the
   * BioFS consented query surface over queryable biodata.
   */
  async query(
    ref: { biocid?: string; biosample?: string },
    sql: string | null,
    wallet: string,
    signature: string,
    opts: { schema?: boolean; rowCap?: number | string; timeoutMs?: number | string; jobId?: string } = {},
  ): Promise<FuseQueryResponse> {
    try {
      const params: Record<string, string> = { wallet, signature };
      if (ref.biocid) params.biocid = ref.biocid;
      if (ref.biosample) params.biosample = ref.biosample;
      if (sql) params.sql = sql;
      if (opts.schema) params.schema = 'true';
      if (opts.rowCap !== undefined) params.row_cap = String(opts.rowCap);
      if (opts.timeoutMs !== undefined) params.timeout_ms = String(opts.timeoutMs);
      if (opts.jobId) params.job_id = opts.jobId;
      // Cold OpenCRAVAT sqlite scans over gcsfuse can take minutes; match the
      // variants() budget so a legitimate full-table scan is not cut short.
      const TIMEOUT_MS = 240_000;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await axios.get(`${this.baseUrl}/query`, {
          params,
          timeout: TIMEOUT_MS,
          signal: controller.signal,
        });
        return response.data;
      } finally {
        clearTimeout(t);
      }
    } catch (error: any) {
      if (error.code === 'ERR_CANCELED' || error.name === 'CanceledError') {
        throw new Error('query API timeout after 240 s (server-side sqlite scan timeout)');
      }
      const status = error.response?.status;
      const serverMsg = error.response?.data?.error;
      if (status === 400) throw new Error(serverMsg || 'Query rejected (only a single read-only SELECT is allowed)');
      if (status === 403) throw new Error(serverMsg || 'BioNFT consent / signature rejected');
      if (status === 404) throw new Error(serverMsg || 'No queryable-biodata sqlite resolved for this biocid/biosample');
      if (status === 503) throw new Error(serverMsg || 'Sqlite path not mounted on prod (transient — try again)');
      throw new Error(`query API failed: ${serverMsg || error.message}`);
    }
  }

  /**
   * Genomi -> biofs Campaign A: submit a variants query as a background job.
   * Returns {query_job_id, status:'in_progress'} in <1s so the cold 462MB-sqlite
   * scan never blocks a request past Cloudflare's ~100s edge (the 524). If the
   * prod analyzer lacks the endpoint (404) or the verb is not async yet (501),
   * returns {fallback:true} so the caller can use the legacy synchronous path.
   */
  async querySubmit(
    biosample: string,
    wallet: string,
    signature: string,
    opts: { gene?: string; region?: string; so?: string; maxAf?: string; clinvar?: string; columns?: string; limit?: number | string; jobId?: string; withAcmg?: boolean } = {}
  ): Promise<FuseQuerySubmitResponse> {
    const params: Record<string, string> = { verb: 'variants', biosample, wallet, signature };
    if (opts.gene) params.gene = opts.gene;
    if (opts.region) params.region = opts.region;
    if (opts.so) params.so = opts.so;
    if (opts.maxAf !== undefined) params.max_af = String(opts.maxAf);
    if (opts.clinvar) params.clinvar = opts.clinvar;
    if (opts.columns) params.columns = opts.columns;
    if (opts.limit !== undefined) params.limit = String(opts.limit);
    if (opts.jobId) params.job_id = opts.jobId;
    if (opts.withAcmg) params.with_acmg = 'true';
    try {
      const r = await axios.get(`${this.baseUrl}/query_submit`, { params, timeout: 30_000 });
      return r.data as FuseQuerySubmitResponse;
    } catch (error: any) {
      const status = error.response?.status;
      const serverMsg = error.response?.data?.error;
      // 404 = endpoint absent (old prod); 501 = verb not async yet -> fall back.
      if (status === 404 || status === 501) return { fallback: true };
      if (status === 403) throw new Error(serverMsg || 'BioNFT consent / signature rejected');
      throw new Error(`query_submit failed: ${serverMsg || error.message}`);
    }
  }

  /**
   * Poll a submitted query job. Fast call; never blocks on the scan. Auth-gated:
   * the wallet + signature must match the submitter (the job UUID is not a bearer
   * token), so genomic results never leak to a caller who merely knows the id.
   */
  async queryStatus(queryJobId: string, wallet: string, signature: string): Promise<Record<string, any>> {
    const r = await axios.get(`${this.baseUrl}/query_status`, {
      params: { query_job_id: queryJobId, wallet, signature },
      timeout: 30_000,
    });
    return r.data;
  }

  /**
   * Variants via submit-then-poll (the 524 killer), with automatic fallback to
   * the legacy synchronous `variants()` when the prod analyzer is not yet
   * envelope/async-aware. Each network call is fast, so the cold scan can run as
   * long as it needs without a Cloudflare gateway timeout.
   */
  async variantsPolled(
    biosample: string,
    wallet: string,
    signature: string,
    opts: { gene?: string; region?: string; so?: string; maxAf?: string; clinvar?: string; columns?: string; limit?: number | string; jobId?: string; withAcmg?: boolean } = {},
    onProgress?: (elapsedSec: number, status: string) => void
  ): Promise<FuseVariantsResponse> {
    const sub = await this.querySubmit(biosample, wallet, signature, opts);
    if (sub.fallback || !sub.query_job_id) {
      // Old prod (no async endpoint) -> legacy synchronous call, unchanged behavior.
      return this.variants(biosample, wallet, signature, opts);
    }
    const qid = sub.query_job_id;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const start = Date.now();
    const MAX_MS = 20 * 60_000;
    let intervalMs = 5_000; // 5s, then back off to 15s after the first minute
    // A dedup-joined job may already be done at submit time; check once up front.
    if (sub.status === 'done') {
      const st0 = await this.queryStatus(qid, wallet, signature);
      if (st0.status === 'done') return st0 as FuseVariantsResponse;
    }
    while (Date.now() - start < MAX_MS) {
      await sleep(intervalMs);
      let st: Record<string, any>;
      try {
        st = await this.queryStatus(qid, wallet, signature);
      } catch (e: any) {
        // transient poll error: keep polling unless the job id is unknown (404)
        if (e.response?.status === 404) throw new Error(`query job ${qid} not found`);
        continue;
      }
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (st.status === 'done') return st as FuseVariantsResponse;
      if (st.status === 'failed' || st.status === 'failed:stalled') {
        const env = st.evidence_envelope as Record<string, any> | undefined;
        const code = env?.guidance_code ? ` [${env.guidance_code}]` : '';
        throw new Error(`${st.error || 'query failed'}${code}`);
      }
      if (onProgress) onProgress(elapsed, String(st.status || 'in_progress'));
      if (Date.now() - start > 60_000) intervalMs = 15_000;
    }
    throw new Error(`variants query timed out after ${Math.round(MAX_MS / 60_000)} min (job ${qid})`);
  }

  /**
   * Submit an arbitrary read-only SQL query as a background job — the heavy-path
   * counterpart to query(). A cold full-table scan over the gcsfuse-mounted
   * sqlite can exceed the synchronous 60 s ceiling; the async worker runs it with
   * a larger (still bounded) budget. Authorization (owner/custodian or active
   * BioNFT consent) is enforced at submit. Returns {query_job_id,status} or
   * {fallback:true} when the prod analyzer lacks the async query verb (404/501).
   */
  async querySqlSubmit(
    ref: { biocid?: string; biosample?: string },
    sql: string | null,
    wallet: string,
    signature: string,
    opts: { schema?: boolean; rowCap?: number | string; timeoutMs?: number | string; jobId?: string } = {},
  ): Promise<FuseQuerySubmitResponse> {
    const params: Record<string, string> = { verb: 'query', wallet, signature };
    if (ref.biocid) params.biocid = ref.biocid;
    if (ref.biosample) params.biosample = ref.biosample;
    if (sql) params.sql = sql;
    if (opts.schema) params.schema = 'true';
    if (opts.rowCap !== undefined) params.row_cap = String(opts.rowCap);
    if (opts.timeoutMs !== undefined) params.timeout_ms = String(opts.timeoutMs);
    if (opts.jobId) params.job_id = opts.jobId;
    try {
      const r = await axios.get(`${this.baseUrl}/query_submit`, { params, timeout: 30_000 });
      return r.data as FuseQuerySubmitResponse;
    } catch (error: any) {
      const status = error.response?.status;
      const serverMsg = error.response?.data?.error;
      if (status === 404 || status === 501) return { fallback: true };
      if (status === 400) throw new Error(serverMsg || 'Query rejected (only a single read-only SELECT is allowed)');
      if (status === 403) throw new Error(serverMsg || 'Not authorized (owner/custodian or active BioNFT consent required)');
      throw new Error(`query_submit (sql) failed: ${serverMsg || error.message}`);
    }
  }

  /**
   * Arbitrary SQL via submit-then-poll (the heavy path, for cold full-table
   * scans). Automatically falls back to the synchronous query() when the prod
   * analyzer has no async query verb. Each network call is fast, so the scan can
   * run as long as it needs without a Cloudflare gateway timeout.
   */
  async querySqlPolled(
    ref: { biocid?: string; biosample?: string },
    sql: string | null,
    wallet: string,
    signature: string,
    opts: { schema?: boolean; rowCap?: number | string; timeoutMs?: number | string; jobId?: string } = {},
    onProgress?: (elapsedSec: number, status: string) => void,
  ): Promise<FuseQueryResponse> {
    const sub = await this.querySqlSubmit(ref, sql, wallet, signature, opts);
    if (sub.fallback || !sub.query_job_id) {
      return this.query(ref, sql, wallet, signature, opts);
    }
    const qid = sub.query_job_id;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const start = Date.now();
    const MAX_MS = 20 * 60_000;
    let intervalMs = 4_000;
    if (sub.status === 'done') {
      const st0 = await this.queryStatus(qid, wallet, signature);
      if (st0.status === 'done') return st0 as FuseQueryResponse;
    }
    while (Date.now() - start < MAX_MS) {
      await sleep(intervalMs);
      let st: Record<string, any>;
      try {
        st = await this.queryStatus(qid, wallet, signature);
      } catch (e: any) {
        if (e.response?.status === 404) throw new Error(`query job ${qid} not found`);
        continue;
      }
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (st.status === 'done') return st as FuseQueryResponse;
      if (st.status === 'failed' || st.status === 'failed:stalled') {
        throw new Error(st.error || 'query failed');
      }
      if (onProgress) onProgress(elapsed, String(st.status || 'in_progress'));
      if (Date.now() - start > 60_000) intervalMs = 10_000;
    }
    throw new Error(`SQL query timed out after ${Math.round(MAX_MS / 60_000)} min (job ${qid})`);
  }

  /**
   * GDPR Art. 17 erasure. Dry run by default: the server enumerates what would
   * be destroyed and changes nothing. Executing additionally requires the typed
   * confirm token, because it is irreversible. Long timeout: deleting many GCS
   * objects is slow, and the saga is resumable if the connection drops.
   */
  async erase(
    opts: { biosample?: string; dryRun?: boolean; confirm?: string; erasureId?: string },
    wallet: string,
    signature: string,
  ): Promise<Record<string, any>> {
    const params: Record<string, string> = { wallet, signature };
    if (opts.biosample) params.biosample = opts.biosample;
    if (opts.erasureId) params.erasure_id = opts.erasureId;
    if (opts.confirm) params.confirm = opts.confirm;
    params.dry_run = opts.dryRun === false ? 'false' : 'true';
    try {
      const r = await axios.get(`${this.baseUrl}/erase`, { params, timeout: 600_000 });
      return r.data;
    } catch (error: any) {
      const status = error.response?.status;
      const msg = error.response?.data?.error;
      if (status === 403) throw new Error(msg || 'Not authorized: only an owner/custodian may erase this biosample');
      if (status === 400) throw new Error(msg || 'Erasure rejected (confirmation required)');
      throw new Error(`erase failed: ${msg || error.message}`);
    }
  }

  /**
   * Batch ACMG-SVI ClinVar P+LP query across a cohort of biosamples.
   * Server processes each in turn; returns per-serial findings with ACMG
   * evidence stacks. Mac client handles serial→biowallet mapping locally.
   */
  async cohortAcmg(
    serials: string[],
    wallet: string,
    signature: string,
    opts: { limit?: number; maxAf?: string } = {}
  ): Promise<FuseCohortAcmgResponse> {
    try {
      const serialsB64 = Buffer.from(JSON.stringify(serials), 'utf-8').toString('base64');
      const params: Record<string, string> = {
        serials_b64: serialsB64,
        wallet,
        signature,
      };
      if (opts.limit !== undefined) params.limit = String(opts.limit);
      if (opts.maxAf !== undefined) params.max_af = String(opts.maxAf);
      const response = await axios.get(`${this.baseUrl}/cohort_acmg`, {
        params,
        timeout: 30 * 60_000, // 30 min — cohort runs are long
      });
      return response.data;
    } catch (error: any) {
      const status = error.response?.status;
      const serverMsg = error.response?.data?.error;
      if (status === 403) throw new Error(serverMsg || 'Signature rejected');
      throw new Error(`cohort_acmg API failed: ${serverMsg || error.message}`);
    }
  }

  /**
   * Per-serial Cosic-RRM spectral scoring against an NFT-gated OpenCRAVAT sqlite.
   * Extracts rare missense variants per the supplied filter, then for each variant
   * computes the five Cosic-RRM metrics using the cached gene-family consensus
   * characteristic frequency. Returns one row per scored variant; no genomic bytes
   * transit the client.
   *
   * The cohort-fourier-score CLI verb calls this once per serial in a small
   * concurrency window (default 2) rather than a single fan-out call, mirroring
   * the cohort-acmg pattern so a stuck serial does not poison the cohort.
   */
  async cohortFourierScorePerSerial(
    biosample: string,
    wallet: string,
    signature: string,
    opts: {
      maxAf?: string;
      amThreshold?: string;
      includeVus?: boolean;
      includeHighAm?: boolean;
      window?: string;
      windowTm?: string;
    } = {},
  ): Promise<{
    biosample: string;
    job_id: string | null;
    biocid: string | null;
    n_variants_scored: number;
    variants: FuseFourierVariantRow[];
    methodology?: string;
  }> {
    try {
      const params: Record<string, string> = { biosample, wallet, signature };
      if (opts.maxAf !== undefined) params.max_af = String(opts.maxAf);
      if (opts.amThreshold !== undefined) params.am_threshold = String(opts.amThreshold);
      if (opts.includeVus) params.include_vus = 'true';
      if (opts.includeHighAm) params.include_high_am = 'true';
      if (opts.window !== undefined) params.window = String(opts.window);
      if (opts.windowTm !== undefined) params.window_tm = String(opts.windowTm);
      // Per-serial Cosic-RRM scoring is dominated by UniProt fetches and ortholog
      // consensus computation for genes that aren't cached. Budget 300 s per serial.
      const TIMEOUT_MS = 300_000;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await axios.get(`${this.baseUrl}/cohort_fourier_score`, {
          params,
          timeout: TIMEOUT_MS,
          signal: controller.signal,
        });
        return response.data;
      } finally {
        clearTimeout(t);
      }
    } catch (error: any) {
      if (error.code === 'ERR_CANCELED' || error.name === 'CanceledError') {
        throw new Error('cohort_fourier_score API timeout after 300 s');
      }
      const status = error.response?.status;
      const serverMsg = error.response?.data?.error;
      if (status === 403) throw new Error(serverMsg || 'BioNFT consent / signature rejected');
      if (status === 404) throw new Error(serverMsg || 'No OpenCRAVAT sqlite registered for this biosample');
      if (status === 503) throw new Error(serverMsg || 'Sqlite path not mounted on prod (transient — try again)');
      throw new Error(`cohort_fourier_score API failed: ${serverMsg || error.message}`);
    }
  }

  /**
   * Get all files across all accessible biosamples
   */
  async getAllFiles(wallet: string, signature: string): Promise<{
    biosample: string;
    files: string[];
  }[]> {
    try {
      // First discover accessible biosamples
      const discovered = await this.discover(wallet, signature);

      if (discovered.count === 0) {
        return [];
      }

      // Then list files for each biosample
      const allFiles = await Promise.all(
        discovered.biosamples.map(async (bs) => {
          const files = await this.list(bs.biosample_serial, wallet, signature);
          return {
            biosample: bs.biosample_serial,
            files: files.files
          };
        })
      );

      return allFiles;
    } catch (error: any) {
      throw new Error(`Failed to get all files: ${error.message}`);
    }
  }
}


