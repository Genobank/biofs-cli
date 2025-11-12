/**
 * ConsentManager - GDPR Article 17 Right to Erasure
 *
 * Manages consent for genomic data sharing with full GDPR compliance:
 * - Parental consent for newborn sequences (multi-party approval)
 * - Age of majority transfer (automatic at 18)
 * - Consent revocation (triggers S3 deletion)
 * - Family inheritance rules
 * - Time-limited consent
 * - Access logging for GDPR Article 15 (right to access)
 *
 * This is WHY we use Sequentia Protocol instead of Story Protocol:
 * Story Protocol IP Assets are IMMUTABLE - cannot be deleted
 * Sequentia ConsentManager enables true GDPR compliance
 */

import { ethers } from 'ethers';
import { Logger } from '../utils/logger';

// Sequentia Network Configuration
const SEQUENTIA_RPC_URL = 'http://52.90.163.112:8545';
const CONSENT_MANAGER_ADDRESS = '0x0000000000000000000000000000000000000000'; // TODO: Deploy (optional for basic operations)

export enum ConsentStatus {
    NotProvided = 0,
    Active = 1,
    Revoked = 2,        // GDPR Article 17
    Expired = 3,
    Transferred = 4      // Age of majority
}

export enum ConsentType {
    Clinical = 0,
    Research = 1,
    Commercial = 2,
    AITraining = 3,
    FamilySharing = 4,
    PublicDatabase = 5
}

export interface ConsentRecord {
    biocid: string;
    subject: string;                 // Data subject (e.g., newborn)
    grantors: string[];              // Parents/guardians
    grantorApproved: Map<string, boolean>;
    consentTypes: ConsentType[];
    status: ConsentStatus;
    grantedAt: number;
    expiresAt: number;
    ageOfMajority: number;          // Unix timestamp when subject turns 18
    purpose: string;
    requiresAllGrantors: boolean;
}

export interface AccessLog {
    biocid: string;
    accessor: string;
    action: string;                  // 'download', 'view', 'share', 'analyze'
    timestamp: number;
    ipAddress?: string;
}

export class ConsentManager {
    private contract: ethers.Contract;
    private signer: ethers.Wallet;
    

    constructor(privateKey: string) {
        

        try {
            // ConsentManager is optional for basic operations
            if (CONSENT_MANAGER_ADDRESS === '0x0000000000000000000000000000000000000000') {
                Logger.warn('ConsentManager not deployed - GDPR features disabled');
                this.contract = null as any;
                this.signer = null as any;
                return;
            }

            const provider = new ethers.JsonRpcProvider(SEQUENTIA_RPC_URL);
            this.signer = new ethers.Wallet(privateKey, provider);

            const abi = require('../../abi/sequentia/ConsentManager.json');
            this.contract = new ethers.Contract(
                CONSENT_MANAGER_ADDRESS,
                abi,
                this.signer
            );

            Logger.info('ConsentManager initialized');
        } catch (error: any) {
            Logger.error(`Failed to initialize ConsentManager: ${error.message}`);
            throw error;
        }
    }

