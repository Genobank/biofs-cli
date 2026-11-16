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

describe('job-log follow', () => {
  it('does not loop forever when the node is unreachable (error surfaces)', async () => {
    process.env.BIOFS_NODE_URL = 'http://127.0.0.1:1';
    await expect(jobLogCommand(JOB, {}, async () => {})).rejects.toBeTruthy();
  });
});
