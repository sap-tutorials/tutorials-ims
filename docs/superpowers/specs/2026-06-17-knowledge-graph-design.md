# Knowledge Graph of Tutorials — Design Spec

**Status:** Draft for review
**Tracking issue:** [sap-tutorials/tutorials-ims#381](https://github.com/sap-tutorials/tutorials-ims/issues/381)
**Date:** 2026-06-17
**Author:** Tom Jung (with Claude)

## Summary

Build an AI-extracted knowledge graph over the tutorial corpus, projected into SAP HANA Cloud's Knowledge Graph Engine (RDF triple store, queried via SPARQL), and surface it on tutorial Object Pages as a four-section discovery sidebar. Phase 1 ships the graph backend + the sidebar + an admin concept-review tool. Phases 2 (Joule learning-path generator) and 3 (`/explore/` graph viz) are deferred but the service shape accommodates them so they land without backend churn.

The graph is built by two cron jobs in `srv/jobs/`: a nightly per-tutorial concept extractor (content-hash-keyed, mirrors the [#208 AI-quiz cache](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\project_208_ai_authored_quizzes_shipped.md) pattern) and a weekly consolidator that merges near-duplicate concepts and rebuilds the HANA KGE named graph. Canonical state lives in three new CDS entities; the triple store is a *projection*, not source-of-truth.

This is also a deliberate showcase of HANA Cloud's Knowledge Graph Engine — an under-promoted multi-model capability ([the multi-model tutorial](https://developers.sap.com/tutorials/hana-dbx-multi-model.html) is one of the few public touchpoints). The Phase 1 flagship SPARQL query — a 4-way UNION inside `neighborhood(slug)` — exercises multi-hop property paths (`teaches → requires → teaches`) that are awkward in plain SQL and elegant in SPARQL.

## Spike findings (PR 1)

The day-1 spike (PR 1 of the implementation plan, [#401](https://github.com/sap-tutorials/tutorials-ims/pull/401)) disproved two assumptions baked into earlier drafts of this spec:

1. **Access path.** `db.run("SPARQL EXECUTE '<query>'")` (and the documented variants `EXECUTE 'SPARQL <q>'` / `EXECUTE 'SPARQL <q>' AS SPARQL`) are rejected by the HANA SQL parser before reaching any SPARQL engine. The verified canonical path is the stored procedure `CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)` invoked over the same `cds.connect.to('db')` connection — wrapped in a `DO BEGIN … END` block to surface the OUT params reliably across cds-driver versions.
2. **Privilege delivery.** The runtime user MUST receive `SPARQL QUERY` and `SPARQL UPDATE` via the canonical `@sap/hdi-deploy` flow — `.hdbgrants` artefact + grantor user (user-provided service) + `default_access_role`. Direct `GRANT … TO <runtime-user>` is the anti-pattern: it does not survive HDI redeploys.

Full write-up — including the `sparqlCall` wrapper, the disproven syntax, the HDI grants flow, and probe behaviour — is in [docs/developers/architecture/hana-kge-access.md](../../developers/architecture/hana-kge-access.md). All references below are aligned with those findings.

## Goals

1. **End-user discovery first.** A new sidebar on tutorial Object Pages helps users find prerequisites, related tutorials, and what-to-learn-next. Behind feature flag `KNOWLEDGE_GRAPH_ENABLED` (default OFF) until extraction quality is validated against real eyeballs.
2. **AI builds the graph.** Concepts are extracted by an LLM from tutorial markdown — admins curate (veto / merge / rename), they don't author. This both reduces operator burden and provides a second showcase ("the AI assembles the graph; HANA KGE answers the questions"). Mirrors author-self-service preference ([[feedback_author_self_service]]).
3. **HANA KGE is a projection.** Canonical state lives in CDS-managed tables (`Concepts`, `TutorialConceptLinks`, `ConceptEdges`); the triple store is rebuilt from these on every concept change. Schema migrations, audit logging, draft semantics, and rebuild-from-scratch all "just work."
4. **Phase 1 surface the architecture end-to-end.** Sidebar is small but proves: extraction job runs, registry persists, KGE projects correctly, named SPARQL queries answer correctly, admin can curate. Phase 2/3 add surfaces, not new infrastructure.
5. **Bounded build cost.** Hard cap (`KG_EXTRACT_BUILD_CAP=200` LLM calls per job run) plus content-hash cache means steady-state cost is ~$1-2/week.

## Non-Goals

- **Joule learning-path generator** — Phase 2. Service-shape stubs (`pathBetween`, `conceptsForUser`) ship in Phase 1 so Phase 2 needs no contract change.
- **`/explore/` graph viz** — Phase 3. Force-directed (or constellation-style) interactive viz; biggest scope, deferred until extraction quality is proven.
- **Concept landing pages** (`/concepts/<slug>/`) — Phase 3. Concept clicks in the Phase 1 sidebar are no-op.
- **Manual concept creation in admin** — never. The showcase narrative is "AI builds the graph"; admins curate, not author.
- **Cross-corpus federation** (e.g. SAP Help portal RDF alongside the tutorials graph) — interesting future, not now.
- **Multi-language extraction** — corpus is English-only ([[project_developers_locales]]).
- **Real-time graph updates** — graph is rebuilt per cron, not on every tutorial publish. Eventual consistency on a daily cadence.
- **Embedding clustering as the extraction strategy** — considered (option B in brainstorming Q5); rejected in favour of constrained per-tutorial extraction.

## Approach

**Approach C from brainstorming Q5 — constrained per-tutorial extraction with weekly consolidation.**

For each tutorial, the extractor LLM call receives the tutorial markdown *plus* the current concept registry (slug + name, ACTIVE only). The prompt instructs: "use existing concept slugs when they fit; only propose new ones for genuine gaps." This naturally bounds vocabulary growth — the registry stabilizes around ~80–150 concepts after the first full corpus pass, with the long tail handled by the weekly consolidator (embedding-similarity merge of near-duplicates).

Two alternatives considered and rejected:

- **A — Free per-tutorial extraction with post-hoc dedupe.** Simpler prompt, no constraint. Risk: vocabulary drift across batches (`cap-handler-functions` from one tutorial, `cap-handlers` from another, `service-handlers-cap` from a third); the merge job has more to clean up. We'd still need the consolidator.
- **B — Corpus-wide embedding clustering, LLM names clusters.** More globally consistent vocabulary in one shot, but cache invalidation is hard — adding one tutorial could shift the whole clustering. Loses the per-tutorial cache that makes incremental runs cheap.

(C) is the best of both: per-tutorial caching (like A) + coherent vocabulary (like B), at the cost of one extra moving part (the registry-aware prompt + the consolidator).

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                        Build / extract loop                     │
│  Tutorials (HANA) ──► extractConcepts cron ──► Concepts (HANA)  │
│       │                  (per-slug, hash-keyed)         │       │
│       │                                                 │       │
│       │              consolidateConcepts cron           │       │
│       │              (weekly: merge near-duplicates)    │       │
│       │                                                 │       │
│       └─────► graphRebuild step ──► HANA KGE triple store       │
│              (project CDS + concepts → RDF)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Query layer (CAP service)                   │
│  KnowledgeGraphService (@path: /graph)                          │
│   • function neighborhood(slug)         (used by sidebar)       │
│   • function pathBetween(from, to)      (Phase 2 stub)          │
│   • function conceptsForUser(userId)    (Phase 2 stub)          │
│   • action runSparql(query)             (admin-only, raw)       │
│   • action mergeConcepts/vetoConcept/triggerGraphRebuild        │
│  All named queries → SPARQL → HANA KGE → JSON                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Phase 1 surface: tutorial sidebar              │
│  Vue 3 island in hugo-apps/src/related-graph/                   │
│  Mounts on tutorial Object Page; hits /graph/neighborhood       │
│  Sections: teaches / prerequisites / shared / what-to-learn-next│
│  Behind feature flag KNOWLEDGE_GRAPH_ENABLED (default OFF)      │
│  Hide-on-empty for tutorials with no concepts yet               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              Phase 1 admin: concept review surface              │
│  /admin-ui/#concepts-display — Fiori Elements list page over    │
│  Concepts entity. Edit name/description, merge duplicates,      │
│  veto (soft-delete), trigger graph rebuild.                     │
└─────────────────────────────────────────────────────────────────┘
```

### Key architectural decisions

1. **HANA KGE is a projection of CDS-managed state.** The canonical state is three new CDS entities (`Concepts`, `TutorialConceptLinks`, `ConceptEdges`); the triple store is rebuilt from them. This means audit-logging, change-tracking, schema-deploy and rebuild-from-empty all work normally. The KGE rebuild is idempotent: same CDS state → same triples.
2. **Two cron jobs in `srv/jobs/`, both using `job-lock.js` for distributed locking.** `extractConcepts` is per-tutorial and content-hash-keyed (mirrors [#208 AI-quiz cache](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\project_208_ai_authored_quizzes_shipped.md)). `consolidateConcepts` runs weekly and ends with a full `graphRebuild` of the named graph in HANA KGE.
3. **Named queries on the public surface, raw SPARQL admin-only.** Same security model as [`AnalyticsService.runSelectQuery`](srv/lib/analytics-sql-validator.cjs): server-validated, parameterized, easy to cache, easy to evolve. Phase 2's `pathBetween()` and `conceptsForUser()` are stubs in Phase 1 so the contract stays stable across phases.
4. **No new approuter routes for Phase 1.** Sidebar is a Vue island consumed by the existing tutorial Object Page. Admin concept review reuses `/admin-ui/`. The only new route is `/graph/*` on `tutorials-srv`. New XSUAA scope: `KnowledgeGraph.Admin`, added to the existing `Tutorial.Admin` role collection.
5. **HANA KGE access via `CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)`** over the existing `cds.connect.to('db')` connection — same connection lifecycle, same auth, no second client. Confirmed by the day-1 spike (PR 1, [#401](https://github.com/sap-tutorials/tutorials-ims/pull/401)). The wrapper uses a `DO BEGIN … END` block to reliably surface the OUT params (`response`, `headers`) across cds-driver versions. See [docs/developers/architecture/hana-kge-access.md](../../developers/architecture/hana-kge-access.md) for the authoritative reference.

### New modules

| File | Responsibility |
| ---- | -------------- |
| `db/knowledge-graph.cds` | The three new CDS entities: `Concepts`, `TutorialConceptLinks`, `ConceptEdges`. |
| `srv/knowledge-graph-service.cds` | `KnowledgeGraphService` at `/graph` — projections + named functions + admin actions. |
| `srv/knowledge-graph-service.js` | Handlers: `neighborhood`, `pathBetween` (Phase 2 stub), `conceptsForUser` (Phase 2 stub), `runSparql`, `mergeConcepts`, `vetoConcept`, `vetoEdge`, `triggerGraphRebuild`. |
| `srv/lib/kg-extract.js` | The constrained-extraction LLM call: `extractConceptsFromTutorial({ tutorialMarkdown, registry, deps })` → `{ teaches, extends, prerequisites, tokenUsage }`. Pure (LLM injected via deps); unit-testable with mock `callModel`. Mirrors the `srv/lib/code-check-llm.js` shape and reuses the same `defaultCallModel` (`@sap-ai-sdk/orchestration`). |
| `srv/lib/kg-queries.js` | The catalog of named SPARQL queries — one constant per named query (e.g. `NEIGHBORHOOD_QUERY`), with `$SLUG`-style parameter substitution and an injection guard that rejects any value containing characters outside `[a-z0-9-]`. |
| `srv/lib/kg-projection.js` | Projects CDS state into RDF triples: walks `Concepts` (status=ACTIVE), `TutorialConceptLinks`, `ConceptEdges`, plus the structural-from-CDS edges (Tutorials, Missions, Tags, etc.), emits triples in batches of ~5000 for `INSERT DATA`. |
| `srv/lib/kg-similarity.js` | Embedding similarity utilities: `cosineSim(a, b)`, `findNearDuplicates(concepts, threshold=0.92)`. Uses `srv/lib/embedding-query.js` patterns for HANA-side vector retrieval (LOB locator workaround). |
| `srv/lib/kg-cycles.js` | DFS cycle detection on `:requires` edges, returns `{ cycles: [[edgeId, ...]], weakestEdges: [edgeId, ...] }` for auto-VETO. |
| `srv/jobs/extract-concepts-job.js` | Nightly cron handler. Iterates Tutorials, hash-checks against existing `TutorialConceptLinks`, calls `kg-extract` on miss, writes Concepts/links transactionally. Honors `KG_EXTRACT_BUILD_CAP`. |
| `srv/jobs/consolidate-concepts-job.js` | Weekly cron handler. Pairwise similarity merge, cycle detection, auto-VETO, then triggers `graphRebuild`. |
| `hugo-apps/src/related-graph/RelatedGraph.vue` | The Phase 1 Vue island. Mounts on the tutorial Object Page; fetches `/graph/neighborhood?slug=…`; renders four `ui5-list` sections. Hide-on-empty. |
| `hugo-apps/src/related-graph/main.ts` | Vue island bootstrap (mirrors existing islands like `tutorial-rating`). Reads `document.documentElement.dataset.pageSlug` ([[feedback_island_slug_source]]). |
| `app/admin/concepts/` | Fiori Elements list page over `Concepts` (peer of the existing 14 admin apps). |

### Existing modules touched

| File | Change |
| ---- | ------ |
| `db/schema.cds` | No direct change. The new entities live in their own file (`db/knowledge-graph.cds`); `mta.yaml` already includes all `db/*.cds` files via `db/` glob. |
| `srv/server.js` | Register the new cron jobs in the existing `cds.on('served')` job-attach block. |
| `srv/jobs/scheduler.js` | Add `extractConcepts` (cron `13 2 * * *`) and `consolidateConcepts` (cron `47 3 * * 0`) to the schedule registry. |
| `srv/ord-annotations.cds` | Annotate `KnowledgeGraphService` for ORD discovery (matches existing pattern). |
| `xs-security.json` | Add `KnowledgeGraph.Admin` scope; attach to the existing `Tutorial.Admin` role-template collection. |
| `app/admin-shell/src/router.ts` (or equivalent) | Add side-nav entry "Concepts" → `#concepts-display`. |
| `db/audit-logging.cds` | Add audit-log entry for `Concepts` (admin merge/veto are destructive). |
| `db/change-tracking.cds` | Add `@cap-js/change-tracking` to `Concepts` (matches the pattern on `Missions`/`Groups`/`Events`). |
| `.deploy/mta.yaml` | Add `srv/lib/kg-*.js` to the `srv-qa` `cp` list ([[feedback_srv_qa_cp_list_recurring]]). |
| `package.json` | New script: `"kg:reextract": "AI_AUTHOR_ENABLED=true cds bind --exec -- node scripts/kg-reextract.cjs"` for one-shot manual re-runs. |
| `hugo-apps/vite.config.ts` | Add `related-graph` entry; verify `base: '/js/'` ([[feedback_vite_chunks_need_base]]). |
| `hugo/layouts/tutorials/single.html` (or partial) | Mount `<div data-vue-island="related-graph"></div>` in the OP layout. |

## Data model

Four new CDS entities in [db/knowledge-graph.cds](db/knowledge-graph.cds) — three carry domain state (`Concepts`, `TutorialConceptLinks`, `ConceptEdges`); one (`GraphMetadata`) is a single-row projection-state sidecar updated on every `graphRebuild`:

```cds
namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';
using { com.sap.developers.ims as base } from './schema';

/**
 * Canonical registry of extracted concepts.
 * AI-extracted, admin-reviewable. Slug is the stable identifier (kebab-case).
 */
entity Concepts : cuid, managed {
  slug            : String(80) @assert.unique;     // 'cap-handlers'
  name            : String(120);                    // 'CAP Service Handlers'
  description     : String(500);                    // LLM-generated, admin-editable
  embedding       : LargeBinary;                    // centroid vector for similarity merge
  status          : String(20) default 'ACTIVE';    // ACTIVE | MERGED | VETOED
  mergedInto      : Association to Concepts;        // if MERGED, points to canonical
  extractionCount : Integer default 0;              // # tutorials that contributed
  firstSeenAt     : Timestamp;
  lastSeenAt      : Timestamp;

  links           : Composition of many TutorialConceptLinks on links.concept = $self;
  outgoingEdges   : Composition of many ConceptEdges on outgoingEdges.source = $self;
  incomingEdges   : Association to many ConceptEdges on incomingEdges.target = $self;
}

/**
 * Per-tutorial extracted concepts. Caches both content hash and concept list
 * so we skip re-extraction when tutorial content is unchanged.
 * Covers both 'teaches' (Tutorial → Concept) and 'extends' (Tutorial → Tutorial).
 */
entity TutorialConceptLinks : cuid, managed {
  tutorial        : Association to base.Tutorials @assert.notNull;
  concept         : Association to Concepts;        // populated when predicate='teaches'
  predicate       : String(20) default 'teaches';   // 'teaches' | 'extends'
  extendsTutorial : Association to base.Tutorials;  // populated when predicate='extends'
  confidence      : Decimal(3, 2);                  // 0.00–1.00 from LLM self-rating
  extractedAt     : Timestamp;
  contentHash     : String(64);                     // SHA-256 of source markdown
  modelVersion    : String(40);                     // 'gpt-4o-2024-08-06'
}

/**
 * Concept-to-concept edges (requires, relatedTo). AI-extracted with confidence.
 */
entity ConceptEdges : cuid, managed {
  source       : Association to Concepts @assert.notNull;
  target       : Association to Concepts @assert.notNull;
  predicate    : String(20);                        // 'requires' | 'relatedTo'
  confidence   : Decimal(3, 2);
  evidence     : String(500);                       // LLM-cited tutorial slugs / quotes
  status       : String(20) default 'ACTIVE';       // ACTIVE | VETOED
  extractedAt  : Timestamp;
  modelVersion : String(40);
}

annotate TutorialConceptLinks with @assert.unique.tutorialConcept : [tutorial, concept, predicate];
annotate ConceptEdges with @assert.unique.conceptEdge : [source, target, predicate];

/**
 * Single-row projection metadata. Updated at the end of every graphRebuild.
 * Read by the query-layer cache to mint a graphVersion cache key.
 */
entity GraphMetadata : cuid, managed {
  graphVersion  : String(40);    // ULID minted on rebuild
  lastRebuiltAt : Timestamp;
  tripleCount   : Integer;
  durationMs    : Integer;
}
```

### Notes on the schema

- **`@assert.unique` on `Concepts.slug`** is non-negotiable from day one ([[project_fix_duplicate_slugs]] / PR #386 lesson learned). Mirrors the guardrail added to `Tutorials`/`Missions`/`Groups`.
- **`mergedInto` is the merge-don't-delete pattern.** When admin merges `cap-handler-functions` into `cap-handlers`, the row stays with `status='MERGED'` and `mergedInto` points to the canonical. All `TutorialConceptLinks` get re-pointed to the canonical concept. This preserves history and gives us "this concept was previously known as X" UX for free.
- **`embedding` per Concept (centroid).** When the consolidator evaluates "is this new concept just a rename of an existing one?", it's a vector similarity check, not an LLM call. Cheap, deterministic, mirrors how [`srv/lib/embedding-query.js`](srv/lib/embedding-query.js) already works for the RAG tool.
- **HANA LOB locator gotcha** ([CLAUDE.md](CLAUDE.md)): never SELECT `embedding` alongside scalar columns in CDS QL on HANA. `srv/lib/kg-similarity.js` uses raw `db.run()` for embedding retrieval, same pattern as `srv/lib/embedding-query.js`.
- **One entity for `teaches` + `extends`.** The predicate column overloads two predicates; alternative is two entities (`TeachesLinks` + `ExtendsLinks`). Single entity wins because both predicates share the same extraction pipeline, the same content-hash cache key, and the same cleanup logic. Filtering by predicate is cheap.
- **No `Triples` table.** The HANA KGE named graph is rebuilt from these three entities + canonical CDS data on every concept change. It's a query optimizer, not a database of record. Full rebuild on a ~50–100k triple graph takes <10 seconds.

## Ontology — predicates in the graph

The named graph URI is `<https://developers.sap.com/kg/tutorials>`. All resources are prefixed `kg:` (`<https://developers.sap.com/kg/>`).

8 predicates, mix of AI-extracted and structural-from-CDS. The richer the predicate vocabulary, the more interesting SPARQL queries become; too many and AI extraction gets fuzzy. This is the deliberate sweet spot.

| Predicate | Source | Domain → Range | Notes |
| --------- | ------ | -------------- | ----- |
| `kg:teaches` | AI-extracted | Tutorial → Concept | 3–7 per tutorial; `confidence ≥ 0.6` filter |
| `kg:requires` | AI-extracted (high-confidence only) | Concept → Concept | Top-2 per concept; `confidence ≥ 0.75`; cycle-validated |
| `kg:relatedTo` | AI-extracted (co-occurrence + embedding) | Concept → Concept | Weaker than `:requires`; symmetric |
| `kg:extends` | AI-extracted ("if you've completed X" prose) | Tutorial → Tutorial | 0–1 per tutorial |
| `kg:partOf` | CDS (existing `Missions` ↔ `Tutorials`) | Tutorial → Mission, Mission → Group | Single predicate used in two contexts; do **not** split into two predicates |
| `kg:taggedWith` | CDS (existing `Tutorial.tags`) | Tutorial → Tag | Structural; no AI |
| `kg:inCategory` | CDS (existing `Mission.category`) | Mission → Category | Structural; no AI |
| `kg:aboutProduct` | CDS (extracted from `software-product>*` tags) | Tutorial → Product | Product is a derived node type |
| `kg:coCompletedWith` | analytics (existing `/build/co-completions`) | Tutorial → Tutorial | Top-N weighted; behavioural signal |

**Counting:** that's 9 lines but `:partOf` covers two domain pairs, so 8 distinct predicates as committed in the brainstorm.

**Mitigation for the two risky predicates:**

- **`:requires`** is the most error-prone (hallucination risk, can create cycles). Capped at top-2 per concept, requires `confidence > 0.75`, validated by DFS cycle detection in `consolidateConcepts` before each `graphRebuild`. Auto-VETO of the weakest edge in any detected cycle.
- **`:coCompletedWith`** is noisy if loaded raw. Capped at top-N=10 per tutorial; weight is the normalized co-occurrence count. Phase 1 sidebar uses it only as a *re-ranking signal*, not as a primary navigation predicate.

## Extraction & consolidation pipeline

### Job A: `extractConcepts` — nightly cron `13 2 * * *`

Per-tutorial, content-hash-keyed, idempotent. Mirrors the [#208 AI-quiz cache](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\project_208_ai_authored_quizzes_shipped.md) pattern but stores cache in HANA (not on the filesystem) so it survives across approuter instances.

```
For each Tutorial in HANA (paginated, 50/page):
  1. Compute contentHash = SHA-256(tutorial markdown body)
  2. Look up TutorialConceptLinks WHERE tutorial.ID = ?
  3. If existing.contentHash === current AND existing.modelVersion === currentModel → SKIP
  4. Else if buildCap budget exhausted → log + break (resume on next tick)
  5. Else:
     a. Load existing Concepts (slug + name + description, status=ACTIVE only)
     b. Constrained-extraction prompt:
          system: "You are a concept-extraction engine. Output JSON conforming
                  to the provided schema. Use existing concept slugs when they
                  fit; only propose new ones for genuine gaps. Confidence
                  reflects how core the concept is to this tutorial."
          user:   "Tutorial: <title>
                   Markdown: <body>
                   Existing concepts (use these when they fit):
                   <slug>: <name>
                   ...
                   Return: { teaches: [{slug, name, confidence}], extends:
                   tutorialSlug | null, prerequisites: [{source, target,
                   confidence, evidence}] }"
     c. Validate response:
          - JSON-schema match (forced tool call via @sap-ai-sdk/orchestration)
          - All slugs match /^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$/
          - confidence ≥ 0.6 (filter below)
          - 3 ≤ teaches.length ≤ 7
          - prerequisites ≤ 4 entries
     d. For each new concept slug (not in registry):
          - Compute embedding(name + " " + description) via ai-sdk
          - Check cosine similarity against existing concept embeddings
          - If max-sim > 0.85 → reuse existing concept (vocabulary collision protection)
          - Else INSERT new Concept row
     e. In a single transaction:
          - DELETE FROM TutorialConceptLinks WHERE tutorial.ID = ?
          - INSERT new TutorialConceptLinks rows
          - Upsert ConceptEdges from prerequisites (predicate='requires')
          - UPDATE Concepts SET extractionCount = extractionCount + 1,
                                lastSeenAt = now() WHERE ID IN (...)
  6. After loop: log token usage + cache hit rate; do NOT trigger graphRebuild
     (consolidator runs that step weekly)
```

**Hard cap.** `KG_EXTRACT_BUILD_CAP` env var (default 200 LLM calls per job run) — same pattern as `AI_AUTHOR_BUILD_CAP`. If hit, the job logs a warning and stops; remaining tutorials get processed on the next tick. The per-tutorial cache makes the job naturally resumable.

**Cost estimate.** ~1400 tutorials. First full run = 1400 LLM calls (~$3–5 with GPT-4o). Steady-state = whatever fraction of tutorials changed since last run, typically <50/day. Cheap.

**LLM choice.** Reuses the same `defaultCallModel` from [`srv/lib/code-check-llm.js`](srv/lib/code-check-llm.js) that #205 and #234 use — `@sap-ai-sdk/orchestration` forced-tool-call wrapper, just a different schema. Centralizing the LLM client also means one switch flips models everywhere. `modelVersion` is captured per row so a model swap invalidates cache deterministically.

### Job B: `consolidateConcepts` — weekly cron `47 3 * * 0`

```
1. Acquire job-lock (TTL 30 min)
2. Load all ACTIVE Concepts (~80–150 expected)
3. Pairwise embedding similarity matrix
4. For each pair with cosineSim > 0.92, ordered by similarity desc:
     - Pick canonical: higher extractionCount wins; tie → older firstSeenAt
     - In a transaction:
       - UPDATE TutorialConceptLinks SET concept_ID = canonical
                WHERE concept_ID = loser
       - UPDATE ConceptEdges SET source_ID = canonical WHERE source_ID = loser
       - UPDATE ConceptEdges SET target_ID = canonical WHERE target_ID = loser
       - DELETE FROM ConceptEdges WHERE source_ID = target_ID  (kill self-loops)
       - UPDATE Concepts SET status='MERGED', mergedInto_ID = canonical
                WHERE ID = loser
5. Cycle detection on :requires edges (kg-cycles.js DFS)
6. For each cycle: pick weakest edge (lowest confidence), set status='VETOED'
7. Trigger graphRebuild (next section)
8. Audit log: merges performed, edges vetoed, triples emitted by predicate
9. Release job-lock
```

**Why weekly?** Consolidation is destructive — letting the registry stabilize between runs gives admins time to review newly-extracted concepts before they get auto-merged. Admin-initiated `triggerGraphRebuild` action lets them force a rebuild after a manual merge or veto without waiting for Sunday.

**The 0.92 cosine threshold is a starting guess.** Phase 1 admin tooling includes a "preview merges" view that runs the similarity logic without writing — lets us tune empirically. If the threshold needs adjusting, it's a config env var (`KG_MERGE_SIM_THRESHOLD`), not a redeploy.

### `graphRebuild` — projection step inside `consolidateConcepts` (also admin-triggerable)

Pure projection. No LLM calls. Idempotent.

```
1. Compute graphVersion = ULID()
2. CALL SYS.SPARQL_EXECUTE('CLEAR GRAPH <kg:tutorials>', '', :response OUT, :headers OUT)
3. Project triples in batches of ~5000:
   - Concepts (status=ACTIVE) → kg:concept/<slug> rdf:type kg:Concept ;
                                                kg:slug "<slug>" ;
                                                kg:name "<name>"
   - TutorialConceptLinks (concept.status=ACTIVE)
       → kg:tutorial/<slug> kg:teaches kg:concept/<concept-slug>
       → kg:tutorial/<slug> kg:extends kg:tutorial/<extends-slug>
   - ConceptEdges (status=ACTIVE)
       → kg:concept/<src> kg:requires kg:concept/<tgt>
       → kg:concept/<src> kg:relatedTo kg:concept/<tgt>
   - Tutorials → kg:partOf, kg:taggedWith, kg:aboutProduct
   - Missions/Groups → kg:partOf, kg:inCategory
   - Top-10 co-completions per Tutorial → kg:coCompletedWith with kg:weight
4. Each batch: CALL SYS.SPARQL_EXECUTE('INSERT DATA { GRAPH <kg:tutorials> { ... } }', '', :response OUT, :headers OUT)
5. Update sidecar in CDS: GraphMetadata.lastRebuiltAt + .graphVersion
6. Cache busts: any /graph/neighborhood result keyed on old graphVersion is now stale
```

`GraphMetadata` is a single-row CDS entity (not in the table list above; introduced here as it's purely projection-state) holding `{lastRebuiltAt, graphVersion, tripleCount, durationMs}`. The sidebar response includes `graphVersion` as a header so client-side caches can self-invalidate.

### Failure modes & guards

| Failure | Detection | Recovery |
| ------- | --------- | -------- |
| LLM returns malformed JSON | Forced tool-call schema validation | Skip tutorial, log entry to `KGExtractionErrors` view, surface in admin dashboard |
| LLM proposes 0 concepts | Length check `< 3` | Fall back to existing tags as concept candidates (slug = tag); log for admin review |
| New concept slug collides with existing different concept | Embedding similarity check at INSERT | Reuse existing if cosine > 0.85; create new if not |
| Cycle in `:requires` | DFS during consolidation | Auto-VETO weakest edge in cycle |
| KGE INSERT batch fails | try/catch around batch | Roll back transaction, retry once with smaller batch, then alert via existing alerting hook |
| Job crashes mid-run | `job-lock.js` releases lock on TTL expiry | Next tick picks up where it left off (per-tutorial caching means resumable) |
| Privilege not granted on container deploy | First SPARQL call returns `User does not have SPARQL query privileges` | PR 2's `.hdbgrants` + grantor flow ensures it; deploy fails fast if not in place. See [docs/developers/architecture/hana-kge-access.md § Privileges required](../../developers/architecture/hana-kge-access.md) |
| `Concepts` table wiped by HDI deploy | Pre-deploy snapshot row count | Re-run `extractConcepts` with `KG_EXTRACT_BUILD_CAP=10000` to rebuild from cache (~$5) |
| `srv-qa` cp-list misses new lib files | QA boot smoke test | PR-time audit ([[feedback_srv_qa_cp_list_recurring]]) |

## Query layer

A new CAP service in [srv/knowledge-graph-service.cds](srv/knowledge-graph-service.cds), path `/graph`, XSUAA-protected.

```cds
using { com.sap.developers.ims as db } from '../db/knowledge-graph';

@path: '/graph'
@requires: 'authenticated-user'
service KnowledgeGraphService {

  // Read-only projections of CDS state — for admin browsing.
  @readonly entity Concepts as projection on db.Concepts;
  @readonly entity ConceptEdges as projection on db.ConceptEdges;
  @readonly entity TutorialConceptLinks as projection on db.TutorialConceptLinks;

  // Typed named queries (parameter-validated, SPARQL hidden from caller).
  function neighborhood(slug: String) returns NeighborhoodResult;
  function pathBetween(fromSlug: String, toSlug: String) returns array of String;  // Phase 2 stub
  function conceptsForUser(userId: String) returns ConceptCoverage;                 // Phase 2 stub

  // Free-form SPARQL — admin only.
  @requires: 'KnowledgeGraph.Admin'
  action runSparql(query: String) returns SparqlResult;

  // Admin actions.
  @requires: 'KnowledgeGraph.Admin'
  action mergeConcepts(loser: UUID, canonical: UUID);
  @requires: 'KnowledgeGraph.Admin'
  action vetoConcept(conceptId: UUID);
  @requires: 'KnowledgeGraph.Admin'
  action vetoEdge(edgeId: UUID);
  @requires: 'KnowledgeGraph.Admin'
  action triggerGraphRebuild();
}

type NeighborhoodResult {
  tutorial         : { slug: String; title: String };
  teaches          : array of ConceptRef;       // concepts this tutorial teaches
  prerequisitesOf  : array of TutorialRef;      // tutorials teaching prerequisite concepts
  sharedConcepts   : array of TutorialRef;      // top-10 tutorials with concept overlap
  whatToLearnNext  : array of TutorialRef;      // see ranking algorithm below
  graphVersion     : String;
}

type ConceptRef    { slug: String; name: String; description: String; }
type TutorialRef   { slug: String; title: String; weight: Decimal(3, 2); reason: String; }
type ConceptCoverage { learned: array of ConceptRef; partial: array of ConceptRef; }
type SparqlResult    { columns: array of String; rows: array of array of String; }
```

### Why named queries (not raw SPARQL) on the public surface?

Same reasoning as `AnalyticsService.runSelectQuery` ([analytics-sql-validator.cjs](srv/lib/analytics-sql-validator.cjs)): server-validated, parameterized, easy to cache, easy to evolve. The SPARQL templates live in [`srv/lib/kg-queries.js`](srv/lib/kg-queries.js) — one constant per named query, with `$SLUG`-style parameter substitution and an injection guard that rejects any value containing characters outside `[a-z0-9-]`.

Raw SPARQL is available via `runSparql` for admins only (scope `KnowledgeGraph.Admin`) — the technical-credibility piece for any internal demo.

### The flagship query — `neighborhood(slug)`

```sparql
PREFIX kg: <https://developers.sap.com/kg/>
SELECT DISTINCT ?type ?targetSlug ?targetLabel ?weight
FROM <https://developers.sap.com/kg/tutorials>
WHERE {
  {
    # what this tutorial teaches
    kg:tutorial/$SLUG kg:teaches ?concept .
    ?concept kg:slug ?targetSlug ; kg:name ?targetLabel .
    BIND("teaches" AS ?type) BIND(1.0 AS ?weight)
  } UNION {
    # tutorials teaching prerequisite concepts (2-hop)
    kg:tutorial/$SLUG kg:teaches ?concept .
    ?concept kg:requires ?prereq .
    ?prereqTut kg:teaches ?prereq ; kg:slug ?targetSlug ; kg:title ?targetLabel .
    FILTER(?prereqTut != kg:tutorial/$SLUG)
    BIND("prerequisitesOf" AS ?type) BIND(0.9 AS ?weight)
  } UNION {
    # tutorials with shared concepts, weighted by overlap count
    kg:tutorial/$SLUG kg:teaches ?sharedConcept .
    ?other kg:teaches ?sharedConcept ; kg:slug ?targetSlug ; kg:title ?targetLabel .
    FILTER(?other != kg:tutorial/$SLUG)
    BIND("sharedConcepts" AS ?type)
  } UNION {
    # what to learn next: tutorials teaching concepts that *require* what this teaches
    kg:tutorial/$SLUG kg:teaches ?known .
    ?advanced kg:requires ?known .
    ?nextTut kg:teaches ?advanced ; kg:slug ?targetSlug ; kg:title ?targetLabel .
    FILTER(?nextTut != kg:tutorial/$SLUG)
    BIND("whatToLearnNext" AS ?type)
  }
}
LIMIT 60
```

That's a real multi-hop SPARQL query — exactly the shape that's painful in plain SQL but elegant here. **This is the showcase moment.**

The handler:

1. Substitutes `$SLUG` (after kebab-case validation)
2. Calls `SYS.SPARQL_EXECUTE` via the canonical `DO BEGIN … END` wrapper over the existing `cds.connect.to('db')` connection (see [docs/developers/architecture/hana-kge-access.md](../../developers/architecture/hana-kge-access.md) for the wrapper shape and [`srv/lib/kg-sparql-client.js`](srv/lib/kg-sparql-client.js) for the production helper PR 4 lands)
3. Groups raw rows by `?type`
4. Re-ranks `whatToLearnNext`: SPARQL gives candidates; JS layer multiplies by `coCompletedWith` weight from a second SPARQL hop (or cached map) and subtracts a penalty for tutorials whose `:teaches` concepts the current user has already seen (Phase 1: anonymous; Phase 2: per-user via `conceptsForUser`)
5. Returns top 10 of each section

`whatToLearnNext` ranking happens **in JS, not in SPARQL** — keeps SPARQL clean; ranking weights stay where they're easy to tune.

### Caching

Per-slug LRU cache keyed `${slug}:${graphVersion}`, 24h TTL, capped at 50MB (mirrors [`srv/lib/content-store.js`](srv/lib/content-store.js)). The `graphVersion` from `GraphMetadata` is the cache-bust signal — every `graphRebuild` mints a new version, all old cache entries become stale on the next request.

~1400 slugs × ~2KB per response = 3MB of working set; trivially fits.

### Audit & telemetry

- Every named-query call → audit log via `@cap-js/audit-logging` (entity `KnowledgeGraphQuery` with query name + slug param)
- Every SPARQL query latency → analytics metric `kg.query.duration` (existing `srv/lib/metrics.js` pattern)
- Graph rebuild → audit log with triple count by predicate
- `runSparql` → always audit-logged with the full query (admin-only and small-volume; cheap)

## Phase 1 surfaces

### Surface 1 — Tutorial sidebar (end-user-facing)

**Where:** New Vue 3 island at [hugo-apps/src/related-graph/](hugo-apps/src/related-graph/) — peer of `tutorial-feedback`, `tutorial-rating`, `tutorial-pip`. Mounts on the tutorial Object Page via a `<div data-vue-island="related-graph">` placeholder in the OP layout.

**What it shows:**

```
┌─ Knowledge graph ─────────────────────────┐
│                                           │
│ This tutorial teaches                     │
│ ┌──────────────────────────────────────┐  │
│ │ ◇ CAP Service Handlers               │  │
│ │ ◇ Custom Logic Patterns              │  │
│ │ ◇ Async Event Handling               │  │
│ └──────────────────────────────────────┘  │
│                                           │
│ Prerequisites you might want first        │
│ ┌──────────────────────────────────────┐  │
│ │ → Build Your First CAP Service       │  │
│ │ → Understanding CDS Annotations      │  │
│ └──────────────────────────────────────┘  │
│                                           │
│ Tutorials covering related concepts       │
│ ┌──────────────────────────────────────┐  │
│ │ → Validate Input with @assert        │  │
│ │ → Read Tenant Context in Handlers    │  │
│ │ → Drafts in CAP                      │  │
│ └──────────────────────────────────────┘  │
│                                           │
│ What to learn next                        │
│ ┌──────────────────────────────────────┐  │
│ │ → Outbox Pattern in CAP              │  │
│ │ → Connect to S/4HANA from Handlers   │  │
│ └──────────────────────────────────────┘  │
└───────────────────────────────────────────┘
```

**Interaction model:**

- Click a tutorial → navigate to that tutorial
- Click a concept → no navigation in Phase 1 (Phase 3 routes to concept landing pages)
- Hover a concept → show definition tooltip (rendered from `Concepts.description`)

**Data flow:**

1. Mount: read `document.documentElement.dataset.pageSlug` ([[feedback_island_slug_source]])
2. `fetch('/graph/neighborhood?slug=' + slug)` with `Accept: application/json`
3. Render four `ui5-list` sections grouped by `type`, sorted by `weight` within group
4. Use ETag from response for browser-side cache; server-side cache is keyed by `graphVersion`

**Empty state:** if no concepts have been extracted yet for this tutorial (`teaches.length === 0`), the entire panel hides — no empty placeholder. Phase 1 ships only after the first cron run completes, so this is mostly belt-and-suspenders.

**Styling:** SAP Horizon design tokens; layout matches the existing tutorial sidebar (`tutorial-rating`, `tutorial-pip`).

**Lazy-load.** Vue island is `defer`-tagged and the data fetch is deferred until the panel scrolls within 200px of the viewport (IntersectionObserver). Tutorial OP first-paint is unaffected.

### Feature flag

`KNOWLEDGE_GRAPH_ENABLED` env var on `tutorials-srv`. When false:

- `/graph/*` returns 503
- Sidebar Vue island detects the 503 and self-removes from DOM (no error UI)

Same kill-switch pattern as `ChatSettings.codeCheckEnabled` ([[feedback_check_chatsettings_after_deploy]]) — flip from BTP cockpit without redeploying. Default OFF until the first nightly extraction has populated the registry.

### Telemetry & A/B

UI events emitted via existing `UI_EVENTS_ENABLED` flag ([[project_204_deploy_flag_flipped]]):

- `kg.sidebar.shown` — slug, sectionCounts (4 ints)
- `kg.sidebar.click` — slug, type (`teaches` | `prerequisitesOf` | `sharedConcepts` | `whatToLearnNext`), targetSlug
- `kg.sidebar.hover_concept` — slug, conceptSlug

Compares CTR on `whatToLearnNext` vs the existing personalized recommendations rail ([[project_personalized_recommendations]]) to validate that the graph adds incremental value over the embedding-centroid approach.

### Surface 2 — Admin concept review (`/admin-ui/#concepts-display`)

**What:** a new Fiori Elements list page over `Concepts`, peer of the existing 14 admin apps in [app/admin/](app/admin/). Adds entry to admin-shell side nav.

**Phase 1 capabilities:**

- **List view:** filter by status (ACTIVE / MERGED / VETOED), search by name/slug, sort by `extractionCount` descending, columns include `slug`, `name`, `extractionCount`, `firstSeenAt`, `lastSeenAt`, `status`
- **Object Page per concept:** name, description, status, slug, extraction count, list of contributing tutorials (via `links`), incoming/outgoing `ConceptEdges` with confidence + evidence
- **Inline edit:** name, description (admin overrides AI; surviving the next extraction round)
- **Actions (page-level toolbar):**
  - "Veto concept" → sets `status='VETOED'`; concept disappears from graph on next rebuild
  - "Merge into…" → opens a value-help dialog over ACTIVE concepts; calls `mergeConcepts(loser, canonical)`
  - "Trigger graph rebuild" → kicks `triggerGraphRebuild`; surfaces job status via toast
  - "Preview merges" → runs the consolidator's similarity logic *without* writing; shows a list of pairs that would merge at the current threshold (used to tune `KG_MERGE_SIM_THRESHOLD`)

**Capabilities deferred (not in Phase 1):**

- Manual concept *creation* — the showcase narrative is "the AI builds the graph"; admins curate, don't author
- A SPARQL Object Page workbench — Phase 2 dev tool

**Why admin-shell, not standalone:** same shell as the other 14 apps; theme switcher, navigation, breadcrumbs all free. Same XSUAA route (`/admin-ui/`), same scope check.

`@cap-js/change-tracking` on `Concepts` (admin-edited entity, mirrors the pattern on `Missions`/`Groups`/`Events`) gives audit trails for free. When someone vetoes a concept, the changelog tile shows it.

**Audit log** on `mergeConcepts` action — destructive (re-points all `TutorialConceptLinks`), so we want a record. Wired through the existing `AuditLog` cron pattern.

**Scope:** new XSUAA scope `KnowledgeGraph.Admin` added to the existing `Tutorial.Admin` role-template collection. No new role collection, no separate role assignment.

## Testing strategy

Following the three Vitest workspaces in [vitest.config.ts](vitest.config.ts):

| Workspace | Scope | Examples |
| --------- | ----- | -------- |
| **unit** | Pure logic, in-memory SQLite | Constrained-extraction prompt assembly; cycle detection in `kg-cycles.js`; `neighborhood` ranking algorithm; SPARQL parameter substitution + injection guard; embedding similarity merge picks correct canonical (higher `extractionCount` wins, tie → older `firstSeenAt`); empty-state hide-on-empty in sidebar |
| **hybrid** | Real HANA + KGE round-trip via `cds bind --exec` | `graphRebuild` actually CLEARs and reloads named graph; named queries return correct shape against real triples; `mergeConcepts` action re-points links atomically; `@assert.unique` on `Concepts.slug` rejects duplicates; cycle auto-VETO survives rebuild |
| **smoke** | HTTP against deployed | `/graph/neighborhood?slug=…` returns expected shape with valid `graphVersion` header; sidebar Vue island doesn't 500 with `KNOWLEDGE_GRAPH_ENABLED=false`; admin role-collection gates `runSparql` (401 without scope, 200 with) |

**`HYBRID_AI_TESTS=true`** opt-in for one extraction-quality test that calls a real LLM. Mirrors the [#208 quiz pattern](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\project_208_ai_authored_quizzes_shipped.md) — keeps default hybrid runs at $0/run.

**Default-OFF live smoke** ([[feedback_default_off_flags_need_live_smoke]]) — when shipping behind the flag, smoke that flipping `KNOWLEDGE_GRAPH_ENABLED=true` on DEV produces a working sidebar before merging the flag-on PR. Don't rely solely on tests.

**Mutation testing** for the SPARQL builder + cycle-detection — these are the parts where bugs would silently corrupt the graph. Same approach as [[project_210_phase4_graduated]].

### Day-1 spike (before locking the implementation)

**✅ Resolved by PR 1 ([#401](https://github.com/sap-tutorials/tutorials-ims/pull/401)) — see "Spike findings (PR 1)" near the top of this spec and [docs/developers/architecture/hana-kge-access.md](../../developers/architecture/hana-kge-access.md) for the full write-up. The questions below are preserved as historical context for what the spike investigated.**

A 1-day investigation, separate PR, *before* the data-model PR. Goals:

1. Can `db.run('EXECUTE STATEMENT \\'SPARQL CLEAR GRAPH <kg:tutorials>\\'')` execute against a `cds bind`'d HANA Cloud DEV tenant? If yes → primary path. If no → switch to KGE REST endpoint via Destination Service. Document either way. *(Resolved: NO — the SQL extension does not exist; the canonical path is `CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)` with no REST fallback needed.)*
2. What's the actual triple-store DDL? (`CREATE GRAPH WORKSPACE`?, special privileges?). The HDI deployer needs to know. *(Resolved: no DDL — `INSERT DATA` into an unknown named graph creates it implicitly. Privileges are `SPARQL QUERY` + `SPARQL UPDATE` delivered via `.hdbgrants` + grantor service.)*
3. Round-trip: insert 100 dummy triples, run a 2-hop SPARQL SELECT, measure latency. If >1s for that, the design assumes wrong order of magnitude and we need to revisit caching. *(Pending: latency re-measurement once PR 2's grants flow lands.)*
4. Confirm `xs-security.json` scope check works for `runSparql` admin-only action without surprises.

The spike outputs become a one-page "HANA KGE access patterns" document committed to [docs/developers/architecture/](../../developers/architecture/), referenced in the implementation plan.

## Risks & mitigations

| Risk | Likelihood | Mitigation |
| ---- | ---------- | ---------- |
| AI extracts garbage concepts ("things about deploying") | High in early runs | Constrained extraction limits new concepts; admin veto is the relief valve; concept review tool ships in Phase 1 so quality is visible from day 1 |
| HANA KGE auth or syntax differs from what the design assumes | Resolved — disproven by PR 1 spike | Spike replaced the assumed `EXECUTE STATEMENT 'SPARQL …'` syntax (rejected by HANA SQL parser) with `CALL SYS.SPARQL_EXECUTE`. Privilege delivery now via canonical HDI `.hdbgrants` flow. See [docs/developers/architecture/hana-kge-access.md](../../developers/architecture/hana-kge-access.md) |
| Phase 1 wow factor lower than expected ("just another sidebar") | Medium | Admin Concepts review is genuinely interesting on its own; SPARQL endpoint is the technical-credibility piece for any internal demo |
| LLM costs balloon | Low | Hard `KG_EXTRACT_BUILD_CAP=200` per job; content-hash cache; weekly consolidation budget separate. Steady-state ~$1–2/week |
| Cycles in `:requires` make SPARQL property-path queries explode | Medium | DFS validation in `consolidateConcepts`; auto-VETO weakest edge; alert on detection |
| Schema drift on `Concepts` after deploy wipes data | Medium | Snapshot row counts before HDI deploy ([[feedback_hdi_deploys_can_wipe_data]]); registry is rebuildable from cache (`kg:reextract` script) |
| Sidebar bloats tutorial OP load time | Low | Lazy-load Vue island below the fold; data fetch deferred to viewport intersection; cache hit is the common path |
| `hugo-apps/` Vite chunk doesn't get `base: '/js/'` | Low (known pitfall) | Verify in `vite.config.ts` before first deploy ([[feedback_vite_chunks_need_base]]) |
| `srv-qa` cp-list misses `srv/lib/kg-*.js` | Medium (recurring) | Audit `.deploy/mta.yaml` srv-qa cp list during PR; QA boot smoke catches it ([[feedback_srv_qa_cp_list_recurring]]) |
| Vocabulary drift across batches before consolidator catches up | Medium | Constrained-extraction prompt; second-pass embedding similarity check at INSERT (cosine > 0.85 → reuse); admin "Preview merges" tool to tune threshold |
| Extraction LLM hallucinates `:requires` edges that aren't real | Medium | `confidence ≥ 0.75` filter; admin can VETO individual edges; cycle detection catches the worst |

## Phase 1 ship-list (summary)

- 3 new CDS entities (`Concepts`, `TutorialConceptLinks`, `ConceptEdges`) + 1 projection-state entity (`GraphMetadata`)
- 1 new CAP service (`KnowledgeGraphService` at `/graph` with Phase 2 method stubs)
- 5 new lib files (`kg-extract.js`, `kg-queries.js`, `kg-projection.js`, `kg-similarity.js`, `kg-cycles.js`)
- 2 new cron jobs (`extractConcepts`, `consolidateConcepts`) registered through `srv/jobs/scheduler.js`
- 1 new Vue island (`hugo-apps/src/related-graph/`)
- 1 new admin app (`app/admin/concepts/`) + admin-shell side-nav entry
- 1 one-shot CLI (`scripts/kg-reextract.cjs` + `npm run kg:reextract`) for cache rebuild after a HDI wipe
- 1 new feature flag (`KNOWLEDGE_GRAPH_ENABLED`, default OFF)
- 1 new XSUAA scope (`KnowledgeGraph.Admin`) attached to existing `Tutorial.Admin` role collection
- 2 new env vars: `KG_EXTRACT_BUILD_CAP` (default 200), `KG_MERGE_SIM_THRESHOLD` (default 0.92)
- 1-day spike (✅ landed in PR 1 / [#401](https://github.com/sap-tutorials/tutorials-ims/pull/401)) — confirmed `CALL SYS.SPARQL_EXECUTE` access path and `.hdbgrants`-based privilege delivery; full findings at [docs/developers/architecture/hana-kge-access.md](../../developers/architecture/hana-kge-access.md)
- Audit-logging + change-tracking on `Concepts`
- ORD annotations for `KnowledgeGraphService`
- Smoke + hybrid + unit test coverage as described above

## Future scope (explicitly OUT of Phase 1)

- **Phase 2 — Joule learning-path generator.** New chat tool, NL → SPARQL → ordered tutorial path. Uses `pathBetween()` and `conceptsForUser()` named queries declared in Phase 1. No new UI route — lives in existing Joule chat surface. Strong demo: "ask Joule for a learning path → see SPARQL → see KGE answer."
- **Phase 3 — Explore page.** New `/explore/` route. Force-directed (or constellation-style) interactive graph viz. Tutorials, concepts, products as nodes; 8 predicates as typed edges. Click a node, graph re-centers. "Find a path from where I am to where I want to be" feature. Highest visual impact for the showcase but biggest scope.
- **Concept landing pages** (`/concepts/<slug>/`) — Phase 3.
- **Manual concept creation in admin** — never; the showcase narrative is "AI builds the graph."
- **Cross-corpus federation** (e.g., SAP Help portal RDF alongside the tutorials graph) — interesting future, not now.
- **Multi-language concept extraction** — corpus is English-only ([[project_developers_locales]]).
- **Real-time graph updates** — graph is rebuilt per cron, not on every tutorial publish. Eventual consistency on a daily cadence.
- **Embedding clustering as the extraction strategy** — considered (option B in brainstorming Q5); rejected. Could be revisited if vocabulary drift is bad.

## Decisions made (with rationale)

1. **AI-extracted concepts** over hand-curated ontology — showcases two SAP technologies (KGE + AI Core), matches author-self-service preference, and the consolidation job becomes its own demoable artifact.
2. **CAP cron job** over CI-time extraction — independent of content publishing, content-hash cache survives across instances, mirrors existing `srv/jobs/` pattern.
3. **Constrained per-tutorial extraction** over corpus-wide clustering — caches well, produces coherent vocabulary, lets the registry stabilize naturally around ~80–150 concepts.
4. **All 8 predicates** including the risky `:requires` (mitigated by confidence threshold + cycle detection).
5. **Phasing P1.1 — backend + sidebar (B)** over Joule-first or admin-only. Smallest end-user surface, real eyeballs surface extraction-quality bugs we'd never find from internal review.
6. **Named queries on the public surface, raw SPARQL admin-only.** Same model as `AnalyticsService.runSelectQuery`.
7. **`whatToLearnNext` ranking happens in JS** after the SPARQL hop, not in SPARQL. Keeps SPARQL clean; ranking stays where it's easy to tune.
8. **HANA KGE access via `CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)` stored procedure** over the existing `cds.connect.to('db')` connection, not a separate REST client. Procedure-based is what HANA Cloud actually exposes — chosen via the day-1 spike (PR 1 / [#401](https://github.com/sap-tutorials/tutorials-ims/pull/401)). The earlier-assumed `EXECUTE STATEMENT 'SPARQL …'` SQL extension does not exist in HANA Cloud QRC 2026.2. Wrapper uses `DO BEGIN … END` for OUT-param robustness; full reference in [docs/developers/architecture/hana-kge-access.md](../../developers/architecture/hana-kge-access.md).
9. **Single `TutorialConceptLinks` entity** with predicate column over split `TeachesLinks` + `ExtendsLinks` entities — same extraction pipeline, same cache key.
10. **`@assert.unique` on `Concepts.slug`** from day one (PR #386 lesson learned).
11. **Hide-on-empty sidebar** rather than empty-state UI — Phase 1 ships only after first cron run.
12. **`KnowledgeGraph.Admin` scope** added to existing `Tutorial.Admin` role collection — no new role assignment work.
13. **HANA KGE is a projection, not source-of-truth.** Canonical state lives in CDS; the triple store is rebuilt from CDS on every concept change. Triple store stays as a query optimizer.

## Open questions

- **HANA KGE feature availability on the `tutorial-system` subaccount.** Tom to confirm via `btp_target` / service-marketplace check before the spike. If not available on EU10-005, this whole spec needs re-targeting. (✅ Confirmed available; see PR 1 / [#401](https://github.com/sap-tutorials/tutorials-ims/pull/401))

## Decisions deferred at brainstorm but locked here for the plan

- **Cron-only extraction in Phase 1.** No `POST /content/publish` hook into `extractConcepts`. Eventual consistency on a daily cadence is acceptable for the discovery surface; publish-triggered extraction is a Phase 2 concern if real-time drift becomes a complaint.
- **Sidebar placement: right rail on desktop, bottom-sheet on mobile.** Right rail mounts in [hugo/layouts/tutorials/single.html](hugo/layouts/tutorials/single.html) (or its sidebar partial) below the existing `tutorial-rating` panel. Mobile reuses the `ui5-dialog` bottom-sheet pattern from [[project_U18_mobile_sheet]].
- **Admin "Concepts" tile slot.** Wedge between "Categories" and "Events" in the admin-shell side nav (alphabetical). Same icon convention as existing tiles.
