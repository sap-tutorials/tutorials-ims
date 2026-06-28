# Knowledge graph Phase 3 Track B — `/explore/` interactive viz: Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public interactive visualization of the entire knowledge graph at `/explore/`, with a "find a path from A to B" feature, k-anonymity-protected co-completion edges, an inline-JSON first-paint strategy, Sigma.js v3 (WebGL) rendering, and a mobile-friendly fallback list.

**Architecture:** CAP-served HTML shell (`GET /explore/`) inlines a JSON blob of nodes + edges as `<script type="application/json">`. A bundled Vue 3 + Vite app under `app/explore/` reads the inline JSON synchronously, builds a graphology instance, runs ForceAtlas2 for bounded iterations, and hands off to Sigma for WebGL rendering. The same payload is also exposed at `GET /graph/explore-data` (cached 5 min) for clients that want to refresh asynchronously. Phase 2's path-finding logic is extracted from the Joule tool into a shared module (`srv/lib/kg-path.js`) and exposed publicly at `GET /graph/path?from=X&to=Y`. The `coCompletedWith` predicate is projected with k-anonymity (K=10, FLOOR by 10) at `graphRebuild` time, so the raw counts never reach the RDF graph.

**Tech Stack:** SAP CAP (Node.js), HANA Cloud + KGE (RDF/SPARQL), Vue 3 + Vite, Sigma.js v3 + graphology + graphology-layout-forceatlas2, Vitest (unit + hybrid + smoke), Fundamental Styles (Horizon theme).

---

## Spec reference

**Spec:** [`docs/superpowers/specs/2026-06-27-446-knowledge-graph-phase3-design.md`](../specs/2026-06-27-446-knowledge-graph-phase3-design.md). This plan covers **Track 3-B** only (§6.2 of the spec). Track 3-A (concept landing pages) shipped via PR #679.

## Prerequisites — read these before starting

1. **Track 3-A is on `main`** — the `Concepts.publishedAt` column, the `PublishedConcepts` view, the `/build/concepts` endpoint, and the `/concepts/<slug>/` Hugo pages all exist. This track does not depend on Track 3-A directly, but assumes the codebase state after PR #679 merged.
2. **The Phase 1 KG infrastructure** — `srv/jobs/extract-concepts-job.js`, `srv/jobs/consolidate-concepts-job.js`, `srv/lib/kg-graph-rebuild.js`, `srv/lib/kg-projection.js`, `srv/lib/kg-queries.js`, `srv/lib/kg/joule-tool-find-path.js`, `db/src/procedures/KG_QUERY.hdbprocedure`. Read on demand; do not pre-read everything.
3. **CAP `before/on/after` handler patterns** — search via `mcp__plugin_cds-mcp_cds-mcp__search_docs` for "service handler before on after"; never guess CAP API signatures.
4. **Sigma.js v3 docs** — <https://www.sigmajs.org/docs/> — the API moved meaningfully between v2 and v3. v3 is the target.
5. **graphology docs** — <https://graphology.github.io/> — the data layer Sigma reads from.
6. **The existing `analytics-explorer` Vue+Vite app** at `app/analytics-explorer/` — the closest sibling pattern for `app/explore/`. Mirror its Vite config, MTA wiring (`.deploy/mta.yaml`), and approuter route (`approuter/xs-app.json`) shapes.
7. **The HARD CONSTRAINT** — SPARQL queries live in **`db/src/procedures/KG_QUERY.hdbprocedure`** (HANA-side), not a JS registry. Adding a new named query (`EXPLORE_GRAPH_BULK`) is an `ELSEIF` block in that procedure. **The procedure does not run in SQLite**, so unit-test fixtures that need the bulk payload either (a) cover only the JS post-processing on top of a mocked SPARQL response, or (b) defer to hybrid tests. This plan picks **(a)** — unit tests cover JS-side projection/filter logic; hybrid tests cover the SPARQL path.
8. **Test discipline (mandatory)** — every step that adds code lands its failing test first. See `superpowers:test-driven-development` if you don't already know the rhythm.

---

## Architectural anchors (verified against current `main`)

| Location | Purpose |
|---|---|
| `srv/lib/kg-graph-rebuild.js:180-269` | `graphRebuild({db,log,...})` orchestrator |
| `srv/lib/kg-projection.js:124-237` | Pure projection generator; coCompletedWith at lines 227-234 |
| `db/src/procedures/KG_QUERY.hdbprocedure:147-229` | SPARQL query dispatch (IF/ELSEIF on `query_name`) |
| `srv/lib/kg/joule-tool-find-path.js:160-216` | Phase 2 path-finding (SPARQL exec + XML parse) — extract from here in 3-B-5 |
| `srv/server.js:184-185` | `/build/catalog` + `/build/concepts` registrations — pattern for new `/graph/*` endpoints |
| `srv/knowledge-graph-service.js:896` | Admin `triggerGraphRebuild` action call site |
| `srv/jobs/consolidate-concepts-job.js:194` | Cron call site for `graphRebuild` |
| `approuter/xs-app.json:3-7` | CSP (`'unsafe-inline'` + `'wasm-unsafe-eval'` already permit Sigma.js/WebGL) |
| `approuter/xs-app.json:140-145` | Existing `/graph/(.*)` proxy route — new routes slot in before catch-all |
| `app/analytics-explorer/vite.config.ts:6` | `base: '/analytics-ui/'` — mirror for `/explore-ui/` |
| `.deploy/mta.yaml:141-156` | Analytics-explorer MTA wiring — mirror for Explore |
| `vitest.config.ts:20` | Unit project glob includes `app/*/src/**/__tests__/*.test.ts` |

---

## File structure — what changes

### New files

- `srv/lib/kg-path.js` — shared SPARQL-execute-and-parse module; consumed by both the Joule tool (3-B-5 refactor) and the new `/graph/path` endpoint.
- `srv/lib/kg-explore-data.js` — builds the `{nodes, edges, generatedAt}` payload for `/explore/` and `/graph/explore-data`. Pure helper.
- `srv/lib/build-explore-html.js` — server-side HTML template renderer; substitutes `__INITIAL_GRAPH_JSON__`, `__BUNDLE_HASH__`, `__META_DESCRIPTION__` into `srv/templates/explore.html`.
- `srv/templates/explore.html` — minimal HTML shell with three substitution points (CAP-serves this for `/explore/`).
- `app/explore/` — Vue+Vite app peer of `app/analytics-explorer/`. Bundles Sigma.js v3 + graphology + graphology-layout-forceatlas2.
- `app/explore/vite.config.ts`
- `app/explore/package.json`
- `app/explore/index.html`
- `app/explore/src/main.ts` — entry point; reads `window.__INITIAL_GRAPH__` synchronously.
- `app/explore/src/App.vue` — root component; routes between viz mode and mobile-list mode based on viewport.
- `app/explore/src/components/ExploreGraph.vue` — the Sigma+graphology rendering boundary; **the only file that talks to Sigma**.
- `app/explore/src/components/ExploreHeader.vue` — Layout-D header (search box, find-path pickers, filters dropdown).
- `app/explore/src/components/NodeDetailPanel.vue` — right-side persistent panel.
- `app/explore/src/components/MobileTypedList.vue` — mobile fallback (typed accordion list).
- `app/explore/src/composables/useGraphData.ts` — reactive wrapper over `window.__INITIAL_GRAPH__`.
- `app/explore/src/composables/useFilters.ts` — node-type + predicate filter state.
- `app/explore/src/api/path.ts` — calls `/graph/path?from=X&to=Y`.
- `app/explore/src/styles.css`
- `app/explore/src/types.ts` — TypeScript types for the JSON shape.
- `app/explore/src/__tests__/ExploreGraph.test.ts` — Vue component test (Sigma init is mocked).
- `app/explore/src/__tests__/ExploreHeader.test.ts`
- `app/explore/src/__tests__/NodeDetailPanel.test.ts`
- `app/explore/src/__tests__/MobileTypedList.test.ts`
- `app/explore/src/__tests__/useFilters.test.ts`
- `test/unit/srv/kg-explore-data.test.js` — k-anonymity invariant + JS-side projection.
- `test/unit/srv/kg-path.test.js` — extracted parser logic unit-tested with canned SPARQL XML.
- `test/unit/srv/build-explore-html.test.js` — template substitution.
- `test/hybrid/explore-data-route.test.js` — HTTP probe + k-anonymity assertion against real DEV HANA.
- `test/hybrid/graph-path-route.test.js` — HTTP probe + same-result-as-Joule-tool invariant.
- `test/smoke/explore-route.smoke.test.js` — deployed `/explore/` returns 200 + contains the inline JSON + references the bundle.

### Modified files

