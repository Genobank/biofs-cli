import { splitGs, detectBuild, shouldStream } from '../src/commands/somatic-mutect/exec';

describe('somatic-mutect exec: large-pair handling', () => {
  test('splitGs separates bucket, directory and file', () => {
    expect(splitGs('gs://b/biorouter/0xabc/bam/1d86/NORMAL.bam')).toEqual({ bucket: 'b', object: 'biorouter/0xabc/bam/1d86/NORMAL.bam', dir: 'biorouter/0xabc/bam/1d86', file: 'NORMAL.bam' });
    expect(splitGs('gs://b/x.bam').dir).toBe('');
    expect(() => splitGs('/local/x.bam')).toThrow(/gs:\/\//);
  });
  test('reference build from chr1 length', () => {
    expect(detectBuild(248956422)).toBe('hg38');
    expect(detectBuild(249250621)).toBe('b37');
    expect(detectBuild(null)).toBe('unknown');
    expect(detectBuild(1)).toBe('unknown');
  });
  test('a normal above the threshold, or with --stream-normal, is streamed; a small one is copied', () => {
    const GB = 1024 ** 3;
    expect(shouldStream({}, 143 * GB, 60)).toBe(true);
    expect(shouldStream({}, 20 * GB, 60)).toBe(false);
    expect(shouldStream({ streamNormal: true }, 1 * GB, 60)).toBe(true);
    expect(shouldStream({}, 60 * GB, 60)).toBe(false);
  });
});

import { validateSomaticMutectInputs } from '../src/commands/somatic-mutect/submit';
describe('somatic-mutect submit inputs', () => {
  const B = 'biocid://public-r2/0xabc/bam/x.bam';
  test('biocids accepted, legacy gs accepted, mixed per side accepted', () => {
    expect(() => validateSomaticMutectInputs({ tumorBiocid: B, normalBiocid: B })).not.toThrow();
    expect(() => validateSomaticMutectInputs({ tumorBam: 'gs://b/t.bam', normalBam: 'gs://b/n.bam' })).not.toThrow();
    expect(() => validateSomaticMutectInputs({ tumorBiocid: B, normalBam: 'gs://b/n.bam' })).not.toThrow();
  });
  test('missing, both, and malformed inputs are refused', () => {
    expect(() => validateSomaticMutectInputs({ normalBiocid: B })).toThrow(/tumor/);
    expect(() => validateSomaticMutectInputs({ tumorBiocid: B, tumorBam: 'gs://b/t.bam', normalBiocid: B })).toThrow(/not both/);
    expect(() => validateSomaticMutectInputs({ tumorBiocid: 'gs://b/t.bam', normalBiocid: B })).toThrow(/biocid:\/\//);
    expect(() => validateSomaticMutectInputs({ tumorBam: 'https://x/t.bam', normalBiocid: B })).toThrow(/gs:\/\//);
    expect(() => validateSomaticMutectInputs({ tumorBiocid: B, normalBiocid: B, intervalFile: 'file:///x.bed' })).toThrow(/gs:\/\//);
  });
});
