# Joule findLearningPath true A→B path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the Joule `findLearningPath` tool through the existing `KG_PATH_V2` GraphScript shortest-path engine so it returns a true A→B route (destination guaranteed present, or an explicit no-path message), with today's v1 SPARQL as fail-open fallback.

**Architecture:** A new `findPathV2OrV1` helper in `srv/lib/kg-path.js` encapsulates the `KG_PATH_V2_ENABLED` flag + fail-open ladder and returns the *raw vertex sequence* (so the concept bridge can be rendered). `srv/lib/kg/joule-tool-find-path.js` branches on the returned `engine`: v2 renders tutorial vertices as ordered steps plus a "Connected via: <concepts>" bridge line; v1 renders exactly as today. The flag is flipped on for DEV only.

**Tech Stack:** SAP CAP (Node.js, ESM), `@sap/cds`, HANA property-graph (`KG_PATH_V2` via `srv/lib/kg-path-v2-client.js`), Vitest (unit + hybrid projects).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-21-1253-joule-findpath-true-a-to-b-design.md`.
- **ESM only** — `import`/`export`, no `require`. Match existing 2-space indent, single-quote strings, no semicolons in `srv/lib/kg/joule-tool-find-path.js` (that file omits semicolons); `srv/lib/kg-path.js` also omits semicolons. Follow each file's existing style exactly.
- **Tutorial IRI prefix:** `https://developers.sap.com/kg/tutorial/` (constant `TUTORIAL_IRI_PREFIX` already in `kg-path.js`).
- **Concept IRI prefix in vertex keys:** `concept:`; tutorial vertex keys: `tutorial:` (see `KG_PG_EDGES_V.hdbview` / `kg-path-v2-client.js`).
- **Do NOT** touch `KG_PATH_V2.hdbprocedure`, `KG_SHORTEST_PATH_GRAPH`, the property-graph views, the CDS `pathBetween` action, or `GET /graph/path`.
- **No schema/CSV changes** → no `cds build --production`, no HDI redeploy.
- **Flag reuse:** `KG_PATH_V2_ENABLED` (read from `process.env`, `'true'` enables). No new flag.
- **Run unit tests:** `npx vitest run --project unit <file>` (via junctioned `node_modules`).
- **Windows/LF:** keep line endings LF; do not introduce CRLF.

## File Structure

| File | Responsibility |
|------|----------------|
| `srv/lib/kg-path.js` | **Modify** — add `findPathV2OrV1({db,fromSlug,toSlug})` returning `{engine:'v2',vertices}` or `{engine:'v1',candidates}`. Keep `findPath` unchanged. |
| `srv/lib/kg/joule-tool-find-path.js` | **Modify** — fetch via `findPathV2OrV1`; add v2 render branch (tutorial steps + concept bridge, concept-name hydration); keep v1 branch behavior; add `engine` to telemetry. |
| `test/unit/kg-path-v2-or-v1.test.js` | **Create** — unit test for the helper engine-selection ladder. |
| `test/unit/kg-path-between-handler.test.js` | **Modify** — add v2-render + fallback handler cases. |
| `test/hybrid/joule-find-path-handler.test.js` | **Modify** — flag-gated assertion that the named destination appears. |
| `docs/developers/architecture/joule.md` | **Modify** — rewrite the findLearningPath procedure-layer paragraph. |
| `.deploy/mta.yaml` | **Modify** — add `KG_PATH_V2_ENABLED: 'false'` default in srv `properties`. |
| `deploy/dev.mtaext` | **Modify** — add `KG_PATH_V2_ENABLED: 'true'` DEV override. |

---

### Task 1: Add `findPathV2OrV1` helper to `kg-path.js`

**Files:**
- Modify: `srv/lib/kg-path.js` (imports at top ~line 15; new export after `findPath`, ~line 48)
- Test: `test/unit/kg-path-v2-or-v1.test.js` (create)

