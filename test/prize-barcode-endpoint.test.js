// test/prize-barcode-endpoint.test.js
// #2861 follow-up — regression guard for the GET /api/my-prize-barcode 401.
//
// The App Space checkpoint barcode is fetched by the browser from this route.
// It 401'd for logged-in visitors. The operative, production-only defect was
// that the handler read the authenticated identity from `req.user`, but on a
// raw Express bootstrap route CAP's auth() middleware populates it on
// `cds.context.user` — `req.user` is only set in CAP service handlers and in
// THIS mocked-basic-auth test harness. So a real XSUAA/IAS login resolved to
// anonymous → provision null → 401, while this very harness stayed green
// (it DOES set req.user). Fix: resolve from cds.context.user with a req.user
// fallback and provision via provisionDbUser (prize-barcode-handler.js) — the
// same idiom the /api/alerts/me and /auth/user routes already use.
//
// This boots the real server to exercise the full middleware + auth wiring.
// The cds.context.user-vs-req.user distinction that was the real bug is guarded
// directly in test/unit/prize-barcode-handler.test.js (this harness cannot
// reproduce it because basic-auth populates req.user).

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
