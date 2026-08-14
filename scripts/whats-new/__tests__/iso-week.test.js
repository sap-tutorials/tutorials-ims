import { describe, it, expect } from 'vitest';
import { isoWeekId, isoWeekStart } from '../iso-week.mjs';

// Anchor facts: 2026-01-01 is a Thursday (so it is in ISO week 1 of 2026,
// whose Monday is 2025-12-29). 2026-08-10 is a Monday.
describe('iso-week', () => {
  it('handles the year-boundary week', () => {
    const d = new Date('2026-01-01T10:00:00Z');
    expect(isoWeekId(d)).toBe('2026-W01');
    expect(isoWeekStart(d)).toBe('2025-12-29');
  });

  it('a Sunday belongs to the week that started the prior Monday', () => {
    // 2025-12-28 is the Sunday before 2025-12-29 → previous ISO week.
    expect(isoWeekStart(new Date('2025-12-28T12:00:00Z'))).toBe('2025-12-22');
  });

  it('computes the Monday for a mid-year week (go-live week)', () => {
    // Monday noon US Eastern = 16:00 UTC.
    expect(isoWeekStart(new Date('2026-08-10T16:00:00Z'))).toBe('2026-08-10');
    // Thursday and Sunday of the same week map to the same Monday + week id.
    expect(isoWeekStart(new Date('2026-08-13T23:00:00Z'))).toBe('2026-08-10');
    expect(isoWeekStart(new Date('2026-08-16T23:00:00Z'))).toBe('2026-08-10');
    expect(isoWeekId(new Date('2026-08-10T16:00:00Z')))
      .toBe(isoWeekId(new Date('2026-08-16T23:00:00Z')));
  });

  it('formats week ids zero-padded', () => {
    expect(isoWeekId(new Date('2026-01-01T10:00:00Z'))).toMatch(/^\d{4}-W\d{2}$/);
  });
});
