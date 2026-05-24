// test/smoke/analytics.test.js
import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

const hasUrls = !!process.env.SMOKE_BASE_URL && !!process.env.SMOKE_SRV_URL;

describe.skipIf(!hasUrls)('analytics smoke', () => {
  it('GET /analytics-ui/ unauthenticated -> 302/401 or 200+JS-redirect', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/analytics-ui/`);
    // Approuter may JS-redirect (200 with /oauth/authorize body) instead of
    // returning 302 for browser-friendly fragment preservation.
    if (res.status === 200) {
      const body = await res.text();
      expect(body).toMatch(/\/oauth\/authorize/);
    } else {
      expect([302, 401]).toContain(res.status);
    }
  });

  it('GET /admin/analytics/$metadata unauthenticated -> 401', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/admin/analytics/$metadata`);
    expect(res.status).toBe(401);
  });
});
