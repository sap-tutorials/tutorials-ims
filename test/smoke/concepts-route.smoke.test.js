import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

// #446 Track 3-A — concept landing pages.
//
// Tests that:
//   1. /concepts/<unknown-slug>/ returns 404 (approuter forwards, srv 404s)
//   2. If at least one concept is published (visible in /build/concepts), the
//      approuter route renders its name in the response HTML.
//
// The "200 for a published concept" leg is conditionally skipped when no
// concepts are published in the target env — this is the expected state on
// the QA channel and on fresh deploys before the first concept publish.

describe('/concepts/<slug>/ route', () => {
  it('returns 404 for a non-existent concept slug', async () => {
    const r = await fetchWithRetry(`${BASE_URL}/concepts/__definitely-not-a-real-slug__/`);
    expect(r.status).toBe(404);
  });

  it('returns 200 for at least one published concept (when any exist)', async () => {
    const probe = await fetchWithRetry(`${SRV_URL}/build/concepts`);
    expect(probe.status).toBe(200);
    const { concepts } = await probe.json();
    if (!Array.isArray(concepts) || concepts.length === 0) {
      console.warn('No published concepts in this env; concept-route smoke test skipped.');
      return;
    }
    const sample = concepts[0];
    const r = await fetchWithRetry(`${BASE_URL}/concepts/${sample.slug}/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain(sample.name);
  });
});
