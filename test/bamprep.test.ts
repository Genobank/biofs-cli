import { buildBamprepBody } from '../src/commands/bamprep';

const W = '0x5f5a60eaef242c0d51a21c703f520347b96ed19a';
const B = `biocid://genobank/${W}/bam/RQ7760854.invitae.hg19.bam`;
const H = 'c'.repeat(64);

describe('bamprep submit input', () => {
  it('builds the body with its defaults and runs only on a worker', () => {
    const b = buildBamprepBody('RQ7760854', { bam: B, codeSha256: H }, W, '0xsig');
    expect(b).toMatchObject({ case_id: 'RQ7760854', bam_biocid: B, sort: 'auto', threads: 4, executor: 'worker', code_sha256: H });
    expect(b.name).toBeUndefined();
  });
  it('refuses a storage path, a bad mode, threads out of range, a bad name and a bad hash', () => {
    expect(() => buildBamprepBody('C', { bam: 'gs://b/x.bam', codeSha256: H }, W, 's')).toThrow();
    expect(() => buildBamprepBody('C', { bam: B, sort: 'maybe', codeSha256: H }, W, 's')).toThrow(/--sort/);
    expect(() => buildBamprepBody('C', { bam: B, threads: '0', codeSha256: H }, W, 's')).toThrow(/--threads/);
    expect(() => buildBamprepBody('C', { bam: B, name: 'a b;rm', codeSha256: H }, W, 's')).toThrow(/--name/);
    expect(() => buildBamprepBody('C', { bam: B, codeSha256: 'zz' }, W, 's')).toThrow();
    expect(() => buildBamprepBody('bad case!', { bam: B, codeSha256: H }, W, 's')).toThrow(/caseId/);
  });
  it('passes name and sort through', () => {
    const b = buildBamprepBody('C', { bam: B, sort: 'always', threads: '8', name: 'x.bam', codeSha256: H }, W, 's');
    expect(b).toMatchObject({ sort: 'always', threads: 8, name: 'x.bam' });
  });
});
