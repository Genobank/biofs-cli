import { buildPublicFetchBody } from '../src/commands/neoantigen-pipeline';

const W = '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
const ok = { accession: 'SRR1234567', maxTotalBytes: '4000000000' };

describe('biofs public-fetch body', () => {
  it('names an accession and nothing that names a place', () => {
    const b = buildPublicFetchBody('VAL1', { ...ok, pairs: '2000000', outName: 'val' }, W, '0xsig');
    expect(b).toEqual({ wallet: W, signature: '0xsig', case_id: 'VAL1', executor: 'worker', accession: 'SRR1234567', out_name: 'val', subsample_pairs: 2000000, max_total_bytes: 4000000000 });
    for (const k of Object.keys(b)) expect(k).not.toMatch(/url|host|token|path/i);
  });

  it('the minimal body has only the required fields', () => {
    const b = buildPublicFetchBody('VAL1', ok, W, '0xsig');
    expect(Object.keys(b).sort()).toEqual(['accession', 'case_id', 'executor', 'max_total_bytes', 'signature', 'wallet']);
  });

  it.each([
    [{ accession: 'SRX1234567', maxTotalBytes: '5' }],
    [{ accession: '../etc', maxTotalBytes: '5' }],
    [{ maxTotalBytes: '5' }],
    [{ accession: 'SRR1234567' }],
    [{ accession: 'SRR1234567', maxTotalBytes: '0' }],
    [{ accession: 'SRR1234567', maxTotalBytes: '2000000000001' }],
    [{ ...ok, pairs: '999' }],
    [{ ...ok, pairs: '50000001' }],
    [{ ...ok, pairs: 'many' }],
    [{ ...ok, outName: '1bad' }],
    [{ ...ok, outName: 'a/b' }],
  ])('refuses %j', (o) => {
    expect(() => buildPublicFetchBody('VAL1', o as any, W, '0xsig')).toThrow();
  });

  it('refuses a case id that could be a person name with spaces', () => {
    expect(() => buildPublicFetchBody('Jane Doe', ok, W, '0xsig')).toThrow();
  });

  it('an operator can run it for a custodial biowallet', () => {
    expect(buildPublicFetchBody('VAL1', { ...ok, owner: '0x' + '1'.repeat(40) }, W, '0xsig').wallet).toBe('0x' + '1'.repeat(40));
  });
});