- `db/src/procedures/KG_QUERY.hdbprocedure` — add `EXPLORE_GRAPH_BULK` ELSEIF block (returns nodes + edges).
- `srv/lib/kg-projection.js:227-234` — apply k-anonymity FLOOR-by-10 + K≥10 filter to `coCompletedWith` triples.
- `srv/lib/kg-graph-rebuild.js` — if any predicate-counts plumbing needs to reflect the K-floored count, adjust (likely minor).
- `srv/lib/kg/joule-tool-find-path.js:160-216` — extract SPARQL exec + parse into `srv/lib/kg-path.js`; keep markdown rendering here.
- `srv/server.js:184-185` — register `/graph/explore-data`, `/graph/path`, `/explore/` routes.
- `approuter/xs-app.json` — add `/explore/` proxy route (before catch-all), add `/explore-ui/` static route.
- `.deploy/mta.yaml` — add `app/explore/` build steps + copy to `approuter/static/explore-ui/`.
- `vitest.config.ts` — extend the unit glob to include `app/explore/src/**/__tests__/`.
- `docs/developers/operations/testing-endpoints.md` — append three new endpoints.

---

## Task decomposition

Six tasks, mirroring the six PRs in spec §6.2. Within each task the rhythm is: **failing test → verify fail → minimal impl → verify pass → commit**.

| Task | Title | Scope |
|---|---|---|
| 1 | `/graph/explore-data` + k-anonymity projection | Server endpoint + projection-time K-floor; no front-end |
| 2 | `app/explore/` Vue+Vite scaffold + Sigma.js wiring | Bare Vue app reading `window.__INITIAL_GRAPH__`; just canvas, no chrome |
| 3 | `/explore/` CAP-rendered shell with inline JSON | Server-rendered HTML shell; approuter route |
| 4 | Explore page chrome — header pickers, filters dropdown, side panel | Layout-D Vue components; client-side filters |
| 5 | `/graph/path` endpoint + find-path UI overlay | Extract Phase 2 logic to `kg-path.js`; UI wires pickers to path endpoint |
| 6 | Mobile typed-list fallback + smoke + rollout note | <768px mobile UX; final smoke; rollout note |

---

## Task 1 — `/graph/explore-data` + k-anonymity projection

**PR title:** `feat(kg): /graph/explore-data + k-anonymity projection (#446 PR 4/9)`

**Files:**
- Modify: `srv/lib/kg-projection.js:227-234`
- Modify: `db/src/procedures/KG_QUERY.hdbprocedure` (add `EXPLORE_GRAPH_BULK` ELSEIF)
- Create: `srv/lib/kg-explore-data.js`
- Create: `test/unit/srv/kg-explore-data.test.js`
- Create: `test/hybrid/explore-data-route.test.js`
- Modify: `srv/server.js:184-185` (register `/graph/explore-data` route)

### 1.1 Apply k-anonymity to `coCompletedWith` projection

- [ ] **Step 1: Read** `srv/lib/kg-projection.js:220-240` to see the current `coCompletedWith` emission. The plan's spec §2.3 says: project with K=10 floor (FLOOR, not ROUND), drop edges where the raw count is <10. Confirm the current code emits raw counts and identify where to add the gate.

- [ ] **Step 2: Write the failing unit test**

Create `test/unit/srv/kg-projection-k-anonymity.test.js` (new file):

```javascript
import { describe, it, expect } from 'vitest'
import { buildCoCompletionTriples } from '../../../srv/lib/kg-projection.js'

// Note: if `buildCoCompletionTriples` is not currently exported, export it
// from kg-projection.js as a side-effect of this change. The current
// emit-triples function may be inlined inside a larger projection function;
// in that case, extract a small pure helper (input: rows from analytics,
// output: array of N-Triple strings) and unit-test the helper.

describe('coCompletedWith k-anonymity', () => {
  it('floors counts to nearest 10', () => {
    const rows = [
      { sourceSlug: 'a', targetSlug: 'b', count: 15 },  // → 10
      { sourceSlug: 'a', targetSlug: 'c', count: 23 },  // → 20
      { sourceSlug: 'a', targetSlug: 'd', count: 9 },   // dropped (below K)
    ]
    const triples = buildCoCompletionTriples(rows)
    // Expect exactly 2 triples (the third is filtered out).
    expect(triples).toHaveLength(2)
    // Expect counts to appear as floored values where they're embedded.
    // Exact shape depends on how the projection encodes counts — adapt
    // assertion to the actual triple format.
  })

  it('drops edges with raw count < 10', () => {
    const rows = [
      { sourceSlug: 'a', targetSlug: 'b', count: 1 },
      { sourceSlug: 'a', targetSlug: 'c', count: 9 },
      { sourceSlug: 'a', targetSlug: 'd', count: 10 },  // boundary — kept
    ]
    const triples = buildCoCompletionTriples(rows)
    expect(triples).toHaveLength(1)
  })

  it('emits zero triples for empty input', () => {
    expect(buildCoCompletionTriples([])).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run failing test:** `npm test -- kg-projection-k-anonymity`. Expected: FAIL — `buildCoCompletionTriples` not exported or not implemented.

- [ ] **Step 4: Implement the k-anonymity gate** in `srv/lib/kg-projection.js`. Around lines 227-234 (the current emission), restructure:

```javascript
// Before (current pattern):
for (const target of coCompletions[sourceSlug]) {
  triples.push(triple(iriTutorial(sourceSlug), iriPredicate('coCompletedWith'), iriTutorial(target.slug)))
}

// After (with k-anonymity):
for (const target of coCompletions[sourceSlug]) {
  if (target.count < 10) continue                      // K=10 floor
  // FLOOR by 10 — true count 15 → 10 (safe lower bound, not 20 overstatement)
  const flooredCount = Math.floor(target.count / 10) * 10
  // Emit two triples: the predicate edge AND a count-annotation triple, OR
  // a single typed-edge — match whatever the existing projection format does.
  triples.push(triple(iriTutorial(sourceSlug), iriPredicate('coCompletedWith'), iriTutorial(target.slug)))
  // If counts need to flow through to the explore payload, also emit:
  // triples.push(triple(<reified-edge-IRI>, iriPredicate('count'), literalInt(flooredCount)))
}
```

The exact shape depends on the existing projection. If counts aren't currently emitted at all (the predicate is binary edge-only), Step 4 is just the `continue` gate (drop edges with count <10) — no FLOOR needed because no count flows through. **Read the current code first; adapt the spec's FLOOR-by-10 requirement to the actual triple shape.**

If counts ARE emitted (e.g., as reified statements), apply the FLOOR.

- [ ] **Step 5: Extract `buildCoCompletionTriples` as a pure helper** if it isn't already. The unit test from Step 2 needs to import it. Keep the existing inlined caller; just `export` the helper.

- [ ] **Step 6: Run test, expect PASS:** `npm test -- kg-projection-k-anonymity`.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/kg-projection.js test/unit/srv/kg-projection-k-anonymity.test.js
git commit -m "feat(#446): apply k-anonymity to coCompletedWith projection (K=10, FLOOR)

Per spec §2.3: drop edges with raw count <10; floor surviving counts to
nearest 10 (FLOOR, not ROUND — 15→10 as a safe lower bound, never an
overstatement). Enforced at graphRebuild projection time, so the raw
TaskRecord-derived counts never reach the RDF graph. Unit-tested with
representative boundary cases."
```

### 1.2 Add `EXPLORE_GRAPH_BULK` SPARQL named query

- [ ] **Step 8: Read** `db/src/procedures/KG_QUERY.hdbprocedure:147-229` to see the IF/ELSEIF dispatch pattern for `NEIGHBORHOOD`, `PATH_BETWEEN`, `CONCEPTS_FOR_USER`. The new query slots in as a sibling ELSEIF before the final ELSE.

- [ ] **Step 9: Add the `EXPLORE_GRAPH_BULK` ELSEIF block** to the procedure. The query needs to return ALL nodes and edges in the graph as a single SPARQL result set. Structure:

```sql
ELSEIF :query_name = 'EXPLORE_GRAPH_BULK' THEN
  :result = SPARQL_EXECUTE('
    PREFIX kg: <https://developers.sap.com/kg/>
    SELECT ?subjectIri ?subjectType ?subjectLabel ?subjectSlug ?predicate ?objectIri ?objectType ?objectLabel ?objectSlug
    WHERE {
      GRAPH <' || COALESCE(:override_graph_iri, '<urn:sap:tutorials:kg>') || '> {
        ?s ?p ?o .
        ?s a ?subjectType .
        ?o a ?objectType .
        OPTIONAL { ?s rdfs:label ?subjectLabel }
        OPTIONAL { ?o rdfs:label ?objectLabel }
        OPTIONAL { ?s kg:slug ?subjectSlug }
        OPTIONAL { ?o kg:slug ?objectSlug }
        BIND(STR(?s) AS ?subjectIri)
        BIND(STR(?o) AS ?objectIri)
        BIND(STR(?p) AS ?predicate)
      }
    }
  ');
```

