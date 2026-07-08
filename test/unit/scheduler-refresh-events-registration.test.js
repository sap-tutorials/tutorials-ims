// test/unit/scheduler-refresh-events-registration.test.js
// #1030 — assert the new refresh-community-events job is wired to the registry.

import { describe, it, expect, beforeAll } from 'vitest';
import { registerJobs, _getJobRegistry } from '../../srv/jobs/scheduler.js';

describe('scheduler registration', () => {
  beforeAll(() => {
    if (_getJobRegistry().size === 0) registerJobs();
  });

  it('registers refresh-community-events at 17 */6 * * *', () => {
    const job = _getJobRegistry().get('refresh-community-events');
    expect(job).toBeDefined();
    expect(job.schedule).toBe('17 */6 * * *');
    expect(job.description).toMatch(/Refresh CommunityEvents/i);
    expect(typeof job.fn).toBe('function');
  });

  it('keeps the twice-weekly fetch-community-events job registered', () => {
    // Guardrail: the new job is IN ADDITION TO, not a replacement for, the extraction job.
    const twiceWeekly = _getJobRegistry().get('fetch-community-events');
    expect(twiceWeekly).toBeDefined();
    expect(twiceWeekly.schedule).toBe('31 4 * * 1,4');
  });
});
