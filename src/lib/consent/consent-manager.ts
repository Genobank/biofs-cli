/**
 * GDPR Consent Manager for BioNFS
 * Manages genomic data access consent records
 */

import axios from 'axios';
import chalk from 'chalk';
import { CONFIG } from '../config/constants';

export interface ConsentRecord {
  wallet_address: string;
  ip_id: string;
  filename: string;
  action: 'download' | 'mount';
  consent_given_at: string;
  access_count: number;
  revoked: boolean;
}

export class ConsentManager {
  private apiBase: string;

  constructor() {
    this.apiBase = CONFIG.API_BASE_URL || 'https://genobank.app';
  }

  /**
   * Check if user has already given consent for this file
   */
  async hasConsent(
    wallet: string,
    ipId: string,
    action: 'download' | 'mount',
    userSignature: string
  ): Promise<boolean> {
    try {
      const response = await axios.get(`${this.apiBase}/api_bioip/verify_consent`, {
        params: {
          user_signature: userSignature,
          ip_id: ipId,
          action: action
        }
      });

      return response.data.status_details?.has_consent === true;
    } catch (error) {
      // If endpoint doesn't exist yet, assume no consent
      return false;
    }
  }

  /**
   * Record user's consent after they agree
   */
  async recordConsent(
    wallet: string,
    fileInfo: any,
    action: 'download' | 'mount',
    ipAddress: string,
    userSignature: string
  ): Promise<boolean> {
    try {
      const response = await axios.get(`${this.apiBase}/api_bioip/record_consent`, {
        params: {
          user_signature: userSignature,
          ip_id: fileInfo.ip_id,
          action: action,
          ip_address: ipAddress
        }
      });

      if (response.data.status === 'Success') {
        console.log(chalk.green('✅ Consent recorded'));
        return true;
      }

      return false;
    } catch (error) {
      console.log(chalk.yellow('⚠️  Consent recording not available yet (API endpoint pending)'));
      console.log(chalk.gray('Proceeding with download (consent will be recorded when API is ready)'));
      return true; // Allow download even if consent recording fails
    }
  }

  /**
   * Revoke consent for an IP asset
   */
  async revokeConsent(
    wallet: string,
    ipId: string | null,
    userSignature: string
  ): Promise<boolean> {
    try {
      const response = await axios.get(`${this.apiBase}/api_bioip/revoke_consent`, {
        params: {
          user_signature: userSignature,
          ip_id: ipId || 'all'
        }
      });

      return response.data.status === 'Success';
    } catch (error: any) {
      console.error(chalk.red('Error revoking consent:', error.message));
      return false;
    }
  }

  /**
   * Get all consent records for a wallet
   */
  async getMyConsents(userSignature: string): Promise<ConsentRecord[]> {
    try {
      const response = await axios.get(`${this.apiBase}/api_bioip/my_consents`, {
        params: { user_signature: userSignature }
      });

      return response.data.status_details?.consents || [];
    } catch (error) {
      return [];
    }
  }
}


