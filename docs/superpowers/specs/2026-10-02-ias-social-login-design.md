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

## Section 3.5 — Styling (user requirement)

The sign-in landing page must **match the site theme** — light/dark mode and our styles — the same way the **error pages** do. It should evoke the SAP Universal ID experience but rendered in our skin (not a raw SAP/IAS screen; that screen appears only *after* the user picks the Universal ID button and is handed to IAS).

**Author it as a Hugo layout, NOT a hand-written approuter static file.** The error pages (403/404/500…) are Hugo-generated and copied into `approuter/static/` at build (`mta.yaml:98` `cp -r hugo/public/. approuter/static/`). A Hugo-sourced page inherits theming, build, and deploy automatically; a hand-edited `approuter/static/*.html` would be overwritten by the build (and is exactly the "ships dead / not deployed" trap in CLAUDE.md).

Recipe (verified 2026-10-02):
- **Clone** `hugo/layouts/403.html` — the closest auth-context analog (uses `fd-button`, `/logout`, `<ui5-illustrated-message>`). It's just a `{{ define "main" }}…{{ end }}` block; `<head>`, shellbar, footer, CSS links, and the theme script all come from `hugo/layouts/_default/baseof.html` + `partials/head.html`.
- **Site CSS:** inherited via the shared head `<link>` chain (`fundamental-styles-icon`, `sap-theme-vars`, `sap-horizon-dark`, `chroma-light/dark`, `sap-fundamental`, `ui5-overrides`). Page-specific `<style>` uses `fd-*` classes + `var(--sap*)` tokens (`--sapBackgroundColor`, `--sapTextColor`, `--sapTile_Background`).
- **Light/dark:** inherited for free from `head.html` pre-paint script — reads localStorage key **`theme`** (`"dark"`/`"light"`), falls back to `prefers-color-scheme`, sets `<html data-theme>` + `.dark` before first paint (no flash). Consistent cold or from an already-themed session. Toggle via the shared shellbar `[data-action="toggle-theme"]`.
- **Logo/brand:** `/img/sap-logo.svg`, favicons `/favicon.svg` / `/favicon.ico` (root-absolute, served after the static copy).
- **Buttons:** two `fd-button`s styled as site primary/secondary (`fd-button--emphasized` for the primary). The IAS/Universal ID button on-brand but visually distinct. Each is a link to the pinned `?sap_idp=` entry (Section 2).
- **Ships via:** `build:hugo` → `hugo/public/` → `mta.yaml:98` copy → `mbt build`/`npm run deploy`. No manual copy into `approuter/static/`.

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

## Decisions (resolved 2026-10-02)

1. **Gate scope:** per-route `dynamicIdentityProvider` on the sign-in route only — minimal blast radius; other routes' login behavior unchanged. *(recommended, accepted)*
2. **Entry point:** add a NEW `/signin` page; leave the existing `/login` → `/login-redirect.html` route in place as the callback-side plumbing. The two buttons live on `/signin`.
3. **Label:** "Sign in with SAP Universal ID" for the IAS button, "Sign in with SAP" for the default. *(wording confirmable at implementation; not blocking)*
4. **Default unauthenticated behavior:** force unauthenticated entry to `/signin` so XSUAA's raw chooser is never reachable by normal navigation — the true "no chooser ever" guarantee. Regression-test the default path (Section 5 #2) to ensure already-authenticated sessions are not bounced through `/signin`.
5. **Styling:** Hugo-sourced sign-in layout cloned from `hugo/layouts/403.html`, inheriting site CSS + light/dark (localStorage `theme` key) + logo + build copy — per Section 3.5. *(user requirement, accepted)*

## Open question — needs user confirm

- **Tenant drift (Q5):** a recalled note mentions a later swap to IAS tenant `alzmza7li`; live `btp list security/trust` shows `atxgsg7zi` as the active `sap.custom`. Spec/plan use the **live** value `atxgsg7zi`/`sap.custom`. Confirm no pending re-trust to `alzmza7li` before implementation, or the `sap_idp` origin key stays `sap.custom` regardless of tenant (origin key is stable across tenant swap unless the trust was re-created with a new key).
