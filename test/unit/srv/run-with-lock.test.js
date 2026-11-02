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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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

// #2975: the #1021 per-tick deleteStuckOutboxRow() DELETE was REMOVED from
// runWithLock's finally. Under CAP 10.2's guarded singleton re-seed, deleting
// the status='processing' row per tick raced CAP's complete-tx and stopped the
// next occurrence from being scheduled (job ran once then never rescheduled).
// These tests pin the fix: runWithLock must NOT call deleteStuckOutboxRow, and
// must still record JobLastRun on both success and failure.
import * as wedge from '../../../srv/lib/scheduler-wedge.js';
import { vi } from 'vitest';

describe('runWithLock — must not delete the outbox row per tick (#2975)', () => {
  beforeAll(async () => {
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
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    await DELETE.from(JobLastRun);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT call deleteStuckOutboxRow on a successful tick (would break CAP 10.2 re-seed)', async () => {
    const spy = vi.spyOn(wedge, 'deleteStuckOutboxRow').mockResolvedValue(false);
    registerJob({
      jobName: 'test-noreap-success',
      schedule: '0 0 1 1 *',
      ttlMs: 60000,
      description: 'unit test — no per-tick reap on success',
      fn: async () => ({ ok: true }),
    });
    await runJobByName('test-noreap-success');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does NOT call deleteStuckOutboxRow on a failed tick', async () => {
    const spy = vi.spyOn(wedge, 'deleteStuckOutboxRow').mockResolvedValue(false);
    registerJob({
      jobName: 'test-noreap-fail',
      schedule: '0 0 1 1 *',
      ttlMs: 60000,
      description: 'unit test — no per-tick reap on failure',
      fn: async () => { throw new Error('boom'); },
    });
    await runJobByName('test-noreap-fail');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('still records JobLastRun on a successful tick', async () => {
    registerJob({
      jobName: 'test-noreap-records',
      schedule: '0 0 1 1 *',
      ttlMs: 60000,
      description: 'unit test — JobLastRun still lands',
      fn: async () => ({ ok: true }),
    });
    await runJobByName('test-noreap-records');
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(JobLastRun).where({ jobName: 'test-noreap-records' });
    expect(row).toBeTruthy();
    expect(row.lastSuccessAt).toBeTruthy();
  });
});
