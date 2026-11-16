import { buildCaptureBody, parseDesignBiocids } from '../src/commands/neoantigen-pipeline';

const W = '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
const O = '0x01a2D260d2fE8cc13AE70b6868dEB4F3DdCDb797';
const BAM = 'biocid://genobank/0x01a2d260d2fe8cc13ae70b6868deb4f3ddcdb797/bam/neo-71e2e8ed.AD3A014_fq2bam.bam';
const BED = 'biocid://genobank/0x01a2d260d2fe8cc13ae70b6868deb4f3ddcdb797/bed/x.bed';
const H = 'a'.repeat(64);
const o = (x: any = {}) => ({ bam: BAM, design: ['twist_core_exome', 'idt_xgen_v2'], codeSha256: H, protocolSha256: H, ledgerRecord: '23', ...x });

describe('capture-compare body', () => {
  it('builds the body with owner, designs, defaults', () => {
    const b: any = buildCaptureBody('AD3KIT', o({ owner: O }), W, '0xsig');
    expect(b.wallet).toBe(O);
    expect(b.designs).toEqual(['twist_core_exome', 'idt_xgen_v2']);
    expect(b.bam_biocid).toBe(BAM);
    expect(b.pad).toBe(0);
    expect(b.ledger_record).toBe(23);
  });
  it('accepts designs by biocid and comma lists', () => {
    const b: any = buildCaptureBody('AD3KIT', o({ design: ['a,b'], designBiocid: [`mine=${BED}`], pad: '100' }), W, 's');
    expect(b.designs).toEqual(['a', 'b']);
    expect(b.designs_biocids.mine).toBe(BED);
    expect(b.pad).toBe(100);
  });
  it('refuses bad input', () => {
    expect(() => buildCaptureBody('AD3KIT', o({ bam: 'gs://b/x.bam' }), W, 's')).toThrow(/biocid/);
    expect(() => buildCaptureBody('AD3KIT', o({ design: [] }), W, 's')).toThrow(/at least one candidate/);
    expect(() => buildCaptureBody('AD3KIT', o({ design: ['../x'] }), W, 's')).toThrow(/catalog design/);
    expect(() => buildCaptureBody('AD3KIT', o({ design: ['a', 'a'] }), W, 's')).toThrow(/twice/);
    expect(() => buildCaptureBody('AD3KIT', o({ pad: '5000' }), W, 's')).toThrow(/--pad/);
    expect(() => buildCaptureBody('AD3KIT', o({ ledgerRecord: '0' }), W, 's')).toThrow(/ledger/);
    expect(() => buildCaptureBody('A D', o(), W, 's')).toThrow(/case identifier/);
    expect(() => parseDesignBiocids(['nolabel'])).toThrow(/label=biocid/);
  });
});
