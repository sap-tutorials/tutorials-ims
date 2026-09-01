// test/smoke/topics-route.smoke.test.js
//
// Smoke tests for the tag-tree topics feature — CAP-served /topics/ routes.
//
// Tests:
//   1. /topics/__definitely-not-a-real-slug__/ → 404 (unknown slug redirects
//      in the approuter, or srv 404s — either way the caller sees no 200)
//   2. /topics/ index → 200 (published BLOB or SSR-served by CAP via
//      /content/topics-index; x-content-source assertion is best-effort)
//   3. A live leaf slug derived from /build/topics-tree → 200 + body
//      references the slug. ctx.skip() (VISIBLE skip) when tree is empty.
//
// Mirrors concepts-route.smoke.test.js structure exactly.
import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('/topics/ route smoke', () => {
  it('returns 404 for a non-existent topic slug', async () => {
    const r = await fetchWithRetry(`${BASE_URL}/topics/__definitely-not-a-real-slug__/`);
    expect(r.status).toBe(404);
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
