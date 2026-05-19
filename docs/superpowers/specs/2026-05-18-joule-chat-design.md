# Joule Chat for the Tutorial Platform

## Problem

The tutorial site's header has a Joule icon, but it currently opens an unrelated external page. The platform needs an embedded AI chat assistant that helps users find tutorials, understand the tutorial they're currently reading, and navigate missions and groups — backed by SAP AI Core via the Generative AI Hub. The whole feature must be wrappable in a kill switch so production cost or quality issues can be resolved without a redeploy.

## Decision

Build a streaming chat experience in the existing Hugo shellbar using the SAP Cloud SDK for AI (`@sap-ai-sdk/orchestration`), a dedicated CAP service shell for ORD/audit registration, and a custom Express SSE endpoint for the streaming hot path. Persist a singleton `ChatSettings` entity in HANA whose `enabled` flag governs both UI visibility and backend acceptance — flipped from a new admin app under the existing admin-shell.

The `@cap-js/ai` plugin is **not** used: it ships UI Recommendations (RPT-1) and AI Core admin entities, not chat completions. The orchestration SDK is the canonical path for LLM chat through SAP AI Core.

## Scope

**In scope (v1):**
- Streaming chat with one configurable LLM deployment
- Page-context-aware system prompt for 5 page kinds: `tutorial`, `search`, `mission`, `group`, `generic`
- RAG via a single `searchTutorials` tool delegating to the existing `SearchService`
- Logged-in users only; anonymous users see no Joule icon
- Session-only conversation history (browser `sessionStorage`)
- Per-instance in-memory rate limit, configurable max requests/user/day
- Master kill switch + 3 config knobs (deployment ID, rate limit, banner text), administered from a new Fiori Elements page in the admin shell
- Telemetry via existing `@cap-js/telemetry` OTLP pipeline (metadata only — no conversation content)

**Explicitly out of scope:**
- Persistent server-side conversation history
- Per-user / percentage-based rollout
- Multi-instance coordinated rate limiting (HANA-backed counter)
- Daily cost-aggregation jobs
- Multi-modal input (file upload, image)
- Streaming a tool call's intermediate state — only final tool result is surfaced

## Design

### Architecture

```
hugo header.html
  └─ Joule button (existing) — visibility gated by /api/ChatConfig
       └─ #joule-panel partial — wired by hugo/static/js/joule.js
            └─ POST /chat/stream (text/event-stream)

CAP backend (tutorials-srv)
  ├─ db/schema.cds                  ChatSettings entity (singleton)
  ├─ db/data/...ChatSettings.csv    seed row (enabled=false)
  ├─ srv/admin-service.cds          @UI annotations + @odata.singleton projection
  ├─ srv/admin-service.js           READ handler ensures singleton row exists
  ├─ srv/developer-service.cds      public ChatConfig projection (enabled, bannerText)
  ├─ srv/chat-service.cds           service shell @path:'/chat' (ORD/audit only)
  ├─ srv/chat-service.js            no-op handler
  ├─ srv/lib/chat-orchestrator.js   orchestration SDK + tool dispatch + SSE writer
  ├─ srv/lib/chat-context.js        page-kind → system prompt builder
  ├─ srv/lib/chat-rate-limit.js     in-memory rolling 24h counter
  └─ srv/server.js (modify)         registers POST /chat/stream

External: SAP AI Core Generative AI Hub (orchestration deployment)
Service binding: aicore (cf service: aicore, plan: extended)

UI (admin)
  └─ app/admin/joule-settings/      Fiori Elements ObjectPage (singleton)
       └─ registered as componentUsage in app/admin-shell, side-nav entry "Joule Chat"
```

### Data Model

`db/schema.cds`:

```cds
entity ChatSettings : cuid, managed {
  enabled              : Boolean default false;
  deploymentId         : String(100);     // AI Core orchestration deployment ID
  maxRequestsPerUser   : Integer default 100;
  bannerText           : String(500);     // optional notice, e.g. "Joule is in beta"
}
```

