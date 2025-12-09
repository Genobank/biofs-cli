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


