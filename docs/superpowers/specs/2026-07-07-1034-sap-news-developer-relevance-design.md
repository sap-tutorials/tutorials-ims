# SAP News developer-relevance filter (#1034)

**Status:** Design approved 2026-07-07. Owns shared classifier + admin plumbing that #1033 (Community Blog Posts) will mirror.

**Related:**
- Parent issue: [#1034](https://github.com/sap-tutorials/tutorials-ims/issues/1034)
- Mirror issue: [#1033 Community Blog Posts](https://github.com/sap-tutorials/tutorials-ims/issues/1033) — will consume the shared classifier, service, and admin surface introduced here.
- `docs/developers/architecture/homepage.md`
- `docs/developers/reference/cap-ai-plugin.md`

## Problem

The `/homepage/news` handler currently pass-throughs `news.sap.com/feed/` and slices to two items. The feed is a general-purpose corporate stream (earnings, executive appointments, non-technical partnerships, event announcements) dominated by content that developers.sap.com visitors are not here for. Rule-based tag filtering is insufficient — the feed does not tag by developer relevance, and its `<category>` tags currently are not even parsed server-side.

## Goals

- Only developer-relevant SAP News items reach the homepage.
- Every candidate has a machine verdict (AI) that admins can override manually.
- Same admin surface pattern applies to Community Blog Posts (#1033) with no shared-plumbing rewrite.
- Homepage never 500s if the classifier is down; graceful fallback to a keyword rule.
- Production replacement quality — no unvetted content ships when everything is working; if AI is down, keyword rules keep the column populated with best-effort filtering.

## Non-goals

- Not localizing classifier or homepage News column beyond English in v1.
- Not backfilling historical news items on first deploy.
- Not merging SAP News and Community Blog Posts into a single homepage strip — they remain separate columns in `CommunityLane`.
- Not exposing the classifier to end users; no "self-serve why-was-this-shown" surface.
- Not moving Community Blog Posts implementation into this spec — #1033 owns its own entity, cron, and rubric refinements while consuming the shared classifier + moderation UI defined here.

## Architecture at a glance

```
news.sap.com/feed/  ──►  srv/jobs/fetch-news-job.js  (hourly, :17)
                                │
                                ├─ upsert NewsItems (sourceId=<guid|link>) into HANA
                                └─ for each new/refreshed row:
                                       srv/lib/relevance-classifier.js
                                          ├─ embed(title + description)
                                          ├─ cosine vs RelevanceSeedExemplars
                                          ├─ |margin| ≥ 0.15  → embedding verdict
                                          └─ |margin| < 0.15  → LLM classify {verdict, reason}
                                       writes aiVerdict + aiReason + aiVerdictSource + aiVerdictAt

srv/homepage-service.js  news()
   ├─ SELECT from NewsItems where publishedAt ≥ NOW-14d AND language='en'
   ├─ effective verdict = adminVerdict ?? aiVerdict
   ├─ if verdict='relevant' → include, cap at 2 (unchanged homepage count)
   └─ 60s in-process cache; resetNewsCache() on admin write

app/admin/content-moderation/  (new UI5 app under /admin-ui/#content-moderation)
   └─ Three-tab shell:
        Tab 1 SAP News           → FE List Report on ContentModerationService.NewsItems
        Tab 2 Community Blog Posts → placeholder for #1033
        Tab 3 Relevance Seeds    → FE List Report on ContentModerationService.RelevanceSeedExemplars
```

Rendering on the homepage is unchanged: `srv/homepage-service.js news()` returns the same `{title, link, publishedAt, description}` shape today; `CommunityLane.vue` needs no v1 change. The parser upgrade in Section 5 does start populating `<category>` tags, which unblocks the currently-inert `applyRssFilter` client-side personalization path as a side effect.

## Data model

Added to `db/external-content.cds` (Phase-4 chassis):

```cds
entity NewsItems : managed {
  key sourceId       : String(200);           // RSS <guid> if present; else canonical link (lowercased, tracking params stripped)
      link           : String(500) not null;
      title          : String(500) not null;
      description    : LargeString;
      publishedAt    : Timestamp;
      language       : String(10);            // detected; v1 filters to 'en'; other values stay in table with aiVerdict='pending'
      contentHash    : String(64);            // sha256(title|description) — change detection for reclassify
      // AI verdict
      aiVerdict      : String(20);            // 'relevant' | 'not-relevant' | 'pending' | 'error'
      aiReason       : String(500);
      aiVerdictSource: String(20);            // 'embedding' | 'llm' | 'fallback-keyword'
      aiConfidence   : Decimal(4,3);
      aiVerdictAt    : Timestamp;
      aiModel        : String(100);           // embedding model name or LLM deploymentId
      // Admin override (wins over AI at read time)
      adminVerdict   : String(20);            // 'approve' | 'reject' | null
      adminNote      : String(500);
      adminBy        : String(255);
      adminAt        : Timestamp;
      // Ops
      lastFetchedAt  : Timestamp;
      classifyError  : String(500);
}
```

Shared seed table (used by News now, Blog Posts later — rubric is identical across sources):

```cds
entity RelevanceSeedExemplars : managed {
  key ID       : UUID;
      label    : String(20) not null;         // 'relevant' | 'not-relevant'
      text     : LargeString not null;        // 1–3 sentences — the exemplar itself
      embedding: Vector(1536);                // recomputed on text change
      active   : Boolean default true;
      note     : String(500);
}
```

- Seeded from `db/data/com.sap.developers.ims-RelevanceSeedExemplars.csv` so a fresh deploy comes up with a working classifier.
- CSV columns exclude `embedding` — embeddings compute on first-boot / on-save via `after('UPDATE')` and `after('CREATE')` handlers on the entity.
- Admins refine over time via Tab 3.

New `ChatSettings` columns (all singleton, admin-editable):

```cds
newsRelevanceLlmBudgetPerDay      : Integer default 100;
newsRelevanceMargin               : Decimal(4,3) default 0.150;   // |margin| threshold for embedding decision
newsFetchCadenceMinutes           : Integer default 60;
```

New `HomepageConfig` column:

```cds
newsRelevanceEnabled              : Boolean default false;        // Rollout flag — see Rollout section
```

## Classifier

**`srv/lib/relevance-classifier.js`** (new — source-agnostic; #1033 reuses):

```
classify({ title, description, sourceType, contentHash }) → {
  verdict: 'relevant' | 'not-relevant',
  reason: string,
  source: 'embedding' | 'llm' | 'fallback-keyword',
  confidence: number,       // 0..1
  model: string,            // embedding model name or LLM deploymentId
}
```

Decision flow:

1. **Cache check.** Callers pass `contentHash`; if the row's stored `contentHash` matches and `aiVerdict ∈ {relevant, not-relevant}`, skip reclassify.
2. **Embed** `title + "\n\n" + description` via `srv/lib/embedding-client.js`. Seed embeddings come from `srv/lib/category-seed-embeddings.js`-style cache — recomputed only when a `RelevanceSeedExemplars` row's text changes.
3. **Score.**
   - `relevantScore = max(cos(item, s)) for s in seeds where label='relevant' AND active`
   - `notScore     = max(cos(item, s)) for s in seeds where label='not-relevant' AND active`
   - `margin = relevantScore - notScore` (range roughly `[-1, +1]`).
4. **Decide.**
   - `margin ≥ +ChatSettings.newsRelevanceMargin`  → `verdict='relevant'`, `source='embedding'`, `confidence=margin`.
   - `margin ≤ -ChatSettings.newsRelevanceMargin`  → `verdict='not-relevant'`, `source='embedding'`, `confidence=|margin|`.
   - Mid-band → LLM fallback.
5. **LLM fallback.** Via `resolveChatLlmSettings()` (existing) + `@sap-ai-sdk` `OrchestrationClient`. JSON-mode prompt, single call, ≤1-sentence reason. Reason lands in `aiReason`. Budget-gated by `newsRelevanceLlmBudgetPerDay` — counted per-day across the whole classifier (not per-source-type; #1033 shares the pool).
6. **Budget exhausted or LLM error.** `aiVerdictSource='fallback-keyword'`, keyword allow/block rule applied for a provisional verdict, `classifyError` populated with message.

The classifier does **not** go through `@cap-js/ai` — it uses direct `@sap-ai-sdk` `OrchestrationClient`, which sidesteps the `AICore` kind-resolution gotcha documented in `docs/developers/reference/cap-ai-plugin.md`.

**Keyword rules (`srv/lib/relevance-keyword-rules.js`):**

- Allowlist tokens (case-insensitive, word-boundary): `API`, `APIs`, `SDK`, `CLI`, `CAP`, `BTP`, `HANA`, `Fiori`, `UI5`, `ABAP`, `Node`, `Java`, `TypeScript`, `Python`, `code`, `sample`, `tutorial`, `walkthrough`, `deploy`, `Kubernetes`, `Kyma`, `AI Core`, `AI Foundation`, `AI SDK`, `Cloud SDK`, `SAP Build`, `developer`.
- Blocklist tokens: `earnings`, `Q1`, `Q2`, `Q3`, `Q4`, `revenue`, `guidance`, `CEO`, `CFO`, `partnership`, `sponsorship`, `celebrat`, `award`, `champion of the year`, `HR`, `board of directors`.
- **Rule:** `verdict='relevant'` iff `hasAllowlist(title+description) AND NOT hasBlocklist(title+description)`; otherwise `not-relevant`.
- Token lists live in the module (not in `ChatSettings`) — v1 tunes via PR; a future admin surface is out of scope.

## Cron job

**`srv/jobs/fetch-news-job.js`** — hourly, off-minute `:17` (unclaimed per `scheduler.js` convention). Registered in `JOB_REGISTRY` with pipeline log rows and `JobLastRun`. Admin manual-trigger via existing `AdminService.JobControls.runJob('fetch-news')`.

Flow:

1. Fetch `news.sap.com/feed/` via `srv/lib/safe-fetch.js` + `srv/lib/homepage-rss-fetcher.js`. **Extend the parser** to extract `<guid>` and `<category>` in addition to the existing four fields. Backwards-compatible additive change.
2. For each item:
   - `sourceId = guid ?? canonicalize(link)` where `canonicalize` = lowercase + strip tracking params (`utm_*`, `sc_camp`, `mc_cid`, `mc_eid`).
   - Language detect: whitelisted char range (Basic Latin + Latin-1 Supplement only), plus English function-word count over `title + description` (`the/of/and/to/is/in/for/with`, ≥3 hits → `en`). Anything else → `null` on first insert, preserved on subsequent runs.
   - `contentHash = sha256(title || '' + '\n' + description || '')`.
3. Upsert on `sourceId`:
   - INSERT if new; classifier called; verdict columns populated.
   - UPDATE if `contentHash` changed → reclassify.
   - UPDATE if `contentHash` unchanged AND `aiVerdict ∈ {relevant, not-relevant}` → **skip reclassify**; only bump `lastFetchedAt`.
4. Non-English items (`language !== 'en'`): row stored, `aiVerdict='pending'`, classifier not invoked. Homepage read path filters them out.
5. On completion: call `resetNewsCache()` in `srv/homepage-service.js`.

**Rate-limit envelope.** Cadence + off-minute IS the rate limit against `news.sap.com`. No token bucket.

**Budget accounting.** Classifier increments a daily `llmCallsToday` counter on `ChatSettings` (or a sidecar). Reset via a job header check comparing `date(now)` vs stored `llmCallsCountedOn`. Same pattern as `ChatSettings.blogPostExtractBudgetPerDay`.

## Homepage read path

`srv/homepage-service.js news()` replaced:

```js
async news() {
  if (!(await isNewsRelevanceEnabled())) {
    return fetchRssItems(SAP_NEWS_RSS_URL, { limit: 2 })   // legacy pass-through
  }
  return this._newsCache.getOrCompute(async () => {
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    const rows = await SELECT.from('NewsItems')
      .where({ publishedAt: { '>=': cutoff }, language: 'en' })
      .orderBy({ publishedAt: 'desc' })
      .limit(20)
    return rows
      .filter(r => {
        if (r.adminVerdict === 'approve') return true
        if (r.adminVerdict === 'reject')  return false
        return r.aiVerdict === 'relevant'
      })
      .slice(0, 2)
      .map(({ title, link, publishedAt, description }) =>
        ({ title, link, publishedAt, description }))
  })
}
```

- 60 s in-process cache; mirrors the existing `HomepageService._state.events` pattern.
- `resetNewsCache()` exported so admin write handlers can invalidate.
- Kill-switch check `isNewsRelevanceEnabled()` reads env `HOMEPAGE_NEWS_RELEVANCE_ENABLED` (default `true`) AND `HomepageConfig.newsRelevanceEnabled` (default `false`) — either falsy disables and reverts to today's pass-through.
- Response shape unchanged. `CommunityLane.vue` gets no v1 change.

## Admin surface

**Route** (added to `app/admin-shell/webapp/manifest.json`):

```
{ name: 'contentModeration', pattern: 'content-moderation',
  target: [{ name: 'contentModerationTarget', prefix: 'cm' }] }
```

URL: `/admin-ui/#content-moderation`. Component: `sap.tutorials.admin.contentModeration`, new UI5 app at `app/admin/content-moderation/`.

**Shell:** `sap.tnt.ToolPage` wrapping an `IconTabBar` with three tabs.

### Tab 1 — SAP News (FE List Report on `ContentModerationService.NewsItems`)

Columns:

| Column | Notes |
| --- | --- |
| Title | Link renderer, opens `link` in new tab |
| Source | Static `ObjectStatus` "SAP News" |
| Published | Relative date; absolute on hover |
| Language | Text (only `en` classifies) |
| AI verdict | `ObjectStatus` — `relevant`=Success, `not-relevant`=Warning, `pending`=Information, `error`=Error |
| AI reason | Truncated with popover for full string |
| AI source | `embedding` / `llm` / `fallback-keyword` — small text so admins understand the "why" |
| AI confidence | Numeric, 3 decimal places |
| Admin verdict | Read-only `ObjectStatus`; changed only through the row actions below |
| Admin note | Read-only display; captured by the `approve` / `reject` action dialog |
| Last classified | Timestamp on `aiVerdictAt` |

**Row actions** (SuperAdmin-gated bound actions):

- `approve` → `adminVerdict='approve'`, `adminBy=user`, `adminAt=now`
- `reject` → `adminVerdict='reject'`
- `clearOverride` → `adminVerdict=null` (AI verdict wins again)
- `reclassify(sourceId)` → forces classifier re-run; useful after seed edits

**Header actions:** `Run classifier now` (proxies to `AdminService.JobControls.runJob('fetch-news')`), `View last run` (deep-link to PipelineRuns detail for the latest `fetch-news` run).

### Tab 2 — Community Blog Posts

Empty placeholder: FE List Report over `ContentModerationService.BlogPosts` (projection defined here as an empty query view; #1033 fills the underlying entity and populates the projection). Column layout is copy-paste identical.

### Tab 3 — Relevance Seeds

FE List Report on `ContentModerationService.RelevanceSeedExemplars`. Admins can add/edit/deactivate exemplars.

Columns: `label`, `text` (multi-line editor), `active`, `note`, `modifiedAt`, `modifiedBy`.

Embedding recompute happens in an `after('CREATE'|'UPDATE')` handler on the entity — the embedding column is not user-editable. A banner appears at the top of Tab 1 if `count(active seeds where label='relevant') = 0 OR count(active seeds where label='not-relevant') = 0`, warning that the classifier will fall back to keyword rules until seeds are configured.

### Service (`srv/content-moderation-service.cds` + `.js`)

- `@requires: 'Tutorial.Author'` at service level (read).
- `@restrict: [{ grant: '*', to: 'internal.SuperAdmin' }]` on all bound actions and on the `RelevanceSeedExemplars` entity.
- Projections: `NewsItems`, `BlogPosts` — read-only; `adminVerdict`, `adminNote`, `adminBy`, `adminAt` mutate only through the bound actions (`approve`, `reject`, `clearOverride`, `reclassify`) to keep the audit trail clean.
- Projection: `RelevanceSeedExemplars` — writable (CREATE/UPDATE/DELETE) for SuperAdmin; embedding column is server-managed.
- Draft **not** enabled — same immediate-save shape as `AdminService.JobControls`.
- Kept out of `AdminService` deliberately: moderation is a distinct auth boundary (SuperAdmin-gated writes) and `AdminService` is already carrying a lot.

## Error handling

Read path is fail-open. Cron job path logs to `PipelineRuns` and moves on.

| Failure | Result |
| --- | --- |
| Cron RSS fetch fails | Job logs to `PipelineRuns`, no upsert. Existing rows keep serving. |
| Embedding call fails | Row lands with `aiVerdict='pending'` + `aiVerdictSource='fallback-keyword'` + keyword-derived provisional verdict + `classifyError` populated. |
| LLM error / budget exhausted | Same as embedding failure. |
| Seed table empty for either label | Classifier short-circuits to `pending` + keyword fallback. Admin banner on Tab 1 warns. |
| HANA read at `news()` throws | `try/catch`, log, return `[]`. `CommunityLane` renders empty column. |
| Admin approves, classifier later re-verdicts on reclassify | Admin columns are **not** overwritten by classifier writes. Guaranteed by the classifier's UPDATE column list excluding `adminVerdict`, `adminNote`, `adminBy`, `adminAt`. |
| `@cap-js/ai` "No service definition for AICore" | N/A — classifier bypasses the plugin. |
| Homepage kill-switch flipped | Handler reverts to legacy `fetchRssItems` pass-through. |

## Testing

**Unit (`test/unit/`):**

- `relevance-classifier.test.js` — seeded exemplars w/ deterministic embeddings; high-cosine → embedding path; forced mid-band → LLM mock returns valid JSON; LLM error → keyword fallback; empty seeds → keyword fallback.
- `relevance-keyword-rules.test.js` — allowlist hit + no blocklist → relevant; allowlist hit + blocklist hit → not-relevant; no allowlist → not-relevant; case-insensitive; word boundaries.
- `fetch-news-job.test.js` — RSS parse w/ and w/o `<guid>`, `<category>`; upsert dedup; non-English item → `pending`; contentHash unchanged → no reclassify; admin columns never overwritten on reclassify.
- `homepage-news-filter.test.js` — 14-day cutoff; adminVerdict precedence over aiVerdict; pending items hidden; kill-switch reverts to legacy pass-through.
- `content-moderation-service.test.js` — Tutorial.Author reads; SuperAdmin writes; non-SuperAdmin approve → 403.
- `relevance-seed-embedding.test.js` — text change triggers recompute; embedding cleared when text changes but seed not yet re-embedded.

**Hybrid (`test/hybrid/`):**

- `news-items-hana.test.js` — real HANA upsert; admin override survives cron re-run; seed embedding refresh on UPDATE; `contentHash` change triggers reclassify.

  No BLOB column on NewsItems → no HANA-LOB-locator hazard.

**Smoke (`test/smoke/`):**

- `GET /homepage/news` returns ≤2 items; every item within 14 days; none with `adminVerdict='reject'`; kill-switch responds to env change.

**Fixtures:**

- `test/fixtures/news-sap-com-feed/*.xml` — recorded RSS responses (with and without `<guid>`, with and without `<category>`, one non-English item) so parser tests run offline.

## Ops

**Kill-switches (two-layer):**

- Env `HOMEPAGE_NEWS_RELEVANCE_ENABLED` (default `true`). Set `false` and `cf restart tutorials-srv` → reverts to legacy pass-through. Zero-schema-change rollback.
- `HomepageConfig.newsRelevanceEnabled` (default `false`). Flip via `/admin-ui/#homepage-config` — no restart. Env dominates: either disables → legacy behavior.

**Metrics** (in `srv/lib/metrics-registry.js` or wherever the equivalent lives — match the `kg_communities_*` shape):

- `news_relevance_classified_total{verdict, source}` — counter
- `news_relevance_duration_ms` — histogram
- `news_relevance_llm_calls_total` — counter
- `news_relevance_budget_exhausted_total` — counter
- `news_relevance_admin_override_total{action}` — counter
- `news_relevance_seed_size{label}` — gauge

**Dashboards / alerts:** none new; PipelineRuns board already covers cron health.

**Docs:**

- New "SAP News" H2 in `docs/developers/architecture/homepage.md`.
- New runbook `docs/developers/operations/content-moderation-runbook.md` — tune seeds, kill-switch, re-run classifier, override an item.
- Update `docs/developers/reference/cap-ai-plugin.md` with the note that this classifier does **not** go through the plugin.

**Rollout:**

1. Ship schema + service + classifier + cron with `HomepageConfig.newsRelevanceEnabled = false`. Homepage still serves legacy pass-through.
2. Let cron run for 48 h; admins triage the moderation UI, approve/reject edge cases, refine seeds.
3. Flip `newsRelevanceEnabled = true` in HomepageConfig. Homepage begins serving filtered items.
4. Monitor `news_relevance_*` metrics. Tune `ChatSettings.newsRelevanceMargin` if verdicts skew (higher = more items routed to LLM; lower = more decisions from embeddings alone).

## Known gotchas

- **Classifier does not go through `@cap-js/ai`** — uses `@sap-ai-sdk` directly to sidestep the AICore-kind-resolution gotcha (see memory + `docs/developers/reference/cap-ai-plugin.md`).
- **`.hdbtabledata` for `RelevanceSeedExemplars`** — CSV changes wipe admin-editable columns on every deploy. **Solution:** only seed `label`, `text`, `active`, `note` from CSV; deliberately keep `embedding` out of the CSV so admin-recomputed embeddings survive deploys. Follow the CSV/hdbtabledata pattern in memory `csv-changes-wipe-editable-columns.md`.
- **CSV changes to seeds after admin edits** will still wipe admin edits to `label/text/active/note` columns of seeded rows — document this in the runbook: to change seeds post-launch, edit via `/admin-ui/#content-moderation` Tab 3 only.
- **`sourceId` fallback:** `news.sap.com/feed/` GUID stability is unverified. Use the guid when present; otherwise use canonicalized link (lowercased, tracking params stripped). Add a fixture-based unit test that covers both branches so a feed-format change surfaces early.
- **`cds build --production` required** after schema change lands in `db/last-dev/` — memory-recorded platform gotcha.
- **`srv-qa` cp list audit** — new files under `srv/lib/` (classifier, keyword-rules) must be added to `.deploy/mta.yaml` `srv-qa` `cp` list.
- **60 s cache on `news()` return** — admin approve/reject reflects on homepage within 60 s. Documented in the runbook.
- **Non-English rows** — currently stored with `language=null` when detection is ambiguous. If SAP News starts emitting a `<language>` element, prefer it over the heuristic; upgrade in a follow-up.

## Open items for the implementation plan

- Exact list of allowlist/blocklist tokens — v1 uses the list in Section 5, but the plan should include a "sanity-check against last 30 days of feed" step before merge.
- Whether to precompute embeddings for all seed rows synchronously on first deploy (blocks startup) or lazily on first classify (adds a few seconds of latency to first item). Recommend lazy with a "warm the cache" admin action.
- Whether `reclassify` should be batchable (approve/reject multi-select bar) — v1 is single-item to keep the surface small; add if admins complain.
