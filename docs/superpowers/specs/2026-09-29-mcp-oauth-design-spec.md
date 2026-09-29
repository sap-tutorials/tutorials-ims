# MCP OAuth — Design Spec (grounded in the working auto-setup, 2026-09-29)

> **For review before ANY config/code change.** Built entirely from authoritative facts (working platform app, deployed approuter/discovery code, mcp-quickstart docs, committed mta) — no invented solutions. Supersedes the abandoned IAS-public-instance POC.

**Spec:** this doc · **Refs:** #16 · **Branch:** worktree-mcp-xsuaa-public-client

## Goal
Let mcp-remote (Claude Desktop / Claude Code) authenticate to the MCP endpoint via **OAuth 2.1 authorization-code + PKCE, no client secret**, resolving to the **same identity the platform already uses** (`user_uuid` claim = `Users.sapId` = the SAP I-number, e.g. `I809764`).

## Core insight (why this is NOT a rearchitecture)
The platform ALREADY authenticates real users correctly:
- The working "SAP BTP subaccount Tutorial System" IAS app + subaccount OIDC trust resolves `user_uuid` → the I-number (`I809764`) that `Users.sapId` keys on. Proven in production via XSUAA.
- `resolveUserSapId` (`packages/core/resolve-db-user.js:49-58`) reads `authInfo.token.userId` (= `user_uuid`), the exact claim that flow already produces.

The ONLY thing XSUAA/the platform doesn't natively give mcp-remote is a **public-PKCE client**. But per the shipped design (mta-mcp.yaml:56-62, mcp-quickstart.md): **XSUAA's ordinary confidential client (`sb-tutorials!t676072`) accepts an authorization_code + PKCE (S256) exchange with the client_secret simply OMITTED.** So there is NO separate public instance and NO IAS app needed. mcp-remote does PKCE against the existing confidential `tutorials-xsuaa` client, secret omitted.

**⇒ The abandoned IAS-public-instance work was solving a problem the confidential-client-PKCE approach already solves. Drop it.**

## The actual bug to fix (Discrepancy #2 from the facts report)
`approuter/lib/well-known-oauth.js` advertises OAuth discovery for a **phantom separate public instance**:
- It reads `XSUAA_MCP_URL` / `XSUAA_MCP_XSAPPNAME` (default `tutorials-mcp`) and advertises scope `<xsappname>.Everyone`.
- But the committed `mta-mcp.yaml` binds ONLY the confidential `tutorials-xsuaa` and sets NO `XSUAA_MCP_URL`/`XSUAA_MCP_XSAPPNAME`.
- So at runtime `resolveMcpXsuaaCredentials()` falls back to `vcap.xsuaa[0]` = `tutorials-xsuaa` — meaning the advertised **issuer/xsappname/scope may not match** what mcp-remote then presents to XSUAA. This inconsistency is a prime suspect for prior failures, independent of the IAS console thrash.

**Fix = make discovery internally consistent with the committed reality:**
- Discovery must advertise the **`tutorials-xsuaa`** issuer, its real client (`sb-tutorials!t676072` dev / `sb-tutorials-prod!…` prod), and a **scope that actually exists on that instance** (verify: does `tutorials-xsuaa` define an `Everyone` scope? If not, use the real baseline scope, e.g. `openid` + the instance's actual scope).
- `token_endpoint_auth_methods_supported: ["none"]` + `code_challenge_methods_supported: ["S256"]` are already advertised — correct for the omit-secret PKCE flow.

## The identity/attribute question (Tom's point — it's just an attribute)
- `resolveUserSapId` reads `user_uuid`, which the XSUAA/`tutorials-xsuaa` path ALREADY populates with `I809764`. So on the confidential-client-PKCE path, **the identity is already correct** — no attribute work needed, because we're using the same XSUAA client the platform uses, not a fresh IAS app.
- (The IAS-attribute-mapping concern only arose because the POC built a SEPARATE app. Using the existing `tutorials-xsuaa` client, `user_uuid`=`I809764` comes for free.)
- If a future need arises to carry the I-number under a different claim, it's a single attribute mapping — not a blocker.

## Open items to VERIFY before implementing (no guessing)
1. **Confirm mcp-remote PKCE against the confidential `sb-tutorials!t676072` with omitted secret actually completes** against `tutorials-xsuaa` (the mta comment claims XSUAA accepts it — but the earlier XSUAA test showed `invalid_client` at the token endpoint when secret omitted; THIS CONTRADICTION MUST BE RESOLVED FIRST — see Risk below).
2. **Confirm the scope** `tutorials-xsuaa` actually grants (does `Everyone` exist, or must discovery advertise a different scope).
3. **Reconcile the `/mcp-auth` authenticationType** — xs-app.json says `none`; srv-mcp comment says `xsuaa`. Confirm the token gate is CAP `@requires:'authenticated-user'` at the `/mcp/api` mount (facts say yes).

## ⚠️ Central risk / contradiction to resolve first
The mta-mcp.yaml comment asserts "XSUAA accepts PKCE against the confidential client with secret omitted." But earlier in this investigation we recorded XSUAA returning **`invalid_client` at the token endpoint when the secret was omitted** from a confidential client. **These cannot both be true.** Before any build, resolve this with ONE clean test: mcp-remote (or a raw PKCE call) against `tutorials-xsuaa`'s `sb-tutorials!t676072`, secret omitted, and observe whether the token exchange succeeds. 
- If it SUCCEEDS → the confidential-client-PKCE design is valid; just fix well-known-oauth.js consistency + verify scope. Small, clean, no IAS.
- If it FAILS (`invalid_client`) → confidential-client-PKCE is NOT viable, which reopens the "how does mcp-remote get a public client" question — and IAS (done correctly, cloning the working app + public-flows-on) becomes the path, as a PROPER planned build, not console hacking.

## What this spec explicitly does NOT do
- No new IAS app, no `tutorials-identity-mcp`, no touching the default SAP-ID trust (all reverted/clean).
- No live console experimentation. Any change is code (well-known-oauth.js / mta) via PR to DEV, or a single scoped verification test.

## Next step
Resolve the central contradiction (does confidential-client PKCE with omitted secret work against `tutorials-xsuaa`?) with one clean test. That single result determines whether this is a small discovery-consistency fix or a genuine IAS build — and we plan accordingly. Do NOT build until that's known.
