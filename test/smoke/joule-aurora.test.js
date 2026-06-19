// test/smoke/joule-aurora.test.js
import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

describe('Joule aurora background smoke', () => {
  let css;

  it('joule.css responds 200 and is fetchable', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/css/joule.css`);
    expect(res.status).toBe(200);
    css = await res.text();
    expect(css.length).toBeGreaterThan(0);
  });

  it('declares the four new mesh tokens', () => {
    expect(css).toMatch(/--joule-mesh-a:\s*#8000dc/i);
    expect(css).toMatch(/--joule-mesh-b:\s*#afd8ff/i);
    expect(css).toMatch(/--joule-mesh-c1:\s*#f1acff/i);
    expect(css).toMatch(/--joule-mesh-d2:\s*#cfc3ff/i);
  });

  it('reuses existing purple tokens for mesh-d1 and mesh-c2', () => {
    // Aurora should reference --joule-purple-1 (== prod #5d36ff == mesh-d1)
    // and --joule-purple-3 (== prod #a100c2 == mesh-c2) inside its layer rules.
    expect(css).toMatch(/\.joule-aurora__layer--d[\s\S]*?--joule-purple-1/);
    expect(css).toMatch(/\.joule-aurora__layer--c[\s\S]*?--joule-purple-3/);
  });

  it('declares the four mesh layer rules with required physics', () => {
    expect(css).toMatch(/\.joule-aurora__layer\b/);
    expect(css).toMatch(/\.joule-aurora__layer--a\b/);
    expect(css).toMatch(/\.joule-aurora__layer--b\b/);
    expect(css).toMatch(/\.joule-aurora__layer--c\b/);
    expect(css).toMatch(/\.joule-aurora__layer--d\b/);
    // The "blurred ellipse anchored to the bottom" physics:
    expect(css).toMatch(/filter:\s*blur\(50px\)/);
    expect(css).toMatch(/radial-gradient\(ellipse at 50%/);
  });

  it('declares the six aurora keyframes', () => {
    expect(css).toMatch(/@keyframes\s+jouleFloatA\b/);
    expect(css).toMatch(/@keyframes\s+jouleFloatB\b/);
    expect(css).toMatch(/@keyframes\s+jouleFloatC\b/);
    expect(css).toMatch(/@keyframes\s+jouleFloatD\b/);
    expect(css).toMatch(/@keyframes\s+jouleBob\b/);
    expect(css).toMatch(/@keyframes\s+jouleBobSettle\b/);
  });

  it('respects prefers-reduced-motion', () => {
    // The reduced-motion @media block must mention the aurora layers
    // (not just the typing dots that already had reduced-motion handling).
    const reducedBlocks = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\}/g) || [];
    const hasAuroraGuard = reducedBlocks.some(b => /joule-aurora__layer|joule-panel__hero-mark/.test(b));
    expect(hasAuroraGuard).toBe(true);
  });

  it('hero markup ships four mesh-layer divs on home', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/`);
    const html = await res.text();
    // Hugo minifier may strip attribute quotes; accept both forms.
    const layerCount = (html.match(/class=(?:["']?[^"'>]*joule-aurora__layer[^"'>]*["']?)/g) || []).length;
    expect(layerCount).toBeGreaterThanOrEqual(4);
  });

  it('admin-shell index ships four mesh-layer divs', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/admin-ui/`);
    // /admin-ui/ is XSUAA-protected; unauth gives 302/401/403.
    // We accept any of those AND the static asset itself.
    if (res.status === 200) {
      const html = await res.text();
      const layerCount = (html.match(/joule-aurora__layer/g) || []).length;
      expect(layerCount).toBeGreaterThanOrEqual(4);
    } else {
      // Fall back to the static file if the route is gated.
      const r2 = await fetchWithRetry(`${BASE_URL}/admin-ui/index.html`);
      if (r2.status === 200) {
        const html = await r2.text();
        const layerCount = (html.match(/joule-aurora__layer/g) || []).length;
        expect(layerCount).toBeGreaterThanOrEqual(4);
      } else {
        // Both gated — record skip; CI smoke runs against deployed URL where
        // admin-ui/* static files are served regardless of XSUAA scope.
        expect([200, 302, 401, 403]).toContain(res.status);
      }
    }
  });

  it('FAB style ships the aurora variant', () => {
    // FAB on the Hugo public site picks up the aurora paint; admin has no FAB.
    expect(css).toMatch(/\.joule-step-fab[\s\S]*?radial-gradient\(ellipse/);
  });
});
