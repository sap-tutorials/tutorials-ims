# Serve `.well-known` discovery documents for the hosted MCP server

**Date:** 2026-08-28
**Decision:** Option B (our origin is the authorization-server-metadata host) · include `mcp.json` + `security.txt` despite caveats.

## Problem

`docs/developers/architecture/mcp-server.md` and `docs/end-users/mcp-quickstart.md` both claim the site serves OAuth discovery documents at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`, and the documented `mcp-remote` OAuth flow depends on them ("endpoints discovered automatically from `<base>/.well-known/oauth-authorization-server`").

Reality: **none of these documents are served.**

- There is no `approuter/static/.well-known/` directory and no such files anywhere in the repo.
- The approuter route `^/.well-known/(.*)$` forwards to `srv-api` (auth `none`), and the CAP origin (`srv/server.js`) only serves `agent-card.json` + `a2a-instructions.md` (#1220). Every other `.well-known` path returns **404** at the CAP origin.
- On `developers.sap.com`, **Akamai returns 403** for every `/.well-known/*` path except `security.txt` (edge-whitelisted, served by SAP corporate infra) — the request never reaches origin. Confirmed via `curl` (`Server: AkamaiGHost` on the 403).

Consequence: the hosted MCP server's OAuth auto-discovery is non-functional. `mcp-remote` and native-OAuth MCP clients cannot discover the XSUAA authorize/token endpoints.

## Goal

Serve a correct, spec-conformant `.well-known` discovery surface at the CAP origin so MCP clients auto-discover the server's OAuth endpoints, and coordinate the Akamai edge change so it works on `developers.sap.com`. Ship and verify on **DEV first**, then **PROD**.

## Constraints & facts (verified)

- **MCP auth spec (stable 2025-06-18) + RFCs** (researched against `modelcontextprotocol.io` + RFC 8414/9728/6750):
  - Client fetches `/.well-known/oauth-protected-resource` from the **resource server** (us). Only required field is `resource`; **MCP additionally mandates `authorization_servers`** (≥1 entry). Path-suffixed variant applies for path-bearing endpoints (e.g. endpoint `/mcp-auth/api` → `/.well-known/oauth-protected-resource/mcp-auth/api`), with fallback to the root path.
  - Client then fetches AS metadata from the `authorization_servers` origin, trying `/.well-known/oauth-authorization-server` (RFC 8414) then `/.well-known/openid-configuration` (OIDC). Client MUST validate `issuer` == the issuer it used to build the URL.
  - **DCR (RFC 7591) is not required** (SHOULD in stable, MAY in draft). Fallback for a non-DCR auth server = pre-registered `client_id`. XSUAA has no DCR; the pre-registered public client `sb-tutorials!t676072` (XSUAA `VCAP_SERVICES.xsuaa[0].credentials.clientid`) is the supported path — already documented.
  - `WWW-Authenticate: Bearer resource_metadata="…"` on a 401 from the protected endpoint is the **preferred** discovery trigger; well-known probing is the fallback.
  - There is **no standard `/.well-known/mcp.json`**. We serve one anyway as a non-standard courtesy manifest (Tom's decision), clearly labeled.
- **XSUAA** serves its own `/.well-known/openid-configuration` per identity zone but does **not** reliably serve an RFC 8414 `oauth-authorization-server` doc, and has no DCR. This is why Option B (we host the AS-metadata shim) is chosen over Option A (point straight at XSUAA).
- **Serving location:** Express handlers in `srv/server.js` `bootstrap`, mirroring the existing `agent-card.json` handler. **No static files, no envsubst** (repo is envsubst-free; DB/VCAP-driven config is the house style). Endpoint values are read at runtime from `VCAP_SERVICES.xsuaa[0].credentials` and `ChatSettings` (the existing `a2aPublicBaseUrl` / `a2aTokenUrl` resolver), with the host-injection-guarded `a2aBaseUrlFallback(req)` for base URL.
- **Scope:** `Tutorial.MCP` (exists in `xs-security.json`, both root and `.deploy/`).

## Design

### Base URL & endpoint resolution (shared helper)

Extract the existing `a2aBaseUrlFallback(req)` logic into a small resolver used by all handlers:

- `baseUrl` = `ChatSettings.a2aPublicBaseUrl` || `VCAP_APPLICATION.application_uris[0]` || guarded request headers (`x-forwarded-*`, marked `private, no-store` + `Vary` when falling back to headers — same as the A2A handler).
- XSUAA endpoints from `VCAP_SERVICES.xsuaa[0].credentials`:
  - `issuer` / `authorization_endpoint` base = `credentials.url` (e.g. `https://<zone>.authentication.<region>.hana.ondemand.com`)
  - `authorization_endpoint` = `<url>/oauth/authorize`
  - `token_endpoint` = `<url>/oauth/token` (must equal `ChatSettings.a2aTokenUrl` when set; DB value wins if present)
  - `clientid` = `credentials.clientid` (for the manifest / docs, not required by the metadata docs themselves)
- Fail-safe: if the XSUAA binding is absent (local `cds watch`), the AS-metadata handlers return 503 with a clear body rather than emitting a malformed doc. Unit tests inject a fake binding.

### Documents served (all at the CAP origin, auth `none`)

1. **`GET /.well-known/oauth-protected-resource`** (RFC 9728)
   ```json
   {
     "resource": "<baseUrl>",
     "authorization_servers": ["<baseUrl>"],
     "scopes_supported": ["Tutorial.MCP"],
     "bearer_methods_supported": ["header"]
   }
   ```
   `authorization_servers` points at **our own origin** (Option B). `resource` is the canonical server URI; it must match the token audience XSUAA stamps and the RFC 8707 `resource` param clients send.

2. **`GET /.well-known/oauth-authorization-server`** (RFC 8414 shim over XSUAA) — and an **alias** `GET /.well-known/openid-configuration` returning the same body:
   ```json
   {
     "issuer": "<baseUrl>",
     "authorization_endpoint": "<xsuaa.url>/oauth/authorize",
     "token_endpoint": "<xsuaa.url>/oauth/token",
     "response_types_supported": ["code"],
     "grant_types_supported": ["authorization_code", "refresh_token", "client_credentials"],
     "code_challenge_methods_supported": ["S256"],
     "token_endpoint_auth_methods_supported": ["none", "client_secret_basic"],
     "scopes_supported": ["Tutorial.MCP"]
   }
   ```
   **`issuer` = `<baseUrl>`** (our origin), so the client's issuer-equality validation passes when it discovered us via `authorization_servers: ["<baseUrl>"]`. Authorize/token endpoints delegate to XSUAA's real URLs. This is a metadata shim only — no token traffic flows through the CAP app; clients hit XSUAA directly.

3. **`WWW-Authenticate` on 401 from `/mcp-auth/*`** — the approuter enforces XSUAA on `/mcp-auth/*`; add the header on the unauthenticated 401 so compliant clients follow the pointer instead of probing:
   `WWW-Authenticate: Bearer resource_metadata="<baseUrl>/.well-known/oauth-protected-resource", scope="Tutorial.MCP"`
   Implementation note: the 401 originates at the approuter for `/mcp-auth/*`. If the approuter cannot inject a custom `WWW-Authenticate`, fall back to emitting it from the CAP `/mcp/*` mount's own 401 path and document the limitation. To be confirmed during implementation (spike the approuter behavior first).

4. **`GET /.well-known/mcp.json`** (non-standard courtesy manifest — Tom's decision; a header comment / `$comment` field notes it is not an MCP standard):
   ```json
   {
     "$comment": "Non-standard convenience manifest; not part of the MCP specification.",
     "name": "SAP Developers MCP",
     "provider": "SAP Tutorials (developers.sap.com)",
     "servers": [
       { "name": "search",   "url": "<baseUrl>/mcp/search",   "auth": "none" },
       { "name": "homepage", "url": "<baseUrl>/mcp/homepage", "auth": "none" },
       { "name": "graph",    "url": "<baseUrl>/mcp/graph",    "auth": "none" },
       { "name": "developer","url": "<baseUrl>/mcp-auth/api",  "auth": "oauth2", "scope": "Tutorial.MCP" }
     ],
     "authorization": { "protected_resource": "<baseUrl>/.well-known/oauth-protected-resource" }
   }
   ```

5. **`GET /.well-known/security.txt`** (RFC 9116) — served from origin despite Akamai already returning one at the edge (Tom's decision). Static content read from a file under `srv/` (packaged into `gen/srv`, like `a2a-instructions.md`), or inline:
   ```
   Contact: https://www.sap.com/report-a-vulnerability
   Expires: 2028-01-31T18:29:00.000Z
   ```
   Note: on PROD, Akamai's edge-served `security.txt` (200) will continue to win unless the edge rule routes it to origin — the origin copy is effectively DEV-visible + a fallback.

### Content-type & caching

- OAuth/OIDC/manifest docs: `application/json`. `security.txt`: `text/plain`.
- The AS/resource metadata docs are env-stable → `Cache-Control: public, max-age=3600`. Header-derived base URL fallback → `private, no-store` + `Vary` (as the A2A handler already does).

### Akamai (PROD dependency — not code)

`developers.sap.com/.well-known/*` is 403'd at the edge. PROD requires an Akamai property rule to **forward `/.well-known/*` to origin** (or at minimum the specific paths above). This is an external networking/edge ticket. Draft the request as part of the PROD rollout; DEV (no Akamai) works as soon as the origin handlers ship.

## Rollout

1. Implement handlers + shared resolver on a branch; unit tests with an injected fake XSUAA binding + `ChatSettings` row.
2. Deploy to **DEV**; verify each path returns the expected body against the DEV srv route (no Akamai). Verify `mcp-remote <dev>/mcp-auth/api --static-oauth-client-info '{"client_id":"…"}'` completes discovery + PKCE end-to-end.
3. Fix `docs/developers/architecture/mcp-server.md` (§`.well-known` discovery) and `docs/end-users/mcp-quickstart.md` to describe the real (origin-served) mechanism.
4. File the Akamai edge-forwarding ticket for PROD; after it lands, verify the same paths on `developers.sap.com`.

## Testing

- **Unit** (`srv/lib` + handler): resolver picks DB → VCAP_APPLICATION → header fallback in order; AS-metadata handler returns 503 when no XSUAA binding; each doc has required fields and correct content-type; `issuer` == advertised `authorization_servers[0]` == `baseUrl` (issuer-equality invariant that clients enforce).
- **Live DEV**: `curl` each path → 200 + shape; `WWW-Authenticate` present on `/mcp-auth/api` 401; one real `mcp-remote` connection.
- **Guard**: a test asserting the doc claims match the served paths, so the docs can't drift back to describing non-existent static files.

## Out of scope

- Registering the server in the central MCP Registry (`server.json`) — separate effort.
- Making the CAP app a real OAuth authorization server (it remains a metadata shim; XSUAA stays the token issuer).
- Changing XSUAA client registration or adding DCR.

## Open items to confirm during implementation

- Whether the approuter can attach a custom `WWW-Authenticate` header to its own `/mcp-auth/*` 401 (spike; §Document 3 fallback if not).
- Exact XSUAA `credentials.url` shape per env, and whether `a2aTokenUrl` in `ChatSettings` is populated on DEV/PROD (DB value wins when present).
