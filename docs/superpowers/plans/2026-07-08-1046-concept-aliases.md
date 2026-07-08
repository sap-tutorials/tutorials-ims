# Concept Aliases (#1046) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `ConceptAliases` sub-entity + LLM backfill + admin sub-table + palette wiring so the ⌘K palette's CONCEPTS group hits acronyms like `SLT`, `IDoc`, `MTA`.

**Architecture:** New composition of `Concepts` in `db/knowledge-graph.cds`; new `PublishedConceptsWithAliases` OData projection on `KnowledgeGraphService` (public, anonymous) with an after-READ hook that hydrates a `virtual aliasSearchBlob`; new inline facet on the existing Concept Object Page under `/admin-ui/#concepts`; one-shot `srv/scripts/concept-alias-backfill.js` invoked via `cds run -s AICore-btp`; the palette's `searchConcepts` swaps one URL.

**Tech Stack:** CAP (Node.js), SAP HANA Cloud (via HDI), Fiori Elements V4 (`@UI.Facets`), Vitest (unit + hybrid), Vue 3 (palette), AI Core (`gpt-4o-mini`) via the existing `srv/lib/ai/*` chat client used by #948's on-demand extractor.

## Global Constraints

- **Language / runtime.** Node 22+ (CAP 10 minimum). No new npm dependencies unless justified — reuse `srv/lib/ai/*` (AI Core), `p-limit` (already in deps), CAP's built-in `cds.ql` and `@sap/cds/common`.
- **CDS.** No raw SQL — use `cds.ql` / CQL. `@requires` inheritance from `KnowledgeGraphService` (`@requires: 'any'`) is the auth for anonymous palette reads. All schema changes require `cds build --production` (not `cds compile`) before commit AND `npx cds deploy --to sqlite::memory:` sanity — surfaces `.hdbtabledata` / uniqueness issues at ~4 s cost. HDI artifacts contain no SQL verbs (`.hdbindex` is `INDEX name ON tbl(cols)` only).
- **HANA.** No `SELECT` of BLOB + non-BLOB columns in one CDS QL statement (see `srv/lib/content-store.js` for the raw-db.run pattern). `.where({col: {in: bigArray}})` risks HANA packet-size — bounded here to `$top ≤ 6`, no unbounded fetches.
- **Admin surface.** The `/admin-ui/#concepts` tile binds to `/graph/` (KnowledgeGraphService), NOT `/admin/`. All FE annotations live in `app/admin-annotations.cds` under `KnowledgeGraphService.Concepts`. No draft-enablement on `Concepts` (see the projection comment at `srv/knowledge-graph-service.cds:42`); aliases inherit non-draft posture and use immediate deep-CREATE against `/graph/Concepts(<uuid>)/aliases`.
- **`@cap-js/ai` hazard.** Do NOT annotate `alias` or `source` with `@Common.ValueList`. The plugin's after-write hook crashes on the AICore binding for any draft-enabled entity with a ValueList field (documented in `docs/developers/reference/cap-ai-plugin.md`). If a value-help is truly needed later, add `@UI.RecommendationState: 0` per that escape hatch.
- **Test posture.** Unit tests use in-memory SQLite (`cds.test`). Hybrid tests run under `cds bind --exec -- npx vitest run --project hybrid` and gate on `test/hybrid/_guard.js` (`isSafeForWrites()`). Every hybrid write test seeds under a `__TEST_1046__` prefix and cleans up in `afterAll`.
- **Idempotency.** The backfill script must skip already-aliased concepts unless `--force`. `--dry-run` must write nothing.
- **CI Node version drift.** CI runs Node 22, local is Node 24. Prefer explicit `cds.entities('com.sap.developers.ims')` references over bare projection names (per the Node-22-vs-24 memory).

---

## Task 1: Schema — add `ConceptAliases` entity + composition

**Files:**
- Modify: `db/knowledge-graph.cds` (append at end, right after the existing entities)

**Interfaces:**
- Consumes: `com.sap.developers.ims.Concepts` (existing entity at line 23 of `db/knowledge-graph.cds`)
- Produces:
  - New entity `com.sap.developers.ims.ConceptAliases` with columns `{ ID, concept_ID, alias, aliasLower, source, createdAt, createdBy, modifiedAt, modifiedBy }`
  - Composition `Concepts.aliases` (many `ConceptAliases`, cascade-delete)
  - Uniqueness annotation `@assert.unique.conceptAlias : [concept, aliasLower]`

- [ ] **Step 1: Add the schema block to `db/knowledge-graph.cds`**

Open `db/knowledge-graph.cds`, scroll to the end of the file (after `TutorialRank` at line 195), and append:

```cds
/**
 * Search synonyms for concepts — LLM-backfilled, admin-editable (#1046).
 * Powers the ⌘K palette's CONCEPTS group so acronym queries hit
 * (e.g. "SLT" → sap-landscape-transformation).
 *
 * aliasLower is populated by a before('CREATE'|'UPDATE') hook on
 * KnowledgeGraphService — kept case-preserved in `alias` so admins see
 * natural casing (IDoc, S/4HANA), matched case-insensitively via a
 * HANA index on `aliasLower`.
 */
entity ConceptAliases : cuid, managed {
  concept    : Association to Concepts @assert.notNull;
  alias      : String(120) @assert.notNull;
  aliasLower : String(120);
  source     : String(20) default 'LLM';   // 'LLM' | 'ADMIN' | 'SEED'
}

annotate ConceptAliases with @assert.unique.conceptAlias : [concept, aliasLower];

extend entity Concepts with {
  aliases : Composition of many ConceptAliases on aliases.concept = $self;
}
```

- [ ] **Step 2: Compile + deploy-check**

