/**
 * Configuration Tests
 *
 * Tests for Sequentia configuration and contract addresses.
 */

describe('Sequentia Configuration', () => {
    // Configuration constants (matching src/lib/sequentia/index.ts)
    const SEQUENTIA_CONFIG = {
        rpcUrl: 'http://52.90.163.112:8545',
        chainId: 15132025,
        usdcToken: '0xD837B344e931cc265ec54879A0B388DE6F0015c9',
        consentManager: '0x2ff3FB85c71D6cD7F1217A08Ac9a2d68C02219cd',
        openCravatJobs: '0xB384A7531d59cFd45f98f71833aF736b921a5FCB',
        paymentRouter: '0x4b46D8A0533bc17503349F86a909C2FEcFD04489',
        bioPIL: '0x6474485F6fE3c19Ac0cD069D4cBc421656942DA9',
        bioCIDRegistry: '0x6Fb51DB12AE422F8360a31a27B3E960f4DC0004b',
        labNFT: '0x24f42752F491540e305384A5C947911649C910CF'
    };

    describe('Chain configuration', () => {
        it('should have correct chain ID (15132025)', () => {
            expect(SEQUENTIA_CONFIG.chainId).toBe(15132025);
        });

        it('should have valid RPC URL', () => {
            expect(SEQUENTIA_CONFIG.rpcUrl).toMatch(/^http/);
            expect(SEQUENTIA_CONFIG.rpcUrl).toContain('52.90.163.112');
            expect(SEQUENTIA_CONFIG.rpcUrl).toContain('8545');
        });
    });

    describe('Contract addresses', () => {
        const addressRegex = /^0x[a-fA-F0-9]{40}$/;

        it('should have valid USDC token address', () => {
            expect(SEQUENTIA_CONFIG.usdcToken).toMatch(addressRegex);
        });

        it('should have valid ConsentManager address', () => {
            expect(SEQUENTIA_CONFIG.consentManager).toMatch(addressRegex);
        });

        it('should have valid OpenCravatJobs address', () => {
            expect(SEQUENTIA_CONFIG.openCravatJobs).toMatch(addressRegex);
        });

        it('should have valid PaymentRouter address', () => {
            expect(SEQUENTIA_CONFIG.paymentRouter).toMatch(addressRegex);
        });

        it('should have valid BioPIL address', () => {
            expect(SEQUENTIA_CONFIG.bioPIL).toMatch(addressRegex);
        });

        it('should have valid BioCIDRegistry address', () => {
            expect(SEQUENTIA_CONFIG.bioCIDRegistry).toMatch(addressRegex);
        });

        it('should have valid LabNFT address', () => {
            expect(SEQUENTIA_CONFIG.labNFT).toMatch(addressRegex);
        });

        it('should have all required contract addresses', () => {
            const requiredContracts = [
                'usdcToken',
                'consentManager',
                'openCravatJobs',
                'paymentRouter',
                'bioPIL',
                'bioCIDRegistry',
                'labNFT'
            ];

            requiredContracts.forEach(contract => {
                expect(SEQUENTIA_CONFIG).toHaveProperty(contract);
                expect(SEQUENTIA_CONFIG[contract as keyof typeof SEQUENTIA_CONFIG]).toMatch(addressRegex);
            });
        });
    });

    describe('Address uniqueness', () => {
        it('should have unique addresses for each contract', () => {
            const addresses = [
                SEQUENTIA_CONFIG.usdcToken,
                SEQUENTIA_CONFIG.consentManager,
                SEQUENTIA_CONFIG.openCravatJobs,
                SEQUENTIA_CONFIG.paymentRouter,
                SEQUENTIA_CONFIG.bioPIL,
                SEQUENTIA_CONFIG.bioCIDRegistry,
                SEQUENTIA_CONFIG.labNFT
            ].map(addr => addr.toLowerCase());

            const uniqueAddresses = new Set(addresses);
            expect(uniqueAddresses.size).toBe(addresses.length);
        });
    });
});

describe('FileFormat enum', () => {
    // Enum values matching BioCIDRegistry.sol
    const FileFormat = {
        VCF: 1,
        BAM: 2,
        FASTQ: 3,
        SQLITE: 4,
        CSV: 5
    };

    it('should have correct VCF value', () => {
        expect(FileFormat.VCF).toBe(1);
    });

    it('should have correct BAM value', () => {
        expect(FileFormat.BAM).toBe(2);
    });

    it('should have correct FASTQ value', () => {
        expect(FileFormat.FASTQ).toBe(3);
    });

    it('should have correct SQLITE value', () => {
        expect(FileFormat.SQLITE).toBe(4);
    });

    it('should have correct CSV value', () => {
        expect(FileFormat.CSV).toBe(5);
    });
});

describe('ConsentStatus enum', () => {
    const ConsentStatus = {
        NotProvided: 0,
        Active: 1,
        Revoked: 2,
        Expired: 3,
        Transferred: 4
    };

    it('should have correct NotProvided value', () => {
        expect(ConsentStatus.NotProvided).toBe(0);
    });

    it('should have correct Active value', () => {
        expect(ConsentStatus.Active).toBe(1);
    });

    it('should have correct Revoked value', () => {
        expect(ConsentStatus.Revoked).toBe(2);
    });

    it('should have correct Expired value', () => {
        expect(ConsentStatus.Expired).toBe(3);
    });

    it('should have correct Transferred value', () => {
        expect(ConsentStatus.Transferred).toBe(4);
    });
});

describe('BioPILLicenseType enum', () => {
    const BioPILLicenseType = {
        NonCommercialSocialRemixing: 1,
        CommercialUseRevShare: 2,
        GDPRResearch: 5,
        AITraining: 6,
        ClinicalUse: 7,
        PharmaResearch: 8,
        FamilyInheritance: 9
    };

    it('should have correct license type values', () => {
        expect(BioPILLicenseType.NonCommercialSocialRemixing).toBe(1);
        expect(BioPILLicenseType.CommercialUseRevShare).toBe(2);
        expect(BioPILLicenseType.GDPRResearch).toBe(5);
        expect(BioPILLicenseType.AITraining).toBe(6);
        expect(BioPILLicenseType.ClinicalUse).toBe(7);
        expect(BioPILLicenseType.PharmaResearch).toBe(8);
        expect(BioPILLicenseType.FamilyInheritance).toBe(9);
    });
});

describe('JobStatus enum', () => {
    const JobStatus = {
        Pending: 0,
        Assigned: 1,
        InProgress: 2,
        Completed: 3,
        Failed: 4,
        Disputed: 5
    };

    it('should have correct job status values', () => {
        expect(JobStatus.Pending).toBe(0);
        expect(JobStatus.Assigned).toBe(1);
        expect(JobStatus.InProgress).toBe(2);
        expect(JobStatus.Completed).toBe(3);
        expect(JobStatus.Failed).toBe(4);
        expect(JobStatus.Disputed).toBe(5);
    });
});


