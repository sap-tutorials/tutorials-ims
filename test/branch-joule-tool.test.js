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
