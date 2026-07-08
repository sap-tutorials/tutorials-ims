// test/unit/community-blogs-jobs-registration.test.js
//
// (#1033) Guards that the fetch + classify jobs are wired into the
// central JOB_REGISTRY with the expected cron schedules. Catches
// accidental removal or minute-drift at commit time — CronService reads
// JOB_REGISTRY at boot, so an entry missing here means the job silently
// doesn't run in prod.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  registerJobs,
  _getJobRegistry,
  _resetJobRegistry,
} from '../../srv/jobs/scheduler.js';

describe('Community Blog Posts cron registration', () => {
  beforeAll(() => {
    _resetJobRegistry();
    registerJobs();
  });

  it('registers community-blogs-fetch at :17 and :47', () => {
    const job = _getJobRegistry().get('community-blogs-fetch');
    expect(job).toBeTruthy();
    expect(job.schedule).toBe('17,47 * * * *');
    expect(typeof job.fn).toBe('function');
    expect(job.ttlMs).toBeGreaterThan(0);
  });

  it('registers community-blogs-classify at :07/:22/:37/:52', () => {
    const job = _getJobRegistry().get('community-blogs-classify');
    expect(job).toBeTruthy();
    expect(job.schedule).toBe('7,22,37,52 * * * *');
    expect(typeof job.fn).toBe('function');
    expect(job.ttlMs).toBeGreaterThan(0);
  });
});
