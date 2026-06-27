# Knowledge graph Phase 3 Track A — Concept landing pages: Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship public-facing concept landing pages at `/concepts/<slug>/` for admin-published concepts, gated behind an explicit `publishedAt`/`publishedBy` marker, indexed by site search, and reached by clickable concept links in the existing Phase 1 tutorial sidebar.

**Architecture:** A read-only CDS view `PublishedConcepts` codifies the publication gate (`publishedAt IS NOT NULL AND status = 'ACTIVE'`). A new build-time endpoint `/build/concepts` exposes publishable concept data for Hugo. Hugo generates one static page per publishable concept under `hugo/content/concepts/<slug>.md`; pages publish to HANA via the existing `/content/publish` pipeline and serve at `/content/concepts/:slug`. The existing Phase 1 sidebar island (`hugo-apps/src/related-graph/RelatedGraph.vue`) is extended to render concept items as `<a>` when published. `SearchService` is extended to surface concept results.

**Tech Stack:** SAP CAP (Node.js), CDS, HANA Cloud, Hugo, TypeScript build scripts, Vue 3 (existing island), Vitest (unit + hybrid + smoke), Fiori Elements V4 (admin Concepts list).

---

## Spec reference

**Spec:** [`docs/superpowers/specs/2026-06-27-446-knowledge-graph-phase3-design.md`](../specs/2026-06-27-446-knowledge-graph-phase3-design.md). This plan covers **Track 3-A** only (§6.1 of the spec). Track 3-B (`/explore/` viz) has its own plan file.

## Prerequisites — read these before starting

