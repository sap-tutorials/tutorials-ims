---
title: Community Blog Posts — rename, tech-topic sourcing, AI relevance classifier, admin override, ≥3 floor
issue: 1033
status: approved
date: 2026-07-07
---

# Community Blog Posts (issue #1033)

## Summary

Two intertwined changes to the homepage Community section:

1. **Rename** the "Community Blogs" column to **"Community Blog Posts"** — matches how the source content is described on community.sap.com and reads more naturally.
2. **Filter to developer-relevant posts only.** Pull from an admin-editable list of SAP Community technology-topic RSS feeds, run each candidate through an AI relevance classifier (SAP Generative AI Hub via `@sap-ai-sdk/orchestration` — the same LLM caller pattern already used by `srv/lib/category-classifier-llm.js`, `srv/lib/ai-quiz-llm.js`, `srv/lib/explainer-generator.js`), persist the verdict + reason, and let admins override per-post. Always show ≥3 posts by falling back to raw candidates if the approved pool runs thin.

The visitor-facing shape of the section is unchanged. The endpoint `GET /homepage/communityBlogs` keeps its current JSON payload; only the source of the data (DB instead of live RSS at request time) and the column heading change.

**Prior state (as of 2026-07-07):** the section renders empty. Root cause is a User-Agent regression — `homepage-rss-fetcher.js` hits `https://community.sap.com/khhcw49343/rss/Community?interaction.style=blog` with the default Node fetch UA, which now returns HTTP 403 behind Cloudflare's bot challenge. The rewritten fetcher in this design sends a browser-shaped UA and this fixes the empty section as a side-effect.

## Scope

**In scope**
- New CDS entities `CommunityBlogSources` and `CommunityBlogPosts`.
- Two backend modules: `srv/lib/community-blogs-fetcher.js` (RSS pull + language filter + upsert) and `srv/lib/community-blogs-classifier.js` (AI Core verdict).
- Two cron jobs: fetch every 30 min, classify every 15 min.
- Rewrite of the public `HomepageService.communityBlogs()` handler to read from the DB with the ≥3 floor algorithm.
- Admin surface at `/admin-ui/#community-blog-posts` — one shell tile, two Fiori Elements List Reports (Sources, Posts) side-by-side.
- Docs: `docs/developers/architecture/homepage.md` Row-6 update + new `docs/developers/reference/community-blog-posts.md`.
- Unit + hybrid + smoke tests.
- DEV-only for v1; PROD cutover before end-of-July 2026 milestone.

**Out of scope**
- Localization (English-only for v1 — non-English posts are dropped at fetch time).
- Bulk-mode admin actions on the Posts LR.
- ETag / 304 on the visitor endpoint.
- User-facing confidence badges on the Vue island.

## Architecture

Two new entities, two new backend modules, two new cron jobs, one rewritten public endpoint, one new admin surface.

### Data flow (steady state)

```
Every 30 min (community-blogs-fetch-job):
CommunityBlogSources (isActive=true) ──┐
                                       ▼
                                 RSS + UA header ──▶ parseRss ──▶ language filter (en only)
                                                                       ▼
                                                       upsert CommunityBlogPosts
                                                       (aiVerdict='PENDING', lastSeenAt=now)

Every 15 min (community-blogs-classify-job):
SELECT CommunityBlogPosts WHERE aiVerdict='PENDING' OR (aiVerdict='ERROR' AND retry-not-yet-used)
  LIMIT COMMUNITY_BLOGS_CLASSIFY_BATCH (default 10)
  ORDER BY publishedAt DESC        ── newest first
  ──▶ SAP Generative AI Hub (@sap-ai-sdk/orchestration) sequentially, one call per row
  ──▶ UPDATE row with aiVerdict/aiReason/aiConfidence/aiClassifiedAt/aiModel

On visitor request GET /homepage/communityBlogs:
  60 s in-process cache (module-level {at, value}).
  Cache miss:
    Query A (approved pool):
      SELECT ... WHERE (linkStatus IS NULL OR linkStatus != 'BROKEN')
        AND (pinned = true
             OR adminOverride = 'ALLOW'
             OR (adminOverride IS NULL AND aiVerdict = 'DEVELOPER_RELEVANT'))
      ORDER BY pinned DESC, publishedAt DESC
      LIMIT 3
    If |A| < 3:
      Query B (padding pool, Q4=B fallback):
        SELECT ... WHERE (linkStatus IS NULL OR linkStatus != 'BROKEN')
          AND adminOverride != 'BLOCK'
          AND sourceUrl NOT IN (<urls in A>)
        ORDER BY publishedAt DESC
        LIMIT (3 - |A|)
      Result = A ++ B. Increment metric homepage.community_blogs[result=degraded].
    Serve top 3 with 60 s cache.
```

