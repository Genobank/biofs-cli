import { buildInventoryRegisterBody, parseObjectArg } from '../src/commands/inventory-register';

const W = '0x01a2d260d2fe8cc13ae70b6868deb4f3ddcdb797';
const B1 = `biocid://augenomics/${W}/fastq/0d5ce2bc7767/S1_R1.fastq.gz`;
const ATT = 'GenoBank.io holds these files as custodian; the data owner consented to their use for software validation';

describe('inventory-register body', () => {
  it('is a dry run unless --yes is given', () => {
    expect(buildInventoryRegisterBody([B1], { attest: ATT }).dry_run).toBe(true);
    expect(buildInventoryRegisterBody([B1], { attest: ATT, yes: true }).dry_run).toBe(false);
  });
  it('refuses anything that is not a biocid', () => {
    expect(() => buildInventoryRegisterBody(['gs://bucket/f.fastq.gz'], { attest: ATT })).toThrow(/not a biocid/);
    expect(() => buildInventoryRegisterBody(['https://x/y.fastq.gz'], { attest: ATT })).toThrow(/not a biocid/);
  });
  it('needs a real attestation and at least one biocid', () => {
    expect(() => buildInventoryRegisterBody([B1], { attest: 'short' })).toThrow(/--attest/);
    expect(() => buildInventoryRegisterBody([], { attest: ATT })).toThrow(/at least one/);
  });
});

describe('inventory-register --object (rows that have no biocid yet)', () => {
  const T = 'genobank-vault/labs/natera/casefiles/30000001/00000000-0000-7000-8000-000000000001.bam';
  it('selects rows by bucket and object path and sends them with the overrides', () => {
    const b: any = buildInventoryRegisterBody([], { attest: ATT, object: [T, `gs://${T}`], lab: 'natera', serial: '30000001', type: 'bam' });
    expect(b.objects).toEqual([
      { bucket: 'genobank-vault', object: 'labs/natera/casefiles/30000001/00000000-0000-7000-8000-000000000001.bam', lab: 'natera', serial: '30000001', type: 'bam' },
      { bucket: 'genobank-vault', object: 'labs/natera/casefiles/30000001/00000000-0000-7000-8000-000000000001.bam', lab: 'natera', serial: '30000001', type: 'bam' },
    ]);
    expect(b.dry_run).toBe(true);
    expect(b.biocids).toEqual([]);
  });
  it('sends no overrides unless they are given, and no objects key without --object', () => {
    const b: any = buildInventoryRegisterBody([B1], { attest: ATT, object: [T] });
    expect(b.objects[0]).toEqual({ bucket: 'genobank-vault', object: 'labs/natera/casefiles/30000001/00000000-0000-7000-8000-000000000001.bam' });
    expect('objects' in (buildInventoryRegisterBody([B1], { attest: ATT }) as any)).toBe(false);
  });
  it('refuses traversal, a bare name, and overrides without --object', () => {
    expect(() => parseObjectArg('genobank-vault/../x.bam')).toThrow(/not a bucket\/object path/);
    expect(() => parseObjectArg('x.bam')).toThrow(/not a bucket\/object path/);
    expect(() => parseObjectArg('genobank-vault//x.bam')).toThrow(/not a bucket\/object path/);
    expect(() => buildInventoryRegisterBody([B1], { attest: ATT, lab: 'natera' })).toThrow(/--object rows only/);
  });
});
