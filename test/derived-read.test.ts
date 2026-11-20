import * as crypto from 'crypto';

jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../src/lib/auth/credentials', () => ({ getCredentials: jest.fn(async () => ({ wallet_address: '0x' + '1'.repeat(40), user_signature: '0xsig' })) }));

import axios from 'axios';
import { fetchDerivedBytes } from '../src/commands/register-derived';

const B = 'biocid://genobank/0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed/mutect-filtering-stats/neo-1.stats.tsv';
const get = (axios as any).get as jest.Mock;
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

describe('reading a node-registered derived biofile', () => {
  it('returns bytes whose SHA-256 equals the node header', async () => {
    const body = Buffer.from('filter\tFP\nweak_evidence\t181.89\n');
    get.mockResolvedValueOnce({ status: 200, data: body, headers: { 'x-sha256': sha(body) } });
    const r = await fetchDerivedBytes(B);
    expect(r.body.toString()).toContain('weak_evidence');
    expect(r.sha256).toBe(sha(body));
    expect(get.mock.calls[0][1].params).toEqual({ biocid: B });
  });
  it('refuses bytes that do not match, bytes with no hash, and node refusals', async () => {
    get.mockResolvedValueOnce({ status: 200, data: Buffer.from('x'), headers: { 'x-sha256': 'f'.repeat(64) } });
    await expect(fetchDerivedBytes(B)).rejects.toThrow(/mismatch/);
    get.mockResolvedValueOnce({ status: 200, data: Buffer.from('x'), headers: {} });
    await expect(fetchDerivedBytes(B)).rejects.toThrow(/X-Sha256/);
    get.mockResolvedValueOnce({ status: 404, data: Buffer.from('{"error":"not found"}'), headers: {} });
    await expect(fetchDerivedBytes(B)).rejects.toThrow(/404/);
    await expect(fetchDerivedBytes('gs://bucket/x')).rejects.toThrow(/not a biocid/);
  });
});
