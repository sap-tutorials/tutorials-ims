// test/smoke/asset-retention.smoke.test.js
//
// Post-deploy smoke: every bundle listed in the live /_retained-assets.json
// must serve 200. Confirms that the retention step actually shipped prior-
// build hashed bundles alongside the new build's bundles, so in-flight
// browser sessions (holding stale /js/<hash>.js or /css/<hash>.css URLs
// from the previous deploy) don't 404.
//
// Skipped unless SMOKE_BASE_URL is set — runs only against a deployed env,
// never locally.

import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

// Self-skip when running locally without a smoke target. Mirrors the pattern
// used by browse.smoke.test.js and other tests that only make sense against
// a live deployed approuter.
const SMOKE_TARGET = process.env.SMOKE_BASE_URL;
const describeIf = SMOKE_TARGET ? describe : describe.skip;

// Parse the manifest body, failing with a clear message if it's not valid JSON.
async function parseManifest(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    expect.fail(
      '/_retained-assets.json returned 200 but body was not valid JSON: ' +
      text.slice(0, 120)
    );
  }
}

describeIf('asset retention', () => {
  it('/_retained-assets.json is reachable and is a JSON array', async () => {
    // redirect: 'follow' — static file, no redirect expected, but follow any
    // approuter rewrite rather than surface a false 3xx failure.
    const res = await fetchWithRetry(`${BASE_URL}/_retained-assets.json`, { redirect: 'follow' });
    expect(res.status).toBe(200);
    const manifest = await parseManifest(res);
    expect(Array.isArray(manifest)).toBe(true);
  });

  it('every bundle in _retained-assets.json serves 200', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/_retained-assets.json`, { redirect: 'follow' });
    expect(res.status).toBe(200);
    const manifest = await parseManifest(res);
    expect(Array.isArray(manifest)).toBe(true);

    for (const { file } of manifest) {
      const kind = file.endsWith('.css') ? 'css' : 'js';
      const r = await fetchWithRetry(`${BASE_URL}/${kind}/${file}`, { method: 'HEAD', redirect: 'follow' });
      expect(r.status, `${file} should serve 200`).toBe(200);
    }
  });
});
