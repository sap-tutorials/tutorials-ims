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

const MISSION_SLUG = '__test__-mission-pr4';
const MISSION_ID = 'aaaaaaaa-9400-0000-0000-000000000400';
const PATH_ID    = 'bbbbbbbb-9400-0000-0000-000000000400';
const TUT_HANA_ID = 'cccccccc-9400-0000-0000-000000000410';
const TUT_PG_ID   = 'cccccccc-9400-0000-0000-000000000420';

describe('getBranchRecommendationHandler — mission scope', () => {
  beforeAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries([
      { ID: TUT_HANA_ID, legacyId: 99410, slug: '__test__-pr4-hana', title: 'HANA', status: 'ACTIVE' },
      { ID: TUT_PG_ID,   legacyId: 99411, slug: '__test__-pr4-pg',   title: 'PG',   status: 'ACTIVE' },
    ]);
    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 99400, title: 'PR4 Mission', slug: MISSION_SLUG, published: true,
    });
    await INSERT.into(CompletionPaths).entries({
      ID: PATH_ID, legacyId: 99401, mission_ID: MISSION_ID, name: 'P1', slug: '__test__-pr4-p1',
    });
    await INSERT.into(CompletionPathItems).entries([
      { ID: 'dddddddd-9400-0000-0000-000000000410', legacyId: 99410, path_ID: PATH_ID, taskType: 'TUTORIAL', taskLegacyId: 99410, tutorial_ID: TUT_HANA_ID, itemOrder: 1, altGroupKey: 'deployment', altGroupLabel: 'HANA Cloud' },
      { ID: 'dddddddd-9400-0000-0000-000000000420', legacyId: 99411, path_ID: PATH_ID, taskType: 'TUTORIAL', taskLegacyId: 99411, tutorial_ID: TUT_PG_ID,   itemOrder: 1, altGroupKey: 'deployment', altGroupLabel: 'PostgreSQL' },
    ]);
  });

  afterAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ path_ID: PATH_ID });
    await DELETE.from(CompletionPaths).where({ ID: PATH_ID });
    await DELETE.from(Missions).where({ ID: MISSION_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [TUT_HANA_ID, TUT_PG_ID] } });
  });

  it('returns altGroups for a mission with alt-group items', async () => {
    const result = await getBranchRecommendationHandler({
      args: { missionSlug: MISSION_SLUG }, user: null
    });
    expect(result.error).toBeUndefined();
    expect(result.altGroups).toHaveLength(1);
    expect(result.altGroups[0].groupKey).toBe('deployment');
    expect(result.altGroups[0].picked).toBeTruthy();
    expect(result.altGroups[0].allBranches).toHaveLength(2);
  });

  it('combined tutorialSlug + missionSlug returns both arrays populated', async () => {
    const { BranchSpecs } = cds.entities('com.sap.developers.ims');
    // Re-seed BranchSpecs since prior describe afterAll may have deleted it
    const existing = await SELECT.one.from(BranchSpecs).where({ slug: TUT_SLUG });
    if (!existing) {
      await INSERT.into(BranchSpecs).entries({
        slug: TUT_SLUG,
        branchPoints: JSON.stringify([{
          id: '1-deployment',
          parentStepNumber: 1,
          groupKey: 'deployment',
          branches: [
            { key: 'hana',     label: 'HANA Cloud', condition: null, embeddingHint: null },
            { key: 'postgres', label: 'PostgreSQL', condition: null, embeddingHint: null },
          ],
        }]),
        skipPoints: JSON.stringify([]),
      });
    }
    const result = await getBranchRecommendationHandler({
      args: { tutorialSlug: TUT_SLUG, missionSlug: MISSION_SLUG }, user: null
    });
    expect(result.branchPoints.length).toBeGreaterThan(0);
    expect(result.altGroups.length).toBeGreaterThan(0);
    if (!existing) {
      await DELETE.from(BranchSpecs).where({ slug: TUT_SLUG });
    }
  });
});

describe('getBranchRecommendationHandler — mission with no alt-groups', () => {
  const PLAIN_MISSION_SLUG = '__test__-plain-mission-pr4';
  const PLAIN_MISSION_ID = 'aaaaaaaa-9402-0000-0000-000000000402';
  const PLAIN_PATH_ID = 'bbbbbbbb-9402-0000-0000-000000000402';

  beforeAll(async () => {
    const { Missions, CompletionPaths } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Missions).entries({
      ID: PLAIN_MISSION_ID, legacyId: 99402, title: 'Plain', slug: PLAIN_MISSION_SLUG, published: true,
    });
    await INSERT.into(CompletionPaths).entries({
      ID: PLAIN_PATH_ID, legacyId: 99403, mission_ID: PLAIN_MISSION_ID, name: 'P', slug: '__test__-pr4-plain-p',
    });
  });

  afterAll(async () => {
    const { Missions, CompletionPaths } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPaths).where({ ID: PLAIN_PATH_ID });
    await DELETE.from(Missions).where({ ID: PLAIN_MISSION_ID });
  });

  it('returns altGroups: [] + note when mission has no alt-group items', async () => {
    const result = await getBranchRecommendationHandler({
      args: { missionSlug: PLAIN_MISSION_SLUG }, user: null
    });
    expect(result.altGroups).toEqual([]);
    expect(result.note).toBe('mission_has_no_alt_groups');
  });
});
