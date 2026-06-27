import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

// Hybrid-only — verifies that Phase 1 Homepage entities deployed correctly
// to HANA with the expected seed data and constraints.
// Run with: ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/homepage-schema.test.js
// Requires: cf login + HANA HDI container binding

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('Homepage entities — HANA schema (hybrid)', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'homepage-schema.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  });

  it('HomepageShelves seed rows loaded with all 6 verbs', async () => {
    const rows = await db.run(SELECT.from('com.sap.developers.ims.HomepageShelves'));
    expect(rows.length).toBeGreaterThanOrEqual(40);
    const verbs = new Set(rows.map(r => r.verb));
    expect(verbs).toEqual(new Set(['LEARN', 'BUILD', 'INTEGRATE', 'OPERATE', 'AI', 'CONNECT']));
  });

  it('LegacyRedirects.fromPath rejects exact-duplicate inserts (assert.unique)', async () => {
    if (!isSafeForWrites() || process.env.ALLOW_HYBRID_WRITES !== 'true') return;
    // The seed CSV already contains '/tutorial-navigator.html'; inserting
    // the exact same fromPath must fail. Case-insensitive uniqueness is
    // enforced at LOOKUP time by srv/lib/legacy-redirects-resolver.js
    // (Phase 3 Task 12), not at the DB level — @assert.unique generates
    // a plain unique index that respects HANA's default case-sensitive
    // collation.
    await expect(
      db.run(INSERT.into('com.sap.developers.ims.LegacyRedirects').entries({
        ID: cds.utils.uuid(),
        fromPath: '/tutorial-navigator.html',  // exact-match duplicate
        toPath: '/tutorial-navigator/',
        statusCode: 301
      }))
    ).rejects.toThrow();
  });

  it('HomepageConfig has exactly one row after deploy', async () => {
    const rows = await db.run(SELECT.from('com.sap.developers.ims.HomepageConfig'));
    expect(rows.length).toBe(1);
  });

  it('AdminService.HomepageConfig is queryable as a singleton projection', async () => {
    const admin = await cds.connect.to('AdminService');
    const row = await admin.tx({ user: { id: 'admin@test', roles: ['Admin'] } }, (tx) =>
      tx.read('HomepageConfig'));
    expect(row).toBeTruthy();
    expect(row).toHaveProperty('developerNewsPlaylistId');
  });
});
