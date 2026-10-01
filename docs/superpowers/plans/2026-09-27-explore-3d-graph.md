# 3D Force-Directed KG View for `/explore/` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, desktop-only, lazy-loaded 3D force-directed view to `/explore/`, gated by a default-OFF feature flag, with nodes sized by PageRank.

**Architecture:** `buildExplorePayload` gains an optional per-node `rank` (from existing ConceptRank/TutorialRank sidecars, injected via `opts` to keep the function pure). A new `KG_EXPLORE_3D_ENABLED` flag is advertised on the payload's `features` object; the Vue app conditionally renders a 2D/3D toggle. The 3D component dynamic-imports `3d-force-graph` so `three`/`d3-force-3d` stay out of the entry chunk. First switch to 3D applies a default node-type subset to keep the scene interactive.

**Tech Stack:** CAP Node.js (ESM), Vue 3 `<script setup>` + TS, Vite, Vitest, `3d-force-graph` (Three.js/WebGL), Sigma.js (existing 2D).

**Spec:** `docs/superpowers/specs/2026-09-27-2517-explore-3d-graph-design.md`

## Global Constraints

- Node baseline 20+; native `fetch` (no axios). ESM throughout `srv/`.
- Never SELECT a HANA BLOB alongside metadata (N/A here — rank tables are scalar).
- New feature flag: default **OFF**, DEV-first, **fail-open** (read failure ⇒ OFF).
- `rank` is **additive/optional** on the wire contract — never required; 2D + sidebar ignore it.
- Explore entry chunk (`main-*.js`) gzip budget: **150 KB**. 3D chunk must NOT count against it.
- `app/explore/src/types.ts` and `hugo-apps/src/related-graph/types.ts` NodeType/shape unions stay in sync.
- PR targets **DEV**, not main. Commit frequently.

---

### Task 1: Shared color module

**Files:**
- Create: `app/explore/src/node-colors.ts`
- Modify: `app/explore/src/components/ExploreGraph.vue` (remove inline `NODE_COLORS`/`EDGE_COLORS`, import from module; keep `colorForNodeType`/`edgeColorForType` call sites working)
- Test: `app/explore/src/node-colors.test.ts`

**Interfaces:**
- Produces: `NODE_COLORS: Record<NodeType,string>`, `EDGE_COLORS: Record<PredicateType,string>`, `colorForNodeType(t: NodeType): string`, `edgeColorForPredicate(p: PredicateType): string`.

- [ ] **Step 1: Write the failing test**

```ts
// app/explore/src/node-colors.test.ts
import { describe, it, expect } from 'vitest'
import { colorForNodeType, edgeColorForPredicate, NODE_COLORS } from './node-colors'

describe('node-colors', () => {
  it('maps known node types to their SAP colors', () => {
    expect(colorForNodeType('tutorial')).toBe('#0a6ed1')
    expect(colorForNodeType('concept')).toBe('#107e3e')
  })
  it('falls back to neutral grey for an unknown type', () => {
    // @ts-expect-error deliberately invalid
    expect(colorForNodeType('nope')).toBe('#8c8c8c')
  })
  it('defaults edges to grey and colors session predicates', () => {
    expect(edgeColorForPredicate('teaches')).toBe('#999999')
    expect(edgeColorForPredicate('presents')).toBe('#e97800')
  })
  it('covers every NodeType (no undefined)', () => {
    for (const c of Object.values(NODE_COLORS)) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/explore && npx vitest run src/node-colors.test.ts`
Expected: FAIL — cannot resolve `./node-colors`.

- [ ] **Step 3: Create the module**

Create `app/explore/src/node-colors.ts` with `NODE_COLORS` and `EDGE_COLORS` copied verbatim from the current inline maps in `ExploreGraph.vue` (tutorial `#0a6ed1` … `devtoberfest-session` `#e97800`; edges default `#999999`, `coCompletedWith` `#cccccc`, `presents`/`aboutTutorial` `#e97800`), plus:

```ts
export function colorForNodeType(t: NodeType): string { return NODE_COLORS[t] ?? '#8c8c8c' }
export function edgeColorForPredicate(p: PredicateType): string { return EDGE_COLORS[p] ?? '#999999' }
```

Import `NodeType`/`PredicateType` from `./types`.

- [ ] **Step 4: Refactor ExploreGraph.vue to use the module**

Delete the inline `const NODE_COLORS`/`const EDGE_COLORS` blocks in `ExploreGraph.vue`. Add `import { NODE_COLORS, EDGE_COLORS } from '../node-colors'`. Keep the file's own `colorForNodeType`/`edgeColorForType` helpers pointing at the imported maps (or import the shared helpers and drop the local ones — whichever preserves current call sites with the smallest diff).

