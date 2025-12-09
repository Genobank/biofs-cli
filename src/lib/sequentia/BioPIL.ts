/**
 * BioPIL (Biomedical Programmable IP License)
 *
 * Genomic-specific licensing system built on Sequentia Protocol.
 * Replaces Story Protocol's generic PIL templates with licenses
 * designed specifically for genomic data:
 *
 * - Clinical Use License (medical diagnosis)
 * - Pharmaceutical Research License (drug discovery)
 * - AI Training License (machine learning datasets)
 * - Family Inheritance License (deceased subject data)
 * - GDPR Consent Research License (revocable research access)
 *
 * Key difference from Story PIL:
 * - BioPIL integrates with ConsentManager for GDPR compliance
 * - License revocation triggers S3 deletion
 * - Revenue sharing for family inheritance
 */

import { ethers } from 'ethers';
import { Logger } from '../utils/logger';

// Sequentia Network Configuration
const SEQUENTIA_RPC_URL = 'http://52.90.163.112:8545';
const BIOPIL_CONTRACT_ADDRESS = '0xDae899b64282370001E3f820304213eDf2D983DE';

export enum BioPILLicenseType {
    NonCommercialSocialRemixing = 1,
    CommercialUseRevShare = 2,
    CommercialRemix = 2,           // Alias for CommercialUseRevShare
    GDPRResearch = 5,
    AITraining = 6,
    ClinicalUse = 7,
    PharmaceuticalResearch = 8,
    FamilyInheritance = 9
}

export interface LicenseTerms {
    pilId: BioPILLicenseType;
    commercialUse: boolean;
    derivativesAllowed: boolean;
    attributionRequired: boolean;
    revenueShare: number;          // Basis points (10000 = 100%)
    gdprCompliant: boolean;
    description: string;
}

export interface LicenseToken {
    id: string;
    biocid: string;
    holder: string;
    licenseType: BioPILLicenseType;
    grantedAt: number;
    expiresAt: number;             // 0 = never expires
    status: 'active' | 'revoked' | 'expired';
    consentHash?: string;          // Link to ConsentManager
}

export interface AccessResult {
    granted: boolean;
    reason: string;
    licenseType?: BioPILLicenseType;
    grantedAt?: Date;
    expiresAt?: Date | null;
}

export class BioPIL {
    private contract: ethers.Contract;
    private signer: ethers.Wallet;
    

    constructor(privateKey: string) {
        

        try {
            const provider = new ethers.JsonRpcProvider(SEQUENTIA_RPC_URL);
            this.signer = new ethers.Wallet(privateKey, provider);

            const abi = require('../../abi/sequentia/BioPIL.json');
            this.contract = new ethers.Contract(
                BIOPIL_CONTRACT_ADDRESS,
                abi,
                this.signer
            );

            Logger.info('BioPIL initialized');
        } catch (error: any) {
            Logger.error(`Failed to initialize BioPIL: ${error.message}`);
            throw error;
        }
    }

