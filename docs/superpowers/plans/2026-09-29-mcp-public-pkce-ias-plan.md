# Implementation Plan A — Test MCP Public-PKCE via the REAL flow (approuter, no localhost deviations)

> **REQUIRED SUB-SKILL:** executing-plans / subagent-driven-development. Steps `- [ ]`.
> **Guiding principle (Tom):** The default subaccount config WORKS. Test the REAL flow with ALL parts (mcp-remote → approuter → discovery → IAS), and REMOVE every variable that deviates from the known-working default. No local probe. No hand-built AuthnRequest. No localhost-redirect stand-in.

**Refs:** #16 · **Spec:** `docs/superpowers/specs/2026-09-29-mcp-oauth-design-spec.md`

## Retracted / do-not-trust (from earlier today)
- The local probe (`ias-app-test.mjs`, `xsuaa-pkce-test.mjs`, etc.) is an INVALID test — no approuter in path, an injected localhost redirect SAP ID Service may not trust, hand-built AuthnRequest. **All its failures are unreliable.**
- **"Public client doesn't work" is RETRACTED.** It's a supported IAS feature; a supported option would not exist if it fundamentally failed. Prior failures are almost certainly local-test artifacts, not a property of public clients.

## Known-working baseline (deviate from this as little as possible)
- Auto-created "SAP BTP subaccount Tutorial System" IAS app (confidential/JWKS) + subaccount OIDC trust to SAP ID Service authenticates real users, resolves identity, uses the IAS tenant's OWN callback (NOT localhost).
- New `Tutorials MCP` IAS app (client_id `9de5cb33-86df-40bd-9f71-20a7c57ef7e5`) = config-clone (Subject=Email, same 5 attributes, Default IdP=SAP ID Service, Federation=Corporate IdP) + ONE delta: Public Client Flows ON.

## Current committed wiring (facts — change only deltas)
- `deploy/dev.mtaext:68` → `XSUAA_MCP_URL = https://tutorial-system.authentication.eu10.hana.ondemand.com` (the XSUAA auth host).
- `.deploy/mta.yaml:316` + `mta.yaml` → `XSUAA_MCP_XSAPPNAME = tutorials`.
- `srv-mcp` binds **`tutorials-xsuaa`** (confidential existing-service) for inbound validation — `mta-mcp.yaml:63,79-82`; its comment falsely claims XSUAA accepts secret-omitted PKCE (retract).
- `well-known-oauth.js`: discovery `issuer` = approuter's own URL; `authorization_endpoint`/`token_endpoint` = `endpointBase` (= `XSUAA_MCP_URL`); scope = `<XSUAA_MCP_XSAPPNAME>.Everyone`.
- ⇒ **Discovery currently advertises XSUAA** (which can't do public-PKCE). To test the IAS public app via the real flow, discovery must advertise the IAS app.

## The question this plan tests — via the REAL flow, once
Does the actual `mcp-remote` client → deployed approuter `/mcp-auth/api`, discovering via the approuter's `.well-known`, complete a **public-PKCE** federated login against the **IAS public app** (`9de5cb33…`) through the working SAP-ID federation, and return a token srv-mcp accepts — with NO local-probe deviations?

## Design points — RESOLVED ON PAPER (2026-09-29, from working app + repo + CAP/IAS docs; agent a95aa682d3546e4be)

- [x] **DP1 — srv-mcp validating an IAS token.** RESOLVED: switch srv-mcp CAP auth to the **hybrid IAS strategy** — `"auth": { "kind": "ias", "xsuaa": true }` (`srv-mcp/package.json:28-30`). `ias` validates IAS JWTs; `xsuaa:true` keeps every existing XSUAA path (browser login, PAT, current confidential-PKCE) working via the documented XSUAA-fallback. `@sap/xssec ^4.13.1` is already a dep (`srv-mcp/package.json:20`) and does both. `@requires:'authenticated-user'` is auth-kind-agnostic — unchanged. Bind an **`identity` managed-service** for the `Tutorials MCP` app alongside the kept `tutorials-xsuaa` binding. **resolveUserSapId needs an IAS-aware branch** (real bug for IAS): `user_uuid` is XSUAA-only; an IAS token has no `user_uuid`, so `resolveUserSapId` (`packages/core/resolve-db-user.js:51-53`) falls through to `return user.id` = the IAS `sub`. Whether that resolves the migrated `Users.sapId` (I-number) depends on the IAS app's Subject Name Identifier + which claim carries the SAP ID — **claim name is a live-test item (LT2), do NOT guess it.** Add the branch once LT2 confirms the claim.
- [x] **DP2 — redirect URI on the IAS app.** RESOLVED: the IAS app must whitelist **mcp-remote's own loopback callback** — `http://localhost:*/oauth/callback` (mirror `xs-security.json`'s existing XSUAA whitelist; also `/mcp-callback`). Discovery advertises the IdP's authorize/token endpoints directly (`well-known-oauth.js:136-137`), so the browser authorize leg goes IdP-direct and mcp-remote captures the code on its loopback — **the approuter does NOT intermediate this callback.** `--host localhost` (per `mcp-quickstart.md:278-285`) forces the registered hostname to match (avoids the `127.0.0.1`-vs-`localhost` literal mismatch). localhost loopback was never the bug — the prior failures were the literal-mismatch and the invalid probe path. **Whether IAS accepts the `:*` port wildcard verbatim is a live-test item (LT3).**
- [x] **DP3 — scope.** RESOLVED: **plain OIDC scopes (`openid`), NOT `<xsappname>.Everyone`.** IAS is OIDC-compliant and **IAS JWTs carry no scopes at all** (CAP IAS doc, verbatim) — there is no `Everyone`-equivalent; `@requires:'authenticated-user'` is satisfied by any valid IAS token. `well-known-oauth.js` scope machinery must become **issuer-aware**: when advertising the IAS app, `resolveScope()` (`:74-79`) → `openid` and `scopes_supported` (`:141`) → `['openid']`, gating the xsappname-prefix logic behind an XSUAA-only branch. `token_endpoint_auth_methods_supported:['none']` (`:142`) stays correct for the public app.

