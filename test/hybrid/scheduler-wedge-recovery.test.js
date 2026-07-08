// test/hybrid/scheduler-wedge-recovery.test.js
//
// #1021: end-to-end verification against real HANA via cds bind.
// Two scenarios:
//   1. Belt self-heal — a synchronous throw in the job body still
//      leaves a clean cds.outbox.Messages afterward.
//   2. forceUnwedge action DELETEs a real stuck row.
//
// 2026-07-07 refresh: rewritten to use the CORRECT outbox column
// semantics — target='queue', task=<jobName>, status='processing'.
// The prior version wrote target='cron.<jobName>' and status='processing'
// with task=NULL, which was self-consistent with the buggy detector
// but did not represent a real stuck row. Both scenarios now insert
// rows that mirror what CAP itself writes when a task is picked up.
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
    // Clean up any synthetic test rows so leftovers don't wedge the
    // next hybrid run. Scope by the synthetic job-name prefix so we
    // never touch real production rows.
    await db.run(
      DELETE.from(outbox.Messages)
        .where({ target: 'queue', task: { like: 'test-wedge-%' } })
    );
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
    // Simulate the wedge condition: manually insert a stuck-shape row
    // BEFORE we invoke the runner. runWithLock's finally block should
    // clear it as part of belt-and-suspenders.
    await db.run(INSERT.into(outbox.Messages).entries({
      target: 'queue',
      task: 'test-wedge-throw',
      status: 'processing',
      lastAttemptTimestamp: new Date().toISOString(),
    }));
    await runJobByName('test-wedge-throw');
    const rows = await db.run(
      SELECT.from(outbox.Messages).where({ target: 'queue', task: 'test-wedge-throw' })
    );
    expect(rows.length).toBe(0);
    _resetJobRegistry();
  });

  it('forceUnwedge: DELETEs a stuck row via the OData action', async () => {
    const jobName = 'test-wedge-force'; // synthetic; never collides with a real registered job
    // Register the job so forceUnwedge accepts it (the action validates
    // against JOB_REGISTRY).
    const { registerJob, _resetJobRegistry } =
      await import('../../srv/jobs/scheduler.js');
    registerJob({
      jobName,
      schedule: '0 0 1 1 *',
      ttlMs: 60000,
      description: 'hybrid — forceUnwedge test',
      fn: async () => {},
    });
    try {
      await db.run(INSERT.into(outbox.Messages).entries({
        target: 'queue',
        task: jobName,
        status: 'processing',
        lastAttemptTimestamp: new Date().toISOString(),
      }));
      const result = await srv.send({
        event: 'forceUnwedge',
        entity: 'JobControls',
        data: { jobName },
      });
      expect(result.cleared).toBe(true);
      const rows = await db.run(
        SELECT.from(outbox.Messages)
          .where({ target: 'queue', task: jobName, status: 'processing' })
      );
      expect(rows.length).toBe(0);
    } finally {
      _resetJobRegistry();
    }
  });

  it('forceUnwedge does NOT DELETE a pending (status=NULL) future-scheduled row', async () => {
    // Guards a class of bug that would break the entire cron: if
    // deleteStuckOutboxRow ever ships without the status='processing'
    // filter, an operator clicking Force-unwedge on a healthy job would
    // silently delete its next-scheduled-fire row.
    const jobName = 'test-wedge-pending';
    const { registerJob, _resetJobRegistry } =
      await import('../../srv/jobs/scheduler.js');
    registerJob({
      jobName,
      schedule: '0 0 1 1 *',
      ttlMs: 60000,
      description: 'hybrid — pending-row guard',
      fn: async () => {},
    });
    try {
      const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await db.run(INSERT.into(outbox.Messages).entries({
        target: 'queue',
        task: jobName,
        status: null, // pending, not yet picked up
        timestamp: futureIso,
      }));
      const result = await srv.send({
        event: 'forceUnwedge',
        entity: 'JobControls',
        data: { jobName },
      });
      expect(result.cleared).toBe(false);
      const rows = await db.run(
        SELECT.from(outbox.Messages).where({ target: 'queue', task: jobName })
      );
      // The pending row must still be there.
      expect(rows.length).toBe(1);
    } finally {
      _resetJobRegistry();
    }
  });
});
