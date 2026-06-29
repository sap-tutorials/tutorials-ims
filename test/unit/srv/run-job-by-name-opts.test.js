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
