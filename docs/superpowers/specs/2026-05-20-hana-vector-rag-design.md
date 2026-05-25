# HANA Vector + RAG for Joule Tutorial Grounding

**Status:** Proposed
**Date:** 2026-05-20
**Author:** Tom Jung (with Claude)
**Related:** [[joule-chat]], [[admin-joule-chat]], [[ai-friendly-site]]

## Problem

Joule chat is live on the tutorial platform with tool-calling, including a `searchTutorials` tool that today delegates to `SearchService.SearchableItems` — HANA fuzzy keyword search with `@Search.fuzzinessThreshold: 0.7`. Keyword search is good for *finding* a tutorial by name or tag, but it cannot ground *how-to* questions in step-level content. When a user asks "how do I configure the destination service in CAP," Joule has no way to retrieve the actual paragraphs of the relevant step — only tutorial titles and descriptions.

Tutorial HTML is stored as gzip-compressed BLOBs in HANA `ContentFiles`, and `Steps` rows are self-healed on every publish (title, order, tutorial FK). The natural next move is to embed step-level content into HANA's native vector store and add a `getRelevantSteps` tool to the existing chat orchestrator. This makes the catalog *queryable by meaning*, not just by keywords, with step-level citations that match Joule's existing citation behavior.

## Goals

1. Joule can answer "how do I do X?" questions by retrieving and citing specific tutorial steps
2. The pipeline is delta-aware — only changed steps re-embed
3. The feature is admin-controllable at runtime (no redeploy to enable/disable or rotate models)
4. The pipeline is resilient — content publish never fails because AI Core is unavailable
5. The work fits the existing patterns: HANA-everywhere, post-publish hooks, scheduled jobs, admin singletons, change-tracked config

## Non-goals

