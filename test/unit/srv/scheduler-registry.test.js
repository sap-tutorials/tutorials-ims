// test/unit/srv/scheduler-registry.test.js
//
// Unit tests for the JOB_REGISTRY chassis in srv/jobs/scheduler.js.
// Tests registry population, duplicate-name rejection, lockstep with
// registerJobs(), and cron-parser parse compat for every registered
// schedule (#958 replaced node-cron.validate with cron-parser.parse —
// the same lib already used by srv/lib/cron-firings.js).

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { CronExpressionParser } from 'cron-parser';

import {
  registerJob,
  registerJobs,
  runJobByName,
  _getJobRegistry,
  _resetJobRegistry,
} from '../../../srv/jobs/scheduler.js';

describe('scheduler — JOB_REGISTRY chassis', () => {
  beforeEach(() => {
    _resetJobRegistry();
  });

  it('registerJob populates JOB_REGISTRY', () => {
    registerJob({
      jobName: 'test-job-1',
      schedule: '0 0 * * *',
      ttlMs: 1000,
      description: 'unit test',
      fn: async () => 'ok',
    });
    const registry = _getJobRegistry();
    expect(registry.has('test-job-1')).toBe(true);
    expect(registry.get('test-job-1').schedule).toBe('0 0 * * *');
  });

  it('duplicate jobName throws', () => {
    registerJob({ jobName: 'dup', schedule: '0 0 * * *', ttlMs: 1000, description: 'x', fn: async () => 'a' });
    expect(() => registerJob({ jobName: 'dup', schedule: '0 1 * * *', ttlMs: 1000, description: 'x', fn: async () => 'b' })).toThrow(/Duplicate jobName/);
  });

  it('registerJobs() registers exactly 35 jobs (lockstep)', async () => {
    // The full registerJobs() schedules crons against node-cron. We run it
    // in a fresh test context; the test isolates by resetting the registry
    // in beforeEach and again in afterAll (below).
    registerJobs();
    // #916 adds kg-pagerank      (32 -> 33)
    // #917 adds kg-communities   (33 -> 34)
    // #918 adds kg-wcc           (34 -> 35)
    expect(_getJobRegistry().size).toBe(35);
    const names = [..._getJobRegistry().keys()];
    expect(names).toContain('fetch-help-docs');
    expect(names).toContain('fetch-community-events');
    expect(names).toContain('kg-pagerank');
    expect(names).toContain('kg-communities');
    expect(names).toContain('kg-wcc');
  });

  it('runJobByName(unknownName) throws', async () => {
    await expect(runJobByName('does-not-exist')).rejects.toThrow(/Unknown jobName/);
  });

  it('every registered schedule parses via cron-parser', () => {
    registerJobs();
    const registry = _getJobRegistry();
    for (const job of registry.values()) {
      // cron-parser throws on invalid expressions; assert no throw.
      expect(
        () => CronExpressionParser.parse(job.schedule, { tz: 'UTC' }),
        `invalid cron for ${job.jobName}: ${job.schedule}`
      ).not.toThrow();
    }
  });

  afterAll(() => {
    _resetJobRegistry();
  });
});
