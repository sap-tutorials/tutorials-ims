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
import { getNextLegacyId } from './legacy-id.js';

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

/**
 * Issue #339: opportunistically populate firstName / lastName / email on the
 * migrated Users row from the authenticated request's JWT claims.
 *
 * Why: the IMS migrator copies SAP_ID + pre-computed totals, but never the
 * profile fields — IMS Java JIT-fetched names from SAP IDP at request time
 * and never persisted them. Most migrated rows have NULL firstName/lastName/
 * email, so the admin Users list and any UI that surfaces a learner's name
 * shows blank.
 *
 * SAP ID Service (Option A trust, see docs/developers/operations/ias-setup.md)
 * does NOT expose a SCIM/People bulk API. The only way to populate these
 * fields after migration is per-user, when the user authenticates and the
 * JWT carries `given_name` / `family_name` / `email` claims.
 *
 * This helper is the lazy-self-heal half of the fix:
 *   - Called from authenticated request hooks (notably /auth/user, which
 *     fires on every page load), it issues an UPDATE iff the row has at
 *     least one blank field that the JWT can fill.
 *   - No-op when fields are already populated, so it's safe to call on
 *     every request.
 *   - No-op when no Users row exists yet (auto-provision will fill the
 *     fields on INSERT).
 *
 * Caller pattern (fire-and-forget):
 *
 *   backfillUserProfile(user).catch(err =>
 *     console.warn('[backfill]', err.message));
 *
 * Returns a verdict object for callers that want to log or test:
 *   { backfilled: false, reason: 'anonymous' | 'no-user' | 'no-blanks' | 'no-claims' }
 *   { backfilled: true,  fields: ['firstName', 'email', ...] }
 *
 * NOT covered:
 *   - displayName (computed at read time from firstName + lastName)
 */
export async function backfillUserProfile(user) {
  const sapId = resolveUserSapId(user);
  if (!sapId) return { backfilled: false, reason: 'anonymous' };
  if (!user.attr) return { backfilled: false, reason: 'no-claims' };

  const { Users } = cds.entities('com.sap.developers.ims');
  const dbUser = await SELECT.one.from(Users)
    .where({ sapId })
    .columns('ID', 'firstName', 'lastName', 'email');
  if (!dbUser) return { backfilled: false, reason: 'no-user' };

  // JWT claim shape from SAP ID Service / IAS — confirmed via /auth/user
  // diag dump 2026-06-16. Either snake_case (SAP ID Service) or camelCase
  // (some IAS configurations) shows up, hence the `||` fallback.
  const claimFirstName = user.attr.given_name || user.attr.givenName;
  const claimLastName  = user.attr.family_name || user.attr.familyName;
  const claimEmail     = user.attr.email;

  const updates = {};
  if (!dbUser.firstName && claimFirstName) updates.firstName = claimFirstName;
  if (!dbUser.lastName  && claimLastName)  updates.lastName  = claimLastName;
  if (!dbUser.email     && claimEmail)     updates.email     = claimEmail;

  if (Object.keys(updates).length === 0) return { backfilled: false, reason: 'no-blanks' };

  await UPDATE(Users).where({ sapId }).set(updates);
  return { backfilled: true, fields: Object.keys(updates) };
}

