import { parseVariant, buildInterval, buildRegisterBody, buildSubmitBody, validateOptions } from '../src/commands/alphagenome';

const W = '0x01a2d260d2fe8cc13ae70b6868deb4f3ddcdb797';
const SRC = `biocid://genobank/${W}/vcf/neo-a1e84dee.AD3IND_noalt_hc_vcf.vcf.gz`;

describe('alphagenome variants', () => {
  it('parses VCF-style SNVs and indels', () => {
    expect(parseVariant('chr2:174776268:T:A')).toEqual({ chromosome: 'chr2', position: 174776268, reference_bases: 'T', alternate_bases: 'A' });
    expect(parseVariant('CHR7:83961822:ATG:A').chromosome).toBe('chr7');
  });
  it('refuses the OpenCRAVAT "-" allele with the conversion hint', () => {
    expect(() => parseVariant('chr7:83961823:TG:-')).toThrow(/anchor base/);
  });
  it('refuses junk, identical alleles, unknown chromosomes', () => {
    expect(() => parseVariant('7:1:A:C')).toThrow();
    expect(() => parseVariant('chr7:1:A:A')).toThrow(/identical/);
    expect(() => parseVariant('chr99:1:A:C')).toThrow(/unknown chromosome/);
    expect(() => parseVariant('chr7:0:A:C')).toThrow(/bad position/);
  });
});

describe('alphagenome request bodies', () => {
  const v = parseVariant('chr2:174776268:T:A');
  it('centres the window and keeps its exact length', () => {
    const i = buildInterval(v, 131072);
    expect(i.end - i.start).toBe(131072);
    expect(i.start).toBe(174776268 - 65536);
  });
  it('clamps at the chromosome start without shortening the window', () => {
    const i = buildInterval(parseVariant('chr1:100:A:C'), 16384);
    expect(i.start).toBe(0); expect(i.end).toBe(16384);
  });
  it('allows only the supported window lengths', () => {
    expect(() => buildInterval(v, 1000)).toThrow(/must be one of/);
  });
  it('registers with a biocid and never auto-processes', () => {
    const b = buildRegisterBody('sig', SRC, [v]);
    expect(b.auto_process).toBe('false'); expect(b.vcf_file_path).toBe(SRC);
    expect(() => buildRegisterBody('sig', 'gs://bucket/x.vcf.gz', [v])).toThrow(/biocid/);
  });
  it('submit body carries variant, interval, terms and outputs only (no wallet, no case label)', () => {
    const b = buildSubmitBody('sig', 'reg1', v, 131072, ['UBERON:0001134'], ['RNA_SEQ']);
    expect(Object.keys(b).sort()).toEqual(['interval', 'ontology_terms', 'registration_id', 'requested_outputs', 'user_signature', 'variant']);
  });
});

describe('alphagenome option validation', () => {
  const base = { variant: ['chr2:174776268:T:A'], ontology: ['UBERON:0001134'], sourceBiocid: SRC, acceptAlphagenomeTerms: true };
  it('needs the terms flag, a variant, an ontology term', () => {
    expect(() => validateOptions({ ...base, acceptAlphagenomeTerms: false })).toThrow(/terms/);
    expect(() => validateOptions({ ...base, variant: [] })).toThrow(/at least one --variant/);
    expect(() => validateOptions({ ...base, ontology: [] })).toThrow(/--ontology/);
  });
  it('defaults to RNA_SEQ and a 131072 window, rejects unknown outputs', () => {
    const r = validateOptions(base);
    expect(r.outputs).toEqual(['RNA_SEQ']); expect(r.length).toBe(131072);
    expect(() => validateOptions({ ...base, outputs: ['NOPE'] })).toThrow(/unknown output/);
  });
});
