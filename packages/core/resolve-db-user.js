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
 * Insert a UserIdentities link row for (issuer, subject) → user_ID. Idempotent:
 * a concurrent/duplicate insert (the (issuer,subject) unique assert) is swallowed
 * so self-heal never throws into a read path. Any non-uniqueness error rethrows.
 *
 * @param {string} user_ID — the Users.ID to link.
 * @param {{issuer:string, subject:string}} isu
 * @param {{provider?:string, email?:string, emailVerified?:boolean}} [meta]
 * @param {object} [db] — optional tx/service runner (e.g. cds.tx(req)); when
 *   given, the INSERT runs on that transaction instead of a fresh ambient one.
 */
export async function writeIdentityLink(user_ID, isu, meta = {}, db) {
  if (!user_ID || !isu) return;
  try {
    const { UserIdentities } = cds.entities('com.sap.developers.ims');
    const stmt = INSERT.into(UserIdentities).entries({
      ID: cds.utils.uuid(),
      user_ID,
      issuer: isu.issuer,
      subject: isu.subject,
      provider: meta.provider ?? null,
      email: meta.email ?? null,
      emailVerified: meta.emailVerified ?? false,
      linkedAt: new Date().toISOString(),
    });
    await (db ? db.run(stmt) : stmt);
  } catch (err) {
    if (!/unique|duplicate/i.test(String(err?.message ?? ''))) throw err;
  }
}

/**
 * Classify the token issuer into a short provider tag for the link row.
 * @param {string|undefined} issuer
 * @returns {string}
 */
function providerFromIssuer(issuer) {
  if (!issuer) return 'unknown';
  if (/\.accounts\.ondemand\.com/i.test(issuer)) return 'ias';
  if (/authentication\..*\.hana\.ondemand\.com/i.test(issuer)) return 'sap-id';
  if (/github/i.test(issuer)) return 'github';
  if (/google/i.test(issuer)) return 'google';
  return 'oidc';
}

// A SCIM-UUID-shaped sapId (stray IAS auto-provision), e.g.
// fbf099e2-f1b5-4cda-b590-866fed970a2a — never a real SAP ID.
const SCIM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The durable, provider-canonical issuer we store for a GitHub login, so the
// link key is stable regardless of which IAS tenant fronts it. providerFromIssuer
// already classifies this as 'github'. See githubIdentityFromUser().
const GITHUB_ISSUER = 'https://github.com';

// Claim names that may carry the GitHub login handle, in preference order. The
// shim stamps `preferred_username`; IAS re-issues it, but a tenant may remap it.
// Defensive: accept the common OIDC + IAS variants (confirmed shim claim is
// `preferred_username`; see github-oidc-shim.js mintIdToken).
const GITHUB_LOGIN_CLAIMS = ['preferred_username', 'login', 'user_name', 'preferredUsername'];

/**
 * Detect a GitHub-federated login and return its PROVIDER-CANONICAL identity,
 * independent of the IAS tenant that fronts it.
 *
 * GitHub is federated into IAS via a custom OIDC shim (approuter/lib/
 * github-oidc-shim.js) registered as a corporate OIDC IdP. After federation the
 * app token's `iss` is the IAS tenant (NOT github.com) and `sub` is the GitHub
 * NUMERIC id (the shim sets it as `sub`; IAS Subject Name Identifier = None
 * passes it through). So the IAS (iss,sub) alone can't be classified as GitHub
 * by issuer — we recognise a GitHub login by the shim-origin claims instead and
 * remap it to the stable (issuer=https://github.com, subject=<numeric id>) key.
 *
 * Recognition is deliberately permissive (the exact IAS-reissued claim names
 * were not captured live — sticky-SSO blocked the browser capture — so this
 * tolerates renames): a login is GitHub-origin when the token carries a GitHub
 * login-handle claim AND a numeric subject, OR an explicit IdP/amr marker that
 * names the GitHub corporate IdP.
 *
 * @param {object} user — CAP cds.context.user / req.user.
 * @returns {{issuer:string, subject:string, login:string|null, email:string|null, emailVerified:boolean}|null}
 */
