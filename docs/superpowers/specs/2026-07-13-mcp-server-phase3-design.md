# MCP Server for tutorials-ims — Phase 3 Design

**Date:** 2026-07-13
**Author:** Tom (via superpowers:brainstorming)
**Status:** Approved — pending user read-through of the written spec
**Related:** issue [#1106](https://github.com/sap-tutorials/tutorials-ims/issues/1106); Phase 1 PR [#1011](https://github.com/sap-tutorials/tutorials-ims/pull/1011); Phase 1 design [`2026-07-05-mcp-server-design.md`](2026-07-05-mcp-server-design.md); Phase 2 design [`2026-07-08-mcp-server-phase2-design.md`](2026-07-08-mcp-server-phase2-design.md)

## Summary

Phase 3 opens the admin / KG-power-user tier of the hosted MCP server and expands MCP primitives beyond tools. Four workstreams:

1. **KG deep-dive tools** — four anonymous curated tools (`kg_shared_concepts`, `kg_neighborhood`, `kg_search_concepts`, `kg_community`) on the already-MCP-annotated `KnowledgeGraphService`.
2. **Admin curation tools** — four authenticated tools (`merge_concepts`, `promote_community_to_mission`, `trigger_rebuild`, `publish_content`) wrapping existing actions, on a new XSUAA-gated `/mcp-admin/*` route.
3. **Resources & Prompts primitives** — `tutorial://<slug>`, `mission://<slug>`, `concept://<id>` resources and four code-shipped prompt templates, delivered through a new **compose layer** that adds resources/prompts to the same MCP endpoint the adapter serves tools on.
4. **External-content proxies** — evaluated and **deferred** (Non-Goal, unchanged from the issue).

No new MTA module, no new subaccount. One new approuter route family (`/mcp-admin/*`), one new shared library (`srv/lib/mcp-compose-router.js`), three new CDS extension files, a static prompts directory, and four new env kill-switches.

## Critical Finding — the adapter is tools-only

The installed `@cap-js/mcp@1.1.1` **does not implement MCP resources or prompts.** Verified against the vendored source:

- `node_modules/@cap-js/mcp/lib/index.js` registers only tool handlers (`registerGenericReadTool`, `registerCallActionTool`, `registerDescribeTool`) and advertises `server.server.registerCapabilities({ tools: { listChanged: false } })` — no `resources/*`, no `prompts/*`.
- A repo-wide grep of the package for `resources/list`, `prompts/list`, `registerResource`, `registerPrompt` returns nothing.
- The CHANGELOG (through 1.1.1, 2026-07-08) mentions neither primitive.

The issue's Approach section assumes "register via the `@cap-js/mcp` resources API" — **that API does not exist in the pinned version.** However:

- The adapter builds a **fresh, stateless `McpServer` per request** using the official `@modelcontextprotocol/sdk`, whose `McpServer` class **natively supports** `registerResource` / `registerPrompt` / `ResourceTemplate` (confirmed present in `node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js`).
- The adapter **exports its tool-registration functions** from `lib/tools.js` with stable signatures `(server, srv, entities|actions, prefix, { log })`, and its authorization check from `lib/auth.js` (`checkAuthorization(srv)`).

This is the seam Phase 3 exploits: we compose our own per-request `McpServer` that calls the adapter's tool functions **and** our resource/prompt registrations, on the same stateless-HTTP transport. Tools stay byte-identical to Phase 1/2; we only *add* the two new primitives to the advertised capabilities.

> **Why not wait for an upstream release?** `@cap-js/mcp@1.1.0` peer-deps `@sap/cds >=8` and CDS-10 compat only landed in 1.1.1 (2026-07-08). A resources/prompts release is not on the visible roadmap, and Phase 3's success criteria require the primitives now. The compose layer is designed to **shrink to nothing** if upstream ships them: delete `mcp-compose-router.js`, drop the `MCP_RESOURCES_ENABLED`/`MCP_PROMPTS_ENABLED` flags, register via the official API. Config change, not a rewrite.

## Goals

1. Four KG deep-dive tools shipped anonymously on `KnowledgeGraphService` with unit + contract + hybrid coverage.
2. Four admin curation tools shipped on a new XSUAA-gated `/mcp-admin/*` route, each wrapping an existing action, author/superadmin scope enforced by hybrid smoke.
3. `tutorial://`, `mission://`, `concept://` resources listable via `resources/list` and readable via `resources/read` on the composed endpoint — on both anonymous and authenticated surfaces.
4. At least four prompt templates under `prompts/list`, callable via `prompts/get`, code-shipped as static files.
5. Zero net-new business logic: every KG and admin tool is a thin wrapper on existing service handlers; resources reuse the Phase 2 slicer + `content-store` BLOB path.
6. Consumer quickstart + reference/architecture/operations docs extended with resource + prompt examples.

## Non-Goals

- **New MTA module / new subaccount** — unless the external-content proxy comes in (it does not, this phase).
- **External-content proxies** (Learning Journeys, Discovery Center) — evaluated, deferred; would live in a separate `tutorials-mcp-external` module if demand appears.
- **Author-editable prompts via admin UI** — Phase 3 prompts are code-shipped static files (decision below). Admin-editable prompts are a possible later phase.
- **Resource subscriptions / `listChanged` notifications** — the stateless per-request transport carries no session state to push change events. `subscribe:false` advertised; a session-ful subscription model is a follow-up.
- **Community *promotion* via `kg_community`** — the tool is read-only surfacing of Louvain sidecars. Promotion stays behind the SuperAdmin `promote_community_to_mission` admin tool, and is DEV-only until #917 reaches PROD.
- **Retiring anything from Phase 1 or Phase 2.** Both surfaces are unchanged.
- **Per-token rate limits, DCR** — unchanged Non-Goals from Phase 2.

## Architecture

Phase 3 layers onto tutorials-srv without a new deployable. The novel piece is the **compose router**; the tool workstreams reuse the plain adapter.

```
Claude Desktop / Code / custom agent
         │  HTTPS  (Streamable HTTP + SSE, MCP 2025-06)
         ▼
approuter  (tutorials-approuter)
   ├── /mcp/*         authenticationType: none    → srv-api   (Phase 1 + Phase 3 anonymous KG tools, resources, prompts)
   ├── /mcp-pat/*     authenticationType: none     → srv-api   (Phase 2 PAT; +Phase 3 resources/prompts)
   ├── /mcp-auth/*    authenticationType: xsuaa     → srv-api   (Phase 2 OAuth; +Phase 3 resources/prompts)
   └── /mcp-admin/*   authenticationType: xsuaa     → srv-api   (Phase 3 admin tools; scope-gated at approuter)
         │
         ▼
tutorials-srv  (CAP Node.js, @cap-js/mcp@1.1.1)
   │
   ├── srv/lib/mcp-compose-router.js         (NEW — heart of Phase 3)
   │     Per-request stateless McpServer that reuses the adapter's tool fns
   │     AND registers resources + prompts. Mounted at /mcp/<svc> for the
   │     R/P-bearing services BEFORE @cap-js/mcp autowires. Falls back to the
   │     plain adapter when MCP_PHASE3_ENABLED=false.
   │
   ├── KnowledgeGraphService   @protocol: [{odata,'/graph'}, graphql, {mcp,'/mcp/graph'}]  (Phase 1)
   │     +4 KG deep-dive tools  (srv/knowledge-graph-service-mcp.cds → srv/lib/mcp-kg-tools.js)
   │     + resources + prompts via compose router
   │
   ├── AdminService            @protocol: ['odata','mcp']   (NEW annotation, srv/admin-service-mcp.cds)
   │     +4 admin curation tools (srv/lib/mcp-admin-tools.js)
   │     served at /mcp/admin; approuter route /mcp-admin/* → srv rewrite → /mcp/admin
   │
   ├── srv/mcp/prompts/*.md                  (NEW — static prompt templates, YAML frontmatter)
   │     loaded once at boot by srv/lib/mcp-prompt-loader.js
   │
   └── srv/lib/tutorial-step-slicer.js       (Phase 2 — reused by tutorial:// resource)
       srv/lib/content-store.js              (Phase 2/earlier — BLOB reader reused by resources)
```

### The compose router — `srv/lib/mcp-compose-router.js`

Modeled directly on `@cap-js/mcp/lib/index.js` (same stateless-per-request shape), with two additions and one reuse:

```js
// Pseudocode — mirrors the adapter's request handler.
router.post('/', async (req, res) => {
  const srv = /* the CAP service this router fronts */;
  const { entities, actions, error } = checkAuthorization(requestService); // adapter's ./auth export
  if (error) return jsonRpcError(res, error);

  const prefix = resolvePrefix(srv.definition);       // adapter ./utils/service-name export
  const server = new McpServer({ name: srv.name, version: '1.0.0', description }, { instructions });

  // 1. TOOLS — reuse the adapter's own functions verbatim (byte-identical to Phase 1/2)
  registerGenericReadTool(server, srv, entities, prefix);
  registerCallActionTool(server, srv, actions, prefix);   // or registerPerActionTools per cds.env
  registerDescribeTool(server, srv, entities, actions, prefix);

  // 2. RESOURCES + PROMPTS — ours (gated by env flags)
  if (RESOURCES_ENABLED) registerResources(server, srv);  // srv/lib/mcp-resources.js
  if (PROMPTS_ENABLED)   registerPrompts(server);         // srv/lib/mcp-prompt-loader.js

  // 3. Merged capabilities
  server.server.registerCapabilities({
    tools:     { listChanged: false },
    ...(RESOURCES_ENABLED && { resources: { subscribe: false, listChanged: false } }),
    ...(PROMPTS_ENABLED   && { prompts:   { listChanged: false } })
  });

  // 4. Same transport dance as the adapter (Accept-header patch, JSON/SSE detect, connect, close)
});
```

**Fail-open:** any throw inside the compose path is caught, logged as `mcp_compose_fallback_total`, and the request is re-dispatched to the plain adapter router (tools-only) — never a 500 that takes the tool surface down. When `MCP_PHASE3_ENABLED=false`, the compose router is not mounted at all and `@cap-js/mcp` autowires normally.

**Mounting order (`srv/server.js`):** the compose router must be registered on the root app for the R/P-bearing services **before** the `@cap-js/mcp` plugin autowires its `/mcp/<svc>` mounts, and after the existing `/mcp-auth`→`/mcp` and `/mcp-pat`→`/mcp` rewrites (so all three route families land on the composed mount). The plugin autowires on `cds.once('listening')` in dev and via the served hook in production; we mount in `cds.on('served')` guarded by the phase-3 flag. Verified seam: adapter's `lib/index.js` returns an `express.Router` per service, and its tool fns are exported from `lib/tools.js`.

### Reuse surface from the adapter package

| Import | From | Used for |
|---|---|---|
| `registerGenericReadTool`, `registerCallActionTool`, `registerPerActionTools`, `registerDescribeTool`, `getInstructions` | `@cap-js/mcp/lib/tools` | Tool registration — tools stay the adapter's |
| `checkAuthorization` | `@cap-js/mcp/lib/auth` | Per-request auth check, identical to adapter |
| `resolvePrefix` | `@cap-js/mcp/lib/utils/service-name` | Tool-name prefix |
| `getDescription` | `@cap-js/mcp/lib/utils/cds-to-schema` | Server description |

> **Deep-import risk.** These are internal (`lib/…`) paths, not the package's public entry. A minor `@cap-js/mcp` bump could move them. Mitigations: (a) the compose router is behind `MCP_PHASE3_ENABLED` and fails open to the plain adapter, so a broken import degrades to Phase-2 behaviour rather than a crash; (b) `test/unit/mcp-compose-router.test.js` asserts the imports resolve and produce a tools+resources+prompts capabilities payload — it reddens the instant an upgrade moves them; (c) the package version is pinned (not `^`). Revisit if upstream ships a public resources/prompts API.

### Kill switches (env vars, `cf set-env` + restart, no redeploy)

- `MCP_PHASE3_ENABLED` (default `true`) — master. `false` → compose router not mounted; `@cap-js/mcp` behaves exactly as Phase 2; `/mcp-admin/*` returns 503.
- `MCP_RESOURCES_ENABLED` (default `true`) — skip resource registration + capability.
- `MCP_PROMPTS_ENABLED` (default `true`) — skip prompt registration + capability.
- `MCP_ADMIN_TOOLS_ENABLED` (default `true`) — `false` → `/mcp-admin/*` returns 503; KG/anonymous unaffected.

Same pattern as the Phase 2 flags and the KG flags in the memory index.

## Workstream 1 — KG deep-dive tools

Four tools on `KnowledgeGraphService`, `@requires:'any'` (anonymous `/mcp/graph`, same surface as Phase 1's `kg_prerequisites` / `kg_what_to_learn_next`). Declarations in a new `srv/knowledge-graph-service-mcp.cds` (aspect-extends the service, keeps the main file from ballooning — same pattern as `developer-service-mcp.cds`); handlers in `srv/lib/mcp-kg-tools.js`. Doc-comments become LLM-facing descriptions. **Zero net-new graph logic** — each wraps existing code in `srv/knowledge-graph-service.js`.

| Tool | Args | Returns | Backed by |
|---|---|---|---|
| `kg_shared_concepts` | `slug_a: String`, `slug_b: String` | `array of { conceptSlug, name, score: Double }` | `rankNeighborhood`'s `sharedConcepts` arm run pairwise on the two tutorials' concept sets. |
| `kg_neighborhood` | `slug: String`, `depth: Integer` (default 1, max 2) | `{ prerequisites[], whatToLearnNext[], sharedConcepts[], teaches[] }`, each element `{ slug, title, score: Double, isolated: Boolean }` | Full `rankNeighborhood` — PageRank-blended when `KG_PAGERANK_ENABLED` (#916); `isolated` from `KgIsolation` (#918). Fail-open exactly like the sidebar. |
| `kg_search_concepts` | `query: String`, `maxConcepts: Integer`, `maxTutorials: Integer` | `{ concepts: [{slug,name,score}], tutorials: [{slug,title,score}] }` | `searchKG` action. Bridges on-demand extraction (#948) enqueue **only when `KG_ONDEMAND_ENABLED`** — same guard the ⌘K palette uses. |
| `kg_community` | `id: String` (community fingerprint) | `{ communityId, label, memberTutorials: [{slug,title}], size, promotedToMissionSlug }` | `KgCommunity` + `KgCommunityLabel` sidecars (#917). **Read-only.** |

### `kg_community` scope note

The issue marks `kg_community` Optional, "once the promotion flow ships to PROD." CLAUDE.md records #917 community promotion as **DEV-only**. Phase 3 ships the tool as **read-only surfacing** of the Louvain sidecars — it never invokes promotion. Its `id` argument is the **community fingerprint** (`sourceKgCommunityFingerprint`, a stable SHA-256 of the sorted member-slug set), NOT the raw Louvain `communityId` — the schema comment (`db/schema.cds:58`) notes Louvain IDs shuffle across nightly passes, so the "already promoted" link keys off the fingerprint. The tool returns `promotedToMissionSlug` (resolved by matching `Missions.sourceKgCommunityFingerprint`) so a caller can see promotion status. Its doc-comment states the data is DEV-only until #917 reaches PROD. Promotion remains exclusively behind the SuperAdmin `promote_community_to_mission` admin tool (WS2).

### Validation

Reuse Phase 2's `srv/lib/mcp-arg-validators.js` for `depth` / `maxConcepts` / `maxTutorials` clamps — one file, one grep audits every clamp. All four tools get `annotations.readOnlyHint: true`.

## Workstream 2 — Admin curation tools

Four tools wrapping existing actions. `AdminService` gets a new `@protocol:['odata','mcp']` annotation via `srv/admin-service-mcp.cds` (object-form or additive per the [[cap-graphql-shortcut-replaces-odata]] rule — verify OData still mounts). `mergeConcepts` already lives on `KnowledgeGraphService`; it is surfaced to admins via its own admin gate. Handlers in `srv/lib/mcp-admin-tools.js`.

New approuter route `^/mcp-admin/(.*)$` → `authenticationType: xsuaa` → srv rewrites `/mcp-admin`→`/mcp/admin`, mirroring the existing `/mcp-auth`→`/mcp` rewrite (`srv/server.js:451`).

| Tool | Args | Wraps (existing) | Gate | Side effects |
|---|---|---|---|---|
| `merge_concepts` | `loser: UUID`, `canonical: UUID` | `KnowledgeGraphService.mergeConcepts` | `KnowledgeGraph.Admin` | KG-internal only |
| `promote_community_to_mission` | `communityId: Integer`, `missionSlug: String`, `title: String` | `AdminService.promoteCommunityToMission` | `SuperAdmin` | Drafts a Mission (DEV-only per #917) |
| `trigger_rebuild` | `slug: String` (optional), `mode: String` (optional) | `srv/lib/rebuild-trigger.js` workflow dispatch | `Tutorial.Author` | **External**: GitHub dispatch (`GITHUB_DISPATCH_TOKEN`) |
| `publish_content` | `slug: String`, `html: String`, … | in-process `/content/publish` path | `Tutorial.Author` + write scope | **External/risky**: `CONTENT_API_KEY`; most side-effecting |

### Layered defense

Approuter XSUAA scope gate on `/mcp-admin/*` rejects non-admins **before** the request touches srv; each wrapped action's existing `@requires` re-checks in-process (belt-and-suspenders). A caller without the scope never sees the admin tools in `tools/list` on this route. Because admin tools sit on their **own** route (not mixed into `/mcp-auth`), a non-admin authenticated user's `tools/list` on `/mcp-auth/*` never shows admin tools they cannot call.

### Side-effect guardrails

- `trigger_rebuild` and `publish_content` carry `annotations.readOnlyHint: false` plus explicit `destructiveHint` / `idempotentHint` per the MCP tool-annotations spec, so well-behaved clients prompt before firing.
- `publish_content` is **PAT/OAuth write-scope-gated only** (never anonymous), reuses `mcp-arg-validators` and the **server-side no-revert guard** already protecting `/content/publish`. Its doc-comment states `trigger_rebuild` (workflow dispatch, CI-validated) is the **preferred** path and `publish_content` is the emergency lever — consistent with the CLAUDE.md "never publish-content from a workstation" rule, which targets CI-bypass, not this authenticated in-process path.
- `merge_concepts` and `promote_community_to_mission` have no external HTTP / token dependency — they are the two hybrid-smoke canaries for criterion 2.

## Workstream 3 — Resources & Prompts

### Resources

Three URI schemes registered via SDK `registerResource` + `ResourceTemplate` on the compose server, in `srv/lib/mcp-resources.js`.

| URI template | Reads (existing) | `resources/read` content |
|---|---|---|
| `tutorial://<slug>` | `tutorial-step-slicer.sliceAllSteps` + `Tutorials` projection | JSON block `{ slug, title, totalSteps, steps: [{n,title}], tags }` + a second block with full rendered HTML |
| `mission://<slug>` | `Missions` + `CompletionPaths` / `CompletionPathItems` | JSON `{ slug, title, tutorials: [{slug,title,order}] }` |
| `concept://<id>` | `Concepts` (`status='ACTIVE'`) + KG link tables | JSON `{ id, slug, name, teachingTutorials[], relatedConcepts[] }` |

- **`resources/list`** enumerates a **bounded** set (published tutorials + missions, ACTIVE concepts), capped (500 each) with an explicit truncation notice in the list result when the cap is hit (memory rule: no silent caps). Clients wanting more use the template + read-by-URI.
- **`resources/read`** reuses the Phase 2 slicer / `content-store` BLOB path (which already handles the HANA LOB-locator gotcha — [[hana-blob-cds-ql]]) and the KG read handlers. No new data access.
- **`subscribe: false`** — content is publish-driven; a session-ful subscription/`listChanged` model needs state the stateless per-request transport deliberately avoids. Follow-up (Open Questions).
- **Anonymous + authenticated:** identical public content on all three route families (`/mcp/*`, `/mcp-auth/*`, `/mcp-pat/*`). `concept://` honors the `status='ACTIVE'` filter every KG read path uses.

Which service hosts them: the compose router is mounted per service. Resources ride the **anonymous `KnowledgeGraphService` `/mcp/graph`** mount (public content, no auth complexity) **and** are re-exposed on the authenticated surfaces via the same compose router (the `/mcp-auth`→`/mcp` and `/mcp-pat`→`/mcp` rewrites already funnel authenticated traffic onto the same mounts). No duplication of content logic — one `registerResources` call, reached by all route families.

### Prompts (code-shipped static files)

Static `.md` files under `srv/mcp/prompts/`, each with YAML frontmatter:

```yaml
---
name: summarize_mission_for_beginner
description: Summarize a mission's arc and outcomes for a complete beginner.
arguments:
  - { name: mission_slug, description: Lowercase canonical mission slug, required: true }
---
You are helping a beginner decide whether to start the "{{mission_slug}}" mission.
Read the mission://{{mission_slug}} resource and summarize ...
```

`srv/lib/mcp-prompt-loader.js` reads the directory once at boot, validates frontmatter (rejects malformed files at boot — fail-fast), and answers `prompts/list` + `prompts/get` (interpolating `{{arg}}`). Ship **four** (criterion 4 needs ≥3):

1. `summarize_mission_for_beginner(mission_slug)` — pairs with `mission://`.
2. `generate_lab_exercise(tutorial_slug, step?)` — pairs with `tutorial://` + slicer.
3. `explain_concept(concept_id)` — pairs with `concept://`.
4. `suggest_learning_path(from_slug, to_slug)` — pairs with `kg_neighborhood` / `pathBetween`.

Each prompt body references the matching resource URI so a client can chain "get prompt → read resource → send to LLM." Prompts carry **no secrets** — pure text templates, reviewable in PRs.

**Decision (issue defers to spec time):** prompts are **code-shipped static files**, not author-editable via admin UI. Rationale: reviewable in PRs, no new entity / admin surface / cache-invalidation / test surface. Admin-editable is a possible later phase. Matches the issue's own Approach note ("static `.md` files under `srv/mcp/prompts/`").

### MTA packaging

`srv/mcp/prompts/*.md` are non-JS runtime assets. They must be added to **both** the `srv` and `srv-qa` `cp` lists in `.deploy/mta.yaml`, else `prompts/get` 404s in QA. The CLAUDE.md `srv-qa` cp-list audit covers `srv/mcp/` and the new `srv/lib/mcp-*.js` files — re-walk transitive `./` imports from `content-store.js` when touching `srv/lib`.

## Workstream 4 — External-content proxies

**Deferred** (evaluate-only per the issue). Learning Journeys and Discovery Center proxies would live in a separate `tutorials-mcp-external` module, not the core MTA, and only if demand appears. No Phase 3 work.

## Testing

Five layers, mirroring Phase 1/2. Every new tool ships unit + contract; hybrid smoke one file per subsystem; LLM-UX opt-in weekly.

### Layer 1 — Unit (`npm test`, in-memory SQLite)

- `test/unit/mcp-kg-tools.test.js` — 4 KG tools: shape, clamp, fail-open (missing sidecars → empty not throw), `isolated` flag surfaced, on-demand guard off-by-default, `kg_community` read-only.
- `test/unit/mcp-admin-tools.test.js` — 4 admin tools call through to the wrapped action (spy asserts the existing handler is invoked, not re-implemented); scope required.
- `test/unit/mcp-compose-router.test.js` — **the crux.** A fabricated request through the compose router returns `tools` **and** `resources` **and** `prompts` in one `initialize` capabilities payload; tool output byte-identical to the plain adapter for the same service; adapter deep-imports resolve; fail-open falls back to plain adapter on injected throw.
- `test/unit/mcp-resources.test.js` — `resources/list` bounded + truncation notice; `resources/read` for all 3 URI schemes; unknown URI → proper MCP error; `concept://` respects `status='ACTIVE'`.
- `test/unit/mcp-prompt-loader.test.js` — frontmatter parse, `{{arg}}` interpolation, `prompts/list` ≥ 4, `prompts/get` bad-name error, malformed-file boot rejection.
- Extend `test/unit/xs-security-authorities.test.js` — assert the `/mcp-admin` scope wiring in **both** `xs-security.json` files (dual-file drift rule [[feedback-xs-security-dual-file-drift]]).

### Layer 2 — Contract (`test/unit/mcp-contract.test.js`, extends Phase 1/2)

For every new tool: enumerates at the correct route, description ≥ 40 chars (no boilerplate), `inputSchema.properties` matches CDS types, `readOnlyHint` correct (true for KG + reads; false + destructive/idempotent hints for `trigger_rebuild` / `publish_content`). **New R/P assertions:** `resources/list` and `prompts/list` non-empty on the composed endpoint; capabilities advertise all three primitives. Blocking CI check.

### Layer 3 — Hybrid (`npm run test:hybrid`, real HANA via `cds bind --exec`; pass `--project hybrid` — memory rule)

- `test/hybrid/mcp-kg-tools.test.js` — real graph, one known tutorial pair, assert a shared concept present; `kg_neighborhood` shape + `isolated` flag.
- `test/hybrid/mcp-admin-tools.test.js` — author/superadmin scope enforced (403 without scope on `merge_concepts` + `trigger_rebuild`). **Satisfies criterion 2.**
- `test/hybrid/mcp-resources.test.js` — `tutorial://` + `mission://` readable end-to-end through the compose router. **Satisfies criterion 3.**

### Layer 4 — Smoke (`test/smoke/mcp.smoke.test.js`, extends)

- `resources/list`, `prompts/list`, `prompts/get` 200 on deployed dev.
- `/mcp-admin/*` `initialize` returns 401 without JWT.
- Discovery/capabilities include resources + prompts on the composed endpoint.

### Layer 5 — LLM-UX (`test/mcp-ux/`, extends Phase 2 opt-in weekly)

Add prompts covering the 4 KG tools + one "read `tutorial://` then summarize" resource-chaining prompt. Model pinned `claude-haiku-4-5-20251001` (per the [claude-api] skill). Info-only; regression against `baseline.json`.

### What we're not testing

- Resource subscription / `listChanged` (out of scope this phase).
- Concurrent compose-router contention (stateless per request; approuter throttles).
- Cross-agent-runtime R/P rendering matrix (manual QA during rollout).

## Rollout, Rollback, Observability

### Rollout — same MTA gates as Phase 1/2

1. **Dev deploy** — merges to `main` through the existing MTA build. New XSUAA scope for `/mcp-admin` created via service-manifest update in **both** xs-security files. Internal testing 1–2 weeks.
2. **QA channel** — picks up the surface automatically (same MTA).
3. **Prod cutover** — bundled into the end-of-July-2026 AEM decommission window.

### Rollback — four tiers

- **Full** — `cf rollback tutorials-srv` + `tutorials-approuter`. New scope safe to leave unused.
- **Master surgical** — `MCP_PHASE3_ENABLED=false`: compose router unmounts, `@cap-js/mcp` reverts to exact Phase-2 tools-only behaviour, `/mcp-admin/*` returns 503. No redeploy.
- **Per-primitive** — `MCP_RESOURCES_ENABLED` / `MCP_PROMPTS_ENABLED` / `MCP_ADMIN_TOOLS_ENABLED` disable resources / prompts / admin-tools independently.
- **Fail-open (automatic)** — any compose-path throw logs `mcp_compose_fallback_total` and re-dispatches to the plain adapter; the tool surface never goes down.

### Observability — extends existing surfaces (no new module)

- `mcp_tool_invocation_total{service,tool,outcome}` gains new tool names + `route=mcp-admin`.
- New `mcp_resource_read_total{scheme,outcome}`, `mcp_prompt_get_total{name}`.
- New `mcp_compose_fallback_total` — alert if non-zero sustained (means the deep-import seam broke).
- Access log: `/mcp-admin/*` distinguished by `route`.
- Audit trail: `merge_concepts`, `promote_community_to_mission`, `publish_content`, `trigger_rebuild` route through the existing admin-action audit plumbing.

### Docs deliverables

1. **`docs/end-users/mcp-quickstart.md`** — new sections: reading resources (`tutorial://`, `mission://`, `concept://`), using prompts (`prompts/list` + `prompts/get`), example client flows.
2. **`docs/developers/reference/mcp-server.md`** — 8 new tool rows (4 KG + 4 admin), resources table, prompts table.
3. **`docs/developers/architecture/mcp-server.md`** — the compose layer, the adapter-tools-only finding, the deep-import seam + fail-open.
4. **`docs/developers/operations/mcp-server.md`** — flip the four flags, grant `/mcp-admin` scope, read the new metrics, respond to `mcp_compose_fallback_total`.

All sidebar-registered in `docs/.vitepress/config.ts` (Deploy-Docs sidebar-registration guard, #1101 fix).

## Success Criteria

Phase 3 is done when:

1. All four Phase-3 KG tools (`kg_shared_concepts`, `kg_neighborhood`, `kg_search_concepts`, `kg_community`) shipped with unit + contract + hybrid coverage — all green.
2. All four admin curation tools shipped end-to-end on `/mcp-admin/*`; author/superadmin scope enforced by hybrid smoke on at least `merge_concepts` + `trigger_rebuild` (criterion 2 requires ≥ 2).
3. `tutorial://<slug>` and `mission://<slug>` (and `concept://<id>`) resources listable via `resources/list` and readable via `resources/read` on the composed endpoint; hybrid resource test green.
4. At least four shipping prompts under `prompts/list`, callable via `prompts/get`; loader boot-validates frontmatter.
5. Consumer quickstart + reference/architecture/operations docs extended with resource + prompt examples; all VitePress-sidebar-registered; Deploy-Docs green.
6. Compose router advertises `{tools, resources, prompts}` in one `initialize`; tool output byte-identical to the plain adapter; `MCP_PHASE3_ENABLED=false` cleanly reverts to Phase-2 behaviour.
7. Four env kill-switches wired; `/mcp-admin/*` approuter route deployed and XSUAA-scope-gated.
8. Phase 1 and Phase 2 surfaces unchanged (contract tests for both still green).

## Open Questions

Deferred, not blocking:

- Whether to adopt an upstream `@cap-js/mcp` resources/prompts API if one ships — the compose layer is designed to be deleted in that event.
- Resource subscriptions / `listChanged` — needs a session-ful transport; revisit if clients demand live updates.
- Whether `kg_community` should gain a promotion arm once #917 reaches PROD (currently read-only).
- Author-editable prompts via admin UI (currently code-shipped).

## References

- Phase 3 issue: [#1106](https://github.com/sap-tutorials/tutorials-ims/issues/1106)
- Phase 2 issue: [#1105](https://github.com/sap-tutorials/tutorials-ims/issues/1105) · design [`2026-07-08-mcp-server-phase2-design.md`](2026-07-08-mcp-server-phase2-design.md)
- Phase 1 issue: [#912](https://github.com/sap-tutorials/tutorials-ims/issues/912) · PR [#1011](https://github.com/sap-tutorials/tutorials-ims/pull/1011) · design [`2026-07-05-mcp-server-design.md`](2026-07-05-mcp-server-design.md)
- KG PageRank: #916 · KG WCC/isolation: #918 · KG communities (Louvain): #917 · On-demand extraction: #948
- CAP 10 MCP Protocol Adapter: https://cap.cloud.sap/docs/releases/2026/jun26#new-mcp-protocol-adapter
- MCP 2025-06 spec (resources, prompts, tool annotations): https://spec.modelcontextprotocol.io/specification/2025-06-18/
- Existing code Phase 3 touches:
  - `node_modules/@cap-js/mcp/lib/{index,tools,auth}.js` — the adapter seam (tool fns, auth check)
  - `srv/knowledge-graph-service.{cds,js}` — KG tool mount + existing graph handlers
  - `srv/admin-service.cds` — admin actions wrapped by WS2
  - `srv/lib/tutorial-step-slicer.js`, `srv/lib/content-store.js` — reused by resources
  - `srv/lib/mcp-arg-validators.js` — reused for clamps
  - `srv/lib/rebuild-trigger.js` — wrapped by `trigger_rebuild`
  - `srv/server.js:440-505` — MCP route rewrites (`/mcp-auth`, `/mcp-pat`); add `/mcp-admin` + compose mount
  - `approuter/xs-app.json` — add `^/mcp-admin/(.*)$` route
  - `xs-security.json` + `.deploy/xs-security.json` — `/mcp-admin` scope (both files)
  - `.deploy/mta.yaml` — `srv` + `srv-qa` cp-lists for `srv/mcp/prompts/*.md`
  - `test/unit/mcp-contract.test.js` — extends
