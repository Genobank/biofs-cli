/**
 * LabNFT Module - Sequentia Network
 *
 * Manages Lab NFTs for permittee registration on Sequentia blockchain.
 * LabNFTs represent verified research labs, institutions, and researchers
 * with GDPR-compliant consent management and access control.
 *
 * Contract: 0x24f42752F491540e305384A5C947911649C910CF
 * Network: Sequentia L1 (Chain ID: 15132025)
 *
 * @author GenoBank.io - BioFS CLI
 */

import { ethers } from 'ethers';
import { SEQUENTIA_CONFIG } from './index';

// LabNFT Contract Configuration
const LABNFT_CONTRACT = '0x24f42752F491540e305384A5C947911649C910CF';
const LABNFT_ABI = [
  // View functions
  'function getLabBySerial(uint256 _serial) external view returns (address owner, uint8 labType, string memory name, string memory specialization, string memory location, string memory website, string memory email, bytes32 biodataConsentHash, bytes32 commercialConsentHash, uint8 accessLevel, uint8 ga4ghLevel, bool verified, bool active)',
  'function getSerialByWallet(address _wallet) external view returns (uint256)',
  'function isLabRegistered(address _wallet) external view returns (bool)',
  'function getNextSerial() external view returns (uint256)',

  // Admin functions (requires executor key)
  'function mintLab(address _owner, uint8 _labType, string memory _name, string memory _specialization, string memory _location, string memory _website, string memory _email, bytes32 _biodataConsentHash, bytes32 _commercialConsentHash, uint8 _accessLevel, uint8 _ga4ghLevel) external returns (uint256)',
  'function updateLabInfo(uint256 _serial, string memory _name, string memory _specialization, string memory _location, string memory _website, string memory _email) external',
  'function setVerified(uint256 _serial, bool _verified) external'
];

/**
 * Lab Types
 */
export enum LabType {
  LAB = 0,
  RESEARCHER = 1,
  INSTITUTION = 2
}

/**
 * Access Levels
 */
export enum AccessLevel {
  RESEARCH_ONLY = 0,
  CLINICAL_NON_CRITICAL = 1,
  CLINICAL_CRITICAL = 2,
  COMMERCIAL = 3
}

/**
 * GA4GH Compliance Levels
 */
export enum GA4GHLevel {
  NONE = 0,
  BASIC = 1,
  LITE = 2,
  FULL = 3
}

/**
 * Lab Information
 */
export interface LabInfo {
  serial: number;
  owner: string;
  labType: LabType;
  name: string;
  specialization: string;
  location: string;
  website: string;
  email: string;
  biodataConsentHash: string;
  commercialConsentHash: string;
  accessLevel: AccessLevel;
  ga4ghLevel: GA4GHLevel;
  verified: boolean;
  active: boolean;
}

/**
 * Mint Lab Options
 */
export interface MintLabOptions {
  owner: string;
  labType: LabType;
  name: string;
  specialization: string;
  location: string;
  website: string;
  email: string;
  biodataConsentHash?: string;
  commercialConsentHash?: string;
  accessLevel?: AccessLevel;
  ga4ghLevel?: GA4GHLevel;
}

/**
 * LabNFT Client
 *
 * Manages Lab NFTs on Sequentia Network
 */
export class LabNFT {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;

