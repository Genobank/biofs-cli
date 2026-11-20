import { Readable } from 'stream';

jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../src/lib/auth/credentials', () => ({ getCredentials: jest.fn(async () => ({ wallet_address: '0x' + '1'.repeat(40), user_signature: '0xsig' })) }));

import axios from 'axios';
import { nodeRegionEligible, openNodeRegion, pipeNodeRegionToCommand } from '../src/lib/tele/region_node';

const get = (axios as any).get as jest.Mock;
const B = 'biocid://genobank/0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed/bam/neo-1.tumor.bam';

describe('region reads through biofs-node', () => {
  it('goes to the node only for a biocid with a start and an end', () => {
    expect(nodeRegionEligible(B, 'chr12:25245300-25245400')).toBe(true);
    expect(nodeRegionEligible(B, 'chr12:25,245,300-25,245,400')).toBe(true);
    expect(nodeRegionEligible(B, 'chr12')).toBe(false);
    expect(nodeRegionEligible(B, undefined)).toBe(false);
    expect(nodeRegionEligible('my-alias', 'chr12:1-2')).toBe(false);
  });

  it('a refusal carries the node status and reason, and no byte reaches a tool', async () => {
    get.mockResolvedValueOnce({ status: 409, data: Readable.from([Buffer.from('{"error":"no index beside this biofile"}')]), headers: {} });
    await expect(openNodeRegion(B, 'chr12:1-2')).rejects.toThrow(/409.*no index beside/);
    expect(get.mock.calls[0][1].params).toEqual({ biocid: B, region: 'chr12:1-2' });
    expect(get.mock.calls[0][1].headers['X-Biofs-Wallet']).toBe('0x' + '1'.repeat(40));
  });

  it('pipes the region bytes into the tool and returns its exit code', async () => {
    get.mockResolvedValueOnce({ status: 200, data: Readable.from([Buffer.from('region-bytes')]), headers: { 'x-format': 'BAM', 'x-region': 'chr12:1-2' } });
    const code = await pipeNodeRegionToCommand(B, 'chr12:1-2', 'sh', ['-c', 'test "$(cat)" = region-bytes'], { quiet: true });
    expect(code).toBe(0);
  });
});

describe('whole-file reads through biofs-node', () => {
  it('a biocid with no region is eligible; an alias or a region is not', () => {
    const { nodeWholeEligible } = require('../src/lib/tele/region_node');
    expect(nodeWholeEligible(B, undefined)).toBe(true);
    expect(nodeWholeEligible(B, 'chr1:1-2')).toBe(false);
    expect(nodeWholeEligible('my-alias', undefined)).toBe(false);
  });

  it('sends no region parameter and returns the stream', async () => {
    const { tryOpenNodeWhole } = require('../src/lib/tele/region_node');
    get.mockResolvedValueOnce({ status: 200, data: Readable.from([Buffer.from('x')]), headers: { 'x-format': 'VCFTXT', 'x-region': 'whole' } });
    const r = await tryOpenNodeWhole(B);
    expect(r.format).toBe('VCFTXT');
    expect(get.mock.calls[get.mock.calls.length - 1][1].params).toEqual({ biocid: B });
  });

  it('404 and 415 fall back to htsget (null); a revoked consent is thrown', async () => {
    const { tryOpenNodeWhole } = require('../src/lib/tele/region_node');
    get.mockResolvedValueOnce({ status: 404, data: Readable.from([Buffer.from('{"error":"not found"}')]), headers: {} });
    expect(await tryOpenNodeWhole(B)).toBeNull();
    get.mockResolvedValueOnce({ status: 415, data: Readable.from([Buffer.from('{"error":"not served"}')]), headers: {} });
    expect(await tryOpenNodeWhole(B)).toBeNull();
    get.mockResolvedValueOnce({ status: 400, data: Readable.from([Buffer.from('{"error":"region must be contig:start-end (1-based, inclusive)"}')]), headers: {} });
    expect(await tryOpenNodeWhole(B)).toBeNull();
    get.mockResolvedValueOnce({ status: 403, data: Readable.from([Buffer.from('{"error":"consent revoked"}')]), headers: {} });
    await expect(tryOpenNodeWhole(B)).rejects.toThrow(/403.*consent revoked/);
  });
});
