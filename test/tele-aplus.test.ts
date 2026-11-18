import { isHeavyGenomicName } from '../src/lib/biofiles/filetype';

describe('tele A+ laptop bar', () => {
  test('heavy genomic names include BAM VCF FASTQ sqlite', () => {
    expect(isHeavyGenomicName('x.bam')).toBe(true);
    expect(isHeavyGenomicName('x.vcf.gz')).toBe(true);
    expect(isHeavyGenomicName('x.fastq.gz')).toBe(true);
    expect(isHeavyGenomicName('x.sqlite')).toBe(true);
    expect(isHeavyGenomicName('letter.pdf')).toBe(false);
  });
});
