import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

describe('AI bot signal headers', () => {
  it('homepage has Content-Signal and X-Robots-Tag', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-signal')).toMatch(/index=yes/);
    expect(res.headers.get('content-signal')).toMatch(/ai-train=no/);
    expect(res.headers.get('content-signal')).toMatch(/ai-search=yes/);
    expect(res.headers.get('x-robots-tag')).toMatch(/index, follow/);
    expect(res.headers.get('x-robots-tag')).toMatch(/max-image-preview:large/);
  });

  it('tutorial page (HANA-served) has the same headers', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/tutorials/`);
    expect(res.headers.get('content-signal')).toBeTruthy();
    expect(res.headers.get('x-robots-tag')).toBeTruthy();
  });
});
