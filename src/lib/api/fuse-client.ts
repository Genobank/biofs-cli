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


