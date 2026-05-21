// srv/__tests__/tutorial-feedback-aggregate.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

process.env.SUBMISSION_SALT_SECRET = 'test-secret';

cds.test('serve', '--project', '.', '--in-memory');

describe('TutorialFeedbackAggregate', () => {
  beforeAll(async () => {
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TutorialFeedback).entries([
      // Slug A: 4 rows — 2 promoters (10, 9), 2 detractors (5, 3)
      {
        ID: cds.utils.uuid(),
        tutorialSlug: 'agg-test',
        npsScore: 10,
        ratingUseCase: 8,
        ratingRelevance: 9
      },
      {
        ID: cds.utils.uuid(),
        tutorialSlug: 'agg-test',
        npsScore: 9,
        ratingUseCase: null,
        ratingRelevance: null
      },
      {
        ID: cds.utils.uuid(),
        tutorialSlug: 'agg-test',
        npsScore: 5,
        ratingUseCase: 2,
        ratingRelevance: 4
      },
      {
        ID: cds.utils.uuid(),
        tutorialSlug: 'agg-test',
        npsScore: 3,
        ratingUseCase: 4,
        ratingRelevance: null
      },
      // Slug B: 2 rows — 1 promoter (9), 0 detractors
      {
        ID: cds.utils.uuid(),
        tutorialSlug: 'agg-test-other',
        npsScore: 9,
        ratingUseCase: 7,
        ratingRelevance: 8
      },
      {
        ID: cds.utils.uuid(),
        tutorialSlug: 'agg-test-other',
        npsScore: 8,
        ratingUseCase: 6,
        ratingRelevance: 7
      }
    ]);
  });

  afterAll(async () => {
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TutorialFeedback)
      .where({ tutorialSlug: { in: ['agg-test', 'agg-test-other'] } });
  });

  it('groups by slug with correct counts and NPS arithmetic', async () => {
    const { TutorialFeedbackAggregate } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one
      .from(TutorialFeedbackAggregate)
      .where({ tutorialSlug: 'agg-test' });

    expect(row).toBeTruthy();
    expect(row.responseCount).toBe(4);
    expect(row.promoters).toBe(2);
    expect(row.detractors).toBe(2);
    expect(Number(row.avgUseCase)).toBeCloseTo((8 + 2 + 4) / 3, 2);
  });

  it('promoters and detractors compute per slug independently', async () => {
    const { TutorialFeedbackAggregate } = cds.entities('com.sap.developers.ims');
    const other = await SELECT.one
      .from(TutorialFeedbackAggregate)
      .where({ tutorialSlug: 'agg-test-other' });

    expect(other).toBeTruthy();
    expect(other.responseCount).toBe(2);
    expect(other.promoters).toBe(1);
    expect(other.detractors).toBe(0);
  });

  it('avgRelevance averages over non-null values only', async () => {
    const { TutorialFeedbackAggregate } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one
      .from(TutorialFeedbackAggregate)
      .where({ tutorialSlug: 'agg-test' });

    // Two non-null values: 9 and 4 (the other two are null)
    expect(Number(row.avgRelevance)).toBeCloseTo((9 + 4) / 2, 2);
  });
});
