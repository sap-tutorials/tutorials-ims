import { describe, it, expect, beforeAll } from 'vitest';
import { __test } from '../srv/lib/mcp-pat-actions.js';
import { __test as mwTest } from '../srv/lib/mcp-pat-middleware.js';
import cds from '@sap/cds';
import { resolveAdminGrant, upsertAdminGrant, revokeAdminGrant } from '../srv/lib/admin-grant.js';
import { FEATURE_FLAGS } from '../packages/core/feature-flags/registry.js';

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
