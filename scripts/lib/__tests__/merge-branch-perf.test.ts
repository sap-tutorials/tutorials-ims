import { describe, it, expect } from 'vitest';
import { mergeBranchPerf } from '../merge-branch-perf';

describe('mergeBranchPerf', () => {
  it('returns empty array for empty input', () => {
    expect(mergeBranchPerf([], [])).toEqual([]);
  });

  it('merges a single performance row with no top-pick rows (degenerate)', () => {
    const perf = [{
      missionSlug: 'm1', tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
      total: 0, byCondition: 0, byRanker: 0, byDefault: 0,
      clickedTotal: 0, followed: 0, avgConfidence: null,
      bySrcJouleTool: 0, bySrcPageLoad: 0, bySrcClick: 0, firstSeenAt: null,
    }];
    const result = mergeBranchPerf(perf, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      missionSlug: 'm1', tutorialSlug: 't1', branchPointId: 'b1',
      total: 0, pickedKeyTop: null, pickedKeyTopShare: null,
      followRate: null, clickRate: null,
    });
  });

  it('computes pickedKeyTop + pickedKeyTopShare from top-pick rows', () => {
    const perf = [{
      missionSlug: 'm1', tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
      total: 10, byCondition: 10, byRanker: 0, byDefault: 0,
      clickedTotal: 7, followed: 7, avgConfidence: 0.9,
      bySrcJouleTool: 0, bySrcPageLoad: 10, bySrcClick: 0, firstSeenAt: '2026-06-01T00:00:00Z',
    }];
    const top = [
      { missionSlug: 'm1', tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', recommendedKey: 'hana',     pickedCount: 7 },
      { missionSlug: 'm1', tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', recommendedKey: 'postgres', pickedCount: 3 },
    ];
    const result = mergeBranchPerf(perf, top);
    expect(result).toHaveLength(1);
    expect(result[0].pickedKeyTop).toBe('hana');
    expect(result[0].pickedKeyTopShare).toBeCloseTo(0.7, 4);
    expect(result[0].followRate).toBeCloseTo(1.0, 4);  // 7 followed of 7 clicked
    expect(result[0].clickRate).toBeCloseTo(0.7, 4);   // 7 clicked of 10 total
  });

  it('handles ties on pickedCount deterministically (alphabetical recommendedKey)', () => {
    const perf = [{
      missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
      total: 10, byCondition: 10, byRanker: 0, byDefault: 0,
      clickedTotal: 0, followed: 0, avgConfidence: 0.5,
      bySrcJouleTool: 0, bySrcPageLoad: 10, bySrcClick: 0, firstSeenAt: null,
    }];
    const top = [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', recommendedKey: 'zebra', pickedCount: 5 },
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', recommendedKey: 'alpha', pickedCount: 5 },
    ];
    const result = mergeBranchPerf(perf, top);
    expect(result[0].pickedKeyTop).toBe('alpha');  // alphabetical tie-break
    expect(result[0].pickedKeyTopShare).toBeCloseTo(0.5, 4);
  });

  it('joins on (missionSlug, tutorialSlug, branchPointId, surface) with null missionSlug equality', () => {
    const perf = [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', total: 5,  byCondition: 5,  byRanker: 0, byDefault: 0, clickedTotal: 0, followed: 0, avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 5,  bySrcClick: 0, firstSeenAt: null },
      { missionSlug: 'm1', tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', total: 10, byCondition: 10, byRanker: 0, byDefault: 0, clickedTotal: 0, followed: 0, avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 10, bySrcClick: 0, firstSeenAt: null },
    ];
    const top = [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', recommendedKey: 'a', pickedCount: 5  },
      { missionSlug: 'm1', tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', recommendedKey: 'b', pickedCount: 10 },
    ];
    const result = mergeBranchPerf(perf, top);
    expect(result).toHaveLength(2);
    const tut = result.find(r => r.missionSlug === null);
    const mis = result.find(r => r.missionSlug === 'm1');
    expect(tut?.pickedKeyTop).toBe('a');
    expect(mis?.pickedKeyTop).toBe('b');
  });

  it('clickRate is null when total is 0 (avoids divide-by-zero NaN)', () => {
    const perf = [{
      missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
      total: 0, byCondition: 0, byRanker: 0, byDefault: 0,
      clickedTotal: 0, followed: 0, avgConfidence: null,
      bySrcJouleTool: 0, bySrcPageLoad: 0, bySrcClick: 0, firstSeenAt: null,
    }];
    const result = mergeBranchPerf(perf, []);
    expect(result[0].clickRate).toBeNull();
    expect(result[0].followRate).toBeNull();
  });

  it('followRate is null when clickedTotal is 0 even if total > 0', () => {
    const perf = [{
      missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
      total: 10, byCondition: 10, byRanker: 0, byDefault: 0,
      clickedTotal: 0, followed: 0, avgConfidence: 0.5,
      bySrcJouleTool: 0, bySrcPageLoad: 10, bySrcClick: 0, firstSeenAt: null,
    }];
    const result = mergeBranchPerf(perf, []);
    expect(result[0].followRate).toBeNull();
    expect(result[0].clickRate).toBe(0);  // 0 / 10 = 0 (deterministic), distinct from null-total
  });
});
