// test/unit/srv/lib/scheduler-reaper.test.js
//
// #2782: unit tests for reapTombstonedOutboxRows — the durable fix for the
// blue-green cutover stall.
//
// Root cause (verified against @sap/cds@10.1 libx/queue/processing.js):
// a scheduled tick commits status='processing' in one tx (:222, set payload
// is ONLY { status }), then runs the handler, then DELETEs the row + inserts
// the next occurrence in a SEPARATE later tx (:333 + :356-371). A SIGTERM in
// that window (every blue-green stop) leaves the row stuck status='processing'
// with lastAttemptTimestamp STILL NULL — lastAttemptTimestamp is written only
// in the failed/retry branch (:426), never on claim or success. CAP's reclaim
// predicate is `(status is NULL OR lastAttemptTimestamp < ?)` (:57), so a
// processing row with NULL lastAttemptTimestamp matches NEITHER disjunct
// (NULL < ? is UNKNOWN) → never reclaimed → permanent tombstone, no successor
// row → the job silently drops with no error. The reaper deletes these stale
// processing rows so the next CronService.init() (.every().as() UPSERT) or the
// next healthy tick re-seeds a fresh future row.
//
// These tests follow the mock-db.run pattern from scheduler-wedge.test.js:
// real DELETE/SELECT coverage lives in the hybrid test (in-memory SQLite
// doesn't deploy cds.outbox).

import { describe, it, expect, vi, afterEach } from 'vitest';
import cds from '@sap/cds';

import { reapTombstonedOutboxRows, armSchedulerSelfHeal } from '../../../../srv/lib/scheduler-reaper.js';

// Fixed "now" far past any fixture timestamp so the 60-min stale floor fires.
const NOW = new Date('2026-10-14T18:00:00.000Z');
// A stale fire-time: ~2h before NOW, older than the 60-min floor.
const STALE_TS = '2026-10-14T16:00:00.000Z';
// A fresh fire-time: 5 min before NOW, inside the floor.
const FRESH_TS = '2026-10-14T17:55:00.000Z';

function mockOutbox(rows, { deleteResult = 1 } = {}) {
  Object.defineProperty(cds, 'entities', {
    get: () => () => ({ Messages: { name: 'cds.outbox.Messages' } }),
    configurable: true,
  });
  const runSpy = vi.fn(async (q) => {
    // Branch on the builder used: a DELETE query returns an affected count,
    // the SELECT returns the fixture rows.
    if (q && q.DELETE) return deleteResult;
    return rows;
  });
  const fakeDb = { run: runSpy };
  Object.defineProperty(cds, 'connect', {
    value: { to: vi.fn().mockResolvedValue(fakeDb) },
    configurable: true,
  });
  return runSpy;
}

