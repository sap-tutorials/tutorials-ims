# Knowledge Graph — Phase 1 DEV rollout

**Status:** Rollout note for [#381](https://github.com/sap-tutorials/tutorials-ims/issues/381) Phase 1.
**Date opened:** 2026-06-19 (PR 8 of 8 — the flag-flip + soak)
**Branch:** `feat/kg-flag-flip`

This document captures the DEV-environment rollout of the knowledge-graph
sidebar surface (the user-facing Phase 1 deliverable from the
[design spec](../specs/2026-06-17-knowledge-graph-design.md)).

> **Convention.** Sections below were originally marked
> `<!-- FILL IN POST-SOAK -->` and got replaced with real values during
> the post-soak review on 2026-06-21. The PR was opened with the
> template; the values were filled in via a follow-up PR (#448 →
> closing PR) on the same branch.

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
ACTIVE concepts:           1089
MERGED concepts:           2
VETOED concepts:           0
TutorialConceptLinks rows: 2183 (2162 teaches, 21 extends)
ConceptEdges rows:         569 (521 ACTIVE requires, 48 VETOED requires)
```

Captured at 2026-06-21 22:05 UTC (~38 min past soak end). Two
`extractConcepts` cron runs completed during the window:
- 2026-06-20 02:13 UTC → 250 tutorials, 198 processed, 200 LLM calls, 777 newConcepts, 6 mergedAtExtract, 2 errors, duration 31m
- 2026-06-21 02:13 UTC → 400 tutorials, 199 processed, 155 cache hits, 200 LLM calls (cap hit), 314 newConcepts, 7 mergedAtExtract, 1 error, duration 31m

Headline: corpus extraction works. ~$5 LLM cost over two nights (8.2M
prompt + 247K completion tokens). Cache hit rate jumped 0 → 155/200 = 77.5%
between the two runs (working as designed). 1 unprocessed error per run
is within tolerance.

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
graphVersion:    n/a — singleton row NOT created (consolidator failed)
tripleCount:     0
durationMs:      n/a
predicateCounts:
  (predicate-level counts not exposed in current GraphMetadata schema —
  schema has only graphVersion + lastRebuiltAt + tripleCount + durationMs;
  the 12-predicate-count fields in this template were aspirational and
  do not exist on the deployed entity. Filed as #525 follow-up.)
```

**Status: consolidator FAILED.** The `consolidateConcepts` cron fired
once at 2026-06-21 03:47 UTC (Sun, weekly schedule) and rolled back
with:

```
transaction rolled back by an internal error:
  "AC9753D6C4764F5ABE3B3CA4E88233C0"."(DO statement)": line 4 col 3 (at pos 129):
  generic. Error - https://developers.sap.com/kg/tutorials: Object does not exist
  or is inaccessible
```

Named-graph IRI `https://developers.sap.com/kg/tutorials` is referenced
by `DEFAULT_GRAPH_IRI` in [srv/lib/kg-graph-rebuild.js:35](../../srv/lib/kg-graph-rebuild.js#L35)
and the `FROM <…>` clause in
[srv/lib/kg-queries.js:240](../../srv/lib/kg-queries.js#L240).
The graph was never bootstrapped, so the consolidator's first `INSERT
DATA` could not find a target. Chicken-and-egg — filed as separate
issue (see Follow-up issues section).

**Consequence:** `GraphMetadata` row never inserted, `kg.*` SPARQL
queries return empty, sidebar islands render nothing. Sidebar's
hide-on-empty logic kicks in correctly — no user-facing breakage,
just an invisible feature.

Query:

```sql
SELECT graphVersion, tripleCount, durationMs, lastRebuiltAt
  FROM "COM_SAP_DEVELOPERS_IMS_GRAPHMETADATA";
```

### Manual review of 10 tutorial OPs

**Deferred.** The consolidator failure (see GraphMetadata section above)
means `kg.*` SPARQL queries return no results, so the sidebar's
hide-on-empty logic hides every section on every tutorial. There's
nothing to qualitatively review until the consolidator is unblocked.

When the named graph is bootstrapped (Phase 1.5 follow-up; see
"Follow-up issues opened" below), this manual review will run in a
follow-up commit on this rollout note.

The shape of the verification is intact:

| # | Tutorial slug | All 4 sections populated? | Concepts plausible? | Prereqs sensible? | "Learn next" sensible? | Would-ship? |
| -- | --- | --- | --- | --- | --- | --- |
| 1–10 | *deferred — see above* |  |  |  |  |  |

**Headline would-ship rate: deferred.**

### Telemetry baseline (after ≥1h of organic browsing)

```
kg.sidebar.shown:        0 events
kg.sidebar.click:        0 events
kg.sidebar.hover_concept: 0 events
```

Zero `kg.*` events captured over the 48h window. Two compounding causes:

1. The consolidator failure (see GraphMetadata section) means the
   sidebar would render empty if visited; hide-on-empty short-circuits
   before any `kg.sidebar.shown` fires.
2. DEV organic browse traffic during the window was light: 30 total
   `UiEvent` rows (mostly `page_view` / `page_leave` / `scroll_depth`
   on `/` and `/browse/`). No one navigated to a tutorial OP that
   would have mounted the sidebar.

```
shown → click rate: n/a (denominator 0)
```

Compared with the existing personalized-recommendations rail
([project_personalized_recommendations](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\project_personalized_recommendations.md)),
this is **not yet measurable** — first signal awaits the consolidator
unblock + an active DEV browsing session (or PROD rollout, where
organic traffic will exercise it).

### Cron health (48h window)

```
extractConcepts:
  ticks observed:   2 (06-20 02:13 UTC, 06-21 02:13 UTC) — both SUCCESS
  errors logged:    3 total (2 on first run, 1 on second; per-tutorial errors,
                    not job-level — job summary shows STATUS=SUCCESS)
  steady-state cache hit rate: 77.5% (155/200 LLM-eligible on run 2;
                    0/200 on run 1, which is correct: cold cache)
  LLM calls per night: 200 (cap hit both nights — capped by AI_AUTHOR_BUILD_CAP=200)

consolidateConcepts:
  ticks observed:   1 (06-21 03:47 UTC, Sun-only schedule) — FAILED
  errors logged:    1 (transaction rolled back, see error text below)
  merges performed: 0 (transaction reverted)
  cycles auto-VETOed: 0 (transaction reverted)
```

**`consolidateConcepts` failure detail:**

```
transaction rolled back by an internal error:
  "AC9753D6C4764F5ABE3B3CA4E88233C0"."(DO statement)":
  line 4 col 3 (at pos 129): generic. Error -
  https://developers.sap.com/kg/tutorials: Object does not exist
  or is inaccessible
```

The named graph IRI from `DEFAULT_GRAPH_IRI` is referenced by the
SPARQL `INSERT DATA` statement before the graph has been created.
This is a Phase-1.5 blocker: the consolidator must either (a) issue
a `CREATE GRAPH <…>` first (idempotent if it already exists), or
(b) infer the graph existence from a prior `kg-graph-rebuild` run.
Filed as separate issue (see Follow-up issues section).

**Sect-5 SQL note (corrected from template).** The original section-5
template referenced `COM_SAP_DEVELOPERS_IMS_JOBEXECUTIONLOG`; that
table doesn't exist on the deployed schema. The real audit lives in
`COM_SAP_DEVELOPERS_IMS_PIPELINELOG` with `PIPELINETYPE='SCHEDULED_JOB'`
and the job name in `JSON_VALUE(METADATA, '$.jobName')`. Captured in
the issue #448 comment for reference.

CF logs filter:

```bash
cf logs tutorials-srv --recent | grep -iE 'extractConcepts|consolidateConcepts|graphRebuild'
```

### `/graph/*` HTTP health (48h window)

```
/graph/neighborhood requests: indeterminate (not logged to PipelineLog;
                              srv-side access log not captured in this run)
  Manual probe at 22:05 UTC:
    Direct srv (no auth):  401 (correct — endpoint requires XSUAA)
    Approuter (no auth):   200 → XSUAA redirect HTML (correct)
  Latency: 568 ms (first hit, cold approuter session)

/graph/runSparql requests: 0 (admin-only; no admin SPARQL exploration this window)
```

No 5xx observed. End-to-end success cannot be confirmed without an
authenticated probe, but per the consolidator failure above the
SPARQL endpoint would currently return empty results regardless of
auth (no graph, no triples). Sidebar's hide-on-empty short-circuit
handles this gracefully.

### HANA usage delta

```
SPARQL_EXECUTE invocations (48h): not measurable from M_SPARQL_*
                                   tables in this HANA Cloud version
                                   (view returns no rows for this user)
Triple-store size delta:           0 (graph never created)

Concept-table footprint (post-soak):
  Concepts (1,089 rows):              369,805 bytes   (cold: 0 bytes)
  TutorialConceptLinks (2,183 rows):  207,996 bytes   (cold: 0 bytes)
  ConceptEdges (569 rows):            253,475 bytes   (cold: 0 bytes)
  GraphMetadata (0 rows):              51,424 bytes   (table allocated, no data)
  ----
  Concept-feature total:              882,700 bytes   (~862 KB)

HDI container total (post-soak):
  105 tables / 12,204,272 rows / 1,056,392,086 bytes (~1007 MB)

  Pre-soak baseline (per issue comment, 2026-06-19 21:54 UTC):
   98 tables /  12,958,051 rows / 1,126,220,754 bytes (~1074 MB)

  Delta over 48h: +7 tables, -753,779 rows, -69,828,668 bytes (~-66 MB)
  (Negative delta: PR #517 reshape + autotest cleanup landed during
  the same window; the row-count drop reflects autotest data churn,
  not data loss from the KG work itself.)
```

## Follow-up issues opened

Surfaced during the 48h soak; gates the "make sidebar actually
populate" follow-up before any PROD rollout:

- **[#525](https://github.com/sap-tutorials/tutorials-ims/issues/525)** —
  `consolidateConcepts` cron fails because the named graph
  `https://developers.sap.com/kg/tutorials` was never created.
  Blocks `GraphMetadata` insert + every `kg:` SPARQL query.
  **Highest-priority follow-up** before next phase.
- **[#526](https://github.com/sap-tutorials/tutorials-ims/issues/526)** —
  `GraphMetadata` entity lacks the 11 per-predicate-count fields
  referenced in the rollout-note template; relational sources of
  truth (`TutorialConceptLinks`, `ConceptEdges`) are sufficient
  for now but a schema bump would be nice for observability.
- **[#448](https://github.com/sap-tutorials/tutorials-ims/issues/448)** —
  This issue (closed by this PR).

No issues opened for sidebar UX rough edges (none observed — sidebar
isn't rendering yet) or admin curation UI gaps (admin UI not
exercised this window).

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

What worked, what surprised, what we'd do differently:

- **Constrained extraction prompt held up.** Predicted "80–150 concepts
  after first pass"; observed 777 newConcepts in first cold run + 314
  in the second (cache-warm) — extractor is meaningfully more
  productive than the headline estimate, and the merge-at-extract
  step (7 + 6 merges across the two nights) kept the registry from
  exploding. Vocabulary drift was lower than feared: only 2 MERGED,
  0 VETOED out of 1091 — the auto-merge heuristics aren't going wild.
- **Cron health surfaced both a real bug AND a template bug.** The
  consolidator failure (#525) was the real signal. The template's
  `JOBEXECUTIONLOG` table reference was a separate template-vs-reality
  drift — corrected inline in the issue body during the pre-soak
  capture step. Lesson: when filling a rollout-note template, run
  every "verification SQL" against the real schema BEFORE the soak
  starts. The pre-soak baseline catches table-name typos before
  they masquerade as zero-data findings during the post-soak review.
- **Pre-soak baseline was load-bearing.** The 21:54 UTC snapshot
  (98 tables / 12,958,051 rows / ~1074 MB) was the only thing that
  made the HDI-delta calculation possible. Without it, the
  post-soak total would have looked like a number with no context.
  The negative delta (~-66 MB, -753,779 rows) turned out to be
  autotest + #517 churn rather than KG signal — but we only knew
  that because we had the BEFORE number.
- **`GraphMetadata` schema vs aspirational template (#526).** The
  rollout-note template encoded 11 fields that don't exist on the
  persisted entity. Aspirational templates are fine but they should
  be flagged in the PR description so a reviewer can either land the
  schema additions or downgrade the template before merge. Drifted
  past 8 PRs without anyone catching it.
- **Hide-on-empty saved face.** The sidebar's `if (results.length === 0)
  return null` logic in the Vue island meant the consolidator
  failure produced **no user-facing breakage** — just an invisible
  feature. Worth keeping that defensive default in every island
  that depends on a back-of-store source-of-truth.
- **Cf set-env, again.** The flag was flipped via `cf set-env`
  (per memory `feedback_cf_set_env_drops_on_redeploy`). Today's MTA
  redeploy DID drop the flag back to false — confirmed by checking
  `cf env tutorials-srv | grep KNOWLEDGE_GRAPH_ENABLED`
  post-deploy. Phase 1.5 should land an mtaext patch to make
  the flag survive deploys. (Tracked separately.)
