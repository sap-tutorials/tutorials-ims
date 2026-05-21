// srv/__tests__/tutorial-feedback-aggregate.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

process.env.SUBMISSION_SALT_SECRET = 'test-secret';

cds.test('serve', '--project', '.', '--in-memory');

describe('TutorialFeedbackAggregate', () => {
  beforeAll(async () => {
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TutorialFeedback).entries([
      {
        ID: cds.utils.uuid(),
        tutorialSlug: 'agg-test',
        npsScore: 10,
        ratingUseCase: 8
      },
      {
        ID: cds.utils.uuid(),
        tutorialSlug: 'agg-test',
        npsScore: 9,
        ratingUseCase: null
      },
      {
        ID: cds.utils.uuid(),
        tutorialSlug: 'agg-test',
        npsScore: 5,
        ratingUseCase: 2
      },
      {
        ID: cds.utils.uuid(),
        tutorialSlug: 'agg-test',
        npsScore: 3,
        ratingUseCase: 4
      }
    ]);
  });

  afterAll(async () => {
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TutorialFeedback).where({ tutorialSlug: 'agg-test' });
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
});
