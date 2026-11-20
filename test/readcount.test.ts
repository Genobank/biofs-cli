import { buildReadcountBody, parseBams, parseReferences, parseSite, parseSites } from '../src/commands/readcount';

const W = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const T = `biocid://genobank/${W}/bam/neo-dc4e11fe.tumor.bam`;
const N = `biocid://genobank/${W}/bam/neo-dc4e11fe.normal.bam`;
const H = 'a'.repeat(64);

describe('biofs readcount', () => {
  it('builds a worker-only body with sorted labels, genomes and sites', () => {
    const b = buildReadcountBody('CASE-000001', { bam: [`tumor=${T}`, `normal=${N}`], ref: 'hg38_noalt', site: ['chr12:25245350:c:t:KRAS_G12D', 'chrX:100:ACTT:A'], codeSha256: H }, W, '0xsig');
    expect(Object.keys(b.bams_biocids as object)).toEqual(['normal', 'tumor']);
    expect(b.references).toEqual({ normal: 'hg38_noalt', tumor: 'hg38_noalt' });
    expect(b.sites).toEqual([{ chrom: 'chr12', pos: 25245350, ref: 'C', alt: 'T', label: 'KRAS_G12D' }, { chrom: 'chrX', pos: 100, ref: 'ACTT', alt: 'A' }]);
    expect(b.min_mapq).toBe(20);
    expect(b.min_baseq).toBe(20);
    expect(b.executor).toBe('worker');
  });

  it('gives one alignment another genome with --ref-for', () => {
    expect(parseReferences(['dna', 'rna'], 'hg38_noalt', ['rna=hg38'])).toEqual({ dna: 'hg38_noalt', rna: 'hg38' });
    expect(() => parseReferences(['dna'], undefined, undefined)).toThrow(/no genome/);
    expect(() => parseReferences(['dna'], 'hg38_noalt', ['other=hg38'])).toThrow(/does not name a --bam label/);
    expect(() => parseReferences(['dna'], 'GRCh38.fa', undefined)).toThrow(/not a catalog genome/);
  });

  it('reads a sites file and skips comments and a header', () => {
    const s = parseSites(undefined, 'x.tsv', () => '# picks\nchrom\tpos\tref\talt\tlabel\nchr1\t10\tA\tG\tGENE_X1Y\nchr2\t20\tT\tC\n');
    expect(s).toEqual([{ chrom: 'chr1', pos: 10, ref: 'A', alt: 'G', label: 'GENE_X1Y' }, { chrom: 'chr2', pos: 20, ref: 'T', alt: 'C' }]);
  });

  it('refuses what the node would refuse', () => {
    expect(() => parseBams([])).toThrow();
    expect(() => parseBams([`tumor=${T}`, `again=${T}`])).toThrow(/same biocid/);
    expect(() => parseBams(['tumor=gs://bucket/x.bam'])).toThrow();
    expect(() => parseSite('chr1:10:AC:GT', 'x')).toThrow(/MNV/);
    expect(() => parseSite('chr1:10:A:G:Jane Doe', 'x')).toThrow(/label/);
    expect(() => parseSite('chr1:0:A:G', 'x')).toThrow();
    expect(() => parseSites(['chr1:10:A:G', 'chr1:10:a:g'], undefined)).toThrow(/twice/);
    expect(() => parseSites(undefined, undefined)).toThrow(/1 to 200/);
    expect(() => buildReadcountBody('C1', { bam: [`t=${T}`], ref: 'hg38', site: ['chr1:10:A:G'], minBaseq: '0', codeSha256: H }, W, 's')).toThrow(/min-baseq/);
    expect(() => buildReadcountBody('C1', { bam: [`t=${T}`], ref: 'hg38', site: ['chr1:10:A:G'], codeSha256: 'x' }, W, 's')).toThrow();
    expect(() => buildReadcountBody('a person', { bam: [`t=${T}`], ref: 'hg38', site: ['chr1:10:A:G'], codeSha256: H }, W, 's')).toThrow(/caseId/);
  });
});
