# Knowledge graph — Phase 4 architecture design

- **Status:** Approved (2026-06-28), pending spec-reviewer pass
- **Issue:** [#447](https://github.com/sap-tutorials/tutorials-ims/issues/447) (parent: [#381](https://github.com/sap-tutorials/tutorials-ims/issues/381))
- **Predecessor specs:**
  - [`2026-06-17-knowledge-graph-design.md`](./2026-06-17-knowledge-graph-design.md) (Phase 1)
  - [`2026-06-27-446-knowledge-graph-phase3-design.md`](./2026-06-27-446-knowledge-graph-phase3-design.md) (Phase 3)
- **Successor specs** (one per sub-phase, written separately):
  - 4.1 Learning Journeys (next)
  - 4.2 Blog posts, 4.3 Discovery + trials, 4.4 Videos, 4.5 API docs, 4.6 Code samples (future)

## Summary

Phase 4 expands the knowledge-graph corpus from "the ~1500 tutorials at `sap-tutorials/*`" to **the SAP developer-content ecosystem** — adding learning journeys, blog posts, trials, discovery missions, videos, API docs, and code samples as first-class graph nodes alongside tutorials. This spec **does not implement any sub-phase**; it locks the cross-cutting architecture so each of the 6 sub-phases ships against a uniform chassis with a small, predictable per-sub-phase delta.

The architecture preserves Phase 1's graph projection + extraction pipeline shape, Phase 3 Track 3-A's concept landing pages, and Phase 3 Track 3-B's `/explore/` viz. New content types plug into all three surfaces through extension points the chassis defines.

## Scope

### In scope

- **Per-content-type chassis** — a reusable artifact template that every sub-phase implements (entity, link entity, IRI prefix entry, extractor adapter, cron job, projection helper, UI surface deltas, test triad).
- **Shared `sap-devs-client.js` MCP wrapper** — new module wrapping `sap-devs` MCP-server access with per-tool TTL cache + retry + schema validation. Consumed by sub-phases 4.1, 4.2, 4.4 directly and partly by 4.3.
- **Refactor of `srv/lib/kg-extract.js`** into a generic `extractConceptsCore({system, user, schema, callModel})` + per-type adapters. Phase 1's `extractConceptsFromTutorial` becomes the first adapter — same public signature, same cron call site.
- **Concept-registry coherence strategy** — pre-fetch nearest-neighbor concepts as a prompt-time registry hint so per-sub-phase extractors strongly prefer reusing existing slugs over minting near-duplicates.
- **Per-type TTL table + shared `isWithinTTL` projection filter** + chassis-level `pinUntil` admin override + weekly GC cron for double-TTL stale rows.
- **Ship order**: 4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6. Each sub-phase lifts the architecture decisions verbatim; the sub-phase brainstorm only debates content-specific details.

### Out of scope

- Implementation of any sub-phase. This spec produces no entities, no cron jobs, no Hugo pages.
- Generalization beyond the SAP developer ecosystem. Cross-org content (third-party SAP blogs on Medium/dev.to) and paywalled material remain out — matches the issue's "Out of scope (probably ever)" list.
- Refactoring Phase 1's `extract-concepts-job.js` cron shell. The 519-line file keeps its current structure; only the `extractConceptsFromTutorial` function it calls gets refactored (rename + adapter-extraction).
- Per-sub-phase content schema columns, prompt templates, predicate names, cron schedules, and concept-page section copy. Those are explicit per-sub-phase brainstorm concerns.

## 1. Architectural decisions (Q2-Q9)

Eight decisions resolved during brainstorming, with rationale:

| # | Decision | Rationale |
|---|---|---|
| Q2 | Extractor: **generic core + per-type adapters** | Phase 1's `extractConceptsFromTutorial` is 519 lines mostly persistence. Split the LLM-call core (content-agnostic) from per-type prompt + persistence (content-specific). Phase 1's call site renames cleanly without semantic change. |
| Q3 | Data model: **per-type CDS entities + per-type link entities** | Phase 1 / Track 3-A precedent (every existing content type is a dedicated entity). `contentHash` cache key sits naturally on per-type link entity. Per-type GC + admin tooling get the conventions they expect. |
| Q4 | IRI prefix registry: **extend existing `KG_IRI_PREFIXES`** | Track 3-B established this registry exactly for this kind of extension. Lockstep test (`test/unit/srv/kg-explore-data-iri-types.test.js`) catches drift automatically. |
| Q5 | GC strategy: **`lastSeenAt` + per-type TTL** (date-aware for trials) | Phase 1's `Concepts` already uses `firstSeenAt`/`lastSeenAt`. Per-type TTL encodes "freshness" differently for stable curricula vs time-sensitive blogs. Time-based, no admin disposition required. |
| Q6 | Concept linking: **shared `Concepts` registry + registry-hint prompt** | Concept landing pages aggregate across content types (the showcase pitch's "everything about CAP handlers in one place"). Prompt-time hint mitigates synonym-noise risk without giving up cross-pollination. |
| Q7 | UI integration: **per-type sections on concept pages + single "Other resources" section on tutorial-OP sidebar** | Sidebar's job is "while reading this, what helps now?" (concise). Concept landing page's job is "everything about this topic" (long is expected). Explore viz + mobile typed-list auto-extend via the IRI registry. |
| Q8 | Fetching: **per-type cron jobs + shared `sap-devs-client.js`** | Schedules differ per content type (weekly journeys → 1-2h trials). Shared client gives consistent retry/cache/validation. Per-type cron file isolates testing and concerns. |
| Q9 | Ship order: **4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6** | Issue author's order. 4.1 (Journeys) is high-value low-complexity; 4.2 (Blogs) lands time-sensitive decay logic that 4.3-4.4 inherit; 4.5 (API docs) is hand-curated polish; 4.6 (Samples) is trickiest semantic last. |

## 2. Per-content-type chassis

Each sub-phase ships these six artifact templates, scoped to its content type. The unit-of-work shape is uniform; what varies is content-specific columns, prompts, schedules, and predicates.

### 2.1 CDS schema — per-type entity + per-type link entity

New file `db/external-content.cds` separates Phase 4 schema from Phase 1's `db/knowledge-graph.cds`.

```cds
namespace com.sap.developers.ims.external;

using { managed, cuid } from '@sap/cds/common';
using { com.sap.developers.ims as ims } from '../db/knowledge-graph';

// Example shape (Learning Journeys; each sub-phase swaps the content-specific
// columns but keeps the chassis-level columns identical).
entity LearningJourneys : cuid, managed {
  slug          : String(80) @assert.unique;
  title         : String(255);
  description   : String(1000);
  url           : String(500);
  sourceId      : String(120);             // upstream identifier
  contentHash   : String(64);              // SHA-256, cache key for extractor
  firstSeenAt   : Timestamp @cds.on.insert: $now;
  lastSeenAt    : Timestamp;               // refreshed on every successful fetch
  pinUntil      : Timestamp;               // optional admin override (see Section 5.3)

  // Content-specific (per sub-phase):
  level         : String(20);              // 'beginner' | 'intermediate' | 'advanced'
  durationHours : Decimal(4, 1);
}

entity LearningJourneyConceptLinks : cuid, managed {
  journey       : Association to LearningJourneys @assert.notNull;
  concept       : Association to ims.Concepts;
  predicate     : String(20);              // 'partOfJourney' | 'journeyPrerequisite'
  confidence    : Decimal(3, 2);
  extractedAt   : Timestamp;
  modelVersion  : String(40);
}

annotate LearningJourneyConceptLinks with
  @assert.unique.journeyConcept : [journey, concept, predicate];
```

**Chassis-owned columns** (every per-type entity): `slug`, `title`, `description`, `url`, `sourceId`, `contentHash`, `firstSeenAt`, `lastSeenAt`, `pinUntil`.

**Per-content-type columns**: anything else the content type needs (`LearningJourneys.level`, `BlogPosts.publishedAt`, `Videos.youtubeId`, `Trials.endDate`, etc.). Each sub-phase spec lists its specific columns.

**Link entity convention**: source-side FK is the per-type entity; target-side FK is the shared `com.sap.developers.ims.Concepts`. Predicates are per-content-type (see Section 2.3).

### 2.2 IRI prefix + projection helper

In `srv/lib/kg-projection.js` (the registry from Track 3-B):

```javascript
export const KG_IRI_PREFIXES = Object.freeze({
  // existing 7 entries (tutorial, concept, mission, group, product, category, tag)
  // ...

  // Phase 4 additions (one per sub-phase as it ships):
  'learning-journey': 'https://developers.sap.com/kg/learning-journey/',
  // 'blog-post': 'https://developers.sap.com/kg/blog-post/',           (4.2)
  // 'trial': 'https://developers.sap.com/kg/trial/',                   (4.3)
  // 'discovery-mission': 'https://developers.sap.com/kg/discovery-mission/', (4.3)
  // 'video': 'https://developers.sap.com/kg/video/',                   (4.4)
  // 'api-doc': 'https://developers.sap.com/kg/api-doc/',               (4.5)
  // 'sample': 'https://developers.sap.com/kg/sample/',                 (4.6)
});

export function iriLearningJourney(slug) {
  return KG_IRI_PREFIXES['learning-journey'] + slug;
}
```

The existing lockstep test enforces parity between `KG_IRI_PREFIXES` keys and the exported `iri*` helpers. Adding a registry entry without the helper (or vice versa) fails the test.

### 2.3 Extractor adapter

`srv/lib/kg-extract.js` is refactored to expose:

```javascript
// Generic core, content-type-agnostic. Receives prompts + schema, runs the
// forced-tool-call LLM, validates the response against the schema, returns
// the verdict. Approximately 80 lines extracted from today's
// extractConceptsFromTutorial.
export async function extractConceptsCore({ system, user, schema, callModel }) {
  // existing LLM-call + schema-validation logic from kg-extract.js
}

// Per-type adapter. Builds the type-specific prompts (with the
// nearest-neighbor registry hint per Section 4), calls the core, returns
// the validated verdict.
export async function extractConceptsFromTutorial({ callModel, tutorial, nearestConcepts }) {
  const system = TUTORIAL_SYSTEM_PROMPT;
  const user = renderTutorialPrompt(tutorial, nearestConcepts);
  return await extractConceptsCore({ system, user, schema: KG_EXTRACT_SCHEMA, callModel });
}

// Phase 4 adapters land per sub-phase:
// export async function extractConceptsFromLearningJourney(...) { ... }   (4.1)
// export async function extractConceptsFromBlogPost(...) { ... }          (4.2)
// ...
```

The forced-tool-call schema (`KG_EXTRACT_SCHEMA`) is shared. Per-type adapters differ in:

- **System prompt**: content-type-specific framing ("This is a learning journey describing a curriculum…").
- **User prompt**: includes the content body + the nearest-neighbor registry hint (Section 4).
- **Predicate vocabulary**: each adapter knows which predicate(s) it produces.
  - Tutorials → `teaches`
  - Learning Journeys → `partOfJourney`, `journeyPrerequisite` (TBD per 4.1 spec)
  - Blog posts → `discusses` (TBD per 4.2 spec)
  - Videos → `videoReferenceFor` (TBD per 4.4 spec)
  - API docs → `officialReferenceFor` (TBD per 4.5 spec)
  - Code samples → `embodies` (TBD per 4.6 spec — explicitly different from `teaches`)

Exact predicate naming is per-sub-phase concern. Architecture spec only locks the pattern.

### 2.4 Cron job

One file per sub-phase: `srv/jobs/fetch-<content-type>-job.js`. Pattern mirrors Phase 1's `srv/jobs/extract-concepts-job.js`:

```javascript
// srv/jobs/fetch-learning-journeys-job.js (template; per-sub-phase will tune).
import { sapDevsClient } from '../lib/sap-devs-client.js';
import { extractConceptsFromLearningJourney } from '../lib/kg-extract.js';
import { isWithinTTL } from '../lib/external-content-ttl.js';

export async function runFetchLearningJourneys({ db, log, callModel, embed }) {
  // 1. Pull list from MCP (cached upstream by sap-devs-client.js).
  const journeys = await sapDevsClient.searchLearningJourneys({ limit: 200 });

  // 2. Upsert into LearningJourneys table; touch lastSeenAt.
  // 3. For each journey whose contentHash changed since last extraction:
  //    a. Embed the content body.
  //    b. Pre-fetch K=15 nearest-neighbor concepts (Section 4).
  //    c. Call extractConceptsFromLearningJourney({...}).
  //    d. Persist LearningJourneyConceptLinks rows + merge-on-write new concepts.
  // 4. Log token spend + row counts.
}
```

Each cron job runs inside `runWithLock` (distributed locking via `JobLocks`) with a content-type-specific lock name. Schedule is per sub-phase (declared in `srv/jobs/scheduler.js`).

### 2.5 Projection extension

`srv/lib/kg-projection.js` gains a per-type helper called from the main `graphRebuild` projection loop:

```javascript
function buildLearningJourneyTriples({ journeys, links }) {
  const triples = [];
  for (const j of journeys) {
    if (!isWithinTTL('learning-journey', j.lastSeenAt)) continue;
    // Emit type triple + label triple + slug triple.
    // ... (mirrors buildTutorialTriples shape)
  }
  for (const link of links) {
    // Same TTL check on the journey side.
    // Emit (journey-iri, predicate-iri, concept-iri) triple.
  }
  return triples;
}
```

Each sub-phase adds one helper + one call-site in the main projection function. Trials' helper additionally checks `endDate > NOW() - 30d` (Section 5.2's date-aware branch in `isWithinTTL`).

### 2.6 UI surface deltas

The chassis defines extension points; each sub-phase fills them in:

| Surface | Phase 4 delta |
|---|---|
| **Concept landing page** (`hugo/layouts/concepts/single.html`) | One new section per sub-phase. Order follows `KG_IRI_PREFIXES`. Section hidden when empty. Section heading copy is per-sub-phase. |
| **Tutorial-OP sidebar** (`hugo-apps/src/related-graph/RelatedGraph.vue`) | Single new section "Other resources" (capped at 5 items, mixed types). Reads from extension to `/graph/neighborhood` or a new sibling endpoint. Lands incrementally — 4.1 ships the section + endpoint; 4.2-4.6 just add rows to it. |
| **Explore viz** (`app/explore/`) | Automatic. New node types appear once `KG_IRI_PREFIXES` is extended + the projection emits them. `FilterDropdown` enumerates entries from the registry. |
| **Mobile typed-list** (`app/explore/src/components/MobileTypedList.vue`) | Automatic via `SECTION_ORDER` array (currently 7 entries; widens with each sub-phase). |
| **`NodeType` + `PredicateType` unions** (`hugo-apps/src/related-graph/types.ts` + `app/explore/src/types.ts`) | Widen per sub-phase as new node + edge types ship. |

The Vue-component bundle stays under its 150KB gzip budget — each sub-phase's contribution is small (~1-2 KB).

### 2.7 Test triad

Same three tiers Phase 3 used (unit + hybrid + smoke), per sub-phase:

- **Unit**: extractor adapter (mocked LLM); projection helper (mocked rows); `isWithinTTL` filter behaviour for the content type's TTL; the per-sub-phase concept-page section rendering.
- **Hybrid**: cron job end-to-end against real HANA (BLOCKED-until-deploy for the new tables).
- **Smoke**: deployed `/concepts/<slug>/` page rendering at least one of the new sections; `/graph/explore-data` returning the new node types.

### 2.8 Per-sub-phase deliverable size estimate

| Artifact | LoC range |
|---|---|
| CDS schema (entity + link entity) | 30-60 |
| IRI prefix + helper | 3-5 |
| Extractor adapter | 50-80 |
| Cron job | 150-200 |
| Projection extension | 30-50 |
| UI surface deltas | 50-100 (split across files) |
| Tests (3 tiers) | 200-400 |
| **Total per sub-phase** | **~500-900 lines** |

Six sub-phases × ~700 lines average = ~4,200 lines across the whole Phase 4 effort. Equivalent to roughly two Track 3-A's, spread across six PRs.

## 3. Shared `sap-devs-client.js` MCP wrapper

New module at `srv/lib/sap-devs-client.js`. Pattern matches existing thin wrappers (`srv/lib/embedding-client.js`, `srv/lib/code-check-llm.js`).

### 3.1 Responsibilities (what it owns)

- **MCP-server connection** — lazy-init stdio child-process; graceful reconnect on broken-pipe.
- **Per-tool TTL cache** — two-tier: in-process LRU (~50 entries per tool) + on-disk JSON cache (`.cache/sap-devs/<tool-name>/<query-sha256>.json`).
- **Per-tool retry with backoff** — 3 attempts, 200ms / 1s / 5s.
- **Per-tool result schema validation** — each tool has a typed response shape; the client validates before returning. Corrupt responses crash the cron job's test rather than landing in production.

### 3.2 Public API

```javascript
// srv/lib/sap-devs-client.js
export const sapDevsClient = {
  async searchLearningJourneys({ limit = 200 } = {}) { /* ... */ },
  async getRecentNews({ limit = 50 } = {}) { /* ... */ },
  async getNewsDetail(communityUrl) { /* ... */ },
  async searchVideos({ query, limit = 100 } = {}) { /* ... */ },
  async searchDiscovery({ query, type = 'missions', limit = 50 } = {}) { /* ... */ },
  async getSamples({ pack, limit = 100 } = {}) { /* ... */ },
  async searchResources({ query, limit = 50 } = {}) { /* ... */ },
};

// Test hooks
export function _resetCache() { /* clears in-process + disk cache */ }
export function _setMockTransport(mock) { /* swap MCP transport for unit tests */ }
```

Each method returns `Promise<Array<NormalizedRow>>`. Per-tool NormalizedRow shape is documented in JSDoc at the client. The downstream cron-job re-validates with a Zod-or-equivalent schema as defense-in-depth.

### 3.3 Per-tool TTL table

| Tool | TTL | Rationale |
|---|---|---|
| `search_learning_journeys` | 24h | Curriculum changes rarely |
| `get_recent_news` | 1h | New blog posts publish daily |
| `search_videos` | 6h | Mid-frequency YouTube uploads |
| `search_discovery` | 6h | Mission catalog refresh cadence |
| `get_samples` | 24h | SAP-samples repo low-frequency |
| `search_resources` | 24h | API doc / curated content low-frequency |
| `get_news_detail` | 12h | Once a post is in the index it's stable |

Note: this is the **MCP-tool cache TTL** (how often the client re-fetches from `sap-devs`). It's distinct from the **per-content-type graph TTL** in Section 5 (how long a row stays projected after `lastSeenAt`).

### 3.4 What it does NOT own

- Per-cron-job semantics (cron job decides what "stale" means; Section 5 owns that).
- Persistence (client returns parsed rows; cron job writes DB).
- Concept extraction (no LLM calls; just MCP fetches).
- Authentication (MCP transport handles upstream auth — `sap-devs` uses an SAP-internal mechanism already).

### 3.5 Cache directory layout

`.cache/sap-devs/` is gitignored. Structure:

```
.cache/sap-devs/
  search_learning_journeys/
    <query-sha256>.json    # { rows, cachedAt }
  get_recent_news/
    <query-sha256>.json
  ...
```

### 3.6 Failure modes

| Mode | Behaviour |
|---|---|
| MCP server unreachable | Client logs + throws. Cron job catches, logs, marks fetch cycle failed, skips. Next cycle retries. |
| Tool returns malformed JSON | Schema validation fails. Same handling as above. |
| Tool returns empty array | NOT a failure. Cron job persists "no rows seen this cycle" by not updating `lastSeenAt`; TTL filter ages out previously-fetched rows naturally. |

### 3.7 Why a shared client (vs. per-cron-job MCP access)

Three sub-phases use `sap-devs` MCP directly (4.1, 4.2, 4.4). Three use other sources or hand-curation (4.3 partly, 4.5 mostly, 4.6 from GitHub directly). A shared client gives the MCP-using sub-phases one consistent retry/cache/validation story. Three+ is the threshold where the abstraction starts paying.

## 4. Concept-registry coherence strategy

Per Q6, all content types share `com.sap.developers.ims.Concepts`. The strategy here ensures cross-content extraction doesn't blow up the registry with synonym-duplicates.

### 4.1 The pre-fetch registry hint

Before each LLM extraction call, the cron job:

1. Embeds the content row (cached against `contentHash` — re-embed only when content changes).
2. Queries the existing `Concepts` registry for the top-K nearest neighbors by cosine similarity (K=15 default).
3. Injects the K neighbors into the LLM prompt as a **registry hint** — *"Concepts already in the registry that you should reuse if any fit this content: [list of (slug, name, description) for the K nearest neighbors]"*.

### 4.2 What the hint changes

- **Slug reuse rate goes up.** Existing slugs surface in the LLM context; the LLM outputs them verbatim when they fit.
- **Synonym detection at extraction time** (not consolidation time). The LLM is much better at "is this the same concept as one of these 15?" than at minting clean novel slugs.
- **Consolidator workload drops.** Phase 1's weekly `consolidateConcepts` cron remains as a backstop (catches edge cases like two new concepts minted in the same week that look similar to each other), but is no longer the primary mechanism.

### 4.3 K hyperparameter

`defaultK = 15`. Reasoning:

- Context budget: 15 hints × ~50 tokens each = ~750 tokens. Small fraction of the typical extraction prompt.
- Coverage: at ~150 concepts in the post-Phase-1 registry, 15 = 10% — enough to cover the semantic neighborhood of nearly any new content.
- Tunable per-sub-phase via the adapter signature (learning journeys may want K=25 for breadth; videos K=5 for narrow focus).

### 4.4 Reuse-priority hint in the prompt

Each per-type adapter's system prompt gains a sentence:

```
You will be given a list of concepts already in the registry. STRONGLY PREFER
to reuse a registry slug when it fits the content. Only mint a new slug when
the content discusses something genuinely outside any registry concept's
scope.

REGISTRY HINT (K nearest concepts by embedding similarity):
- cap-service-handlers: CAP service event handlers (before/on/after). Used for
  custom business logic.
- ...
```

The forced-tool-call schema doesn't change; the prompt biases the LLM toward reuse but the schema still validates novel slugs (e.g. for genuinely new topics).

### 4.5 Cost ceiling guard

The registry-hint expands prompt size, which expands per-content-item LLM cost.

Mitigations:

- **Per-content-type LLM-call budget** in `ChatSettings` (or equivalent runtime config). Each cron job checks the budget before its run; skips if exhausted.
- **Daily budget enforcement** mirrors Phase 1's existing `extractConcepts` quota.
- **Token accounting** logged per fetch cycle (already standard in `extractConceptsCore`'s return shape).

### 4.6 Brand-new concepts

The prompt explicitly allows minting when nothing fits. The schema accepts novel slugs (confidence + slug regex are the only validation). So:

- A learning journey about "BTP Quantum Computing" → LLM mints `btp-quantum-computing` as a new slug → cron job persists with merge-on-write (cosine > 0.85 against existing registry; no match → INSERT new row).
- The consolidator may later merge it with a similar concept from elsewhere — normal Phase 1 path.

### 4.7 Why in the architecture spec

This decision affects every per-type adapter's prompt template and the chassis's extraction-call flow. Putting it in 4.1's spec only would force each subsequent sub-phase to re-decide it. Architecture spec is the right place.

## 5. Per-type TTLs and projection filter

Q5's strategy (`lastSeenAt` + per-type TTL, date-aware for trials) made concrete.

### 5.1 TTL table

| Content type | TTL (days) | Rationale |
|---|---|---|
| Learning Journeys | 365 | Stable curriculum; SAP rarely deletes a journey |
| Blog posts | 540 (18 months) | Matches issue's hint; older posts have low discovery value |
| Discovery missions | 180 | Mid-life-cycle; SAP refreshes mission catalogs ~quarterly |
| Trials | per-row `endDate` + 30-day grace | Strict: `endDate < NOW() - 30d` drops the row |
| Videos | 730 (24 months) | Engagement-driven; old SAP demos still have discovery value |
| API docs | 3650 (~10 years) | Authoritative reference; effectively forever |
| Code samples | 365 | SAP-samples repo regularly maintained; archived samples age out |

These live in `srv/lib/external-content-ttl.js`:

```javascript
export const PER_TYPE_TTL_DAYS = Object.freeze({
  'learning-journey': 365,
  'blog-post': 540,
  'discovery-mission': 180,
  'trial': null,  // date-aware; see isWithinTTL
  'video': 730,
  'api-doc': 3650,
  'sample': 365,
});
```

### 5.2 Shared `isWithinTTL` filter

```javascript
import { PER_TYPE_TTL_DAYS } from './external-content-ttl.js';

/**
 * Returns true if a content row's lastSeenAt + optional endDate make it
 * eligible for graph projection right now.
 */
export function isWithinTTL(contentType, lastSeenAt, endDate = null) {
  const ttlDays = PER_TYPE_TTL_DAYS[contentType];
  const seenAt = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(seenAt)) return false;

  // Standard TTL check (skipped for date-aware types like trials).
  if (ttlDays != null) {
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    if (Date.now() - seenAt > ttlMs) return false;
  }

  // Date-aware tier: trials. endDate + 30-day grace.
  if (endDate) {
    const ends = new Date(endDate).getTime();
    if (Number.isFinite(ends) && Date.now() - ends > 30 * 24 * 60 * 60 * 1000) return false;
  }
  return true;
}
```

Every per-type projection helper calls `isWithinTTL(contentType, row.lastSeenAt, row.endDate)` before emitting triples. Filter is silent — rows past TTL just don't project (next `graphRebuild` removes them from the RDF graph).

### 5.3 `pinUntil` admin override

Every per-type entity carries a chassis-level `pinUntil : Timestamp` column (Section 2.1). Behaviour:

- `pinUntil > NOW()` → row force-included regardless of TTL or `lastSeenAt`.
- Defaults to null.
- Settable from per-type Fiori list page (sub-phases that don't surface it in admin UI just store null).
- Falls back to TTL when pin expires.

Primarily useful for blogs and videos (evergreen content older than TTL). API docs don't need it (effectively-forever TTL); trials don't surface it (explicit `endDate` is the right semantic).

### 5.4 GC of stale rows

`lastSeenAt + TTL` hides rows from the graph; the rows themselves accumulate. Separate weekly cron prunes:

- `srv/jobs/gc-external-content-job.js` — shipped in 4.1's spec since 4.1 is the first sub-phase introducing the need.
- Runs weekly; scans each per-type entity; deletes where `lastSeenAt + (TTL * 2) < NOW()` AND `pinUntil IS NULL OR pinUntil < NOW()`.
- Double-TTL grace prevents accidentally GC'ing rows about to be re-seen.
- Cascade-deletes link entity rows; the next `graphRebuild` re-projects (RDF cleanup is automatic).

## 6. Acceptance criteria + sub-phase handoff

### 6.1 Architecture-spec acceptance

This spec is "done" when:

- [ ] 8 architecture decisions (Q2-Q9) documented with rationale (Section 1)
- [ ] Per-content-type chassis (Section 2) lists 6 artifact templates with LoC estimates
- [ ] Shared MCP client (Section 3) has public API + cache strategy documented
- [ ] Concept-registry coherence strategy (Section 4) specifies K=15 and the registry-hint prompt addition
- [ ] Per-type TTL table + `isWithinTTL` helper (Section 5) pinned
- [ ] Ship order locked (Q9): 4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6
- [ ] Spec explicitly calls out what is NOT decided here (per-sub-phase concerns enumerated in Section 6.2)
- [ ] Spec-reviewer subagent approves on a clean pass
- [ ] User reviews + approves the written spec file

### 6.2 Per-sub-phase brainstorm handoff

Each sub-phase (4.1-4.6) starts its own brainstorm. The architecture spec gives every sub-phase **lifted decisions** (not re-debated):

| Lifted from arch | Sub-phase does NOT re-decide |
|---|---|
| Q2 + Section 2.3: extractor adapter pattern | Adapter function signature |
| Q3 + Section 2.1: per-type entity + per-type link entity | Whether to use one shared table |
| Q4 + Section 2.2: extend `KG_IRI_PREFIXES` | Where the new prefix lives |
| Q5 + Section 5: TTL + `pinUntil` + GC cron | Whether GC is per-type or shared |
| Q6 + Section 4: shared `Concepts` + registry-hint prompt | Whether to namespace concepts per type |
| Q7 + Section 2.6: concept-page section + sidebar single section | Where the new content type surfaces |
| Q8 + Section 3: per-type cron + shared `sap-devs-client.js` | How fetch is wired |
| Q9: ship order | Sequencing |

Each sub-phase brainstorm focuses on:

- **Content-specific schema columns** (e.g. `Videos.youtubeId`, `Trials.endDate`)
- **Per-type prompt template** (system prompt copy + predicate vocabulary)
- **Per-type predicate(s)** (`partOfJourney`, `discusses`, `embodies`, `officialReferenceFor`, …)
- **Per-type cron schedule** (cron string for `scheduler.js`)
- **Concept-page section ordering position + heading copy**
- **Sub-phase-specific risks** (e.g. trials' lifecycle, samples' embodies-vs-teaches semantic)
- **Sub-phase test fixtures** (canonical MCP response shapes)

A sub-phase brainstorm should be **5-8 questions max** vs. the architecture spec's 9. The chassis carries the complexity; each sub-phase is a focused content-type concern.

### 6.3 Spec-reviewer scope note

When this architecture spec goes through the spec-reviewer subagent, the reviewer is told explicitly:

> "This is the architecture spec for Phase 4. It deliberately does NOT cover implementation details for sub-phases 4.1-4.6 — each gets its own spec → plan cycle. Do NOT flag 'lacks implementation detail per sub-phase' as a scope concern — that's by design."

(Same disclaimer pattern as Phase 3's "single doc covering both 3-A and 3-B" framing.)

### 6.4 Documents this spec produces

- `docs/superpowers/specs/2026-06-28-447-knowledge-graph-phase4-architecture.md` (this spec)

Documents this spec **prepares** (but doesn't produce):

- `docs/superpowers/specs/<date>-phase4.1-learning-journeys.md` — next brainstorm
- `docs/superpowers/plans/<date>-phase4.1-learning-journeys-implementation.md`
- One spec + plan per subsequent sub-phase (4.2-4.6)

### 6.5 Re-affirmed out-of-scope

- No sub-phase implementation shipped.
- No concept-page section copy decided.
- No cron schedules decided (only that each sub-phase has one).
- No exact MCP-tool-to-content-type wiring decided (per sub-phase).

## 7. Risks & mitigations (cross-sub-phase)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LLM token cost blows up across 6 cron jobs | Medium | High — operational cost | Per-content-type budget caps in `ChatSettings`. Daily quotas. Token accounting logged per fetch cycle. |
| `Concepts` registry pollutes with content-source-specific synonyms despite the hint | Medium | High — degrades concept page UX | The K=15 registry hint at extraction time + the weekly `consolidateConcepts` backstop. If pollution is observed, raise K. |
| `sap-devs` MCP server downtime cascades to N cron jobs | Low | Low | Each cron job catches its fetch failure independently; next cycle retries. Disk cache (Section 3) serves last-known-good for the TTL window. |
| Per-type TTL values miscalibrated (too short → constant re-extraction; too long → stale content lingers) | Medium | Low | TTL values are config constants, not schema. Easy to tune post-deploy without migration. Monitor `lastSeenAt` distributions and adjust. |
| Six new entities + six new link entities crowd the HANA schema | Low | Low | 12 new tables across all 6 sub-phases is modest; HANA handles thousands. No HDI artifact concerns. |
| Sub-phase 4.6 (Code Samples) `embodies` predicate semantically conflicts with `teaches` | Medium | Medium — confuses concept-page rendering | Sub-phase 4.6 spec will explicitly differentiate the two predicates in the concept-page template. Architecture-spec leaves room for the distinction without forcing it in 4.1-4.5. |

## 8. Decisions locked

| # | Decision | Section |
|---|---|---|
| 1 | Two specs: this architecture + per-sub-phase specs | Q1 (brainstorm) |
| 2 | Extractor: generic core + per-type adapters | Q2 + §2.3 |
| 3 | Per-type CDS entities + per-type link entities | Q3 + §2.1 |
| 4 | Extend existing `KG_IRI_PREFIXES` registry | Q4 + §2.2 |
| 5 | `lastSeenAt` + per-type TTL + `pinUntil` + weekly GC cron | Q5 + §5 |
| 6 | Shared `Concepts` registry + K=15 registry-hint prompt | Q6 + §4 |
| 7 | Per-type sections on concept pages + single "Other resources" on tutorial-OP sidebar | Q7 + §2.6 |
| 8 | Per-type cron + shared `sap-devs-client.js` MCP wrapper | Q8 + §3 |
| 9 | Ship order: 4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6 | Q9 |

## 9. Refs

- Issue: [#447](https://github.com/sap-tutorials/tutorials-ims/issues/447)
- Parent epic: [#381](https://github.com/sap-tutorials/tutorials-ims/issues/381)
- Phase 1 spec: [`2026-06-17-knowledge-graph-design.md`](./2026-06-17-knowledge-graph-design.md)
- Phase 3 spec: [`2026-06-27-446-knowledge-graph-phase3-design.md`](./2026-06-27-446-knowledge-graph-phase3-design.md)
- Phase 3 rollout note: [`docs/superpowers/done/2026-06-27-knowledge-graph-phase3-shipped.md`](../done/2026-06-27-knowledge-graph-phase3-shipped.md)
- `sap-devs` MCP tools reference: see the `sap-devs-server` section in the project's CLAUDE.md
