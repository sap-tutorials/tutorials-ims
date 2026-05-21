import { describe, it, expect, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_SLUG = '__TEST__feedback-hybrid';

describe.runIf(isSafeForWrites())('TutorialFeedback (hybrid)', () => {
  afterAll(async () => {
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TutorialFeedback).where({ tutorialSlug: TEST_SLUG });
  });

  it('insert + aggregate roundtrip', async () => {
    const { TutorialFeedback, TutorialFeedbackAggregate } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TutorialFeedback).entries([
      { ID: cds.utils.uuid(), tutorialSlug: TEST_SLUG, npsScore: 10, ratingUseCase: 8 },
      { ID: cds.utils.uuid(), tutorialSlug: TEST_SLUG, npsScore: 3,  ratingUseCase: 4 }
    ]);
    const agg = await SELECT.one.from(TutorialFeedbackAggregate).where({ tutorialSlug: TEST_SLUG });
    expect(agg.responseCount).toBe(2);
    expect(agg.promoters).toBe(1);
    expect(agg.detractors).toBe(1);
  });
});