describe('scheduler-reaper — reapTombstonedOutboxRows', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reaps a processing row with NULL lastAttemptTimestamp and a stale timestamp (the tombstone)', async () => {
    // This is the exact incident row: claimed (status=processing) then the
    // instance died before completion, so lastAttemptTimestamp stayed NULL.
    // CAP's lease can never reclaim it; the reaper must.
    const runSpy = mockOutbox([
      { ID: 'row-1', target: 'queue', task: 'metrics-rollup', status: 'processing', lastAttemptTimestamp: null, timestamp: STALE_TS },
    ]);
    const schedules = new Map([['metrics-rollup', '*/5 * * * *']]);
    const { inspected, reaped } = await reapTombstonedOutboxRows(schedules, NOW);
    expect(inspected).toBe(1);
    expect(reaped).toBe(1);
    // A DELETE keyed on the row ID must have been issued.
    const deleteCalls = runSpy.mock.calls.filter(([q]) => q && q.DELETE);
    expect(deleteCalls.length).toBe(1);
    expect(JSON.stringify(deleteCalls[0][0].DELETE)).toContain('row-1');
  });

  it('does NOT reap a pending row (status=NULL) — healthy future tick', async () => {
    const runSpy = mockOutbox([
      { ID: 'row-ok', target: 'queue', task: 'metrics-rollup', status: null, lastAttemptTimestamp: null, timestamp: STALE_TS },
    ]);
    const schedules = new Map([['metrics-rollup', '*/5 * * * *']]);
    const { inspected, reaped } = await reapTombstonedOutboxRows(schedules, NOW);
    expect(inspected).toBe(0);
    expect(reaped).toBe(0);
    expect(runSpy.mock.calls.filter(([q]) => q && q.DELETE).length).toBe(0);
  });

  it('does NOT reap a fresh processing row inside the 60-min floor (legitimate long run)', async () => {
    // extractConcepts can legitimately run ~40 min. A processing row only 5 min
    // old must survive — reaping it would kill a running job.
    const runSpy = mockOutbox([
      { ID: 'row-running', target: 'queue', task: 'extractConcepts', status: 'processing', lastAttemptTimestamp: null, timestamp: FRESH_TS },
    ]);
    const schedules = new Map([['extractConcepts', '13 2 * * *']]);
    const { inspected, reaped } = await reapTombstonedOutboxRows(schedules, NOW);
    expect(inspected).toBe(1);
    expect(reaped).toBe(0);
    expect(runSpy.mock.calls.filter(([q]) => q && q.DELETE).length).toBe(0);
  });

  it('reaps a stale processing row even when its job is unknown to the registry (unparseable cron → floor still applies)', async () => {
    // A job removed from the registry can still have a stuck row. With no cron
    // to parse, isRowStale falls back to the 60-min floor — a 2h-old row is
    // still reaped.
    const runSpy = mockOutbox([
      { ID: 'row-orphan', target: 'queue', task: 'retired-job', status: 'processing', lastAttemptTimestamp: null, timestamp: STALE_TS },
    ]);
    const schedules = new Map(); // empty — job not registered
    const { inspected, reaped } = await reapTombstonedOutboxRows(schedules, NOW);
    expect(inspected).toBe(1);
    expect(reaped).toBe(1);
  });

  it('tolerates uppercase column names (HANA casing)', async () => {
    const runSpy = mockOutbox([
      { ID: 'row-upper', TARGET: 'queue', TASK: 'metrics-rollup', STATUS: 'processing', LASTATTEMPTTIMESTAMP: null, TIMESTAMP: STALE_TS },
    ]);
    const schedules = new Map([['metrics-rollup', '*/5 * * * *']]);
    const { reaped } = await reapTombstonedOutboxRows(schedules, NOW);
    expect(reaped).toBe(1);
  });

  it('reaps multiple tombstones and leaves healthy rows in one pass', async () => {
    const runSpy = mockOutbox([
      { ID: 'a', target: 'queue', task: 'metrics-rollup', status: 'processing', lastAttemptTimestamp: null, timestamp: STALE_TS },
      { ID: 'b', target: 'queue', task: 'community-blogs-fetch', status: 'processing', lastAttemptTimestamp: null, timestamp: STALE_TS },
      { ID: 'c', target: 'queue', task: 'kg-pagerank', status: null, lastAttemptTimestamp: null, timestamp: STALE_TS },
      { ID: 'd', target: 'queue', task: 'extractConcepts', status: 'processing', lastAttemptTimestamp: null, timestamp: FRESH_TS },
    ]);
    const schedules = new Map([
      ['metrics-rollup', '*/5 * * * *'],
      ['community-blogs-fetch', '17,47 * * * *'],
      ['kg-pagerank', '53 3 * * *'],
      ['extractConcepts', '13 2 * * *'],
    ]);
    const { inspected, reaped } = await reapTombstonedOutboxRows(schedules, NOW);
    // inspected = processing rows (a, b, d) = 3; c is pending so not inspected.
    expect(inspected).toBe(3);
    // reaped = stale processing (a, b) = 2; d is fresh.
    expect(reaped).toBe(2);
    const deletedIds = runSpy.mock.calls
      .filter(([q]) => q && q.DELETE)
      .map(([q]) => JSON.stringify(q.DELETE));
    expect(deletedIds.some(s => s.includes('"a"'))).toBe(true);
    expect(deletedIds.some(s => s.includes('"b"'))).toBe(true);
    expect(deletedIds.some(s => s.includes('"c"'))).toBe(false);
    expect(deletedIds.some(s => s.includes('"d"'))).toBe(false);
  });

  it('does NOT reap a non-queue outbox row (persistent-outbox emitted event sharing the table)', async () => {
    // cds.outbox.Messages is shared: the queue scheduler uses target='queue',
    // but persistent-outbox emitted events (ANS alerts, cds.emit) also land
    // here with a DIFFERENT target. A slow/dead-instance event row can sit at
    // status='processing' with a populated task past the floor — the reaper
    // must NOT delete it (that would silently drop an event the outbox is still
    // responsible for retrying). Scope the reaper to target='queue' only.
    const runSpy = mockOutbox([
      { ID: 'evt-1', target: 'TutorialProgressService', task: 'some/#event', status: 'processing', lastAttemptTimestamp: null, timestamp: STALE_TS },
    ]);
    const schedules = new Map();
    const { inspected, reaped } = await reapTombstonedOutboxRows(schedules, NOW);
    expect(inspected).toBe(0);
    expect(reaped).toBe(0);
    expect(runSpy.mock.calls.filter(([q]) => q && q.DELETE).length).toBe(0);
  });

  it('fail-open: returns zeros when cds.outbox.Messages is missing', async () => {
    Object.defineProperty(cds, 'entities', { get: () => () => ({}), configurable: true });
    const { inspected, reaped } = await reapTombstonedOutboxRows(new Map(), NOW);
    expect(inspected).toBe(0);
    expect(reaped).toBe(0);
  });

  it('fail-open: returns zeros when db.run throws', async () => {
    Object.defineProperty(cds, 'entities', {
      get: () => () => ({ Messages: { name: 'cds.outbox.Messages' } }),
      configurable: true,
    });
    const fakeDb = { run: vi.fn().mockRejectedValue(new Error('DB down')) };
    Object.defineProperty(cds, 'connect', { value: { to: vi.fn().mockResolvedValue(fakeDb) }, configurable: true });
    const { inspected, reaped } = await reapTombstonedOutboxRows(new Map(), NOW);
    expect(inspected).toBe(0);
    expect(reaped).toBe(0);
  });

  it('a DELETE that throws does not abort the whole pass (per-row fail-open)', async () => {
    Object.defineProperty(cds, 'entities', {
      get: () => () => ({ Messages: { name: 'cds.outbox.Messages' } }),
      configurable: true,
    });
    const rows = [
      { ID: 'x', target: 'queue', task: 'metrics-rollup', status: 'processing', lastAttemptTimestamp: null, timestamp: STALE_TS },
      { ID: 'y', target: 'queue', task: 'community-blogs-fetch', status: 'processing', lastAttemptTimestamp: null, timestamp: STALE_TS },
    ];
    let deleteCount = 0;
    const run = vi.fn(async (q) => {
      if (q && q.DELETE) {
        deleteCount++;
        if (deleteCount === 1) throw new Error('transient delete fault');
        return 1;
      }
      return rows;
    });
    Object.defineProperty(cds, 'connect', { value: { to: vi.fn().mockResolvedValue({ run }) }, configurable: true });
    const schedules = new Map([
      ['metrics-rollup', '*/5 * * * *'],
      ['community-blogs-fetch', '17,47 * * * *'],
    ]);
    const { inspected, reaped } = await reapTombstonedOutboxRows(schedules, NOW);
    expect(inspected).toBe(2);
    // First delete threw; second succeeded → 1 reaped, pass did not abort.
    expect(reaped).toBe(1);
  });
});

