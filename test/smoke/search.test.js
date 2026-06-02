import { describe, it, expect } from 'vitest';

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:4004';

describe('Search Service (smoke)', () => {

  it('GET /search/SearchableItems returns 200', async () => {
    const res = await fetch(`${BASE_URL}/search/SearchableItems?$top=5`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.value).toBeDefined();
    expect(data.value.length).toBeGreaterThan(0);
  });

  it('GET /search/SearchableItems?$search=cap returns results', async () => {
    const res = await fetch(`${BASE_URL}/search/SearchableItems?$search=cap&$top=10`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.value.length).toBeGreaterThan(0);
  });

  it('GET /search/Tags returns 200 with tag list', async () => {
    const res = await fetch(`${BASE_URL}/search/Tags?$top=10`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.value.length).toBeGreaterThan(0);
    expect(data.value[0]).toHaveProperty('name');
  });

  it('GET /search/getFacets returns facets', async () => {
    const res = await fetch(`${BASE_URL}/search/getFacets(search='cap')`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('totalCount');
    expect(data).toHaveProperty('typeCounts');
  });

  it('search endpoint does not require authentication', async () => {
    const res = await fetch(`${BASE_URL}/search/SearchableItems?$top=1`, {
      headers: {}
    });
    expect(res.status).toBe(200);
  });

  it('response time under 500ms for typical search', async () => {
    const start = Date.now();
    await fetch(`${BASE_URL}/search/SearchableItems?$search=hana&$top=20`);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('does not leak _searchRank field on deployed srv (#154)', async () => {
    const res = await fetch(`${BASE_URL}/search/SearchableItems?$search=BTP&$top=10`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.value)).toBe(true);
    // Don't assert >0 hits — content shape varies by environment (DEV/QA/cold).
    // Only assert: if there are hits, none of them leak _searchRank.
    for (const row of data.value) {
      expect(row).not.toHaveProperty('_searchRank');
    }
  });

  it('SearchableItems projects createdAt', async () => {
    const res = await fetch(`${BASE_URL}/search/SearchableItems?$top=10`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.value)).toBe(true);
    expect(data.value.length).toBeGreaterThan(0);
    const withCreatedAt = data.value.filter(r => r.createdAt);
    // Don't insist all rows have it — legacy IMS imports may have null
    // createdAt — but require at least one to confirm the field is exposed.
    expect(withCreatedAt.length).toBeGreaterThan(0);
    expect(typeof withCreatedAt[0].createdAt).toBe('string');
  });

  it('OData $filter on createdAt is honored', async () => {
    const farFuture = '2999-01-01T00:00:00.000Z';
    const url = `${BASE_URL}/search/SearchableItems?$filter=${encodeURIComponent(`createdAt gt ${farFuture}`)}&$top=5&$count=true`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.value).toEqual([]);
    expect(data['@odata.count']).toBe(0);
  });
});
