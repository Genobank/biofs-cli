import { buildJobsPath, buildLogPath, elapsed, jobLogCommand } from '../src/commands/job-view';

const JOB = 'neo-71e2e8ed-892c-41bf-9142-82b5120a542b';

describe('jobs and job-log paths', () => {
  it('validates limit and job id and offset', () => {
    expect(buildJobsPath({})).toBe('/jobs_recent');
    expect(buildJobsPath({ limit: '10' })).toBe('/jobs_recent?limit=10');
    expect(() => buildJobsPath({ limit: '0' })).toThrow(/--limit/);
    expect(() => buildJobsPath({ limit: '101' })).toThrow(/--limit/);
    expect(buildLogPath(JOB, 120)).toBe(`/job_log?neoantigen_job_id=${JOB}&from=120`);
    expect(() => buildLogPath('x', 0)).toThrow(/neo-/);
    expect(() => buildLogPath(JOB, -1)).toThrow(/--from/);
  });
  it('formats elapsed time', () => {
    expect(elapsed('2026-11-16T00:00:00Z', '2026-11-16T00:00:42Z')).toBe('42s');
    expect(elapsed('2026-11-16T00:00:00Z', '2026-11-16T00:05:07Z')).toBe('5m07s');
    expect(elapsed('2026-11-16T00:00:00Z', '2026-11-16T02:03:00Z')).toBe('2h03m');
    expect(elapsed(null)).toBe('');
  });
});

jest.mock('axios');
jest.mock('../src/lib/auth/credentials', () => ({ getCredentials: jest.fn() }));
import axios from 'axios';
import { getCredentials } from '../src/lib/auth/credentials';

describe('job-log follow (no network: axios and credentials are mocked)', () => {
  const creds = { wallet_address: '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a', user_signature: '0xsig' };
  const page = (o: object) => ({ status: 200, data: o });
  beforeEach(() => { jest.resetAllMocks(); });

  it('needs credentials', async () => {
    (getCredentials as jest.Mock).mockResolvedValue(null);
    await expect(jobLogCommand(JOB, {}, async () => {})).rejects.toThrow(/Not authenticated/);
  });
  it('without --follow reads one page and returns', async () => {
    (getCredentials as jest.Mock).mockResolvedValue(creds);
    (axios.get as jest.Mock).mockResolvedValue(page({ text: 'a\n', next: 2, status: 'running', finished: false }));
    const w = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await jobLogCommand(JOB, {}, async () => {});
    expect(axios.get).toHaveBeenCalledTimes(1);
    w.mockRestore();
  });
  it('with --follow it continues from the returned offset and stops when the job is finished and the log is drained', async () => {
    (getCredentials as jest.Mock).mockResolvedValue(creds);
    (axios.get as jest.Mock)
      .mockResolvedValueOnce(page({ text: 'a\n', next: 2, status: 'running', finished: false }))
      .mockResolvedValueOnce(page({ text: 'b\n', next: 4, status: 'done', finished: true }))
      .mockResolvedValueOnce(page({ text: '', next: 4, status: 'done', finished: true }));
    const w = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await jobLogCommand(JOB, { follow: true }, async () => {});
    const urls = (axios.get as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(urls.map((u) => u.split('from=')[1])).toEqual(['0', '2', '4']);
    w.mockRestore();
  });
  it('a node error surfaces', async () => {
    (getCredentials as jest.Mock).mockResolvedValue(creds);
    (axios.get as jest.Mock).mockResolvedValue({ status: 404, data: { error: 'neoantigen_job_id not found' } });
    await expect(jobLogCommand(JOB, { follow: true }, async () => {})).rejects.toBeTruthy();
  });
});
