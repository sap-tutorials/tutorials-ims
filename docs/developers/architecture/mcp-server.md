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

## References

- Design spec: `docs/superpowers/specs/2026-07-08-mcp-server-phase2-design.md`
- End-user quickstart: [docs/end-users/mcp-quickstart.md](../../end-users/mcp-quickstart.md)
- Reference (tool signatures): [docs/developers/reference/mcp-server.md](../reference/mcp-server.md)
- Operations runbook: [docs/developers/operations/mcp-server.md](../operations/mcp-server.md)
- Issue: [sap-tutorials/tutorials-ims#1105](https://github.com/sap-tutorials/tutorials-ims/issues/1105)
- Adapter: [`@cap-js/mcp` on npm](https://www.npmjs.com/package/@cap-js/mcp)
