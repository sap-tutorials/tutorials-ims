import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { resolveAdminGrant, upsertAdminGrant, revokeAdminGrant } from '../srv/lib/admin-grant.js';

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
