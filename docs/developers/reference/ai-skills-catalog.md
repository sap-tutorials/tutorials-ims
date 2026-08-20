# AI Skills Catalog

> **Purpose.** A single index of every *internal AI capability* ("skill") the platform runs — what each does, how it works, what external data/services it touches, and how to operate/maintain it. Each entry links to its deep-dive doc; this page is the map, not a replacement for those.
>
> **Scope.** In-product AI features executed by the CAP backend (`srv/`) and build pipeline (`scripts/`). It does **not** cover the Claude Code developer skills under `.claude/skills/`. Two things that *look* like AI but aren't: the **Joule Aurora** background is pure CSS ([joule-aurora.md](../architecture/joule-aurora.md)); **AI consumption** ([ai-consumption.md](ai-consumption.md)) is the SEO/agent-citation policy (`robots.txt`, `llms.txt`, JSON-LD), covered in [§8](#8-ai-agent-consumption-policy-not-an-llm-feature).

## 1. Shared foundation

Every LLM/embedding call in the platform goes through **SAP AI Core** (Generative AI Hub); nothing calls an LLM provider directly.

| Concern | Detail |
|---|---|
| **Service binding** | Managed service `tutorials-aicore`, plan `extended`, bound to `tutorials-srv` (`.deploy/mta.yaml:406-412`, `:142`). Consumed via `VCAP_SERVICES.aicore[0].credentials`. |
| **SDK wrappers** | Embeddings → `srv/lib/embedding-client.js` (wraps `@sap-ai-sdk/foundation-models` `AzureOpenAiEmbeddingClient`; batch 100, retry 3× on 429/5xx). Chat/completions → `@sap-ai-sdk/orchestration` `OrchestrationClient` (forced tool-calls). |
| **Models** | Chat default `anthropic--claude-4.6-sonnet` (override `ChatSettings.modelName` / `CHAT_MODEL_NAME`); embeddings `text-embedding-3-small` (1536-dim); explainers GPT-4.1-mini; AI quizzes gpt-4o-class. |
| **Local vs cloud** | `AICore-mocked` profile for local `cds watch` (zero AI Core quota); `AICore-btp` for `[hybrid]`/`[production]`. `@cap-js/ai` leaves `kind` unset so profile defaults apply ([cap-ai-plugin.md](cap-ai-plugin.md)). |
| **Vector storage** | HANA `REAL_VECTOR(1536)`: `TutorialEmbedding.embedding` (per step) and `Concepts.EMBEDDINGVEC` (#1113). Cosine via native `COSINE_SIMILARITY(...)` in raw SQL (avoids LOB-locator expiry); SQLite tests decode BLOB → JS `cosine()`. |
| **Governance** | Runtime flags live on the `ChatSettings` singleton + `KnowledgeGraphSettings`; env-var flags and constants are mirrored in `srv/lib/feature-flags/registry.js` (a drift test fails the build if a flag is added without an entry). See [§7](#7-feature-flags-reference). |
| **Cost control** | Per-day LLM budgets on `ChatSettings` (community labels 50/day, news relevance 100/day), per-user request caps, and build caps for authoring jobs. See [§6](#6-maintenance--operations). |

The skills below fall into four families: **[A] Joule chat + its tools** (interactive), **[B] Knowledge-graph batch jobs** (scheduled), **[C] Content-authoring AI** (build/admin-time), and **[D] Search & recommendation AI**.

---

## 2. Family A — Joule chat assistant

**What.** In-page, page-aware LLM chat on tutorial/mission/search/admin pages, streamed over SSE. Optional RAG grounding over per-step embeddings, plus a registry of tools the model can call. Deep dive: [joule.md](../architecture/joule.md); admin runbook: [joule-chat-admin-settings.md](../operations/joule-chat-admin-settings.md).

**How it works.** Browser `POST /chat/stream` → `srv/lib/chat-orchestrator.js` runs an agent loop (`MAX_TURNS = 5`): stream deltas, execute any tool calls, feed results back as `role:'tool'` messages. `buildSystemPrompt` (`srv/lib/chat-context.js`) layers persona → RAG guidance → progress → what's-new → **community catalog** (labeled Louvain clusters, injected only when `communityPeersEnabled`) → page context → user context.

**Tool registration** is scope-first, then flag-gated (`buildToolRegistry`, chat-orchestrator.js:301-374): Devtoberfest/puzzle/advocates pages get a restricted set; learners get progress + what's-new; admins get docs + analytics tools; then feature-flagged tools append.

### Joule tools

| Tool (LLM-facing name) | Source | What it does | External data | Gate (default) |
|---|---|---|---|---|
| `expandSearchConcepts` | `kg/joule-tool-expand-concepts.js` | Query → related KG concepts + best tutorials; call before `searchTutorials`. On true zero-seed, fire-and-forget enqueues on-demand extraction. | AI Core embedding + cosine over `Concepts` + 1-hop `ConceptEdges` + `TutorialConceptLinks` (via `computeKgSignal`) | `kgSearchExpansionEnabled` (**true**) |
| `findLearningPath` | `kg/joule-tool-find-path.js` | Ordered tutorial sequence from a start to a target; prefers true shortest KG path (`KG_PATH_V2`), falls back to SPARQL neighbors. | Raw SQL on `TUTORIALS`/`CONCEPTS`/`TASKRECORDS`/`TUTORIALCONCEPTLINKS`; SPARQL/graph engine (no LLM) | `kgPathBetweenEnabled` (**false**) |
| `findCommunityPeers` | `kg/joule-tool-community-peers.js` | Sibling tutorials from the same Louvain community as an anchor slug + the cluster label. | `KgCommunity`, `KgCommunityLabel` (no LLM) | `communityPeersEnabled` (**false**, ships dark) |
| `describeCommunity` | `kg/joule-tool-describe-community.js` | Answers "what's the cluster around X"; resolves free-text/LLM-picked label to a labeled community + members. | `KgCommunityLabel` (≤200), deterministic `matchLabel` (no LLM) | `communityPeersEnabled` (**false**) |
| `puzzleHint` | `kg/joule-tool-puzzle-hint.js` | Safe crossword-hint material (clue text, length, wordplay, solver's own crossing letters). **Never reads the answer.** | `Puzzles.layout` only (no LLM) | `puzzleHintEnabled` (**false**) |
| `getRelevantSteps` | RAG via `embedding-query.js` | Retrieves top-K tutorial steps by embedding similarity to ground answers. | `TutorialEmbedding` vector cosine | `ragEnabled` (**false**) |
| `checkCode` | `code-check-llm.js` | LLM checks a learner's code snippet against the step. | AI Core LLM | `codeCheckEnabled` (**false**, #171) |
| `getBranchRecommendation` | branching logic | Recommends a next branch/path. | KG/progress | `branchingEnabled` (**false**, #172) |
| `findRelatedContent` | `kg/external-content-signal.js` | External/related content cards via the KG signal. | `computeKgSignal` | `kgRelatedContentEnabled` (**true**, #1125) |
| `searchTutorials` / `getUserProgress` / `getWhatsNew` | orchestrator | Catalog search (KG-reranked rationales), learner progress, what's-new digest. | `SearchableItems`, progress tables | always / always / `whatsNewEnabled` (**true**) |

**Every tool fails open** — on bad input, missing data, timeout, or dispatch error it returns an empty-result envelope with a `reason`/`warning`, never a 500. **SSE render frames** map tool output to UI cards: `tutorial-cards`, `step-citations`, `external-content-cards`, `community-peers-cards` (peers *and* describeCommunity), `analytics-result`, etc. (chat-orchestrator.js:911-929).

**Maintenance.** Enable/tune in `/admin-ui/#joule` (Joule Settings). Master switch `ChatSettings.enabled` (default **false**). Per-user cap `maxRequestsPerUser` (default 100/24h, in-memory → 429). Needs an AI Core **orchestration-scenario** deployment UUID (not a model-direct id). Diagnose: `cf logs tutorials-srv --recent | grep -E "chat stream failed|registered"`.

---

## 3. Family B — Knowledge-graph batch jobs

Scheduled via CAP 10's Scheduling API through the internal `CronService` (`srv/cron-service.js`), driven by the `JOB_REGISTRY` in `srv/jobs/scheduler.js`. Every job is wrapped by `registerJob` (PipelineLog + JobLastRun; a throw writes a FAILED log and raises `ScheduledJobFailed`). All times UTC. Deep dive: [knowledge-graph.md](../architecture/knowledge-graph.md).

Nightly ordering is deliberate so every algorithm sees the same graph snapshot: **pagerank 03:53 → communities 03:57 → wcc 04:07 → community-labels 04:12 → featured-topics 04:13 → retire-orphans 04:37 → topic-clusters 04:47**.

| Job | Cron (UTC) | Computes | Engine | Reads → Writes | LLM? | Toggle (default) |
|---|---|---|---|---|---|---|
| `kg-pagerank` | `53 3 * * *` | Undirected PageRank (damping 0.85). | **Node.js** (HANA has no PageRank primitive) | `KG_PG_VERTICES_V`/`KG_PG_EDGES_V` → `CONCEPTRANK`, `TUTORIALRANK` | No | reader-side `KG_PAGERANK_ENABLED` (**off**); job always runs |
| `kg-communities` | `57 3 * * *` | Louvain clusters + per-cluster `communityFingerprint`. | **HANA GraphScript** `KG_LOUVAIN_GRAPH` | KG_PG workspace → `KGCOMMUNITY` | No | always runs |
| `kg-wcc` | `7 4 * * *` | Weakly-connected components; flags isolated concept/tutorial vertices. | **Node.js** union-find (HANA ships only SCC) | `KG_PG_*` → `KGISOLATION` | No | `KG_WCC_ISOLATION_THRESHOLD` (1) |
| `kg-community-labels` | `12 4 * * *` | LLM-names each community with ≥2 tutorials; skips unchanged member sets (`memberSlugsHash`). | Node planner + **LLM** | `KgCommunitySummaryV`, `KgCommunity` → `KgCommunityLabel` | **Yes** — `community-label-llm.js`, forced tool-call | budget `communityLabelLlmBudgetPerDay` (**50/day**) |
| `kg-retire-orphans` | `37 4 * * *` | Flips ACTIVE→RETIRED concepts with zero links across all 10 link tables, older than the age cutoff. Reversible (nothing deleted). | Raw SQL | `Concepts` + 10 link tables → `Concepts.status` | No | `KG_RETIRE_ORPHANS_ENABLED` (**on**; only `'false'` disables), age `KG_RETIRE_ORPHANS_AGE_DAYS` (14) |
| `kg-ondemand-drain` | `1-59/2 * * * *` | Drains PENDING on-demand requests: embed query → cosine-rank tutorials → extract concepts from top-K (**link-only, never mints**; reactivates retired). | Node + **LLM** (embed + extract) | `KgOnDemandRequests`, `TutorialBodyText`, `TutorialEmbedding` → `TutorialConceptLinks`, request status | **Yes** — embed + `extractConceptsFromTutorial` | needs **both** KG `enabled` (**off**) AND `onDemandExtractionEnabled` (**off**); link floor 0.7; batch/attempt env knobs |

Adjacent KG jobs consuming these sidecars: `kg-topic-clusters` (`47 4 * * *` → `TopicClusters`) and `kg-featured-topics` (`13 4 * * *` → `FeaturedTopicsSnapshot`).

**Fail-open.** Every job writes its sidecar in a single `db.tx` (TRUNCATE + batched INSERT) so readers keep yesterday's data on any fault; readers positively filter `status='ACTIVE'` / leave badges unset. Metrics per job: `<name>_duration_ms`, `<name>_failures`, plus feature gauges (e.g. `kg_communities_count`, `kg_pagerank_nodes_scored`).

---

## 4. Family C — Content-authoring AI

Build-time / admin-time LLM features that generate or grade content. These are **not** in the interactive request path (except the free-text grader, which runs on learner submit).

### 4.1 Categories classifier — [categories-classifier.md](../architecture/categories-classifier.md)
Tags Missions/Groups/Tutorials into the `/browse/` Categories facet: **embedding-similarity first, LLM fallback second**. Source `srv/lib/category-classifier.js` + `categories-after-hooks.js`; backfill `scripts/backfill-categories.cjs`. Data: category `seedDescription` embeddings, junction tables; AI Core `text-embedding-3-small` + LLM fallback. Triggered by after-hook on INSERT/UPDATE (5s debounce), admin "Re-classify (force)", or deploy backfill. **No on/off flag** — tuned by constants (`HIGH_THRESHOLD` 0.32, `AMBIGUITY_GAP` 0.05, `MAX_CATEGORIES` 3, `LLM_TIMEOUT_MS` 8000). Job-lock `categories-classify` prevents concurrent bulk runs; edit seeds + re-embed via `/admin-ui/#categories-display`.

### 4.2 Free-text grader — [free-text-grader.md](../architecture/free-text-grader.md)
Server-side LLM grading of `[VALIDATE_N]` text questions marked `###Grading: ai-judged` (3-state: pass/partial/fail), keeping `correctAnswer` off the public wire. Source `srv/lib/validate-answer-*.js`. Runtime: learner `POST /api/validate-answer` (XSUAA, rate-limited **30/hr** + **5/5min** per step → 429). Data: `ValidateAnswerSpecs` (answer/question), `ValidateAnswerSubmissions` (telemetry); AI Core forced tool-call with `redactReferenceLeaks` scrubbing. Toggle `ChatSettings.validateAnswerEnabled` (**false**); disabled → 503, never marks learner wrong. Token spend tracked via seeded Analytics saved queries.

### 4.3 AI-authored quizzes — [ai-authored-quizzes.md](../architecture/ai-authored-quizzes.md)
Build-time author opt-in (`[AUTOAUTHOR_*]`): an LLM synthesizes quiz questions from step bodies into normal `ValidationQuestion`s (AI-text answers then flow through the free-text grader). Source `srv/lib/ai-quiz-generator.js` (`PROMPT_VERSION`), `scripts/lib/expand-ai-authored.ts`. Triggered by `npm run fetch-tutorials` / `seed-ai-quizzes` / CI rebuild — **not** a runtime call. Flag graduated & removed 2026-06-13 (#275): **always-on** for non-`catalog-only` rebuilds; build cap `AI_AUTHOR_BUILD_CAP=200`. Cache `.tutorial-cache/<slug>.ai-quiz-cache.json` (invalidate by editing step or bumping `PROMPT_VERSION`; **model-swap does not auto-invalidate**). Pre-go-live: `npm run preflight:ai-quiz-smoke`. CI runbook: [ai-author-ci-setup.md](../operations/ai-author-ci-setup.md).

### 4.4 Homepage explainers — [homepage-explainers.md](../architecture/homepage-explainers.md)
AI-generates progressive-disclosure `tagline` + `whyItMatters` for homepage verb cards, shelf headers, per-link cards. Source `srv/lib/explainer-generator.js` + `srv/lib/prompts/explainer-*.txt`. Admin actions `generateVerb/Shelf/ShelfEntryExplainers` (modes all/blanks/selected) → write triggers a `catalog-only` rebuild. Data: `VerbDefinitions`/`ShelfDefinitions`/`HomepageShelves`; AI Core GPT-4.1-mini (`response_format` JSON). Kill switch env `AICORE_EXPLAINER_GENERATOR_DISABLED=true` → 503. Gated by `AuthoringStatus` lifecycle (BLANK→AI_SEEDED→REVIEWED); hard limit 100 rows/call (~$0.01/row).

### 4.5 Other LLM authoring/classification modules
Direct `@sap-ai-sdk` call sites registered in the flags registry, each budget- or flag-gated:
- **News relevance classifier** — `srv/lib/relevance-classifier.js` (#1034). Scores news/blog relevance; budget `newsRelevanceLlmBudgetPerDay` (**100/day**), `newsRelevanceMargin` (0.150). Deliberately bypasses `@cap-js/ai` to avoid the AICore kind-resolution path.
- **Community blogs classifier** — `COMMUNITY_BLOGS_CLASSIFIER_ENABLED` (**on**, #1033).
- **OS-variant generator** — `srv/lib/os-variant-generator.js` (LLM-generates OS-specific step variants).
- **Code-check** — `srv/lib/code-check-llm.js` (also backs the Joule `checkCode` tool).

---

## 5. Family D — Search & recommendation AI

### 5.1 Search KG re-ranking — `srv/lib/search-kg-signal.js`
Wired in `SearchService.before('READ', SearchableItems)` (search-service.js:226-270), gated by `ChatSettings.searchKgRerankEnabled` (**true**, #945).
- **Concept-overlap term (`KG_WEIGHT`, #945).** `final_rank = fuzzy_rank + 2.0 × kg_score`, where `kg_score = Σ(concept_score × link_confidence)` from query embedding → cosine over `Concepts` → 1-hop `ConceptEdges` (walk boost 0.5) → `TutorialConceptLinks`. `KG_WEIGHT` is a fixed **constant 2.0** (not runtime-tunable). 5-min LRU + single-flight + 5000ms deadline.
- **Community term (`communityRankWeight`, #1171).** Additive `+ W × (peer ? 1.0 : 0)` boost for tutorials sharing a Louvain community with the top-5 concept hits. Source of truth is `ChatSettings.communityRankWeight` (Decimal, default **0 = off**); env `KG_COMMUNITY_WEIGHT` is only a null-fallback. Default 0 short-circuits before any DB work. Only computes when the rerank flag is also on.

The same `computeKgSignal` feeds Joule's `searchTutorials` rationales, `expandSearchConcepts`, and `findRelatedContent`. Anonymous ⌘K palette search uses the parallel `srv/lib/kg/search-kg-handler.js` (3000ms timeout, no queue imports, #1036).

### 5.2 @cap-js/ai RPT-1 ValueList recommendations — [cap-ai-plugin.md](cap-ai-plugin.md)
Auto-attaches SAP **RPT-1** recommendations to every `@Common.ValueList` field in Fiori draft admin UIs (a one-click accept chip above value-help). Fields defined in `app/admin-annotations.cds` (e.g. `Missions.tags`, `Advocates.topics`, `Events.tags`). Config: `cds.requires.AICore` (`package.json:222-231`, `resourceGroup: default`); **`@cap-js/ai/srv/AICoreService` must be in the srv build-task model list** (`.cdsrc.json:11`, #1276) or admin draft-create 500s on CF. Per-field opt-out `@UI.RecommendationState: 0` (supports dynamic expressions). First form-load post-deploy triggers a one-time RPT-1 deployment (~5-20s).

### 5.3 Embeddings & RAG — `srv/lib/embedding-query.js`, `kg/concept-embedding-query.js`, `kg/on-demand-cosine-rank.js`
1536-dim vectors in HANA. Three uses: (a) Joule RAG `getRelevantSteps` over `TutorialEmbedding` (gated `ragEnabled`; `embeddingTopK` 5, `embeddingMinScore` 0.25); (b) KG concept cosine seeding over `Concepts.EMBEDDINGVEC`; (c) on-demand tutorial ranking. HANA path uses native `COSINE_SIMILARITY` in raw SQL (query vector serialized as a 6-decimal JSON-array literal); SQLite tests fall back to JS cosine. Async embedding pipeline runs after `POST /content/publish` (`setImmediate`), reconciled hourly (`:17`) with a daily orphan cleanup (03:30).

---

## 6. Maintenance & operations

**Where to change behavior**
- **Runtime feature flags** → `/admin-ui/#joule` (Joule Settings) edits the `ChatSettings` singleton; KG behavior via `KnowledgeGraphSettings` (admin) or env fallback. Prefer DB-driven config over env vars where a column exists.
- **Env-var flags** → `cf set-env tutorials-srv <VAR> <value> && cf restart tutorials-srv`. All are listed in [§7](#7-feature-flags-reference).
- **Every new flag must be registered** in `srv/lib/feature-flags/registry.js` — a drift test fails the build otherwise. A new Boolean on a `*Settings` entity additionally trips the feature-flags-registry guard test until registered.

**Budgets & caps** (guard AI Core spend)
| Feature | Cap | Where |
|---|---|---|
| Community labels | 50 LLM calls/day | `ChatSettings.communityLabelLlmBudgetPerDay` |
| News relevance | 100 LLM calls/day | `ChatSettings.newsRelevanceLlmBudgetPerDay` |
| AI quizzes (build) | 200 questions/build | `AI_AUTHOR_BUILD_CAP` |
| Explainers | 100 rows/call (~$0.01/row) | hard limit |
| Free-text grader | 30/hr + 5/5min per step | in-memory, resets on restart |
| Joule chat | 100 requests/user/24h | `ChatSettings.maxRequestsPerUser` |

**Disabling a skill** — flip its `ChatSettings` flag to false (Joule tools, grader), set its env kill-switch (`AICORE_EXPLAINER_GENERATOR_DISABLED`, `KG_RETIRE_ORPHANS_ENABLED=false`), or set a weight/budget to 0. Batch jobs without a flag stop only if unscheduled; their *readers* are separately gated (e.g. `KG_PAGERANK_ENABLED`), so an unread sidecar is harmless.

**Observability** — batch jobs emit `<name>_duration_ms`/`_failures` metrics and PipelineLog rows (see [observability.md](../architecture/observability.md)); scheduler recovery in [scheduler-troubleshooting.md](../operations/scheduler-troubleshooting.md). Joule diagnostics via `cf logs`. Grader/quiz token spend surfaces in Analytics Builder saved queries.

**Adding a new AI skill** — (1) put the LLM call behind `@sap-ai-sdk/orchestration` or the embedding client, never a raw provider SDK; (2) add a `ChatSettings`/`KnowledgeGraphSettings` flag (default **off** for anything new-and-cloud) and register it in `registry.js`; (3) add a per-day budget or request cap if it hits an LLM at runtime; (4) fail **open** (empty envelope + `reason`, never a 500 into the request/tx); (5) if it writes a sidecar in a batch job, do it in one `db.tx` and register in `scheduler.js`; (6) if it touches `srv/lib/`, re-walk the `srv-qa` cp-list audit ([mta.yaml](../../../.deploy/mta.yaml)); (7) document it here + a deep-dive doc.

---

## 7. Feature flags reference

**`ChatSettings` singleton** (`db/schema.cds`, admin-edited) — AI-relevant flags:

| Flag | Default | Skill |
|---|---|---|
| `enabled` | `false` | Joule master switch |
| `ragEnabled` | `false` | RAG grounding (`getRelevantSteps`) |
| `codeCheckEnabled` | `false` | `checkCode` (#171) |
| `validateAnswerEnabled` | `false` | Free-text grader (#209) |
| `branchingEnabled` | `false` | `getBranchRecommendation` (#172) |
| `kgPathBetweenEnabled` | `false` | `findLearningPath` (#445) |
| `kgSearchExpansionEnabled` | **`true`** | `expandSearchConcepts` (#943) |
| `searchKgRerankEnabled` | **`true`** | Search KG rerank; gates community term (#945) |
| `kgRelatedContentEnabled` | **`true`** | `findRelatedContent` (#1125) |
| `communityPeersEnabled` | `false` | `findCommunityPeers` + `describeCommunity` (#1126) |
| `puzzleHintEnabled` | `false` | `puzzleHint` |
| `communityRankWeight` | `0` (off) | Search community boost (#1171) |
| `communityLabelLlmBudgetPerDay` | `50` | community-labels job budget |
| `newsRelevanceLlmBudgetPerDay` / `newsRelevanceMargin` | `100` / `0.150` | news relevance (#1034) |
| `whatsNewEnabled` | **`true`** | `getWhatsNew` (#1859) |
| `embeddingModel` / `embeddingTopK` / `embeddingMinScore` | `text-embedding-3-small` / `5` / `0.25` | RAG tuning |

**`KnowledgeGraphSettings`** — `enabled` (null→env), `onDemandExtractionEnabled` (`false`), `extractBuildCap`, `mergeSimThreshold*` (all nullable → env fallback; CSV seed kept empty so HDI redeploy never clobbers operator values).

**Env-var flags** (mirrored in `registry.js`): `KNOWLEDGE_GRAPH_ENABLED` (off), `KG_ONDEMAND_ENABLED` (off, #948), `KG_PAGERANK_ENABLED` (off, #916) + `KG_PAGERANK_ALPHA`, `KG_PATH_V2_ENABLED` (off, #913), `KG_WCC_ISOLATION_THRESHOLD` (1, #918), `KG_RETIRE_ORPHANS_ENABLED` (on) + `KG_RETIRE_ORPHANS_AGE_DAYS` (14, #1115), `KG_WEIGHT` (const 2.0, #945), `KG_COMMUNITY_WEIGHT` (0, #1171), `AICORE_EXPLAINER_GENERATOR_DISABLED` (off), `CHAT_MODEL_NAME`, `KG_EMBED_MODEL`, plus on-demand sizing knobs `KG_ONDEMAND_DRAIN_BATCH` (3) / `KG_ONDEMAND_TUTORIALS_PER_REQ` (5) / `KG_ONDEMAND_MAX_ATTEMPTS` (3).

---

## 8. AI-agent consumption policy (not an LLM feature)

For completeness: [ai-consumption.md](ai-consumption.md) documents how the site lets external AI agents **cite** tutorials without permitting training — `robots.txt` bot allowlist (GPTBot, ClaudeBot, PerplexityBot…), `sitemap.xml`, `llms.txt` / `llms-full.txt`, public `AGENTS.md`, per-page JSON-LD (HowTo/Course/…), and `Content-Signal: index=yes, ai-train=no, ai-search=yes` headers from the AppRouter. It is a build/edge concern, not an AI Core consumer.

---

*Maintainer note: this catalog is hand-curated. When you add, remove, or re-gate an AI feature, update the relevant row here and its deep-dive doc in the same PR. Source of truth for flags remains `srv/lib/feature-flags/registry.js` + `db/schema.cds`.*
