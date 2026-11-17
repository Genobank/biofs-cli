import { parseVariant, buildAlphagenomeBody } from '../src/commands/alphagenome';

const W = '0x01a2d260d2fe8cc13ae70b6868deb4f3ddcdb797';
const SRC = `biocid://genobank/${W}/vcf/neo-a1e84dee.AD3IND_noalt_hc_vcf.vcf.gz`;
const H = 'b'.repeat(64);
const o = { variant: ['chr2:174776268:T:A', 'chr7:83961822:CTG:C'], ontology: ['UBERON:0001134', 'CL:0000062'], sourceBiocid: SRC, codeSha256: H, acceptAlphagenomeTerms: true };

describe('alphagenome variants', () => {
  it('parses VCF-style SNVs and indels', () => {
    expect(parseVariant('chr2:174776268:T:A')).toEqual({ chromosome: 'chr2', position: 174776268, reference_bases: 'T', alternate_bases: 'A' });
    expect(parseVariant('CHR7:83961822:ATG:A').chromosome).toBe('chr7');
  });
  it('refuses the OpenCRAVAT "-" allele with the conversion hint', () => {
    expect(() => parseVariant('chr7:83961823:TG:-')).toThrow(/anchor base/);
  });
  it('refuses junk, identical alleles, unknown chromosomes, long alleles', () => {
    expect(() => parseVariant('7:1:A:C')).toThrow();
    expect(() => parseVariant('chr7:1:A:A')).toThrow(/identical/);
    expect(() => parseVariant('chr99:1:A:C')).toThrow(/unknown chromosome/);
    expect(() => parseVariant('chr7:0:A:C')).toThrow(/bad position/);
    expect(() => parseVariant(`chr7:5:${'A'.repeat(65)}:A`)).toThrow(/64/);
  });
});

describe('alphagenome job body', () => {
  it('is local, carries the pinned code, the terms acceptance and the lineage biocid', () => {
    const b: any = buildAlphagenomeBody('AD3AG', o, '0xf54D5EA2eb0E93d46e8Bd925E0104162B8737722', 'sig');
    expect(b.executor).toBe('local');
    expect(b.accept_alphagenome_terms).toBe(true);
    expect(b.source_biocid).toBe(SRC);
    expect(b.requested_outputs).toEqual(['RNA_SEQ']);
    expect(b.window_bp).toBe(131072);
    expect(b.variants).toHaveLength(2);
  });
  it('an operator names the owner; the signer is not the owner', () => {
    const b: any = buildAlphagenomeBody('AD3AG', { ...o, owner: '0x01a2D260d2fE8cc13AE70b6868dEB4F3DdCDb797' }, '0xf54D5EA2eb0E93d46e8Bd925E0104162B8737722', 'sig');
    expect(b.wallet).toBe('0x01a2D260d2fE8cc13AE70b6868dEB4F3DdCDb797');
  });
  it('refuses without the terms, a storage path, bad terms, windows, outputs and case ids', () => {
    expect(() => buildAlphagenomeBody('x', { ...o, acceptAlphagenomeTerms: false }, 'w', 's')).toThrow(/terms/);
    expect(() => buildAlphagenomeBody('x', { ...o, sourceBiocid: 'gs://b/x.vcf.gz' }, 'w', 's')).toThrow(/biocid/);
    expect(() => buildAlphagenomeBody('x', { ...o, ontology: [] }, 'w', 's')).toThrow(/--ontology/);
    expect(() => buildAlphagenomeBody('x', { ...o, ontology: ['muscle'] }, 'w', 's')).toThrow(/ontology term/);
    expect(() => buildAlphagenomeBody('x', { ...o, window: '1000' }, 'w', 's')).toThrow(/--window/);
    expect(() => buildAlphagenomeBody('x', { ...o, outputs: ['NOPE'] }, 'w', 's')).toThrow(/unknown output/);
    expect(() => buildAlphagenomeBody('Maria Lopez', o, 'w', 's')).toThrow(/case identifier/);
    expect(() => buildAlphagenomeBody('x', { ...o, codeSha256: 'abc' }, 'w', 's')).toThrow();
    expect(() => buildAlphagenomeBody('x', { ...o, variant: [] }, 'w', 's')).toThrow(/1 to 50/);
  });
});
