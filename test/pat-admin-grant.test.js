import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { __test } from '../srv/lib/mcp-pat-actions.js';
import { __test as mwTest } from '../srv/lib/mcp-pat-middleware.js';
import cds from '@sap/cds';
import { resolveAdminGrant, upsertAdminGrant, revokeAdminGrant } from '../srv/lib/admin-grant.js';
import { FEATURE_FLAGS } from '../packages/core/feature-flags/registry.js';
import { handleMintPolicy } from '../srv/lib/mcp-pat-actions.js';
import { __setFlagForTest, __resetFlagsForTest } from '../srv/lib/feature-flags/db-flags.js';

const { SELECT, INSERT } = cds.ql;

describe('AdminGrants entity', () => {
  const project = cds.test('serve', '--project', '.', '--in-memory');

  it('persists a grant row keyed by user with expiry', async () => {
    const db = await cds.connect.to('db');
    const { AdminGrants, Users } = cds.entities('com.sap.developers.ims');

    // Create a test user
    const userId = cds.utils.uuid();
    await db.run(INSERT.into(Users).entries({
      ID: userId, email: 'test@example.com', name: 'Test User'
    }));

    const exp = new Date(Date.now() + 30 * 864e5).toISOString();
    await db.run(INSERT.into(AdminGrants).entries({
      ID: cds.utils.uuid(), user_ID: userId, grantedBy: 'tom@sap.com', expiresAt: exp,
    }));
    const [row] = await db.run(SELECT.from(AdminGrants).where({ user_ID: userId }));
    expect(row).toBeDefined();
    expect(row.grantedBy).toBe('tom@sap.com');
  });
});

describe('admin-grant helper', () => {
  cds.test('serve', '--project', '.', '--in-memory');

  let uid;

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { Users } = cds.entities('com.sap.developers.ims');
    const userId = cds.utils.uuid();
    await db.run(INSERT.into(Users).entries({ ID: userId, email: 'grant-test@example.com', name: 'Grant Test' }));
    uid = userId;
  });

  it('resolves false with no grant', async () => {
    expect(await resolveAdminGrant(uid)).toBe(false);
  });

  it('upserts then resolves true, and is idempotent (one row)', async () => {
    await upsertAdminGrant(uid, 'tom@sap.com', 30);
    await upsertAdminGrant(uid, 'tom@sap.com', 30);
    const db = await cds.connect.to('db');
    const { AdminGrants } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(AdminGrants).where({ user_ID: uid }));
    expect(rows.length).toBe(1);
    expect(await resolveAdminGrant(uid)).toBe(true);
  });

  it('resolves false when expired', async () => {
    await upsertAdminGrant(uid, 'tom@sap.com', -1);  // already expired
    expect(await resolveAdminGrant(uid)).toBe(false);
  });

  it('revoke removes the grant', async () => {
    await upsertAdminGrant(uid, 'tom@sap.com', 30);
    expect(await revokeAdminGrant(uid)).toBeGreaterThan(0);
    expect(await resolveAdminGrant(uid)).toBe(false);
  });
});

describe('admin scope + TTL', () => {
  it('accepts admin in valid scopes', () => {
    expect(() => __test.assertValidScopes(['admin'])).not.toThrow();
  });

  it('clamps admin TTL to max 90 and default 30', () => {
    expect(__test.clampTtl(365, { admin: true })).toBe(90);
    expect(__test.clampTtl(undefined, { admin: true })).toBe(30);
    expect(__test.clampTtl(365, { admin: false })).toBe(365);
  });

  it('clampTtl(90, admin) returns 90 — grant and PAT share the same lifetime', () => {
    // Regression guard for #2574: a 90-day admin PAT must yield a 90-day grant.
    expect(__test.clampTtl(90, { admin: true })).toBe(90);
  });

  it('clampTtl with no ttlDays and admin still defaults to 30', () => {
    expect(__test.clampTtl(undefined, { admin: true })).toBe(30);
  });
});

describe('admin grant TTL alignment (upsertAdminGrant receives clamped ttl)', () => {
  cds.test('serve', '--project', '.', '--in-memory');

  let uid;

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { Users } = cds.entities('com.sap.developers.ims');
    const userId = cds.utils.uuid();
    await db.run(INSERT.into(Users).entries({ ID: userId, email: 'ttl-align-test@example.com', name: 'TTL Align Test' }));
    uid = userId;
  });

  it('upsertAdminGrant with ttl=90 sets expiresAt ~90 days out', async () => {
    const before = Date.now();
    await upsertAdminGrant(uid, 'tom@sap.com', 90);
    const after = Date.now();
    const db = await cds.connect.to('db');
    const { AdminGrants } = cds.entities('com.sap.developers.ims');
    const [row] = await db.run(SELECT.from(AdminGrants).where({ user_ID: uid }));
    expect(row).toBeDefined();
    const expiresMs = new Date(row.expiresAt).getTime();
    const expectedMin = before + 89 * 24 * 3600 * 1000;
    const expectedMax = after  + 91 * 24 * 3600 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresMs).toBeLessThanOrEqual(expectedMax);
  });

  it('upsertAdminGrant with ttl=30 (default) sets expiresAt ~30 days out', async () => {
    const before = Date.now();
    await upsertAdminGrant(uid, 'tom@sap.com', 30);
    const after = Date.now();
    const db = await cds.connect.to('db');
    const { AdminGrants } = cds.entities('com.sap.developers.ims');
    const [row] = await db.run(SELECT.from(AdminGrants).where({ user_ID: uid }));
    expect(row).toBeDefined();
    const expiresMs = new Date(row.expiresAt).getTime();
    const expectedMin = before + 29 * 24 * 3600 * 1000;
    const expectedMax = after  + 31 * 24 * 3600 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresMs).toBeLessThanOrEqual(expectedMax);
  });
});