**Interfaces:**
- Consumes: `findPath({db,fromSlug,toSlug})` (existing, this module); `kgPathV2({fromIri,toIri})` from `./kg-path-v2-client.js` returning `Promise<Array<{pathRank,hopCount,vertices:string[]}>>`.
- Produces: `findPathV2OrV1({db,fromSlug,toSlug}) => Promise<{engine:'v2',vertices:string[]} | {engine:'v1',candidates:Array<{slug,pathType,pathTypeRank,hopCount}>}>`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/kg-path-v2-or-v1.test.js`:

```js
// test/unit/kg-path-v2-or-v1.test.js
//
// Unit tests for findPathV2OrV1 engine-selection ladder (issue #1253).
// Mocks kg-path-v2-client.js (kgPathV2) and kg-sparql-client.js (kgQuery,
// which findPath uses). No HANA.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../srv/lib/kg-path-v2-client.js', () => ({
  kgPathV2: vi.fn(),
}))
vi.mock('../../srv/lib/kg-sparql-client.js', () => ({
  kgQuery: vi.fn(),
  SparqlTimeoutError: class SparqlTimeoutError extends Error {},
  SparqlSyntaxError: class SparqlSyntaxError extends Error {},
}))

const { kgPathV2 } = await import('../../srv/lib/kg-path-v2-client.js')
const { kgQuery } = await import('../../srv/lib/kg-sparql-client.js')
const { findPathV2OrV1 } = await import('../../srv/lib/kg-path.js')

const PFX = 'https://developers.sap.com/kg/tutorial/'
function v1Json(slugs) {
  return JSON.stringify({
    head: { vars: ['b', 'pathType', 'pathTypeRank', 'hopCount'] },
    results: {
      bindings: slugs.map(s => ({
        b: { type: 'uri', value: `${PFX}${s}` },
        pathType: { type: 'literal', value: 'SHARED_CONCEPT' },
        pathTypeRank: { type: 'literal', value: '3' },
        hopCount: { type: 'literal', value: '0' },
      })),
    },
  })
}

