// Unit tests for srv/lib/cron-firings.js — pure-function helpers that
// enumerate cron firings within a time window. Used by the AdminService.
// JobControls.listJobs handler to populate nextRunsIso for the Board's
// Cron health tile (#750). Mirrors the v5 cron-parser API (CronExpressionParser.
// parse) used at srv/admin-service.js:2166 — same import shape, same call,
// same options.

import { describe, it, expect } from 'vitest';
import { enumerateFiringsWithinWindow, nextRunIsoFrom } from '../../../srv/lib/cron-firings.js';

describe('enumerateFiringsWithinWindow', () => {
  it('returns 12 firings for a */5 schedule across a 60-minute window', () => {
    const from = new Date('2026-07-01T12:00:00.000Z');
    const to = new Date('2026-07-01T13:00:00.000Z');
    const out = enumerateFiringsWithinWindow('*/5 * * * *', from, to, 50);
    expect(out).toHaveLength(12);
    // monotonic strictly increasing
    for (let i = 1; i < out.length; i++) {
      expect(new Date(out[i]) > new Date(out[i - 1])).toBe(true);
    }
    // 5-minute spacing
    expect(new Date(out[1]) - new Date(out[0])).toBe(5 * 60 * 1000);
  });

  it('honors the cap argument when there are more firings than the cap allows', () => {
    const from = new Date('2026-07-01T12:00:00.000Z');
    const to = new Date('2026-07-01T13:00:00.000Z');
    const out = enumerateFiringsWithinWindow('*/5 * * * *', from, to, 3);
    expect(out).toHaveLength(3);
  });

  it('returns [] when no firing falls inside the window (monthly cron)', () => {
    // "23 4 1 * *" fires at 04:23 on the 1st of each month. From 2026-06-30T00:00Z + 24h,
    // the window is [2026-06-30T00:00Z, 2026-07-01T00:00Z], which excludes the next
    // 2026-07-01T04:23Z firing (`to` is inclusive but 04:23Z > 00:00Z).
    const from = new Date('2026-06-30T00:00:00.000Z');
    const to = new Date('2026-07-01T00:00:00.000Z');
    const out = enumerateFiringsWithinWindow('23 4 1 * *', from, to, 50);
    expect(out).toEqual([]);
  });

  it('caps a per-minute schedule at exactly 50 firings, not 1440', () => {
    const from = new Date('2026-07-01T12:00:00.000Z');
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
    const out = enumerateFiringsWithinWindow('* * * * *', from, to, 50);
    expect(out).toHaveLength(50);
  });

  it('excludes the lower bound: a firing exactly at `from` is NOT in the result', () => {
    // "0 * * * *" fires at HH:00:00. Starting `from` AT HH:00:00 should yield
    // the NEXT hour as the first entry, not the current one.
    const from = new Date('2026-07-01T12:00:00.000Z');
    const to = new Date('2026-07-01T14:30:00.000Z');
    const out = enumerateFiringsWithinWindow('0 * * * *', from, to, 50);
    expect(out[0]).toBe('2026-07-01T13:00:00.000Z');
    expect(out[1]).toBe('2026-07-01T14:00:00.000Z');
  });

  it('includes a firing landing exactly on the upper bound `to` (to is inclusive)', () => {
    // `0 * * * *` fires hourly on the hour. From 12:00:00 to 13:00:00 (exactly +1h),
    // the firing at 13:00:00 should be included — `to` is inclusive.
    const from = new Date('2026-07-01T12:00:00.000Z');
    const to = new Date('2026-07-01T13:00:00.000Z');
    const out = enumerateFiringsWithinWindow('0 * * * *', from, to, 50);
    expect(out).toEqual(['2026-07-01T13:00:00.000Z']);
  });
});

describe('nextRunIsoFrom', () => {
  it('returns the single next firing time as an ISO string', () => {
    const from = new Date('2026-06-30T00:00:00.000Z');
    const out = nextRunIsoFrom('23 4 1 * *', from);
    expect(out).toBe('2026-07-01T04:23:00.000Z');
  });
});
