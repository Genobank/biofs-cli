import { buildAcmgBody, buildRefIndexBody, buildVcfCompareBody, HPO_RELEASES } from '../src/commands/neoantigen-pipeline';

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

describe('vcf-compare body', () => {
  const A = `biocid://genobank/${OWNER.toLowerCase()}/vcf/neo-a.dv.vcf.gz`;
  const B = `biocid://genobank/${OWNER.toLowerCase()}/vcf/neo-b.hc.vcf.gz`;
  const o = { a: A, b: B, labelA: 'deepvariant', labelB: 'haplotypecaller', codeSha256: H, owner: OWNER };
  it('is two VCF biocids, two labels and the pinned code', () => {
    const b = buildVcfCompareBody('CMP1', { ...o, minDp: '15', minGq: '30', bed: `biocid://genobank/${OWNER.toLowerCase()}/neoantigen-capture-file/neo-x.bed` }, W, '0xsig');
    expect(b.vcf_a_biocid).toBe(A);
    expect(b.label_b).toBe('haplotypecaller');
    expect(b.min_dp).toBe(15);
    expect(b.min_gq).toBe(30);
    expect(String(b.bed_biocid)).toContain('neoantigen-capture-file');
  });
  it('refuses the same file twice, equal labels, a path, a bad threshold', () => {
    expect(() => buildVcfCompareBody('x', { ...o, b: A }, W, 's')).toThrow(/same file/);
    expect(() => buildVcfCompareBody('x', { ...o, labelB: 'deepvariant' }, W, 's')).toThrow(/differ/);
    expect(() => buildVcfCompareBody('x', { ...o, a: 'gs://b/a.vcf' }, W, 's')).toThrow(/biocid/);
    expect(() => buildVcfCompareBody('x', { ...o, minDp: '-3' }, W, 's')).toThrow(/--min-dp/);
    expect(() => buildVcfCompareBody('x', { ...o, codeSha256: 'abc' }, W, 's')).toThrow();
  });
});

describe('acmg-triage constraint file', () => {
  it('carries the pinned constraint file into a classify body', () => {
    const b = buildAcmgBody('AD3ACMG', { ...base, constraintObject: 'gnomad_constraint/4.1/gnomad.v4.1.constraint_metrics.tsv', constraintSha256: H }, W, '0xsig');
    expect(b.constraint_object).toBe('gnomad_constraint/4.1/gnomad.v4.1.constraint_metrics.tsv');
    expect(b.constraint_sha256).toBe(H);
  });
  it('refuses an object without its hash and a hash without its object', () => {
    expect(() => buildAcmgBody('x', { ...base, constraintObject: 'gnomad_constraint/4.1/x.tsv' }, W, 's')).toThrow();
    expect(() => buildAcmgBody('x', { ...base, constraintSha256: H }, W, 's')).toThrow(/--constraint-object/);
  });
});

describe('acmg-triage --support body', () => {
  const BAM = `biocid://genobank/${OWNER.toLowerCase()}/bam/neo-5fc194a4.AD3IND_pooled_try1_fq2bam.bam`;
  const REP = `biocid://genobank/${OWNER.toLowerCase()}/classification-report/neo-f0ee7a9a.AD3NOALTHCCLS.json`;
  const o = { support: true, bam: BAM, reportBiocid: REP, reference: 'hg38_noalt', codeSha256: H, owner: OWNER };
  it('is the BAM, the classification report, the reference and no phenotype', () => {
    const b = buildAcmgBody('AD3SUP', o, W, '0xsig');
    expect(b.mode).toBe('support');
    expect(b.report_biocid).toBe(REP);
    expect(b.scope).toBe('all');
    expect(b.hpo_terms).toBeUndefined();
  });
  it('refuses a storage path, another reference, a bad scope and mixed modes', () => {
    expect(() => buildAcmgBody('x', { ...o, reportBiocid: 'gs://b/r.json' }, W, 's')).toThrow(/biocid/);
    expect(() => buildAcmgBody('x', { ...o, reference: 'hg38' }, W, 's')).toThrow(/hg38_noalt/);
    expect(() => buildAcmgBody('x', { ...o, scope: 'some' }, W, 's')).toThrow(/--scope/);
    expect(() => buildAcmgBody('x', { ...o, smn: true }, W, 's')).toThrow(/different modes/);
    expect(() => buildAcmgBody('x', { ...o, reportBiocid: undefined }, W, 's')).toThrow(/--report-biocid/);
  });
});
