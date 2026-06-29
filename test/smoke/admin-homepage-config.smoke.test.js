// Smoke test for issue #734 — the admin-shell surfaces HomepageConfig +
// Redirects + Shelves via three top-level nav entries.
//
// Pattern: matches admin-exports.smoke.test.js (the established admin smoke
// test shape). XSUAA gates /admin/* and /admin-ui/* — anonymous requests
// resolve to 401 / 302 / HTML-redirect to /oauth/authorize. With a
// SMOKE_ADMIN_TOKEN env var (tech user), we can hit the OData singleton
// directly and assert the four-field shape.

import { describe, it, expect } from 'vitest';

const APPROUTER = process.env.SMOKE_BASE_URL;
const SRV       = process.env.SMOKE_SRV_URL;

describe.runIf(APPROUTER && SRV)('admin homepage config smoke (#734)', () => {
  it('rejects anonymous request to approuter /admin-ui/ (401, 302, or JS-redirect to XSUAA)', async () => {
    const res = await fetch(`${APPROUTER}/admin-ui/`, { redirect: 'manual' });
    if (res.status === 200) {
      const body = await res.text();
      expect(body).toMatch(/\/oauth\/authorize/);
    } else {
      expect([401, 302]).toContain(res.status);
    }
  });

  it('rejects anonymous request to /admin/HomepageConfig (401, 302, or JS-redirect)', async () => {
    // Hit srv directly. The OData v4 singleton URL must not return 200 with
    // data for an anonymous client. We confirm the route is gated, not what
    // it returns when authenticated.
    const res = await fetch(`${SRV}/admin/HomepageConfig`, { redirect: 'manual' });
    if (res.status === 200) {
      const body = await res.text();
      expect(body).toMatch(/\/oauth\/authorize/);
    } else {
      expect([401, 302]).toContain(res.status);
    }
  });

  // With an admin tech token, hit srv directly and confirm the singleton
  // returns the four expected fields. Tracks the admin-exports.smoke.test.js
  // convention (SMOKE_ADMIN_TOKEN), so this branch runs only in environments
  // that provide a token.
  const ADMIN_TOKEN = process.env.SMOKE_ADMIN_TOKEN;
  describe.runIf(ADMIN_TOKEN)('with admin token', () => {
    it('GET /admin/HomepageConfig: 200 with all four fields', async () => {
      const res = await fetch(`${SRV}/admin/HomepageConfig`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      const body = await res.json();
      // Singleton must always have these four fields (auto-init handler
      // creates the row with defaults if missing — srv/admin-service.js).
      expect(body).toHaveProperty('developerNewsPlaylistId');
      expect(body).toHaveProperty('videoBandEnabled');
      expect(body).toHaveProperty('eventsBandEnabled');
      expect(body).toHaveProperty('communityLaneEnabled');
      // Flags are booleans by spec; playlist ID is a nullable string.
      expect(typeof body.videoBandEnabled).toBe('boolean');
      expect(typeof body.eventsBandEnabled).toBe('boolean');
      expect(typeof body.communityLaneEnabled).toBe('boolean');
    });
  });
});
