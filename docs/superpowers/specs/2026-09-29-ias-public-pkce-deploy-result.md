# IAS Public-PKCE MCP OAuth — Deploy Result & Stopping Point (2026-09-29)

## TOMORROW — start-here summary + guardrails (added at session end)
**Tom's decision:** something is fundamentally wrong with the IAS tenant; plan to **delete & recreate the IAS tenant** — but carefully, WITHOUT breaking production.

**⚠️ HARD SAFETY CONSTRAINTS for the tenant recreate (do NOT skip):**
- The IAS tenant `atxgsg7zi.accounts.ondemand.com` is **shared by PROD and DEV** (same subaccount `tutorial-system`, single subaccount = single IAS trust). Deleting/recreating it **breaks ALL production logins** (the auto-provisioned XSUAA↔SAP-ID trust every prod user depends on) until fully re-established. This is NOT a DEV-only action.
- Do NOT delete the tenant as a first step. First: (1) confirm with Tom whether a SEPARATE IAS tenant can be provisioned for DEV/MCP so PROD's tenant is never touched; (2) capture full current-state export/screenshots of the working trust before any destructive step; (3) identify a maintenance window + a prod-login smoke test to run immediately after.
- The auto-provisioned trust "just works when the subaccount is activated" (Tom) — so recreating may mean **re-activating/re-establishing the subaccount↔IAS trust**, which is a BTP-cockpit operation, not just IAS console. Verify the exact re-provisioning steps BEFORE deleting anything.

