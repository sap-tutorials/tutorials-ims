import { describe, it, expect } from 'vitest';
import { matches, isHidden, scoreEntry, rankShelves, rankForYou }
  from '../../../srv/lib/homepage/persona-scoring.js';

const dev = { role: 'developer', deployment: 'cloud', cloud: 'aws' };
const anon = { role: null, deployment: null, cloud: null };

describe('matches', () => {
  it('is false for empty tags', () => {
    expect(matches({ personaTags: [] }, dev)).toBe(false);
  });
  it('is true when role matches', () => {
    expect(matches({ personaTags: ['role:developer'] }, dev)).toBe(true);
  });
  it('is false when tag field is not set on profile', () => {
    expect(matches({ personaTags: ['role:developer'] }, anon)).toBe(false);
  });
  it('is true when any tag matches (OR semantics)', () => {
    expect(matches({ personaTags: ['role:architect', 'cloud:aws'] }, dev)).toBe(true);
  });
});

describe('isHidden', () => {
  it('is false when hidden list is empty or absent', () => {
    expect(isHidden({}, dev)).toBe(false);
    expect(isHidden({ personaHidden: [] }, dev)).toBe(false);
  });
  it('is true when any hidden tag matches', () => {
    expect(isHidden({ personaHidden: ['role:developer'] }, dev)).toBe(true);
  });
});

describe('scoreEntry', () => {
  it('is 0 when no match', () => {
    expect(scoreEntry({ personaTags: ['role:student'], personaWeight: 5 }, dev)).toBe(0);
  });
  it('is personaWeight on match', () => {
    expect(scoreEntry({ personaTags: ['role:developer'], personaWeight: 5 }, dev)).toBe(5);
  });
  it('is 0 when weight is undefined even with match', () => {
    expect(scoreEntry({ personaTags: ['role:developer'] }, dev)).toBe(0);
  });
});

describe('rankShelves', () => {
  const rows = [
    { ID: 'a', title: 'A', sortOrder: 200, personaTags: ['role:architect'], personaWeight: 10 },
    { ID: 'b', title: 'B', sortOrder: 100, personaTags: ['role:developer'], personaWeight: 10 },
    { ID: 'c', title: 'C', sortOrder: 50,  personaTags: [], personaWeight: 0 },
    { ID: 'd', title: 'D', sortOrder: 300, personaHidden: ['role:developer'] },
  ];

  it('hides entries whose personaHidden matches', () => {
    const r = rankShelves(rows, dev);
    expect(r.map(x => x.ID)).not.toContain('d');
  });

  it('scored entries lead untagged ones', () => {
    const r = rankShelves(rows, dev);
    expect(r[0].ID).toBe('b');           // matched developer, weight 10
    expect(r.at(-1).ID).toBe('a');       // no match, higher sortOrder
  });

  it('preserves stable order on ties (by sortOrder then title)', () => {
    const tied = [
      { ID: '2', title: 'Bb', sortOrder: 100 },
      { ID: '1', title: 'Aa', sortOrder: 100 },
    ];
    const r = rankShelves(tied, anon);
    expect(r.map(x => x.ID)).toEqual(['1', '2']);
  });
});

describe('rankForYou', () => {
  it('returns empty when fewer than min match', () => {
    const rows = [
      { ID: '1', personaTags: ['role:developer'], personaWeight: 5, sortOrder: 100 },
      { ID: '2', personaTags: ['role:student'],   personaWeight: 5, sortOrder: 100 },
    ];
    expect(rankForYou(rows, dev, { min: 3, max: 8 })).toEqual([]);
  });

  it('drops untagged candidates', () => {
    const rows = [
      { ID: '1', personaTags: ['role:developer'], personaWeight: 5, sortOrder: 100 },
      { ID: '2', personaTags: ['role:developer'], personaWeight: 3, sortOrder: 100 },
      { ID: '3', personaTags: ['role:developer'], personaWeight: 0, sortOrder: 100 },
      { ID: '4', personaTags: [],                  personaWeight: 99, sortOrder: 100 },
    ];
    const r = rankForYou(rows, dev, { min: 3, max: 8 });
    expect(r.map(x => x.ID)).toEqual(['1', '2', '3']);   // 4 excluded (no match)
  });

  it('caps at max', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      ID: String(i), personaTags: ['role:developer'], personaWeight: 10 - i, sortOrder: 100,
    }));
    const r = rankForYou(rows, dev, { min: 1, max: 3 });
    expect(r).toHaveLength(3);
    expect(r.map(x => x.ID)).toEqual(['0', '1', '2']);
  });
});
