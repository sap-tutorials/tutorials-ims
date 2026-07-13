// test/unit/kg/community-label-scheduled.test.js
import { describe, it, expect } from 'vitest';
import { registerJobs, _getJobRegistry, _resetJobRegistry } from '../../../srv/jobs/scheduler.js';

describe('kg-community-labels scheduling (#1126)', () => {
  it('is registered at 04:12 UTC', () => {
    _resetJobRegistry();
    registerJobs();
    const job = _getJobRegistry().get('kg-community-labels');
    expect(job).toBeTruthy();
    expect(job.schedule).toBe('12 4 * * *');
  });
});
