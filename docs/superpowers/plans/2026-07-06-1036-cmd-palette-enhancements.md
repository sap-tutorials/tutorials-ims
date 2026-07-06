# Command Palette Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `⌘K` command palette with three new EXPLORE nav entries (Concepts, Devtoberfest, Developer Advocates), dynamic concept-name search results, and a new "KNOWLEDGE GRAPH" group backed by an anonymous CDS action that never enqueues on-demand extraction.

**Architecture:** Frontend: add three static entries in `hugo-apps/src/cmd-palette/actions.ts`, then extend `CommandPalette.vue` with two new async searchers (`searchConcepts` against `/graph/PublishedConcepts?$search=…`, `searchKG` against `/graph/searchKG`) that render into two new group blocks alongside the existing ACTIONS / EXPLORE / TUTORIALS groups. Backend: add one CDS action `searchKG(term, maxConcepts, maxTutorials)` on the existing `KnowledgeGraphService` (path `/graph`, `@requires: 'any'`) with a new handler `srv/lib/kg/search-kg-handler.js` that shares the seed/walk/hydrate helpers with the Joule tool but never imports `on-demand-enqueue.js`.

**Tech Stack:** TypeScript + Vue 3 (`hugo-apps/`), CAP Node.js CDS (`srv/`), vitest + happy-dom (unit), `cds.test` in-memory SQLite (srv unit), hybrid tests via `cds bind --exec` against real HANA.

## Global Constraints

- **Auth posture** — Both new endpoints inherit `KnowledgeGraphService`'s service-level `@requires: 'any'`. No `@requires: 'authenticated-user'` on the new action.
- **Never enqueue** — `srv/lib/kg/search-kg-handler.js` MUST NOT import `srv/lib/kg/on-demand-enqueue.js`. A palette keystroke must never call `enqueueOnDemandExtraction`.
- **Fail-open** — Any throw inside `search-kg-handler.js` returns `{concepts: [], tutorials: []}` at 200. Never a 5xx to an anonymous caller.
- **Debounce timer** — Single 250ms timer in `CommandPalette.vue` fires all three searchers in parallel. Bumped from the existing 200ms.
- **Query-tag race guard** — Each searcher tags its result with the query string that produced it; stale responses (where `query.value !== responseQuery`) are discarded. Apply uniformly to all three searchers, including the existing `searchTutorials`.
- **Group order** — `[actions, explore, tutorials, concepts, kg]`. Keyboard nav walks in that order.
- **Static entry placement** — The three new EXPLORE entries go between `explore-connect` and `explore-knowledge-graph` in `PALETTE_ACTIONS`.
- **Icon fallback** — Palette already falls back to `•` if the SAP icon font isn't loaded. Use `bullet-text` for concept rows, `org-chart` for KG rows.
- **CDS build** — After any change to `srv/knowledge-graph-service.cds`, run `npm run build:all` locally before hybrid tests; the CDS compile step must succeed before the handler wire-up test can pass.
- **Test frameworks** — hugo-apps tests: `// @vitest-environment happy-dom` at top-of-file; server-side tests: vitest with `cds.test` in-memory SQLite for unit, hybrid tests use `cds bind --exec`.

## File Structure

**Backend (server, `srv/`):**
- **Modify** `srv/knowledge-graph-service.cds` — add one `action searchKG(...)` declaration.
- **Modify** `srv/knowledge-graph-service.js` — register `this.on('searchKG', ...)` wired to the new handler.
- **Create** `srv/lib/kg/search-kg-handler.js` — the anonymous-safe, no-enqueue handler (~120 lines). Shares helpers with `joule-tool-expand-concepts.js` but does NOT import `on-demand-enqueue.js`.

**Frontend (`hugo-apps/`):**
- **Modify** `hugo-apps/src/cmd-palette/actions.ts` — add three new EXPLORE entries.
- **Modify** `hugo-apps/src/cmd-palette/CommandPalette.vue` — two new refs, two new async searchers, two new template group blocks, `activeIndex` math updated to walk five arrays via a `flatIndex()` helper.

**Tests:**
- **Modify** `hugo-apps/src/cmd-palette/actions.test.ts` — extend with three new EXPLORE entry assertions.
- **Create** `hugo-apps/src/cmd-palette/CommandPalette.test.ts` — new integration test with `@vue/test-utils`, mocks fetch, walks all five groups.
- **Create** `test/kg-search-kg-handler.test.js` — server-side unit tests (vitest + `cds.test`), mirrors the pattern in `test/kg-joule-tool-expand-concepts.test.js`. **Asserts `enqueueOnDemandExtraction` is never called.**
- **Create** `test/hybrid/search-kg.hybrid.test.js` — hybrid test against real HANA verifying anonymous 200 + no drain-queue row after garbage seed.

---

### Task 1: New anonymous `searchKG` handler with fail-open + no-enqueue guarantee

**Files:**
- Create: `srv/lib/kg/search-kg-handler.js`
- Test: `test/kg-search-kg-handler.test.js`

**Interfaces:**
- Consumes: `topConceptsByCosine` from `srv/lib/kg/concept-embedding-query.js`; `fetchEdges`, `fetchConceptsByIds`, `fetchLinks` from `srv/lib/kg/_search-fetches.js`; injected `embedClient` with signature `embed(text: string, opts?: {signal?: AbortSignal}) => Promise<Float32Array>`; `cds` for `cds.log`.
- Produces: `export async function searchKgHandler({ db, embedClient, args, telemetry?, timeoutMs?: number = 3000 }): Promise<{ concepts: Array<{slug:string,name:string,score:number}>, tutorials: Array<{slug:string,title:string,score:number}> }>`. No `queryEcho`, no `rationale`, no `warning` in the shape — the caller is a UI that shows/hides groups by array emptiness.
- MUST NOT import `srv/lib/kg/on-demand-enqueue.js`. Verified by a static-grep test AND a mock-and-assert test.

- [ ] **Step 1: Write the failing test file** — create `test/kg-search-kg-handler.test.js` with the complete content shown in the code block below this step list.
- [ ] **Step 2: Run the test to verify it fails** — `npx vitest run test/kg-search-kg-handler.test.js` — expect `Cannot find module '../srv/lib/kg/search-kg-handler.js'`.
- [ ] **Step 3: Create the handler** — create `srv/lib/kg/search-kg-handler.js` with the complete content shown in the second code block below.
- [ ] **Step 4: Run the test to verify it passes** — `npx vitest run test/kg-search-kg-handler.test.js` — expect 7 tests PASS, 0 failures.
- [ ] **Step 5: Commit** — `git add srv/lib/kg/search-kg-handler.js test/kg-search-kg-handler.test.js && git commit -m "feat(#1036): add anonymous-safe searchKgHandler (never enqueues)"`

**Test file — `test/kg-search-kg-handler.test.js` (complete content for Step 1):**

