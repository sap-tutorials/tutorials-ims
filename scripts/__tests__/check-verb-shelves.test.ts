// scripts/__tests__/check-verb-shelves.test.ts
//
// Unit tests for the build-time verb-shelf guard (scripts/check-verb-shelves.cjs),
// the durable net for the #1029 regression where /model/ shipped to DEV with
// zero shelf cards because the build baked shelf data from a CSV-seeded SQLite
// backend that lacked MODEL's rows.
//
// We import the pure core (findEmptyVerbs) and assert against synthetic
// payloads — same approach as check-build-collisions.test.ts. The CLI wiring
// (file read + exit code) is exercised by the live `build:hugo` chain.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findEmptyVerbs } = require('../check-verb-shelves.cjs');

const SEVEN_VERBS = {
  verbs: ['LEARN', 'BUILD', 'INTEGRATE', 'MODEL', 'OPERATE', 'AI', 'CONNECT'].map(
    (verbKey) => ({ verbKey })
  ),
};

const shelvesFor = (verbs: string[], opts: { inactive?: string[] } = {}) => ({
  shelves: verbs.map((verb) => ({
    verb,
    isActive: opts.inactive?.includes(verb) ? false : true,
  })),
});

describe('findEmptyVerbs', () => {
  it('flags the exact #1029 shape: MODEL defined but no shelf rows', () => {
    const shelves = shelvesFor(['LEARN', 'BUILD', 'INTEGRATE', 'OPERATE', 'AI', 'CONNECT']);
    const { empties, verbCount, shelfCount } = findEmptyVerbs(SEVEN_VERBS, shelves);
    expect(empties).toEqual(['MODEL']);
    expect(verbCount).toBe(7);
    expect(shelfCount).toBe(6);
  });

  it('passes when every verb has at least one active shelf row', () => {
    const shelves = shelvesFor(SEVEN_VERBS.verbs.map((v) => v.verbKey));
    expect(findEmptyVerbs(SEVEN_VERBS, shelves).empties).toEqual([]);
  });

  it('treats a verb whose only rows are isActive:false as empty', () => {
    const shelves = shelvesFor(
      SEVEN_VERBS.verbs.map((v) => v.verbKey),
      { inactive: ['MODEL'] }
    );
    expect(findEmptyVerbs(SEVEN_VERBS, shelves).empties).toEqual(['MODEL']);
  });

  it('counts a row with no explicit isActive as active (default-true schema)', () => {
    const shelves = { shelves: [{ verb: 'MODEL' }] }; // no isActive key
    const verbs = { verbs: [{ verbKey: 'MODEL' }] };
    expect(findEmptyVerbs(verbs, shelves).empties).toEqual([]);
  });

  it('flags multiple empty verbs (e.g. a whole-feed SQLite build with only CSV verbs)', () => {
    const shelves = shelvesFor(['LEARN', 'BUILD']);
    const { empties } = findEmptyVerbs(SEVEN_VERBS, shelves);
    expect(empties.sort()).toEqual(['AI', 'CONNECT', 'INTEGRATE', 'MODEL', 'OPERATE']);
  });

  it('reports zero verbs when verb_definitions baked empty (fetch fallback)', () => {
    const { empties, verbCount } = findEmptyVerbs({ verbs: [] }, { shelves: [] });
    expect(verbCount).toBe(0);
    expect(empties).toEqual([]); // CLI turns verbCount===0 into its own failure
  });

  it('is defensive against missing/malformed payload keys', () => {
    expect(findEmptyVerbs({}, {}).empties).toEqual([]);
    expect(findEmptyVerbs(null, null).verbCount).toBe(0);
  });
});
