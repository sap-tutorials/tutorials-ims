# MCP Server (Model Context Protocol)

**Status:** GA on DEV. Curated toolset shipped with #912. Adapter: `@cap-js/mcp@1.1.1`.

**Upstream reference:** [CAP MCP protocol adapter](https://cap.cloud.sap/docs/guides/protocols/mcp).

**See also:**
- End-user quickstart: [docs/end-users/mcp-quickstart.md](../../end-users/mcp-quickstart.md)
- Operator runbook: [docs/developers/operations/mcp-server.md](../operations/mcp-server.md)

---

## What is MCP?

MCP (Model Context Protocol) is a JSON-RPC 2.0 protocol for exposing tools, resources, and prompts to LLM clients (Claude Desktop, Claude Code, Cursor, custom agents). The CAP adapter `@cap-js/mcp` mounts a JSON-RPC endpoint per service and auto-generates:

1. `describe` — returns the service's CSN (entities, actions, functions, types). No arguments.
2. `query` — a generic CQN-`SELECT` tool. Arguments: `entity`, `select?`, `where?`, `top?`, `skip?`.
3. **Per-action/function tools** — one MCP tool per CDS action or function, because this project sets `cds.mcp.per_action_tool: true`. Each tool inherits the CDS signature verbatim.

The auto-generated tool shapes (`describe`, `query`) are documented at <https://cap.cloud.sap/docs/guides/protocols/mcp> — do not re-document them here.

## Base URLs

MCP is mounted at `/mcp/<service-@path>`. Three services expose MCP in this project:

| Service                 | MCP endpoint                    | Auth |
| ---                     | ---                             | --- |
| `SearchService`         | `/mcp/search`                   | Public |
| `HomepageService`       | `/mcp/homepage`                 | Public (per-function overrides may apply) |
| `KnowledgeGraphService` | `/mcp/graph`                    | Public (admin actions carry their own `@requires`) |

Local: `http://localhost:4004/mcp/search`.
DEV: `https://tutorials-approuter-dev.cfapps.eu10-005.hana.ondemand.com/mcp/search`.

Every enabled service also serves OData at the same base path (`/search`, `/homepage`, `/graph`). MCP is additive — the OData mount is untouched. This is why the service annotations look like `@protocol: ['odata', 'graphql', 'mcp']` and not `@mcp` alone. The `@mcp` single-protocol shortcut REPLACES the default OData mount; see [[cap-graphql-shortcut-replaces-odata]] in MEMORY.md and the callout comments in `srv/search-service.cds:18-22`.

## JSON-RPC envelope

Every tool invocation is a JSON-RPC 2.0 request with method `tools/call`:

```json
{
  "jsonrpc": "2.0",
  "id": "<any string or number>",
  "method": "tools/call",
  "params": {
    "name":      "<tool name>",
    "arguments": { "<arg>": "<value>" }
  }
}
```

Success response:

```json
{
  "jsonrpc": "2.0",
  "id": "<echo of request id>",
  "result": {
    "content": [ { "type": "text", "text": "<JSON-stringified return value>" } ]
  }
}
```

Error response (JSON-RPC error object):

```json
{
  "jsonrpc": "2.0",
  "id": "<echo>",
  "error": {
    "code":    -32602,
    "message": "Invalid params",
    "data":    { "details": "..." }
  }
}
```

Standard JSON-RPC codes: `-32700` parse error, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal error. CAP handler errors surface via `req.error()` and land in `error.data` (for example `{ code: 'KG_LOOKUP_FAILED', message: '...' }` from `kg_prerequisites`).

---

## Curated tools

Eight tools are curated in the CDS surfaces (four in `SearchService`, two in `HomepageService`, two in `KnowledgeGraphService`). Each also appears as an OData function at the same URL — the MCP wrapper reuses the CDS handler verbatim.

### 1. `search_tutorials`

**Purpose.** Fuzzy full-text search across published tutorials — returns slug + title + short snippet + tag list.

**Endpoint.** `/mcp/search`

| Argument     | Type            | Required | Notes |
| ---          | ---             | ---      | --- |
| `query`      | `String`        | no       | Natural-language search terms; word-boundary matched, stopword-filtered. |
| `tags`       | `array<String>` | no       | Exact-match filter on `primaryTag`. |
| `experience` | `String`        | no       | One of `'beginner'`, `'intermediate'`, `'advanced'`. |
| `limit`      | `Integer`       | no       | Default 10, hard max 100. |

**Return shape** (from handler, `srv/search-service.js:273`):

```jsonc
[
  {
    "slug":    "string (lowercased)",
    "title":   "string",
    "snippet": "string (first 240 chars of description)",
    "tags":    ["string"]            // [primaryTag] or [] when null
  }
]
```

**Example.**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search_tutorials",
    "arguments": { "query": "CAP HANA", "experience": "beginner", "limit": 5 }
  }
}
```

---

### 2. `list_missions`

**Purpose.** List published missions with the number of tutorials in each — the same missions the `/missions/` page shows.

**Endpoint.** `/mcp/search`

| Argument | Type            | Required | Notes |
| ---      | ---             | ---      | --- |
| `tags`   | `array<String>` | no       | Returns only missions whose `primaryTag` matches any supplied value. |
| `limit`  | `Integer`       | no       | Default 20, hard max 50. |

**Return shape** (from handler, `srv/search-service.js:327`):

```jsonc
[
  {
    "slug":          "string (lowercased)",
    "title":         "string",
    "description":   "string",
    "tutorialCount": 0
  }
]
```

**Example.**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "list_missions",
    "arguments": { "limit": 20 }
  }
}
```

