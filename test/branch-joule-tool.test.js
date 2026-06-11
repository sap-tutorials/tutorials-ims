import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { GET_BRANCH_RECOMMENDATION_TOOL, getBranchRecommendationHandler } from '../srv/lib/branch/joule-tool.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET_BRANCH_RECOMMENDATION_TOOL', () => {
  it('exports an OpenAI-shaped tool definition', () => {
    expect(GET_BRANCH_RECOMMENDATION_TOOL.type).toBe('function');
    expect(GET_BRANCH_RECOMMENDATION_TOOL.function.name).toBe('getBranchRecommendation');
    expect(GET_BRANCH_RECOMMENDATION_TOOL.function.parameters.properties).toHaveProperty('missionSlug');
    expect(GET_BRANCH_RECOMMENDATION_TOOL.function.parameters.properties).toHaveProperty('tutorialSlug');
    expect(GET_BRANCH_RECOMMENDATION_TOOL.function.parameters.properties).toHaveProperty('branchPointId');
  });
});

describe('getBranchRecommendationHandler — param validation', () => {
  it('rejects when no params given', async () => {
    const result = await getBranchRecommendationHandler({ args: {}, user: null });
    expect(result.error).toMatch(/requires_at_least_one_of/);
  });

  it('rejects branchPointId without tutorialSlug', async () => {
    const result = await getBranchRecommendationHandler({
      args: { branchPointId: '1-deployment' }, user: null
    });
    expect(result.error).toMatch(/branchPointId requires tutorialSlug/);
  });
});

const TUT_SLUG = '__test__-tut-pr4';

describe('getBranchRecommendationHandler — tutorial scope', () => {
  beforeAll(async () => {
    const { BranchSpecs } = cds.entities('com.sap.developers.ims');
    await INSERT.into(BranchSpecs).entries({
      slug: TUT_SLUG,
      branchPoints: JSON.stringify([{
        id: '1-deployment',
        parentStepNumber: 1,
        groupKey: 'deployment',
        branches: [
          { key: 'hana',     label: 'HANA Cloud', condition: "profile.deployment == 'cloud'", embeddingHint: 'Configure HANA' },
          { key: 'postgres', label: 'PostgreSQL', condition: null, embeddingHint: 'Configure PG' },
        ],
      }, {
        id: '3-storage',
        parentStepNumber: 3,
        groupKey: 'storage',
        branches: [
          { key: 's3',     label: 'S3', condition: null, embeddingHint: null },
          { key: 'azure',  label: 'Azure Blob', condition: null, embeddingHint: null },
        ],
      }]),
      skipPoints: JSON.stringify([
        { stepNumber: 4, skipIf: 'completed:__test__-prereq', skipLabel: 'Skip', skipReason: 'You have it' },
      ]),
    });
  });

  afterAll(async () => {
    const { BranchSpecs } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BranchSpecs).where({ slug: TUT_SLUG });
  });

  it('returns branchPoints + skipPoints for the tutorial when anonymous', async () => {
    const result = await getBranchRecommendationHandler({
      args: { tutorialSlug: TUT_SLUG }, user: null
    });
    expect(result.error).toBeUndefined();
    expect(result.branchPoints).toHaveLength(2);
    expect(result.branchPoints[0].id).toBe('1-deployment');
    expect(result.branchPoints[0].picked).toBeTruthy();
    expect(result.branchPoints[0].reason).toBeDefined();
    expect(result.branchPoints[0].confidence).toBeDefined();
    expect(result.branchPoints[0].allBranches).toHaveLength(2);
    expect(result.skipPoints).toHaveLength(1);
    expect(result.skipPoints[0].stepNumber).toBe(4);
    expect(result.skipPoints[0].skip).toBe(false);
    expect(result.altGroups).toEqual([]);
  });

  it('scopes to one branchPoint when branchPointId given', async () => {
    const result = await getBranchRecommendationHandler({
      args: { tutorialSlug: TUT_SLUG, branchPointId: '1-deployment' }, user: null
    });
    expect(result.branchPoints).toHaveLength(1);
    expect(result.branchPoints[0].id).toBe('1-deployment');
  });

  it('rejects unknown branchPointId', async () => {
    const result = await getBranchRecommendationHandler({
      args: { tutorialSlug: TUT_SLUG, branchPointId: 'does-not-exist' }, user: null
    });
    expect(result.error).toMatch(/unknown_branch_point/);
  });

  it('returns empty + note when tutorial has no BranchSpecs row', async () => {
    const result = await getBranchRecommendationHandler({
      args: { tutorialSlug: 'no-such-tutorial' }, user: null
    });
    expect(result.branchPoints).toEqual([]);
    expect(result.altGroups).toEqual([]);
    expect(result.skipPoints).toEqual([]);
    expect(result.note).toBe('tutorial_has_no_branches');
  });

  it('lowercases tutorialSlug input', async () => {
    const result = await getBranchRecommendationHandler({
      args: { tutorialSlug: TUT_SLUG.toUpperCase() }, user: null
    });
    expect(result.branchPoints).toHaveLength(2);
  });

  it('writes one BranchDecisions row per branchPoint with source=jouleTool', async () => {
    const { BranchDecisions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BranchDecisions).where({ tutorialSlug: TUT_SLUG });

    await getBranchRecommendationHandler({
      args: { tutorialSlug: TUT_SLUG }, user: null
    });

    const rows = await SELECT.from(BranchDecisions).where({ tutorialSlug: TUT_SLUG });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every(r => r.source === 'jouleTool')).toBe(true);
    expect(rows.every(r => r.surface === 'tutorialBranch')).toBe(true);

    await DELETE.from(BranchDecisions).where({ tutorialSlug: TUT_SLUG });
  });
});
