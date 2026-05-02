import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('Content serving (tutorials from HANA)', () => {
  let knownSlug;
  let etag;

  it('GET /content/hashes returns a hash manifest', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/content/hashes`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(typeof body).toBe('object');

    const slugs = Object.keys(body);
    if (slugs.length > 0) {
      knownSlug = slugs[0];
    }
  });

  it('GET /tutorials/<slug>/ returns HTML with ETag', async () => {
    if (!knownSlug) return; // skip if no content published yet

    const res = await fetchWithRetry(`${BASE_URL}/tutorials/${knownSlug}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);

    etag = res.headers.get('etag');
    expect(etag).toBeTruthy();

    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it('GET /tutorials/<slug>/ with If-None-Match returns 304', async () => {
    if (!knownSlug || !etag) return;

    const res = await fetchWithRetry(`${BASE_URL}/tutorials/${knownSlug}/`, {
      headers: { 'If-None-Match': etag },
    });
    expect(res.status).toBe(304);
  });

  it('GET /tutorials/non-existent-slug-xyz/ returns 404', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/tutorials/non-existent-slug-xyz/`);
    expect(res.status).toBe(404);
  });

  it('GET /content/tutorials/<slug> directly on srv also works', async () => {
    if (!knownSlug) return;

    const res = await fetchWithRetry(`${SRV_URL}/content/tutorials/${knownSlug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });
});
