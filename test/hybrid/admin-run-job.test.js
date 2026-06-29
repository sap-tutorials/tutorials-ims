// test/hybrid/admin-run-job.test.js
//
// Hybrid end-to-end test for AdminService.JobControls.runJob.
// BLOCKED-until-deploy: requires ALLOW_HYBRID_WRITES=true + cds bind --exec
// against the DEV HANA instance. Validates that:
//   - runJob successfully fires a _test-noop job
//   - JobLastRun row updates with lastSuccessAt
//
// Audit-event assertion (2 events emitted: started + success) intentionally
// omitted — the audit-log binding isn't always available in hybrid test
// runs, and emitJobAudit's safe-degrade path swallows missing-binding
// errors. JobLastRun is the durable end-to-end signal.
//
// Module-import discipline: scheduler.js is imported via cds.utils._import
// after cds.connect so the test shares the SAME registry instance the
// AdminService handler uses (cds.utils._import is CAP's internal ESM loader
// that handles Windows file:// URL resolution; a plain `import` statement
// would yield a SEPARATE module instance — same file, two registries).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

describe('admin run-job (hybrid)', () => {
  let admin;
  let sched;
  const TEST_JOB_NAME = '_test-noop';

  beforeAll(async () => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to write HANA.');
    }
    const schedPath = path.resolve(process.cwd(), 'srv/jobs/scheduler.js');
    sched = await cds.utils._import(schedPath);
    admin = await cds.connect.to('AdminService');
    // Register a noop test job (must NOT collide with any production job).
    sched.registerJob({
      jobName: TEST_JOB_NAME,
      schedule: '0 0 1 1 1900',     // year-rare; never fires on its own
      ttlMs: 60000,
      description: 'hybrid test noop — safe to delete from JOB_REGISTRY',
      fn: async () => ({ processed: 0 }),
    });
  });

  afterAll(() => {
    // REQUIRED cleanup — leaves no test pollution in the registry.
    if (sched) sched._getJobRegistry().delete(TEST_JOB_NAME);
  });

  it('runJob fires successfully and updates JobLastRun', async () => {
    const result = await admin.send({
      event: 'runJob',
      entity: 'AdminService.JobControls',
      data: { jobName: TEST_JOB_NAME },
    });
    expect(result.started).toBe(true);
    expect(result.jobName).toBe(TEST_JOB_NAME);

    // Wait for the background setImmediate(runJobByName) to complete.
    await new Promise(resolve => setTimeout(resolve, 500));

    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(JobLastRun).where({ jobName: TEST_JOB_NAME });
    expect(row).toBeTruthy();
    expect(row.lastSuccessAt).toBeTruthy();
  });
});