```js
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import cds from '@sap/cds'
import { readFileSync } from 'node:fs'
import { searchKgHandler } from '../srv/lib/kg/search-kg-handler.js'
import { enqueueOnDemandExtraction } from '../srv/lib/kg/on-demand-enqueue.js'

vi.mock('../srv/lib/kg/on-demand-enqueue.js', () => ({
  enqueueOnDemandExtraction: vi.fn().mockResolvedValue({ status: 'enqueued' }),
}))

function encode(vec) {
  const buf = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}
function unit(i, dims = 1536) { const v = new Array(dims).fill(0); v[i] = 1; return v }

describe('searchKgHandler', () => {
  let db, embedClient
  const conceptIds = ['c-cap', 'c-cds', 'c-other']
  const tutorialIds = ['t-cap', 't-abap']

  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
    db = await cds.connect.to('db')
    await cds.deploy(cds.model || 'db/schema.cds').to(db)
    const active = { status: 'ACTIVE', publishedAt: new Date().toISOString(), mergedInto_ID: null }
    await db.run(INSERT.into('com.sap.developers.ims.Concepts').entries([
      { ID: conceptIds[0], slug: 'cap-service', name: 'CAP Service',    embedding: encode(unit(0)), ...active },
      { ID: conceptIds[1], slug: 'cds-model',   name: 'CDS Model',      embedding: encode(unit(1)), ...active },
      { ID: conceptIds[2], slug: 'unrelated',   name: 'Unrelated',      embedding: encode(unit(2)), ...active },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.ConceptEdges').entries([
      { ID: cds.utils.uuid(), source_ID: conceptIds[0], target_ID: conceptIds[1], predicate: 'relatedTo', confidence: 0.8 },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.Tutorials').entries([
      { ID: tutorialIds[0], slug: 'build-cap-svc', title: 'Build a CAP service' },
      { ID: tutorialIds[1], slug: 'basic-abap',    title: 'Basic ABAP' },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.TutorialConceptLinks').entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutorialIds[0], concept_ID: conceptIds[0], predicate: 'teaches', confidence: 0.9 },
      { ID: cds.utils.uuid(), tutorial_ID: tutorialIds[0], concept_ID: conceptIds[1], predicate: 'teaches', confidence: 0.7 },
      { ID: cds.utils.uuid(), tutorial_ID: tutorialIds[1], concept_ID: conceptIds[2], predicate: 'teaches', confidence: 0.9 },
    ]))
    embedClient = { embed: vi.fn(async () => Float32Array.from(unit(0))) }
  })
  afterAll(async () => { await db.disconnect?.() })

  it('returns concepts + tutorials for a valid query, sans queryEcho/rationale', async () => {
    const out = await searchKgHandler({
      db, embedClient, args: { term: 'cap service', maxConcepts: 3, maxTutorials: 5 },
    })
    expect(out).toHaveProperty('concepts')
    expect(out).toHaveProperty('tutorials')
    expect(out.queryEcho).toBeUndefined()
    expect(out.concepts.map(c => c.slug)).toContain('cap-service')
    expect(out.tutorials.map(t => t.slug)).toContain('build-cap-svc')
    for (const t of out.tutorials) expect(t.rationale).toBeUndefined()
  })

  it('returns { concepts: [], tutorials: [] } for empty/whitespace query — no error', async () => {
    const out = await searchKgHandler({ db, embedClient, args: { term: '   ' } })
    expect(out.concepts).toEqual([])
    expect(out.tutorials).toEqual([])
  })

  it('returns empty arrays on embed failure (fail-open, never throws)', async () => {
    const bad = { embed: vi.fn().mockRejectedValue(new Error('embed 500')) }
    const out = await searchKgHandler({ db, embedClient: bad, args: { term: 'anything' } })
    expect(out.concepts).toEqual([])
    expect(out.tutorials).toEqual([])
  })

  it('returns empty arrays when KG has no matching seeds', async () => {
    const empty = await cds.connect.to({ kind: 'sqlite', credentials: { url: ':memory:' } })
    await cds.deploy(cds.model || 'db/schema.cds').to(empty)
    const out = await searchKgHandler({ db: empty, embedClient, args: { term: 'anything' } })
    expect(out.concepts).toEqual([])
    expect(out.tutorials).toEqual([])
  })

  it('NEVER calls enqueueOnDemandExtraction — even on zero-seed queries', async () => {
    const empty = await cds.connect.to({ kind: 'sqlite', credentials: { url: ':memory:' } })
    await cds.deploy(cds.model || 'db/schema.cds').to(empty)
    await searchKgHandler({ db: empty, embedClient, args: { term: 'zzz nothing here' } })
    expect(enqueueOnDemandExtraction).not.toHaveBeenCalled()
  })

  it('handler source file does not import on-demand-enqueue.js (static guarantee)', () => {
    const src = readFileSync(new URL('../srv/lib/kg/search-kg-handler.js', import.meta.url), 'utf8')
    expect(src).not.toMatch(/on-demand-enqueue/)
    expect(src).not.toMatch(/enqueueOnDemandExtraction/)
  })

  it('clamps maxConcepts and maxTutorials to sane bounds', async () => {
    const out = await searchKgHandler({
      db, embedClient, args: { term: 'x', maxConcepts: 999, maxTutorials: -1 },
    })
    expect(out.concepts.length).toBeLessThanOrEqual(10)
    expect(out.tutorials.length).toBeGreaterThanOrEqual(0)
  })
})
```

**Handler file — `srv/lib/kg/search-kg-handler.js` (complete content for Step 3):**

```js
// srv/lib/kg/search-kg-handler.js
//
// Anonymous-safe KG search for the ⌘K command palette (issue #1036).
//
// Same seed / walk / hydrate / link-aggregate algorithm as
// srv/lib/kg/joule-tool-expand-concepts.js MINUS:
//   • the on-demand extraction enqueue on zero-seed queries
//   • the queryEcho / rationale / warning fields the Joule LLM needs
//
// This file MUST NOT import on-demand-enqueue.js. A palette keystroke never
// spams the drain queue. A static-grep test in
// test/kg-search-kg-handler.test.js fails if the import is added.

import cds from '@sap/cds'
import { topConceptsByCosine } from './concept-embedding-query.js'
import { fetchEdges, fetchConceptsByIds, fetchLinks } from './_search-fetches.js'

const LOG = cds.log('search-kg-handler')

const DEFAULT_MAX_CONCEPTS = 5
const DEFAULT_MAX_TUTORIALS = 5
const HARD_QUERY_LIMIT = 200
const WALK_BOOST = 0.5
const DEFAULT_TIMEOUT_MS = 3000  // palette keystrokes — users abandon fast

function clampInt(value, min, max, defaultValue) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return defaultValue
  return Math.max(min, Math.min(max, n))
}

/**
 * @param {object} opts
 * @param {object}   opts.db           - CDS db handle
 * @param {object}   opts.embedClient  - { embed(text, opts?) => Promise<Float32Array> }
 * @param {object}   opts.args         - { term, maxConcepts?, maxTutorials? }
 * @param {object=}  opts.telemetry    - { emit(event, payload) } optional
 * @param {number=}  opts.timeoutMs    - default 3000
 * @returns {Promise<{concepts: Array, tutorials: Array}>} Fail-open — always resolves.
 */
export async function searchKgHandler({ db, embedClient, args, telemetry, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const rawQuery = typeof args?.term === 'string' ? args.term.trim() : ''
  if (!rawQuery) return { concepts: [], tutorials: [] }
  if (rawQuery.length > HARD_QUERY_LIMIT) return { concepts: [], tutorials: [] }

  const maxConcepts = clampInt(args?.maxConcepts, 1, 10, DEFAULT_MAX_CONCEPTS)
  const maxTutorials = clampInt(args?.maxTutorials, 1, 20, DEFAULT_MAX_TUTORIALS)

  const t0 = Date.now()
  const deadline = t0 + timeoutMs
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error('searchKG timeout')), timeoutMs)
  const timedOut = () => Date.now() >= deadline

  try {
    let queryVector
    try {
      queryVector = await embedClient.embed(rawQuery, { signal: abort.signal })
    } catch (err) {
      LOG.warn?.('embed failed:', err.message)
      return { concepts: [], tutorials: [] }
    }
    if (timedOut()) return { concepts: [], tutorials: [] }

    const seeds = await topConceptsByCosine({ db, queryVector, limit: maxConcepts })
    if (timedOut()) return { concepts: [], tutorials: [] }
    if (seeds.length === 0) return { concepts: [], tutorials: [] }

    const seedById = new Map(seeds.map(s => [s.id, s]))
    const edges = await fetchEdges(db, seeds.map(s => s.id))
    if (timedOut()) return { concepts: [], tutorials: [] }

    const boosted = new Map(seeds.map(s => [s.id, { ...s }]))
    const neighbourIds = new Set()
    for (const e of edges) {
      if (boosted.has(e.target_id) && seedById.has(e.target_id)) continue
      const src = seedById.get(e.source_id)
      if (!src) continue
      const boost = WALK_BOOST * src.score * (Number(e.confidence) || 0)
      neighbourIds.add(e.target_id)
      const existing = boosted.get(e.target_id)
      if (existing) existing.score = Math.max(existing.score, boost)
      else boosted.set(e.target_id, { id: e.target_id, score: boost })
    }

    if (neighbourIds.size > 0) {
      const hydrated = await fetchConceptsByIds(db, [...neighbourIds])
      if (timedOut()) return { concepts: [], tutorials: [] }
      const hydratedMap = new Map(hydrated.map(h => [h.id, h]))
      for (const id of neighbourIds) {
        const meta = hydratedMap.get(id)
        const entry = boosted.get(id)
        if (!meta) { boosted.delete(id); continue }
        entry.slug = meta.slug
        entry.name = meta.name
      }
    }

    const allConcepts = [...boosted.values()]
      .filter(c => c.slug && c.name)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxConcepts)

    if (allConcepts.length === 0) return { concepts: [], tutorials: [] }

    const links = await fetchLinks(db, allConcepts.map(c => c.id))
    if (timedOut()) return { concepts: [], tutorials: [] }
    const conceptScoreById = new Map(allConcepts.map(c => [c.id, c.score]))

    const perTutorial = new Map()
    for (const l of links) {
      const cs = conceptScoreById.get(l.concept_id) ?? 0
      const contribution = cs * (Number(l.confidence) || 0)
      let bucket = perTutorial.get(l.tutorial_id)
      if (!bucket) {
        bucket = { slug: l.tutorial_slug, title: l.title, score: 0 }
        perTutorial.set(l.tutorial_id, bucket)
      }
      bucket.score += contribution
    }

    const tutorials = [...perTutorial.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, maxTutorials)

    telemetry?.emit?.('kg.palette.search_returned', {
      conceptCount: allConcepts.length,
      tutorialCount: tutorials.length,
      latencyMs: Date.now() - t0,
    })

    return {
      concepts: allConcepts.map(c => ({ slug: c.slug, name: c.name, score: Number(c.score.toFixed(4)) })),
      tutorials: tutorials.map(t => ({ slug: t.slug, title: t.title, score: Number(t.score.toFixed(4)) })),
    }
  } catch (err) {
    LOG.warn?.('searchKgHandler failed open:', err.message)
    return { concepts: [], tutorials: [] }
  } finally {
    clearTimeout(timer)
  }
}
```