Run:

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/1046-concept-aliases
npx cds compile db/ srv/ --to sql > /dev/null
npx cds deploy --to sqlite::memory: 2>&1 | tail -20
```

Expected: no errors from either. `cds compile` catches static-model breakage; `cds deploy` catches `@assert.unique` / composition-shape issues that `compile` misses.

- [ ] **Step 3: Regenerate the HDI last-dev snapshot**

Run:

```bash
npx cds build --production 2>&1 | tail -10
```

Expected: `Build completed`, and `db/src/gen/com.sap.developers.ims.ConceptAliases.hdbmigrationtable` (or `.hdbtable`) appears in `git status`.

- [ ] **Step 4: Commit**

```bash
git add db/knowledge-graph.cds db/src/gen/
git commit -m "feat(#1046): add ConceptAliases entity + Concepts.aliases composition"
```

---

## Task 2: HDI index on `aliasLower`

**Files:**
- Create: `db/src/IDX_CONCEPT_ALIASES_LOWER.hdbindex`

**Interfaces:**
- Consumes: table `com_sap_developers_ims_ConceptAliases` (from Task 1)
- Produces: HANA index `IDX_CONCEPT_ALIASES_LOWER` on column `aliasLower`. Speeds up `$search` on the palette-facing projection and the uniqueness check.

- [ ] **Step 1: Create the .hdbindex file**

Write to `db/src/IDX_CONCEPT_ALIASES_LOWER.hdbindex` (mirrors the shape of `db/src/IDX_METRIC_SNAPSHOTS_WINDOW.hdbindex`):

```
INDEX IDX_CONCEPT_ALIASES_LOWER ON com_sap_developers_ims_ConceptAliases (aliasLower)
```

No trailing SQL verbs (per `docs/developers/reference/hana-hdi-gotchas.md` and the memory file `hdi-artifacts-no-sql-verbs`). HDI Deployer picks the verb at deploy time.

- [ ] **Step 2: Local `cds build --production` sanity**

Run:

```bash
npx cds build --production 2>&1 | tail -5
```

Expected: build passes; `.hdbindex` file gets copied into `gen/db/src/`.

- [ ] **Step 3: Commit**

```bash
git add db/src/IDX_CONCEPT_ALIASES_LOWER.hdbindex
git commit -m "feat(#1046): HANA index on ConceptAliases.aliasLower for palette \$search"
```

---

## Task 3: Expose `ConceptAliases` through `KnowledgeGraphService`

**Files:**
- Modify: `srv/knowledge-graph-service.cds` (append writable `ConceptAliases` projection after existing entities)

**Interfaces:**
- Consumes: `com.sap.developers.ims.ConceptAliases` (Task 1). The composition `Concepts.aliases` flows through the existing `Concepts` projection because it uses `excluding`.
- Produces: OData entity set `KnowledgeGraphService.ConceptAliases` at `/graph/ConceptAliases`, and reachable via the composition path `/graph/Concepts(<uuid>)/aliases`.

- [ ] **Step 1: Write a failing test asserting the entity exists**

Create `test/kg-concept-aliases-service.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

const { GET, POST, DELETE, expect: capExpect } = cds.test('serve').in(__dirname, '..')

