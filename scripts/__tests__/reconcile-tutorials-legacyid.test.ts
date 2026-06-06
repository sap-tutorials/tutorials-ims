import { describe, it, expect } from 'vitest';

import helpersDefault from '../lib/cpi-reconcile-helpers.cjs';
const { deriveSlug, scoreCanonicalUrl, pickBestImsTask, planUpdates } = helpersDefault as {
  deriveSlug: (url: string | null | undefined) => string | null;
  scoreCanonicalUrl: (url: string | null | undefined) => number;
  pickBestImsTask: (candidates: Array<{ ID: number; URL: string; TASK_STATUS: string | null }>) =>
    | { ID: number; URL: string; score: number }
    | null;
  planUpdates: (
    tutorialRows: Array<{ ID: string; SLUG: string; LEGACYID: number | null }>,
    imsTasksBySlug: Map<string, Array<{ ID: number; URL: string; TASK_STATUS: string | null }>>,
  ) => {
    updates: Array<{
      tutorialId: string;
      slug: string;
      newLegacyId: number;
      oldLegacyId: number | null;
      score: number;
      url: string;
    }>;
    stats: {
      matched: number;
      alreadyCorrect: number;
      noImsMatch: number;
      onlyDeletedMatches: number;
      candidates: number;
    };
  };
};

