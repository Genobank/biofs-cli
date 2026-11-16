import { buildAcmgBody, HPO_RELEASES } from '../src/commands/neoantigen-pipeline';

const W = '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
const OWNER = '0x01a2D260d2fE8cc13AE70b6868dEB4F3DdCDb797';
const SQ = `biocid://genobank/${OWNER.toLowerCase()}/sqlite/AD3IND_pooled_dv_vcf.sqlite`;
const VCF = `biocid://genobank/${OWNER.toLowerCase()}/vcf/neo-a3d4fdad.AD3IND_pooled_dv_vcf.vcf.gz`;
const H = 'a'.repeat(64);
const base = { sqlite: SQ, vcf: VCF, hpo: ['HP:0002757,HP:0000924'], panel: 'skeletal_dysplasia', hpoRelease: '2026-09-01', codeSha256: H, owner: OWNER };

describe('acmg-triage body', () => {
  it('builds a classify body with the built-in HPO release hashes', () => {
    const b = buildAcmgBody('AD3ACMG', base, W, '0xsig');
    expect(b.mode).toBe('classify');
    expect(b.wallet).toBe(OWNER);
    expect(b.hpo_terms).toEqual(['HP:0002757', 'HP:0000924']);
    expect(b.hpo_obo_sha256).toBe(HPO_RELEASES['2026-09-01'].obo);
    expect(b.vcf_biocid).toBe(VCF);
  });
  it('schema mode needs only the sqlite and the code hash', () => {
    const b = buildAcmgBody('AD3SCHEMA', { sqlite: SQ, schema: true, codeSha256: H, owner: OWNER }, W, '0xsig');
    expect(b.mode).toBe('schema');
    expect(b.hpo_terms).toBeUndefined();
  });
  it('refuses what the node would refuse, before any request', () => {
    expect(() => buildAcmgBody('x', { ...base, sqlite: 'gs://b/x.sqlite' }, W, 's')).toThrow(/biocid/);
    expect(() => buildAcmgBody('x', { ...base, hpo: [] }, W, 's')).toThrow(/HPO terms/);
    expect(() => buildAcmgBody('x', { ...base, hpo: ['HP:12'] }, W, 's')).toThrow(/not an HPO id/);
    expect(() => buildAcmgBody('x', { ...base, hpo: ['HP:0002757,HP:0002757'] }, W, 's')).toThrow(/twice/);
    expect(() => buildAcmgBody('x', { ...base, hpoRelease: undefined }, W, 's')).toThrow(/--hpo-release/);
    expect(() => buildAcmgBody('x', { ...base, hpoRelease: '2030-01-01' }, W, 's')).toThrow(/no recorded file hashes/);
    expect(() => buildAcmgBody('x', { ...base, maxAf: '0.9' }, W, 's')).toThrow(/--max-af/);
    expect(() => buildAcmgBody('x', { ...base, codeSha256: 'abc' }, W, 's')).toThrow();
    expect(() => buildAcmgBody('Maria Lopez', base, W, 's')).toThrow(/case identifier/);
  });
});
