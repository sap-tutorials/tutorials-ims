// test/unit/author-service-analytics.test.js
//
// Task 6 (#617) — AuthorService analytics surface.
// Verifies the curated subset and absence of runSelectQuery (which lives on
// AdminService.AnalyticsService only).

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('AuthorService analytics surface', () => {
  it('listExposedEntities returns the curated subset', async () => {
    const { GET } = project;
    const res = await GET('/author/listExposedEntities()', {
      auth: { username: 'author', password: '' },
    });
    expect(res.status).toBe(200);
    const list = res.data.value ?? res.data;
    expect(list).toHaveLength(9);
    const names = list.map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'CompletionAnalytics',
        'CodeCheckSubmissions',
        'ValidateAnswerSubmissions',
        'ActiveLearnersDaily',
        'AnalyticsBranchPerformance',
        'AnalyticsBranchTopPick',
        'Tasks',
        'TaskRecords',
        'UIEvents',
      ])
    );
  });

  it('does NOT expose runSelectQuery', async () => {
    const { GET } = project;
    const res = await GET('/author/$metadata', {
      auth: { username: 'author', password: '' },
    });
    expect(String(res.data)).not.toMatch(/runSelectQuery/);
  });

  it('CompletionAnalytics is queryable as author', async () => {
    const { GET } = project;
    const res = await GET('/author/CompletionAnalytics?$top=1', {
      auth: { username: 'author', password: '' },
    });
    expect(res.status).toBe(200);
  });
});
