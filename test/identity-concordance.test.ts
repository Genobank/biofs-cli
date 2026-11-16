import { buildIdentityBody, parseSamples } from '../src/commands/neoantigen-pipeline';

const W = '0x01a2d260d2fe8cc13ae70b6868deb4f3ddcdb797';
const G = (n: string) => `biocid://genobank/${W}/gvcf/neo-6e9fe8ce-5c47-417f-9b1d-99d0d1a94ef7.${n}.g.vcf.gz`;
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const opts = { sample: [`L13972=${G('a')}`, `L14008=${G('b')}`], codeSha256: H1, protocolSha256: H2, ledgerRecord: '22' };

describe('identity-concordance body', () => {
  it('builds the registered job body with the defaults', () => {
    const b = buildIdentityBody('AD3ID', opts, W, '0xsig');
    expect(b.samples_biocids).toEqual({ L13972: G('a'), L14008: G('b') });
    expect(b.min_depth).toBe(10);
    expect(b.min_gq).toBe(20);
    expect(b.ledger_record).toBe(22);
    expect(b.code_sha256).toBe(H1);
  });
  it('an operator job carries the owner as the wallet', () => {
    expect(buildIdentityBody('AD3ID', { ...opts, owner: '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a' }, '0xf54D5EA2eb0E93d46e8Bd925E0104162B8737722', '0xsig').wallet).toBe('0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a');
  });
  it('refuses a bad sample list, hashes, record, thresholds and case id', () => {
    expect(() => parseSamples([`only=${G('a')}`])).toThrow(/2 to 8/);
    expect(() => parseSamples([`a=${G('a')}`, `a=${G('b')}`])).toThrow(/twice/);
    expect(() => parseSamples([`a=${G('a')}`, `b=${G('a')}`])).toThrow(/same biocid/);
    expect(() => parseSamples([`a=gs://b/f.g.vcf.gz`, `b=${G('b')}`])).toThrow();
    expect(() => parseSamples([`bad label=${G('a')}`, `b=${G('b')}`])).toThrow(/label=biocid/);
    expect(() => buildIdentityBody('AD3ID', { ...opts, codeSha256: 'x' }, W, 's')).toThrow();
    expect(() => buildIdentityBody('AD3ID', { ...opts, ledgerRecord: '0' }, W, 's')).toThrow(/--ledger-record/);
    expect(() => buildIdentityBody('AD3ID', { ...opts, minDepth: '0' }, W, 's')).toThrow(/--min-depth/);
    expect(() => buildIdentityBody('a b', opts, W, 's')).toThrow(/caseId/);
  });
  it('accepts comma separated entries', () => {
    expect(Object.keys(parseSamples([`a=${G('a')},b=${G('b')}`]))).toEqual(['a', 'b']);
  });
});