---

### 3. `get_mission`

**Purpose.** Fetch a mission by slug with its ordered tutorial list. Returns `null` for unknown/unpublished missions; slug is case-insensitive.

**Endpoint.** `/mcp/search`

| Argument | Type     | Required | Notes |
| ---      | ---      | ---      | --- |
| `slug`   | `String` | yes      | Mission slug (lowercased server-side). |

**Return shape** (from handler, `srv/search-service.js:395`):

```jsonc
{
  "slug":        "string",
  "title":       "string",
  "description": "string",
  "tutorials":   [
    { "slug": "string", "title": "string", "order": 0 }
  ]
}
```

Returns `null` when no published mission matches the slug.

**Example.**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_mission",
    "arguments": { "slug": "cap-fiori-app" }
  }
}
```

---

### 4. `get_tutorial`

**Purpose.** Fetch tutorial metadata and ordered step list by slug. Returns `null` for unknown slugs, empty slugs, or INACTIVE tutorials.

**Endpoint.** `/mcp/search`

| Argument | Type     | Required | Notes |
| ---      | ---      | ---      | --- |
| `slug`   | `String` | yes      | Tutorial slug (case-insensitive; lowercased server-side). |

**Return shape** (from handler, `srv/search-service.js:428`):

```jsonc
{
  "slug":        "string",
  "title":       "string",
  "description": "string",
  "tags":        ["string"],       // [primaryTag] or [] when null
  "steps":       [
    { "number": 0, "title": "string" }
  ]
}
```

Note the handler maps the DB column `stepOrder` onto the returned `number` field, matching the CDS return type.

**Example.**

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "get_tutorial",
    "arguments": { "slug": "hana-cloud-mission-1-onboarding" }
  }
}
```

---

### 5. `get_recent_news`

**Purpose.** Recent SAP developer news items — the same feed the homepage news band shows.

**Endpoint.** `/mcp/homepage`

| Argument | Type      | Required | Notes |
| ---      | ---       | ---      | --- |
| `limit`  | `Integer` | no       | Default 10, hard max 50. |

**Return shape.** `array of RssItem` (declared in `srv/homepage-service.cds:75`, populated by `fetchRssItems` in the handler at `srv/homepage-service.js:829`):

```jsonc
[
  {
    "title":       "string",
    "link":        "string",
    "publishedAt": "2026-07-08T09:44:00.000Z",
    "description": "string"
  }
]
```

