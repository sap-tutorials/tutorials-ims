# MCP Server Architecture

How the Model Context Protocol surface is structured across CAP services, approuter routes, and the shared step-HTML slicer. For the design rationale, see the spec at `docs/superpowers/specs/2026-07-08-mcp-server-phase2-design.md`.

## Three-route stack

```
Internet / MCP client
        |
  Approuter (xs-app.json)
        |
   ┌────┴──────────────────────────────────────────────────────────┐
   │  Route             Auth              Description               │
   │  /mcp/*            none              Anonymous read-only tools  │
   │  /mcp-auth/*       XSUAA OAuth JWT   Authenticated tools        │
   │  /mcp-pat/*        Bearer PAT        Headless / CI agents       │
   └───────────────────────────────────────────────────────────────┘
        |
  CAP runtime (tutorials-srv)
        |
   ┌────┴──────────────────────────────────────────────────────────┐
   │  @cap-js/mcp adapter                                           │
   │  Registers each @protocol:['odata','mcp'] service at          │
   │  /mcp/<serviceRoot> (anonymous) and                           │
   │  /mcp-auth/<serviceRoot> / /mcp-pat/<serviceRoot>              │
   │  (via the approuter prefix routing above)                     │
   └───────────────────────────────────────────────────────────────┘
```

**Anonymous route (`/mcp/*`):** No XSUAA round-trip. The approuter's `authenticationType: none` route forwards directly to `srv-api`. Participating services: `SearchService`, `HomepageService`, `KnowledgeGraphService`.

**Authenticated route (`/mcp-auth/*`):** The approuter enforces a valid XSUAA bearer. The CAP runtime receives `req.user` pre-populated by the XSUAA middleware. Participating services: `DeveloperService`, `HomepageService` (authenticated tools).

**PAT route (`/mcp-pat/*`):** The approuter uses `authenticationType: none` (the PAT is not a XSUAA token — the approuter cannot validate it). The CAP middleware `srv/lib/mcp-pat-middleware.js` intercepts every request before CAP's routing, validates the `Authorization: Bearer pat_...` header against the `PersonalAccessTokens` HANA table (SHA-256 comparison, TTL check), and synthesises a `req.user` object with the matched user's SAP ID and a `tokenSource: 'pat'` marker.

## Adapter package

`@cap-js/mcp@1.1.1` — the CAP MCP protocol adapter. Registers itself under `cds.protocols.mcp` on boot. No separate install or configuration needed beyond adding `'mcp'` to a service's `@protocol` list. Peer-dep: `@sap/cds ^10`.

Key behavior:

- `cds.mcp.per_action_tool: true` → every CDS action/function surfaces as its own named MCP tool.
- `cds.mcp.toon_format: true` → query results serialize as TOON (compact tabular text, LLM-friendly).
- Tools annotated `@requires: 'authenticated-user'` are **hidden from `tools/list`** for unauthenticated requests and return 401 when called unauthenticated. This is adapter-level filtering in `lib/auth.js::checkActionAccess()`.

Full adapter reference: <https://cap.cloud.sap/docs/guides/protocols/mcp>.

## `req.user` resolution

All authenticated tools ultimately call `resolveDbUser(req.user)` to look up the user's database row. Three paths converge on this function:

```
/mcp-auth/*  →  XSUAA middleware  →  req.user.id = SAP universal ID (from JWT sub)
                                       req.user.tokenSource = undefined (JWT)
                                       ↓
                                    resolveDbUser(req.user)
                                       ↓
                                    DB row from Users WHERE sapId = req.user.id

/mcp-pat/*   →  mcp-pat-middleware →  req.user.id = sapId from PersonalAccessTokens
                                       req.user.tokenSource = 'pat'
                                       req.user.roles = ['pat-read'] + ['pat-write'] (if scopes include 'write')
                                       ↓
                                    resolveDbUser(req.user)  (same function)
                                       ↓
                                    DB row from Users WHERE sapId = req.user.id
```

If `resolveDbUser` returns null (user not in the DB, stale OAuth clientId, or unmigrated user), the handler emits a WARN log `[mcp-dev] resolveDbUser miss` and rejects with 401. This surfaces stale-token issues without a silent zero-row response — see [[silent-user-resolution-hides-token-bugs]] in MEMORY.md.

## Shared step-HTML slicer

`srv/lib/tutorial-step-slicer.js` is the single implementation for extracting a step's HTML from the HANA content BLOB. Four consumers:

1. `DeveloperService.get_tutorial_step` (authenticated MCP, `/mcp-auth/*`)
2. `SearchService.get_tutorial_step` (anonymous MCP, `/mcp/search`)
3. `srv/lib/code-check-step-loader.js` (Joule `checkStepCode`)
4. `srv/lib/chat-context.js` server-side fallback

