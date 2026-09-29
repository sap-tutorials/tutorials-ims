# M1 POC Result — IAS Public PKCE Works; Identity Reconciliation Required

**Date:** 2026-09-29 · **Status:** POC complete, decision point · **Refs:** #16, #30, ias-migration-impact-research, ias-tenant-foundation

## FINAL CHAIN (2026-09-29, decisive — end-to-end tested with nav trace)

The complete "what's needed to make IAS-for-MCP work" answer, each step empirically confirmed:
1. ✅ **IAS public PKCE, no client secret** — real token captured (XSUAA can't).
2. ✅ **IAS emits a P-shaped claim** — a self-defined attribute (Trust→Attributes, Source=Identity Directory→User ID) put `user_id` in the token. Mechanism works.
3. ✅ **App routes login to SAP ID Service** — after setting the app's Default Identity Provider = SAP ID Service + "Use Identity Authentication user store" OFF, the browser nav trace confirmed it redirects to `accounts.sap.com` (not the local IAS form).
4. ⛔ **SAP ID Service REJECTS the SAML AuthnRequest from this IAS tenant** — error thrown BY `accounts.sap.com`: "Identity Provider could not process the authentication request received" (correlation IDs 0C818729, C188AFA7). IAS's own SAML 2.0 config to SAP ID Service is correct (metadata URL, SSO/SLO endpoints, CN=accounts.sap.com signing cert to 2030, SHA-256, sign-auth-requests ON).

**The last mile is an SAP-SIDE action, not a console toggle:** SAP ID Service (SAP-operated `accounts.sap.com`) must **register/trust this IAS tenant (`atxgsg7zi`) as a Service Provider** and accept its signed AuthnRequests. This requires an **SAP support request** (provide correlation `C188AFA7`); likely causes on their side: the IAS tenant/SP isn't a registered trusted SP, or the AuthnRequest signing cert isn't recognized. Until that trust is established on the SAP-ID side, the real Universal ID P-number cannot flow.

**Still-open after SAP registers the trust (must retest):** (a) confirm the SAP ID Service assertion actually carries the real `^[PSIps]\d{6,}$` P-number and it equals the existing `Users.sapId`; (b) confirm CAP `resolveUserSapId` reads it from the IAS token (may need an IAS-aware branch). Both are quick token-decode retests once login completes.

**Net:** IAS-for-MCP is viable and is a CONFIG + SAP-side-trust-request path (NOT a 798k migration) — gated on SAP ID Service registering the IAS tenant as an SP. Same federation foundation as #2506.

---


## UPDATE (2026-09-29, later) — root cause found + config path identified Deeper investigation (real tokens + IAS console + federation research) found:

- **Why M1 was RED:** the IAS tenant `atxgsg7zi`'s users are **maintained LOCALLY** (local store; User ID = tenant-sequential placeholder `P000000`; Employee Number + Login Name EMPTY; Global User ID = SCIM UUID). The real SAP Universal ID P-number was **never fed into this tenant**, so no token claim can carry it. Confirmed via the user profile screen (`User ID: P000000`) + a real token where a `user_id` self-defined attribute (Source=Identity Directory→User ID) emitted `"P000000"` — the mechanism works, the value is the local placeholder.
- **The claim MECHANISM is proven:** a self-defined attribute (Trust→Attributes, Source=Identity Directory) DOES emit a `P######`-shaped claim in the IAS token. So IAS *can* carry a P-number claim — the only issue is sourcing the *real* one.
- **The fix is CONFIG, not a migration** (recommended pattern, doc-cited): federate the IAS tenant to **SAP ID Service** (accounts.sap.com) as a corporate IdP (already present as a SAML corporate IdP with "Forward All SSO Requests" ON), point the app's authenticating IdP at it with **Identity Federation OFF** (pass-through) so the SAP-ID assertion's real P-number flows straight into the IAS token — no local user pre-provisioning, no 798k-row reconciliation. IPS provisioning is the heavier fallback only if local user maintenance is mandated.
- **The current gap:** the POC app's Default Identity Provider was **"Identity Authentication" (local)**, so login used the local `P000000` account instead of forwarding to SAP ID Service. Switching the app's Default IdP → SAP ID Service is the next test.
- **Blast radius:** adding/using the SAP-ID corporate-IdP *trust* is tenant-level (shared `atxgsg7zi` — coordinate); pointing an app at it + federation-OFF + attribute mapping is app-scoped and DEV-safe.
- **Ties to #2506:** same IAS-as-issuer foundation, but #2506's branding switch does NOT by itself source the P-number — it must explicitly include this federation step or it re-introduces the local-user problem.

**Two must-TEST unknowns before calling it GREEN** (docs JS-rendered/unfetchable on these):
1. **SAP Universal ID == IAS Global User ID? UNCONFIRMED.** Must decode a real *federated* token to confirm the pass-through value is the actual `^[PSIps]\d{6,}$` P-number that equals the existing `Users.sapId`.
2. **CAP's claim→identity mapping for IAS tokens is undocumented** — whether `resolveUserSapId` (`authInfo.token.userId`/`payload.user_uuid`) picks up the federated P-number, or needs an IAS-aware branch, must be proven with a real token.

**Next test (app-scoped, DEV-safe):** set the POC app's Default Identity Provider = SAP ID Service, Identity Federation OFF, re-run the Playwright probe, confirm `user_id`/`sub` returns the REAL P-number (not `P000000`) and matches the user's `Users.sapId`.

---

## (Original conclusion below — superseded by the UPDATE above on the "reconciliation required" framing; the auth-works + DEV-isolation facts stand)

## What the POC proved (empirical, real token captured)

A full **authorization_code + PKCE, public client, NO client secret** flow against the IAS tenant `atxgsg7zi.accounts.ondemand.com` **succeeded end-to-end** (token endpoint HTTP 200). This is the capability XSUAA categorically could not provide (XSUAA `application` plan rejects public-client / `credential-types:none`; confidential-client secret-omit returns `invalid_client`). **IAS public PKCE is viable.**

Captured token (Thomas Jung, standalone IAS OIDC app, Subject Name Identifier switched off the empty `personnelNumber`):
```
sub:        ba411614-11a4-42a3-9867-0919861a7dac
user_uuid:  ba411614-11a4-42a3-9867-0919861a7dac   (identical to sub)
scim_id:    ba411614-11a4-42a3-9867-0919861a7dac   (identical)
email/mail: thomas.jung@sap.com
given_name / family_name / sap_id_type:user
```

## M1 verdict: RED — no P/S/I number in any IAS claim

- Our data model + NGDS badge gate key on `Users.sapId` = the **P/S/I personnel number** (`^[PSIps]\d{6,}$`), sourced today from XSUAA's `user_uuid`. ~798k rows.
- IAS emits only the **Global User ID UUID** (same value in `sub` / `user_uuid` / `scim_id`). The **`personnelNumber` attribute is EMPTY** for this user (that was the "Attribute personnelNumber is not supported" / IdP-config-incorrect error, KBA 2954081) — and is expected empty for the largely non-employee community/external user population.
- **A native IAS token cannot be mapped directly to the existing `Users.sapId`.** No claim carries the P-number.

## Implication: "project, not a flip" (confirmed)

IAS-for-MCP splits into two separable problems:
1. **Authentication** — SOLVED. Public PKCE works; DEV-isolated from PROD (app-scoped, no subaccount trust mutation — proven); reproducible via the `SAP/terraform-provider-sap-cloud-identity-services` `sci_application` resource.
2. **Identity reconciliation** — a real workstream. Mapping IAS-UUID → existing `Users.sapId` needs one of:
   - **UUID→P-number lookup** at login via the SAP ID Service `/cps/user/...` API (note: that API rate-limits hard — SCI #632).
   - **IPS-synced mapping** table (Global User ID ↔ SAP Universal ID / P-number).
   - **Store the IAS UUID as a new alt-key** on `Users` alongside `sapId`, backfill the ~798k rows, and add an IAS-aware branch to `resolveUserSapId`. This also forces the HANA UNIQUE hardening + NGDS-gate revisit flagged in the impact research.

## Options (decision is Tom's)

- **A. Pause IAS-for-MCP.** Auth is proven but identity reconciliation is a sizable, PROD-touching workstream (798k rows, NGDS gate, HANA uniqueness). Ship/keep **PAT** as the interim OAuth-adjacent path; schedule IAS identity reconciliation as its own planned project (possibly aligned with #2506).
- **B. Design the reconciliation** now — pick the mapping mechanism (lookup vs IPS vs alt-key backfill), spec it, then wire IAS-for-MCP in DEV.
- **C. Reconsider the requirement** — does interactive MCP OAuth truly need to resolve to the *existing* P-number-keyed identity, or can MCP users be keyed on the IAS UUID (new identity space) for the MCP surface only, avoiding the 798k reconciliation?

## Cleanup owed
- Delete POC IAS artifacts when done: `cf delete-service tutorials-identity-mcp` (broker app) + delete the console "Tutorials MCP POC (standalone)" app. (Left in place now pending the decision.)
- Local probe scripts under the job tmp dir are throwaway.
