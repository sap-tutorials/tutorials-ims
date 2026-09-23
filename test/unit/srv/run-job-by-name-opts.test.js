import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import {
  registerJob,
  runJobByName,
  _resetJobRegistry,
} from '../../../srv/jobs/scheduler.js';

describe('runJobByName opts threading (Phase 4.6)', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
  });

  beforeEach(() => {
    _resetJobRegistry();
  });

  it('logId-style cron still receives logId as first positional arg', async () => {
    let receivedLogId = null;
    registerJob({
      jobName: 'test-logid-cron',
      schedule: '0 0 * * *',
      ttlMs: 60000,
      description: 'test',
      fn: (logId) => { receivedLogId = logId; return { ok: true }; },
    });
    await runJobByName('test-logid-cron');
    expect(receivedLogId).toBeTruthy();
    expect(typeof receivedLogId).toBe('string');
  });

  it('zero-arg cron still works', async () => {
    let called = false;
    registerJob({
      jobName: 'test-zero-arg-cron',
      schedule: '0 0 * * *',
      ttlMs: 60000,
      description: 'test',
      fn: () => { called = true; return { ok: true }; },
    });
    await runJobByName('test-zero-arg-cron');
    expect(called).toBe(true);
  });

  it('Phase 4.6 cron receives opts as second positional arg', async () => {
    let receivedLogId = null;
    let receivedOpts = null;
    registerJob({
      jobName: 'test-opts-cron',
      schedule: '0 0 * * *',
      ttlMs: 60000,
      description: 'test',
      fn: (logId, opts) => { receivedLogId = logId; receivedOpts = opts; return { ok: true }; },
    });
    await runJobByName('test-opts-cron', {
      sinceIsoOverride: '1970-01-01T00:00:00Z',
      budgetOverride: 100,
    });
    expect(receivedLogId).toBeTruthy();
    expect(receivedOpts).toBeDefined();
    expect(receivedOpts.sinceIsoOverride).toBe('1970-01-01T00:00:00Z');
    expect(receivedOpts.budgetOverride).toBe(100);
  });

  it('manualTrigger + user opts are also passed through', async () => {
    let receivedOpts = null;
    registerJob({
      jobName: 'test-manual-cron',
      schedule: '0 0 * * *',
      ttlMs: 60000,
      description: 'test',
      fn: (logId, opts) => { receivedOpts = opts; return { ok: true }; },
    });
    await runJobByName('test-manual-cron', {
      manualTrigger: true,
      user: 'tom@example.com',
    });
    expect(receivedOpts.manualTrigger).toBe(true);
    expect(receivedOpts.user).toBe('tom@example.com');
  });
});

describe('scheduler soft-failure detection (#2478)', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
  });

  beforeEach(() => {
    _resetJobRegistry();
  });

  async function latestLogFor(jobName) {
    const { PipelineLog, JobLastRun } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(PipelineLog)
      .where({ pipelineType: 'SCHEDULED_JOB' })
      .orderBy({ startedAt: 'desc' });
    const log = rows.find(r => {
      try { return JSON.parse(r.metadata || '{}').jobName === jobName; }
      catch { return false; }
    });
    const lastRun = await SELECT.one.from(JobLastRun).where({ jobName });
    return { log, lastRun };
  }

  it('runner returning {ok:false, error} → FAILED with error in errorDetails (arg 4), failed JobLastRun', async () => {
    registerJob({
      jobName: 'soft-fail-cron',
      schedule: '0 0 * * *',
      ttlMs: 60000,
      description: 'test',
      fn: () => ({ ok: false, error: 'fetch/mapping failed; nothing written' }),
    });
    const res = await runJobByName('soft-fail-cron');
    expect(res.outcome).toBe('error');
    expect(res.errorMessage).toBe('fetch/mapping failed; nothing written');

    const { log, lastRun } = await latestLogFor('soft-fail-cron');
    expect(log.status).toBe('FAILED');
    expect(log.errorDetails).toBe('fetch/mapping failed; nothing written');
    // error must NOT be smuggled into the summary column
    expect(log.summary).not.toBe('fetch/mapping failed; nothing written');
    expect(lastRun.lastErrorAt).toBeTruthy();
    expect(lastRun.lastErrorMessage).toBe('fetch/mapping failed; nothing written');
    expect(lastRun.lastSuccessAt).toBeFalsy();
  });

  it('runner returning {ok:false} without error → FAILED with synthesized message', async () => {
    registerJob({
      jobName: 'soft-fail-noerr-cron',
      schedule: '0 0 * * *',
      ttlMs: 60000,
      description: 'test',
      fn: () => ({ ok: false }),
    });
    const res = await runJobByName('soft-fail-noerr-cron');
    expect(res.outcome).toBe('error');
    expect(res.errorMessage).toBe('soft-fail-noerr-cron returned ok:false');

    const { log, lastRun } = await latestLogFor('soft-fail-noerr-cron');
    expect(log.status).toBe('FAILED');
    expect(log.errorDetails).toBe('soft-fail-noerr-cron returned ok:false');
    expect(lastRun.lastErrorMessage).toBe('soft-fail-noerr-cron returned ok:false');
  });

  it('thrown exception still recorded as FAILED', async () => {
    registerJob({
      jobName: 'throw-cron',
      schedule: '0 0 * * *',
      ttlMs: 60000,
      description: 'test',
      fn: () => { throw new Error('boom'); },
    });
    const res = await runJobByName('throw-cron');
    expect(res.outcome).toBe('error');
    expect(res.errorMessage).toBe('boom');

    const { log, lastRun } = await latestLogFor('throw-cron');
    expect(log.status).toBe('FAILED');
    expect(log.errorDetails).toBe('boom');
    expect(lastRun.lastErrorMessage).toBe('boom');
  });

  it('runner returning {ok:true} still succeeds', async () => {
    registerJob({
      jobName: 'ok-true-cron',
      schedule: '0 0 * * *',
      ttlMs: 60000,
      description: 'test',
      fn: () => ({ ok: true, processed: 5 }),
    });
    const res = await runJobByName('ok-true-cron');
    expect(res.outcome).toBe('success');

    const { log, lastRun } = await latestLogFor('ok-true-cron');
    expect(log.status).toBe('SUCCESS');
    expect(log.errorDetails).toBeFalsy();
    expect(lastRun.lastSuccessAt).toBeTruthy();
    expect(lastRun.lastErrorAt).toBeFalsy();
  });

  it('runner returning a plain summary (no ok field) still succeeds', async () => {
    registerJob({
      jobName: 'plain-summary-cron',
      schedule: '0 0 * * *',
      ttlMs: 60000,
      description: 'test',
      fn: () => ({ processed: 3, skipped: 1 }),
    });
    const res = await runJobByName('plain-summary-cron');
    expect(res.outcome).toBe('success');

    const { log } = await latestLogFor('plain-summary-cron');
    expect(log.status).toBe('SUCCESS');
  });
});