describe('reconcile-tutorials-legacyid helpers', () => {
  describe('deriveSlug', () => {
    it('extracts slug from a canonical sap-tutorials URL', () => {
      const url = 'https://github.com/sap-tutorials/Tutorials/blob/master/tutorials/abap-cloud-ui-from-interface/abap-cloud-ui-from-interface.md';
      expect(deriveSlug(url)).toBe('abap-cloud-ui-from-interface');
    });

    it('extracts slug from a personal-fork URL too', () => {
      const url = 'https://github.com/maximilianone/Tutorials/blob/master/tutorials/abap-connectivity-daemon-mqtt-bridge/abap-connectivity-daemon-mqtt-bridge.md';
      expect(deriveSlug(url)).toBe('abap-connectivity-daemon-mqtt-bridge');
    });

    it('returns null for empty/null input', () => {
      expect(deriveSlug(null as any)).toBeNull();
      expect(deriveSlug('')).toBeNull();
      expect(deriveSlug(undefined as any)).toBeNull();
    });

    it('returns null when URL does not end in .md', () => {
      expect(deriveSlug('https://github.com/x/y/blob/master/tutorials/abc/abc')).toBeNull();
      expect(deriveSlug('https://github.com/x/y/blob/master/tutorials/abc/abc.html')).toBeNull();
    });

    it('returns null for URLs with non-canonical slugs (spaces, special chars)', () => {
      expect(deriveSlug('https://github.com/darkina/forTestGreen/blob/master/tutorials/Daria%20TG%203/Daria%20TG.md')).toBeNull();
      expect(deriveSlug('https://github.com/x/y/blob/master/tutorials/foo/has spaces.md')).toBeNull();
      // Slug with leading hyphen rejected
      expect(deriveSlug('https://github.com/x/y/blob/master/tutorials/foo/-leading-hyphen.md')).toBeNull();
    });

    it('lowercases slug for canonical comparison', () => {
      expect(deriveSlug('https://github.com/x/y/blob/master/tutorials/foo/Bar-Baz.md')).toBe('bar-baz');
    });

    it('handles URLs with query/fragment', () => {
      expect(deriveSlug('https://github.com/x/y/blob/master/tutorials/foo/abc.md?ref=main')).toBe('abc');
      expect(deriveSlug('https://github.com/x/y/blob/master/tutorials/foo/abc.md#L42')).toBe('abc');
    });
  });

  describe('scoreCanonicalUrl', () => {
    it('rewards canonical sap-tutorials org', () => {
      const score = scoreCanonicalUrl('https://github.com/sap-tutorials/Tutorials/blob/master/tutorials/x/x.md');
      expect(score).toBeGreaterThanOrEqual(1000);
    });

    it('rewards master/main branch', () => {
      const masterUrl = 'https://github.com/x/y/blob/master/tutorials/a/a.md';
      const branchUrl = 'https://github.com/x/y/blob/some-feature-branch/tutorials/a/a.md';
      expect(scoreCanonicalUrl(masterUrl)).toBeGreaterThan(scoreCanonicalUrl(branchUrl));
    });

    it('returns 0 for empty/null input (not negative)', () => {
      expect(scoreCanonicalUrl(null as any)).toBe(0);
      expect(scoreCanonicalUrl('')).toBe(0);
    });

    it('does NOT penalize personal forks (intentional looseness)', () => {
      // IMS prod is heavy on personal forks; loose scoring lets us match them
      // when no canonical sap-tutorials match exists.
      const personalFork = 'https://github.com/maximilianone/Tutorials/blob/master/tutorials/x/x.md';
      expect(scoreCanonicalUrl(personalFork)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('pickBestImsTask', () => {
    it('returns null when all candidates are DELETED', () => {
      const candidates = [
        { ID: 1, URL: 'https://github.com/x/y/blob/master/tutorials/a/a.md', TASK_STATUS: 'DELETED' },
        { ID: 2, URL: 'https://github.com/x/y/blob/master/tutorials/a/a.md', TASK_STATUS: 'DELETED' },
      ];
      expect(pickBestImsTask(candidates)).toBeNull();
    });

    it('prefers canonical sap-tutorials over personal forks', () => {
      const candidates = [
        { ID: 100, URL: 'https://github.com/maximilianone/Tutorials/blob/master/tutorials/x/x.md', TASK_STATUS: null },
        { ID: 200, URL: 'https://github.com/sap-tutorials/Tutorials/blob/master/tutorials/x/x.md', TASK_STATUS: null },
      ];
      expect(pickBestImsTask(candidates)?.ID).toBe(200);
    });

    it('breaks ties by lowest ID (oldest first)', () => {
      // Both same scoring (master branch, non-canonical org)
      const candidates = [
        { ID: 999, URL: 'https://github.com/x/y/blob/master/tutorials/a/a.md', TASK_STATUS: null },
        { ID: 100, URL: 'https://github.com/x/y/blob/master/tutorials/a/a.md', TASK_STATUS: null },
        { ID: 500, URL: 'https://github.com/x/y/blob/master/tutorials/a/a.md', TASK_STATUS: null },
      ];
      expect(pickBestImsTask(candidates)?.ID).toBe(100);
    });

    it('skips DELETED candidates even when they are the highest-scored', () => {
      const candidates = [
        { ID: 100, URL: 'https://github.com/sap-tutorials/Tutorials/blob/master/tutorials/x/x.md', TASK_STATUS: 'DELETED' },
        { ID: 200, URL: 'https://github.com/maximilianone/Tutorials/blob/master/tutorials/x/x.md', TASK_STATUS: null },
      ];
      // Even though sap-tutorials is preferred by score, it's DELETED so we get the personal fork
      expect(pickBestImsTask(candidates)?.ID).toBe(200);
    });
  });

  describe('planUpdates', () => {
    it('returns no updates when TUTORIALS list is empty', () => {
      const result = planUpdates([], new Map());
      expect(result.updates).toEqual([]);
      expect(result.stats).toMatchObject({ matched: 0, alreadyCorrect: 0, noImsMatch: 0 });
    });

    it('produces an update for each match', () => {
      const tutorialRows = [
        { ID: 'tut-1', SLUG: 'abc', LEGACYID: 20000 },
        { ID: 'tut-2', SLUG: 'def', LEGACYID: 20001 },
      ];
      const imsTasksBySlug = new Map([
        ['abc', [{ ID: 100, URL: 'https://github.com/x/y/blob/master/tutorials/abc/abc.md', TASK_STATUS: null }]],
        ['def', [{ ID: 200, URL: 'https://github.com/x/y/blob/master/tutorials/def/def.md', TASK_STATUS: null }]],
      ]);
      const result = planUpdates(tutorialRows, imsTasksBySlug);
      expect(result.updates).toHaveLength(2);
      expect(result.updates[0]).toMatchObject({ tutorialId: 'tut-1', newLegacyId: 100, oldLegacyId: 20000, slug: 'abc' });
      expect(result.stats.matched).toBe(2);
    });

    it('skips rows where LEGACYID is already correct (idempotent)', () => {
      const tutorialRows = [
        { ID: 'tut-1', SLUG: 'abc', LEGACYID: 100 },  // already matches
      ];
      const imsTasksBySlug = new Map([
        ['abc', [{ ID: 100, URL: 'https://github.com/x/y/blob/master/tutorials/abc/abc.md', TASK_STATUS: null }]],
      ]);
      const result = planUpdates(tutorialRows, imsTasksBySlug);
      expect(result.updates).toHaveLength(0);
      expect(result.stats.alreadyCorrect).toBe(1);
    });

    it('counts no-IMS-match separately from only-DELETED-match', () => {
      const tutorialRows = [
        { ID: 'tut-1', SLUG: 'no-match', LEGACYID: 20000 },
        { ID: 'tut-2', SLUG: 'all-deleted', LEGACYID: 20001 },
      ];
      const imsTasksBySlug = new Map([
        ['all-deleted', [{ ID: 999, URL: 'https://github.com/x/y/blob/master/tutorials/x/x.md', TASK_STATUS: 'DELETED' }]],
      ]);
      const result = planUpdates(tutorialRows, imsTasksBySlug);
      expect(result.updates).toHaveLength(0);
      expect(result.stats.noImsMatch).toBe(1);
      expect(result.stats.onlyDeletedMatches).toBe(1);
    });

    it('lowercase-normalizes slug for lookup', () => {
      const tutorialRows = [
        { ID: 'tut-1', SLUG: 'Abc-Def', LEGACYID: null },
      ];
      const imsTasksBySlug = new Map([
        ['abc-def', [{ ID: 100, URL: 'https://github.com/x/y/blob/master/tutorials/abc-def/abc-def.md', TASK_STATUS: null }]],
      ]);
      const result = planUpdates(tutorialRows, imsTasksBySlug);
      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].newLegacyId).toBe(100);
    });

    it('handles null LEGACYID without crashing', () => {
      const tutorialRows = [
        { ID: 'tut-1', SLUG: 'abc', LEGACYID: null },
      ];
      const imsTasksBySlug = new Map([
        ['abc', [{ ID: 100, URL: 'https://github.com/x/y/blob/master/tutorials/abc/abc.md', TASK_STATUS: null }]],
      ]);
      const result = planUpdates(tutorialRows, imsTasksBySlug);
      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].oldLegacyId).toBeNull();
    });
  });
});