    /**
     * Attach license terms to IP asset
     *
     * Simpler than Story Protocol - no complex PIL templates!
     * Just specify the license type and BioCID.
     */
    async attachLicenseTerms(
        ipAsset: string,
        pilId: BioPILLicenseType,
        biocid: string
    ): Promise<string> {
        Logger.info(`Attaching BioPIL license to IP Asset: ${ipAsset}`);
        Logger.info(`License Type: ${BioPILLicenseType[pilId]}`);
        Logger.info(`BioCID: ${biocid}`);

        try {
            const tx = await this.contract.attachLicenseTerms(ipAsset, pilId, biocid);
            Logger.info(`Transaction submitted: ${tx.hash}`);

            const receipt = await tx.wait();
            Logger.info(`License attached in block ${receipt.blockNumber}`);

            return receipt.transactionHash;

        } catch (error: any) {
            Logger.error(`License attachment failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Mint license token for lab/researcher
     *
     * ONE TRANSACTION - Simple and efficient!
     * No need for complex Story Protocol registerDerivative()
     */
    async mintLicenseToken(
        biocid: string,
        licenseType: BioPILLicenseType,
        receiver: string,
        amount: number = 1
    ): Promise<LicenseToken> {
        Logger.info(`Minting license token for BioCID: ${biocid}`);
        Logger.info(`License Type: ${BioPILLicenseType[licenseType]}`);
        Logger.info(`Receiver: ${receiver}`);

        try {
            const tx = await this.contract.mintLicenseToken(
                biocid,
                licenseType,
                receiver,
                amount
            );

            Logger.info(`Transaction submitted: ${tx.hash}`);
            const receipt = await tx.wait();
            Logger.info(`License token minted in block ${receipt.blockNumber}`);

            // Parse LicenseTokenMinted event
            const event = receipt.logs.find((log: any) => {
                try {
                    return log.topics[0] === this.contract.interface.getEvent('LicenseTokenMinted')!.topicHash;
                } catch {
                    return false;
                }
            });

            if (!event) {
                throw new Error('LicenseTokenMinted event not found');
            }

            const parsedEvent = this.contract.interface.parseLog({
                topics: event.topics as string[],
                data: event.data
            });

            const tokenId = parsedEvent!.args.tokenId;

            return {
                id: tokenId.toString(),
                biocid,
                holder: receiver,
                licenseType,
                grantedAt: Math.floor(Date.now() / 1000),
                expiresAt: 0, // Never expires by default
                status: 'active'
            };

        } catch (error: any) {
            Logger.error(`License token minting failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Check if wallet has access to BioCID
     */
    async checkAccess(biocid: string, wallet: string): Promise<AccessResult> {
        Logger.info(`Checking access for ${wallet.substring(0, 10)}...`);

        try {
            const hasLicense = await this.contract.hasLicenseToken(biocid, wallet);

            if (!hasLicense) {
                return {
                    granted: false,
                    reason: 'No license token found'
                };
            }

            const license = await this.contract.getLicenseToken(biocid, wallet);

            // Check expiration
            if (license.expiresAt > 0 && license.expiresAt < Date.now() / 1000) {
                return {
                    granted: false,
                    reason: 'License expired'
                };
            }

            // Check status
            if (license.status !== 'active') {
                return {
                    granted: false,
                    reason: `License ${license.status}`
                };
            }

            return {
                granted: true,
                reason: BioPILLicenseType[license.type],
                licenseType: license.type,
                grantedAt: new Date(license.grantedAt * 1000),
                expiresAt: license.expiresAt ? new Date(license.expiresAt * 1000) : null
            };

        } catch (error: any) {
            Logger.error(`Access check failed: ${error.message}`);
            return {
                granted: false,
                reason: 'Error checking access'
            };
        }
    }

    /**
     * Get all license tokens for a BioCID
     */
    async getLicenseTokens(biocid: string): Promise<LicenseToken[]> {
        Logger.info(`Fetching license tokens for BioCID: ${biocid}`);

        try {
            const tokens = await this.contract.getLicenseTokens(biocid);
            Logger.info(`Found ${tokens.length} license token(s)`);
            return tokens;

        } catch (error: any) {
            Logger.error(`Failed to fetch license tokens: ${error.message}`);
            return [];
        }
    }

    /**
     * Revoke license token (GDPR compliance)
     */
    async revokeLicenseToken(tokenId: string): Promise<void> {
        Logger.warn(`⚠️  Revoking license token: ${tokenId}`);

        try {
            const tx = await this.contract.revokeLicenseToken(tokenId);
            await tx.wait();
            Logger.info('License token revoked');

        } catch (error: any) {
            Logger.error(`License revocation failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Burn license token (permanent removal)
     */
    async burnLicenseToken(tokenId: string): Promise<void> {
        Logger.warn(`⚠️  Burning license token: ${tokenId}`);

        try {
            const tx = await this.contract.burnLicenseToken(tokenId);
            await tx.wait();
            Logger.info('License token burned');

        } catch (error: any) {
            Logger.error(`License burning failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Inherit license terms from parent BioCID
     *
     * Simple derivative licensing - no Story Protocol complexity!
     */
    async inheritLicenseTerms(derivativeBioCID: string, parentBioCID: string): Promise<void> {
        Logger.info(`Inheriting license from parent BioCID: ${parentBioCID}`);

        try {
            // Get parent license terms
            const parentLicense = await this.contract.getLicenseTerms(parentBioCID);

            // Apply same terms to derivative
            await this.contract.attachLicenseTerms(
                derivativeBioCID,
                parentLicense.pilId,
                derivativeBioCID
            );

            Logger.info('License terms inherited');

        } catch (error: any) {
            Logger.error(`License inheritance failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Find license token for specific holder
     */
    async findLicenseToken(biocid: string, holder: string): Promise<LicenseToken | null> {
        Logger.info(`Finding license token for ${holder.substring(0, 10)}...`);

        try {
            const tokens = await this.getLicenseTokens(biocid);
            const match = tokens.find(token => token.holder.toLowerCase() === holder.toLowerCase());

            if (!match) {
                Logger.warn('No license token found for holder');
                return null;
            }

            return match;

        } catch (error: any) {
            Logger.error(`License token search failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Get license terms for BioCID
     */
    async getLicenseTerms(biocid: string): Promise<LicenseTerms> {
        Logger.info(`Fetching license terms for BioCID: ${biocid}`);

        try {
            const terms = await this.contract.getLicenseTerms(biocid);
            return terms;

        } catch (error: any) {
            Logger.error(`Failed to fetch license terms: ${error.message}`);
            throw error;
        }
    }

    /**
     * Helper: Map license type string to enum
     */
    static parseLicenseType(licenseType: string): BioPILLicenseType {
        const normalized = licenseType.toLowerCase().replace(/[-_]/g, '');

        switch (normalized) {
            case 'noncommercial':
            case 'noncommercialsocialremixing':
                return BioPILLicenseType.NonCommercialSocialRemixing;

            case 'commercial':
            case 'commercialuse':
            case 'commercialuserevshare':
            case 'commercialremix':
                return BioPILLicenseType.CommercialUseRevShare;

            case 'gdpr':
            case 'gdprresearch':
            case 'research':
                return BioPILLicenseType.GDPRResearch;

            case 'ai':
            case 'aitraining':
            case 'machinelearning':
                return BioPILLicenseType.AITraining;

            case 'clinical':
            case 'clinicaluse':
            case 'medical':
                return BioPILLicenseType.ClinicalUse;

            case 'pharma':
            case 'pharmaceutical':
            case 'pharmaceuticalresearch':
            case 'drugdiscovery':
                return BioPILLicenseType.PharmaceuticalResearch;

            case 'family':
            case 'familyinheritance':
            case 'inheritance':
                return BioPILLicenseType.FamilyInheritance;

            default:
                throw new Error(`Unknown license type: ${licenseType}`);
        }
    }

    /**
     * Helper: Format license type for display
     */
    static formatLicenseType(licenseType: BioPILLicenseType): string {
        switch (licenseType) {
            case BioPILLicenseType.NonCommercialSocialRemixing:
                return '📚 Non-Commercial (Research/Education)';
            case BioPILLicenseType.CommercialUseRevShare:
                return '💰 Commercial Use (Revenue Share)';
            case BioPILLicenseType.GDPRResearch:
                return '🔒 GDPR Consent Research';
            case BioPILLicenseType.AITraining:
                return '🤖 AI Training (Revenue Share)';
            case BioPILLicenseType.ClinicalUse:
                return '🏥 Clinical Use';
            case BioPILLicenseType.PharmaceuticalResearch:
                return '💊 Pharmaceutical Research';
            case BioPILLicenseType.FamilyInheritance:
                return '👨‍👩‍👧‍👦 Family Inheritance';
            default:
                return '❓ Unknown License';
        }
    }

    /**
     * Helper: Get license description
     */
    static getLicenseDescription(licenseType: BioPILLicenseType): string {
        switch (licenseType) {
            case BioPILLicenseType.NonCommercialSocialRemixing:
                return 'Free for research and education. No commercial use.';
            case BioPILLicenseType.CommercialUseRevShare:
                return 'Commercial use allowed with revenue sharing.';
            case BioPILLicenseType.GDPRResearch:
                return 'Research use with GDPR consent. Revocable.';
            case BioPILLicenseType.AITraining:
                return 'AI/ML training with revenue share on derived models.';
            case BioPILLicenseType.ClinicalUse:
                return 'Medical diagnosis and treatment planning.';
            case BioPILLicenseType.PharmaceuticalResearch:
                return 'Drug discovery and development with revenue share.';
            case BioPILLicenseType.FamilyInheritance:
                return 'Family control with automatic revenue distribution to heirs.';
            default:
                return 'Unknown license type.';
        }
    }
}

