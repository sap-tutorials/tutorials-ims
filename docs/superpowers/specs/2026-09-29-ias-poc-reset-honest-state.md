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

## AUTHORITATIVE working-config values (read from the live working app, 2026-09-29)

From the auto-created **"SAP BTP subaccount Tutorial System"** app (OIDC, client_id `5bf33bd6-…`, the app the platform/XSUAA actually uses):

**Client Authentication:**
- **Enable Public Client Flows = OFF** ("Last enabled: Never").
- **No secrets, no certificates.**
- Trust via **Configure Trust by URI** → JWKS at `https://tutorial-system.authentication.eu10.hana.ondemand.com/token_keys` (12h refresh).
- ⇒ The working platform app is **NOT a public/PKCE client**. It's the XSUAA-integration app (JWKS-based). So mcp-remote's public-PKCE requirement is a genuinely DIFFERENT shape than what the platform uses — we cannot simply "point mcp-remote at the working app."

**Attributes (Self-defined, all Source = Identity Directory):**
- `email` ← Email
- `family_name` ← Last Name
- `given_name` ← First Name
- `groups` ← All Groups
- **`user_uuid` ← Global User ID** (the UUID — NOT the employee I-number)
- ⚠️ Banner: *"These attributes are ignored if Identity Federation User Store is disabled and Default Identity Provider isn't set to Identity Authentication."*

**KEY IMPLICATION for the identity question:** even the WORKING app maps `user_uuid` → the Global User ID **UUID**, not `I809764`. So the employee I-number `I809764` that `Users.sapId` uses is **NOT produced by IAS attribute mapping** — it must be resolved in the **XSUAA federation layer** (subaccount OIDC trust), below the IAS app config. Reproducing `I809764` via a separate IAS public-PKCE app is therefore NOT a copy-the-attributes job — it would require replicating that XSUAA-layer resolution, which the IAS app itself does not do.

**System app "User Profile"** (SAML 2.0, `sp.accounts.sap.com`) is an SAP System application ("be careful making changes") — Subject = User ID; not a template for a custom MCP client.

## Decision needed before any restart
Given the working app is confidential/JWKS (not public-PKCE) and the I-number is resolved in the XSUAA layer (not IAS attributes): does the MCP OAuth requirement justify a separate IAS public-PKCE app at all, or should MCP identity ride the existing XSUAA path that already yields `I809764`? This is the open architecture question — do NOT build until it's answered.