- [ ] **Step 5: Run tests to verify pass + no 2D regression**

Run: `cd app/explore && npx vitest run`
Expected: PASS (new test + existing ExploreGraph tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add app/explore/src/node-colors.ts app/explore/src/node-colors.test.ts app/explore/src/components/ExploreGraph.vue
git commit -m "refactor(explore): extract shared node/edge color maps (#2517)"
```

---

### Task 2: `rank` on the payload (pure function)

**Files:**
- Modify: `srv/lib/kg-explore-data.js` (`buildExplorePayload` — accept rank maps via `opts`, stamp nodes)
- Modify: `app/explore/src/types.ts` and `hugo-apps/src/related-graph/types.ts` (`rank?: number` on `ExploreNode`)
- Test: `srv/lib/kg-explore-data.test.js` (extend, or create if absent)

**Interfaces:**
- Consumes: existing `buildExplorePayload(db, opts)` returning `{nodes, edges, generatedAt, droppedBindings}`.
- Produces: `buildExplorePayload(db, opts)` where `opts.rankMaps?: { conceptRank: Map<string,number>, tutorialRank: Map<string,number> }`. When supplied, each node gets `rank: number` in `[0,1]` (max-normalized within its own map: tutorial nodes normalized against `tutorialRank` max, concept nodes against `conceptRank` max); nodes with no rank entry get no `rank` key. When `opts.rankMaps` absent/empty ⇒ no `rank` key on any node.

- [ ] **Step 1: Write the failing test**

```js
// srv/lib/kg-explore-data.test.js
import { describe, it, expect, vi } from 'vitest'
import { buildExplorePayload } from './kg-explore-data.js'

// Minimal fake: kgQuery is called with { db }, returns a SPARQL-ish response
// this test injects. We stub the module boundary the same way existing tests do
// (check the top of this file for the established kgQuery mock pattern and reuse it).
// The row here yields one tutorial node t:a and one concept node c:b via `teaches`.

describe('buildExplorePayload rank', () => {
  it('omits rank when no rankMaps supplied', async () => {
    const payload = await buildExplorePayload(fakeDb, {})
    for (const n of payload.nodes) expect(n).not.toHaveProperty('rank')
  })
  it('stamps normalized rank per map when rankMaps supplied', async () => {
    const rankMaps = {
      tutorialRank: new Map([['a', 5], ['other', 10]]), // a normalizes to 0.5
      conceptRank:  new Map([['b', 4]]),                 // b is the max → 1
    }
    const payload = await buildExplorePayload(fakeDb, { rankMaps })
    const a = payload.nodes.find(n => n.id === 't:a')
    const b = payload.nodes.find(n => n.id === 'c:b')
    expect(a.rank).toBeCloseTo(0.5, 5)
    expect(b.rank).toBeCloseTo(1, 5)
  })
})
```

(Set up `fakeDb` + the `kgQuery` stub following the existing mock convention already in this test file / its siblings; the response must parse to nodes `t:a`, `c:b` with an edge `teaches`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <repo root> && npx vitest run srv/lib/kg-explore-data.test.js`
Expected: FAIL — `rank` undefined / property present when it should be absent.

- [ ] **Step 3: Implement rank stamping**

In `buildExplorePayload`, after the `for (const r of rows)` loop and before the `return`, add:

```js
const rankMaps = opts.rankMaps;
if (rankMaps && (rankMaps.tutorialRank?.size || rankMaps.conceptRank?.size)) {
  const maxOf = (m) => { let mx = 0; for (const v of m.values()) if (v > mx) mx = v; return mx || 1; };
  const tMax = maxOf(rankMaps.tutorialRank ?? new Map());
  const cMax = maxOf(rankMaps.conceptRank ?? new Map());
  for (const node of nodesById.values()) {
    const src = node.type === 'tutorial' ? rankMaps.tutorialRank
      : node.type === 'concept' ? rankMaps.conceptRank : null;
    if (!src) continue;
    const raw = src.get(node.slug);
    if (raw == null) continue;
    node.rank = raw / (node.type === 'tutorial' ? tMax : cMax);
  }
}
```

Add `rank?: number` to `ExploreNode` in both `app/explore/src/types.ts` and `hugo-apps/src/related-graph/types.ts` (with a `// #2517` comment).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/lib/kg-explore-data.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg-explore-data.js srv/lib/kg-explore-data.test.js app/explore/src/types.ts hugo-apps/src/related-graph/types.ts
git commit -m "feat(explore): optional per-node rank on explore-data payload (#2517)"
```

---

### Task 3: Register `KG_EXPLORE_3D_ENABLED` + advertise on payload

**Files:**
- Modify: `srv/lib/feature-flags/registry.js` (new entry)
- Modify: `srv/lib/build-explore-data.js` (Express wrapper — read flag, load rank maps when `KG_PAGERANK_ENABLED`, pass to `buildExplorePayload`, attach `features`)
- Test: `srv/lib/build-explore-data.test.js` (create or extend)

**Interfaces:**
- Consumes: `buildExplorePayload(db, { rankMaps })` from Task 2; the rank-maps reader from `srv/knowledge-graph-service.js` (export `_loadRankMapsFromDb` if not already exported, or add a thin exported `loadRankMaps()` wrapper).
- Produces: `/graph/explore-data` response gains `features: { threeD: boolean }`. `threeD === true` iff `KG_EXPLORE_3D_ENABLED` resolves truthy.

- [ ] **Step 1: Add the registry entry**

In `srv/lib/feature-flags/registry.js`, add (mirroring the `KG_PAGERANK_ENABLED` entry at ~line 72):

```js
{
  key: 'KG_EXPLORE_3D_ENABLED', label: 'Explore 3D graph view', category: 'Knowledge Graph',
  kind: 'db', imsConfigKey: 'flag.kg.explore3d',
  valueType: 'boolean', default: false, issue: '#2517', status: 'dev-only',
  description: 'Opt-in 3D force-directed view on /explore/ (three.js). Desktop-only, lazy-loaded. DB-driven config (ImsConfig flag.kg.explore3d); DEV-first, default OFF, fail-open.',
  howToChange: featureFlagUpsert('KG_EXPLORE_3D_ENABLED', 'flag.kg.explore3d'),
},
```

- [ ] **Step 2: Write the failing wrapper test**

```js
// srv/lib/build-explore-data.test.js — assert the features field + fail-open.
// Mock isFlagEnabled and buildExplorePayload; assert res.json payload.features.threeD
// is true when the flag mock returns true, false when it throws (fail-open), and
// false when it returns false.
```

Write three cases: flag on ⇒ `features.threeD === true`; flag read throws ⇒ `features.threeD === false`; flag off ⇒ `false`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run srv/lib/build-explore-data.test.js`
Expected: FAIL — `features` undefined.

- [ ] **Step 4: Implement in the wrapper**

In `srv/lib/build-explore-data.js`: import the flag helper (same `isFlagEnabled`/resolver the service uses) and the rank-maps loader. Before `res.json`:

```js
let threeD = false;
try { threeD = !!(await isFlagEnabled('KG_EXPLORE_3D_ENABLED')); } catch { threeD = false; }
let rankMaps;
try { if (await isFlagEnabled('KG_PAGERANK_ENABLED')) rankMaps = await loadRankMaps(db); } catch { /* fail-open: no rank */ }
const payload = await buildExplorePayload(db, { rankMaps });
payload.features = { threeD };
```

Keep the LRU cache keyed so a flag flip isn't served stale beyond the existing 5-min TTL (document that a flag change takes up to the cache TTL to surface — acceptable for a DEV-first flag).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run srv/lib/build-explore-data.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/feature-flags/registry.js srv/lib/build-explore-data.js srv/lib/build-explore-data.test.js srv/knowledge-graph-service.js
git commit -m "feat(explore): KG_EXPLORE_3D_ENABLED flag advertised on explore-data (#2517)"
```

---

### Task 4: `ThreeDGraph.vue` component

**Files:**
- Create: `app/explore/src/components/ThreeDGraph.vue`
- Modify: `app/explore/package.json` (add `3d-force-graph` dependency)
- Test: `app/explore/src/components/ThreeDGraph.test.ts`

**Interfaces:**
- Consumes: `NodeType`/`ExploreNode`/`ExploreEdge` from `../types` (now with `rank?`); `colorForNodeType`/`edgeColorForPredicate` from `../node-colors`.
- Produces: `<ThreeDGraph :nodes :edges @nodeClick="{ id, node }">`. Sizing: `nodeVal = rank != null ? 1 + rank*N : 1 + degree`.

- [ ] **Step 1: Add dependency**

Run: `cd app/explore && npm install 3d-force-graph --no-audit --no-fund`

- [ ] **Step 2: Write the failing test (data-mapping unit, no WebGL)**

WebGL can't run in jsdom, so test the pure `toGraphData` mapping. Extract it as a named export from the component's module OR into a small `threed-graph-data.ts` helper the component imports (preferred — keeps the SFC thin and the mapping unit-testable):

```ts
// app/explore/src/components/threed-graph-data.test.ts
import { describe, it, expect } from 'vitest'
import { toGraphData } from './threed-graph-data'

describe('toGraphData', () => {
  const nodes = [
    { id: 't:a', type: 'tutorial', slug: 'a', label: 'A', rank: 0.5 },
    { id: 'c:b', type: 'concept', slug: 'b', label: 'B' },
  ] as any
  const edges = [{ s: 't:a', p: 'teaches', o: 'c:b' }] as any
  it('maps edges to source/target links and drops dangling', () => {
    const withDangling = [...edges, { s: 't:a', p: 'requires', o: 'zzz' }] as any
    const { links } = toGraphData(nodes, withDangling)
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ source: 't:a', target: 'c:b' })
  })
  it('sizes by rank when present, else degree', () => {
    const { nodes: gn } = toGraphData(nodes, edges)
    const a = gn.find(n => n.id === 't:a'); const b = gn.find(n => n.id === 'c:b')
    expect(a.val).toBeGreaterThan(1)          // rank-driven
    expect(b.val).toBe(1 + 1)                 // degree 1, no rank
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd app/explore && npx vitest run src/components/threed-graph-data.test.ts`
Expected: FAIL — cannot resolve `./threed-graph-data`.

- [ ] **Step 4: Create `threed-graph-data.ts` + `ThreeDGraph.vue`**

`threed-graph-data.ts` exports `toGraphData(nodes, edges)` computing degree, `val = node.rank != null ? 1 + node.rank * 10 : 1 + degree`, `color = colorForNodeType(type)`, links `{ source: e.s, target: e.o, color: edgeColorForPredicate(e.p), predicate: e.p }` filtered to edges whose both endpoints exist.

`ThreeDGraph.vue` (`<script setup lang="ts">`): dynamic-import `3d-force-graph` in `onMounted`, build graph with `nodeVal`/`nodeColor`/`nodeLabel`, directional arrows, particles on `requires`/`teaches`, `onNodeClick` → emit `nodeClick` + camera fly-to, `zoomToFit` after settle, rebuild on `watch([nodes,edges])`, `_destructor` on unmount. (Promote from the spike component, swapping its inline `toGraphData` for the imported one.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd app/explore && npx vitest run src/components/threed-graph-data.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/explore/src/components/ThreeDGraph.vue app/explore/src/components/threed-graph-data.ts app/explore/src/components/threed-graph-data.test.ts app/explore/package.json app/explore/package-lock.json
git commit -m "feat(explore): 3D force-graph component with rank-based sizing (#2517)"
```

---

### Task 5: Toggle + async load + default 3D filter in `App.vue`

**Files:**
- Modify: `app/explore/src/App.vue`
- Test: `app/explore/src/App.test.ts` (create or extend)

**Interfaces:**
- Consumes: `ThreeDGraph` (async), `payload.features.threeD` (Task 3), `useViewport().isMobile`, `useFilters()`.
- Produces: toggle rendered iff `payload.features?.threeD && !isMobile`. Named constant `THREED_DEFAULT_TYPES = ['tutorial','concept','mission']` applied on first switch to 3D.

- [ ] **Step 1: Write the failing test**

```ts
// app/explore/src/App.test.ts (extend). Mock useGraphData to return a payload
// with features.threeD true/false; mock useViewport isMobile.
import { mount } from '@vue/test-utils'
// case A: features.threeD=false, desktop → no button with name '3D'
// case B: features.threeD=true, desktop → 2D + 3D buttons present
// case C: features.threeD=true, mobile → no toggle (MobileTypedList only)
```

Assert on `wrapper.findAll('.explore__viewbtn')` length (0 / 2 / 0).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/explore && npx vitest run src/App.test.ts`
Expected: FAIL — toggle unconditional or absent.

- [ ] **Step 3: Implement**

In `App.vue`: `const ThreeDGraph = defineAsyncComponent(() => import('./components/ThreeDGraph.vue'))`, `const view3d = ref(false)`, `const show3dToggle = computed(() => !!payload.value?.features?.threeD && !isMobile.value)`. Render the `.explore__viewtoggle` only when `show3dToggle`. In the canvas, `v-if="view3d"` → `<ThreeDGraph :nodes="filteredNodes" :edges="filteredEdges" @nodeClick="onNodeClick" />`, else the existing `<ExploreGraph>`. On first `view3d = true`, if the current filter set is the default all-on, narrow enabled node types to `THREED_DEFAULT_TYPES` (via `useFilters` setters); switching back to 2D does not force-restore (user's filter choices persist). Add the spike's toggle CSS.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/explore && npx vitest run src/App.test.ts`
Expected: PASS.

- [ ] **Step 5: Full explore test run**

Run: `cd app/explore && npx vitest run`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add app/explore/src/App.vue app/explore/src/App.test.ts
git commit -m "feat(explore): 2D/3D toggle, flag-gated + default 3D filtering (#2517)"
```

---

### Task 6: Split the Vite bundle budget

**Files:**
- Modify: `app/explore/vite.config.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: entry-chunk-only 150 KB assertion + separate 3D-chunk ceiling.

- [ ] **Step 1: Rewrite the budget plugin**

Change `exploreBudget()` so it sums gzip of **only** the entry chunk (`name.startsWith('main-') && name.endsWith('.js')`) against `MAX_EXPLORE_GZIP` (150 KB), and separately sums the 3D-bearing chunk(s) (`name.includes('ThreeDGraph') || chunk.moduleIds?.some(id => id.includes('3d-force-graph'))`) against a new `MAX_3D_GZIP = 400 * 1024`, `this.error` if either exceeds. Keep the informational `this.warn`.

- [ ] **Step 2: Build to verify budgets hold**

Run: `cd app/explore && npx vite build`
Expected: build succeeds; warn lines show entry chunk < 150 KB and 3D chunk < 400 KB. If entry > 150 KB, the dynamic import regressed — fix before proceeding.

- [ ] **Step 3: Commit**

```bash
git add app/explore/vite.config.ts
git commit -m "build(explore): budget entry chunk separately from lazy 3D chunk (#2517)"
```

---

### Task 7: e2e spec + docs

**Files:**
- Create: `test/e2e/explore-3d.spec.ts` (follow `test/e2e/README.md` conventions; self-skips without `SMOKE_BASE_URL`)
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md` or the KG architecture doc — one line documenting `KG_EXPLORE_3D_ENABLED` (flag, default OFF, desktop-only, lazy chunk ~338 KB)

**Interfaces:**
- Consumes: deployed `/explore/` with the flag on in the target env.

- [ ] **Step 1: Write the e2e spec**

Playwright: navigate `${SMOKE_BASE_URL}/explore/`, wait for the graph, click the `3D` button, assert a `canvas` appears under `.threed-graph` and `page` has no console errors. Guard the whole suite with `test.skip(!process.env.SMOKE_BASE_URL)`. Note the flag must be ON in the target env or the toggle won't render — `test.skip` if the toggle is absent (flag off) rather than fail.

- [ ] **Step 2: Lint/typecheck the spec**

Run: `cd app/explore && npx vitest run` (unit) and `npx tsc --noEmit` at repo root if the e2e project typechecks there.
Expected: no type errors in the new spec.

- [ ] **Step 3: Doc line + commit**

```bash
git add test/e2e/explore-3d.spec.ts docs/
git commit -m "test(explore): e2e for 3D toggle + document KG_EXPLORE_3D_ENABLED (#2517)"
```

---

### Task 8: Full verification + PR

- [ ] **Step 1: Full test suite**

Run: `npm test` (repo root, in-memory). Expected: all PASS.

- [ ] **Step 2: Explore build + budget**

Run: `cd app/explore && npx vitest run && npx vite build`. Expected: PASS + budgets green.

- [ ] **Step 3: Manual GPU check (maintainer)**

Start `cd app/explore && npx vite` with the DEV proxy, flip to 3D, confirm the default-filtered scene is interactive on a real GPU, click a node → detail panel + fly-to. (Headless FPS is not representative — this gate is human.)

- [ ] **Step 4: Open DEV PR**

```bash
git push -u origin HEAD
gh pr create --base DEV --title "feat(explore): opt-in 3D KG view (#2517)" --body "Implements docs/superpowers/specs/2026-09-27-2517-explore-3d-graph-design.md. Flag KG_EXPLORE_3D_ENABLED (default OFF). See spec for spike findings."
```

## Self-Review

- **Spec coverage:** §1 → Task 2; §2 → Tasks 1,4,5; §3 → Tasks 3,5; §4 → Tasks 6,7. Adjacent `SearchService` compile error noted in spec as out-of-scope; no task (intentional).
- **Placeholder scan:** code shown for every code step; test bodies concrete. The two `kgQuery`/`isFlagEnabled` mock setups defer to "existing convention in the file" — acceptable because the executor must read that file anyway and the convention is established there; not a silent TODO.
- **Type consistency:** `rankMaps: {conceptRank, tutorialRank}`, `features: {threeD}`, `toGraphData(nodes, edges)`, `THREED_DEFAULT_TYPES` used consistently across Tasks 2/3/4/5.