---

### Task 2: Expose `searchKG` as a CDS action and wire the handler

**Files:**
- Modify: `srv/knowledge-graph-service.cds` — add one action declaration in the anonymous read-side action cluster (after `neighborhoodFull` / `pathBetween` / `conceptsForUser`, before `runSparql` which requires admin).
- Modify: `srv/knowledge-graph-service.js` — register `this.on('searchKG', …)` inside the existing `cds.service.impl` callback.
- Test: `test/kg-search-kg-action.test.js` (new)

**Interfaces:**
- Consumes: `searchKgHandler` from Task 1.
- Produces: `POST /graph/searchKG` accepting `{term: string, maxConcepts?: number, maxTutorials?: number}` and returning `{concepts: [...], tutorials: [...]}` per the handler contract. Anonymous callers (no `Authorization` header) get 200 — inherited `@requires: 'any'`.

- [ ] **Step 1: Write the failing action test** — create `test/kg-search-kg-action.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

describe('KnowledgeGraphService.searchKG action', () => {
  let srv
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
    srv = await cds.test.in(process.cwd()).run().catch(() => null)
    // fall back to direct connect if cds.test isn't wired for this file
    if (!srv) srv = await cds.connect.to('KnowledgeGraphService')
  })

  it('exposes searchKG as an unbound action on the service', async () => {
    const kg = cds.services['KnowledgeGraphService'] || await cds.connect.to('KnowledgeGraphService')
    const action = kg.operations?.searchKG || kg.definition?.actions?.searchKG
    expect(action).toBeDefined()
  })

  it('returns the { concepts, tutorials } shape even for a garbage term', async () => {
    const kg = cds.services['KnowledgeGraphService'] || await cds.connect.to('KnowledgeGraphService')
    const out = await kg.send('searchKG', { term: 'zzz-nothing-here-xyz-1036' })
    expect(out).toHaveProperty('concepts')
    expect(out).toHaveProperty('tutorials')
    expect(Array.isArray(out.concepts)).toBe(true)
    expect(Array.isArray(out.tutorials)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/kg-search-kg-action.test.js` — expect the first `it` to fail with `expected undefined to be defined` (action not declared yet).

- [ ] **Step 3: Declare the action in `srv/knowledge-graph-service.cds`** — locate the line `action runSparql(query : String) returns SparqlResult;` (currently line ~237). Insert immediately BEFORE it:

```cds
  /**
   * Anonymous KG search for the ⌘K command palette (issue #1036).
   * Same seed/walk/hydrate/link-aggregate as expandSearchConcepts, MINUS
   * the on-demand-extraction enqueue. Fail-open — never returns a warning.
   */
  action searchKG(term : String, maxConcepts : Integer, maxTutorials : Integer)
    returns {
      concepts  : many {
        slug  : String;
        name  : String;
        score : Double;
      };
      tutorials : many {
        slug  : String;
        title : String;
        score : Double;
      };
    };
```

- [ ] **Step 4: Wire the handler in `srv/knowledge-graph-service.js`** — two edits:

**4a. Add top-level imports** — near the other `import` statements at the top of the file (grep for `from './lib/kg/'` to find the cluster), add:

```js
import { searchKgHandler } from './lib/kg/search-kg-handler.js'
```

Verify the embed-client helper is already imported at the top of the file — grep for `embed-client` in `srv/knowledge-graph-service.js`. If already imported under a name like `embedClient` / `getEmbedClient` / `createEmbedClient`, reuse the existing binding. If NOT imported, add it top-level using whatever name that file exports (grep `srv/lib/kg/embed-client.js` for its `export`).

**4b. Register the handler** — inside the `cds.service.impl(async function () { … })` block, next to `this.on('neighborhood', …)` (line ~785), add:

```js
  // Anonymous KG search for the ⌘K command palette (issue #1036). Delegates
  // to the anonymous-safe handler; never imports on-demand-enqueue.
  this.on('searchKG', async (req) => {
    const db = await cds.connect.to('db')
    const embedClient = await getEmbedClient()   // adjust if the helper is exported under a different name
    return searchKgHandler({
      db,
      embedClient,
      args: {
        term: req.data.term,
        maxConcepts: req.data.maxConcepts,
        maxTutorials: req.data.maxTutorials,
      },
    })
  })
```

Match the convention already used inside `cds.service.impl` for the other actions — if the surrounding handlers reference a module-scope `embedClient` singleton instead of calling a factory, do the same here. The name/shape must match what's used by the existing handlers in this file.

- [ ] **Step 5: Run to verify it passes** — `npx vitest run test/kg-search-kg-action.test.js` — expect 2 PASS. Then run the handler test again to confirm no regression: `npx vitest run test/kg-search-kg-handler.test.js` — expect 7 PASS.

- [ ] **Step 6: Rebuild CDS artifacts** — `npm run build:all` — the CDS compile must succeed. If it fails on the new action, re-check the type block syntax (many + inline structured type — matches the `MergePreview` / `RebuildResult` patterns already in the file).

- [ ] **Step 7: Commit**

```bash
git add srv/knowledge-graph-service.cds srv/knowledge-graph-service.js test/kg-search-kg-action.test.js
git commit -m "feat(#1036): expose searchKG action on KnowledgeGraphService (anonymous)"
```

---

### Task 3: Hybrid test — anonymous 200 + no drain-queue row after garbage seed

**Files:**
- Create: `test/hybrid/kg-search-kg.test.js`

**Interfaces:**
- Consumes: the CDS action from Task 2, deployed to a HANA-bound CF space (`npm run test:hybrid` boots via `cds.test('serve', '--profile', 'hybrid')`).
- Produces: end-to-end guarantee that a garbage-string keystroke on the palette does NOT insert a row into the `KgOnDemandExtractions` queue. This is the runtime backstop for the static + mock-based guarantees in Task 1.

- [ ] **Step 1: Write the failing hybrid test** — create `test/hybrid/kg-search-kg.test.js`:

