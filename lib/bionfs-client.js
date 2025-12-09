/**
 * BioNFS Client - Blockchain-Authenticated File Streaming
 * Handles authentication and file streaming via BioNFS protocol
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const API_BASE = process.env.GENOBANK_API_URL || 'https://genobank.app';

class BioNFSClient {
  constructor() {
    this.sessionId = null;
    this.permissions = null;
  }

  /**
   * Authenticate with BioNFS server using Web3 signature
   */
  async authenticate(wallet, signature) {
    try {
      const response = await axios.post(`${API_BASE}/bionfs/v1/auth`, {
        wallet: wallet,
        signature: signature,
        message: 'I want to access BioNFS'
      });

      this.sessionId = response.data.session_id;
      this.permissions = response.data.permissions;

      return this.sessionId;
    } catch (error) {
      // If BioNFS endpoint doesn't exist, use fallback
      console.log(chalk.gray('BioNFS server not available, using direct API access'));
      return null;
    }
  }

  /**
   * Stream file by IP Asset ID or BioCID
   */
  async streamFile(identifier, outputPath, userSignature) {
    // Parse identifier
    const ipAssetId = this.parseIdentifier(identifier);

    if (this.sessionId) {
      // Use BioNFS streaming endpoint
      return await this.streamViaBioNFS(ipAssetId, outputPath);
    } else {
      // Fallback to direct API download
      return await this.downloadViaAPI(ipAssetId, outputPath, userSignature);
    }
  }

  /**
   * Stream via BioNFS server (if available)
   */
  async streamViaBioNFS(ipAssetId, outputPath) {
    const response = await axios.get(
      `${API_BASE}/bionfs/v1/stream/${ipAssetId}`,
      {
        headers: { 'X-Session-ID': this.sessionId },
        responseType: 'stream'
      }
    );

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(outputPath));
      writer.on('error', reject);
    });
  }

  /**
   * Fallback: Download via existing API
   */
  async downloadViaAPI(ipAssetId, outputPath, userSignature) {
    // Use existing /api_bioip/download_granted_file endpoint
    const response = await axios.get(
      `${API_BASE}/api_bioip/download_granted_file`,
      {
        params: {
          user_signature: userSignature,
          ip_id: ipAssetId
        },
        responseType: 'stream'
      }
    );

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(outputPath));
      writer.on('error', reject);
    });
  }

  /**
   * Parse BioCID or IP Asset ID
   * Formats:
   *   - biocid://OWNER/bioip/IP_ASSET_ID
   *   - 0xIP_ASSET_ID
   */
  parseIdentifier(identifier) {
    // If it's a BioCID, extract IP asset ID
    const biocidMatch = identifier.match(/biocid:\/\/0x[a-fA-F0-9]{40}\/bioip\/(0x[a-fA-F0-9]{40})/);
    if (biocidMatch) {
      return biocidMatch[1];
    }

    // If it's already an address, return it
    if (identifier.startsWith('0x') && identifier.length === 42) {
      return identifier;
    }

    throw new Error('Invalid identifier format. Use BioCID or IP Asset ID (0x...)');
  }
}

module.exports = BioNFSClient;

