import { buildReconcileBody } from '../src/commands/reconcile-owners';

describe('buildReconcileBody', () => {
  const W = '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
  it('is a dry run unless --apply', () => {
    expect(buildReconcileBody('0xa', 's', {}).dry_run).toBe(true);
    expect(buildReconcileBody('0xa', 's', { apply: true }).dry_run).toBe(false);
  });
  it('passes owner, prefix and limit through', () => {
    const b = buildReconcileBody('0xa', 's', { owner: W, prefix: '0x5f5a/', limit: '50' });
    expect(b.owner).toBe(W); expect(b.prefix).toBe('0x5f5a/'); expect(b.limit).toBe(50);
  });
  it('rejects a bad owner and a bad limit', () => {
    expect(() => buildReconcileBody('0xa', 's', { owner: '0x123' })).toThrow(/42 characters/);
    expect(() => buildReconcileBody('0xa', 's', { limit: '0' })).toThrow(/1 to 5000/);
    expect(() => buildReconcileBody('0xa', 's', { limit: 'x' })).toThrow(/1 to 5000/);
  });
});