```js
// test/hybrid/kg-search-kg.test.js
//
// Runtime contract for #1036: POST /graph/searchKG is anonymous and
// NEVER enqueues an on-demand-extraction row — even on a garbage seed.
//
// Counterpart to test/kg-search-kg-handler.test.js (unit) and
// test/kg-search-kg-action.test.js (CDS shape). This layer catches a bug
// those can't: a future refactor that re-imports on-demand-enqueue in the
// service wire-up or slips it through via a helper.
//
// Run with: npm run test:hybrid -- test/hybrid/kg-search-kg.test.js
// Requires: `cf login` to a HANA-bound CF space first.

import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid')

const GARBAGE_TERM = `palette-hybrid-noenqueue-${Date.now()}`
const KNOWN_TERM = process.env.SMOKE_KG_TERM || 'cap'

describe('POST /graph/searchKG — anonymous', () => {
  it('returns 200 with { concepts, tutorials } shape for a known term', async () => {
    let r
    try {
      r = await project.post('/graph/searchKG', { term: KNOWN_TERM, maxConcepts: 5, maxTutorials: 5 })
    } catch (err) {
      r = err.response
      if (r && (r.status === 401 || r.status === 403)) {
        throw new Error(`Anonymous POST /graph/searchKG was rejected with ${r.status}.`)
      }
      throw err
    }
    expect(r.status).toBe(200)
    expect(r.data).toHaveProperty('concepts')
    expect(r.data).toHaveProperty('tutorials')
    expect(Array.isArray(r.data.concepts)).toBe(true)
    expect(Array.isArray(r.data.tutorials)).toBe(true)
  })

  it('does NOT insert a KgOnDemandExtractions row for a garbage seed', async () => {
    const db = await cds.connect.to('db')
    const before = await db.run(SELECT.from('com.sap.developers.ims.KgOnDemandExtractions')
      .where({ normalizedQuery: { like: `%${GARBAGE_TERM}%` } }))
    expect(before.length).toBe(0)

    const r = await project.post('/graph/searchKG', { term: GARBAGE_TERM })
    expect(r.status).toBe(200)
    expect(r.data.concepts).toEqual([])
    expect(r.data.tutorials).toEqual([])

    // Wait a beat — the enqueue in the Joule handler is fire-and-forget.
    // If the palette action ever regresses to enqueueing, a row would land
    // within a few hundred ms. Sleep 1s then assert nothing landed.
    await new Promise(r => setTimeout(r, 1000))
    const after = await db.run(SELECT.from('com.sap.developers.ims.KgOnDemandExtractions')
      .where({ normalizedQuery: { like: `%${GARBAGE_TERM}%` } }))
    expect(after.length).toBe(0)
  })
})
```

Note: verify the exact entity name `KgOnDemandExtractions` and column `normalizedQuery` in `db/knowledge-graph-ondemand.cds` or similar before running. Adjust the SELECT if the field is `queryKey` / `normalizedKey`. The `enqueueOnDemandExtraction` module in `srv/lib/kg/on-demand-enqueue.js` writes with a consistent field name — grep it for the write column.

- [ ] **Step 2: Run to verify it either fails or is skipped without `cf login`** — `npm run test:hybrid -- test/hybrid/kg-search-kg.test.js`. If no HANA binding, the boot hook skips; if bound and the route isn't deployed, the first `it` fails with a 404 or ECONNREFUSED.

- [ ] **Step 3: Deploy the change if hybrid test framework can't reach a fresh route** — this test may require the change to be deployed first (`.deploy && mbt build && cf deploy …` per the CLAUDE.md canonical local-deploy). If the hybrid boot brings up an in-process server via `cds.test('serve', …)`, deployment isn't strictly needed — the change is loaded from the working tree. **Verify which mode applies by reading `test/hybrid/kg-neighborhood-anonymous.test.js:22-30` — it uses the same `cds.test('serve', …)` pattern, so in-process serve is the default.**