**Current DEV state left behind (needs revert during tomorrow's fresh start):**
- `tutorials-identity` CF instance (client `c6fd4896…`) still exists, **bound to the running `tutorials-srv-mcp`**. To remove: unbind from srv-mcp first (redeploy srv-mcp without the identity binding), then `cf delete-service tutorials-identity`.
- Deployed IAS wiring is LIVE on DEV: srv-mcp `auth:{kind:ias,xsuaa:true}` + approuter discovery `MCP_ISSUER_KIND=ias`/`XSUAA_MCP_URL=IAS`. Because `xsuaa:true` keeps the XSUAA fallback, existing paths still work — but to fully revert, restore `srv-mcp` auth to `xsuaa` and `dev.mtaext` discovery to XSUAA, then redeploy both MTAs (merged via PR #2544/#2545 — revert PRs needed).
- IAS console `tutorials-identity` child app (`4277f978…`): OIDC config was set to inherit-from-parent then localhost redirect URIs re-added; a spurious `.../login/callback` (throwaway approuter, now deleted) redirect URI remains — remove it.
- **Include scoping toggle on SAP ID Service IdP: REVERTED to ON (original) — verified. Production trust untouched.**
- Throwaway `ias-test-approuter` CF app: **DELETED.** Probe scripts + scratch: **DELETED.**

## KEY TESTED FINDING (why "something is wrong")
Every self-service lever was eliminated BY TEST: redirect_uri, app config, RequesterID/OIDC-inheritance, IAS session, approuter-vs-direct, AND `<Scoping>` (dropped via Include-scoping-off → SAML became bare Issuer-only → **SAP ID Service STILL returned 400**). ⇒ Even a minimal, correctly-signed SP-initiated SAML AuthnRequest from this tenant → `accounts.sap.com` is rejected. The failure is at the **tenant↔SAP-ID-Service SAML trust layer** (SAP-operated side; correlation IDs produce no IAS logs) — consistent with Tom's read that the tenant's trust is somehow broken. Recreating the tenant/trust is a reasonable next hypothesis, hence tomorrow's plan.

**Status:** Wiring deployed to DEV and verified for OAuth *mechanics*; federated login fails at the SAP-ID (accounts.sap.com) SAML step. Live IAS-console inspection done (read-only) — findings below are OBSERVED, not concluded.


## Live IAS console inspection (2026-09-29, read-only, Playwright as Tom's session) — OBSERVED FACTS
`tutorials-identity` (IAS app `4277f978…`) is a **Bundled CHILD** of the working parent "SAP BTP subaccount Tutorial System" (`173d6c00…`). Banner: "child application with inherited configuration … You can change the configuration and it won't affect the parent's."

**The failing request (decoded from the live authorize attempt):** browser hit `atxgsg7zi/oauth2/authorize` → IAS forwarded (SAML) to `accounts.sap.com/saml2/idp/sso` → **that page returned HTTP 400 "Identity Provider could not process the authentication request"** (correlation `728DACEE-…`, and earlier `2D058140-…` — both produce NO tenant-log entry). Decoded SAMLRequest: `<Issuer>https://atxgsg7zi.accounts.ondemand.com</Issuer>`, `<Scoping ProxyCount=1><RequesterID>eb9a31c6-6a65-44ad-b2e7-d3b482e67dec</RequesterID></Scoping>` (= the CHILD's OIDC-config ID).

**Child vs parent field comparison (observed; do NOT treat any single row as THE cause — multiple may be diverged):**
| Field | Child `tutorials-identity` | Parent | Inherited tag on child? |
|---|---|---|---|
| Protocol | OpenID Connect | OpenID Connect (parent shows OIDC-config `XSUAA_3c6fa3f1…`) | — |
| OIDC Config ID | `eb9a31c6…` | `XSUAA_3c6fa3f1…` | **NO inherited tag** |
| Client Auth clientid | `c6fd4896…` | `5bf33bd6…` | — (child-specific) |
| Redirect URIs | `localhost:*/oauth/callback` + `/mcp-callback` | (parent JWKS/XSUAA — not this shape) | child-specific |
| Grant types | Auth Code + **Enforce PKCE S256** + Refresh | — | on child OIDC-config |
| Subject Name Identifier | Email | Email | **Inherited** |
| Attributes | (mappings) | — | **Inherited** (tag) — verified, NOT diverged |
| Conditional Authentication | SAP ID Service | SAP ID Service | **NO inherited tag** |
| Identity Federation | Corporate IdP | Corporate IdP | **Inherited** |
| Configure Requests → Issuer name | `https://atxgsg7zi.accounts.ondemand.com`; Auth context = None | — | **Inherited** (tag) |
| Trust Corporate IdPs | "Allow logon with all configured corporate IdPs" = ON | — | — |

**Tom's correction (recorded):** the child DID inherit originally; the `cf create-service … -c {oauth2-configuration…}` I passed at creation **broke inheritance on the OIDC-config** (and possibly others — the two rows WITHOUT an "inherited" tag are OIDC Config and Conditional Authentication). Whether more than the OIDC-config diverged is NOT yet fully verified (Attributes detail + Client Authentication detail + Conditional-Auth detail not yet opened). Do NOT declare a single root cause.

**Still unchecked (to be complete):** child's Attributes detail (actual mappings), Client Authentication detail (public-client/secret/cert state), Conditional Authentication detail (rules), Certificates tab — each compared to parent.

## INSPECTION COMPLETE (2026-09-29) — verified findings
Finished reading every child sub-page (read-only). Results:
- **Client Authentication (child):** client `c6fd4896…`, **Public Client Flows = ON**, **NO secret, NO certificate**. Correct public client. NOT diverged in a harmful way.
- **Attributes (child):** **Inherited** — not diverged.
- **Trust Corporate IdPs (child):** "Allow logon with all configured corporate IdPs" = ON.
- **Configure Requests (child):** Issuer name = `https://atxgsg7zi.accounts.ondemand.com` (tenant), Auth Context = None. Inherited.
- **OIDC Configuration (child):** `eb9a31c6…` — **child-local, NOT inherited.** This is the ONLY load-bearing divergence.

**VERIFIED ROOT-CAUSE STRUCTURE (not a single-field guess):** The child-local OIDC configuration is a *single object* that carries BOTH (a) the public-client flag + the two `localhost:*` redirect URIs mcp-remote requires, AND (b) the identity under which IAS forwards to SAP ID Service (RequesterID `eb9a31c6…`). Because the OIDC config is child-local rather than inherited, the forward carries `eb9a31c6…` instead of the parent's trusted RequesterID → accounts.sap.com returns HTTP 400.

**The tension (why "Inherit from Parent" is NOT a safe fix):** "Inherit from Parent" reverts the WHOLE OIDC-config object to the parent's (parent = XSUAA-integration app: no localhost URIs, Public Client Flows OFF). So inheriting would fix the RequesterID but DESTROY the public-PKCE capability + redirect URIs — defeating the purpose. In the bundled-child model, "trusted inherited RequesterID" and "own public-client OIDC config" appear to be mutually exclusive (same object).

**Open (subagent researching authoritative IAS docs):** how the RequesterID is trusted by the corporate IdP, and the DOCUMENTED supported way to give a NEW public-client OIDC app the same corporate-IdP trust — inherit vs register-RequesterID vs tenant-issuer-trusts-all. The exact change depends on that answer; NOT changing anything on the shared tenant until it's known.

## KEY EVIDENCE — parent vs child redirect URI (verified live 2026-09-29, read-only)
Compared the two apps' OIDC-config Redirect URIs directly:
- **Parent (working)** redirect URI: `https://tutorial-system.authentication.eu10.hana.ondemand.com/login/callback/sap.custom` — the **IAS tenant's OWN callback** (the `sap.custom` corporate-IdP callback). The parent's OAuth flow round-trips THROUGH the IAS tenant's login/callback.
- **Child (failing)** redirect URIs: `http://localhost:*/oauth/callback` + `/mcp-callback` — **mcp-remote's loopback**, bypassing the tenant callback round-trip.

**Structural finding (from evidence, not theory):** the working federated flow round-trips through the IAS tenant's own `/login/callback/sap.custom`; the public-PKCE/localhost flow does NOT. SAP ID Service accepts the parent's request (originating from the tenant's trusted SP callback flow) and rejects the child's. This matches the honest-state spec's original observation ("Redirect URI = the IAS tenant's own callback, NOT a localhost loopback"). Research also found: `RequesterID`/`Scoping` per-app rejection is UNDOCUMENTED; SAP docs trust by tenant `<Issuer>` only; a novel issuer suffix would send an issuer SAP ID Service was never told to trust (likely rejected too) — so setting a suffix was NOT done (would be a guess on the shared tenant).

**Where this points (NOT yet a fix — needs deliberate decision):** the localhost-loopback (public-PKCE) request shape and the IAS-tenant-callback (federated) request shape appear to be different flows to SAP ID Service. Reconciling them — whether mcp-remote's flow can be made to round-trip through the tenant callback, or whether identity must come a different way — is the open design question. No further live-tenant changes made; tenant left exactly as found (issuer suffix typed then cleared, nothing saved).

## CONTROL TEST + CONCLUSION (2026-09-29, verified live with the real mcp-remote client)
Ran experiments to isolate the 400, eliminating hypotheses BY TEST (not theory):
1. **Added the tenant callback URI to the child** → SAML request byte-identical → still 400. (Redirect URIs don't appear in the SAML forward.) **Not the cause.**
2. **"Inherit from Parent" on the child's OIDC config** (Tom-approved) → still 400 (RequesterID unchanged in tree), AND it stripped the 2 localhost redirect URIs → **restored them afterward.** RequesterID/OIDC-config identity **not the cause.**
3. **CONTROL: hit the PARENT app's client (`5bf33bd6…`, the production-working app) via the same cold `/oauth2/authorize`** → **IDENTICAL HTTP 400.** ⇒ the failure is NOT child-app-specific and NOT a misconfiguration of `tutorials-identity`.
4. **With an active IAS admin session in the same browser** → still 400. **Not a missing-session issue.**
5. **Confirmed mcp-remote's REAL request == the manual authorize URL** (same host/client/PKCE/scope/localhost-callback + `resource=`). So the manual test was representative; mcp-remote genuinely cannot pass this leg.

**VERIFIED ROOT CAUSE:** IAS's OIDC `/oauth2/authorize` → proxied SAML AuthnRequest → SAP ID Service (`accounts.sap.com`) returns **HTTP 400 "could not process the authentication request"** in this tenant — for BOTH the child AND the known-good parent app. The production login does NOT use this OIDC-proxy-to-SAP-ID path; it uses the subaccount's auto-provisioned **XSUAA↔IAS SAML trust** (a different mechanism). Every self-service IAS app field was verified correct/inherited (Subject=Email, Conditional-Auth=SAP ID Service, Federation=Corporate IdP, public client, no secret). Correlation IDs (2D058140, 728DACEE, AFEF1985, 77376CAA, 3D831DD5, 0BEBE5F4) all produce NO IAS log entry.

**Honest bound on the claim:** proven = the public-PKCE OIDC-proxy path 400s for all apps in this tenant. NOT independently re-verified = the parent's production login succeeds via the XSUAA/approuter path (inferred from architecture, not re-tested — testing it isn't the MCP goal). What's undocumented (per the docs research) is SAP ID Service's per-request acceptance logic — SAP-operated, not customer-configurable.

**Child app left in a known state:** OIDC config was set to inherit-from-parent (Tom-approved) then localhost redirect URIs (`/oauth/callback` + `/mcp-callback`) were re-added; the inherited `.../login/callback/sap.custom` URI remains. Public client + no secret intact. The earlier-added tenant-callback URI change is effectively part of this (harmless).

## PRIOR (pre-inspection) status below — superseded by the observed facts above

## What was deployed to DEV (verified live)
- **srv-mcp** 1/1 running, CAP hybrid auth `{kind:ias, xsuaa:true}`, bound to IAS instance `tutorials-identity` (client `c6fd4896-dbd4-4883-9916-5cd36e6ccde4`, issuer `https://atxgsg7zi.accounts.ondemand.com`).
- **approuter** serving IAS discovery: `.well-known/oauth-authorization-server` → `authorization_endpoint=…/oauth2/authorize`, `token_endpoint=…/oauth2/token`, `scopes_supported:["openid"]`, `token_endpoint_auth_methods_supported:["none"]`. Confirmed via curl.
- srv-mcp's bound `identity` client **matches** the approuter-advertised client (`c6fd4896…`) — our wiring is internally consistent.
- Merged via PR #2544 (T1–T4) + #2545 (existing-service). `mta.yaml` stage/restore landmine handled.

## What is PROVEN to work
- The IAS `identity` broker mints a genuine **secretless public client** (`credential-type:NONE` key → no secret/cert). This is the public-PKCE shape XSUAA's `application` plan structurally cannot produce.
- mcp-remote ran the **real flow** (approuter discovery → IAS `/oauth2/authorize`, PKCE S256, no secret, `scope=openid`, own loopback callback) — NOT a local probe. It reached the IAS authorize endpoint correctly.

## The blocker (grounded, not guessed)
Federated SAP-ID login is rejected: *"Identity Provider could not process the authentication request"* (correlation `2D058140-2B83-4A07-9E01-0A001463DC65` — **produces NO IAS troubleshooting-log entry**, consistent with rejection *before* a loggable auth step, i.e. no IdP wired for this app to forward to).

Per the honest-state spec (`2026-09-29-ias-poc-reset-honest-state.md`), the WORKING app authenticates because it rides the **subaccount's XSUAA→SAP-ID-Service OIDC trust** — that trust layer federates the login AND resolves the employee I-number `I809764` (which `Users.sapId` keys on). It is **NOT** produced by IAS app-level attribute mapping. A **standalone** IAS public OIDC app (`tutorials-identity`) has no link to that subaccount trust, so:
1. IAS has no corporate IdP to forward the login to → the rejection above.
2. Even if login completed, the app would emit `user_uuid`=Global-User-UUID, **not** `I809764` — so identity resolution would still need the XSUAA-layer work.

This is the architectural gap the honest-state spec explicitly flagged as unresolved BEFORE building. Building the standalone app did not close it; app-console field changes (Subject=Email, Default-IdP, Conditional-Auth — all already set) cannot close it because the missing piece is subaccount-level trust, not app config.

## Confirmed dead ends (do NOT re-attempt)
- Reading the correlation ID in IAS logs — **empty**, every time.
- IAS app-console field tweaks (Subject Name Identifier / Default IdP / Conditional Auth / Identity Federation) — user confirmed already set to match the working app; the rejection persists.
- Adding the approuter/subaccount URL to the app's redirect URIs — the localhost-only redirects are CORRECT (mcp-remote catches the code on its own loopback; approuter is only in the discovery path, never the callback).
- Any local/hand-built probe (retracted earlier).

## The decision (the honest-state spec's open question, now forced)
Does MCP public-PKCE justify wiring subaccount-level trust for a standalone IAS app, OR should MCP identity ride the existing XSUAA path that already yields `I809764`?
- **Option A — wire subaccount trust for the IAS public app.** A deliberate subaccount-trust configuration task (establish trust so the IAS public app federates to SAP ID Service like the working app). Must be planned; not console-poking.
- **Option B — abandon the separate IAS app.** Keep the deployed discovery/hybrid wiring dormant (harmless — XSUAA fallback keeps all existing paths working); accept public-PKCE MCP needs the trust work before it's viable. The interim `/mcp-pat` path already ships authenticated MCP today.

## Deployed-but-dormant safety note
The hybrid `{kind:ias, xsuaa:true}` + discovery flip is live on DEV. Because `xsuaa:true` keeps the XSUAA fallback, existing MCP auth paths (browser/PAT) are unaffected. If Option B, decide whether to revert the discovery flip (`MCP_ISSUER_KIND`/`XSUAA_MCP_URL`) or leave it dormant.