The MCP tool bypasses the homepage news band's hardcoded `limit:2` and calls `fetchRssItems(SAP_NEWS_RSS_URL, { limit })` directly, so callers can request up to 50.

**Example.**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "get_recent_news",
    "arguments": { "limit": 10 }
  }
}
```

---

### 6. `get_recent_videos`

**Purpose.** Recent SAP developer videos from the persistent `Videos` corpus, ordered by publish date descending. Corpus is refreshed twice-weekly by `srv/jobs/fetch-videos-job.js`.

**Endpoint.** `/mcp/homepage`

| Argument | Type      | Required | Notes |
| ---      | ---       | ---      | --- |
| `limit`  | `Integer` | no       | Default 10, hard max 50. |

**Return shape.** `array of VideoItem` (declared in `srv/homepage-service.cds:73`; handler at `srv/homepage-service.js:850`):

```jsonc
[
  {
    "videoId":     "string (YouTube video id)",
    "title":       "string",
    "thumbnail":   "string (URL)",
    "publishedAt": "2026-07-08T09:44:00.000Z"
  }
]
```

Returns `[]` on any DB failure — callers never see a 500.

**Example.**

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "get_recent_videos",
    "arguments": { "limit": 10 }
  }
}
```

---

### 7. `kg_prerequisites`

**Purpose.** Tutorials that teach concepts this tutorial depends on. Answers "what should I learn first?". Backed by the same knowledge graph the tutorial sidebar uses.

**Endpoint.** `/mcp/graph`

| Argument        | Type      | Required | Notes |
| ---             | ---       | ---      | --- |
| `tutorial_slug` | `String`  | yes      | Tutorial slug (lowercased server-side). |
| `depth`         | `Integer` | no       | Default 10, hard max 50. Slices the `prerequisitesOf` arm. |

**Return shape.** `array of TutorialRef` (declared in `srv/knowledge-graph-service.cds:110`):

```jsonc
[
  {
    "slug":   "string",
    "title":  "string",
    "weight": 0.00,          // Decimal(3,2), 0.00–1.00
    "reason": "string"
  }
]
```

Handler at `srv/knowledge-graph-service.js:1357` re-uses the internal `neighborhood()` handler and returns `nb.prerequisitesOf.slice(0, depth)`. On lookup failure the handler emits a JSON-RPC error with `code: 'KG_LOOKUP_FAILED'` and returns `[]`.

**Example.**

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "kg_prerequisites",
    "arguments": { "tutorial_slug": "hana-cloud-mission-3-modelling", "depth": 5 }
  }
}
```

---

### 8. `kg_what_to_learn_next`

**Purpose.** Tutorials that build on what this one teaches. Answers "what should I learn next?". PageRank-blended when `KG_PAGERANK_ENABLED=true` (#916).

**Endpoint.** `/mcp/graph`

| Argument        | Type      | Required | Notes |
| ---             | ---       | ---      | --- |
| `tutorial_slug` | `String`  | yes      | Tutorial slug (lowercased server-side). |
| `limit`         | `Integer` | no       | Default 10, hard max 50. Slices the `whatToLearnNext` arm. |

**Return shape.** `array of TutorialRef` — same shape as `kg_prerequisites` above.

Handler at `srv/knowledge-graph-service.js:1376` also re-uses `neighborhood()` and slices the `whatToLearnNext` arm. Same error posture as `kg_prerequisites`.

**Example.**

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "kg_what_to_learn_next",
    "arguments": { "tutorial_slug": "hana-cloud-mission-3-modelling", "limit": 10 }
  }
}
```

---

## Auto tools (all services)

Every MCP-enabled service also exposes:

- **`describe`** — no arguments; returns the CSN slice for this service (entities + actions + functions + types).
- **`query`** — arguments `entity` (required), `select?`, `where?`, `top?`, `skip?`; runs a CQN `SELECT` against a queryable entity in scope. Shapes are documented at <https://cap.cloud.sap/docs/guides/protocols/mcp>.

