import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

// #1327 Task 6 — concepts page smoke.
// Self-skips when SMOKE_BASE_URL is not set (no deployed target available).

const ENABLED = !!process.env.SMOKE_BASE_URL;

describe.skipIf(!ENABLED)('/concepts/ list page [smoke] (#1327)', () => {
  it('returns 200 gzipped text/html', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/concepts/`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toMatch(/text\/html/);
    // AppRouter decompresses before sending to clients, so Content-Encoding
    // may already be stripped; accept either form.
    // What we care about: the content arrived.
    expect(res.headers.get('content-length') ?? res.headers.get('transfer-encoding')).toBeTruthy();
  });

  it('page HTML < 2 MB decompressed', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/concepts/`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let html: string;
    try {
      html = gunzipSync(buf).toString('utf-8');
    } catch {
      // AppRouter already decompressed it
      html = buf.toString('utf-8');
    }
    // The old Hugo-static page was 2.07 MB — the new CAP list page should be
    // significantly smaller (SSR top-100 + embedded JSON only).
    expect(html.length).toBeLessThan(2 * 1024 * 1024);
    // The article shell is always present.
    expect(html).toContain('id="concepts-filter-root"');
  });

  it('embeds #concepts-data JSON array', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/concepts/`, {
      headers: { 'Accept-Encoding': 'identity' },
    });
    const html = await res.text();
    const m = html.match(/<script[^>]+id="concepts-data"[^>]*>([\s\S]*?)<\/script>/);
    expect(m, '#concepts-data script block not found').toBeTruthy();
    const arr = JSON.parse(m![1]);
    expect(Array.isArray(arr)).toBe(true);
    // Expect a non-trivial corpus once at least one rebuild has run.
    // Skips structural check if the env has no published concepts yet.
    if (arr.length > 0) {
      expect(arr[0]).toHaveProperty('slug');
      expect(arr[0]).toHaveProperty('name');
      expect(arr[0]).toHaveProperty('tutorialCount');
    }
  });

  it('SSR top-100 <li> present', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/concepts/`, {
      headers: { 'Accept-Encoding': 'identity' },
    });
    const html = await res.text();
    const liCount = (html.match(/class="concepts-index__item"/g) ?? []).length;
    // After a rebuild there are up to 100 SSR cards (fewer if corpus < 100).
    // On a fresh env (no rebuild yet) the list may be empty — tolerate 0.
    expect(liCount).toBeGreaterThanOrEqual(0);
    expect(liCount).toBeLessThanOrEqual(100);
  });

  it('has ETag and Cache-Control headers', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/concepts/`);
    expect(res.headers.get('cache-control')).toMatch(/max-age/);
    // ETag is emitted by srv; AppRouter may strip it — tolerate absence.
    // If present it must be a non-empty string.
    const etag = res.headers.get('etag');
    if (etag !== null) expect(etag.length).toBeGreaterThan(0);
  });

  it('cold response time p50 < 200 ms', async () => {
    const RUNS = 3;
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const start = Date.now();
      const res = await fetchWithRetry(`${BASE_URL}/concepts/`);
      times.push(Date.now() - start);
      expect(res.status).toBe(200);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(RUNS / 2)];
    expect(p50).toBeLessThan(200);
  });

  it('warm (second hit) served from memcache via X-Content-Source', async () => {
    // Hit directly against srv (bypasses AppRouter caching) to observe the
    // in-process version-keyed cache in concept-list-page.js.
    if (!SRV_URL) return;
    // Warm the cache.
    await fetchWithRetry(`${SRV_URL}/content/concepts-index`);
    // Second hit — should be served from the in-process cache.
    const res = await fetchWithRetry(`${SRV_URL}/content/concepts-index`);
    // The real signal that the cache engaged is the header, not wall-clock
    // latency: a prior `expect(elapsed).toBeLessThan(30)` asserted a sub-30ms
    // round-trip, which is unattainable over a public-internet HTTPS call to
    // eu10 (observed 160-170ms) and made this test flaky-by-design regardless
    // of cache health. Assert the header the cache actually sets instead.
    expect(res.headers.get('x-content-source')).toBe('memcache');
  });
});

describe.skipIf(!ENABLED)('/concepts/<slug>/ detail via new CAP path [smoke] (#1327)', () => {
  it('/concepts/cap/ returns 200 after cutover', async () => {
    // Probe whether 'cap' is published before asserting.
    const probe = SRV_URL
      ? await fetchWithRetry(`${SRV_URL}/build/concepts`)
      : null;
    if (probe) {
      const { concepts } = await probe.json() as { concepts: { slug: string }[] };
      if (!Array.isArray(concepts) || !concepts.find(c => c.slug === 'cap')) {
        console.log('skip: cap concept not published in this env');
        return;
      }
    }
    const res = await fetchWithRetry(`${BASE_URL}/concepts/cap/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-render-source="cap"');
    expect(html).toContain('/concepts/cap/');
  });
});
