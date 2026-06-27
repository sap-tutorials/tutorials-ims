import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

// #446 Track 3-A — concept landing pages.
//
// Tests that:
//   1. /concepts/<unknown-slug>/ returns 404 (approuter forwards, srv 404s)
//   2. If at least one concept is published (visible in /build/concepts), the
//      approuter route renders that slug's concept page.
//
// The "200 for a published concept" leg calls `ctx.skip()` at runtime when
// no concepts are published in the target env (e.g. QA channel or fresh
// deploys before the first publish). Vitest then reports a VISIBLE skip in
// test output — the previous shape `return`-ed silently and counted as PASS.

describe('/concepts/<slug>/ route', () => {
  it('returns 404 for a non-existent concept slug', async () => {
    const r = await fetchWithRetry(`${BASE_URL}/concepts/__definitely-not-a-real-slug__/`);
    expect(r.status).toBe(404);
  });

  it('returns 200 for a known published concept', async (ctx) => {
    const probe = await fetchWithRetry(`${SRV_URL}/build/concepts`);
    expect(probe.status).toBe(200);
    const { concepts } = await probe.json();
    if (!Array.isArray(concepts) || concepts.length === 0) {
      // Visible skip — distinct from a passing assertion. Surfaces in CI as
      // a skipped test, not a silent PASS.
      ctx.skip();
      return;
    }
    const sample = concepts[0];
    const r = await fetchWithRetry(`${BASE_URL}/concepts/${sample.slug}/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    // Assert on slug (unescaped in <a href>), not name (HTML-escaped by Hugo
    // template — would break for names with & < > etc).
    expect(html).toContain(`/concepts/${sample.slug}/`);
  });
});
