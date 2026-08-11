// test/smoke/pages-routes.smoke.test.js
//
// HTTP-level smoke tests for the page routes flipped from static to CAP in
// #1659 Phase 2 (/browse/, /topics/, /tutorial-navigator/, /developer-advocates/,
// /devtoberfest/ root, 7 verb pages, sitemaps).
//
// Skipped unless SMOKE_BASE_URL is set (e.g. during deploy verification).
//
// Verifies per route:
//  - 200 with Content-Type: text/html
//  - A page-appropriate HTML landmark is present
//  - Every /js/*.js script src is content-hashed (/js/<name>-<hash>.js)
//    — guards against the stale-island class (#1628/#1604)
//
// Special cases:
//  - /devtoberfest/ root served by CAP; a known subpage stays static
//  - /sitemap.xml served by CAP, returns XML with <urlset
//  - / (homepage) NOT yet flipped — still 200 via catch-all static

import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

// Skip the suite when running locally without a smoke target. The smoke
// project runs only against deployed envs (see vitest.config.ts → smoke).
const SMOKE_TARGET = process.env.SMOKE_BASE_URL;
const describeIf = SMOKE_TARGET ? describe : describe.skip;

// Routes flipped to CAP in Phase 2.
// `marker` is a short HTML substring that must appear in the served page,
// confirming the right page was served (not a fallback error page).
const HTML_ROUTES = [
  { path: '/browse/',              marker: 'id="browse-results"'     },
  { path: '/topics/',              marker: 'id="topics-map"'         },
  { path: '/tutorial-navigator/', marker: 'id="tutorial-navigator"' },
  { path: '/developer-advocates/', marker: 'id="advocates-mount"'   },
  { path: '/devtoberfest/',        marker: 'id="devtoberfest-mount"' },
  { path: '/ai/',                  marker: 'data-verb="ai"'          },
  { path: '/build/',               marker: 'data-verb="build"'       },
  { path: '/connect/',             marker: 'data-verb="connect"'     },
  { path: '/integrate/',           marker: 'data-verb="integrate"'   },
  { path: '/learn/',               marker: 'data-verb="learn"'       },
  { path: '/model/',               marker: 'data-verb="model"'       },
  { path: '/operate/',             marker: 'data-verb="operate"'     },
];

// Assert that every /js/*.js script src in the HTML is content-hashed.
// Hashed path pattern: /js/<name>-<hash>.js where hash is [A-Za-z0-9_-]{6,}
// (Vite emits 8-char hashes; 6 is the lower bound for robustness).
//
// Extracts only bare src="..." attribute values — excludes:
//  - query-string paths like /js/featured-rail.js?v=... (not from island-src)
//  - inline-script string literals (not src attributes)
function collectIslandSrcs(html) {
  // Match src="/js/<path>.js" (no query string — [^"?] stops at ? or ")
  return [...html.matchAll(/src="(\/js\/[^"?]+\.js)"/g)].map(m => m[1]);
}

function assertHashedIslands(html, path) {
  const srcs = collectIslandSrcs(html);
  if (srcs.length === 0) return; // page has no /js/*.js islands — skip hash check
  const unhashed = srcs.filter(s => !/-[A-Za-z0-9_-]{6,}\.js$/.test(s));
  expect(
    unhashed,
    `unhashed island srcs on ${path}: ${unhashed.join(', ')}`
  ).toHaveLength(0);
}

describeIf('#1659 Phase 2 flipped page routes', () => {
  for (const { path, marker } of HTML_ROUTES) {
    it(`${path} → 200 HTML with page landmark and hashed island refs`, async () => {
      const r = await fetchWithRetry(`${BASE_URL}${path}`, { redirect: 'follow' });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type') || '').toContain('text/html');
      const html = await r.text();
      expect(html.length).toBeGreaterThan(500);
      expect(html).toContain(marker);
      assertHashedIslands(html, path);
    });
  }

  it('/devtoberfest/ root served by CAP; a known subpage still resolves', async () => {
    // Root must be 200 from CAP
    const root = await fetchWithRetry(`${BASE_URL}/devtoberfest/`, { redirect: 'follow' });
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type') || '').toContain('text/html');
    expect(await root.text()).toContain('id="devtoberfest-mount"');

    // /devtoberfest/faq/ is a static subpage served below the flipped root —
    // 200 or a redirect (301/302) is acceptable; what must NOT happen is a 404/500.
    const sub = await fetchWithRetry(`${BASE_URL}/devtoberfest/faq/`);
    expect([200, 301, 302]).toContain(sub.status);
  });

  it('/sitemap.xml → 200 XML from CAP containing <urlset', async () => {
    const r = await fetchWithRetry(`${BASE_URL}/sitemap.xml`, { redirect: 'follow' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') || '').toContain('xml');
    const body = await r.text();
    expect(body).toContain('<urlset');
  });

  it('homepage / is NOT yet flipped — still 200 via catch-all static', async () => {
    // / is served by approuter static, NOT yet in the CAP page store.
    // This test documents the boundary and will need updating when / flips.
    const r = await fetchWithRetry(`${BASE_URL}/`, { redirect: 'follow' });
    expect(r.status).toBe(200);
  });
});
