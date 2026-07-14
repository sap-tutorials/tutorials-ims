import { describe, it, expect } from 'vitest';
import { computeCoverage, resolveThreshold } from '../../srv/lib/kg-community-coverage.js';

const T = 70;

describe('computeCoverage', () => {
  it('tutorials-only denominator: 2 of 4 covered → 50%', () => {
    const members = new Map([[1, ['a', 'b', 'c', 'd']]]);
    const covered = [
      { slug: 'a', missionTitle: 'M1', missionSlug: 'm1' },
      { slug: 'b', missionTitle: 'M1', missionSlug: 'm1' },
    ];
    const r = computeCoverage({ memberSlugsByCommunity: members, coveredRows: covered, threshold: T }).get(1);
    expect(r.missionCoveragePct).toBe(50);
    expect(r.orphanTutorialCount).toBe(2);
    expect(r.dominantMissionTitle).toBe('M1');
    expect(r.dominantMissionSlug).toBe('m1');
    expect(r.coverageHigh).toBe(false);
  });

  it('dominant mission = the one covering the most members; tie broken by title asc', () => {
    const members = new Map([[1, ['a', 'b', 'c', 'd']]]);
    const covered = [
      { slug: 'a', missionTitle: 'Zeta', missionSlug: 'zeta' },
      { slug: 'b', missionTitle: 'Alpha', missionSlug: 'alpha' },
    ]; // 1 each → tie → 'Alpha' wins on title asc
    const r = computeCoverage({ memberSlugsByCommunity: members, coveredRows: covered, threshold: T }).get(1);
    expect(r.dominantMissionTitle).toBe('Alpha');
    expect(r.dominantMissionSlug).toBe('alpha');
  });

  it('a tutorial counted once even if in two missions (coverage dedupe by slug)', () => {
    const members = new Map([[1, ['a', 'b']]]);
    const covered = [
      { slug: 'a', missionTitle: 'M1', missionSlug: 'm1' },
      { slug: 'a', missionTitle: 'M2', missionSlug: 'm2' },
    ]; // only 'a' covered → 1 of 2 = 50%, M1 dominant (title asc tie among 1-each)
    const r = computeCoverage({ memberSlugsByCommunity: members, coveredRows: covered, threshold: T }).get(1);
    expect(r.missionCoveragePct).toBe(50);
    expect(r.orphanTutorialCount).toBe(1);
  });

  it('coverageHigh boundary: 69 false, 70 true, 71 true', () => {
    const mk = (n, total) => {
      const members = new Map([[1, Array.from({ length: total }, (_, i) => `t${i}`)]]);
      const covered = Array.from({ length: n }, (_, i) => ({ slug: `t${i}`, missionTitle: 'M', missionSlug: 'm' }));
      return computeCoverage({ memberSlugsByCommunity: members, coveredRows: covered, threshold: 70 }).get(1);
    };
    expect(mk(69, 100).coverageHigh).toBe(false); // 69%
    expect(mk(70, 100).coverageHigh).toBe(true);  // 70%
    expect(mk(71, 100).coverageHigh).toBe(true);  // 71%
  });

  it('rounds to nearest integer (1 of 3 = 33%)', () => {
    const members = new Map([[1, ['a', 'b', 'c']]]);
    const covered = [{ slug: 'a', missionTitle: 'M', missionSlug: 'm' }];
    expect(computeCoverage({ memberSlugsByCommunity: members, coveredRows: covered, threshold: T }).get(1).missionCoveragePct).toBe(33);
  });

  it('no coverage: 0%, all orphaned, no dominant mission', () => {
    const members = new Map([[1, ['a', 'b']]]);
    const r = computeCoverage({ memberSlugsByCommunity: members, coveredRows: [], threshold: T }).get(1);
    expect(r.missionCoveragePct).toBe(0);
    expect(r.orphanTutorialCount).toBe(2);
    expect(r.dominantMissionTitle).toBeNull();
    expect(r.dominantMissionSlug).toBeNull();
    expect(r.coverageHigh).toBe(false);
  });

  it('0-tutorial community → pct and orphanCount unset (null), not 0', () => {
    const members = new Map([[1, []]]);
    const r = computeCoverage({ memberSlugsByCommunity: members, coveredRows: [], threshold: T }).get(1);
    expect(r.missionCoveragePct).toBeNull();
    expect(r.orphanTutorialCount).toBeNull();
    expect(r.coverageHigh).toBe(false);
  });

  it('covered rows for slugs not in the community are ignored', () => {
    const members = new Map([[1, ['a']]]);
    const covered = [{ slug: 'x', missionTitle: 'M', missionSlug: 'm' }];
    const r = computeCoverage({ memberSlugsByCommunity: members, coveredRows: covered, threshold: T }).get(1);
    expect(r.missionCoveragePct).toBe(0);
    expect(r.orphanTutorialCount).toBe(1);
  });
});

describe('resolveThreshold', () => {
  it('defaults to 70 when unset', () => { expect(resolveThreshold({})).toBe(70); });
  it('reads a valid override', () => { expect(resolveThreshold({ KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD: '80' })).toBe(80); });
  it('falls back to 70 on NaN', () => { expect(resolveThreshold({ KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD: 'abc' })).toBe(70); });
  it('clamps out-of-range to 70', () => { expect(resolveThreshold({ KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD: '150' })).toBe(70); });
});
