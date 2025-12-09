/**
 * VCF Fingerprint Calculator
 * Ported from Python vcfAnnotator/libs/utils/fingerprint.py
 *
 * Calculates DNA fingerprints from VCF, 23andMe, and genomic text files
 * using SNP markers and bloom filters for privacy-preserving identification.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as zlib from 'zlib';
import { BloomFilter } from 'bloom-filters';

export interface SNP {
  chrom: string;
  pos: number;
  variantId: string;
  gt: string;
  ref: string;
  alt: string;
}

export class VCFFingerprint {
  // SNPs used for fingerprinting (from 23andMe)
  private readonly fingerprintSNPs = [
    'rs952718', 'rs7803075', 'rs9319336', 'rs2397060', 'rs1344870', 'rs2946788',
    'rs6591147', 'rs2272998', 'rs7229946', 'rs9951171', 'rs525869', 'rs530501',
    'rs2040962', 'rs2032624', 'rs1865680', 'rs17307398', 'rs3795366', 'rs2460111',
    'rs1675126', 'rs1061629', 'rs538847', 'rs76432344', 'rs3750390', 'rs1624844',
    'rs3803390', 'rs2293768', 'rs9358890', 'rs11197835', 'rs1806191', 'rs7953',
    'rs3736757', 'rs2940779', 'rs7522034', 'rs6107027', 'rs2275059', 'rs3746805',
    'rs4953042', 'rs3817098', 'rs6965201', 'rs5998', 'rs7259333', 'rs1802778',
    'rs907157', 'rs8064024', 'rs3749970', 'rs7933089', 'rs2292745', 'rs1799932',
    'rs4078313', 'rs2266918', 'rs805423', 'rs540261', 'rs3734586', 'rs3753886'
  ];

  /**
   * Process a file and generate DNA fingerprint
   */
  async processFile(filePath: string, sampleIndex: number = 0, numSnps: number = 50): Promise<string> {
    // Read file (handle .gz compression)
    let fileContent: Buffer;

    if (filePath.endsWith('.gz')) {
      const compressed = fs.readFileSync(filePath);
      fileContent = zlib.gunzipSync(compressed);
    } else {
      fileContent = fs.readFileSync(filePath);
    }

    const text = fileContent.toString('utf-8');
    const lines = text.split('\n');

    // Detect file type
    const is23andMe = this.detect23andMe(lines);
    const isVCF = this.detectVCF(lines);

    if (is23andMe) {
      return this.process23andMe(lines);
    } else if (isVCF) {
      return this.processVCF(lines, sampleIndex, numSnps);
    } else {
      // Try 23andMe format by default
      return this.process23andMe(lines);
    }
  }

  /**
   * Process text content directly (for in-memory data)
   */
  processText(text: string, sampleIndex: number = 0, numSnps: number = 50): string {
    const lines = text.split('\n');

    const is23andMe = this.detect23andMe(lines);
    const isVCF = this.detectVCF(lines);

    if (is23andMe) {
      return this.process23andMe(lines);
    } else if (isVCF) {
      return this.processVCF(lines, sampleIndex, numSnps);
    } else {
      return this.process23andMe(lines);
    }
  }

  /**
   * Detect 23andMe format
   */
  private detect23andMe(lines: string[]): boolean {
    for (const line of lines.slice(0, 50)) {
      if (line.includes('23andMe') || line.includes('AncestryDNA') || line.includes('MyHeritage')) {
        return true;
      }
      if (line.startsWith('# rsid') || (line.startsWith('rs') && line.includes('\t'))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detect VCF format
   */
  private detectVCF(lines: string[]): boolean {
    for (const line of lines.slice(0, 50)) {
      if (line.startsWith('##fileformat=VCF') || line.startsWith('#CHROM')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Process 23andMe format file
   */
  private process23andMe(lines: string[]): string {
    const snpGenotypes: { [rsid: string]: string } = {};

    for (const line of lines) {
      // Skip comments and headers
      if (line.startsWith('#') || !line.trim()) {
        continue;
      }

      // Split by tab
      const parts = line.trim().split('\t');
      if (parts.length >= 4) {
        const rsid = parts[0];
        const genotype = parts[3] || '';

        // Check if this is one of our fingerprint SNPs
        if (this.fingerprintSNPs.includes(rsid)) {
          snpGenotypes[rsid] = genotype;
        }
      }
    }

    if (Object.keys(snpGenotypes).length === 0) {
      throw new Error('No fingerprint SNPs found in file');
    }

    return this.generateBloomFingerprint(snpGenotypes);
  }

  /**
   * Process VCF format file
   */
  private processVCF(lines: string[], sampleIndex: number, numSnps: number): string {
    let sampleNames: string[] = [];
    let firstSampleIdx = -1;

    // Find header line
    for (const line of lines) {
      if (line.startsWith('#CHROM')) {
        const headerFields = line.trim().split('\t');
        if (headerFields.length < 9) {
          throw new Error('No samples in VCF file');
        }
        sampleNames = headerFields.slice(9);
        firstSampleIdx = 9;
        break;
      }
    }

    if (sampleNames.length === 0) {
      throw new Error('No header line found in VCF file');
    }

    if (sampleIndex >= sampleNames.length) {
      throw new Error(`Sample index ${sampleIndex} out of range. Only ${sampleNames.length} samples in VCF.`);
    }

    const absoluteSampleIdx = firstSampleIdx + sampleIndex;
    const candidateSNPs: SNP[] = [];

    // Parse variant lines
    for (const line of lines) {
      if (line.startsWith('#')) {
        continue;
      }

      const fields = line.trim().split('\t');
      if (fields.length <= absoluteSampleIdx) {
        continue;
      }

      // Filter: only PASS variants
      const filterField = fields[6];
      if (filterField !== 'PASS') {
        continue;
      }

      // Filter: only SNPs (single nucleotide)
      const ref = fields[3];
      const alt = fields[4].split(',')[0];
      if (ref.length !== 1 || alt.length !== 1 || ref === '.' || alt === '.') {
        continue;
      }

      // Get genotype
      const formatField = fields[8].split(':');
      if (!formatField.includes('GT')) {
        continue;
      }

      const sampleData = fields[absoluteSampleIdx].split(':');
      const gtIdx = formatField.indexOf('GT');
      if (gtIdx >= sampleData.length) {
        continue;
      }

      const gt = sampleData[gtIdx];

      // Skip reference homozygous and missing genotypes
      if (['0/0', '0|0', './.', '.|.'].includes(gt)) {
        continue;
      }

      // Filter by depth if available
      if (formatField.includes('DP')) {
        const dpIdx = formatField.indexOf('DP');
        if (dpIdx < sampleData.length && sampleData[dpIdx] !== '.') {
          try {
            const depth = parseInt(sampleData[dpIdx]);
            if (depth < 10) {
              continue;
            }
          } catch (e) {
            // Skip if can't parse depth
          }
        }
      }

      const chrom = fields[0];
      const pos = parseInt(fields[1]);
      const variantId = fields[2] !== '.' ? fields[2] : `${chrom}:${pos}_${ref}>${alt}`;

      candidateSNPs.push({ chrom, pos, variantId, gt, ref, alt });
    }

    // Select distributed SNPs
    const selectedSNPs = this.selectDistributedSNPs(candidateSNPs, numSnps);
    return this.generateFingerprintFromSNPs(selectedSNPs);
  }

  /**
   * Select evenly distributed SNPs across genome
   */
  private selectDistributedSNPs(candidateSNPs: SNP[], numSnps: number): SNP[] {
    if (candidateSNPs.length <= numSnps) {
      return candidateSNPs;
    }

    // Sort by chromosome and position
    candidateSNPs.sort((a, b) => {
      if (a.chrom !== b.chrom) {
        return a.chrom.localeCompare(b.chrom);
      }
      return a.pos - b.pos;
    });

    // Take evenly spaced SNPs
    const step = Math.max(1, Math.floor(candidateSNPs.length / numSnps));
    const selected: SNP[] = [];

    for (let i = 0; i < candidateSNPs.length && selected.length < numSnps; i += step) {
      selected.push(candidateSNPs[i]);
    }

    // If we don't have enough, add more randomly
    if (selected.length < numSnps) {
      const remaining = candidateSNPs.filter(snp => !selected.includes(snp));
      const shuffled = remaining.sort(() => Math.random() - 0.5);
      selected.push(...shuffled.slice(0, numSnps - selected.length));
    }

    return selected;
  }

  /**
   * Generate fingerprint from SNP list using bloom filter
   */
  private generateFingerprintFromSNPs(snps: SNP[]): string {
    if (snps.length === 0) {
      throw new Error('No SNPs provided for fingerprinting');
    }

    // Create bloom filter
    const bloom = new BloomFilter(10000, 4); // 10k capacity, 4 hash functions

    // Sort SNPs for consistency
    snps.sort((a, b) => {
      if (a.chrom !== b.chrom) {
        return a.chrom.localeCompare(b.chrom);
      }
      return a.pos - b.pos;
    });

    // Add each SNP to bloom filter
    for (const snp of snps) {
      const snpKey = `${snp.chrom}:${snp.pos}:${snp.gt}:${snp.ref}:${snp.alt}`;
      bloom.add(snpKey);
    }

    // Export bloom filter to buffer
    const exported = bloom.saveAsJSON();
    const bloomString = JSON.stringify(exported);

    // Hash the bloom filter to get fingerprint
    return crypto.createHash('sha256').update(bloomString).digest('hex');
  }

  /**
   * Generate bloom filter-based fingerprint from SNP genotype data
   */
  private generateBloomFingerprint(snpData: { [rsid: string]: string }): string {
    if (Object.keys(snpData).length === 0) {
      throw new Error('No SNP data provided for fingerprinting');
    }

    // Create bloom filter
    const bloom = new BloomFilter(1000, 4); // 1k capacity, 4 hash functions

    // Add each SNP to bloom filter (sorted for consistency)
    const sortedRsids = Object.keys(snpData).sort();
    for (const rsid of sortedRsids) {
      const genotype = snpData[rsid];
      // Add both rsid:genotype and just rsid
      bloom.add(`${rsid}:${genotype}`);
      bloom.add(rsid);
    }

    // Export and hash
    const exported = bloom.saveAsJSON();
    const bloomString = JSON.stringify(exported);

    return crypto.createHash('sha256').update(bloomString).digest('hex');
  }

  /**
   * Calculate file hash (SHA256)
   */
  static calculateFileHash(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Calculate file hash from buffer
   */
  static calculateBufferHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}


