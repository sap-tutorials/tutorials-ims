import { describe, it, expect } from 'vitest';
import { buildTrackColorMap, NAMED_PALETTE } from './track-colors';

describe('buildTrackColorMap with planner colors', () => {
  it('uses the enum color when present', () => {
    const map = buildTrackColorMap([{ name: 'ABAP', color: 'Green' }]);
    expect(map.get('ABAP')).toEqual(NAMED_PALETTE.Green);
  });
  it('falls back to hash palette when color missing', () => {
    const map = buildTrackColorMap([{ name: 'NoColor' }]);
    expect(map.get('NoColor')).toBeTruthy();
  });
});
