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
 * Extract the OIDC (issuer, subject) tuple from the authenticated user's token.
 * This is the durable per-IdP identity key — stable across logins for every
 * provider (SAP ID, IAS, social). Returns null when either claim is absent.
 *
 * @param {object} user — CAP cds.context.user / req.user.
 * @returns {{issuer: string, subject: string} | null}
 */
export function issuerSubjectFromUser(user) {
  const p = user?.authInfo?.token?.payload;
  const issuer = p?.iss;
  const subject = p?.sub;
  if (typeof issuer === 'string' && issuer && typeof subject === 'string' && subject) {
    return { issuer, subject };
  }
  return null;
}

/**
 * Resolve the authenticated request to its Users row via the tiered identity
 * layer (#2552). Tiers, in order:
 *   1. (issuer, subject) link in UserIdentities — durable, all providers.
 *   2. sapId fast-path (+ self-healing link write) — migrated SAP users.  [Task 3]
 *   3. trusted-token-email → Users.email (+ link write).                  [Task 4]
 * Miss on all tiers → null (caller stays fail-closed).
 *
 * @param {object} user — CAP cds.context.user / req.user.
 * @returns {Promise<object|null>} the full Users row, or null.
 */
export async function resolveUser(user) {
  if (!user || !user.id || user.id === 'anonymous') return null;
  const { Users, UserIdentities } = cds.entities('com.sap.developers.ims');

  // ── Tier 1: (issuer, subject) link ──────────────────────────────────────
  const isu = issuerSubjectFromUser(user);
  if (isu) {
    const link = await SELECT.one.from(UserIdentities)
      .columns('user_ID')
      .where({ issuer: isu.issuer, subject: isu.subject });
    if (link?.user_ID) {
      const row = await SELECT.one.from(Users).where({ ID: link.user_ID });
      if (row) return row;
    }
  }

  // Tiers 2 & 3 added in later tasks.
  return null;
}

// ── IAS (MCP public-PKCE) identity resolution (#2550) ──────────────────────
//
// **Why IAS needs a different path than XSUAA.**
//
// The MCP tier authenticates mcp-remote via a secretless public OIDC client on
// SAP Cloud Identity Services (IAS tenant atxgsg7zi). Unlike the XSUAA path —
// where the JWT `user_uuid` claim IS the SAP ID (I-number) — an IAS token
// carries NO I-number. Decoded live 2026-10-01 (client 0b1e8b56-…):
//   sub   = thomas.jung@sap.com      (the VERIFIED email — IAS enforces email
//                                      verification on the app, so sub is a
//                                      trustworthy join key, not a self-claimed
//                                      address)
//   email = thomas.jung@sap.com
//   user_uuid = scim_id = ba411614-… (the IAS SCIM UUID — NOT the I-number!)
//   iss   = https://atxgsg7zi.accounts.ondemand.com
//
// So the XSUAA chain in resolveUserSapId is WRONG for an IAS token: branch #2
// (`payload.user_uuid`) would return the SCIM UUID as a bogus "sapId". The IAS
// path must instead JOIN on the verified email: email → Users.email → sapId.
// This is a DB lookup, hence async — it cannot live inside the synchronous
// resolveUserSapId. The srv-mcp before('*') hook calls resolveIasSapId once per
// request and pins the resolved I-number onto the context (as authInfo.token.
// userId) so the existing synchronous resolveUserSapId — and every handler that
// calls it — keeps working unchanged, taking branch #1.

const IAS_ISSUER_RE = /\.accounts\.ondemand\.com\/?$/i;

/**
 * True when the authenticated request came from an IAS OIDC token (as opposed
 * to XSUAA). Detected by the token issuer host (`iss` claim).
 *
 * @param {object} user — CAP user; reads user.authInfo.token.payload.iss.
 * @returns {boolean}
 */
export function isIasToken(user) {
  const iss = user?.authInfo?.token?.payload?.iss;
  return typeof iss === 'string' && IAS_ISSUER_RE.test(iss);
}

/**
 * The verified email carried by an IAS token. Prefers the `sub` claim (which
 * IAS sets to the email for these apps and gates on email-verification), then
 * the explicit `email` claim, then — defensively — emailFromUser (user.id).
 *
 * @param {object} user — CAP user.
 * @returns {string | null} lowercased email, or null.
 */
export function iasEmailFromToken(user) {
  const p = user?.authInfo?.token?.payload;
  const isEmail = (v) => typeof v === 'string' && v.includes('@');
  // Prefer sub (IAS sets it to the verified email), but only if sub is actually
  // an address — a non-email sub (e.g. a bare id) must fall through to the
  // explicit `email` claim, then defensively to emailFromUser(user.id).
  const raw = (isEmail(p?.sub) && p.sub)
    || (isEmail(p?.email) && p.email)
    || emailFromUser(user);
  return isEmail(raw) ? raw.toLowerCase() : null;
}

/**
 * Resolve the SAP ID (I-number) for an IAS-authenticated request by joining the
 * token's VERIFIED email to Users.email. This is the MCP-tier counterpart to
 * resolveUserSapId's XSUAA `user_uuid` path.
 *
 * Fail-closed: returns null when the token is not IAS, carries no usable email,
 * or no Users row matches that email — callers MUST treat null as "unresolved"
 * (anonymous), never minting or acting on a partial identity. Email match is
 * case-insensitive (emails are stored/compared lowercased).
 *
 * NOTE: does NOT fall back to the SCIM UUID (`user_uuid`) — that value is NOT a
 * SAP ID and must never be returned as one.
 *
 * @param {object} user — CAP user with an IAS token.
 * @returns {Promise<string | null>} the matched Users.sapId, or null.
 */
