import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

// Sweeps all 17 app.post() routes in srv/server.js:
//   - 10 bearer-required (contentAuthMiddleware) reject unauth + wrong bearer
//   - 5 XSUAA-required reject unauth (401/403)
//   - 3 public-POST hardening checks: malformed JSON, empty body, 5MB payload
// Any 500 is a real DoS/logic surface — file a follow-up and .skip the case.
describe.skipIf(!SRV_URL || SRV_URL.startsWith('http://localhost'))(
  'Custom Express route auth + input hardening (#797)',
  () => {
    describe('bearer-token-required routes', () => {
      const bearerRoutes = [
        { path: '/content/publish', method: 'POST' },
        { path: '/content/publish/begin', method: 'POST' },
        { path: '/content/publish/append', method: 'POST' },
        { path: '/content/publish/commit', method: 'POST' },
        { path: '/content/publish/abort', method: 'POST' },
        { path: '/content/rollback', method: 'POST' },
        { path: '/content/orphan-purge', method: 'POST' },
        { path: '/content/code-check-specs', method: 'POST' },
        { path: '/content/validate-answer-specs', method: 'POST' },
        { path: '/build/repo-catalog', method: 'POST' },
      ];
      it.each(bearerRoutes)('$method $path without Authorization → 401', async ({ path, method }) => {
        const res = await fetchWithRetry(`${SRV_URL}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        expect(res.status).toBe(401);
      });

      it('POST /content/publish with wrong bearer → 403', async () => {
        // contentAuthMiddleware (srv/lib/content-store.js:224-243) distinguishes
        // missing creds (401) from wrong creds (403) per RFC 7235 — the
        // timing-safe compare at line 237 returns 403 when the bytes don't match.
        const res = await fetchWithRetry(`${SRV_URL}/content/publish`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer definitely-not-the-key',
          },
          body: '{}',
        });
        expect(res.status).toBe(403);
      });
    });

    describe('XSUAA-required routes (unauthenticated → 401/403)', () => {
      const xsuaaRoutes = [
        '/admin/analytics/export',
        '/admin/advocates/foo/photo',
        '/api/codecheck',
        '/api/validate-answer',
        '/chat/stream',
      ];
      it.each(xsuaaRoutes)('POST %s without XSUAA → 401/403', async (path) => {
        const res = await fetchWithRetry(`${SRV_URL}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        expect([401, 403]).toContain(res.status);
      });
    });

    describe('public POST hardening', () => {
      it('POST /api/ui-event with malformed JSON → 400', async () => {
        const res = await fetchWithRetry(`${SRV_URL}/api/ui-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not-json{{',
        });
        expect(res.status).toBe(400);
      });

      it('POST /feedback/submit with empty body → 400 or 422', async () => {
        const res = await fetchWithRetry(`${SRV_URL}/feedback/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        // Rate-limiter may 429 or handler may 400/422 for missing fields.
        expect([400, 422, 429]).toContain(res.status);
      });

      it('POST /api/ui-event with 5MB payload rejected (413) or accepted (2xx) but bounded', async () => {
        const huge = 'x'.repeat(5 * 1024 * 1024);
        const res = await fetchWithRetry(`${SRV_URL}/api/ui-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: huge }),
        });
        // Either the express.json({limit}) rejects (413) or the handler ignores it (2xx).
        // If it 500s, that's a real DoS surface — file a follow-up issue.
        expect([200, 204, 400, 413]).toContain(res.status);
      });
    });
  }
);
