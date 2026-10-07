# Headless Admin OData / GraphQL via per-user PATs

**Issue:** [#2574](https://github.com/sap-tutorials/tutorials-ims/issues/2574)
**Date:** 2026-10-07
**Status:** Design — awaiting review before implementation plan
**Context:** #2539 (DJ Adams use case), #2552 (identity work)

## Problem

The Admin OData surface (`AdminService` `@path:'/admin'`, `@requires:'Admin'`) and
`/graphql` (CAP `authenticated-user` / `Tutorial.API`) are reachable **only from an
interactive browser session** today. There is no supported headless/`curl` flow:

- `$XSAPPNAME.Admin` is granted only to named users via the *Tutorials Admin* role
  collection; it is **not** in `xs-security.json` `authorities` (only `Everyone` +
  `InternalWrite`), so a `client_credentials` token cannot carry it.
- PATs are confined to the `/mcp-pat/*` namespace and carry only
  `authenticated-user` + `pat-read`/`pat-write` pseudo-roles (`lookupPAT` hardcodes
  `roles: []`). The Authorization header is stripped before any OData/GraphQL auth runs.
- The approuter gates `/admin/*` with `authenticationType: xsuaa` + `scope
  $XSAPPNAME.Admin`, and `/graphql` with `authenticationType: xsuaa` — both require a
  session; a bearer PAT redirects to login.

User impact (#2539): monitoring one's own tutorials via
`/admin/Tutorials?$filter=owner eq '…'&$expand=completionStats,feedbackItems` works
in the browser but **cannot be scripted**.

## Chosen security model

**Per-user PAT, extended to BOTH `/admin/*` and `/graphql`, with authority resolved
live per request from an app-managed DB grant.** (Rejected: adding `Admin` to
`authorities` for `client_credentials` — widens blast radius to any binding of
`tutorials-xsuaa`.)

Key decisions (confirmed with maintainer):

| Decision | Choice |
|---|---|
| Surfaces | Both `/admin/*` (Admin) and `/graphql` (Tutorial.API) |
| Scope→role mapping | Resolve the owner's roles **live per request** (not baked into the PAT) |
| Mint-time gate | Minting an `admin`-scoped PAT requires the caller to hold `Admin` on their live XSUAA session (403 otherwise) |
| Live authority source | A new app-managed `AdminGrants` DB table (XSUAA roles are unavailable on a PAT request) |
| Admin PAT TTL | Shorter than read/write PATs: **default 30 days, max 90 days** (vs 90/365) |
| settings.json plaintext risk | Document hygiene in `api-consumption.md`; file a **separate ticket** for a Credential-Store-backed MCP-client PAT option |
| Feature flag | New DB flag `PAT_ADMIN_SCOPE_ENABLED`, default **OFF**, DEV-first |

### Why a DB grant, not XSUAA, at request time

A PAT request carries no XSUAA JWT (that is the whole point of headless access), so
the owner's XSUAA role-collection membership is **not** resolvable server-side at
request time. "Live per-request" authority can therefore only come from our own
persistence. The `AdminGrants` row is the server-trusted source of truth for
"is this PAT owner currently an admin"; the mint-time gate ties that row back to a
genuine XSUAA Admin check so a non-admin can never create one.

## Architecture

### Components

1. **`AdminGrants` entity** (`db/mcp-pats.cds`, co-located with `PATs`)
   - `user : Association to ims.Users` (the grantee)
   - `grantedAt : Timestamp`, `grantedBy : String` (email of the admin who minted/affirmed), `expiresAt : Timestamp`
   - Presence of a non-expired row = that user currently has headless admin authority.
   - `@assert.unique` on `user` (one grant row per user; upsert on affirm).

2. **PAT scope `admin`** (`srv/lib/mcp-pat-actions.js`)
   - Add `'admin'` to `VALID_SCOPES` (currently `{read, write}`).
   - Admin-scoped mint is gated (see mint flow) and uses the shorter TTL clamp.

3. **Live grant resolution in `lookupPAT`** (`srv/lib/mcp-pat-middleware.js`)
   - `lookupPAT` already `SELECT`s the full `Users` row. Add: if the PAT's `scopes`
     include `admin`, `SELECT from AdminGrants where user_ID = row.user_ID`; if a
     non-expired row exists, set `roles: ['Admin', 'Tutorial.API']`; else `roles: []`.
   - A read/write-only PAT never gets admin even if the owner has a grant — the scope
     is the token's declared intent. Admin implies `Tutorial.API` (so one admin PAT
     works on both surfaces, matching the "both surfaces" decision).
   - `installSyntheticUser` already honors `cached.roles` in its `is()` closure — no
     change needed there beyond `roles` now being populated.

4. **Bootstrap PAT recognition for `/admin/*` and `/graphql`** (`srv/server.js`)
   - New root middleware (mirrors the `/mcp-pat/` block at ~line 1229), gated behind
     `PAT_ADMIN_SCOPE_ENABLED`. For requests whose URL starts with `/admin` or
     `/graphql` AND carry `Authorization: Bearer pat_`:
     - call `patMiddleware` (sets `req.user` with `tokenSource:'pat'`, strips the
       Authorization header), then `next()` **without** URL rewrite (unlike
       `/mcp-pat`, we want CAP's real `/admin` + `/graphql` routers to serve it).
     - a non-PAT request falls through untouched to the normal XSUAA session path.
   - The already-global `pinPatUserToContext` (`after:'auth'`) propagates the PAT user
     to `cds.context.user` — no change.

5. **Approuter route change** (`approuter/xs-app.json`) — **open sub-decision, see below.**

6. **Mint-time gate + admin-grant revoke** (`srv/lib/mcp-pat-actions.js`, `srv/admin-service.*`)
   - Mint flow (below). Revoke: new `AdminService` action `revokeAdminGrant(user_ID)`
     (`@requires:'Admin'`) deletes the grant row — instantly disabling that user's
     admin PATs on their next request. Surface in the existing `PATsAdmin` audit area.

### Data flow — minting an admin PAT

```
User (interactive XSUAA session, holds Tutorials Admin) → POST /pats mintPAT{scopes:['admin']}
  → PatService.handleMintPAT
     → if !PAT_ADMIN_SCOPE_ENABLED            → 503 (flag off)
     → if !MCP_PAT_MINT_ENABLED               → 503 (existing kill-switch)
     → assertValidScopes(['admin'])           → ok (admin now valid)
     → if scopes includes 'admin':
          if !req.user.is('Admin')            → 403 (caller lacks real Admin)
          else upsert AdminGrants{user, grantedBy, expiresAt=+30..90d}
     → clampTtl uses the admin clamp (default 30, max 90) when admin-scoped
     → INSERT PATs{..., scopes:['admin']}; return plaintext token ONCE
```

### Data flow — using an admin PAT headless

```
curl -H "Authorization: Bearer pat_…" https://…/admin/Tutorials?$filter=…
  → approuter route for /admin (see sub-decision) forwards to srv-api
  → srv/server.js bootstrap middleware: URL starts /admin + Bearer pat_ + flag ON
       → patMiddleware → lookupPAT(hash)
            → PAT has scope 'admin' → SELECT AdminGrants where user_ID
                 → non-expired row? roles=['Admin','Tutorial.API'] : roles=[]
            → installSyntheticUser (req.user.is('Admin') now true); STRIP Authorization
       → next() (no rewrite)
  → CAP auth phase: no JWT (stripped) → pinPatUserToContext copies PAT user to cds.context.user
  → AdminService @requires:'Admin' satisfied by cds.context.user.is('Admin') → 200
```

## Open sub-decision for review: approuter routing

`/admin/*` and `/graphql` currently require `authenticationType: xsuaa` at the
approuter, which redirects a bearer PAT to login before it ever reaches the app.
Two ways to let the PAT through:

- **(A) Dedicated `none` routes (recommended).** Add approuter routes that match a PAT
  request (e.g. by a distinct path prefix like `/admin-pat/*` → rewritten to `/admin`,
  mirroring `/mcp-pat/`→`/mcp`, OR by matching the `Authorization: Bearer pat_` — note
  approuter cannot route on header value, so a path prefix is the practical lever).
  The existing interactive `/admin/*` xsuaa route is **untouched**; the browser session
  path keeps its approuter-level scope enforcement. Downside: headless callers use a
  slightly different base path (`/admin-pat/...`, `/graphql-pat`), documented in
  `api-consumption.md`.
- **(B) Flip `/admin/*` and `/graphql` to `authenticationType: none`.** Simpler URLs
  (same path for browser and curl), but removes approuter session enforcement for **all**
  callers — interactive admin access would then rely solely on CAP `@requires:'Admin'`.
  A real behavior change and a wider blast radius. Not recommended.

**Recommendation: (A)** — a `/admin-pat/*` and `/graphql-pat` prefix with a bootstrap
rewrite (exactly the `/mcp-pat/` pattern that already works), leaving every interactive
route as-is. This keeps the change additive and reversible (delete the routes + the
middleware to fully disable).

## Error handling

- **Fail-closed grant resolution.** Any error selecting `AdminGrants` → `roles: []`
  (PAT degrades to `authenticated-user` + its read/write scopes). Never throws into the
  request pipeline.
- **Expired grant.** Treated as absent → no admin roles. The PAT itself stays valid for
  its non-admin scopes until its own `expiresAt`.
- **Flag off.** `PAT_ADMIN_SCOPE_ENABLED` OFF → the bootstrap middleware does not engage
  (PAT on `/admin-pat` 401s as unknown route / falls through), and `mintPAT{admin}`
  returns 503. Existing read/write PAT behavior unchanged.
- **Mint by non-admin.** 403, no grant row written, no PAT minted.
- **Header strip.** The bootstrap middleware strips `Authorization` after installing the
  synthetic user (as `/mcp-pat` does) so CAP's XSUAA strategy does not JWT-parse the PAT
  and 401 (known failure mode — see memory `pat-token-vs-cap-xsuaa-jwt-parse`).

## Testing (TDD — test the actual thing)

1. **Unit (in-memory SQLite, `npm test`):**
   - `lookupPAT` populates `roles:['Admin','Tutorial.API']` when a non-expired
     `AdminGrants` row exists AND the PAT has scope `admin`; empty otherwise.
   - Expired grant → no admin. Read/write-only PAT with a grant present → no admin.
   - `assertValidScopes(['admin'])` passes; mint gate 403s a non-admin caller; grant
     upsert on admin mint; admin TTL clamp (30/90).
   - Grant resolution error → fail-closed (`roles:[]`).
2. **Integration:** bootstrap middleware recognizes `Bearer pat_` on `/admin-pat` +
   `/graphql-pat`, strips header, `cds.context.user.is('Admin')` true end-to-end against
   `AdminService`; flag OFF → path inert.
3. **Smoke / e2e (post-deploy, self-skips without `SMOKE_*`):** real
   `curl -H "Authorization: Bearer pat_…"` against deployed
   `/admin-pat/Tutorials?$filter=owner eq '…'&$expand=…` and `/graphql-pat` — the exact
   #2539 scenario. Add to `test:smoke` / `test:e2e`.

## Documentation

- `docs/end-users/api-consumption.md`:
  - Flip the Admin OData + GraphQL rows from "❌ browser session only" to
    "✅ headless-capable (PAT, `admin` scope)".
  - Rewrite the two "browser-session only (today)" sections into working `curl` flows
    (mint at `/me/tokens/` with `admin` scope → `curl` the `/admin-pat/*` + `/graphql-pat`
    endpoints).
  - **PAT hygiene callout:** admin PATs are high-value bearer credentials; prefer an env
    var / secret store over committing them to client config files such as Claude Code
    `settings.json`; use the shortest TTL that works; revoke when done
    (`/me/tokens/` or admin `revokeAdminGrant`).
  - Move the #2574 gap item from "future work" to "done".

## Out of scope (YAGNI)

- `client_credentials` / `authorities` technical-user path (rejected security model).
- GraphQL schema changes.
- Credential-Store-backed storage for the MCP **client's** PAT (the `settings.json`
  plaintext concern) — **separate ticket**, not this PR.
- Any `/me/tokens/` UI change beyond adding an `admin` scope checkbox, gated by the flag
  and only offered to a user who holds a live grant.

## Feature-flag registration

Add to `packages/core/feature-flags/registry.js` (same shape as `MCP_PAT_MINT_ENABLED`):
`PAT_ADMIN_SCOPE_ENABLED`, kind `db`, imsConfigKey `flag.pat.adminScope`, boolean,
default **false**, status `beta`, issue #2574. DEV-first; flip after DEV verification.

## Reversibility / kill path

Delete the bootstrap middleware block + the `/admin-pat`/`/graphql-pat` approuter
routes, drop `'admin'` from `VALID_SCOPES`, and set `PAT_ADMIN_SCOPE_ENABLED` OFF.
Existing read/write PATs and interactive admin access are unaffected throughout.
