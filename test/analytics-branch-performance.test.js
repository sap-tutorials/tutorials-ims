import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const RUN_ID = 'aaaaaaaa-9500-0000-0000-000000000001'; // stable test prefix

describe('AnalyticsBranchPerformance view', () => {
  beforeAll(async () => {
    const { BranchDecisions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BranchDecisions).where({ tutorialSlug: { like: '__test__-pr5-%' } });
  });

  afterAll(async () => {
    const { BranchDecisions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BranchDecisions).where({ tutorialSlug: { like: '__test__-pr5-%' } });
  });

  it('returns 0 rows when BranchDecisions is empty for the slug', async () => {
    const { AnalyticsBranchPerformance } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AnalyticsBranchPerformance).where({ tutorialSlug: '__test__-pr5-empty' });
    expect(rows).toHaveLength(0);
  });

  it('aggregates one branchPoint with 10 decisions into one row', async () => {
    const { BranchDecisions, AnalyticsBranchPerformance } = cds.entities('com.sap.developers.ims');
    const slug = '__test__-pr5-one';
    for (let i = 0; i < 10; i++) {
      await INSERT.into(BranchDecisions).entries({
        user_ID: null,
        surface: 'tutorialBranch',
        missionSlug: null, tutorialSlug: slug, branchPointId: '1-deployment',
        recommendedKey: 'hana', chosenKey: null,
        recommendationKind: 'condition', confidence: 1.0,
        source: 'pageLoad', followedRecommendation: i < 7 ? true : null,
      });
    }
    const rows = await SELECT.from(AnalyticsBranchPerformance).where({ tutorialSlug: slug });
    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(10);
    expect(rows[0].byCondition).toBe(10);
    expect(rows[0].byRanker).toBe(0);
    expect(rows[0].byDefault).toBe(0);
    expect(rows[0].clickedTotal).toBe(7);  // 7 had non-null followedRecommendation
    expect(rows[0].followed).toBe(7);      // all 7 were true
    expect(rows[0].bySrcPageLoad).toBe(10);
    expect(rows[0].bySrcJouleTool).toBe(0);
  });

  it('aggregates two branchPoints with mixed kinds and sources', async () => {
    const { BranchDecisions, AnalyticsBranchPerformance } = cds.entities('com.sap.developers.ims');
    const slug = '__test__-pr5-two';
    // 50 decisions for branchPoint 1: 35 hana (28 followed), 15 pg (5 followed); some via Joule
    const rows = [];
    for (let i = 0; i < 35; i++) rows.push({ surface: 'tutorialBranch', tutorialSlug: slug, branchPointId: '1-deployment', recommendedKey: 'hana',     recommendationKind: i < 30 ? 'condition' : 'ranker', confidence: 0.9, source: i < 30 ? 'pageLoad' : 'jouleTool', followedRecommendation: i < 28 ? true : null });
    for (let i = 0; i < 15; i++) rows.push({ surface: 'tutorialBranch', tutorialSlug: slug, branchPointId: '1-deployment', recommendedKey: 'postgres', recommendationKind: 'default', confidence: 0,   source: 'pageLoad', followedRecommendation: i < 5 ? true : null });
    for (const r of rows) await INSERT.into(BranchDecisions).entries({ user_ID: null, missionSlug: null, chosenKey: null, ...r });

    const result = await SELECT.from(AnalyticsBranchPerformance).where({ tutorialSlug: slug });
    expect(result).toHaveLength(1);
    expect(result[0].total).toBe(50);
    expect(result[0].byCondition).toBe(30);
    expect(result[0].byRanker).toBe(5);
    expect(result[0].byDefault).toBe(15);
    expect(result[0].clickedTotal).toBe(33);  // 28 + 5
    expect(result[0].followed).toBe(33);
    expect(result[0].bySrcJouleTool).toBe(5);
    expect(result[0].bySrcPageLoad).toBe(45);
  });

  it('aggregates skip-point rows separately by surface', async () => {
    const { BranchDecisions, AnalyticsBranchPerformance } = cds.entities('com.sap.developers.ims');
    const slug = '__test__-pr5-skip';
    await INSERT.into(BranchDecisions).entries([
      { user_ID: null, surface: 'tutorialBranch', missionSlug: null, tutorialSlug: slug, branchPointId: '1-deployment', recommendedKey: 'hana', chosenKey: null, recommendationKind: 'condition', confidence: 1, source: 'pageLoad', followedRecommendation: true },
      { user_ID: null, surface: 'tutorialSkip',   missionSlug: null, tutorialSlug: slug, branchPointId: 'step-4',       recommendedKey: 'skip', chosenKey: 'skip', recommendationKind: 'condition', confidence: 1, source: 'pageLoad', followedRecommendation: true },
    ]);
    const result = await SELECT.from(AnalyticsBranchPerformance).where({ tutorialSlug: slug }).orderBy('surface');
    expect(result).toHaveLength(2);
    expect(result[0].surface).toBe('tutorialBranch');
    expect(result[1].surface).toBe('tutorialSkip');
  });

});

describe('AnalyticsBranchTopPick view', () => {
  it('aggregates by recommendedKey for downstream pickedKeyTop merge', async () => {
    const { BranchDecisions, AnalyticsBranchTopPick } = cds.entities('com.sap.developers.ims');
    const slug = '__test__-pr5-top';
    for (let i = 0; i < 7; i++) await INSERT.into(BranchDecisions).entries({ user_ID: null, surface: 'tutorialBranch', missionSlug: null, tutorialSlug: slug, branchPointId: '1-deployment', recommendedKey: 'hana',     chosenKey: null, recommendationKind: 'condition', confidence: 1, source: 'pageLoad', followedRecommendation: null });
    for (let i = 0; i < 3; i++) await INSERT.into(BranchDecisions).entries({ user_ID: null, surface: 'tutorialBranch', missionSlug: null, tutorialSlug: slug, branchPointId: '1-deployment', recommendedKey: 'postgres', chosenKey: null, recommendationKind: 'default',   confidence: 0, source: 'pageLoad', followedRecommendation: null });

    const rows = await SELECT.from(AnalyticsBranchTopPick).where({ tutorialSlug: slug }).orderBy('pickedCount desc');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ recommendedKey: 'hana',     pickedCount: 7 });
    expect(rows[1]).toMatchObject({ recommendedKey: 'postgres', pickedCount: 3 });
  });
});
