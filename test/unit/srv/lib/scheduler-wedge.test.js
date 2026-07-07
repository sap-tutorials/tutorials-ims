// test/unit/srv/lib/scheduler-wedge.test.js
//
// #1021: unit tests for scheduler-wedge helpers.
//
// 2026-07-07 refresh: prior tests asserted `target = 'cron.<jobName>'`
// on outbox rows — that was wrong. Real CAP 10 semantics
// (verified against DEV HANA, and against
// node_modules/@sap/cds/libx/queue/consts.js which exports
// QUEUE = 'queue'): target='queue' for every scheduled task, and the
// job name lives in the `task` column. Filtering on the wrong column
// is why the shipped wedge detector always returned an empty Map,
// making the wedge badge + Force-unwedge button invisible in
// production. These tests now enforce the corrected filter.
//
// Real DELETE/SELECT coverage against cds.outbox.Messages lives in the
// hybrid test (test/hybrid/scheduler-wedge-recovery.test.js) —
// in-memory SQLite doesn't deploy cds.outbox by default.
//
// These unit tests exercise the fail-open branches (missing entity,
// db.run() throws) and the pure staleness logic.

import { describe, it, expect, vi, afterEach } from 'vitest';
import cds from '@sap/cds';

import {
  deleteStuckOutboxRow,
  loadStuckOutboxTargets,
  isRowStale,
  _STALE_FLOOR_MS_FOR_TESTS,
} from '../../../../srv/lib/scheduler-wedge.js';