`managed` aspect supplies `createdAt/createdBy/modifiedAt/modifiedBy` for audit. `cuid` keeps the key shape consistent with other admin entities even though we treat the entity as a singleton.

Seeded via `db/data/com.sap.developers.ims-ChatSettings.csv` with one row `(enabled=false)` so production deploys land safely off.

`db/persistence.cds`:

```cds
annotate ims.ChatSettings with @cds.persistence.journal;
```

Matches the project's pattern for journal-backed admin entities (used by `ImsConfig`, `FeaturedTasks`).

`db/change-tracking.cds`:

```cds
annotate ims.ChatSettings with @changelog;
```

Records every flag flip with who/when, surfaced through the existing changelog admin app.

### Singleton Behavior

`srv/admin-service.cds`:

```cds
@odata.singleton
@requires: 'Admin'
entity ChatSettings as projection on ims.ChatSettings;
```

The explicit `@requires: 'Admin'` guards reads and writes in case the service-level annotation changes — defense in depth.

`srv/admin-service.js` registers a `before READ` for `ChatSettings` that ensures exactly one row exists, inserting the seeded defaults if the table is empty. Subsequent reads always return that row. The seed CSV makes this near-zero-cost — the safeguard is for fresh dev databases.

### Public Config Projection

Added to `srv/developer-service.cds` (the existing service at `@path: '/api'`) so the resource address is `/api/ChatConfig`:

```cds
@requires: 'any'
@readonly
entity ChatConfig as projection on ims.ChatSettings { enabled, bannerText };
```

Annotated `@requires: 'any'` so it's reachable without auth (header script needs to know whether to render the icon). Only the two fields safe to expose are projected — `deploymentId` and `maxRequestsPerUser` never leave the server.

### Frontend: Page Context Detection

`hugo/layouts/_default/baseof.html` extends the existing `<html>` data attributes:

```html
<html
  data-cap-base="..."
  data-page-kind="{{ if .IsHome }}search{{ else if eq .Type "tutorials" }}tutorial{{ else if eq .Type "missions" }}mission{{ else if eq .Type "groups" }}group{{ else }}generic{{ end }}"
  data-page-slug="{{ .Params.slug }}"
  data-page-title="{{ .Title }}"
  data-page-tags="{{ delimit .Params.tags "," }}"
  data-page-step-count="{{ .Params.stepCount }}"
>
```

`joule.js` reads these on every send, plus `?q=` and active facet checkboxes when on `search`, plus the in-view step (already tracked by `progress-bar.html`) when on `tutorial`.

### Frontend: Chat Lifecycle

1. **Boot.** `header.html` script `fetch('/api/ChatConfig')`. If `enabled === false`, removes the Joule `<button>` from the DOM. If enabled, attaches the click handler and stores `bannerText` on `document.documentElement.dataset.jouleBanner`. Result is cached in `sessionStorage` under a versioned key (`joule.config.v1`) for 60 s — flips propagate within a minute without a hard reload, and a future schema change can bump the key to invalidate stale caches cleanly.
2. **Open.** Clicking the button reveals the `#joule-panel` partial. If `sessionStorage["joule.history"]` is empty, render the greeting state ("Hello {firstName}, How can I help you?" using the user object already fetched by the existing avatar code). Otherwise render the saved transcript.
3. **Send.** User types → `joule.js` posts to `/chat/stream` with `{ messages, pageContext }`, reads SSE chunks via `fetch().body.getReader()`, appends `delta` content to the in-progress assistant bubble, surfaces `tool` events as a "Searching for X…" chip, and persists to `sessionStorage` on `done`.
4. **Errors.** Mapped per the table in §"Error Handling" below; never silent.

The greeting and panel layout follow the screenshots: gradient diamond loading state, then a dark-purple panel anchored to the top-right of the viewport with the input pinned to the bottom.

### Backend: SSE Endpoint

