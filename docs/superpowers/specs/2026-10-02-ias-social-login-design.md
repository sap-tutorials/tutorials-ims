# IAS Social Login — additive, no IdP chooser (#2506)

**Date:** 2026-10-02
**Issue:** [#2506](https://github.com/sap-tutorials/tutorials-ims/issues/2506) — continue IAS usage: enable social login on the IAS infrastructure without breaking the existing default IdP login.
**Status:** Design — pending user review.
**Depends on:** #2552 identity-linkage layer (`(issuer, subject)` resolver) — **already merged + in PROD** (Release 1.33.0, 2026-10-01).

## Goal

Let a developer sign in with a **social provider** (Google etc., surfaced inside IAS) while the existing **SAP ID Service** login keeps working exactly as today, and **neither path shows an IdP selection screen**. Social-authenticated users resolve to the **same `user_uuid`** as their SAP ID login (merge by email), so progress/completions carry across.

## What is already in place (verified 2026-10-02)

This feature is mostly *configuration that already exists*; the code change is small.

1. **Subaccount trusts two OIDC IdPs** (live `btp list security/trust`, Tutorial System subaccount `3c6fa3f1-…`):

   | IdP | originKey | protocol | status |
   |---|---|---|---|
   | SAP ID Service (default) | `sap.default` | OpenID Connect | active |
   | IAS tenant `atxgsg7zi` (business users) | `sap.custom` | OpenID Connect | active |

2. **Social providers are enabled inside the IAS tenant** and verified visible on the IAS login page (user-confirmed 2026-10-02). Enabling/adding social providers is an IAS admin-console action — no app change.

3. **XSUAA federation re-issues its own token.** The main app binds only `tutorials-xsuaa`. When a user picks `sap.custom`, XSUAA federates to IAS, then re-issues an **XSUAA** token to the app. The main CAP `srv` therefore needs **no** `auth:{kind:ias}` change — it already accepts the token for both IdPs. User-confirmed: logging in via *either* IdP reached real authenticated app pages.

4. **Identity merge is already deployed.** `packages/core/resolve-db-user.js` (#2552) resolves `(iss, sub)` across providers (Tier 1), self-heals by canonical sapId (Tier 2), and matches trusted token-email → `Users.email` (Tier 3), merging SAP-ID and IAS/social logins onto one `Users` row. `providerFromIssuer` already maps `*.accounts.ondemand.com → 'ias'`. **No resolver change needed.**

5. **approuter supports IdP pinning.** Installed `@sap/approuter` **v16.9.0** honors the `sap_idp=<originKey>` query param (translated to XSUAA `login_hint={"origin":"<originKey>"}`), **gated by `dynamicIdentityProvider`** — currently **off**.

## The gap (what this build actually does)

Two things, both small:

1. **Turn on IdP pinning** — enable `dynamicIdentityProvider` so `sap_idp` is honored. Without it, `sap_idp` is silently ignored (`path-rewriter.js:136`).
2. **A two-button sign-in landing page** — app-controlled HTML with two pinned entries so users never see XSUAA's raw chooser:
   - **[Sign in with SAP]** → `…?sap_idp=sap.default` → SAP ID Service (today's path).
   - **[Sign in with SAP Universal ID]** → `…?sap_idp=sap.custom` → IAS page (social + IAS-local).

   The button label is **not** "Sign in with Google" — our page names the SAP Universal ID / IAS entry; the social provider buttons live *inside* IAS. This keeps the page provider-agnostic (add more social IdPs in IAS with no page change).

## Section 1 — Architecture

```
                 ┌───────────────────────────────────────┐
   GET /signin   │  App landing page (approuter static)   │
  ──────────────▶│  [ Sign in with SAP ]                  │
                 │  [ Sign in with SAP Universal ID ]     │
                 └──────┬──────────────────────┬──────────┘
      sap_idp=sap.default                      sap_idp=sap.custom
                        ▼                       ▼
                 approuter /login (xsuaa, dynamicIdentityProvider:true)
                        │  login_hint={"origin":"sap.default"}  │ {"origin":"sap.custom"}
                        ▼                       ▼
                     XSUAA ───────────────► federates to IdP
                        │ SAP ID Service        │ IAS atxgsg7zi (social + local)
                        └──────────┬────────────┘
                       XSUAA re-issues its OWN token (both branches)
                                   ▼
                           main approuter + main srv (unchanged)
                                   ▼
                 (iss,sub) resolver merges by email → one user_uuid
```

- Main approuter login binding (`tutorials-xsuaa`) **unchanged** — no second approuter, no custom OIDC code.
- Main srv auth **unchanged** — XSUAA token for both branches.
- No new service bindings. No MTA resource changes.

## Section 2 — The no-chooser mechanism

- `sap_idp=<originKey>` on an xsuaa-protected URL → approuter emits `login_hint={"origin":"<originKey>"}` on the XSUAA authorize request → XSUAA jumps straight to that IdP, no selection screen (`oauth2.js:31-42`, README v16.9.0 §Dynamic Identity Provider).
- **Gate:** `dynamicIdentityProvider` must be true, set either:
  - globally via approuter env `DYNAMIC_IDENTITY_PROVIDER: true` (standalone approuter → applies to all routes), **or**
  - per-route `"dynamicIdentityProvider": true` on the sign-in route(s) in `xs-app.json`.

  **Decision (recommended): per-route**, scoped to the sign-in entry route(s), not global — smallest blast radius; leaves all other routes' login behavior exactly as today. (Open for review — see Open Questions.)
- **Session caching:** once XSUAA issues the session cookie, the landing page is not seen again until logout/expiry — the "unobtrusive but powerful, seen once" UX.
- **Caveat — IdP switch needs logout first** (approuter README:932): a user already logged in via one IdP must hit `/logout` before the other `sap_idp` takes effect. The landing page / account menu must route IdP-switch through logout. This is the one real UX wrinkle.

## Section 3 — Identity continuity (already solved, just verified)

No code here — this section is a **verification obligation**, not a change.

- Social/IAS login via `sap.custom` → XSUAA token with IAS-derived `(iss, sub)`.
- First hit: resolver Tier-3 matches the trusted token email to the existing `Users.email` row (the user's SAP ID account), writes a `UserIdentities` link, returns that row → **same `user_uuid`**.
- Subsequent hits: Tier-1 `(iss, sub)` → O(1), no email dependency.
- Grounding risk (from #2552): `Users.email` is NULL on ~97.6% of PROD rows and backfills lazily on login. A social user whose SAP-ID row has **no email yet** will Tier-3-miss and get a **separate** `Users` row (separate `user_uuid`) until a later explicit account-merge. This is the known, accepted #2552 boundary — call it out in testing, do not try to re-solve it here.

## Section 4 — Scope

**In scope (code):**
1. `approuter/static/` sign-in landing page (two pinned buttons) + a route for it in `approuter/xs-app.json`.
2. Enable `dynamicIdentityProvider` (per-route) on the sign-in / login route(s) in `approuter/xs-app.json`.
3. IdP-switch-via-logout wiring on the landing page / account menu (handle README:932 caveat).
4. Optional: redirect unauthenticated entry to `/signin` instead of the default XSUAA chooser (so the chooser is never reachable by normal navigation).

**In scope (config / console, no code):**
5. Confirm IAS social providers enabled (done) + branding of the IAS login page is a separate follow-up (#2506 notes branding is deferred).

**Out of scope / unchanged:**
- Main srv auth config, identity resolver (`resolve-db-user.js`), XSUAA bindings, second approuter, MTA resources — all untouched.
- Cross-provider explicit account-merge UX (same human, SAP then social, when email was absent) — deferred per #2552.
- IAS login-page branding/custom domain — separate follow-up.

## Section 5 — Testing

1. **Both buttons, no chooser:** `/signin` → [SAP] lands on SAP ID Service directly; [SAP Universal ID] lands on IAS page directly; XSUAA selection screen never shown.
2. **Default path regression:** existing deep links / normal navigation for already-authenticated users behave exactly as today; a logged-in session is not forced back through `/signin`.
3. **Identity continuity (happy path):** a user with a populated `Users.email` logs in via social → resolves to the **same `user_uuid`** as their prior SAP ID login; progress visible.
4. **Identity boundary (known #2552 limit):** a user whose SAP-ID row has NULL email logs in via social → gets a separate row; documented, not a regression.
5. **IdP switch:** logged in as SAP, choose Universal ID → confirm logout-first flow works and does not 400/loop.
6. **Role-collection authorization:** an admin/author identity asserted via IAS still authorizes role-gated pages (role collections resolve by identity).
7. **DEV first**, then PROD — same trust config exists on the shared subaccount.

## Verification before calling done

- `dynamicIdentityProvider` actually honored on DEV (not silently ignored): confirm `sap_idp` produces a direct IdP jump, inspect the authorize URL carries `login_hint`.
- Admin-UI changes rule (CLAUDE.md): the landing page ships via the approuter static copy at `mbt build` — a FULL deploy, no `--skip-build`, no `-m` scoping; Step 3.5 bundle check applies.
- `cf target` before any push; deploy from fresh `origin/DEV`, never a feature branch.

## Open questions for review

1. **Gate scope:** per-route `dynamicIdentityProvider` on the sign-in route (recommended, minimal) vs. global `DYNAMIC_IDENTITY_PROVIDER` env (simpler, broader). Any route accepting `sap_idp` lets a crafted URL steer the IdP — per-route limits that surface.
2. **Entry point:** add a NEW `/signin` page, or convert the existing `/login` → `/login-redirect.html` route into the two-button page? (Existing route at `xs-app.json:116-121`.)
3. **Label:** "Sign in with SAP Universal ID" — confirm wording for the IAS button.
4. **Default unauthenticated behavior:** force all unauthenticated entry to `/signin` (never reach XSUAA's chooser), or only use `/signin` as an explicit opt-in link? Forcing it is the true "no chooser ever" guarantee but touches the default path more.
5. **Tenant drift:** a recalled note mentions a later swap to IAS tenant `alzmza7li`; live trust shows `atxgsg7zi` as the active `sap.custom`. Spec uses the live value. Confirm no pending re-trust.
