import { buildRegisterDerivedGcsBody } from '../src/commands/register-derived';
const W = '0xFD1f085f8d10375df8A1c7C9ffA4FD0eB80B0b1d';
const P = `biocid://public-r2/${W}/bam/DNA_TN25-112103.bam`;
const U = `gs://genobank-parabricks-output/biowallet/${W.toLowerCase()}/somatic-mutect/j/x.vcf.gz`;
describe('register-derived gcs', () => {
  test('builds the body with lineage', () => {
    const b: any = buildRegisterDerivedGcsBody(U, { type: 'vcf', parent: [P], caseId: 'TN25-112103' });
    expect(b.gcs_uri).toBe(U); expect(b.filename).toBe('x.vcf.gz'); expect(b.parent_biocids).toEqual([P]); expect(b.data_category).toBe('dna');
  });
  test('refuses non-gs, missing parents, bad parents, bad type, name-like case id', () => {
    expect(() => buildRegisterDerivedGcsBody('https://x/y', { type: 'vcf', parent: [P] })).toThrow(/gs:\/\//);
    expect(() => buildRegisterDerivedGcsBody(U, { type: 'vcf', parent: [] })).toThrow(/parent/);
    expect(() => buildRegisterDerivedGcsBody(U, { type: 'vcf', parent: ['gs://b/x'] })).toThrow(/not a biocid/);
    expect(() => buildRegisterDerivedGcsBody(U, { type: 'VCF', parent: [P] })).toThrow(/--type/);
    expect(() => buildRegisterDerivedGcsBody(U, { type: 'vcf', parent: [P], caseId: 'Jane Doe' })).toThrow(/case identifier/);
  });
});

import { validateReadArgs, sha256Hex } from '../src/commands/register-derived';
describe('register-derived read', () => {
  test('accepts a biocid, refuses a path or URL', () => {
    expect(() => validateReadArgs(P, '/tmp/x.json')).not.toThrow();
    expect(() => validateReadArgs('gs://b/x')).toThrow(/biocid/);
    expect(() => validateReadArgs('https://x/y')).toThrow(/biocid/);
  });
  test('sha256 of known bytes', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