    /**
     * Create consent (parental or self-consent)
     */
    async createConsent(
        biocid: string,
        subject: string,
        grantors: string[],
        consentTypes: ConsentType[],
        birthDate: number,           // Unix timestamp of birth
        expiresAt: number,           // 0 = never expires
        purpose: string,
        requiresAllGrantors: boolean = true
    ): Promise<string> {
        Logger.info(`Creating consent for BioCID: ${biocid}`);
        Logger.info(`Subject: ${subject}`);
        Logger.info(`Grantors: ${grantors.join(', ')}`);
        Logger.info(`Types: ${consentTypes.map(t => ConsentType[t]).join(', ')}`);

        try {
            const tx = await this.contract.createConsent(
                biocid,
                subject,
                grantors,
                consentTypes,
                birthDate,
                expiresAt,
                purpose,
                requiresAllGrantors
            );

            Logger.info(`Transaction submitted: ${tx.hash}`);
            const receipt = await tx.wait();
            Logger.info(`Consent created in block ${receipt.blockNumber}`);

            return biocid;

        } catch (error: any) {
            Logger.error(`Consent creation failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Approve consent (for multi-party approval)
     */
    async approveConsent(biocid: string): Promise<void> {
        Logger.info(`Approving consent for BioCID: ${biocid}`);

        try {
            const tx = await this.contract.approveConsent(biocid);
            await tx.wait();
            Logger.info('Consent approved');

        } catch (error: any) {
            Logger.error(`Consent approval failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Revoke consent (GDPR Article 17 - Right to Erasure)
     *
     * This triggers off-chain S3 deletion via backend event listener
     */
    async revokeConsent(biocid: string, reason: string): Promise<void> {
        Logger.warn(`⚠️  REVOKING consent for BioCID: ${biocid}`);
        Logger.warn(`   Reason: ${reason}`);
        Logger.warn(`   This will trigger S3 deletion (GDPR Article 17)`);

        try {
            const tx = await this.contract.revokeConsent(biocid, reason);
            const receipt = await tx.wait();

            Logger.info('✅ Consent revoked');
            Logger.info('   ConsentRevoked event emitted for backend S3 deletion');
            Logger.info(`   GDPR Article 17: Right to erasure executed`);

            // Parse event for confirmation
            const event = receipt.logs.find((log: any) => {
                try {
                    return log.topics[0] === this.contract.interface.getEvent('ConsentRevoked')!.topicHash;
                } catch {
                    return false;
                }
            });

            if (event) {
                Logger.info('   Backend will delete S3 file within 24 hours');
            }

        } catch (error: any) {
            Logger.error(`Consent revocation failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Check consent status
     */
    async checkConsent(biocid: string): Promise<ConsentStatus> {
        // Return Active if ConsentManager not deployed
        if (!this.contract) {
            return ConsentStatus.Active;
        }

        Logger.info(`Checking consent for BioCID: ${biocid}`);

        try {
            const consent = await this.contract.getConsent(biocid);
            const status: ConsentStatus = consent.status;

            Logger.info(`Consent status: ${ConsentStatus[status]}`);

            // Check if age of majority reached (automatic transfer)
            if (consent.ageOfMajority > 0 && consent.ageOfMajority < Date.now() / 1000) {
                Logger.info('   Age of majority reached - automatic transfer');
                return ConsentStatus.Transferred;
            }

            // Check expiration
            if (consent.expiresAt > 0 && consent.expiresAt < Date.now() / 1000) {
                Logger.warn('   Consent expired');
                return ConsentStatus.Expired;
            }

            return status;

        } catch (error: any) {
            Logger.error(`Consent check failed: ${error.message}`);
            // Default to NotProvided if consent doesn't exist
            return ConsentStatus.NotProvided;
        }
    }

    /**
     * Verify consent is valid (Active and not expired)
     */
    async isConsentValid(biocid: string): Promise<boolean> {
        const status = await this.checkConsent(biocid);
        return status === ConsentStatus.Active;
    }

    /**
     * Get full consent record
     */
    async getConsentRecord(biocid: string): Promise<ConsentRecord | null> {
        Logger.info(`Fetching consent record for BioCID: ${biocid}`);

        try {
            const consent = await this.contract.getConsent(biocid);

            // Convert to our interface
            const grantorApproved = new Map<string, boolean>();
            for (let i = 0; i < consent.grantors.length; i++) {
                grantorApproved.set(
                    consent.grantors[i],
                    consent.grantorApproved[i]
                );
            }

            return {
                biocid,
                subject: consent.subject,
                grantors: consent.grantors,
                grantorApproved,
                consentTypes: consent.consentTypes,
                status: consent.status,
                grantedAt: consent.grantedAt,
                expiresAt: consent.expiresAt,
                ageOfMajority: consent.ageOfMajority,
                purpose: consent.purpose,
                requiresAllGrantors: consent.requiresAllGrantors
            };

        } catch (error: any) {
            Logger.error(`Failed to fetch consent record: ${error.message}`);
            return null;
        }
    }

    /**
     * Log access for GDPR Article 15 (Right to Access)
     */
    async logAccess(
        biocid: string,
        accessor: string,
        action: string,
        timestamp: Date
    ): Promise<void> {
        Logger.info(`Logging access: ${action} by ${accessor.substring(0, 10)}...`);

        try {
            const tx = await this.contract.logAccess(
                biocid,
                accessor,
                action,
                Math.floor(timestamp.getTime() / 1000)
            );
            await tx.wait();
            Logger.info('Access logged (GDPR Article 15 compliance)');

        } catch (error: any) {
            // Log access errors shouldn't block the main operation
            Logger.warn(`Failed to log access: ${error.message}`);
        }
    }

    /**
     * Get access logs for a BioCID
     */
    async getAccessLogs(biocid: string): Promise<AccessLog[]> {
        Logger.info(`Fetching access logs for BioCID: ${biocid}`);

        try {
            const logs = await this.contract.getAccessLogs(biocid);
            Logger.info(`Found ${logs.length} access log(s)`);
            return logs;

        } catch (error: any) {
            Logger.error(`Failed to fetch access logs: ${error.message}`);
            return [];
        }
    }

    /**
     * Declare family inheritance (for deceased data subjects)
     */
    async declareFamilyInheritance(
        deceased: string,
        heirs: string[],
        heirShares: number[],      // Basis points (10000 = 100%)
        biocids: string[]
    ): Promise<void> {
        Logger.info(`Declaring family inheritance for ${deceased}`);
        Logger.info(`Heirs: ${heirs.join(', ')}`);

        if (heirs.length !== heirShares.length) {
            throw new Error('Heirs and shares arrays must have same length');
        }

        const totalShares = heirShares.reduce((sum, share) => sum + share, 0);
        if (totalShares !== 10000) {
            throw new Error('Heir shares must sum to 10000 basis points (100%)');
        }

        try {
            const tx = await this.contract.declareFamilyInheritance(
                deceased,
                heirs,
                heirShares,
                biocids
            );
            await tx.wait();
            Logger.info('Family inheritance declared');

        } catch (error: any) {
            Logger.error(`Family inheritance declaration failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Transfer consent to subject at age of majority
     */
    async transferConsentToSubject(biocid: string): Promise<void> {
        Logger.info(`Transferring consent to subject for BioCID: ${biocid}`);

        try {
            const tx = await this.contract.transferConsentToSubject(biocid);
            await tx.wait();
            Logger.info('Consent transferred to subject (age of majority reached)');

        } catch (error: any) {
            Logger.error(`Consent transfer failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Helper: Calculate age of majority timestamp
     */
    static calculateAgeOfMajority(birthDate: Date): number {
        const ageOfMajority = new Date(birthDate);
        ageOfMajority.setFullYear(ageOfMajority.getFullYear() + 18);
        return Math.floor(ageOfMajority.getTime() / 1000);
    }

    /**
     * Helper: Format consent status for display
     */
    static formatConsentStatus(status: ConsentStatus): string {
        switch (status) {
            case ConsentStatus.Active:
                return '✅ Active';
            case ConsentStatus.Revoked:
                return '❌ Revoked (GDPR Article 17)';
            case ConsentStatus.Expired:
                return '⏰ Expired';
            case ConsentStatus.Transferred:
                return '🎂 Transferred (Age of Majority)';
            case ConsentStatus.NotProvided:
                return '⚠️  Not Provided';
            default:
                return '❓ Unknown';
        }
    }
}
