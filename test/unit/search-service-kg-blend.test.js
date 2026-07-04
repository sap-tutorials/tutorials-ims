// test/unit/search-service-kg-blend.test.js
//
// Wiring verification for #945: SearchService projection exposes the new
// virtual `searchScore` field, and non-search reads leave it null.
//
// The end-to-end ranking assertion (KG signal reaches the SQL rank formula)
// lives in test/hybrid/search-kg-rerank.test.js, where the real embedding
// client + HANA path exercise the full blend. Reasoning:
//   - cds.test('serve') loads services from gen/srv/srv/, giving those
//     services their OWN module identity vs. the srv/lib/ imports pulled in
//     by the test file. Test-time mocking of `search-kg-signal.js` internal
//     state does NOT reach the served copy, so a full ranking assertion
//     would need a real AI Core binding (unavailable in unit tests).
//   - Algorithm correctness is fully covered by test/unit/search-kg-signal.test.js
//     (15 assertions on the cache, blend, sanitization, rationale, error paths).
//   - The hybrid HANA test verifies signal → SQL → row order end-to-end.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('SearchService — #945 wiring', () => {
  beforeAll(async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries([
      { ID: 'kg-t-strong', legacyId: 91001, slug: 'kg-strong-tutorial',
        title: 'kgprobe Strong Match Tutorial', description: 'unrelated body',
        primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 30, status: 'ACTIVE' },
    ]);
  });

  it('OData metadata exposes searchScore field on SearchableItems', async () => {
    const res = await project.get('/search/$metadata', {
      headers: { Accept: 'application/xml' },
    });
    expect(res.data).toContain('searchScore');
    // Must be Decimal(8,4) per the schema declaration.
    expect(res.data).toMatch(/searchScore.*Edm\.Decimal.*Precision="8".*Scale="4"/);
  });

  it('non-search reads: searchScore is null on returned rows', async () => {
    const res = await project.get(
      "/search/SearchableItems?$select=slug,searchScore&$filter=slug eq 'kg-strong-tutorial'",
    );
    const row = res.data.value[0];
    expect(row).toBeDefined();
    // searchScore is virtual → null when the rank hook doesn't fire.
    expect(row.searchScore == null).toBe(true);
  });

  it('search reads: title-hit rows still return (KG signal empty in unit env)', async () => {
    // With no AI Core binding in unit tests, the KG signal empties out
    // (warning=embed_failed), buildKgRankFragment returns '', and the rank
    // formula reduces byte-identically to today's fuzzy-only formula.
    // This proves the graceful-degradation branch — the search still works
    // when the KG stack is unavailable.
    const res = await project.get(
      "/search/SearchableItems?$search=kgprobe&$select=slug,title,searchScore&$top=5",
    );
    const rows = res.data.value;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const strong = rows.find(r => r.slug === 'kg-strong-tutorial');
    expect(strong).toBeDefined();
    // Title-hit → fuzzy rank = 3, no KG contribution, searchScore = 3.
    expect(strong.searchScore).toBe(3);
  });
});
