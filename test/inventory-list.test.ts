import { buildInventoryListBody, groupRows, InventoryRow } from '../src/commands/inventory-list';

const row = (o: Partial<InventoryRow> = {}): InventoryRow => ({
  biocid: 'biocid://a/0x1/fastq/h1/S_R1.fastq.gz', sample_serial: 'S1', filetype: 'fastq', owner_wallet: '0xabc', originlab: 'lab', bucket: 'b1',
  object: 'input/S_R1.fastq.gz', size: 10, hierarchy_role: 'root', orphan_status: 'OWNED', ...o,
});

describe('inventory-list body', () => {
  it('needs a serial or a lab', () => {
    expect(() => buildInventoryListBody({})).toThrow(/whole inventory is never listed/);
    expect(buildInventoryListBody({ serial: ['S1'] })).toEqual({ serials: ['S1'], types: [] });
    expect(buildInventoryListBody({ lab: 'tecbase', type: ['FASTQ'], limit: '50' })).toEqual({ serials: [], types: ['fastq'], lab: 'tecbase', limit: 50 });
  });
  it('rejects a bad limit', () => {
    expect(() => buildInventoryListBody({ serial: ['S1'], limit: 'x' })).toThrow(/--limit/);
    expect(() => buildInventoryListBody({ serial: ['S1'], limit: '0' })).toThrow(/--limit/);
  });
});

describe('groupRows', () => {
  it('collapses copies of one file in several buckets into one line', () => {
    const g = groupRows([row(), row({ bucket: 'b2', biocid: 'biocid://a/0x1/fastq/h2/S_R1.fastq.gz', object: 'x/S_R1.fastq.gz' }), row({ object: 'input/S_R2.fastq.gz', biocid: 'biocid://a/0x1/fastq/h3/S_R2.fastq.gz', size: 20 })]);
    expect(g).toHaveLength(2);
    const r1 = g.find((x) => x.name === 'S_R1.fastq.gz')!;
    expect(r1.copies).toBe(2);
    expect(r1.buckets).toEqual(['b1', 'b2']);
    expect(r1.biocids).toHaveLength(2);
  });
  it('keeps files of different size or type apart', () => {
    expect(groupRows([row(), row({ size: 11 }), row({ filetype: 'bam' })])).toHaveLength(3);
  });
});
