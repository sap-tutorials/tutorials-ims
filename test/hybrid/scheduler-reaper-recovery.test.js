// test/hybrid/scheduler-reaper-recovery.test.js
//
// #2782: end-to-end verification of the outbox tombstone reaper against real
// HANA via cds bind. The unit tests (test/unit/srv/lib/scheduler-reaper.test.js)
// mock db.run; this proves the real CDS QL SELECT/DELETE round-trips against
// cds.outbox.Messages, including the exact tombstone shape CAP leaves on a
// blue-green cutover death: status='processing', lastAttemptTimestamp=NULL.
//
// #2814: also covers the PipelineLog cross-check (HANA-HA-failover fast path) —
// a fresh processing row is protected IFF a real RUNNING SCHEDULED_JOB
// PipelineLog row exists for its job, and fast-path-reaped when none does.
//
// Gated on ALLOW_HYBRID_WRITES=1 (same pattern as the sibling wedge hybrid test).

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import cds from '@sap/cds';

import { reapTombstonedOutboxRows, reseedMissingSuccessorRows } from '../../srv/lib/scheduler-reaper.js';

const HYBRID = process.env.ALLOW_HYBRID_WRITES === '1';
const maybeDescribe = HYBRID ? describe : describe.skip;

maybeDescribe('scheduler tombstone reaper recovery (hybrid)', () => {
  let db;
  let outbox;
  let PipelineLog;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    outbox = cds.entities('cds.outbox');
    if (!outbox?.Messages) throw new Error('cds.outbox.Messages missing — CAP version mismatch');
    ({ PipelineLog } = cds.entities('com.sap.developers.ims'));
    if (!PipelineLog) throw new Error('PipelineLog missing — model mismatch');
  });

  afterAll(async () => { await cds.disconnect(); });

  afterEach(async () => {
    await db.run(
      DELETE.from(outbox.Messages).where({ target: 'queue', task: { like: 'test-reaper-%' } })
    );
    // #2814: clean any RUNNING PipelineLog rows this suite inserted. jobName
    // lives in the metadata JSON (no column), so match on the metadata text —
    // our sentinel jobNames all start with 'test-reaper-'.
    await db.run(
      DELETE.from(PipelineLog).where({ pipelineType: 'SCHEDULED_JOB', metadata: { like: '%test-reaper-%' } })
    );
  });

  it('reaps a NULL-lastAttemptTimestamp processing row with a stale fire-time (the cutover tombstone)', async () => {
    const jobName = 'test-reaper-tombstone';
    // Exactly the shape CAP leaves when SIGTERM lands between claim and
    // completion: status='processing', NO lastAttemptTimestamp, old timestamp.
    const staleIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    await db.run(INSERT.into(outbox.Messages).entries({
      target: 'queue',
      task: jobName,
      status: 'processing',
      timestamp: staleIso,
      // lastAttemptTimestamp intentionally omitted → NULL
    }));

    const schedules = new Map([[jobName, '*/5 * * * *']]);
    const { inspected, reaped } = await reapTombstonedOutboxRows(schedules);
    expect(inspected).toBeGreaterThanOrEqual(1);
    expect(reaped).toBeGreaterThanOrEqual(1);

    const rows = await db.run(
      SELECT.from(outbox.Messages).where({ target: 'queue', task: jobName })
    );
    expect(rows.length).toBe(0);
  });

  it('does NOT reap a pending (status=NULL) future row', async () => {
    const jobName = 'test-reaper-pending';
    const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await db.run(INSERT.into(outbox.Messages).entries({
      target: 'queue',
      task: jobName,
      status: null,
      timestamp: futureIso,
    }));

    const schedules = new Map([[jobName, '0 0 1 1 *']]);
    await reapTombstonedOutboxRows(schedules);

    const rows = await db.run(
      SELECT.from(outbox.Messages).where({ target: 'queue', task: jobName })
    );
    expect(rows.length).toBe(1); // untouched
  });

  it('does NOT reap a fresh processing row inside the 60-min floor when its job has a RUNNING PipelineLog row (legitimate long run)', async () => {
    const jobName = 'test-reaper-running';
    const freshIso = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    await db.run(INSERT.into(outbox.Messages).entries({
      target: 'queue',
      task: jobName,
      status: 'processing',
      timestamp: freshIso,
    }));
    // #2814: a REAL RUNNING SCHEDULED_JOB PipelineLog row makes the reaper treat
    // the job as genuinely in-flight → the fresh row must survive.
    await db.run(INSERT.into(PipelineLog).entries({
      pipelineType: 'SCHEDULED_JOB',
      status: 'RUNNING',
      startedAt: freshIso,
      metadata: JSON.stringify({ jobName }),
    }));

    const schedules = new Map([[jobName, '13 2 * * *']]);
    await reapTombstonedOutboxRows(schedules);

    const rows = await db.run(
      SELECT.from(outbox.Messages).where({ target: 'queue', task: jobName })
    );
    expect(rows.length).toBe(1); // still running, not reaped
  });

  it('#2814 fast path: reaps a fresh processing row (daily cron, inside floor) when its job has NO RUNNING PipelineLog row', async () => {
    const jobName = 'test-reaper-failover';
    // HANA-HA-failover tombstone: claimed then DB connection dropped, no app
    // restart. Daily cron so isRowStale rule (a) doesn't fire — only the #2814
    // PipelineLog cross-check can reap it. No RUNNING PipelineLog row exists →
    // not in-flight → reaped regardless of the 60-min floor.
    const freshIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await db.run(INSERT.into(outbox.Messages).entries({
      target: 'queue',
      task: jobName,
      status: 'processing',
      timestamp: freshIso,
    }));

    const schedules = new Map([[jobName, '13 2 * * *']]);
    const { reaped } = await reapTombstonedOutboxRows(schedules);
    expect(reaped).toBeGreaterThanOrEqual(1);

    const rows = await db.run(
      SELECT.from(outbox.Messages).where({ target: 'queue', task: jobName })
    );
    expect(rows.length).toBe(0); // fast-path reaped
  });

  // ─── #2827: missing-successor-row re-seed (real cds.outbox.Messages read) ───

  it('#2827 re-seeds a registered job that has NO queue row, and leaves one that does', async () => {
    // The crash-mid-tick stall: `missing` was consumed-but-not-reinserted, so it
    // has ZERO target='queue' rows. `present` still has its pending future row.
    // reseedMissingSuccessorRows must call reseedJob exactly for `missing`.
    const missing = 'test-reaper-missing';
    const present = 'test-reaper-present';
    const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await db.run(INSERT.into(outbox.Messages).entries({
      target: 'queue', task: present, status: null, timestamp: futureIso,
    }));
    // `missing` deliberately gets NO row inserted.

    const schedules = new Map([[missing, '*/5 * * * *'], [present, '*/2 * * * *']]);
    const reseedJob = vi.fn().mockResolvedValue(undefined);
    const { checked, reseeded } = await reseedMissingSuccessorRows(schedules, reseedJob);

    expect(checked).toBe(2);
    expect(reseeded).toBe(1);
    expect(reseedJob).toHaveBeenCalledTimes(1);
    expect(reseedJob).toHaveBeenCalledWith(missing, '*/5 * * * *');
    expect(reseedJob).not.toHaveBeenCalledWith(present, expect.anything());
  });

  it('#2827 does NOT re-seed a job whose only row is a processing tombstone (reaper territory)', async () => {
    // A 'processing' row still counts as presence — re-seeding here would create
    // a duplicate concurrent tick. The reaper, not the re-seeder, clears it.
    const jobName = 'test-reaper-proc-only';
    const staleIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await db.run(INSERT.into(outbox.Messages).entries({
      target: 'queue', task: jobName, status: 'processing', timestamp: staleIso,
    }));

    const schedules = new Map([[jobName, '*/5 * * * *']]);
    const reseedJob = vi.fn().mockResolvedValue(undefined);
    const { reseeded } = await reseedMissingSuccessorRows(schedules, reseedJob);

    expect(reseeded).toBe(0);
    expect(reseedJob).not.toHaveBeenCalled();
  });
});
