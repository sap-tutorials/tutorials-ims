import { describe, it, expect } from 'vitest';
import {
  weekIndexToMonday,
  weekIndexToMondayISO,
  isoWeekLabel,
  enrichSignupRows,
} from '../../srv/lib/devtoberfest-signup-enrich.js';

describe('weekIndex ↔ Monday mapping', () => {
  it('weekIndex 0 is the 2018-01-01 Monday anchor', () => {
    expect(weekIndexToMondayISO(0)).toBe('2018-01-01');
  });

  it('consecutive weekIndexes are 7 days apart', () => {
    const a = weekIndexToMonday(100).getTime();
    const b = weekIndexToMonday(101).getTime();
    expect(b - a).toBe(7 * 86400000);
  });

  it('matches the spike bucket: weekIndex 453 → Monday 2026-09-07', () => {
    expect(weekIndexToMondayISO(453)).toBe('2026-09-07');
  });
});

describe('isoWeekLabel — ISO-8601 week numbering against known reference dates', () => {
  const cases = [
    // [Monday UTC, expected 'YYYY-Www']
    [Date.UTC(2018, 0, 1), '2018-W01'],  // 1 Jan 2018 is a Monday, ISO 2018-W01
    [Date.UTC(2018, 11, 31), '2019-W01'], // 31 Dec 2018 (Mon) belongs to ISO year 2019
    [Date.UTC(2020, 11, 28), '2020-W53'], // 28 Dec 2020 (Mon) is the 53-week year
    [Date.UTC(2016, 0, 4), '2016-W01'],  // 4 Jan 2016 (Mon) = ISO 2016-W01
    [Date.UTC(2026, 8, 7), '2026-W37'],  // matches the backend spike output
  ];
  it.each(cases)('%i → %s', (ms, expected) => {
    expect(isoWeekLabel(new Date(ms))).toBe(expected);
  });
});

describe('enrichSignupRows', () => {
  it('labels every week row and computes a running cumulative on the by-week series', () => {
    // deliberately unordered input
    const rows = [
      { weekIndex: 455, newSignups: 2 },
      { weekIndex: 453, newSignups: 3 },
      { weekIndex: 454, newSignups: 1 },
    ];
    enrichSignupRows(rows);
    const byWeek = Object.fromEntries(rows.map((r) => [r.weekIndex, r]));
    expect(byWeek[453]).toMatchObject({ weekMonday: '2026-09-07', weekLabel: '2026-W37', cumulativeSignups: 3 });
    expect(byWeek[454].cumulativeSignups).toBe(4);
    expect(byWeek[455].cumulativeSignups).toBe(6);
  });

  it('keys off a real weekMonday when weekIndex is absent (chart grouped by weekMonday)', () => {
    // deliberately unordered; no weekIndex (chart groups on the real weekMonday Date)
    const rows = [
      { weekMonday: '2026-09-21', newSignups: 2 },
      { weekMonday: '2026-09-07', newSignups: 3 },
      { weekMonday: '2026-09-14', newSignups: 1 },
    ];
    enrichSignupRows(rows);
    const byMon = Object.fromEntries(rows.map((r) => [r.weekMonday, r]));
    expect(byMon['2026-09-07']).toMatchObject({ weekLabel: '2026-W37', cumulativeSignups: 3 });
    expect(byMon['2026-09-14'].cumulativeSignups).toBe(4);
    expect(byMon['2026-09-21'].cumulativeSignups).toBe(6);
  });

  it('accepts a Date instance for weekMonday (HANA may return a Date, not a string)', () => {
    const rows = [{ weekMonday: new Date(Date.UTC(2026, 8, 7)), newSignups: 5 }];
    enrichSignupRows(rows);
    expect(rows[0].weekMonday).toBe('2026-09-07');
    expect(rows[0].weekLabel).toBe('2026-W37');
  });

  it('does NOT compute cumulative when a second dimension makes weeks repeat', () => {
    const rows = [
      { weekIndex: 453, region: 'EMEA', newSignups: 2 },
      { weekIndex: 453, region: 'AMERICAS', newSignups: 1 },
      { weekIndex: 454, region: 'Not set', newSignups: 1 },
    ];
    enrichSignupRows(rows);
    // labels still applied…
    expect(rows[0].weekLabel).toBe('2026-W37');
    // …but cumulative is omitted (a running total across repeated weeks is meaningless)
    expect(rows.every((r) => r.cumulativeSignups === undefined)).toBe(true);
  });

  it('leaves rows without a numeric weekIndex untouched (e.g. groupby region only / grand total)', () => {
    const rows = [{ region: 'EMEA', newSignups: 4 }, { newSignups: 6 }];
    enrichSignupRows(rows);
    expect(rows[0].weekMonday).toBeUndefined();
    expect(rows[0].cumulativeSignups).toBeUndefined();
    expect(rows[1].weekLabel).toBeUndefined();
  });

  it('skips cumulative when the measure is absent (raw non-aggregated read)', () => {
    const rows = [{ weekIndex: 453 }, { weekIndex: 454 }];
    enrichSignupRows(rows);
    expect(rows[0].weekMonday).toBe('2026-09-07'); // labels still applied
    expect(rows[0].cumulativeSignups).toBeUndefined();
  });

  it('returns non-array input unchanged', () => {
    expect(enrichSignupRows(null)).toBeNull();
    expect(enrichSignupRows(undefined)).toBeUndefined();
  });
});
