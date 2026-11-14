import { buildInventoryRegisterBody } from '../src/commands/inventory-register';

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
