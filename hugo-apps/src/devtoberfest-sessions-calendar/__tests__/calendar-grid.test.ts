import { describe, it, expect } from 'vitest';
import { buildCalendar, weekdayOf } from '../calendar-grid';

describe('buildCalendar', () => {
  it('derives weeks and weekdays from data, omitting empties, supporting non-contiguous weeks + weekend', () => {
    const sessions = [
      { id: '1', week: '1', scheduledDate: '2026-10-05' }, // Monday
      { id: '2', week: '1', scheduledDate: '2026-10-09' }, // Friday
      { id: '3', week: '3', scheduledDate: '2026-10-24' }, // Saturday (weekend), note week 2 absent
    ] as any;
    const cal = buildCalendar(sessions);
    expect(cal.weeks).toEqual(['1', '3']);            // week 2 omitted (non-contiguous)
    expect(cal.weekdays).toEqual(['Monday', 'Friday', 'Saturday']); // only present days, in week order
    expect(cal.cells['1']['Monday'].map((s: any) => s.id)).toEqual(['1']);
    expect(cal.cells['3']['Saturday'].map((s: any) => s.id)).toEqual(['3']);
    expect(cal.cells['1']['Saturday']).toBeUndefined();
  });

  it('weekdayOf returns English weekday name', () => {
    expect(weekdayOf('2026-10-05')).toBe('Monday');
  });
});