Because `cds.mcp.per_action_tool: true` is set on this project, every action and function in each MCP-enabled service is also a first-class tool — not just the eight curated names listed above. For example, `SearchService.getFacets` is reachable as an MCP tool at `/mcp/search`, and `KnowledgeGraphService.neighborhood` at `/mcp/graph`. Curated tools are the ones with LLM-friendly signatures, snake_case names, and doc-comments intended for tool descriptions; the rest are available but were not shaped for MCP-first consumption. Admin actions on `KnowledgeGraphService` (`runSparql`, `mergeConcepts`, `vetoConcept`, `triggerGraphRebuild`, `publishAllConcepts`) remain gated by `@requires: 'KnowledgeGraph.Admin'` when invoked via MCP.

---

## Testing this locally

Start the CAP backend:

```bash
cds watch
```

Then hit the MCP endpoint with `tools/call`. Example — `search_tutorials`:

```bash
curl -X POST "http://localhost:4004/mcp/search" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "search_tutorials",
      "arguments": { "query": "CAP HANA", "limit": 3 }
    }
  }'
```

Example — `describe` (introspect the service):

```bash
curl -X POST "http://localhost:4004/mcp/search" \
  -H "Content-Type: application/json" \
  -d '{ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "describe", "arguments": {} } }'
```

Example — `query` over `SearchableItems`:

```bash
curl -X POST "http://localhost:4004/mcp/search" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name":      "query",
      "arguments": { "entity": "SearchService.SearchableItems", "top": 3 }
    }
  }'
```

Success responses come back wrapped in the standard `result.content[0].text` envelope with the handler's return value JSON-stringified. Failure responses use the standard JSON-RPC `error` object.

---

## Phase 2: Authenticated tools

Phase 2 adds nine authenticated tools across two services: seven on `DeveloperService` (user progress + step content) and two on `HomepageService` (personalized recommendations). All nine require a valid XSUAA JWT or a PAT with at least `read` scope.

### Route decision matrix

| Client type | Route | Auth mechanism |
| --- | --- | --- |
| Browser agent (Claude Desktop OAuth) | `/mcp-auth/api` | OAuth 2.1 + PKCE via XSUAA/IAS |
| Headless agent (Claude Code, CI, VS Code extension) | `/mcp-pat/api` | Bearer PAT (`pat_...`) |
| Anonymous / public content | `/mcp/*` | none |

`/mcp-auth/*` carries the full XSUAA bearer from the approuter. `/mcp-pat/*` is handled by `srv/lib/mcp-pat-middleware.js` before the CAP runtime sees the request — the middleware resolves the PAT to a synthetic `req.user` and attaches `tokenSource: 'pat'`. Both paths converge on `resolveDbUser()` and the same CAP handlers.

### 9. `get_my_tutorials`

**Purpose.** The authenticated user's tutorials filtered by progress status.

**Endpoint.** `/mcp-auth/api` or `/mcp-pat/api`  **Auth.** `@requires: 'authenticated-user'`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `status` | `String` | no | `'in_progress'`, `'completed'`, `'all'` (default). |
| `limit` | `Integer` | no | Default 20, max 50. |

**Return shape.** `array of TutorialProgress` — slug, title, progress fields. See `srv/developer-service.cds`.

---

### 10. `get_my_missions`

**Purpose.** The authenticated user's missions filtered by status.

**Endpoint.** `/mcp-auth/api` or `/mcp-pat/api`  **Auth.** `@requires: 'authenticated-user'`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `status` | `String` | no | `'in_progress'`, `'completed'`, `'not_started'`, `'all'` (default). |
| `limit` | `Integer` | no | Default 10, max 50. |

---

### 11. `get_my_events`

**Purpose.** The authenticated user's registered events.

**Endpoint.** `/mcp-auth/api` or `/mcp-pat/api`  **Auth.** `@requires: 'authenticated-user'`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `when` | `String` | no | `'upcoming'` (default), `'past'`, `'registered'`. |
| `limit` | `Integer` | no | Default 20, max 50. |

---

### 12. `get_my_completed_steps`

**Purpose.** Step numbers the user has completed for a specific tutorial.

