// test/unit/kg-tutorial-teaches-map.test.js
//
// Unit tests for the cached tutorial-teaches map. Uses mocked cds so we
// don't need a live DB.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockRun = vi.fn();
const mockDb = {
  options: { kind: 'hana' },
  constructor: { name: 'HANAService' },
  run: mockRun,
};

vi.mock('@sap/cds', () => ({
  default: {
    entities: () => ({}),
  },
}));

const {
  getTutorialTeachesMap,
  computeTutorialTeachesMap,
  bustTutorialTeachesCache,
} = await import('../../srv/lib/kg-tutorial-teaches-map.js');

const silentLog = { warn: () => {}, info: () => {} };

beforeEach(() => {
  bustTutorialTeachesCache();
  mockRun.mockReset();
});

describe('kg-tutorial-teaches-map', () => {
  it('computeTutorialTeachesMap builds Map<tutSlug, Set<conceptSlug>>', async () => {
    mockRun.mockResolvedValueOnce([
      { TUT_SLUG: 'tut-a', CONCEPT_SLUG: 'concept-1' },
      { TUT_SLUG: 'tut-a', CONCEPT_SLUG: 'concept-2' },
      { TUT_SLUG: 'tut-b', CONCEPT_SLUG: 'concept-1' },
    ]);
    const map = await computeTutorialTeachesMap(mockDb, silentLog);
    expect(map.size).toBe(2);
    expect([...map.get('tut-a')]).toEqual(['concept-1', 'concept-2']);
    expect([...map.get('tut-b')]).toEqual(['concept-1']);
  });

  it('drops rows with null tut or concept slugs', async () => {
    mockRun.mockResolvedValueOnce([
      { TUT_SLUG: 'tut-a', CONCEPT_SLUG: 'concept-1' },
      { TUT_SLUG: null,    CONCEPT_SLUG: 'concept-2' },
      { TUT_SLUG: 'tut-b', CONCEPT_SLUG: null },
    ]);
    const map = await computeTutorialTeachesMap(mockDb, silentLog);
    expect(map.size).toBe(1);
    expect(map.has('tut-a')).toBe(true);
  });

  it('getTutorialTeachesMap caches within the TTL window', async () => {
    mockRun.mockResolvedValue([
      { TUT_SLUG: 'tut-a', CONCEPT_SLUG: 'concept-1' },
    ]);
    await getTutorialTeachesMap(mockDb, silentLog);
    await getTutorialTeachesMap(mockDb, silentLog);
    await getTutorialTeachesMap(mockDb, silentLog);
    // Only ONE db.run — subsequent calls hit the cache.
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('bustTutorialTeachesCache forces a recompute on next call', async () => {
    mockRun.mockResolvedValue([{ TUT_SLUG: 'tut-a', CONCEPT_SLUG: 'concept-1' }]);
    await getTutorialTeachesMap(mockDb, silentLog);
    expect(mockRun).toHaveBeenCalledTimes(1);
    bustTutorialTeachesCache();
    await getTutorialTeachesMap(mockDb, silentLog);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('TTL expiry triggers a recompute', async () => {
    mockRun.mockResolvedValue([{ TUT_SLUG: 'tut-a', CONCEPT_SLUG: 'concept-1' }]);
    vi.useFakeTimers();
    try {
      await getTutorialTeachesMap(mockDb, silentLog);
      expect(mockRun).toHaveBeenCalledTimes(1);
      // Just under TTL: no recompute.
      vi.advanceTimersByTime(4 * 60 * 1000 + 59_000);
      await getTutorialTeachesMap(mockDb, silentLog);
      expect(mockRun).toHaveBeenCalledTimes(1);
      // Cross the TTL boundary.
      vi.advanceTimersByTime(2_000);
      await getTutorialTeachesMap(mockDb, silentLog);
      expect(mockRun).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces concurrent misses (one DB scan, not N)', async () => {
    let resolveRun;
    const pending = new Promise((r) => { resolveRun = r; });
    mockRun.mockReturnValueOnce(pending);

    // Fire three concurrent calls before any resolves.
    const p1 = getTutorialTeachesMap(mockDb, silentLog);
    const p2 = getTutorialTeachesMap(mockDb, silentLog);
    const p3 = getTutorialTeachesMap(mockDb, silentLog);

    // Now unblock the mock.
    resolveRun([{ TUT_SLUG: 'tut-a', CONCEPT_SLUG: 'concept-1' }]);
    const [m1, m2, m3] = await Promise.all([p1, p2, p3]);
    // Only ONE call to db.run — the other two awaited the inflight promise.
    expect(mockRun).toHaveBeenCalledTimes(1);
    // All three got the same Map instance.
    expect(m1).toBe(m2);
    expect(m2).toBe(m3);
  });
});
