import { buildWindowsBody, buildRescoreBody, parsePeptidesTsv, peptidesSha256 } from '../src/commands/neoantigen-pipeline';

const W = '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
const O = '0x01a2D260d2fE8cc13AE70b6868dEB4F3DdCDb797';
const H = 'a'.repeat(64);
const items = [{ id: 'TBKBP1', gene: 'TBKBP1', change: 'D607N' }, { id: 'RYR2', gene: 'RYR2', change: 'E2355K' }];
const wo = (x: any = {}) => ({ items: 'x.json', codeSha256: H, protocolSha256: H, ledgerRecord: '29', ...x });
const ro = (x: any = {}) => ({ peptides: 'x.tsv', class1: ['HLA-A*02:01,HLA-B*51:08'], class2: ['HLA-DRB104:02'], codeSha256: H, protocolSha256: H, ledgerRecord: '29', ...x });
const peps = [{ id: 'a', peptide: 'SIINFEKLA' }, { id: 'b', peptide: 'LLFGYPVYV' }, { id: 'c', peptide: 'AAAAAAAAAK' }];

describe('windows-geometry body', () => {
  it('builds the body with owner, flank default and registered hashes', () => {
    const b: any = buildWindowsBody('TN25', wo({ owner: O }), W, '0xsig', items);
    expect(b.wallet).toBe(O);
    expect(b.flank).toBe(40);
    expect(b.items).toHaveLength(2);
    expect(b.ledger_record).toBe(29);
    expect(b.executor).toBe('auto');
  });
  it('refuses a bad case id, list, flank, hash, record', () => {
    expect(() => buildWindowsBody('a b', wo(), W, 's', items)).toThrow(/case identifier/);
    expect(() => buildWindowsBody('TN25', wo(), W, 's', [])).toThrow(/1 to 200/);
    expect(() => buildWindowsBody('TN25', wo(), W, 's', 'x')).toThrow(/1 to 200/);
    expect(() => buildWindowsBody('TN25', wo({ flank: '0' }), W, 's', items)).toThrow(/flank/);
    expect(() => buildWindowsBody('TN25', wo({ codeSha256: 'x' }), W, 's', items)).toThrow(/SHA-256/);
    expect(() => buildWindowsBody('TN25', wo({ ledgerRecord: '0' }), W, 's', items)).toThrow(/ledger/);
  });
});

describe('rescore body', () => {
  it('splits comma lists and pins the peptide hash', () => {
    const b: any = buildRescoreBody('TN25', ro({ owner: O }), W, '0xsig', peps);
    expect(b.class1_alleles).toEqual(['HLA-A*02:01', 'HLA-B*51:08']);
    expect(b.class2_molecules).toEqual(['HLA-DRB104:02']);
    expect(b.peptides_sha256).toBe(peptidesSha256(peps));
    expect(b.wallet).toBe(O);
  });
  it('the hash matches the worker (fixed vector shared with the Python and node tests) and ignores ids and order', () => {
    expect(peptidesSha256(peps)).toBe('29436a12819bc13da5239454997e38936e5a4d8c8f5de630f72aa27e92828597');
    expect(peptidesSha256([...peps].reverse().map((p) => ({ id: 'z' + p.id, peptide: p.peptide })))).toBe(peptidesSha256(peps));
    expect(peptidesSha256(peps.slice(0, 2))).not.toBe(peptidesSha256(peps));
  });
  it('refuses nothing to score and bad hashes', () => {
    expect(() => buildRescoreBody('TN25', ro({ class1: [], class2: [] }), W, 's', peps)).toThrow(/at least one/);
    expect(() => buildRescoreBody('TN25', ro({ protocolSha256: '' }), W, 's', peps)).toThrow(/SHA-256/);
  });
});

describe('peptides tsv', () => {
  it('parses and upper-cases', () => {
    expect(parsePeptidesTsv('peptide_id\tpeptide\np1\tsiinfekla\n')).toEqual([{ id: 'p1', peptide: 'SIINFEKLA' }]);
  });
  it('refuses a missing header, an empty file, a short row', () => {
    expect(() => parsePeptidesTsv('id\tseq\nA\tB\n')).toThrow(/header/);
    expect(() => parsePeptidesTsv('peptide_id\tpeptide\n')).toThrow(/at least one row/);
    expect(() => parsePeptidesTsv('peptide_id\tpeptide\np1\n')).toThrow(/row 2/);
  });
});
