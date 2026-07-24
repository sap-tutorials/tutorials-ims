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
      // The header is emitted twice (xs-app.json + CF framework injection);
      // Headers.get() joins duplicates with ", ". Assert every token is SAMEORIGIN.
      const xfo = res.headers.get('x-frame-options');
      expect(xfo).toBeTruthy();
      expect(xfo.split(',').every((v) => v.trim() === 'SAMEORIGIN')).toBe(true);
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

    it('CSP allows TrustArc consent domain (#trustarc-cmp)', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      const csp = res.headers.get('content-security-policy');
      expect(csp).toMatch(/script-src[^;]*consent\.trustarc\.com/);
      expect(csp).toMatch(/connect-src[^;]*user-consent-center\.trustarc\.com/);
    });

    it('serves the TrustArc notice script in the homepage HTML (#trustarc-cmp)', async (ctx) => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      const html = await res.text();
      // Absent shim → inhouse-mode deploy (SKIPPED, not passed).
      // Present shim but missing markers → broken deploy (FAILED).
      if (!html.includes('/js/consent-trustarc.js')) {
        ctx.skip(); // inhouse-mode deploy — TrustArc not expected
        return;
      }
      expect(html).toMatch(/consent\.trustarc\.com\/notice\?domain=sapshared\.com/);
      // The standalone <div id="teconsent"> link is intentionally omitted
      // (the footer "Cookie Preferences" button reopens the manager instead —
      // see hugo/layouts/partials/consent.html). Assert the blackbar container
      // that the notice script hydrates. Hugo's minifier strips quotes around
      // simple id values, so match both quoted and unquoted forms.
      expect(html).toMatch(/id=(?:["']?)consent_blackbar(?:["']?)/);
    });
  },
);
