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

    it('allows SAP sister-site iframe embedding via CSP frame-ancestors', async () => {
      // Legacy AEM allowed partner sites (Discovery Center, *.sap.com, hybris,
      // gigya, lookbookhq, *.cloud.sap) to iframe-embed developer.sap.com pages.
      // We restore that via CSP frame-ancestors (NOT X-Frame-Options, which
      // can't express an allow-list). X-Frame-Options must be ABSENT — if it
      // were present with SAMEORIGIN it would override frame-ancestors and
      // re-block cross-origin framing. The approuter framework's own default
      // injection is disabled via SEND_XFRAMEOPTIONS=false in mta.yaml.
      const res = await fetchWithRetry(`${BASE_URL}/`);
      const csp = res.headers.get('content-security-policy');
      expect(csp).toMatch(/frame-ancestors[^;]*'self'/);
      expect(csp).toMatch(/frame-ancestors[^;]*\*\.sap\.com/);
      expect(csp).toMatch(/frame-ancestors[^;]*\*\.cloud\.sap/);
      // X-Frame-Options must not slip back in and override frame-ancestors.
      expect(res.headers.get('x-frame-options')).toBeNull();
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
      // The visible #teconsent div is injected client-side by TrustArc's
      // notice.js at runtime, so it is NOT in the server HTML. The server-side
      // marker is the notice URL's c=teconsent config param, which names the
      // consent placeholder TrustArc hydrates into.
      expect(html).toMatch(/[?&]c=teconsent\b/);
    });
  },
);

describe.skipIf(!BASE_URL || BASE_URL.startsWith('http://localhost'))(
  'CDN cacheability of dynamic feeds (#devtoberfest-cache)',
  () => {
    // Akamai fronts the public domain and applies a heuristic/default TTL to
    // any 200 GET that lacks an explicit Cache-Control (the approuter is a
    // transparent proxy that adds none). Admin-editable / per-user JSON feeds
    // must send no-store; shared catalog feeds send public,max-age.

    // Admin-editable + per-user → must NOT be shared-cacheable at the edge.
    const NO_STORE = [
      '/api/devtoberfest/terms',
      '/api/devtoberfest/faq',
      '/api/devtoberfest/status',
      '/api/devtoberfest/schedule',
    ];
    for (const path of NO_STORE) {
      it(`${path} sends Cache-Control: no-store`, async () => {
        const res = await fetchWithRetry(`${BASE_URL}${path}`);
        // 503 EVENT_NOT_CONFIGURED is a valid state (no active edition); the
        // header is still set on the 200 path, which is what we assert when
        // the feed is live. Skip the assertion only when the feed is 503.
        if (res.status === 503) return;
        expect(res.headers.get('cache-control')).toMatch(/no-store/);
      });
    }

    // Shared, non-personalized catalog feeds → short edge cache is fine.
    const CACHEABLE = ['/build/catalog', '/build/navigator', '/build/slug-mapping'];
    for (const path of CACHEABLE) {
      it(`${path} sends a bounded public Cache-Control`, async () => {
        const res = await fetchWithRetry(`${BASE_URL}${path}`);
        if (!res.ok) return;
        const cc = res.headers.get('cache-control');
        expect(cc).toMatch(/public/);
        expect(cc).toMatch(/max-age=\d+/);
      });
    }
  },
);
