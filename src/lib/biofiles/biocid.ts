import { BioCID } from '../../types/biofiles';
import path from 'path';

export class BioCIDParser {
  static parse(biocid: string): BioCID | null {
    // Format: biocid://wallet/type/identifier
    const regex = /^biocid:\/\/(0x[a-fA-F0-9]{40})\/([^\/]+)\/(.+)$/;
    const match = biocid.match(regex);

    if (!match) {
      return null;
    }

    return {
      wallet: match[1].toLowerCase(),
      type: match[2],
      identifier: match[3],
      fullCID: biocid
    };
  }

  /**
   * Build a canonical BioCID.
   *
   * BioRouter's promise is to be the oracle / source of truth for biodata
   * origin, so we REFUSE to generate a biocid with an unknown origin prefix.
   * Passing anything that isn't a 0x-prefixed 40-hex-char wallet or contract
   * address produces a `resolver_err/*` prefix that's obviously broken and
   * gets flagged by the caller, instead of the silent `unknown` sentinel
   * that used to leak through (see biofiles resolver refactor · 2026-04-24).
   */
  static generate(origin: string, filename: string): string {
    const type = this.detectFileType(filename);
    const safe =
      typeof origin === 'string' &&
      /^0x[a-fA-F0-9]{40}$/.test(origin)
        ? origin.toLowerCase()
        : `resolver_err/${origin || 'missing-origin'}`;
    return `biocid://${safe}/${type}/${filename}`;
  }

  static detectFileType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();

    const typeMap: { [key: string]: string } = {
      '.vcf': 'vcf',
      '.vcf.gz': 'vcf',
      '.fastq': 'fastq',
      '.fastq.gz': 'fastq',
      '.fq': 'fastq',
      '.fq.gz': 'fastq',
      '.bam': 'bam',
      '.sam': 'bam',
      '.pdf': 'pdf',
      '.csv': 'csv',
      '.json': 'json',
      '.txt': 'txt',
      '.sqlite': 'sqlite',
      '.db': 'database'
    };

    // Check for compound extensions
    if (filename.endsWith('.vcf.gz')) return 'vcf';
    if (filename.endsWith('.fastq.gz')) return 'fastq';
    if (filename.endsWith('.fq.gz')) return 'fastq';

    return typeMap[ext] || 'file';
  }

  static isValidBioCID(biocid: string): boolean {
    return this.parse(biocid) !== null;
  }
}

