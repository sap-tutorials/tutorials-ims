// scripts/parsers/__tests__/cap-catalog-title.test.ts
// #3091 follow-up: fetchBuildCatalog must carry each tutorial's `title` into
// tutorialMetas. fetch-tutorials.ts seeds the xref/prereq catalogBySlug from
// these titles so :tutorial / ::requires cross-references render a real title
// (not the raw slug) even on slug-targeted rebuilds, where the referenced
// tutorial's own <slug>.md is never fetched into CACHE_DIR.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchBuildCatalog } from '../cap.js';

const CATALOG = {
  missions: [],
  hierarchies: [],
  standaloneGroups: [],
  categories: [],
  tutorials: [
    { slug: 'hana-cloud-mission-trial-1', title: 'Understand How the SAP HANA Cloud Free Tier Service can be Used', categorySlugs: [] },
    { slug: 'no-title-slug', categorySlugs: ['cat-a'] }, // title absent → omitted, not slug-filled
  ],
  featured: [],
};

afterEach(() => vi.restoreAllMocks());

describe('fetchBuildCatalog title capture (#3091)', () => {
  it('threads tutorials[].title into tutorialMetas', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => CATALOG,
    })));

    const res = await fetchBuildCatalog('http://localhost:4004');
    const bySlug = new Map(res.tutorialMetas.map(m => [m.slug, m]));

    expect(bySlug.get('hana-cloud-mission-trial-1')?.title)
      .toBe('Understand How the SAP HANA Cloud Free Tier Service can be Used');
    // A tutorial with no title must NOT get a fabricated one — the slug-as-title
    // fallback lives in fetch-tutorials.ts, not here; here title stays undefined.
    expect(bySlug.get('no-title-slug')?.title).toBeUndefined();
    expect(bySlug.get('no-title-slug')?.categorySlugs).toEqual(['cat-a']);
  });
});
