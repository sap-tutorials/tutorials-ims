/**
 * Tests for calendar-core.ts date helpers.
 *
 * TZ-pinning: process.env.TZ is set BEFORE any import so that Intl resolves
 * viewer-local zone to America/Los_Angeles (PDT in Oct, UTC-7). This makes
 * groupByDate (which uses viewerDayKey) deterministic in tests.
 *
 * The date-math helpers (iso, parseISO, addDays, etc.) operate on UTC Date
 * objects and are unaffected by local TZ — they're tested with UTC assertions.
 */

// Pin viewer-local TZ BEFORE any module is imported.
process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect } from 'vitest';
import {
  iso, parseISO, addDays, addWeeks, addMonths,
  startOfWeek, weekDays, monthGridCells, groupByDate, unscheduled,
} from '../calendar-core';

describe('calendar-core date helpers', () => {
  it('iso/parseISO round-trip in UTC', () => {
    expect(iso(parseISO('2026-10-05')!)).toBe('2026-10-05');
    expect(parseISO('')).toBeNull();
    expect(parseISO('not-a-date')).toBeNull();
  });

  it('addDays / addWeeks / addMonths do not mutate and wrap correctly', () => {
    const base = parseISO('2026-10-31')!;
    expect(iso(addDays(base, 1))).toBe('2026-11-01');
    expect(iso(addWeeks(base, 1))).toBe('2026-11-07');
    expect(iso(addMonths(parseISO('2026-12-15')!, 1))).toBe('2027-01-15');
    expect(iso(base)).toBe('2026-10-31'); // unchanged
  });

  it('addMonths clamps day to target month length (no month-skip)', () => {
    // Aug 31 + 1 → Sep has 30 days → clamps to Sep 30, NOT Oct 1 (would skip Sep)
    expect(iso(addMonths(parseISO('2026-08-31')!, 1))).toBe('2026-09-30');
    // Jan 31 + 1 → Feb 2027 (28 days) → clamps to Feb 28
    expect(iso(addMonths(parseISO('2027-01-31')!, 1))).toBe('2027-02-28');
    // Mar 31 - 1 → Feb 2026 (28 days) → clamps to Feb 28
    expect(iso(addMonths(parseISO('2026-03-31')!, -1))).toBe('2026-02-28');
    // year-wrap still works for a safe day
    expect(iso(addMonths(parseISO('2026-12-15')!, 1))).toBe('2027-01-15');
  });

  it('startOfWeek returns Monday for any day', () => {
    expect(iso(startOfWeek(parseISO('2026-10-08')!))).toBe('2026-10-05'); // Thu → Mon
    expect(iso(startOfWeek(parseISO('2026-10-05')!))).toBe('2026-10-05'); // Mon → Mon
    expect(iso(startOfWeek(parseISO('2026-10-11')!))).toBe('2026-10-05'); // Sun → Mon
  });

  it('weekDays returns 7 Mon→Sun dates', () => {
    const days = weekDays(parseISO('2026-10-08')!).map(iso);
    expect(days).toEqual([
      '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
      '2026-10-09', '2026-10-10', '2026-10-11',
    ]);
  });

  it('monthGridCells returns 42 Monday-first cells spanning the month', () => {
    const cells = monthGridCells(parseISO('2026-10-15')!).map(iso);
    expect(cells).toHaveLength(42);
    expect(cells[0]).toBe('2026-09-28');  // Monday before Oct 1 (a Thursday)
    expect(cells).toContain('2026-10-01');
    expect(cells).toContain('2026-10-31');
    expect(cells[41]).toBe('2026-11-08'); // trailing Sunday
  });

  it('monthGridCells handles a month starting on Monday', () => {
    // Jun 2026 starts on Monday
    const cells = monthGridCells(parseISO('2026-06-10')!).map(iso);
    expect(cells[0]).toBe('2026-06-01');
    expect(cells).toHaveLength(42);
  });

  it('groupByDate keys by viewer-local day (decision B), sorts by scheduledStart instant, drops undated', () => {
    // TZ=America/Los_Angeles (PDT = UTC-7 in October)
    // 2026-10-05T21:00:00Z = 2026-10-05 14:00 PDT (later that day)
    // 2026-10-05T17:00:00Z = 2026-10-05 10:00 PDT (earlier that day)
    // 2026-10-05T22:00:00Z = 2026-10-05 15:00 PDT (no-time session, sorts last)
    // 2026-10-06T05:00:00Z = 2026-10-05 22:00 PDT (prev-day in LA!)
    const sessions = [
      { id: 'b', kind: 'session', title: 'B', scheduledStart: '2026-10-05T21:00:00Z' },
      { id: 'a', kind: 'session', title: 'A', scheduledStart: '2026-10-05T17:00:00Z' },
      // crosses midnight: 2026-10-06T05:00:00Z = 2026-10-05 22:00 PDT → same day as a/b
      { id: 'c', kind: 'session', title: 'C', scheduledStart: '2026-10-06T05:00:00Z' },
      { id: 'x', kind: 'session', title: 'X' }, // no scheduledStart → excluded
    ] as any;
    const map = groupByDate(sessions);
    // All three with scheduledStart bucket to the same viewer-local day key
    expect([...map.keys()]).toEqual(['2026-10-05']);
    // Sorted by scheduledStart ISO ascending: 17:00Z < 21:00Z < 06T05:00Z
    expect(map.get('2026-10-05')!.map((s: any) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('groupByDate: session crossing UTC midnight stays on viewer-local prev-day', () => {
    // 2026-10-02T05:00:00Z = 2026-10-01 22:00 PDT → should land on '2026-10-01'
    const sessions = [
      { id: 'late', kind: 'session', title: 'Late', scheduledStart: '2026-10-02T05:00:00Z' },
    ] as any;
    const map = groupByDate(sessions);
    expect([...map.keys()]).toEqual(['2026-10-01']);
  });

  it('unscheduled surfaces sessions with no scheduledStart', () => {
    const sessions = [
      { id: 'a', kind: 'session', title: 'A', scheduledStart: '2026-10-05T14:00:00Z' },
      { id: 'x', kind: 'session', title: 'X' }, // no scheduledStart
      { id: 'y', kind: 'session', title: 'Y', scheduledStart: '' }, // blank → no start
      { id: 'z', kind: 'session', title: 'Z', scheduledStart: undefined }, // undefined
    ] as any;
    // The undated rows are surfaced here rather than silently vanishing
    expect(unscheduled(sessions).map((s: any) => s.id)).toEqual(['x', 'y', 'z']);
  });
});
