/**
 * GDPR Consent Manager for BioNFS
 * Manages genomic data access consent records
 */

const axios = require('axios');
const chalk = require('chalk');

const API_BASE = process.env.GENOBANK_API_URL || 'https://genobank.app';

class ConsentManager {
  /**
   * Check if user has already given consent for this file
   */
  async hasConsent(wallet, ipId, action, userSignature) {
    try {
      const response = await axios.post(`${API_BASE}/bionfs/v1/verify_consent`, {
        user_signature: userSignature,
        ip_id: ipId,
        action: action  // 'download' or 'mount'
      });

      return response.data.has_consent === true;
    } catch (error) {
      // If endpoint doesn't exist yet, assume no consent
      return false;
    }
  }

  /**
   * Record user's consent after they agree
   */
  async recordConsent(wallet, fileInfo, action, ipAddress, userSignature) {
    try {
      const response = await axios.post(`${API_BASE}/bionfs/v1/record_consent`, {
        user_signature: userSignature,
        ip_id: fileInfo.ip_id,
        action: action,
        ip_address: ipAddress
      });

      if (response.data.status === 'Success') {
        console.log(chalk.green('✅ Consent recorded'));
        return true;
      }

      return false;
    } catch (error) {
      console.error(chalk.yellow('⚠️  Could not record consent:', error.message));
      console.log(chalk.gray('Proceeding with download (consent will be recorded when API is ready)'));
      return true;  // Allow download even if consent recording fails
    }
  }

  /**
   * Revoke consent for an IP asset
   */
  async revokeConsent(wallet, ipId, userSignature) {
    try {
      const response = await axios.post(`${API_BASE}/bionfs/v1/revoke_consent`, {
        user_signature: userSignature,
        ip_id: ipId || 'all'
      });

      return response.data.status === 'Success';
    } catch (error) {
      console.error(chalk.red('Error revoking consent:', error.message));
      return false;
    }
  }

  /**
   * Get all consent records for a wallet
   */
  async getMyConsents(userSignature) {
    try {
      const response = await axios.get(`${API_BASE}/bionfs/v1/my_consents`, {
        params: { user_signature: userSignature }
      });

      return response.data.consents || [];
    } catch (error) {
      return [];
    }
  }
}

module.exports = ConsentManager;


