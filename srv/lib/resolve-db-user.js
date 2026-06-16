// srv/lib/resolve-db-user.js
//
// Single source of truth for "which Users row does this authenticated request
// correspond to?" — used by every authenticated CAP handler that reads/writes
// per-user data.
//
// **Why this is a separate module (issue #343):**
//
// The IMS legacy app stored users keyed by SAP ID (I-number / D-number / S-number).
// The XSUAA JWT carries this value in the `user_uuid` claim — confirmed by
// reading IMS Java's AuditUserFilter.java + UserResolverHelperImpl.java, and
// verified in production via /auth/user diag dump 2026-06-16. The IMS Java
// app reads the same claim via `jwt.getClaimAsString("user_uuid")` and looks
// up users via `findOneBySapId(...)`.
//
// CAP's @sap/xssec wrapper exposes the claim as `req.authInfo.token.userId`
// (see node_modules/@sap/xssec/src/token/Token.js:240 — `get userId() { return
// this.payload.user_uuid; }`).
//
// CAP's `req.user.id` is a different value: for XSUAA tokens against SAP ID
// Service it's the user's email. The migrator wrote `Users.uuid` from the
// IMS-internal opaque GUID (IMS_USER.UUID), which never matched the JWT.
// So `WHERE uuid = req.user.id` was a no-op for every migrated user → /me/
// blank, admin Tutorial Health stale, etc.
//
// Fix: every lookup uses `WHERE sapId = resolveUserSapId(user)`. Migrated rows
// already have `Users.sapId = IMS_USER.SAP_ID` from the migrator. Auto-
// provisioned rows must also set sapId from the JWT (see auto-provision
// callsites in developer-service.js).
//
// **Fallback chain for auth contexts where xssec is not present:**
// 1. authInfo.token.userId (XSUAA @sap/xssec — production path)
// 2. authInfo.token.payload.user_uuid (defensive: in case xssec API changes)
// 3. user.id (basic-auth tech users, tests, mock contexts — preserves old
//    behavior for non-JWT request paths)
//
// Returns null for anonymous; callers MUST handle null.

import cds from '@sap/cds';

/**
 * Extract the SAP ID for the authenticated user from the request context.
 *
 * @param {object} user — the CAP `cds.context.user` or `req.user` object.
 *   Expected shape: `{ id: string, attr?: object, authInfo?: { token?: { userId?: string, payload?: { user_uuid?: string } } } }`
 * @returns {string | null} The SAP ID (I-number etc.) or null if anonymous.
 */
export function resolveUserSapId(user) {
  if (!user || !user.id || user.id === 'anonymous') return null;
  const t = user.authInfo?.token;
  if (t?.userId) return t.userId;
  if (t?.payload?.user_uuid) return t.payload.user_uuid;
  // Fallback: pre-migration tests + basic-auth tech users may set user.id to
  // an SAP ID directly. Migrated users with a real JWT will always take the
  // userId branch above.
  return user.id;
}

/**
 * Resolve to the migrated Users row (or null) for the authenticated request.
 *
 * @param {object} user — see resolveUserSapId.
 * @param {string[]} [columns] — optional columns subset; defaults to full row.
 * @returns {Promise<object | null>} The Users row (or null if not found / anonymous).
 */
export async function resolveDbUser(user, columns) {
  const sapId = resolveUserSapId(user);
  if (!sapId) return null;
  const { Users } = cds.entities('com.sap.developers.ims');
  let q = SELECT.one.from(Users).where({ sapId });
  if (columns && columns.length) q = q.columns(...columns);
  return await q;
}
