// test/prize-barcode-endpoint.test.js
// #2861 follow-up — regression guard for the GET /api/my-prize-barcode 401.
//
// The App Space checkpoint barcode is fetched by the browser from this route.
// Two defects shipped in #2861 made it 401 for EVERY logged-in visitor:
//   1. The route was a bootstrap `app.get('/api/my-prize-barcode', handler)`
//      registered directly on Express, BEFORE CAP's protocol middleware chain,
//      so the auth strategy never ran → cds.context.user/req.user were null.
//      Fix: mount cds.middlewares.context()/auth() in front of the route
//      (srv/server.js), matching the /api/alerts/me pattern.
//   2. The handler resolved identity with the read-only resolveDbUserScoped,
//      which returns null for a logged-in user with no DB row yet → 401.
//      Fix: use the canonical tiered getOrProvisionDbUser (prize-barcode-handler.js).
//
// A pure unit test on the handler cannot catch defect #1 (it calls the handler
// directly, bypassing the middleware chain). This boots the real server so the
// full auth wiring is exercised — the only level at which the bug reproduces.

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const URL = '/api/my-prize-barcode?eventId=10000015';
const devAuth = { auth: { username: 'developer', password: 'developer' } };

describe('GET /api/my-prize-barcode (#2861 401 regression)', () => {
  it('401s for an anonymous (unauthenticated) request', async () => {
    const res = await project.get(URL, { validateStatus: () => true });
    expect(res.status).toBe(401);
  });

  it('returns a 200 image/png barcode for an authenticated visitor', async () => {
    // Pre-fix this returned 401 even with a valid session because CAP's auth
    // middleware never ran on the bootstrap route → the handler saw no user.
    const res = await project.get(URL, {
      ...devAuth,
      responseType: 'arraybuffer',
      validateStatus: () => true,
    });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('image/png');
    expect(String(res.headers['cache-control'])).toContain('no-store');
    // PNG magic bytes — confirm it is a real image, not an error body.
    const buf = Buffer.from(res.data);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 4).toString('hex')).toBe('89504e47');
  });
});
