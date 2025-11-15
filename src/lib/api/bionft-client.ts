/**
 * BioNFT Client for biofs-cli
 *
 * Integrates with:
 * - MongoDB sequentia_bionfts collection
 * - BioNFT contract on Sequentia (0x8C1fdECE83fA3F48777da16eb58ed801C676F8C1)
 * - /api_biofs_fuse/ endpoints
 */

import axios, { AxiosInstance } from 'axios';
import { CredentialsManager } from '../auth/credentials';
import { Logger } from '../utils/logger';

export interface BioNFTConsent {
  biosample_serial: string;
  patient_wallet: string | null;
  agent_wallet: string;
  tx_hash: string;
  block_number: number;
  s3_paths: string[];
  status: 'active' | 'revoked';
  files?: Array<{
    filename: string;
    s3_path: string;
    file_type: string;
    size_bytes: number;
  }>;
}

export interface BiosampleFile {
  filename: string;
  size: number;
  lastModified: string;
  sizeReadable: string;
}

export class BioNFTClient {
  private static instance: BioNFTClient;
  private axios: AxiosInstance;
  private credManager: CredentialsManager;
  private readonly BIONFT_CONTRACT = '0x8C1fdECE83fA3F48777da16eb58ed801C676F8C1';
  private readonly SEQUENTIA_RPC = 'http://52.90.163.112:8545';
  private readonly API_BASE = 'https://genobank.app';

  private constructor() {
    this.credManager = CredentialsManager.getInstance();
    this.axios = axios.create({
      baseURL: this.API_BASE,
      timeout: 30000
    });
  }

  static getInstance(): BioNFTClient {
    if (!BioNFTClient.instance) {
      BioNFTClient.instance = new BioNFTClient();
    }
    return BioNFTClient.instance;
  }

  private async getSignature(): Promise<string> {
    const creds = await this.credManager.loadCredentials();
    if (!creds) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }
    return creds.user_signature;
  }

  private async getWallet(): Promise<string> {
    const creds = await this.credManager.loadCredentials();
    if (!creds) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }
    return creds.wallet_address;
  }

  /**
   * Check if biosample is tokenized (has patient_wallet set)
   * Queries MongoDB via Python backend
   */
  async checkBiosampleTokenization(biosampleSerial: string): Promise<{
    isTokenized: boolean;
    consent: BioNFTConsent | null;
  }> {
    try {
      const signature = await this.getSignature();

      // Query via /api_biofs_fuse/discover (returns biosamples accessible to wallet)
      const response = await this.axios.get('/api_biofs_fuse/discover', {
        params: {
          wallet: await this.getWallet(),
          signature
        }
      });

      const biosamples = response.data.biosamples || [];
      const consent = biosamples.find((b: any) => b.biosample_serial === biosampleSerial);

      if (consent) {
        return {
          isTokenized: true,
          consent: {
            biosample_serial: consent.biosample_serial,
            patient_wallet: consent.patient_wallet || null,
            agent_wallet: consent.agent_wallet,
            tx_hash: consent.tx_hash,
            block_number: consent.block_number,
            s3_paths: consent.s3_paths || [],
            status: consent.status || 'active'
          }
        };
      }

      return {
        isTokenized: false,
        consent: null
      };
    } catch (error: any) {
      Logger.error(`Failed to check tokenization: ${error.message}`);
      return {
        isTokenized: false,
        consent: null
      };
    }
  }

  /**
   * List files in biosample using /api_biofs_fuse/list
   */
  async listBiosampleFiles(biosampleSerial: string): Promise<BiosampleFile[]> {
    try {
      const signature = await this.getSignature();
      const wallet = await this.getWallet();

      const response = await this.axios.get('/api_biofs_fuse/list', {
        params: {
          biosample: biosampleSerial,
          wallet,
          signature,
          rebuild_index: false
        }
      });

      if (response.data.files) {
        return response.data.files.map((filename: string) => ({
          filename,
          size: 0,  // Will be populated by info call if needed
          lastModified: '',
          sizeReadable: ''
        }));
      }

      return [];
    } catch (error: any) {
      Logger.error(`Failed to list files: ${error.message}`);
      return [];
    }
  }

  /**
   * Get detailed file info using /api_biofs_fuse/info
   */
  async getFileInfo(biosampleSerial: string, filename: string): Promise<BiosampleFile | null> {
    try {
      const signature = await this.getSignature();
      const wallet = await this.getWallet();

      const response = await this.axios.get('/api_biofs_fuse/info', {
        params: {
          biosample: biosampleSerial,
          filename,
          wallet,
          signature
        }
      });

      if (response.data.size) {
        return {
          filename: response.data.filename,
          size: response.data.size,
          lastModified: response.data.lastModified,
          sizeReadable: response.data.sizeReadable
        };
      }

      return null;
    } catch (error: any) {
      Logger.error(`Failed to get file info: ${error.message}`);
      return null;
    }
  }

  /**
   * Tokenize biosample (claim ownership)
   * This should call a backend endpoint that:
   * 1. Queries /api_biofs_fuse/list for files
   * 2. Creates MongoDB record in sequentia_bionfts
   * 3. Mints BioNFT on Sequentia blockchain
   */
  async tokenizeBiosample(biosampleSerial: string): Promise<{
    success: boolean;
    tx_hash?: string;
    error?: string;
  }> {
    try {
      const signature = await this.getSignature();
      const wallet = await this.getWallet();

      // TODO: Create backend endpoint /api_biofs/tokenize_biosample
      // For now, return error with instructions
      return {
        success: false,
        error: 'Biosample tokenization endpoint not yet implemented. Please use GenoBank.io web interface to tokenize.'
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Grant access to biosample for an agent wallet
   * Updates MongoDB and blockchain
   */
  async grantAccess(
    biosampleSerial: string,
    agentWallet: string,
    operations: string[] = ['read', 'download', 'process']
  ): Promise<{
    success: boolean;
    tx_hash?: string;
    error?: string;
  }> {
    try {
      const signature = await this.getSignature();

      // TODO: Create backend endpoint /api_biofs/grant_access
      // For now, return error with instructions
      return {
        success: false,
        error: 'Access grant endpoint not yet implemented. Please use GenoBank.io web interface to grant access.'
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Check if agent has access to biosample
   */
  async checkAccess(biosampleSerial: string, agentWallet: string): Promise<{
    hasAccess: boolean;
    operations: string[];
    consent: BioNFTConsent | null;
  }> {
    try {
      // Use new check_consent endpoint (no signature required)
      const response = await this.axios.get('/api_biofs_fuse/check_consent', {
        params: {
          biosample: biosampleSerial,
          agent_wallet: agentWallet
        }
      });

      // CRITICAL: Verify consent exists in BOTH MongoDB AND blockchain
      // MongoDB-only records (blockchain_verified: false) are stale data from old blockchain instances
      if (response.data.has_consent && response.data.blockchain_verified === true) {
        return {
          hasAccess: true,
          operations: response.data.operations || [],
          consent: {
            biosample_serial: response.data.biosample_serial,
            patient_wallet: response.data.patient_wallet,
            agent_wallet: response.data.agent_wallet,
            tx_hash: response.data.tx_hash,
            block_number: response.data.block_number,
            s3_paths: [],
            status: response.data.status
          }
        };
      }

      return {
        hasAccess: false,
        operations: [],
        consent: null
      };
    } catch (error: any) {
      Logger.error(`Failed to check access: ${error.message}`);
      return {
        hasAccess: false,
        operations: [],
        consent: null
      };
    }
  }
}
