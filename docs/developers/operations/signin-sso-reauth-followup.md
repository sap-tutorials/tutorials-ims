# Follow-up: force IdP re-selection on /signin over an existing IAS SSO session

**Status:** known limitation, shipped 1.34.0 (GitHub-login + RPT `/signin`). Not a regression — login works correctly for logged-out/fresh users. This only affects **switching providers mid-session**.

## Symptom
On `/signin`, clicking a provider button (e.g. LinkedIn) when the user already has an
active IAS SSO session silently logs them in with the **existing** session's IdP instead
of the chosen one. The `sap_idp=sap.custom,<Name>` chain correctly selects the IdP only
when there is no session to reuse.

## Root cause (investigated 2026-10-03)
Fixing this requires OIDC `prompt=login` (force re-authentication) on the IAS
`/oauth2/authorize` request. **The approuter cannot send it:**

- `@sap/approuter` v23.3.0 builds the authorize URL in
  `lib/passport/oauth2.js:getCodeAuthorizationUrl` (lines 27-70) from a **closed** query set
  (`response_type`, `client_id`, `redirect_uri`, `idp`, `scope`, `state`, `code_challenge`).
  There is **no** `prompt`/`max_age` field and **no** passthrough for arbitrary inbound
  params. Only `sap_idp` is consumed (-> `idp`). Confirmed: zero `prompt`/`max_age` matches
  in the whole package.
- XSUAA (`xs-security.json`) has no per-request force-reauth / `prompt` config.
- **Hand-rolling the authorize URL in an approuter middleware is NOT safe here**: this app
  runs with state protection AND PKCE both ON by default (`env-config.js:243` + `:269-270`,
  neither overridden). The approuter's `/login/callback` strictly validates a server-side
  cached `state` + PKCE `code_verifier` (`oauth2-strategy.js:118-145`, `:249-260`) that a
  hand-rolled redirect can't populate -> the callback would 401. It would only work by
  disabling those protections app-wide — an unacceptable security downgrade.

## The fix (IAS-side, admin console — tenant atxgsg7zi)
Force re-auth **scoped to the deliberate corporate-IdP clicks**, without breaking the
seamless returning-visitor path (`header.html maybeAutoLogin`, which must stay silent).

**Preferred — Conditional Authentication rule (scalpel):** add an IAS Conditional
Authentication rule that forces re-authentication only when a specific corporate `idp`
(GitHub / Google / Hugging Face / LinkedIn) is requested, leaving the default/SAP-ID path
seamless. (SAP KBA 3195136 conditional auth; combinable with forced auth.)

**Fallback — dedicated IAS application:** point the provider-button flow at a separate IAS
OIDC application that has "Force user authentication for every application access" ON
(SAP KBA 3487096), keeping the existing app (used by `maybeAutoLogin`) with it OFF. More
moving parts; the only repo change would be pointing those `/login?sap_idp=...` buttons at
the route/client bound to that app.

**Load-bearing caveat:** the plain per-application "force authentication" toggle is
all-or-nothing for that app — without the Conditional-Auth rule OR a separate app it would
also force re-auth on the silent returning-visitor flow, breaking "seamless". The scoping
is the real work, not flipping the toggle.

## Scope / effort
- IAS-admin-console change on tenant `atxgsg7zi`; **no approuter/CAP code change** required
  for the Conditional-Auth path (the `sap_idp` chain already selects the IdP).
- Needs the IAS administrator. Verify the Conditional-Auth rule can key on the requested
  `idp` before committing to the scalpel vs. the separate-app fallback.

## Current wiring (reference)
- Buttons: `hugo/layouts/signin.html` — `<a href="/login?sap_idp=sap.custom,<Name>">`
  (SAP ID = `sap.default`).
- Seamless auto-login (must stay silent): `hugo/layouts/partials/header.html`
  `maybeAutoLogin()` -> `/login?returnTo=...`; deliberate profile-click -> `/signin`.