**BLOCK wins even in degraded mode.** An admin who explicitly blocks a marketing post never sees it re-appear because the classifier is having a bad day.

### Component map

| Layer | Component | File |
|---|---|---|
| Data model | `CommunityBlogSources`, `CommunityBlogPosts` | `db/community-blogs.cds` (new) |
| Seed | 3–5 seed technology-board rows | `db/data/com.sap.developers.ims-CommunityBlogSources.csv` (new) |
| Service | Rewritten `communityBlogs()` handler | `srv/homepage-service.js` (edit) |
| Service | Admin projections + auto-init + `reclassifyCommunityBlogPost` action | `srv/admin-service.cds`, `srv/admin-service.js` (edit) |
| Fetcher | RSS pull + language filter + upsert | `srv/lib/community-blogs-fetcher.js` (new) |
| Classifier | AI Core call + response parse + row update | `srv/lib/community-blogs-classifier.js` (new) |
| Shared helper | Extract `parseRss()` from existing fetcher | `srv/lib/rss-parse.js` (new, refactor) |
| Cron | Fetch job (30 min) | `srv/jobs/community-blogs-fetch-job.js` (new) |
| Cron | Classify job (15 min) | `srv/jobs/community-blogs-classify-job.js` (new) |
| Prompt | System-prompt file for the classifier | `srv/lib/prompts/community-blogs-classifier.md` (new) |
| Admin UI | Shell tile + Sources LR + Posts LR | `app/admin-shell/*`, `app/community-blog-posts/*` (new) |
| Admin annotations | `@UI.LineItem` etc. on both entities | `app/admin-annotations.cds` (edit) |
| Vue island | UI copy rename only ("Community Blogs" → "Community Blog Posts") | `hugo-apps/src/homepage-bands/CommunityLane.vue` (edit) |
| Hugo partial | Alt/aria-label rename | `hugo/layouts/partials/homepage/community-lane.html` (edit) |

## Data model

New file `db/community-blogs.cds`:

```cds
namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';

/** Admin-editable list of RSS feed URLs the Community Blog Posts
    fetcher pulls from every 30 min. Seeded with 3–5 technology
    board feeds; admins tune from /admin-ui/#community-blog-posts. */
entity CommunityBlogSources : cuid, managed {
  @assert.unique
  label       : String(120) not null;      // "Community — Technology (blogs)"
  @assert.unique
  feedUrl     : String(500) not null;      // canonical https URL, validated at write time
  topicSlug   : String(60);                // short label for admin "source topic" column
  isActive    : Boolean default true;
  sortOrder   : Integer default 100;
  managed     : Boolean default false;     // audit-only marker for seed rows
}

/** Fetched blog post candidates + AI relevance verdict + admin override.
    sourceUrl is the community.sap.com post permalink AND the classifier cache key —
    same post URL never gets re-classified. */
entity CommunityBlogPosts : cuid, managed {
  @assert.unique
  sourceUrl           : String(600) not null;    // dedupe key + classifier cache key
  sourceId            : Association to CommunityBlogSources;

  // RSS-extracted fields (never edited by admin)
  @readonly title              : String(400);
  @readonly author             : String(200);
  @readonly publishedAt        : Timestamp;
  @readonly descriptionSnippet : String(2000);   // first ~500 chars fed to classifier
  @readonly language           : String(8);      // 'en' only in v1
  @readonly lastSeenAt         : Timestamp;      // touched each time the fetcher sees this URL

  // Classifier output (never edited by admin)
  @readonly aiVerdict          : String(24) enum {
    PENDING; DEVELOPER_RELEVANT; NOT_RELEVANT; ERROR;
  } default 'PENDING';
  @readonly aiReason           : String(1000);   // model's short justification
  @readonly aiConfidence       : Decimal(4,3);   // 0.000–1.000
  @readonly aiClassifiedAt     : Timestamp;
  @readonly aiModel            : String(80);     // e.g. 'gpt-4o-mini@aicore'
  @readonly attemptCount       : Integer default 0;  // classifier attempts; drives retry-once policy

  // Admin-editable
  adminOverride       : String(8) enum {
    ALLOW; BLOCK;                                // null = defer to AI verdict
  };
  pinned              : Boolean default false;   // evergreen — always eligible

  // Link-health, refreshed by nightly homepage-link-health job
  @readonly linkStatus         : String(8) enum { OK; SLOW; BROKEN; };
  @readonly lastChecked        : Timestamp;
}
```

