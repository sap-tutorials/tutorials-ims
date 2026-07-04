// test/unit/srv/run-with-lock.test.js
//
// Tests for the runWithLock chassis extension in #756:
// - 4th opts arg {manualTrigger, user}
// - Always writes JobLastRun row on completion (success or error)
// - Returns structured {skipped, outcome, result, errorMessage, reason}
//
// The manualTrigger=true audit-emission cases are covered in Task 2's
// tests (where emitJobAudit is defined). Here we just verify the
// lock-held PATH returns the expected shape.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

import {
  registerJob,
  runJobByName,
  _resetJobRegistry,
} from '../../../srv/jobs/scheduler.js';

describe('runWithLock — JobLastRun retrofit + manual-trigger opts', () => {
  beforeAll(async () => {
    // Boot CAP in-process against in-memory SQLite. Phase 4.5 canonical
    // pattern used by sibling unit tests (e.g. fetch-api-docs-job.test.js).
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  beforeEach(async () => {
    _resetJobRegistry();
    // Reset JobLastRun between tests. The scheduler chassis no longer
    // touches JobLocks (#958 — CAP 10's .as(name) singleton locking
    // replaced the DB lock), so JobLocks reset removed here.
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    await DELETE.from(JobLastRun);
  });

  it('successful fn: returns outcome=success, writes JobLastRun.lastSuccessAt', async () => {
    registerJob({
      jobName: 'test-success',
      schedule: '0 0 1 1 *',     // year-rare; never fires during the test
      ttlMs: 60000,
      description: 'unit test — success path',
      fn: async () => ({ processed: 5 }),
    });

    const result = await runJobByName('test-success');
    expect(result.skipped).toBe(false);
    expect(result.outcome).toBe('success');
    expect(result.result).toEqual({ processed: 5 });

    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(JobLastRun).where({ jobName: 'test-success' });
    expect(row).toBeTruthy();
    expect(row.lastSuccessAt).toBeTruthy();
    expect(row.lastErrorAt).toBeFalsy();
  });

  it('failing fn: returns outcome=error, writes JobLastRun.lastErrorMessage', async () => {
    registerJob({
      jobName: 'test-fail',
      schedule: '0 0 1 1 *',
      ttlMs: 60000,
      description: 'unit test — error path',
      fn: async () => { throw new Error('boom'); },
    });

    const result = await runJobByName('test-fail');
    expect(result.skipped).toBe(false);
    expect(result.outcome).toBe('error');
    expect(result.errorMessage).toBe('boom');

    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(JobLastRun).where({ jobName: 'test-fail' });
    expect(row).toBeTruthy();
    expect(row.lastErrorMessage).toBe('boom');
    expect(row.lastErrorAt).toBeTruthy();
  });
});