- Replacing the public `/search` UI's keyword search (separate future change — keep the option open by isolating retrieval behind `embedding-query.js`)
- Tutorial-to-tutorial recommendations / "you might also like" (future use case — schema accommodates it via per-tutorial summary embeddings, but those aren't generated in this slice)
- An external agent-facing semantic API (`/api/v1/ask`) (future use case — same retrieval path, different surface)
- Sliding-window or token-based chunking (rejected: per-step chunking is sufficient and aligns with citation behavior)
- A separate vector database (rejected: HANA-native is sufficient at our scale)

## Approach

**Storage:** HANA-native `Vector(1536)` column with `COSINE_SIMILARITY` for retrieval. SQLite test path uses `LargeBinary` + JS cosine, branched in `embedding-query.js` the same way `content-store.js` already branches BLOB reads.

**Embedding model:** `text-embedding-3-small` (1536 dims) via SAP Generative AI Hub through the existing `tutorials-aicore` service binding. The model name is stored on each row, so a model rotation triggers re-embed via the reconciliation job rather than a code change.

**Chunking:** One embedding per step, keyed by `(tutorial_ID, stepNumber)`. Step text is extracted from the published HTML (not the source markdown) to match what readers actually see. The extractor handles both Hugo output formats: v1 parser ACCORDION blocks (`<div class="accordion-content" data-step="N">`) and v2 parser H3 sections (`<section data-step="N">`). Extracted text is truncated to **8000 characters** at the nearest sentence boundary before embedding (well below the model's context window, and the typical step is far shorter).

**Trigger:** Belt-and-braces — a server-side post-publish hook embeds changed slugs synchronously after `/content/publish`, AND an hourly reconciliation cron catches anything the hook missed (failures, model rotations, slugs published before RAG was enabled).

**Query side:** New tool `getRelevantSteps` registered with the chat orchestrator only when `ChatSettings.ragEnabled` is true. Returns `{ slug, stepNumber, text, score, url }` per hit. Joule persona updated to cite the URL with step anchor when quoting.

**Feature gating:** Four new fields on `ChatSettings` (the existing `@odata.singleton` admin entity) — `ragEnabled`, `embeddingModel`, `embeddingTopK`, `embeddingMinScore`. Surfaced in the existing Joule admin tile under a new "Tutorial Grounding (RAG)" panel. Change-tracked automatically.

**Cold-start:** New admin action `AdminService.seedEmbeddings()` triggers the reconciliation routine on demand — for the first enable, model rotation, or after a long outage.

## Architecture

```
GitHub repos
   │
   ▼
fetch-tutorials.ts ──► hugo/content/tutorials/*.md ──► hugo build
                                                            │
                                                            ▼
                                          publish-content.ts (delta)
                                                            │
                                              POST /content/publish
                                                            │
                                                            ▼
                              ┌─── content-store.js (existing) ────┐
                              │  • write ContentFiles BLOBs         │
                              │  • upsert Tutorials + Steps         │
                              │  • activate ContentManifest         │
                              └─────────────────┬───────────────────┘
                                                │
                                                ▼ (NEW: post-publish hook)
                              ┌─── embedding-pipeline.js (NEW) ────┐
                              │  • read ChatSettings.ragEnabled     │
                              │  • decompress changed slugs         │
                              │  • extract step text (v1 + v2)      │
                              │  • call embedding-client.js         │──► AI Core
                              │    (Generative AI Hub)              │    (text-embedding-3-small)
                              │  • upsert TutorialEmbedding rows    │
                              └─────────────────────────────────────┘

                              ┌─── embedding-reconciliation cron ──┐
                              │  hourly + jitter:                   │
                              │  • read settings, exit if disabled  │
                              │  • find Steps where embedding stale │
                              │    (missing | hash mismatch | model │
                              │     mismatch)                       │
                              │  • call pipeline for those slugs    │
                              └─────────────────────────────────────┘

   Joule chat (/chat/stream) ─► chat-orchestrator.js
                                       │
                                       ▼  (NEW tool, gated by ragEnabled)
                              getRelevantSteps(query)
                                       │
                                       ▼
                  embed query → SQL: ORDER BY COSINE_SIMILARITY(...) LIMIT topK
                                       │
                                       ▼
                  return [{slug, stepNumber, text, score, url, title}]
```

## Components

| File (new) | Responsibility | Inputs | Outputs |
|---|---|---|---|
| `srv/lib/step-text-extractor.js` | Decompress BLOB, parse HTML with cheerio (handles both v1 ACCORDION and v2 H3 step delimiters), return step records. Pure — no DB, no network. Truncates each chunk to 8000 chars at sentence boundary. | gzip Buffer | `[{stepNumber, text, charCount}]` |
| `srv/lib/embedding-client.js` | Wraps `@sap-ai-sdk/foundation-models` embedding call. Batches up to 100 inputs, retries with exponential backoff on 429/5xx (max 3). | `string[]`, model | `Float32Array[]` aligned with input order |
| `srv/lib/embedding-pipeline.js` | Reads `ChatSettings`; if `ragEnabled`, runs extract → embed (via `embedding-client`) → upsert for given slugs. Returns summary. Acquires `embedding-pipeline` distributed lock for concurrency. | slug list, options | `{embedded, skipped, failed}` |
| `srv/jobs/embedding-reconciliation.js` | Hourly job (cron `0 * * * *` + jitter). Walks `Steps` in batches; finds stale rows; calls pipeline. Distributed lock + on/off honors settings. | none | log line + `PipelineLog` row |
| `srv/lib/embedding-query.js` | Reads `topK`/`minScore`/`embeddingModel` from `ChatSettings`, embeds query (via `embedding-client`), runs cosine SQL on HANA (or JS cosine on SQLite), returns hits. | query string | hit list |
| `srv/lib/embedding-stats.js` | Computes coverage stats for the admin UI. Returns `{totalRows, byModel, oldestRow, missingFromSteps, lastReconciliationAt}`. Mounted as a custom Express route `GET /admin/embeddings/stats` in `srv/server.js`, gated by the `Admin` scope. | (admin user) | stats JSON |
| `srv/admin-service.js` (extended) | Implements `seedEmbeddings` action — fire-and-forget: schedules the reconciliation routine via `setImmediate` and returns immediately. Reuses the same `embedding-pipeline` distributed lock as the cron, so concurrent seed + reconciliation runs are safe (the second caller exits early when the lock is held). | (admin user) | `{triggered: true, message}` |

| File (modified) | Change |
|---|---|
| `db/schema.cds` | Add `TutorialEmbedding` entity, add `contentHash` to `Steps`, add four RAG fields to `ChatSettings` |
| `srv/admin-service.cds` | Expose `seedEmbeddings()` action |
| `srv/lib/content-store.js` | Add post-publish hook call to `embedding-pipeline.js`; best-effort, log-and-continue on failure |
| `srv/lib/chat-orchestrator.js` | Define `GET_RELEVANT_STEPS_TOOL`; pass `settings` into `toolsForContext`; register tool only when `settings.ragEnabled` is true; dispatch handler calls `embedding-query.js` |
| `srv/lib/chat-context.js` | Append RAG-citation guidance to `PERSONA` (and `ADMIN_PERSONA`) |
| `srv/jobs/scheduler.js` | Register `embedding-reconciliation` job |
| `app/admin/joule/webapp/view/Settings.view.xml` | Add Panel "Tutorial Grounding (RAG)" with fields and a "Seed now" button bound to the action |
| `app/admin-annotations.cds` | Annotations for the new RAG fields (labels, value-help where useful) |
| `db/change-tracking.cds` | (already covers `ChatSettings`) — confirm new fields tracked |

## Schema additions

### `TutorialEmbedding` (new entity)

```cds
entity TutorialEmbedding {
  key tutorial_ID  : UUID;          // FK to Tutorials.ID (no association — avoid cascade complexity)
  key stepNumber   : Integer;       // matches Steps.stepOrder
  contentHash      : String(64);    // sha256 of the chunk text — staleness detection
  embeddingModel   : String(100);   // e.g. 'text-embedding-3-small' — drives re-embed on rotation
  embedding        : Vector(1536);  // HANA REAL_VECTOR(1536); LargeBinary on SQLite
  text             : LargeString;   // chunk text (returned with hits, also kept for debugging)
  charCount        : Integer;
  createdAt        : Timestamp @cds.on.insert: $now;
}
```

Composite PK `(tutorial_ID, stepNumber)` matches the natural identity of a step chunk. No association to `Tutorials` — keeps cascade behavior simple and matches how `Steps` references its parent today.

### `Steps.contentHash` (new field)

Tiny denormalization: `Steps` gets `contentHash : String(64)`, populated by the extractor at publish time. The hash is `sha256(extractedText)` where `extractedText` is the **post-truncation, post-whitespace-normalization** chunk that will actually be sent to the embedding model — collapsing runs of whitespace to a single space and trimming. This is what makes "is this embedding stale?" a simple equality check between `Steps.contentHash` and `TutorialEmbedding.contentHash`. Both rows must hash the same input or reconciliation will loop forever.

### `ChatSettings` additions (4 fields)

```cds
entity ChatSettings : cuid, managed {
  // existing fields...
  enabled              : Boolean default false;
  deploymentId         : String(100);
  modelName            : String(100);
  temperature          : Decimal(3, 2);
  maxTokens            : Integer;
  maxRequestsPerUser   : Integer default 100;
  bannerText           : String(500);

  // NEW
  ragEnabled           : Boolean default false;
  embeddingModel       : String(100) default 'text-embedding-3-small';
  embeddingTopK        : Integer default 5;
  embeddingMinScore    : Decimal(4, 3) default 0.25;
}
```

- `ragEnabled` — master switch, runtime-toggleable
- `embeddingModel` — drives re-embed via reconciliation when changed
- `embeddingTopK` — chunks returned per query (admin-tunable)
- `embeddingMinScore` — drop hits below this cosine similarity (default 0.25; tune in DEV)

## Data flow

### Publish-time (synchronous, best-effort)

1. `publish-content.ts` POSTs `/content/publish` with delta of changed slugs (existing behavior)
2. `content-store.js` writes BLOBs, upserts Tutorials/Steps, activates the new manifest (existing behavior)
3. **NEW:** `content-store.js` reads `ChatSettings`. If `ragEnabled`:
   - Calls `embedding-pipeline.embedSlugs(slugs, {model: settings.embeddingModel})`
   - Pipeline acquires `embedding-pipeline` distributed lock
   - For each slug: fetch BLOB → decompress → extract step text → compute hashes → diff against existing `TutorialEmbedding` rows → embed only changed/new chunks → upsert
   - Returns `{embedded, skipped, failed}` summary
4. Errors from steps 3 are caught and logged at `warn`; the publish response stays `201` with the existing payload. Reconciliation will retry.

### Reconciliation (hourly, idempotent)

1. Cron fires `embedding-reconciliation` (with jitter, distributed lock)
2. Read `ChatSettings`. If `!ragEnabled`, return.
3. Walk `Steps` rows in batches of 200, joined to `TutorialEmbedding` on `(tutorial_ID, stepNumber)`
4. A row is **stale** if any of:
   - No matching `TutorialEmbedding` row
   - `TutorialEmbedding.contentHash != Steps.contentHash`
   - `TutorialEmbedding.embeddingModel != ChatSettings.embeddingModel`
5. Group stale rows by slug, call `embedding-pipeline.embedSlugs()`
6. Log structured summary; write `PipelineLog` row with type `EMBEDDING_PIPELINE`

### Query (per chat turn)

1. Joule chat turn arrives at `/chat/stream`
2. `chat-orchestrator.js` loads `ChatSettings` (existing behavior)
3. **NEW:** `toolsForContext({...settings})` includes `GET_RELEVANT_STEPS_TOOL` only when `settings.ragEnabled`
4. LLM (gpt-4o or whatever's configured) decides whether to call `getRelevantSteps` based on the user's message and the persona guidance
5. If called: `embedding-query.getRelevantSteps(query, settings)`:
   - Embed the single query string via `embedding-client`
   - HANA: `SELECT TOP topK ... ORDER BY COSINE_SIMILARITY(embedding, TO_REAL_VECTOR(?)) DESC` with filters on `Tutorials.status != 'INACTIVE'` and `embeddingModel = ?`
   - Filter results below `minScore`
   - Join `Tutorials` for `slug` and `title`; build `url = '/tutorials/' + slug + '#step-' + stepNumber`
6. Tool returns `{hits: [...], modelUsed, minScoreThreshold}` to the LLM
7. LLM composes answer citing chunks per persona guidance

### Cold-start / on-demand seed

1. Admin flips `ragEnabled = true` (via admin UI), saves
2. Admin clicks "Seed now" button → calls `AdminService.seedEmbeddings()`
3. Action handler schedules the reconciliation routine via `setImmediate` (fire-and-forget) and returns `{triggered: true, message: '...'}` immediately
4. The scheduled routine acquires the same `embedding-pipeline` distributed lock as the hourly cron — if reconciliation is already running, the seed call exits early with a "lock held" log line (the cron will cover the work)
5. Admin UI polls `GET /admin/embeddings/stats` for progress (totalRows climbing, missingFromSteps shrinking)

## Error handling

| Failure mode | Behavior |
|---|---|
| AI Core embedding endpoint 429 | Exponential backoff in `embedding-client`, max 3 retries; final failure surfaces to pipeline |
| AI Core endpoint down (5xx after retries) | Pipeline returns `{failed: N}`; publish hook logs warn, continues. Reconciliation retries next hour. |
| Cheerio parse fails on a slug | Extractor returns `[]` for that slug, logs warn. Pipeline reports it as failed. Reconciliation retries (will keep failing until content is fixed — visible in logs) |
| HANA `COSINE_SIMILARITY` not available | Should be impossible (HANA Cloud QRC 1/2024+); explicit check at boot logs error. `getRelevantSteps` returns `{hits: [], error: 'unsupported'}` and Joule falls back to `searchTutorials` per persona |
| `ChatSettings` row missing | Treat as `ragEnabled = false` (defaults). Log warn on first read, don't crash. |
| `embeddingModel` rotated | Reconciliation walks corpus, re-embeds rows where model mismatches. Query path filters on current model so mixed states don't blend cosine spaces. |
| Tutorial soft-deleted | Query path filters `Tutorials.status != 'INACTIVE'`. Embeddings remain in DB (cheap). When tutorial is re-activated, no re-embed needed. |
| Tutorial hard-deleted | No cascade currently — leaves orphan `TutorialEmbedding` rows. Add cleanup to existing daily content GC job (`srv/jobs/cleanup.js`) — prune `TutorialEmbedding` rows whose `tutorial_ID` no longer exists in `Tutorials`. |

## Observability

- Structured log per pipeline run: `{event: 'embedding-pipeline', source: 'hook'|'reconciliation'|'seed-action', slugs: N, embedded, skipped, failed, durationMs, model}`
- `PipelineLog` row of type `EMBEDDING_PIPELINE` (existing pattern via `srv/lib/pipeline-log.js`) — visible in admin operations console alongside content publishes
- AI Core call latency + token-count logged at `info`
- New `GET /admin/embeddings/stats` endpoint (custom Express route in `srv/server.js`, gated by `Admin` scope, backed by `srv/lib/embedding-stats.js`) returns `{totalRows, byModel, oldestRow, missingFromSteps, lastReconciliationAt}` — surfaced in admin UI as a coverage health card

## Testing

Three Vitest workspaces matching the existing structure:

| Workspace | New file(s) | Coverage |
|---|---|---|
| unit | `srv/lib/__tests__/step-text-extractor.test.js` | Fixture HTML → expected step records. Covers v1 ACCORDION format, v2 H3 format, missing-body, malformed, oversized chunk truncation |
| unit | `srv/lib/__tests__/embedding-query.test.js` | SQLite path: insert fixture vectors, query → expected ordering and `minScore` filtering. JS cosine matches a known-good reference implementation within tolerance |
| unit | `srv/lib/__tests__/embedding-pipeline.test.js` | Mock `embedding-client` and content-store; verify pipeline upserts correct rows, handles partial failures, respects `ragEnabled` flag |
| unit | `srv/lib/__tests__/chat-orchestrator-rag.test.js` | Tool registration: `getRelevantSteps` present iff `settings.ragEnabled`; dispatch handler returns expected shape |
| hybrid | `test/hybrid/embedding-roundtrip.test.js` | Real HANA: write a `Vector(1536)`, query via `COSINE_SIMILARITY`, verify ordering. Guarded by `ALLOW_HYBRID_WRITES=true` |
| hybrid | `test/hybrid/reconciliation-job.test.js` | Insert stale Steps row (with `contentHash`), run reconciliation, verify `TutorialEmbedding` row exists with current hash + model |
| smoke | `test/smoke/joule-grounded.test.js` | Hit `/chat/stream` with a question that should ground; verify `getRelevantSteps` is called and response cites a slug |

## Rollout

1. Land schema + extractor + client + pipeline (no UI, no tool wiring) — all dormant since `ragEnabled` defaults to `false`
2. Land Joule tool registration + persona update — still dormant
3. Land admin UI fields + seed action + stats endpoint — still dormant
4. Deploy to DEV; admin flips `ragEnabled = true`, clicks Seed, dogfoods chat for a tuning week
5. Tune `embeddingTopK` and `embeddingMinScore` based on observed retrieval quality
6. Enable in PROD

If quality regresses or AI Core is unavailable, flipping `ragEnabled` to `false` removes the tool from Joule's repertoire on the next chat turn — instant rollback, no redeploy.

## Documentation updates (part of this spec's PR)

| File | Change |
|---|---|
| `docs/joule-chat.md` | New section "Tutorial Grounding (RAG)": how `getRelevantSteps` differs from `searchTutorials`, when the LLM picks each, the four `ChatSettings` fields and what they do, how to enable in DEV/PROD, what "stale embedding" means, troubleshooting (no hits / wrong citations / embeddings missing) |
| `docs/developers/architecture/build.md` | Add a step to the end-to-end flow diagram for the post-publish embedding hook + reconciliation. Note that publish stays green even when AI Core is down. |
| `docs/developers/operations/joule-chat-admin-settings.md` (new) | Walkthrough of the new admin UI panel including the Seed button and the stats card |
| `CLAUDE.md` | Add Gotcha: "RAG is gated by `ChatSettings.ragEnabled`. Cold-start requires a publish OR a manual Seed via admin action — the publish hook only embeds *changed* slugs." Add command pointer for `seedEmbeddings` action via curl for ops use. |

## Open questions / future work

- **Tutorial-to-tutorial recommendations** (queued use case 3 from the brainstorm) — would benefit from a per-tutorial summary embedding alongside the per-step embeddings. Schema accommodates: add a sentinel `stepNumber = 0` row with the summary. Defer until needed.
- **Hybrid keyword + vector ranking for `/search` UI** (queued use case 2) — `embedding-query.js` is the natural integration point. Defer until we have retrieval-quality numbers from Joule dogfooding.
- **External agent-facing `/api/v1/ask`** (queued use case 4) — same retrieval path with a public OData function or REST endpoint, behind a separate scope. Defer.
- **Auto-tuning `minScore`** — once we have query/click-through telemetry, we can tune per-query type. For now, single global threshold is sufficient.
