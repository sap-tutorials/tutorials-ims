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
  isWithinExpectedTickWindow,
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
    const fakeDb = { run: vi.fn().mockResolvedValue([
      { target: 'cron.extractConcepts', status: 'processing' },
      { target: 'cron.other-job',       status: 'done' },        // filtered — wrong status
      { target: 'not-a-cron-target',    status: 'processing' },  // filtered — no cron. prefix
      { target: 'cron.another-job',     status: 'processing' },
    ])};
    Object.defineProperty(cds, 'connect', {
      value: { to: vi.fn().mockResolvedValue(fakeDb) },
      configurable: true,
    });
    const result = await loadStuckOutboxTargets();
    expect(result.size).toBe(2);
    expect(result.has('extractConcepts')).toBe(true);
    expect(result.has('another-job')).toBe(true);
    expect(result.has('other-job')).toBe(false);
  });

  it('loadStuckOutboxTargets tolerates uppercase column names (HANA casing)', async () => {
    Object.defineProperty(cds, 'entities', {
      get: () => () => ({
        Messages: { name: 'cds.outbox.Messages' },
      }),
      configurable: true,
    });
    const fakeDb = { run: vi.fn().mockResolvedValue([
      { TARGET: 'cron.uppercase-job', STATUS: 'processing' },
    ])};
    Object.defineProperty(cds, 'connect', {
      value: { to: vi.fn().mockResolvedValue(fakeDb) },
      configurable: true,
    });
    const result = await loadStuckOutboxTargets();
    expect(result.has('uppercase-job')).toBe(true);
  });
});

describe('scheduler-wedge — isWithinExpectedTickWindow', () => {
  it('returns true immediately after a firing (inside current window)', () => {
    // Every hour on the :07 mark. At :30 we are 23 minutes into the current window.
    const now = new Date('2026-07-06T12:30:00Z');
    expect(isWithinExpectedTickWindow('7 * * * *', now)).toBe(true);
  });

  it("always returns true for a valid parse — wedge composition is the caller's job", () => {
    // The pure predicate returns true whenever cron-parser resolves prev/next
    // cleanly around `now`. Wedge composition happens in listJobs() by
    // combining this signal with "does an outbox row exist for cron.<name>".
    const now = new Date('2026-07-06T13:08:00Z');
    expect(isWithinExpectedTickWindow('7 * * * *', now)).toBe(true);
  });

  it('returns true on cron parse failure (fail-open — do not false-positive)', () => {
    const now = new Date('2026-07-06T12:00:00Z');
    expect(isWithinExpectedTickWindow('this is not a cron expression', now)).toBe(true);
  });
});
