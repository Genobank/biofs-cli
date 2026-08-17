import { BioCIDParser } from '../src/lib/biofiles/biocid';
import { detectFileType, fileMatchesTypeFilter } from '../src/lib/biofiles/filetype';

describe('BioCIDParser', () => {
  it('parses canonical 4-part lab/wallet/type/dataset biocids', () => {
    const p = BioCIDParser.parse(
      'biocid://caris/0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a/bam/DNA_TN25-336147.bam'
    );
    expect(p).not.toBeNull();
    expect(p!.lab).toBe('caris');
    expect(p!.wallet).toBe('0x5f5a60eaef242c0d51a21c703f520347b96ed19a');
    expect(p!.type).toBe('bam');
    expect(p!.identifier).toBe('DNA_TN25-336147.bam');
  });

  it('parses legacy 3-part wallet/type/identifier biocids', () => {
    const p = BioCIDParser.parse(
      'biocid://0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a/vcf/foo.vcf'
    );
    expect(p).not.toBeNull();
    expect(p!.lab).toBeUndefined();
    expect(p!.type).toBe('vcf');
    expect(p!.identifier).toBe('foo.vcf');
  });

  it('rejects a non-biocid string', () => {
    expect(BioCIDParser.parse('DNA_TN25-336147.bam')).toBeNull();
  });

  it('normalizes Biocid: without slashes', () => {
    const p = BioCIDParser.parse(
      'Biocid:caris/0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a/vcf/DNA_TN25-336147.vcf'
    );
    expect(p).not.toBeNull();
    expect(p!.lab).toBe('caris');
    expect(p!.type).toBe('vcf');
  });
});

describe('detectFileType', () => {
  it('maps .pas OpenCRAVAT files to sqlite', () => {
    expect(detectFileType('DNA_TN25-336147.caris.pas')).toBe('sqlite');
  });
  it('maps compound vcf/fastq and cram', () => {
    expect(detectFileType('x.vcf.gz')).toBe('vcf');
    expect(detectFileType('x.g.vcf.gz')).toBe('gvcf');
    expect(detectFileType('x.fastq.gz')).toBe('fastq');
    expect(detectFileType('x.cram')).toBe('cram');
  });
});

describe('fileMatchesTypeFilter', () => {
  it('treats opencravat as sqlite', () => {
    expect(fileMatchesTypeFilter('sqlite', { type: 'opencravat', filename: 'a.sqlite' })).toBe(true);
    expect(fileMatchesTypeFilter('sqlite', { type: 'file', filename: 'a.caris.pas' })).toBe(true);
  });
  it('matches bam via biocid path even when type is wrong', () => {
    expect(
      fileMatchesTypeFilter('bam', {
        type: 'file',
        filename: 'mystery',
        biocid: 'biocid://caris/0xabc/bam/DNA.bam',
      })
    ).toBe(true);
  });
  it('does not collapse unrelated types', () => {
    expect(fileMatchesTypeFilter('bam', { type: 'vcf', filename: 'x.vcf' })).toBe(false);
  });
  it('does not treat a .bam.bai index as a bam', () => {
    expect(fileMatchesTypeFilter('bam', { type: 'genomic_index', filename: 'x.bam.bai' })).toBe(false);
  });
});
