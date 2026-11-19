import * as crypto from 'crypto';
import { ethers } from 'ethers';
import { buildRelease, canonical, manifestSha256, releaseMessage } from '../src/commands/node-release';

const A = Buffer.from('A = 1\n');
const spec = { release_id: 'rel-cli-test', source_commit: 'd1a2b1d', note: 'cross check',
  targets: [{ host: 'parabricks-gpu', root: '/opt/biofs-pbrun/repo', service: 'biofs-pbrun-worker.service', files: [{ path: 'neoantigen/a.py', old_sha256: null, source: 'a.py' }] }] };

describe('node-release: the manifest every host hashes and the admin signs', () => {
  it('hashes to the value biofs-node computes (node_release_core.manifest_sha256, Python)', () => {
    const rel = buildRelease(spec as any, '/x', () => A);
    expect(rel.sha256).toBe('6d122d9a41b5296fefc2b289c5de4d676c8a0da4c5699b6e158dc664bd1f55bd');
    expect(rel.contents[crypto.createHash('sha256').update(A).digest('hex')]).toBe(A.toString('base64'));
    expect(canonical({ b: [1, null, 'x'], a: true })).toBe('{"a":true,"b":[1,null,"x"]}');
  });
  it('signs the message the hosts recover', async () => {
    const w = new ethers.Wallet('0x' + 'a1'.repeat(32));
    const rel = buildRelease(spec as any, '/x', () => A);
    const sig = await w.signMessage(releaseMessage(rel.manifest));
    expect(ethers.verifyMessage(`biofs-node release:v1:rel-cli-test:${manifestSha256(rel.manifest)}`, sig)).toBe(w.address);
  });
  it('refuses a bad id, a non-ASCII note, and a file that does not change', () => {
    expect(() => buildRelease({ ...spec, release_id: 'X' } as any, '/x', () => A)).toThrow(/release_id/);
    expect(() => buildRelease({ ...spec, note: 'caf\u00e9' } as any, '/x', () => A)).toThrow(/ASCII/);
    const same = crypto.createHash('sha256').update(A).digest('hex');
    expect(() => buildRelease({ ...spec, targets: [{ ...spec.targets[0], files: [{ path: 'neoantigen/a.py', old_sha256: same, source: 'a.py' }] }] } as any, '/x', () => A)).toThrow(/replaces/);
  });
});