Delete of a `CommunityBlogSources` row is allowed. Because the association is optional, existing `CommunityBlogPosts` rows keep their `sourceId` value in the DB but resolve as an orphan (`sourceId.label` renders empty on the admin LR). The visitor endpoint doesn't depend on the source label, so no user-visible impact.

**No `@Common.ValueList` anywhere on `CommunityBlogPosts`.** Explicit design constraint. The `@cap-js/ai` plugin's after-write hook fires on Creates of draft-enabled admin entities with `@Common.ValueList` fields and crashes with `"No service definition found for 'AICore'"` (per `cap-ai-plugin-aicore-kind-resolution` in memory). If we later want an admin-editable dropdown of models, it goes through a plain FK to a new mini-entity, not a `@Common.ValueList` annotation.

**`.hdbtabledata`-wipes-editable-columns gotcha applies to Sources.** The seed CSV lists `label`, `feedUrl`, `topicSlug`, `isActive`, `sortOrder`; any deploy where the CSV hash changes will overwrite admin edits to those columns on rows with matching IDs. Documented in the reference doc; seed rows carry `managed=true` so admins can tell them apart from their own additions.

## Public endpoint

`GET /homepage/communityBlogs` — no route change, no JSON shape change. Handler in `srv/homepage-service.js` is rewritten:

1. 60 s in-process cache (`_state.communityBlogs = { at, value }` in the existing STATE_KEY object; matches `_state.events` shape).
2. Cache miss → runs Query A + optional Query B as shown in the data flow above.
3. Payload shape: `[{ title, url, publishedAt, author }]` (same as today).
4. Metrics:
   - `homepage.community_blogs[result=served,count=<n>]`
   - `homepage.community_blogs[result=degraded]` when padding was used
   - `homepage.community_blogs[result=error]` when the DB read threw (never surfaces to visitor — endpoint returns `[]`)

**Cache invalidation.** New export `resetCommunityBlogsCache()` in `srv/homepage-service.js`, called from `srv/admin-service.js` after any UPDATE / DELETE on `CommunityBlogPosts` or `CommunityBlogSources`. Same shape as the existing `resetFtCache()` for the featured-topics cache.

## Fetcher (`srv/lib/community-blogs-fetcher.js`)

Public API:

```js
export async function fetchAllSources({ tx, log }) { /* iterates active sources, best-effort */ }
export async function fetchOneSource(source, { tx, log }) { /* returns { fetched, upserted, skippedLang, errored } */ }
```

- Reads active `CommunityBlogSources` rows via the passed `tx`.
- For each source, calls `safeFetch` with a browser-shaped UA header (fixes the current 403). Timeout 5 s, max 3 redirects, https-only — matches `homepage-rss-fetcher.js` for parity.
- Parses XML via the extracted `parseRss()` helper in `srv/lib/rss-parse.js` (also used by the existing `fetchRssItems`).
- Language filter: reject items whose RSS `<language>` element (or channel-level `<language>`) is not `en*`; if the element is missing, fall back to a cheap heuristic (title contains ≥3 ASCII words separated by spaces AND no more than ~10 % non-ASCII chars).
- Upsert on `sourceUrl`: SELECT-then-UPDATE-or-INSERT (per the memory rule about unique constraints and upsert). `lastSeenAt = now` on every match. `title`, `author`, `publishedAt`, `descriptionSnippet` refresh from the feed on every match (feeds occasionally correct typos post-hoc).
- Never writes `aiVerdict` — new rows start `PENDING`; existing rows retain whatever the classifier gave them. Re-classification requires the row action.
- Metrics: `homepage.community_blogs.fetch[source=<slug>,result=hit|fetch_error|parse_error|zero_items,count=<n>]`.

