# Knowledge graph — Phase 3 design: `/explore/` viz + concept landing pages

- **Status:** Approved (2026-06-27), pending spec-reviewer pass
- **Issue:** [#446](https://github.com/sap-tutorials/tutorials-ims/issues/446) (parent: [#381](https://github.com/sap-tutorials/tutorials-ims/issues/381))
- **Predecessor specs:** [`2026-06-17-knowledge-graph-design.md`](./2026-06-17-knowledge-graph-design.md) (Phase 1)
- **Predecessor rollout:** [`docs/superpowers/done/2026-06-19-knowledge-graph-phase1-shipped.md`](../done/2026-06-19-knowledge-graph-phase1-shipped.md), Phase 2 (PR [#563](https://github.com/sap-tutorials/tutorials-ims/pull/563))

## Summary

Phase 3 adds the two remaining knowledge-graph surfaces deferred from Phase 1:

1. **`/concepts/<slug>/`** — Hugo-generated static landing pages per concept, indexed by site search, linked from the Phase 1 tutorial sidebar.
2. **`/explore/`** — a public interactive viz of the entire knowledge graph (Sigma.js v3 + WebGL), with a "find a path from A to B" feature, telemetry, and a mobile fallback.

Both surfaces read the Phase 1 graph backend (`KnowledgeGraphService`, `/graph/*` OData, RDF projection in HANA KGE) without schema changes. The only schema-adjacent addition is a read-only CDS view `PublishedConcepts` that codifies the publication gate.

## Scope

### In scope

- **3-A — Concept landing pages.** One Hugo-built static page per publishable concept at `/concepts/<slug>/`. Page contents: name, admin-edited description (or LLM fallback), four related-entity sections (`teaches → tutorials`, `requires → concepts`, `requiredBy → concepts`, `relatedTo → concepts`). Indexed by `SearchService`. Phase 1 sidebar concept items flip from `<span>` to `<a href>` when the target concept is published.
- **3-B — `/explore/` interactive viz.** A new top-level public route at `/explore/`. CAP-rendered HTML shell with the graph data inlined as JSON; Sigma.js v3 + graphology + graphology-layout-forceatlas2 hydrates the viz client-side. Layout-D chrome (header search + find-path pickers + filters dropdown; right-side persistent node-detail panel; max viz canvas). Mobile (<768px) collapses to a typed accordion list — no viz on phones.
- **Find-a-path UI** invoking a new public `GET /graph/path?from=X&to=Y` endpoint (the Phase 2 Joule tool's path-finding logic, extracted into a shared module and exposed publicly).
- **`coCompletedWith` privacy** enforced at the projection layer (k-anonymity floor K=10, count rounded to nearest 10, edges with raw count <10 omitted).
- **Telemetry** — 8 new `UIEvent` events (6 explore + 2 concept), reusing the Phase 1 dispatcher.
- **Three-tier tests** (unit + hybrid + smoke) for every new endpoint and component.
- **Rollout note** in `docs/superpowers/done/`.

### Out of scope (deferred or yagni)

- Editing the graph from `/explore/` — admin curation remains at `/admin-ui/#concepts-display`.
- Multi-user collaboration features.
- Cross-corpus federation (e.g. SAP Help portal RDF).
- 3D / VR visualizations.
- A feature flag for opt-in rollout — the surfaces are read-only static-or-cached content, so the worst-case rollback is `git revert` + redeploy. Phase 1's `ChatSettings.ragEnabled` gating shape is not reused.
- A pre-rendered static PNG snapshot of the graph (first-paint optimization) — deferred until we measure real-world LCP for `/explore/` and find it lacking.

## Approach

Two independent surfaces sharing one data source — Phase 1's projected knowledge graph in HANA KGE. They can ship in either order. Section 6 below decomposes Phase 3 into nine PRs and locks the recommended sequence as **3-A first**, then **3-B**.

Concept pages (3-A) are pure static content — built at Hugo time, published as compressed BLOBs to HANA via the existing `/content/publish` pipeline, served via the existing `/content/<slug>` mechanism. No new runtime serving infrastructure.

The explore viz (3-B) is interactive but read-only. To meet the issue's "<2s to interactive on broadband DEV" acceptance criterion, the page is **CAP-rendered HTML** (not static Hugo) with the graph data inlined as `<script type="application/json" id="initial-graph">`. The Vue app reads it synchronously on mount instead of waiting for a fetch round-trip. This is the same "static-data-island" pattern Next.js / Nuxt use for SSR'd content.

Sigma.js v3 was chosen over D3-force, Cytoscape.js, and vis-network because it's the only candidate with WebGL rendering — and force-directed layout over 1700 nodes is the workload Sigma was purpose-built for. Bundle size at ~65KB gzip is also the smallest of the four. See Section 1.4 for the full rationale.

## 1. Architecture

### 1.1 Surfaces and ownership

| Surface | Owner | URL | Renderer | Build/serve time |
|---|---|---|---|---|
| Concept landing page | Hugo (static) | `/concepts/<slug>/` | Hugo `layouts/concepts/single.html` | Build-time |
| Explore page HTML shell | CAP express | `/explore/` | `srv/templates/explore.html` template | Request-time |
| Explore Vue bundle | Vite (app/explore/) | `/explore-ui/*` | Vue + Sigma.js, served as static | Build-time |
| Bulk graph JSON (runtime) | CAP | `/graph/explore-data` | `KnowledgeGraphService` | Request-time, 5-min cache |
| Build-time concept JSON | CAP | `/build/concepts` | `KnowledgeGraphService` | Build-time |
| Path-finding | CAP | `/graph/path?from=X&to=Y` | Shared module (Phase 2 Joule tool's logic, extracted) | Request-time |

### 1.2 The 3-A surface (concept pages)

Flow:

```text
Hugo build
  └── scripts/fetch-concepts.ts  (new sibling of fetch-tutorials.ts)
        └── GET /build/concepts → CAP
              └── KnowledgeGraphService.PublishedConcepts (CDS view)
        └── emit hugo/content/concepts/<slug>.md (one per publishable concept)
              └── frontmatter only — Hugo template renders body
  └── npm run build (Hugo)
        └── hugo/public/concepts/<slug>/index.html
  └── npm run publish-content
        └── stored in ContentFiles HANA BLOB → served via /content/concepts/<slug>
              └── approuter route /concepts/* → CAP /content/concepts/$1
```

The Phase 1 sidebar island (`hugo-apps/src/tutorial-related-graph/`) fetches its data through `/graph/concept-bundle/:tutorialSlug` (existing endpoint). Phase 3 extends that payload with a `published: boolean` per concept; the island renders `<a href="/concepts/<slug>/">` when `published=true` and `<span>` otherwise. No new endpoint.

### 1.3 The 3-B surface (`/explore/`)

Flow:

```text
Browser
  └── GET /explore/  →  approuter proxy  →  CAP express GET /explore/
        └── single SPARQL query → bulk explore-data JSON (same as /graph/explore-data)
        └── renders srv/templates/explore.html with substitutions:
              - __INITIAL_GRAPH_JSON__
              - __BUNDLE_HASH__
              - __META_DESCRIPTION__
        └── returns text/html (<100ms target)
  └── Vue app boots from <script src="/explore-ui/main-${hash}.js">
        - Reads window.__INITIAL_GRAPH__ synchronously
        - Calls graphology constructor, then graphology-layout-forceatlas2 (50 iterations)
        - Hands the graph to Sigma for WebGL rendering
        - Wires up Layout-D chrome (header pickers, filters, side panel)
```

Approuter routes:

- `^/explore/?$` → CAP `/explore/` (proxy)
- `^/explore-ui/` → static (Vue bundle from `approuter/static/explore-ui/`)
- `^/graph/path` → CAP (proxy, public)
- `^/graph/explore-data` → CAP (proxy, public)

### 1.4 Viz library choice — Sigma.js v3

Decided in brainstorming (Q7). Four candidates evaluated:

| Library | Bundle (gzip) | Rendering | Perf @ 1700 nodes | Bus factor |
|---|---|---|---|---|
| D3-force | ~50KB | SVG | ★★☆☆☆ — SVG re-flows hurt above ~500 | Stable, huge ecosystem |
| **Sigma.js v3** | **~65KB** | **WebGL** | **★★★★★ — scales to 100K+** | **Active, TS-first, multi-maintainer** |
| Cytoscape.js | ~130KB | Canvas | ★★★★☆ | Stable, biotech-pedigree |
| vis-network | ~140KB | Canvas | ★★★☆☆ — physics slow at scale | Very mature |

Sigma.js wins on perf (WebGL rendering is the only candidate that scales cleanly past ~1000 nodes) **and** bundle size. The Vue boundary keeps Sigma isolated to a single `<ExploreGraph>` component, so if a future need calls for a different library we replace one component, not the app.

Stack components:

- **graphology** — data-model layer (library-agnostic). Holds nodes, edges, attributes. Vue mounts to a graphology instance, not directly to Sigma.
- **sigma** — WebGL renderer. Reads from graphology.
- **graphology-layout-forceatlas2** — layout algorithm. Capped at 50 iterations (most convergence happens in the first ~30); subsequent panning is WebGL-cheap.

### 1.5 Layout — Layout D (chosen in Q10)

Single top header bar contains, left-to-right:

- Site logo / breadcrumb
- Search box (autocomplete over node labels)
- Find-a-path pickers: `From: [▾]  →  To: [▾]  [Find]`
- Filters dropdown — toggle node-type and predicate visibility

Below the header:

- **Left ~80%**: viz canvas (Sigma WebGL surface, full height)
- **Right ~20%**: persistent node-detail side panel
  - When no node selected → empty state with usage hint
  - When a node is selected → name, type, link to the underlying tutorial/concept, list of incident edges grouped by predicate

The side panel is persistent (not popover) for screen-reader / keyboard support and for the "click the next node while keeping the current detail visible" pattern.

### 1.6 Mobile fallback (chosen in Q5)

Below ~768px viewport width:

- The viz canvas is replaced by a **typed accordion list** consuming the same `/graph/explore-data` JSON.
- Top level: four accordion sections — Tutorials (N), Concepts (N), Missions (N), Products (N).
- Tapping a section expands a flat alphabetically-sorted list.
- Tapping a node navigates to its underlying tutorial / concept page.
- The search box and filter dropdown remain functional; the find-path pickers do not (would need the viz to render the overlay).

Reason: force-directed graphs are a well-known anti-pattern on phones (pinch-zoom + force layout = frustration). Force-fitting the viz to mobile would deliver a worse experience than honest collapse to a list.

## 2. Data model

### 2.1 No new tables

Phase 3 reads from Phase 1's tables (`Concepts`, `ConceptEdges`, `TutorialConceptLinks`) and the existing `Tutorials`, `Missions`, `Groups`, `Products` tables via existing CDS associations and SPARQL named queries. The Phase 1 projection of all of these into HANA KGE as RDF triples (graph `<urn:sap:tutorials:kg>`) is also reused as-is.

### 2.2 New CDS view — `PublishedConcepts`

In `srv/knowledge-graph-service.cds`:

```cds
@readonly
entity PublishedConcepts as projection on db.Concepts {
  *
} where status = 'ACTIVE' or lastEditedBy is not null;
```

This codifies the publication gate decided in Q4: a concept is "publishable" if **either** an admin has reviewed-and-flipped its status to `ACTIVE`, **or** an admin has edited its `name` or `description` at least once. The OR keeps the workflow flexible (admins can publish either by approving as-is, or by polishing).

Anywhere downstream that needs "is this concept publishable" reads `PublishedConcepts`:

- `/build/concepts` selects from it.
- `SearchService` joins against it for the concept-search-results path.
- `/graph/concept-bundle/:tutorialSlug` joins to populate the `published: boolean` per sidebar concept.

### 2.3 `coCompletedWith` k-anonymity (Q2)

Enforced at the **projection layer** — i.e. the nightly `graphRebuild` cron, when projecting `TaskRecord` co-completions into RDF triples, applies:

```sql
SELECT a.tutorial_id, b.tutorial_id, ROUND(COUNT(DISTINCT user_id) / 10) * 10 AS cnt
FROM TaskRecord a JOIN TaskRecord b ON a.user_id = b.user_id AND a.tutorial_id < b.tutorial_id
WHERE a.status = 'COMPLETE' AND b.status = 'COMPLETE'
GROUP BY a.tutorial_id, b.tutorial_id
HAVING COUNT(DISTINCT user_id) >= 10
```

The raw count never reaches the RDF graph; the raw `TaskRecord` remains `@PersonalData`-tagged and admin-access-only. By enforcing at the projection (not at the API), a query bug downstream **cannot** accidentally leak the raw count — the data isn't there to leak.

### 2.4 Endpoint contracts

#### `GET /build/concepts` (unauthenticated, Hugo build-time)

Used by `scripts/fetch-concepts.ts`. Returns:

```json
{
  "concepts": [
    {
      "slug": "cap-handlers",
      "name": "CAP handlers",
      "description": "Multi-line concept description.",
      "teaches": [{ "slug": "cap-tut-1", "title": "..." }],
      "requires": [{ "slug": "node-basics", "name": "Node basics" }],
      "requiredBy": [{ "slug": "cap-advanced", "name": "CAP advanced" }],
      "relatedTo": [{ "slug": "cds-modeling", "name": "CDS modeling" }]
    }
  ],
  "generatedAt": "2026-06-27T12:34:56Z"
}
```

Implementation: read `PublishedConcepts`, then for each row run the Phase 1 `neighborhood(slug)` SPARQL named query. ~30-100 concepts × ~50ms each = ~3-10s total at build time — well inside Hugo's build budget.

#### `GET /graph/explore-data` (unauthenticated, runtime, 5-min cache)

```json
{
  "nodes": [
    { "id": "t:cap-handlers", "type": "tutorial", "label": "CAP handlers", "slug": "cap-handlers" },
    { "id": "c:cap-handlers", "type": "concept", "label": "CAP handlers", "slug": "cap-handlers" }
  ],
  "edges": [
    { "s": "t:cap-handlers", "p": "teaches", "o": "c:cap-handlers" },
    { "s": "t:cap-handlers", "p": "coCompletedWith", "o": "t:foo", "count": 30 }
  ],
  "generatedAt": "2026-06-27T12:34:56Z"
}
```

- Single SPARQL query against the projected graph.
- `count` only appears on `coCompletedWith` edges; rounded to nearest 10; never below 10.
- Server gzipped via existing `compression` middleware.
- Target payload: 80-200KB gzip for ~1700 nodes / ~10k edges. Section 5 has the fallback if we exceed.

#### `GET /explore/` (unauthenticated, runtime, no cache by default)

Returns `text/html`. Body is `srv/templates/explore.html` with substitutions:

- `__INITIAL_GRAPH_JSON__` — same payload as `/graph/explore-data`, computed inline (single shared module call).
- `__BUNDLE_HASH__` — content-hash of the Vue bundle, for `<script src="/explore-ui/main-${hash}.js">` cache-bust.
- `__META_DESCRIPTION__` — fixed SEO description.

Response time target: <100ms server-side.

#### `GET /graph/path?from=X&to=Y` (unauthenticated, runtime)

Wraps the same path-finding logic Phase 2 ships as a Joule tool. Extracted into a shared module (`srv/lib/kg-path.js`); both the Joule tool and this HTTP endpoint call it.

```json
{
  "from": "cap-handlers",
  "to": "advanced-cap-patterns",
  "steps": [
    { "slug": "cap-handlers", "type": "tutorial", "title": "..." },
    { "slug": "cap-error-handling", "type": "tutorial", "title": "..." },
    { "slug": "advanced-cap-patterns", "type": "tutorial", "title": "..." }
  ]
}
```

Returns 404 if no path exists. Inputs validated against the published node set; non-existent slugs return 400.

### 2.5 Concept page Hugo source shape

`hugo/content/concepts/<slug>.md` is **frontmatter-only**:

```yaml
---
type: concept
slug: cap-handlers
name: CAP handlers
description: |-
  Multi-line concept description here.
teaches: [{slug: "...", title: "..."}]
requires: [{slug: "...", name: "..."}]
requiredBy: [{slug: "...", name: "..."}]
relatedTo: [{slug: "...", name: "..."}]
---
```

The Hugo layout `layouts/concepts/single.html` reads the frontmatter and emits the four related-entity sections. Body markdown is empty — the layout owns the rendering.

Slug normalization is lowercase canonical (same as the existing `srv/lib/_tutorials-table.js` `tutorialsTableInfo` helper); enforced server-side in `/build/concepts`.

## 3. Telemetry

Eight new `UIEvent` events, reusing the Phase 1 dispatcher:

| Event | Fired when | Payload |
|---|---|---|
| `kg.concept.viewed` | `/concepts/<slug>/` page loads | `{slug}` |
| `kg.concept.tutorial_clicked` | User clicks a tutorial link on a concept page | `{conceptSlug, tutorialSlug}` |
| `kg.explore.viewed` | `/explore/` page loads + graph hydrates | `{nodeCount, edgeCount}` |
| `kg.explore.node_clicked` | User clicks a node (panel updates) | `{nodeId, nodeType}` |
| `kg.explore.node_navigated` | Click navigates away (vs just re-center) | `{nodeId, nodeType, targetUrl}` |
| `kg.explore.search` | User submits search input | `{query, resultCount}` |
| `kg.explore.filter` | User toggles a filter (node-type or predicate) | `{filter, enabled}` |
| `kg.explore.path_drawn` | Find-path returns and overlays a path | `{from, to, stepCount}` |

`kg.explore.node_clicked` distinguished from `kg.explore.node_navigated` for forensic value — lets us measure exploration depth (how many clicks before someone leaves the page) vs drop-off into a tutorial.

## 4. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Sigma.js perf at the issue's "5000-node" worst case | Medium — Sigma is built for this but it's not free | High if it misses the <2s TTI | 3-B-2 PR includes a 5000-node synthetic-fixture benchmark before commit. ForceAtlas2 iterations capped at 50. Fallback: `displayedNodes = top-200 by degree centrality` + "show all" toggle. |
| LLM-extracted concept content on public pages exposes garbage | Medium — Phase 1 saw a ~30% "needs admin review" rate at extraction | High — public-facing bad copy hurts trust | Q4's edit-OR-status gate **is** the mitigation. 3-A-3 admin "Public" badge surfaces what's live. Hugo build prints `X published, Y skipped` counter. Admin can VETO and the page auto-disappears next build. |
| Viz library lock-in | Low — Sigma v3 is small + stable | Medium if we want to swap | graphology (data) is library-agnostic; Sigma (renderer) is isolated to one `<ExploreGraph>` component. Swap = rewrite one component. |
| Concept pages compete with tutorial pages for SEO | Low — concept pages are derived/aggregated | Medium if Google ranks `/concepts/X/` over the actual tutorial | Concept-page internal link graph drives PageRank to tutorials. Sitemap submission de-prioritizes concept pages. Monitor first month; add `<meta name="robots" content="noindex,follow">` if SERP cannibalization shows up. |
| First-paint regression on `/explore/` (inline JSON balloons HTML > 200KB) | Medium — depends on graph size growth | Medium — slow LCP hurts perceived perf | `/graph/explore-data` size measured in 3-B-1 PR; if >200KB gzip, trim to top-N by degree centrality and lazy-load the long-tail. Acceptance: p95 LCP for `/explore/` <1.5s on DEV. |

Risks considered and not tracked: bot/crawler scraping the public JSON to reconstruct user-derived patterns. K-anonymity floor (K=10) is the structural protection; an attacker scraping 100% of the public JSON learns only the same coarse bands any single-tutorial-OP visitor sees. Not worth a rate-limit.

## 5. Testing strategy

Phase 3 reuses the three-tier (unit / hybrid / smoke) `vitest` workspace established in Phase 1. No new test runners.

### 5.1 Unit (in-memory SQLite)

- `PublishedConcepts` view: returns rows for `status=ACTIVE`, returns rows for `lastEditedBy IS NOT NULL`, excludes both-conditions-false rows.
- `/build/concepts` payload shape: matches contract in Section 2.4.
- Hugo frontmatter generator: emits valid YAML for representative concepts (no special-char escapes broken); slug lowercase-normalized.
- `searchAll(q)`: returns concept rows with `type: 'concept'` matching `PublishedConcepts.name`; excludes unpublished concepts.
- `/graph/explore-data` payload shape; k-anonymity invariant — no `coCompletedWith` edge with raw count <10 in output, all surviving counts divisible by 10.
- Vue component tests for header pickers (autocomplete + debounce), filter dropdown, find-path picker, side panel, mobile typed-list — using the existing `@vue/test-utils` setup.

### 5.2 Hybrid (real HANA via `cds bind --exec`)

Under `test/hybrid/`:

- `concepts-published-view.test.js` — seed three concepts (PENDING, ACTIVE, PENDING-but-edited); assert `PublishedConcepts` returns exactly the second and third. Cleans up.
- `build-concepts.test.js` — HTTP probe against the hybrid CAP server; assert shape and SPARQL-resolved related-tutorials/concepts.
- `graph-explore-data.test.js` — probe `/graph/explore-data` against real DEV data; assert k-anonymity invariant holds.
- `graph-path.test.js` — probe `/graph/path?from=X&to=Y`; assert same path as Phase 2 Joule tool returns for representative inputs.

All write tests respect the existing `ALLOW_HYBRID_WRITES=true` guard and `__TEST__` data prefix.

### 5.3 Smoke (HTTP against deployed `SMOKE_BASE_URL` / `SMOKE_SRV_URL`)

Under `test/smoke/`:

- `concepts-route.smoke.test.js` — `GET /concepts/<known-published-slug>/` returns 200 with the concept name in body; unknown slug returns 404.
- `explore-route.smoke.test.js` — `GET /explore/` returns 200; HTML contains the `__INITIAL_GRAPH__` JSON block and references the bundle; bundle URL is loadable; bundle includes Sigma.
- `graph-explore-data.smoke.test.js` — `GET /graph/explore-data` returns 200; JSON parses; has `nodes` and `edges` arrays.
- `graph-path.smoke.test.js` — `GET /graph/path?from=...&to=...` returns 200 with `steps` array.

The existing `auth-enforcement.smoke.test.js` is extended to assert the four new routes are unauthenticated.

### 5.4 One-shot performance probe (not a CI gate)

For 3-B-2's PR — manual Playwright run loading `/explore/` against a synthetic 5000-node fixture; captures TTI via `performance.mark`. Documented in the PR description, not a CI gate (too flaky for CI). Goal: <2s to interactive on a typical broadband DEV browser (the issue's acceptance criterion).

## 6. PR decomposition + ship sequence

### 6.1 Track 3-A — Concept landing pages (3 PRs, ~1 week)

| PR | Title | What it lands |
|---|---|---|
| **3-A-1** | `feat(kg): /build/concepts endpoint + PublishedConcepts view` | The `PublishedConcepts` CDS view; the `/build/concepts` Express route on CAP; unit + hybrid tests. No front-end change. |
| **3-A-2** | `feat(kg): concept landing pages — Hugo template + build wiring` | `hugo/content/concepts/` generator (`scripts/fetch-concepts.ts`); `layouts/concepts/single.html`; pages publish via existing `/content/publish` to `/content/concepts/:slug`; approuter route `/concepts/*` → CAP. Smoke test for one slug. Hugo build prints `X published, Y skipped` counter. |
| **3-A-3** | `feat(kg): sidebar concept links + search + admin "Public" badge` | Phase 1 sidebar island flips to `<a>` when `published=true`; `SearchService` indexes `PublishedConcepts`; admin Concepts list adds "Public" column; telemetry `kg.concept.viewed`, `kg.concept.tutorial_clicked` wired. |

### 6.2 Track 3-B — `/explore/` interactive viz (6 PRs, ~2-3 weeks)

| PR | Title | What it lands |
|---|---|---|
| **3-B-1** | `feat(kg): /graph/explore-data + k-anonymity projection` | Server endpoint; k-anonymity floor enforced in nightly `graphRebuild` cron; 5-min response cache; hybrid test asserts no <K edges leak. No front-end. |
| **3-B-2** | `feat(kg): app/explore/ Vue+Vite scaffold + Sigma.js wiring` | New peer of `app/analytics-explorer/`; bundles Sigma.js v3 + graphology + graphology-layout-forceatlas2; gzip-budgeted (≤150KB); reads `window.__INITIAL_GRAPH__` synchronously; canvas only, no chrome. Includes 5000-node synthetic benchmark in PR description. |
| **3-B-3** | `feat(kg): /explore/ CAP-rendered shell with inline JSON` | `GET /explore/` express route; HTML template; approuter proxy `/explore/` → CAP. End-to-end: hitting `/explore/` renders the graph. |
| **3-B-4** | `feat(kg): explore page chrome — header pickers, filters dropdown, side panel` | Vue components for Layout-D: search, find-path pickers (UI only — wires to the Phase 2 tool in next PR), filters dropdown, right side panel. Filters are client-side hide/show. Telemetry events 3-6 above. |
| **3-B-5** | `feat(kg): /graph/path endpoint + find-path UI overlay` | Extract path-finding logic to `srv/lib/kg-path.js`; both Joule tool and new `/graph/path?from=X&to=Y` HTTP endpoint call it. UI wires header pickers to the endpoint; result overlays path edges + camera-fits bounding box + side panel shows steps. Telemetry `kg.explore.path_drawn`. |
| **3-B-6** | `feat(kg): mobile typed-list fallback + smoke + rollout note` | Below ~768px, viz replaced by typed accordion list. Final smoke tests across all new routes. Rollout note in `docs/superpowers/done/`. |

### 6.3 Ship sequence: 3-A first

Decided in brainstorming. Heals dead concept clicks early. De-risks `/graph/*` traffic by routing it to a low-traffic surface (concept pages) before the high-traffic surface (the public viz). Sigma.js spike happens in 3-B-2 against real data, not as a separate Day-1 spike PR.

### 6.4 No feature flag

The two surfaces are read-only static-or-cached content. Worst-case rollback is `git revert` + redeploy. Phase 1's `ChatSettings.ragEnabled` opt-in shape is not reused for Phase 3.

### 6.5 Documentation drops

- `docs/developers/architecture/knowledge-graph-phase3.md` (new) — explore page + concept pages architecture; Sigma.js wiring; k-anonymity invariant; mobile fallback.
- `docs/developers/operations/testing-endpoints.md` (extend) — add `/concepts/*`, `/explore/`, `/graph/explore-data`, `/graph/path` to the public-endpoints table.
- `docs/superpowers/done/2026-XX-XX-knowledge-graph-phase3-shipped.md` (new) — same shape as Phase 1's rollout note, written by 3-B-6.

## 7. Acceptance criteria

Phase 3 is "shipped" when **all** of these are true:

- [ ] `/concepts/<slug>/` exists for every concept satisfying the edit-OR-status gate.
- [ ] Phase 1 sidebar concept items are `<a>` (published) or `<span>` (unpublished).
- [ ] Site search returns concept results with a `type: 'concept'` discriminator.
- [ ] Admin Concepts list shows a "Public" badge per row.
- [ ] Hugo build emits a `X published concepts, Y skipped` counter at deploy time.
- [ ] `/explore/` route serves the viz; loads to interactive in <2s on broadband DEV.
- [ ] Click a tutorial node → graph re-centers; click again → navigates to `/tutorials/<slug>/`.
- [ ] "Find a path" UI invokes `/graph/path` and overlays the result on the graph.
- [ ] Mobile (<768px) renders the typed accordion list instead of the viz.
- [ ] All 8 telemetry events fire and land in `UIEvent`.
- [ ] k-anonymity verified: no `coCompletedWith` edge with raw count <10 leaks via `/graph/explore-data`.
- [ ] Phase 3 rollout note in `docs/superpowers/done/`.
- [ ] All three test tiers pass for the 9 PRs.

## 8. Decisions locked

| # | Decision | Rationale |
|---|---|---|
| 1 | Single spec covering 3-A (concept pages) + 3-B (explore viz) | They share a data source and ship cleanly in either order; decompose at PR-plan time, not at spec time. |
| 2 | `coCompletedWith` k-anonymity floor K=10, rounded to nearest 10 | Enforced at the projection layer (graphRebuild cron). Below-K edges omitted; raw counts never reach RDF. |
| 3 | Concept URL: `/concepts/<slug>/` top-level | Concept pages are static-rendered Hugo content (peer of `/tutorials/<slug>/`), not "explore mode" content. Decouples 3-A from 3-B shipping order. |
| 4 | Concept page gate: `status='ACTIVE' OR lastEditedBy IS NOT NULL` | Permissive — admins can publish either by flipping status or by polishing content; both surfaces are visible in the admin UI's new "Public" badge. |
| 5 | Mobile fallback: typed accordion list (no viz) | Force-directed viz is a known anti-pattern on phones; honest collapse to a list is better than fighting touch pinch-zoom. |
| 6 | First-paint: inline JSON blob, CAP-rendered `/explore/`, synchronous client hydration | Zero network round-trip for graph data. Pre-rendered PNG snapshot pipeline (issue's suggestion) deferred. |
| 7 | Viz library: Sigma.js v3 + graphology + graphology-layout-forceatlas2 | Only WebGL candidate that scales cleanly past ~1000 nodes; smallest bundle of the four shortlisted libraries. |
| 8 | Find-path UI: two pickers in the explore page header, always visible | Most demo-able shape for the issue's stated "Twitch / TechEd showcase" angle. |
| 9 | Telemetry: 8 events, reuse Phase 1 `UIEvent` pipeline | No new infrastructure; 6 explore events + 2 concept events for forensic value. |
| 10 | Layout D: header has search + pickers + filters dropdown; right-side persistent detail panel | Maximizes viz canvas while keeping all controls visible and accessible. |
| 11 | Ship sequence: 3-A first, then 3-B | Heals dead concept clicks early; de-risks the new `/graph/*` traffic; Sigma spike happens against real data inside 3-B-2 (no separate spike PR). |
| 12 | Path-finding architecture: promote Phase 2 logic to public `/graph/path?from=X&to=Y` endpoint, called by both Joule tool and the explore UI | Cleanest seam; small refactor (extract SPARQL execution to a shared module); avoids divergence. |
| 13 | No feature flag | Read-only static-or-cached surfaces; rollback is `git revert` + redeploy. |

## 9. Open questions

None — all design questions raised in the issue and during brainstorming are resolved in Section 8.

## 10. Refs

- Issue: [#446](https://github.com/sap-tutorials/tutorials-ims/issues/446)
- Parent: [#381](https://github.com/sap-tutorials/tutorials-ims/issues/381)
- Phase 1 design: [`2026-06-17-knowledge-graph-design.md`](./2026-06-17-knowledge-graph-design.md)
- Phase 1 rollout: [`docs/superpowers/done/2026-06-19-knowledge-graph-phase1-shipped.md`](../done/2026-06-19-knowledge-graph-phase1-shipped.md)
- Phase 2 PR: [#563](https://github.com/sap-tutorials/tutorials-ims/pull/563)
- Sigma.js: <https://www.sigmajs.org/>
- graphology: <https://graphology.github.io/>
