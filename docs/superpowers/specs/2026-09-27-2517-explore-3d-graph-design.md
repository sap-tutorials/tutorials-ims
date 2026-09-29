# 3D Force-Directed Knowledge Graph View for `/explore/` (#2517)

**Status:** Design approved, spec under review
**Date:** 2026-09-27
**Author:** Thomas Jung (with Claude)
**Issue:** [#2517](https://github.com/sap-tutorials/tutorials-ims/issues/2517)

## Summary

Add an opt-in 3D force-directed view to the `/explore/` Knowledge Graph page using
[`vasturiano/3d-force-graph`](https://github.com/vasturiano/3d-force-graph) (Three.js/WebGL),
alongside the existing Sigma.js 2D view. The 3D view is desktop-only, lazy-loaded, gated behind
a default-OFF feature flag, and sizes nodes by PageRank (exposed via a new optional field on
`/graph/explore-data`).

## Spike findings (throwaway POC, validated 2026-09-27)

Ran against the DEV backend's real KG (**6,319 nodes / 37,739 edges**, 4.4 MB payload):

1. **Renders correctly** — 3D force layout, color-by-type, size-by-degree, directional arrows +
   particles on `requires`/`teaches`. WebGL canvas confirmed.
2. **Bundle cost: 338 KB gzip** for the 3D chunk (`three` + `d3-force-3d`) — **2.25× the entire
   150 KB explore-app budget**. Only viable lazy-loaded / opt-in.
3. **Full unfiltered graph is a hairball** — 37.7k edges wash to grey; ~1.7 fps in headless
   software WebGL (real GPU far better, but directionally: unfiltered ≠ interactive). 3D **must**
   ship with default filtering.

**Verdict:** viable as a desktop-only opt-in "wow" view, not a replacement for the 2D default.

## Design

### §1 — Endpoint change (server)

`buildExplorePayload` (`srv/lib/kg-explore-data.js`) gains an **optional per-node `rank: number`**
(normalized 0–1). Sourced from the existing `ConceptRank` / `TutorialRank` sidecars via the
`_loadRankMapsFromDb()` LRU reader already in `srv/knowledge-graph-service.js` (5-min TTL,
single-flight guard, fails to empty maps).

- Gated by **`KG_PAGERANK_ENABLED`** (existing flag). Flag off or empty maps ⇒ `rank` omitted;
  client falls back to degree sizing.
- `rank` is **additive/optional** on the wire contract — the Sigma 2D view
  (`app/explore/src/components/ExploreGraph.vue`) and the related-graph sidebar
  (`hugo-apps/src/related-graph/`) ignore it harmlessly.
- No LOB in the query (rank tables are `{slug, score, computedAt}` scalars), so the
  "never SELECT a BLOB alongside metadata" gotcha does not apply.
- `generatedAt` / `droppedBindings` unchanged.

`app/explore/src/types.ts` `ExploreNode` gains `rank?: number` (mirror into
`hugo-apps/src/related-graph/types.ts` to keep the two NodeType/shape unions in sync).

### §2 — Client component + toggle

- Promote the spike's `ThreeDGraph.vue` to `app/explore/src/components/`.
- Extract shared color maps to `app/explore/src/node-colors.ts` (single source of truth); both
  2D and 3D import it. **Delete** the duplicate inline `NODE_COLORS`/`EDGE_COLORS` in
  `ExploreGraph.vue` and import from the shared module.
- `3d-force-graph` stays a **dynamic import** inside `ThreeDGraph.vue`; `App.vue` loads the
  component via `defineAsyncComponent` — `three`/`d3-force-3d` never enter the main entry chunk.
- Node sizing: `nodeVal` ∝ `rank` when present (§1), else degree.
- Color by type, directional arrows + particles on `requires`/`teaches`.
- Click → emits `nodeClick` → existing `NodeDetailPanel` (reused unchanged) + camera fly-to.
- Toggle: 2D/3D segmented control in the header row. Default **2D**.
- **Desktop-only:** mobile (`isMobile`) keeps `MobileTypedList`; no toggle rendered on mobile.
- Node-type/predicate filters apply to both views (they drive `filteredNodes`/`filteredEdges`).

### §3 — Feature flag + default filtering

**Two-layer gate:**

- Server `KG_PAGERANK_ENABLED` (existing) — governs whether `rank` ships.
- **New `KG_EXPLORE_3D_ENABLED`** — governs whether the 3D toggle is *offered*. Registered in
  `srv/lib/feature-flags/registry.js`, default **OFF**, DEV-first, **fail-open** (flag read fails
  ⇒ OFF ⇒ 2D only). Value reaches the client via a small `features` field on the
  `/graph/explore-data` response (confirm cheapest surface during implementation). Flag OFF ⇒
  toggle never renders ⇒ 3D chunk never downloads.

**Default filtering (hairball fix):** on first switch to 3D, apply a **default node-type subset**
instead of all 27 filters: **`tutorial + mission`** (~3,125 nodes, ~50% of the graph; missions
supply the connective tissue since tutorials have no direct tutorial↔tutorial edges — they link
through concepts/missions). Everything else — including `concept` — is opt-in via the existing
filter dropdown. Kept as a single named constant for easy tuning. The 2D view's all-on default is
unchanged.

### §4 — Bundle budget + testing

**Bundle budget** (`app/explore/vite.config.ts`): the `exploreBudget()` plugin currently sums all
`.js` chunks against 150 KB — would fail once the 3D chunk exists. Change to:

- Budget the **entry chunk only** (`main-*.js`) against 150 KB — excludes the lazy 3D chunk.
- Add a **separate explicit ceiling** on the 3D chunk (~400 KB gzip warn/fail) so its weight is
  tracked in CI, not silently unbounded.

**Testing:**

- **Server unit** (`npm test`, in-memory, no HANA): `buildExplorePayload` emits normalized `rank`
  when maps supplied; omits it when flag off / empty maps.
- **Flag:** `KG_EXPLORE_3D_ENABLED` off ⇒ payload advertises 3D off ⇒ no toggle.
- **Client (Vitest + @vue/test-utils on `App.vue`):** toggle renders only when flag on + desktop;
  clicking 3D mounts the async component (mock the dynamic import); mobile never shows toggle.
- **e2e (`test:e2e`, post-deploy, self-skips without `SMOKE_BASE_URL`):** canvas mounts, no console
  errors. Committed spec per CLAUDE.md `app/**` rule.
- **Manual GPU check:** maintainer runs locally before sign-off (headless FPS unrepresentative).

## Out of scope (v1)

- Find-path overlay in 3D.
- Exposing PageRank as an endpoint for consumers other than explore-data.
- Mobile 3D.

## Known adjacent issue (not addressed here)

`srv/search-service.cds:27` has a pre-existing `Duplicate definition of artifact "SearchService"`
compile error that blocks `cds-mcp` model introspection. Unrelated to this work; flagged for a
separate fix.

## Affected files

- `srv/lib/kg-explore-data.js` — add `rank` to node shape (§1)
- `srv/knowledge-graph-service.js` — reuse `_loadRankMapsFromDb()` from `buildExplorePayload` path (§1)
- `srv/lib/feature-flags/registry.js` — register `KG_EXPLORE_3D_ENABLED` (§3)
- `app/explore/src/node-colors.ts` — new shared color module (§2)
- `app/explore/src/components/ThreeDGraph.vue` — promote from spike (§2)
- `app/explore/src/components/ExploreGraph.vue` — import shared colors, drop inline maps (§2)
- `app/explore/src/App.vue` — toggle, async 3D component, default-filter-on-3D (§2, §3)
- `app/explore/src/types.ts` (+ `hugo-apps/src/related-graph/types.ts`) — `rank?` (§1)
- `app/explore/vite.config.ts` — split bundle budget (§4)
- `app/explore/package.json` — add `3d-force-graph` dependency
- Tests: server unit, flag, client Vitest, e2e spec (§4)