**Endpoint.** `/mcp-auth/api` or `/mcp-pat/api`  **Auth.** `@requires: 'authenticated-user'`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `slug` | `String` | yes | Tutorial slug (lowercased server-side). |

**Return shape.** `array of Integer` — the completed step numbers. Returns 404 for unknown slugs.

---

### 13. `get_tutorial_step`

**Purpose.** Full HTML slice of a tutorial step. Available on both the anonymous (`/mcp/search`) and authenticated (`/mcp-auth/api`) routes — authenticated callers also emit a `tokenSource`-tagged metric.

**Endpoint.** `/mcp/search`, `/mcp-auth/api`, or `/mcp-pat/api`  **Auth.** None required (anonymous mount), or `@requires: 'authenticated-user'` (authenticated mount).

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `slug` | `String` | yes | Tutorial slug. |
| `stepNumber` | `Integer` | yes | 1-based step number. |

**Return shape.**

```jsonc
{
  "slug":       "string",
  "stepNumber": 1,
  "stepTitle":  "string",
  "html":       "string (HTML fragment, gzip-decoded from HANA BLOB)",
  "textLength": 0,
  "totalSteps": 0
}
```

Returns 404 if the tutorial or step is not in the content store. Backed by `srv/lib/tutorial-step-slicer.js`; LRU-cached per `slug::activeManifestVersion`. Disabled if `KG_STEP_SLICER_ENABLED=false`.

---

### 14. `complete_step`

**Purpose.** Mark a tutorial step as completed. Writes progress; requires `pat-write` pseudo-role for PAT callers.

**Endpoint.** `/mcp-auth/api` or `/mcp-pat/api`  **Auth.** `@requires: 'authenticated-user'`. PAT callers need `scopes: ['read', 'write']`.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `slug` | `String` | yes | Tutorial slug. |
| `stepNumber` | `Integer` | yes | 1-based step number. |

Delegates to the existing `completeStep` action — the same audit trail fires for browser and MCP callers.

---

### 15. `reset_tutorial_progress`

**Purpose.** Reset all step progress for a tutorial. Writes progress; requires `pat-write` pseudo-role for PAT callers. Emits `TutorialProgressReset` audit event with `tokenSource` field.

**Endpoint.** `/mcp-auth/api` or `/mcp-pat/api`  **Auth.** `@requires: 'authenticated-user'`. PAT callers need `scopes: ['read', 'write']`.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `slug` | `String` | yes | Tutorial slug. |

---

### 16. `get_my_recommended_tutorials`

**Purpose.** Persona-ranked tutorial recommendations from `HomepageForYouCandidates`.

**Endpoint.** `/mcp-auth/homepage` or `/mcp-pat/homepage`  **Auth.** `@requires: 'authenticated-user'`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `limit` | `Integer` | no | Default 10, max 50. |

**Return shape.** `array of TutorialRef` (slug, title, snippet, tags) — ranked by persona fit. Anonymous users (no `UserLearningPreferences`) receive the un-personalized pool.

---

### 17. `get_my_recommended_missions`

**Purpose.** Persona-ranked mission recommendations from `HomepageForYouCandidates`.

**Endpoint.** `/mcp-auth/homepage` or `/mcp-pat/homepage`  **Auth.** `@requires: 'authenticated-user'`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `limit` | `Integer` | no | Default 10, max 50. |

**Return shape.** `array of MissionRef` (slug, title, description, tutorialCount).

---

## Related

- End-user quickstart (Claude Desktop / Claude Code wiring): [docs/end-users/mcp-quickstart.md](../../end-users/mcp-quickstart.md)
- Operator runbook (enable/disable, kill switch, smoke tests): [docs/developers/operations/mcp-server.md](../operations/mcp-server.md)
- HCQL protocol adapter (sibling protocol, same URL pattern): [hcql-support.md](./hcql-support.md)
- Issue: [sap-tutorials/tutorials-ims#912](https://github.com/sap-tutorials/tutorials-ims/issues/912)
- Upstream: [CAP MCP protocol adapter](https://cap.cloud.sap/docs/guides/protocols/mcp)
