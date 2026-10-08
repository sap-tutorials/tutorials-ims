import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { __setFlagForTest, __resetFlagsForTest, bustFeatureFlagsCache } from '../srv/lib/feature-flags/db-flags.js';

// Full-server boot — required because the /admin-pat middleware is registered
// in the cds.on('bootstrap', ...) block in srv/server.js.
const project = cds.test('serve', '--project', '.', '--in-memory');

// mocked-auth admin user (defined in .cdsrc.json):
//   id: 'admin', password: 'admin', roles: ['Admin', ...]
const ADMIN_USER_ID = 'admin';

/**
 * Set/unset PAT_ADMIN_SCOPE_ENABLED in the DB and force-warm the cache.
 * Using the DB row (not just __setFlagForTest) avoids the boot-refresh race:
 * ensureFeatureFlagDefaults seeds the flag as 'false' at boot; any background
 * refresh would overwrite a purely in-memory __setFlagForTest value.
 * bustFeatureFlagsCache + __setFlagForTest ensures isFlagEnabled() sees the new
 * value synchronously on the very next call.
 */
async function setAdminScopeFlag(enabled) {
  const db = await cds.connect.to('db');
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  const existing = await db.run(SELECT.one.from(ImsConfig).where({ key: 'flag.pat.adminScope' }));
  const strVal = enabled ? 'true' : 'false';
  if (existing) {
    await db.run(UPDATE(ImsConfig).set({ value: strVal }).where({ key: 'flag.pat.adminScope' }));
  } else {
    await db.run(INSERT.into(ImsConfig).entries({ ID: cds.utils.uuid(), key: 'flag.pat.adminScope', value: strVal }));
  }
  bustFeatureFlagsCache();
  __setFlagForTest('PAT_ADMIN_SCOPE_ENABLED', enabled);
}

/**
 * Insert the admin user into the Users table so resolveDbUser can find them.
 * resolveUserSapId falls back to user.id for mocked-auth users, so the
 * sapId column must match ADMIN_USER_ID.
 */
async function ensureAdminDbUser() {
  const db = await cds.connect.to('db');
  const { Users } = cds.entities('com.sap.developers.ims');
  const existing = await db.run(SELECT.one.from(Users).where({ sapId: ADMIN_USER_ID }));
  if (!existing) {
    await db.run(INSERT.into(Users).entries({
      ID: cds.utils.uuid(),
      sapId: ADMIN_USER_ID,
      email: 'admin@test.local',
      displayName: 'Test Admin',
    }));
  }
}

/**
 * Mint an admin-scoped PAT as the admin user via PatService.
 * PAT_ADMIN_SCOPE_ENABLED must be ON before calling this (mintPAT rejects
 * admin scope when the flag is off at lines ~68 of mcp-pat-actions.js).
 */
async function mintAdminPAT() {
  const srv = await cds.connect.to('PatService');
  return srv.tx(
    { user: { id: ADMIN_USER_ID, roles: { Admin: true, 'authenticated-user': true } } },
    (tx) => tx.send({
      event: 'mintPAT',
      data: { name: 'headless-admin-test', scopes: ['admin'], ttlDays: 1 }
    })
  );
}

describe('headless admin PAT on /admin-pat', () => {
  let adminToken;

  beforeAll(async () => {
    await ensureAdminDbUser();
    // Enable flag in DB + warm cache before minting.
    await setAdminScopeFlag(true);
    const result = await mintAdminPAT();
    expect(result.token).toMatch(/^pat_/);
    adminToken = result.token;
  });

  afterAll(async () => {
    await setAdminScopeFlag(false);
    __resetFlagsForTest();
  });

  it('(a) flag ON + admin PAT → GET /admin-pat/Tutorials returns 200', async () => {
    const res = await project.get('/admin-pat/Tutorials?$top=1', {
      headers: { Authorization: `Bearer ${adminToken}` },
      validateStatus: () => true,
    });
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('value');
  });

  it('(b) flag OFF → /admin-pat is inert (404 or 401, not 200)', async () => {
    await setAdminScopeFlag(false);
    try {
      const res = await project.get('/admin-pat/Tutorials?$top=1', {
        headers: { Authorization: `Bearer ${adminToken}` },
        validateStatus: () => true,
      });
      // With flag OFF the middleware calls next() — the path is unmapped → 404.
      expect(res.status).not.toBe(200);
    } finally {
      await setAdminScopeFlag(true);
    }
  });

  it('(c) no Authorization header + flag ON → 401', async () => {
    const res = await project.get('/admin-pat/Tutorials', {
      validateStatus: () => true,
    });
    expect(res.status).toBe(401);
  });
});
