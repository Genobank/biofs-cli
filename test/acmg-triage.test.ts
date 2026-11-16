import { buildAcmgBody, buildRefIndexBody, HPO_RELEASES } from '../src/commands/neoantigen-pipeline';

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
  it('coverage mode needs a BAM and a pinned gene annotation, not a sqlite', () => {
    const BAM = `biocid://genobank/${OWNER.toLowerCase()}/bam/neo-5fc194a4.AD3IND_pooled_try1_fq2bam.bam`;
    const cov = { coverage: true, bam: BAM, gtfBucket: 'deepvariant-fastq-to-vcf-genobank-app', gtfObject: 'reference/gencode/gencode_v44.gtf.gz', gtfSha256: H, hpo: ['HP:0002659'], panel: 'skeletal_dysplasia', hpoRelease: '2026-09-01', codeSha256: H, owner: OWNER, genes: ['COL1A1,COL1A2'] };
    const b = buildAcmgBody('AD3COV', cov, W, '0xsig');
    expect(b.mode).toBe('coverage');
    expect(b.bam_biocid).toBe(BAM);
    expect(b.sqlite_biocid).toBeUndefined();
    expect(b.genes).toEqual(['COL1A1', 'COL1A2']);
    expect(b.max_af).toBeUndefined();
    expect(() => buildAcmgBody('x', { ...cov, bam: undefined }, W, 's')).toThrow(/--bam/);
    expect(() => buildAcmgBody('x', { ...cov, gtfObject: undefined }, W, 's')).toThrow(/--gtf-object/);
    expect(() => buildAcmgBody('x', { ...cov, gtfSha256: 'abc' }, W, 's')).toThrow();
    expect(() => buildAcmgBody('x', { ...cov, schema: true }, W, 's')).toThrow(/different modes/);
    expect(() => buildAcmgBody('x', { ...base, sqlite: undefined }, W, 's')).toThrow(/--sqlite/);
  });
});

describe('reference-index body', () => {
  it('is the reference name, the code hash and a worker, nothing that names a place', () => {
    const b = buildRefIndexBody('REFNOALT', { reference: 'hg38_noalt', codeSha256: H, owner: OWNER }, W, '0xsig');
    expect(b.reference).toBe('hg38_noalt');
    expect(b.executor).toBe('worker');
    expect(b.wallet).toBe(OWNER);
    expect(Object.keys(b).sort()).toEqual(['case_id', 'code_sha256', 'executor', 'reference', 'signature', 'wallet']);
  });
  it('refuses any reference outside the catalog and a bad hash', () => {
    expect(() => buildRefIndexBody('x', { reference: 'hg19', codeSha256: H }, W, 's')).toThrow(/hg38_noalt/);
    expect(() => buildRefIndexBody('x', { reference: 'gs://b/x.fasta', codeSha256: H }, W, 's')).toThrow();
    expect(() => buildRefIndexBody('x', { reference: 'hg38_noalt', codeSha256: 'abc' }, W, 's')).toThrow();
    expect(() => buildRefIndexBody('Maria Lopez', { reference: 'hg38_noalt', codeSha256: H }, W, 's')).toThrow(/case identifier/);
  });
});

describe('acmg-triage --smn body', () => {
  const BAM = `biocid://genobank/${OWNER.toLowerCase()}/bam/neo-5fc194a4.AD3IND_pooled_try1_fq2bam.bam`;
  const o = { smn: true, bam: BAM, reference: 'hg38_noalt', gtfBucket: 'deepvariant-fastq-to-vcf-genobank-app', gtfObject: 'reference/gencode/g.gtf.gz', gtfSha256: H, codeSha256: H, owner: OWNER };
  it('is the BAM, the reference, the pinned annotation and no phenotype', () => {
    const b = buildAcmgBody('AD3SMN', o, W, '0xsig');
    expect(b.mode).toBe('smn');
    expect(b.reference).toBe('hg38_noalt');
    expect(b.panel).toBe('skeletal_dysplasia');
    expect(b.hpo_terms).toBeUndefined();
    expect(b.sqlite_biocid).toBeUndefined();
  });
  it('refuses another reference and mixed modes', () => {
    expect(() => buildAcmgBody('x', { ...o, reference: 'hg38' }, W, 's')).toThrow(/hg38_noalt/);
    expect(() => buildAcmgBody('x', { ...o, coverage: true }, W, 's')).toThrow(/different modes/);
    expect(() => buildAcmgBody('x', { ...o, bam: undefined }, W, 's')).toThrow(/--bam/);
  });
});
