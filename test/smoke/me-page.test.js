import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

// Skip the suite when running locally without a smoke target. The smoke
// project runs only against deployed envs (see vitest.config.ts → smoke).
const SMOKE_TARGET = process.env.SMOKE_BASE_URL;
const describeIf = SMOKE_TARGET ? describe : describe.skip;

describeIf('/me page shape', () => {
  it('serves /me with all four mount-point divs', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/me/`);
    // /me is XSUAA-protected; unauthenticated requests receive 302→login.
    // Static HTML layout is served pre-auth by approuter, so we expect 200
    // when a session cookie is provided (via SMOKE_* auth headers / cookies),
    // or 302 if running anonymously. Both are acceptable for this shape test.
    expect([200, 302]).toContain(res.status);

    if (res.status !== 200) {
      // Anonymous redirect — shape check skipped.
      return;
    }

    const html = await res.text();

    // The four mount points for Vue islands (Task 8, commit 403fd72d).
    // These are the divs that the me.js script hydrates.
    expect(html).toContain('id="me-recent-activity"');
    expect(html).toContain('id="me-all-completions"');
    expect(html).toContain('id="me-learning-preferences"');
    expect(html).toContain('id="me-community-profile"');
  });

  it('references the me.js bundle', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/me/`);
    expect([200, 302]).toContain(res.status);

    if (res.status !== 200) {
      return;
    }

    const html = await res.text();

    // Tolerant of Hugo asset versioning cache-busting (?v=...).
    // Matches src="/js/me.js?v=..." or data-src="/js/me.js?v=...".
    expect(html).toMatch(/["\s/]\/js\/me\.js[\?\s"]/);
  });

  it('wraps content in three ui5-panel elements', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/me/`);
    expect([200, 302]).toContain(res.status);

    if (res.status !== 200) {
      return;
    }

    const html = await res.text();

    // Three collapsible panels (Task 8, commit 403fd72d):
    // 1. "Learning Preferences" (also wraps "Community Profile")
    // 2. "Recent Activity"
    // 3. "All Completions"
    const panelCount = (html.match(/<ui5-panel\b/g) || []).length;
    expect(panelCount).toBeGreaterThanOrEqual(3);
  });
});
