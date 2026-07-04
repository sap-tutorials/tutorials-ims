// test/integration/homepage/personalized-endpoint.test.js
//
// (#763) Integration tests for GET /homepage/personalized.
// Verifies auth gate, kill-switch 204, full 200 envelope, and 304 ETag.
//
// Notes:
//  - "alice" is not in .cdsrc.json mock users; CAP mocked auth grants
//    `authenticated-user` role to any unlisted user that presents credentials.
//    That satisfies the @(requires:'authenticated-user') annotation.
//  - HomepageConfig is manipulated directly via db to avoid the Admin-scoped
//    /admin/HomepageConfig endpoint (AdminService is @requires:'Admin').

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /homepage/personalized', () => {
  // ── helper: set personalizationEnabled in DB ─────────────────────────────
  async function setPersonalizationEnabled(enabled) {
    const db = await cds.connect.to('db');
    const { HomepageConfig } = cds.entities('com.sap.developers.ims');
    await db.run(
      UPDATE(HomepageConfig).set({ personalizationEnabled: enabled })
    );
  }

  // ── 1. Unauthenticated → 401 ─────────────────────────────────────────────
  it('401 without auth', async () => {
    const r = await project.get('/homepage/personalized', {
      validateStatus: () => true,
    });
    expect(r.status).toBe(401);
  });

  // ── 2. Kill switch off → 204 ─────────────────────────────────────────────
  it('204 when kill switch is off', async () => {
    await setPersonalizationEnabled(false);
    const r = await project.get('/homepage/personalized', {
      auth: { username: 'alice', password: 'password' },
      validateStatus: () => true,
    });
    expect(r.status).toBe(204);
  });

  // ── 3. Kill switch on → 200 with envelope ────────────────────────────────
  it('200 with envelope when enabled', async () => {
    await setPersonalizationEnabled(true);
    const r = await project.get('/homepage/personalized', {
      auth: { username: 'alice', password: 'password' },
      validateStatus: () => true,
    });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.headers['x-personalization']).toBe('1');
    expect(r.data.hash).toBeDefined();
    expect(r.data.verbOrder).toHaveLength(6);
    expect(r.data.shelfOverrides).toBeDefined();
  });

  // ── 3b. Payload size guard (< 10 KB) ─────────────────────────────────────
  it('200 payload is under 10 KB', async () => {
    await setPersonalizationEnabled(true);
    const r = await project.get('/homepage/personalized', {
      auth: { username: 'alice', password: 'password' },
      validateStatus: () => true,
    });
    expect(r.status).toBe(200);
    const bytes = Buffer.byteLength(JSON.stringify(r.data), 'utf8');
    expect(bytes).toBeLessThan(10 * 1024);
  });

  // ── 4. ETag → 304 on matching If-None-Match ──────────────────────────────
  it('returns 304 on matching If-None-Match', async () => {
    await setPersonalizationEnabled(true);
    const first = await project.get('/homepage/personalized', {
      auth: { username: 'alice', password: 'password' },
      validateStatus: () => true,
    });
    expect(first.status).toBe(200);
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();
    const second = await project.get('/homepage/personalized', {
      auth: { username: 'alice', password: 'password' },
      headers: { 'if-none-match': etag },
      validateStatus: () => true,
    });
    expect(second.status).toBe(304);
  });
});
