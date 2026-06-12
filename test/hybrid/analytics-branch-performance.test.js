import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const SLUG_BRANCH = '__test__-pr5-hybrid-branch';
const SLUG_TOP    = '__test__-pr5-hybrid-top';
const writesEnabled = process.env.ALLOW_HYBRID_WRITES === 'true';

describe('AnalyticsBranchPerformance + TopPick (hybrid HANA)', () => {
  beforeAll(async () => {
    if (!writesEnabled) return;
    if (!isSafeForWrites()) throw new Error('refusing to write to a prod-shaped target');
    const { BranchDecisions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BranchDecisions).where({ tutorialSlug: { like: '__test__-pr5-hybrid-%' } });
  });

  afterAll(async () => {
    if (!writesEnabled) return;
    const { BranchDecisions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BranchDecisions).where({ tutorialSlug: { like: '__test__-pr5-hybrid-%' } });
  });

  it.skipIf(process.env.ALLOW_HYBRID_WRITES !== 'true')(
    'aggregates BranchDecisions into AnalyticsBranchPerformance on HANA',
    async () => {
      const { BranchDecisions, AnalyticsBranchPerformance } = cds.entities('com.sap.developers.ims');
      const rows = [];
      for (let i = 0; i < 30; i++) rows.push({ user_ID: null, surface: 'tutorialBranch', missionSlug: null, tutorialSlug: SLUG_BRANCH, branchPointId: 'bp1', recommendedKey: 'hana',     chosenKey: null, recommendationKind: 'condition', confidence: 0.95, source: 'pageLoad',  followedRecommendation: i < 25 ? true : null });
      for (let i = 0; i < 5;  i++) rows.push({ user_ID: null, surface: 'tutorialBranch', missionSlug: null, tutorialSlug: SLUG_BRANCH, branchPointId: 'bp1', recommendedKey: 'postgres', chosenKey: null, recommendationKind: 'default',   confidence: 0,    source: 'jouleTool', followedRecommendation: null });
      for (const r of rows) await INSERT.into(BranchDecisions).entries(r);

      const result = await SELECT.from(AnalyticsBranchPerformance).where({ tutorialSlug: SLUG_BRANCH });
      expect(result).toHaveLength(1);
      expect(result[0].total).toBe(35);
      expect(result[0].byCondition).toBe(30);
      expect(result[0].byRanker).toBe(0);
      expect(result[0].byDefault).toBe(5);
      expect(result[0].clickedTotal).toBe(25);
      expect(result[0].followed).toBe(25);
      expect(result[0].bySrcJouleTool).toBe(5);
      expect(result[0].bySrcPageLoad).toBe(30);
    }
  );

  it.skipIf(process.env.ALLOW_HYBRID_WRITES !== 'true')(
    'AnalyticsBranchTopPick aggregates per recommendedKey on HANA',
    async () => {
      const { BranchDecisions, AnalyticsBranchTopPick } = cds.entities('com.sap.developers.ims');
      for (let i = 0; i < 10; i++) await INSERT.into(BranchDecisions).entries({ user_ID: null, surface: 'tutorialBranch', missionSlug: null, tutorialSlug: SLUG_TOP, branchPointId: 'bp1', recommendedKey: 'hana',     chosenKey: null, recommendationKind: 'condition', confidence: 1, source: 'pageLoad', followedRecommendation: null });
      for (let i = 0; i < 3;  i++) await INSERT.into(BranchDecisions).entries({ user_ID: null, surface: 'tutorialBranch', missionSlug: null, tutorialSlug: SLUG_TOP, branchPointId: 'bp1', recommendedKey: 'postgres', chosenKey: null, recommendationKind: 'default',   confidence: 0, source: 'pageLoad', followedRecommendation: null });

      const result = await SELECT.from(AnalyticsBranchTopPick).where({ tutorialSlug: SLUG_TOP }).orderBy('pickedCount desc');
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ recommendedKey: 'hana',     pickedCount: 10 });
      expect(result[1]).toMatchObject({ recommendedKey: 'postgres', pickedCount: 3 });
    }
  );

  it.skipIf(process.env.ALLOW_HYBRID_WRITES !== 'true')(
    'merge layer + view combine to a deterministic top-pick on HANA',
    async () => {
      // Reuses the data from the 1st test (still in DB if afterAll defers).
      const { mergeBranchPerf } = await import('../../scripts/lib/merge-branch-perf.js');
      const { AnalyticsBranchPerformance, AnalyticsBranchTopPick } = cds.entities('com.sap.developers.ims');
      const perf = await SELECT.from(AnalyticsBranchPerformance).where({ tutorialSlug: SLUG_BRANCH });
      const top  = await SELECT.from(AnalyticsBranchTopPick).where({ tutorialSlug: SLUG_BRANCH });
      const merged = mergeBranchPerf(perf, top);
      expect(merged).toHaveLength(1);
      expect(merged[0].pickedKeyTop).toBe('hana');     // 30 of 35 picks
      expect(merged[0].pickedKeyTopShare).toBeCloseTo(30 / 35, 4);
      expect(merged[0].followRate).toBeCloseTo(1.0, 4);  // 25 / 25
      expect(merged[0].clickRate).toBeCloseTo(25 / 35, 4);
    }
  );
});