- [ ] **Step 4: Run to verify it passes** — `npm run test:hybrid -- test/hybrid/kg-search-kg.test.js` — expect 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add test/hybrid/kg-search-kg.test.js
git commit -m "test(#1036): hybrid — searchKG anonymous 200 + no enqueue on garbage seed"
```

---

### Task 4: Three new static EXPLORE nav entries in `actions.ts`

**Files:**
- Modify: `hugo-apps/src/cmd-palette/actions.ts`
- Test: `hugo-apps/src/cmd-palette/actions.test.ts` (extend)

**Interfaces:**
- Produces: three new entries in `PALETTE_ACTIONS` with ids `explore-concepts`, `explore-devtoberfest`, `explore-advocates`, all `group: 'explore'`. Placed between `explore-connect` and `explore-knowledge-graph`. Each has a `run: navTo(<href>)` closure.

- [ ] **Step 1: Extend the failing test** — open `hugo-apps/src/cmd-palette/actions.test.ts` and add the following new `describe` block AFTER the existing `describe('keyword-driven discoverability')` block (i.e., after line ~102 in the current file):

```ts
describe('#1036 — Concepts / Devtoberfest / Developer Advocates nav entries', () => {
  it('includes explore-concepts, explore-devtoberfest, explore-advocates in the EXPLORE group', () => {
    const exploreIds = PALETTE_ACTIONS.filter(a => a.group === 'explore').map(a => a.id)
    expect(exploreIds).toEqual(expect.arrayContaining([
      'explore-concepts',
      'explore-devtoberfest',
      'explore-advocates',
    ]))
  })

  it('places the three new entries between explore-connect and explore-knowledge-graph', () => {
    const explore = PALETTE_ACTIONS.filter(a => a.group === 'explore').map(a => a.id)
    const iConnect = explore.indexOf('explore-connect')
    const iKG      = explore.indexOf('explore-knowledge-graph')
    const iConcepts     = explore.indexOf('explore-concepts')
    const iDevtoberfest = explore.indexOf('explore-devtoberfest')
    const iAdvocates    = explore.indexOf('explore-advocates')
    expect(iConnect).toBeGreaterThanOrEqual(0)
    expect(iKG).toBeGreaterThan(iConnect)
    for (const idx of [iConcepts, iDevtoberfest, iAdvocates]) {
      expect(idx).toBeGreaterThan(iConnect)
      expect(idx).toBeLessThan(iKG)
    }
  })

  it.each<[string, string, string]>([
    ['concepts',      'explore-concepts',      '/concepts/'],
    ['glossary',      'explore-concepts',      '/concepts/'],
    ['devtoberfest',  'explore-devtoberfest',  '/devtoberfest/'],
    ['festival',      'explore-devtoberfest',  '/devtoberfest/'],
    ['advocates',     'explore-advocates',     '/developer-advocates/'],
    ['devrel',        'explore-advocates',     '/developer-advocates/'],
  ])('keyword %j matches %s and its run navigates to %s', (query, expectedId, expectedHref) => {
    const matched = PALETTE_ACTIONS.filter(a => fuzzyMatch(a, query)).map(a => a.id)
    expect(matched).toContain(expectedId)
    // Assert the run closure navigates to the expected href by stubbing
    // window.location.href assignment.
    const entry = PALETTE_ACTIONS.find(a => a.id === expectedId)!
    const originalHref = window.location.href
    let assigned = ''
    Object.defineProperty(window, 'location', {
      value: { get href() { return originalHref }, set href(v) { assigned = v } },
      configurable: true,
    })
    entry.run(() => {})
    expect(assigned).toBe(expectedHref)
  })
})
```

Also update the existing `it('default group is "actions" — explore-group entries opt in explicitly', ...)` at line ~56: change the assertion `expect(explicitExplore).toBeGreaterThanOrEqual(8)` to `.toBeGreaterThanOrEqual(11)` (was 8 = 7 verbs + KG; now 11 = 7 verbs + KG + 3 new).

Also update the `describe('PALETTE_ACTIONS — EXPLORE group registration')` first test's comment on line ~24: "The verb-spine partial … emits exactly these seven verbs" is still correct — the three new entries are NOT verbs, they sit alongside. No code change needed there, but review the comment for accuracy.

Note: the existing `actions.test.ts` currently expects `explore-model` at line 32 in the `expect.arrayContaining` list. It's there in the current registry — no change needed to that assertion.

- [ ] **Step 2: Run to verify it fails** — `cd hugo-apps && npx vitest run src/cmd-palette/actions.test.ts` — expect the new `describe` block to FAIL: `expected [Array] to contain 'explore-concepts'`.

- [ ] **Step 3: Add the three entries in `hugo-apps/src/cmd-palette/actions.ts`** — locate the closing `},` of the `explore-connect` block (line ~203) and the opening `{` of the `explore-knowledge-graph` block (line ~204). Insert the following three entries between them:

```ts
  {
    id: 'explore-concepts',
    label: 'Concepts — index of every SAP concept in the knowledge graph',
    icon: 'bullet-text',
    keywords: ['concepts', 'index', 'glossary', 'terms', 'kg', 'knowledge'],
    group: 'explore',
    run: navTo('/concepts/'),
  },
  {
    id: 'explore-devtoberfest',
    label: 'Devtoberfest — annual SAP developer festival',
    icon: 'calendar',
    keywords: ['devtoberfest', 'festival', 'event', 'weekly', 'challenge', 'october'],
    group: 'explore',
    run: navTo('/devtoberfest/'),
  },
  {
    id: 'explore-advocates',
    label: 'Developer Advocates — meet the SAP DevRel team',
    icon: 'group',
    keywords: ['advocates', 'devrel', 'team', 'spokespeople', 'community', 'evangelists'],
    group: 'explore',
    run: navTo('/developer-advocates/'),
  },
```

Also update the top-of-EXPLORE comment (currently line ~140–145 in `actions.ts`):

```ts
  // EXPLORE group — the 7 homepage verb-spine routes, three curated
  // destinations (Concepts, Devtoberfest, Developer Advocates — #1036),
  // and the Knowledge Graph Explorer. Order matches the verb-spine partial
  // at hugo/layouts/partials/homepage/verb-spine.html (LEARN, BUILD,
  // INTEGRATE, MODEL, OPERATE, AI, CONNECT). Keep the verb list in sync if
  // the spine ever gains an eighth verb; otherwise the palette will be out
  // of date with the homepage's own primary nav.
```

- [ ] **Step 4: Run to verify it passes** — `cd hugo-apps && npx vitest run src/cmd-palette/actions.test.ts` — expect all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/cmd-palette/actions.ts hugo-apps/src/cmd-palette/actions.test.ts
git commit -m "feat(#1036): add Concepts / Devtoberfest / Advocates EXPLORE nav entries"
```

---

### Task 5: CommandPalette.vue — race guard + query-tag on the existing tutorial searcher

**Files:**
- Modify: `hugo-apps/src/cmd-palette/CommandPalette.vue`
- Test: `hugo-apps/src/cmd-palette/CommandPalette.test.ts` (create — first test in the file)

**Interfaces:**
- Produces: an in-flight-response race guard for `searchTutorials`. Adds the pattern all three searchers will share in Task 6 + 7: tag the fetch with the query that produced it, discard on landing if `query.value !== responseQuery`.

**Rationale for landing this before the new groups:** the race guard is a general pattern; introducing it alone (with tutorial searcher only) lets us validate the guard behavior in isolation before layering concept + KG searchers on top. Otherwise a race-condition bug in the guard would surface tangled with new-feature bugs.

- [ ] **Step 1: Write the failing test** — create `hugo-apps/src/cmd-palette/CommandPalette.test.ts`:

```ts
// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CommandPalette from './CommandPalette.vue'

function makeFetchMock(routes: Record<string, unknown | Promise<unknown>>) {
  return vi.fn(async (url: string) => {
    for (const [pattern, body] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        const resolved = await body
        return { ok: true, json: async () => resolved }
      }
    }
    return { ok: false, json: async () => ({}) }
  })
}

describe('CommandPalette — race guard on tutorial searcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('discards a stale in-flight tutorial response when the query has changed', async () => {
    // Two responses; the first (query 'ab') resolves slowly, the second
    // ('abcdef') resolves fast. When both land, the slow one must not
    // clobber the fast one.
    let resolveSlow: (v: unknown) => void = () => {}
    const slow = new Promise(r => { resolveSlow = r })
    const fast = Promise.resolve({ value: [
      { ID: '2', title: 'Fresh result', slug: 'fresh', description: '', primaryTag: null, averageTimeToComplete: null },
    ]})
    let callCount = 0
    globalThis.fetch = vi.fn(async (url: string) => {
      callCount++
      const body = callCount === 1 ? slow : fast
      return { ok: true, json: async () => await body }
    }) as unknown as typeof fetch

    const wrapper = mount(CommandPalette)
    ;(window as unknown as { openCommandPalette: () => void }).openCommandPalette()
    await flushPromises()

    const input = wrapper.find('input.cmdk__input')
    await input.setValue('ab')
    await vi.advanceTimersByTimeAsync(250)   // debounce fires, request 1 in flight

    await input.setValue('abcdef')
    await vi.advanceTimersByTimeAsync(250)   // debounce fires, request 2 completes fast
    await flushPromises()

    // Fast (second) request landed first with the "Fresh result" row.
    expect(wrapper.text()).toContain('Fresh result')

    // Now let the stale request resolve. Its result must be discarded.
    resolveSlow({ value: [
      { ID: '1', title: 'Stale result', slug: 'stale', description: '', primaryTag: null, averageTimeToComplete: null },
    ]})
    await flushPromises()

    expect(wrapper.text()).not.toContain('Stale result')
    expect(wrapper.text()).toContain('Fresh result')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd hugo-apps && npx vitest run src/cmd-palette/CommandPalette.test.ts` — expect the test to fail: `Stale result` appears in the palette because the current `searchTutorials` (line ~213 of the .vue file) unconditionally assigns `tutorialResults.value = ...` when the slow response lands.

- [ ] **Step 3: Add the query-tag race guard to `searchTutorials`** — in `hugo-apps/src/cmd-palette/CommandPalette.vue`, replace the current `async function searchTutorials(term: string) { ... }` (line ~213) with:

```ts
async function searchTutorials(term: string) {
  tutorialRefs.value = []
  if (term.length < 2) {
    tutorialResults.value = []
    searching.value = false
    return
  }
  searching.value = true
  // Race guard: capture the query string that produced this request. When
  // the response lands, if the user has since typed something else,
  // discard our results — they're stale.
  const requestedQuery = term
  try {
    const params = new URLSearchParams()
    params.set('$search', term)
    params.set('$top', '6')
    params.set('$filter', "taskType eq 'TUTORIAL'")
    const res = await fetch(`/search/SearchableItems?${params}`)
    if (!res.ok) {
      if (query.value.trim() === requestedQuery) tutorialResults.value = []
      return
    }
    const data = await res.json()
    if (query.value.trim() !== requestedQuery) return  // stale — discard
    tutorialResults.value = (data.value || [])
      .filter((row: { slug: string | null }) => row.slug)
      .map((row: { ID: string; title: string; slug: string; description: string | null; primaryTag: string | null; averageTimeToComplete: number | null }) => {
        const meta = [row.primaryTag, row.averageTimeToComplete ? `${row.averageTimeToComplete} min` : null].filter(Boolean).join(' · ')
        return {
          id: row.ID,
          label: row.title,
          hint: meta || undefined,
          icon: 'course-book',
          slug: row.slug,
          run: (close: () => void) => {
            close()
            window.location.href = `/tutorials/${row.slug}`
          },
        }
      })
  } catch {
    if (query.value.trim() === requestedQuery) tutorialResults.value = []
  } finally {
    if (query.value.trim() === requestedQuery) searching.value = false
  }
}
```

Also bump the debounce timer from 200 to 250 (line ~258):

```ts
watch(query, (v) => {
  activeIndex.value = 0
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => searchTutorials(v.trim()), 250)
})
```

- [ ] **Step 4: Run to verify it passes** — `cd hugo-apps && npx vitest run src/cmd-palette/CommandPalette.test.ts` — expect PASS.

- [ ] **Step 5: Also run the existing test file to catch regressions** — `cd hugo-apps && npx vitest run src/cmd-palette/actions.test.ts` — expect PASS.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/cmd-palette/CommandPalette.vue hugo-apps/src/cmd-palette/CommandPalette.test.ts
git commit -m "refactor(#1036): race-guard searchTutorials + bump debounce to 250ms"
```

---

### Task 6: CommandPalette.vue — CONCEPTS group (dynamic concept-name search)

**Files:**
- Modify: `hugo-apps/src/cmd-palette/CommandPalette.vue`
- Test: `hugo-apps/src/cmd-palette/CommandPalette.test.ts` (extend)

**Interfaces:**
- Consumes: `GET /graph/PublishedConcepts?$search=<term>&$top=6&$select=slug,name,description` — anonymous.
- Produces: a `conceptResults: PaletteAction[]` ref, a `searchConcepts(term)` function fired from the shared debounce, and a new template group block that renders between TUTORIALS and the empty state. The `activeIndex` math is updated to walk four arrays: `[actions, explore, tutorials, concepts]`. Each concept row navigates to `/concepts/<slug>/`.

- [ ] **Step 1: Write the failing test** — append to `hugo-apps/src/cmd-palette/CommandPalette.test.ts`:

```ts
describe('CommandPalette — CONCEPTS group', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('renders a CONCEPTS group with concept-name search results', async () => {
    globalThis.fetch = makeFetchMock({
      '/search/SearchableItems':   { value: [] },
      '/graph/PublishedConcepts':  { value: [
        { slug: 'cds-annotations',       name: 'CDS Annotations',       description: 'Metadata on CDS entities' },
        { slug: 'cds-associations',      name: 'CDS Associations',      description: 'Relations between entities' },
      ]},
    }) as unknown as typeof fetch

    const wrapper = mount(CommandPalette)
    ;(window as unknown as { openCommandPalette: () => void }).openCommandPalette()
    await flushPromises()

    await wrapper.find('input.cmdk__input').setValue('cds')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    expect(wrapper.text()).toContain('Concepts')          // group heading
    expect(wrapper.text()).toContain('CDS Annotations')
    expect(wrapper.text()).toContain('CDS Associations')

    const conceptAnchor = wrapper.find('a[href="/concepts/cds-annotations/"]')
    expect(conceptAnchor.exists()).toBe(true)
  })

  it('hides the CONCEPTS group when no concept results are returned', async () => {
    globalThis.fetch = makeFetchMock({
      '/search/SearchableItems':   { value: [{ ID: 't', title: 'Only tutorial', slug: 'only', description: '', primaryTag: null, averageTimeToComplete: null }] },
      '/graph/PublishedConcepts':  { value: [] },
    }) as unknown as typeof fetch

    const wrapper = mount(CommandPalette)
    ;(window as unknown as { openCommandPalette: () => void }).openCommandPalette()
    await flushPromises()
    await wrapper.find('input.cmdk__input').setValue('xyz')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    const groupLabels = wrapper.findAll('.cmdk__group-label').map(w => w.text())
    expect(groupLabels).not.toContain('Concepts')
    expect(wrapper.text()).toContain('Only tutorial')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd hugo-apps && npx vitest run src/cmd-palette/CommandPalette.test.ts` — expect the new tests to fail: no `Concepts` heading rendered.

- [ ] **Step 3: Modify `CommandPalette.vue`** — three edits:

**3a. Add the new ref** — near the existing `const tutorialResults = ref<PaletteAction[]>([])` (line ~111), add:

```ts
const conceptResults = ref<PaletteAction[]>([])
```

**3b. Add the `searchConcepts` function** — immediately after the existing `searchTutorials` function (after the closing brace at line ~253), add:

```ts
async function searchConcepts(term: string) {
  if (term.length < 2) {
    conceptResults.value = []
    return
  }
  const requestedQuery = term
  try {
    const params = new URLSearchParams()
    params.set('$search', term)
    params.set('$top', '6')
    params.set('$select', 'slug,name,description')
    const res = await fetch(`/graph/PublishedConcepts?${params}`)
    if (!res.ok) {
      if (query.value.trim() === requestedQuery) conceptResults.value = []
      return
    }
    const data = await res.json()
    if (query.value.trim() !== requestedQuery) return  // stale — discard
    conceptResults.value = (data.value || [])
      .filter((row: { slug: string | null }) => row.slug)
      .map((row: { slug: string; name: string; description: string | null }) => {
        const desc = row.description ? row.description.slice(0, 60) : ''
        const hint = desc ? `Concept · ${desc}${row.description && row.description.length > 60 ? '…' : ''}` : 'Concept'
        return {
          id: `concept-${row.slug}`,
          label: row.name,
          hint,
          icon: 'bullet-text',
          slug: row.slug,
          run: (close: () => void) => {
            close()
            window.location.href = `/concepts/${row.slug}/`
          },
        }
      })
  } catch {
    if (query.value.trim() === requestedQuery) conceptResults.value = []
  }
}
```

**3c. Update the debounce watcher to fire both searchers** — replace the `watch(query, …)` at line ~255 with:

```ts
watch(query, (v) => {
  activeIndex.value = 0
  if (debounceTimer) clearTimeout(debounceTimer)
  const trimmed = v.trim()
  debounceTimer = setTimeout(() => {
    searchTutorials(trimmed)
    searchConcepts(trimmed)
  }, 250)
})
```

**3d. Reset `conceptResults` in `close()`** — line ~148, add `conceptResults.value = []` alongside `tutorialResults.value = []`.

**3e. Extend `move()` and `runActive()` to walk four groups** — replace `move(delta: number)` at line ~157:

```ts
function move(delta: number) {
  const total = actionResults.value.length + exploreResults.value.length
             + tutorialResults.value.length + conceptResults.value.length
  if (!total) return
  activeIndex.value = (activeIndex.value + delta + total) % total
  scrollActiveIntoView()
}
```

Replace `runActive()` at line ~171:

```ts
function runActive() {
  const i = activeIndex.value
  const aLen = actionResults.value.length
  const eLen = exploreResults.value.length
  const tLen = tutorialResults.value.length
  if (i < aLen) { runItem(actionResults.value[i]); return }
  if (i < aLen + eLen) { runItem(exploreResults.value[i - aLen]); return }
  if (i < aLen + eLen + tLen) {
    const tIndex = i - aLen - eLen
    const anchor = tutorialRefs.value[tIndex]
    if (anchor) { close(); anchor.click(); return }
    runItem(tutorialResults.value[tIndex]); return
  }
  const cIndex = i - aLen - eLen - tLen
  runItem(conceptResults.value[cIndex])
}
```

**3f. Add the template block** — in the `<template>` section, insert a new `<template v-if="conceptResults.length">` block AFTER the tutorials block (after the closing `</template>` at line ~82) and BEFORE the empty-state div at line ~84:

```vue
        <template v-if="conceptResults.length">
          <div class="cmdk__group-label">Concepts</div>
          <a
            v-for="(item, i) in conceptResults"
            :key="`c-${item.id}`"
            :href="`/concepts/${item.slug}/`"
            :class="['cmdk__item', 'cmdk__item--link', { 'cmdk__item--active': activeIndex === actionResults.length + exploreResults.length + tutorialResults.length + i }]"
            data-vt-card="navigator"
            role="option"
            :aria-selected="activeIndex === actionResults.length + exploreResults.length + tutorialResults.length + i"
            @mouseenter="activeIndex = actionResults.length + exploreResults.length + tutorialResults.length + i"
            @click="close()"
          >
            <span class="cmdk__item-icon" data-icon="bullet-text" aria-hidden="true"></span>
            <span class="cmdk__item-content">
              <span class="cmdk__item-label nav-card__title">{{ item.label }}</span>
              <span v-if="item.hint" class="cmdk__item-hint">{{ item.hint }}</span>
            </span>
          </a>
        </template>
```

**3g. Update the empty-state condition** — line ~84:

```vue
        <div v-if="!actionResults.length && !exploreResults.length && !tutorialResults.length && !conceptResults.length" class="cmdk__empty">
```

- [ ] **Step 4: Run to verify it passes** — `cd hugo-apps && npx vitest run src/cmd-palette/CommandPalette.test.ts src/cmd-palette/actions.test.ts` — expect all PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/cmd-palette/CommandPalette.vue hugo-apps/src/cmd-palette/CommandPalette.test.ts
git commit -m "feat(#1036): palette — CONCEPTS group with dynamic concept-name results"
```

---

### Task 7: CommandPalette.vue — KNOWLEDGE GRAPH group (dynamic KG neighborhood search)

**Files:**
- Modify: `hugo-apps/src/cmd-palette/CommandPalette.vue`
- Test: `hugo-apps/src/cmd-palette/CommandPalette.test.ts` (extend)

**Interfaces:**
- Consumes: `POST /graph/searchKG` (from Task 2) with body `{term, maxConcepts: 5, maxTutorials: 5}` returning `{concepts: [{slug,name,score}], tutorials: [{slug,title,score}]}`.
- Produces: a `kgResults: PaletteAction[]` ref, a `searchKG(term)` function fired from the shared debounce (same 250ms window as the other two), and a new template group block that renders after CONCEPTS. `activeIndex` math walks five arrays. Concept-slug and tutorial-slug dedupe against `conceptResults` / `tutorialResults` in the KG post-processor.

- [ ] **Step 1: Write the failing test** — append to `hugo-apps/src/cmd-palette/CommandPalette.test.ts`:

```ts
describe('CommandPalette — KNOWLEDGE GRAPH group', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('renders KG concept + tutorial rows, deduped against CONCEPTS/TUTORIALS', async () => {
    globalThis.fetch = makeFetchMock({
      '/search/SearchableItems':  { value: [
        { ID: 't1', title: 'Existing tutorial', slug: 'existing-tut', description: '', primaryTag: null, averageTimeToComplete: null },
      ]},
      '/graph/PublishedConcepts': { value: [
        { slug: 'cds-annotations', name: 'CDS Annotations', description: 'Metadata on entities' },
      ]},
      '/graph/searchKG':          {
        concepts: [
          { slug: 'cds-annotations', name: 'CDS Annotations',   score: 0.99 }, // dup — drop
          { slug: 'cds-associations', name: 'CDS Associations', score: 0.75 }, // fresh — keep
        ],
        tutorials: [
          { slug: 'existing-tut', title: 'Existing tutorial',   score: 0.90 }, // dup — drop
          { slug: 'fresh-tut',    title: 'Fresh KG tutorial',   score: 0.80 }, // fresh — keep
        ],
      },
    }) as unknown as typeof fetch

    const wrapper = mount(CommandPalette)
    ;(window as unknown as { openCommandPalette: () => void }).openCommandPalette()
    await flushPromises()
    await wrapper.find('input.cmdk__input').setValue('cds')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    const groupLabels = wrapper.findAll('.cmdk__group-label').map(w => w.text())
    expect(groupLabels).toEqual(expect.arrayContaining(['Explore', 'Tutorials', 'Concepts', 'Knowledge Graph']))

    // Deduped: the KG row for cds-annotations must NOT appear again under KG.
    const kgRows = wrapper.findAll('.cmdk__group-label').at(-1)!
      .element.parentElement!.querySelectorAll('.cmdk__item')
    const kgLabels = Array.from(kgRows).map(el => el.textContent || '')
    expect(kgLabels.join(' ')).toContain('CDS Associations')
    expect(kgLabels.join(' ')).toContain('Fresh KG tutorial')
    // dup checks — labels are still allowed to APPEAR in the DOM under
    // their non-KG group; we care that they don't appear under KG.
    const kgSectionText = Array.from(kgRows).map(el => el.textContent).join(' ')
    // The dup 'Existing tutorial' from KG should be filtered out of the KG section.
    // (It legitimately still shows under TUTORIALS.)
    expect(kgSectionText).not.toContain('Existing tutorial')
    // The dup 'CDS Annotations' concept from KG should be filtered out of the KG section.
    expect(kgSectionText).not.toContain('CDS Annotations')
  })

  it('hides KG group when /graph/searchKG returns 500 or throws', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/graph/searchKG')) return { ok: false, status: 500, json: async () => ({}) }
      if (url.includes('/search/SearchableItems')) return { ok: true, json: async () => ({ value: [] }) }
      if (url.includes('/graph/PublishedConcepts'))  return { ok: true, json: async () => ({ value: [] }) }
      return { ok: false, json: async () => ({}) }
    }) as unknown as typeof fetch

    const wrapper = mount(CommandPalette)
    ;(window as unknown as { openCommandPalette: () => void }).openCommandPalette()
    await flushPromises()
    await wrapper.find('input.cmdk__input').setValue('anything')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    const groupLabels = wrapper.findAll('.cmdk__group-label').map(w => w.text())
    expect(groupLabels).not.toContain('Knowledge Graph')
    // Empty-state message should render since nothing else matched either.
    expect(wrapper.text()).toContain('No matches.')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd hugo-apps && npx vitest run src/cmd-palette/CommandPalette.test.ts` — expect the new tests to fail.

- [ ] **Step 3: Modify `CommandPalette.vue`** — parallel edits to Task 6:

**3a. Add the ref:**

```ts
const kgResults = ref<PaletteAction[]>([])
```

**3b. Add `searchKG` function** — after `searchConcepts`:

```ts
async function searchKG(term: string) {
  if (term.length < 2) {
    kgResults.value = []
    return
  }
  const requestedQuery = term
  try {
    const res = await fetch('/graph/searchKG', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term, maxConcepts: 5, maxTutorials: 5 }),
    })
    if (!res.ok) {
      if (query.value.trim() === requestedQuery) kgResults.value = []
      return
    }
    const data = await res.json()
    if (query.value.trim() !== requestedQuery) return  // stale — discard

    // Dedupe: drop concepts whose slug already appears in CONCEPTS group,
    // and tutorials whose slug already appears in TUTORIALS group.
    const conceptSlugsSeen = new Set(conceptResults.value.map(c => c.slug).filter(Boolean))
    const tutorialSlugsSeen = new Set(tutorialResults.value.map(t => t.slug).filter(Boolean))

    const conceptRows: PaletteAction[] = (data.concepts || [])
      .filter((c: { slug: string }) => c.slug && !conceptSlugsSeen.has(c.slug))
      .map((c: { slug: string; name: string; score: number }) => ({
        id: `kg-c-${c.slug}`,
        label: c.name,
        hint: `via KG · score ${c.score.toFixed(2)}`,
        icon: 'org-chart',
        slug: c.slug,
        run: (close: () => void) => { close(); window.location.href = `/concepts/${c.slug}/` },
      }))

    const tutorialRows: PaletteAction[] = (data.tutorials || [])
      .filter((t: { slug: string }) => t.slug && !tutorialSlugsSeen.has(t.slug))
      .map((t: { slug: string; title: string; score: number }) => ({
        id: `kg-t-${t.slug}`,
        label: t.title,
        hint: `via KG · score ${t.score.toFixed(2)}`,
        icon: 'org-chart',
        slug: t.slug,
        run: (close: () => void) => { close(); window.location.href = `/tutorials/${t.slug}` },
      }))

    kgResults.value = [...conceptRows, ...tutorialRows]
  } catch {
    if (query.value.trim() === requestedQuery) kgResults.value = []
  }
}
```

**3c. Update the watcher to fire all three:**

```ts
watch(query, (v) => {
  activeIndex.value = 0
  if (debounceTimer) clearTimeout(debounceTimer)
  const trimmed = v.trim()
  debounceTimer = setTimeout(() => {
    searchTutorials(trimmed)
    searchConcepts(trimmed)
    searchKG(trimmed)
  }, 250)
})
```

**3d. Reset in `close()`** — add `kgResults.value = []`.

**3e. Extend `move()` and `runActive()` to walk five arrays:**

```ts
function move(delta: number) {
  const total = actionResults.value.length + exploreResults.value.length
             + tutorialResults.value.length + conceptResults.value.length
             + kgResults.value.length
  if (!total) return
  activeIndex.value = (activeIndex.value + delta + total) % total
  scrollActiveIntoView()
}

function runActive() {
  const i = activeIndex.value
  const aLen = actionResults.value.length
  const eLen = exploreResults.value.length
  const tLen = tutorialResults.value.length
  const cLen = conceptResults.value.length
  if (i < aLen) { runItem(actionResults.value[i]); return }
  if (i < aLen + eLen) { runItem(exploreResults.value[i - aLen]); return }
  if (i < aLen + eLen + tLen) {
    const tIndex = i - aLen - eLen
    const anchor = tutorialRefs.value[tIndex]
    if (anchor) { close(); anchor.click(); return }
    runItem(tutorialResults.value[tIndex]); return
  }
  if (i < aLen + eLen + tLen + cLen) {
    runItem(conceptResults.value[i - aLen - eLen - tLen])
    return
  }
  runItem(kgResults.value[i - aLen - eLen - tLen - cLen])
}
```

**3f. Add the KG template block** — after the CONCEPTS block:

```vue
        <template v-if="kgResults.length">
          <div class="cmdk__group-label">Knowledge Graph</div>
          <a
            v-for="(item, i) in kgResults"
            :key="`k-${item.id}`"
            :href="item.id.startsWith('kg-c-') ? `/concepts/${item.slug}/` : `/tutorials/${item.slug}`"
            :class="['cmdk__item', 'cmdk__item--link', { 'cmdk__item--active': activeIndex === actionResults.length + exploreResults.length + tutorialResults.length + conceptResults.length + i }]"
            data-vt-card="navigator"
            role="option"
            :aria-selected="activeIndex === actionResults.length + exploreResults.length + tutorialResults.length + conceptResults.length + i"
            @mouseenter="activeIndex = actionResults.length + exploreResults.length + tutorialResults.length + conceptResults.length + i"
            @click="close()"
          >
            <span class="cmdk__item-icon" data-icon="org-chart" aria-hidden="true"></span>
            <span class="cmdk__item-content">
              <span class="cmdk__item-label nav-card__title">{{ item.label }}</span>
              <span v-if="item.hint" class="cmdk__item-hint">{{ item.hint }}</span>
            </span>
          </a>
        </template>
```

**3g. Update the empty-state condition:**

```vue
        <div v-if="!actionResults.length && !exploreResults.length && !tutorialResults.length && !conceptResults.length && !kgResults.length" class="cmdk__empty">
```

- [ ] **Step 4: Run to verify it passes** — `cd hugo-apps && npx vitest run src/cmd-palette/CommandPalette.test.ts src/cmd-palette/actions.test.ts` — expect all PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/cmd-palette/CommandPalette.vue hugo-apps/src/cmd-palette/CommandPalette.test.ts
git commit -m "feat(#1036): palette — KNOWLEDGE GRAPH group with cosine-ranked neighborhood"
```

---

### Task 8: End-to-end verification, follow-up issue, and PR

**Files:**
- No new source files. This task exercises the change end-to-end and files the alias follow-up.

- [ ] **Step 1: Run all cmd-palette tests together** — `cd hugo-apps && npx vitest run src/cmd-palette/` — expect all PASS.

- [ ] **Step 2: Run all server-side KG tests together** — `npx vitest run test/kg-search-kg-handler.test.js test/kg-search-kg-action.test.js test/kg-joule-tool-expand-concepts.test.js` — expect all PASS (the Joule tool test is included to catch any accidental cross-file regression on shared helpers).

- [ ] **Step 3: Build the frontend + Hugo end-to-end** — `npm run build:all` — expect success. This confirms the Vue island still compiles, Hugo builds, and CDS artifacts are current.

- [ ] **Step 4: Hybrid test against a HANA-bound CF space** — assumes `cf login` to `tutorial-system/dev` (per the CLAUDE.md wired environment):

```bash
npm run test:hybrid -- test/hybrid/kg-search-kg.test.js
```

Expect 2 PASS: anonymous 200 with the shape, garbage seed produces no `KgOnDemandExtractions` row.

- [ ] **Step 5: Manual smoke against local dev** — start `cds watch` in one terminal and `npm run dev` in another:

  - Open `http://localhost:1313/` and press `⌘K` / `Ctrl+K`.
  - Verify EXPLORE shows Concepts + Devtoberfest + Developer Advocates entries between Connect and Knowledge Graph Explorer.
  - Type `cds annotations` → expect five groups populated (or four if TUTORIALS matches nothing for that term).
  - Type `slt` → expect CONCEPTS may be empty; KG group should surface `sap-landscape-transformation` via cosine.
  - Press ↓ repeatedly to walk all five groups; verify wrap-around at the last entry.
  - Type garbage `xyzqwertyuiop123` → expect "No matches." Empty state; no console errors.
  - Confirm `cf logs tutorials-srv --recent` (if pointing at deployed) shows no 5xx entries for `/graph/searchKG`.

- [ ] **Step 6: File the aliases follow-up issue** — the design deferred `Concepts.aliases` and promised a follow-up:

```bash
gh issue create --repo sap-tutorials/tutorials-ims \
  --title "KG: add Concepts.aliases for command-palette synonym matching" \
  --body "Follow-up from #1036.

Ship blocker: none — the KG cosine group in ⌘K catches most acronyms (e.g. 'SLT' finds sap-landscape-transformation via embedding similarity).

Motivation: strengthen the CONCEPTS group hit rate for pure acronym queries where cosine misses. Estimated 20–40% of common developer acronyms miss today.

Scope:
- Schema: entity ConceptAliases { key concept: Association to Concepts; key alias: String(120); } as a composition of Concepts.
- One-off backfill: LLM-driven pass over all 698 published concepts extracting common acronyms + synonyms. Wire from srv/lib/kg/, run via a one-shot cds run script.
- Admin UI: expose aliases as a sub-collection under the Concept object page.
- Palette: extend the searchConcepts $search to match against aliases (either via a composed OData \$expand or a new PublishedConceptsWithAliases projection).

Design doc: docs/superpowers/specs/2026-07-06-1036-cmd-palette-enhancements-design.md (see 'Out of scope' section)."
```

- [ ] **Step 7: Push branch and open a draft PR** —

```bash
git push -u origin worktree-cmd-palette-1036
gh pr create --draft --repo sap-tutorials/tutorials-ims \
  --title "feat(#1036): cmd palette — Concepts/Devtoberfest/Advocates nav + concept search + full-KG search" \
  --body "Closes #1036.

Adds three static EXPLORE entries (Concepts / Devtoberfest / Developer Advocates), a dynamic CONCEPTS group backed by \`/graph/PublishedConcepts \$search\`, and a KNOWLEDGE GRAPH group backed by a new anonymous CDS action \`KnowledgeGraphService.searchKG\` that reuses the seed/walk/hydrate helpers from the Joule tool but **never enqueues on-demand extraction** (guarded by a static-grep test AND a mock-and-assert test AND a hybrid test).

Design doc: \`docs/superpowers/specs/2026-07-06-1036-cmd-palette-enhancements-design.md\`
Plan: \`docs/superpowers/plans/2026-07-06-1036-cmd-palette-enhancements.md\`

Follow-up filed: <link to Step 6 issue>."
```

- [ ] **Step 8: Final commit if any last edits are needed** — otherwise the PR is ready for human review.

---

## Global sanity: what MUST be true after all 8 tasks

- `git grep -n "on-demand-enqueue" srv/lib/kg/search-kg-handler.js` — returns nothing.
- `git grep -n "on-demand-enqueue" srv/knowledge-graph-service.js` — returns only the pre-existing hits (verify by comparing to `git show origin/main:srv/knowledge-graph-service.js | grep on-demand-enqueue`).
- Palette open on `/` shows 5 EXPLORE entries above the KG Explorer: Concepts, Devtoberfest, Developer Advocates (new), Learn/Build/Integrate/Model/Operate/AI/Connect (existing).
- Typing `xyzqwertyuiop123` and waiting 3 seconds does NOT insert a row into `KgOnDemandExtractions`.
- `cf logs tutorials-srv --recent | grep '5[0-9][0-9] .*searchKG'` — returns nothing.

## Deliberately deferred from the spec

The design mentioned two items that this plan does NOT schedule; they are minor extensions best done as their own follow-ups if signal appears in production:

- **`test/smoke/` addition** — the hybrid test (Task 3) already exercises the deployed contract for the palette's two new endpoints (anonymous shape + no-enqueue guarantee), and Task 8 Step 5 covers the manual smoke checklist. A dedicated `test/smoke/cmd-palette.*` file would duplicate coverage without meaningfully improving it. If a smoke-test regression later surfaces the palette specifically, add it then.
- **Client-side metrics** (`cmd_palette_concept_search_ms`, `cmd_palette_kg_search_ms`, `cmd_palette_search_fail_total`) — the palette runs anonymously and the metrics module in the codebase is server-first. Emitting from the client would require a new anonymous ingestion endpoint (attack surface + spam risk). If observability into palette latency is genuinely needed, file a dedicated issue for a server-side ingestion channel; do not tack it onto this PR.







