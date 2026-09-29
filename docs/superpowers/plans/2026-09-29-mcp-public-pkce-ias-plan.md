# Implementation Plan — MCP Public-PKCE Auth via IAS (clone-the-working-app)

> **REQUIRED SUB-SKILL:** subagent-driven-development or executing-plans. Steps use `- [ ]`.
> **For review before any build.** Grounded in verified facts, not theories. One deliberate build + one acceptance test. No live console improvisation beyond the exact steps below.

**Goal:** mcp-remote authenticates to the tutorials MCP endpoint via OAuth authorization-code + PKCE (public client, no secret), resolving to the platform's existing identity, WITHOUT the config divergence that broke prior attempts.

**Spec:** `docs/superpowers/specs/2026-09-29-mcp-oauth-design-spec.md`

## Settled facts this plan rests on (do NOT re-test)
- XSUAA cannot issue a secretless public-PKCE client (proven repeatedly: broker rejects public-client/`credential-types:none`; token endpoint returns `invalid_client` when secret omitted). → a dedicated IAS public client is the ONLY way to get a public-PKCE client.
- The auto-created **"SAP BTP subaccount Tutorial System"** IAS app (OIDC) authenticates real users correctly via the subaccount OIDC trust to SAP ID Service. Its config (authoritative, captured): Subject=Email; Attributes email/given_name/family_name/groups/user_uuid←Global User ID; confidential (public-flows OFF).
- Prior IAS attempts failed because the POC app **diverged** from that working app (Employee-Number subject [empty], localhost-only bare app, forced SAML). The fix is to NOT diverge.
- `resolveUserSapId` reads the `user_uuid` claim.

## Global Constraints
- Change on the IAS app ONLY the minimum delta vs. the working app. Everything else = identical to the working app.
- Do NOT touch the default SAP ID Service corporate-IdP trust settings (protocol, scoping, signing). Those are shared/default; leave as shipped.
- DEV-scoped; production (XSUAA) untouched. All app-level, no subaccount-trust mutation.
- Every step is either a precise console action (with the exact field values) or a code/PR change — no "try and see."

## The build (deliberate, minimal-delta)

### Task 1: Create the IAS OIDC app as an EXACT clone of the working app
**Console (IAS admin):**
- [ ] Applications → Create → Name `Tutorials MCP` · Protocol Type **OpenID Connect** → Create.
- [ ] Trust → **Subject Name Identifier = Email** (match working app).
- [ ] Trust → Attributes → add EXACTLY the working app's 5, Source=Identity Directory each: `email`←Email, `given_name`←First Name, `family_name`←Last Name, `groups`←All Groups, `user_uuid`←Global User ID.
- [ ] Trust → Conditional Authentication → **Default Identity Provider = the SAME value the working app uses** (verify the working app's exact Conditional-Auth value first and copy it — do NOT set it to anything the working app doesn't use).
- [ ] Trust → Identity Federation → **match the working app's Identity Federation setting exactly** (verify working app's value first; the working app "just works", so copy it verbatim).

**Verification before proceeding:** confirm each of the above equals the working app's value (side-by-side). Any divergence = the failure mode from before.

### Task 2: The ONE intentional delta — enable public-client + loopback redirect
- [ ] Application APIs → Client Authentication → **Enable Public Client Flows = ON**.
- [ ] OpenID Connect Configuration → Redirect URIs → add `http://localhost:*/oauth/callback` and `http://localhost:*/callback` (mcp-remote loopback; `--host localhost`).
- [ ] Capture the app's generated **Client ID**.

### Task 3: Add the identity claim IF NEEDED (verify, don't assume)
- [ ] After Task 4's token capture, inspect the token. If `user_uuid` already carries the identity `resolveUserSapId` needs → nothing to add.
- [ ] If not, add ONE self-defined attribute carrying the identity claim (source determined from the actual token, not guessed).

### Task 4: THE acceptance test (the only thing genuinely unproven) — GATE
- [ ] Run a PKCE probe (the existing `xsuaa-pkce-test.mjs` pattern, repointed at the IAS app's authorize/token endpoints + Client ID) — real federated login via SAP ID Service.
- [ ] **Expected:** token exchange SUCCEEDS with no secret (public client), browser did a real SAP-ID login (not a local account).
- [ ] Decode the token; record `sub`, `user_uuid`, `scim_id`, email, and any P/S/I claim.
- [ ] **GATE:** does the token carry an identity `resolveUserSapId` can map to a `Users` row? If yes → viable. If no → Task 3 (add claim) then re-test once.

### Task 5: Wire srv-mcp + discovery (code, PR to DEV) — only after Task 4 passes
- [ ] `mta-mcp.yaml`: bind srv-mcp to the IAS app for inbound validation; **remove the false "XSUAA accepts secret-omitted PKCE" comment**.
- [ ] `approuter/lib/well-known-oauth.js`: set `XSUAA_MCP_URL`/`XSUAA_MCP_XSAPPNAME` (or equivalent) so discovery advertises the IAS app's real issuer + a scope that exists (fixes Discrepancy #2 — no phantom `tutorials-mcp`/`Everyone`).
- [ ] If `resolveUserSapId` needs an IAS-token branch (per Task 4), add it — minimal.
- [ ] PR to DEV. Deploy the mcp MTA. 

### Task 6: End-to-end acceptance on DEV — GATE
- [ ] mcp-remote against the deployed `/mcp-auth/api` (through the approuter), real federated login, an authenticated tool call returns the logged-in user's data.
- [ ] This is the real "test the actual thing." If it passes, done.

## Explicit non-goals / stop conditions
- If Task 4 shows IAS can't carry a mappable identity even with an added attribute → STOP, report; that's a genuine finding, not a reason to keep tweaking.
- No re-testing XSUAA secretless PKCE (settled). No touching the shared default trust. No console improvisation outside these steps.

## Cleanup
- Throwaway probe scripts under the job tmp dir; the `mcp-pkce-test` service key already deleted. Prior POC artifacts already removed.
