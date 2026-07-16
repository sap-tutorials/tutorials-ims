# A2A Endpoint + Agent Card for Central Joule Consumption (#1220)

**Status:** Design approved — ready for implementation plan
**Issue:** https://github.com/sap-tutorials/tutorials-ims/issues/1220
**Date:** 2026-07-16

## Goal

Expose an **Agent-to-Agent (A2A)** endpoint with a discoverable **Agent Card** so a
central SAP Joule instance can consume this platform's existing Joule chat orchestrator
**and** selected discrete capabilities (tutorial search, user progress, knowledge-graph
reasoning, tutorial-step fetch) via the open [A2A protocol](https://a2a-protocol.org).

The issue explicitly asks for "an Agent Card and other necessary consumption prompt and
explanation" — so a machine-readable card **and** human/LLM-facing integration guidance
are both in scope.

## Decisions (locked with maintainer)

| Question | Decision |
|---|---|
| What to expose | **Both** — one conversational chat skill + four discrete tool skills |
| Auth | **XSUAA JWT**, reusing the existing `Tutorial.MCP` scope (same tier as `/mcp-auth`) |
| Streaming | **Yes, from day one** — `message/stream` (SSE) plus sync `message/send` |
| Task state | **cds-caching store** (`store:"cds"`, TTL) — cross-instance coherent, no new schema |
| Tool skills | `searchTutorials`, user progress (`get_my_tutorials`), knowledge graph, tutorial steps |

## A2A protocol facts this design relies on

- Agent Card served at **`/.well-known/agent-card.json`** (public discovery).
- Transport: **JSON-RPC 2.0 over HTTP**; streaming via **SSE**.
- Core methods: `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`.
- Minimal viable server = Agent Card + `message/send` + `tasks/get`; streaming + cancel are
  additive.
- Card fields: `protocolVersion, name, description, url, preferredTransport, version,
  provider, capabilities{streaming,pushNotifications}, defaultInputModes, defaultOutputModes,
  skills[]{id,name,description,tags,examples}, securitySchemes, security`.

## Why this fits the existing platform

The repo already runs a **mature MCP surface** that is structurally identical to what A2A
needs, so A2A reuses proven patterns rather than inventing new ones:

- **Joule chat** is a custom Express SSE route `POST /chat/stream` (not OData); the CDS
  `ChatService` is an empty shell for ORD/audit symmetry. Core: `streamChat({res, system,
  messages, tools, user, ...})` in `srv/lib/chat-orchestrator.js:722` — an agentic tool loop
  over `@sap-ai-sdk/orchestration` that writes SSE `data:` frames directly to `res`.
- **MCP** is exposed at `/mcp/<svc>` via `@cap-js/mcp` 1.1.1 + a compose router
  (`srv/lib/mcp-compose-router.js`) using **JSON-RPC 2.0** already, with three auth tiers:
  `/mcp-auth` (XSUAA `Tutorial.MCP`), `/mcp-pat` (PAT), `/mcp-admin`.
- The approuter **already routes `^/.well-known/(.*)$` to `srv-api` with `auth=none`** — the
  Agent Card needs **no new approuter config**.
- `ChatConfig` (`@requires:'any'`, public via `/api/ChatConfig`) is the established
  public-probe precedent for anonymous discovery metadata.

## Architecture

```
Central Joule ──► approuter ──► srv (CAP Node.js)

  /.well-known/agent-card.json   auth=none   → GET  → Agent Card JSON (built once at boot)
  /a2a                           auth=xsuaa  → POST → JSON-RPC 2.0 dispatcher
                (scope: Tutorial.MCP)                 (message/send, message/stream,
                                                       tasks/get, tasks/cancel)
  /.well-known/a2a-instructions.md auth=none → GET  → consumption prompt / integration guide
```

- **New approuter route** `^/a2a/(.*)$` → `srv-api`, `authenticationType:xsuaa`,
  `scope:$XSAPPNAME.Tutorial.MCP`, `csrfProtection:false` — a clone of the `/mcp-auth`
  route. The forwarded JWT carries the end-user identity so `user-progress` works.
- **`/.well-known/agent-card.json` + `/.well-known/a2a-instructions.md` are public** (card +
  guide contain no secrets; matches the A2A discovery model). Both are covered by the
  existing `/.well-known/*` route — serving the guide under `/.well-known/` avoids a
  mixed-auth `/a2a/*` prefix.
- **Kill switch** `A2A_ENABLED` (default on), same idiom as `MCP_PHASE3_ENABLED`. When off:
  `/a2a` POST → **503**; the Agent Card still serves (discovery still explains the agent) and
  signals unavailability so a consumer knows it is disabled.

## Components & file layout

```
srv/a2a-service.cds              # empty shell, @path:'/a2a', @requires:'authenticated-user' (ORD/audit symmetry; mirrors chat-service.cds)
srv/a2a-service.js               # empty init() — live path is the Express route (mirrors chat-service.js)
srv/lib/a2a/agent-card.js        # buildAgentCard(baseUrl, flags) → the card object (pure, no I/O)
srv/lib/a2a/rpc-router.js        # express.Router — JSON-RPC 2.0 dispatch + error shaping
srv/lib/a2a/skills.js            # skill registry: skillId → handler (chat + 4 tool skills)
srv/lib/a2a/task-store.js        # cds-caching-backed task put/get/cancel with TTL, keyed by task id
srv/lib/a2a/message-adapter.js   # A2A Message <-> {messages,pageContext}; SSE frame <-> A2A task/artifact events
srv/lib/chat-invocation.js       # NEW shared helper: buildChatInvocation(pageContext,user) → {system,tools,deploymentId,modelName,enabled}
docs/.../a2a-instructions.md     # consumption prompt / integration guide (served + embedded)
```

### Responsibility isolation (each unit testable alone)

- **`agent-card.js`** — pure builder. Input: base URL + flags. Output: card object. No I/O.
- **`skills.js`** — the ONLY place that knows about internal tools. Maps:
  - `tutorial-chat` → `streamChat` (full agentic loop; internally routes to all tools).
  - `search-tutorials` → `searchTutorials` handler.
  - `user-progress` → `get_my_tutorials` handler (needs forwarded user identity).
  - `knowledge-graph` → `expandSearchConcepts` / `findLearningPath` handlers.
  - `tutorial-steps` → `get_tutorial_step` handler.
- **`rpc-router.js`** — protocol only: parse JSON-RPC, validate method/params, route to a
  skill, shape response/errors. Knows nothing about tutorials.
- **`task-store.js`** — persistence only (cds-caching `store:cds` with TTL).
- **`message-adapter.js`** — translation only.

### The one shared refactor

Extract the ChatSettings read + `buildSystemPrompt` + `toolsForContext` assembly currently
inline in `srv/server.js` `businessHandler` (~`:1263-1319`) into
`buildChatInvocation(pageContext, user)` in `srv/lib/chat-invocation.js`, so `/chat/stream`
and the A2A chat skill call it identically. Prevents setup drift between the two entrypoints.
`/chat/stream` behavior must be byte-for-byte unchanged after the extraction (guarded by
existing chat tests).

## Data flow

### A. `message/stream` (primary chat path)

```
POST /a2a {jsonrpc:"2.0", method:"message/stream", params:{message:{role:"user",parts:[{kind:"text",text:"..."}]}, ...}}
  → auth (xsuaa JWT → cds.context.user); anonymous → JSON-RPC -32001 (+ WWW-Authenticate)
  → rpc-router validates method + params; resolves skillId (metadata) or defaults to tutorial-chat
  → task-store.put(taskId, {status:"submitted", contextId})            (cds-caching, TTL ~15 min)
  → message-adapter: A2A message → {messages:[{role:"user",content}], pageContext:{kind:"generic"}}
  → open SSE response; task-store → status:"working"
  → streamChat({res: sseShim, ...buildChatInvocation(pageContext,user), messages, user})
       chat-orchestrator emits internal SSE frames; message-adapter re-maps each:
         {type:'delta'}  → TaskStatusUpdateEvent(state:"working") + incremental message part
         {type:'tool'}   → status update w/ tool name in metadata (optional)
         card-frames     → TaskArtifactUpdateEvent (tutorial-cards etc. as structured artifacts)
         {type:'done'}   → final message artifact + TaskStatusUpdateEvent(state:"completed", final:true)
         {type:'error'}  → TaskStatusUpdateEvent(state:"failed")
  → task-store.put(taskId, terminal snapshot)
```

**Reuse boundary:** `streamChat` already accepts `res` and writes `data:` frames. A2A passes
a thin **SSE writer shim** (a `res`-like object) so `message-adapter` transforms each internal
frame into an A2A JSON-RPC SSE event before it hits the wire — **no change to `streamChat`
internals**.

### B. `message/send` (sync) + `tasks/get` / `tasks/cancel`

- `message/send` for a **tool skill** → run the handler to completion, return a `Task`
  with `status:"completed"` + result as message/artifact. No SSE.
- `message/send` for the **chat skill** → run `streamChat` to completion server-side
  (buffer frames via the adapter), return one completed `Task`.
- `tasks/get` → `task-store.get(taskId)` → snapshot; cross-instance coherent via cds-caching.
- `tasks/cancel` → mark `canceled` in store + abort the local `streamChat` `signal` if the
  task is running on this instance.

**Skill selection:** the A2A message may carry a `skillId` (in `message.metadata` /
`configuration`). Present → dispatch to that skill; absent → default to `tutorial-chat`
(which internally routes to all tools). Tool skills are therefore just *direct* entrypoints
to the same handlers the chat LLM already calls — low incremental risk.

## Agent Card (served at `/.well-known/agent-card.json`)

```jsonc
{
  "protocolVersion": "0.3.0",
  "name": "SAP Tutorials Learning Agent",
  "description": "Answers questions about SAP developer tutorials, missions, and learning paths; searches the tutorial catalog; reasons over the tutorial knowledge graph; and reports a signed-in developer's progress.",
  "url": "https://<host>/a2a",
  "preferredTransport": "JSONRPC",
  "version": "1.0.0",
  "provider": { "organization": "SAP Tutorials (developers.sap.com)", "url": "https://developers.sap.com" },
  "capabilities": { "streaming": true, "pushNotifications": false },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "securitySchemes": {
    "xsuaa": { "type": "oauth2", "flows": { "clientCredentials": { "tokenUrl": "<xsuaa-token-url>", "scopes": { "Tutorial.MCP": "MCP/A2A protocol access" } } } }
  },
  "security": [{ "xsuaa": ["Tutorial.MCP"] }],
  "skills": [
    { "id": "tutorial-chat",  "name": "Ask about SAP tutorials",
      "description": "Conversational Q&A over SAP developer tutorials, missions, and learning paths. Runs the full agentic loop (search, KG, progress).",
      "tags": ["chat","tutorials","learning","rag"],
      "examples": ["How do I get started with CAP?","What should I learn after the HANA Cloud tutorial?"] },
    { "id": "search-tutorials", "name": "Search tutorials",
      "description": "Semantic/keyword search over the tutorial catalog.",
      "tags": ["search"], "examples": ["Find tutorials about Fiori elements"] },
    { "id": "user-progress",   "name": "Get my learning progress",
      "description": "The signed-in developer's tutorial/mission progress. Requires the caller to forward the end-user's identity token; returns empty otherwise.",
      "tags": ["progress","personal"], "examples": ["Which tutorials have I completed?"] },
    { "id": "knowledge-graph", "name": "Explore the learning graph",
      "description": "Concept expansion and learning-path reasoning over the tutorial knowledge graph.",
      "tags": ["knowledge-graph","paths"], "examples": ["Show a learning path to RAP"] },
    { "id": "tutorial-steps",  "name": "Fetch a tutorial step",
      "description": "Return a specific tutorial step's HTML so a central agent can quote exact instructions.",
      "tags": ["content"], "examples": ["Show step 3 of cap-getting-started"] }
  ]
}
```

Base URL, `tokenUrl`, and disabled-state are injected at build time. When `A2A_ENABLED=false`
the card still serves for discovery but signals unavailability.

## Consumption prompt / explanation

Delivered three ways (the issue's "consumption prompt and explanation"):

1. **In the card** — `description` + per-skill `description`/`examples` are what a central
   Joule reads to decide routing.
2. **Integration guide** `docs/.../a2a-instructions.md`, served at
   **`/.well-known/a2a-instructions.md`** (public): how to obtain a `Tutorial.MCP`-scoped
   token, the JSON-RPC method shapes, when to use chat vs. a specific skill, and worked
   example requests/responses.
3. **Design-doc appendix** (this file) — the canonical "how central Joule consumes this."

## Error handling

All JSON-RPC 2.0 error objects, mirroring the MCP router's codes (`mcp-compose-router.js`):

- Missing/anonymous auth → `-32001` (401) + `WWW-Authenticate: Bearer`.
- Unknown method → `-32601`; bad params / unknown skillId → `-32602`.
- Content-safety refusal / LLM error from `streamChat` → A2A task `state:"failed"` (not a
  transport error).
- `A2A_ENABLED=false` → 503 before dispatch.
- Any handler throw → `-32603` with a correlation id (pattern from
  `mcp-compose-router.js:123-128`); never leak internals.

## Testing

Unit-first (TDD):

- `agent-card.test.js` — card validates required A2A fields; all 5 skills present; URLs
  derived from base; disabled-state signalling.
- `rpc-router.test.js` — method routing, error codes, anonymous reject, kill switch;
  in-memory `@sap/cds` + mocked `streamChat`.
- `message-adapter.test.js` — internal SSE frames → A2A events; A2A message →
  `{messages,pageContext}`.
- `task-store.test.js` — put/get/cancel with the memory cds-caching store (unit config
  already forces memory store via `cds_requires_caching_*` env vars).
- `chat-invocation.test.js` — extraction preserves the `/chat/stream` setup exactly.
- **Hybrid** — one end-to-end against real HANA/cds-caching CDS store verifying `tasks/get`
  is cross-read coherent (guards the multi-instance decision). Uses the `test:hybrid` harness.

## Deploy & operational touchpoints

- **approuter**: add `^/a2a/(.*)$` route (xsuaa + `Tutorial.MCP`, `csrfProtection:false`) to
  `approuter/xs-app.json`, `srv-api` only for v1 (QA channel out of scope). The
  `/.well-known/*` route already covers the card + guide.
- **env**: document `A2A_ENABLED` (default on) in the reference docs.
- **schema**: none — cds-caching CDS store already deployed (post-#1182).
- **`srv-qa` cp-list audit** (CLAUDE.md rule): re-walk transitive `./` imports from
  `srv/lib/a2a/*` (they pull `chat-orchestrator`/`chat-context`/`chat-invocation` + cds-caching,
  all already in the tree) and confirm each is in `.deploy/mta.yaml`'s `srv-qa` `cp` list, OR
  confirm `srv-qa` does not wire A2A (mirrors how srv-qa skips caching).
- **docs**: add `/a2a`, the card path, and the instructions path to
  `docs/developers/operations/testing-endpoints.md`; add an ORD annotation entry in
  `srv/ord-annotations.cds` for `A2aService`.

## Out of scope (v1 / YAGNI)

- Push notifications (`capabilities.pushNotifications:false`).
- `tasks/list`, push-config methods, extended-card auth tier.
- PAT/anonymous A2A tiers (XSUAA only for v1).
- QA channel A2A route.
- Persisting full task history to a HANA entity (cds-caching TTL snapshot suffices).