describe('scheduler-wedge — fail-open branches', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('deleteStuckOutboxRow returns false when cds.outbox.Messages is missing', async () => {
    Object.defineProperty(cds, 'entities', {
      get: () => () => ({}),
      configurable: true,
    });
    const result = await deleteStuckOutboxRow('any-job');
    expect(result).toBe(false);
  });

  it('deleteStuckOutboxRow returns false when db.run throws', async () => {
    Object.defineProperty(cds, 'entities', {
      get: () => () => ({
        Messages: { name: 'cds.outbox.Messages' },
      }),
      configurable: true,
    });
    const fakeDb = { run: vi.fn().mockRejectedValue(new Error('DB down')) };
    Object.defineProperty(cds, 'connect', {
      value: { to: vi.fn().mockResolvedValue(fakeDb) },
      configurable: true,
    });
    const result = await deleteStuckOutboxRow('any-job');
    expect(result).toBe(false);
  });

  it('deleteStuckOutboxRow filters by task + status=processing (not by target)', async () => {
    // Guards the real bug that shipped: the old impl filtered on
    // { target: 'cron.<jobName>' }, which matched nothing in production
    // because real CAP writes target='queue'. This test locks in that
    // the corrected filter uses the `task` column and requires
    // status='processing' so a pending (status=NULL) row is never
    // accidentally deleted.
    Object.defineProperty(cds, 'entities', {
      get: () => () => ({
        Messages: { name: 'cds.outbox.Messages' },
      }),
      configurable: true,
    });
    const runSpy = vi.fn().mockResolvedValue(1);
    const fakeDb = { run: runSpy };
    Object.defineProperty(cds, 'connect', {
      value: { to: vi.fn().mockResolvedValue(fakeDb) },
      configurable: true,
    });
    const result = await deleteStuckOutboxRow('extractConcepts');
    expect(result).toBe(true);
    expect(runSpy).toHaveBeenCalledOnce();
    // Inspect the CQL passed to db.run. CAP DELETE builder returns an
    // object whose serialized form we can introspect via .DELETE.
    const arg = runSpy.mock.calls[0][0];
    // Depending on CAP version the CQN is on .DELETE or the plain object;
    // check both shapes tolerantly.
    const cqn = arg?.DELETE ?? arg;
    const json = JSON.stringify(cqn);
    expect(json).toContain('"task"');
    expect(json).toContain('extractConcepts');
    expect(json).toContain('processing');
    // The old buggy filter would have contained 'cron.extractConcepts'
    // as the target value; assert it does NOT.
    expect(json).not.toContain('cron.extractConcepts');
  });

  it('loadStuckOutboxTargets returns empty Map when cds.outbox.Messages is missing', async () => {
    Object.defineProperty(cds, 'entities', {
      get: () => () => ({}),
      configurable: true,
    });
    const result = await loadStuckOutboxTargets();
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('loadStuckOutboxTargets returns empty Map when db.run throws', async () => {
    Object.defineProperty(cds, 'entities', {
      get: () => () => ({
        Messages: { name: 'cds.outbox.Messages' },
      }),
      configurable: true,
    });
    const fakeDb = { run: vi.fn().mockRejectedValue(new Error('DB down')) };
    Object.defineProperty(cds, 'connect', {
      value: { to: vi.fn().mockResolvedValue(fakeDb) },
      configurable: true,
    });
    const result = await loadStuckOutboxTargets();
    expect(result.size).toBe(0);
  });

  it('loadStuckOutboxTargets extracts jobName from the `task` column, requires status=processing', async () => {
    Object.defineProperty(cds, 'entities', {
      get: () => () => ({
        Messages: { name: 'cds.outbox.Messages' },
      }),
      configurable: true,
    });
    const ts1 = '2026-07-06T12:07:00.000Z';
    const ts2 = '2026-07-06T14:05:00.000Z';
    const fakeDb = { run: vi.fn().mockResolvedValue([
      // Real stuck row shape: target='queue', status='processing', task=jobName.
      { target: 'queue', task: 'extractConcepts', status: 'processing', lastAttemptTimestamp: ts1 },
      // Pending future firing — status is NULL. MUST NOT be returned.
      { target: 'queue', task: 'kg-pagerank',     status: null,         lastAttemptTimestamp: null },
      // Another stuck row.
      { target: 'queue', task: 'another-job',     status: 'processing', lastAttemptTimestamp: ts2 },
      // Rare: status looks right but task is empty — skip.
      { target: 'queue', task: '',                status: 'processing', lastAttemptTimestamp: ts1 },
    ])};
    Object.defineProperty(cds, 'connect', {
      value: { to: vi.fn().mockResolvedValue(fakeDb) },
      configurable: true,
    });
    const result = await loadStuckOutboxTargets();
    expect(result.size).toBe(2);
    expect(result.has('extractConcepts')).toBe(true);
    expect(result.get('extractConcepts')).toBeInstanceOf(Date);
    expect(result.get('extractConcepts').toISOString()).toBe(ts1);
    expect(result.has('another-job')).toBe(true);
    expect(result.get('another-job')).toBeInstanceOf(Date);
    expect(result.get('another-job').toISOString()).toBe(ts2);
    // Explicitly guard the false-positive class: pending rows must NEVER
    // appear. Would break the cron if their outbox row was subsequently
    // DELETE'd on operator "Force unwedge".
    expect(result.has('kg-pagerank')).toBe(false);
  });

  it('loadStuckOutboxTargets tolerates uppercase column names (HANA casing)', async () => {
    Object.defineProperty(cds, 'entities', {
      get: () => () => ({
        Messages: { name: 'cds.outbox.Messages' },
      }),
      configurable: true,
    });
    const ts = '2026-07-06T11:00:00.000Z';
    const fakeDb = { run: vi.fn().mockResolvedValue([
      { TARGET: 'queue', TASK: 'uppercase-job', STATUS: 'processing', LASTATTEMPTTIMESTAMP: ts },
    ])};
    Object.defineProperty(cds, 'connect', {
      value: { to: vi.fn().mockResolvedValue(fakeDb) },
      configurable: true,
    });
    const result = await loadStuckOutboxTargets();
    expect(result.has('uppercase-job')).toBe(true);
    expect(result.get('uppercase-job')).toBeInstanceOf(Date);
  });
});

describe('scheduler-wedge — isRowStale', () => {
  it('returns false when now is inside the same tick window as rowStartedAt (healthy)', () => {
    // Cron fires at :07 every hour. Row started at 12:07; now is 12:30 — still
    // within the same tick window (next firing is 13:07). Not stale.
    const rowStartedAt = new Date('2026-07-06T12:07:00Z');
    const now = new Date('2026-07-06T12:30:00Z');
    expect(isRowStale('7 * * * *', rowStartedAt, now)).toBe(false);
  });

  it('returns true when now has passed the next firing after rowStartedAt (rule a)', () => {
    // Cron fires at :07 every hour. Row started at 12:07; next firing was 13:07,
    // but now is 14:08 — that firing has come and gone. The row is stale/wedged.
    const rowStartedAt = new Date('2026-07-06T12:07:00Z');
    const now = new Date('2026-07-06T14:08:00Z');
    expect(isRowStale('7 * * * *', rowStartedAt, now)).toBe(true);
  });

  it('returns false on cron parse failure when under the hard floor (fail-open)', () => {
    // Parse fails → rule (a) can't decide. And ageMs is 0, so rule (b) is false.
    expect(isRowStale('not a cron', new Date(), new Date())).toBe(false);
  });

  it('returns true on cron parse failure when age exceeds the hard floor', () => {
    // Rule (b) still fires even if the cron expression is garbage — protects
    // against a wedge hiding forever behind an unparseable schedule.
    const rowStartedAt = new Date('2026-07-06T12:00:00Z');
    const now = new Date(rowStartedAt.getTime() + _STALE_FLOOR_MS_FOR_TESTS + 1000);
    expect(isRowStale('not a cron', rowStartedAt, now)).toBe(true);
  });

  it('returns true for a daily job wedged for > 60 min even though next fire is 23h away (rule b)', () => {
    // extractConcepts runs at 02:13 UTC daily. Row started at 02:13; it's now
    // 03:14 — still ~23 hours before the NEXT firing per rule (a), but the
    // row has been in flight for 61 minutes. Rule (b) surfaces the wedge
    // now instead of ~23h from now. This is the concrete scenario that
    // motivated the 2026-07-07 refresh.
    const rowStartedAt = new Date('2026-07-07T02:13:00Z');
    const now = new Date('2026-07-07T03:14:00Z'); // 61 min later
    expect(isRowStale('13 2 * * *', rowStartedAt, now)).toBe(true);
  });

  it('returns false for a daily job wedged for < 60 min (still within floor, next fire far off)', () => {
    // Same shape as above but only 30 min in — neither rule triggers.
    // Legitimate long-running jobs (extractConcepts ~40 min) must not
    // be flagged as wedged during their normal run.
    const rowStartedAt = new Date('2026-07-07T02:13:00Z');
    const now = new Date('2026-07-07T02:43:00Z'); // 30 min later
    expect(isRowStale('13 2 * * *', rowStartedAt, now)).toBe(false);
  });

  it('returns true right at the hard-floor boundary', () => {
    const rowStartedAt = new Date('2026-07-07T02:13:00Z');
    const now = new Date(rowStartedAt.getTime() + _STALE_FLOOR_MS_FOR_TESTS);
    expect(isRowStale('13 2 * * *', rowStartedAt, now)).toBe(true);
  });

  it('STALE_FLOOR_MS is 60 minutes (regression guard)', () => {
    // If someone widens this to hours+, they must update the comment
    // and re-verify against the longest legitimate job runtime.
    expect(_STALE_FLOOR_MS_FOR_TESTS).toBe(60 * 60 * 1000);
  });
});