export function githubIdentityFromUser(user) {
  const p = user?.authInfo?.token?.payload;
  if (!p) return null;

  const login = GITHUB_LOGIN_CLAIMS.map((c) => p[c]).find((v) => typeof v === 'string' && v);
  const sub = typeof p.sub === 'string' ? p.sub : null;
  // The GitHub subject the shim stamps is the numeric user id (digits only).
  const numericSub = sub && /^\d+$/.test(sub) ? sub : null;

  // Explicit IdP marker, if present (IAS may surface the corporate-IdP name or
  // id in a claim; amr sometimes carries it). Best-effort, not required.
  const idpMarker = [p.identity_provider, p.identityProvider, p.idp, p.amr]
    .flat()
    .filter((v) => typeof v === 'string')
    .join(' ');
  const idpSaysGithub = /github/i.test(idpMarker);

  // GitHub-origin when: a login handle + numeric subject are present, or an
  // explicit GitHub IdP marker is present with a numeric subject.
  if (numericSub && (login || idpSaysGithub)) {
    return {
      issuer: GITHUB_ISSUER,
      subject: numericSub,
      login: login || null,
      email: tokenEmail(user),
      emailVerified: typeof p.email_verified === 'boolean' ? p.email_verified : true,
    };
  }
  return null;
}

/**
 * Write the provider-canonical GitHub link (issuer=https://github.com) and set
 * Users.githubLogin from the login handle. Idempotent and non-throwing — a
 * duplicate (iss,sub) link or a githubLogin unique-collision is swallowed so
 * this never breaks a read/resolve path. Called wherever a Users row is
 * resolved or created for a GitHub-origin login, IN ADDITION to the IAS
 * (iss,sub) self-heal link, so Tier 1 resolves on both keys.
 *
 * @param {string} user_ID
 * @param {ReturnType<typeof githubIdentityFromUser>} gh — non-null GitHub identity.
 * @param {object} [db] — optional tx/service runner threaded through.
 */