**Adapt to the actual triple shape** — read the projection code in `srv/lib/kg-projection.js` to see exactly what IRIs and predicates are emitted. The query above is a template; the implementer must match it to the project's RDF schema.

- [ ] **Step 10: Test the SPARQL query manually** against DEV HANA (skip if no `cf login` available — document as BLOCKED-pending-deploy):

```bash
# After deploy:
npx cds bind --exec -- node -e "
  const cds = require('@sap/cds');
  cds.connect.to('db').then(async db => {
    const r = await db.run(\`CALL com.sap.developers.ims.KG_QUERY('EXPLORE_GRAPH_BULK', null, ?)\`)
    console.log(JSON.stringify(r.slice(0, 5), null, 2))
  })
"
```

Confirm the response shape matches what the JS helper expects (Step 11).

- [ ] **Step 11: Commit the SPARQL addition**

```bash
git add db/src/procedures/KG_QUERY.hdbprocedure
git commit -m "feat(#446): EXPLORE_GRAPH_BULK SPARQL query

New named query in the KG_QUERY procedure returning all (subject,
predicate, object) triples for the /graph/explore-data endpoint.
Adapter ELSEIF; no other registries to update."
```

### 1.3 The `kg-explore-data.js` helper

- [ ] **Step 12: Write the failing unit test**

Create `test/unit/srv/kg-explore-data.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest'
import { buildExplorePayload } from '../../../srv/lib/kg-explore-data.js'

describe('buildExplorePayload', () => {
  it('converts SPARQL rows to {nodes, edges, generatedAt}', async () => {
    // Mock kgQuery to return canned rows
    const mockRows = [
      // 1500 tutorials, 100 concepts, 50 missions, 50 products would be too
      // much for a unit test — use a 4-node fixture.
      { subjectIri: 'urn:t:cap-handlers', subjectType: 'Tutorial', subjectLabel: 'CAP handlers', subjectSlug: 'cap-handlers',
        predicate: 'urn:kg:teaches',
        objectIri: 'urn:c:cap-handlers', objectType: 'Concept', objectLabel: 'CAP handlers', objectSlug: 'cap-handlers' },
      { subjectIri: 'urn:t:cap-handlers', subjectType: 'Tutorial', subjectLabel: 'CAP handlers', subjectSlug: 'cap-handlers',
        predicate: 'urn:kg:partOf',
        objectIri: 'urn:m:cap-quickstart', objectType: 'Mission', objectLabel: 'CAP quickstart', objectSlug: 'cap-quickstart' },
    ]
    const fakeDb = { run: vi.fn().mockResolvedValue(mockRows) }
    const payload = await buildExplorePayload(fakeDb)

    expect(payload).toHaveProperty('nodes')
    expect(payload).toHaveProperty('edges')
    expect(payload).toHaveProperty('generatedAt')
    expect(payload.nodes).toHaveLength(3)  // tutorial, concept, mission
    expect(payload.edges).toHaveLength(2)
    expect(payload.nodes.find(n => n.type === 'tutorial').slug).toBe('cap-handlers')
    expect(payload.edges.find(e => e.p === 'teaches')).toBeTruthy()
  })

  it('deduplicates nodes that appear in multiple edges', async () => {
    const mockRows = [
      { subjectIri: 'urn:t:a', subjectType: 'Tutorial', subjectLabel: 'A', subjectSlug: 'a',
        predicate: 'urn:kg:teaches',
        objectIri: 'urn:c:x', objectType: 'Concept', objectLabel: 'X', objectSlug: 'x' },
      { subjectIri: 'urn:t:a', subjectType: 'Tutorial', subjectLabel: 'A', subjectSlug: 'a',
        predicate: 'urn:kg:teaches',
        objectIri: 'urn:c:y', objectType: 'Concept', objectLabel: 'Y', objectSlug: 'y' },
    ]
    const fakeDb = { run: vi.fn().mockResolvedValue(mockRows) }
    const payload = await buildExplorePayload(fakeDb)
    expect(payload.nodes).toHaveLength(3) // a, x, y — not 4
  })

  it('produces stable node IDs from (type, slug)', async () => {
    const mockRows = [
      { subjectIri: 'urn:t:cap', subjectType: 'Tutorial', subjectLabel: 'CAP', subjectSlug: 'cap',
        predicate: 'urn:kg:teaches',
        objectIri: 'urn:c:cap', objectType: 'Concept', objectLabel: 'CAP', objectSlug: 'cap' },
    ]
    const fakeDb = { run: vi.fn().mockResolvedValue(mockRows) }
    const payload = await buildExplorePayload(fakeDb)
    const ids = payload.nodes.map(n => n.id).sort()
    // Tutorial and Concept can have the same slug; node IDs must distinguish.
    expect(ids).toEqual(['c:cap', 't:cap'])
  })
})
```

- [ ] **Step 13: Run failing test:** `npm test -- kg-explore-data`. Expected: FAIL.

- [ ] **Step 14: Implement the helper**

Create `srv/lib/kg-explore-data.js`:

```javascript
// Builds the /graph/explore-data payload — the same JSON shape inlined
// into the /explore/ HTML shell for first-paint hydration.
//
// Reads SPARQL via the EXPLORE_GRAPH_BULK named query, deduplicates nodes
// by (type, slug), and emits { nodes, edges, generatedAt }.
//
// Wire shape documented in docs/superpowers/specs/2026-06-27-446-knowledge-graph-phase3-design.md §2.4.

const TYPE_PREFIX = {
  Tutorial: 't',
  Concept: 'c',
  Mission: 'm',
  Product: 'p',
  Group: 'g',
}

const PREDICATE_SHORT = {
  'urn:kg:teaches': 'teaches',
  'urn:kg:requires': 'requires',
  'urn:kg:relatedTo': 'relatedTo',
  'urn:kg:extends': 'extends',
  'urn:kg:partOf': 'partOf',
  'urn:kg:taggedWith': 'taggedWith',
  'urn:kg:aboutProduct': 'aboutProduct',
  'urn:kg:inCategory': 'inCategory',
  'urn:kg:coCompletedWith': 'coCompletedWith',
  // Match the actual IRIs emitted by kg-projection.js — read it first.
}

export async function buildExplorePayload(db) {
  // Prefer the existing kgQuery() helper in srv/lib/kg-queries.js if it
  // accepts the new EXPLORE_GRAPH_BULK query name — that's the canonical
  // CALL+param-binding wrapper used by the rest of the codebase. If the
  // helper has a hardcoded allowlist of query names, extend the allowlist
  // OR fall back to db.run() with raw CALL syntax (shown below) as a
  // localized exception.
  const rows = await db.run(`CALL com.sap.developers.ims.KG_QUERY('EXPLORE_GRAPH_BULK', null, ?)`)

  const nodesById = new Map()
  const edges = []

  function nodeId(type, slug) {
    return `${TYPE_PREFIX[type] || 'x'}:${slug}`
  }

  for (const row of rows) {
    const sId = nodeId(row.subjectType, row.subjectSlug)
    const oId = nodeId(row.objectType, row.objectSlug)

    if (!nodesById.has(sId)) {
      nodesById.set(sId, {
        id: sId,
        type: row.subjectType.toLowerCase(),
        label: row.subjectLabel || row.subjectSlug,
        slug: row.subjectSlug,
      })
    }
    if (!nodesById.has(oId)) {
      nodesById.set(oId, {
        id: oId,
        type: row.objectType.toLowerCase(),
        label: row.objectLabel || row.objectSlug,
        slug: row.objectSlug,
      })
    }

    const p = PREDICATE_SHORT[row.predicate] || row.predicate
    edges.push({ s: sId, p, o: oId })
  }

  return {
    nodes: Array.from(nodesById.values()),
    edges,
    generatedAt: new Date().toISOString(),
  }
}
```

- [ ] **Step 15: Run test, expect PASS:** `npm test -- kg-explore-data`.

- [ ] **Step 16: Commit**

```bash
git add srv/lib/kg-explore-data.js test/unit/srv/kg-explore-data.test.js
git commit -m "feat(#446): buildExplorePayload helper — bulk graph JSON

Pure helper assembling the /explore/ inline JSON + /graph/explore-data
endpoint payload. Calls the EXPLORE_GRAPH_BULK SPARQL query, dedupes
nodes by (type, slug), short-names predicates. Unit-tested against
mocked SPARQL responses (no SQLite-incompatible dep)."
```

### 1.4 The `/graph/explore-data` Express handler

