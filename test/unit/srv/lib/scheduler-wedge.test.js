// test/unit/srv/lib/scheduler-wedge.test.js
//
// #1021: unit tests for scheduler-wedge helpers. Real DELETE/SELECT
// coverage against cds.outbox.Messages lives in the hybrid test
// (test/hybrid/scheduler-wedge-recovery.test.js) — in-memory SQLite
// does not deploy cds.outbox by default.
//
// These unit tests exercise the fail-open branches (missing entity,
// db.run() throws) and the pure cron-window logic.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';

import {
  deleteStuckOutboxRow,
  loadStuckOutboxTargets,
  isRowStale,
} from '../../../../srv/lib/scheduler-wedge.js';

describe('scheduler-wedge — fail-open branches', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('deleteStuckOutboxRow returns false when cds.outbox.Messages is missing', async () => {
    // Override the cds.entities getter
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

  it('loadStuckOutboxTargets extracts jobName from cron.<name> targets, filters status=processing', async () => {
    Object.defineProperty(cds, 'entities', {
      get: () => () => ({
        Messages: { name: 'cds.outbox.Messages' },
      }),
      configurable: true,
    });
    const ts1 = '2026-07-06T12:07:00.000Z';
    const ts2 = '2026-07-06T14:05:00.000Z';
    const fakeDb = { run: vi.fn().mockResolvedValue([
      { target: 'cron.extractConcepts', status: 'processing', lastAttemptTimestamp: ts1 },
      { target: 'cron.other-job',       status: 'done',        lastAttemptTimestamp: ts1 }, // filtered — wrong status
      { target: 'not-a-cron-target',    status: 'processing',  lastAttemptTimestamp: ts1 }, // filtered — no cron. prefix
      { target: 'cron.another-job',     status: 'processing',  lastAttemptTimestamp: ts2 },
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
    expect(result.has('other-job')).toBe(false);
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
      { TARGET: 'cron.uppercase-job', STATUS: 'processing', LASTATTEMPTTIMESTAMP: ts },
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
    const now = new Date('2026-07-06T12:30:00Z'); // 23min into current hour
    expect(isRowStale('7 * * * *', rowStartedAt, now)).toBe(false);
  });

  it('returns true when now has passed the next firing after rowStartedAt (wedged)', () => {
    // Cron fires at :07 every hour. Row started at 12:07; next firing was 13:07,
    // but now is 14:08 — that firing has come and gone. The row is stale/wedged.
    // This is the test that would have FAILED against the old tautological impl.
    const rowStartedAt = new Date('2026-07-06T12:07:00Z');
    const now = new Date('2026-07-06T14:08:00Z'); // 13:07 fire should have cleared the row
    expect(isRowStale('7 * * * *', rowStartedAt, now)).toBe(true);
  });

  it('returns false on cron parse failure (fail-open — do not false-positive)', () => {
    expect(isRowStale('not a cron', new Date(), new Date())).toBe(false);
  });
});