async function linkGithubIdentity(user_ID, gh, db) {
  if (!user_ID || !gh) return;
  await writeIdentityLink(user_ID, { issuer: gh.issuer, subject: gh.subject }, {
    provider: 'github',
    email: gh.email,
    emailVerified: gh.emailVerified,
  }, db);
  if (gh.login) {
    try {
      const { Users } = cds.entities('com.sap.developers.ims');
      const stmt = UPDATE(Users).set({ githubLogin: gh.login }).where({ ID: user_ID });
      await (db ? db.run(stmt) : stmt);
    } catch (err) {
      // githubLogin is @assert.unique — a collision (same handle already on
      // another row) must not break login. Swallow unique/duplicate only.
      if (!/unique|duplicate/i.test(String(err?.message ?? ''))) throw err;
    }
  }
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
 * @param {object} [db] — optional tx/service runner (e.g. cds.tx(req)); when
 *   given, all reads/writes run on that transaction instead of a fresh ambient
 *   one. Prevents single-connection SQLite deadlocks when a handler already
 *   holds the request tx (#2552).
 * @returns {Promise<object|null>} the full Users row, or null.
 */
export async function resolveUser(user, db) {
  if (!user || !user.id || user.id === 'anonymous') return null;
  const { Users, UserIdentities } = cds.entities('com.sap.developers.ims');
  const run = (stmt) => (db ? db.run(stmt) : stmt);

  // The IAS (tenant-local) (iss,sub) key, and — if this is a GitHub-federated
  // login — the provider-canonical GitHub identity. GitHub's app-token iss is
  // the IAS tenant, so the durable key is (https://github.com, <numeric id>).
  const isu = issuerSubjectFromUser(user);
  const gh = githubIdentityFromUser(user);

  // ── Tier 0: GitHub provider-canonical link (durable across IAS tenants) ──
  if (gh) {
    const ghLink = await run(SELECT.one.from(UserIdentities)
      .columns('user_ID')
      .where({ issuer: gh.issuer, subject: gh.subject }));
    if (ghLink?.user_ID) {
      const row = await run(SELECT.one.from(Users).where({ ID: ghLink.user_ID }));
      if (row) {
        // Self-heal the IAS (iss,sub) link + githubLogin on repeat logins.
        if (isu) await writeIdentityLink(row.ID, isu, {
          provider: providerFromIssuer(isu.issuer), email: gh.email, emailVerified: gh.emailVerified,
        }, db);
        await linkGithubIdentity(row.ID, gh, db);
        return row;
      }
    }
  }

  // ── Tier 1: (issuer, subject) link ──────────────────────────────────────
  if (isu) {
    const link = await run(SELECT.one.from(UserIdentities)
      .columns('user_ID')
      .where({ issuer: isu.issuer, subject: isu.subject }));
    if (link?.user_ID) {
      const row = await run(SELECT.one.from(Users).where({ ID: link.user_ID }));
      if (row) {
        if (gh) await linkGithubIdentity(row.ID, gh, db);
        return row;
      }
    }
  }

  // ── Tier 2: sapId fast-path (+ self-heal link write) ────────────────────
  const sapId = resolveUserSapId(user);
  // A canonical sapId is an SAP employee ID (letter + digits), NOT a SCIM UUID
  // (IAS user_uuid) and NOT an email (XSUAA user.id fallback). Only treat a
  // canonical value as a Tier-2 key — a SCIM-UUID or email here is not a sapId.
  const canonicalSapId = sapId && !SCIM_UUID_RE.test(sapId) && !sapId.includes('@') ? sapId : null;
  if (canonicalSapId) {
    const row = await run(SELECT.one.from(Users).where({ sapId: canonicalSapId }));
    if (row) {
      if (isu) {
        await writeIdentityLink(row.ID, isu, {
          provider: providerFromIssuer(isu.issuer),
          email: user.authInfo?.token?.payload?.email ?? null,
          emailVerified: true,
        }, db);
      }
      if (gh) await linkGithubIdentity(row.ID, gh, db);
      return row;
    }
  }

  // ── Tier 3: trusted-token-email → Users.email (+ self-heal link write) ──
  const email = tokenEmail(user);
  if (email) {
    const rows = await run(SELECT.from(Users).where`lower(email) = ${email}`);
    const candidates = (rows ?? []).filter(
      (r) => r.email && !NOREPLY_GITHUB_RE.test(r.email),
    );
    if (candidates.length) {
      // Prefer a row whose sapId is a real SAP ID (letter+digits) over a stray
      // SCIM-UUID-keyed row sharing the same email (#2550 collision fix).
      const real = candidates.find((r) => r.sapId && !SCIM_UUID_RE.test(r.sapId));
      const row = real ?? candidates[0];
      if (isu) {
        await writeIdentityLink(row.ID, isu, {
          provider: providerFromIssuer(isu.issuer),
          email,
          emailVerified: true,
        }, db);
      }
      if (gh) await linkGithubIdentity(row.ID, gh, db);
      return row;
    }
  }

  return null;
}

/**
 * Per-request identity pin (the before('*') hook helper, #2552). Resolves the
 * Users row via resolveUser and pins it onto the CAP user object so the ~40
 * synchronous `resolveUserSapId` / `resolveDbUser` callsites downstream resolve
 * the right row with NO per-callsite change:
 *   - authInfo.token.userId = row.sapId   (when sapId present — SAP users)
 *   - attr.dbUserId         = row.ID      (always on hit — carries no-sapId users)
 * No-op (returns null) for anonymous or resolution miss; the caller's own
 * fail-closed guard then applies.
 *
 * @param {object} user — CAP cds.context.user / req.user (mutated in place).
 * @param {object} [db] — optional tx/service runner (e.g. cds.tx(req)) threaded
 *   through to resolveUser so the pin's lookups join the request transaction
 *   instead of opening a deadlock-prone ambient one on SQLite (#2552).
 * @returns {Promise<object|null>} the resolved Users row, or null.
 */
export async function pinResolvedUser(user, db) {
  if (!user || !user.id || user.id === 'anonymous') return null;
  // Idempotent: if already pinned this request, don't re-resolve.
  if (user.attr?.dbUserId) return { ID: user.attr.dbUserId, sapId: user.authInfo?.token?.userId ?? null };
  let row;
  try {
    row = await resolveUser(user, db);
  } catch (err) {
    cds.log('resolve-db-user').warn('[pinResolvedUser] resolve failed',
      { email: tokenEmail(user), isu: issuerSubjectFromUser(user), msg: err?.message ?? err });
    return null;
  }
  if (!row) return null;
  user.attr = user.attr || {};
  user.attr.dbUserId = row.ID;
  if (row.sapId) {
    user.authInfo = user.authInfo || {};
    user.authInfo.token = user.authInfo.token || {};
    user.authInfo.token.userId = row.sapId;
  }
  return row;
}

/**
 * The email a token asserts, for Tier-3 identity resolution. The IdP enforces
 * email verification before login, so a token email is trusted-verified. Prefer
 * the explicit `email` claim; else use `sub` only when it is email-shaped.
 * Lowercased for case-insensitive comparison against Users.email.
 *
 * @param {object} user
 * @returns {string | null}
 */
export function tokenEmail(user) {
  const p = user?.authInfo?.token?.payload;
  const isEmail = (v) => typeof v === 'string' && v.includes('@');
  const raw = (isEmail(p?.email) && p.email) || (isEmail(p?.sub) && p.sub) || null;
  return raw ? raw.toLowerCase() : null;
}

// Stored GitHub-synthetic emails (contributor API) must never be a Tier-3 match
// target — they are dirty data, not a login identity.
const NOREPLY_GITHUB_RE = /@users\.noreply\.github\.com$/i;

/**
 * Resolve to the migrated Users row (or null) for the authenticated request.
 *
 * @param {object} user — see resolveUserSapId.
 * @param {string[]} [columns] — optional columns subset; defaults to full row.
 * @returns {Promise<object | null>} The Users row (or null if not found / anonymous).
 */
export async function resolveDbUser(user, columns) {
  const { Users } = cds.entities('com.sap.developers.ims');
  let q;
  if (user?.attr?.dbUserId) {
    // Fast-path: the before('*') pin has already resolved the Users row.
    // For SAP users attr.dbUserId coexists with a sapId, but we prefer the PK
    // for no-sapId (social / IAS pre-link) users. (#2552)
    q = SELECT.one.from(Users);
    if (columns && columns.length) q = q.columns(...columns);
    return await q.where({ ID: user.attr.dbUserId });
  }
  const sapId = resolveUserSapId(user);
  if (!sapId) return null;
  q = SELECT.one.from(Users);
  if (columns && columns.length) q = q.columns(...columns);
  return await q.where({ sapId });
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
 * Issue #2628: refresh the login-provider profile picture (OIDC `picture`
 * claim) on Users.pictureUrl.
 *
 * Unlike backfillUserProfile (blanks-only self-heal for firstName/lastName/
 * email), the picture URL is NOT stable: GitHub bumps `?v=`, LinkedIn/Google
 * return short-lived signed URLs. So this is deliberately "always overwrite
 * with the latest non-null claim" rather than blanks-only — the row should
 * carry whatever the most recent login produced.
 *
 * Preservation rule: a token WITHOUT a picture claim never clears an existing
 * value. A provider that stops emitting the claim (or a login via SAP ID /
 * Apple, which never do) must not wipe a good picture captured earlier.
 *
 * UPDATE-only, keyed on sapId — provisionDbUser handles the INSERT path by
 * seeding pictureUrl directly on row creation.
 *
 * @returns {Promise<{updated: boolean, reason?: string}>}
 */
export async function refreshUserPicture(user) {
  const sapId = resolveUserSapId(user);
  if (!sapId) return { updated: false, reason: 'anonymous' };

  const claimPicture = user.attr?.picture || null;
  if (!claimPicture) return { updated: false, reason: 'no-claim' };

  const { Users } = cds.entities('com.sap.developers.ims');
  const dbUser = await SELECT.one.from(Users).where({ sapId }).columns('ID', 'pictureUrl');
  if (!dbUser) return { updated: false, reason: 'no-user' };
  if (dbUser.pictureUrl === claimPicture) return { updated: false, reason: 'unchanged' };

  await UPDATE(Users).where({ sapId }).set({ pictureUrl: claimPicture });
  return { updated: true };
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
  if (!user || !user.id || user.id === 'anonymous') return null;
  const { Users } = cds.entities('com.sap.developers.ims');
  const isu = issuerSubjectFromUser(user);

  // Get: resolve via the tiered resolver (also self-heals a link on T2/T3 hit).
  const existing = await resolveUser(user);
  if (existing) {
    await backfillUserProfile(user).catch((err) =>
      cds.log('resolve-db-user').warn('[provision-backfill]', err?.message ?? err));
    await refreshUserPicture(user).catch((err) =>
      cds.log('resolve-db-user').warn('[provision-picture]', err?.message ?? err));
    // Ensure a (iss,sub) link exists even if the hit came via Tier 1 already
    // (no-op on duplicate). Tiers 2/3 wrote one; Tier 1 means it exists.
    if (columns && columns.length) {
      return await SELECT.one.from(Users).where({ ID: existing.ID }).columns(...columns);
    }
    return existing;
  }

  // Create: brand-new identity. Only mint when the token carries a usable
  // identity (email or a name) — never an empty-profile row.
  const sapId = resolveUserSapId(user);
  const canonicalSapId = sapId && !SCIM_UUID_RE.test(sapId) && !sapId.includes('@') ? sapId : null;
  const claimFirstName = user.attr?.given_name || user.attr?.givenName;
  const claimLastName  = user.attr?.family_name || user.attr?.familyName;
  const claimEmail     = emailFromUser(user);
  const claimPicture   = user.attr?.picture || null;
  if (!claimEmail && !claimFirstName && !claimLastName && !canonicalSapId) return null;

  const db = await cds.connect.to('db');
  const newId = cds.utils.uuid();
  try {
    await INSERT.into(Users).entries({
      ID: newId,
      uuid: cds.utils.uuid(),
      sapId: canonicalSapId,            // null for social / no-SAP-ID users
      legacyId: await getNextLegacyId('Users', db),
      email: claimEmail || null,
      firstName: claimFirstName || null,
      lastName: claimLastName || null,
      pictureUrl: claimPicture,         // login-provider avatar (#2628), nullable
    });
  } catch (err) {
    if (!/unique|duplicate/i.test(String(err?.message ?? ''))) throw err;
  }
  // Link the (iss,sub) to the row (idempotent).
  if (isu) {
    await writeIdentityLink(newId, isu, {
      provider: providerFromIssuer(isu.issuer),
      email: tokenEmail(user),
      emailVerified: true,
    });
  }
  // For a GitHub-federated login also write the provider-canonical link
  // (issuer=https://github.com) + githubLogin, so future logins resolve on the
  // durable GitHub key regardless of the fronting IAS tenant.
  const ghNew = githubIdentityFromUser(user);
  if (ghNew) await linkGithubIdentity(newId, ghNew);
  const q = SELECT.one.from(Users).where({ ID: newId });
  return (columns && columns.length) ? await q.columns(...columns) : await q;
}
