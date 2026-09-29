# IAS Migration Impact Research — tutorials-ims Authentication

**Date:** 2026-09-29
**Status:** Research only — read-only investigation. **No code was changed.**
**Scope:** Decide whether a minimal POC of SAP Cloud Identity Services (IAS) for the MCP endpoint is worth doing, and map the blast radius of a broader XSUAA→IAS auth migration.
**Drivers:**
1. A working OAuth/public-PKCE path for the MCP endpoint. XSUAA cannot do a standalone secretless/public PKCE client on the `application` plan (empirically proven — see §1).
2. Issue #2506's branded-login goal (custom login page / branding, which the default SAP ID Service cannot provide).

> **Grounding rule for this doc:** every claim is tagged with either a codebase citation (`file:line`) or an authoritative SAP source (URL/title). Anything that can only be resolved by standing up IAS is called out as an explicit **OPEN QUESTION**.

---

## Executive Summary

**Is IAS-for-MCP viable?** Yes, technically. The OAuth/MCP tier is already cleanly isolated in its own module (`srv-mcp/`) and its own MTA (`mta.yaml`, ID `tutorials-mcp`), bound to exactly one auth resource and validating exactly one issuer (`mta.yaml:63,79-82`). CAP natively supports `auth.kind: "ias"` and an `ias`+`xsuaa` hybrid that accepts BOTH token types on one service (SAP CAP docs — [Hybrid Authentication / XSUAA Fallback](https://cap.cloud.sap/docs/guides/security/authentication#xsuaa-auth)). `@sap/xssec` (the validator) is already a dependency of `srv-mcp` (`srv-mcp/package.json:20`). IAS natively provides public clients + PKCE + optional dynamic client registration (RFC 7591) — precisely the capabilities the repo's own dated, in-code notes prove XSUAA's `application` plan lacks (`mta.yaml:54-62`, "empirically confirmed 2026-09-29").

**Is the POC worth doing?** **Yes — a minimal, MCP-only POC is worth doing, and it is low-risk IF and ONLY IF it is scoped to the isolated `srv-mcp` module and left in the `ias`+`xsuaa` hybrid so the existing XSUAA browser/PAT paths keep working unchanged.** The single most important thing the POC must measure is the **token claim shape of an IAS-issued token** (§2), because the entire authenticated data model keys on one value — `Users.sapId`, populated from the XSUAA `user_uuid` claim — and that same value is *also* the identifier sent outbound to NGDS/community/badging with a hard format gate. If an IAS token does not carry that same P/S/I-number value in a claim the platform can read, the migration silently orphans progress records and silently drops badge crediting. This cannot be settled from docs; it is the red/green light for any broader migration.

**Recommended posture:** Green-light a **hybrid, MCP-scoped POC** (§ "Recommended Minimal POC Scope"). Do **not** flip the main browser-facing services (`tutorials-srv`) to IAS as part of this POC — that is a separate, much larger decision that this research rates **High risk** on §2/§4/§6 until the claim-shape open questions are closed with real tokens.

**Critical distinction this doc rests on:** There are TWO different "IAS migrations" and the codebase docs conflate them:
- **(A) IAS-as-trust-behind-XSUAA** (`docs/developers/operations/ias-setup.md` "Option B"; `docs/developers/architecture/authentication.md:668-673` "If You Migrate to IAS"). Here **XSUAA still issues the token**; IAS is just the upstream IDP. Token claims stay **XSUAA-shaped** (`user_uuid`, `user_name`, `email`, `scope`), so the doc's "No changes needed to CAP service code" (`authentication.md:673`) is broadly true.
- **(B) IAS issues the token directly** via a bound `identity` service instance and `cds.requires.auth: { kind: 'ias' }`. This is what the task proposes for `srv-mcp`. Here the token is an **IAS-issued OIDC token with a different claim shape**, and `req.user.id` / attributes derive from IAS, not XSUAA. **This is where the §2 risk lives.** The repo's optimistic "no code changes" note describes (A), not (B).

---

## Section 1 — IAS OAuth feasibility for MCP

**Risk rating: LOW–MEDIUM (technical feasibility LOW; unknowns pushed to §2).**

### What exists today (the clean seam)
- The OAuth/MCP tier is a **separate CAP module** `srv-mcp/` deployed as its **own MTA** `mta.yaml` (`ID: tutorials-mcp`, module `tutorials-srv-mcp`, `path: gen/srv-mcp` — `mta.yaml:6,32-34`). It is bound to the existing confidential `tutorials-xsuaa` for inbound JWT validation (`mta.yaml:63`, adopted as existing-service `:79-82`).
- Its auth config is a single line: `srv-mcp/package.json:28-30` → `"auth": { "kind": "xsuaa" }`. `@sap/xssec` is already a dependency (`srv-mcp/package.json:20`).
- The approuter route `^/mcp-auth/(.*)$` is `authenticationType: "none"` → `destination: "srv-mcp-api"` (`approuter/xs-app.json:568-573`); the PKCE bearer passes through untouched and CAP validates it server-side. So **the approuter needs no auth change** to move this tier to IAS.
- Discovery docs are generated dynamically by `approuter/lib/well-known-oauth.js` (RFC 8414 `/.well-known/oauth-authorization-server`, RFC 9728 `/.well-known/oauth-protected-resource`).

### Why XSUAA cannot do the public/PKCE client (the driver, proven in-repo)
- `mta.yaml:54-62`: "XSUAA `application` plan cannot declare a standalone public/PKCE client (broker rejects public-client / _pkce_s256 grant / credential-types:none — **empirically confirmed 2026-09-29**…)."
- `docs/superpowers/specs/2026-07-08-mcp-server-phase2-design.md:136-145` (the 2026-07-13 correction): XSUAA auto-creates exactly one client per instance (`sb-<xsappname>!<suffix>`) and cannot define a second differently-named client. `:27`: "Dynamic client registration (RFC 7591) — XSUAA doesn't support it natively."
- `docs/superpowers/specs/2026-09-27-mcp-auth-multi-package-split-design.md:7-22`: token exchange fails `invalid_client` because the default client is confidential and requires a secret while `mcp-remote` sends PKCE only.
- The shipped workaround: reuse the confidential `sb-tutorials!<suffix>` client with `client_secret` OMITTED (`docs/end-users/mcp-quickstart.md:261-270`). It works for `mcp-remote` but is a workaround, not a real public client, and does not satisfy clients that require a genuine public/DCR flow.

### What it concretely takes to give `srv-mcp` an IAS public/PKCE client
1. **Create + bind an `identity` service instance.** `cds add ias` generates exactly this: a resource of `service: identity`, `service-plan: application`, bound with `credential-type: X509_GENERATED` and `app-identifier`, plus a `cert.*` route for mTLS (SAP CAP docs — [Adding IAS](https://cap.cloud.sap/docs/guides/security/authentication#ias-auth), which shows the generated `mta.yaml` block verbatim). Today **NO `identity` instance exists anywhere** — all four subagent sweeps + a direct grep confirm auth is 100% XSUAA (`mta.yaml`, `.deploy/mta.yaml:460-466`, and the roles-agent grep for `service: identity` returned zero). The subaccount already has an active IAS **trust** (origin `sap.custom` = `atxgsg7zi.accounts.ondemand.com`) but **zero bound `identity` service instances** — trust ≠ a bound instance; a bound instance is still required for `kind:'ias'`.
2. **Register the IAS OIDC public/PKCE app** in the IAS admin console (public client, PKCE S256, redirect URIs matching the current allowlist: `http://localhost:*/oauth/callback`, `vscode://…`, `https://developers.sap.com/callback` — cf. `xs-security.json:227-238` for the current XSUAA set, plus `mcp://*`-style native schemes noted in `2026-07-08-mcp-server-phase2-design.md:147`).
3. **Switch `srv-mcp` to the hybrid.** Change `srv-mcp/package.json:28-30` from `{ "kind": "xsuaa" }` to `{ "kind": "ias", "xsuaa": true }`, and swap the `mta.yaml` binding from the `tutorials-xsuaa` existing-service (`:63,79-82`) to the new `identity` instance while keeping `tutorials-xsuaa` bound too (so XSUAA tokens still validate).
4. **Repoint the discovery generator.** `approuter/lib/well-known-oauth.js:122-144` is XSUAA-specific (self-issuer workaround because "XSUAA does not implement RFC 8414" — `:125-132`). IAS *does* implement standard OIDC discovery, so for IAS the issuer/authorize/token endpoints can point straight at IAS and the self-issuer hack may become unnecessary (a simplification). Env config `XSUAA_MCP_URL` / `XSUAA_MCP_XSAPPNAME` (`.deploy/mta.yaml:310,316`) would be replaced/augmented with IAS equivalents.

### CAP-doc confirmation that ias+xsuaa hybrid accepts BOTH token types on one service
SAP CAP docs, [Hybrid Authentication → XSUAA Fallback](https://cap.cloud.sap/docs/guides/security/authentication#xsuaa-auth):
> "accept tokens issued by XSUAA and IAS → bind your application to service instances of **both** types."
> "To ease your migration from XSUAA-based to IAS-based authentication, the `ias` strategy **automatically supports tokens issued by XSUAA** when you provide the necessary credentials at `cds.env.requires.xsuaa.credentials`."
Config: `"requires": { "auth": "ias", "xsuaa": true }`. The Node.js runtime path is real: the CAP docs' Node startup log shows `using auth strategy { kind: 'ias', impl: 'node_modules/@sap/cds/lib/srv/middlewares/auth/ias-auth.js' }` (same doc). This means the POC can run **hybrid** — existing XSUAA `mcp-remote` clients keep working while an IAS public client is added — which de-risks the flip.

**Impact assessment:** Feasibility is **LOW risk** — a clean, isolated module, a one-line auth-kind change, a generated MTA binding, and native IAS support for the exact PKCE/DCR features XSUAA lacks. The `MEDIUM` component is entirely the claim-shape unknown carried into §2, plus mTLS/`cert.*` route wiring and the discovery-generator rework, none of which are proven-out locally yet.

**OPEN QUESTIONS (POC-only):**
- **OQ-1.1** Does the hybrid (`kind:'ias', xsuaa:true`) actually validate BOTH a real IAS token and the existing XSUAA `mcp-remote` bearer on the *same* `srv-mcp` route in a deployed CF space? (Docs say yes; unproven here.)
- **OQ-1.2** Does IAS's `identity` `application` plan require the `cert.*` mTLS route + `X509_GENERATED` binding for the MCP bearer flow, and does the approuter `authenticationType:"none"` passthrough still work with an IAS token that expects proof-of-possession/x5t validation (`@sap/xssec` enables x5t + proofToken by default on `.cert` routes — CAP docs [Token Validation](https://cap.cloud.sap/docs/node.js/authentication))?
- **OQ-1.3** Can IAS's discovery replace the approuter self-issuer workaround, or does the `mcp-remote` SDK still need the approuter to front discovery?

---

## Section 2 — Token claim-shape + login email backfill (HIGHEST RISK)

**Risk rating: HIGH — this is the crux of the entire migration.**

### The backfill / identity-resolution code (quoted, with citations)
Canonical resolver: **`packages/core/resolve-db-user.js`** (`srv/lib/resolve-db-user.js` is a thin re-export shim, `srv/lib/resolve-db-user.js:1-9`).

`resolveUserSapId` — the single value everything keys on (`packages/core/resolve-db-user.js:49-58`):
```js
export function resolveUserSapId(user) {
  if (!user || !user.id || user.id === 'anonymous') return null;
  const t = user.authInfo?.token;
  if (t?.userId) return t.userId;                     // @sap/xssec → payload.user_uuid
  if (t?.payload?.user_uuid) return t.payload.user_uuid;
  return user.id;                                     // fallback: basic-auth tech users / tests
}
```
The header comment (`packages/core/resolve-db-user.js:9-28`) documents the empirically-established facts:
- IMS keyed users by **SAP ID** (I-/D-/S-number). The XSUAA JWT carries this in the **`user_uuid`** claim (confirmed against IMS Java `AuditUserFilter`/`UserResolverHelperImpl` + a prod `/auth/user` dump 2026-06-16).
- `@sap/xssec` exposes it as `req.authInfo.token.userId` (= `payload.user_uuid`).
- **`req.user.id` under XSUAA-against-SAP-ID-Service is the user's EMAIL, not `user_uuid`** — which is why the code deliberately does NOT use `user.id` for lookups. (Note: `docs/developers/architecture/authentication.md:147,193,287` simplifies this to "`user.id` = `user_uuid`" — the code comment is the empirical correction; treat the code as authoritative.)

Email backfill (`packages/core/resolve-db-user.js:122-161`):
```js
export function emailFromUser(user) {
  if (user?.attr?.email) return user.attr.email;
  const id = user?.id;
  return typeof id === 'string' && id.includes('@') ? id : null;   // token subject IS email for browser logins
}
// backfillUserProfile: reads user.attr.given_name||givenName, family_name||familyName, emailFromUser(user)
// then UPDATEs Users(firstName,lastName,email) WHERE sapId, only filling blanks.
```
The comment at `:132-135` explicitly hedges: "JWT claim shape from SAP ID Service / IAS — … Either snake_case (SAP ID Service) or camelCase (some IAS configurations) shows up, hence the `||` fallback." So the code *already anticipates* IAS claim-shape variance for names — but the **identity key** (`sapId`) has no such fallback.

### The chain that makes this HIGH risk
**JWT `user_uuid` → `resolveUserSapId()` → `Users.sapId` → every authenticated read/write.** Confirmed keying:
- `resolveDbUser` / `provisionDbUser` both `SELECT.one.from(Users).where({ sapId })` (`packages/core/resolve-db-user.js:67-74, 220-276`).
- Auto-provision INSERTs `sapId` from `resolveUserSapId(req.user)` (`packages/core/resolve-db-user.js:252`; `srv/developer-service.js:159,983,1027,1083`; `srv/petoberfest-service.js:11-19`; `srv/puzzle-service.js:87-95`).
- Progress reads scope on `sapId` then `user_ID` (`srv/developer-service.js:333-334`).

### Does an IAS-issued OIDC token carry the SAME claim shape as an XSUAA token?
Authoritative CAP-doc facts:
- IAS is OpenID-Connect compliant and provides user identity/attributes via a bound `identity` instance as a JWT; it adds `cds.context.user.authInfo` (SAP CAP docs — [IAS-based Authentication](https://cap.cloud.sap/docs/node.js/authentication#ias)).
- **`cds.User.id` corresponds to `$user` and its source is authentication-strategy-dependent** (SAP CAP docs — [cds.User .id](https://cap.cloud.sap/docs/node.js/authentication)). The Node.js doc does **not** state which IAS claim becomes `user.id`, and a WebFetch of that page confirmed it "does not specify which token claim becomes `cds.context.user.id` under IAS."
- XSUAA and IAS tokens are **different token types** validated by different `@sap/xssec` paths (CAP docs distinguish them throughout; hybrid requires binding *both* instance types precisely because the tokens differ).

What this means: XSUAA tokens carry `user_uuid` (the SAP IDP Global User ID = the P/S/I-number the platform stores as `sapId`), `user_name`, `email`, `xs.user.attributes` (`authentication.md:54-72`). An **IAS-issued** OIDC token's subject (`sub`) is generally an **IAS-internal user UUID / SCIM id**, and IAS tokens do **not** carry XSUAA authorization claims (CAP docs, [IAS-based Authentication]: "JWT tokens issued by IAS service **don't contain authorization information. In particular, no scopes are included.**"). Whether an IAS token exposes the SAP Universal ID / P-number in a claim the platform can map to `user_uuid` is **not documented in a machine-renderable SAP source** (the SAP Help token pages are JS-rendered and did not yield content to WebFetch) and is exactly what the `resolveUserSapId` fallback chain does **not** handle: if `authInfo.token.userId` (XSUAA `user_uuid`) is absent and `payload.user_uuid` is absent, it falls through to `user.id` — which under IAS is likely the IAS UUID or email, **not** the P/S/I-number.

### The concrete failure mode
If IAS tokens resolve a *different* stable id than the stored `sapId`:
1. `resolveUserSapId` returns the IAS value → `WHERE sapId = <IAS value>` misses every one of the ~797k migrated rows and every previously-provisioned row.
2. `provisionDbUser` then **mints a NEW `Users` row** for the same human (guarded only by `@assert.unique.sapId`, which the direct `cds.db` INSERT bypasses on HANA — `packages/core/resolve-db-user.js:198-213,264-274`). Result: **orphaned progress** (old `TaskRecords` still FK to the old row) and **duplicate profiles**.
3. Because `emailFromUser` falls back to `user.id.includes('@')`, if IAS puts an email in `user.id` the new row's `email` gets written, but the `sapId` is now an IAS UUID — poisoning the outbound NGDS gate (§6) as well.

**Impact assessment: HIGH.** The blast radius is the entire per-user data model (progress, points, completions, ownership). This is *contained* for an MCP-only hybrid POC (MCP write tools forward to main-srv and the same human's XSUAA path still resolves the old `sapId`), but it is the **red-light gate** for any migration of the main browser services to IAS.

**OPEN QUESTIONS (POC-only — these decide the whole thing):**
- **OQ-2.1 (RED/GREEN LIGHT)** For a real IAS-issued token for a known SAP Universal ID user, what is `resolveUserSapId(req.user)`? Specifically: does `req.authInfo.token.userId` / `payload.user_uuid` still carry the **same P/S/I-number** as the XSUAA path, or does it resolve an IAS UUID / email? Decode a real IAS token via `srv-mcp` and diff `sapId` against the same human's XSUAA `user_uuid`.
- **OQ-2.2** What is `req.user.id` and `req.user.attr.{email,given_name,family_name,givenName,familyName}` under IAS? (Needed to confirm `backfillUserProfile`/`emailFromUser` still populate correctly and don't write an IAS email onto a mis-keyed row.)
- **OQ-2.3** Can IAS be configured (Subject Name Identifier → User UUID vs Login Name, per `docs/developers/operations/ias-setup.md:135-153`) to emit the legacy SAP-ID value in a claim the platform reads — i.e. is claim-shape *continuity* achievable by IAS config alone, or does `resolveUserSapId` need a new mapping branch?

---

## Section 3 — Author email lookup

**Risk rating: MEDIUM (LOW for the MCP-only hybrid POC; MEDIUM–HIGH if the main services move to IAS).**

### What author/ownership resolution keys on (quoted, cited)
Two distinct mechanisms:

**(a) Request-time "my tutorials" ownership** keys on `Users.uuid` (a generated GUID column, NOT the PK, NOT `sapId`), resolved via the `sapId` chain:
- `srv/author-service.js:48` — `const dbUser = await resolveDbUser(user, ['uuid']);` then `.where({ userId: dbUser.uuid })`.
- The `MyTutorialsRaw` view's four priority join tiers (`db/views.cds:233-284`):
  - Priority 1/2: FK — `on u.ID = t.author.ID` (`:238`) / `on u.ID = c.user.ID` (`:247`).
  - **Priority 3: `on u.email = m.ownerEmail`** (`:258-266`, guarded `trim(coalesce(m.ownerEmail,'')) <> ''`).
  - **Priority 4: `on m.owner = u.email OR m.owner = u.firstName||' '||u.lastName`** (`:275-283`).

**(b) Strict authorship at publish time** (`Tutorials.author_ID`) keys on **GitHub login first, then contributor email** (`packages/core/resolve-tutorial-author.js`):
- Phase 0 (wins): frontmatter `author_profile` → `Users.githubLogin` (`:114-119`).
- Phase A/B: contributor **email** via `emailToUserId` map `LOWER(TRIM(email))→Users.ID` (`:85-103,133-163`).
- The `ownerEmail` fallback was **removed** (#862): "TutorialMeta.ownerEmail is a *monitoring* signal … not an authorship signal" (`:165-179`). `githubLogin` is "canonical … for Tutorials.author resolution at publish time (#777)" (`db/schema.cds:175-180`).

`initiator` (ContentManifest / PipelineLog) is **NOT an auth identity** — it's an OS `username@hostname` attribution string (`scripts/publish-content.ts:684-688`; read from header `x-initiator` in `packages/content/content-store.js:453`; written `packages/content/content-publish-session.js:106`). The only auth-derived initiator is `mcp:${req.user?.id}` when driven via the MCP admin tool (`srv/lib/mcp-admin-tools.js:109`) — under IAS, `req.user.id` would change shape (§2), altering that attribution string but not breaking anything functional.

### IAS impact
- Author **email** and **githubLogin** keys are **stable, IdP-independent** — an author's email address and GitHub login do not change because the IdP that issued the login token changed. So publish-time author resolution and the email/name tiers (3/4) are **not directly broken** by IAS.
- **BUT** these tiers only resolve a match if the author's `Users.email` / `Users.firstName+lastName` are populated — and those are populated by the **§2 backfill**, which runs keyed on `sapId`. If §2 mis-keys (mints a new row), the author's email/name backfill lands on the *new* row while the tutorial's `ownerEmail`/`owner` may still match the *old* row, or neither — a second-order duplication/mismatch risk. Tier 1/2 (FK to `Users.ID`) is fine; tiers 3/4 (email/name) inherit §2's correctness.

**Impact assessment:** The author lookup itself is **IdP-agnostic (LOW)**; it becomes **MEDIUM** only through its dependence on §2's `sapId`-keyed backfill populating the right row. No standalone author-lookup breakage from IAS.

**OPEN QUESTIONS:**
- **OQ-3.1** After an IAS login, does the author's `Users.email` get backfilled onto the *same* row that `ownerEmail`/`owner` tiers match, or (if §2 mis-keys) a new row — producing an author who "owns zero tutorials" despite matching by email? (Directly downstream of OQ-2.1.)

---

## Section 4 — User provisioning + migration

**Risk rating: HIGH (for a full migration of existing users); LOW for the MCP-only hybrid POC.**

### How users are created today
No separate registration entity — a uniform SELECT-by-`sapId`-then-INSERT get-or-create, minted from JWT claims on first authenticated call:
- Canonical: `provisionDbUser` (`packages/core/resolve-db-user.js:220-276`) — mints `ID` (cuid PK, default), a fresh `uuid` (String(36), because `user.id`=email overflows — `:251`, #1614), `sapId` (from the JWT), `legacyId` (sequence), and NULL-or-claim email/first/last.
- Inline copies: `srv/petoberfest-service.js:11-19`, `srv/puzzle-service.js:87-95`, `srv/developer-service.js:539`.
- Fire-and-forget on `/auth/user` (every page load): `srv/server.js:1962`.

### DB keying (the facts that matter for orphaning)
`db/schema.cds:157-188`, `entity Users : cuid, managed, LegacyKeyed`:
- **Primary key = `ID`** (a cuid UUID from the `cuid` aspect) — NOT `sapId`, NOT `uuid`, NOT `legacyId`.
- Columns: `uuid : String(36) @mandatory` (IMS-internal GUID), `sapId : String(255)` (the P/S/I-number — the de-facto business key), `legacyId : Integer64`, `email`, `firstName`, `lastName`, `displayName`, `khorosId`, `githubLogin`.
- `@assert.unique.sapId` / `.khorosId` / `.githubLogin` (`:157`) — but per `packages/core/resolve-db-user.js:198-213`, `@assert.unique.sapId` is a **CAP app-service runtime check only**; direct `cds.db` INSERT bypasses it and **there is NO DB-level UNIQUE index on `Users.sapId` on HANA** (SQLite unit tests DO enforce it — `:264-274`). So nothing at the DB layer prevents duplicate-`sapId` rows under a mis-keyed migration.

Progress records = **`TaskRecords`** (`db/schema.cds:190-210`): `user : Association to Users @mandatory` → FK column **`user_ID` → `Users.ID`** (the cuid PK). Same FK pattern for `TutorialMonitors`, `PuzzleProgress`, `SessionFavorites`, `UserLearningPreferences`. So **all progress is anchored to `Users.ID`, reached via `sapId`**.

### The migrator
`scripts/migrate-from-hana.js` (Users step `:1268-1283`) copied **only** `ID` (deterministic `uuidv5('user', IMS_USER.ID)`), `UUID` (IMS GUID), `SAP_ID`, `legacyId`, and audit stamps — **NOT** firstName/lastName/email (those stay NULL, which is why §2's lazy backfill exists). TaskRecords step `:1345-1373` sets `USER_ID` via the same `uuidMap.users` — so FK integrity depends on `Users.ID` being stable, and lookups depend on `Users.sapId` matching the JWT.

### What #2506 says about SAP-ID→IAS migration
Per the task brief and the repo's own ias-setup guidance: **SAP-ID accounts do not auto-migrate to IAS**; population is via **SCIM / IPS / CSV**. `docs/developers/operations/ias-setup.md:135-153` (Subject Name Identifier) and `:216-218` ("User Gets New Identity (Progress Data Mismatch)") warn that if the IAS `sub` doesn't match what the legacy system produced, the user gets a new identity and progress mismatches. **Note:** the literal `#2506` string is **not present** in this worktree's docs/code (roles agent grep for `2506`, `289`, `near-empty` returned nothing) — its content is known only from the task brief and the parallel documented 2026-07-23 PROD incident (§5).

### IAS impact
This is the **same root risk as §2, viewed from the data side**: if the IAS identity id differs from the stored `sapId`, existing users' progress is orphaned (old `TaskRecords` FK to a row that new logins no longer resolve) and duplicate `Users` rows accrue, with **no DB-level guard** to collapse them on HANA. A full migration therefore requires either (a) IAS config that preserves the legacy SAP-ID value in a readable claim (OQ-2.3), or (b) a `resolveUserSapId` mapping branch + a `Users.sapId` reconciliation/dedup pass over 797k rows.

**Impact assessment: HIGH for a full user migration.** For the **MCP-only hybrid POC it is LOW** — the same humans still log into the browser via XSUAA (unchanged), MCP write tools forward to main-srv, and the hybrid keeps XSUAA tokens valid, so no existing progress row is re-keyed.

**OPEN QUESTIONS:**
- **OQ-4.1** (= OQ-2.1 restated for data) With real IAS tokens, do existing users resolve to their existing `Users` row, or does `provisionDbUser` mint duplicates? Measure duplicate-`sapId` count after N IAS logins of known-migrated users.
- **OQ-4.2** If a mapping is needed, what is the authoritative source to map IAS `sub` → legacy SAP-ID (SCIM `userName`? a custom attribute? IPS transformation)? Requires SCIM/IPS access, not resolvable from code.

---

## Section 5 — Role assignment

**Risk rating: MEDIUM (LOW for the MCP-only hybrid; MEDIUM for anything scope-gated).**

### How roles work today
- `xs-security.json` (root; byte-identical `.deploy/xs-security.json`, produced by `cp` at `.deploy/mta.yaml:71`) defines 13 scopes, 11 role-templates, 8 role-collections. MCP tier: scope `$XSAPPNAME.Tutorial.MCP` (`:51`), template `TutorialMCP` (`:144-150`), collection `Tutorials MCP Users` (`:214-221`). PROD uses a distinct descriptor `xs-security-prod.json` (`.deploy/mta.yaml:77`).
- **Role collections are assigned by (email as `ID`) + (IdP `origin`).** `docs/developers/operations/xsuaa-role-collection-assignment.md:25` — "add rows with `SAP IDP` origin and the user's e-mail as `ID`"; `:39` — "`<origin-id>` is typically `sap.default` for SAP IDP." CLI join key: `btp assign security/role-collection … --to-user user@sap.com --of-idp <origin-id>` (`:33-36`).
- Most user-facing services deliberately **avoid** scope-based auth: `srv/developer-service.cds:3` `@requires:'any'`, and `authentication.md:447-451` — because role collections are **NOT auto-assigned**, public services use `authenticated-user`/`any`. Scope-gated services: `AdminService` (`Admin`, `srv/admin-service.cds:18`), `AuthorService` (`Tutorial.Author`, `srv/author-service.cds:6`), `AnalyticsService`/`ExportsService` (`Admin`), `ConsolidationService` (`ConsolidationScope`), `DisplayService` (`DisplayApp`), `ScannerService` (`MobileApp`). MCP admin tools AND their scope on top of `Admin` (`srv/admin-service-mcp.cds:17,26,36,49,64`).

### Does an IAS origin change the email→role-collection mapping?
- Role-collection assignments are **bound to an IdP `origin`**. `docs/developers/operations/btp-role-migration.md:95` — "IDP origin is preserved verbatim… If that ever changes, add an origin-mapping step." The subaccount today has an active IAS trust at origin `sap.custom` (`atxgsg7zi.accounts.ondemand.com`) alongside the default SAP IDP origin. **Introducing IAS as the token issuer changes the `origin` on the assignment join** — a user assigned under `sap.default` would NOT automatically carry that assignment when authenticating under the IAS origin.
- **Prior PROD incident (the cited class):** `docs/developers/operations/author-admin-access.md:89-91` — "2026-07-23 PROD incident: `Tutorials Author (Prod)` was near-empty; same class of fix (assign the collections)." Root cause of empties: auto-grant removed post-#809 (`xsuaa-role-collection-assignment.md:3,56`). The task's "289 DEV vs 5 PROD" figure is the same *class* of near-empty-collection problem. **An origin change would re-introduce exactly this class**: assignments keyed to the old origin go dark under the new origin until re-assigned.
- **Also (CAP-doc):** **IAS tokens carry no scopes** ("JWT tokens issued by IAS service don't contain authorization information. In particular, no scopes are included." — CAP [IAS-based Authentication]). XSUAA scopes come from role collections baked into the XSUAA token. Under a pure-IAS token, the `@requires:'Admin'`/`'DisplayApp'`/etc. scope checks would have **nothing to check** unless the hybrid re-derives scopes from a bound XSUAA instance (which the `xsuaa:true` fallback preserves for XSUAA-issued tokens, but an IAS-issued token still carries no XSUAA scopes). This is why an IAS migration of scope-gated services needs an explicit authorization story (e.g. AMS/IAS authorization policies, or keep XSUAA for scopes).

### IAS impact
- **MCP-only hybrid POC: LOW.** The `/mcp-auth/*` MCP developer tools are `@requires:'authenticated-user'` (`srv/developer-service-mcp.cds:14,...`) — **no scope/role-collection needed**, so an IAS token that merely authenticates is sufficient. The scope-gated `/mcp-admin/*` tier stays XSUAA.
- **Full migration: MEDIUM.** Scope-gated services (Admin/Author/Display/Mobile/Consolidation) depend on XSUAA scopes and origin-bound role-collection assignments. An IAS origin invalidates the assignment join and IAS tokens carry no scopes — both must be solved (re-assign under the IAS origin AND/OR keep XSUAA in the hybrid to supply scopes for XSUAA-issued tokens, plus define an authorization model for IAS-issued tokens).

**OPEN QUESTIONS:**
- **OQ-5.1** Under the hybrid, does an IAS-issued token reach a scope-gated service (`@requires:'Admin'`) with the required scope, or does it 403 because IAS tokens carry no scopes? (Confirm whether scope enforcement needs AMS/IAS authorization policies.)
- **OQ-5.2** For role-collection assignments, does the IAS origin require re-assigning all admin/author/display users under the new `--of-idp` origin (reintroducing the 2026-07-23 near-empty class), or can an origin-mapping/shared-trust config preserve them?

---

## Section 6 — SAP Community / Badges / NGDS outbound interface

**Risk rating: HIGH (functional break under a claim-shape change); blast radius bounded by PROD-gate + fail-closed.**

### The integration + the outbound identifier
- Code: `srv/lib/ngds-client.js` (payload build + POST), `srv/lib/ngds-autosend.js` (trigger + gates), `srv/jobs/ngds-retry.js` (replay), manual resend `srv/admin-service.js:1850-1851`. Endpoint `POST https://api2.services.sap.com/ngds/developers/ims` (`srv/lib/ngds-client.js:26`).
- **Outbound user identifier = `context.user_id` = `Users.sapId`** (`srv/lib/ngds-client.js:206-208`):
  ```js
  return buildNgdsPayload({
      // Legacy context.user_id = SCI uid; CAP's equivalent is Users.sapId.
      userId: user?.sapId || user?.uuid,
  ```
  The `Users` row is read by `user_ID` (`:189-191`) and `context.user_id` set at `:77-80`. Field contract `:59`: "`f.userId  SCI/IAS uid → context.user_id (CAP: Users.sapId)`."
- **`Users.sapId` originates from the inbound JWT `user_uuid`** (the §2 chain). So the **same value is the DB key AND the wire key** — one identifier, inbound and outbound.
- **Hard identity gate** (`srv/lib/ngds-autosend.js:40,177-213`):
  ```js
  const CANONICAL_SAP_ID = /^[PSIps]\d{6,}$/;   // must be a P-/S-/I-number
  ```
  `hasResolvableIdentity` reads only `Users.sapId` and **suppresses the send** unless it matches this regex (rationale `:32-39`: NGDS needs an SCI/IAS uid to resolve a universal id downstream, else "Cannot find universal id"). Non-matching → counted `ngds.autosend.skipped.no_identity`, **no error surfaced**.
- **No Credly/Acclaim.** "Badges" = the NGDS feed itself (`srv/jobs/ngds-retry.js:20`). SAP Community (Khoros) is **inbound-lookup only** — `setKhorosLink` resolves a user-supplied handle and stores `khorosId` on the row (`srv/developer-service.js:1058-1117`); it sends NO SAP identity outbound. There is **no mapping layer** translating the inbound identity to a separate SAP universal id — the raw `sapId` is sent and NGDS resolves it downstream.

### Gating / blast radius (confirmed)
Double gate in `srv/lib/ngds-autosend.js`: env gate requires CF `space_name`==='prod' (`:117-121`, via `srv/lib/deploy-environment.js:39-40` — the only non-spoofable signal since DEV+PROD share one XSUAA tenant) AND DB kill-switch `ngds.autosend.enabled === 'true'` (`:61-79`, **fails CLOSED** on read error, defaults OFF). Edge-only (fires on transition→COMPLETED, `:142-144`), allowlisted TUTORIAL/GROUP/MISSION (`:46,146`), never throws into the completion tx (`:141,189-192`; failures queue in `NGDSFailedMessages`).

### IAS impact
This is the sharpest functional break: if IAS changes the identity claim value (IAS UUID / SCIM id / email instead of the P/S/I-number), then (1) `resolveUserSapId` resolves a non-canonical value → new logins fail to match existing rows (§2), and critically (2) **even where a row is found, the `CANONICAL_SAP_ID` regex gate silently suppresses every outbound NGDS/community/badge send** — no error, just a `skipped.no_identity` counter. Badge/achievement crediting to SAP Community would **silently stop** for IAS-authenticated users. Because there's no id-mapping layer, this is a breaking change unless the P/S/I-number continues to arrive in a readable claim, OR a mapping is introduced at `resolveUserSapId` and the regex gate revisited.

**Impact assessment: HIGH functional risk.** Blast radius is **bounded**: PROD-only, DB-gated (default OFF), fail-closed, never rolls back a completion. So it cannot corrupt data or 500 a user — it **silently drops badge crediting**, which is a serious but non-catastrophic, reversible-once-detected failure. For the **MCP-only hybrid POC this does not fire at all** (MCP write tools forward to main-srv where the human's XSUAA `sapId` is still resolved; NGDS is PROD-gated and unaffected by a DEV MCP POC).

**OPEN QUESTIONS:**
- **OQ-6.1** (= OQ-2.1 for the wire) Under IAS, does `Users.sapId` still hold a `^[PSIps]\d{6,}$` value? If not, the NGDS gate silently suppresses all sends. Measure the `ngds.autosend.skipped.no_identity` counter with IAS-sourced identities in a non-prod probe.
- **OQ-6.2** If IAS ids are non-canonical, is there an authoritative IAS→SAP-universal-id/P-number mapping NGDS will accept, or must the platform introduce a translation before the outbound call?

---

## Consolidated OPEN QUESTIONS — only a POC (real IAS tokens) can answer

1. **OQ-2.1 / 4.1 / 6.1 (THE red/green light).** For a real IAS-issued token for a known SAP Universal ID user, what does `resolveUserSapId(req.user)` return — the same P/S/I-number as the XSUAA `user_uuid`, or an IAS UUID / email? (Decides orphaning, duplication, author-email tiers, AND the NGDS `CANONICAL_SAP_ID` gate — one measurement gates §2, §4, §6.)
2. **OQ-2.2.** What are `req.user.id`, `req.user.attr.{email,given_name,family_name,givenName,familyName}` under IAS? (Confirms backfill/`emailFromUser` still fill the right fields.)
3. **OQ-2.3 / 4.2.** Can IAS config (Subject Name Identifier; SCIM/IPS attribute mapping) emit the legacy SAP-ID in a readable claim, achieving claim continuity without code changes — or is a `resolveUserSapId` mapping branch + a 797k-row dedup/reconcile required?
4. **OQ-1.1.** Does `kind:'ias', xsuaa:true` validate BOTH a real IAS token and the existing XSUAA `mcp-remote` bearer on the same `srv-mcp` route in a deployed CF space?
5. **OQ-1.2.** Does the IAS `application` plan require the `cert.*` mTLS route + `X509_GENERATED` binding, and does the approuter `authenticationType:"none"` passthrough survive IAS x5t/proof-of-possession validation?
6. **OQ-1.3.** Can IAS's native OIDC discovery replace the approuter self-issuer workaround (`well-known-oauth.js:122-132`)?
7. **OQ-5.1.** Under the hybrid, does an IAS-issued token pass a `@requires:'Admin'`-style scope check, or 403 because IAS tokens carry no scopes (needs AMS/IAS authorization policy or XSUAA-for-scopes)?
8. **OQ-5.2.** Does the IAS origin force re-assigning all scope-gated users under the new `--of-idp` origin (reintroducing the 2026-07-23 near-empty class), or can origin-mapping/shared-trust preserve assignments?
9. **Doc-drift flag (not a POC question, but decision-relevant).** Repo docs disagree on the current IdP: `authentication.md:389-408` says default SAP ID Service; `btp-role-migration.md:79,95` assumes a trusted "SAP IAS tenant" origin. Confirm the real current trust before designing the migration.

---

## Recommended Minimal POC Scope

**Green-light a hybrid, MCP-only POC in a non-prod (DEV) space. Do NOT touch `tutorials-srv` (browser services) or PROD.**

### What to stand up
1. Create + bind ONE `identity` service instance to `srv-mcp` only (via `cds add ias`-style resource in `mta.yaml`), keeping the existing `tutorials-xsuaa` binding. (§1)
2. Register an IAS OIDC **public/PKCE** app with redirect URIs mirroring the current XSUAA MCP allowlist.
3. Flip `srv-mcp/package.json` auth to `{ "kind": "ias", "xsuaa": true }` (hybrid). (§1)
4. Repoint `approuter/lib/well-known-oauth.js` discovery to IAS endpoints (test whether the self-issuer workaround can be dropped). (§1, OQ-1.3)
5. Leave `/mcp-admin/*` (scope-gated) and all browser routes on XSUAA untouched.

### What to measure (each maps to a red/green criterion)
- **M1 (RED/GREEN).** Decode a real IAS token for a known-migrated user via `srv-mcp`; log `resolveUserSapId`, `req.user.id`, `req.user.attr.*`. Diff `sapId` against the same human's XSUAA `user_uuid`. (OQ-2.1)
- **M2.** Run an MCP write tool (e.g. `complete_step`) under the IAS token; confirm it resolves the **existing** `Users` row (no duplicate minted) and writes `TaskRecords` under the correct `Users.ID`. Query `SELECT sapId, count(*) FROM Users GROUP BY sapId HAVING count(*)>1` before/after. (OQ-4.1)
- **M3.** Confirm the hybrid still validates the existing XSUAA `mcp-remote` bearer on the same route (no regression for current users). (OQ-1.1)
- **M4.** In a non-prod probe, feed an IAS-sourced identity to the NGDS `hasResolvableIdentity` gate; confirm whether `Users.sapId` still matches `^[PSIps]\d{6,}$` (i.e., whether badge sends would survive). NGDS stays PROD-gated/OFF — this is a unit/probe, not a live send. (OQ-6.1)
- **M5.** Verify mTLS/`cert.*` + x5t/proof-of-possession behavior end-to-end through the approuter passthrough. (OQ-1.2)
- **M6.** Confirm branded IAS login page renders (satisfies #2506's driver #2).

### Green-light criteria (proceed to plan a broader migration)
- **M1 GREEN:** IAS token resolves the **same** `sapId` (P/S/I-number) as XSUAA — either natively or via achievable IAS Subject-Name-Identifier config.
- **M2 GREEN:** zero duplicate-`sapId` rows after IAS logins; progress writes hit the existing row.
- **M3, M4, M5, M6 GREEN:** hybrid preserves XSUAA clients; NGDS gate would still pass; mTLS works; branded login renders.

### Red-light criteria (do NOT proceed to a full migration without a mapping + dedup plan)
- **M1 RED:** IAS resolves a different id (IAS UUID/email) that cannot be configured back to the SAP-ID. This means a full migration requires a `resolveUserSapId` mapping branch, a `Users.sapId` reconciliation over ~797k rows, a `Users.sapId` UNIQUE-index hardening on HANA, and a revisit of the NGDS `CANONICAL_SAP_ID` gate — a substantial project, NOT a config flip.
- **M2 RED:** duplicate rows minted → confirms the orphaning risk is live.

**Bottom line:** The MCP-only hybrid POC is cheap, isolated, and reversible (rollback = flip `srv-mcp` auth back to `xsuaa`, per the ias-setup rollback note `docs/developers/operations/ias-setup.md:230-234`). It directly delivers the two drivers (public PKCE + branded login) for the MCP surface while quarantining the HIGH-risk identity questions (§2/§4/§6) behind a single measurement (M1) that the POC exists to answer. **Do the POC. Gate the full migration on M1/M2.**

---

## Source Index

**Codebase (all under `D:\projects\tutorials-poc\.claude\worktrees\mcp-xsuaa-public-client`):**
- `packages/core/resolve-db-user.js` — `resolveUserSapId`/`emailFromUser`/`backfillUserProfile`/`provisionDbUser` (identity crux). Shim: `srv/lib/resolve-db-user.js`.
- `packages/core/resolve-tutorial-author.js` — publish-time author resolution (githubLogin→email).
- `srv/author-service.js`, `db/views.cds:233-284` — ownership tiers.
- `db/schema.cds:157-210` — Users (PK=`ID`, key=`sapId`) + TaskRecords (`user_ID`→`Users.ID`).
- `scripts/migrate-from-hana.js:1268-1283,1345-1373` — migrator mapping.
- `srv/lib/ngds-client.js:59,77-80,189-208`, `srv/lib/ngds-autosend.js:40,117-121,177-213`, `srv/jobs/ngds-retry.js` — NGDS outbound (`context.user_id=Users.sapId`, `CANONICAL_SAP_ID` gate).
- `srv-mcp/package.json:20,28-30`, `mta.yaml:6,32-34,54-62,63,79-82`, `.deploy/mta.yaml:310-316,460-466` — MCP module + auth binding.
- `approuter/xs-app.json:554-581`, `approuter/lib/well-known-oauth.js:122-157` — routes + OAuth discovery.
- `xs-security.json:5-238` — scopes/templates/collections.
- `docs/developers/architecture/authentication.md:54-72,147,447-451,668-673` — claim structure, no-auto-assign, "If You Migrate to IAS" (Option A).
- `docs/developers/operations/ias-setup.md:9-32,135-153,216-234` — Option A vs B, Subject Name Identifier, rollback.
- `docs/developers/operations/{xsuaa-role-collection-assignment,btp-role-migration,author-admin-access}.md` — origin-keyed assignment; 2026-07-23 near-empty PROD incident.
- `docs/superpowers/specs/2026-07-08-mcp-server-phase2-design.md:27,136-145`, `2026-09-27-mcp-auth-multi-package-split-design.md:7-22`, `docs/end-users/mcp-quickstart.md:261-282` — XSUAA public-client limits (empirical).

**Authoritative SAP docs:**
- SAP CAP — [Authentication (Node.js)](https://cap.cloud.sap/docs/node.js/authentication) — IAS strategy, `cds.User.id`, IAS tokens carry no scopes, Node `ias-auth.js` impl, x5t/proofToken validation.
- SAP CAP — [Security / Authentication guide](https://cap.cloud.sap/docs/guides/security/authentication) — hybrid (bind both instance types), `cds add ias` generated MTA (identity/application/X509_GENERATED/cert route), XSUAA Fallback (`auth:'ias', xsuaa:true`), hybrid testing (`cds bind -2 <ias>`).
- SAP Help — [Establish Trust between XSUAA and Identity Authentication](https://help.sap.com/docs/btp/sap-business-technology-platform/establish-trust-and-federation-between-uaa-and-identity-authentication).
- SAP Help — [IAS Subject Name Identifier](https://help.sap.com/docs/identity-authentication/identity-authentication/configure-subject-name-identifier) (JS-rendered; not machine-fetchable here — flagged in OQ-2.3).
