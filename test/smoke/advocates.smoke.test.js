import { describe, expect, it } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;
const SRV  = process.env.SMOKE_SRV_URL;

describe.skipIf(!BASE)('GET /developer-advocates/', () => {
  it('returns 200 and contains the mount point + script tag', async () => {
    const res = await fetch(BASE + '/developer-advocates/');
    expect(res.status).toBe(200);
    const html = await res.text();
    // Tolerant of Hugo minifier's quote-stripping
    // (per feedback_hugo_minifier_strips_quotes — the minifier removes
    // attribute quotes when the value contains no special characters).
    expect(html).toMatch(/<main[^>]+id=["']?advocates-mount["']?/);
    expect(html).toMatch(/src=["']?[^"']*\/js\/advocates\.js["']?/);
  });
});

describe.skipIf(!SRV)('GET /api/advocates', () => {
  it('returns 200 JSON with at least one advocate', async () => {
    const res = await fetch(SRV + '/api/advocates');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/json/);
    const body = await res.json();
    expect(Array.isArray(body.advocates)).toBe(true);
    expect(body.advocates.length).toBeGreaterThan(0);
    const first = body.advocates[0];
    expect(first).toHaveProperty('hasPhoto');
    expect(first).toHaveProperty('topics');
    expect(first).toHaveProperty('links');
  });

  it('responds with ETag and Cache-Control', async () => {
    const res = await fetch(SRV + '/api/advocates');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(res.headers.get('cache-control')).toMatch(/max-age=60/);
    expect(res.headers.get('cache-control')).toMatch(/stale-while-revalidate=600/);
  });

  it('returns 304 on If-None-Match round-trip', async () => {
    const first = await fetch(SRV + '/api/advocates');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const res2 = await fetch(SRV + '/api/advocates', {
      headers: { 'If-None-Match': etag },
    });
    expect(res2.status).toBe(304);
  });
});

describe.skipIf(!SRV)('GET /api/advocates/:slug/photo', () => {
  it('returns 404 for a placeholder row (no photo uploaded)', async () => {
    const res = await fetch(SRV + '/api/advocates/placeholder-emea/photo');
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown slug', async () => {
    const res = await fetch(SRV + '/api/advocates/no-such-advocate/photo');
    expect(res.status).toBe(404);
  });
});
