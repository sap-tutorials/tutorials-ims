import { describe, it, expect, beforeEach } from 'vitest';
import { registerJobs, _getJobRegistry, _resetJobRegistry } from '../../srv/jobs/scheduler.js';

describe('url-health-check registration', () => {
  beforeEach(() => _resetJobRegistry());
  it('registers url-health-check on an off-minute schedule', async () => {
    await registerJobs();
    const job = _getJobRegistry().get('url-health-check');
    expect(job).toBeTruthy();
    const minute = job.schedule.split(' ')[0];
    expect(['0', '30']).not.toContain(minute); // off-minute per Global Constraints
    expect(typeof job.fn).toBe('function');
  });
});