1. **CAP `before/on/after` handler patterns** — search via `mcp__plugin_cds-mcp_cds-mcp__search_docs` for "service handler before on after"; never guess CAP API signatures.
2. **The Phase 1 KG service file**: [srv/knowledge-graph-service.cds](../../../srv/knowledge-graph-service.cds) — the projection on `Concepts` and the existing admin actions live here.
3. **The Phase 1 schema**: [db/knowledge-graph.cds](../../../db/knowledge-graph.cds) — `Concepts` uses `cuid, managed`; `status` defaults to `'ACTIVE'`; there is **no** `lastEditedBy` field. The schema change in Task 1 adds `publishedAt` + `publishedBy`.
4. **The existing `/build/catalog` precedent** — [srv/lib/build-catalog.js](../../../srv/lib/build-catalog.js) and its registration in [srv/server.js:183](../../../srv/server.js#L183). All new `/build/*` endpoints follow this Express-middleware shape, **NOT** `cds.on('bootstrap')`.
5. **The existing content-publish pipeline** — [srv/lib/content-store.js](../../../srv/lib/content-store.js); `publishHandler` (lines 268–430) accepts a `files` map, decompresses base64-gzip, hashes, inserts into `ContentFiles` versioned. `serveHandler` (line 811+) reads back. Concepts will publish through the same pipeline.
6. **Test discipline (mandatory)** — every step that adds code lands its failing test first. See `@superpowers:test-driven-development` if you don't already know the rhythm.

---

## File structure — what changes

### New files

- `srv/lib/published-concepts-query.js` — pure helper that builds the `/build/concepts` payload (uses `cds.ql`, no raw SQL). Exposed for unit testing.
- `srv/lib/build-concepts.js` — Express handler `buildConceptsHandler(req, res)`, pattern-matches `srv/lib/build-catalog.js`.
- `scripts/fetch-concepts.ts` — Hugo build-time fetcher that calls `/build/concepts` and emits `hugo/content/concepts/<slug>.md`. Sibling of `scripts/fetch-tutorials.ts`.
- `hugo/layouts/concepts/single.html` — template that renders a concept page from frontmatter.
- `hugo/layouts/concepts/_markup/render-image.html` — copied from the `_default` layouts so concept-page markdown images render with the same constraints (skip if no images in concept body content; we'll see in Task 6).
- `test/unit/srv/published-concepts-query.test.js` — unit tests for the helper.
- `test/unit/srv/build-concepts.test.js` — unit test for the Express handler.
- `test/hybrid/concepts-published-view.test.js` — hybrid test for the gate semantics.
- `test/hybrid/build-concepts.test.js` — hybrid HTTP probe.
- `test/hybrid/publish-concept-action.test.js` — hybrid test of the new admin actions.
- `test/smoke/concepts-route.smoke.test.js` — smoke test of the deployed `/concepts/<slug>/` route.

### Modified files

- `db/knowledge-graph.cds` — add `publishedAt`, `publishedBy` to `Concepts`.
- `srv/knowledge-graph-service.cds` — add `PublishedConcepts` view; add `publishConcept` / `unpublishConcept` actions.
- `srv/knowledge-graph-service.js` — implement the two new actions.
- `srv/server.js` — register `/build/concepts` route.
- `app/admin-annotations.cds` — add "Published" column + Publish/Unpublish toolbar buttons to the Concepts list annotations.
- `hugo-apps/src/related-graph/RelatedGraph.vue` — render concept items as `<a>` when `published: true`.
- `hugo-apps/src/related-graph/types.ts` — extend `ConceptRef` with `published?: boolean`.
- `srv/knowledge-graph-service.js` — the `neighborhood` handler must surface `published` per concept in its response.
- `srv/search-service.js` and `srv/views.cds` — extend the search FTS source to include published concepts.
- `srv/search-service.cds` — expose published concepts in the projection.
- `scripts/fetch-tutorials.ts` — chain into `fetch-concepts.ts` so Hugo gets both fetch passes from one entry point (or document a sibling npm script).
- `package.json` — add `fetch-concepts` script.
- `approuter/xs-app.json` — add `/concepts/*` route mapping to CAP `/content/concepts/$1`.
- `docs/developers/operations/testing-endpoints.md` — append the new endpoints.

---

## Task decomposition

Three tasks, mirroring the three PRs in spec §6.1. Within each task the rhythm is: **failing test → verify fail → minimal impl → verify pass → commit**. Tests are real (no skipped tests, no `it.todo`).

---

## Task 1 — Schema + PublishedConcepts view + admin actions + `/build/concepts` endpoint

**PR title:** `feat(kg): publishedAt schema + PublishedConcepts view + /build/concepts endpoint (#446 PR 1/3)`

**Files:**
- Create: `srv/lib/published-concepts-query.js`
- Create: `srv/lib/build-concepts.js`
- Create: `test/unit/srv/published-concepts-query.test.js`
- Create: `test/unit/srv/build-concepts.test.js`
- Create: `test/hybrid/concepts-published-view.test.js`
- Create: `test/hybrid/build-concepts.test.js`
- Create: `test/hybrid/publish-concept-action.test.js`
- Modify: `db/knowledge-graph.cds:23-37` (add fields)
- Modify: `srv/knowledge-graph-service.cds` (add view + actions)
- Modify: `srv/knowledge-graph-service.js` (implement actions)
- Modify: `srv/server.js:183` (register `/build/concepts` route)

### 1.1 Schema bump

- [ ] **Step 1: Read the existing `Concepts` entity** in [db/knowledge-graph.cds:23-37](../../../db/knowledge-graph.cds#L23-L37). Confirm the field shape and the `managed` aspect.

- [ ] **Step 2: Add the two new fields**

Modify `db/knowledge-graph.cds` — inside `entity Concepts`, after `lastSeenAt` and before the `links` composition:

```cds
  /**
   * Set by the admin `publishConcept` action and cleared by `unpublishConcept`.
   * `publishedAt IS NOT NULL AND status = 'ACTIVE'` is the gate for a
   * /concepts/<slug>/ page to be generated by the Hugo build (see PR 2/3).
   */
  publishedAt     : Timestamp;
  publishedBy     : String(255);                    // upn / email; audit only
```

- [ ] **Step 3: Verify the CDS compiles**

Run: `npx cds compile srv/knowledge-graph-service.cds --to csn`
Expected: compiles without error; `Concepts` CSN includes `publishedAt` and `publishedBy`.

- [ ] **Step 4: Commit**

```bash
git add db/knowledge-graph.cds
git commit -m "feat(#446): add publishedAt/publishedBy to Concepts

Phase 3 publication gate. Set by the new publishConcept admin action."
```

### 1.2 `PublishedConcepts` view + admin actions

- [ ] **Step 5: Add the view + two actions** to `srv/knowledge-graph-service.cds`

After the existing `@readonly entity TutorialConceptLinks ...` line (around line 41), insert:

```cds
  /**
   * Publishable subset of Concepts — the projection the Hugo build script
   * (PR 2/3) reads via /build/concepts. Excludes never-published rows,
   * unpublished (publishedAt cleared by admin), VETOED, and MERGED.
   */
  @readonly
  entity PublishedConcepts as projection on ims.Concepts {
    ID, slug, name, description, publishedAt, publishedBy, status
  } where publishedAt is not null and status = 'ACTIVE';
```

Then below the existing admin actions block (after `triggerGraphRebuild` near line 123), add:

```cds
  @requires : 'KnowledgeGraph.Admin'
  action publishConcept(conceptId : UUID);

  @requires : 'KnowledgeGraph.Admin'
  action unpublishConcept(conceptId : UUID);
```

- [ ] **Step 6: Verify the CDS compiles**

Run: `npx cds compile srv/knowledge-graph-service.cds --to csn`
Expected: compiles; service CSN exposes `PublishedConcepts`, `publishConcept`, `unpublishConcept`.

- [ ] **Step 7: Write the failing hybrid test for the view + actions**

Create `test/hybrid/publish-concept-action.test.js`:

```javascript
import cds from '@sap/cds'
import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import { ensureHybridWriteAllowed } from './_guard.js'

describe('publishConcept / unpublishConcept admin actions', () => {
  let db, kg
  const TEST_PREFIX = '__TEST__phase3-publish-'
  const testIds = []

  beforeAll(async () => {
    ensureHybridWriteAllowed()
    await cds.connect.to('db')
    db = cds.db
    kg = await cds.connect.to('KnowledgeGraphService')
  })

  afterAll(async () => {
    if (testIds.length) {
      await DELETE.from('com.sap.developers.ims.Concepts').where({ ID: { in: testIds } })
    }
  })

  it('publishConcept sets publishedAt + publishedBy; unpublishConcept clears both', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims')
    const [{ ID }] = await INSERT.into(Concepts).entries({
      slug: TEST_PREFIX + 'a',
      name: 'Publish Test A',
      status: 'ACTIVE',
    })
    // NOTE: on HANA, INSERT.entries() may return `[{...}]` or `{results: [{...}]}`
    // depending on driver version. If the destructure above fails, fall back to:
    //   await SELECT.one.from(Concepts).columns('ID').where({ slug: TEST_PREFIX + 'a' })
    testIds.push(ID)

    // Initially: not published.
    let row = await SELECT.one.from(Concepts).columns('publishedAt', 'publishedBy').where({ ID })
    expect(row.publishedAt).toBeNull()
    expect(row.publishedBy).toBeNull()

    // Publish.
    await kg.send('publishConcept', { conceptId: ID })
    row = await SELECT.one.from(Concepts).columns('publishedAt', 'publishedBy').where({ ID })
    expect(row.publishedAt).toBeTruthy()
    expect(row.publishedBy).toBeTruthy()

    // Unpublish.
    await kg.send('unpublishConcept', { conceptId: ID })
    row = await SELECT.one.from(Concepts).columns('publishedAt', 'publishedBy').where({ ID })
    expect(row.publishedAt).toBeNull()
    expect(row.publishedBy).toBeNull()
  })

  it('PublishedConcepts view returns published+active only', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims')
    const fixtures = [
      { slug: TEST_PREFIX + 'never', name: 'never', status: 'ACTIVE' }, // never published
      { slug: TEST_PREFIX + 'pub',   name: 'pub',   status: 'ACTIVE' }, // will be published
      { slug: TEST_PREFIX + 'unpub', name: 'unpub', status: 'ACTIVE' }, // publish then unpublish
      { slug: TEST_PREFIX + 'veto',  name: 'veto',  status: 'VETOED' }, // published then vetoed
    ]
    const inserted = await INSERT.into(Concepts).entries(fixtures)
    const ids = inserted.results ? inserted.results.map(r => r.ID) : inserted.map(r => r.ID)
    testIds.push(...ids)

    // Publish pub, unpub, veto. Then unpublish unpub. Then veto veto.
    await kg.send('publishConcept', { conceptId: ids[1] })
    await kg.send('publishConcept', { conceptId: ids[2] })
    await kg.send('publishConcept', { conceptId: ids[3] })
    await kg.send('unpublishConcept', { conceptId: ids[2] })
    // The veto concept was published but status is already VETOED, so it
    // should NOT appear in PublishedConcepts.

    const visible = await kg.read('PublishedConcepts')
      .where({ slug: { like: TEST_PREFIX + '%' } })

    const visibleSlugs = visible.map(r => r.slug)
    expect(visibleSlugs).toEqual([TEST_PREFIX + 'pub'])
  })
})
```

- [ ] **Step 8: Run the failing test**

Run: `npm run test:hybrid -- publish-concept-action`
Expected: FAIL — `publishConcept`/`unpublishConcept` handlers don't exist yet.

> **NOTE on test runner**: this project uses three Vitest workspaces (`unit`, `hybrid`, `smoke`). The hybrid runner requires `cf login` to the DEV space and `ALLOW_HYBRID_WRITES=true` (the `_guard.js` import enforces it). If the guard call doesn't exist yet, copy the pattern from any other file under `test/hybrid/`.

- [ ] **Step 9: Implement the two actions** in `srv/knowledge-graph-service.js`

Inside the service implementation (the `cds.service.impl(async function() { ... })` body, near the other admin actions like `vetoConcept`):

```javascript
this.on('publishConcept', async (req) => {
  const { Concepts } = cds.entities('com.sap.developers.ims')
  const { conceptId } = req.data
  const user = req.user?.id ?? 'anonymous'
  const now = new Date().toISOString()
  const count = await UPDATE(Concepts)
    .set({ publishedAt: now, publishedBy: user })
    .where({ ID: conceptId })
  if (!count) return req.reject(404, `Concept ${conceptId} not found`)
})

this.on('unpublishConcept', async (req) => {
  const { Concepts } = cds.entities('com.sap.developers.ims')
  const { conceptId } = req.data
  const count = await UPDATE(Concepts)
    .set({ publishedAt: null, publishedBy: null })
    .where({ ID: conceptId })
  if (!count) return req.reject(404, `Concept ${conceptId} not found`)
})
```

Do NOT use raw SQL — the CLAUDE.md hard constraint forbids it. `UPDATE().set()...where()` is the canonical CAP pattern; use `mcp__plugin_cds-mcp_cds-mcp__search_docs` if you need to refresh on the syntax.

- [ ] **Step 10: Run the test, expect PASS**

Run: `npm run test:hybrid -- publish-concept-action`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add srv/knowledge-graph-service.cds srv/knowledge-graph-service.js test/hybrid/publish-concept-action.test.js
git commit -m "feat(#446): PublishedConcepts view + publish/unpublish admin actions

- New @readonly view PublishedConcepts filters to publishedAt IS NOT NULL
  AND status = 'ACTIVE'.
- New actions publishConcept(id) and unpublishConcept(id) under
  KnowledgeGraph.Admin scope set/clear publishedAt + publishedBy.
- Hybrid test seeds 4 concepts covering never-published, published,
  unpublish-after-publish, and veto-after-publish cases."
```

### 1.3 The `/build/concepts` payload helper (unit-tested)

- [ ] **Step 12: Write the failing unit test for the payload helper**

Create `test/unit/srv/published-concepts-query.test.js`:

```javascript
import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import cds from '@sap/cds'
import { buildConceptsPayload } from '../../../srv/lib/published-concepts-query.js'

describe('buildConceptsPayload', () => {
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
    await cds.deploy(['db', 'srv']).to(cds.db)
    const { Concepts, ConceptEdges, TutorialConceptLinks } = cds.entities('com.sap.developers.ims')
    const { Tutorials } = cds.entities('com.sap.developers.ims')

    // Two published concepts: cap-handlers, cap-services.
    // One never-published: never.
    const concepts = await INSERT.into(Concepts).entries([
      { slug: 'cap-handlers', name: 'CAP handlers', description: 'desc 1',
        status: 'ACTIVE', publishedAt: new Date().toISOString(), publishedBy: 'admin@sap.com' },
      { slug: 'cap-services', name: 'CAP services', description: 'desc 2',
        status: 'ACTIVE', publishedAt: new Date().toISOString(), publishedBy: 'admin@sap.com' },
      { slug: 'never', name: 'never', status: 'ACTIVE' },
    ])

    // Stub a tutorial that teaches cap-handlers.
    const tut = await INSERT.into(Tutorials).entries({
      slug: 't1', title: 'Tutorial One', status: 'ACTIVE'
    })
    const conceptRows = concepts.results ?? concepts
    const tutRows = tut.results ?? tut
    await INSERT.into(TutorialConceptLinks).entries({
      tutorial_ID: tutRows[0].ID, concept_ID: conceptRows[0].ID, predicate: 'teaches',
    })

    // cap-handlers requires cap-services.
    await INSERT.into(ConceptEdges).entries({
      source_ID: conceptRows[0].ID, target_ID: conceptRows[1].ID, predicate: 'requires',
      status: 'ACTIVE',
    })
  })

  afterAll(async () => {
    await cds.disconnect()
  })

  it('returns only published concepts', async () => {
    const payload = await buildConceptsPayload(cds.db)
    const slugs = payload.concepts.map(c => c.slug).sort()
    expect(slugs).toEqual(['cap-handlers', 'cap-services'])
  })

  it('populates teaches[] with tutorials teaching the concept', async () => {
    const payload = await buildConceptsPayload(cds.db)
    const ch = payload.concepts.find(c => c.slug === 'cap-handlers')
    expect(ch.teaches).toHaveLength(1)
    expect(ch.teaches[0]).toMatchObject({ slug: 't1', title: 'Tutorial One' })
  })

  it('populates requires[] from outgoing edges', async () => {
    const payload = await buildConceptsPayload(cds.db)
    const ch = payload.concepts.find(c => c.slug === 'cap-handlers')
    expect(ch.requires).toHaveLength(1)
    expect(ch.requires[0]).toMatchObject({ slug: 'cap-services', name: 'CAP services' })
  })

  it('populates requiredBy[] from incoming edges', async () => {
    const payload = await buildConceptsPayload(cds.db)
    const cs = payload.concepts.find(c => c.slug === 'cap-services')
    expect(cs.requiredBy).toHaveLength(1)
    expect(cs.requiredBy[0]).toMatchObject({ slug: 'cap-handlers', name: 'CAP handlers' })
  })

  it('includes generatedAt timestamp', async () => {
    const payload = await buildConceptsPayload(cds.db)
    expect(payload.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
```

- [ ] **Step 13: Run the failing test**

Run: `npm test -- published-concepts-query`
Expected: FAIL — `buildConceptsPayload` not defined.

- [ ] **Step 14: Implement the helper**

Create `srv/lib/published-concepts-query.js`:

```javascript
// Builds the /build/concepts payload. Pure helper — takes a CDS db service
// so the same code can run against in-memory SQLite (unit tests) or HANA
// (hybrid + production).
//
// Wire shape documented in docs/superpowers/specs/2026-06-27-446-knowledge-graph-phase3-design.md §2.4.

import cds from '@sap/cds'

const { entities } = cds

/**
 * @param {import('@sap/cds').Service} db  cds.db (or the connect-to('db') handle)
 * @returns {Promise<{ concepts: Array<{slug, name, description, teaches, requires, requiredBy, relatedTo}>, generatedAt: string }>}
 */
export async function buildConceptsPayload(db) {
  const { Concepts, ConceptEdges, TutorialConceptLinks } = entities('com.sap.developers.ims')

  // 1. Pull the publishable concepts.
  const published = await db.run(
    SELECT.from(Concepts)
      .columns('ID', 'slug', 'name', 'description')
      .where({ publishedAt: { '!=': null }, status: 'ACTIVE' })
      .orderBy('slug')
  )

  if (!published.length) return { concepts: [], generatedAt: new Date().toISOString() }

  const ids = published.map(c => c.ID)

  // 2. Tutorials that teach each published concept (predicate='teaches').
  const teachesRows = await db.run(
    SELECT.from(TutorialConceptLinks)
      .columns(
        'concept_ID',
        'tutorial.slug as tutorial_slug',
        'tutorial.title as tutorial_title'
      )
      .where({ concept_ID: { in: ids }, predicate: 'teaches' })
  )
  const teachesByConcept = groupBy(teachesRows, 'concept_ID', r => ({
    slug: r.tutorial_slug, title: r.tutorial_title
  }))

  // 3. Outgoing edges (requires + relatedTo) per concept.
  const outgoingRows = await db.run(
    SELECT.from(ConceptEdges)
      .columns(
        'source_ID', 'predicate',
        'target.slug as target_slug',
        'target.name as target_name'
      )
      .where({ source_ID: { in: ids }, status: 'ACTIVE' })
  )

  // 4. Incoming "requires" edges per concept (so the page can show "required by").
  const incomingRows = await db.run(
    SELECT.from(ConceptEdges)
      .columns(
        'target_ID', 'predicate',
        'source.slug as source_slug',
        'source.name as source_name'
      )
      .where({ target_ID: { in: ids }, status: 'ACTIVE', predicate: 'requires' })
  )

  const requiresByConcept = groupBy(
    outgoingRows.filter(r => r.predicate === 'requires'),
    'source_ID',
    r => ({ slug: r.target_slug, name: r.target_name })
  )
  const relatedToByConcept = groupBy(
    outgoingRows.filter(r => r.predicate === 'relatedTo'),
    'source_ID',
    r => ({ slug: r.target_slug, name: r.target_name })
  )
  const requiredByConcept = groupBy(
    incomingRows,
    'target_ID',
    r => ({ slug: r.source_slug, name: r.source_name })
  )

  // 5. Stitch.
  const concepts = published.map(c => ({
    slug: c.slug,
    name: c.name,
    description: c.description || '',
    teaches: teachesByConcept[c.ID] || [],
    requires: requiresByConcept[c.ID] || [],
    requiredBy: requiredByConcept[c.ID] || [],
    relatedTo: relatedToByConcept[c.ID] || [],
  }))

  return { concepts, generatedAt: new Date().toISOString() }
}

function groupBy(rows, keyCol, projectFn) {
  const out = {}
  for (const row of rows) {
    const key = row[keyCol]
    if (!out[key]) out[key] = []
    out[key].push(projectFn(row))
  }
  return out
}
```

- [ ] **Step 15: Run the test, expect PASS**

Run: `npm test -- published-concepts-query`
Expected: PASS — all five assertions green.

- [ ] **Step 16: Commit**

```bash
git add srv/lib/published-concepts-query.js test/unit/srv/published-concepts-query.test.js
git commit -m "feat(#446): buildConceptsPayload helper — Hugo-build /build/concepts data

Pure CDS QL (no raw SQL). Unit-tested against in-memory SQLite covering:
- only published concepts surface
- teaches[] populated from TutorialConceptLinks
- requires[] / requiredBy[] populated from ConceptEdges (outgoing/incoming)
- generatedAt timestamp shape"
```

### 1.4 The `/build/concepts` Express handler

- [ ] **Step 17: Write the failing unit test for the Express handler**

Create `test/unit/srv/build-concepts.test.js`:

```javascript
import { describe, it, beforeAll, expect, vi } from 'vitest'
import { buildConceptsHandler } from '../../../srv/lib/build-concepts.js'

describe('buildConceptsHandler (Express middleware)', () => {
  it('returns the payload as JSON', async () => {
    const fakeDb = {} // helper is mocked
    const fakePayload = { concepts: [], generatedAt: '2026-06-27T00:00:00.000Z' }

    vi.doMock('../../../srv/lib/published-concepts-query.js', () => ({
      buildConceptsPayload: vi.fn().mockResolvedValue(fakePayload),
    }))

    const req = {}
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }
    await buildConceptsHandler(req, res)

    expect(res.status).not.toHaveBeenCalled() // 200 default
    expect(res.json).toHaveBeenCalledWith(fakePayload)
  })

  it('returns 500 + error JSON when the helper throws', async () => {
    vi.doMock('../../../srv/lib/published-concepts-query.js', () => ({
      buildConceptsPayload: vi.fn().mockRejectedValue(new Error('boom')),
    }))

    const req = {}
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }
    await buildConceptsHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }))
  })
})
```

- [ ] **Step 18: Run the failing test**

Run: `npm test -- build-concepts`
Expected: FAIL — `buildConceptsHandler` not defined.

- [ ] **Step 19: Implement the handler**

Create `srv/lib/build-concepts.js`:

```javascript
// Express middleware backing GET /build/concepts.
// Pattern matches srv/lib/build-catalog.js. Unauthenticated by design;
// consumed by scripts/fetch-concepts.ts at Hugo build time.

import cds from '@sap/cds'
import { buildConceptsPayload } from './published-concepts-query.js'

const log = cds.log('build-concepts')

export async function buildConceptsHandler(req, res) {
  try {
    const db = await cds.connect.to('db')
    const payload = await buildConceptsPayload(db)
    res.json(payload)
  } catch (err) {
    log.error('failed to build /build/concepts payload', err)
    res.status(500).json({ error: err.message })
  }
}
```

- [ ] **Step 20: Run the test, expect PASS**

Run: `npm test -- build-concepts`
Expected: PASS.

- [ ] **Step 21: Register the route in `srv/server.js`**

Find the existing `/build/catalog` registration (around line 183) and add the sibling immediately below:

```javascript
import { buildConceptsHandler } from './lib/build-concepts.js'
// ...
app.get('/build/concepts', buildConceptsHandler)
```

(If the import block is already grouped, slot the new import into that group.)

- [ ] **Step 22: Write the failing hybrid HTTP probe**

Create `test/hybrid/build-concepts.test.js`:

```javascript
import { describe, it, beforeAll, expect } from 'vitest'

describe('/build/concepts (HTTP)', () => {
  let baseUrl
  beforeAll(() => {
    baseUrl = process.env.HYBRID_SRV_URL ?? 'http://localhost:4004'
  })

  it('returns 200 with concepts + generatedAt', async () => {
    const r = await fetch(`${baseUrl}/build/concepts`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body).toHaveProperty('concepts')
    expect(Array.isArray(body.concepts)).toBe(true)
    expect(body).toHaveProperty('generatedAt')
  })

  it('does not require auth', async () => {
    const r = await fetch(`${baseUrl}/build/concepts`, { headers: {} })
    expect(r.status).toBe(200)
  })

  it('every returned concept has the contract shape', async () => {
    const r = await fetch(`${baseUrl}/build/concepts`)
    const body = await r.json()
    for (const c of body.concepts) {
      expect(c).toHaveProperty('slug')
      expect(c).toHaveProperty('name')
      expect(c).toHaveProperty('teaches')
      expect(c).toHaveProperty('requires')
      expect(c).toHaveProperty('requiredBy')
      expect(c).toHaveProperty('relatedTo')
      expect(Array.isArray(c.teaches)).toBe(true)
    }
  })
})
```

- [ ] **Step 23: Run the failing hybrid test**

Run: `npm run test:hybrid -- build-concepts`
Expected: PASS (the route was registered in Step 21 — this confirms the wiring).

> If FAIL: re-check Step 21's import path and that the local CAP server has been restarted to pick up the new route.

- [ ] **Step 24: Commit**

```bash
git add srv/lib/build-concepts.js srv/server.js test/unit/srv/build-concepts.test.js test/hybrid/build-concepts.test.js
git commit -m "feat(#446): GET /build/concepts endpoint

Express middleware peer of /build/catalog. Unauthenticated; consumed by
scripts/fetch-concepts.ts at Hugo build time. Returns the publishable
concept payload with teaches/requires/requiredBy/relatedTo arrays."
```

### 1.5 Update the `neighborhood` handler to surface `published`

The Phase 1 sidebar island consumes `/graph/neighborhood(slug='...')`. Task 3 will flip its rendering to `<a>`, but the handler has to send the `published: boolean` field first.

- [ ] **Step 25: Read the existing `neighborhood` handler** at [srv/knowledge-graph-service.js:527-657](../../../srv/knowledge-graph-service.js#L527-L657). Note where the `teaches: [...]` array is built (around line 645).

- [ ] **Step 26: Write the failing hybrid test** for the new `published` field

Create `test/hybrid/concepts-published-view.test.js`:

```javascript
import cds from '@sap/cds'
import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import { ensureHybridWriteAllowed } from './_guard.js'

describe('neighborhood handler exposes concept.published', () => {
  let kg
  const PREFIX = '__TEST__phase3-pubview-'
  const ids = []

  beforeAll(async () => {
    ensureHybridWriteAllowed()
    kg = await cds.connect.to('KnowledgeGraphService')
    // Setup: pick any existing tutorial slug that has a teaches link to
    // a concept, then mark the linked concept published.
  })

  afterAll(async () => {
    if (ids.length) {
      await DELETE.from('com.sap.developers.ims.Concepts').where({ ID: { in: ids } })
    }
  })

  it('every concept in teaches[] has a `published` boolean', async () => {
    const sample = await SELECT.one
      .from('com.sap.developers.ims.TutorialConceptLinks')
      .columns('tutorial.slug as slug')
      .where({ predicate: 'teaches' })
    const { teaches } = await kg.send('neighborhood', { slug: sample.slug })
    expect(Array.isArray(teaches)).toBe(true)
    if (teaches.length === 0) return // empty graph — environmental
    for (const c of teaches) {
      expect(c).toHaveProperty('published')
      expect(typeof c.published).toBe('boolean')
    }
  })
})
```

- [ ] **Step 27: Run the failing test**

Run: `npm run test:hybrid -- concepts-published-view`
Expected: FAIL — `published` not on each item in `teaches`.

- [ ] **Step 28: Update the handler** — add `published: boolean` to the projected concept shape

In `srv/knowledge-graph-service.js`, find the section where the `teaches` array is built inside the `neighborhood` handler (around line 645). The current shape is `{ slug, name, description }`. Extend the SPARQL/post-processing to look up which slugs are published, then set `published` per concept.

Implementation guidance:

```javascript
// After the existing teaches projection in the neighborhood handler:
const teachesSlugs = (teaches || []).map(c => c.slug)
let publishedSet = new Set()
if (teachesSlugs.length) {
  const rows = await SELECT.from('com.sap.developers.ims.Concepts')
    .columns('slug')
    .where({ slug: { in: teachesSlugs }, publishedAt: { '!=': null }, status: 'ACTIVE' })
  publishedSet = new Set(rows.map(r => r.slug))
}
const enrichedTeaches = (teaches || []).map(c => ({ ...c, published: publishedSet.has(c.slug) }))
// Return enrichedTeaches instead of teaches in the response object.
```

If the existing function uses a different intermediate variable name, follow the local pattern — the goal is "every item in the response's `teaches[]` has `published`".

- [ ] **Step 29: Run the test, expect PASS**

Run: `npm run test:hybrid -- concepts-published-view`
Expected: PASS.

- [ ] **Step 30: Commit**

```bash
git add srv/knowledge-graph-service.js test/hybrid/concepts-published-view.test.js
git commit -m "feat(#446): neighborhood handler surfaces concept.published

Every item in the response's teaches[] now carries a boolean 'published'
field. Phase 3-A-3 will flip the sidebar island to render <a> vs <span>
based on this flag. Hybrid test guards against regression."
```

### 1.6 Task 1 close-out

- [ ] **Step 31: Run all task-1 tests one more time** to confirm green-on-rerun

Run:
```bash
npm test -- published-concepts-query build-concepts
npm run test:hybrid -- publish-concept-action build-concepts concepts-published-view
```
Expected: all PASS.

- [ ] **Step 32: Push the branch and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(kg): publishedAt schema + PublishedConcepts view + /build/concepts endpoint (#446 PR 1/3)" \
  --body "Phase 3 PR 1 of 3. See plan: docs/superpowers/plans/2026-06-27-446-kg-phase3-track-a.md.

- New publishedAt/publishedBy columns on Concepts (admin publish marker)
- New @readonly view PublishedConcepts (publishedAt IS NOT NULL AND status = 'ACTIVE')
- New publishConcept(id) / unpublishConcept(id) admin actions
- New GET /build/concepts endpoint (pattern of /build/catalog; unauthenticated)
- neighborhood handler now surfaces concept.published

Refs #446"
```

---

## Task 2 — Hugo build + concept pages publish

**PR title:** `feat(kg): concept landing pages — Hugo template + build wiring (#446 PR 2/3)`

**Files:**
- Create: `scripts/fetch-concepts.ts`
- Create: `hugo/layouts/concepts/single.html`
- Create: `test/smoke/concepts-route.smoke.test.js`
- Modify: `package.json` (add `fetch-concepts` script + chain it)
- Modify: `scripts/fetch-tutorials.ts` (or add separate orchestrator — see step 33)
- Modify: `approuter/xs-app.json` (add `/concepts/*` route)
- Modify: `srv/lib/content-store.js` (if any kind discrimination is needed for `/content/concepts/:slug` — investigate first)
- Modify: `docs/developers/operations/testing-endpoints.md` (append)

### 2.1 The fetch-concepts script

- [ ] **Step 33: Read `scripts/fetch-tutorials.ts`** for the pattern — frontmatter shape, output directory convention, gitignore handling. The new sibling follows the same shape.

- [ ] **Step 34: Write the failing assertion** — there are no concept pages in `hugo/content/concepts/` yet, and `scripts/fetch-concepts.ts` doesn't exist. Skip the formal test step for the script itself (it's a build-time CLI; smoke-tested via the deployed `/concepts/<slug>/` route in Step 41).