## Live-test items (CANNOT be resolved on paper — fold into the SINGLE real acceptance test, do NOT guess)
- **LT1 — RESOLVED on DEV 2026-09-29 (inverts the plan's client-id assumption; IAS public client CONFIRMED).** A bound `identity`:`application` instance (`tutorials-identity-mcp`, DEV) **mints its OWN client** (`d01a9789-5ee1-4d5d-a499-83d574a9c8b5`), NOT the console app's `9de5cb33…`, and does NOT adopt the pre-created `Tutorials MCP` app by name (broker always mints a new app — no adoption param exists). With instance params `oauth2-configuration.public-client:true` + `grant-types:[authorization_code, authorization_code_pkce_s256, refresh_token]` + `redirect-uris:[http://localhost:*/oauth/callback, /mcp-callback]`, and a service key requested with `{"credential-type":"NONE"}`, the key returns **NO clientsecret, NO cert** — a genuine secretless public-PKCE client. ⇒ (a) discovery + mcp-remote MUST advertise `d01a9789…`; (b) console app `9de5cb33…` is irrelevant to the CF-validated flow; (c) **the IAS `identity` broker CAN mint a public client — the blocker that killed XSUAA does NOT apply.** Issuer `https://atxgsg7zi.accounts.ondemand.com`, authorize `/oauth2/authorize`, token `/oauth2/token`.
- **LT3 — RESOLVED (same run).** IAS accepts the `http://localhost:*/oauth/callback` port wildcard verbatim (documented: port wildcards allowed for localhost/127.0.0.1; the instance update applied it without error). One wildcard entry suffices; no pinned port needed.
- **LT2:** the exact IAS token claim carrying the migrated SAP ID (I-number) — decode a real `Tutorials MCP` IAS token before writing the resolveUserSapId branch (T2b).
- **LT3:** whether IAS accepts the `:*` port-wildcard redirect URI verbatim, and the installed mcp-remote build's port behavior (fixed vs ephemeral) — decides whether one wildcard entry suffices (T4).
- **LT4:** whether the IAS app emits `given_name`/`family_name`/`email` claims (profile backfill only, not auth) — decode the token (with LT2).

## Wiring tasks (code/config → PR to DEV) — DP1–DP3 resolved; LT items verified in the acceptance test
- [x] **T1 — point approuter discovery at the IAS public app + make scope issuer-aware.** DONE: `deploy/dev.mtaext` → `XSUAA_MCP_URL=https://atxgsg7zi.accounts.ondemand.com`, `MCP_ISSUER_KIND=ias`, `XSUAA_MCP_CLIENT_ID=d01a9789…`. `well-known-oauth.js`: `isIasIssuer()` switch → IAS uses `/oauth2/authorize|/oauth2/token`, `resolveScope()`→`openid`, `scopes_supported`→`['openid']`. IAS-variant unit tests added (18/18 pass).
- [x] **T2 — srv-mcp inbound validation for IAS (hybrid).** DONE: `srv-mcp/package.json` → `"auth": {"kind":"ias","xsuaa":true}` (cds-mcp-verified hybrid form). `mta-mcp.yaml`: added `tutorials-identity` managed `identity`:`application` resource (public-client params) + `requires` binding, KEEPING `tutorials-xsuaa` for the fallback.
- [ ] **T2b — resolveUserSapId IAS branch.** DEFERRED to acceptance test (LT2 — exact claim name needs a decoded real token; guessing would violate verify-first).
- [x] **T3 — remove the false "XSUAA accepts secret-omitted PKCE" comment.** DONE: both `requires:` and `resources:` comments in `mta-mcp.yaml` rewritten to the IAS-public-client reality.
- [x] **T4 — set the IAS app redirect URIs.** DONE: `http://localhost:*/oauth/callback` + `/mcp-callback` in the `tutorials-identity` resource config (LT3-confirmed IAS accepts the localhost port wildcard).

## The ONLY valid acceptance test — GATE (real flow, all parts, no localhost stand-in)
- [ ] Deploy the wiring to DEV (PR → DEV → mcp MTA deploy from fresh origin/DEV; cf target dev).
- [ ] Run the ACTUAL mcp-remote client:
  `npx -y mcp-remote <deployed-approuter>/mcp-auth/api --static-oauth-client-info '{"client_id":"9de5cb33-86df-40bd-9f71-20a7c57ef7e5"}' --host localhost`
  (documented command; mcp-remote's own loopback is fine — what matters is it discovers via the approuter and hits the IAS app, NOT a hand-built probe.)
- [ ] **Expected:** real SAP-ID federated login (accounts.sap.com), token issued (public PKCE, no secret), MCP connects, an authenticated tool call returns the logged-in user's data.
- [ ] **Verify the LT items in the same run:** LT1 — confirm the `client_id` the bound `identity` instance actually presents (adjust T1's advertised client if it isn't `9de5cb33…`); LT2 — decode the issued IAS token, read which claim carries the SAP ID (I-number), then land T2b's branch; LT3 — confirm IAS honored the `:*` redirect wildcard (else pin a port); LT4 — confirm profile claims present (backfill).
- [ ] On failure: capture the REAL mcp-remote output + `cf logs` for approuter/srv-mcp — real-flow diagnostics only.

## Hard rules (to break the day-long loop)
- **No local probe / hand-built AuthnRequest / standalone localhost script as a test.** Only test = real mcp-remote → deployed approuter.
- **Deviate minimally from the working app.** Anything not required to change stays identical.
- **No conclusions from invalid tests.** If the real flow can't be run yet, we WIRE it — we don't conclude.
- Do NOT touch the shared default SAP-ID-Service trust.

## Next step
DP1–DP3 are resolved on paper (above). Awaiting Tom's approval to execute T1–T4 as a PR to DEV, deploy, and run the SINGLE real mcp-remote acceptance test — which also verifies LT1–LT4 (no separate probe).
