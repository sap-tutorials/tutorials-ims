import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

describe.skipIf(!BASE_URL || BASE_URL.startsWith('http://localhost'))(
  'Approuter security headers (#797)',
  () => {
    it("sets CSP with default-src 'self'", async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      const csp = res.headers.get('content-security-policy');
      expect(csp).toBeTruthy();
      expect(csp).toMatch(/default-src\s+'self'/);
    });

    it('sets X-Frame-Options SAMEORIGIN', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    });

    it('sets X-Content-Type-Options nosniff', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('sets Strict-Transport-Security with includeSubDomains and preload', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      const hsts = res.headers.get('strict-transport-security');
      expect(hsts).toBeTruthy();
      expect(hsts).toMatch(/max-age=\d+/);
      expect(hsts).toMatch(/includeSubDomains/);
    });

    it('sets Referrer-Policy strict-origin-when-cross-origin', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    });

    it('CSP script-src allows known SAP hosts', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      const csp = res.headers.get('content-security-policy');
      // Approuter serves ui5 assets from ui5.sap.com; loosening this would be a regression.
      expect(csp).toMatch(/script-src[^;]*ui5\.sap\.com/);
    });
  },
);
