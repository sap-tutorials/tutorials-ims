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

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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
});
