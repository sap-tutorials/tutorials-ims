import { describe, it, expect } from 'vitest';
import { broadcastingTag, matchesFormat, FORMAT_FILTER_OPTIONS } from '../broadcasting';

describe('broadcasting helper', () => {
  it('maps Live and PreRecorded to display tags', () => {
    const live = broadcastingTag('Live');
    expect(live).toMatchObject({ value: 'Live', label: 'Live', modifier: 'live' });
    const rec = broadcastingTag('PreRecorded');
    expect(rec).toMatchObject({ value: 'PreRecorded', label: 'Prerecorded', modifier: 'prerecorded' });
    expect(live!.icon).toBeTruthy();
    expect(rec!.icon).toBeTruthy();
  });

  it('returns null for unset/unrecognized preferences (no tag)', () => {
    expect(broadcastingTag(null)).toBeNull();
    expect(broadcastingTag(undefined)).toBeNull();
    expect(broadcastingTag('Whatever' as any)).toBeNull();
  });

  it('empty filter matches everything, including unset', () => {
    expect(matchesFormat('Live', '')).toBe(true);
    expect(matchesFormat('PreRecorded', '')).toBe(true);
    expect(matchesFormat(null, '')).toBe(true);
    expect(matchesFormat(null, null)).toBe(true);
  });

  it('set filter requires exact match; unset is excluded', () => {
    expect(matchesFormat('Live', 'Live')).toBe(true);
    expect(matchesFormat('PreRecorded', 'Live')).toBe(false);
    expect(matchesFormat('PreRecorded', 'PreRecorded')).toBe(true);
    expect(matchesFormat(null, 'Live')).toBe(false);
    expect(matchesFormat(null, 'PreRecorded')).toBe(false);
  });

  it('exposes All/Live/Prerecorded filter options in order', () => {
    expect(FORMAT_FILTER_OPTIONS.map((o) => o.value)).toEqual(['', 'Live', 'PreRecorded']);
  });
});
