import { describe, it, expect } from 'vitest';
import { categorySlugsFor, countActiveFor, buildCategoriesPayload } from '../build-catalog-categories.js';

const catByID = new Map([
  ['cat-ai',   { ID: 'cat-ai',   slug: 'artificial-intelligence', sortOrder: 50 }],
  ['cat-app',  { ID: 'cat-app',  slug: 'app-dev-automation',      sortOrder: 10 }],
  ['cat-data', { ID: 'cat-data', slug: 'data-analytics',          sortOrder: 20 }],
]);

describe('categorySlugsFor', () => {
  it('returns top-3 sorted DESC by score', () => {
    const assigns = [
      { mission_ID: 'm1', category_ID: 'cat-app', score: 0.5 },
      { mission_ID: 'm1', category_ID: 'cat-ai',  score: 0.9 },
      { mission_ID: 'm1', category_ID: 'cat-data', score: 0.3 },
      { mission_ID: 'm2', category_ID: 'cat-ai',  score: 0.8 },
    ];
    expect(categorySlugsFor('m1', assigns, 'mission_ID', catByID))
      .toEqual(['artificial-intelligence', 'app-dev-automation', 'data-analytics']);
  });

  it('caps at 3 even with more assignments', () => {
    const assigns = ['cat-ai','cat-app','cat-data'].flatMap((id, i) =>
      [{ mission_ID: 'm1', category_ID: id, score: 0.9 - i*0.1 }]);
    assigns.push({ mission_ID: 'm1', category_ID: 'cat-ai', score: 0.5 }); // dup category, low score
    const result = categorySlugsFor('m1', assigns, 'mission_ID', catByID);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('breaks ties by sortOrder ASC', () => {
    const assigns = [
      { mission_ID: 'm1', category_ID: 'cat-ai',  score: 0.5 },  // sortOrder 50
      { mission_ID: 'm1', category_ID: 'cat-app', score: 0.5 },  // sortOrder 10  → wins tie
    ];
    expect(categorySlugsFor('m1', assigns, 'mission_ID', catByID)[0]).toBe('app-dev-automation');
  });

  it('returns [] when no assignments match', () => {
    expect(categorySlugsFor('m99', [], 'mission_ID', catByID)).toEqual([]);
  });

  it('drops assignments whose category_ID is unknown', () => {
    const assigns = [
      { mission_ID: 'm1', category_ID: 'unknown-cat', score: 0.9 },
      { mission_ID: 'm1', category_ID: 'cat-ai',     score: 0.5 },
    ];
    expect(categorySlugsFor('m1', assigns, 'mission_ID', catByID))
      .toEqual(['artificial-intelligence']);
  });
});

describe('countActiveFor', () => {
  it('sums across all 3 kinds', () => {
    const m = [{ category_ID: 'cat-ai' }, { category_ID: 'cat-ai' }, { category_ID: 'cat-app' }];
    const g = [{ category_ID: 'cat-ai' }];
    const t = [{ category_ID: 'cat-ai' }, { category_ID: 'cat-data' }];
    expect(countActiveFor('cat-ai', m, g, t)).toBe(4);
    expect(countActiveFor('cat-app', m, g, t)).toBe(1);
    expect(countActiveFor('cat-data', m, g, t)).toBe(1);
    expect(countActiveFor('nonexistent', m, g, t)).toBe(0);
  });
});

describe('buildCategoriesPayload', () => {
  it('returns shape sorted ASC by sortOrder', () => {
    const categories = [
      { ID: 'cat-ai',   slug: 'artificial-intelligence', label: 'AI',   sortOrder: 50 },
      { ID: 'cat-app',  slug: 'app-dev-automation',      label: 'App',  sortOrder: 10 },
      { ID: 'cat-data', slug: 'data-analytics',          label: 'Data', sortOrder: 20 },
    ];
    const out = buildCategoriesPayload(categories, [], [], []);
    expect(out.map(c => c.slug)).toEqual([
      'app-dev-automation', 'data-analytics', 'artificial-intelligence',
    ]);
    expect(out[0]).toMatchObject({ slug: 'app-dev-automation', label: 'App', sortOrder: 10, activeCount: 0 });
  });

  it('counts active items', () => {
    const categories = [
      { ID: 'cat-ai', slug: 'artificial-intelligence', label: 'AI', sortOrder: 50 },
    ];
    const m = [{ category_ID: 'cat-ai' }, { category_ID: 'cat-ai' }];
    const out = buildCategoriesPayload(categories, m, [], []);
    expect(out[0].activeCount).toBe(2);
  });
});
