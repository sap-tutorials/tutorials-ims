# MCP Server for tutorials-ims — Phase 2 Design

**Date:** 2026-07-08
**Author:** Tom (via superpowers:brainstorming)
**Status:** Approved — pending user read-through of the written spec
**Related:** issue [#1105](https://github.com/sap-tutorials/tutorials-ims/issues/1105); Phase 1 PR [#1011](https://github.com/sap-tutorials/tutorials-ims/pull/1011); Phase 1 design [`2026-07-05-mcp-server-design.md`](2026-07-05-mcp-server-design.md)

## Summary

Add the authenticated tier to the hosted MCP server. Phase 1 shipped 8 anonymous curated tools at `/mcp/*`. Phase 2 opens `/mcp-auth/*` (OAuth 2.1 + PKCE via XSUAA) and `/mcp-pat/*` (Personal Access Tokens for headless agents), lands 8 authenticated curated tools on `DeveloperService` and `HomepageService`, and introduces a shared step-HTML slicer that unblocks per-step reads for MCP callers *and* retrofits two existing whole-tutorial code paths (Joule's `checkStepCode` and the server-side chat-context fallback).

No new MTA module, no new subaccount, one new CDS entity (`PATs`), one new approuter route family, one new middleware, one new shared library.

## Goals

1. Authenticated MCP clients (Claude Desktop via OAuth, Claude Code + CI + VS Code extensions via PATs) can read the signed-in user's progress, mark steps complete, get personalized recommendations, and fetch per-step tutorial HTML — with `req.user` propagated end-to-end via CAP's existing `@requires` enforcement.
2. Retire the two "whole tutorial dumped to the LLM" code paths (`code-check-step-loader.defaultLoadStepText`, `chat-context` server-side fallback) by consolidating on one shared `srv/lib/tutorial-step-slicer.js`. Silent quality improvement for Joule's `checkStepCode` tool.
3. Zero net-new business logic: every authenticated MCP tool is a thin CAP function calling existing service handlers. OData and MCP share code paths.
4. Static, cacheable OAuth discovery docs — no new Node handler, no XSUAA-availability dependency for the discovery step.

## Non-Goals

- **KG deep-dive tools** (`kg_shared_concepts`, `kg_neighborhood`) — Phase 3 (#1106).
- **Admin curation / community-promotion / content-publish trigger tools** — Phase 3.
- **MCP resources and prompts primitives** — Phase 3.
- **External-content proxies** (Learning Journeys, Discovery Center) — deferred.
- **Dynamic client registration (RFC 7591)** — XSUAA doesn't support it natively; standing up a proxy is a mini-product. Shared public client_id + PKCE covers every real-world MCP client.
- **Per-token rate limits** — IP-layer throttling only in Phase 2. Follow-up if abuse appears.
- **Programmatic PAT mint via API** — admin-UI-only in Phase 2.
- **Fine-grained per-tool token scopes** — coarse `read` / `write` only.
- **Retiring anything from Phase 1.** Phase 1's `/mcp/*` surface is unchanged.

## Architecture

The Phase 2 additions layer onto the existing tutorials-srv without a new deployable. Three MCP routes now coexist at the approuter, all forwarding to the same in-process `@cap-js/mcp` adapter — the routes differ only in how `req.user` is populated.

```
Claude Desktop / Code / custom agent
         │  HTTPS  (Streamable HTTP + SSE, MCP 2025-06)
         ▼
approuter  (tutorials-approuter)
   ├── /.well-known/oauth-authorization-server   authenticationType: none   → static discovery JSON
   ├── /.well-known/oauth-protected-resource     authenticationType: none   → static discovery JSON
   ├── /mcp/*         authenticationType: none                              → srv-api  (Phase 1, unchanged)
   ├── /mcp-pat/*     authenticationType: none                              → srv-api  (Phase 2, PAT middleware resolves req.user)
   └── /mcp-auth/*    authenticationType: xsuaa  scope: Tutorial.MCP        → srv-api  (Phase 2, browser OAuth flow)
                                                                              csrfProtection: false on all routes
         │
         ▼
tutorials-srv  (CAP Node.js, @cap-js/mcp@1.1.x)
   │
   ├── srv/lib/mcp-pat-middleware.js
   │     Bearer pat_...  → SHA-256 hash lookup → resolves synthetic req.user → next()
   │     Bearer <JWT>    → passthrough (CAP's XSUAA strategy handles it)
   │
   ├── DeveloperService     @path: '/api'
   │     @protocol: ['odata', 'graphql', 'mcp']
   │     Adds 8 curated @requires:'authenticated-user' functions
   │     + get_tutorial_step also mounted on SearchService (anonymous /mcp/*)
   │
   ├── HomepageService      @protocol: ['odata', 'graphql', 'mcp']  (Phase 1)
   │     +2 authenticated recommendation functions
   │
   ├── srv/lib/tutorial-step-slicer.js  (NEW — shared)
   │     ├── consumed by DeveloperService.get_tutorial_step (Phase 2)
   │     ├── consumed by SearchService.get_tutorial_step (Phase 2 anonymous)
   │     ├── consumed by srv/lib/code-check-step-loader.js (retrofit — Joule's checkStepCode)
   │     └── consumed by srv/lib/chat-context.js server-side fallback (retrofit)
   │
   └── db/mcp-pats.cds → PATs entity
         Fiori Elements page mounted at /admin-ui/#pats
```

Key architectural properties:

- **One process, one adapter, three routes.** `@cap-js/mcp` runs unchanged from Phase 1; the adapter is agnostic to which URL served the request. `@requires` on CDS functions enforces before dispatch on all three routes.
- **`req.user` resolution converges.** Every handler starts with `const dbUser = await resolveDbUser(req)` — the existing helper from `srv/lib/user-resolver.js`. JWT path uses CAP's XSUAA strategy; PAT path uses `mcp-pat-middleware.js` to install a synthetic `req.user`; downstream code cannot tell them apart.
- **Shared slicer removes duplication.** Three existing/new callers converge on one file: MCP `get_tutorial_step`, `code-check-step-loader.defaultLoadStepText`, and `chat-context` server-side fallback. The `_stepNumber` underscore in `code-check-step-loader.js` and its "TODO Phase 4" comment are deleted.
- **Sidecar escape hatch stays open** (deferred from Phase 1). If MCP-authenticated traffic squeezes the srv Node loop, lift the MCP-annotated services into a `tutorials-mcp` MTA module. Same code, different memory quota, different approuter route. Config change, not a rewrite.

## OAuth 2.1 + Discovery Documents

### The problem the discovery doc solves

MCP 2025-06 clients do this on first connect to a protected server:

1. Hit `/mcp-auth/*` unauthenticated → server returns `401 WWW-Authenticate: Bearer resource_metadata="..."`.
2. Fetch the resource-metadata URL to find the authorization server.
3. Fetch `/.well-known/oauth-authorization-server` to learn `authorization_endpoint` and `token_endpoint`.
4. Open the user's browser, do authorization-code + PKCE, get back a JWT.
5. Retry the MCP call with `Authorization: Bearer <jwt>`.

Steps 1–4 work without new endpoint code because we serve static discovery docs from the approuter's static tree.

### `/.well-known/oauth-protected-resource` (MCP 2025-06 Resource Server discovery)

```json
{
  "resource": "https://developers.sap.com/mcp-auth",
  "authorization_servers": ["https://developers.sap.com"],
  "scopes_supported": ["Tutorial.MCP"],
  "bearer_methods_supported": ["header"]
}
```

### `/.well-known/oauth-authorization-server` (RFC 8414)

```json
{
  "issuer": "https://<tenant>.authentication.<region>.hana.ondemand.com",
  "authorization_endpoint": "https://<tenant>.authentication.<region>.hana.ondemand.com/oauth/authorize",
  "token_endpoint": "https://<tenant>.authentication.<region>.hana.ondemand.com/oauth/token",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["openid", "Tutorial.MCP"],
  "token_endpoint_auth_methods_supported": ["none"]
}
```

Both files are templated per-environment during `mbt build` from `deploy/<env>.mtaext` variables (the XSUAA tenant/region already surface there for the sub-app roles).

### XSUAA changes

`xs-security.json` **and** `.deploy/xs-security.json` — both files, memory rule ([[feedback-xs-security-dual-file-drift]]):

- New scope `$XSAPPNAME.Tutorial.MCP` — "MCP protocol access — authenticated tutorial reads/writes".
- New role template `TutorialMCP` binding `Tutorial.MCP + Everyone`.
- New role collection `Tutorials MCP Users`.
- New OAuth client `sb-tutorials-mcp` in the XSUAA instance config:
  - `redirect-uris: ["https://developers.sap.com/callback", "http://localhost/*", "http://127.0.0.1/*", "mcp://*"]`
  - `oauth2-configuration.token-validity: 3600`
  - `refresh-token-validity: 2592000` (30 days)
  - No client secret (`authorities-inheritance: false`, PKCE-only)

`http://localhost/*` and `http://127.0.0.1/*` are what Claude Desktop's local callback server uses; `mcp://*` is the emerging MCP-native scheme.

### Approuter route stack (order matters — most-specific first)

```
/.well-known/oauth-protected-resource       none   static
/.well-known/oauth-authorization-server     none   static
/mcp/*                                      none   → srv-api  (Phase 1)
/mcp-pat/*                                  none   → srv-api  (Phase 2, PAT middleware)
/mcp-auth/*                                 xsuaa  → srv-api  (Phase 2, JWT, scope: Tutorial.MCP)
```

The `/mcp-auth/*` route sets `scope: "$XSAPPNAME.Tutorial.MCP"` so users without the role collection get 403 at approuter, before the request ever touches srv. Approuter forwards the JWT unchanged; `@cap-js/mcp` picks it up like any other CAP OData call and `@requires: 'authenticated-user'` on handlers just works.

### Rationale for static discovery docs

- Response time ≤50ms even under load.
- No XSUAA-reachability dependency for the discovery step.
- Trivially cacheable at a CDN in front (out of scope for Phase 2; future-friendly).
- No Node handler = no failure modes.

### Rationale against dynamic client registration

XSUAA doesn't support RFC 7591 natively. Standing up a proxy that does would be a mini-product on its own. The shared public `sb-tutorials-mcp` client + PKCE is the pragmatic path; every real-world MCP client we care about (Claude Desktop, Code, `mcp-remote`) supports being pointed at a pre-registered client_id.

### Failure modes handled

- **XSUAA down.** Approuter serves the static discovery docs fine; token endpoint call fails at the client with a clean OAuth error.
- **Stale JWT.** CAP rejects with 401; MCP client refreshes using the `refresh_token` from the initial exchange.
- **Missing role collection.** 403 at approuter with `WWW-Authenticate: Bearer error="insufficient_scope"`; curated `403.html` explains how to request the `Tutorials MCP Users` collection.

## Authenticated Tool Surface

Eight curated tools on `DeveloperService` (progress reads/writes + step content) and `HomepageService` (recommendations). All `@requires: 'authenticated-user'` — CAP enforces before the handler runs, identically for JWT and PAT auth.

### File placement

- CDS declarations → new `srv/developer-service-mcp.cds` (aspect-extends `DeveloperService`; keeps `developer-service.cds` from ballooning).
- Handlers → new `srv/lib/mcp-developer-tools.js` (one function per exported symbol; wired into `srv/developer-service.js` in a single `srv.on(...)` block, ~20 lines).
- HomepageService additions → declarations in `srv/homepage-service-mcp.cds`, handlers in `srv/lib/mcp-homepage-tools.js`.

### Reads (5)

| Tool | Args | Returns | Backed by |
|---|---|---|---|
| `get_my_tutorials(status?, limit?)` | `status: 'in_progress'\|'completed'\|'all'` (default `all`), `limit ≤ 50` | array `{ slug, title, status, completedSteps[], totalSteps, lastActivityAt, attemptNumber }` | Existing `Tutorials` projection + `TaskRecords` aggregation via new `srv/lib/mcp-progress-store.js` (private helper). |
| `get_my_missions(status?, limit?)` | same shape | array `{ slug, title, status, completedCount, totalCount, nextTutorialSlug }` | Existing `Missions` + `CompletionPaths` + the mission-progress helper `/api/missions` uses today. |
| `get_my_events(when?, limit?)` | `when: 'upcoming'\|'registered'\|'past'` (default `upcoming`), `limit ≤ 50` | array `{ slug, name, eventType, startDate, endDate, registered }` | Existing `Events` projection + registration lookup. |
| `get_my_completed_steps(slug)` | `slug` | `{ slug, completedSteps: [Integer], attemptNumber, lastActivityAt }` | Direct read on `TaskRecords`. |
| `get_tutorial_step(slug, stepNumber)` | `slug`, `stepNumber ≥ 1` | `{ slug, stepNumber, stepTitle, html, textLength, totalSteps }` | Shared `srv/lib/tutorial-step-slicer.js`. **Also mounted anonymously on `SearchService`** (route `/mcp/*`) — published tutorial HTML is already public content, so this closes Phase 1's "step-HTML deferred" item as a Phase-2 side-effect at zero extra design cost. The same handler symbol is exposed on both services; enforcement is `@requires: 'any'` on the SearchService mount, `@requires: 'authenticated-user'` on the DeveloperService mount. |

### Writes (2)

| Tool | Args | Returns | Backed by |
|---|---|---|---|
| `complete_step(slug, stepNumber)` | slug, stepNumber | `{ completedSteps[], points }` | Passthrough to existing `DeveloperService.completeStep` action — same handler, same audit event. |
| `reset_tutorial_progress(slug)` | slug | `{ newAttemptNumber, previousAttemptCompletedAt, supersededRecordCount }` | Passthrough to existing `resetTutorialProgress` action; emits the same `TutorialProgressReset` audit event with an added `tokenSource` field. |

### Recommendations (2) — on HomepageService

| Tool | Args | Returns | Backed by |
|---|---|---|---|
| `get_my_recommended_tutorials(limit?)` | `limit ≤ 20` | array `{ slug, title, rationale, tags[] }` | Existing `HomepageForYou` computation keyed to `req.user`. |
| `get_my_recommended_missions(limit?)` | `limit ≤ 10` | array `{ slug, title, rationale, tutorialCount, completedCount }` | Same computation, mission arm. |

### Doc-comment discipline (LLM-facing)

Every function gets `/** ... */` above its CDS declaration — first sentence is the tool description the LLM sees; `@param` lines become argument descriptions in the tool's JSON schema. Phase 1 established this pattern; Phase 2 sticks to it. Contract test enforces "non-trivial description" (≥40 chars, no boilerplate substrings).

### Argument validation

CAP's CDS type system covers required/optional and type checks for free. Range checks (`limit ≤ 50`, `stepNumber ≥ 1`, `status ∈ {...}`) go in a shared `srv/lib/mcp-arg-validators.js` — one exported `assertRange({limit, min, max})` etc., called at the top of each handler. One file so the "did we clamp?" audit is a single grep.

### `req.user` handling

Every handler starts with `const dbUser = await resolveDbUser(req)` — the existing helper in `srv/lib/user-resolver.js` (the one the [[silent-user-resolution-hides-token-bugs]] memory-fact WARN-logs). No handler talks to `req.user.id` directly, so PATs (whose middleware injects a synthetic `req.user`) don't need to bypass anything.

### Contract test extension

`test/unit/mcp-contract.test.js` grows from 36 to ~90 assertions — every new tool must (a) enumerate in `tools/list` at the correct route(s), (b) have a description ≥40 chars, (c) have all args in `inputSchema.properties` with types matching CDS, (d) `annotations.readOnlyHint: true` for the 5 reads. Blocking CI check — Phase 1 established this as the single strongest guard for LLM UX.

### Deliberate scope-outs

- No `submit_ai_quiz_answer` — quiz submission is Devtoberfest-shaped and not a general-tutorial primitive.
- No `set_khoros_link` — Community linking is a browser-only SSO handshake.
- No `join_devtoberfest` — event-shaped, phase 3 territory.
- No mission-level "mark complete" — missions are completion-driven; no direct write.

## Shared Step-HTML Slicer

Three existing/new callers converge on one shared helper. Phase 1 explicitly deferred step-HTML slicing; two other code paths were dumping whole tutorials to the LLM as a workaround. Phase 2 consolidates.

### `srv/lib/tutorial-step-slicer.js`

```js
// Cache key: `${slug}::${activeManifestVersion}`  → invalidates on publish.
// Value:     { steps: Map<stepNumber, { html, text, title }>, totalSteps }
// LRU: 200 slugs × ~50KB avg = ~10MB RAM ceiling.

export async function sliceStep(slug, stepNumber);       // → {html, text, stepTitle, totalSteps} | null
export async function sliceAllSteps(slug);               // → [{stepNumber, title}] | null (metadata only, no bodies)
export function invalidateSlug(slug);                    // called from content-publish hook
```

### Slicing algorithm

Hugo emits per-step content wrapped by `<section class="step" data-step-number="N">` with `<h2 class="step-title">` inside. Parse with `parse5` (already a `@sap/cds` transitive dep — no new package), walk children of `<main class="tutorial-body">`, group by `data-step-number`.

On miss or malformed HTML: `console.warn` + fall back to `<h2>`-boundary split. Phase-1 Hugo output is stable, but the fallback keeps old cached content readable.

`text` field is `stripHtml(html)` — the same logic `code-check-step-loader.stripHtml` uses today, extracted to the slicer for one implementation.

### Loading path

Reuses `content-store.js`'s existing raw-BLOB fetch — that helper already handles the CDS-QL-vs-`db.run()` HANA-BLOB LOB-locator gotcha (see [[hana-blob-cds-ql]] and `docs/developers/reference/tutorials-ims-gotchas.md`). The slicer receives a `Buffer`, gunzips once, parses once, populates the whole `steps` map, then answers the specific `stepNumber` from the map.

Cost profile:
- Cold: 1 HANA read + gunzip (~50–100ms depending on tutorial size) + parse (~5ms) → cache.
- Warm: Map lookup, ~1μs.

### Cache invalidation

`srv/lib/content-publish-session.js` already emits a `content.published` cds event per slug at commit time (used by other cache-busters). The slicer subscribes and calls `invalidateSlug`. QA-channel publishes hit the same event — no separate path.

### Retrofit site 1: `srv/lib/code-check-step-loader.js`

Full rewrite. Delete the private `stripHtml` copy, delete the `hanaTableName` hand-rolled path (was working around `content-store.js` at the time), delete the `PLAIN_TEXT_CAP = 3000` whole-tutorial dump. `defaultLoadStepText(slug, stepNumber)` becomes:

```js
const slice = await sliceStep(slug, stepNumber);
if (!slice) return null;
return slice.text.slice(0, PLAIN_TEXT_CAP);
```

The `_stepNumber` underscore comes off, the "TODO Phase 4" comment goes with it. Callers (`chat-orchestrator.js:573` → `checkStepCode`) don't change — the API is the same.

**This is a live behavior improvement:** `checkStepCode` today grades submitted code against the whole tutorial's text; after this it grades against exactly the step the user is on. Silently much better prompts.

### Retrofit site 2: `srv/lib/chat-context.js`

The client-populated `ctx.currentStepText` path stays as-is (browser DOM scraping is fastest for the interactive Joule case). Add a server-side fallback: when `ctx.slug && ctx.currentStep && !ctx.currentStepText`, call `sliceStep(ctx.slug, ctx.currentStep)` and use `.text` as `currentStepText`.

Covers three futures at once:
- Programmatic Joule callers (e.g. VS Code extension) that don't have a DOM.
- Client-cached-stale pages where the browser sends `currentStep=5` but the DOM still holds step 3's markup.
- Post-Phase-2 LLM tool-calling flows where the server needs step content directly.

No behavior change for real browser users today (client still fills `currentStepText`; the fallback never fires).

### Retrofit site 3 (new caller): `get_tutorial_step`

Wrapper handler: validate range, call `sliceStep`, return `{ slug, stepNumber, stepTitle, html, textLength, totalSteps }`. `html` is Hugo's rendered HTML — safe to send to LLMs, and MCP clients that render markdown just show it. `textLength` lets clients decide whether to summarize.

**Also mounted anonymously on SearchService** (`/mcp/*`). Published tutorial HTML is public content; the slicer enables what Phase 1 had to defer.

### Metrics

Piggyback on `srv/lib/metrics.js`:
- `tutorial_step_slice_total{outcome=hit|miss|error}` histogram
- `tutorial_step_slice_cache_size` gauge

Same shape Phase 1's `mcp_tool_invocation_total` uses.

### Rollback

Slicer failing everywhere degrades gracefully:
- `get_tutorial_step` returns `req.error(404, 'Step content unavailable')`.
- `checkStepCode` returns `null` (its existing failure mode), the LLM gets a clean "unable to load step" tool result.
- Joule's browser DOM path is untouched, so the interactive experience is safe.

Surgical disable: `KG_STEP_SLICER_ENABLED=false` env var short-circuits `sliceStep` to `null`. Same pattern as the KG flags in the memory index. No redeploy.

## Personal Access Tokens

Alternative to full OAuth for headless agents (CI, VS Code extensions, `mcp-remote`). OAuth handles browser agents; PATs handle everyone else. Both converge on the same handlers.

### Schema — new `db/mcp-pats.cds`

```cds
using { com.sap.developers.ims as ims } from './schema';
using { managed, cuid } from '@sap/cds/common';

namespace com.sap.developers.ims;

entity PATs : cuid, managed {
  user          : Association to Users;          // owner (dbUser.ID)
  name          : String(80)  @mandatory;        // user-supplied label ("claude-desktop-laptop")
  prefix        : String(12)  @readonly;         // "pat_" + 8 random alnum, displayed after mint
  hashHex       : String(64)  @readonly;         // SHA-256 of the full plaintext token, hex
  scopes        : array of String;               // 'read' | 'write' | both (Phase 2 coarse)
  expiresAt     : Timestamp;                     // null = no expiry (discouraged; UI defaults to 90 days)
  lastUsedAt   : Timestamp;                      // updated on every successful auth (best-effort, no locking)
  revokedAt    : Timestamp;                      // null = active; set on user Revoke
  createdFromIP : String(45);                    // IPv6-safe, "when was this minted from where?" audit line
}

@assert.unique.hashHex: [hashHex]
annotate PATs with @assert.unique.hashHex;
```

Rule from [[csv-changes-wipe-editable-columns]] and [[cds-deploy-catches-runtime-only-errors]] applies — run `npx cds deploy --to sqlite::memory:` before committing schema (assert-unique-hash is runtime-checked).

### Mint flow

Users mint their own tokens. The FE list report is scoped to `req.user`:

```cds
@restrict: [{ grant: '*', to: 'Everyone', where: 'user.ID = $user' }]
```

Admins can see all via a separate `PATsAdmin` projection under `@requires: 'Admin'` if audit demands it.

Mint action:

```cds
action mintPAT(name: String, scopes: array of String, ttlDays: Integer) returns {
  token     : String;    // full plaintext, "pat_<prefix>_<48 random alnum>". Shown ONCE.
  prefix    : String;
  expiresAt : Timestamp;
};
```

Handler: `crypto.randomBytes(36).toString('base64url')` (~48 chars), prepend `pat_<prefix>_`, SHA-256 the full plaintext, INSERT the hash + prefix + metadata, return the full string in the response body. Never logged, never persisted plaintext. Response includes a big FE UI notice: "Copy now — this is the only time you'll see the full token."

### Revoke

`revokePAT(ID)` action sets `revokedAt = $now`. Row stays for audit; middleware rejects revoked tokens.

### Middleware — `srv/lib/mcp-pat-middleware.js`

Registered in `srv/server.js` before `@cap-js/mcp` mounts, gated by URL prefix `^/mcp-pat/` — never runs on non-MCP routes, so a stray Bearer header in `/api/...` calls isn't misinterpreted.

```js
export function patMiddleware(req, res, next) {
  const authz = req.headers.authorization;
  if (!authz?.startsWith('Bearer pat_')) return next();

  const token = authz.slice('Bearer '.length);
  const hashHex = crypto.createHash('sha256').update(token).digest('hex');

  // Cache: LRU keyed on hashHex → {userId, scopes, expiresAt, revokedAt}. TTL 60s.
  // Every successful auth also fires-and-forgets a lastUsedAt update.
  const cached = patCache.get(hashHex);
  if (cached && !cached.revokedAt && (!cached.expiresAt || cached.expiresAt > Date.now())) {
    installSyntheticUser(req, cached);
    return next();
  }

  // Cache miss — DB lookup, populate cache, decide.
  ...
}
```

`installSyntheticUser` sets `req.user = { id: dbUser.email, is: (role) => role === 'authenticated-user', attr: {...}, tokenSource: 'pat' }` — same shape CAP's Passport strategy produces for JWTs. Downstream `resolveDbUser(req)` sees a normal user object and behaves identically.

### Cache semantics

- 60s TTL bounds the "user revokes token, expects it to stop working immediately" window. 60s ≪ any credible attack duration; simpler than pub/sub invalidation.
- `lastUsedAt` writes are UPDATE-with-no-transaction and swallowed on failure — never block a request. Approximation is fine; this is a UX signal, not a security surface.

### Fiori Elements page — `/admin-ui/#pats`

New componentUsage in the admin shell. The admin-shell registration is discovery-driven from `admin-shell/manifest.json` scan, not a hardcoded list (memory rule: hand-curated registration lists rot) — so this is a one-file diff.

Object page for the mint action shows the plaintext exactly once in a modal — modeled on the same "one-time secret display" pattern used for `/admin-ui/#secrets` (referenced in CLAUDE.md's envsubst-free callout). User copies, closes modal, plaintext is gone from every surface.

List report columns: name, prefix ("pat_ab12cd34…"), scopes, createdAt, lastUsedAt, expiresAt, revokedAt (null = "active" green badge, non-null = "revoked" grey).

### Auth mixing behavior

- JWT sent to `/mcp-pat/*` → middleware ignores (only recognizes `Bearer pat_...`) → auth missing → 401.
- PAT sent to `/mcp-auth/*` → approuter's XSUAA gate doesn't recognize PATs → 401 with `WWW-Authenticate: Bearer`.

Both clean errors; clients can distinguish and correct.

### Rate limiting

Same anonymous-IP throttle as `/mcp/*` covers `/mcp-pat/*`. Token owner is identified but throttle is at the IP layer so a leaked PAT can't fan out. Per-token rate limits are a follow-up if abuse appears.

### PAT scope-outs (Phase 2 does not build)

- Per-token rate limits (IP-layer only).
- Programmatic mint via API (admin UI only).
- Fine-grained token scopes beyond `read`/`write`.
- Automatic expiry sweep (cron that hard-deletes long-revoked rows) — nice-to-have.

## Testing

Four layers, mirroring Phase 1's structure. Every new tool ships with unit + contract coverage; hybrid smoke is one file per subsystem; LLM-UX runs opt-in weekly.

### Layer 1 — Unit (`npm test`, in-memory SQLite, ~2s)

Per-tool files, one CDS function per describe block:

- `test/unit/mcp-progress-tools.test.js` — `get_my_tutorials`, `get_my_missions`, `get_my_events`, `get_my_completed_steps`. Seeds a fixture user with mixed in-progress / completed records; asserts status filtering, limit clamping, cross-user isolation (`resolveDbUser` scoping).
- `test/unit/mcp-progress-write-tools.test.js` — `complete_step`, `reset_tutorial_progress`. Assert the audit event (`TutorialProgressReset`) still fires with the same payload OData callers see plus the new `tokenSource` field.
- `test/unit/mcp-recommend-tools.test.js` — `get_my_recommended_tutorials`, `get_my_recommended_missions`. Seeded `HomepageForYou` fixture, in-order return.
- `test/unit/tutorial-step-slicer.test.js` — slicer correctness (5-step fixture, out-of-range → null, cache hit/miss, invalidation).
- `test/unit/code-check-step-loader.test.js` — regression against whole-tutorial-dump: `defaultLoadStepText(slug, 2)` returns step-2 text only.
- `test/unit/chat-context-server-slice.test.js` — server-side fallback fires only when client omits `currentStepText`.
- `test/unit/mcp-pat-middleware.test.js` — mint → attach → resolve → revoke → reject; cache TTL boundary; bad token → 401.
- `test/unit/mcp-pats-service.test.js` — FE scoping, exactly-once plaintext, `@assert.unique.hashHex` fires on collision (fixed rng seed), ttlDays clamp.
- `test/unit/xs-security-authorities.test.js` — extend the existing drift guard to assert `Tutorial.MCP` scope + role template + role collection in BOTH `xs-security.json` files.
- `test/unit/well-known-oauth.test.js` — snapshot test for the two `.well-known/` JSON files; required RFC 8414 fields present.

### Layer 2 — Protocol contract (`test/unit/mcp-contract.test.js`, extends Phase 1's file)

Grows from 36 → ~90 assertions. For every new tool:

- Enumerates in `tools/list` at the correct route (`/mcp-auth/DeveloperService`, `/mcp-pat/DeveloperService`, `/mcp/SearchService` for the anonymous `get_tutorial_step`).
- Description ≥40 chars, no boilerplate substrings (`"TODO"`, `"function that"`).
- `inputSchema.properties` matches CDS type map (String → string, Integer → integer, `many String` → array/string).
- `annotations.readOnlyHint: true` for the 5 reads.

The single most important guard for LLM UX. Blocking CI check.

### Layer 3 — Hybrid (`npm run test:hybrid`, real HANA via `cds bind --exec`)

One file per new subsystem, one canary per curated tool inside. Assertions are shape + non-empty + auth-scoping, not exact-value:

- `test/hybrid/mcp-authenticated-tools.test.js` — all 8 curated authenticated tools. Uses a dedicated fixture user (`mcp-hybrid-test@sap.example`) seeded via `npm run setup-dev-data`. Verifies `req.user` propagation end-to-end through the real @cap-js/mcp adapter.
- `test/hybrid/tutorial-step-slicer.test.js` — one real published tutorial, assert step N text contains its known heading.
- `test/hybrid/mcp-pat-e2e.test.js` — mint PAT via HTTP → hit `/mcp-pat/DeveloperService/tools/call` with `Authorization: Bearer pat_...` → assert same result as JWT call.
- `test/hybrid/oauth-discovery.test.js` — GET `/.well-known/oauth-authorization-server` on deployed dev, assert schema + issuer URL matches the deployed XSUAA tenant.

### Layer 4 — Smoke (`npm run test:smoke`, deployed target)

Extends Phase 1's `test/smoke/mcp.smoke.test.js`:

- `initialize` on `/mcp-auth/*` returns 401 without JWT.
- `initialize` on `/mcp-pat/*` returns 401 without PAT.
- End-to-end fixture-token round-trip: mint via test fixture → tool call succeeds. Test fixture user's PAT is stored in the target env's Credential Store (reuses `/admin-ui/#secrets` rotation surface). Test grabs it via a dedicated `GET /admin/secrets/mcp-smoke-pat` endpoint gated by `SMOKE_ADMIN_KEY`.
- Discovery doc 200s with the right content-type at both `.well-known/` paths.

### Layer 5 — LLM UX quality (`npm run test:llm-ux`, opt-in)

New directory `test/mcp-ux/`. Structure:

- `prompts.yaml` — 15 fixed natural-language prompts covering every tool at least once ("am I done with the CAP getting-started mission?", "find me a tutorial about draft handling", "mark step 3 of foo done", "which tutorial should I do next?").
- `runner.js` — connects to a local `cds watch` with `@cap-js/mcp` mounted (no deployed target, no XSUAA), passes each prompt to Claude Haiku 4.5 with `tools/list` output as the tool schemas, records which tool the LLM picked + args, asserts pick + arg-schema fit + no clarifying-question loop.
- **Runs opt-in locally** (`ANTHROPIC_API_KEY` env var required; ~$0.10/full run).
- **Weekly scheduled CI job** — `.github/workflows/mcp-ux-weekly.yml`, cron `0 9 * * 1` (Monday 9am UTC), uses the org's existing `ANTHROPIC_API_KEY` secret. Fails only on regression (drop in pick-accuracy from `test/mcp-ux/baseline.json`).
- **Model pin:** `claude-haiku-4-5-20251001` — pinned per the [claude-api] skill so a Haiku 4.5.1 release doesn't invalidate the baseline. Bumped intentionally with a baseline-refresh PR.
- **Not counted toward CI green on regular PRs.** Info-only; failure means "investigate description clarity", not "block merge."

### What we're not testing

- Full-corpus RAG retrieval quality (deferred to Phase 3 with KG deep-dive tools).
- Concurrent-user PAT/JWT contention (rate-limit stress is the approuter's job).
- Cross-agent-runtime compat matrix (Claude Desktop vs. Code vs. Cursor vs. Continue — manual QA during rollout).

## Rollout, Rollback, Observability

### Rollout — same MTA gates as Phase 1

1. **Dev deploy** — merges to `main` flow through the existing MTA build. New XSUAA scope + role collection created via mta.yaml's service-manifest update; existing `TutorialAuthor`-style pattern. First deploy prompts a manual `btp assign role-collection "Tutorials MCP Users" --to <first-tester>`, then automated for the rest via the existing `scripts/btp-role-collection-sync.js`. Internal testing 1–2 weeks.
2. **QA channel** — picks up the surface automatically (same MTA). QA-channel author preview lets us hand out `Tutorials MCP Users` collection to a wider circle without prod exposure.
3. **Prod cutover** — bundled into the end-of-July-2026 AEM decommission window. `-e ../deploy/prod.mtaext` picks up prod tenant/region substitutions for the `.well-known/` files.

### Feature flags for staged enablement

- `MCP_AUTH_ENABLED` (default `true`) — envelope kill-switch for `/mcp-auth/*` routing. `false` → approuter returns 503 with "Phase 2 disabled" static page. Also flips PAT middleware to bypass mode.
- `MCP_PAT_MINT_ENABLED` (default `true`) — surfaces at `/admin-ui/#pats` mint button. `false` → button greyed with "Contact admin" tooltip; existing tokens keep working.
- `KG_STEP_SLICER_ENABLED` (default `true`) — slicer short-circuit.

All three: env vars, `cf set-env` + `cf restart`, no redeploy. Same pattern as the KG flags.

### Rollback plan — three tiers

- **Full rollback** — `cf rollback tutorials-srv` and `cf rollback tutorials-approuter` roll back both. XSUAA scope and role collection remain (safe to leave; unused). PAT rows in HANA remain (users can revoke on next deploy or via SQL if urgent).
- **Surgical disable** — set `MCP_AUTH_ENABLED=false`; kills `/mcp-auth/*` and `/mcp-pat/*` end-to-end without touching Phase 1's anonymous surface. Slicer stays live for `checkStepCode`.
- **Per-tool disable** — comment the CDS function declaration out (or annotate `@mcp: null` once `@cap-js/mcp` supports it), redeploy. MCP clients see the tool disappear from `tools/list`.

### Docs deliverables (four files)

Three symmetric with Phase 1, one new architecture reference:

1. **`docs/end-users/mcp-quickstart.md`** — three new sections: **Sign in with Claude Desktop** (OAuth flow, screenshot of the browser handshake), **Sign in with Claude Code** (`.mcp.json` snippet using `mcp-remote` with OAuth), **Headless / CI with a PAT** (mint + `.mcp.json` snippet with the PAT header). Verified end-to-end by a reviewer other than the author.
2. **`docs/developers/reference/mcp-server.md`** — Phase 1 tool table extended with 10 new rows (8 curated authenticated + `get_tutorial_step` on both surfaces). New "Authenticated tools" section with a "which route do I use?" decision matrix.
3. **`docs/developers/operations/mcp-server.md`** — runbook extended: mint / revoke fixture PAT for smoke tests, flip the three feature flags, grant `Tutorials MCP Users` role collection, read new metrics, read audit trail for authenticated tool calls.
4. **`docs/developers/architecture/mcp-server.md`** (new) — all three routes, adapter package, middleware, slicer.

All four registered in `docs/.vitepress/config.ts` sidebar. Sidebar-registration test guards Deploy-Docs pass (memory: #1101 fix).

### Observability — no new module, extends existing surfaces

- **Access log** — `/mcp-auth/*` and `/mcp-pat/*` show up automatically; `route` field distinguishes them.
- **Tool-level counters** — existing `mcp_tool_invocation_total{service,tool,outcome}` gains a `tokenSource` label (`jwt` | `pat` | `anon`).
- **Slicer metrics** — `tutorial_step_slice_total`, `tutorial_step_slice_cache_size`.
- **PAT metrics** — `mcp_pat_mint_total`, `mcp_pat_revoke_total`, `mcp_pat_auth_total{outcome}` (hit/miss/revoked/expired).
- **Audit trail** — existing plumbing routes `complete_step` and `reset_tutorial_progress` audit events; `TutorialProgressReset` payload includes new nullable `tokenSource` field to distinguish browser-driven from MCP-driven.
- **Alerting** — existing `srv-error-rate` covers `/mcp-auth/*` and `/mcp-pat/*` automatically. New alert `mcp-pat-auth-fail-rate` on `mcp_pat_auth_total{outcome!="hit"} / mcp_pat_auth_total`; threshold 20%/5min = potential leaked-and-brute-forced token, page on-call.

## Success Criteria

Phase 2 is done when:

1. `@cap-js/mcp` mounts on `DeveloperService` and `HomepageService` in addition to the three Phase-1 services; `@protocol: ['odata','graphql','mcp']` on both; extended contract test passes.
2. All 10 new curated tools have unit + contract + hybrid coverage — all green:
   - 8 authenticated (5 reads, 2 writes, 2 recommendations)
   - `get_tutorial_step` on both anonymous (`/mcp/*`) and authenticated (`/mcp-auth/*`, `/mcp-pat/*`) surfaces
3. `srv/lib/tutorial-step-slicer.js` shipped with retrofits in `code-check-step-loader.js` and `chat-context.js`; the underscore-prefixed `_stepNumber` and "TODO Phase 4" comment gone.
4. `xs-security.json` (both copies) has `Tutorial.MCP` scope, `TutorialMCP` role template, `Tutorials MCP Users` role collection; drift guard passes.
5. `.well-known/oauth-protected-resource` and `.well-known/oauth-authorization-server` served from approuter static tree with per-env tenant substitution; hybrid discovery test passes on dev.
6. Approuter routes deployed:
   - `^/mcp-auth/(.*)$` → xsuaa with `Tutorial.MCP` scope gate
   - `^/mcp-pat/(.*)$` → anonymous, PAT middleware resolves req.user
   - Anonymous `/mcp/*` unchanged
7. `PATs` entity deployed; `/admin-ui/#pats` mint/revoke Fiori Elements page live; one-time plaintext modal verified with a reviewer.
8. Claude Desktop OAuth flow completes end-to-end against dev, verified by a reviewer other than the author.
9. Claude Code with a minted PAT calls `get_my_tutorials` end-to-end against dev, verified by same.
10. Consumer quickstart doc updated with the three new sections; architecture / reference / operations docs registered in the VitePress sidebar; Deploy-Docs green.
11. LLM-UX weekly workflow scheduled with `test/mcp-ux/baseline.json` seeded; first run passes.
12. sap-devs owner has a Phase 2 migration note filed against the sap-devs repo (closes Phase 1 Success Criterion 5 which deferred authenticated-tool migration to Phase 2).

## Open Questions

Deferred to Phase 3 or beyond (not blocking):

- Whether `/mcp-auth/*` and `/mcp-pat/*` should collapse to one route with dual auth strategies in a future adapter release.
- Whether `mcp://` custom URL scheme handling on desktop client OSes needs approuter route-specific redirects.
- Whether the LLM-UX weekly job should notify Slack on regression or annotate the PR (deferred until we see false-positive rate).

## References

- Phase 1 PR: [#1011](https://github.com/sap-tutorials/tutorials-ims/pull/1011)
- Phase 1 issue: [#912](https://github.com/sap-tutorials/tutorials-ims/issues/912)
- Phase 2 issue: [#1105](https://github.com/sap-tutorials/tutorials-ims/issues/1105)
- Phase 3 issue: [#1106](https://github.com/sap-tutorials/tutorials-ims/issues/1106)
- Phase 1 design spec: [`2026-07-05-mcp-server-design.md`](2026-07-05-mcp-server-design.md)
- CAP 10 MCP Protocol Adapter: https://cap.cloud.sap/docs/releases/2026/jun26#new-mcp-protocol-adapter
- MCP 2025-06 Authorization: https://spec.modelcontextprotocol.io/specification/2025-06-18/basic/authorization/
- RFC 8414 (Authorization Server Metadata): https://datatracker.ietf.org/doc/html/rfc8414
- RFC 7636 (PKCE): https://datatracker.ietf.org/doc/html/rfc7636
- Existing code the spec touches:
  - `srv/developer-service.cds` / `srv/developer-service.js` — mount point
  - `srv/homepage-service.cds` — recommendations mount
  - `srv/lib/content-store.js` — BLOB reader the slicer wraps
  - `srv/lib/code-check-step-loader.js` — retrofit site 1
  - `srv/lib/chat-context.js` — retrofit site 2
  - `srv/lib/user-resolver.js` — `resolveDbUser`, unchanged
  - `srv/lib/metrics.js` — extends existing counters
  - `xs-security.json` + `.deploy/xs-security.json` — both files (memory rule)
  - `approuter/xs-app.json` — three routes + two `.well-known/` files
  - `test/unit/mcp-contract.test.js` — extends
  - `test/hybrid/*` — new hybrid smoke tests
