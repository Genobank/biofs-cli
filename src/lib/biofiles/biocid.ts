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

  static generate(wallet: string, filename: string): string {
    const type = this.detectFileType(filename);
    return `biocid://${wallet.toLowerCase()}/${type}/${filename}`;
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
