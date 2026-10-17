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

function mockOutbox(rows, { deleteResult = 1, pipelineRows = [], pipelineThrows = false, noPipelineEntity = false } = {}) {
  Object.defineProperty(cds, 'entities', {
    get: () => (ns) => {
      if (ns === 'com.sap.developers.ims') {
        return noPipelineEntity ? {} : { PipelineLog: { name: 'com.sap.developers.ims.PipelineLog' } };
      }
      return { Messages: { name: 'cds.outbox.Messages' } };
    },
    configurable: true,
  });
  const runSpy = vi.fn(async (q) => {
    // db.run branches on the builder: DELETE → affected count; the outbox
    // SELECT builder → the fixture rows. (The outbox SELECT is the only query
    // that reaches db.run; the PipelineLog SELECT is awaited directly via the
    // fluent global stubbed below.)
    if (q && q.DELETE) return deleteResult;
    return rows;
  });
  Object.defineProperty(cds, 'connect', {
    value: { to: vi.fn().mockResolvedValue({ run: runSpy }) },
    configurable: true,
  });

  // #2814: loadRunningScheduledJobNames awaits the fluent global
  // SELECT.from(PipelineLog).columns(...).where(...) directly (a thenable),
  // NOT db.run. Stub the global SELECT so that chain resolves to pipelineRows.
  // The outbox read still goes through db.run(SELECT.from(outbox.Messages)) —
  // db.run ignores the builder shape and returns `rows`, so the outbox builder
  // never needs to be awaited.
  _savedSelect = Object.getOwnPropertyDescriptor(globalThis, 'SELECT');
  Object.defineProperty(globalThis, 'SELECT', {
    configurable: true,
    writable: true,
    value: {
      from() {
        return {
          columns() { return this; },
          where() { return this; },
          then(resolve, reject) {
            const p = pipelineThrows
              ? Promise.reject(new Error('PipelineLog DB down'))
              : Promise.resolve(pipelineRows);
            return p.then(resolve, reject);
          },
        };
      },
    },
  });
  return runSpy;
}

let _savedSelect;