- [ ] **Step 17: Create the handler module**

Create `srv/lib/build-explore-data.js`:

```javascript
import cds from '@sap/cds'
import { buildExplorePayload } from './kg-explore-data.js'

const log = cds.log('build-explore-data')

// In-process LRU cache: 1 entry, 5-minute TTL.
let cached = null
let cachedAt = 0
const TTL_MS = 5 * 60 * 1000

export async function exploreDataHandler(req, res) {
  try {
    const now = Date.now()
    if (cached && (now - cachedAt < TTL_MS)) {
      res.setHeader('X-Cache', 'HIT')
      return res.json(cached)
    }
    const db = await cds.connect.to('db')
    const payload = await buildExplorePayload(db)
    cached = payload
    cachedAt = now
    res.setHeader('X-Cache', 'MISS')
    res.json(payload)
  } catch (err) {
    log.error('failed to build /graph/explore-data payload', err)
    res.status(500).json({ error: 'Explore-data query failed' })
  }
}

// Exposed for tests + manual cache busting.
export function _resetExploreDataCache() {
  cached = null
  cachedAt = 0
}
```

- [ ] **Step 18: Register the route in `srv/server.js`** (around line 185, after `/build/concepts`):

```javascript
import { exploreDataHandler } from './lib/build-explore-data.js'
// ...
app.get('/graph/explore-data', exploreDataHandler)
```

- [ ] **Step 19: Write the failing hybrid test**

Create `test/hybrid/explore-data-route.test.js`:

```javascript
import { describe, it, beforeAll, expect } from 'vitest'

describe('/graph/explore-data (HTTP)', () => {
  let baseUrl
  beforeAll(() => {
    baseUrl = process.env.HYBRID_SRV_URL ?? 'http://localhost:4004'
  })

  it('returns 200 with nodes + edges + generatedAt', async () => {
    const r = await fetch(`${baseUrl}/graph/explore-data`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body).toHaveProperty('nodes')
    expect(body).toHaveProperty('edges')
    expect(Array.isArray(body.nodes)).toBe(true)
    expect(Array.isArray(body.edges)).toBe(true)
    expect(body).toHaveProperty('generatedAt')
  })

  it('cache header reflects HIT on second call within 5 minutes', async () => {
    const r1 = await fetch(`${baseUrl}/graph/explore-data`)
    expect(r1.headers.get('x-cache')).toBeTruthy()
    const r2 = await fetch(`${baseUrl}/graph/explore-data`)
    expect(r2.headers.get('x-cache')).toBe('HIT')
  })

  it('coCompletedWith edges leaked from /graph/explore-data must satisfy k-anonymity', async () => {
    const r = await fetch(`${baseUrl}/graph/explore-data`)
    const { edges } = await r.json()
    const coEdges = edges.filter(e => e.p === 'coCompletedWith')
    // If any coCompletedWith edges exist, all must be derivable from
    // K=10-floored counts. Since counts may or may not be inlined, the
    // simplest invariant is: just check the edges exist (the projection-
    // time filter dropped <10 counts; if any leak with raw count <10, this
    // is a projection bug, not a route bug).
    for (const e of coEdges) {
      if ('count' in e) {
        expect(e.count % 10).toBe(0)         // FLOOR-by-10 invariant
        expect(e.count).toBeGreaterThanOrEqual(10)
      }
    }
  })

  it('does not require auth', async () => {
    const r = await fetch(`${baseUrl}/graph/explore-data`, { headers: {} })
    expect(r.status).toBe(200)
  })
})
```

- [ ] **Step 20: Run failing hybrid test:** `npm run test:hybrid -- explore-data-route`. Expected: PASS once schema deploys with the new SPARQL query AND `graphRebuild` has run post-deploy. If `cf login` not available, surface as BLOCKED.

- [ ] **Step 21: Commit**

```bash
git add srv/lib/build-explore-data.js srv/server.js test/hybrid/explore-data-route.test.js
git commit -m "feat(#446): GET /graph/explore-data endpoint with 5-min LRU cache

Express handler peer of /build/concepts. Unauthenticated; cached for
5 min in-process. k-anonymity floor (K=10, FLOOR-by-10) is enforced
at projection time (kg-projection.js), so a query bug downstream cannot
leak raw counts."
```

### 1.5 Task 1 close-out

- [ ] **Step 22: Run all task-1 tests** to confirm green-on-rerun:

```bash
npm test -- kg-projection-k-anonymity kg-explore-data
npm run test:hybrid -- explore-data-route   # may be BLOCKED until deploy
```

