import { describe, it, expect } from 'vitest';

const baseUrl = process.env.SMOKE_APPROUTER_URL;

describe.skipIf(!baseUrl)('graphql smoke (#996)', () => {
  it('public concepts query returns 200', async () => {
    const r = await fetch(`${baseUrl}/graphql/public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '{ __typename }'
      })
    });
    expect(r.status).toBe(200);
  });

  it('search query returns results', async () => {
    const r = await fetch(`${baseUrl}/graphql/public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '{ SearchService { SearchableItems(search: "cap", top: 1) { totalCount } } }'
      })
    });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.data?.SearchService?.SearchableItems?.totalCount).toBeGreaterThanOrEqual(0);
  });

  it('production stack traces are not leaked', async () => {
    const r = await fetch(`${baseUrl}/graphql/public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ NonExistent { foo } }' })
    });
    const j = await r.json();
    const text = JSON.stringify(j.errors ?? []);
    expect(text).not.toMatch(/at Object\.<anonymous>/);
    expect(text).not.toMatch(/node_modules/);
  });
});