export async function resolveIasSapId(user) {
  if (!isIasToken(user)) return null;
  const email = iasEmailFromToken(user);
  if (!email) return null;
  const { Users } = cds.entities('com.sap.developers.ims');
  // Case-insensitive email match: compare lowercased on both sides so a token
  // email that differs only in case from the stored value still resolves.
  // Fetch ALL matches, not SELECT.one — a single email can map to >1 Users row:
  // early IAS logins (before this resolver existed) auto-provisioned a row keyed
  // on the SCIM UUID, so a user can have BOTH an I-number row (the real migrated
  // identity) AND a stray SCIM-UUID-keyed row with the same email. We must
  // deterministically prefer the I-number — returning the SCIM-UUID sapId would
  // resolve the MCP user to the wrong (stray) Users row.
  const rows = await SELECT.from(Users)
    .columns('sapId')
    .where`lower(email) = ${email}`;
  if (!rows || !rows.length) return null;
  const ids = rows.map((r) => r.sapId).filter(Boolean);
  // Prefer a real SAP ID (I-/D-/S-number: a letter followed by digits) over a
  // SCIM-UUID-shaped sapId (the stray auto-provisioned row).
  const realSapId = ids.find((id) => !SCIM_UUID_RE.test(id));
  return realSapId ?? ids[0] ?? null;
}

// A SCIM-UUID-shaped sapId (stray IAS auto-provision), e.g.
// fbf099e2-f1b5-4cda-b590-866fed970a2a — never a real SAP ID.
const SCIM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * srv-mcp before('*') hook: for an IAS-authenticated request, resolve the real
 * SAP ID via resolveIasSapId and PIN it onto the context so the synchronous
 * resolveUserSapId (and every handler that calls it) returns the I-number via
 * branch #1 (authInfo.token.userId) instead of the SCIM UUID.
 *
 * Idempotent and no-op for:
 *   - non-IAS tokens (XSUAA path is untouched),
 *   - already-pinned contexts (userId already set to a resolved value),
 *   - IAS tokens whose email matches no Users row (leaves the context as-is;
 *     resolveUserSapId will then fall through to its own logic, and the caller's
 *     fail-closed null-guard still applies since no I-number was pinned).
 *
 * @param {object} user — CAP cds.context.user / req.user (mutated in place).
 * @returns {Promise<string | null>} the pinned sapId, or null if not pinned.
 */
export async function pinIasSapId(user) {
  if (!user || !isIasToken(user)) return null;
  const sapId = await resolveIasSapId(user);
  if (!sapId) return null;
  // Pin where synchronous resolveUserSapId reads branch #1. Build the authInfo/
  // token shells if absent (IAS tokens still carry a payload, but be defensive).
  user.authInfo = user.authInfo || {};
  user.authInfo.token = user.authInfo.token || {};
  user.authInfo.token.userId = sapId;
  return sapId;
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
/**
 * The email to backfill for this user. SAP ID Service / XSUAA tokens do NOT
 * reliably populate the `email` *attribute* — whether it's present depends on
 * the IdP's scope config — which is why migrated author rows stay NULL-email
 * even after the author logs in (issue #2199). But the token *subject*
 * `user.id` IS the email for real browser logins: that's exactly why
 * resolveUserSapId falls back to it and /auth/user echoes it as the identity.
 * So when the claim is absent, use `user.id`, guarded on '@' so basic-auth /
 * tech-user ids (bare usernames, SAP IDs) never pollute Users.email.
 */
export function emailFromUser(user) {
  if (user?.attr?.email) return user.attr.email;
  const id = user?.id;
  return typeof id === 'string' && id.includes('@') ? id : null;
}

export async function backfillUserProfile(user) {
  const sapId = resolveUserSapId(user);
  if (!sapId) return { backfilled: false, reason: 'anonymous' };

  // JWT claim shape from SAP ID Service / IAS — confirmed via /auth/user
  // diag dump 2026-06-16. Either snake_case (SAP ID Service) or camelCase
  // (some IAS configurations) shows up, hence the `||` fallback. Email also
  // falls back to the token subject (user.id) — see emailFromUser.
  const claimFirstName = user.attr?.given_name || user.attr?.givenName;
  const claimLastName  = user.attr?.family_name || user.attr?.familyName;
  const claimEmail     = emailFromUser(user);

  // Nothing the token can contribute (no name claims AND no usable email).
  // Checked before the SELECT so a claimless token never hits the DB.
  if (!claimFirstName && !claimLastName && !claimEmail) {
    return { backfilled: false, reason: 'no-claims' };
  }

  const { Users } = cds.entities('com.sap.developers.ims');
  const dbUser = await SELECT.one.from(Users)
    .where({ sapId })
    .columns('ID', 'firstName', 'lastName', 'email');
  if (!dbUser) return { backfilled: false, reason: 'no-user' };

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
  const claimEmail     = emailFromUser(user);
  if (!claimEmail && !claimFirstName && !claimLastName) return null;

  const db = await cds.connect.to('db');
  try {
    await INSERT.into(Users).entries({
      uuid: cds.utils.uuid(),  // String(36): user.id is email under XSUAA → overflows on long addresses (#1614)
      sapId,
      legacyId: await getNextLegacyId('Users', db),
      // NULL — not '' — for any absent claim (SAGE 718-bug). A blank-string
      // identity collides in MyTutorialsRaw's priority-3 (ownerEmail) and
      // priority-4 (owner-name) equijoins, matching every blank-owner
      // TutorialMeta row; NULL never equals anything, so it can't over-match.
      // The guard at line 246 guarantees at least one of these is truthy, so
      // this never mints a fully-blank row.
      email: claimEmail || null,
      firstName: claimFirstName || null,
      lastName: claimLastName || null,
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
