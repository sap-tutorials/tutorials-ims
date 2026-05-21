import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

const TRIALS_TARGET = 'https://www.sap.com/products/try-sap/trials-downloads.html';

describe('Legacy redirects (AEM cutover continuity)', () => {
  it('GET /trials-downloads.html returns 301 to sap.com', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/trials-downloads.html`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(TRIALS_TARGET);
  });

  it('GET /trials-downloads.html?search=... preserves the query string', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/trials-downloads.html?search=sdk%20for%20android`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${TRIALS_TARGET}?search=sdk%20for%20android`);
  });

  it('HEAD /trials-downloads.html also redirects', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/trials-downloads.html`, { method: 'HEAD' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(TRIALS_TARGET);
  });
});
