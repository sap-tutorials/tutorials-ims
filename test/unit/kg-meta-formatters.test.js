import { describe, it, expect } from 'vitest';
import {
  formatRelativeMonth,
  formatDate,
  formatLevel,
} from '../../srv/lib/kg-meta-formatters.js';

describe('kg-meta-formatters', () => {
  describe('formatRelativeMonth', () => {
    it('formats a mid-month UTC ISO timestamp as "Mon YYYY"', () => {
      expect(formatRelativeMonth('2026-06-03T12:00:00Z')).toBe('Jun 2026');
    });

    // Day-boundary: 23:00 UTC on Jun 30 is 09:00 Jul 1 in Sydney. UTC
    // pinning must keep this in June regardless of the reader's TZ.
    it('pins to UTC across day boundaries (2026-06-30T23:00:00Z stays in Jun)', () => {
      expect(formatRelativeMonth('2026-06-30T23:00:00Z')).toBe('Jun 2026');
    });

    it('returns "" for null / undefined / invalid input', () => {
      expect(formatRelativeMonth(null)).toBe('');
      expect(formatRelativeMonth(undefined)).toBe('');
      expect(formatRelativeMonth('not-a-date')).toBe('');
    });
  });

  describe('formatDate', () => {
    it('formats a mid-month UTC ISO timestamp as "Mon D, YYYY"', () => {
      expect(formatDate('2026-06-03T12:00:00Z')).toBe('Jun 3, 2026');
    });

    it('pins to UTC across day boundaries (2026-06-30T23:00:00Z stays Jun 30)', () => {
      expect(formatDate('2026-06-30T23:00:00Z')).toBe('Jun 30, 2026');
    });

    it('falls back to the raw slice(0,10) when the string is parseable-but-bad', () => {
      expect(formatDate('bad')).toBe('bad');
    });

    it('returns "" for null input', () => {
      expect(formatDate(null)).toBe('');
    });
  });

  describe('formatLevel', () => {
    it('capitalises the first letter and lowercases the rest', () => {
      expect(formatLevel('advanced')).toBe('Advanced');
      expect(formatLevel('BEGINNER')).toBe('Beginner');
    });

    it('returns "" for null / undefined / empty', () => {
      expect(formatLevel(null)).toBe('');
    });
  });
});
