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

  it('groupByDate keys by ISO date, sorts by time, drops undated', () => {
    const sessions = [
      { id: 'b', kind: 'session', title: 'B', scheduledDate: '2026-10-05', scheduledTime: '16:00' },
      { id: 'a', kind: 'session', title: 'A', scheduledDate: '2026-10-05', scheduledTime: '14:00' },
      { id: 'n', kind: 'session', title: 'N', scheduledDate: '2026-10-05' }, // no time → last
      { id: 'x', kind: 'session', title: 'X' }, // no date → excluded from the date map
    ] as any;
    const map = groupByDate(sessions);
    expect([...map.keys()]).toEqual(['2026-10-05']);
    expect(map.get('2026-10-05')!.map((s) => s.id)).toEqual(['a', 'b', 'n']);
  });

  it('unscheduled surfaces sessions with no parseable scheduledDate', () => {
    const sessions = [
      { id: 'a', kind: 'session', title: 'A', scheduledDate: '2026-10-05' },
      { id: 'x', kind: 'session', title: 'X' }, // no date
      { id: 'y', kind: 'session', title: 'Y', scheduledDate: '' }, // blank date
      { id: 'z', kind: 'session', title: 'Z', scheduledDate: 'not-a-date' }, // unparseable
    ] as any;
    // the undated/unparseable rows are surfaced here rather than silently vanishing
    expect(unscheduled(sessions).map((s) => s.id)).toEqual(['x', 'y', 'z']);
  });
});
