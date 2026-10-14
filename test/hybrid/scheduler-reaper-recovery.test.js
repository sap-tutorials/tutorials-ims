// test/hybrid/scheduler-reaper-recovery.test.js
//
// #2782: end-to-end verification of the outbox tombstone reaper against real
// HANA via cds bind. The unit tests (test/unit/srv/lib/scheduler-reaper.test.js)
// mock db.run; this proves the real CDS QL SELECT/DELETE round-trips against
// cds.outbox.Messages, including the exact tombstone shape CAP leaves on a
// blue-green cutover death: status='processing', lastAttemptTimestamp=NULL.
//
// Gated on ALLOW_HYBRID_WRITES=1 (same pattern as the sibling wedge hybrid test).

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import cds from '@sap/cds';

import { reapTombstonedOutboxRows } from '../../srv/lib/scheduler-reaper.js';

const HYBRID = process.env.ALLOW_HYBRID_WRITES === '1';
const maybeDescribe = HYBRID ? describe : describe.skip;

maybeDescribe('scheduler tombstone reaper recovery (hybrid)', () => {
  let db;
  let outbox;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    outbox = cds.entities('cds.outbox');
    if (!outbox?.Messages) throw new Error('cds.outbox.Messages missing — CAP version mismatch');
  });

  afterAll(async () => { await cds.disconnect(); });

  afterEach(async () => {
    await db.run(
      DELETE.from(outbox.Messages).where({ target: 'queue', task: { like: 'test-reaper-%' } })
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

  it('does NOT reap a fresh processing row inside the 60-min floor (legitimate long run)', async () => {
    const jobName = 'test-reaper-running';
    const freshIso = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    await db.run(INSERT.into(outbox.Messages).entries({
      target: 'queue',
      task: jobName,
      status: 'processing',
      timestamp: freshIso,
    }));

    const schedules = new Map([[jobName, '13 2 * * *']]);
    await reapTombstonedOutboxRows(schedules);

    const rows = await db.run(
      SELECT.from(outbox.Messages).where({ target: 'queue', task: jobName })
    );
    expect(rows.length).toBe(1); // still running, not reaped
  });
});
