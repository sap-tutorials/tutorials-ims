# Command palette enhancements — design (issue #1036)

> **Issue:** [#1036 — Command palette: add Concepts / Devtoberfest / Developer Advocates nav, dynamic concept results, and full-KG search](https://github.com/sap-tutorials/tutorials-ims/issues/1036)
> **Date:** 2026-07-06
> **Status:** design approved, plan pending

## Summary

Expand the `⌘K` command palette in three ways: (a) add three static EXPLORE nav entries — Concepts, Devtoberfest, Developer Advocates — that today have no palette shortcut; (b) layer dynamic concept-name results on top of the static registry the same way tutorial search is layered today; (c) add a new "KNOWLEDGE GRAPH" group that hits a new anonymous-safe backend action which reuses the existing KG seed/walk/hydrate helpers but **never enqueues on-demand extraction**, so a curious keystroke can't spam the drain queue.

## Motivation

- The EXPLORE group only covers the six verb-spine routes + KG Explorer today. Concepts, Devtoberfest, and Developer Advocates have no palette entry — visitors have to know the URL.
- Tutorial search already layers dynamic results at runtime. Concepts are the KG's primary vocabulary and deserve the same treatment.
- The full KG holds concept + relationship data that isn't discoverable from tutorial titles alone. Wiring cosine-based KG search into `⌘K` lets a visitor jump from "SLT" straight to the `sap-landscape-transformation` concept + tutorials that teach it, without going through the KG Explorer first.

## Scope decisions

Resolved during brainstorming — recorded here so a future reader doesn't re-litigate them:

| Question | Decision |
|---|---|
| Scope in this PR | All three parts (nav + concept search + full-KG search). |
| KG backend shape | New CDS action `KnowledgeGraphService.searchKG` — never enqueues. Rejected: threading `noEnqueue` into the Joule handler, or client-side stitching two OData calls. |
| Group layout | Five groups: `ACTIONS · EXPLORE · TUTORIALS · CONCEPTS · KNOWLEDGE GRAPH`. Rejected: merged single dynamic group. |
| Fetch trigger | Auto-fire all three searchers on every keystroke past 2 chars, single 250ms debounce. |
| Aliases | Ship without aliases in this PR; open a follow-up issue titled "add Concepts.aliases for command-palette synonym matching". Justification: the KG cosine group is the escape hatch for missing aliases (typing `SLT` still finds `sap-landscape-transformation` under KNOWLEDGE GRAPH via cosine even when the concept-name group misses). |
| Auth posture | Both new endpoints inherit `KnowledgeGraphService`'s `@requires: 'any'` — consistent with `/explore/` and `/graph/PublishedConcepts` already being public. |

## Architecture

Two moving parts.

### Backend (CAP, `srv/`)

**New CDS action** on the existing anonymous-readable `KnowledgeGraphService` (path `/graph`, `@requires: 'any'`):

```cds
action searchKG(term: String, maxConcepts: Integer, maxTutorials: Integer)
  returns {
    concepts: many { slug: String; name: String; score: Double };
    tutorials: many { slug: String; title: String; score: Double };
  };
```

**New handler** `srv/lib/kg/search-kg-handler.js`. Shares `topConceptsByCosine`, `fetchEdges`, `fetchConceptsByIds`, `fetchLinks` from `srv/lib/kg/_search-fetches.js` and `srv/lib/kg/concept-embedding-query.js`. Same logic as `expandSearchConceptsHandler` in `srv/lib/kg/joule-tool-expand-concepts.js` **minus** the `enqueueOnDemandExtraction` fire-and-forget call. Return shape drops the Joule-specific `rationale` and `queryEcho` fields. No import of `on-demand-enqueue.js`.

**Wire-up in `srv/knowledge-graph-service.js`** — one `srv.on('searchKG', ...)` next to the existing anonymous read-side actions.

### Frontend (`hugo-apps/src/cmd-palette/`)

**`actions.ts`** — three new `PaletteAction` entries under `group: 'explore'`, placed between `explore-connect` and `explore-knowledge-graph`:

- `explore-concepts` → `/concepts/` — keywords: `concepts, index, glossary, terms, kg`
- `explore-devtoberfest` → `/devtoberfest/` — keywords: `devtoberfest, festival, event, weekly, challenge`
- `explore-advocates` → `/developer-advocates/` — keywords: `advocates, devrel, team, spokespeople, community`

**`CommandPalette.vue`** — the changes cluster in five spots:

1. Two new refs: `conceptResults: PaletteAction[]`, `kgResults: PaletteAction[]`.
2. Two new async searcher functions (`searchConcepts`, `searchKG`) modeled on the existing `searchTutorials`.
3. Existing `watch(query, …)` fires all three searchers inside one 250ms debounced tick (bumped from 200ms; single timer, three parallel fetches).
4. Template — two new `<template v-if="conceptResults.length">` and `<template v-if="kgResults.length">` blocks between TUTORIALS and the empty state. Each row shows a subtle right-aligned badge (`Concept` / `via KG`).
5. `runActive()` and the `activeIndex` math walk five arrays: `[…actions, …explore, …tutorials, …concepts, …kg]`. Refactored into a small `flatIndex()` helper.

## Data flow

**On palette open** — no network calls. Static ACTIONS + EXPLORE render immediately, including the three new nav entries.

**On keystroke (query length ≥ 2)**, single 250ms debounce timer schedules one tick that runs three searchers in parallel:

```
query "cds annotations"
      │
      ├─► GET /search/SearchableItems?$search=cds+annotations&$top=6&$filter=taskType eq 'TUTORIAL'
      │    └─► TUTORIALS: [Tutorial rows with (title, primaryTag · Nmin) hint]
      │
      ├─► GET /graph/PublishedConcepts?$search=cds+annotations&$top=6&$select=slug,name,description
      │    └─► CONCEPTS: [{label: name, hint: description (truncated 60ch), run: nav → /concepts/<slug>/}]
      │
      └─► POST /graph/searchKG  body: {term, maxConcepts: 5, maxTutorials: 5}
           └─► KNOWLEDGE GRAPH: two sub-shapes concatenated:
                • concept hits not already in CONCEPTS list (dedupe by slug),
                  href /concepts/<slug>/, hint "via KG · score 0.NN" (2dp)
                • tutorial hits (from KG walk, not just $search),
                  href /tutorials/<slug>, hint "via KG · teaches <concept-name>"
                  (where <concept-name> is the top-scoring concept edge that
                  surfaced this tutorial; falls back to "via KG" if unknown)
```

**Query length < 2**: all three result lists cleared. Static groups only.

**Ordering** — inside each group, backend rank order preserved. No cross-group ranking.

**Dedupe** — concept-slug and tutorial-slug dedupe happens client-side in the `searchKG` post-processor. If a slug already appears in the higher-priority group (CONCEPTS or TUTORIALS), drop it from the KG group.

**Race handling** — each searcher tags its result set with the query string that produced it. When the response lands, if `query.value !== responseQuery`, discard. Prevents a slow in-flight response from clobbering newer keystrokes. Applied uniformly to all three searchers (existing tutorial searcher gains this too — small drive-by fix).

**Cross-document View Transitions** — CONCEPTS and KG tutorial rows render as `<a href data-vt-card="navigator">` (same as tutorial rows) so `startViewTransition` picks them up on click.

## Error handling

| Failure | Palette behavior |
|---|---|
| `/graph/PublishedConcepts` returns non-2xx | CONCEPTS group hidden; other groups unaffected |
| `/graph/searchKG` returns non-2xx | KNOWLEDGE GRAPH group hidden; other groups unaffected |
| `searchKG` handler throws internally | Handler catches at top level, returns `{concepts:[], tutorials:[]}`; client sees 200 with empty arrays → group hidden. Never a 5xx to a curious keystroke. |
| All three fail | Existing "No matches." branch unchanged |
| One searcher slow (>3s) | Client-side `AbortController` fires; that group stays empty, others render as they arrive |
| Embed client throws inside `searchKG` handler | Handler soft-falls-back to `PublishedConcepts $search` on the raw term (concepts only, empty tutorials) — resilience escape hatch |

**Observability** — three client-side metrics via the existing `metrics` module: `cmd_palette_concept_search_ms`, `cmd_palette_kg_search_ms`, `cmd_palette_search_fail_total{source=…}`.

## Testing strategy

### Unit (fast, no HANA, no CAP boot)

1. **`hugo-apps/src/cmd-palette/actions.test.ts`** — extended:
   - Three new EXPLORE entries exist by `id`, have `group: 'explore'`, `run` navigates to the expected href.
   - Keyword coverage: `fuzzyMatch(…, 'devtoberfest')` returns the entry, etc.
   - Insertion position: `explore-concepts` sits between `explore-connect` and `explore-knowledge-graph`.

2. **`hugo-apps/src/cmd-palette/CommandPalette.test.ts`** — new, ~120 lines, vitest + happy-dom + `@vue/test-utils`:
   - Mount with `open: true`, mock `globalThis.fetch` by URL.
   - Type `'cds'`, wait for debounce, assert five group headings render in order, dedupe works, arrow-key nav walks all five groups, Enter navigates.
   - Race-condition test: fire two fetches synchronously, older resolves last, assert older discarded.
   - Empty-state test: all three return empty → "No matches." rendered.

3. **`test/srv/search-kg-handler.test.js`** — new:
   - Handler returns `{concepts, tutorials}` shape.
   - Mock `../on-demand-enqueue.js` and assert `.not.toHaveBeenCalled()` — enforces the no-enqueue guarantee.
   - Fail-open path: mock embed client to throw → returns `{concepts:[], tutorials:[]}`.
   - Timeout path: mock `topConceptsByCosine` to hang 4s → handler aborts and returns empty.

### Hybrid (real HANA via `cds bind`)

4. **`test/hybrid/search-kg.hybrid.test.js`** — new:
   - `POST /graph/searchKG` with an unauthenticated agent returns 200 (public).
   - Known-populated seed term (`"cap"`) returns ≥1 concept and ≥1 tutorial.
   - Garbage seed (`"xyzqwertyuiop123"`) returns empty arrays **AND** the on-demand-drain queue shows no new row after the call — enqueue guarantee verified end-to-end.
   - `GET /graph/PublishedConcepts?$search=cds` returns rows anonymously.

### Smoke

5. Extend `test/smoke/` — one `⌘K palette` case: fetch the palette bundle, sanity-parse the built entries, curl the two public endpoints and assert 200 + expected JSON shape.

### Manual QA before PR review

- Open `⌘K` on `/`, on a tutorial page, on `/concepts/abap-cds-annotations/`; verify five groups render.
- Type `'slt'` → CONCEPTS probably empty, KG group finds `sap-landscape-transformation` via cosine — escape-hatch claim validated.
- Type garbage 15-char query → all dynamic groups empty gracefully, no console errors, no 5xx in `cf logs tutorials-srv --recent`.

## Out of scope

- **Aliases on `Concepts`** — deferred to a follow-up issue. Cosine-based KG group is the acronym escape hatch until then.
- **KG search authorization gating** — public read stays public; no per-role KG surface.
- **PageRank / community weighting on `searchKG` results** — reuse plain cosine + edge-walk for v1; may be revisited once nightly PageRank sidecars stabilize.
- **Persisting recent palette queries** — not this PR.
- **New icons in the SAP icon font** — reuse existing icons (`bullet-text`, `org-chart`).

## Follow-ups to file

1. **Add `Concepts.aliases` (or `ConceptAliases` child entity) for synonym matching in ⌘K.** Schema change + one-off backfill via AI Core (~$5 credits) + `$search` scope widening on the palette query.
2. **Palette recent-queries persistence.** LocalStorage-backed most-recent, most-clicked; renders as a small "RECENT" group above ACTIONS when the query is empty.

## Related files

- `hugo-apps/src/cmd-palette/actions.ts`
- `hugo-apps/src/cmd-palette/CommandPalette.vue`
- `hugo-apps/src/cmd-palette/actions.test.ts`
- `srv/knowledge-graph-service.cds`
- `srv/knowledge-graph-service.js`
- `srv/lib/kg/_search-fetches.js`
- `srv/lib/kg/concept-embedding-query.js`
- `srv/lib/kg/joule-tool-expand-concepts.js` (reference implementation, not modified)
- `srv/lib/kg/on-demand-enqueue.js` (must NOT be imported by the new handler)
- `db/knowledge-graph.cds` (Concepts / PublishedConcepts)
- `hugo/content/concepts/` (per-concept pages `<slug>.md` — already generated)
- `hugo/content/devtoberfest/` and `hugo/content/developer-advocates/` (already exist)
