// test/unit/author-service-feedback.test.js
//
// Task 8 (#617) — AuthorService.TutorialFeedback + TutorialFeedbackAggregate
// read-only surface. Verifies authors can read feedback but cannot write,
// and the aggregate view is reachable.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('AuthorService.TutorialFeedback', () => {
  beforeAll(async () => {
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TutorialFeedback).entries({
      ID: cds.utils.uuid(),
      tutorialSlug: 'feedback-test',
      ratingUseCase: 5,
      comment: 'Great tutorial',
    });
  });

  it('TutorialFeedback is readable by Tutorial.Author', async () => {
    const { GET } = project;
    const res = await GET("/author/TutorialFeedback?$filter=tutorialSlug eq 'feedback-test'", {
      auth: { username: 'author', password: '' },
    });
    expect(res.status).toBe(200);
    const rows = res.data.value ?? res.data;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('TutorialFeedback rejects POST (read-only)', async () => {
    const res = await fetch(`${project.url}/author/TutorialFeedback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Basic ' + Buffer.from('author:').toString('base64'),
      },
      body: JSON.stringify({ tutorialSlug: 'x', ratingUseCase: 1 }),
    });
    expect([405, 403]).toContain(res.status);
  });

  it('TutorialFeedbackAggregate is readable', async () => {
    const { GET } = project;
    const res = await GET('/author/TutorialFeedbackAggregate?$top=1', {
      auth: { username: 'author', password: '' },
    });
    expect(res.status).toBe(200);
  });
});
