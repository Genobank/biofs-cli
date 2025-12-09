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
import * as fs from 'fs';
import * as path from 'path';

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
   * Check if biosample is tokenized by attempting to mount it on biofs-node
   * This validates consent via Sequentia blockchain
   */
  async checkBiosampleTokenization(biosampleSerial: string): Promise<{
    isTokenized: boolean;
    consent: BioNFTConsent | null;
  }> {
    try {
      const wallet = await this.getWallet();

      // Get biofs-node URL from config (check multiple locations)
      let biofsNodeUrl = process.env.BIOFS_NODE_URL;

      if (!biofsNodeUrl) {
        const localConfigPath = path.join(process.cwd(), 'config.json');
        const homeConfigPath = path.join(process.env.HOME || '~', '.biofsrc');

        if (fs.existsSync(localConfigPath)) {
          const config = JSON.parse(fs.readFileSync(localConfigPath, 'utf-8'));
          biofsNodeUrl = config.biofsNode?.url;
        } else if (fs.existsSync(homeConfigPath)) {
          const config = JSON.parse(fs.readFileSync(homeConfigPath, 'utf-8'));
          biofsNodeUrl = config.biofsNode?.url;
        }
      }

      if (!biofsNodeUrl) {
        throw new Error('BioFS-Node URL not configured. Set biofsNode.url in config.json or ~/.biofsrc');
      }

      // Try to mount biosample on biofs-node (validates consent)
      const mountResponse = await axios.post(
        `${biofsNodeUrl}/api/v1/clara/mount`,
        {
          biosampleId: biosampleSerial,
          mountPoint: `/biofs/${biosampleSerial}`,
          userWallet: wallet
        },
        {
          timeout: 30000,
          headers: { 'Content-Type': 'application/json' }
        }
      );

      if (mountResponse.data.success && mountResponse.data.consent) {
        const consentData = mountResponse.data.consent;

        return {
          isTokenized: true,
          consent: {
            biosample_serial: biosampleSerial,
            patient_wallet: consentData.patient || wallet,
            agent_wallet: consentData.agent,
            tx_hash: consentData.tx_hash || '',
            block_number: consentData.block || 0,
            s3_paths: mountResponse.data.files || [],
            status: 'active'
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
   * Automatically fetches file sizes from S3 for each file
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
        // Get file sizes for each file
        const filesWithSizes = await Promise.all(
          response.data.files.map(async (filename: string) => {
            const fileInfo = await this.getFileInfo(biosampleSerial, filename);
            return fileInfo || {
              filename,
              size: 0,
              lastModified: '',
              sizeReadable: ''
            };
          })
        );

        return filesWithSizes;
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
   * Calls /api_biofs_fuse/tokenize_biosample which:
   * 1. Discovers files from S3 index
   * 2. Mints BioNFT consent on Sequentia blockchain
   * 3. Creates MongoDB record in sequentia_bionfts
   */
  async tokenizeBiosample(biosampleSerial: string, files?: string[]): Promise<{
    success: boolean;
    tx_hash?: string;
    block_number?: number;
    consent?: {
      patient_wallet: string;
      agent_wallet: string;
      operations: string[];
      expires_at: number;
      status: string;
    };
    error?: string;
  }> {
    try {
      const signature = await this.getSignature();
      const wallet = await this.getWallet();

      const response = await this.axios.get('/api_biofs_fuse/tokenize_biosample', {
        params: {
          biosample: biosampleSerial,
          wallet,
          signature,
          files: files ? JSON.stringify(files) : undefined
        }
      });

      if (response.data.success) {
        return {
          success: true,
          tx_hash: response.data.tx_hash,
          block_number: response.data.block_number,
          consent: response.data.consent
        };
      } else {
        return {
          success: false,
          error: response.data.error || 'Tokenization failed'
        };
      }

    } catch (error: any) {
      // Handle specific error responses
      if (error.response?.data?.error) {
        return {
          success: false,
          error: error.response.data.error
        };
      }
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Grant access to biosample for an agent wallet
   * Calls /api_biofs_fuse/grant_access which:
   * 1. Verifies owner signature
   * 2. Mints permission on Sequentia blockchain
   * 3. Creates MongoDB access record
   */
  async grantAccess(
    biosampleSerial: string,
    agentWallet: string,
    operations: string[] = ['read', 'download', 'process'],
    expiresDays: number = 365
  ): Promise<{
    success: boolean;
    tx_hash?: string;
    block_number?: number;
    access_record?: {
      patient_wallet: string;
      agent_wallet: string;
      operations: string[];
      expires_at: number;
      expires_days: number;
      status: string;
    };
    error?: string;
  }> {
    try {
      const signature = await this.getSignature();
      const wallet = await this.getWallet();

      const response = await this.axios.get('/api_biofs_fuse/grant_access', {
        params: {
          biosample: biosampleSerial,
          owner_wallet: wallet,
          owner_signature: signature,
          agent_wallet: agentWallet,
          operations: JSON.stringify(operations),
          expires_days: expiresDays
        }
      });

      if (response.data.success) {
        return {
          success: true,
          tx_hash: response.data.tx_hash,
          block_number: response.data.block_number,
          access_record: response.data.access_record
        };
      } else {
        return {
          success: false,
          error: response.data.error || 'Access grant failed'
        };
      }

    } catch (error: any) {
      if (error.response?.data?.error) {
        return {
          success: false,
          error: error.response.data.error
        };
      }
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Revoke access from an agent wallet
   * Calls /api_biofs_fuse/revoke_access
   */
  async revokeAccess(
    biosampleSerial: string,
    agentWallet: string
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const signature = await this.getSignature();
      const wallet = await this.getWallet();

      const response = await this.axios.get('/api_biofs_fuse/revoke_access', {
        params: {
          biosample: biosampleSerial,
          owner_wallet: wallet,
          owner_signature: signature,
          agent_wallet: agentWallet
        }
      });

      if (response.data.success) {
        return { success: true };
      } else {
        return {
          success: false,
          error: response.data.error || 'Access revoke failed'
        };
      }

    } catch (error: any) {
      if (error.response?.data?.error) {
        return {
          success: false,
          error: error.response.data.error
        };
      }
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

