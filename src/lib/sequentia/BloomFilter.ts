/**
 * Bloom Filter Fingerprinting for Genomic Files
 *
 * Creates DNA-specific fingerprints using Bloom Filters to:
 * 1. Uniquely identify files based on SNP content
 * 2. Detect duplicates across different uploads
 * 3. Enable cross-format tracking (FASTQ → BAM → VCF → SQLite)
 *
 * Parameters (matching BioCIDRegistry.sol):
 * - Capacity: 10,000 SNPs
 * - Error rate: 0.001 (0.1%)
 * - SNP format: {chrom}:{pos}:{GT}:{ref}:{alt}
 */

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import { Logger } from '../utils/logger';

export interface SNP {
    rsid: string;
    chromosome: string;
    position: number;
    genotype: string;
    ref: string;
    alt: string;
    gene?: string;
    phenotype?: string;
}

export class BloomFilterFingerprint {
    
    private capacity: number = 10000;
    private errorRate: number = 0.001;
    private bitArray: Uint8Array;
    private hashFunctions: number;

    constructor() {
        

        // Calculate optimal bit array size and number of hash functions
        const bits = Math.ceil(
            (this.capacity * Math.log(this.errorRate)) / Math.log(1 / Math.pow(2, Math.log(2)))
        );
        this.hashFunctions = Math.ceil((bits / this.capacity) * Math.log(2));

        this.bitArray = new Uint8Array(Math.ceil(bits / 8));
        Logger.info(`Initialized Bloom Filter: ${bits} bits, ${this.hashFunctions} hash functions`);
    }

    /**
     * Add SNP to Bloom Filter
     */
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

    /**
     * Calculate fingerprint (SHA-256 of Bloom Filter bits)
     */
    getFingerprint(): Uint8Array {
        const hash = createHash('sha256').update(this.bitArray).digest();
        Logger.info(`Fingerprint: 0x${Buffer.from(hash).toString('hex').substring(0, 16)}...`);
        return new Uint8Array(hash);
    }

    /**
     * Parse VCF file and calculate fingerprint
     */
    static async fromVCF(vcfPath: string): Promise<Uint8Array> {
        Logger.info(`Reading VCF: ${vcfPath}`);

        const bloom = new BloomFilterFingerprint();
        const content = await fs.readFile(vcfPath, 'utf-8');
        const lines = content.split('\n');

        let snpCount = 0;

        for (const line of lines) {
            // Skip headers and empty lines
            if (line.startsWith('#') || line.trim() === '') {
                continue;
            }

            const fields = line.split('\t');
            if (fields.length < 5) {
                continue;
            }

            const [chrom, pos, id, ref, alt, qual, filter, info, format, ...samples] = fields;

            // Extract genotype from first sample
            let genotype = 'GT';
            if (samples.length > 0 && format) {
                const formatFields = format.split(':');
                const gtIndex = formatFields.indexOf('GT');
                if (gtIndex !== -1) {
                    const sampleFields = samples[0].split(':');
                    genotype = sampleFields[gtIndex] || 'GT';
                }
            }

            // Add to Bloom Filter
            bloom.add({
                rsid: id,
                chromosome: chrom,
                position: parseInt(pos),
                genotype,
                ref,
                alt
            });

            snpCount++;

            // Stop at capacity limit
            if (snpCount >= 10000) {
                Logger.warn(`Reached capacity limit of 10,000 SNPs`);
                break;
            }
        }

        Logger.info(`Processed ${snpCount} SNPs`);
        return bloom.getFingerprint();
    }

    /**
     * Parse 23andMe file and calculate fingerprint
     */
    static async from23andMe(txtPath: string): Promise<Uint8Array> {
        Logger.info(`Reading 23andMe: ${txtPath}`);

        const bloom = new BloomFilterFingerprint();
        const content = await fs.readFile(txtPath, 'utf-8');
        const lines = content.split('\n');

        let snpCount = 0;

        for (const line of lines) {
            // Skip comments and empty lines
            if (line.startsWith('#') || line.trim() === '') {
                continue;
            }

            const fields = line.split('\t');
            if (fields.length < 4) {
                continue;
            }

            const [rsid, chrom, pos, genotype] = fields;

            // Skip if not a valid SNP
            if (!rsid.startsWith('rs')) {
                continue;
            }

            // Add to Bloom Filter
            // Note: 23andMe doesn't provide ref/alt, so we use genotype directly
            bloom.add({
                rsid,
                chromosome: chrom,
                position: parseInt(pos),
                genotype,
                ref: genotype[0] || '',
                alt: genotype[1] || ''
            });

            snpCount++;

            if (snpCount >= 10000) {
                Logger.warn(`Reached capacity limit of 10,000 SNPs`);
                break;
            }
        }

        Logger.info(`Processed ${snpCount} SNPs`);
        return bloom.getFingerprint();
    }

    /**
     * Parse Ancestry.com file and calculate fingerprint
     */
    static async fromAncestry(txtPath: string): Promise<Uint8Array> {
        // Ancestry format is similar to 23andMe
        return this.from23andMe(txtPath);
    }

    /**
     * Detect file format and calculate fingerprint
     */
    static async fromFile(filePath: string): Promise<Uint8Array> {
        // Detect format from extension
        const ext = filePath.toLowerCase().split('.').pop();

        Logger.info(`Detected format: ${ext}`);

        switch (ext) {
            case 'vcf':
            case 'vcf.gz':
                return this.fromVCF(filePath);

            case 'txt':
                // Try to detect 23andMe vs Ancestry format
                const content = await fs.readFile(filePath, 'utf-8');
                if (content.includes('# This data file generated by 23andMe')) {
                    return this.from23andMe(filePath);
                } else {
                    return this.fromAncestry(filePath);
                }

            default:
                throw new Error(`Unsupported file format: ${ext}`);
        }
    }

    /**
     * Hash function for Bloom Filter
     */
    private hash(key: string, seed: number): number {
        const hash = createHash('sha256')
            .update(key + seed.toString())
            .digest();

        // Convert first 4 bytes to number
        return (
            (hash[0] << 24) |
            (hash[1] << 16) |
            (hash[2] << 8) |
            hash[3]
        ) >>> 0; // Unsigned 32-bit integer
    }
}

/**
 * Convenience function for quick fingerprint calculation
 */
export async function calculateFingerprint(filePath: string): Promise<Uint8Array> {
    return BloomFilterFingerprint.fromFile(filePath);
}

/**
 * Extract phenotype-specific SNPs from VCF
 */
export async function extractPhenotypeSubset(
    vcfPath: string,
    phenotype: string,
    relevantSNPs: SNP[]
): Promise<{ content: string; snpCount: number }> {
    Logger.info(`Extracting SNPs for phenotype: ${phenotype}`);

    const vcfContent = await fs.readFile(vcfPath, 'utf-8');
    const lines = vcfContent.split('\n');

    // Keep headers
    const outputLines = lines.filter(line => line.startsWith('#'));

    // Extract only relevant SNPs
    let snpCount = 0;
    const relevantPositions = new Set(
        relevantSNPs.map(snp => `${snp.chromosome}:${snp.position}`)
    );

    for (const line of lines) {
        if (line.startsWith('#') || line.trim() === '') {
            continue;
        }

        const [chrom, pos] = line.split('\t');
        const key = `${chrom}:${pos}`;

        if (relevantPositions.has(key)) {
            outputLines.push(line);
            snpCount++;
        }
    }

    Logger.info(`Extracted ${snpCount} SNPs`);

    return {
        content: outputLines.join('\n'),
        snpCount
    };
}

