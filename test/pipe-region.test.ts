import { buildPipeArgs } from '../src/commands/pipe';

describe('biofs pipe region handling', () => {
  it('applies a region to a VCF stream with a bcftools streaming targets filter', () => {
    const r = buildPipeArgs('bcftools', [], 'chr12:25245300-25245400');
    expect(r.args).toEqual(['view', '-t', 'chr12:25245300-25245400', '-']);
    expect(r.regionAppliedClientSide).toBe(true);
  });

  it('keeps extra bcftools arguments after the targets filter and drops a bare --', () => {
    const r = buildPipeArgs('bcftools', ['--', '-H'], 'chr17:7673700-7673850');
    expect(r.args).toEqual(['view', '-t', 'chr17:7673700-7673850', '-H', '-']);
  });

  it('does not add a second region when the caller passed -r or -t to bcftools', () => {
    const r = buildPipeArgs('bcftools', ['-t', 'chr1:1-10'], 'chr2:1-10');
    expect(r.args).toEqual(['view', '-t', 'chr1:1-10', '-']);
    expect(r.regionAppliedClientSide).toBe(false);
    expect(r.regionNote).toMatch(/only the bcftools argument/);
  });

  it('warns instead of pretending for a reads stream, which cannot be filtered without an index', () => {
    const r = buildPipeArgs('samtools', [], 'chr1:100-200');
    expect(r.args).toEqual(['view', '-']);
    expect(r.regionAppliedClientSide).toBe(false);
    expect(r.regionNote).toMatch(/samtools cannot filter an unindexed stream/);
  });

  it('leaves VCF and FASTQ arguments unchanged when no region is given', () => {
    expect(buildPipeArgs('bcftools', ['-h'], undefined)).toEqual({ args: ['view', '-h', '-'], regionAppliedClientSide: false, regionNote: undefined });
    expect(buildPipeArgs('seqkit', [], undefined).args).toEqual(['stats', '-']);
  });
});
