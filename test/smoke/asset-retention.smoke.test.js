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

describeIf('asset retention', () => {
  it('/_retained-assets.json is reachable and is a JSON array', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/_retained-assets.json`);
    expect(res.status).toBe(200);
    const manifest = await res.json();
    expect(Array.isArray(manifest)).toBe(true);
  });

  it('every bundle in _retained-assets.json serves 200', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/_retained-assets.json`);
    expect(res.status).toBe(200);
    const manifest = await res.json();
    expect(Array.isArray(manifest)).toBe(true);

    for (const { file } of manifest) {
      const kind = file.endsWith('.css') ? 'css' : 'js';
      const r = await fetchWithRetry(`${BASE_URL}/${kind}/${file}`, { method: 'HEAD' });
      expect(r.status, `${file} should serve 200`).toBe(200);
    }
  });
});
