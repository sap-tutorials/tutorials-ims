import { describe, it, expect } from 'vitest';
import { formatEventDate } from './format-date';

describe('formatEventDate', () => {
  // #1615 — a date-only string is a CALENDAR day, not a UTC instant. It must
  // render as that same day in every viewer timezone. The old code did
  // `new Date("2026-09-04").toLocaleDateString()`, which parsed as UTC midnight
  // and rolled back one day for any behind-UTC (Americas) viewer.
  it('renders a date-only string as its own calendar day (no tz shift)', () => {
    expect(formatEventDate('2026-09-04')).toBe('Sep 4, 2026');
    expect(formatEventDate('2026-09-01')).toBe('Sep 1, 2026');
    expect(formatEventDate('2026-08-18')).toBe('Aug 18, 2026');
    // Jan 1 is the worst case: a UTC-parse + Americas render would roll to Dec 31.
    expect(formatEventDate('2026-01-01')).toBe('Jan 1, 2026');
  });

  it('accepts a custom Intl options object', () => {
    expect(formatEventDate('2026-09-04', { month: 'short', day: 'numeric' })).toBe('Sep 4');
  });

  it('returns "" for null/undefined/empty', () => {
    expect(formatEventDate(null)).toBe('');
    expect(formatEventDate(undefined)).toBe('');
    expect(formatEventDate('')).toBe('');
  });

  it('passes an unparseable string through unchanged', () => {
    expect(formatEventDate('not a date')).toBe('not a date');
  });

  it('formats a full ISO timestamp on its UTC calendar day', () => {
    // Blog publishedAt values carry a time. Forcing UTC keeps the displayed day
    // stable and consistent with the date-only path.
    expect(formatEventDate('2026-09-04T09:00:00.000Z')).toBe('Sep 4, 2026');
  });
});
