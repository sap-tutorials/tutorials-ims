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
  { path: '/topics/',              marker: 'id="topics-tree-root"'   },
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

// Collect the src paths of island-src bundle scripts in the HTML.
//
// Island bundles are emitted as <script type="module" src="/js/name-hash.js">
// (baseof.html:61,68-71 and per-page layouts like browse/list.html).
// Attribute order varies — cmd-palette (baseof.html:61) puts src before
// type="module"; most others put type="module" first. We match the full
// opening <script ...> tag and check for both attrs independent of order.
//
// Excluded intentionally:
//  - Vendor scripts (markdown-it.min.js, purify.min.js) and joule scripts:
//    bare `defer` without type="module" (baseof.html:55-59).
//  - /js/ui5-bootstrap.js: Hugo esbuild asset (assets/js/ui5-bootstrap.ts),
//    NOT a Vite island, intentionally never content-hashed (no | fingerprint).
//  - Query-string paths like /js/featured-rail.js?v=<unix>: [^"?] stops at ?
//    so these never match the src="..." capture.
function collectIslandSrcs(html) {
  const results = [];
  for (const [, rawAttrs] of html.matchAll(/<script([^>]*)>/g)) {
    // Production HTML is Hugo-minified: attribute values lose their quotes
    // (type="module" → type=module, src="/js/x.js" → src=/js/x.js). Strip
    // quotes so this matches both minified (deployed) and unminified (local)
    // output — otherwise the src="..." capture finds nothing on a live env
    // and every hash check silently no-ops.
    const attrs = rawAttrs.replace(/["']/g, '');
    if (!/\btype=module\b/.test(attrs)) continue;
    const m = attrs.match(/\bsrc=(\/js\/[^\s>?]+\.js)/);
    if (!m) continue;
    const src = m[1];
    // Hugo esbuild assets are not content-hashed by design — skip.
    if (src.includes('ui5-bootstrap')) continue;
    results.push(src);
  }
  return results;
}

// Production HTML is Hugo-minified, so attribute values lose their quotes
// (id="browse-results" → id=browse-results). Compare quote-insensitively so a
// marker matches both the deployed (minified) and local (unminified) forms.
const stripQuotes = (s) => s.replace(/["']/g, '');
function assertContainsMarker(html, marker, path) {
  expect(
    stripQuotes(html).includes(stripQuotes(marker)),
    `marker ${marker} not found on ${path}`
  ).toBe(true);
}

function assertHashedIslands(html, path) {
  const srcs = collectIslandSrcs(html);
  if (srcs.length === 0) return; // page has no /js/*.js islands — skip hash check
  // Vite content hashes are base64url ([A-Za-z0-9_-]) and always contain at
  // least one uppercase letter or digit (the entropy discriminator).  Bare
  // island names are all-lowercase kebab-case, so they never satisfy that
  // requirement.  The lookahead is scoped to the TRAILING segment after the
  // last name-separating hyphen, so a digit embedded in the island NAME itself
  // (e.g. `oauth2-client.js` → trailing segment `client`) does not falsely
  // pass. This also correctly handles hashes that themselves contain hyphens
  // (e.g. `homepage-explainers-Cy2N-GCe.js`), which the previous char-class
  // `[A-Za-z0-9_]` (missing `-`) false-flagged as unhashed.
  const unhashed = srcs.filter(s => !/-(?=[A-Za-z0-9_-]*[A-Z0-9])[A-Za-z0-9_-]{6,}\.js$/.test(s));
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
      assertContainsMarker(html, marker, path);
      assertHashedIslands(html, path);
    });
  }

  it('/devtoberfest/ root served by CAP; a known subpage still resolves', async () => {
    // Root must be 200 from CAP
    const root = await fetchWithRetry(`${BASE_URL}/devtoberfest/`, { redirect: 'follow' });
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type') || '').toContain('text/html');
    assertContainsMarker(await root.text(), 'id="devtoberfest-mount"', '/devtoberfest/');

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

  it('/index.xml → 200 XML from CAP RSS feed containing <rss', async () => {
    const r = await fetchWithRetry(`${BASE_URL}/index.xml`, { redirect: 'follow' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') || '').toContain('xml');
    const body = await r.text();
    expect(body).toContain('<rss');
  });

  it('/llms-full.txt → 200 plain-text catalog containing marker', async () => {
    const r = await fetchWithRetry(`${BASE_URL}/llms-full.txt`, { redirect: 'follow' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') || '').toContain('text/plain');
    const body = await r.text();
    expect(body).toContain('# SAP Developers Tutorials');
  });

  it('homepage / is NOT yet flipped — still 200 via catch-all static', async () => {
    // / is served by approuter static, NOT yet in the CAP page store.
    // This test documents the boundary and will need updating when / flips.
    const r = await fetchWithRetry(`${BASE_URL}/`, { redirect: 'follow' });
    expect(r.status).toBe(200);
  });
});