describe('lookupPAT live admin role resolution', () => {
  cds.test('serve', '--project', '.', '--in-memory');

  let uid;

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { Users } = cds.entities('com.sap.developers.ims');
    const { INSERT } = cds.ql;
    const userId = cds.utils.uuid();
    await db.run(INSERT.into(Users).entries({ ID: userId, email: 'pat-role-test@example.com', name: 'PAT Role Test' }));
    uid = userId;
  });

  it('admin PAT + live grant → roles include Admin & Tutorial.API', async () => {
    await upsertAdminGrant(uid, 'tom@sap.com', 30);
    const cached = await mwTest.buildCached({ ID: 'p1', user_ID: uid, scopes: ['admin'], expiresAt: null, revokedAt: null });
    expect(cached.roles).toEqual(expect.arrayContaining(['Admin', 'Tutorial.API']));
  });

  it('read-only PAT with a grant present → no admin role', async () => {
    const cached = await mwTest.buildCached({ ID: 'p2', user_ID: uid, scopes: ['read'], expiresAt: null, revokedAt: null });
    expect(cached.roles).not.toContain('Admin');
  });
});

describe('PAT_ADMIN_SCOPE_ENABLED flag', () => {
  it('is registered and defaults OFF', () => {
    const flag = FEATURE_FLAGS.find(f => f.key === 'PAT_ADMIN_SCOPE_ENABLED');
    expect(flag).toBeDefined();
    expect(flag.default).toBe(false);
  });
});

describe('AdminService.revokeAdminGrant', () => {
  cds.test('serve', '--project', '.', '--in-memory');

  let uid;

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { Users } = cds.entities('com.sap.developers.ims');
    const userId = cds.utils.uuid();
    await db.run(INSERT.into(Users).entries({ ID: userId, email: 'revoke-grant-test@example.com', name: 'Revoke Grant Test' }));
    uid = userId;
  });

  it('deletes a user grant via the action (as Admin)', async () => {
    // Arrange: upsert a grant and confirm it's live
    await upsertAdminGrant(uid, 'tom@sap.com', 30);
    expect(await resolveAdminGrant(uid)).toBe(true);

    // Act: invoke the action through the service layer with Admin role
    const admin = await cds.connect.to('AdminService');
    const res = await admin.tx(
      { user: { id: 'admin', roles: ['Admin', 'authenticated-user'] } },
      tx => tx.send({ event: 'revokeAdminGrant', data: { user_ID: uid } })
    );

    // Assert
    expect(res.revoked).toBeGreaterThanOrEqual(1);
    expect(await resolveAdminGrant(uid)).toBe(false);
  });
});

describe('PatService.mintPolicy (#2574 scope-offer gate)', () => {
  cds.test('serve', '--project', '.', '--in-memory');

  let uid;
  const SAPID = 'P000POLICY';

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { Users } = cds.entities('com.sap.developers.ims');
    uid = cds.utils.uuid();
    await db.run(INSERT.into(Users).entries({
      ID: uid, email: 'policy-test@example.com', name: 'Policy Test', sapId: SAPID
    }));
  });

  afterEach(() => __resetFlagsForTest());

  // Thin req shim: handleMintPolicy reads req.user.is() and resolves the db
  // user via resolveDbUser → resolveUserSapId, which falls back to user.id as
  // the SAP ID when no JWT authInfo is present (test/basic-auth path). So the
  // shim's id must equal the seeded Users.sapId for the grant lookup to hit.
  const reqFor = (user) => ({ user });
  const adminUser = { id: SAPID, is: (r) => r === 'Admin' };
  const plainUser = { id: SAPID, is: () => false };

  it('flag OFF → adminScopeEnabled false, canMintAdmin false (even for a live admin)', async () => {
    __setFlagForTest('PAT_ADMIN_SCOPE_ENABLED', false);
    const res = await handleMintPolicy(reqFor(adminUser));
    expect(res.adminScopeEnabled).toBe(false);
    expect(res.canMintAdmin).toBe(false);
  });

  it('flag ON + live Admin role → canMintAdmin true', async () => {
    __setFlagForTest('PAT_ADMIN_SCOPE_ENABLED', true);
    const res = await handleMintPolicy(reqFor(adminUser));
    expect(res.adminScopeEnabled).toBe(true);
    expect(res.canMintAdmin).toBe(true);
  });

  it('flag ON + non-admin + no grant → canMintAdmin false', async () => {
    __setFlagForTest('PAT_ADMIN_SCOPE_ENABLED', true);
    await revokeAdminGrant(uid);
    const res = await handleMintPolicy(reqFor(plainUser));
    expect(res.adminScopeEnabled).toBe(true);
    expect(res.canMintAdmin).toBe(false);
  });

  it('flag ON + non-admin BUT holds a live grant → canMintAdmin true', async () => {
    __setFlagForTest('PAT_ADMIN_SCOPE_ENABLED', true);
    await upsertAdminGrant(uid, 'tom@sap.com', 30);
    const res = await handleMintPolicy(reqFor(plainUser));
    expect(res.canMintAdmin).toBe(true);
    await revokeAdminGrant(uid);
  });
});