/**
 * Get-or-create the Users row for the authenticated request, keyed on sapId.
 *
 * **Why this exists (SAGE ownership under-reporting):**
 *
 * backfillUserProfile above is UPDATE-only — it no-ops (`reason: 'no-user'`)
 * when the caller has no Users row yet. That's the common case for the
 * ~797k migrated learners AND for tutorial authors who have never logged
 * into the browser Admin UI: the migrator (scripts/migrate-from-hana.js)
 * copied only ID/UUID/SAP_ID, never profile fields, and never created rows
 * for users who existed only in legacy IMS's author tables.
 *
 * The AuthorService MyTutorials-family read handlers resolve ownership by
 * joining TutorialMeta.owner/ownerEmail to a Users row (db/views.cds
 * MyTutorialsRaw priority 3 = ownerEmail=Users.email, priority 4 =
 * owner=firstName||' '||lastName). With no Users row, those joins return
 * zero — so SAGE under-reports for every author who hasn't been provisioned,
 * not just one. This helper closes that gap by minting the row from the
 * caller's OWN JWT claims on first authenticated call.
 *
 * Generalizes the get-or-create INSERT already used in developer-service.js
 * (completeStep / setLearningPreferences / setPreferredEventRegion) so the
 * read path and the write path can't diverge.
 *
 * Semantics:
 *   - Anonymous / no sapId → returns null (callers keep their fail-closed guard).
 *   - Existing row → opportunistically fills blank firstName/lastName/email
 *     from JWT claims (same as backfillUserProfile), then returns it.
 *   - No row + JWT carries a usable identity → INSERTs a row from claims,
 *     then re-selects and returns it.
 *   - No row + no usable claims (no email AND no name) → does NOT invent an
 *     empty-profile row; returns null so the caller stays fail-closed. This
 *     matches backfillUserProfile's "nothing to write" posture and avoids
 *     minting useless rows for tokens that carry no profile.
 *
 * **Concurrency (best-effort, NOT DB-enforced):** two parallel first-calls
 * for the same brand-new sapId (e.g. a SAGE panel firing MyTutorials +
 * MyOwnedTutorials + /auth/user at once) can both SELECT-empty then both
 * INSERT. There is NO DB-level uniqueness on Users.sapId to collapse them:
 * @assert.unique.sapId (db/schema.cds) is a CAP application-service runtime
 * check only, and this direct cds.db INSERT bypasses it — so the INSERT does
 * not throw on a duplicate and the catch below is a backstop for the SQLite
 * unit path, not HANA. This is deliberately tolerated: (1) prod has 0
 * duplicate sapId rows across 797k rows despite developer-service.js running
 * this same SELECT-then-INSERT pattern unguarded for months, so the window
 * has never fired in practice; (2) every caller reads via SELECT.one, so even
 * if a duplicate were ever minted the caller still gets a single consistent
 * row and ownership resolution is unaffected. If a duplicate is ever OBSERVED,
 * revisit with a real UNIQUE index (needs an hdbmigrationtable migration on
 * the 797k-row table) or an UPSERT — tracked as separate hardening, not
 * forced preemptively.
 *
 * @param {object} user — see resolveUserSapId.
 * @param {string[]} [columns] — optional columns subset for the returned row.
 * @returns {Promise<object | null>} the Users row, or null if anonymous /
 *   unprovisionable.
 */
export async function provisionDbUser(user, columns) {
  const sapId = resolveUserSapId(user);
  if (!sapId) return null;

  const { Users } = cds.entities('com.sap.developers.ims');
  const select = () => {
    let q = SELECT.one.from(Users).where({ sapId });
    if (columns && columns.length) q = q.columns(...columns);
    return q;
  };

  const existing = await select();
  if (existing) {
    // Fill blanks from claims (idempotent; UPDATE-only when something's blank).
    await backfillUserProfile(user).catch((err) =>
      cds.log('resolve-db-user').warn('[provision-backfill]', err?.message ?? err));
    // Re-select so the freshly-filled fields are visible to the caller.
    return await select();
  }

  // No row yet. Only provision when the JWT carries a usable identity —
  // otherwise a bare token would mint an empty-profile row that resolves
  // nothing. Same claim shape as backfillUserProfile.
  const claimFirstName = user.attr?.given_name || user.attr?.givenName;
  const claimLastName  = user.attr?.family_name || user.attr?.familyName;
  const claimEmail     = user.attr?.email;
  if (!claimEmail && !claimFirstName && !claimLastName) return null;

  const db = await cds.connect.to('db');
  try {
    await INSERT.into(Users).entries({
      uuid: user.id,
      sapId,
      legacyId: await getNextLegacyId('Users', db),
      email: claimEmail || '',
      firstName: claimFirstName || '',
      lastName: claimLastName || '',
    });
  } catch (err) {
    // Backstop for the SQLite unit path (which DOES enforce @assert.unique):
    // if a concurrent first-call already inserted this sapId, swallow the
    // uniqueness collision and fall through to the re-select — the invariant
    // is "a row exists after this call." On HANA there is no DB-level
    // uniqueness on sapId (see the concurrency note above), so this rarely
    // fires there. Only swallow true uniqueness collisions; rethrow anything
    // else (FK / NOT NULL / etc.) so real INSERT failures aren't masked as a
    // silent zero-row "miss".
    if (!/unique|duplicate/i.test(String(err?.message ?? ''))) throw err;
  }
  return await select();
}
