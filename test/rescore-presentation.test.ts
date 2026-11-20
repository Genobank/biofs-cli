import { buildRescoreBody, parsePeptidesTsv, peptidesFlanksSha256, peptidesSha256 } from '../src/commands/neoantigen-pipeline';

const H = 'a'.repeat(64);
const W = '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
const ro = (o: any = {}) => ({ peptides: 'x.tsv', class1: ['HLA-A*02:01'], codeSha256: H, protocolSha256: H, ledgerRecord: '64', ...o });
const peps = [{ id: 'p1', peptide: 'SIINFEKLA', n_flank: 'AAA', c_flank: 'CC' }, { id: 'p2', peptide: 'LLFGYPVYV', n_flank: '', c_flank: '' }];

describe('rescore presentation', () => {
  test('the flank pin is the vector of the worker and the engine (rescore.peptides_flanks_sha256)', () => {
    expect(peptidesFlanksSha256(peps)).toBe('92932c84b08f2d2f73d6d4795bd11d324be523019c187ac9960346ae6b9bee94');
    expect(peptidesFlanksSha256([...peps].reverse().map((p) => ({ ...p, id: 'z' + p.id })))).toBe(peptidesFlanksSha256(peps));
    expect(peptidesFlanksSha256([{ ...peps[0], n_flank: 'AAB' }, peps[1]])).not.toBe(peptidesFlanksSha256(peps));
  });

  test('the body carries presentation, both pins and the flanks only when asked', () => {
    const b: any = buildRescoreBody('TN25', ro({ presentation: true }), W, '0xsig', peps);
    expect(b.presentation).toBe(true);
    expect(b.peptides_flanks_sha256).toBe(peptidesFlanksSha256(peps));
    expect(b.peptides_sha256).toBe(peptidesSha256(peps));
    expect(b.peptides[0]).toEqual({ id: 'p1', peptide: 'SIINFEKLA', n_flank: 'AAA', c_flank: 'CC' });
    const plain: any = buildRescoreBody('TN25', ro(), W, '0xsig', [{ id: 'p1', peptide: 'SIINFEKLA' }]);
    expect('presentation' in plain).toBe(false);
    expect('peptides_flanks_sha256' in plain).toBe(false);
  });

  test('presentation needs a class I allele', () => {
    expect(() => buildRescoreBody('TN25', ro({ presentation: true, class1: [], class2: ['HLA-DRB104:02'] }), W, 's', peps)).toThrow(/at least one --class1/);
  });

  test('the TSV with flank columns is parsed, upper-cased and validated; without --presentation the old header still works', () => {
    const t = 'peptide_id\tpeptide\tn_flank\tc_flank\np1\tsiinfekla\taaa\tCC\np2\tLLFGYPVYV\t\t\n';
    expect(parsePeptidesTsv(t, true)).toEqual([{ id: 'p1', peptide: 'SIINFEKLA', n_flank: 'AAA', c_flank: 'CC' }, { id: 'p2', peptide: 'LLFGYPVYV', n_flank: '', c_flank: '' }]);
    expect(parsePeptidesTsv(t)).toEqual([{ id: 'p1', peptide: 'SIINFEKLA' }, { id: 'p2', peptide: 'LLFGYPVYV' }]);
    expect(() => parsePeptidesTsv('peptide_id\tpeptide\np1\tSIINFEKLA\n', true)).toThrow(/n_flank and c_flank/);
    expect(() => parsePeptidesTsv(`peptide_id\tpeptide\tn_flank\tc_flank\np1\tSIINFEKLA\t${'A'.repeat(16)}\t\n`, true)).toThrow(/flank/);
    expect(() => parsePeptidesTsv('peptide_id\tpeptide\tn_flank\tc_flank\np1\tSIINFEKLA\tAAXA\t\n', true)).toThrow(/flank/);
  });
});