- [ ] **Step 35: Implement the script**

Create `scripts/fetch-concepts.ts`:

```typescript
#!/usr/bin/env tsx
// Build-time fetcher for /concepts/<slug>/ Hugo pages.
//
// Calls /build/concepts (CAP) and emits one hugo/content/concepts/<slug>.md
// per publishable concept. Idempotent: deletes the output directory first.
//
// Sibling of scripts/fetch-tutorials.ts. CAP_BASE_URL env var picks the
// target (defaults to http://localhost:4004 for local dev).

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'hugo', 'content', 'concepts')

const CAP_BASE_URL = process.env.CAP_BASE_URL || 'http://localhost:4004'

interface ConceptPayload {
  slug: string
  name: string
  description: string
  teaches: { slug: string; title: string }[]
  requires: { slug: string; name: string }[]
  requiredBy: { slug: string; name: string }[]
  relatedTo: { slug: string; name: string }[]
}

interface BuildConceptsResponse {
  concepts: ConceptPayload[]
  generatedAt: string
}

function yamlEscape(s: string): string {
  // YAML scalar safe-escape: prefer double quotes, escape internal " and \
  return `"${(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function frontmatter(c: ConceptPayload): string {
  const refs = (arr: { slug: string; title?: string; name?: string }[]) =>
    arr.length === 0
      ? '[]'
      : '\n' + arr.map(r => `  - slug: ${yamlEscape(r.slug)}\n    title: ${yamlEscape(r.title ?? r.name ?? '')}`).join('\n')

  return [
    '---',
    'type: concept',
    `slug: ${yamlEscape(c.slug)}`,
    `name: ${yamlEscape(c.name)}`,
    `description: ${yamlEscape(c.description)}`,
    `teaches:${refs(c.teaches)}`,
    `requires:${refs(c.requires)}`,
    `requiredBy:${refs(c.requiredBy)}`,
    `relatedTo:${refs(c.relatedTo)}`,
    '---',
    ''  // empty body — layout renders from frontmatter
  ].join('\n')
}

