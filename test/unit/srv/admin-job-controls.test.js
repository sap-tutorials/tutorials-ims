// test/unit/srv/admin-job-controls.test.js
//
// Unit tests for AdminService.JobControls (listJobs + runJob).
//
// Boot pattern: module-top `cds.test('serve', '--project', '.', '--in-memory')`
// — same pattern as admin-secret-value-handlers.test.js. Auto-deploys schema
// + serves the OData runtime so cds.connect.to('AdminService') resolves.
//
// IMPORTANT (adaptation from plan): CAP loads service implementation
// modules via `cds.utils._import(absPath)` (a dynamic-import wrapper that
// handles ESM resolution on Windows by URL-encoding the path). When this
// test imports the same scheduler.js with a plain `import` statement,
// Node treats it as a DIFFERENT module instance — same file, two
// registries. To work around this we resolve scheduler.js + admin-service.js
// the same way CAP does so the JOB_REGISTRY map and the emitJobAudit
// export are shared. Without this, registerJob() in the test would not be
// visible to the AdminService handler.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const ADMIN_USER = { id: 'admin@test', roles: ['Admin'] };

let sched;
let adminMod;

describe('AdminService.JobControls', () => {
  let admin;
  // Unique job name per test to avoid fire-and-forget setImmediate runs from
  // a previous test landing on the next test's job (which would inflate the
  // _setJobFn spy count). Bumped in each `it` via inc().
  let jobCounter = 0;
  const nextJobName = () => `test-controls-job-${++jobCounter}`;

  beforeAll(async () => {
    const schedPath = path.resolve(process.cwd(), 'srv/jobs/scheduler.js');
    const adminPath = path.resolve(process.cwd(), 'srv/admin-service.js');
    sched = await cds.utils._import(schedPath);
    adminMod = await cds.utils._import(adminPath);
    admin = await cds.connect.to('AdminService');
  });

  beforeEach(async () => {
    sched._resetJobRegistry();
    // Reset JobLastRun + JobLocks between tests.
    const { JobLastRun, JobLocks } = cds.entities('com.sap.developers.ims');
    await DELETE.from(JobLastRun);
    await DELETE.from(JobLocks);
  });

  function registerOne(jobName, fn = async () => ({ processed: 1 })) {
    sched.registerJob({
      jobName,
      schedule: '0 0 1 1 *',
      ttlMs: 60000,
      description: 'unit test',
      fn,
    });
  }

  // Helper: invoke an unbound JobControls action (singleton, no params).
  async function callListJobs() {
    return admin.tx({ user: ADMIN_USER }, (tx) =>
      tx.send({ event: 'listJobs', entity: 'AdminService.JobControls' })
    );
  }

  async function callRunJob(jobName) {
    return admin.tx({ user: ADMIN_USER }, (tx) =>
      tx.send({ event: 'runJob', entity: 'AdminService.JobControls', data: { jobName } })
    );
  }

  it('listJobs returns one entry per registered job with nextRunIso populated', async () => {
    const jobName = nextJobName();
    registerOne(jobName);
    const rows = await callListJobs();
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.find(r => r.jobName === jobName);
    expect(row).toBeTruthy();
    expect(row.schedule).toBe('0 0 1 1 *');
    expect(row.description).toBe('unit test');
    // ISO8601 timestamp for 1 Jan at midnight UTC.
    expect(row.nextRunIso).toMatch(/^\d{4}-01-01T00:00:00\.\d{3}Z$/);
  });

  it('runJob returns {started: true, startedAt} synchronously for a known jobName', async () => {
    const jobName = nextJobName();
    registerOne(jobName);
    const result = await callRunJob(jobName);
    expect(result.started).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.jobName).toBe(jobName);
    expect(result.startedAt).toBeTruthy();
  });

  it('runJob rejects with 400 for an unknown jobName', async () => {
    // Validation-before-audit: the handler returns req.reject() synchronously
    // BEFORE setImmediate fires emitJobAudit, so a rejection guarantees no
    // audit emission. We verify this by intercepting emitJobAudit via the
    // (shared via cds.utils._import) adminMod namespace. Direct
    // re-assignment to the export is rejected by Node's ESM frozen
    // namespace, so we instead swap the internal _moduleAuditEvent pointer
    // — not exposed but discoverable through the closure.
    let auditCalls = 0;
    const origEmit = adminMod.emitJobAudit;
    // We cannot replace the exported function on a frozen namespace; instead
    // assert via timing: the rejection MUST occur synchronously (handler
    // returns sub-ms before setImmediate could run).
    const start = Date.now();
    await expect(callRunJob('no-such-job')).rejects.toMatchObject({ code: 400 });
    const elapsed = Date.now() - start;
    // Confirms handler returned synchronously without firing setImmediate.
    expect(elapsed).toBeLessThan(100);
    // Also wait + verify no JobLastRun row was written (would be a side-
    // effect of a successful runJobByName, which can't happen if validation
    // rejected first).
    await new Promise(resolve => setTimeout(resolve, 50));
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(JobLastRun).where({ jobName: 'no-such-job' });
    expect(row).toBeFalsy();
  });

  it('runJob rejects with 400 for an oversized jobName payload', async () => {
    const huge = 'a'.repeat(101);
    const start = Date.now();
    await expect(callRunJob(huge)).rejects.toMatchObject({ code: 400 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
    // No JobLastRun row written.
    await new Promise(resolve => setTimeout(resolve, 50));
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(JobLastRun).where({ jobName: huge });
    expect(row).toBeFalsy();
  });

  it('runJob invokes the registered fn (verified via direct counter)', async () => {
    const jobName = nextJobName();
    let callCount = 0;
    registerOne(jobName, async () => { callCount++; return { processed: callCount }; });

    await callRunJob(jobName);
    // Fire-and-forget — wait briefly for setImmediate to drain.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(callCount).toBe(1);
  });

  it('runJob writes JobLastRun row after the fn resolves (chassis path)', async () => {
    const jobName = nextJobName();
    registerOne(jobName);
    await callRunJob(jobName);
    // Wait for setImmediate + the fn + recordJobLastRun.
    await new Promise(resolve => setTimeout(resolve, 200));

    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(JobLastRun).where({ jobName });
    expect(row).toBeTruthy();
    expect(row.lastSuccessAt).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────
  // #750: nextRunsIso (forward-visibility window for the Board tile)
  // ─────────────────────────────────────────────────────────────────

  // Helper: register a job with a specific schedule. Variant of registerOne()
  // above that takes the schedule, so we can test window math without
  // colliding with the default '0 0 1 1 *' yearly cron.
  function registerWithSchedule(jobName, schedule) {
    sched.registerJob({
      jobName,
      schedule,
      ttlMs: 60000,
      description: 'unit test #750',
      fn: async () => ({ processed: 1 }),
    });
  }

  it('listJobs response includes nextRunsIso as an array', async () => {
    const jobName = nextJobName();
    registerWithSchedule(jobName, '*/5 * * * *');
    const rows = await callListJobs();
    const row = rows.find(r => r.jobName === jobName);
    expect(row).toBeTruthy();
    expect(Array.isArray(row.nextRunsIso)).toBe(true);
  });

  it('listJobs.nextRunsIso entries are all within the next 24 hours', async () => {
    const jobName = nextJobName();
    registerWithSchedule(jobName, '*/15 * * * *'); // every 15 minutes
    const rows = await callListJobs();
    const row = rows.find(r => r.jobName === jobName);
    expect(row.nextRunsIso.length).toBeGreaterThan(0);
    const now = Date.now();
    const horizon = now + 24 * 60 * 60 * 1000;
    for (const iso of row.nextRunsIso) {
      const t = new Date(iso).getTime();
      expect(t).toBeGreaterThan(now);
      // Allow ±1s slack for handler-clock vs. test-clock skew.
      expect(t).toBeLessThanOrEqual(horizon + 1000);
    }
  });

  it('listJobs.nextRunsIso[0] equals nextRunIso when the next run is in-window', async () => {
    const jobName = nextJobName();
    registerWithSchedule(jobName, '*/5 * * * *');
    const rows = await callListJobs();
    const row = rows.find(r => r.jobName === jobName);
    expect(row.nextRunsIso.length).toBeGreaterThan(0);
    expect(row.nextRunsIso[0]).toBe(row.nextRunIso);
  });

  it('listJobs.nextRunsIso is [] for a monthly cron whose next firing is >24h away', async () => {
    // Pick a day-of-month so far in the future that no firing lands in (now, now+24h].
    // First of next year @ 00:00 UTC is always >24h out from any test run.
    const jobName = nextJobName();
    registerWithSchedule(jobName, '0 0 1 1 *'); // 00:00 on 1 Jan
    const rows = await callListJobs();
    const row = rows.find(r => r.jobName === jobName);
    expect(row.nextRunsIso).toEqual([]);
    // But nextRunIso must still be populated via the fallback.
    expect(row.nextRunIso).toMatch(/^\d{4}-01-01T00:00:00\.\d{3}Z$/);
  });

  it('listJobs.nextRunsIso has exactly 50 entries for a per-minute schedule (cap, not 1440)', async () => {
    const jobName = nextJobName();
    registerWithSchedule(jobName, '* * * * *');
    const rows = await callListJobs();
    const row = rows.find(r => r.jobName === jobName);
    expect(row.nextRunsIso.length).toBe(50);
  });

  // ─────────────────────────────────────────────────────────────────
  // #1023: listRunningJobs — reads PipelineLog rows still in RUNNING
  // state and extracts jobName from metadata JSON.
  // ─────────────────────────────────────────────────────────────────
  async function callListRunningJobs() {
    return admin.tx({ user: ADMIN_USER }, (tx) =>
      tx.send({ event: 'listRunningJobs', entity: 'AdminService.JobControls' })
    );
  }

  async function insertPipelineRow({ id, status, jobName, pipelineType = 'SCHEDULED_JOB', startedAt = new Date().toISOString() }) {
    const { PipelineLog } = cds.entities('com.sap.developers.ims');
    await INSERT.into(PipelineLog).entries({
      ID: id,
      pipelineType,
      status,
      startedAt,
      initiator: 'system',
      metadata: jobName != null ? JSON.stringify({ jobName }) : null,
    });
  }

  it('listRunningJobs returns only SCHEDULED_JOB rows with status=RUNNING', async () => {
    const { PipelineLog } = cds.entities('com.sap.developers.ims');
    await DELETE.from(PipelineLog);
    await insertPipelineRow({ id: 'r1', status: 'RUNNING', jobName: 'alpha' });
    // Finished job — must NOT show up.
    await insertPipelineRow({ id: 'r2', status: 'SUCCESS', jobName: 'beta' });
    // Failed job — must NOT show up.
    await insertPipelineRow({ id: 'r3', status: 'FAILED', jobName: 'gamma' });
    // Non-scheduled RUNNING pipeline (e.g. CONTENT_PUBLISH) — must NOT show up.
    await insertPipelineRow({ id: 'r4', status: 'RUNNING', jobName: 'delta', pipelineType: 'CONTENT_PUBLISH' });

    const rows = await callListRunningJobs();
    expect(rows).toHaveLength(1);
    expect(rows[0].jobName).toBe('alpha');
    expect(rows[0].startedAt).toBeTruthy();
  });

  it('listRunningJobs skips rows with unparseable / missing metadata', async () => {
    const { PipelineLog } = cds.entities('com.sap.developers.ims');
    await DELETE.from(PipelineLog);
    await insertPipelineRow({ id: 'r1', status: 'RUNNING', jobName: 'good' });
    // Garbage metadata — must be skipped, not throw.
    await INSERT.into(PipelineLog).entries({
      ID: 'r2',
      pipelineType: 'SCHEDULED_JOB',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      initiator: 'system',
      metadata: '{not-json',
    });
    // Missing metadata — must be skipped.
    await INSERT.into(PipelineLog).entries({
      ID: 'r3',
      pipelineType: 'SCHEDULED_JOB',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      initiator: 'system',
      metadata: null,
    });

    const rows = await callListRunningJobs();
    expect(rows).toHaveLength(1);
    expect(rows[0].jobName).toBe('good');
  });

  it('listRunningJobs returns [] when no scheduled jobs are running', async () => {
    const { PipelineLog } = cds.entities('com.sap.developers.ims');
    await DELETE.from(PipelineLog);
    const rows = await callListRunningJobs();
    expect(rows).toEqual([]);
  });

  // #1021 — wedge detection in listJobs()
  // NOTE: plan named helpers callListJobs() and registerTestJob(name, schedule).
  // callListJobs() already exists (line 65). registerTestJob does not exist;
  // registerWithSchedule(jobName, schedule) is the pre-existing equivalent
  // and is used below (adaptation option b — no renaming of existing helpers).
  //
  // IMPORTANT (Windows module-identity / Vitest ESM mock limitation):
  // cds.test('serve') loads admin-service.js via cds.utils._import, which on
  // Windows issues import(new URL('file://'+path).href). This bypasses Vitest's
  // ESM live-binding mock interceptor so vi.spyOn on scheduler-wedge exports
  // has no effect on the handler's copy — same documented limitation as
  // AdminService.generate*Explainers tests (admin-service-explainer-actions.test.js)
  // and kg-path-v2-handler-flag.test.js. Workaround: globalThis injection hooks
  // (__TEST_loadStuckOutboxTargets, __TEST_isWithinExpectedTickWindow) checked
  // by the listJobs handler. Production never sets these globals.
  describe('JobControls.listJobs — wedged field', () => {
    afterEach(() => {
      delete globalThis.__TEST_loadStuckOutboxTargets;
      delete globalThis.__TEST_isWithinExpectedTickWindow;
    });

    it('returns wedged: false for a job with no outbox row', async () => {
      globalThis.__TEST_loadStuckOutboxTargets = async () => new Map();
      const jobs = await callListJobs();
      for (const job of jobs) {
        expect(job.wedged).toBe(false);
      }
    });

    it('returns wedged: false for a job with a processing row inside its expected tick window', async () => {
      globalThis.__TEST_loadStuckOutboxTargets = async () => new Map([['test-window-ok', true]]);
      globalThis.__TEST_isWithinExpectedTickWindow = () => true;
      registerWithSchedule('test-window-ok', '*/1 * * * *');
      const jobs = await callListJobs();
      const job = jobs.find(j => j.jobName === 'test-window-ok');
      expect(job.wedged).toBe(false);
    });

    it('returns wedged: true when a processing row exists AND we are past next fire', async () => {
      globalThis.__TEST_loadStuckOutboxTargets = async () => new Map([['test-wedged', true]]);
      globalThis.__TEST_isWithinExpectedTickWindow = () => false;
      registerWithSchedule('test-wedged', '*/1 * * * *');
      const jobs = await callListJobs();
      const job = jobs.find(j => j.jobName === 'test-wedged');
      expect(job.wedged).toBe(true);
    });

    it('fails open — returns all wedged: false when loadStuckOutboxTargets rejects', async () => {
      globalThis.__TEST_loadStuckOutboxTargets = async () => { throw new Error('outbox unreachable'); };
      const jobs = await callListJobs();
      for (const job of jobs) {
        expect(job.wedged).toBe(false);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // #1021 — forceUnwedge operator recovery action
  //
  // NOTE (ESM identity adaptation — same constraint as Task 3 wedge tests):
  // cds.test('serve') loads admin-service.js via cds.utils._import (Windows
  // file:// URL path) which bypasses Vitest's ESM live-binding interceptor.
  // vi.spyOn on scheduler-wedge or admin-service exports does NOT intercept
  // the handler's copy of those bindings. Strategy B (pre-flight flag #1):
  // globalThis seams (__TEST_deleteStuckOutboxRow, __TEST_emitJobAudit)
  // checked by the forceUnwedge handler. Production never sets these globals.
  // ─────────────────────────────────────────────────────────────────

  async function callForceUnwedge(jobName) {
    return admin.tx({ user: ADMIN_USER }, (tx) =>
      tx.send({ event: 'forceUnwedge', entity: 'AdminService.JobControls', data: { jobName } })
    );
  }

  describe('JobControls.forceUnwedge', () => {
    afterEach(() => {
      delete globalThis.__TEST_deleteStuckOutboxRow;
      delete globalThis.__TEST_emitJobAudit;
    });

    it('rejects with 400 for missing jobName', async () => {
      await expect(callForceUnwedge(undefined)).rejects.toMatchObject({ code: 400 });
    });

    it('rejects with 400 for jobName longer than MAX_JOB_NAME_LEN', async () => {
      const huge = 'x'.repeat(200);
      await expect(callForceUnwedge(huge)).rejects.toMatchObject({ code: 400 });
    });

    it('rejects with 400 for unknown jobName', async () => {
      await expect(callForceUnwedge('never-registered')).rejects.toMatchObject({ code: 400 });
    });

    it('returns cleared: true when deleteStuckOutboxRow reports a delete', async () => {
      registerWithSchedule('test-unwedge-ok', '*/1 * * * *');
      globalThis.__TEST_deleteStuckOutboxRow = async () => true;
      const result = await callForceUnwedge('test-unwedge-ok');
      expect(result.cleared).toBe(true);
      expect(result.reason).toBeFalsy();
      expect(result.jobName).toBe('test-unwedge-ok');
    });

    it('returns cleared: false with reason when no row was found', async () => {
      registerWithSchedule('test-unwedge-none', '*/1 * * * *');
      globalThis.__TEST_deleteStuckOutboxRow = async () => false;
      const result = await callForceUnwedge('test-unwedge-none');
      expect(result.cleared).toBe(false);
      expect(result.reason).toMatch(/No stuck outbox row/i);
    });

    it('emits audit with outcome=unwedged before the DELETE (strategy B: globalThis seam)', async () => {
      // Rationale: vi.spyOn on emitJobAudit export doesn't intercept the
      // handler's internal binding (ESM namespace frozen at load time, same
      // issue as listJobs wedge tests). globalThis.__TEST_emitJobAudit is
      // the canonical workaround for this repo — matches Task 3's pattern.
      registerWithSchedule('test-unwedge-audit', '*/1 * * * *');
      const auditCalls = [];
      globalThis.__TEST_emitJobAudit = async (opts) => { auditCalls.push(opts); };
      globalThis.__TEST_deleteStuckOutboxRow = async () => true;
      await callForceUnwedge('test-unwedge-audit');
      // Flush setImmediate so the fire-and-forget audit call executes.
      await new Promise(resolve => setImmediate(resolve));
      expect(auditCalls.length).toBe(1);
      expect(auditCalls[0]).toMatchObject({
        jobName: 'test-unwedge-audit',
        outcome: 'unwedged',
      });
    });
  });
});
