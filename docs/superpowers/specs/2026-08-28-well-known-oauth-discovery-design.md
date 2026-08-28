# `.well-known` discovery — remaining additions for the hosted MCP server

**Date:** 2026-08-28 (revised after discovering the OAuth docs already ship)
**Decision:** Keep the shipped **Option A** OAuth discovery. Add the four missing pieces below.

## Correction to the original premise

An earlier draft of this spec assumed nothing was served and proposed building an Option-B surface at the CAP origin. That was wrong — a broken `rg` silently returned no matches. **The OAuth discovery + security.txt surface already exists, wired, and tested:**

- `approuter/lib/well-known-oauth.js` → `wellKnownOAuthHandler` serves `/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/oauth-protected-resource` (RFC 9728), **dynamically at runtime** from the bound XSUAA VCAP credentials (no static files, no envsubst).
- `approuter/lib/security-txt.js` → `securityTxtHandler` serves `/.well-known/security.txt` (RFC 9116), byte-identical to SAP's canonical, guarded by a drift check.
- Both are registered as `insertMiddleware.first` in `approuter/server.js` (they answer before the `^/.well-known/(.*)$` → `srv-api` proxy route, which serves neither).
- Tests: `test/unit/security-txt.test.js`, `test/hybrid/oauth-discovery.test.js`.

**Option A is retained** (`authorization_servers`/`issuer` point straight at the XSUAA URL; the docs advertise the *fully-qualified* scope `<xsappname>.Tutorial.MCP`, e.g. `tutorials!t676072.Tutorial.MCP` — bare `Tutorial.MCP` is rejected by XSUAA with `invalid_scope`; `resolveScope()` encodes this hard-won behavior). Do **not** rewrite to Option B.

**The real reason the docs are unreachable on `developers.sap.com`:** Akamai 403s every `/.well-known/*` path at the edge except `security.txt` (confirmed: `Server: AkamaiGHost` on the 403). The origin serves them correctly; the edge blocks them.

## Scope (four additions)

### 1. `/.well-known/mcp.json` (non-standard courtesy manifest)

Not part of the MCP spec (server publishing is via the central MCP Registry `server.json`). Served anyway as a convenience. New approuter middleware mirroring `security-txt.js` / `well-known-oauth.js`. Body (base URL derived from the request, same `resolveBaseUrl` approach as the oauth handler):

```json
{
  "$comment": "Non-standard convenience manifest; not part of the MCP specification.",
  "name": "SAP Developers MCP",
  "provider": "SAP Tutorials (developers.sap.com)",
  "servers": [
    { "name": "search",    "url": "<base>/mcp/search",   "auth": "none" },
    { "name": "homepage",  "url": "<base>/mcp/homepage", "auth": "none" },
    { "name": "graph",     "url": "<base>/mcp/graph",    "auth": "none" },
    { "name": "developer", "url": "<base>/mcp-auth/api",  "auth": "oauth2", "scope": "<qualified-scope>" }
  ],
  "authorization": { "protected_resource": "<base>/.well-known/oauth-protected-resource" }
}
```

`Content-Type: application/json`, `Cache-Control: public, max-age=300`. Reuse `resolveScope()` for the qualified scope. GET/HEAD only; other methods + other paths pass through to `next()`.

### 2. `/.well-known/openid-configuration` (alias of oauth-authorization-server)

Native/draft-spec MCP clients try OIDC discovery when RFC 8414 isn't found. Serve the **same body** as `authorization_server_metadata`. Cleanest: extend `wellKnownOAuthHandler` to also match `OPENID_CONFIG_PATH = '/.well-known/openid-configuration'` and return `authorizationServerMetadata(issuer, scope)`. The 503-when-no-issuer path is shared.

### 3. `WWW-Authenticate: … resource_metadata="…"` pointer

The spec's *preferred* discovery trigger. The three existing 401s (`srv/server.js:764`, `srv/lib/a2a/rpc-router.js:23`, `srv/lib/mcp-pat-middleware.js:92`) set only `Bearer error="…"` with no pointer. The primary protected resource is `/mcp-auth/*`, whose 401 is emitted by the **approuter** (XSUAA auth), so the pointer belongs in an approuter middleware.

**Implementation:** a small approuter `insertMiddleware.first` handler that, for `/mcp-auth/*` and `/mcp-admin/*` requests lacking an `Authorization: Bearer` header, short-circuits with `401` + header (mirrors how `srv/server.js:756` short-circuits `/mcp-pat/*`):

```
WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource", scope="<qualified-scope>"
```

**Open item (spike first):** confirm the approuter forwards `/mcp-auth/*` to XSUAA auth *after* `insertMiddleware.first`, so short-circuiting there is safe and doesn't break the valid-bearer path. If short-circuit is unsafe, fall back to augmenting the CAP `/mcp/*` 401 (`srv/server.js`) with the same pointer and document that `/mcp-auth` 401s carry only the bare header.

### 4. Akamai edge-forward rule (PROD blocker — not code)

Draft a networking/edge request to forward `/.well-known/*` (or at minimum the five paths: `oauth-authorization-server`, `oauth-protected-resource`, `openid-configuration`, `mcp.json`, and keep `security.txt`) from the edge to origin on `developers.sap.com`. Deliverable: a written ticket/request in the PR description or an ops doc, not a code change. Everything else works behind Akamai the moment this lands; DEV (no Akamai) works immediately.

## Docs to fix

`docs/developers/architecture/mcp-server.md` §`.well-known` discovery still claims these are **static** files under `approuter/static/.well-known/`. Correct it to describe the runtime middleware (`approuter/lib/well-known-oauth.js`) and add the two new docs. `docs/end-users/mcp-quickstart.md` is broadly accurate (it already describes discovery from `oauth-authorization-server`); add an `openid-configuration` mention only if needed.

## Testing

- **Unit** (`test/unit/`): new `mcp.json` handler — 200 + JSON + expected `servers[]`/scope, passes through non-matching paths & methods (mirror `security-txt.test.js`). `wellKnownOAuthHandler` — `openid-configuration` returns the same body as `oauth-authorization-server`; 503 when no issuer. WWW-Authenticate middleware — 401 + `resource_metadata` pointer when no bearer on `/mcp-auth`, pass-through when bearer present.
- **Hybrid** (`test/hybrid/oauth-discovery.test.js`): extend to assert `openid-configuration` + `mcp.json` shape against the deployed approuter (uses `SMOKE_BASE_URL`).
- **Live DEV** (manual, needs correct approuter host via `cf`): `curl` all five paths → 200; `curl -D-` `/mcp-auth/api` → 401 carries `resource_metadata`.

## Out of scope

Rewriting to Option B; MCP Registry publishing; changing XSUAA client registration/DCR.

## Open items to confirm during implementation

- Correct **live DEV approuter hostname** (the hybrid test's hardcoded fallback `tutorials-approuter-dev.cfapps.eu10-005…` is stale — root 404s). Get it from Tom's `cf routes`.
- Whether short-circuiting `/mcp-auth/*` in `insertMiddleware.first` is safe (item 3 spike).
