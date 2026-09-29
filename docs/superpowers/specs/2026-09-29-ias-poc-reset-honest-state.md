# MCP OAuth via IAS — Clean-Slate Reset & Honest State (2026-09-29)

**Status:** POC abandoned; IAS tenant reset to clean default. Production auth (XSUAA) was never touched.

## What is actually PROVEN
- **XSUAA `application` plan cannot issue a secretless public/PKCE client** — broker rejects `public-client`/`credential-types:none`/`authorization_code_pkce_s256`; confidential-client + omitted secret → `invalid_client` at the token endpoint. (Empirical.)
- **XSUAA today resolves the Universal ID to the SAP employee I-number `I809764`** — this is the value in `Users.sapId` (the DB key the whole model + NGDS gate depend on). Confirmed via prior testing + live `/auth/user`.
- **IAS CAN issue a public-PKCE token with no secret** — captured a real token end-to-end.

## What was NOT proven (claimed earlier without evidence — corrected)
- **Whether IAS delivers `I809764` (or the correct identity) for REAL users is UNKNOWN.** The IAS token we captured showed a UUID / `P000000` — but that was for a **locally-created admin account** (a special case), NOT a federated user. A federated login through SAP ID Service **never completed** (persistent "Identity Provider could not process the authentication request" at accounts.sap.com), so we have zero evidence about a real user's IAS token identity.
- "It works, just not for your user" was an **unfounded claim** — retracted.
- The SAP-support-ticket / SAML-vs-OIDC / SP-registration theories were **unverified guesses**.

## The WORKING REFERENCE (study this before any restart)
The auto-created bundled app **"SAP BTP subaccount Tutorial System"** (the one BTP wires up automatically, that just works) is the model:
- **Subject Name Identifier = Email** (NOT Employee Number / personnelNumber — that attribute is empty and caused the first error).
- **Conditional Authentication = SAP ID Service; Identity Federation = Corporate IdP** — it DOES forward to SAP ID Service and works.
- **Redirect URI = the IAS tenant's own callback** (`https://tutorial-system.authentication.eu10.hana.ondemand.com/login/callback/sap.custom`) — NOT a `localhost` loopback.
- The **subaccount trust to SAP ID Service is OIDC and auto-provisioned** when the subaccount is activated (no hand-entered client_id/secret). The default corporate-IdP trust "just works" because BTP wired it.

**Why the POC failed:** the hand-built POC apps diverged from this reference — Employee-Number subject (empty), `localhost` public-client redirects, and forcing a raw SAML forward to accounts.sap.com. Those divergences broke it, NOT the platform or the trust. A standalone hand-built public-PKCE client forwarding SAML to accounts.sap.com is NOT the auto-provisioned pattern.

## Reset actions taken (all reversible, all on throwaway IAS-POC objects)
- Deleted CF service `tutorials-identity-mcp` (broker instance) + its service key.
- Deleted standalone IAS app "Tutorials MCP POC (standalone)".
- Reverted corporate IdP "SAP ID Service" type OIDC→SAML 2.0; Include-scoping back ON.
- Bundled broker app "Tutorials MCP Desktop Client (POC)" auto-removes with its deleted service.

## If restarting the MCP-OAuth goal later
- The requirement was a **public-PKCE MCP client** (mcp-remote) that resolves to the real `Users.sapId` identity.
- XSUAA already resolves that identity correctly via the auto-provisioned trust — the ONLY reason we looked at IAS is XSUAA can't do the public-PKCE client shape.
- Open question to answer FIRST (before building anything): does an app modeled on the working reference (Email subject, Corporate-IdP federation, IAS callback) — accessed as a real federated user — yield an identity that maps to `I809764`? If not, IAS needs identity reconciliation regardless.
- The interim shipped path (PAT tokens at `/mcp-pat`) already provides authenticated MCP without any of this.

## Branch
All research/decision docs on `worktree-mcp-xsuaa-public-client` (unmerged). Not PR'd.
