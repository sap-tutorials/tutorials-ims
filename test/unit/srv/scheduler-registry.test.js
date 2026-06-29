// test/unit/srv/scheduler-registry.test.js
//
// Unit tests for the JOB_REGISTRY chassis in srv/jobs/scheduler.js.
// Tests registry population, duplicate-name rejection, lockstep with
// registerJobs(), and node-cron validate() compat for every registered
// schedule.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import cron from 'node-cron';

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

  it('registerJobs() registers exactly 25 jobs (lockstep)', async () => {
    // The full registerJobs() schedules crons against node-cron. We run it
    // in a fresh test context; the test isolates by resetting the registry
    // in beforeEach and again in afterAll (below).
    registerJobs();
    expect(_getJobRegistry().size).toBe(25);    // Phase 4.6 (#747) adds fetch-samples
  });

  it('runJobByName(unknownName) throws', async () => {
    await expect(runJobByName('does-not-exist')).rejects.toThrow(/Unknown jobName/);
  });

  it('every registered schedule validates via node-cron', () => {
    registerJobs();
    const registry = _getJobRegistry();
    for (const job of registry.values()) {
      expect(cron.validate(job.schedule), `invalid cron for ${job.jobName}: ${job.schedule}`).toBe(true);
    }
  });

  afterAll(() => {
    _resetJobRegistry();
  });
});
