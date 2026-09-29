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

## Open design points to resolve ON PAPER first (from working app + repo, NOT by probing)
- [ ] **DP1 — srv-mcp validating an IAS token.** srv-mcp binds `tutorials-xsuaa` (validates XSUAA tokens). An IAS-issued token needs srv-mcp to validate against the IAS app: CAP `auth.kind: ias` + a bound `identity` instance for the `Tutorials MCP` app. Decide the exact binding/config. (Biggest real design decision.)
- [ ] **DP2 — redirect URI on the IAS app.** The working app uses the IAS/approuter callback, NOT localhost. mcp-remote's `--host localhost` is ITS OWN loopback for the final code hand-off. Determine, from the working app's model, exactly which redirect URI(s) the IAS app must register for the approuter-fronted flow — minimize deviation from the working app (which does NOT use localhost).
- [ ] **DP3 — scope.** Verify the actual scope the IAS `Tutorials MCP` app exposes; do NOT assume `Everyone`.

## Wiring tasks (code/config → PR to DEV) — after DP1–DP3 resolved
- [ ] **T1 — point approuter discovery at the IAS public app:** set `XSUAA_MCP_URL` = IAS issuer (`https://atxgsg7zi.accounts.ondemand.com`) and the discovery client/xsappname/scope inputs to the IAS `Tutorials MCP` app (client `9de5cb33…`, verified scope). `.well-known` then advertises the IAS authorize/token + public client.
- [ ] **T2 — srv-mcp inbound validation for IAS** per DP1 (bind `identity` instance for the IAS app; `auth: {kind:'ias', xsuaa:true}` hybrid so existing XSUAA paths keep working).
- [ ] **T3 — remove the false "XSUAA accepts secret-omitted PKCE" comment** from `mta-mcp.yaml`.
- [ ] **T4 — set the IAS app redirect URIs** per DP2 (match the working-app model, not a localhost stand-in).

## The ONLY valid acceptance test — GATE (real flow, all parts, no localhost stand-in)
- [ ] Deploy the wiring to DEV (PR → DEV → mcp MTA deploy from fresh origin/DEV; cf target dev).
- [ ] Run the ACTUAL mcp-remote client:
  `npx -y mcp-remote <deployed-approuter>/mcp-auth/api --static-oauth-client-info '{"client_id":"9de5cb33-86df-40bd-9f71-20a7c57ef7e5"}' --host localhost`
  (documented command; mcp-remote's own loopback is fine — what matters is it discovers via the approuter and hits the IAS app, NOT a hand-built probe.)
- [ ] **Expected:** real SAP-ID federated login (accounts.sap.com), token issued (public PKCE, no secret), MCP connects, an authenticated tool call returns the logged-in user's data.
- [ ] On failure: capture the REAL mcp-remote output + `cf logs` for approuter/srv-mcp — real-flow diagnostics only.

## Hard rules (to break the day-long loop)
- **No local probe / hand-built AuthnRequest / standalone localhost script as a test.** Only test = real mcp-remote → deployed approuter.
- **Deviate minimally from the working app.** Anything not required to change stays identical.
- **No conclusions from invalid tests.** If the real flow can't be run yet, we WIRE it — we don't conclude.
- Do NOT touch the shared default SAP-ID-Service trust.

## Next step
Resolve DP1–DP3 on paper, then T1–T4 as a PR to DEV, deploy, and run the SINGLE real mcp-remote acceptance test.