  /**
   * Initialize LabNFT client
   *
   * @param privateKey - Executor private key (without 0x prefix)
   */
  constructor(privateKey: string) {
    this.provider = new ethers.JsonRpcProvider(SEQUENTIA_CONFIG.rpcUrl);
    this.wallet = new ethers.Wallet(
      privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`,
      this.provider
    );
    this.contract = new ethers.Contract(LABNFT_CONTRACT, LABNFT_ABI, this.wallet);
  }

  /**
   * Check if wallet has a LabNFT
   *
   * @param wallet - Wallet address to check
   * @returns True if wallet is registered
   */
  async isLabRegistered(wallet: string): Promise<boolean> {
    try {
      return await this.contract.isLabRegistered(wallet);
    } catch (error: any) {
      throw new Error(`Failed to check lab registration: ${error.message}`);
    }
  }

  /**
   * Get lab serial number by wallet
   *
   * @param wallet - Wallet address
   * @returns Serial number (0 if not registered)
   */
  async getSerialByWallet(wallet: string): Promise<number> {
    try {
      const serial = await this.contract.getSerialByWallet(wallet);
      return Number(serial);
    } catch (error: any) {
      throw new Error(`Failed to get lab serial: ${error.message}`);
    }
  }

  /**
   * Get lab information by serial
   *
   * @param serial - LabNFT serial number
   * @returns Lab information
   */
  async getLabBySerial(serial: number): Promise<LabInfo> {
    try {
      const result = await this.contract.getLabBySerial(serial);

      return {
        serial,
        owner: result[0],
        labType: result[1],
        name: result[2],
        specialization: result[3],
        location: result[4],
        website: result[5],
        email: result[6],
        biodataConsentHash: result[7],
        commercialConsentHash: result[8],
        accessLevel: result[9],
        ga4ghLevel: result[10],
        verified: result[11],
        active: result[12]
      };
    } catch (error: any) {
      throw new Error(`Failed to get lab info: ${error.message}`);
    }
  }

  /**
   * Get lab information by wallet address
   *
   * @param wallet - Wallet address
   * @returns Lab information or null if not registered
   */
  async getLabByWallet(wallet: string): Promise<LabInfo | null> {
    try {
      const serial = await this.getSerialByWallet(wallet);
      if (serial === 0) return null;
      return await this.getLabBySerial(serial);
    } catch (error: any) {
      throw new Error(`Failed to get lab by wallet: ${error.message}`);
    }
  }

  /**
   * Get next available serial number
   *
   * @returns Next serial number
   */
  async getNextSerial(): Promise<number> {
    try {
      const serial = await this.contract.getNextSerial();
      return Number(serial);
    } catch (error: any) {
      throw new Error(`Failed to get next serial: ${error.message}`);
    }
  }

  /**
   * Mint a new LabNFT
   *
   * @param options - Lab information
   * @returns Transaction hash and serial number
   */
  async mintLab(options: MintLabOptions): Promise<{ txHash: string; serial: number; blockNumber: number }> {
    try {
      // Generate consent hashes if not provided
      const biodataHash = options.biodataConsentHash ||
        ethers.keccak256(ethers.toUtf8Bytes(`Generated consent for ${options.name}`));
      const commercialHash = options.commercialConsentHash ||
        ethers.keccak256(ethers.toUtf8Bytes(`No commercial consent - ${options.name}`));

      // Ensure both hashes are bytes32 format (0x + 64 hex chars)
      if (biodataHash.length !== 66) {
        throw new Error(`Invalid biodata consent hash length: ${biodataHash.length}`);
      }
      if (commercialHash.length !== 66) {
        throw new Error(`Invalid commercial consent hash length: ${commercialHash.length}`);
      }

      // Build transaction
      const tx = await this.contract.mintLab(
        options.owner,
        options.labType,
        options.name,
        options.specialization,
        options.location,
        options.website,
        options.email,
        biodataHash,
        commercialHash,
        options.accessLevel ?? AccessLevel.RESEARCH_ONLY,
        options.ga4ghLevel ?? GA4GHLevel.NONE
      );

      // Wait for confirmation
      const receipt = await tx.wait();

      if (receipt.status !== 1) {
        throw new Error('Transaction reverted');
      }

      // Get minted serial
      const serial = await this.getSerialByWallet(options.owner);

      return {
        txHash: receipt.hash,
        serial,
        blockNumber: receipt.blockNumber
      };
    } catch (error: any) {
      throw new Error(`Failed to mint LabNFT: ${error.message}`);
    }
  }

  /**
   * Update lab information
   *
   * @param serial - LabNFT serial number
   * @param updates - Fields to update
   */
  async updateLabInfo(
    serial: number,
    updates: {
      name?: string;
      specialization?: string;
      location?: string;
      website?: string;
      email?: string;
    }
  ): Promise<string> {
    try {
      // Get current lab info
      const current = await this.getLabBySerial(serial);

      // Build transaction
      const tx = await this.contract.updateLabInfo(
        serial,
        updates.name ?? current.name,
        updates.specialization ?? current.specialization,
        updates.location ?? current.location,
        updates.website ?? current.website,
        updates.email ?? current.email
      );

      const receipt = await tx.wait();

      if (receipt.status !== 1) {
        throw new Error('Transaction reverted');
      }

      return receipt.hash;
    } catch (error: any) {
      throw new Error(`Failed to update lab info: ${error.message}`);
    }
  }

  /**
   * Set lab verification status
   *
   * @param serial - LabNFT serial number
   * @param verified - Verification status
   */
  async setVerified(serial: number, verified: boolean): Promise<string> {
    try {
      const tx = await this.contract.setVerified(serial, verified);
      const receipt = await tx.wait();

      if (receipt.status !== 1) {
        throw new Error('Transaction reverted');
      }

      return receipt.hash;
    } catch (error: any) {
      throw new Error(`Failed to set verification: ${error.message}`);
    }
  }

  /**
   * Generate consent hash
   *
   * @param text - Consent text
   * @returns Keccak256 hash (bytes32)
   */
  static generateConsentHash(text: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(text));
  }

  /**
   * Get contract address
   */
  static getContractAddress(): string {
    return LABNFT_CONTRACT;
  }

  /**
   * Get network configuration
   */
  static getNetworkConfig() {
    return {
      rpcUrl: SEQUENTIA_CONFIG.rpcUrl,
      chainId: SEQUENTIA_CONFIG.chainId,
      contract: LABNFT_CONTRACT
    };
  }
}