async function main() {
  console.log(`[fetch-concepts] GET ${CAP_BASE_URL}/build/concepts`)
  const r = await fetch(`${CAP_BASE_URL}/build/concepts`)
  if (!r.ok) {
    throw new Error(`/build/concepts returned ${r.status}: ${await r.text().catch(() => '')}`)
  }
  const data = (await r.json()) as BuildConceptsResponse

  await fs.rm(OUT_DIR, { recursive: true, force: true })
  await fs.mkdir(OUT_DIR, { recursive: true })

  // Probe count: how many concepts exist server-side total? Compare to
  // published.length for the "X published, Y skipped" log message.
  // Best-effort — if a totals endpoint isn't available, log only published.
  let totalsLine = `[fetch-concepts] ${data.concepts.length} published concept(s) — writing pages`
  try {
    const totals = await fetch(`${CAP_BASE_URL}/graph/Concepts/$count?$filter=status%20eq%20%27ACTIVE%27`)
    if (totals.ok) {
      const total = parseInt(await totals.text(), 10)
      const skipped = total - data.concepts.length
      totalsLine = `[fetch-concepts] ${data.concepts.length} published concept(s), ${skipped} skipped (${total} ACTIVE concepts total)`
    }
  } catch {/* fall through to the simpler line */}
  console.log(totalsLine)

  for (const c of data.concepts) {
    const filename = `${c.slug.toLowerCase()}.md`
    await fs.writeFile(path.join(OUT_DIR, filename), frontmatter(c), 'utf8')
  }

  // Drop a marker file so Hugo can render an /concepts/ index page if needed.
  await fs.writeFile(path.join(OUT_DIR, '_index.md'),
    `---\ntitle: Concepts\nlayout: concepts-index\n---\n`, 'utf8')

  console.log(`[fetch-concepts] wrote ${data.concepts.length} page(s) + _index.md to ${OUT_DIR}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

> The X-published/Y-skipped counter is part of the spec's acceptance criteria. If the `$count` probe in the try-block fails (older HANA OData semantics, network), the script still succeeds with a simpler log line — degradation is acceptable.

- [ ] **Step 36: Add the npm script** to `package.json`

Inside the `scripts` block:

```json
"fetch-concepts": "tsx scripts/fetch-concepts.ts",
```

And chain it into the existing `fetch-tutorials` flow. The cleanest place is `build:all`. Find the current `build:all` line and append `&& npm run fetch-concepts` after `fetch-tutorials`:

```json
"build:all": "npm run fetch-tutorials && npm run fetch-concepts && /* ...rest unchanged... */",
```

Use `node -e 'const p=require("./package.json"); console.log(p.scripts["build:all"])'` first to read the exact existing string before editing.

- [ ] **Step 37: Run fetch-concepts locally** (after `cds watch` is running)

Run:
```bash
# Terminal 1
cds watch
# Terminal 2
CAP_BASE_URL=http://localhost:4004 npm run fetch-concepts
```
Expected: prints `[fetch-concepts] N published concept(s) — writing pages` and creates files under `hugo/content/concepts/`.

In a fresh local DB no concepts are published. Use one of the seed scripts or invoke `publishConcept` manually via `curl`:

```bash
# Find an existing concept ID
curl -s http://localhost:4004/graph/Concepts | jq '.value[0]'
# Publish it
curl -X POST -H 'Content-Type: application/json' \
  -d '{"conceptId":"<the-id>"}' \
  http://localhost:4004/graph/publishConcept
```

- [ ] **Step 38: Commit**

```bash
git add scripts/fetch-concepts.ts package.json
git commit -m "feat(#446): scripts/fetch-concepts.ts + npm run fetch-concepts

Build-time fetcher for /concepts/<slug>/ pages. Reads /build/concepts,
writes one hugo/content/concepts/<slug>.md per publishable concept with
frontmatter-only payload (layout renders body). Chained into build:all.
Logs 'X published, Y skipped' counter (per spec acceptance criterion)."
```

### 2.2 The Hugo template

- [ ] **Step 39: Read an existing Hugo layout** for the local convention. Open `hugo/layouts/_default/single.html` and `hugo/layouts/tutorials/single.html` (if it exists) to see partial/include conventions. Stay focused on the layout structure; no edits.

- [ ] **Step 40: Implement the template**

Create `hugo/layouts/concepts/single.html`:

```go-html-template
{{ define "main" }}
{{ $name := .Params.name | default .Params.slug }}
<article class="concept-page">
  <header class="concept-page__header">
    <nav class="concept-page__breadcrumb" aria-label="breadcrumb">
      <a href="/">Home</a> &rsaquo; <a href="/concepts/">Concepts</a> &rsaquo; <span>{{ $name }}</span>
    </nav>
    <h1 class="concept-page__title">{{ $name }}</h1>
    {{ with .Params.description }}<p class="concept-page__description">{{ . }}</p>{{ end }}
  </header>

  {{ with .Params.teaches }}
  <section class="concept-page__section">
    <h2>Tutorials that teach this</h2>
    <ul>
      {{ range . }}<li><a href="/tutorials/{{ .slug }}/">{{ .title }}</a></li>{{ end }}
    </ul>
  </section>
  {{ end }}

  {{ with .Params.requires }}
  <section class="concept-page__section">
    <h2>Prerequisites</h2>
    <ul>
      {{ range . }}<li><a href="/concepts/{{ .slug }}/">{{ .name }}</a></li>{{ end }}
    </ul>
  </section>
  {{ end }}

  {{ with .Params.requiredBy }}
  <section class="concept-page__section">
    <h2>Concepts that build on this</h2>
    <ul>
      {{ range . }}<li><a href="/concepts/{{ .slug }}/">{{ .name }}</a></li>{{ end }}
    </ul>
  </section>
  {{ end }}

  {{ with .Params.relatedTo }}
  <section class="concept-page__section">
    <h2>Related concepts</h2>
    <ul>
      {{ range . }}<li><a href="/concepts/{{ .slug }}/">{{ .name }}</a></li>{{ end }}
    </ul>
  </section>
  {{ end }}
</article>
{{ end }}
```

- [ ] **Step 41: Run a local Hugo build to verify the template renders**

Run:
```bash
# Make sure fetch-concepts already ran (Step 37)
hugo --logLevel warn --baseURL http://localhost:1313/
```
Expected: succeeds; `hugo/public/concepts/<slug>/index.html` exists for every published concept.

Spot-check the output: open one of the generated HTML files and verify the four sections are present.

- [ ] **Step 42: Commit**

```bash
git add hugo/layouts/concepts/single.html
git commit -m "feat(#446): Hugo concept-page template

Renders from frontmatter: name, description, four related-entity
sections (teaches/requires/requiredBy/relatedTo). Breadcrumb to /concepts/."
```

### 2.3 Approuter route + content-store

- [ ] **Step 43: Inspect both the content-serve handler AND the publisher**

```bash
grep -n "content/concepts\|content/tutorials" srv/lib/content-store.js | head -10
grep -n "hugo/public/tutorials\|hugo/public/concepts\|tutorials/\\*" scripts/publish-content.ts | head -20
```

**Two distinct surfaces need to know about concepts:**

1. **The publisher** ([scripts/publish-content.ts](../../../scripts/publish-content.ts)) — today scans `hugo/public/tutorials/*` and uploads to `ContentFiles`. It almost certainly does NOT walk `hugo/public/concepts/`. Expect a 30-60-minute exercise extending the discovery pass + the file-key generation. The plan **owes this work** (it's not free).
2. **The serve handler** ([srv/lib/content-store.js:811+](../../../srv/lib/content-store.js#L811)) — keyed by slug; it needs to know whether to look up `concept-<slug>` or use a `kind` discriminator column.

The simplest path: prefix concept slugs with `concept-` in `ContentFiles.slug`. Both surfaces then key by the same column; no schema change, no kind discriminator. Publisher walks `hugo/public/concepts/` and emits keys with the prefix; serve handler reads `/content/concepts/:slug` → looks up `concept-<slug>`.

If that introduces collisions or trips the existing `tutorialsTableInfo` slug-lowercase helper, fall back to: add a `kind : String(20)` column to `ContentFiles` and pass `?kind=concept` in the serve path.

- [ ] **Step 44: Decision point — record the result of Step 43**

If the existing `ContentFiles` table uses `slug` as a unique key with no namespace, the simplest path is:
- Hugo emits `concept-<slug>` keys when publishing concept pages (i.e. `scripts/publish-content.ts` writes them under a namespaced key).
- The approuter route `^/concepts/(.*)$` rewrites to CAP's `/content/concepts/$1` which the content-serve handler rewrites again internally to look up the `concept-<slug>` key.

If the existing infra already supports a content "kind" field, use that instead — leave the slug unchanged and pass `kind=concept` at publish time.

**Write a brief note** in this plan's task-2 PR description summarizing the decision. The exact diff in steps 45-47 depends on what you find.

- [ ] **Step 45: Add the approuter route**

In `approuter/xs-app.json`, add a new route before the catch-all (find the `/tutorials/(.*)$` rule and add a sibling immediately above or below):

```json
{
  "source": "^/concepts/(.*)$",
  "target": "/content/concepts/$1",
  "destination": "tutorials-srv-api",
  "authenticationType": "none",
  "csrfProtection": false
}
```

The exact rewrite target depends on Step 44's decision. If `kind=concept` query string is used: `"target": "/content/serve/$1?kind=concept"`.

- [ ] **Step 46: Add the content-serve concept route in CAP**

In `srv/lib/content-store.js`, the `serveHandler` already routes on slug. If a namespace prefix is the chosen approach, add a thin wrapper or extend the existing slug normalization to recognize the `concept-` prefix and route appropriately. Keep changes localized — this file is canonical and tested.

If a separate handler is cleaner, write a `serveConceptHandler` that:
1. Lowercases the slug.
2. Looks up `concept-<slug>` (or the kind-namespaced variant) in `ContentFiles`.
3. Returns 404 if not found.
4. Decompresses and serves with the same ETag + Cache-Control headers as `serveHandler`.

Register it in `srv/server.js`:

```javascript
app.get('/content/concepts/:slug', serveConceptHandler)
```

- [ ] **Step 47: Run the local end-to-end check**

```bash
# Make sure publishConcept has been called for at least one concept (Step 37)
npm run fetch-concepts
hugo
# Inspect what the publisher discovers — if it doesn't pick up concepts, extend it.
npm run publish-content -- --dry-run | head -20
```

If the dry-run output shows only `t:<tutorial-slug>` keys and no `concept-<slug>` keys, the publisher needs the extension described in Step 43. Pattern:

1. In `scripts/publish-content.ts`, find the file-discovery walker (likely a glob over `hugo/public/tutorials/*/index.html`).
2. Add a second walker over `hugo/public/concepts/*/index.html` that emits keys with the `concept-` prefix (or sets the `kind` discriminator per Step 44's decision).
3. Verify with another `--dry-run` that both sets show up.

Spot-check `/concepts/<slug>/` resolves to the rendered HTML. The Approuter doesn't run in `cds watch` mode — manual verification with `curl http://localhost:4004/content/concepts/<slug>` is the quickest validation.

- [ ] **Step 48: Write the failing smoke test**

Create `test/smoke/concepts-route.smoke.test.js`:

```javascript
import { describe, it, expect } from 'vitest'

const BASE = process.env.SMOKE_BASE_URL
if (!BASE) throw new Error('SMOKE_BASE_URL not set')
const SRV = process.env.SMOKE_SRV_URL
if (!SRV) throw new Error('SMOKE_SRV_URL not set — must be set explicitly per CLAUDE.md smoke test convention')

describe('/concepts/<slug>/ route', () => {
  it('returns 404 for a non-existent concept slug', async () => {
    const r = await fetch(`${BASE}/concepts/__definitely-not-a-real-slug__/`)
    expect(r.status).toBe(404)
  })

  it('returns 200 for at least one published concept (canonical seed)', async () => {
    // Probe /build/concepts to find a known-published slug, then request it.
    const probe = await fetch(`${SRV}/build/concepts`)
    expect(probe.status).toBe(200)
    const { concepts } = await probe.json()
    if (concepts.length === 0) {
      // Environment has no published concepts yet — skip with a note rather than fail.
      console.warn('No published concepts in this env; concepts-route smoke skipped.')
      return
    }
    const r = await fetch(`${BASE}/concepts/${concepts[0].slug}/`)
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain(concepts[0].name)
  })
})
```

- [ ] **Step 49: Run smoke against DEV after deploy** (the PR's CI run will do this; manual run optional)

Run: `SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com npm run test:smoke -- concepts-route`
Expected: PASS (post-merge).

- [ ] **Step 50: Append the new endpoints to the testing-endpoints reference**

Open `docs/developers/operations/testing-endpoints.md`. Add rows in the appropriate table:

```markdown
| `/concepts/:slug` | public | none | Hugo-rendered concept landing page; 404 if slug not in PublishedConcepts |
| `/build/concepts` | public | none | Build-time JSON; consumed by scripts/fetch-concepts.ts |
| `/graph/publishConcept` | admin | KnowledgeGraph.Admin | Sets publishedAt + publishedBy on a Concept |
| `/graph/unpublishConcept` | admin | KnowledgeGraph.Admin | Clears publishedAt + publishedBy on a Concept |
```

- [ ] **Step 51: Commit**

```bash
git add approuter/xs-app.json srv/lib/content-store.js srv/server.js test/smoke/concepts-route.smoke.test.js docs/developers/operations/testing-endpoints.md
git commit -m "feat(#446): /concepts/<slug>/ routing + smoke test + docs

- Approuter route /concepts/* → CAP /content/concepts/$1
- Content-serve wiring for concept slugs (see PR description for namespace
  decision per plan Step 44)
- Smoke test: known-published slug returns 200; unknown returns 404
- Operations reference updated"
```

### 2.4 Task 2 close-out

- [ ] **Step 52: Push + PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(kg): concept landing pages — Hugo template + build wiring (#446 PR 2/3)" \
  --body "Phase 3 PR 2 of 3. See plan: docs/superpowers/plans/2026-06-27-446-kg-phase3-track-a.md.

- scripts/fetch-concepts.ts pulls /build/concepts → hugo/content/concepts/<slug>.md
- hugo/layouts/concepts/single.html renders four related-entity sections
- Approuter route /concepts/* → CAP /content/concepts/$1
- Smoke test for the deployed route
- Hugo build log line 'X published, Y skipped' (spec acceptance criterion)
- Operations endpoint reference updated

**Namespace decision (from plan Step 44):** [fill in here at PR time].

Refs #446"
```

---

## Task 3 — Sidebar concept links + search + admin UI

**PR title:** `feat(kg): sidebar concept links + search + admin Publish action UI (#446 PR 3/3)`

**Files:**
- Modify: `hugo-apps/src/related-graph/RelatedGraph.vue:49-61` (render `<a>` when `published`)
- Modify: `hugo-apps/src/related-graph/types.ts:8-12` (add `published?`)
- Modify: `srv/search-service.cds` (project `PublishedConcepts`)
- Modify: `srv/views.cds` (extend `SearchableItems` UNION with concepts)
- Modify: `srv/search-service.js` (if any handler-level type discrimination needed)
- Modify: `app/admin-annotations.cds` (Published column + Publish/Unpublish toolbar buttons)
- Create: `test/unit/hugo-apps/related-graph-concept-links.test.ts` (Vue component test)
- Create: `test/hybrid/search-includes-concepts.test.js`
- Create: `hugo-apps/src/shared/telemetry-concept.ts` (or extend an existing telemetry util — see Step 60)

### 3.1 Sidebar — render concept links

- [ ] **Step 53: Extend the `ConceptRef` type**

Modify `hugo-apps/src/related-graph/types.ts` lines 8-12:

```typescript
export type ConceptRef = {
  slug: string
  name: string
  description?: string | null
  published?: boolean  // Phase 3: true when /concepts/<slug>/ exists
}
```

- [ ] **Step 54: Write the failing Vue component test**

Create `test/unit/hugo-apps/related-graph-concept-links.test.ts`:

```typescript
import { mount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'
import RelatedGraph from '../../../hugo-apps/src/related-graph/RelatedGraph.vue'

describe('RelatedGraph concept rendering', () => {
  it('renders published concept as an <a href="/concepts/<slug>/">', () => {
    const wrapper = mount(RelatedGraph, {
      props: {
        tutorialSlug: 't1',
        // Bypass fetch by injecting fake neighborhood data — see component
        // implementation for the prop / provide shape. If the component
        // fetches internally, mock global.fetch instead.
      },
    })
    // Implementation note: depending on how RelatedGraph receives data,
    // either inject a `neighborhood` prop (preferred) or stub fetch.
    // Adjust the assertion to walk the rendered DOM for the concept item.
    // This is a *minimum*: a published concept must render as <a>; an
    // unpublished concept must render as a non-link (e.g. <span>).
    // ... (rest of the test depends on the component's contract)
  })

  it('renders unpublished concept as a <span>', () => {
    // Symmetric to the above.
  })
})
```

> The exact test wiring depends on whether `RelatedGraph.vue` accepts a `neighborhood` prop or fetches its own data. Read [hugo-apps/src/related-graph/RelatedGraph.vue:1-200](../../../hugo-apps/src/related-graph/RelatedGraph.vue) before writing the test. If the component fetches internally, use a fetch stub. Either way, the assertion is: an item with `published: true` is a link to `/concepts/<slug>/`; an item with `published: false` is not.

- [ ] **Step 55: Run the failing test**

Run: `npm test -- related-graph-concept-links`
Expected: FAIL.

- [ ] **Step 56: Flip rendering to `<a>` when published**

In `hugo-apps/src/related-graph/RelatedGraph.vue` near line 58 (the current `<li>{{ concept.name }}</li>`):

```vue
<li>
  <a
    v-if="concept.published"
    :href="`/concepts/${concept.slug}/`"
    class="related-graph__concept-link"
    @click="emit('kg.concept.tutorial_clicked', { conceptSlug: concept.slug, tutorialSlug })"
  >{{ concept.name }}</a>
  <span v-else class="related-graph__concept-text">{{ concept.name }}</span>
</li>
```

If the existing `emit()` helper inside the component only takes one arg, adjust the event-name parameter to match. The point is: click on a published concept link → dispatch `kg.concept.tutorial_clicked`; navigation happens via the `<a href>` natively.

- [ ] **Step 57: Run the test, expect PASS**

Run: `npm test -- related-graph-concept-links`
Expected: PASS.

- [ ] **Step 58: Commit**

```bash
git add hugo-apps/src/related-graph/types.ts hugo-apps/src/related-graph/RelatedGraph.vue test/unit/hugo-apps/related-graph-concept-links.test.ts
git commit -m "feat(#446): sidebar concept links — published concepts render as <a>

Phase 1 sidebar island now flips concept items from <span> to <a href>
when concept.published is true. ConceptRef type extended with optional
'published' field (set by the neighborhood handler from PR 1/3)."
```

### 3.2 Search — index published concepts

- [ ] **Step 59: Read the existing `views.cds` SearchableItems UNION** ([srv/views.cds:86-126](../../../srv/views.cds#L86-L126)) and `srv/search-service.cds` projection. The pattern: each row carries `slug, title, description, primaryTag, tagBag, taskType` with `taskType` being the discriminator.

- [ ] **Step 60: Write the failing hybrid test**

Create `test/hybrid/search-includes-concepts.test.js`:

```javascript
import cds from '@sap/cds'
import { describe, it, beforeAll, expect } from 'vitest'

describe('SearchableItems includes published concepts', () => {
  let search
  beforeAll(async () => {
    search = await cds.connect.to('SearchService')
  })

  it('returns published concept rows when searched by name', async () => {
    // Pick the first published concept and search for it.
    const probe = await fetch(`${process.env.HYBRID_SRV_URL || 'http://localhost:4004'}/build/concepts`)
    const { concepts } = await probe.json()
    if (concepts.length === 0) {
      console.warn('No published concepts; search test trivially passes')
      return
    }
    const c = concepts[0]
    const rows = await search.read('SearchableItems')
      .where({ title: { like: `%${c.name.split(' ')[0]}%` } })
    const matching = rows.filter(r => r.taskType === 'CONCEPT' && r.slug === c.slug)
    expect(matching.length).toBeGreaterThan(0)
  })

  it('does NOT return unpublished concepts', async () => {
    const rows = await search.read('SearchableItems').where({ taskType: 'CONCEPT' })
    // Cross-check against the Concepts table: every SearchableItems CONCEPT
    // row must have publishedAt IS NOT NULL.
    if (rows.length === 0) return
    const slugs = rows.map(r => r.slug)
    const conceptRows = await SELECT.from('com.sap.developers.ims.Concepts')
      .columns('slug', 'publishedAt', 'status')
      .where({ slug: { in: slugs } })
    for (const r of conceptRows) {
      expect(r.publishedAt).not.toBeNull()
      expect(r.status).toBe('ACTIVE')
    }
  })
})
```

- [ ] **Step 61: Run the failing test**

Run: `npm run test:hybrid -- search-includes-concepts`
Expected: FAIL — SearchableItems doesn't include `CONCEPT` rows.

- [ ] **Step 62: Extend `srv/views.cds`** with a fourth UNION branch

Find the `SearchableItems` view (around line 86) and append a fourth `UNION ALL SELECT` after the existing three:

```sql
UNION ALL
SELECT
  c.slug                                  AS slug,
  c.name                                  AS title,
  c.description                           AS description,
  ''                                      AS primaryTag,
  ''                                      AS tagBag,
  'CONCEPT'                               AS taskType
FROM com.sap.developers.ims.Concepts c
WHERE c.publishedAt IS NOT NULL AND c.status = 'ACTIVE'
```

(Adjust column types to match the existing UNION — String(80), String(120), String(500), etc.)

- [ ] **Step 63: Update `srv/search-service.cds`** if the `taskType` enum is whitelisted there. If it's a free String column, no CDS change is needed.

- [ ] **Step 64: Run the test, expect PASS**

Run: `npm run test:hybrid -- search-includes-concepts`
Expected: PASS.

- [ ] **Step 65: Commit**

```bash
git add srv/views.cds srv/search-service.cds test/hybrid/search-includes-concepts.test.js
git commit -m "feat(#446): SearchableItems indexes published concepts

Adds a fourth UNION branch (taskType='CONCEPT') filtered on the same
gate as PublishedConcepts. Unpublished/vetoed concepts are NOT in the
search index. Hybrid test asserts the negative case."
```

### 3.3 Admin UI — Published column + Publish/Unpublish toolbar buttons

- [ ] **Step 66: Read the existing admin-annotations file**

Open [app/admin-annotations.cds](../../../app/admin-annotations.cds). Find the `Concepts` (or `KnowledgeGraphService.Concepts`) annotation block.

- [ ] **Step 67: Add the Published column to the List Report**

Append to the existing `@UI.LineItem` annotation for the Concepts entity:

```cds
{
  $Type: 'UI.DataField',
  Label: 'Published',
  Value: publishedAt,
  Criticality: { $edmJson: { $If: [{ $Ne: [{ $Path: 'publishedAt' }, null] }, 3, 1] } }
}
```

(Or use `@UI.DataFieldDefault` if the existing pattern is different — keep parity with the surrounding line-item entries.)

- [ ] **Step 68: Add the Publish + Unpublish toolbar actions**

In the same file, append an action-binding stanza:

```cds
@UI.LineItem.@UI.Identification : [
  { $Type: 'UI.DataFieldForAction', Action: 'KnowledgeGraphService.publishConcept', Label: 'Publish' },
  { $Type: 'UI.DataFieldForAction', Action: 'KnowledgeGraphService.unpublishConcept', Label: 'Unpublish' },
]
```

The exact CDS shape depends on the version + the existing conventions in the file. Adapt to local pattern; the goal is two visible toolbar buttons on the Concepts List Report bound to the new actions.

- [ ] **Step 69: Smoke-test locally** — start the admin shell, navigate to `#concepts-display`, confirm:
  1. A "Published" column exists.
  2. "Publish" and "Unpublish" buttons appear in the toolbar.
  3. Selecting a row and clicking Publish refreshes the row with `publishedAt = <now>`.

This is a manual check; no automated test for the FE V4 metadata layer.

- [ ] **Step 70: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(#446): admin Concepts list — Published column + Publish/Unpublish buttons

Surfaces the publication state on the Fiori list report. Toolbar buttons
invoke the publishConcept/unpublishConcept actions from PR 1/3."
```

### 3.4 Telemetry — `kg.concept.viewed` + `kg.concept.tutorial_clicked`

- [ ] **Step 71: Read the existing Phase 1 telemetry pattern** in [hugo-apps/src/related-graph/RelatedGraph.vue:135-164](../../../hugo-apps/src/related-graph/RelatedGraph.vue#L135-L164). The pattern is `window.dispatchEvent(new CustomEvent(type, { detail }))`.

- [ ] **Step 72: Wire `kg.concept.viewed`** in the concept-page Hugo template

Modify `hugo/layouts/concepts/single.html` — add a small inline script at the bottom of the `<article>`. **Use a `data-` attribute, not Hugo's `jsonify` filter inside the script body** — Hugo's HTML minifier strips quotes around `data-` values predictably but has bitten this project on `jsonify` output in inline scripts before (see [docs/developers/reference/vue-islands-gotchas.md](../../../docs/developers/reference/vue-islands-gotchas.md)).

```html
<div data-concept-slug="{{ .Params.slug }}" id="concept-telemetry" hidden></div>
<script>
(function() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  var el = document.getElementById('concept-telemetry')
  if (!el) return
  window.dispatchEvent(new CustomEvent('kg.concept.viewed', {
    detail: { slug: el.dataset.conceptSlug }
  }))
})()
</script>
```

- [ ] **Step 73: Wire `kg.concept.tutorial_clicked`** — already added in Step 56's `@click` handler. Verify it fires by reading the existing emit pattern; the event should bubble up to the same UIEvent bridge Phase 1 wires.

- [ ] **Step 74: Run a manual smoke** — load a `/concepts/<slug>/` page locally, open DevTools, listen for the event:

```js
window.addEventListener('kg.concept.viewed', (e) => console.log('viewed', e.detail))
```

Expected: fires once on page load. Click a tutorial link in the "Tutorials that teach this" section to confirm `kg.concept.tutorial_clicked` fires.

- [ ] **Step 75: Commit**

```bash
git add hugo/layouts/concepts/single.html
git commit -m "feat(#446): telemetry for concept pages

kg.concept.viewed fires on page load; kg.concept.tutorial_clicked fires
on outbound click from a concept page to a tutorial. Reuses Phase 1's
window.dispatchEvent pattern."
```

### 3.5 Task 3 close-out

- [ ] **Step 76: Run all task-3 tests**

Run:
```bash
npm test -- related-graph-concept-links
npm run test:hybrid -- search-includes-concepts
```
Expected: all PASS.

- [ ] **Step 77: Push + PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(kg): sidebar concept links + search + admin Publish action UI (#446 PR 3/3)" \
  --body "Phase 3 PR 3 of 3. See plan: docs/superpowers/plans/2026-06-27-446-kg-phase3-track-a.md.

- Sidebar island (RelatedGraph.vue) renders concept items as <a> when published
- SearchableItems indexes published concepts (taskType='CONCEPT')
- Admin Concepts list grows a Published column + Publish/Unpublish toolbar buttons
- Telemetry: kg.concept.viewed (on page load) + kg.concept.tutorial_clicked (on outbound click)
- Tests: Vue component + hybrid search + hybrid concept-published-view

Closes Track 3-A of #446. Track 3-B (/explore/) ships next."
```

- [ ] **Step 78: After PR is merged and deployed to DEV**, run the full Track 3-A smoke suite

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com \
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
  npm run test:smoke -- concepts-route
```

Expected: PASS. (Manual: visit a published concept page, click a tutorial link, confirm the concept-page link from a tutorial sidebar works end-to-end.)

---

## Track 3-A done. What's next

After Track 3-A merges to `main` and the smoke suite is green on DEV, write the Track 3-B plan (`docs/superpowers/plans/YYYY-MM-DD-446-kg-phase3-track-b.md`) covering the 6-PR sequence:

1. `/graph/explore-data` + k-anonymity projection (3-B-1)
2. `app/explore/` Vue+Vite scaffold + Sigma.js wiring (3-B-2)
3. `/explore/` CAP-rendered shell with inline JSON (3-B-3)
4. Explore page chrome — header pickers, filters dropdown, side panel (3-B-4)
5. `/graph/path` endpoint + find-path UI overlay (3-B-5)
6. Mobile typed-list fallback + smoke + rollout note (3-B-6)

The Track 3-B plan can incorporate lessons learned from this track (e.g. did the Hugo `X published, Y skipped` counter actually surface admin gaps? does the Publish UX feel right?) before locking implementation details.

---

## Skills referenced

- `@superpowers:test-driven-development` — red/green/refactor rhythm for every step.
- `@superpowers:subagent-driven-development` (recommended execution mode) — fresh subagent per task; two-stage review.
- `@superpowers:executing-plans` (alternative execution mode) — inline batch execution with checkpoints.
- `mcp__plugin_cds-mcp_cds-mcp__search_docs` — search CAP docs before guessing CDS or Node API signatures (CLAUDE.md hard constraint).
- `mcp__plugin_cds-mcp_cds-mcp__search_model` — inspect the CDS model when reasoning about entity associations.
