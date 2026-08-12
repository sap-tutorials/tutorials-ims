/**
 * Tests for format-session-time.ts helpers.
 *
 * TZ-pinning strategy: `process.env.TZ` is set BEFORE any import so that
 * Node/Intl resolves the viewer-local zone to a deterministic value.
 * This is confirmed to work in Node 26 with Vitest 4 (the worker inherits
 * the env var set before the module graph loads).
 *
 * We also verify TZ actually took effect with a sanity assertion before the
 * substantive tests — if TZ pinning fails the sanity check will fail first
 * with a clear message.
 */

// Pin viewer-local TZ BEFORE importing any module.
// 2026-10-02T05:00:00Z = 2026-10-01 22:00:00 America/Los_Angeles (PDT, UTC-7)
// → viewerDayKey should return '2026-10-01'.
process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect } from 'vitest';
import { formatViewerLocal, formatHomeZone, viewerDayKey } from '../format-session-time';

// ── Sanity: confirm TZ actually took effect ─────────────────────────────────
describe('TZ pin sanity', () => {
  it('process.env.TZ = America/Los_Angeles is effective (Intl sees PDT/PST)', () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(tz).toBe('America/Los_Angeles');
  });
});

// ── viewerDayKey ─────────────────────────────────────────────────────────────
describe('viewerDayKey', () => {
  it('buckets by viewer-local day (decision B): 05:00Z = prev-day in LA', () => {
    // 2026-10-02T05:00:00Z = 2026-10-01 22:00 PDT (UTC-7)
    expect(viewerDayKey('2026-10-02T05:00:00Z')).toBe('2026-10-01');
  });

  it('same-day case: midday UTC is still same day in LA', () => {
    // 2026-10-01T18:00:00Z = 2026-10-01 11:00 PDT
    expect(viewerDayKey('2026-10-01T18:00:00Z')).toBe('2026-10-01');
  });

  it('returns YYYY-MM-DD with zero-padded month and day', () => {
    // 2026-01-05T20:00:00Z = 2026-01-05 12:00 PST (UTC-8, after DST ends Nov 1)
    expect(viewerDayKey('2026-01-05T20:00:00Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns empty string for falsy input', () => {
    expect(viewerDayKey('')).toBe('');
  });

  it('returns empty string for invalid ISO string', () => {
    expect(viewerDayKey('not-a-date')).toBe('');
  });
});

// ── formatHomeZone ───────────────────────────────────────────────────────────
describe('formatHomeZone', () => {
  it('Berlin in CEST (UTC+2): 15:00Z → 17:00 local', () => {
    const result = formatHomeZone('2026-10-01T15:00:00Z', 'Europe/Berlin');
    // Should show 5:00 PM or 17:00 (hour in 12h or 24h format depending on locale)
    expect(result).toMatch(/5:00\s?PM|17:00/);
    // Should show CEST or GMT+2 zone label
    expect(result).toMatch(/GMT\+2|CEST/);
  });

  it('falls back to Etc/UTC when zone is empty', () => {
    // 2026-10-01T12:00:00Z in UTC → 12:00 noon UTC
    const result = formatHomeZone('2026-10-01T12:00:00Z', '');
    expect(result).toMatch(/12:00/);
    expect(result).toMatch(/UTC|GMT\+0/);
  });

  it('returns empty string for falsy instantISO', () => {
    expect(formatHomeZone('', 'Europe/Berlin')).toBe('');
  });

  it('returns empty string for invalid ISO string', () => {
    expect(formatHomeZone('not-a-date', 'Europe/Berlin')).toBe('');
  });

  it('Tokyo (UTC+9): 15:00Z → midnight + 1 day (00:00 Oct 2)', () => {
    const result = formatHomeZone('2026-10-01T15:00:00Z', 'Asia/Tokyo');
    // 15:00Z + 9h = 00:00 Oct 2 in Tokyo
    expect(result).toMatch(/12:00\s?AM|0:00/);
    expect(result).toMatch(/JST|GMT\+9/);
  });

  // Bad data must degrade gracefully, never throw. A non-IANA abbreviation
  // like 'CEST' makes Intl.DateTimeFormat throw RangeError; one such row must
  // not take down the whole page render (regression: Devtoberfest Sessions).
  it('does not throw on a non-IANA zone abbreviation (e.g. CEST)', () => {
    expect(() => formatHomeZone('2026-10-01T15:00:00Z', 'CEST')).not.toThrow();
  });

  it('returns empty string for an invalid/unknown zone (CEST)', () => {
    expect(formatHomeZone('2026-10-01T15:00:00Z', 'CEST')).toBe('');
  });

  it('returns empty string for other bogus zone strings', () => {
    expect(formatHomeZone('2026-10-01T15:00:00Z', 'Not/AZone')).toBe('');
    expect(formatHomeZone('2026-10-01T15:00:00Z', 'Europe/Nowhere')).toBe('');
  });
});

// ── formatViewerLocal ────────────────────────────────────────────────────────
describe('formatViewerLocal', () => {
  it('renders a time + a timezone abbreviation token for a valid input', () => {
    const result = formatViewerLocal('2026-10-01T18:00:00Z');
    // Must contain time digits
    expect(result).toMatch(/\d+:\d+/);
    // Must contain a zone token (PDT, PST, GMT..., etc.)
    expect(result).toMatch(/PDT|PST|GMT/);
  });

  it('returns empty string for falsy input', () => {
    expect(formatViewerLocal('')).toBe('');
  });

  it('returns empty string for invalid ISO string', () => {
    expect(formatViewerLocal('not-a-date')).toBe('');
  });

  it('viewer-local: 05:00Z in LA = previous day (PDT UTC-7)', () => {
    // 2026-10-02T05:00:00Z = Oct 1 10:00 PM PDT
    const result = formatViewerLocal('2026-10-02T05:00:00Z');
    // Should contain Oct 1 (not Oct 2)
    expect(result).toContain('Oct 1');
    expect(result).toMatch(/PDT|GMT-7/);
  });
});
