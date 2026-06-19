# Knowledge Graph — Phase 1 DEV rollout

**Status:** Rollout note for [#381](https://github.com/sap-tutorials/tutorials-ims/issues/381) Phase 1.
**Date opened:** 2026-06-19 (PR 8 of 8 — the flag-flip + soak)
**Branch:** `feat/kg-flag-flip`

This document captures the DEV-environment rollout of the knowledge-graph
sidebar surface (the user-facing Phase 1 deliverable from the
[design spec](../specs/2026-06-17-knowledge-graph-design.md)).

> **Convention.** Sections below marked `<!-- FILL IN POST-SOAK -->` get
> replaced with real values during/after the 48h DEV soak. The PR is opened
> with the template; the placeholders are filled in either by amending the
> commit before merge or in a follow-up commit on the same branch.

## What shipped

The eight PRs that landed Phase 1 of the knowledge graph:

| PR | Scope | Merged |
| -- | ----- | ------ |
| [#401](https://github.com/sap-tutorials/tutorials-ims/pull/401) | PR 1 — Day-1 spike: HANA KGE access patterns | ✅ |
| [#403](https://github.com/sap-tutorials/tutorials-ims/pull/403) | PR 2 — Data model + HDI deploy + `.hdbgrants` flow | ✅ |
| [#407](https://github.com/sap-tutorials/tutorials-ims/pull/407), [#408](https://github.com/sap-tutorials/tutorials-ims/pull/408), [#411](https://github.com/sap-tutorials/tutorials-ims/pull/411), [#413](https://github.com/sap-tutorials/tutorials-ims/pull/413) | PR 2 deploy unblockers (comment-keys / cups tags / per-channel split / docs alignment) | ✅ |
| [#416](https://github.com/sap-tutorials/tutorials-ims/pull/416) | PR 3 — Extraction pipeline (`extractConcepts` cron + `kg:reextract` CLI) | ✅ |
| [#419](https://github.com/sap-tutorials/tutorials-ims/pull/419) | PR 4 — Consolidator + graph projection (`consolidateConcepts` cron + `graphRebuild`) | ✅ |
| [#427](https://github.com/sap-tutorials/tutorials-ims/pull/427) | PR 5 — `KnowledgeGraphService` query layer at `/graph` | ✅ |
| [#439](https://github.com/sap-tutorials/tutorials-ims/pull/439) | PR 6 — Admin concept-review UI at `/admin-ui/#concepts-display` | ✅ |
| [#441](https://github.com/sap-tutorials/tutorials-ims/pull/441) | PR 7 — Vue 3 sidebar island on tutorial OPs (viewport-aware mount) | ✅ |
| **(this PR)** | PR 8 — DEV flag-flip + soak observations + rollout note | 🟡 in progress |

Surface delivered:

- **End-user**: Vue 3 sidebar on every tutorial OP showing four sections —
  *This tutorial teaches*, *Prerequisites you might want first*,
  *Tutorials covering related concepts*, *What to learn next*. Lazy-loaded
  via IntersectionObserver, ETag-cached in `sessionStorage`,
  viewport-aware (right-rail desktop, after-Discussion mobile),
  hide-on-empty.
- **Admin**: `/admin-ui/#concepts-display` — Fiori Elements list-report
  + object-page over `Concepts` with inline-edit on name/description,
  per-row Veto/Merge actions, page-level Preview Merges + Trigger
  Graph Rebuild.
- **Backend**: extraction cron (nightly 02:13 UTC), consolidation +
  graph rebuild cron (weekly Sunday 03:47 UTC), `/graph/neighborhood`
  4-way SPARQL UNION, admin-only `/graph/runSparql` for raw SPARQL
  inspection.

## Pre-flight verification (executed before flag-flip)

- [ ] All 8 PRs merged to `main` ✅ (#401 + #403 + #407 + #408 + #411 +
      #413 + #416 + #419 + #427 + #439 + #441)
- [ ] Latest `main` deployed to DEV via `mbt build && cf deploy …`
- [ ] `cf services` shows `tutorials-kg-grantor` + `tutorials-kg-grantor-qa`
      bound to the deployers (per
      [kg-grantor-setup.md](../../developers/operations/kg-grantor-setup.md))
- [ ] Spike probe (PR 1) returns exit 0 against the deployed runtime user:
      `cds bind --exec --profile hybrid -- node scripts/spike/kg-probe.cjs`
- [ ] At least one extractConcepts run has populated the registry —
      verified by `SELECT COUNT(*) FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
      WHERE STATUS='ACTIVE'` (expected ~80–150 after first full pass)
- [ ] At least one consolidateConcepts run has populated the named graph —
      verified by `GraphMetadata.tripleCount > 0`

## Soak observations

### Concept registry (post-first-extraction-pass)

```
ACTIVE concepts:           <!-- FILL IN POST-SOAK -->
MERGED concepts:           <!-- FILL IN POST-SOAK -->
VETOED concepts:           <!-- FILL IN POST-SOAK -->
TutorialConceptLinks rows: <!-- FILL IN POST-SOAK -->
ConceptEdges rows:         <!-- FILL IN POST-SOAK -->
```

Query:

```sql
SELECT 'concepts.' || STATUS AS k, COUNT(*) AS n
  FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
  GROUP BY STATUS
UNION ALL
SELECT 'links.' || PREDICATE, COUNT(*)
  FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS"
  GROUP BY PREDICATE
UNION ALL
SELECT 'edges.' || STATUS || '.' || PREDICATE, COUNT(*)
  FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES"
  GROUP BY STATUS, PREDICATE;
```

### Graph projection (post-first-consolidation-pass)

```
graphVersion:    <!-- FILL IN POST-SOAK -->
tripleCount:     <!-- FILL IN POST-SOAK -->
durationMs:      <!-- FILL IN POST-SOAK -->
predicateCounts:
  kg:teaches         <!-- N -->
  kg:requires        <!-- N -->
  kg:relatedTo       <!-- N -->
  kg:extends         <!-- N -->
  kg:partOf          <!-- N -->
  kg:taggedWith      <!-- N -->
  kg:aboutProduct    <!-- N -->
  kg:inCategory      <!-- N -->
  kg:coCompletedWith <!-- N -->
```

Query:

```sql
SELECT graphVersion, tripleCount, durationMs, lastRebuiltAt
  FROM "COM_SAP_DEVELOPERS_IMS_GRAPHMETADATA";
```

### Manual review of 10 tutorial OPs

Picked from a balanced mix of products + difficulty levels.

| # | Tutorial slug | All 4 sections populated? | Concepts plausible? | Prereqs sensible? | "Learn next" sensible? | Would-ship? |
| -- | --- | --- | --- | --- | --- | --- |
| 1 | <!-- slug --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> |
| 2 | <!-- slug --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> |
| 3 | <!-- slug --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> |
| 4 | <!-- slug --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> |
| 5 | <!-- slug --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> |
| 6 | <!-- slug --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> |
| 7 | <!-- slug --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> |
| 8 | <!-- slug --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> |
| 9 | <!-- slug --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> |
| 10 | <!-- slug --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> | <!-- y/n --> |

**Headline would-ship rate: <!-- N/10 -->.**

Notes:

<!-- One-line observation per tutorial that scored "would-ship: no" -->

### Telemetry baseline (after ≥1h of organic browsing)

```
kg.sidebar.shown:        <!-- N events -->
kg.sidebar.click:        <!-- N events -->
kg.sidebar.hover_concept: <!-- N events -->
```

Query:

```sql
SELECT eventType, COUNT(*) AS n
  FROM "COM_SAP_DEVELOPERS_IMS_UIEVENT"
  WHERE eventType LIKE 'kg.%'
  GROUP BY eventType;
```

CTR signal:

```
shown → click rate: <!-- % -->
```

Compared with the existing personalized-recommendations rail
([project_personalized_recommendations](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\project_personalized_recommendations.md)),
this is <!-- higher / lower / similar --> — first signal that the graph
adds <!-- meaningful / marginal / no --> incremental discovery value.

### Cron health (48h window)

```
extractConcepts:
  ticks observed:   <!-- N -->
  errors logged:    <!-- N -->
  steady-state cache hit rate: <!-- % -->
  LLM calls per night: <!-- avg N (cap = 200) -->

consolidateConcepts:
  ticks observed:   <!-- 1 expected (weekly) -->
  errors logged:    <!-- N -->
  merges performed: <!-- N -->
  cycles auto-VETOed: <!-- N -->
```

CF logs filter:

```bash
cf logs tutorials-srv --recent | grep -iE 'extractConcepts|consolidateConcepts|graphRebuild'
```

### `/graph/*` HTTP health (48h window)

```
/graph/neighborhood requests: <!-- N -->
  2xx:  <!-- N -->
  4xx:  <!-- N (validation rejections) -->
  5xx:  <!-- N -->
  cache hit (304): <!-- N -->

/graph/runSparql requests: <!-- N (admin only) -->
  2xx:  <!-- N -->
  4xx:  <!-- N -->
  5xx:  <!-- N -->
```

### HANA usage delta

```
SPARQL_EXECUTE invocations (48h):  <!-- N -->
Triple-store size delta:           <!-- N triples added/removed -->
```

Query:

```sql
SELECT * FROM "M_SPARQL_STATEMENT_STATISTICS"
  WHERE LAST_EXECUTION_TIMESTAMP > ADD_DAYS(CURRENT_TIMESTAMP, -2);
```

## Follow-up issues opened

<!-- FILL IN POST-SOAK — link to any GitHub issues filed for: -->

- <!-- bad concept extractions caught during manual review -->
- <!-- UX rough edges in the admin curation UI -->
- <!-- gaps in the sidebar's responsive layout -->

Also tracking against [#381](https://github.com/sap-tutorials/tutorials-ims/issues/381):

- Phase 2 — Joule learning-path generator (`pathBetween()` named query
  scaffold already in place from PR 5)
- Phase 3 — `/explore/` graph viz + concept landing pages
- LRU cache wiring for `neighborhood` results (deferred from PR 5)
- `tutorialTeachesMap` graph-version-keyed caching (deferred from PR 5)

## Production rollout

After this PR merges, prod rollout is a config-only change:

```bash
cf target -o <prod-org> -s prod   # confirm with Tom first
cf set-env tutorials-srv KNOWLEDGE_GRAPH_ENABLED true
cf restart tutorials-srv
```

The prod cron jobs need a full corpus pass before the sidebar populates;
budget ~$5 LLM cost on first full extraction. Schedule the flip for a
Sunday evening so the consolidator runs that night and the registry is
populated by Monday morning.

After flag-flip on prod:

- [ ] Telemetry baseline captured (separate from DEV)
- [ ] HANA usage measured
- [ ] CTR compared with the existing personalized-recommendations rail
      to validate the spec's "graph adds incremental signal" hypothesis

## Lessons captured

<!-- FILL IN POST-SOAK or after first prod week — what worked, what surprised us, what we'd do differently in Phase 2 -->

- <!-- e.g. "constrained extraction prompt produced 80–150 concepts as predicted; vocabulary drift was lower than feared" -->
- <!-- e.g. "PR 1 spike was the highest-leverage step in the plan; 5 PRs of foot-gun saved" -->
- <!-- e.g. "bottlenecks turned out to be X / Y / Z" -->