**Browser UA constant** — stored inline as `const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'`. If Cloudflare's challenge ever shifts, we bump the constant; not admin-editable.

## Classifier (`srv/lib/community-blogs-classifier.js`)

Public API:

```js
export async function classifyPendingBatch({ tx, log, limit }) { /* returns { drained, ok, parseError, aicoreError } */ }
export async function classifyOne(row, { aiCoreService, log }) { /* returns updated row fields */ }
```

- Reads up to `limit` rows where `aiVerdict = 'PENDING'` OR (`aiVerdict = 'ERROR'` AND `attemptCount < 2`), ordered by `publishedAt DESC`.
- Kill switch: env var `COMMUNITY_BLOGS_CLASSIFIER_ENABLED`, default `true`. When explicitly `false`, `classifyPendingBatch` no-ops and returns `{ drained: 0, disabled: true }`. Same shape as the existing `AICORE_EXPLAINER_GENERATOR_DISABLED` env var.
- Loads the system prompt from `srv/lib/prompts/community-blogs-classifier.md` at module init (cached across calls).
- Calls SAP Generative AI Hub via `OrchestrationClient.chatCompletion` from `@sap-ai-sdk/orchestration`, using **forced tool-call** for structured output — same pattern as `srv/lib/category-classifier-llm.js`. Resolves modelName + deploymentId via `resolveChatLlmSettings()` from `srv/lib/chat-settings-resolver.js` (same fallback chain every other AI caller in the app uses).
- Runs classifications **sequentially** (not parallel) — one call at a time, ~200 ms each. Sequential keeps rate-limits happy and makes try/finally recovery simple.
- Response parsing: forced tool-call with a `submit_verdict` tool whose parameters JSON-schema encodes `{ verdict, confidence, reason }`. This makes the model return valid structured data by construction; no `JSON.parse` on prose. Extract via `response.getToolCalls()[0].function.arguments`. Required fields `verdict` (enum: `DEVELOPER_RELEVANT` or `NOT_RELEVANT`), `confidence` (0.0–1.0), `reason` (string, truncated to 1000 chars).
- On missing/malformed tool call: row marked `aiVerdict='ERROR'`, `aiReason='parse: <first 200 chars of raw response or err>'`, `aiClassifiedAt=now`, `attemptCount = attemptCount + 1`.
- On AI SDK throw: same as above but `aiReason='aicore: <err.code || err.message>'`, `attemptCount = attemptCount + 1`.
- On success: `attemptCount = attemptCount + 1` also (so a sticky-ERROR row that eventually classifies OK on manual reclassify still has a bounded attempt trail).
- Retry semantics: a fresh `PENDING` row has `attemptCount=0`; first drain sets `attemptCount=1`. If it errored, next scheduled drain re-picks it (`attemptCount<2`). Second error sets `attemptCount=2` and the row is sticky-`ERROR` until `Reclassify` action resets `attemptCount=0`.
- Batch wall-clock ceiling ≈ 3 s (10 × 200 ms + tx overhead) — well under CAP's default request timeout.
- try/finally around the whole batch loop so a mid-batch throw doesn't leave the current row stuck in `PENDING`.
- Metrics: `homepage.community_blogs.classifier[result=hit|parse_error|aicore_error|disabled]`.

### Prompt (`srv/lib/prompts/community-blogs-classifier.md`)

```
System: You classify SAP Community blog posts as either developer-relevant
        or not. Developer-relevant means the post contains code samples,
        config snippets, CLI commands, API usage, or a walkthrough of a
        hands-on build; discusses developer-facing tooling, frameworks,
        SDKs, APIs, extension patterns, or architecture; OR explicitly
        targets developers, architects, or technical practitioners as
        the audience. NOT developer-relevant: pure product announcements
        without code, event recap posts, marketing-shaped posts,
        opinion/culture posts, org-chart or personnel news, sales
        enablement. Reply with a single JSON object exactly like:
        {"verdict":"DEVELOPER_RELEVANT"|"NOT_RELEVANT",
         "confidence":0.0-1.0,
         "reason":"<one short sentence>"}.
        No prose outside the JSON. No markdown fences.

User: Title: <title>
      Author: <author>
      Snippet: <first ~500 chars of descriptionSnippet, whitespace-normalised>
```

### Model

