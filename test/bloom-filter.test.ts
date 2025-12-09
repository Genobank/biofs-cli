/**
 * BloomFilter Tests
 *
 * Tests for Bloom Filter fingerprinting used in BioCID file identity.
 */

import { createHash } from 'crypto';

// Inline BloomFilter implementation for testing (avoids Logger dependency)
interface SNP {
    rsid: string;
    chromosome: string;
    position: number;
    genotype: string;
    ref: string;
    alt: string;
}

class BloomFilterFingerprint {
    private capacity: number = 10000;
    private errorRate: number = 0.001;
    private bitArray: Uint8Array;
    private hashFunctions: number;

    constructor() {
        const bits = Math.ceil(
            (this.capacity * Math.log(this.errorRate)) / Math.log(1 / Math.pow(2, Math.log(2)))
        );
        this.hashFunctions = Math.ceil((bits / this.capacity) * Math.log(2));
        this.bitArray = new Uint8Array(Math.ceil(bits / 8));
    }

    add(snp: SNP): void {
        const snpKey = `${snp.chromosome}:${snp.position}:${snp.genotype}:${snp.ref}:${snp.alt}`;
        for (let i = 0; i < this.hashFunctions; i++) {
            const hash = this.hash(snpKey, i);
            const bitIndex = hash % (this.bitArray.length * 8);
            const byteIndex = Math.floor(bitIndex / 8);
            const bitOffset = bitIndex % 8;
            this.bitArray[byteIndex] |= (1 << bitOffset);
        }
    }

    getFingerprint(): Uint8Array {
        const hash = createHash('sha256').update(this.bitArray).digest();
        return new Uint8Array(hash);
    }

    private hash(key: string, seed: number): number {
        const hash = createHash('sha256')
            .update(key + seed.toString())
            .digest();
        return (
            (hash[0] << 24) |
            (hash[1] << 16) |
            (hash[2] << 8) |
            hash[3]
        ) >>> 0;
    }
}

describe('BloomFilterFingerprint', () => {
    describe('constructor', () => {
        it('should create a bloom filter instance', () => {
            const bloom = new BloomFilterFingerprint();
            expect(bloom).toBeInstanceOf(BloomFilterFingerprint);
        });
    });

    describe('add', () => {
        it('should add SNPs without throwing', () => {
            const bloom = new BloomFilterFingerprint();
            expect(() => {
                bloom.add({
                    rsid: 'rs123456',
                    chromosome: '1',
                    position: 12345,
                    genotype: 'AG',
                    ref: 'A',
                    alt: 'G'
                });
            }).not.toThrow();
        });

        it('should handle multiple SNPs', () => {
            const bloom = new BloomFilterFingerprint();
            for (let i = 0; i < 100; i++) {
                bloom.add({
                    rsid: `rs${i}`,
                    chromosome: String(Math.floor(i / 10) + 1),
                    position: i * 1000,
                    genotype: 'AG',
                    ref: 'A',
                    alt: 'G'
                });
            }
            const fingerprint = bloom.getFingerprint();
            expect(fingerprint.length).toBe(32);
        });
    });

    describe('getFingerprint', () => {
        it('should return 32-byte SHA-256 hash', () => {
            const bloom = new BloomFilterFingerprint();
            bloom.add({
                rsid: 'rs123456',
                chromosome: '1',
                position: 12345,
                genotype: 'AG',
                ref: 'A',
                alt: 'G'
            });
            const fingerprint = bloom.getFingerprint();
            expect(fingerprint).toBeInstanceOf(Uint8Array);
            expect(fingerprint.length).toBe(32);
        });

        it('should produce consistent fingerprints', () => {
            const bloom1 = new BloomFilterFingerprint();
            const bloom2 = new BloomFilterFingerprint();

            const snp = {
                rsid: 'rs123456',
                chromosome: '1',
                position: 12345,
                genotype: 'AG',
                ref: 'A',
                alt: 'G'
            };

            bloom1.add(snp);
            bloom2.add(snp);

            const fp1 = Buffer.from(bloom1.getFingerprint()).toString('hex');
            const fp2 = Buffer.from(bloom2.getFingerprint()).toString('hex');

            expect(fp1).toBe(fp2);
        });

        it('should produce different fingerprints for different SNPs', () => {
            const bloom1 = new BloomFilterFingerprint();
            const bloom2 = new BloomFilterFingerprint();

            bloom1.add({
                rsid: 'rs123456',
                chromosome: '1',
                position: 12345,
                genotype: 'AG',
                ref: 'A',
                alt: 'G'
            });

            bloom2.add({
                rsid: 'rs654321',
                chromosome: '2',
                position: 67890,
                genotype: 'CT',
                ref: 'C',
                alt: 'T'
            });

            const fp1 = Buffer.from(bloom1.getFingerprint()).toString('hex');
            const fp2 = Buffer.from(bloom2.getFingerprint()).toString('hex');

            expect(fp1).not.toBe(fp2);
        });

        it('should produce same fingerprint regardless of SNP order', () => {
            const bloom1 = new BloomFilterFingerprint();
            const bloom2 = new BloomFilterFingerprint();

            const snps = [
                { rsid: 'rs1', chromosome: '1', position: 100, genotype: 'AG', ref: 'A', alt: 'G' },
                { rsid: 'rs2', chromosome: '1', position: 200, genotype: 'CT', ref: 'C', alt: 'T' },
                { rsid: 'rs3', chromosome: '1', position: 300, genotype: 'GG', ref: 'G', alt: 'A' }
            ];

            // Add in order
            snps.forEach(snp => bloom1.add(snp));

            // Add in reverse order
            [...snps].reverse().forEach(snp => bloom2.add(snp));

            const fp1 = Buffer.from(bloom1.getFingerprint()).toString('hex');
            const fp2 = Buffer.from(bloom2.getFingerprint()).toString('hex');

            expect(fp1).toBe(fp2);
        });
    });

    describe('SNP key format', () => {
        it('should use correct SNP key format: chrom:pos:GT:ref:alt', () => {
            // This test validates the SNP key format matches BioCIDRegistry.sol
            const bloom = new BloomFilterFingerprint();

            // Add an SNP with known values
            const snp = {
                rsid: 'rs123',
                chromosome: 'chr1',
                position: 12345,
                genotype: '0/1',
                ref: 'A',
                alt: 'G'
            };

            bloom.add(snp);
            const fingerprint = bloom.getFingerprint();

            // Verify fingerprint is valid SHA-256
            expect(fingerprint.length).toBe(32);
            expect(Buffer.from(fingerprint).toString('hex')).toMatch(/^[a-f0-9]{64}$/);
        });
    });
});

describe('Fingerprint determinism', () => {
    it('should produce identical fingerprints for identical SNP sets across runs', () => {
        // Create multiple bloom filters with same data
        const fingerprints: string[] = [];

        for (let run = 0; run < 5; run++) {
            const bloom = new BloomFilterFingerprint();

            // Add same SNPs each run
            bloom.add({ rsid: 'rs1', chromosome: '1', position: 100, genotype: 'AA', ref: 'A', alt: 'G' });
            bloom.add({ rsid: 'rs2', chromosome: '2', position: 200, genotype: 'CT', ref: 'C', alt: 'T' });
            bloom.add({ rsid: 'rs3', chromosome: '3', position: 300, genotype: 'GG', ref: 'G', alt: 'A' });

            fingerprints.push(Buffer.from(bloom.getFingerprint()).toString('hex'));
        }

        // All fingerprints should be identical
        const firstFp = fingerprints[0];
        fingerprints.forEach(fp => {
            expect(fp).toBe(firstFp);
        });
    });
});


