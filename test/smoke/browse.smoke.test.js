// test/smoke/browse.smoke.test.js
//
// HTTP-level smoke tests for /browse/ on the deployed approuter.
// Skipped unless SMOKE_BASE_URL is set (e.g. during deploy verification).
//
// Verifies:
//  - The page returns 200 with the expected SSR landmarks (banner,
//    filter rail, results main, skip-link).
//  - The catalog is inlined as <script id="browse-data">.
//  - Filter checkbox wiring is present in the SSR'd filter rail.

import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

// Skip the suite when running locally without a smoke target. The smoke
// project runs only against deployed envs (see vitest.config.ts → smoke).
const SMOKE_TARGET = process.env.SMOKE_BASE_URL;
const describeIf = SMOKE_TARGET ? describe : describe.skip;

describeIf('/browse/ smoke', () => {
  it('returns 200 with the expected landmarks', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/browse/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Banner, filter rail, results main — the controllable landmarks
    // BrowsePage.vue + controller.ts wire onto.
    expect(html).toMatch(/<header[^>]+class="browse-banner"/);
    expect(html).toMatch(/<aside[^>]+id="browse-filter-rail"/);
    expect(html).toMatch(/<main[^>]+id="browse-results"/);
    // Skip-link (a11y)
    expect(html).toMatch(/skip-link/);
    // The grid mount point used by the Vue island.
    expect(html).toMatch(/id="browse-root"/);
  });

  it('inlines the catalog as <script id="browse-data">', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/browse/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Whitespace-tolerant: the Hugo minifier may strip the space between
    // the type attribute and the closing >.
    expect(html).toMatch(/<script\s+id="browse-data"\s+type="application\/json"\s*>[^<]*"all"\s*:\s*\[/);
  });

  it('renders the type=mission filter checkbox in the SSR filter rail', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/browse/?type=mission`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The SSR'd filter rail does NOT pre-check the checkbox (controller
    // does that on mount), but the input MUST exist so the controller
    // has something to wire onto.
    expect(html).toMatch(/<input[^>]+name="type"[^>]+value="mission"/);
  });
});
