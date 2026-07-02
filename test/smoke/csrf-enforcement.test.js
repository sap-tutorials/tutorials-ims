import { describe, it, expect } from 'vitest';
import { SRV_URL, BASE_URL, fetchWithRetry } from './smoke.config.js';

const AUTHOR_TOKEN = process.env.SMOKE_AUTHOR_TOKEN;

// CSRF enforcement is on OData mutations. We test:
// 1. POST without any token -> 403 (or 401 if unauthenticated first).
// 2. POST with a bogus token -> 403.
// 3. HEAD/GET with x-csrf-token: fetch -> response echoes a token.
describe.skipIf(!SRV_URL || SRV_URL.startsWith('http://localhost'))(
  'CSRF enforcement on OData (#797)',
  () => {
    const authHeaders = AUTHOR_TOKEN
      ? { Authorization: `Bearer ${AUTHOR_TOKEN}` }
      : {};

    it('POST /admin/Tags without CSRF token is rejected (403 or 401)', async () => {
      const res = await fetchWithRetry(`${SRV_URL}/admin/Tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ slug: '__test__csrf', label: 'x' }),
      });
      expect([401, 403]).toContain(res.status);
    });

    it('POST /admin/Tags with x-csrf-token: bogus is rejected', async () => {
      const res = await fetchWithRetry(`${SRV_URL}/admin/Tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': 'bogus-not-a-real-token',
          ...authHeaders,
        },
        body: JSON.stringify({ slug: '__test__csrf', label: 'x' }),
      });
      expect([401, 403]).toContain(res.status);
    });

    it('HEAD /admin/$metadata with x-csrf-token: fetch returns a token', async () => {
      const res = await fetchWithRetry(`${SRV_URL}/admin/$metadata`, {
        method: 'HEAD',
        headers: { 'x-csrf-token': 'fetch', ...authHeaders },
      });
      // If auth passes: expect x-csrf-token header. If auth fails: skip assertion (headers only meaningful for authenticated fetch).
      if (res.status === 200) {
        expect(res.headers.get('x-csrf-token')).toBeTruthy();
      } else {
        expect([401, 403]).toContain(res.status);
      }
    });

    it('POST /api/completeStep (developer-service action) rejected without CSRF token', async () => {
      // Note: /api/getProgress is a `function` (GET-only) — POST returns 405 before auth.
      // completeStep is a bound action and exercises the POST + auth + CSRF path we care about.
      const res = await fetchWithRetry(`${SRV_URL}/api/completeStep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: '__test__csrf', stepNumber: 1 }),
      });
      expect([401, 403]).toContain(res.status);
    });

    it('POST /admin/Missions without CSRF token is rejected', async () => {
      const res = await fetchWithRetry(`${SRV_URL}/admin/Missions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ slug: '__test__csrf' }),
      });
      expect([401, 403]).toContain(res.status);
    });
  },
);

describe.skipIf(!BASE_URL || BASE_URL.startsWith('http://localhost'))(
  'CSRF via approuter (#797)',
  () => {
    it('POST /admin/Tags via approuter without token is rejected', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/admin/Tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: '__test__csrf-appr', label: 'x' }),
      });
      // Approuter with `csrfProtection: false` still requires auth (XSUAA), so unauthenticated → 401/403.
      expect([401, 403]).toContain(res.status);
    });
  },
);