- **Prod (BTP):** modelName is resolved via `resolveChatLlmSettings()` (ChatSettings.modelName → env `CHAT_MODEL_NAME` → default `anthropic--claude-4.6-sonnet`). Deployment ID resolves the same way. This is the same resolution chain used by every other AI caller in the codebase; no separate binding to babysit for this feature.
- **DEV / hybrid:** unit tests mock `OrchestrationClient` directly (same pattern as `category-classifier-llm.test.js`). Live `cds watch` sessions hit AI Core only if the developer chooses to trigger the classify job manually — the fetch job populates rows as `PENDING`, but nothing calls the LLM until the schedule fires or the admin triggers `runJob('community-blogs-classify-drain')`.
- **Env kill switch:** `COMMUNITY_BLOGS_CLASSIFIER_ENABLED=false` no-ops the classify drain. Same shape as `AICORE_EXPLAINER_GENERATOR_DISABLED`.
- **Cost estimate:** ~$0.00012 per classification at typical Claude-Sonnet pricing (~600 input + ~50 output tokens). 500 posts/week ≈ $0.06/week ≈ $3/year — rounding error against the project's existing AI Hub spend.

### Row action on `AdminService`

```cds
action reclassifyCommunityBlogPost(ID: UUID) returns Boolean;
```

Handler: SuperAdmin-scoped, resets `aiVerdict='PENDING'`, `aiClassifiedAt=null`, `aiReason=null`, `attemptCount=0`. Called from the Posts Object Page. Emits metric `homepage.community_blogs.reclassify[result=hit]`.

## Cron jobs

Both use CAP 10's Scheduling API through the internal `CronService` in `srv/cron-service.js` (same pattern as `kg-pagerank-job.js`, `kg-featured-topics-job.js`, `homepage-link-health.js`).

- **`community-blogs-fetch-job`** — every 30 min at :17 past. Calls `fetchAllSources`. Fail-open on all paths (per-source try/catch, per-item try/catch).
- **`community-blogs-classify-job`** — every 15 min at :07 past. Calls `classifyPendingBatch({ limit: process.env.COMMUNITY_BLOGS_CLASSIFY_BATCH ?? 10 })`. Fail-open. No inter-run coordination — the DB row's `aiVerdict='PENDING'` filter is the queue.

Off-cycle minute choice (:17, :07) matches the memory rule "don't pile every recurring job on minute 0".

## Admin UI

