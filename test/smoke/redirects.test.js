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

describe('Migrated AEM redirects (#752)', () => {
  it('GET /leonardo-iot 301s to SAP Community', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/leonardo-iot`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://community.sap.com/topics/leonardo');
  });

  it('GET /abap 301s to the same-origin topic page', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/abap`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/topics/abap-platform.html');
  });
});
