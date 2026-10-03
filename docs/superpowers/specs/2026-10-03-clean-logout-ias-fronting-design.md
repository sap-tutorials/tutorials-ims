# Clean Logout via IAS-fronted Approuter — Design

**Issue:** [#2610](https://github.com/sap-tutorials/tutorials-ims/issues/2610) — Clean logout on shared/event machines
**Date:** 2026-10-03
**Status:** Design — pending review
**Author:** Thomas Jung (with Claude)

## Problem

On shared event-floor machines, logging out does not fully clear the user. The approuter
`/logout` terminates the approuter + XSUAA session, but the **IAS session (tenant
`atxgsg7zi`) survives**, so the next person is silently re-SSO'd as the previous user.

**Verified root cause:** the approuter is bound to **XSUAA only**. On `/logout` it clears
its own session and redirects to `/`, hitting XSUAA `logout.do` — it **never reaches IAS**
(`atxgsg7zi.accounts.ondemand.com`). The IAS Remember-Me token is tenant-wide and
default-on, so the surviving IAS session re-authenticates the next visitor. XSUAA does not
perform federated single-logout to IAS.

## Goal

Make approuter 23.x's native OIDC RP-initiated logout (`end_session`) fire against IAS on
`/logout`, so the IAS session is terminated and the next person on a shared machine is not
silently re-SSO'd — **without** changing which identities users log in with and **without**
breaking the public-PKCE MCP flow.

Verified during design: the IAS logout endpoint the approuter will call is
`https://atxgsg7zi.accounts.ondemand.com/oauth2/logout` (from the live
`tutorials-identity` binding's `end_session_endpoint`).

## Non-goals

- **No change to the login UX.** The dual-IdP picker (`sap.default` = SAP Universal ID,
  `sap.custom` = social/other) stays exactly as today, including the `/signin` chooser page.
- **No change to which IAS tenant is used.** `atxgsg7zi` is the only tenant.
  (`alzmza7li` was a failed/abandoned setup attempt — ignore it. No Corporate-IdP
  federation to `accounts.sap.com`.)
- **No making IAS the single/forced login** (that was #2551 follow-up #1 — a separate
  concern). Force-authentication is explicitly unacceptable (users would revolt).
- **No change to the public-PKCE MCP flow** (`mcp-remote`). Hard constraint.

## Prerequisites (already satisfied on DEV)

- `@sap/approuter ^23.3.0` on `origin/DEV` (≥21 required for native `end_session`).
  **Gap:** `main` and the working tree still declare `^16.0.0`; the bump must reach `main`
  as part of this work (see Rollout step 6).
- `xs-app.json` already defines `login.callbackEndpoint: /login/callback` and
  `logout: { logoutEndpoint: "/logout", logoutPage: "/" }`.
- An `identity` service instance already exists in the DEV space (`tutorials-identity`),
  proving entitlement + broker work on this tenant.

## Architecture

The change is scoped to the **single `tutorials-approuter` module** in the main MTA
(`.deploy/mta.yaml`, module block ~230–446). There is **one** application router, always —
this design adds no second approuter app.

```
Browser ──/login?sap_idp=…──> approuter (bound XSUAA + IAS)
                                  │  authenticationType: ias  (explicit per route)
                                  ▼
                        IAS atxgsg7zi (interactive OIDC login)
                                  │  xsuaa-cross-consumption → XSUAA scopes/authz preserved
                                  ▼
                               CAP srv (XSUAA token, unchanged authz)

Browser ──/logout──> approuter → OIDC end_session →
                     https://atxgsg7zi.accounts.ondemand.com/oauth2/logout
                     → IAS session terminated → post-logout redirect
```

### The core mechanism

Bind the `identity` service to the approuter alongside `tutorials-xsuaa`, keeping XSUAA for
authorization/scopes. With both bound and routes resolving to `ias`, the existing `/logout`
endpoint performs OIDC RP-initiated logout → IAS `end_session` → IAS session ends.

### Central design risk and its resolution

`.deploy/mta.yaml:362–371` documents a deliberate constraint: the approuter is bound to
**only** `tutorials-xsuaa` because, under the **16.x** approuter, binding a second auth
service made the login handshake pick a binding non-deterministically → 500s.

Under **23.3.0** this is resolved and dual-binding is supported. The `@sap/approuter`
23.3.0 README (`authenticationType` reference) states: when bound to both XSUAA and IAS,
the approuter *"prefers ias if both authentication services can be used … determined via
BTP security endpoint (may impact response time)."* Therefore:

- We set `authenticationType: ias` **explicitly** on each protected route rather than
  relying on auto-detection — this avoids the per-request BTP-security-endpoint probe
  latency.
- The stale "one binding only" comment at `mta.yaml:362–371` is replaced with the 23.x
  rationale.
- XSUAA `scope` arrays on routes still apply under `ias` auth when the approuter is bound
  to both (README `authenticationType` note).

## Identity instance strategy

**Decision (confirmed with Tom): two service instances.** The extra IAS service instance is
acceptable; it is strictly safer than sharing one client between two auth postures.

- The **existing `tutorials-identity`** instance stays **untouched**. It remains the
  public-PKCE client for `mcp-remote` (`public-client: true`, `credential-type: NONE`,
  `clientid 0b1e8b56-…`). The MCP flow is fully protected — **no client_id rotation, no doc
  churn**.
- A **new dedicated IAS instance** is created for the approuter's interactive login
  (confidential, X.509).

Why not share one instance: a single `identity` instance maps to one IAS OIDC app with one
`client_id`; a binding only selects credential posture (NONE vs X509) against that same
client. Whether one client can simultaneously allow public PKCE (secretless, for
mcp-remote) **and** X509 confidential auth (for the approuter) is uncertain, and probing it
would risk the live MCP client. Two instances sidesteps the question entirely.

### New instance: `tutorials-approuter-identity`

Created **out-of-band** (mirroring how `tutorials-identity` was created out-of-band for a
stable client_id), then **adopted** via `org.cloudfoundry.existing-service` in the main
MTA. Out-of-band creation means **no provisioning time is added to the main MTA deploy** —
adoption is just a bind. This matches the established pattern already used for
`tutorials-xsuaa`/`tutorials-hana` adoption in `mta-mcp.yaml`.

Instance `oauth2-configuration` (per approuter 23.3.0 README "Authentication with IAS"):

```jsonc
{
  "oauth2-configuration": {
    "redirect-uris":            ["https://*.cfapps.eu10-005.hana.ondemand.com/login/callback?authType=ias"],
    "post-logout-redirect-uris":["https://*.cfapps.eu10-005.hana.ondemand.com/**"]
    // prod cutover: add the real prod host (developers.sap.com/**) to both arrays
  },
  "xsuaa-cross-consumption": true   // keep XSUAA trust/authz while IAS fronts login
}
```

Binding to the approuter uses `credential-type: X509_GENERATED` (README: approuter→IAS auth
must use X.509 certificates).

> **Note on `redirect-uris` / `post-logout-redirect-uris`:** the exact production host
> (`developers.sap.com` vs the `*.cfapps…` route) must be enumerated to match the real
> login/logout callback origins. The main `xs-security.json` already lists both
> `developers.sap.com/login/callback` and the `*.cfapps.*.hana.ondemand.com/**` wildcard as
> XSUAA redirect-uris; the IAS instance must mirror the equivalents.

## Route authentication & the dual-IdP picker

### Routes

Set `authenticationType: ias` explicitly on the routes currently marked `xsuaa` in
`approuter/xs-app.json` (~40 routes). `authenticationType: none` routes (public content,
MCP `/mcp-auth/*`, build feeds, etc.) are **unchanged** — in particular the MCP public-PKCE
routes stay `none` and are untouched.

### Picker preserved via `sap_idp` + `dynamicIdentityProvider`

The picker (`hugo/layouts/signin.html`, rendered to `approuter/static/signin/index.html`)
today links:

- Button 1 "Sign in SAP Universal Account" → `/login?sap_idp=sap.default`
- Button 2 "Other Options including Social Login" → `/login?sap_idp=sap.custom`

The 23.3.0 README documents exactly this case: with XSUAA + IAS, a chain such as
`sap_idp=sap.custom,local` routes through the XSUAA trust configuration `sap.custom` and
then to IAS. We:

- Enable `dynamicIdentityProvider: true` on the `/login` route so the `sap_idp` query param
  is honored under IAS fronting.
- Keep both picker buttons; the `sap_idp` values are mapped to the IAS-aware equivalents so
  users still choose SAP Universal ID vs. social.

**Note (README):** after logging in with one IdP, switching to the other requires a logout
+ new login — which is exactly the behavior clean logout now provides correctly.

## Logout wiring

`xs-app.json` already has `logout: { logoutEndpoint: "/logout", logoutPage: "/" }`. Once
routes resolve to `ias`, `/logout` triggers approuter 23.x RP-initiated logout →
`end_session_endpoint` (`atxgsg7zi.../oauth2/logout`) → IAS session ends → redirect to the
instance's `post-logout-redirect-uris`.

- Add `backChannelLogoutEndpoint` to the `logout` object so IAS-initiated back-channel
  logout is also honored.
- The site chrome logout button (`hugo/layouts/partials/header.html:313`) already navigates
  to `/logout` — **no client-side change required**.

## Identity-continuity gate (hard PROD blocker)

Today users are keyed by XSUAA's `user_uuid`. `Users.sapId` (~798k rows) and the NGDS badge
gate (`^[PSIps]\d{6,}$`) depend on that key. #2551 follow-up #1 explicitly left this
unvalidated: **does an IAS-fronted interactive login resolve to the same user key the
current XSUAA path produces?**

- If **yes**, cutover is safe.
- If **no**, user progress/completions **fork** for the entire population. The spec then
  requires a UUID→user reconciliation step before any PROD cutover.

This MUST be validated empirically on DEV (one real user: compare the resolved user key
before vs. after IAS fronting) and is a **gate before PROD**, not an afterthought.

## Testing & verification

1. **DEV deploy** of the IAS-fronted approuter (new instance bound, routes `ias`,
   `dynamicIdentityProvider` on `/login`).
2. **Login works** via both picker buttons (SAP Universal ID and social).
3. **Logout clears the IAS session** — the core assertion. Simulate the shared-machine
   case: log in as user A, log out, confirm a fresh login prompt appears (not a silent
   re-SSO as A). Verify the network trace reaches `atxgsg7zi.../oauth2/logout`.
4. **MCP public-PKCE flow intact** — `mcp-remote` still obtains a token against the
   untouched `tutorials-identity` client.
5. **Identity-continuity check** (gate above).
6. **e2e:** extend `test/e2e/signin.spec.ts` with the logout-clears-session assertion
   (post-deploy, self-skips without `SMOKE_BASE_URL`).

## Rollout sequence

1. Create `tutorials-approuter-identity` out-of-band on DEV (`atxgsg7zi`), confidential/X509
   posture, with the `oauth2-configuration` above.
2. Adopt it as `existing-service` in `.deploy/mta.yaml`; add the `requires` entry to the
   `tutorials-approuter` module; replace the stale "one binding" comment.
3. Flip the ~40 `xsuaa` routes to `ias` in `approuter/xs-app.json`; add
   `dynamicIdentityProvider: true` on `/login`; add `backChannelLogoutEndpoint`.
4. Deploy to DEV; run the full test matrix incl. the identity-continuity gate.
5. **Shared DEV+PROD subaccount caveat:** DEV and PROD share the subaccount. Anything that
   surfaces on PROD must be done in a planned window (per #2551). Plan the PROD cutover
   accordingly.
6. Land the approuter `^16.0.0` → `^23.3.0` bump on `main` (currently DEV-only) so a
   from-`main` deploy carries the version that supports native `end_session`.
7. PROD cutover only after the identity-continuity gate passes on DEV.

## Files touched (implementation)

- `.deploy/mta.yaml` — new `identity` resource (existing-service) + `requires` on the
  approuter module; replace stale comment at ~362–371.
- `approuter/xs-app.json` — route `authenticationType` flips; `/login`
  `dynamicIdentityProvider`; `logout.backChannelLogoutEndpoint`.
- `approuter/package.json` — `@sap/approuter` `^16.0.0` → `^23.3.0` (align with DEV).
- `hugo/layouts/signin.html` — map `sap_idp` values to IAS-aware equivalents (picker
  preserved).
- `test/e2e/signin.spec.ts` — logout-clears-session assertion.
- Out-of-band: create `tutorials-approuter-identity` IAS instance (not an MTA-managed
  resource — created once, adopted).

## Open items for the implementation plan

- Enumerate the exact prod/dev callback + post-logout origins for the IAS instance's
  `redirect-uris` / `post-logout-redirect-uris`.
- Confirm the `sap_idp` value mapping that preserves both picker buttons under IAS fronting
  (DEV probe).
- Confirm route-scoped CSP behavior under 23.x (a `server.js:124` comment references 16.9.0
  behavior that may be stale).