The slicer is **disabled** when `KG_STEP_SLICER_ENABLED=false`. It returns `null` on any error (fail-open). Content is cached in an LRU (200 slugs × ~50KB ≈ 10MB ceiling) keyed by `slug::activeManifestVersion` and invalidated on `content.published` CDS events.

The slicer uses raw `db.run()` for BLOB retrieval to avoid the CAP/HANA LOB locator expiry bug that occurs when BLOBs are mixed with non-BLOB columns in a CDS QL query. See the gotcha in CLAUDE.md (`Never SELECT a HANA BLOB alongside metadata`).

## `.well-known` discovery

Two OAuth discovery documents are served at the approuter level, enabling MCP 2.1 OAuth auto-discovery (RFC 8414 + RFC 9728):

- **`/.well-known/oauth-authorization-server`** — populated from the XSUAA/IAS instance's metadata. Fields: `issuer`, `authorization_endpoint`, `token_endpoint`, `code_challenge_methods_supported: ['S256']`, `token_endpoint_auth_methods_supported: ['none']` (public clients). Per-env values are substituted at deploy time from `deploy/dev.mtaext` / `deploy/prod.mtaext`.

- **`/.well-known/oauth-protected-resource`** — identifies this server as a protected resource (RFC 9728). Fields: `resource`, `scopes_supported: ['Tutorial.MCP']`, `authorization_servers: [<xsuaa-issuer>]`.

Both documents are served as static JSON by the approuter (`approuter/static/.well-known/`). No CAP backend round-trip. Their content-type is `application/json`.

## Phase 3 — the compose layer

`@cap-js/mcp@1.1.1` is **tools-only**: it has no API for registering MCP resources or prompts. Phase 3 adds `srv/lib/mcp-compose-router.js` to bridge this gap without forking the adapter.

### How it works

On each incoming request the compose router builds a per-request `McpServer` instance using the MCP TypeScript SDK. It then:

1. Calls the adapter's exported tool-registration functions (`@cap-js/mcp/lib/tools`) to re-register all curated tools from the underlying `@cap-js/mcp`-managed services.
2. Adds `registerResource` callbacks for the three URI schemes (`tutorial://`, `mission://`, `concept://`).
3. Adds `registerPrompt` callbacks for the four prompt templates.

The resulting `McpServer` advertises merged capabilities `{tools, resources, prompts}` on `initialize`, so clients see a single endpoint with all three capability types.

### Mounting

The compose router is registered in `cds.on('bootstrap', ...)` — before CAP's own `cds.protocols.mcp` adapter fires — so it wins the Express first-match race for `/mcp/graph` and `/mcp-admin/*`. The CAP adapter continues to serve `/mcp/search` and `/mcp/homepage` directly; `/mcp/graph` and `/mcp-admin/*` are owned by the compose layer.

```
/mcp/search        → @cap-js/mcp adapter   (SearchService, tools only)
/mcp/homepage      → @cap-js/mcp adapter   (HomepageService, tools only)
/mcp/graph         → mcp-compose-router.js (KnowledgeGraphService + resources + prompts)
/mcp-admin/*       → mcp-compose-router.js (admin tools, XSUAA-gated)
```

### Fragile seam and fallback

Deep-importing `@cap-js/mcp/lib/tools` is a **private-API seam**. If a future adapter update moves or renames those exports, the compose layer will fail to register tools on boot. Two guards protect against this:

- **`MCP_PHASE3_ENABLED` flag** (default `true`) — when `false`, the compose router is never mounted; `@cap-js/mcp` serves all three services in tools-only mode and `/mcp-admin/*` returns 503.
- **Fail-open fallback** — if `require('@cap-js/mcp/lib/tools')` throws on boot, the compose router logs a `WARN` and falls back to tools-only mode for `/mcp/graph` (same as Phase 2). The `mcp_compose_fallback_total` metric increments; a sustained non-zero value means the seam broke and manual intervention is needed (pin or patch the adapter, or disable Phase 3).

See the Operations runbook for flag knobs and alert guidance.

## References

- Design spec: `docs/superpowers/specs/2026-07-08-mcp-server-phase2-design.md`
- End-user quickstart: [docs/end-users/mcp-quickstart.md](../../end-users/mcp-quickstart.md)
- Reference (tool signatures): [docs/developers/reference/mcp-server.md](../reference/mcp-server.md)
- Operations runbook: [docs/developers/operations/mcp-server.md](../operations/mcp-server.md)
- Issue: [sap-tutorials/tutorials-ims#1105](https://github.com/sap-tutorials/tutorials-ims/issues/1105)
- Adapter: [`@cap-js/mcp` on npm](https://www.npmjs.com/package/@cap-js/mcp)
