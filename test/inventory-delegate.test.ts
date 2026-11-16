import { buildFields, buildMessage, buildDelegateBody, biocidsDigest } from '../src/commands/inventory-delegate';

const FROM = '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
const TO = '0x01a2D260d2fE8cc13AE70b6868dEB4F3DdCDb797';
const OP = '0xf54D5EA2eb0E93d46e8Bd925E0104162B8737722';
const B1 = 'biocid://tecbase/0xcef484deb09b3dad49a51d3283c1e96809fad2bb/fastq/A014_S63_L001_R1_001.fastq.gz';
const B2 = 'biocid://tecbase/0xcef484deb09b3dad49a51d3283c1e96809fad2bb/fastq/A014_S63_L001_R2_001.fastq.gz';
const ATT = 'The data owner asked that these libraries be held for her under her wallet';
const NOW = Date.parse('2026-11-15T20:00:00.000Z');
const opts = { from: FROM, to: TO, attest: ATT, nonce: 'a'.repeat(32) };

describe('inventory-delegate message', () => {
  it('matches the node builder byte for byte (shared test vector)', () => {
    // The same vector is asserted in biofs-node test/inventory_delegate.test.mjs through its own builder; the digest of the two biocids below is fixed here.
    expect(biocidsDigest([B2, B1])).toBe(biocidsDigest([B1, B2]));
    const f = buildFields([B1, B2], { ...opts, operator: [OP, FROM] }, OP, NOW);
    const m = buildMessage(f);
    expect(m.split('\n')).toHaveLength(10);
    expect(m).toContain(`From owner: ${FROM.toLowerCase()}`);
    expect(m).toContain(`To owner: ${TO.toLowerCase()}`);
    expect(m).toContain('Operators retained: 0x5f5a60eaef242c0d51a21c703f520347b96ed19a, 0xf54d5ea2eb0e93d46e8bd925e0104162b8737722');
    expect(m).toContain('Files: 2');
    expect(m).toContain('Expires: 2026-11-16T20:00:00.000Z');
  });
  it('is independent of biocid and operator order', () => {
    const a = buildMessage(buildFields([B1, B2], { ...opts, operator: [OP, FROM] }, OP, NOW));
    const b = buildMessage(buildFields([B2, B1], { ...opts, operator: [FROM, OP] }, OP, NOW));
    expect(a).toBe(b);
  });
  it('defaults the operators to the owner and the signed-in wallet', () => {
    expect(buildFields([B1], opts, OP, NOW).operators).toEqual([FROM, OP]);
  });
});

describe('inventory-delegate validation', () => {
  it('refuses non-biocids, bad wallets, same wallet, short attestation, bad nonce, long validity', () => {
    expect(() => buildFields(['gs://b/f.fastq.gz'], opts, OP, NOW)).toThrow(/not a biocid/);
    expect(() => buildFields([B1, B1], opts, OP, NOW)).toThrow(/duplicate/);
    expect(() => buildFields([B1], { ...opts, to: '0x12' }, OP, NOW)).toThrow(/--to/);
    expect(() => buildFields([B1], { ...opts, to: FROM }, OP, NOW)).toThrow(/same wallet/);
    expect(() => buildFields([B1], { ...opts, attest: 'short' }, OP, NOW)).toThrow(/--attest/);
    expect(() => buildFields([B1], { ...opts, nonce: 'xyz' }, OP, NOW)).toThrow(/--nonce/);
    expect(() => buildFields([B1], { ...opts, expiresHours: '500' }, OP, NOW)).toThrow(/--expires-hours/);
    expect(() => buildFields([], opts, OP, NOW)).toThrow(/at least one/);
  });
  it('body is a dry run unless --yes and needs a real signature', () => {
    const f = buildFields([B1], opts, OP, NOW);
    const sig = '0x' + 'ab'.repeat(65);
    expect(buildDelegateBody(f, sig, false).dry_run).toBe(true);
    expect(buildDelegateBody(f, sig, true).dry_run).toBe(false);
    expect(() => buildDelegateBody(f, '0x12', true)).toThrow(/--signature/);
  });
});
