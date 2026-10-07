import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';

/**
 * Resolve whether dbUserId currently holds a non-expired AdminGrant.
 * Fail-closed: any error → false, warning logged.
 * @param {string} dbUserId  UUID of the Users row (= db-level user ID)
 * @returns {Promise<boolean>}
 */
export async function resolveAdminGrant(dbUserId) {
  if (!dbUserId) return false;
  try {
    const { SELECT } = cds.ql;
    const { AdminGrants } = cds.entities(NS);
    const db = await cds.connect.to('db');
    const [row] = await db.run(SELECT.from(AdminGrants).where({ user_ID: dbUserId }));
    if (!row || !row.expiresAt) return false;
    return new Date(row.expiresAt).getTime() > Date.now();
  } catch (e) {
    cds.log('admin-grant').warn('resolveAdminGrant failed, fail-closed:', e.message);
    return false;
  }
}

/**
 * Insert-or-update the single AdminGrant row for a user.
 * Idempotent: a second call for the same user updates rather than adds a row.
 * @param {string} dbUserId       UUID of the Users row
 * @param {string} grantedByEmail email of the admin performing the grant
 * @param {number} ttlDays        validity in days (negative = already expired)
 */
export async function upsertAdminGrant(dbUserId, grantedByEmail, ttlDays) {
  const { SELECT, INSERT, UPDATE } = cds.ql;
  const { AdminGrants } = cds.entities(NS);
  const db = await cds.connect.to('db');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 864e5).toISOString();
  const grantedAt = now.toISOString();

  const [existing] = await db.run(SELECT.from(AdminGrants).where({ user_ID: dbUserId }));
  if (existing) {
    await db.run(
      UPDATE(AdminGrants)
        .set({ grantedAt, grantedBy: grantedByEmail, expiresAt })
        .where({ user_ID: dbUserId })
    );
  } else {
    await db.run(
      INSERT.into(AdminGrants).entries({
        ID: cds.utils.uuid(),
        user_ID: dbUserId,
        grantedAt,
        grantedBy: grantedByEmail,
        expiresAt,
      })
    );
  }
}

/**
 * Delete the AdminGrant row(s) for a user.
 * @param {string} dbUserId  UUID of the Users row
 * @returns {Promise<number>}  count of rows deleted
 */
export async function revokeAdminGrant(dbUserId) {
  const { DELETE } = cds.ql;
  const { AdminGrants } = cds.entities(NS);
  const db = await cds.connect.to('db');
  return db.run(DELETE.from(AdminGrants).where({ user_ID: dbUserId }));
}