Registered in `srv/server.js` on `cds.on('bootstrap', app => …)` — same lifecycle as the existing `/content/tutorials/:slug` route:

```
POST /chat/stream
  1. Read ChatSettings (single row). If !enabled → 503 {error:"disabled"}
  2. Read cds.context.user. If anonymous (DefaultUser) → 401
  3. chat-rate-limit.check(user.id, settings.maxRequestsPerUser) → 429 if over
  4. system = chat-context.buildSystemPrompt(pageContext, user)
  5. orchestrator.streamChat({ system, messages, tools: [searchTutorials] })
       → for each token chunk: res.write(`data: ${JSON.stringify({type:"delta",content})}\n\n`)
       → for each tool call: res.write(`data: ${JSON.stringify({type:"tool",name,args})}\n\n`)
       → on done: res.write(`data: ${JSON.stringify({type:"done"})}\n\n`); res.end()
       → on error: res.write(`data: ${JSON.stringify({type:"error",retryable})}\n\n`); res.end()
```

Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`. The flag is read fresh on each request — no module-level cache — so admin changes apply within one round-trip.

### Backend: System Prompt

Three layers, assembled by `srv/lib/chat-context.js`:

**Layer 1 — Persona & hard scope** (constant):

> You are Joule, an AI assistant embedded in the SAP Tutorial Platform. You ONLY answer questions about SAP tutorials and directly related topics (SAP technologies, the tutorial content, how to complete a step). If asked about anything else, politely redirect: "I can only help with SAP tutorials. Want me to find one about <topic>?". Never invent tutorial slugs, step numbers, or URLs. If you don't know, call the searchTutorials tool or say so.

**Layer 2 — Page specialization** (varies by `pageContext.kind`):

| Kind | Injected | Behavior |
|---|---|---|
| `tutorial` | title, description, tags, prerequisites, total steps, current step | Prefer answering about THIS tutorial; cite step numbers; only call RAG if user asks about a different tutorial |
| `search` | current query, active filters | Always call `searchTutorials` first; summarize 1–3 best matches with slug + one-line reason |
| `mission` / `group` | title + ordered list of contained tutorials | Explain the path, prerequisites, suggest next logical tutorial |
| `generic` | nothing | Use `searchTutorials` liberally |

**Layer 3 — User context** (only when authenticated): `The user's name is {firstName} {lastName}. Use it sparingly.`

### Backend: RAG Tool

Single tool registered with the orchestration client. Parameters declared as a JSON Schema object so the SDK can pass it through to the model unchanged:

```js
{
  name: "searchTutorials",
  description: "Search the SAP tutorial catalog. Use when the user asks to find a tutorial, or when answering a question that needs context from a tutorial other than the current one.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "keywords to search" },
      tags:  { type: "array",  items: { type: "string" }, description: "optional tag filters (e.g. ['hana','cap'])" },
      type:  { type: "string", enum: ["tutorial","mission","group"], description: "optional kind filter" }
    },
    required: ["query"]
  }
}
```

Implementation invokes `SearchService.SearchableItems` with `$search=<query>` and `$top=5`, optionally filtered by `tags` and `type`, and returns `{slug,title,description,type,primaryTag}[]`. Errors return `{error:"search_failed",hits:[]}` so the model can recover and answer without grounding.

Tool calls are surfaced to the UI via `{type:"tool"}` SSE events for transparency ("Searched for HANA Cloud") and debug-ability.

### Admin UI

A new entry in the existing `app/admin-shell` side-nav, labeled **"Joule Chat"** with `sap-icon--da` (matching the header), positioned between Operations and Privacy.

Implementation: a new Fiori Elements ObjectPage app at `app/admin/joule-settings/` consuming `AdminService.ChatSettings`. With `@odata.singleton` the binding addresses the entity directly without a key — no list view needed. Edit-only ObjectPage with four fields:

