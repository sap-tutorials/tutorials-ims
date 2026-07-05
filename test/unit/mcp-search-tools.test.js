import { expect, describe, it, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

describe('MCP curated tool: search_tutorials', () => {
  let SearchService;

  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
    SearchService = await cds.serve('SearchService').from('./srv/search-service');
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  it('returns bounded result array with slug + title + snippet + tags', async () => {
    const results = await SearchService.send('search_tutorials', { query: 'test', limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(5);
    for (const r of results) {
      expect(r).toHaveProperty('slug');
      expect(r).toHaveProperty('title');
      expect(r).toHaveProperty('snippet');
      expect(Array.isArray(r.tags)).toBe(true);
    }
  });

  it('clamps limit at 100 even when caller passes more', async () => {
    const results = await SearchService.send('search_tutorials', { query: 'a', limit: 999 });
    expect(results.length).toBeLessThanOrEqual(100);
  });

  it('does not read req.user (anonymous tier)', async () => {
    // Call without any auth context — must not throw.
    const results = await SearchService.send('search_tutorials', { query: 'x' });
    expect(Array.isArray(results)).toBe(true);
  });

  it('orders results by relevance score (_searchRank DESC) when query is provided', async () => {
    // Spy on cds.db.run to capture the CQN that reaches the database.
    const runSpy = vi.spyOn(cds.db, 'run').mockResolvedValueOnce([]);

    await SearchService.send('search_tutorials', { query: 'hana cloud', limit: 5 });

    expect(runSpy).toHaveBeenCalledOnce();
    const cqn = runSpy.mock.calls[0][0];

    // attachSearchRank prepends { ref: ['_searchRank'], sort: 'desc' } to orderBy
    const orderBy = cqn?.SELECT?.orderBy;
    expect(Array.isArray(orderBy)).toBe(true);
    expect(orderBy.length).toBeGreaterThan(0);

    const firstOrder = orderBy[0];
    expect(firstOrder).toMatchObject({ ref: ['_searchRank'], sort: 'desc' });

    // Also assert that _searchRank column was appended to SELECT.columns
    const columns = cqn?.SELECT?.columns;
    expect(Array.isArray(columns)).toBe(true);
    const rankCol = columns.find((c) => c.as === '_searchRank');
    expect(rankCol).toBeDefined();

    runSpy.mockRestore();
  });
});
