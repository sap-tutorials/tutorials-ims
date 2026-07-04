import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('Joule step-help FAB smoke', () => {
  let slug;

  it('discovers a published tutorial slug', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/content/hashes`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const slugs = Object.keys(body);
    if (slugs.length > 0) slug = slugs[0];
  });

  it('tutorial page renders the step-help FAB element', async () => {
    if (!slug) return;
    const res = await fetchWithRetry(`${BASE_URL}/tutorials/${slug}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Hugo's HTML minifier may strip attribute quotes; accept both forms.
    expect(html).toMatch(/id=["']?joule-step-fab["']?/);
    expect(html).toMatch(/class=(["'][^"']*joule-step-fab[^"']*["']|joule-step-fab[\s>])/);
    expect(html).toMatch(/aria-label=["'][^"']*step[^"']*["']/i);
  });

  it('tutorial page exposes window.opGetCurrentStep getter', async () => {
    if (!slug) return;
    const res = await fetchWithRetry(`${BASE_URL}/tutorials/${slug}/`);
    const html = await res.text();
    expect(html).toMatch(/window\.opGetCurrentStep\s*=/);
  });

  it('joule.css ships the FAB styles', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/css/joule.css`);
    expect(res.status).toBe(200);
    const css = await res.text();
    expect(css).toMatch(/\.joule-step-fab\b/);
    expect(css).toMatch(/@media \(max-width: 960px\)/);
  });

  it('joule.js ships the openWithStepContext API', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/js/joule.js`);
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toMatch(/openWithStepContext/);
    expect(js).toMatch(/joule-step-fab/);
  });

  it('joule.js ships the openWithPrefill API (#946)', async () => {
    // #946: sibling of openWithMessage that pre-fills the composer without
    // submitting. Consumers include future admin/docs handoffs where the
    // user is more likely to iterate on the prompt before sending.
    const res = await fetchWithRetry(`${BASE_URL}/js/joule.js`);
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toMatch(/openWithPrefill/);
    expect(js).toMatch(/prefillText/);
  });

  it('joule.js observes BOTH .tutorial-nav-bottom AND .next-steps (issue #456)', async () => {
    // Issue #102 added an IntersectionObserver on .tutorial-nav-bottom so
    // the FAB lifts clear of the in-flow prev/next nav row. Issue #456 noted
    // the FAB ALSO overlaps the "Next Steps" card (.next-steps in
    // next-steps.html) which sits ABOVE the nav row in mission/group
    // tutorials. The fix observes both selectors with a shared observer.
    const res = await fetchWithRetry(`${BASE_URL}/js/joule.js`);
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toMatch(/\.tutorial-nav-bottom/);
    expect(js).toMatch(/\.next-steps/);
  });
});