describe('scheduler-reaper — reapTombstonedOutboxRows', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (_savedSelect !== undefined) {
      if (_savedSelect) Object.defineProperty(globalThis, 'SELECT', _savedSelect);
      else delete globalThis.SELECT;
      _savedSelect = undefined;
    }
  });

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

  it('does NOT reap a fresh processing row inside the 60-min floor WHEN its job has a RUNNING PipelineLog row (legitimate long run)', async () => {
    // extractConcepts can legitimately run ~40 min. A processing row only 5 min
    // old whose job IS running (RUNNING SCHEDULED_JOB PipelineLog row present)
    // must survive — reaping it would kill a running job. #2814: the RUNNING
    // PipelineLog row is the authoritative in-flight signal.
    const runSpy = mockOutbox(
      [
        { ID: 'row-running', target: 'queue', task: 'extractConcepts', status: 'processing', lastAttemptTimestamp: null, timestamp: FRESH_TS },
      ],
      { pipelineRows: [{ metadata: JSON.stringify({ jobName: 'extractConcepts' }) }] },
    );
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
    const runSpy = mockOutbox(
      [
        { ID: 'a', target: 'queue', task: 'metrics-rollup', status: 'processing', lastAttemptTimestamp: null, timestamp: STALE_TS },
        { ID: 'b', target: 'queue', task: 'community-blogs-fetch', status: 'processing', lastAttemptTimestamp: null, timestamp: STALE_TS },
        { ID: 'c', target: 'queue', task: 'kg-pagerank', status: null, lastAttemptTimestamp: null, timestamp: STALE_TS },
        { ID: 'd', target: 'queue', task: 'extractConcepts', status: 'processing', lastAttemptTimestamp: null, timestamp: FRESH_TS },
      ],
      // extractConcepts is genuinely running → its fresh row (d) is protected.
      { pipelineRows: [{ metadata: JSON.stringify({ jobName: 'extractConcepts' }) }] },
    );
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

  // ─── #2814: PipelineLog cross-check (HANA-HA-failover fast path) ───

  it('#2814 fast path: reaps a FRESH processing row (inside floor) when its job has NO RUNNING PipelineLog row', async () => {
    // The HANA-failover tombstone: a tick claimed status=processing then the DB
    // connection dropped (standby takeover), no app restart. The row is 5 min
    // old AND inside its cron period (daily cron → rule (a) doesn't fire), so
    // floor-only would NOT reap it — only the #2814 fast path (no RUNNING
    // PipelineLog row) does.
    const runSpy = mockOutbox(
      [
        { ID: 'fresh-dead', target: 'queue', task: 'daily-digest', status: 'processing', lastAttemptTimestamp: null, timestamp: FRESH_TS },
      ],
      { pipelineRows: [] }, // nothing running
    );
    const schedules = new Map([['daily-digest', '13 2 * * *']]);
    const { inspected, reaped } = await reapTombstonedOutboxRows(schedules, NOW);
    expect(inspected).toBe(1);
    expect(reaped).toBe(1);
    const deleteCalls = runSpy.mock.calls.filter(([q]) => q && q.DELETE);
    expect(deleteCalls.length).toBe(1);
    expect(JSON.stringify(deleteCalls[0][0].DELETE)).toContain('fresh-dead');
  });

  it('#2814 RUNNING veto extends PAST the 60-min floor: a STALE row whose job has a RUNNING PipelineLog row is NOT reaped', async () => {
    // Deliberate change to #2782 "age wins": per the "Protect if RUNNING"
    // decision, a RUNNING PipelineLog row vetoes reaping at ANY age. A job that
    // legitimately exceeds the floor (hypothetical >60-min run) is protected
    // even though its outbox row is "stale" by the wedge-badge definition.
    const runSpy = mockOutbox(
      [
        { ID: 'stale-but-running', target: 'queue', task: 'extractConcepts', status: 'processing', lastAttemptTimestamp: null, timestamp: STALE_TS },
      ],
      { pipelineRows: [{ metadata: JSON.stringify({ jobName: 'extractConcepts' }) }] },
    );
    const schedules = new Map([['extractConcepts', '13 2 * * *']]);
    const { inspected, reaped } = await reapTombstonedOutboxRows(schedules, NOW);
    expect(inspected).toBe(1);
    expect(reaped).toBe(0);
    expect(runSpy.mock.calls.filter(([q]) => q && q.DELETE).length).toBe(0);
  });

  it('#2814 fail-open (entity missing): PipelineLog absent → floor-only. STALE row reaped, FRESH row NOT', async () => {
    // Use a daily cron for the fresh row so isRowStale rule (a) (missed firing)
    // doesn't fire — the fresh row is inside BOTH the floor and its cron period,
    // so floor-only must leave it (it is only reaped via the #2814 fast path,
    // which is disabled here because the lookup is undeterminable).
    const runSpy = mockOutbox(
      [
        { ID: 'stale', target: 'queue', task: 'metrics-rollup', status: 'processing', lastAttemptTimestamp: null, timestamp: STALE_TS },
        { ID: 'fresh', target: 'queue', task: 'daily-digest', status: 'processing', lastAttemptTimestamp: null, timestamp: FRESH_TS },
      ],
      { noPipelineEntity: true },
    );
    const schedules = new Map([['metrics-rollup', '*/5 * * * *'], ['daily-digest', '13 2 * * *']]);
    const { inspected, reaped } = await reapTombstonedOutboxRows(schedules, NOW);
    expect(inspected).toBe(2);
    expect(reaped).toBe(1); // only the stale one
    const deleted = runSpy.mock.calls.filter(([q]) => q && q.DELETE).map(([q]) => JSON.stringify(q.DELETE));
    expect(deleted.some(s => s.includes('"stale"'))).toBe(true);
    expect(deleted.some(s => s.includes('"fresh"'))).toBe(false);
  });

  it('#2814 fail-open (PipelineLog SELECT throws): → floor-only. STALE row reaped, FRESH row NOT', async () => {
    const runSpy = mockOutbox(
      [
        { ID: 'stale', target: 'queue', task: 'metrics-rollup', status: 'processing', lastAttemptTimestamp: null, timestamp: STALE_TS },
        { ID: 'fresh', target: 'queue', task: 'daily-digest', status: 'processing', lastAttemptTimestamp: null, timestamp: FRESH_TS },
      ],
      { pipelineThrows: true },
    );
    const schedules = new Map([['metrics-rollup', '*/5 * * * *'], ['daily-digest', '13 2 * * *']]);
    const { inspected, reaped } = await reapTombstonedOutboxRows(schedules, NOW);
    expect(inspected).toBe(2);
    expect(reaped).toBe(1);
  });

  it('#2814 lookup OK + no RUNNING log → a STALE row is still reaped (unchanged tombstone recovery)', async () => {
    const runSpy = mockOutbox(
      [
        { ID: 'stale-dead', target: 'queue', task: 'metrics-rollup', status: 'processing', lastAttemptTimestamp: null, timestamp: STALE_TS },
      ],
      { pipelineRows: [] },
    );
    const schedules = new Map([['metrics-rollup', '*/5 * * * *']]);
    const { reaped } = await reapTombstonedOutboxRows(schedules, NOW);
    expect(reaped).toBe(1);
  });

  it('#2814 unparseable PipelineLog metadata is ignored; the running Set is built from the rest', async () => {
    // Two fresh rows on daily crons (floor-only would leave both). extractConcepts
    // has a VALID running log → protected. daily-digest only appears in a row
    // with MALFORMED metadata → treated as not-running → fast-path reaped.
    const runSpy = mockOutbox(
      [
        { ID: 'ec', target: 'queue', task: 'extractConcepts', status: 'processing', lastAttemptTimestamp: null, timestamp: FRESH_TS },
        { ID: 'mr', target: 'queue', task: 'daily-digest', status: 'processing', lastAttemptTimestamp: null, timestamp: FRESH_TS },
      ],
      {
        pipelineRows: [
          { metadata: '{not valid json' },
          { metadata: JSON.stringify({ jobName: 'extractConcepts' }) },
        ],
      },
    );
    const schedules = new Map([['extractConcepts', '13 2 * * *'], ['daily-digest', '47 3 * * *']]);
    const { inspected, reaped } = await reapTombstonedOutboxRows(schedules, NOW);
    expect(inspected).toBe(2);
    expect(reaped).toBe(1);
    const deleted = runSpy.mock.calls.filter(([q]) => q && q.DELETE).map(([q]) => JSON.stringify(q.DELETE));
    expect(deleted.some(s => s.includes('"mr"'))).toBe(true);
    expect(deleted.some(s => s.includes('"ec"'))).toBe(false);
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