- `enabled` (toggle, prominent)
- `deploymentId` (text input)
- `maxRequestsPerUser` (numeric input)
- `bannerText` (multi-line text)

Plus a read-only footer showing `modifiedBy` / `modifiedAt`. Registered as a `componentUsage` in `app/admin-shell` — pattern matches the existing 10 admin apps.

### Authorization

Defense in depth — three independent gates:

1. **UI** — Joule button is removed from the DOM when `/api/ChatConfig` returns `enabled=false` or fails. Anonymous users never get past this point because the click handler redirects to `/login`.
2. **Endpoint** — `/chat/stream` re-checks `ChatSettings.enabled` on every request and returns 503 when off. `cds.context.user.id` must be present (set by approuter JWT propagation through CAP's XSUAA auth middleware).
3. **Service** — `chat-service.cds` annotated `@requires: 'authenticated-user'`; `admin-service.cds` `ChatSettings` entry already inherits the `Admin` requirement.

The `@cap-js/audit-logging` infrastructure is **not** extended to ChatSettings (no `@PersonalData`) — admin operations are tracked through the existing `@cap-js/change-tracking` plugin.

### Rate Limiting

`srv/lib/chat-rate-limit.js`:

- `Map<userId, { count, windowStart }>`
- Rolling 24 h window, lazily reset on next call after expiry
- On each request: `if count >= settings.maxRequestsPerUser throw RateLimitError`
- Cleared on srv restart (acceptable: deploys reset budgets)

Per-instance only. If `tutorials-srv` scales beyond 1 instance the effective ceiling becomes `maxRequestsPerUser × instanceCount`. The admin app's `maxRequestsPerUser` field gets a `@description` annotation noting this multiplication so operators size the limit correctly. HANA-backed counter is a one-file change later if observed limits need to be tighter.

### Observability

- **Telemetry span** per chat request via existing `@cap-js/telemetry`: `name="chat"`, attributes `user.id` (SHA-256-hashed for aggregability without PII), `page.kind`, `model.deployment`, `tokens.in`, `tokens.out`, `tool.calls.count`, `outcome ∈ {ok, error, rate_limited, content_filtered}`. Flows through the existing OTLP exporter.
- **Structured info-level log line** with the same fields plus duration. Greppable for ad-hoc cost trend analysis.
- **No conversation content** is logged — only metadata. Avoids PII concerns and keeps audit-logging scope unchanged.

### Error Handling

| Where | Failure | UX | Server response |
|---|---|---|---|
| `/api/ChatConfig` fetch | Network error / 5xx | Hide Joule button (fail-safe) | n/a |
| `/chat/stream` | Flag off | Hide button, toast "Joule is currently unavailable" if open | `503 {error:"disabled"}` |
| `/chat/stream` | Anonymous | Redirect to `/login?returnTo=...` | `401` |
| `/chat/stream` | Over rate limit | In-bubble error: "You've reached today's chat limit." | `429 {error:"rate_limit",retryAfter}` |
| `/chat/stream` | AI Core 5xx / timeout | In-bubble: "Something went wrong. Please try again." + Retry button | SSE `{type:"error",retryable:true}` then close |
| `/chat/stream` | Content filter triggered | In-bubble: "I can't help with that. Try asking about SAP tutorials." | SSE `{type:"error",reason:"content_filter"}` |
| Tool call error | `SearchService` throws | Tool returns `{error:"search_failed",hits:[]}`; model proceeds without grounding | n/a |
| `joule.js` SSE parse | Malformed event | Console-log, drop chunk, continue | n/a |

No automatic client retry — a Retry button on failed bubbles reposts the same message on user action.

If reading `ChatSettings` itself errors (HANA hiccup), the endpoint treats it as `enabled=false` (fail-closed) — better silent than inconsistent.

### Service Binding

A new `aicore` service instance bound to `tutorials-srv`. MTA modifications:

```yaml
# .deploy/mta.yaml — resources
- name: tutorial-system-aicore
  type: org.cloudfoundry.managed-service
  parameters:
    service: aicore
    service-plan: extended

# tutorials-srv module requires
- name: tutorial-system-aicore
```

Local hybrid dev: `cds bind` to the deployed aicore instance, same pattern as the existing HANA hybrid setup. The orchestration SDK auto-discovers credentials from `VCAP_SERVICES`.

### Testing

**Unit** (`test/unit/chat-*.test.js`, in-memory SQLite):

| File | Coverage |
|---|---|
| `chat-context.test.js` | `buildSystemPrompt(pageContext, user)` produces expected strings for each of the 5 page kinds; handles missing fields gracefully |
| `chat-rate-limit.test.js` | Counter increments, resets after window expiry, throws when over limit, reads fresh from injected settings |
| `chat-orchestrator.test.js` | Mocked orchestration SDK; verifies tool registration, `searchTutorials` dispatches to SearchService, streaming chunks → SSE events, errors → `{type:"error"}` |
| `chat-config-serve.test.js` | `GET /api/ChatConfig` returns `{enabled,bannerText}`; never leaks `deploymentId` or `maxRequestsPerUser` |

**Hybrid** (`test/hybrid/chat-settings.test.js`, real HANA via `cds bind`):

- `ChatSettings` singleton row deploys with seed values
- Admin update of `enabled` persists; change-tracking journal records the flip
- `GET /api/ChatConfig` reflects the live row

**Smoke** (`test/smoke/chat.test.js`, deployed URL):

- `/api/ChatConfig` responds with JSON
- `/chat/stream` returns 401 unauthenticated
- `/chat/stream` returns 503 when flag off
- *(opt-in via `JOULE_SMOKE_ENABLED=true`)* end-to-end chat with "What is CAP?", expects non-empty stream completing in ≤30 s

No real AI Core calls in unit or hybrid; orchestration client mocked everywhere except the opt-in smoke path. Keeps CI fast, deterministic, and free.

## Security Considerations

- Joule button visible only after authenticated `/api/ChatConfig` check; clicking when logged out redirects to login.
- `/chat/stream` requires authenticated user; rejects on missing JWT (approuter strips/forwards).
- `deploymentId` and `maxRequestsPerUser` never exposed to the client — only `enabled` and `bannerText` are projected publicly.
- No conversation content logged or persisted server-side; transcripts live only in browser `sessionStorage`.
- RAG tool only reads from the public `SearchService` — no privileged data is reachable.
- Content-filter outcomes from orchestration are surfaced as user-facing errors, not stack traces.
- `ChatSettings` writes are gated by the existing `Admin` XSUAA scope and audited via change-tracking.

## Operational Notes

- **Default state on first deploy is OFF.** The seed CSV has `enabled=false`. After binding the `aicore` service and provisioning a deployment, an admin sets `deploymentId` and toggles `enabled` to launch.
- **Killing the feature** is a one-toggle operation in the admin UI and propagates to all clients within ~60 s (one `sessionStorage` TTL); the backend rejects new requests immediately.
- **Switching models** (e.g., from `gpt-4o-mini` to `gpt-4o`) is just changing `deploymentId` — no redeploy.
- **Local dev with hybrid binding** requires `cds bind --to aicore` once an aicore instance is provisioned in the dev space.

## Implementation Order

A suggested build sequence (refined in the implementation plan):

1. CDS model: `ChatSettings` entity, projection, seed CSV, persistence/change-tracking annotations
2. Public `ChatConfig` projection + smoke test
3. `chat-context.js` system-prompt builder + unit tests
4. Admin UI app (Fiori Elements ObjectPage) + admin-shell registration
5. `chat-rate-limit.js` + unit tests
6. `chat-orchestrator.js` with mocked SDK + unit tests
7. `srv/server.js` SSE endpoint
8. Hugo header changes + `joule.js` + page-context wiring
9. MTA aicore binding + hybrid wiring docs
10. Hybrid + smoke tests
