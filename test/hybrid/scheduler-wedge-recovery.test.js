// test/hybrid/scheduler-wedge-recovery.test.js
//
// #1021: end-to-end verification against real HANA via cds bind.
// Two scenarios:
//   1. Belt self-heal — a synchronous throw in the job body still
//      leaves a clean cds.outbox.Messages afterward.
//   2. forceUnwedge action DELETEs a real stuck row.
//
// Gated on ALLOW_HYBRID_WRITES=1 (same pattern as sibling hybrid tests).

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import cds from '@sap/cds';

const HYBRID = process.env.ALLOW_HYBRID_WRITES === '1';
const maybeDescribe = HYBRID ? describe : describe.skip;

maybeDescribe('scheduler wedge recovery (hybrid)', () => {
  let srv;
  let db;
  let outbox;

  beforeAll(async () => {
    srv = await cds.connect.to('AdminService');
    db = await cds.connect.to('db');
    outbox = cds.entities('cds.outbox');
    if (!outbox?.Messages) throw new Error('cds.outbox.Messages missing — CAP version mismatch');
  });

  afterAll(async () => { await cds.disconnect(); });

  afterEach(async () => {
    // Clean up any test rows so leftovers don't wedge the next hybrid run.
    await db.run(DELETE.from(outbox.Messages).where`target LIKE 'cron.test-wedge-%'`);
  });

  it('belt: a throwing job leaves no stuck row', async () => {
    const { registerJob, _resetJobRegistry, runJobByName } =
      await import('../../srv/jobs/scheduler.js');
    registerJob({
      jobName: 'test-wedge-throw',
      schedule: '0 0 1 1 *',
      ttlMs: 60000,
      description: 'hybrid — belt test',
      fn: async () => { throw new Error('synthetic throw'); },
    });
    // Simulate the wedge condition: manually insert a processing row
    // BEFORE we invoke the runner. runWithLock's finally block should
    // clear it as part of belt-and-suspenders.
    await db.run(INSERT.into(outbox.Messages).entries({
      target: 'cron.test-wedge-throw',
      status: 'processing',
    }));
    await runJobByName('test-wedge-throw');
    const rows = await db.run(SELECT.from(outbox.Messages)
      .where({ target: 'cron.test-wedge-throw' }));
    expect(rows.length).toBe(0);
    _resetJobRegistry();
  });

  it('forceUnwedge: DELETEs a stuck row via the OData action', async () => {
    const jobName = 'extractConcepts'; // real registered job — #1021's actual failure
    await db.run(INSERT.into(outbox.Messages).entries({
      target: `cron.${jobName}`,
      status: 'processing',
    }));
    const result = await srv.send({
      event: 'forceUnwedge',
      entity: 'JobControls',
      data: { jobName },
    });
    expect(result.cleared).toBe(true);
    const rows = await db.run(SELECT.from(outbox.Messages)
      .where({ target: `cron.${jobName}`, status: 'processing' }));
    expect(rows.length).toBe(0);
  });
});
