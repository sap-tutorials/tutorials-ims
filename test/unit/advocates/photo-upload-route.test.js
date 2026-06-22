/**
 * Issue #417 regression test — POST /admin/advocates/:slug/photo authentication.
 *
 * Bug report (2026-06-21): Tom hit "Admin scope required" 403 from the Admin UI
 * even though his JWT contains the Admin scope.
 *
 * Root cause hypothesis (Phase 1-3 of systematic-debugging):
 *
 *   The handler at srv/server.js:325 reads `req.user?.is?.('Admin')` only.
 *   When `multer` is chained between `cds.middlewares.auth()` and the handler,
 *   `req.user` is not reliably populated (CAP populates `cds.context.user`
 *   via async local storage; some adapters mirror onto req.user, but multer's
 *   body parse can interfere). The companion analytics-export handler at
 *   srv/lib/analytics-export-handler.js:16 explicitly falls back to
 *   `req.user || cds.context?.user` and documents the failure mode.
 *
 *   PR #514 shipped without an end-to-end auth test for this route; the
 *   acceptance criterion "hybrid test exercises the new endpoint with auth"
 *   was met only for the storage helper, not the express route.
 *
 * This test asserts the route accepts an authenticated admin upload (200 + JSON
 * shape) — reproducing the bug as a 403 before the fix lands.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { readFile } from 'node:fs/promises';

const project = cds.test('serve', '--project', '.', '--in-memory');

const ADMIN_BASIC = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const SLUG = '__test__photo-auth-' + Date.now().toString(36);
const ADVOCATE_ID = 'ADC00417-FFFF-0000-0000-000000000001';

describe('POST /admin/advocates/:slug/photo — auth integration (#417 regression)', () => {
  let baseUrl;
  let portraitBytes;

  beforeAll(async () => {
    baseUrl = project.url;
    portraitBytes = await readFile('test/unit/advocates/fixtures/portrait.jpg');

    const db = await cds.connect.to('db');
    const { Advocates } = cds.entities('com.sap.developers.ims');
    await db.run(
      INSERT.into(Advocates).entries({
        ID: ADVOCATE_ID,
        slug: SLUG,
        firstName: '__TEST__',
        lastName: 'PhotoAuth',
        region: 'AMERICAS',
        isActive: true,
      }),
    );
  });

  afterAll(async () => {
    const db = await cds.connect.to('db');
    const { Advocates, AdvocatePhotos } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(AdvocatePhotos).where({ advocate_ID: ADVOCATE_ID }));
    await db.run(DELETE.from(Advocates).where({ ID: ADVOCATE_ID }));
  });

  it('returns 200 when an authenticated admin uploads a valid image', async () => {
    const fd = new FormData();
    // Wrap the Buffer in a Blob for FormData compatibility.
    fd.append('photo', new Blob([portraitBytes], { type: 'image/jpeg' }), 'portrait.jpg');

    const res = await fetch(`${baseUrl}/admin/advocates/${SLUG}/photo`, {
      method: 'POST',
      body: fd,
      headers: { Authorization: ADMIN_BASIC },
    });

    // BEFORE FIX: this would fail with 403 'Admin scope required' because
    // req.user.is('Admin') returns false despite the admin user being
    // authenticated (req.user is the anonymous-default after multer runs).
    // AFTER FIX: 200 + photoUrl JSON.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe(SLUG);
    expect(typeof body.sha256).toBe('string');
    expect(body.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(body.sizeBytes).toBeGreaterThan(0);
  });

  it('returns 401 for anonymous callers (no Authorization header)', async () => {
    const fd = new FormData();
    fd.append('photo', new Blob([portraitBytes], { type: 'image/jpeg' }), 'portrait.jpg');
    const res = await fetch(`${baseUrl}/admin/advocates/${SLUG}/photo`, {
      method: 'POST',
      body: fd,
    });
    // Anonymous: should be rejected (401 preferred over 403 for unauthenticated).
    expect([401, 403]).toContain(res.status);
  });

  it('returns 403 when a non-admin authenticated user attempts to upload', async () => {
    const devAuth = 'Basic ' + Buffer.from('developer:developer').toString('base64');
    const fd = new FormData();
    fd.append('photo', new Blob([portraitBytes], { type: 'image/jpeg' }), 'portrait.jpg');
    const res = await fetch(`${baseUrl}/admin/advocates/${SLUG}/photo`, {
      method: 'POST',
      body: fd,
      headers: { Authorization: devAuth },
    });
    expect(res.status).toBe(403);
  });

  it('reads cds.context.user not just req.user (deployed XSUAA + multer regression guard)', async () => {
    // Issue #417 regression: the original handler read only `req.user?.is?.('Admin')`.
    // Per CAP June-2024 docs, req.user is "internal to authentication strategies
    // and not public API" — the deployed XSUAA path doesn't reliably mirror
    // onto req.user when multer sits between auth and the handler. The fix
    // reads `cds.context.user` first (canonical), with req.user as a fallback.
    //
    // To verify the fix lives, this test reads srv/server.js as source text
    // and asserts the canonical-user pattern is in place. A regression to
    // bare `req.user?.is?.('Admin')` would fail this assertion.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile('srv/server.js', 'utf8');
    // The photo route's auth gate must consult cds.context.user.
    const photoSection = source.slice(
      source.indexOf("app.post('/admin/advocates/:slug/photo',"),
      source.indexOf("// AnalyticsService at /admin/analytics"),
    );
    expect(photoSection).toMatch(/cds\.context\?\.user|cds\.context\.user/);
    expect(photoSection).toMatch(/typeof\s+user\.is\s*===\s*['"]function['"]/);
  });
});
