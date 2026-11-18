import { buildTwinBody } from '../src/commands/neoantigen-pipeline';

const W = '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
const O = '0x01a2D260d2fE8cc13AE70b6868dEB4F3DdCDb797';
const H = 'b'.repeat(64);

describe('twin classify body', () => {
  it('is report-only by default, pins the code and always runs on the node', () => {
    const b: any = buildTwinBody('TWIN1', { codeSha256: H }, W, '0xsig');
    expect(b.wallet).toBe(W);
    expect(b.apply).toBe(false);
    expect(b.code_sha256).toBe(H);
    expect(b.executor).toBe('local');
    expect(b.case_id).toBe('TWIN1');
  });
  it('applies for another owner when asked', () => {
    const b: any = buildTwinBody('TWIN1', { codeSha256: H, apply: true, owner: O }, W, '0xsig');
    expect(b.apply).toBe(true);
    expect(b.wallet).toBe(O);
  });
  it('refuses a bad case id or hash', () => {
    expect(() => buildTwinBody('a b', { codeSha256: H }, W, 's')).toThrow(/case identifier/);
    expect(() => buildTwinBody('TWIN1', { codeSha256: 'x' }, W, 's')).toThrow(/SHA-256/);
  });
});