describe('scheduler-reaper — armSchedulerSelfHeal (periodic timer wiring)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const enabledEnv = { CF_INSTANCE_INDEX: '0', SCHEDULER_HEALTHCHECK_ENABLED: 'true' };

  it('returns null and arms nothing when disabled (no CF, not forced on)', () => {
    const setIntervalFn = vi.fn();
    const handle = armSchedulerSelfHeal({ env: {}, setIntervalFn, jobSchedules: new Map() });
    expect(handle).toBeNull();
    expect(setIntervalFn).not.toHaveBeenCalled();
  });

  it('arms a single interval timer when enabled and unrefs it', () => {
    const unref = vi.fn();
    const setIntervalFn = vi.fn().mockReturnValue({ unref });
    armSchedulerSelfHeal({
      env: enabledEnv,
      setIntervalFn,
      jobSchedules: new Map(),
      reap: vi.fn().mockResolvedValue({ inspected: 0, reaped: 0 }),
      loadRows: async () => [],
      raiseAlert: vi.fn(),
    });
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('each tick runs the reaper against the supplied jobSchedules', async () => {
    let tickFn;
    const setIntervalFn = vi.fn().mockImplementation((fn) => { tickFn = fn; return { unref() {} }; });
    const reap = vi.fn().mockResolvedValue({ inspected: 1, reaped: 1 });
    const schedules = new Map([['metrics-rollup', '*/5 * * * *']]);
    armSchedulerSelfHeal({
      env: enabledEnv, setIntervalFn, jobSchedules: schedules,
      reap, loadRows: async () => [], raiseAlert: vi.fn(),
    });
    await tickFn();
    expect(reap).toHaveBeenCalledTimes(1);
    expect(reap.mock.calls[0][0]).toBe(schedules);
  });

  it('raises SchedulerStallDetected ALERT (alert-only, NO exit) when both canaries are stale', async () => {
    let tickFn;
    const setIntervalFn = vi.fn().mockImplementation((fn) => { tickFn = fn; return { unref() {} }; });
    const stale = new Date(Date.now() - 30 * 60_000).toISOString();
    const raiseAlert = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    armSchedulerSelfHeal({
      env: enabledEnv, setIntervalFn, jobSchedules: new Map(),
      reap: vi.fn().mockResolvedValue({ inspected: 0, reaped: 0 }),
      // Both canaries stale.
      loadRows: async () => [
        { jobName: 'metrics-rollup', lastSuccessAt: stale },
        { jobName: 'kg-ondemand-drain', lastSuccessAt: stale },
      ],
      raiseAlert, exit,
    });
    await tickFn();
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    expect(raiseAlert.mock.calls[0][0]).toMatchObject({
      eventType: 'SchedulerStallDetected',
      category: 'ALERT',
    });
    // The whole point of #2782: no process.exit.
    expect(exit).not.toHaveBeenCalled();
  });

  it('does NOT alert when the queue is healthy (a canary is fresh)', async () => {
    let tickFn;
    const setIntervalFn = vi.fn().mockImplementation((fn) => { tickFn = fn; return { unref() {} }; });
    const stale = new Date(Date.now() - 30 * 60_000).toISOString();
    const fresh = new Date(Date.now() - 60_000).toISOString();
    const raiseAlert = vi.fn();
    armSchedulerSelfHeal({
      env: enabledEnv, setIntervalFn, jobSchedules: new Map(),
      reap: vi.fn().mockResolvedValue({ inspected: 0, reaped: 0 }),
      loadRows: async () => [
        { jobName: 'metrics-rollup', lastSuccessAt: fresh },
        { jobName: 'kg-ondemand-drain', lastSuccessAt: stale },
      ],
      raiseAlert,
    });
    await tickFn();
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it('a tick where the reaper throws still runs the canary check (fail-open, timer survives)', async () => {
    let tickFn;
    const setIntervalFn = vi.fn().mockImplementation((fn) => { tickFn = fn; return { unref() {} }; });
    const stale = new Date(Date.now() - 30 * 60_000).toISOString();
    const raiseAlert = vi.fn().mockResolvedValue(undefined);
    armSchedulerSelfHeal({
      env: enabledEnv, setIntervalFn, jobSchedules: new Map(),
      reap: vi.fn().mockRejectedValue(new Error('reap blew up')),
      loadRows: async () => [
        { jobName: 'metrics-rollup', lastSuccessAt: stale },
        { jobName: 'kg-ondemand-drain', lastSuccessAt: stale },
      ],
      raiseAlert,
    });
    // Must not throw out of the tick.
    await expect(tickFn()).resolves.toBeUndefined();
    expect(raiseAlert).toHaveBeenCalledTimes(1);
  });
});