const db = { run: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('findPathV2OrV1 engine selection', () => {
  it('flag on + v2 non-empty → returns engine v2 with vertices', async () => {
    vi.stubEnv('KG_PATH_V2_ENABLED', 'true')
    kgPathV2.mockResolvedValue([
      { pathRank: 1, hopCount: 2, vertices: [`tutorial:a`, `concept:x`, `tutorial:b`] },
    ])
    const out = await findPathV2OrV1({ db, fromSlug: 'a', toSlug: 'b' })
    expect(out.engine).toBe('v2')
    expect(out.vertices).toEqual(['tutorial:a', 'concept:x', 'tutorial:b'])
    expect(kgPathV2).toHaveBeenCalledWith({ fromIri: `${PFX}a`, toIri: `${PFX}b` })
    expect(kgQuery).not.toHaveBeenCalled()
  })

  it('flag on + v2 empty → falls through to v1', async () => {
    vi.stubEnv('KG_PATH_V2_ENABLED', 'true')
    kgPathV2.mockResolvedValue([])
    kgQuery.mockResolvedValue({ response: v1Json(['b']) })
    const out = await findPathV2OrV1({ db, fromSlug: 'a', toSlug: 'b' })
    expect(out.engine).toBe('v1')
    expect(out.candidates.map(c => c.slug)).toEqual(['b'])
  })

  it('flag on + v2 throws → falls through to v1 (fail-open)', async () => {
    vi.stubEnv('KG_PATH_V2_ENABLED', 'true')
    kgPathV2.mockRejectedValue(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }))
    kgQuery.mockResolvedValue({ response: v1Json(['b']) })
    const out = await findPathV2OrV1({ db, fromSlug: 'a', toSlug: 'b' })
    expect(out.engine).toBe('v1')
    expect(kgQuery).toHaveBeenCalledTimes(1)
  })

  it('flag off → v1 directly, kgPathV2 never called', async () => {
    vi.stubEnv('KG_PATH_V2_ENABLED', 'false')
    kgQuery.mockResolvedValue({ response: v1Json(['b']) })
    const out = await findPathV2OrV1({ db, fromSlug: 'a', toSlug: 'b' })
    expect(out.engine).toBe('v1')
    expect(kgPathV2).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/kg-path-v2-or-v1.test.js`
Expected: FAIL — `findPathV2OrV1 is not a function` (export does not exist yet).

- [ ] **Step 3: Add imports to `kg-path.js`**

Change the import block at the top of `srv/lib/kg-path.js` (currently line 15):

```js
import cds from '@sap/cds'
import { kgQuery } from './kg-sparql-client.js'
import { kgPathV2 } from './kg-path-v2-client.js'
```

(Add the `cds` and `kgPathV2` lines; keep the existing `kgQuery` import.)

- [ ] **Step 4: Add the `findPathV2OrV1` export**

Insert immediately after the `findPath` function (after its closing brace, ~line 48) in `srv/lib/kg-path.js`:

```js
/**
 * Compute an A→B path, preferring the KG_PATH_V2 property-graph shortest-path
 * engine (issue #913) and failing open to the v1 SPARQL PATH_BETWEEN
 * (findPath) when the flag is off, v2 returns empty, or v2 errors.
 *
 * Unlike the CDS `pathBetween` action (knowledge-graph-service.js), which maps
 * the v2 result to bare tutorial slugs and discards the concept vertices, this
 * helper returns the RAW vertex sequence so the Joule tool can surface the
 * bridging concepts ("Connected via: …"). Issue #1253.
 *
 * @param {object} opts
 * @param {object} opts.db        - CDS db service handle (v1 fallback)
 * @param {string} opts.fromSlug  - source tutorial slug (canonical lowercase)
 * @param {string} opts.toSlug    - target tutorial slug (canonical lowercase)
 * @returns {Promise<
 *   | { engine: 'v2', vertices: string[] }
 *   | { engine: 'v1', candidates: Array<{slug:string,pathType:string,pathTypeRank:number,hopCount:number}> }
 * >}
 */
export async function findPathV2OrV1({ db, fromSlug, toSlug }) {
  const fromIri = `${TUTORIAL_IRI_PREFIX}${fromSlug}`
  const toIri = `${TUTORIAL_IRI_PREFIX}${toSlug}`

  if (process.env.KG_PATH_V2_ENABLED === 'true') {
    try {
      const paths = await kgPathV2({ fromIri, toIri })
      if (paths.length > 0) {
        return { engine: 'v2', vertices: paths[0].vertices }
      }
      // v2 returned empty → fall through to v1 SPARQL below.
    } catch (err) {
      // Fail-open: log and fall through to v1 (mirrors the pathBetween action
      // in srv/knowledge-graph-service.js). ETIMEDOUT on disconnected pairs
      // lands here too.
      cds.log('kg').warn('findPathV2OrV1: v2 failed, falling back to v1', {
        code: err?.code,
        message: err?.message,
        fromSlug,
        toSlug,
      })
    }
  }

  const candidates = await findPath({ db, fromSlug, toSlug })
  return { engine: 'v1', candidates }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/kg-path-v2-or-v1.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/kg-path.js test/unit/kg-path-v2-or-v1.test.js
git commit -m "feat(#1253): add findPathV2OrV1 helper (KG_PATH_V2 with v1 fail-open)"
```

---

### Task 2: v2 render branch in the Joule handler

**Files:**
- Modify: `srv/lib/kg/joule-tool-find-path.js` (imports ~line 14; Step 6 fetch ~line 155–177; new v2 branch; v1 branch keeps Steps 7–14)
- Test: `test/unit/kg-path-between-handler.test.js` (add cases)

**Interfaces:**
- Consumes: `findPathV2OrV1` from `../kg-path.js` (Task 1).
- Produces: unchanged public signature `findLearningPathHandler({db,args,user,telemetry}) => Promise<string>`.

**Context for the implementer — how the handler is structured today:**
`joule-tool-find-path.js` imports `findPath` from `../kg-path.js` (line 14). Step 6 (lines ~155-177) calls `findPath(...)` into `rawCandidates`, wrapped in a try/catch that maps `SparqlTimeoutError`/`SparqlSyntaxError`/generic to friendly strings. Steps 7–14 (lines ~179-352) do: per-arm telemetry tally, empty-guard, dedup by slug, `exactTargetReached` promotion, user-coverage filter, `AVERAGETIMETOCOMPLETE` hydration, and markdown render with `PATH_TYPE_REASONS`. Constant `PATH_TYPE_REASONS` is at line 27; `SLUG_RE` at line 24.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/kg-path-between-handler.test.js`. First extend the imports/mocks at the top of the file — add a mock for the v2 client right after the existing `vi.mock('../../srv/lib/kg/concepts-for-user.js', …)` block (around line 35):

```js
vi.mock('../../srv/lib/kg-path-v2-client.js', () => ({
  kgPathV2: vi.fn(),
}))
```

And add to the import section (after line 39's `getConceptsForUser` import):

```js
const { kgPathV2 } = await import('../../srv/lib/kg-path-v2-client.js')
```

Then append this describe block at the end of the file:

```js
describe('findLearningPathHandler — KG_PATH_V2 engine (issue #1253)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConceptsForUser.mockResolvedValue({ learned: [], partial: [], truncatedAt500: false })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // db.run dispatcher for the v2 branch: TUTORIALS hydration + CONCEPTS names.
  function makeV2Db({ tutorialRows = [], conceptRows = [] } = {}) {
    return {
      run: vi.fn(async (sqlOrCqn) => {
        const sql = typeof sqlOrCqn === 'string' ? sqlOrCqn : String(sqlOrCqn)
        if (sql.includes('COM_SAP_DEVELOPERS_IMS_CONCEPTS') && sql.includes('NAME')) return conceptRows
        if (sql.includes('COM_SAP_DEVELOPERS_IMS_TUTORIALS')) return tutorialRows
        return []
      }),
    }
  }

  it('collapsed [A,B] path: 2 steps, B last, bridge lists concept names', async () => {
    vi.stubEnv('KG_PATH_V2_ENABLED', 'true')
    kgPathV2.mockResolvedValue([
      { pathRank: 1, hopCount: 2, vertices: ['tutorial:abap-create-basic-app', 'concept:abap-cloud', 'concept:rap-bo', 'tutorial:abap-create-project'] },
    ])
    const db = makeV2Db({
      tutorialRows: [
        { SLUG: 'abap-create-basic-app', TITLE: 'Basic App', AVERAGETIMETOCOMPLETE: 900 },
        { SLUG: 'abap-create-project', TITLE: 'Create Project', AVERAGETIMETOCOMPLETE: 600 },
      ],
      conceptRows: [
        { SLUG: 'abap-cloud', NAME: 'ABAP Cloud' },
        { SLUG: 'rap-bo', NAME: 'RAP Business Object' },
      ],
    })
    const out = await findLearningPathHandler({ db, args: { fromSlug: 'abap-create-basic-app', toSlug: 'abap-create-project' }, user: null, telemetry: makeTelemetry() })
    // Destination present — the exact regression from #1253.
    expect(out).toContain('abap-create-project')
    // Two numbered steps, B is #2.
    expect(out).toMatch(/1\.\s+\*\*Basic App\*\*/)
    expect(out).toMatch(/2\.\s+\*\*Create Project\*\*/)
    // Bridge line surfaces concept NAMES.
    expect(out).toMatch(/Connected via:.*ABAP Cloud/)
    expect(out).toMatch(/RAP Business Object/)
    // First step reason.
    expect(out).toMatch(/Starting point/)
  })

  it('intermediate tutorial on path renders as an ordered middle step', async () => {
    vi.stubEnv('KG_PATH_V2_ENABLED', 'true')
    kgPathV2.mockResolvedValue([
      { pathRank: 1, hopCount: 3, vertices: ['tutorial:a', 'concept:x', 'tutorial:m', 'concept:y', 'tutorial:b'] },
    ])
    const db = makeV2Db({
      tutorialRows: [
        { SLUG: 'a', TITLE: 'Tut A', AVERAGETIMETOCOMPLETE: 600 },
        { SLUG: 'm', TITLE: 'Tut M', AVERAGETIMETOCOMPLETE: 600 },
        { SLUG: 'b', TITLE: 'Tut B', AVERAGETIMETOCOMPLETE: 600 },
      ],
      conceptRows: [{ SLUG: 'x', NAME: 'X' }, { SLUG: 'y', NAME: 'Y' }],
    })
    const out = await findLearningPathHandler({ db, args: { fromSlug: 'a', toSlug: 'b' }, user: null, telemetry: makeTelemetry() })
    expect(out).toMatch(/1\.\s+\*\*Tut A\*\*/)
    expect(out).toMatch(/2\.\s+\*\*Tut M\*\*/)
    expect(out).toMatch(/3\.\s+\*\*Tut B\*\*/)
    expect(out).toMatch(/On the shortest path/)
  })

  it('direct tutorial↔tutorial path (no interior concepts) → Directly connected', async () => {
    vi.stubEnv('KG_PATH_V2_ENABLED', 'true')
    kgPathV2.mockResolvedValue([
      { pathRank: 1, hopCount: 1, vertices: ['tutorial:a', 'tutorial:b'] },
    ])
    const db = makeV2Db({
      tutorialRows: [
        { SLUG: 'a', TITLE: 'Tut A', AVERAGETIMETOCOMPLETE: 600 },
        { SLUG: 'b', TITLE: 'Tut B', AVERAGETIMETOCOMPLETE: 600 },
      ],
      conceptRows: [],
    })
    const out = await findLearningPathHandler({ db, args: { fromSlug: 'a', toSlug: 'b' }, user: null, telemetry: makeTelemetry() })
    expect(out).toContain('Directly connected')
    expect(out).toMatch(/2\.\s+\*\*Tut B\*\*/)
  })

  it('emits engine:v2 in path_returned telemetry', async () => {
    vi.stubEnv('KG_PATH_V2_ENABLED', 'true')
    kgPathV2.mockResolvedValue([
      { pathRank: 1, hopCount: 1, vertices: ['tutorial:a', 'tutorial:b'] },
    ])
    const db = makeV2Db({
      tutorialRows: [
        { SLUG: 'a', TITLE: 'A', AVERAGETIMETOCOMPLETE: 60 },
        { SLUG: 'b', TITLE: 'B', AVERAGETIMETOCOMPLETE: 60 },
      ],
    })
    const tel = makeTelemetry()
    await findLearningPathHandler({ db, args: { fromSlug: 'a', toSlug: 'b' }, user: null, telemetry: tel })
    const returned = tel.emitted.find(e => e.event === 'kg.joule.path_returned')
    expect(returned.payload.engine).toBe('v2')
  })

  it('v2 empty → falls through to v1 neighbor render (engine:v1)', async () => {
    vi.stubEnv('KG_PATH_V2_ENABLED', 'true')
    kgPathV2.mockResolvedValue([])
    kgQuery.mockResolvedValue({ response: buildJsonResponse([{ slug: 'cap-getting-started', pathType: 'SHARED_CONCEPT', rank: 3 }]) })
    // v1 branch uses makeDb() dispatcher (TASKRECORDS/TUTORIALCONCEPTLINKS/TUTORIALS).
    const db = makeDb({ tutorialRows: [{ SLUG: 'cap-getting-started', TITLE: 'CAP GS', AVERAGETIMETOCOMPLETE: 600 }] })
    const tel = makeTelemetry()
    const out = await findLearningPathHandler({ db, args: { fromSlug: 'a', toSlug: 'cap-getting-started' }, user: null, telemetry: tel })
    expect(out).toContain('cap-getting-started')
    expect(tel.emitted.find(e => e.event === 'kg.joule.path_returned').payload.engine).toBe('v1')
  })
})
```

Also add `afterEach` + `vi.unstubAllEnvs` import usage — ensure `afterEach` is imported from vitest at the top of the file (line 9 currently imports `describe, it, expect, vi, beforeEach`; add `afterEach`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit test/unit/kg-path-between-handler.test.js`
Expected: FAIL — new v2 cases fail (handler still calls `findPath`, no `engine` branch, no concept hydration). Existing tests still pass.

- [ ] **Step 3: Swap the import in the handler**

In `srv/lib/kg/joule-tool-find-path.js` line 14, change:

```js
import { findPath } from '../kg-path.js'
```

to:

```js
import { findPathV2OrV1 } from '../kg-path.js'
```

- [ ] **Step 4: Add v2 reason constants**

After the `PATH_TYPE_REASONS` constant (line ~31) in `srv/lib/kg/joule-tool-find-path.js`, add:

```js
// Max bridging-concept names to list on the destination's "Connected via" line.
const MAX_BRIDGE_CONCEPTS = 4
```

- [ ] **Step 5: Replace Step 6 fetch + add engine branch**

Replace the Step 6 block (lines ~150-200, from `const t0 = Date.now()` through the `if (rawCandidates.length === 0) { … }` empty-guard) with the following. The `t0`, the try/catch error envelopes, and the empty-guard are preserved; a v2 branch is added that returns early.

```js
  // Step 5: Record t0
  const t0 = Date.now()

  // Step 6: Fetch a path via the shared helper — prefers KG_PATH_V2 (true
  // shortest A→B path, #1253) and fails open to v1 SPARQL PATH_BETWEEN.
  let pathResult
  try {
    pathResult = await findPathV2OrV1({ db, fromSlug: effectiveFromSlug, toSlug })
  } catch (err) {
    if (err instanceof SparqlTimeoutError || err?.name === 'SparqlTimeoutError') {
      telemetry?.emit?.('kg.joule.path_returned', {
        fromSlug: effectiveFromSlug, toSlug, error: 'timeout', latencyMs: Date.now() - t0,
      })
      return "I couldn't find a learning path right now — the query timed out. Please try a more specific target."
    }
    const errKind = err?.name === 'SparqlSyntaxError' ? 'syntax' : 'error'
    telemetry?.emit?.('kg.joule.path_returned', {
      fromSlug: effectiveFromSlug, toSlug, error: errKind, latencyMs: Date.now() - t0,
    })
    return 'Internal error finding a learning path — please try a more specific question.'
  }

  // ── V2 branch: render the true shortest path (tutorial steps + concept bridge)
  if (pathResult.engine === 'v2') {
    return await renderV2Path({
      db, vertices: pathResult.vertices, effectiveFromSlug, toSlug,
      telemetry, t0, fromSlugInferred, unanchored,
    })
  }

  // ── V1 branch: today's neighbor-based behavior (unchanged below).
  const rawCandidates = pathResult.candidates
```

- [ ] **Step 6: Add the `renderV2Path` function**

Add this function ABOVE `findLearningPathHandler` (e.g. after the `MAX_BRIDGE_CONCEPTS` constant, before the `// Handler` section) in `srv/lib/kg/joule-tool-find-path.js`:

```js
/**
 * Render a KG_PATH_V2 shortest path (#1253). `vertices` is the ordered
 * sequence [tutorial:A, concept:…, …, tutorial:B]. Tutorial vertices become
 * numbered steps; interior concept vertices become the "Connected via" bridge
 * line on the destination. Guarantees the destination (toSlug) appears.
 */
async function renderV2Path({ db, vertices, effectiveFromSlug, toSlug, telemetry, t0, fromSlugInferred, unanchored }) {
  const tutorialSlugs = []
  const conceptSlugs = []
  for (const v of vertices) {
    if (typeof v !== 'string') continue
    if (v.startsWith('tutorial:')) tutorialSlugs.push(v.slice('tutorial:'.length))
    else if (v.startsWith('concept:')) conceptSlugs.push(v.slice('concept:'.length))
  }

  // Hydrate tutorial title + minutes (reuse the #1254 column). Convert
  // seconds → minutes at render time (build-catalog.js does the same /60).
  const tutMeta = new Map()
  if (tutorialSlugs.length > 0) {
    const ph = tutorialSlugs.map(() => '?').join(',')
    const rows = await db.run(
      `SELECT SLUG, TITLE, AVERAGETIMETOCOMPLETE
       FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS
       WHERE SLUG IN (${ph})`,
      tutorialSlugs
    )
    for (const r of rows || []) {
      const secs = r.AVERAGETIMETOCOMPLETE
      tutMeta.set(r.SLUG, { title: r.TITLE, minutes: secs != null ? Math.round(secs / 60) : null })
    }
  }

  // Hydrate concept names for the bridge line.
  const conceptNames = []
  if (conceptSlugs.length > 0) {
    const ph = conceptSlugs.map(() => '?').join(',')
    const rows = await db.run(
      `SELECT SLUG, NAME
       FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS
       WHERE SLUG IN (${ph})`,
      conceptSlugs
    )
    const nameBySlug = new Map((rows || []).map(r => [r.SLUG, r.NAME]))
    for (const s of conceptSlugs) conceptNames.push(nameBySlug.get(s) || s)
  }

  telemetry?.emit?.('kg.joule.path_returned', {
    fromSlug: effectiveFromSlug,
    toSlug,
    resultCount: tutorialSlugs.length,
    latencyMs: Date.now() - t0,
    fromSlugInferred,
    exactTargetReached: true,
    unanchored,
    engine: 'v2',
  })

  const bridge = conceptNames.length > 0
    ? `Connected via: ${conceptNames.slice(0, MAX_BRIDGE_CONCEPTS).join(', ')}${conceptNames.length > MAX_BRIDGE_CONCEPTS ? ', …' : ''}`
    : 'Directly connected'

  const lines = [`Here's a path from \`${effectiveFromSlug}\` to \`${toSlug}\`:\n`]
  for (let i = 0; i < tutorialSlugs.length; i++) {
    const slug = tutorialSlugs[i]
    const meta = tutMeta.get(slug) || { title: slug, minutes: null }
    const url = `https://developers.sap.com/tutorials/${slug}.html`
    let reason
    if (i === 0) reason = 'Starting point'
    else if (i === tutorialSlugs.length - 1) reason = bridge
    else reason = 'On the shortest path'
    lines.push(`${i + 1}. **${meta.title}** — [${slug}](${url})`)
    lines.push(`   ~${meta.minutes ?? '?'} min · ${reason}`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 7: Add `engine: 'v1'` to the v1 branch telemetry**

In the v1 branch (the existing Steps 7–14), add `engine: 'v1',` to each `telemetry?.emit?.('kg.joule.path_returned', { … })` payload (there are 4: the empty-candidates guard, the all-filtered guard, the hydrated-empty guard, and the final success emit). Example for the final success emit (line ~330):

```js
  telemetry?.emit?.('kg.joule.path_returned', {
    fromSlug: effectiveFromSlug,
    toSlug,
    resultCount: hydrated.length,
    pathTypeBreakdown,
    latencyMs: Date.now() - t0,
    fromSlugInferred,
    exactTargetReached,
    unanchored,
    engine: 'v1',
  })
```

Apply the same one-line addition to the other three `path_returned` emits in the v1 branch.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run --project unit test/unit/kg-path-between-handler.test.js`
Expected: PASS — all existing tests plus the 5 new v2 cases.

- [ ] **Step 9: Run the full unit path suite for regressions**

Run: `npx vitest run --project unit test/unit/kg-path-v2-or-v1.test.js test/unit/kg-path-between-handler.test.js`
Expected: PASS (all).

- [ ] **Step 10: Commit**

```bash
git add srv/lib/kg/joule-tool-find-path.js test/unit/kg-path-between-handler.test.js
git commit -m "feat(#1253): render true A→B path in findLearningPath via KG_PATH_V2"
```

---

### Task 3: Flag-gated hybrid destination-present assertion

**Files:**
- Modify: `test/hybrid/joule-find-path-handler.test.js`

**Interfaces:**
- Consumes: `findLearningPathHandler` (real, unmocked) against HANA; `KG_PATH_V2_ENABLED` env.

- [ ] **Step 1: Add the flag-gated test**

Append this `it` inside the existing `describe` block in `test/hybrid/joule-find-path-handler.test.js` (after the existing two tests, before the closing `})`):

```js
  // #1253: with KG_PATH_V2 enabled, the true shortest path MUST end at (or
  // include) the named destination — the exact regression the issue names.
  // Gated on the flag so a flag-off hybrid run no-ops cleanly (mirrors the
  // KG_PATH_V2_BODY_IMPLEMENTED gate in kg-path-v2.test.js).
  it.skipIf(process.env.KG_PATH_V2_ENABLED !== 'true')(
    'names the destination in the rendered path (issue #1253)',
    async () => {
      const out = await findLearningPathHandler({
        db,
        args: { fromSlug: FROM_SLUG, toSlug: TO_SLUG },
        user: null,
        telemetry: null,
      })
      expect(out).not.toMatch(/couldn't find a path/i)
      // The destination slug must appear in the rendered output.
      expect(out).toContain(TO_SLUG)
    },
    30_000
  )
```

- [ ] **Step 2: Verify the test parses (no HANA needed for a syntax check)**

Run: `npx vitest run --project hybrid test/hybrid/joule-find-path-handler.test.js`
Expected: If no `cds bind` / HANA available, the `beforeAll` throws or the suite errors on connect — that is acceptable at plan-write time; the new test is `skipIf`-gated on the flag. If run under `npm run test:hybrid` with `KG_PATH_V2_ENABLED=true`, the new test runs and PASSES (destination present). Document the run command in the commit body.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/joule-find-path-handler.test.js
git commit -m "test(#1253): hybrid assert findLearningPath names the destination (flag-gated)"
```

---

### Task 4: Flip the flag on for DEV + document the default

**Files:**
- Modify: `.deploy/mta.yaml` (srv `properties`, near the KG flags ~line 80-86)
- Modify: `deploy/dev.mtaext` (near `KNOWLEDGE_GRAPH_ENABLED` ~line 22)

- [ ] **Step 1: Add the default (off) to `.deploy/mta.yaml`**

In `.deploy/mta.yaml`, in the srv module's `properties` block, immediately after the `KG_STEP_SLICER_ENABLED: 'true'` line (~line 86), add:

```yaml
      # KG_PATH_V2 (issue #913): property-graph shortest-path engine backing
      # the Joule findLearningPath tool + CDS pathBetween + GET /graph/path
      # (#1253). Default OFF; DEV override 'true' in deploy/dev.mtaext.
      KG_PATH_V2_ENABLED: 'false'
```

- [ ] **Step 2: Add the DEV override to `deploy/dev.mtaext`**

In `deploy/dev.mtaext`, immediately after the `KNOWLEDGE_GRAPH_ENABLED: 'true'` line (~line 22), add:

```yaml
      # KG_PATH_V2 on for DEV (#1253): routes findLearningPath through the
      # true-shortest-path engine. Also activates it for the CDS pathBetween
      # action + GET /graph/path (both fail open to v1). Pinned here so MTA
      # redeploys preserve the flip — cf set-env does NOT survive cf deploy.
      # prod.mtaext / qa.mtaext intentionally inherit 'false'.
      KG_PATH_V2_ENABLED: 'true'
```

- [ ] **Step 3: Sanity-check YAML validity**

Run: `yq '.modules[] | select(.name=="tutorials-srv") | .properties.KG_PATH_V2_ENABLED' .deploy/mta.yaml`
Expected: `false`
Run: `yq '.modules[] | select(.name=="tutorials-srv") | .properties.KG_PATH_V2_ENABLED' deploy/dev.mtaext`
Expected: `true`
(If the module name differs, use `yq '.. | .KG_PATH_V2_ENABLED? // empty' <file>` to confirm the key resolves.)

- [ ] **Step 4: Commit**

```bash
git add .deploy/mta.yaml deploy/dev.mtaext
git commit -m "chore(#1253): enable KG_PATH_V2 for DEV (default off elsewhere)"
```

---

### Task 5: Update the joule.md docs

**Files:**
- Modify: `docs/developers/architecture/joule.md` (findLearningPath "Procedure layer" bullet ~line 552)

- [ ] **Step 1: Rewrite the procedure-layer bullet**

Replace the existing bullet at `docs/developers/architecture/joule.md:552` (the one starting "**Procedure layer** — the PATH_BETWEEN branch in `KG_QUERY.hdbprocedure` validates `:p1` and `:p2` … only references `:p1` …") with:

```markdown
- **Path engine** — when `KG_PATH_V2_ENABLED='true'` (DEV default on, #1253), the tool routes through `KG_PATH_V2` (HANA GraphScript `SHORTEST_PATH` over `KG_PG_WORKSPACE`, #913) via `srv/lib/kg-path.js::findPathV2OrV1`, which computes a **true shortest A→B path** — the named destination is guaranteed to appear as the final step, or an explicit "couldn't find a path" message is returned. The path is `tutorial:A → concept:… → tutorial:B`; interior concepts are surfaced on the destination step as "Connected via: …". When the flag is off, or v2 returns empty / errors, it fails open to the v1 SPARQL `PATH_BETWEEN` branch in `KG_QUERY.hdbprocedure` — which references only `:p1` in its 3-arm UNION body and thus returns the source's closest topical neighbors (the pre-#1253 behavior).
```

- [ ] **Step 2: Verify no other doc references contradict**

Run: `grep -n "only references" docs/developers/architecture/joule.md`
Expected: no matches (the stale "only references `:p1`" claim as *the* behavior is gone; it now appears only as the fallback description above, phrased as fallback).

- [ ] **Step 3: Commit**

```bash
git add docs/developers/architecture/joule.md
git commit -m "docs(#1253): findLearningPath now KG_PATH_V2-backed with v1 fallback"
```

---

## Self-Review Notes

- **Spec coverage:** engine adoption (Task 1), concept-bridge render (Task 2), flag flip for DEV (Task 4), hybrid destination-present acceptance test (Task 3), docs (Task 5), unit coverage (Tasks 1-2). All spec sections mapped.
- **Type consistency:** `findPathV2OrV1` return shape `{engine,vertices|candidates}` defined in Task 1, consumed identically in Task 2. `kgPathV2` result `{pathRank,hopCount,vertices}` matches `srv/lib/kg-path-v2-client.js`. Vertex prefixes `tutorial:`/`concept:` consistent across tasks and match `KG_PG_EDGES_V.hdbview`.
- **No placeholders:** every code step shows complete code.
- **Fail-open:** v2 error/empty paths covered by tests in Tasks 1 and 2.
