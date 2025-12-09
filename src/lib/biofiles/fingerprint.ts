import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import * as readline from 'readline';
import { gunzipSync } from 'zlib';

export interface FingerprintResult {
  fingerprint: string;
  snpCount: number;
}

/**
 * Calculate SNP fingerprint for VCF/genomic files
 *
 * CRITICAL: MUST be based on unique genetic variants ONLY.
 * If no variants found, this function MUST throw error - NEVER fall back to MD5 or any conventional hash.
 * Synchronized with bioip.js calculateSNPFingerprint() method.
 */
export async function calculateSnpFingerprint(filePath: string): Promise<FingerprintResult> {
  const fileContent = await readFile(filePath);
  const fileName = filePath.toLowerCase();

  // Check if file is gzipped
  let content: string;
  if (fileName.endsWith('.gz')) {
    const decompressed = gunzipSync(fileContent);
    content = decompressed.toString('utf-8');
  } else {
    content = fileContent.toString('utf-8');
  }

  let snps: string[] = [];

  if (fileName.includes('.vcf')) {
    snps = await extractSnpsFromVcf(content);
  } else if (fileName.endsWith('.txt') || fileName.endsWith('.csv') || fileName.endsWith('.tsv')) {
    snps = await extractSnpsFromDtc(content);
  }

  // CRITICAL: If no unique variants found, FAIL the entire process
  // NEVER fall back to MD5 or any conventional hashing method
  if (snps.length === 0) {
    throw new Error(
      'CRITICAL ERROR: No unique genetic variants detected in file.\n' +
      'Genomic fingerprint MUST be based on unique variants (SNPs, indels, etc.).\n' +
      'MD5 or conventional hashing is FORBIDDEN for genomic data.\n\n' +
      'Possible causes:\n' +
      '  - File contains only headers (no variant data)\n' +
      '  - VCF file is empty or malformed\n' +
      '  - File format is not recognized\n\n' +
      'Please ensure your file contains actual variant data before tokenization.'
    );
  }

  const fingerprint = hashSnpList(snps);

  return {
    fingerprint,
    snpCount: snps.length
  };
}

/**
 * SNP candidate with genomic position and genotype data
 */
interface SnpCandidate {
  chrom: string;
  pos: number;
  variantId: string;
  gt: string;
  ref: string;
  alt: string;
}

/**
 * Extract SNPs from VCF content with proper quality filters
 *
 * Implements the same logic as vcf_annotator.py fingerprint.py:
 * - Only PASS filter variants
 * - Only single nucleotide changes (SNPs)
 * - Excludes reference calls (0/0, 0|0, ./., .|.)
 * - Requires depth ≥10 if DP field available
 * - Selects 50 evenly distributed SNPs across genome
 */
async function extractSnpsFromVcf(content: string): Promise<string[]> {
  const lines = content.split('\n');
  const candidateSnps: SnpCandidate[] = [];

  let sampleIndex = 0; // Default to first sample
  let formatFields: string[] = [];

  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) {
      continue;
    }

    // Parse header to find sample column
    if (line.startsWith('#CHROM')) {
      const headerFields = line.split('\t');
      // Sample columns start after FORMAT (column 9)
      if (headerFields.length > 9) {
        sampleIndex = 9; // First sample column
      }
      continue;
    }

    // Skip other header lines
    if (line.startsWith('#')) {
      continue;
    }

    const fields = line.split('\t');
    if (fields.length < 10) continue; // Need at least one sample

    const chrom = fields[0];
    const pos = parseInt(fields[1]);
    const variantId = fields[2];
    const ref = fields[3];
    const alt = fields[4].split(',')[0]; // Take first ALT allele
    const qual = fields[5];
    const filter = fields[6];
    const info = fields[7];
    const format = fields[8];
    const sampleData = fields[sampleIndex];

    // FILTER 1: Only PASS variants
    if (filter !== 'PASS') {
      continue;
    }

    // FILTER 2: Only single nucleotide variants (SNPs)
    if (ref.length !== 1 || alt.length !== 1) {
      continue;
    }

    // Parse FORMAT field
    formatFields = format.split(':');
    const sampleFields = sampleData.split(':');

    // Find GT (genotype) index
    const gtIdx = formatFields.indexOf('GT');
    if (gtIdx === -1 || gtIdx >= sampleFields.length) {
      continue;
    }

    const gt = sampleFields[gtIdx];

    // FILTER 3: Exclude reference calls and no-calls
    if (gt === '0/0' || gt === '0|0' || gt === './.' || gt === '.|.') {
      continue;
    }

    // FILTER 4: Check depth if DP field available
    const dpIdx = formatFields.indexOf('DP');
    if (dpIdx !== -1 && dpIdx < sampleFields.length) {
      const depth = parseInt(sampleFields[dpIdx]);
      if (!isNaN(depth) && depth < 10) {
        continue;
      }
    }

    // Add to candidate SNPs
    candidateSnps.push({
      chrom,
      pos,
      variantId,
      gt,
      ref,
      alt
    });
  }

  // Select 50 evenly distributed SNPs across genome
  const selectedSnps = selectDistributedSnps(candidateSnps, 50);

  // Generate fingerprint strings from selected SNPs
  return selectedSnps.map(snp =>
    `${snp.chrom}:${snp.pos}:${snp.gt}:${snp.ref}:${snp.alt}`
  );
}

