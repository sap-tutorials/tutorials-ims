// test/unit/author-service-analytics.test.js
//
// Task 6 (#617) — AuthorService analytics surface.
// Verifies the curated subset and absence of runSelectQuery (which lives on
// AdminService.AnalyticsService only).

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { AUTHOR_EXPOSED_ENTITIES } from '../../srv/lib/author-exposed-entities.js'; // #1089

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('AuthorService analytics surface', () => {
  it('listExposedEntities returns the curated subset', async () => {
    const { GET } = project;
    const res = await GET('/author/listExposedEntities()', {
      auth: { username: 'author', password: '' },
    });
    expect(res.status).toBe(200);
    const list = res.data.value ?? res.data;
    const names = list.map((e) => e.name);
    // Count + membership derived from the source-of-truth constant (#1089) so
    // growing the curated set doesn't silently regress this assertion.
    expect(list).toHaveLength(AUTHOR_EXPOSED_ENTITIES.length);
    expect(new Set(names)).toEqual(new Set(AUTHOR_EXPOSED_ENTITIES.map((e) => e.name)));
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
