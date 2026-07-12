# Joule external-content retrieval via the knowledge graph (#1125)

**Status:** Design approved 2026-07-12. Ready for implementation planning.
**Issue:** [sap-tutorials/tutorials-ims#1125](https://github.com/sap-tutorials/tutorials-ims/issues/1125)

## Problem

Joule can surface **tutorials** related to a query via the knowledge graph, but it
cannot surface the **external content** already modeled in and linked to the KG.
A user asked *"What external content do you have linked to the AI Topic?"* and Joule
answered it had none — a **retrieval gap, not a data gap**. Eight external content
types are modeled in `com.sap.developers.ims.external`, each linked to `Concepts`
through its own link table + predicate, and each already projected into the RDF graph
by `srv/lib/kg-projection.js`. But the shared retrieval helper `fetchLinks` (in
`srv/lib/kg/_search-fetches.js`) queries **only** `TutorialConceptLinks WHERE
predicate='teaches'` joined to `Tutorials`. Every non-tutorial node hanging off the
matched concepts is discarded.

| Type | Entity | Link table | Predicate to concept | Trust tier |
|---|---|---|---|---|
| Learning Journeys | `LearningJourneys` | `LearningJourneyConceptLinks` | `covers` | authoritative |
| Blog Posts | `BlogPosts` | `BlogPostConceptLinks` | `discusses` | community |
| Discovery Missions | `DiscoveryMissions` | `DiscoveryMissionConceptLinks` | `teaches` | authoritative |
| Videos | `Videos` | `VideoConceptLinks` | `teaches` | authoritative |
| API Docs | `ApiDocs` | `ApiDocConceptLinks` | `officialReferenceFor` | authoritative |
| Code Samples | `Samples` | `SampleConceptLinks` | `embodies` | authoritative |
| Help Docs | `HelpDocs` | `HelpDocConceptLinks` | `explains` | authoritative |
| Community Events | `CommunityEvents` | `CommunityEventConceptLinks` | `covers` | community |

## Goal

Widen Joule's KG retrieval so it can find and recommend external content, **without
regressing** the tuned tutorial rank blend that `SearchService.before('READ')` depends
on. Include all 8 types; distinguish authoritative from community sources so the LLM
attributes them appropriately.

## Non-goals

- No new modeling, extraction, embedding, or linking — that heavy lifting is done.
- No change to the tutorial rank blend (`buildKgRankFragment`, `slugScores`, the
  `SearchService` OData rank path). This is a **retrieval-layer extension only**.
- No filtering-out of "risky" types. All 8 are returned; trust tier is metadata the
  LLM uses for attribution, not a gate.

## Existing pipeline (reference)

```
expandSearchConcepts / searchTutorials  (srv/lib/chat-orchestrator.js)
  → computeKgSignal  (srv/lib/search-kg-signal.js)   [5-min LRU + single-flight]
      embed query → topConceptsByCosine → fetchEdges (1-hop walk)
      → fetchConceptsByIds (hydrate, publish gate) → fetchLinks (teaches→Tutorials)
      → aggregate Σ(conceptScore × linkConfidence) per tutorial
  → slugScores / slugRationale / slugTitle / topConcepts
```

`computeKgSignal` already produces the gated concept set + per-concept scores and
caches it for 5 minutes keyed on the normalized query. The external path piggybacks
on that cache: **no second embed, no perturbation of the tutorial rank blend.**

## Architecture

### Part A — Retrieval / backend

**A1. Widen the cached signal (additive only).** In `srv/lib/search-kg-signal.js`,
add the concept IDs to the returned/cached `KgSignal` so downstream callers can fetch
external links without re-walking. Concretely: add an `id` field to each `topConcepts`
entry (currently `{ slug, name, score }` → `{ id, slug, name, score }`). This is the
**only** edit to that file. `buildKgRankFragment`, `slugScores`, `slugRationale`,
`slugTitle`, and the `SearchService.before('READ')` path are untouched — the change is
purely a new field on an existing array, so the tutorial rank blend is byte-identical.

**A2. New fetch helper** `fetchExternalContentLinks(db, conceptIds, { types } = {})`
in `srv/lib/kg/_search-fetches.js`. UNIONs the 8 link tables back to their content
rows, mirroring `fetchLinks`'s HANA/SQLite dialect branching:

- HANA branch: double-quoted lowercase aliases (`SLUG as "slug"`) per #1113, raw
  `db.run()` with positional `?` placeholders.
- SQLite branch: physical lowercase column names, unquoted.
- Selects **only** scalar metadata: `content_type` (literal per UNION arm),
  `concept_id`, `slug`, `title`, `url`, `confidence`, `lastSeenAt`, and `endDate`
  (only `CommunityEvents` has it; other arms select `NULL`).
- **NEVER selects the `description` NCLOB column** — every external entity except the
  link tables carries a `LargeString description`; selecting it alongside scalars
  expires the LOB locator on HANA (established rule — see `content-store.js`,
  `kg-projection.js`). Cards render from title + url only.
- `types` optionally restricts which UNION arms run (maps the LLM's `types[]` arg).
- Returns `[]` for empty `conceptIds` (matches `fetchLinks`).

**A3. New signal module** `srv/lib/kg/external-content-signal.js` exporting
`computeExternalContentSignal({ phrase, db, embedClient, embeddingModel, enabled,
timeoutMs, types, maxItems })`:

1. `const signal = await computeKgSignal({ phrase, db, embedClient, embeddingModel,
   enabled, timeoutMs })` — cache hit (free) if `searchTutorials`/`expandSearchConcepts`
   already fired this turn; otherwise one embed + cosine + walk.
2. Propagate `signal.warning` (`timeout`/`embed_failed`/`kg_empty`/`db_error`/`disabled`)
   straight through — same contract as the tutorial path.
3. Take `signal.topConcepts` (now carrying `id` + `score`). Build
   `conceptScoreById = Map(id → score)`.
4. `const rows = await fetchExternalContentLinks(db, conceptIds, { types })`.
5. **Freshness gate:** filter each row through `isWithinTTL(ttlKeyFor(content_type),
   lastSeenAt, endDate)` (from `srv/lib/external-content-ttl.js`) so stale rows drop,
   matching the projection's gate exactly. `endDate` + 30-day grace applies only to
   `community-event`.
6. Aggregate per content item: `score = Σ(conceptScore × linkConfidence)`; keep a
   short `rationale` from the top-contributing concept name(s) (mirror the tutorial
   `slugRationale` shape, e.g. "Covers Async ABAP").
7. Tag each item with `trustTier` (`authoritative` | `community`) per the table above.
8. Return `{ externalContent: [{ type, title, url, slug, trustTier, score, rationale }],
   warning? }`, sorted by score desc, capped at `maxItems`.

A per-type TTL-key map (`ttlKeyFor`) translates DB `content_type` → the
`PER_TYPE_TTL_DAYS` key (e.g. `Videos` → `'video'`).

### Part B — Tool + surfacing + rendering

**B1. New ChatSettings flag.** `db/schema.cds` `ChatSettings`:

```cds
// Knowledge Graph external-content recommendation tool (#1125). When true,
// findRelatedContent is registered on the standard learner/admin path. Reuses
// the same cached embed+cosine as kgSearchExpansionEnabled, then fans out over
// the 8 external-content link tables (bounded by the <=5 concept set). Default
// true (cheap, cache-reused); toggle off if telemetry shows problems.
kgRelatedContentEnabled : Boolean default true;
```

CSV seed stays empty (HDI-clobber rule — `feedback_cap_csv_seeds_clobber_admin_data`).

**B2. New Joule tool `findRelatedContent`** (descriptor + dispatch in
`chat-orchestrator.js`):

- OpenAI function-calling descriptor shape (bare `parameters`, matching
  `EXPAND_SEARCH_CONCEPTS_TOOL`). Params:
  - `query` (string, required, 1–200 chars)
  - `types` (array, optional, items enum: the 8 type keys) — restrict result kinds
  - `maxItems` (integer, optional, 1–20, default 8)
- Registered in `buildToolRegistry` when `settings?.kgRelatedContentEnabled`, under the
  **same standard learner/admin guard** as `expandSearchConcepts`. Excluded from
  devtoberfest and advocates palettes (early-return branches unchanged).
- Dispatch branch in `dispatchTool`: `cds.connect.to('db')`, resolve embedding model
  via `resolveEmbeddingSettings()`, build `defaultEmbedClient(model)`, call
  `computeExternalContentSignal(...)`. Map `signal.warning` back into the response
  envelope (`{ queryEcho, externalContent: [], warning }`), matching the
  `expandSearchConcepts` error contract. Wrap in try/catch → `warning:'dispatch_failed'`.

**B3. System-prompt line** in `buildSystemPromptLines` (only when
`kgRelatedContentEnabled`): instruct Joule to call `findRelatedContent` when the user
asks for docs / videos / samples / blogs / learning journeys / "external content /
resources" on a topic, and to **attribute by trust tier** — cite `authoritative` items
directly; present `community` items with soft attribution ("a community blog post by
…", "a community event"). Same guard as `buildToolRegistry` (skip devtoberfest/advocates).

**B4. SSE card event.** In `streamChat`'s post-dispatch block, add a branch mirroring
`tutorial-cards`: when `tc.name === 'findRelatedContent'` and
`result.externalContent?.length`, emit
`sse(res, { type: 'external-content-cards', items: result.externalContent })`.

**B5. Frontend renderer** `renderExternalContentCards(items)` in
`hugo/static/js/joule.js`, wired into the SSE `switch` (~line 646, alongside
`tutorial-cards` / `doc-citations` / `step-citations`):

- Renders **external anchors** — `<a href={url} target="_blank" rel="noopener">` —
  mirroring `renderStepCitations`, NOT the internal `safeNavigate` used by
  tutorial-cards (external URLs point to api.sap.com / github.com / youtube.com / …).
- URL sanitized: only `http:`/`https:` protocols rendered (parse with `new URL`,
  drop anything else). Defense-in-depth against a malformed `url` column.
- Grouped by `type` with a per-type label (and optional icon); community-tier items
  get a small "community" hint so the visual matches the LLM's attribution.
- Skips items with a missing/invalid url (never renders a dead anchor).

## Data flow (new path)

```
findRelatedContent tool call (LLM)
  → dispatchTool → computeExternalContentSignal
      → computeKgSignal  [CACHE HIT if searchTutorials fired this turn → free]
      → fetchExternalContentLinks(db, conceptIds, {types})   [8-arm UNION, no NCLOB]
      → isWithinTTL filter per type (+ endDate grace for events)
      → aggregate Σ(conceptScore × linkConfidence), trustTier tag, sort, cap
  → { queryEcho, externalContent: [...], warning? }
  → streamChat emits `external-content-cards` SSE
  → joule.js renderExternalContentCards → external <a> links grouped by type
```

## Error handling

- Empty query → `{ error / warning, externalContent: [] }` (mirror `expandSearchConcepts`).
- `computeKgSignal` warning (`timeout` / `embed_failed` / `kg_empty` / `db_error` /
  `disabled`) → propagated as `warning` with empty `externalContent`.
- `kg_empty` does NOT trigger on-demand extraction here (that's the tutorial path's
  concern via `enqueueOnDemandExtraction`; the external tool just returns empty).
- DB throw in `fetchExternalContentLinks` → caught, `warning:'db_error'`, empty array —
  never breaks the chat turn.
- Frontend: invalid/missing url → item skipped; empty `items` → nothing rendered.

## Testing

**Unit (in-memory SQLite):**
- `fetchExternalContentLinks`: SQLite dialect returns lowercased keys; empty
  `conceptIds` → `[]`; `types` filter restricts arms; multiple content types come back
  in one call; NCLOB `description` is never in the projection.
- `computeExternalContentSignal`: aggregation math (Σ conceptScore × confidence);
  trust-tier tagging per type; TTL filtering drops a stale row (fake old `lastSeenAt`);
  event `endDate` grace; cache reuse (inject a stub embed client, assert one embed
  across a `searchTutorials` + `findRelatedContent` pair); `maxItems` cap; warning
  propagation.
- `buildToolRegistry` / `buildSystemPromptLines`: tool + prompt line present when flag
  on, absent when off; absent on devtoberfest / advocates regardless of flag.
- `dispatchTool('findRelatedContent', …)`: warning contract, dispatch_failed on throw.

**Hybrid (real HANA via `cds bind`, `--project hybrid`):** the `_search-fetches.js`
HANA branch can't be unit-tested (matches how `fetchLinks` is covered). Assert the
8-arm UNION returns correctly-keyed rows against real link tables and that the
double-quoted-alias lowercasing holds.

**Frontend:** existing joule.js test harness (if present) — external-content-cards
renders anchors, sanitizes non-http urls, groups by type.

## Files touched

- `srv/lib/search-kg-signal.js` — add `id` to `topConcepts` entries (additive).
- `srv/lib/kg/_search-fetches.js` — new `fetchExternalContentLinks` (+ HANA/SQLite branches).
- `srv/lib/kg/external-content-signal.js` — **new** module.
- `srv/lib/chat-orchestrator.js` — `FIND_RELATED_CONTENT_TOOL` descriptor, registry +
  prompt-line wiring, dispatch branch, SSE emit, export.
- `db/schema.cds` — `ChatSettings.kgRelatedContentEnabled`.
- `hugo/static/js/joule.js` — `renderExternalContentCards` + SSE switch wiring.
- Tests: unit + hybrid as above.

## Rollout / risk

- **Main risk (per issue):** regressing the search rank blend. Mitigated by A1 being a
  purely additive field — the tutorial path's `slugScores`/`buildKgRankFragment` are
  not touched. A unit test asserts `buildKgRankFragment` output is unchanged.
- Flag defaults ON but is a single `cf set-env` / admin toggle away from off.
- No schema change beyond one nullable-defaulting boolean; `cds build --production`
  required so it lands in `db/last-dev/` (schema-change rule). Run
  `npx cds deploy --to sqlite::memory:` before committing the `db/schema.cds` edit
  (runtime `@assert`/deploy check).
- DEV-only until PROD cutover (end of July 2026), consistent with the rest of the KG
  surface.
