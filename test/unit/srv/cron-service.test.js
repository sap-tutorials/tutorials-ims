// test/unit/srv/cron-service.test.js
//
// Unit test for the CronService wiring: verifies that init() populates
// JOB_REGISTRY (via registerJobs), attaches one handler + one schedule()
// call per registered job, and that emitting 'cron.<name>' dispatches
// to runJobByName(name).
//
// Mocking approach: vitest spies on the CronService instance's .on and
// .schedule methods. We do NOT boot the CAP outbox — this test verifies
// the CALL SHAPE, not persistent delivery.
//
// Migration spec: docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md
// Issue: #958

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';

import {
  _getJobRegistry,
  _resetJobRegistry,
  _setJobFn,
} from '../../../srv/jobs/scheduler.js';

describe('CronService.init()', () => {
  let CronService;

  beforeEach(async () => {
    _resetJobRegistry();
    // Fresh dynamic import each test so the class doesn't retain state.
    ({ default: CronService } = await import('../../../srv/cron-service.js?t=' + Date.now()));
    // Boot CAP in-memory so preSeedJobLastRun's cds.entities() call works.
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
  });

  afterEach(async () => {
    await cds.disconnect();
    _resetJobRegistry();
    delete process.env.CAP_SCHEDULING_ENABLED;
  });

  it('populates JOB_REGISTRY via registerJobs() and attaches one handler + one schedule() per job', async () => {
    const svc = new CronService();

    // Stub .on and .schedule with vitest spies. .schedule returns a chainable
    // fluent object matching the CAP 10 API shape.
    const scheduleFluent = {
      every: vi.fn().mockReturnThis(),
      as: vi.fn().mockResolvedValue(undefined),
    };
    svc.on = vi.fn();
    svc.schedule = vi.fn().mockReturnValue(scheduleFluent);

    await svc.init();

    const registrySize = _getJobRegistry().size;
    expect(registrySize).toBeGreaterThan(30);   // 32 today; guards against accidental loss

    const cronOnCalls = svc.on.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].startsWith('cron.')
    );
    expect(cronOnCalls.length).toBe(registrySize);
    expect(svc.schedule).toHaveBeenCalledTimes(registrySize);

    // Every cron handler is bound on an event name of the form 'cron.<jobName>'.
    for (const call of cronOnCalls) {
      expect(call[0]).toMatch(/^cron\..+/);
      expect(typeof call[1]).toBe('function');
    }
    // Every schedule call uses .every(<cron>).as(<jobName>).
    expect(scheduleFluent.every).toHaveBeenCalledTimes(registrySize);
    expect(scheduleFluent.as).toHaveBeenCalledTimes(registrySize);
  });

  it('handler dispatch: emitting cron.<name> invokes runJobByName(name)', async () => {
    const svc = new CronService();

    // Capture the handler registered for a specific job.
    let capturedHandler = null;
    svc.on = vi.fn((event, handler) => {
      if (event === 'cron.metrics-rollup') capturedHandler = handler;
    });
    svc.schedule = vi.fn().mockReturnValue({
      every: vi.fn().mockReturnThis(),
      as: vi.fn().mockResolvedValue(undefined),
    });
    await svc.init();

    // Replace the job fn to observe dispatch.
    let called = 0;
    _setJobFn('metrics-rollup', async () => { called++; return { ok: true }; });

    expect(capturedHandler).toBeTruthy();
    await capturedHandler();
    expect(called).toBe(1);
  });

  it('CAP_SCHEDULING_ENABLED=false: still populates registry, but does NOT wire handlers or schedule calls', async () => {
    process.env.CAP_SCHEDULING_ENABLED = 'false';
    const svc = new CronService();
    svc.on = vi.fn();
    svc.schedule = vi.fn();

    await svc.init();

    expect(_getJobRegistry().size).toBeGreaterThan(30);
    const cronOnCalls = svc.on.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].startsWith('cron.')
    );
    expect(cronOnCalls.length).toBe(0);
    expect(svc.schedule).not.toHaveBeenCalled();
  });

  it('rerun of init() does not re-run registerJobs() (guards against duplicate-jobName throw)', async () => {
    const svc1 = new CronService();
    svc1.on = vi.fn();
    svc1.schedule = vi.fn().mockReturnValue({
      every: vi.fn().mockReturnThis(),
      as: vi.fn().mockResolvedValue(undefined),
    });
    await svc1.init();

    const svc2 = new CronService();
    svc2.on = vi.fn();
    svc2.schedule = vi.fn().mockReturnValue({
      every: vi.fn().mockReturnThis(),
      as: vi.fn().mockResolvedValue(undefined),
    });
    // Should NOT throw despite the registry already being populated.
    await expect(svc2.init()).resolves.not.toThrow();
  });
});