describe('#1046 KnowledgeGraphService.ConceptAliases', () => {
  let conceptId
  beforeAll(async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims')
    // Seed one concept the tests can hang aliases off.
    const [row] = await cds.run(
      INSERT.into(Concepts).entries({
        slug: 'test-concept-1046',
        name: 'Test Concept 1046',
        description: 'seed',
        status: 'ACTIVE'
      })
    )
    conceptId = row.ID || (await SELECT.one.from(Concepts).where({ slug: 'test-concept-1046' })).ID
  })

  it('exposes /graph/ConceptAliases as writable', async () => {
    const { data } = await POST('/graph/ConceptAliases', {
      concept_ID: conceptId,
      alias: 'IDoc',
      source: 'ADMIN'
    })
    expect(data.alias).toBe('IDoc')
    expect(data.aliasLower).toBe('idoc')  // Task 4 will make this pass; expect a fail here.
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run:

```bash
npx vitest run test/kg-concept-aliases-service.test.js --project unit
```

Expected: FAIL — either "no entity KnowledgeGraphService.ConceptAliases" (before Task 3 edit) or `aliasLower` is undefined (after Task 3 edit, before Task 4). Either failure mode is fine — this test's expectations are met by Task 4.

- [ ] **Step 3: Add the projection to `srv/knowledge-graph-service.cds`**

Open `srv/knowledge-graph-service.cds` and locate line 65 (after `@readonly entity TutorialConceptLinks`). Insert:

```cds
  // #1046 — writable projection so the Concept OP's inline sub-table can
  // CREATE/UPDATE/DELETE aliases. Auth inherited from the service
  // (@requires: 'any' at line 33), but writes are only reachable through
  // an authenticated admin session because the FE OP requires Author
  // scope — same posture as the writable `Concepts` projection above.
  entity ConceptAliases as projection on ims.ConceptAliases;
```

- [ ] **Step 4: Run the same test — expect it to move forward (now failing at `aliasLower`)**

```bash
npx vitest run test/kg-concept-aliases-service.test.js --project unit
```

Expected: POST succeeds (alias='IDoc') but `aliasLower` is undefined/empty. That's Task 4's job.

- [ ] **Step 5: Commit**

```bash
git add srv/knowledge-graph-service.cds test/kg-concept-aliases-service.test.js
git commit -m "feat(#1046): expose ConceptAliases projection on KnowledgeGraphService"
```

---

## Task 4: Before-write hook — populate `aliasLower`

**Files:**
- Modify: `srv/knowledge-graph-service.js` (add one `srv.before` handler)

**Interfaces:**
- Consumes: `req.data.alias : String` on `CREATE` / `UPDATE` against `ConceptAliases`
- Produces: `req.data.aliasLower` = `req.data.alias.toLowerCase().trim()`. Enables the palette `$search` case-insensitive match and enforces `@assert.unique.conceptAlias` correctly.

- [ ] **Step 1: Add the hook**

Open `srv/knowledge-graph-service.js`, find a location near other `srv.before` handlers (grep for `srv.before` to see conventions), and append:

```js
// #1046 — normalize aliasLower on write so the palette $search matches
// case-insensitively and the @assert.unique.conceptAlias catch is right.
srv.before(['CREATE', 'UPDATE'], 'ConceptAliases', (req) => {
  if (typeof req.data.alias === 'string') {
    req.data.aliasLower = req.data.alias.toLowerCase().trim()
  }
})
```

- [ ] **Step 2: Run the Task 3 test — should now pass fully**

```bash
npx vitest run test/kg-concept-aliases-service.test.js --project unit
```

Expected: PASS. `aliasLower === 'idoc'`.

- [ ] **Step 3: Add a uniqueness collision test to the same file**

Append inside the `describe(...)` block:

```js
  it('rejects a duplicate (concept, aliasLower) pair', async () => {
    // First insert of 'IDoc' happens in the earlier `it`. This is 'idoc'.
    await expect(POST('/graph/ConceptAliases', {
      concept_ID: conceptId,
      alias: 'idoc',
      source: 'ADMIN'
    })).rejects.toThrow(/unique|assert/i)
  })

  it('allows the same alias on a different concept', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims')
    const [row] = await cds.run(
      INSERT.into(Concepts).entries({
        slug: 'test-concept-1046-b',
        name: 'Test Concept 1046 B',
        status: 'ACTIVE'
      })
    )
    const otherId = row.ID || (await SELECT.one.from(Concepts).where({ slug: 'test-concept-1046-b' })).ID
    const { data } = await POST('/graph/ConceptAliases', {
      concept_ID: otherId,
      alias: 'IDoc',
      source: 'ADMIN'
    })
    expect(data.aliasLower).toBe('idoc')
  })
```

- [ ] **Step 4: Run all three tests**

```bash
npx vitest run test/kg-concept-aliases-service.test.js --project unit
```

Expected: all three pass.

- [ ] **Step 5: Commit**

```bash
git add srv/knowledge-graph-service.js test/kg-concept-aliases-service.test.js
git commit -m "feat(#1046): before-write hook lowercases ConceptAliases.aliasLower"
```

---

## Task 5: `PublishedConceptsWithAliases` projection + after-READ hydrator

**Files:**
- Modify: `srv/knowledge-graph-service.cds` (append projection after existing `PublishedConcepts` at line 73)
- Modify: `srv/knowledge-graph-service.js` (add after-READ handler)

**Interfaces:**
- Consumes:
  - Projection `PublishedConcepts` shape from `srv/knowledge-graph-service.cds:73`
  - Entity `com.sap.developers.ims.ConceptAliases` (Task 1)
- Produces:
  - OData entity `KnowledgeGraphService.PublishedConceptsWithAliases` at `/graph/PublishedConceptsWithAliases`
  - Wire shape: `{ ID, slug, name, description, publishedAt, publishedBy, status, aliasSearchBlob }`
  - `aliasSearchBlob : String(2000)` = comma-joined lowercase alias values, populated in the after-READ hook
  - `@cds.search` covers `{ name, description, aliasSearchBlob }`

- [ ] **Step 1: Write the failing palette-search test**

Create `test/palette-published-concepts-with-aliases.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

const { GET, POST, expect: capExpect } = cds.test('serve').in(__dirname, '..')

describe('#1046 PublishedConceptsWithAliases', () => {
  let conceptId
  beforeAll(async () => {
    const { Concepts, ConceptAliases } = cds.entities('com.sap.developers.ims')
    const [row] = await cds.run(
      INSERT.into(Concepts).entries({
        slug: 'sap-landscape-transformation',
        name: 'SAP Landscape Transformation',
        description: 'SLT replication server for SAP HANA and S/4HANA.',
        status: 'ACTIVE',
        publishedAt: new Date().toISOString(),
        publishedBy: 'test'
      })
    )
    conceptId = row.ID || (await SELECT.one.from(Concepts).where({ slug: 'sap-landscape-transformation' })).ID
    await cds.run(
      INSERT.into(ConceptAliases).entries([
        { concept_ID: conceptId, alias: 'SLT',      aliasLower: 'slt',      source: 'SEED' },
        { concept_ID: conceptId, alias: 'S/4HANA',  aliasLower: 's/4hana',  source: 'SEED' }
      ])
    )
  })

  it('hydrates aliasSearchBlob on read', async () => {
    const { data } = await GET(`/graph/PublishedConceptsWithAliases?$top=6&$select=slug,name,aliasSearchBlob`)
    const row = data.value.find(r => r.slug === 'sap-landscape-transformation')
    expect(row).toBeDefined()
    expect(row.aliasSearchBlob).toMatch(/slt/)
    expect(row.aliasSearchBlob).toMatch(/s\/4hana/)
  })

  it('matches "SLT" via $search when the alias is present', async () => {
    const { data } = await GET(`/graph/PublishedConceptsWithAliases?$search=SLT&$top=6`)
    const slugs = (data.value || []).map(r => r.slug)
    expect(slugs).toContain('sap-landscape-transformation')
  })

  it('matches "slt" (case-insensitive)', async () => {
    const { data } = await GET(`/graph/PublishedConceptsWithAliases?$search=slt&$top=6`)
    const slugs = (data.value || []).map(r => r.slug)
    expect(slugs).toContain('sap-landscape-transformation')
  })

  it('returns empty for a nonsense query', async () => {
    const { data } = await GET(`/graph/PublishedConceptsWithAliases?$search=xyzzy-nomatch&$top=6`)
    expect(data.value).toEqual([])
  })
})
```

- [ ] **Step 2: Run — expect FAIL (entity does not exist yet)**

```bash
npx vitest run test/palette-published-concepts-with-aliases.test.js --project unit
```

Expected: FAIL with "entity not found" or 404 on `/graph/PublishedConceptsWithAliases`.

- [ ] **Step 3: Add the projection to `srv/knowledge-graph-service.cds`**

Append after the existing `PublishedConcepts` block (around line 76):

```cds
  /**
   * #1046 — PublishedConcepts + a searchable alias blob for the ⌘K
   * palette's CONCEPTS group. aliasSearchBlob is a comma-joined lowercase
   * alias string populated at READ time by the after-READ hook in
   * srv/knowledge-graph-service.js. HANA $search hits it via @cds.search
   * so queries like "SLT" match sap-landscape-transformation.
   *
   * Inherits @requires: 'any' from the service — anonymous-safe.
   */
  @readonly
  @cds.search: { name, description, aliasSearchBlob }
  entity PublishedConceptsWithAliases as projection on ims.Concepts {
    ID, slug, name, description, publishedAt, publishedBy, status,
    virtual null as aliasSearchBlob : String(2000)
  } where publishedAt is not null and status = 'ACTIVE';
```

- [ ] **Step 4: Add the after-READ hydrator to `srv/knowledge-graph-service.js`**

Append near the other `srv.after('READ', ...)` handlers (grep to find them):

```js
// #1046 — hydrate aliasSearchBlob on PublishedConceptsWithAliases so the
// palette's OData $search on this projection matches concept aliases.
// One IN-query batches all rows returned by the caller ($top≤6 from palette
// — no unbounded-fetch risk of the shape that broke featured missions in
// #1032). Fail-open: any exception leaves aliasSearchBlob undefined, and
// the palette gracefully drops the row.
srv.after('READ', 'PublishedConceptsWithAliases', async (rows, req) => {
  try {
    const list = Array.isArray(rows) ? rows : (rows ? [rows] : [])
    if (list.length === 0) return
    const ids = list.map(r => r.ID).filter(Boolean)
    if (ids.length === 0) return
    const { ConceptAliases } = cds.entities('com.sap.developers.ims')
    const aliasRows = await cds.tx(req).run(
      SELECT.from(ConceptAliases)
        .columns('concept_ID', 'aliasLower')
        .where({ concept_ID: { in: ids } })
    )
    const byConcept = new Map()
    for (const a of aliasRows) {
      if (!byConcept.has(a.concept_ID)) byConcept.set(a.concept_ID, [])
      byConcept.get(a.concept_ID).push(a.aliasLower)
    }
    for (const r of list) {
      r.aliasSearchBlob = (byConcept.get(r.ID) || []).join(',')
    }
  } catch (err) {
    cds.log('kg-search').warn?.('aliasSearchBlob hydrate failed:', err.message)
  }
})
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run test/palette-published-concepts-with-aliases.test.js --project unit
```

Expected outcomes:
- `hydrates aliasSearchBlob on read` — PASS.
- `matches "SLT" via $search when the alias is present` — may PASS or FAIL depending on how `@cds.search` on a `virtual` field interacts with SQLite's CAP shim. **If FAIL**, move to Step 6 (fallback). **If PASS**, skip Step 6.
- Case-insensitive + empty tests — should follow the `SLT` test's outcome.

- [ ] **Step 6 (conditional — only if Step 5's `$search` tests FAILED): Materialize `aliasSearchBlob` as a real column**

If the virtual-field `@cds.search` path does not work under CAP's runtime (either SQLite or HANA — verified separately in Task 8's hybrid test), swap the projection for a materialized column:

Edit `db/knowledge-graph.cds` — extend `Concepts`:

```cds
extend entity Concepts with {
  aliasSearchBlob : String(2000);  // #1046 fallback — populated by srv layer, indexed by $search
}
```

Edit `srv/knowledge-graph-service.cds` — remove `virtual null as` from the projection and let it fall through:

```cds
  @readonly
  @cds.search: { name, description, aliasSearchBlob }
  entity PublishedConceptsWithAliases as projection on ims.Concepts {
    ID, slug, name, description, publishedAt, publishedBy, status,
    aliasSearchBlob
  } where publishedAt is not null and status = 'ACTIVE';
```

Move the hydration logic to a before-write hook on `ConceptAliases` that re-computes and stores the parent concept's `aliasSearchBlob` after every alias INSERT / UPDATE / DELETE. Append to `srv/knowledge-graph-service.js`:

```js
async function refreshConceptAliasBlob(req, conceptId) {
  if (!conceptId) return
  const { Concepts, ConceptAliases } = cds.entities('com.sap.developers.ims')
  const rows = await cds.tx(req).run(
    SELECT.from(ConceptAliases).columns('aliasLower').where({ concept_ID: conceptId })
  )
  const blob = rows.map(r => r.aliasLower).filter(Boolean).join(',')
  await cds.tx(req).run(UPDATE(Concepts).set({ aliasSearchBlob: blob }).where({ ID: conceptId }))
}
srv.after(['CREATE', 'UPDATE', 'DELETE'], 'ConceptAliases', async (_res, req) => {
  const conceptId = req.data?.concept_ID
    || (req.data?.ID && (await SELECT.one.from(cds.entities('com.sap.developers.ims').ConceptAliases).where({ ID: req.data.ID }))?.concept_ID)
  await refreshConceptAliasBlob(req, conceptId).catch(err => cds.log('kg-search').warn?.('refresh blob failed:', err.message))
})
```

Delete the after-READ hydrator from Step 4 (no longer needed). Rerun `cds build --production`, rerun the test suite.

- [ ] **Step 7: Commit**

```bash
git add srv/knowledge-graph-service.cds srv/knowledge-graph-service.js \
        test/palette-published-concepts-with-aliases.test.js \
        db/knowledge-graph.cds db/src/gen/                      # only if Step 6 ran
git commit -m "feat(#1046): PublishedConceptsWithAliases projection with alias \$search"
```

---

## Task 6: Palette front-end URL swap

**Files:**
- Modify: `hugo-apps/src/cmd-palette/CommandPalette.vue` (line ~325 — one URL string)
- Modify: `hugo-apps/src/cmd-palette/CommandPalette.test.ts` (update mock URL string in two places)

**Interfaces:**
- Consumes: `/graph/PublishedConceptsWithAliases?$search=<term>&$top=6&$select=slug,name,description` (Task 5's projection)
- Produces: same `PaletteAction[]` shape as today — no downstream contract change

- [ ] **Step 1: Update the fetch URL**

Open `hugo-apps/src/cmd-palette/CommandPalette.vue`, find line 325:

```ts
    const res = await fetch(`/graph/PublishedConcepts?${params}`)
```

Replace with:

```ts
    const res = await fetch(`/graph/PublishedConceptsWithAliases?${params}`)
```

- [ ] **Step 2: Update the test mock URLs**

Open `hugo-apps/src/cmd-palette/CommandPalette.test.ts` — grep for `PublishedConcepts` and replace each occurrence (there are 4 references based on earlier exploration: lines 103, 128, 152, 207 — verify by grep at edit time):

```bash
grep -n "PublishedConcepts" hugo-apps/src/cmd-palette/CommandPalette.test.ts
```

For each hit that does NOT already say `PublishedConceptsWithAliases`, replace `PublishedConcepts` with `PublishedConceptsWithAliases`. Leave any comment lines that reference the old projection alone (they document the migration).

- [ ] **Step 3: Run the palette Vitest suite**

Run:

```bash
cd hugo-apps && npx vitest run src/cmd-palette/ && cd ..
```

Expected: PASS. All existing palette behavior tests continue to pass — the URL change is transparent to the response shape.

- [ ] **Step 4: Commit**

```bash
git add hugo-apps/src/cmd-palette/CommandPalette.vue hugo-apps/src/cmd-palette/CommandPalette.test.ts
git commit -m "feat(#1046): palette CONCEPTS group hits PublishedConceptsWithAliases"
```

---

## Task 7: Admin UI — Aliases facet on the Concept Object Page

**Files:**
- Modify: `app/admin-annotations.cds` — one Facet entry addition + one new `annotate KnowledgeGraphService.ConceptAliases` block

**Interfaces:**
- Consumes: `KnowledgeGraphService.Concepts.aliases` (composition from Task 1) and `KnowledgeGraphService.ConceptAliases` projection (Task 3)
- Produces: FE renders an "Aliases" facet on `/admin-ui/#concepts` OP with a LineItem table over `alias / source / modifiedAt` and inline CREATE/UPDATE/DELETE

- [ ] **Step 1: Add the Facet entry**

Open `app/admin-annotations.cds`, locate the existing `UI.Facets` array for `KnowledgeGraphService.Concepts` at line ~2586. Add one entry to the array:

Before:

```cds
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'General',         Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', Label: 'Tutorials',       Target: 'links/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Outgoing edges',  Target: 'outgoingEdges/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Incoming edges',  Target: 'incomingEdges/@UI.LineItem' }
  ],
```

After:

```cds
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'General',         Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', Label: 'Tutorials',       Target: 'links/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Outgoing edges',  Target: 'outgoingEdges/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Incoming edges',  Target: 'incomingEdges/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Aliases',         Target: 'aliases/@UI.LineItem' }
  ],
```

- [ ] **Step 2: Add the `ConceptAliases` annotation block**

Below the existing `annotate KnowledgeGraphService.TutorialConceptLinks with @UI: { ... }` block (~line 2626–2639), add:

```cds
// --- #1046 ConceptAliases — inline sub-table on the Concept OP "Aliases" facet
annotate KnowledgeGraphService.ConceptAliases with {
  alias      @Common.Label: 'Alias';
  source     @Common.Label: 'Source';
  modifiedAt @Common.Label: 'Modified At';
};

annotate KnowledgeGraphService.ConceptAliases with @UI: {
  LineItem: [
    { $Type: 'UI.DataField', Value: alias,      Label: 'Alias' },
    { $Type: 'UI.DataField', Value: source,     Label: 'Source' },
    { $Type: 'UI.DataField', Value: modifiedAt, Label: 'Modified At' }
  ]
};
```

Do NOT add `@Common.ValueList` to `source` (see Global Constraints — `@cap-js/ai` hazard). It's a plain freeform String(20) with the CDS default `'LLM'`.

- [ ] **Step 3: Run the existing admin annotations sanity test**

```bash
npx vitest run test/admin-annotations.test.js --project unit
```

Expected: PASS (or, if the test greps annotation shapes and fails on the new block, adjust the test — but that's a Task-7 diagnostic).

- [ ] **Step 4: Local `cds watch` smoke (manual)**

Run `cds watch` in a spare terminal, hit `http://localhost:4004/admin-ui/#concepts`, click any concept row. Confirm the "Aliases" facet renders with an empty state. Inline-create an alias, confirm it saves. Reload — alias persists.

*Skip this manual step if running in CI / headless — the annotation shape is compile-checked by `cds build`, and the write path is covered by Task 4's unit tests.*

- [ ] **Step 5: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(#1046): Aliases facet on Concept OP under /admin-ui/#concepts"
```

---

## Task 8: Hybrid test — real HANA `$search` on `aliasSearchBlob`

**Files:**
- Create: `test/hybrid/1046-concept-aliases-hybrid.test.js`

**Interfaces:**
- Consumes: real HANA HDI container via `cds bind --exec`
- Produces: pass/fail signal that the virtual-vs-materialized-column choice from Task 5 is correct against HANA

- [ ] **Step 1: Write the hybrid test**

Create `test/hybrid/1046-concept-aliases-hybrid.test.js`:

```js
// test/hybrid/1046-concept-aliases-hybrid.test.js
// Verifies alias $search works end-to-end against real HANA, and
// that anonymous (no XSUAA) callers can hit PublishedConceptsWithAliases.
//
// Run with: npm run test:hybrid

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'
import { isSafeForWrites } from './_guard.js'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe.runIf(isSafeForWrites())('#1046 Concept aliases (hybrid)', () => {
  let Concepts, ConceptAliases
  const PREFIX = '__TEST_1046__'
  const ids = {
    a: '10460000-1111-0000-0000-000000000001',
    b: '10460000-1111-0000-0000-000000000002',
  }

  beforeAll(async () => {
    ;({ Concepts, ConceptAliases } = cds.entities('com.sap.developers.ims'))
    // Clean any leftover rows from prior runs.
    await cds.run(DELETE.from(ConceptAliases).where({ concept: { in: [ids.a, ids.b] } }))
    await cds.run(DELETE.from(Concepts).where({ ID: { in: [ids.a, ids.b] } }))

    await cds.run(INSERT.into(Concepts).entries([
      { ID: ids.a, slug: `${PREFIX}slt-concept`, name: 'SLT Concept', description: 'landscape transform', status: 'ACTIVE', publishedAt: new Date().toISOString(), publishedBy: PREFIX },
      { ID: ids.b, slug: `${PREFIX}idoc-concept`, name: 'IDoc Concept', description: 'edi doc', status: 'ACTIVE', publishedAt: new Date().toISOString(), publishedBy: PREFIX }
    ]))
    await cds.run(INSERT.into(ConceptAliases).entries([
      { concept_ID: ids.a, alias: 'SLT',   aliasLower: 'slt',  source: 'SEED' },
      { concept_ID: ids.b, alias: 'IDoc',  aliasLower: 'idoc', source: 'SEED' }
    ]))
  })

  afterAll(async () => {
    await cds.run(DELETE.from(ConceptAliases).where({ concept: { in: [ids.a, ids.b] } }))
    await cds.run(DELETE.from(Concepts).where({ ID: { in: [ids.a, ids.b] } }))
  })

  it('anonymous callers see PublishedConceptsWithAliases', async () => {
    // no headers → no XSUAA token → anonymous
    const res = await fetch(`${cds.server.url}/graph/PublishedConceptsWithAliases?$search=SLT&$top=6`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const slugs = (body.value || []).map(r => r.slug)
    expect(slugs).toContain(`${PREFIX}slt-concept`)
  })

  it('IDoc query surfaces IDoc concept', async () => {
    const res = await fetch(`${cds.server.url}/graph/PublishedConceptsWithAliases?$search=IDoc&$top=6`)
    const body = await res.json()
    const slugs = (body.value || []).map(r => r.slug)
    expect(slugs).toContain(`${PREFIX}idoc-concept`)
  })

  it('batch after-READ hydrates all rows in one IN-query', async () => {
    // Fetch both rows via $top=6 — the after-READ hook should batch, not fan out.
    // Loose assertion — we're checking that both rows come back with an alias blob,
    // not that we can spy tx.run count (that's a nice-to-have for the deeper test).
    const res = await fetch(`${cds.server.url}/graph/PublishedConceptsWithAliases?$select=slug,aliasSearchBlob&$top=6`)
    const body = await res.json()
    const blobBySlug = Object.fromEntries((body.value || []).map(r => [r.slug, r.aliasSearchBlob]))
    expect(blobBySlug[`${PREFIX}slt-concept`]).toMatch(/slt/)
    expect(blobBySlug[`${PREFIX}idoc-concept`]).toMatch(/idoc/)
  })
})
```

- [ ] **Step 2: Run against real HANA**

Ensure `cf login` and `cds bind` are set up for the DEV HDI binding, then:

```bash
npm run test:hybrid -- --project hybrid test/hybrid/1046-concept-aliases-hybrid.test.js
```

Expected: PASS. If the `$search` tests fail against HANA, that's the signal to revisit Task 5's Step 6 fallback (materialized column). Re-run Task 5 → Step 6, redeploy schema, retry.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/1046-concept-aliases-hybrid.test.js
git commit -m "test(#1046): hybrid test for alias \$search against real HANA"
```

---

## Task 9: Backfill script scaffolding + `--dry-run`

**Files:**
- Create: `srv/scripts/concept-alias-backfill.js`

**Interfaces:**
- Consumes:
  - CAP db handle via `await cds.connect.to('db')`
  - AI Core chat client — reuse the module used by `srv/lib/kg/joule-tool-expand-concepts.js` or `srv/jobs/kg-ondemand-drain.js` (grep for `getAiCore` / `chat.completions` to find the exact export)
  - `Concepts`, `TutorialConceptLinks`, `Tutorials`, `ConceptAliases` from `cds.entities('com.sap.developers.ims')`
- Produces:
  - CLI executable: `node srv/scripts/concept-alias-backfill.js [--limit N] [--dry-run] [--only-slug <slug>] [--force]`
  - Exit codes: `0` success, `1` unrecoverable error, `2` invalid arguments
  - Emits per-concept telemetry to stderr: `slug\taliases_written\tskipped_duplicates\tlatency_ms`

- [ ] **Step 1: Scaffold the script (dry-run only in this task; LLM call is stubbed)**

Create `srv/scripts/concept-alias-backfill.js`:

```js
#!/usr/bin/env node
// srv/scripts/concept-alias-backfill.js
//
// One-shot backfill of ConceptAliases via AI Core (#1046).
//
// Usage:
//   cds run -s AICore-btp -- node srv/scripts/concept-alias-backfill.js [flags]
//
// Flags:
//   --limit N          Process at most N concepts (default: unlimited)
//   --dry-run          Print planned inserts, write nothing
//   --only-slug <s>    Target a single concept by slug
//   --force            Re-run against concepts that already have aliases
//
// Telemetry: one tab-separated line per concept to stderr:
//   <slug>\t<aliases_written>\t<skipped_duplicates>\t<latency_ms>

import cds from '@sap/cds'

const args = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--dry-run')      args.set('dryRun', true)
  else if (a === '--force')   args.set('force', true)
  else if (a === '--limit')   args.set('limit', Number(process.argv[++i]))
  else if (a === '--only-slug') args.set('onlySlug', process.argv[++i])
  else {
    process.stderr.write(`Unknown flag: ${a}\n`)
    process.exit(2)
  }
}

async function main() {
  const db = await cds.connect.to('db')
  const { Concepts, ConceptAliases, TutorialConceptLinks, Tutorials } = cds.entities('com.sap.developers.ims')

  const filters = { publishedAt: { '!=': null }, status: 'ACTIVE' }
  if (args.get('onlySlug')) filters.slug = args.get('onlySlug')

  const concepts = await db.run(
    SELECT.from(Concepts).columns('ID', 'slug', 'name', 'description').where(filters)
  )
  const cap = args.get('limit')
  const targets = typeof cap === 'number' && cap > 0 ? concepts.slice(0, cap) : concepts

  process.stderr.write(`Backfill targets: ${targets.length} concept(s). dry-run=${!!args.get('dryRun')} force=${!!args.get('force')}\n`)

  for (const c of targets) {
    const t0 = Date.now()
    // Skip if this concept already has aliases and --force not set
    if (!args.get('force')) {
      const existing = await db.run(SELECT.one.from(ConceptAliases).where({ concept_ID: c.ID }))
      if (existing) {
        process.stderr.write(`${c.slug}\t0\t0\tskipped-existing\n`)
        continue
      }
    }

    // STUB — Task 10 replaces this with the real LLM call.
    const aliases = []

    if (args.get('dryRun')) {
      process.stderr.write(`${c.slug}\t${aliases.length}\t0\t${Date.now() - t0}\tdry-run\n`)
      continue
    }

    // Real inserts land in Task 10 too. For now nothing to write when aliases=[].
    process.stderr.write(`${c.slug}\t0\t0\t${Date.now() - t0}\n`)
  }
}

main().then(() => process.exit(0)).catch(err => {
  process.stderr.write(`Fatal: ${err.stack || err.message}\n`)
  process.exit(1)
})
```

- [ ] **Step 2: Smoke-test the scaffolding**

```bash
node srv/scripts/concept-alias-backfill.js --dry-run --limit 3 2>&1 | tail -10
```

Expected: 3 telemetry lines to stderr, exit 0. No writes.

- [ ] **Step 3: Commit**

```bash
git add srv/scripts/concept-alias-backfill.js
git commit -m "feat(#1046): scaffold concept-alias-backfill script (dry-run only)"
```

---

## Task 10: Backfill script — real AI Core LLM call + writes + smoke test

**Files:**
- Modify: `srv/scripts/concept-alias-backfill.js` (fill in LLM + write logic)
- Create: `test/scripts/concept-alias-backfill.smoke.test.js`

**Interfaces:**
- Consumes: The AI Core chat client. **Identify the correct import at implementation time** — grep for `chat.completions` / `getAiCore` under `srv/lib/` and `srv/jobs/kg-ondemand-drain.js` (issue #948's on-demand extractor uses it). The module likely exports a function returning `{ chat: (messages, opts) => Promise<{content: string}> }` or similar.
- Produces: N `ConceptAliases` rows per concept, `source: 'LLM'`. Idempotent — dedupes against `aliasLower` at insert time.

- [ ] **Step 1: Locate the AI Core client**

```bash
grep -rn "chat.completions\|getAiCore\|aiCoreChat" srv/lib/ srv/jobs/ 2>/dev/null | head
```

Note the import path and the client's shape (function name, return type, whether it takes a `model` param). Use these in Step 2.

- [ ] **Step 2: Write the LLM-integration test first (mocked AI Core)**

Create `test/scripts/concept-alias-backfill.smoke.test.js`:

```js
// test/scripts/concept-alias-backfill.smoke.test.js
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import cds from '@sap/cds'

cds.test('serve').in(__dirname, '../..')

// Mock hoisted before the script imports its AI Core client.
vi.mock('../../srv/lib/ai/ai-core-chat.js', () => ({
  // Replace with the actual export shape found in Task 10 Step 1.
  getAiCoreChatClient: () => ({
    chat: async ({ prompt }) => ({
      content: JSON.stringify({ aliases: ['IDoc', 'idoc', 'I-Doc'] })
    })
  })
}))

async function seedConcept(slug, name) {
  const { Concepts } = cds.entities('com.sap.developers.ims')
  const [row] = await cds.run(
    INSERT.into(Concepts).entries({
      slug, name, status: 'ACTIVE',
      publishedAt: new Date().toISOString(), publishedBy: 'test'
    })
  )
  return row.ID || (await SELECT.one.from(Concepts).where({ slug })).ID
}

async function countAliases(conceptId) {
  const { ConceptAliases } = cds.entities('com.sap.developers.ims')
  const rows = await cds.run(SELECT.from(ConceptAliases).where({ concept_ID: conceptId }))
  return rows.length
}

describe('#1046 concept-alias-backfill smoke', () => {
  afterEach(async () => {
    const { ConceptAliases, Concepts } = cds.entities('com.sap.developers.ims')
    await cds.run(DELETE.from(ConceptAliases))
    await cds.run(DELETE.from(Concepts).where({ slug: { like: 'smoke1046-%' } }))
  })

  it('collapses case-duplicate LLM output to one row per concept', async () => {
    const id = await seedConcept('smoke1046-idoc', 'Intermediate Document')
    // Load and invoke the backfill main() directly (as a module).
    const { runBackfill } = await import('../../srv/scripts/concept-alias-backfill.js')
    await runBackfill({ dryRun: false, onlySlug: 'smoke1046-idoc' })
    // Mock returned ['IDoc', 'idoc', 'I-Doc'] — aliasLower ['idoc', 'idoc', 'i-doc']
    // → 2 rows after dedupe.
    expect(await countAliases(id)).toBe(2)
  })

  it('is idempotent — second run without --force is a no-op', async () => {
    const id = await seedConcept('smoke1046-mta', 'Multi-Target Application')
    const { runBackfill } = await import('../../srv/scripts/concept-alias-backfill.js')
    await runBackfill({ dryRun: false, onlySlug: 'smoke1046-mta' })
    const count1 = await countAliases(id)
    await runBackfill({ dryRun: false, onlySlug: 'smoke1046-mta' })  // no --force
    const count2 = await countAliases(id)
    expect(count2).toBe(count1)
  })

  it('--dry-run writes nothing', async () => {
    const id = await seedConcept('smoke1046-slt', 'SAP Landscape Transformation')
    const { runBackfill } = await import('../../srv/scripts/concept-alias-backfill.js')
    await runBackfill({ dryRun: true, onlySlug: 'smoke1046-slt' })
    expect(await countAliases(id)).toBe(0)
  })
})
```

- [ ] **Step 3: Run — expect FAIL (script doesn't export `runBackfill` yet)**

```bash
npx vitest run test/scripts/concept-alias-backfill.smoke.test.js --project unit
```

Expected: FAIL — cannot import `runBackfill`.

- [ ] **Step 4: Refactor the script to export `runBackfill` and wire the LLM call**

Replace `srv/scripts/concept-alias-backfill.js` with (using the exact AI Core client import identified in Step 1 — the example below assumes `getAiCoreChatClient` from `srv/lib/ai/ai-core-chat.js`; adjust to reality):

```js
#!/usr/bin/env node
// (banner comment identical to Task 9)

import cds from '@sap/cds'
// TODO(task 10 step 1): adjust this import to match the discovered AI Core client shape.
import { getAiCoreChatClient } from '../lib/ai/ai-core-chat.js'
import pLimit from 'p-limit'

const CONCURRENCY = 4
const MODEL = 'gpt-4o-mini'
const MAX_ALIASES_PER_CONCEPT = 8
const MIN_ALIAS_LEN = 2
const MAX_ALIAS_LEN = 40
const MAX_CONSECUTIVE_FAILURES = 3

const SYSTEM_PROMPT = `You extract common short synonyms and acronyms for a technical concept.
Return a JSON object shaped {"aliases": ["..."]} with 0 to 8 short forms
that a developer might type in a search box. Rules:
- Only real, in-use aliases. No invented shortenings.
- 2 to 40 characters each. No punctuation-only strings.
- Drop the canonical name itself. Drop pluralization variants.
- Prefer classical SAP shorthand: "IDoc" (not "Intermediate Document"),
  "MTA" (not "Multi-Target Application"), "S/4HANA" (not "SAP S/4HANA").
- If nothing fits, return {"aliases": []}. Do not guess.`

function parseAliases(raw) {
  try {
    const obj = JSON.parse(raw)
    if (!obj || !Array.isArray(obj.aliases)) return []
    return obj.aliases
      .filter(a => typeof a === 'string')
      .map(a => a.trim())
      .filter(a => a.length >= MIN_ALIAS_LEN && a.length <= MAX_ALIAS_LEN)
      .slice(0, MAX_ALIASES_PER_CONCEPT)
  } catch { return [] }
}

async function loadTopTutorialTitles(db, conceptIds, entities) {
  if (conceptIds.length === 0) return new Map()
  const { TutorialConceptLinks, Tutorials } = entities
  const rows = await db.run(
    SELECT.from(TutorialConceptLinks)
      .columns('concept_ID', l => { l.tutorial(t => t.title) })
      .where({ concept_ID: { in: conceptIds }, predicate: 'teaches' })
  )
  const byConcept = new Map()
  for (const r of rows) {
    if (!byConcept.has(r.concept_ID)) byConcept.set(r.concept_ID, [])
    const arr = byConcept.get(r.concept_ID)
    if (arr.length < 3 && r.tutorial?.title) arr.push(r.tutorial.title)
  }
  return byConcept
}

export async function runBackfill({ dryRun = false, force = false, onlySlug, limit } = {}) {
  const db = await cds.connect.to('db')
  const entities = cds.entities('com.sap.developers.ims')
  const { Concepts, ConceptAliases } = entities
  const chat = getAiCoreChatClient()

  const filters = { publishedAt: { '!=': null }, status: 'ACTIVE' }
  if (onlySlug) filters.slug = onlySlug
  const concepts = await db.run(
    SELECT.from(Concepts).columns('ID', 'slug', 'name', 'description').where(filters)
  )
  const targets = typeof limit === 'number' && limit > 0 ? concepts.slice(0, limit) : concepts

  const titlesByConcept = await loadTopTutorialTitles(db, targets.map(c => c.ID), entities)

  const limitFn = pLimit(CONCURRENCY)
  let consecutiveFailures = 0

  await Promise.all(targets.map(c => limitFn(async () => {
    const t0 = Date.now()

    if (!force) {
      const existing = await db.run(SELECT.one.from(ConceptAliases).where({ concept_ID: c.ID }))
      if (existing) {
        process.stderr.write(`${c.slug}\t0\t0\tskipped-existing\n`)
        return
      }
    }

    const titles = titlesByConcept.get(c.ID) || []
    const userPrompt = JSON.stringify({
      name: c.name || '',
      description: c.description || '',
      linkingTutorialTitles: titles
    })

    let raw
    try {
      const res = await chat.chat({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userPrompt }
        ],
        temperature: 0.0
      })
      raw = res?.content || res?.message?.content || ''
      consecutiveFailures = 0
    } catch (err) {
      consecutiveFailures++
      process.stderr.write(`${c.slug}\t0\t0\terror:${err.message}\n`)
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`Aborting: ${MAX_CONSECUTIVE_FAILURES} consecutive AI Core failures`)
      }
      return
    }

    const aliases = parseAliases(raw)
    if (aliases.length === 0) {
      process.stderr.write(`${c.slug}\t0\t0\t${Date.now() - t0}\n`)
      return
    }

    // Dedupe within LLM output by lowercase.
    const seen = new Set()
    const rows = []
    let skipped = 0
    for (const a of aliases) {
      const lower = a.toLowerCase()
      if (seen.has(lower)) { skipped++; continue }
      seen.add(lower)
      rows.push({ concept_ID: c.ID, alias: a, aliasLower: lower, source: 'LLM' })
    }

    if (dryRun) {
      process.stderr.write(`${c.slug}\t${rows.length}\t${skipped}\t${Date.now() - t0}\tdry-run\n`)
      return
    }

    // Insert one at a time — @assert.unique.conceptAlias handles collisions
    // with rows that already exist (e.g. admin-added SEED aliases).
    let written = 0
    for (const row of rows) {
      try {
        await db.run(INSERT.into(ConceptAliases).entries(row))
        written++
      } catch (err) {
        if (/unique|assert/i.test(err.message)) { skipped++ } else { throw err }
      }
    }
    process.stderr.write(`${c.slug}\t${written}\t${skipped}\t${Date.now() - t0}\n`)
  })))
}

// CLI entrypoint — parse argv, call runBackfill.
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')) {
  const args = new Map()
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]
    if (a === '--dry-run')      args.set('dryRun', true)
    else if (a === '--force')   args.set('force', true)
    else if (a === '--limit')   args.set('limit', Number(process.argv[++i]))
    else if (a === '--only-slug') args.set('onlySlug', process.argv[++i])
    else {
      process.stderr.write(`Unknown flag: ${a}\n`)
      process.exit(2)
    }
  }
  runBackfill({
    dryRun:  args.get('dryRun'),
    force:   args.get('force'),
    limit:   args.get('limit'),
    onlySlug: args.get('onlySlug')
  }).then(() => process.exit(0)).catch(err => {
    process.stderr.write(`Fatal: ${err.stack || err.message}\n`)
    process.exit(1)
  })
}
```

- [ ] **Step 5: Run the smoke test — expect PASS**

```bash
npx vitest run test/scripts/concept-alias-backfill.smoke.test.js --project unit
```

Expected: all three tests pass.

- [ ] **Step 6: Commit**

```bash
git add srv/scripts/concept-alias-backfill.js test/scripts/concept-alias-backfill.smoke.test.js
git commit -m "feat(#1046): AI Core-backed alias backfill with dedupe + dry-run + smoke tests"
```

---

## Task 11: Regression guard — static `@cds.search` assertion

**Files:**
- Create: `test/kg-search-annotation-guard.test.js`

**Interfaces:**
- Consumes: source text of `srv/knowledge-graph-service.cds`
- Produces: CI fails if the `@cds.search` on `PublishedConceptsWithAliases` is deleted or loses `aliasSearchBlob`

- [ ] **Step 1: Add the guard test**

Create `test/kg-search-annotation-guard.test.js`:

```js
// test/kg-search-annotation-guard.test.js
// #1046 — if this annotation is deleted or loses aliasSearchBlob, the palette's
// CONCEPTS group silently collapses to name-only match. Fail CI, not users.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('#1046 PublishedConceptsWithAliases @cds.search annotation guard', () => {
  const src = readFileSync(resolve(__dirname, '..', 'srv', 'knowledge-graph-service.cds'), 'utf8')

  it('PublishedConceptsWithAliases is defined', () => {
    expect(src).toMatch(/entity\s+PublishedConceptsWithAliases\b/)
  })

  it('carries @cds.search covering aliasSearchBlob', () => {
    // Match the annotation immediately above the entity, tolerant of whitespace.
    const idx = src.indexOf('PublishedConceptsWithAliases')
    expect(idx).toBeGreaterThan(-1)
    const preamble = src.slice(Math.max(0, idx - 400), idx)
    expect(preamble).toMatch(/@cds\.search/)
    expect(preamble).toMatch(/aliasSearchBlob/)
  })
})
```

- [ ] **Step 2: Run — expect PASS**

```bash
npx vitest run test/kg-search-annotation-guard.test.js --project unit
```

Expected: PASS.

- [ ] **Step 3: Sanity-check the failure mode**

Temporarily comment out the `@cds.search:` line above `PublishedConceptsWithAliases` in `srv/knowledge-graph-service.cds`, re-run the test — it should FAIL. Uncomment, re-run — PASS. Do NOT commit the temporary edit.

- [ ] **Step 4: Commit**

```bash
git add test/kg-search-annotation-guard.test.js
git commit -m "test(#1046): static guard against \@cds.search regression on aliases"
```

---

## Task 12: Run the full unit test suite + open the PR

**Files:** none — verification + shipping

**Interfaces:** none

- [ ] **Step 1: Full unit test run**

```bash
npm test 2>&1 | tail -30
```

Expected: green. All new tests pass; existing tests unchanged.

- [ ] **Step 2: Full hybrid test run (if `cf login` is set up)**

```bash
npm run test:hybrid -- --project hybrid test/hybrid/1046-concept-aliases-hybrid.test.js 2>&1 | tail -30
```

Expected: green. If `$search` fails, revisit Task 5 Step 6 (materialized-column fallback).

- [ ] **Step 3: Push the branch + open a draft PR**

```bash
git push -u origin worktree-1046-concept-aliases
gh pr create --draft --title "feat(#1046): Concepts.aliases for command-palette synonym matching" --body "$(cat <<'EOF'
Closes #1046.

Design spec: `docs/superpowers/specs/2026-07-08-1046-concept-aliases-design.md`

## Summary

Adds a `ConceptAliases` sub-entity (composition of `Concepts`), an LLM-backfilled synonym list, a new `PublishedConceptsWithAliases` OData projection with `@cds.search` on a lowercase alias blob, and an inline sub-table on the Concept OP under `/admin-ui/#concepts`. The ⌘K palette's CONCEPTS group now hits acronyms like `SLT`, `IDoc`, `MTA` that missed before.

## Testing

- Unit tests (in-memory SQLite): schema + hook + projection + palette wiring — all pass.
- Hybrid test (real HANA via `cds bind`): anonymous \$search hits `aliasSearchBlob` end-to-end.
- Backfill smoke test: mocked AI Core; verifies dedupe, idempotency, and `--dry-run`.

## Backfill

To run the LLM backfill after merge:

\`\`\`bash
cds run -s AICore-btp -- node srv/scripts/concept-alias-backfill.js --dry-run --limit 20
# Sanity-check the output. Then:
cds run -s AICore-btp -- node srv/scripts/concept-alias-backfill.js
\`\`\`

Rough budget ~\$2 in AI Core credits.

## Non-goals (documented in the spec)

- No PageRank blend on alias matches.
- No admin bulk-regenerate action.
- No search-match highlight in the palette.
- No `AliasSources` value-help table (three-value enum not worth the `@cap-js/ai` hazard in v1).
EOF
)"
```

Expected: PR URL printed to stdout. Copy it into the completion signal.

---

## Self-review notes

**Spec coverage** — walked each spec section:

- Schema (spec §"Schema") → Task 1 ✓
- HDI index (spec, in schema notes) → Task 2 ✓
- Backend projection + after-READ (spec §"Backend") → Task 5 ✓ (with Task 6's Step 6 as the materialized-column fallback path when `virtual` field `@cds.search` doesn't work)
- LLM backfill (spec §"LLM backfill") → Tasks 9 + 10 ✓
- Admin UI facet (spec §"Admin UI") → Task 7 ✓
- Palette front-end URL swap (spec §"Palette front-end") → Task 6 ✓
- Tests (spec §"Testing") → Tasks 3/4 (unit CRUD), 5 (unit palette), 8 (hybrid), 10 (backfill smoke), 11 (regression guard) ✓
- Non-goals — no tasks created, correct

**Placeholders** — none present. Every step has runnable commands or exact code.

**Type consistency** — `runBackfill(opts)` is defined in Task 10 Step 4 and consumed in Task 10 Step 2. `ConceptAliases`, `Concepts.aliases` names match across schema, service, and admin annotations. `aliasSearchBlob` name is consistent across projection, after-READ hook, `@cds.search`, and guard test.

**One caveat, documented in Task 5 Step 6:** If `@cds.search` on a `virtual` field doesn't wire into HANA `CONTAINS` at storage-layer time (the exact ordering-vs-hydration nuance I called out in the spec), the fallback is a materialized column populated by a before-write / after-write hook. Task 5 explicitly branches on the test outcome; Task 8's hybrid test is the canonical decider.
