# Concept Aliases — design (issue #1046)

> **Issue:** [#1046 — KG: add Concepts.aliases for command-palette synonym matching](https://github.com/sap-tutorials/tutorials-ims/issues/1046)
> **Follow-up from:** #1036 / PR #1045 (see "Out of scope" in `docs/superpowers/specs/2026-07-06-1036-cmd-palette-enhancements-design.md`)
> **Date:** 2026-07-08
> **Status:** design approved, plan pending

## Summary

Strengthen the CONCEPTS group hit rate in the ⌘K command palette for pure acronym / synonym queries. Today, queries like `SLT`, `IDoc`, `MTA` miss the CONCEPTS group because the underlying concept was extracted only under its long-form name — the KG cosine group under KNOWLEDGE GRAPH still surfaces them via embedding similarity, which is why this is a hit-rate improvement, not a ship blocker.

The change: a new `ConceptAliases` sub-entity composition of `Concepts`, an LLM-backfilled synonym list, a new palette-facing OData projection that folds aliases into a `$search`-able blob, and an inline sub-table under the Concept Object Page for admin review.

## Scope decisions

Resolved during brainstorming — recorded here so a future reader doesn't re-litigate them:

| Question | Decision |
|---|---|
| Palette matching mechanism | New `PublishedConceptsWithAliases` projection with `@cds.search` on a virtual `aliasSearchBlob` field. Rejected: client-side `$expand=aliases($filter=...)` (weaker HANA plan, more client code), two-stage side-table query (extra round-trip). |
| Backfill approach | Per-concept prompt via AI Core (`gpt-4o-mini`). Rejected: batched 50/call (chunk failures lose 50 concepts, harder to keep deterministic), CSV seed only (defers the LLM-quality question to another PR). |
| Alias case handling | Case-preserved storage (`IDoc`, `S/4HANA`), case-insensitive match via a lowercase-sibling column `aliasLower`. Rejected: uppercase-normalize on write (loses natural casing), rely on HANA fuzzy `$search` (behavior on short acronyms diverges from a purely case-folded match). |
| Admin UI shape | Inline sub-table facet on the Concept Object Page in `/admin-ui/#concepts`, standard FE draft round-trip. Rejected: top-level ConceptAliases list-report (worse for the common "editing one concept" flow), bulk-regenerate action only (no per-alias review). |
| Public exposure | New projection inherits `@requires: 'any'` from `KnowledgeGraphService`; aliases visible to anonymous. Rejected: strip aliases on the wire (they're public synonyms of already-public concepts — no sensitivity), new POST action (loses `$search` / paging semantics). |

## Architecture

Four moving parts: schema, backend projection, LLM backfill script, admin UI + palette front-end.

### Schema — `db/knowledge-graph.cds`

New composition of Concepts + a lowercase index for case-insensitive match:

```cds
/**
 * Search synonyms for concepts — LLM-backfilled, admin-editable.
 * Powers the ⌘K palette's CONCEPTS group so acronym queries hit
 * (e.g. "SLT" → sap-landscape-transformation).
 */
entity ConceptAliases : cuid, managed {
  concept    : Association to Concepts @assert.notNull;
  alias      : String(120) @assert.notNull;
  aliasLower : String(120);                            // populated by srv layer on write
  source     : String(20) default 'LLM';               // 'LLM' | 'ADMIN' | 'SEED'
}

annotate ConceptAliases with @assert.unique.conceptAlias : [concept, aliasLower];

extend entity Concepts with {
  aliases : Composition of many ConceptAliases on aliases.concept = $self;
}
```

Notes:

- `aliasLower` is populated by a `before('CREATE'|'UPDATE')` hook on the admin service — not a `virtual` element and not an HDI computed column. This keeps the write path simple and avoids HDI generated-column syntax quirks.
- `@assert.unique.conceptAlias` uses the lowercase column so `IDoc` and `idoc` collide.
- HANA index on `aliasLower` via a `.hdbindex` artifact (`INDEX name ON ConceptAliases(aliasLower)` — no SQL verbs per the HDI-artifacts constraint documented in `docs/developers/reference/hana-hdi-gotchas.md`).
- `source` lets an admin filter LLM-generated rows vs hand-added ones.
- Cascade-delete on Concept DELETE is automatic via the composition.
- A tiny `AliasSources` reference table for a value-help dropdown on the `source` field is **deferred** — see the admin UI section for the `@cap-js/ai` rationale.
- Cascade-delete on Concept DELETE is automatic via the composition.

### Backend — `srv/knowledge-graph-service.cds` + `.js`

**New projection** added to `KnowledgeGraphService` (inherits `@requires: 'any'`):

```cds
/**
 * PublishedConcepts + a searchable alias blob for the ⌘K palette (#1046).
 * aliasSearchBlob is a comma-joined lowercase alias string populated at
 * READ time by an after-READ handler — HANA $search hits it as a single
 * field so a query like "SLT" matches sap-landscape-transformation.
 */
@readonly
@cds.search: { name, description, aliasSearchBlob }
entity PublishedConceptsWithAliases as projection on ims.Concepts {
  ID, slug, name, description, publishedAt, publishedBy, status,
  virtual null as aliasSearchBlob : String(2000),
  aliases : redirected to ConceptAliases,
} where publishedAt is not null and status = 'ACTIVE';

@readonly entity ConceptAliases as projection on ims.ConceptAliases;
```

**After-READ handler** in `srv/knowledge-graph-service.js`:

```js
srv.after('READ', 'PublishedConceptsWithAliases', async (rows, req) => {
  const list = Array.isArray(rows) ? rows : [rows]
  const ids = list.map(r => r.ID).filter(Boolean)
  if (!ids.length) return
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
  for (const r of list) r.aliasSearchBlob = (byConcept.get(r.ID) || []).join(',')
})
```

**Two nuances to verify at implementation time:**

1. **`@cds.search` on a virtual field.** The `virtual` element `aliasSearchBlob` is not a storage column; it's hydrated by the after-READ hook. CAP's `@cds.search` machinery normally wires `$search` → HANA `CONTAINS(...)` on the listed fields at the storage layer, which happens **before** after-READ. If the unit / hybrid tests confirm this doesn't work, the fallback is to materialize `Concepts.aliasSearchBlob` as a real column populated by the before-write hook that already computes `aliasLower` per alias. Belt-and-suspenders variant lives one commit away; the test suite decides.

2. **Batch-fetch honors the HANA packet-size constraint.** The after-READ query uses `IN` over `list.map(r => r.ID)` — capped at `$top=6` from the palette caller, so the array is tiny. No unbounded-fetch risk of the shape that broke the featured-missions carousel in #1032.

**Auth:** inherits `@requires: 'any'`. Anonymous callers see aliases — consistent with the "aliases are public synonyms of public concepts" decision.

**No new POST action.** The palette swaps its `fetch(/graph/PublishedConcepts)` → `fetch(/graph/PublishedConceptsWithAliases)`. The `searchKG` handler in `srv/lib/kg/search-kg-handler.js` (the KNOWLEDGE GRAPH group in the palette) is untouched.

### LLM backfill — `srv/scripts/concept-alias-backfill.js`

**Invocation:** `cds run -s AICore-btp -- node srv/scripts/concept-alias-backfill.js [--limit N] [--dry-run] [--only-slug <slug>] [--force]`

Runs under `cds bind` so `cds.env.requires.AICore` resolves to the real BTP AI Core binding. Local `cds watch` uses `AICore-mocked` and short-circuits with a warning — mocked embedder isn't acceptable for acronym extraction.

**Prompt shape:**

```
You extract common short synonyms and acronyms for a technical concept.
Return a JSON object shaped {"aliases": ["..."]} with 0 to 8 short forms
that a developer might type in a search box. Rules:
- Only real, in-use aliases. No invented shortenings.
- 2 to 40 characters each. No punctuation-only strings.
- Drop the canonical name itself. Drop pluralization variants.
- Prefer classical SAP shorthand: "IDoc" (not "Intermediate Document"),
  "MTA" (not "Multi-Target Application"), "S/4HANA" (not "SAP S/4HANA").
- If nothing fits, return {"aliases": []}. Do not guess.
```

Per-concept payload: `{name, description, top-3 linking tutorial titles}`.

**Batching / concurrency / cost:**

- Load all published concepts + top-3 linking tutorial titles in **two outer queries**, keyed by `concept_ID` — not 700 sub-queries. Respects `docs/developers/reference/cap-cds-gotchas.md`.
- Concurrency 4 via `p-limit` — small, so AI Core rate limits stay clear and the cost graph stays readable.
- Skip a concept if `ConceptAliases WHERE concept_ID = ?` already has any row (idempotent, resumable). Override with `--force`.
- Model: `gpt-4o-mini` via AI Core (same client the on-demand extractor from #948 uses).
- Rough budget: 700 concepts × ~500 input tokens × ~50 output tokens ≈ **~$2 at current gpt-4o-mini rates**. Under the issue's $5 ceiling.

**Write path:**

- One transaction per concept. Insert with `source='LLM'`. Compute `aliasLower` on write.
- If the LLM emits an alias that duplicates the existing set for that concept (by `aliasLower`), silently skip — the uniqueness constraint would otherwise 400.
- Per-concept telemetry line to stderr: `slug\taliases_written\tskipped_duplicates\tlatency_ms`. Enables `grep` post-mortems.

**Guardrails:**

- `--dry-run` prints planned inserts, writes nothing. Use on the first ~20 concepts before spending the full budget.
- `--only-slug <slug>` targets one concept.
- The script exits non-zero if AI Core returns 5xx three times in a row.

**Where it does NOT run:**

- Not from a scheduled job. One-shot; re-run cadence is a follow-up decision if Concepts grows past 700.
- Not from a CAP action. Actions have HTTP timeouts and no `--dry-run` semantics.

### Admin UI — sub-table facet on the Concept Object Page

**Where the Concept OP actually lives:** The `/admin-ui/#concepts` tile's manifest binds to `/graph/` — i.e., `KnowledgeGraphService`, not `AdminService`. All existing Concept OP annotations (Facets, LineItem, FieldGroup #General, Identification actions) sit in `app/admin-annotations.cds` under `annotate KnowledgeGraphService.Concepts with @(...)` at line ~2528. The new aliases facet and its child `ConceptAliases` annotations extend that same block — no `AdminService` changes needed.

**Files:**

- `srv/knowledge-graph-service.cds` — expose the composition through the writable `Concepts` projection AND declare a `ConceptAliases` projection so FE can round-trip it.
- `app/admin-annotations.cds` — add one new Facet entry to the existing Concept `@UI.Facets` array + a new `annotate KnowledgeGraphService.ConceptAliases with { @UI.LineItem ... }` block.
- `srv/knowledge-graph-service.js` — before-write hook on `ConceptAliases` that lowercases `aliasLower`.

**Service wiring in `srv/knowledge-graph-service.cds`:**

The existing writable `Concepts` projection at line 61 is `entity Concepts as projection on ims.Concepts excluding { embedding };` — with `excluding`, the composition `aliases` (defined on the base entity in `db/knowledge-graph.cds`) is auto-included. So the change is small:

```cds
// Add — writable so FE draft can insert/update/delete alias rows.
entity ConceptAliases as projection on ims.ConceptAliases;
```

The `Concepts` projection itself needs no edit; the composition flows through.

**Facet annotation (append to the existing `UI.Facets` array in `app/admin-annotations.cds:2586`):**

```cds
UI.Facets: [
  { $Type: 'UI.ReferenceFacet', Label: 'General',        Target: '@UI.FieldGroup#General' },
  { $Type: 'UI.ReferenceFacet', Label: 'Tutorials',      Target: 'links/@UI.LineItem' },
  { $Type: 'UI.ReferenceFacet', Label: 'Outgoing edges', Target: 'outgoingEdges/@UI.LineItem' },
  { $Type: 'UI.ReferenceFacet', Label: 'Incoming edges', Target: 'incomingEdges/@UI.LineItem' },
  { $Type: 'UI.ReferenceFacet', Label: 'Aliases',        Target: 'aliases/@UI.LineItem' }   // ← new
],
```

**New `ConceptAliases` annotation block (append after existing `TutorialConceptLinks`/`ConceptEdges` blocks at ~line 2650):**

```cds
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

**Draft posture:** The existing `Concepts` projection is writable but *not* draft-enabled (see the comment at line 42 explaining this is intentional — direct PATCH for `name`/`description`). Aliases inherit the same posture: inline CREATE/UPDATE/DELETE on `ConceptAliases` via the composition, no draft round-trip. FE inline-create in a sub-table facet works with a non-draft parent — it uses immediate deep-CREATE against `/graph/Concepts(<uuid>)/aliases`.

**Before-write hook (`srv/knowledge-graph-service.js`):**

```js
srv.before(['CREATE', 'UPDATE'], 'ConceptAliases', (req) => {
  if (typeof req.data.alias === 'string') {
    req.data.aliasLower = req.data.alias.toLowerCase().trim()
  }
})
```

**UX:**

- Admin opens `/admin-ui/#concepts` → clicks a concept row → sees an "Aliases" facet with a table (empty state: "No aliases yet").
- Standard FE inline-create adds an alias row. `source` defaults to `LLM` per the CDS default; the admin overrides to `ADMIN` in the row-detail (simplest UX; no custom controller).
- Save fires an immediate deep-CREATE. The before-hook lowercases `aliasLower`; `@assert.unique.conceptAlias` runs at commit. Duplicates surface as the standard "Value already exists" toast.
- Delete a row through standard FE row-action.

**No new controller extension** — reuses standard FE plumbing. `ConceptActionsController` stays untouched.

**Guard against `@cap-js/ai` crash:**

- The `alias` field is short freeform text. Do NOT annotate it with `@Common.ValueList` — the `@cap-js/ai` plugin's after-write hook fires on every Create with a ValueList field and crashes on the AICore binding (documented in `docs/developers/reference/cap-ai-plugin.md` and the memory file `cap-ai-plugin-aicore-kind-resolution.md`). If future work wants recommendations here, add `@UI.RecommendationState: 0` per that escape hatch.

**Value-help for `source`:** Deferred to a follow-up. In v1, `source` is a plain freeform String(20) with a CDS `default 'LLM'`. Admins type `ADMIN` when editing manually. Adding a `AliasSources` reference table + `@Common.ValueList` triggers the `@cap-js/ai` hazard above; the three-value enum isn't worth the risk in v1. Documented as a non-goal below.

### Palette front-end — `hugo-apps/src/cmd-palette/CommandPalette.vue`

Two-line change in `searchConcepts()` (line ~325):

```diff
- const res = await fetch(`/graph/PublishedConcepts?${params}`)
+ const res = await fetch(`/graph/PublishedConceptsWithAliases?${params}`)
```

No hint change — the palette row still says `Concept · <description>`. Showing which alias matched requires either an extra round-trip or match-highlighting; the payoff is small, so YAGNI.

The KNOWLEDGE GRAPH group is untouched — cosine already catches missed aliases exactly as recorded in #1036's design doc.

## Data flow

```
Admin opens /admin-ui/#concepts
  → OP for concept "sap-landscape-transformation"
  → Aliases facet loads /admin/Concepts(<uuid>)/aliases
  → admin types "SLT" + Save
  → before('CREATE') hook lowercases → aliasLower='slt'
  → INSERT ConceptAliases (concept=<uuid>, alias='SLT', aliasLower='slt', source='ADMIN')

Anonymous visitor presses ⌘K, types "SLT"
  → GET /graph/PublishedConceptsWithAliases?$search=SLT&$top=6
  → HANA $search matches aliasSearchBlob='slt' (or name/description) via @cds.search
  → after-READ hydrates aliasSearchBlob for the returned rows (idempotent — search already ran)
  → CONCEPTS group renders "SAP Landscape Transformation"
  → click → nav to /concepts/sap-landscape-transformation/

One-off backfill (once, before first user hit)
  → cds run -s AICore-btp -- node srv/scripts/concept-alias-backfill.js --dry-run --limit 20
  → sanity check output
  → cds run -s AICore-btp -- node srv/scripts/concept-alias-backfill.js
  → ~2 minutes wall clock, ~$2 in AI Core credits
```

## Testing

**Unit (`test/kg-concept-aliases.test.js`, in-memory SQLite):**

- `POST /admin/ConceptAliases` with `alias: 'IDoc'` → row inserted with `aliasLower: 'idoc'`.
- Two aliases with same lowercase form on the same concept → second write fails with `@assert.unique` violation. Verifies the collision guard.
- Delete parent Concept row → alias rows gone (composition cascade).
- Deploy sanity: run `npx cds deploy --to sqlite::memory:` in the test bootstrap — surfaces `.hdbtabledata` breakages before commit, per the CSV-change gotcha documented in memory.

**Unit (`test/palette-published-concepts-with-aliases.test.js`):**

- Seed one Concept `sap-landscape-transformation` + alias `SLT` + `aliasLower: 'slt'`.
- `GET /graph/PublishedConceptsWithAliases?$search=SLT&$top=6` → returns the row with `aliasSearchBlob: 'slt'`.
- Same URL with `$search=slt` → same row (case-insensitive).
- `$search=xyzzy` → empty. Anonymous request (no auth header) — verifies public exposure.
- **Contract test**: if the SQLite unit run behaves differently from HANA hybrid on the `virtual` `@cds.search` path, this test surfaces the belt-and-suspenders "materialize as a real column" fallback described above.

**Hybrid (`test/hybrid/kg-aliases-hybrid.test.js`, real HANA via `cds bind --exec`):**

- Real HANA `$search` on `aliasSearchBlob` — verifies the virtual approach works against HDI, or fails cleanly.
- Anonymous fetch (no XSUAA token) returns aliases. Confirms `@requires: 'any'` inheritance end-to-end.
- Batch-fetch shape: 5 concept IDs → after-READ hydrates all 5 with their aliases in one `IN` query, not 5 separate queries. Asserted via a `tx.run` spy or SQL-statement counter.

**Backfill smoke (`test/scripts/concept-alias-backfill.smoke.test.js`, mocked AI Core):**

- Mock the AI Core chat client to return `{aliases: ['IDoc', 'idoc']}` deterministically.
- Run backfill against a 3-concept in-memory fixture. Assert:
  - Duplicates within LLM output collapse to a single row (case-insensitive).
  - Second run with same fixtures is a no-op (idempotency check).
  - `--dry-run` writes nothing.
  - `--only-slug foo` writes only for `foo`.

**Regression guard against silent breakage:**

- A static test (extend an existing one under `test/` that greps `srv/knowledge-graph-service.cds`) asserts that `PublishedConceptsWithAliases` carries an `@cds.search` annotation covering `aliasSearchBlob`. If someone deletes it thinking it's redundant, palette matches collapse to name-only silently — this test catches it at CI, not by users noticing broken search.

## Explicit non-goals (YAGNI)

- No PageRank blend on alias matches (#916 covers cosine — different arm).
- No admin bulk-regenerate action. If the LLM needs rerunning, it's `cds run` with `--force`.
- No search-highlight of which alias matched. Adds UI complexity for marginal value.
- No feedback loop from palette clicks to concept extraction quality (that's #948's on-demand path, a different subsystem).
- No scheduled re-backfill job. Concept growth cadence doesn't justify one yet.
- No `AliasSources` value-help table. Three-value enum isn't worth the `@cap-js/ai` risk in v1; freeform String with a CDS default suffices.

## Files touched

New:

- `srv/scripts/concept-alias-backfill.js`
- `db/src/IDX_CONCEPT_ALIASES_LOWER.hdbindex`
- `test/kg-concept-aliases.test.js`
- `test/palette-published-concepts-with-aliases.test.js`
- `test/hybrid/kg-aliases-hybrid.test.js`
- `test/scripts/concept-alias-backfill.smoke.test.js`

Modified:

- `db/knowledge-graph.cds` (add `ConceptAliases` entity + extend `Concepts` with `aliases` composition)
- `srv/knowledge-graph-service.cds` (add `PublishedConceptsWithAliases` + `ConceptAliases` projections)
- `srv/knowledge-graph-service.js` (add after-READ hydrator on `PublishedConceptsWithAliases` + before-write lowercasing hook on `ConceptAliases`)
- `app/admin-annotations.cds` (add "Aliases" facet entry + `ConceptAliases` LineItem/Label annotations)
- `hugo-apps/src/cmd-palette/CommandPalette.vue` (URL swap only, ~line 325)
- One existing static-check test — extend with the `@cds.search` regression assertion

Estimated effort: **2–3 hours + one backfill run**, matching the issue's estimate.
