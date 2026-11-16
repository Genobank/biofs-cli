import { buildAnnotateBody } from '../src/commands/annotate/submit';
const W = '0x01a2d260d2fe8cc13ae70b6868deb4f3ddcdb797';
const B = `biocid://genobank/${W}/gvcf/neo-6e9f.AD3L13972_dv_wes.g.vcf.gz`;
describe('annotate submit input', () => {
  it('names the input by serial or by biocid, never both ways at once', () => {
    expect(buildAnnotateBody('55052008714008', {}, W, '0xsig').biosample_serial).toBe('55052008714008');
    const b = buildAnnotateBody(undefined, { vcfBiocid: B }, W, '0xsig');
    expect(b.vcf_biocid).toBe(B);
    expect(b.biosample_serial).toBeUndefined();
    expect(b.package).toBe('wes_default');
    expect(() => buildAnnotateBody(undefined, {}, W, 's')).toThrow(/serial or --vcf-biocid/);
    expect(() => buildAnnotateBody('S', { vcfBiocid: B, vcfUri: 'gs://b/x.vcf.gz' }, W, 's')).toThrow(/not both/);
  });
  it('refuses a storage path or URL as the biocid', () => {
    expect(() => buildAnnotateBody(undefined, { vcfBiocid: 'gs://b/x.vcf.gz' }, W, 's')).toThrow(/not a biocid/);
    expect(() => buildAnnotateBody(undefined, { vcfBiocid: 'https://x/y.vcf' }, W, 's')).toThrow(/not a biocid/);
  });
});
