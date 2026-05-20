import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

// Hugo's HTML minifier strips quotes around attribute values that contain only
// safe characters (letters, digits, slashes). So the source markers
// `data-error-page="404"` / `id="popular-rail"` / `name="q"` render as
// `data-error-page=404` / `id=popular-rail` / `name=q` in production.
// Use regex matchers that tolerate both forms.
const errorPageMarker = (status) => new RegExp(`data-error-page=(?:["']?)${status}(?:["']?)`);
const popularRailMarker = /id=(?:["']?)popular-rail(?:["']?)/;
const searchInputMarker = /name=(?:["']?)q(?:["']?)/;
const healthHref = /href=(?:["']?)\/health(?:["']?)/;
const healthDbHref = /href=(?:["']?)\/health\/db(?:["']?)/;

describe('Custom error pages', () => {
  it('GET /this-path-does-not-exist returns 404 with custom page', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/this-path-does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') || '').toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(errorPageMarker(404));
    expect(body).toMatch(popularRailMarker);
    expect(body).toMatch(searchInputMarker);
  });

  it('GET /assets/missing.js returns 404 with custom page', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/assets/missing.js`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toMatch(errorPageMarker(404));
  });

  it('GET /500.html serves the 500 layout directly', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/500.html`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(errorPageMarker(500));
    expect(body).toMatch(healthHref);
    expect(body).toMatch(healthDbHref);
  });

  it('GET /maintenance.html serves the maintenance layout directly', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/maintenance.html`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(errorPageMarker(503));
  });

  it('GET /tutorials/this-slug-does-not-exist returns 404', async () => {
    // CAP serves a styled 404 (its `__404__` slug) for missing tutorials —
    // the body assertion stays loose because the CAP fallback may or may not
    // include our marker depending on which 404.html version was last published.
    const res = await fetchWithRetry(`${BASE_URL}/tutorials/this-slug-does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('proxied 404 from CAP is not hijacked by errorPage (guardrail)', async () => {
    // /build/* routes are unauthenticated and proxy to CAP. A bogus path under
    // /build returns a real 404 from express. We don't care what the body
    // looks like — only that our custom 404 marker is absent, which proves
    // the approuter's errorPage map didn't replace the upstream body.
    const res = await fetchWithRetry(`${BASE_URL}/build/does-not-exist-endpoint`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toMatch(errorPageMarker(404));
  });
});