/**
 * Select evenly distributed SNPs across the genome
 *
 * Implements the same logic as vcf_annotator.py select_distributed_snps()
 */
function selectDistributedSnps(candidates: SnpCandidate[], numSnps: number): SnpCandidate[] {
  if (candidates.length === 0) {
    return [];
  }

  if (candidates.length <= numSnps) {
    return candidates;
  }

  // Sort by chromosome and position
  candidates.sort((a, b) => {
    if (a.chrom !== b.chrom) {
      return a.chrom.localeCompare(b.chrom);
    }
    return a.pos - b.pos;
  });

  // Select evenly distributed SNPs
  const step = Math.max(1, Math.floor(candidates.length / numSnps));
  const selected: SnpCandidate[] = [];

  for (let i = 0; i < candidates.length && selected.length < numSnps; i += step) {
    selected.push(candidates[i]);
  }

  // If we didn't get enough SNPs (due to rounding), fill remaining with random selection
  if (selected.length < numSnps) {
    const remaining = candidates.filter(snp => !selected.includes(snp));

    // Shuffle remaining SNPs
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }

    // Add random SNPs to fill up to numSnps
    const needed = numSnps - selected.length;
    selected.push(...remaining.slice(0, needed));
  }

  return selected.slice(0, numSnps);
}

/**
 * Extract SNPs from 23andMe/Ancestry format
 */
async function extractSnpsFromDtc(content: string): Promise<string[]> {
  const snps: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    // Skip comments and headers
    if (line.startsWith('#') || !line.trim()) {
      continue;
    }

    // Parse tab or comma separated values
    const separator = line.includes('\t') ? '\t' : ',';
    const fields = line.split(separator);

    if (fields.length < 2) continue;

    const rsId = fields[0].trim();

    // Check if it's a valid rsID
    if (rsId.startsWith('rs') || rsId.startsWith('i')) {
      snps.push(rsId);
    }

    // Limit to first 10,000 SNPs
    if (snps.length >= 10000) {
      break;
    }
  }

  return snps;
}

/**
 * Calculate SHA-256 hash of unique SNP list
 *
 * CRITICAL: This function should ONLY be called with non-empty SNP array.
 * Uses SHA-256 (not MD5) to match bioip.js implementation.
 * The hash is calculated from sorted unique variant positions, ensuring
 * consistent fingerprints across different systems.
 */
function hashSnpList(snps: string[]): string {
  // Sort SNPs alphabetically for consistency
  const sortedSnps = [...snps].sort();

  // Join and hash with SHA-256 (matching bioip.js)
  const snpString = sortedSnps.join(',');
  const hash = createHash('sha256');
  hash.update(snpString);

  return hash.digest('hex');
}

/**
 * Calculate general file fingerprint (for non-genomic files)
 */
export async function calculateFileFingerprint(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    const stream = createReadStream(filePath);

    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Check if fingerprint exists in cache (to detect duplicates)
 */
export async function checkFingerprintExists(fingerprint: string): Promise<boolean> {
  // This would check against local cache or API
  // For now, return false (no duplicate)
  return false;
}

