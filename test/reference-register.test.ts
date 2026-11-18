import { buildReferenceRegisterBody } from '../src/commands/reference-register';

const B = 'biocid://genobank/0xf54d5ea2eb0e93d46e8bd925e0104162b8737722/known-sites/Homo_sapiens_assembly38.dbsnp138.vcf';
const ATTEST = 'public reference data held in the GenoBank.io reference buckets';

describe('biofs reference-register', () => {
  test('a dry run by default, every catalog dataset when no biocid is given', () => {
    expect(buildReferenceRegisterBody([], { attest: ATTEST })).toEqual({ biocids: [], attestation: ATTEST, dry_run: true });
    expect(buildReferenceRegisterBody([B], { attest: ATTEST, yes: true })).toEqual({ biocids: [B], attestation: ATTEST, dry_run: false });
  });
  test('a bucket path, a URL or a biocid of another shape is refused', () => {
    expect(() => buildReferenceRegisterBody(['gs://genobank-references/hg38/x.vcf'], { attest: ATTEST })).toThrow(/not the biocid of a reference dataset/);
    expect(() => buildReferenceRegisterBody(['biocid://augenomics/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/fastq/x/y.fastq.gz'], { attest: ATTEST })).toThrow(/not the biocid of a reference dataset/);
  });
  test('the attestation is required', () => {
    expect(() => buildReferenceRegisterBody([], { attest: 'short' })).toThrow(/20 characters/);
  });
});
