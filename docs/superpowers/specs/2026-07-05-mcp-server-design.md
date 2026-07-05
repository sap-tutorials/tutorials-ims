# MCP Server for tutorials-ims — Phase 1 Design

**Date:** 2026-07-05
**Author:** Tom (via superpowers:brainstorming)
**Status:** Approved — corrections applied 2026-07-05 after codebase recon during plan-writing
**Related:** issue [#912](https://github.com/sap-tutorials/tutorials-ims/issues/912); CAP 10 [MCP Protocol Adapter release notes](https://cap.cloud.sap/docs/releases/2026/jun26#new-mcp-protocol-adapter)

## Summary

Expose the tutorials-ims CAP backend as a hosted MCP (Model Context Protocol) server so that AI agents (Claude Desktop, Claude Code, custom clients) can query tutorial content, missions, news, videos, and knowledge-graph relations without a local CLI install. Delivered in three phases; **this spec covers Phase 1 only** — the anonymous read tier that replaces the tutorial-content and news/video/mission surfaces of the `sap-devs` MCP.

The MCP adapter is the CAP 10 `@cap-js/ai` plugin's `@mcp` annotation, mounted **in-process** inside `tutorials-srv`. Four public CAP services get `@mcp` for schema-level auto-exposure; eight hand-authored CAP functions ride on top of them as opinionated, LLM-friendly tools. No new app, no new database tables, no auth in Phase 1.

## Goals

1. Any developer can add `https://developers.sap.com/mcp/*` to their MCP client config and immediately get tutorial search, tutorial content, mission browse, recent news, recent videos, and knowledge-graph recommendations — with no local install.
2. Content freshness improves silently for existing `sap-devs` CLI users: sap-devs's tutorial/news/video/mission tools become passthroughs to this hosted MCP (change tracked in the sap-devs repo, out of scope here).
3. Knowledge-graph queries (prerequisites, "what to learn next") are exposed as first-class MCP tools — pure differentiation from anything sap-devs offers today.
4. Zero net-new business logic: every curated MCP tool is a thin CAP function calling existing service handlers. One code path serves OData and MCP.

## Non-Goals

- **Authenticated / personalized tools** (progress, recommendations, homepage shelves keyed to `req.user`) — deferred to Phase 2.
- **Admin-scoped tools** (KG curation, community-promotion, content-publish) — deferred to Phase 3.
- **OAuth 2.1 flow** (browser sign-in for MCP clients) — Phase 2. `/mcp-auth/*` URL namespace reserved.
- **Personal access tokens.**
- **External-content proxies** (Learning Journeys, Discovery Center missions/services) — deferred; not requested by anyone today.
- **MCP resources and prompts** primitive types — tools only in Phase 1.
- **Removing anything from sap-devs.** sap-devs stays a first-class client. It changes internally to call this server; end-users don't lose tools.
- **A new metrics module or observability stack.** Piggybacks on existing metrics/logging.

## Architecture

The MCP server is not a new app. It's the CAP 10 `@mcp` protocol adapter, mounted in-process inside `tutorials-srv`, exposed at `/mcp/*` through the existing approuter.

```
Claude Desktop / Code / Custom agent
        │  HTTPS (Streamable HTTP + SSE per MCP 2025-06 spec)
        ▼
approuter (tutorials-approuter)
   ├── /mcp/*        →  anonymous (Phase 1) — authenticationType: none
   └── /mcp-auth/*   →  XSUAA OAuth 2.1 (Phase 2, reserved namespace)
        │
        ▼
tutorials-srv (CAP Node.js)
   @cap-js/ai plugin registers 'mcp' protocol
   ├── @mcp on SearchService          → describe/query/call_action
   ├── @mcp on HomepageService        → describe/query/call_action
   └── @mcp on KnowledgeGraphService  → describe/query/call_action
       (DeveloperService is authenticated-user per-entity, so it does not
        carry @mcp in Phase 1 — its curated tools live on SearchService)
        │
        ├── srv/search-service.js      (search_tutorials, list_missions, get_mission, get_tutorial)
        ├── srv/homepage-service.js    (get_recent_news, get_recent_videos)
        └── srv/knowledge-graph-service.js (kg_prerequisites, kg_what_to_learn_next)
        │
        │  get_tutorial delegates to srv/lib/content-store.js → HANA BLOBs
        │  (same code path OData /content/tutorials/:slug uses today)
        ▼
HANA Cloud (existing schema, no new tables in Phase 1)
```

Key architectural properties:

- **`@requires` propagates.** The `@cap-js/ai` adapter honors CDS auth annotations. All four Phase-1 services are already `@requires: 'any'`; nothing to re-annotate.
- **Curated tools are CAP functions** with rich `/** */` doc-comments. `@cap-js/ai` reads doc-comments as MCP tool descriptions. No parallel "MCP layer" — MCP and OData share handlers.
- **Sidecar escape hatch (deferred).** If MCP traffic squeezes the SRV Node loop, we lift the `@mcp`-annotated services into a new `tutorials-mcp` MTA module. Same code, different memory quota, different approuter route. This is a config change, not a rewrite; the design does not preclude it.

## Tool Surface (Phase 1)

### Auto-exposed via `@mcp` annotation

Three services × three tools = 9 free tools:

| Service | Auto-tools LLM gets |
|---|---|
| `SearchService` | `describe`, `query` (`SearchableItems`, `Tags`), `call_action` (`getFacets`) |
| `HomepageService` | `describe`, `query` (`HomepageShelves`), `call_action` (`events`, `videos`, `news`, `communityBlogs`, `shelves`, `tutorialCards`) |
| `KnowledgeGraphService` | `describe`, `query` (`Concepts` read-only, `ConceptEdges`, `TutorialConceptLinks`, `PublishedConcepts`), `call_action` (`neighborhood`, `neighborhoodFull`) |

`DeveloperService` does **not** carry `@mcp` in Phase 1 — its meaningful reads (`Tutorials`, `Missions`, `Events`, `TaskRecords`) are all `@requires: 'authenticated-user'`. Exposing it via `@mcp` in the anonymous namespace would either 401 every call or require re-annotation we're deferring to Phase 2.

### Hand-authored curated tools

Eight tools declared as CDS `function`s on the appropriate service; each backed by the existing handler logic. **Tutorial-content reads route through `srv/lib/content-store.js`**, the same helper that serves `/content/tutorials/:slug` today — anonymous by design.

| Tool | Service | Purpose | sap-devs replacement |
|---|---|---|---|
| `search_tutorials(query, tags?, experience?, limit?)` | Search | Fuzzy full-text search; returns slug + title + snippet + tags | Yes — `search_tutorials` |
| `get_tutorial(slug, step?)` | Search | Metadata + rendered HTML for one step. Fetches via `content-store.serveHandler` internals (no auth needed — same path as `/content/tutorials/:slug`). When `step` is omitted, returns metadata + step list only (no full body — LLM must ask for a specific step to get HTML, keeping responses bounded). | Yes — `get_tutorial_step` |
| `list_missions(tags?, limit?)` | Search | Ordered mission list with tutorial counts, queried directly from the `ims.Missions` DB entity | New |
| `get_mission(slug)` | Search | Mission metadata + ordered tutorial slugs, from `ims.Missions` + `ims.CompletionPaths` | New |
| `get_recent_news(limit?)` | Homepage | Thin wrapper around existing `news()` function with `limit` slicing | Yes — `get_recent_news` |
| `get_recent_videos(limit?)` | Homepage | Thin wrapper around existing `videos()` function; flattens `featured + recent` | Yes — recency slice of `search_videos` |
| `kg_prerequisites(tutorial_slug, depth?)` | Knowledge Graph | Calls existing `neighborhood(slug)` and slices the `prerequisitesOf` arm | New — differentiator |
| `kg_what_to_learn_next(tutorial_slug, limit?)` | Knowledge Graph | Calls existing `neighborhood(slug)` and slices the `whatToLearnNext` arm — PageRank-blended (#916) | New — differentiator |

Note: `list_missions` / `get_mission` live on **`SearchService`** because it's the anonymous entry point. They read the same `ims.Missions` table `AdminService.Missions` exposes; the anonymous read is safe because published missions are already public content on the site.

**Deliberate omissions in Phase 1:**

- No image-fetching tool. Tutorials embed image URLs; MCP clients that render markdown resolve them client-side. sap-devs's `get_tutorial_image` exists only because sap-devs is stdio and can't return browser-reachable URLs — we don't have that problem.
- No `search_learning_journeys` / `search_discovery` — external SAP content we'd have to proxy. Not requested; deferred.
- No progress or personalization — Phase 2.

## Auth and Transport

### Transport

CAP 10's adapter serves **Streamable HTTP** (MCP 2025-06 wire format) with SSE for large responses. Consequences:

- One HTTPS endpoint per service under `/mcp/<ServiceName>` — no WebSocket, no stdio.
- Existing approuter TLS + access logging + rate-limits apply automatically.
- Claude Desktop and Claude Code speak this format natively. Older stdio-only MCP clients need the `mcp-remote` bridge npm package — documented in the consumer quickstart, not solved in code.

### Phase 1 auth: none

The approuter route for `/mcp/*` sets `authenticationType: none`, mirroring `/homepage/*`. All three backing services (`SearchService`, `HomepageService`, `KnowledgeGraphService`) already carry `@requires: 'any'`.

Explicit rules:

- No PATs, no OAuth handshake, no XSUAA scope checks.
- Rate-limit by IP at the approuter (same as anonymous homepage).
- Curated-tool handlers **must not read `req.user`** — anonymous tier only.

### Phase 2 auth (reserved, not built): OAuth 2.1

Namespace `/mcp-auth/*` reserved. MCP 2025 auth spec uses OAuth 2.1 authorization-code with PKCE; XSUAA supports this natively, and the approuter already terminates the flow for browser sessions. What's missing today is an OAuth *discovery* document at `/.well-known/oauth-authorization-server`; that's a static JSON file the approuter can serve when Phase 2 lands. Phase 1 must not squat on the URL space.

### `@mcp` annotation mechanics

In each of the four service CDS files:

```cds
annotate SearchService with @mcp;
```

Placed alongside existing `@path` and `@requires`. The adapter picks up:

- Entity names, keys, and types → MCP tool schemas
- `@title` / `@description` → LLM-facing labels
- `/** */` doc-comments on entities, elements, and actions/functions → tool descriptions
- `@cds.query.limit` → default row caps
- `@requires` / `@restrict` → auth gates (all `'any'` in Phase 1)

### `@cap-js/ai` install and configuration

`@cap-js/ai@^1.0.1` **is already installed** for issue #959 (Fiori `@Common.ValueList` recommendations). No dependency change needed. The plugin's `cds-plugin.js` auto-registers the `mcp` protocol as soon as any service carries `@mcp`.

Add to `package.json`:

```json
"cds": {
  "requires": {
    "ai": {
      "mcp": { "path": "/mcp" }
    }
  }
}
```

Local `cds watch` auto-wires Claude Code's `.mcp.json` (dev convenience only; orthogonal to production shape).

### Curated tool implementation shape

Each hand-authored tool lands as a CDS function on the owning service, with logic in the existing `srv/*.js` handler:

```cds
service SearchService {
  /** Fuzzy search across published tutorials.
      @param query Search terms
      @param tags  Optional tag filter (array)
      @param limit Max results (default 10, max 50) */
  function search_tutorials(query: String, tags: many String, limit: Integer)
    returns array of {
      slug    : String;
      title   : String;
      snippet : String;
      tags    : many String;
    };
}
```

The doc-comment IS the MCP tool description. `srv/search-service.js` implements the handler by calling into the same search internals OData callers use — no new business code, only a new export shape.

## Data Flow, Errors, and Observability

### Anatomy of one tool call

For `search_tutorials(query="CAP handlers", limit=5)`:

1. Client opens Streamable HTTP connection to `https://developers.sap.com/mcp/SearchService`.
2. MCP `initialize` handshake → server responds with the tool list (12 auto + 8 curated).
3. Client sends `tools/call { name: "search_tutorials", args: {...} }`.
4. approuter forwards to `tutorials-srv` at `/mcp/SearchService`.
5. `@cap-js/ai` maps to the CDS function `search_tutorials`.
6. `srv/search-service.js` handler runs — same code path OData search hits.
7. Handler returns an array of objects; adapter frames as an MCP tool result.
8. approuter streams response over SSE if large, JSON otherwise.

The single most important property: step 6 is the *same code path* as OData. If OData search works, MCP search works.

### Error handling

**CAP/CDS validation layer** — Missing required args, wrong types, over-limit values return a structured MCP error before the handler runs. No handler code needed.

**Business errors** — Existing services `req.error(code, message)`. The adapter maps `req.error` to `mcp:error` with the same code and message. No changes needed.

**Panics** — Uncaught throws bubble as MCP protocol errors with a generic `internal_error` code (no stack traces leak). Existing CAP error-handler chain runs unchanged.

Two Phase-1 rules for curated tools:

- **No leaking `req.user`.** Anonymous tier only; handlers must not read the user. Static analysis check in PR review.
- **Bounded result sizes.** Every curated tool declares a `limit` param with a hard maximum (50 for lists, 100 for search). `@cds.query.limit: 200` on auto-exposed queries as a belt-and-braces cap.

### Observability

Piggyback on existing metrics — no new module.

- **Request-level:** approuter access log covers `/mcp/*` automatically. Same fields, same log store.
- **Tool-level counters:** `srv/lib/metrics.js` exposes `mcp_tool_invocation_total{service,tool,outcome}`. One line at the top of each curated handler. Auto-exposed tools get a blanket counter incremented in a small `on('*', srv, ...)` hook per `@mcp` service — good enough for Phase 1.
- **Latency histogram:** `mcp_tool_duration_ms{service,tool}` via the same hook.
- **Alerting:** existing `srv-error-rate` alert already fires on elevated errors. MCP errors count. No new alerts.

Not tracked in Phase 1: per-caller identity or per-agent breakdown — no auth, no identity.

### Rate limiting

Approuter route `/mcp/*` shares the anonymous-IP throttle used by `/homepage/*` and `/tutorials/*`. If the hosted MCP proves popular, we tune this route independently; not up front.

### Version pinning

- `@cap-js/ai` is beta. Pin in `package.json` with `~` (patch-level updates only). Breaking bumps get their own PR.
- MCP protocol version negotiated per-connection; adapter picks the latest it supports.

## Testing

Three layers, all reusing existing rigs. No new frameworks.

**Layer 1 — Unit (`npm test`, in-memory SQLite).** One unit test file per service (`test/unit/mcp-search-tools.test.js`, `test/unit/mcp-homepage-tools.test.js`, `test/unit/mcp-kg-tools.test.js`). Each test invokes the CAP function directly (e.g. `cds.services.SearchService.search_tutorials(...)`) — verifies shape and business logic. No MCP wire traffic.

**Layer 2 — Protocol contract (`test/unit/mcp-contract.test.js`, in-memory).** Boots CAP with `@cap-js/ai` loaded. Sends raw `initialize` + `tools/list` over HTTP. Asserts every Phase 1 tool is enumerated, has a non-empty description, has a valid JSON-schema `input_schema`. Failing this test blocks PR merge — catches missing doc-comments, wrong CDS types, silent adapter version drift. No MCP client SDK dependency; the wire format is straightforward JSON-RPC over HTTP.

**Layer 3 — Hybrid smoke (`npm run test:hybrid`).** One smoke test per curated tool against real HANA via `cds bind --exec`. Same rig `test/hybrid/*` tests already use. Confirms the CDS→HANA path (BLOB fetches, fuzzy search, KG procedures) works end-to-end.

Deployed-target smoke (`npm run test:smoke`) adds two checks: (a) `/mcp/SearchService` returns 200 for `initialize`, (b) `search_tutorials` returns non-empty for a canary query.

**Not built in Phase 1:** an "LLM UX quality" test suite. Deferred until Phase 2 delivers signal from real users.

## Documentation

Three docs under `docs/`:

1. **`docs/developers/reference/mcp-server.md`** — canonical tool reference. One table row per tool: name, args, returns, example JSON call/response. Hand-authored; ~200 lines. Kept in sync manually; the protocol-contract test (below) enumerates the exposed tool list, so renames or additions surface as CI failures until the doc is updated.
2. **`docs/users/mcp-quickstart.md`** — connect-with-Claude-Desktop and connect-with-Claude-Code recipes. Copy-pasteable `.mcp.json` snippets. Screenshots at the end. The doc developers paste from most.
3. **`docs/developers/operations/mcp-server.md`** — operator's runbook: how to disable a tool, how to redeploy the adapter, how to read the metrics dashboard, how to tune rate limits.

## Rollout

Three environments, three gates:

**Dev (BTP subaccount `tutorial-system`, space `dev`)** — merges to `main` flow the MCP surface to dev via existing MTA deploy. Public URL: `https://developers-dev.<region>.hana.ondemand.com/mcp/*`. Live for internal testing 1–2 weeks.

**QA channel** — the existing QA author-preview channel picks up the MCP surface automatically since it deploys the same MTA. Confirms behavior for real reviewers.

**Prod cutover** — timed with the end-of-July 2026 AEM decommission. Same MTA, `-e ../deploy/prod.mtaext`. Public URL: `https://developers.sap.com/mcp/*`. Announced via SAP Developer News (episode of that week) with Claude Desktop/Code recipes.

## sap-devs Retirement

Not a hard cutover. sap-devs keeps its interface; the hosted MCP is offered as an **alternative** for users who prefer no local install.

Two changes on the sap-devs side (tracked separately, not in this repo):

1. `search_tutorials`, `get_tutorial_step`, `get_recent_news`, `search_videos` become thin passthroughs to `https://developers.sap.com/mcp/*`. UX unchanged; content freshness improves silently.
2. Deprecation notice for local-cache flags after 60 days.

sap-devs remains useful for BTP/CF inspection, offline reading, and Phase-2/3 features not yet in the hosted MCP.

## Rollback

- MTA rollback (`cf rollback`) rolls back the MCP surface alongside the app. No independent state.
- To disable one misbehaving tool without a full rollback: comment out its CDS function declaration and redeploy. MCP clients treat missing tools as unavailable, not errors.
- To disable MCP on one service: `annotate <ServiceName> with @mcp: null;` and redeploy.
- Ultima ratio: uninstall `@cap-js/ai` — the adapter is opt-in via annotations; removing the dependency deactivates everything.

## Open Questions

None blocking Phase 1. Items surfaced during brainstorming that live in later phases:

- **OAuth discovery document format** — resolve during Phase 2 spec-writing.
- **Whether curated tools should also register as MCP resources** (e.g. `tutorial://<slug>`) — Phase 3.
- **`sap-devs` deprecation timeline** — negotiated with the sap-devs owner during rollout.

## Success Criteria

Phase 1 is done when:

1. `@cap-js/ai` is installed, pinned, and the four public services carry `@mcp`.
2. All eight curated tools have unit tests, protocol-contract coverage, and one hybrid smoke test each — all green.
3. `/mcp/*` route is deployed to Dev and the deployed-target smoke test passes.
4. Consumer quickstart doc exists with working Claude Desktop and Claude Code recipes verified end-to-end by a reviewer other than the author.
5. sap-devs owner has been informed of the hosted MCP endpoints and has an issue open to migrate the affected tools to passthroughs.

## References

- [CAP 10 MCP Protocol Adapter](https://cap.cloud.sap/docs/releases/2026/jun26#new-mcp-protocol-adapter)
- [MCP specification](https://modelcontextprotocol.io/specification/)
- Issue [#912](https://github.com/sap-tutorials/tutorials-ims/issues/912) — hosted MCP server
- Issue [#916](https://github.com/sap-tutorials/tutorials-ims/issues/916) — KG PageRank (feeds `kg_what_to_learn_next`)
- [srv/knowledge-graph-service.cds](../../../srv/knowledge-graph-service.cds)
- [srv/search-service.cds](../../../srv/search-service.cds)
- [srv/homepage-service.cds](../../../srv/homepage-service.cds)
- [srv/developer-service.cds](../../../srv/developer-service.cds)