- [ ] **Step 23: Push the branch and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(kg): /graph/explore-data + k-anonymity projection (#446 PR 4/9)" \
  --body "Phase 3 Track 3-B PR 1 of 6. See plan: docs/superpowers/plans/2026-06-27-446-kg-phase3-track-b.md.

- k-anonymity enforced at projection time (K=10, FLOOR-by-10) in srv/lib/kg-projection.js
- New EXPLORE_GRAPH_BULK SPARQL named query in KG_QUERY.hdbprocedure
- New /graph/explore-data Express handler (5-min in-process cache)
- Unit + hybrid tests; hybrid is BLOCKED-until-schema-deploys

**Pre-merge:** db deployer push to deploy the new SPARQL procedure ELSEIF.

Refs #446"
```

---

## Task 2 — `app/explore/` Vue+Vite scaffold + Sigma.js wiring

**PR title:** `feat(kg): app/explore/ Vue+Vite scaffold + Sigma.js wiring (#446 PR 5/9)`

**Files:** All under `app/explore/` (new); plus minor `vitest.config.ts` extension.

### 2.1 Scaffold the Vue+Vite app

- [ ] **Step 24: Read** `app/analytics-explorer/` end-to-end:
  - `vite.config.ts`
  - `package.json`
  - `index.html`
  - `src/main.ts`
  - `src/App.vue`
  - The vitest test wiring

Mirror the structure for `app/explore/`. Don't pre-write everything — read the structure, then create only what `explore/` needs.

- [ ] **Step 25: Create `app/explore/package.json`**

```json
{
  "name": "@sap-tutorials/explore",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "preview": "vite preview"
  },
  "dependencies": {
    "vue": "^3.4.0",
    "sigma": "^3.0.0",
    "graphology": "^0.25.0",
    "graphology-layout-forceatlas2": "^0.10.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.0.0",
    "@vue/test-utils": "^2.4.0",
    "vite": "^5.0.0",
    "happy-dom": "^15.0.0",
    "typescript": "^5.4.0",
    "vue-tsc": "^2.0.0"
  }
}
```

(Adjust the exact versions to match what `app/analytics-explorer/package.json` uses for Vue 3 + Vite, to minimize lockfile drift.)

- [ ] **Step 26: Create `app/explore/vite.config.ts`**

```typescript
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { gzipSync } from 'node:zlib'

const MAX_EXPLORE_GZIP = 150 * 1024 // 150KB budget — Sigma + graphology + ForceAtlas2 baseline ~65KB

function exploreBudget() {
  return {
    name: 'explore-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      let totalGzip = 0
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && name.endsWith('.js')) {
          totalGzip += gzipSync(chunk.code).length
        }
      }
      if (totalGzip > MAX_EXPLORE_GZIP) {
        // @ts-ignore
        this.error(`explore bundle total is ${totalGzip} gzip bytes (> ${MAX_EXPLORE_GZIP}).`)
      } else {
        // @ts-ignore
        this.warn(`explore bundle: ${totalGzip} gzip bytes (budget ${MAX_EXPLORE_GZIP}).`)
      }
    }
  }
}

export default defineConfig({
  base: '/explore-ui/',
  plugins: [vue(), exploreBudget()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        entryFileNames: 'main-[hash].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
```

- [ ] **Step 27: Create `app/explore/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Knowledge Graph Explorer · SAP Tutorials</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

This is the **Vite dev-server** index. The production HTML shell is server-rendered by CAP (Task 3) — Vite's bundle is loaded via the `<script>` tag the server emits.

- [ ] **Step 28: Create `app/explore/src/types.ts`**

```typescript
export type NodeType = 'tutorial' | 'concept' | 'mission' | 'product' | 'group'
export type PredicateType =
  | 'teaches' | 'requires' | 'relatedTo' | 'extends'
  | 'partOf' | 'taggedWith' | 'aboutProduct' | 'inCategory' | 'coCompletedWith'

export interface ExploreNode {
  id: string
  type: NodeType
  label: string
  slug: string
}

export interface ExploreEdge {
  s: string
  p: PredicateType
  o: string
  count?: number  // present on coCompletedWith edges (FLOOR-by-10)
}

export interface ExplorePayload {
  nodes: ExploreNode[]
  edges: ExploreEdge[]
  generatedAt: string
}

declare global {
  interface Window {
    __INITIAL_GRAPH__?: ExplorePayload
  }
}
```

- [ ] **Step 29: Create `app/explore/src/composables/useGraphData.ts`**

```typescript
import { ref, computed } from 'vue'
import type { ExplorePayload } from '../types'

export function useGraphData() {
  // Server-rendered HTML inlines the JSON; read synchronously.
  const payload = ref<ExplorePayload | null>(window.__INITIAL_GRAPH__ ?? null)
  const hasData = computed(() => !!payload.value)

  // Fallback: if HTML wasn't server-rendered (e.g., dev server), fetch.
  async function fetchAsync() {
    const r = await fetch('/graph/explore-data')
    if (r.ok) payload.value = await r.json()
  }

  if (!payload.value) fetchAsync()

  return { payload, hasData }
}
```

- [ ] **Step 30: Create `app/explore/src/components/ExploreGraph.vue`** — the Sigma boundary

Read Sigma.js v3 docs before writing this. The component:
- Receives `{ nodes, edges }` as a prop.
- Constructs a graphology instance.
- Runs ForceAtlas2 for up to 50 iterations.
- Mounts a Sigma renderer in a `<canvas>` element.
- Emits `nodeClick` events upward.

```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import Graph from 'graphology'
import Sigma from 'sigma'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import type { ExploreNode, ExploreEdge } from '../types'

const props = defineProps<{ nodes: ExploreNode[]; edges: ExploreEdge[] }>()
const emit = defineEmits<{ nodeClick: [{ id: string; node: ExploreNode }] }>()

const container = ref<HTMLDivElement | null>(null)
let renderer: Sigma | null = null
let graph: Graph | null = null

onMounted(() => {
  if (!container.value) return
  graph = new Graph()
  for (const n of props.nodes) {
    graph.addNode(n.id, {
      x: Math.random(), y: Math.random(),  // ForceAtlas2 will redistribute
      size: 4,
      label: n.label,
      color: colorForNodeType(n.type),
      ...n,
    })
  }
  for (const e of props.edges) {
    // graphology requires unique edge keys; combine s+p+o.
    const key = `${e.s}--${e.p}--${e.o}`
    if (!graph.hasEdge(key)) {
      graph.addEdgeWithKey(key, e.s, e.o, { type: e.p, color: edgeColorForType(e.p) })
    }
  }
  forceAtlas2.assign(graph, { iterations: 50, settings: { gravity: 1, scalingRatio: 10 } })
  renderer = new Sigma(graph, container.value, {
    minCameraRatio: 0.1,
    maxCameraRatio: 5,
  })
  renderer.on('clickNode', ({ node }) => {
    emit('nodeClick', { id: node, node: graph!.getNodeAttributes(node) as ExploreNode })
  })
})

onBeforeUnmount(() => {
  renderer?.kill()
  renderer = null
  graph = null
})

function colorForNodeType(t: string) {
  switch (t) {
    case 'tutorial': return '#0a6ed1'
    case 'concept':  return '#107e3e'
    case 'mission':  return '#df6e0c'
    case 'product':  return '#a100c2'
    case 'group':    return '#8c8c8c'
    default:         return '#000'
  }
}

function edgeColorForType(p: string) {
  return p === 'coCompletedWith' ? '#cccccc' : '#999999'
}
</script>

<template>
  <div ref="container" class="explore-graph" />
</template>

<style scoped>
.explore-graph {
  width: 100%;
  height: 100%;
  min-height: 600px;
}
</style>
```

- [ ] **Step 31: Create `app/explore/src/App.vue`**

```vue
<script setup lang="ts">
import { useGraphData } from './composables/useGraphData'
import ExploreGraph from './components/ExploreGraph.vue'

const { payload, hasData } = useGraphData()
</script>

<template>
  <main class="explore">
    <p v-if="!hasData" class="explore__empty">Loading graph…</p>
    <ExploreGraph
      v-else
      :nodes="payload!.nodes"
      :edges="payload!.edges"
    />
  </main>
</template>

<style>
.explore {
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.explore__empty {
  text-align: center;
  margin-top: 4rem;
  color: #666;
}
</style>
```

- [ ] **Step 32: Create `app/explore/src/main.ts`**

```typescript
import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

createApp(App).mount('#app')
```

- [ ] **Step 33: Create `app/explore/src/styles.css`**

```css
:root {
  --sap-horizon-bg: #fafafa;
  --sap-horizon-text: #32363a;
}
body {
  margin: 0;
  font-family: '72', '72full', Arial, Helvetica, sans-serif;
  background: var(--sap-horizon-bg);
  color: var(--sap-horizon-text);
}
```

### 2.2 Component test for the Sigma boundary

- [ ] **Step 34: Write the Vue component test** at `app/explore/src/__tests__/ExploreGraph.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ExploreGraph from '../components/ExploreGraph.vue'

// Mock Sigma + graphology — we don't need a real WebGL context for the test
vi.mock('sigma', () => ({ default: class { on() {} kill() {} } }))
vi.mock('graphology', () => ({
  default: class {
    nodes: Map<string, any> = new Map()
    edges: Map<string, any> = new Map()
    addNode(id: string, attrs: any) { this.nodes.set(id, attrs) }
    addEdgeWithKey(key: string, s: string, o: string, attrs: any) { this.edges.set(key, { s, o, ...attrs }) }
    hasEdge(key: string) { return this.edges.has(key) }
    getNodeAttributes(id: string) { return this.nodes.get(id) }
  }
}))
vi.mock('graphology-layout-forceatlas2', () => ({
  default: { assign: vi.fn() }
}))

describe('ExploreGraph', () => {
  const fixture = {
    nodes: [
      { id: 't:a', type: 'tutorial', label: 'A', slug: 'a' },
      { id: 'c:x', type: 'concept', label: 'X', slug: 'x' },
    ],
    edges: [{ s: 't:a', p: 'teaches', o: 'c:x' }],
  }

  it('mounts without error', () => {
    const wrapper = mount(ExploreGraph, { props: fixture })
    expect(wrapper.find('.explore-graph').exists()).toBe(true)
  })

  it('deduplicates duplicate edges by key', () => {
    const dupEdges = {
      nodes: [
        { id: 't:a', type: 'tutorial' as const, label: 'A', slug: 'a' },
        { id: 'c:x', type: 'concept' as const, label: 'X', slug: 'x' },
      ],
      edges: [
        { s: 't:a', p: 'teaches' as const, o: 'c:x' },
        { s: 't:a', p: 'teaches' as const, o: 'c:x' },  // duplicate
      ],
    }
    // The internal graph should have only one edge for the duplicate key.
    // This test verifies the hasEdge guard works.
    const wrapper = mount(ExploreGraph, { props: dupEdges })
    expect(wrapper.exists()).toBe(true)
    // (More detailed assertions would need to introspect the mocked graph
    // instance — keep this lightweight for the scaffold PR.)
  })
})
```

- [ ] **Step 35: Run the failing test, then PASS:** `npm test -- ExploreGraph`. (Initially fails because the component doesn't exist; passes after Step 30.)

- [ ] **Step 36: Extend `vitest.config.ts`** to include `app/explore/src/**/__tests__/*.test.ts` if not already covered by the existing glob (read line 20).

### 2.3 MTA + approuter wiring

- [ ] **Step 37: Add the build steps to `.deploy/mta.yaml`** mirroring `analytics-explorer` (around lines 141-156). Pattern:

```yaml
- name: tutorials-explore-build
  type: nodejs
  path: ../app/explore
  build-parameters:
    no-source: true
    before-all:
      - builder: custom
        commands:
          - npm install
          - npm run build
  requires: []
  parameters:
    enabled: false
    deployable: false
```

And in the `tutorials-approuter` module's `before-all` or `commands` section, add:

```yaml
- cp -r ../app/explore/dist/. static/explore-ui/
```

**Read the existing analytics-explorer wiring** (lines 141-156) and adapt — don't blindly copy the structure above; it may need adjustment.

- [ ] **Step 38: Add the approuter static route to `approuter/xs-app.json`**

```json
{
  "source": "^/explore-ui/(.*)$",
  "target": "/explore-ui/$1",
  "localDir": "static",
  "authenticationType": "none"
}
```

Slot in among the existing static UI routes (analytics-ui, admin-ui).

### 2.4 Commit + close-out

- [ ] **Step 39: Run all task-2 tests:** `npm test -- ExploreGraph`. Verify the gzip-budget plugin succeeds when building locally (`cd app/explore && npm install && npm run build`).

- [ ] **Step 40: Commit**

```bash
git add app/explore/ vitest.config.ts .deploy/mta.yaml approuter/xs-app.json
git commit -m "feat(#446): app/explore/ Vue+Vite scaffold + Sigma.js v3 wiring

- New Vue 3 + Vite app peer of app/analytics-explorer/
- Sigma.js v3 + graphology + graphology-layout-forceatlas2 (WebGL viz)
- gzip budget cap 150KB
- ForceAtlas2 capped at 50 iterations
- ExploreGraph.vue is the Sigma boundary (single component talks to Sigma)
- MTA + approuter wiring mirroring analytics-explorer
- Component test mocks Sigma to avoid needing a real WebGL context"
```

- [ ] **Step 41: Push + PR** (continues stacking on the same branch per Track-3-B PR-stacking convention).

---

## Task 3 — `/explore/` CAP-rendered shell with inline JSON

**PR title:** `feat(kg): /explore/ CAP-rendered shell with inline JSON (#446 PR 6/9)`

**Files:**
- Create: `srv/templates/explore.html`
- Create: `srv/lib/build-explore-html.js`
- Create: `test/unit/srv/build-explore-html.test.js`
- Modify: `srv/server.js` (register `/explore/` route)
- Modify: `approuter/xs-app.json` (add `/explore/` proxy route)

### 3.1 The HTML shell template

> **Cache-coherence note:** `/graph/explore-data` is cached for 5 min in-process (Task 1); the `/explore/` shell renders `buildExplorePayload(db)` directly on every request (no cache). After a `graphRebuild`, users hitting `/explore/` for the first time get fresh data, but if their browser falls back to `fetchAsync` (Task 2 `useGraphData`), they may briefly see the cached `/graph/explore-data` payload. This is acceptable — the fallback is dev-mode only and the cache TTL is short. Document in 3-B-6 rollout note that an admin can hard-bust the cache by restarting `tutorials-srv` if needed.

- [ ] **Step 42: Create `srv/templates/explore.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Knowledge Graph Explorer · SAP Tutorials</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="__META_DESCRIPTION__" />
  <link rel="stylesheet" href="/explore-ui/assets/index.css" />
</head>
<body>
  <div id="app"></div>
  <script type="application/json" id="initial-graph">__INITIAL_GRAPH_JSON__</script>
  <script>
    try {
      var el = document.getElementById('initial-graph')
      window.__INITIAL_GRAPH__ = JSON.parse(el.textContent || el.innerText)
    } catch (e) {
      // Fall through; the Vue app will fetch /graph/explore-data instead.
    }
  </script>
  <script type="module" src="/explore-ui/main-__BUNDLE_HASH__.js"></script>
</body>
</html>
```

### 3.2 The build-explore-html helper + unit test

- [ ] **Step 43: Write the failing unit test** at `test/unit/srv/build-explore-html.test.js`

```javascript
import { describe, it, expect, vi } from 'vitest'
import { buildExploreHtml } from '../../../srv/lib/build-explore-html.js'

describe('buildExploreHtml', () => {
  it('substitutes the three placeholders', () => {
    const payload = { nodes: [], edges: [], generatedAt: '2026-06-27T00:00:00.000Z' }
    const bundleHash = 'abc123'
    const html = buildExploreHtml(payload, bundleHash)
    expect(html).toContain('"generatedAt":"2026-06-27T00:00:00.000Z"')
    expect(html).toContain('main-abc123.js')
    expect(html).not.toContain('__INITIAL_GRAPH_JSON__')
    expect(html).not.toContain('__BUNDLE_HASH__')
  })

  it('escapes </script> inside the inline JSON to prevent XSS', () => {
    const payload = { nodes: [{ id: 'a', label: '</script><script>alert(1)</script>', slug: 'a', type: 'tutorial' }], edges: [], generatedAt: 'x' }
    const html = buildExploreHtml(payload, 'hash')
    // Inline JSON must not contain a literal </script> sequence — escape to <\/script>.
    expect(html).not.toContain('</script><script>alert')
    expect(html).toMatch(/<\\\/script>/)
  })

  it('uses default meta description when not provided', () => {
    const html = buildExploreHtml({ nodes: [], edges: [], generatedAt: '' }, 'h')
    expect(html).toContain('content="')
  })
})
```

- [ ] **Step 44: Run failing test:** `npm test -- build-explore-html`. Expected: FAIL.

- [ ] **Step 45: Implement `srv/lib/build-explore-html.js`**

```javascript
import fs from 'node:fs'
import path from 'node:path'

const TEMPLATE_PATH = path.join(import.meta.dirname, '..', 'templates', 'explore.html')
let cachedTemplate = null

function loadTemplate() {
  if (!cachedTemplate) cachedTemplate = fs.readFileSync(TEMPLATE_PATH, 'utf8')
  return cachedTemplate
}

const DEFAULT_META = 'Explore the SAP Tutorials knowledge graph — discover concepts, missions, and learning paths.'

export function buildExploreHtml(payload, bundleHash, meta = DEFAULT_META) {
  // Critical: escape </script> in the JSON to prevent breaking out of the script tag.
  const safeJson = JSON.stringify(payload).replace(/<\/script>/gi, '<\\/script>')
  return loadTemplate()
    .replace('__INITIAL_GRAPH_JSON__', safeJson)
    .replace('__BUNDLE_HASH__', bundleHash)
    .replace('__META_DESCRIPTION__', meta.replace(/"/g, '&quot;'))
}

// Test hook
export function _resetTemplateCache() {
  cachedTemplate = null
}
```

- [ ] **Step 46: Run test, expect PASS:** `npm test -- build-explore-html`.

### 3.3 The `/explore/` route

- [ ] **Step 47: Create `srv/lib/explore-route.js`**

```javascript
import cds from '@sap/cds'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildExplorePayload } from './kg-explore-data.js'
import { buildExploreHtml } from './build-explore-html.js'

const log = cds.log('explore-route')

// Resolve the latest bundle hash by reading the static-ui directory at boot.
// In production the file `main-<hash>.js` is emitted by Vite's build.
let cachedHash = null
async function resolveBundleHash() {
  if (cachedHash) return cachedHash
  try {
    const staticDir = path.resolve(import.meta.dirname, '..', '..', 'approuter', 'static', 'explore-ui')
    const files = await fs.readdir(staticDir)
    const main = files.find(f => /^main-[a-z0-9]+\.js$/.test(f))
    if (main) cachedHash = main.replace(/^main-|\.js$/g, '')
  } catch {
    cachedHash = 'dev'
  }
  return cachedHash
}

export async function exploreHandler(req, res) {
  try {
    const db = await cds.connect.to('db')
    const payload = await buildExplorePayload(db)
    const hash = await resolveBundleHash()
    const html = buildExploreHtml(payload, hash)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(html)
  } catch (err) {
    log.error('failed to render /explore/', err)
    res.status(500).send('Explore page render failed')
  }
}
```

- [ ] **Step 48: Register the route in `srv/server.js`**

```javascript
import { exploreHandler } from './lib/explore-route.js'
// ...
app.get('/explore/?', exploreHandler)
```

- [ ] **Step 49: Add the approuter proxy route** to `approuter/xs-app.json` (slot before catch-all):

```json
{
  "source": "^/explore/?$",
  "target": "/explore/",
  "destination": "srv-api",
  "authenticationType": "none",
  "csrfProtection": false
}
```

### 3.4 Commit + close-out

- [ ] **Step 50: Run all tests:**

```bash
npm test -- build-explore-html
```

- [ ] **Step 51: Commit + Push**

```bash
git add srv/templates/explore.html srv/lib/build-explore-html.js srv/lib/explore-route.js srv/server.js approuter/xs-app.json test/unit/srv/build-explore-html.test.js
git commit -m "feat(#446): /explore/ CAP-rendered shell with inline JSON

- srv/templates/explore.html: minimal HTML shell with 3 substitution points
- srv/lib/build-explore-html.js: pure helper with </script>-escape (XSS guard)
- srv/lib/explore-route.js: Express handler resolves bundle hash dynamically
- Approuter route /explore/ → CAP /explore/
- Unit tests cover substitution + XSS guard"
```

---

## Task 4 — Explore page chrome (header pickers, filters, side panel)

**PR title:** `feat(kg): explore page chrome — header pickers, filters dropdown, side panel (#446 PR 7/9)`

**Files:**
- Create: `app/explore/src/components/ExploreHeader.vue`
- Create: `app/explore/src/components/NodeDetailPanel.vue`
- Create: `app/explore/src/components/FilterDropdown.vue`
- Create: `app/explore/src/composables/useFilters.ts`
- Create: `app/explore/src/composables/useSelectedNode.ts`
- Create: `app/explore/src/composables/useTelemetry.ts`
- Modify: `app/explore/src/App.vue` (compose the new chrome)
- Create: `app/explore/src/__tests__/ExploreHeader.test.ts`
- Create: `app/explore/src/__tests__/NodeDetailPanel.test.ts`
- Create: `app/explore/src/__tests__/useFilters.test.ts`

### 4.1 Filters composable + dropdown

- [ ] **Step 52: Write the failing `useFilters` test** at `app/explore/src/__tests__/useFilters.test.ts`. Cover: enable/disable a node-type filter; enable/disable a predicate filter; emit `kg.explore.filter` telemetry on toggle.

- [ ] **Step 53: Implement `app/explore/src/composables/useFilters.ts`** — reactive `Set<NodeType>` + `Set<PredicateType>` with toggle methods.

- [ ] **Step 54: Implement `app/explore/src/components/FilterDropdown.vue`** — checkboxes for node types + predicate types.

### 4.2 Header with search box + find-path pickers (UI shell only; wired to endpoint in Task 5)

- [ ] **Step 55: Write the failing `ExploreHeader` test** — search box fires `kg.explore.search` event; find-path pickers emit `findPath` event with `{from, to}` payload.

- [ ] **Step 56: Implement `app/explore/src/components/ExploreHeader.vue`** — search input with autocomplete (debounced), two pickers (`From`, `To`) with autocomplete over published-concept + tutorial slugs, "Find path" button.

### 4.3 Node detail side panel

- [ ] **Step 57: Write the failing `NodeDetailPanel` test** — given a selected node, panel shows name, type, link to `/tutorials/<slug>/` or `/concepts/<slug>/`, list of incident edges grouped by predicate.

- [ ] **Step 58: Implement `app/explore/src/components/NodeDetailPanel.vue`** — empty state when no node selected; populated state derived from the graph instance and edge list.

### 4.4 Telemetry composable

- [ ] **Step 59: Implement `app/explore/src/composables/useTelemetry.ts`** — same `window.dispatchEvent(new CustomEvent(...))` pattern as Phase 1 / Track 3-A.

Emits the 6 explore events (per spec §3 telemetry table):
- `kg.explore.viewed` — fires once on App mount
- `kg.explore.node_clicked` — selected via panel
- `kg.explore.node_navigated` — anchor-click that leaves the page
- `kg.explore.search` — search input submitted
- `kg.explore.filter` — filter toggle
- `kg.explore.path_drawn` — fires from Task 5 when path overlay renders

### 4.5 Compose chrome in `App.vue`

- [ ] **Step 60: Update `app/explore/src/App.vue`** to compose `ExploreHeader` + `ExploreGraph` + `NodeDetailPanel` in the Layout-D shape (top header, viz center, right detail panel).

### 4.6 Commit + Push

- [ ] **Step 61: Run all task-4 tests:** `npm test -- useFilters ExploreHeader NodeDetailPanel`.

- [ ] **Step 62: Commit + Push**

```bash
git commit -m "feat(#446): explore page chrome — Layout-D

- Header search box + find-path pickers (UI shell; wired in PR 5)
- Filters dropdown (node types + predicates)
- Right-side persistent node-detail panel
- 5 of 6 explore telemetry events wired (kg.explore.path_drawn lands in PR 5)"
```

---

## Task 5 — `/graph/path` endpoint + find-path UI overlay

**PR title:** `feat(kg): /graph/path endpoint + find-path UI overlay (#446 PR 8/9)`

**Files:**
- Create: `srv/lib/kg-path.js` (extracted from `srv/lib/kg/joule-tool-find-path.js`)
- Modify: `srv/lib/kg/joule-tool-find-path.js:160-216` (consume the extracted module)
- Create: `srv/lib/graph-path-route.js` (Express handler)
- Modify: `srv/server.js` (register `/graph/path` route)
- Create: `test/unit/srv/kg-path.test.js`
- Create: `test/hybrid/graph-path-route.test.js`
- Modify: `app/explore/src/components/ExploreHeader.vue` (wire pickers to endpoint)
- Modify: `app/explore/src/components/ExploreGraph.vue` (overlay path edges + camera-fit)
- Create: `app/explore/src/api/path.ts`
- Modify: `app/explore/src/composables/useTelemetry.ts` (fire `kg.explore.path_drawn`)

### 5.1 Extract path-finding to a shared module

- [ ] **Step 63: Write the failing unit test** at `test/unit/srv/kg-path.test.js`

```javascript
import { describe, it, expect, vi } from 'vitest'
import { findPath, parsePathSparql } from '../../../srv/lib/kg-path.js'

const FIXTURE_SPARQL_XML = `
<sparql>
  <results>
    <result>
      <binding name="b"><uri>urn:t:cap-handlers</uri></binding>
      <binding name="pathType"><literal>direct</literal></binding>
      <binding name="pathTypeRank"><literal>1</literal></binding>
      <binding name="hopCount"><literal>1</literal></binding>
    </result>
    <result>
      <binding name="b"><uri>urn:t:advanced</uri></binding>
      <binding name="pathType"><literal>direct</literal></binding>
      <binding name="pathTypeRank"><literal>1</literal></binding>
      <binding name="hopCount"><literal>2</literal></binding>
    </result>
  </results>
</sparql>
`

describe('parsePathSparql', () => {
  it('extracts ordered steps from SPARQL XML response', () => {
    const steps = parsePathSparql(FIXTURE_SPARQL_XML)
    expect(steps).toHaveLength(2)
    expect(steps[0].slug).toBe('cap-handlers')
    expect(steps[0].hopCount).toBe(1)
    expect(steps[1].slug).toBe('advanced')
  })

  it('returns empty array for empty response', () => {
    expect(parsePathSparql('<sparql><results></results></sparql>')).toEqual([])
  })
})

describe('findPath', () => {
  it('calls SPARQL and parses the response', async () => {
    const fakeDb = { run: vi.fn().mockResolvedValue(FIXTURE_SPARQL_XML) }
    const result = await findPath({ db: fakeDb, fromSlug: 'a', toSlug: 'b' })
    expect(result).toHaveLength(2)
    expect(fakeDb.run).toHaveBeenCalled()
  })
})
```

- [ ] **Step 64: Implement `srv/lib/kg-path.js`** by extracting `srv/lib/kg/joule-tool-find-path.js:160-216`. The new module exports `findPath({db, fromSlug, toSlug})` returning `Array<{slug, pathType, pathTypeRank, hopCount}>` and `parsePathSparql(xml)` for testing.

- [ ] **Step 65: Update `srv/lib/kg/joule-tool-find-path.js`** to consume the extracted module. The Joule tool keeps its markdown-rendering responsibility; the SPARQL execution + parsing now goes through `kg-path.js`. Existing Joule tests must still pass.

### 5.2 The `/graph/path` Express handler

- [ ] **Step 66: Implement `srv/lib/graph-path-route.js`**

```javascript
import cds from '@sap/cds'
import { findPath } from './kg-path.js'

const log = cds.log('graph-path-route')

const SLUG_RE = /^[a-z0-9-]+$/

export async function graphPathHandler(req, res) {
  try {
    const { from, to } = req.query
    if (!from || !to) return res.status(400).json({ error: 'from and to required' })
    if (!SLUG_RE.test(from) || !SLUG_RE.test(to)) {
      return res.status(400).json({ error: 'invalid slug format' })
    }
    const db = await cds.connect.to('db')
    const steps = await findPath({ db, fromSlug: from, toSlug: to })
    if (!steps.length) return res.status(404).json({ error: 'No path found', from, to })
    res.json({ from, to, steps })
  } catch (err) {
    log.error('failed to find path', err)
    res.status(500).json({ error: 'Path query failed' })
  }
}
```

Register in `srv/server.js`: `app.get('/graph/path', graphPathHandler)`.

### 5.3 The find-path UI overlay

- [ ] **Step 67: Create `app/explore/src/api/path.ts`** — `fetchPath(from, to)` calls `/graph/path?from=...&to=...`.

- [ ] **Step 68: Update `ExploreHeader.vue`** — the "Find path" button emits a `findPath` event with `{from, to}` slugs. (UI shell was scaffolded in Task 4; this PR wires it.)

- [ ] **Step 69: Update `App.vue`** to listen for `findPath`, call the API, pass the resulting `steps` to `ExploreGraph.vue` as a prop.

- [ ] **Step 70: Update `ExploreGraph.vue`** — when a `path` prop is set, overlay edges along the path in a highlight color, camera-fit the bounding box of the path nodes.

- [ ] **Step 71: Fire `kg.explore.path_drawn`** telemetry from the overlay branch.

### 5.4 Hybrid test

- [ ] **Step 72: Write the failing hybrid test** at `test/hybrid/graph-path-route.test.js`

```javascript
import { describe, it, beforeAll, expect } from 'vitest'

describe('/graph/path (HTTP)', () => {
  let baseUrl
  beforeAll(() => { baseUrl = process.env.HYBRID_SRV_URL ?? 'http://localhost:4004' })

  it('returns 400 when from/to missing', async () => {
    const r = await fetch(`${baseUrl}/graph/path`)
    expect(r.status).toBe(400)
  })

  it('returns 400 for invalid slug', async () => {
    const r = await fetch(`${baseUrl}/graph/path?from=A%20B&to=valid-slug`)
    expect(r.status).toBe(400)
  })

  it('returns 404 when no path exists between unrelated slugs', async () => {
    const r = await fetch(`${baseUrl}/graph/path?from=__nonexistent_a&to=__nonexistent_b`)
    expect(r.status).toBe(404)
  })

  it('returns 200 + steps for a known-connected pair', async () => {
    // Probe /graph/explore-data and find any edge — its endpoints are
    // guaranteed to be connected (1-hop path). Use those slugs.
    const probe = await fetch(`${baseUrl}/graph/explore-data`)
    const { nodes, edges } = await probe.json()
    if (!edges.length) {
      // No graph data in this env — skip rather than fail.
      console.log('SKIP: no edges in /graph/explore-data')
      return
    }
    // Find an edge with both endpoints having slugs (some node types may
    // not carry a slug). Use the first such edge.
    const edge = edges.find(e => {
      const s = nodes.find(n => n.id === e.s)?.slug
      const o = nodes.find(n => n.id === e.o)?.slug
      return s && o && /^[a-z0-9-]+$/.test(s) && /^[a-z0-9-]+$/.test(o)
    })
    if (!edge) {
      console.log('SKIP: no edge with two slug-bearing endpoints')
      return
    }
    const from = nodes.find(n => n.id === edge.s).slug
    const to = nodes.find(n => n.id === edge.o).slug
    const r = await fetch(`${baseUrl}/graph/path?from=${from}&to=${to}`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(Array.isArray(body.steps)).toBe(true)
    expect(body.steps.length).toBeGreaterThan(0)
  })
})
```

### 5.5 Commit + Push

- [ ] **Step 73: Commit + Push**

```bash
git commit -m "feat(#446): /graph/path endpoint + find-path UI overlay

- Extract Phase 2 path-finding logic to srv/lib/kg-path.js (shared between
  the Joule tool and the new public endpoint).
- New GET /graph/path?from=X&to=Y endpoint, unauthenticated, validates slugs.
- Explore page header pickers wired to the endpoint; result overlays the
  path on the viz with camera-fit.
- Telemetry kg.explore.path_drawn lands on overlay render.
- Joule tool now consumes kg-path.js; existing Joule tests still pass."
```

---

## Task 6 — Mobile typed-list fallback + smoke + rollout note

**PR title:** `feat(kg): mobile typed-list fallback + smoke + rollout note (#446 PR 9/9)`

**Files:**
- Create: `app/explore/src/components/MobileTypedList.vue`
- Modify: `app/explore/src/App.vue` (route between viz and mobile-list based on viewport)
- Create: `app/explore/src/composables/useViewport.ts`
- Create: `app/explore/src/__tests__/MobileTypedList.test.ts`
- Create: `test/smoke/explore-route.smoke.test.js`
- Create: `docs/superpowers/done/<YYYY-MM-DD>-knowledge-graph-phase3-shipped.md`
- Modify: `docs/developers/operations/testing-endpoints.md`

### 6.1 Mobile typed-list

- [ ] **Step 74: Implement `app/explore/src/composables/useViewport.ts`** — reactive `isMobile` ref tied to a `matchMedia('(max-width: 768px)')` query.

- [ ] **Step 75: Write the failing `MobileTypedList` test** — given `{nodes, edges}`, the component renders 4 accordion sections (Tutorials, Concepts, Missions, Products); each tap navigates to the underlying slug page.

- [ ] **Step 76: Implement `app/explore/src/components/MobileTypedList.vue`** — accordion grouped by `nodeType`, alphabetical, anchors to `/tutorials/<slug>/` or `/concepts/<slug>/`.

- [ ] **Step 77: Update `App.vue`** — on mobile, render `MobileTypedList`; on desktop, render the full viz chrome.

### 6.2 Smoke test

- [ ] **Step 78: Create `test/smoke/explore-route.smoke.test.js`**

```javascript
import { describe, it, expect } from 'vitest'

const BASE = process.env.SMOKE_BASE_URL
if (!BASE) throw new Error('SMOKE_BASE_URL not set')
const SRV = process.env.SMOKE_SRV_URL
if (!SRV) throw new Error('SMOKE_SRV_URL not set')

describe('/explore/ route', () => {
  it('returns 200 with inline graph JSON', async () => {
    const r = await fetch(`${BASE}/explore/`)
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain('id="initial-graph"')
    expect(html).toContain('"nodes":')
  })

  it('references the explore bundle', async () => {
    const r = await fetch(`${BASE}/explore/`)
    const html = await r.text()
    expect(html).toMatch(/\/explore-ui\/main-[a-z0-9]+\.js/)
  })

  it('returns 200 for /graph/explore-data', async () => {
    const r = await fetch(`${SRV}/graph/explore-data`)
    expect(r.status).toBe(200)
  })

  it('returns 200 for /graph/path with valid slugs', async () => {
    // Probe /graph/explore-data for two slug-bearing endpoints of any edge.
    const probe = await fetch(`${SRV}/graph/explore-data`)
    if (!probe.ok) return
    const { nodes, edges } = await probe.json()
    const edge = edges.find(e => {
      const s = nodes.find(n => n.id === e.s)?.slug
      const o = nodes.find(n => n.id === e.o)?.slug
      return s && o && /^[a-z0-9-]+$/.test(s) && /^[a-z0-9-]+$/.test(o)
    })
    if (!edge) return  // empty-env skip; no slugs to probe
    const from = nodes.find(n => n.id === edge.s).slug
    const to = nodes.find(n => n.id === edge.o).slug
    const r = await fetch(`${SRV}/graph/path?from=${from}&to=${to}`)
    expect(r.status).toBe(200)
  })
})
```

### 6.3 Rollout note

- [ ] **Step 79: Create `docs/superpowers/done/<today>-knowledge-graph-phase3-shipped.md`** following the shape of `docs/superpowers/done/2026-06-19-knowledge-graph-phase1-shipped.md`. Include:
  - What shipped (Track 3-A summary + Track 3-B summary)
  - Pre-flight verification (smoke + hybrid)
  - Telemetry baseline (after 1h browsing)
  - Cron health (graphRebuild now applies k-anonymity)
  - HTTP health for the new routes
  - HANA usage delta
  - Production rollout status

### 6.4 Operations doc update

- [ ] **Step 80: Append to `docs/developers/operations/testing-endpoints.md`**

| `/explore/` | public | none | CAP-rendered HTML shell with inline graph JSON |
| `/graph/explore-data` | public | none | Bulk graph JSON for the explore page (5-min cache) |
| `/graph/path` | public | none | Path-finding between two slugs (extracted from Phase 2 Joule tool) |

### 6.5 Commit + Push

- [ ] **Step 81: Final smoke + push**

```bash
npm test                          # full unit suite
npm run test:hybrid               # full hybrid suite (post-deploy)
git commit -m "feat(#446): mobile typed-list + smoke tests + rollout note

- MobileTypedList.vue replaces the viz at <768px viewport
- App.vue routes between viz and mobile-list based on useViewport
- New smoke test validates /explore/, /graph/explore-data, /graph/path
- Rollout note in docs/superpowers/done/
- Operations endpoint reference updated

Closes Track 3-B of #446. Phase 3 complete (Tracks 3-A + 3-B both shipped)."
```

---

## Track 3-B done. What's next

After Track 3-B merges to `main` and the smoke suite is green on DEV:

1. File any follow-up issues for the lessons learned during 3-B implementation (e.g., perf at 5000 nodes — was the issue's "worst-case" actually hit?).
2. Mark the **Phase 3 epic (#446) as closed**; the spec's "Phase 3 complete" criteria are all met once both tracks ship.
3. Phase 4 (if there is one) gets a new spec → plan → implement cycle.

---

## Skills referenced

- `@superpowers:test-driven-development` — red/green/refactor rhythm for every step.
- `@superpowers:subagent-driven-development` (recommended execution mode) — fresh subagent per task; two-stage review.
- `@superpowers:executing-plans` (alternative execution mode) — inline batch execution with checkpoints.
- `mcp__plugin_cds-mcp_cds-mcp__search_docs` — search CAP docs before guessing CDS or Node API signatures (CLAUDE.md hard constraint).
- Sigma.js docs: <https://www.sigmajs.org/docs/>
- graphology docs: <https://graphology.github.io/>
