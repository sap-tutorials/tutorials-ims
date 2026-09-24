// test/smoke/topics-route.smoke.test.js
//
// Smoke tests for the tag-tree topics feature — CAP-served /topics/ routes.
//
// Tests:
//   1. /topics/__definitely-not-a-real-slug__/ → NOT 200. Topics unknown slugs
//      301 to /topics/ (resolveTopicBySlug redirect path), unlike /concepts/
//      which 404s. fetchWithRetry uses redirect:'manual' so the client sees the
//      raw 301 — the invariant is simply: a bogus slug must never resolve to a
//      served page (status ≠ 200).
//   2. /topics/ index → 200 (published BLOB or SSR-served by CAP via
//      /content/topics-index; x-content-source assertion is best-effort)
//   3. A live leaf slug derived from /build/topics-tree → 200 + body
//      references the slug. GATED behind SMOKE_CONTENT_FRESH (#2493): leaf
//      pages are HANA BLOBs published by a full rebuild, not by a deploy, so
//      this asserts only in the post-publish verification run and is a visible
//      skip in the plain deploy gate. Also ctx.skip() when the tree is empty.
//
// Mirrors concepts-route.smoke.test.js structure exactly.
import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, CONTENT_FRESH, fetchWithRetry } from './smoke.config.js';

describe('/topics/ route smoke', () => {
  it('does not serve a non-existent topic slug as a page', async () => {
    const r = await fetchWithRetry(`${BASE_URL}/topics/__definitely-not-a-real-slug__/`);
    // Topics 301 unknown slugs to /topics/ (resolveTopicBySlug redirect), unlike
    // concepts which 404. fetchWithRetry uses redirect:'manual', so assert the
    // real invariant: a bogus slug must never resolve to a served page.
    expect(r.status).not.toBe(200);
  });

  it('/topics/ index returns 200', async () => {
    const r = await fetchWithRetry(`${BASE_URL}/topics/`, { redirect: 'follow' });
    expect(r.status).toBe(200);
    // x-content-source header presence is best-effort (route exposes it when
    // the page is served from HANA; approuter-cached responses may not carry it).
    const xcs = r.headers.get('x-content-source');
    if (xcs !== null) {
      expect(typeof xcs).toBe('string');
    }
  });

  it('returns 200 for a known live topic slug', async (ctx) => {
    // Topic LEAF pages are HANA `topic-<slug>` BLOBs published ONLY by the
    // render-topics phase of a FULL, no-slug content rebuild (publish-content.ts
    // gate `!opts.slug && channel === 'prod'`). A DEPLOY ships the srv fallback
    // and the SSR `/topics/` index but publishes NO leaf BLOBs — and the ongoing
    // DEV per-tutorial dispatches are slug-targeted, so they skip render-topics
    // too. So in the post-deploy gate a live-tree leaf legitimately 404s until a
    // full rebuild runs; asserting 200 there is a false regression (issue #2493).
    // Gate the served-leaf assertion behind SMOKE_CONTENT_FRESH — the same
    // contract seo-files.test.js uses for catalog-freshness BLOB checks — so it
    // asserts in the post-publish verification run (where topics ARE freshly
    // published) and is a visible skip in the plain deploy gate.
    if (!CONTENT_FRESH) {
      ctx.skip();
      return;
    }
    const probe = await fetchWithRetry(`${SRV_URL}/build/topics-tree`);
    expect(probe.status).toBe(200);
    const body = await probe.json();
    // Recursively find the first leaf node that has a slug.
    function findLeafSlug(nodes) {
      for (const node of nodes || []) {
        if (node.slug) return node.slug;
        if (Array.isArray(node.children)) {
          const found = findLeafSlug(node.children);
          if (found) return found;
        }
      }
      return null;
    }
    const slug = findLeafSlug(body.tree || []);
    if (!slug) {
      // Visible skip — distinct from a passing assertion. Surfaces in CI as
      // a skipped test, not a silent PASS. Matches concepts-route.smoke pattern.
      ctx.skip();
      return;
    }
    const r = await fetchWithRetry(`${BASE_URL}/topics/${slug}/`, { redirect: 'follow' });
    expect(r.status).toBe(200);
    const html = await r.text();
    // Assert on slug (unescaped in <a href>), not label (HTML-escaped by Hugo
    // template — would break for labels with & < > etc).
    expect(html).toContain(`/topics/${slug}/`);
  });
});
