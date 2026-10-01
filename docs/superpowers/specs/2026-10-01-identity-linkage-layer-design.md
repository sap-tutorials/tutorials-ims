# Identity-Linkage Layer: `(issuer, subject)` as the durable identity key (#2552)

**Date:** 2026-10-01
**Issue:** [#2552](https://github.com/sap-tutorials/tutorials-ims/issues/2552) — Identity Key in Tutorial System
**Status:** Design approved; ready for implementation plan.

## Problem

The app's logical identity key is `Users.sapId` — the SAP employee/universal ID (P/S/I-number) extracted from the XSUAA JWT `user_uuid` claim. Every per-user read/write funnels through `resolveUserSapId(user)` → `WHERE { sapId }`. This breaks for any identity that carries no SAP employee ID:

- **IAS logins** emit no P/S/I number in any OIDC claim for this population (`sub == user_uuid ==` the Global User ID UUID; `personnelNumber` empty — KBA 2954081, verified 2026-09-29).
- **Social logins** (future: Google, etc. via IAS) have no SAP Universal ID at all.

A naive "fall back to email" is unsafe: email is unstable across IdPs, enables account-takeover/collision, and is the exact field that is dirty here.

### Live data grounding (why email cannot be the key)

Read-only probes against bound HANA:

| Metric | PROD (live 2026-10-01) | DEV |
|---|---|---|
| Total `Users` | 816,720 | 789,101 |
| non-null email | 19,892 (2.4%) | 45 (0.006%) |
| null sapId | 472 | 472 |
| canonical I/P/S/D sapId | ~98.6% | 778,128 |

`Users.email` is NULL on ~97.6% of PROD rows (the migrator never populated it; it fills lazily via login-time `backfillUserProfile`), is non-unique, and has no `@assert.unique`. Email is an **attribute that is slowly filling in**, never a safe primary key today.

### Blast-radius finding (audit)

`sapId` is the universal per-user key for the ENTIRE authenticated surface (progress, completions, GDPR anonymization, MCP, Devtoberfest, puzzles, Petoberfest, author ownership) — NOT NGDS-specific. But every consumer funnels through **one chokepoint**: `packages/core/resolve-db-user.js` (`resolveUserSapId` / `resolveDbUser` / `provisionDbUser`). Change the chokepoint, ~40 `WHERE {sapId}` callsites follow unchanged. NGDS is the *opposite* of the main consumer — it reads `Users.sapId` by **row PK** at send time, not via the identity path, so it needs no change.

## Approach

Add an `(issuer, subject)` identity-linkage layer. `(iss, sub)` is the one tuple every OIDC provider guarantees stable per-identity. Keep `Users.ID` (cuid) as the physical FK and `sapId` as a fast-path/attribute. Resolution becomes tiered; callsites stay unchanged via a pin pattern.

## Section 1 — Schema

New entity in `db/schema.cds`:

```cds
@assert.unique.issuerSubject : [issuer, subject]
entity UserIdentities : cuid, managed {
  user          : Association to Users @mandatory;  // → user_ID FK
  issuer        : String(512) @mandatory;           // JWT `iss`
  subject       : String(255) @mandatory;           // JWT `sub` — stable per-IdP identity
  provider      : String(32);                       // 'sap-id' | 'ias' | 'github' | 'google'
  email         : String(255);                      // email AS SEEN BY THIS IdP (attribute, not key)
  emailVerified : Boolean default false;            // true when written from a login (login proves it)
  linkedAt      : Timestamp;
}
```

`Users` gains only:
```cds
identities : Composition of many UserIdentities on identities.user = $self;
```

- `sapId`, `khorosId`, `githubLogin`, `Users.email` stay as attributes.
- **No `@assert.unique.email`** — PROD data (97.6% null, non-unique) cannot support it.
- **Two distinct email fields, different jobs:**
  - `Users.email` — the user's current/display email, lazily backfilled on login (behavior UNCHANGED).
  - `UserIdentities.email` + `emailVerified` — the email as asserted by that specific IdP, an attribute of the link. A GitHub link and an SAP link can carry different emails for the same human.

## Section 2 — Tiered resolver

Resolution splits: a new `async resolveUser(user)` returns the `Users` row (or null); the existing synchronous `resolveUserSapId` stays for the XSUAA fast-path and backward-compat. Read identity from `cds.context.user` (CAP: `req.user` is internal to auth strategies).

**Tier 1 — `(iss, sub)` link lookup.** `SELECT user FROM UserIdentities WHERE issuer=? AND subject=?`. Primary; durable; works for every provider. Returning users always hit this.

**Tier 2 — sapId fast-path + self-heal.** On T1 miss, if the token yields a canonical sapId (XSUAA `user_uuid`), `SELECT Users WHERE sapId=?`. Hit → **write a `UserIdentities` link row** `(iss, sub, provider, email, emailVerified:true)`, return the row. Covers the ~816k migrated SAP users with no link row yet. **Auto-link-by-sapId semantics (approved):** any login resolving to a sapId links that `(iss,sub)` to the existing row, so SAP-via-XSUAA and SAP-via-IAS converge on one `Users` row.

**Tier 3 — token-email provisioning hint.** On T1&T2 miss, match the token's email (trusted-verified — the IdP enforces email verification before login is possible, so no separate `email_verified` claim is required) against `Users.email`:
- **Token-email extraction:** prefer the `email` claim; if absent, use `sub` only when `sub` is email-shaped (contains `@`). For the current IAS app, `sub == email == the address` (decoded 2026-10-01). A provider whose `sub` is a UUID with no `email` claim yields no Tier-3 email → T3 is skipped (falls to miss/provision). Lowercase before comparison.
- Exclude stored `…@users.noreply.github.com` synthetics as match targets (GitHub contributor-API dirty data).
- Single-canonical-row preference: prefer a non-SCIM-UUID `sapId` row when multiple rows share the email (carries forward the #2550 collision fix).
- Hit → write a link row with `emailVerified: true`, return the row.

**Miss on all three → null → caller stays fail-closed (401)**, exactly as today.

### Keeping the ~40 sync callsites unchanged — the pin pattern

A `before('*')` (srv-mcp) / existing auth hook (main srv) calls `resolveUser` once and pins the resolved row onto `cds.context.user`:
- `authInfo.token.userId = row.sapId` when present (SAP users — today's path, unchanged), **and**
- `cds.context.user.attr.dbUserId = row.ID` (the cuid PK) for the no-sapId case.

`resolveUserSapId` is unchanged (returns sapId or null). The two shared row-resolvers — `resolveDbUser` and `user-progress.js resolveDbUserId` — gain a fallback: if `sapId` is null but `attr.dbUserId` is pinned, resolve `WHERE { ID: dbUserId }`. The ~40 callsites funnel through these two and need **zero individual edits**.

### Per-login-path behavior

| Login | Tier (first → subsequent) | sapId pinned? | Carried by |
|---|---|---|---|
| SAP via XSUAA (migrated) | T2 → T1 | yes (I-number) | `userId` |
| SAP via IAS (MCP) | T3 → T1 | yes (I-number via email match) | `userId` |
| Social (future, no SAP ID) | T3 → T1 | no | pinned `row.ID` |

After the first hit, every path is Tier 1 — no email dependency once a link row exists.

## Section 3 — Provisioning + the no-sapId seam

`provisionDbUser` mirrors the resolver:
1. Try `resolveUser` (T1→T2→T3). Hit → backfill blanks, ensure a link row exists, return.
2. Miss → create a `Users` row (sapId from token if canonical, else null) + a `UserIdentities` link row `(iss, sub, provider, email, emailVerified:true)`. Keep the existing concurrency backstop (swallow unique collision, re-select).

A social/IAS user with no sapId gets a `Users` row (`sapId=null`) + a link row — fully functional for progress/MCP, carried by the pinned `row.ID`; just not NGDS-badgeable until a sapId is present.

**Manual employee-ID entry (approved: trusted).** A social user may set `Users.sapId` via Profile Maintenance. This is accepted as fully trusted: any canonical `sapId` is NGDS-eligible regardless of origin. The only collision guard is `@assert.unique.sapId` (app-level) — Profile Maintenance MUST handle a uniqueness rejection gracefully (user-facing error, not a 500). No `sapIdVerified` distinction.

## Section 4 — NGDS carve-out (no-op)

`ngds-autosend.js` / `ngds-client.js` are **unchanged**. They read `Users.sapId` by row PK (`user_ID`) and gate on the canonical regex + migration-stamp + cutover epoch — they never call the identity resolver.
- Social/no-sapId user → sapId null → auto-send suppresses (`ngds.autosend.skipped.no_identity`); still gets progress/MCP. Intended.
- Manual or login-acquired sapId → NGDS auto-resumes with zero NGDS code change.

The carve-out is structural: NGDS is the one component that keeps using the I-number, and it needs no edits.

## Section 5 — Scope, fixes, migration, testing

**In scope (this build):**
1. `UserIdentities` entity + `Users.identities` composition.
2. `async resolveUser` tiered resolver + pin-pattern wiring; `resolveDbUser` / `resolveDbUserId` gain the `attr.dbUserId` → `WHERE {ID}` fallback.
3. `provisionDbUser` on `(iss, sub)` with self-heal link-writes.
4. Remove the unsafe #2550 email-join (`resolveIasSapId` / `pinIasSapId` as currently written); replace with the Tier-3 path inside the new resolver.
5. Fix `ktt-service.js:29,44` — the pre-existing `sapId: req.user.id` mis-key (email under XSUAA) → route through the resolver.
6. Preserve `backfillUserProfile` login-time email backfill (unchanged).
7. Re-bundle `@tutorials/core` into srv-mcp / srv-qa (`scripts/bundle-shared.cjs`); re-export new functions from `packages/core/index.js` and the `srv/lib` shim.
8. `srv-qa` cp-list audit (CLAUDE.md): re-walk transitive `srv/lib/` imports after touching the resolver.
9. Tests: resolver tiers (unit, mocked cds/SELECT), provisioning get-or-create, no-sapId seam (`attr.dbUserId` fallback), NGDS suppression for null sapId, `ktt-service` fix, XSUAA regression (migrated user still resolves by sapId).

**Deferred (tracked, NOT this build):**
- Email backfill/dedupe/`@assert.unique.email` + `.hdbmigrationtable` — only needed if email ever becomes a *key*; out of scope (email stays attribute).
- Full social-IdP enablement (IAS Conditional Auth, social sign-on, identifier-first/session work) — separate.
- Cross-provider explicit account-merge UX (same human via SAP then GitHub) — reuses existing `account-merge.js` + `PrimaryAccounts`/`SecondaryAccounts`; wire-up deferred.

**Migration:** `UserIdentities` is a NEW, empty entity → additive `.hdbtable`, NO ALTER on the 816k-row `Users` table (low-risk deploy). It self-populates lazily via Tier-2/3 link-writes as users log in — no bulk backfill, same philosophy as the email backfill.

## Verification

1. Unit: all three tiers resolve correctly against a mocked `UserIdentities`/`Users`; miss → null.
2. XSUAA regression: a migrated SAP user (sapId in `user_uuid`) resolves to the same row as today (T2), and a link row is written.
3. IAS MCP acceptance (the #2550 blocker): real `mcp-remote` login → `get_my_tutorials` returns the logged-in user's data (T3 first hit → link row → T1 thereafter).
4. No-sapId seam: a user with `sapId=null` + pinned `attr.dbUserId` resolves per-user data via `WHERE {ID}`.
5. NGDS: null-sapId user suppresses; populated-sapId user (manual or login) is eligible.
6. `ktt-service` resolves via the resolver, not raw `req.user.id`.

## Hard rules

- PRs target DEV; never deploy a feature branch; deploy from fresh `origin/DEV`; `cf target` before every push.
- `req.user` is internal — read `cds.context.user`.
- Fail-closed on resolution miss (401), never silently return 0 rows without a WARN carrying sapId + email + (iss,sub).
- Do not add `@assert.unique.email` (data can't support it).
- `UserIdentities` is additive only — no ALTER on `Users`.
