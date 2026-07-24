// test/hybrid/pipeline-log-reconciler.test.js
//
// #1293: end-to-end verification against real HANA via cds bind.
//
// Two scenarios:
//   1. Boot reconciler — reconcileOrphanedRunningJobs() flips a
//      SCHEDULED_JOB RUNNING row older than the 60-min floor to FAILED,
//      and leaves a fresh (<floor) RUNNING row untouched.
//   2. forceClose action — the OData action closes a RUNNING row for a
//      named job with no age gate.
//
// Gated on ALLOW_HYBRID_WRITES=1 (same pattern as sibling hybrid tests).
// Synthetic rows use a 'test-reconcile-%' jobName / ID prefix so cleanup
// never touches real production rows.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import cds from '@sap/cds';

const HYBRID = process.env.ALLOW_HYBRID_WRITES === '1';
const maybeDescribe = HYBRID ? describe : describe.skip;
const NS = 'com.sap.developers.ims';
const HOUR = 60 * 60 * 1000;

maybeDescribe('pipeline-log reconciler (hybrid)', () => {
  let srv;
  let db;
  let PipelineLog;
  let reconcileOrphanedRunningJobs;

  beforeAll(async () => {
    srv = await cds.connect.to('AdminService');
    db = await cds.connect.to('db');
    PipelineLog = cds.entities(NS).PipelineLog;
    ({ reconcileOrphanedRunningJobs } = await import('../../srv/lib/pipeline-log-reconciler.js'));
  });

  afterAll(async () => { await cds.disconnect(); });

  afterEach(async () => {
    // Scope by the synthetic ID prefix so we never touch real rows.
    await db.run(DELETE.from(PipelineLog).where({ ID: { like: 'test-reconcile-%' } }));
  });

  async function insertRunningRow({ id, jobName, ageMs, pipelineType = 'SCHEDULED_JOB' }) {
    await db.run(INSERT.into(PipelineLog).entries({
      ID: id,
      pipelineType,
      status: 'RUNNING',
      startedAt: new Date(Date.now() - ageMs).toISOString(),
      initiator: 'system',
      metadata: jobName ? JSON.stringify({ jobName }) : null,
    }));
  }

  it('boot reconciler closes an old RUNNING row, leaves a fresh one', async () => {
    await insertRunningRow({ id: 'test-reconcile-old', jobName: 'test-reconcile-jjourneys', ageMs: 2 * HOUR });
    await insertRunningRow({ id: 'test-reconcile-fresh', jobName: 'test-reconcile-fresh-job', ageMs: 5 * 60 * 1000 });

    await reconcileOrphanedRunningJobs();

    const oldRow = await db.run(SELECT.one.from(PipelineLog).where({ ID: 'test-reconcile-old' }));
    const freshRow = await db.run(SELECT.one.from(PipelineLog).where({ ID: 'test-reconcile-fresh' }));
    expect(oldRow.status).toBe('FAILED');
    expect(oldRow.finishedAt).toBeTruthy();
    expect(freshRow.status).toBe('RUNNING');
  });

  it('forceClose action closes a RUNNING row for a registered job (no age gate)', async () => {
    const jobName = 'test-reconcile-force';
    const { registerJob, _resetJobRegistry } = await import('../../srv/jobs/scheduler.js');
    registerJob({ jobName, schedule: '0 0 1 1 *', ttlMs: 60000, description: 'hybrid — forceClose test', fn: async () => {} });
    try {
      // 2 min old — younger than the 60-min floor; only forceClose closes it.
      await insertRunningRow({ id: 'test-reconcile-force-row', jobName, ageMs: 2 * 60 * 1000 });
      const result = await srv.send({ event: 'forceClose', entity: 'JobControls', data: { jobName } });
      expect(result.closed).toBe(1);
      const row = await db.run(SELECT.one.from(PipelineLog).where({ ID: 'test-reconcile-force-row' }));
      expect(row.status).toBe('FAILED');
      expect(row.finishedAt).toBeTruthy();
    } finally {
      _resetJobRegistry();
    }
  });
});
