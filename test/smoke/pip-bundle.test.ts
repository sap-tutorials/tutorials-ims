import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

const BASE = process.env.SMOKE_BASE_URL ?? BASE_URL;
const SRV = process.env.SMOKE_SRV_URL ?? SRV_URL;

// The PiP bundles are content-hashed (#1604), so their filenames are
// tutorial-pip-launcher-<hash>.js / tutorial-pip-<hash>.js. Discover the
// real URLs from a served tutorial page (the two scripts are emitted by
// hugo/layouts/tutorials/{single,u1-object-page}.html) rather than fetching
// a fixed /js/<name>.js path.
describe('PiP bundles deployed', () => {
  let html;

  it('discovers a published tutorial page that references the PiP bundles', async () => {
    const res = await fetchWithRetry(`${SRV}/content/hashes`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const slug = Object.keys(body).find(s => !s.startsWith('concept-'));
    expect(slug, 'no published tutorial slug found').toBeTruthy();

    const page = await fetchWithRetry(`${BASE}/tutorials/${slug}/`, { redirect: 'follow' });
    expect(page.status).toBe(200);
    html = await page.text();
  });

  it('serves both PiP island bundles at their hashed URLs', async () => {
    if (!html) return; // discovery step skipped/empty
    // Collect every /js/*.js src on the page, then classify by basename.
    // `tutorial-pip` is a prefix of `tutorial-pip-launcher` (and Vite hashes
    // can contain hyphens), so prefix regexes cross-match — pick each bundle
    // by explicit basename inspection instead.
    const srcs = [...html.matchAll(/src=["']?([^"'\s>]*\/js\/[^"'\s>]+\.js)/g)].map(m => m[1]);
    const base = (url) => url.split('/').pop().replace(/\?.*$/, '');
    const launcher = srcs.find(u => /^tutorial-pip-launcher(?:-[\w-]+)?\.js$/.test(base(u)));
    const pip = srcs.find(u => {
      const b = base(u);
      return /^tutorial-pip(?:-[\w-]+)?\.js$/.test(b) && !b.startsWith('tutorial-pip-launcher');
    });
    expect(launcher, 'tutorial-pip-launcher island URL not found in tutorial HTML').toBeTruthy();
    expect(pip, 'tutorial-pip island URL not found in tutorial HTML').toBeTruthy();
    for (const url of [launcher, pip]) {
      const res = await fetchWithRetry(BASE + url);
      expect(res.status).toBe(200);
      const txt = await res.text();
      expect(txt.length).toBeGreaterThan(0);
    }
  });
});