Shell tile at `/admin-ui/#community-blog-posts`, opening a two-LR layout via `sap.f.FlexibleColumnLayout` (mirrors `/admin-ui/#homepage`'s Shelves + Redirects split).

### Sources LR (`AdminService.CommunityBlogSources`)

- Columns: `label`, `feedUrl`, `topicSlug`, `isActive`, `sortOrder`, `managed`.
- Create / Edit / Delete permitted (SuperAdmin scope).
- Draft-enabled. Object Page for edit.
- No `@Common.ValueList` on any field.

### Posts LR (`AdminService.CommunityBlogPosts`)

- Columns: `title` (link to `sourceUrl`, target=`_blank`), `author`, `publishedAt`, `sourceId.label`, `aiVerdict` (Fiori `ObjectStatus` with `Success=DEVELOPER_RELEVANT`, `Warning=PENDING`, `Error=NOT_RELEVANT|ERROR`), `aiReason` (LR: truncated with tooltip; OP: full), `aiConfidence` (Decimal, right-aligned), `adminOverride` (editable dropdown: null / ALLOW / BLOCK), `pinned` (editable checkbox), `linkStatus`.
- Filters: SelectionField facets on `aiVerdict`, `adminOverride`, `sourceId`, `pinned`.
- Default filter on first load: `aiVerdict = PENDING or ERROR` — admins see what needs attention.
- OP fields: everything read-only except `adminOverride` and `pinned` (enforced by `@readonly` at the service layer).
- Row action `Reclassify` on OP → invokes `AdminService.reclassifyCommunityBlogPost(ID)`. SuperAdmin-scoped.
- No `@Common.ValueList` on any field. No bulk-mode actions.

### Auto-init handler

`before('READ')` on `AdminService.CommunityBlogSources` — if the table is empty, insert the 3–5 seed rows programmatically (mirrors the seed CSV). Same shape as `HomepageConfig.beforeRead` auto-init. Marks all seeded rows `managed=true`.

## Testing

### Unit (`test/unit/`, `cds.test` in-memory SQLite)

| Test file | Coverage |
|---|---|
| `test/unit/community-blogs-fetcher.test.js` | Canned RSS XML: English / non-English / malformed / empty. Upsert dedupe on `sourceUrl`. Language drop. `lastSeenAt` refresh. UA-header applied. Timeout / non-2xx paths return early without polluting the DB. |
| `test/unit/community-blogs-classifier.test.js` | Mocked `OrchestrationClient.chatCompletion` (same pattern as `category-classifier-llm.test.js`). Valid tool-call response → row updated correctly. Missing tool call → `ERROR`, `aiReason='parse: no tool call'`. Malformed tool arguments → `ERROR`, `aiReason='parse: ...'`. Timeout / 429 / 5xx throw → `ERROR`, `aiReason='aicore: ...'`. Batch drain limit honoured. Retry-once via `attemptCount`: fresh `PENDING` (attemptCount=0) picked; `ERROR` with `attemptCount=1` re-picked; `ERROR` with `attemptCount=2` NOT re-picked. Env kill switch → no-op with `disabled: true`. |
| `test/unit/homepage-service-endpoints.test.js` (extend) | `communityBlogs()` new selection algorithm: pinned-first ordering; `adminOverride=ALLOW` beats `aiVerdict=NOT_RELEVANT`; `adminOverride=BLOCK` beats `aiVerdict=DEVELOPER_RELEVANT`; degraded padding when approved pool <3; `BLOCK` wins in degraded mode; empty-DB case returns `[]`. |
| `test/unit/community-blogs-cds-assert.test.js` | `@assert.unique.sourceUrl` on Posts; `@assert.unique.label` and `@assert.unique.feedUrl` on Sources. **Runs `cds deploy --to sqlite::memory:`** so `@assert.unique` runtime errors surface (per memory: `cds compile` alone won't catch them). |

### Hybrid (`test/hybrid/`, real HANA via `cds bind`, `--project hybrid`)

| Test file | Coverage |
|---|---|
| `test/hybrid/community-blogs-hana.test.js` | Real DB round-trip on upsert + selection paths. Confirms the `NOT IN` dedupe in the padding query stays under HANA's parameter-count limit even in the worst realistic case. |
| `test/hybrid/community-blogs-admin.test.js` | Real HANA + real `AdminService` draft round-trip on both Sources and Posts. Guards against `@odata.singleton + @odata.draft.enabled` and `draft-survives-schema-swap` regressions. |

### Smoke (`test/smoke/`, HTTP against deployed)

Extend `test/smoke/homepage-api.smoke.test.ts`:
- `GET /homepage/communityBlogs` returns `application/json`, array with 0–3 items, each item has `title`+`url`.
- No HTTP 500 even against a fresh subaccount.

### Probe

`test/hybrid/probe-community-blogs.mjs` — manual probe run by the plan author before merge. Prints `count(*) by aiVerdict`, `count(*) by adminOverride`, `count(*) where pinned=true`, `count(*) by linkStatus`. **Observes real rows via `cds bind`**, does not assert schema shape (per memory: shape-only probes miss filter-shape bugs).

## Observability

New metrics under the `homepage.community_blogs.*` namespace (via existing `srv/lib/metrics.js`):

- `homepage.community_blogs[result=served,count=<n>]` — each `/homepage/communityBlogs` hit.
- `homepage.community_blogs[result=degraded]` — a served response that used padding.
- `homepage.community_blogs[result=error]` — DB read threw.
- `homepage.community_blogs.fetch[source=<slug>,result=hit|fetch_error|parse_error|zero_items,count=<n>]`
- `homepage.community_blogs.classifier[result=hit|parse_error|aicore_error|disabled]`
- `homepage.community_blogs.reclassify[result=hit]`

## Failure modes

Extends the table in `docs/developers/architecture/homepage.md`:

| Failure | Behaviour |
|---|---|
| DB unavailable for the SELECT | Endpoint returns `[]`; CommunityLane.vue renders the empty-state link. No crash. |
| All approved posts marked `linkStatus=BROKEN` | Falls through to padding pool. |
| Both A and B empty (fresh deploy, fetcher hasn't run yet) | Endpoint returns `[]`. Section runs empty for at most the first fetch cycle (~30 min post-deploy). |
| AI Hub outage | New posts pile up as `PENDING`; classifier writes `ERROR` on throw; padding kicks in and section stays populated. `homepage.community_blogs[result=degraded]` counter climbs — ops signal. |
| SAP Community RSS 404 / 5xx | Per-source try/catch in fetcher; other sources continue. Metric `fetch[source=<slug>,result=fetch_error]`. |
| Malformed AI response for many posts in a row | Each row marked `ERROR` with reason preserved. Batch keeps advancing. Admin can spot-check the `aiReason` column to diagnose. Kill switch available if classification drifts pathologically. |
| A single row's `title` or `author` contains unsafe HTML | CommunityLane.vue renders as plain text via Vue's default escaping — no XSS risk. |

## Rollout

Single MTA deploy to DEV (matches KG-communities rollout shape):

1. Deploy CDS + service + admin UI + cron registrations. New tables created empty.
2. Auto-init inserts 3–5 seed `CommunityBlogSources` rows on first admin-service read (or CSV deploy, whichever fires first).
3. First `community-blogs-fetch-job` fires within 30 min; `PENDING` rows populate.
4. First `community-blogs-classify-job` fires within 15 min after; verdicts land.
5. Visitor section fills within ~45 min of deploy. Before then: raw-pad fallback fills the section; before first fetch, CommunityLane.vue renders the empty-state link.

No feature flag needed — the change is additive on the DB side, and the visitor endpoint's contract stays identical. `COMMUNITY_BLOGS_CLASSIFIER_ENABLED=false` degrades cleanly to the raw pool without a redeploy.

**`srv-qa` cp-list audit.** New files under `srv/lib/` (`community-blogs-fetcher.js`, `community-blogs-classifier.js`, `rss-parse.js`) and `srv/jobs/` — per the memory rule, re-walk transitive imports from `srv/lib/content-store.js` and confirm the new modules are in `.deploy/mta.yaml`'s `srv-qa` `cp` list. Prevents QA boot crashes at MTA deploy time.

**DEV-only for v1**; PROD cutover before end-of-July 2026.

## Go/no-go metrics for the ~1-week DEV review

- `homepage.community_blogs.classifier[result=hit]` > 90 % of drained rows.
- `homepage.community_blogs.classifier[result=parse_error]` < 5 %.
- Admin `adminOverride` count < 20 % of `aiVerdict=DEVELOPER_RELEVANT` rows.
- `homepage.community_blogs[result=degraded]` < 5 % of visitor hits.

## Open questions resolved during brainstorming

| Issue's open question | Decision |
|---|---|
| Which model backs the classifier? | SAP Generative AI Hub via `@sap-ai-sdk/orchestration` with forced tool-call (same pattern as `category-classifier-llm.js`). Model resolved via `resolveChatLlmSettings()` — inherits ChatSettings/env fallback like every other AI caller. |
| Confidence threshold / auto-classified badge? | Store `aiConfidence`, don't gate on it in v1. No visitor-facing badge. |
| Trailing window vs backfill? | No trailing window — every fetched candidate is classified once. Backfill happens naturally as `PENDING` drains. |
| How many posts on the homepage? | 3, unchanged. `LIMIT 3` in the selection. |
| Fallback on AI outage? | Show admin-approved + `pinned` posts; if still <3, pad from raw candidates (`BLOCK` still wins). |
| Localization? | English-only for v1; non-English posts dropped at fetch time. |
| One source list, admin-editable? | Admin-editable `CommunityBlogSources` table, seeded with 3–5 technology-board feeds. |
| Rename URL slug? | New admin surface at `/admin-ui/#community-blog-posts`. No visitor-facing URL change (endpoint stays `/homepage/communityBlogs`). |

## Related

- Homepage architecture: `docs/developers/architecture/homepage.md`.
- `@cap-js/ai` adoption notes: `docs/developers/reference/cap-ai-plugin.md`.
- AICore-kind-resolution gotcha (why no `@Common.ValueList`): `cap-ai-plugin-aicore-kind-resolution` memory.
- `.hdbtabledata`-wipes-editable-columns gotcha (why seed CSV is careful): `csv-changes-wipe-editable-columns` memory.
- Probe rule (why the probe observes rows, not schema): `probe-observe-not-assert-shape` memory.
