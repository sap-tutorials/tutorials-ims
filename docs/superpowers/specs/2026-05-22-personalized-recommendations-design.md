# Personalized "What's Next" Recommendations — Design

**Date:** 2026-05-22
**Branch target:** `feature/personalized-recommendations`
**Layout target:** `hugo/layouts/partials/next-steps.html` (rail wrapper) + new JS island
**Backend:** new `srv/lib/recommend.js`, `srv/lib/tutorial-centroid.js`, `srv/handlers/recommendations.js`; new `GET /api/recommendations` endpoint

## Goal

Replace today's build-time tag/co-completion blender output (rendered in the "Related Tutorials" rail at the bottom of every Object Page tutorial) with a runtime, per-user personalized ranking that reuses the existing per-step embeddings, the existing co-completion aggregator, and the existing user-progress lookup. Anonymous visitors get a similarity-based upgrade over today's static rail; authenticated visitors additionally get already-completed tutorials filtered out.

The existing curated next-card (mission-defined `Params.next`) above the rail stays untouched — that surface continues to represent the structured/curated path. The personalized rail is the long-tail/self-directed counterpart, side-by-side in the same Resources section.

## Non-goals

- No precomputed `Tutorials.embedding` column or schema migration. Centroids are computed on demand from `TutorialEmbedding` rows.
- No new background job. Reuses the existing embedding seed/reconcile cron (minute :17 of every hour) for centroid invalidation timing.
- No `RecommendationCache` entity or per-user offline cohort precompute. (Approach C, rejected.)
- No A/B-style counterfactual logging or click-through metrics in v1. Listed as a follow-up.
- No "Why was this recommended?" tooltip or reasoning UI.
- No personalized heading flip ("Recommended for you" vs "Related Tutorials") in v1 — the `personalized` response flag is exposed but unused on the client.
- No mobile/desktop divergence. Existing rail CSS is already responsive.
- No locale handling. Project is en-only (per memory: `developers_locales`).
- No change to the curated next-card directly above the rail.
- No feature flag. Graceful degradation to the server-rendered static rail is the safety net.

## Architecture

### Data flow

```
Browser (every tutorial Object Page render)
  ├─ Server-side (Hugo): server-renders today's static Params.recommendations rail
  └─ <div class="next-steps-rail" data-recommend-slug="<currentSlug>">
        ↓ JS island (apps/recommend.ts), lazy-loaded by ui5-bootstrap.ts
        ↓ fetch GET /api/recommendations?slug=<currentSlug> (credentials: 'include')
        ↓
CAP srv (DeveloperService, /api path)
  ├─ Custom express handler in srv/handlers/recommendations.js
  ├─ No @requires; reads XSUAA session if cookie present (mirrors /api/qrcode + /build/catalog)
  ├─ Calls recommend({ currentSlug, user, limit })
  └─ Returns { currentSlug, personalized, recommendations: [...], reason? }
        ↓
srv/lib/recommend.js (new)
  ├─ getCentroid(tutorial_ID) via srv/lib/tutorial-centroid.js (in-process LRU)
  ├─ Pulls candidate centroids (HANA: raw SQL; SQLite: CDS QL + JS rank)
  ├─ computeCoCompletions() — REUSED from srv/lib/co-completion.js (1h cache)
  ├─ getUserProgress(user) — REUSED from srv/lib/user-progress.js (completedSlugs)
  └─ Blend, filter, top-K
```

### Files

| File | Action | Purpose |
|---|---|---|
| `srv/lib/tutorial-centroid.js` | **create** | `getCentroid(tutorialId)` — averages step embeddings into Float32Array; in-process LRU (size 256, TTL 30 min). Returns `null` on empty. |
| `srv/lib/recommend.js` | **create** | `recommend({ currentSlug, user, limit })` — orchestrates centroid + co-completion + filter + top-K. Exports `RANKING_WEIGHTS = { sim: 0.6, co: 0.4 }`. Per-process LRU keyed `${slug}:${userIdOrAnon}`, TTL 5 min, max 1024. |
| `srv/handlers/recommendations.js` | **create** | Express handler. Validates query params, resolves user, calls `recommend()`, shapes JSON response. |
| `srv/server.js` | **modify** | Register handler on `cds.on('bootstrap')` next to other custom express routes. |
| `hugo/layouts/partials/next-steps.html` | **modify** | Add `data-recommend-slug` attribute to rail wrapper; extract card markup into reusable partial; embed inline `<template>` for client-side card cloning. |
| `hugo/layouts/partials/next-steps-card.html` | **create** | One-card markup, used by both Hugo `range` and the JS island's `<template>`. |
| `apps/recommend.ts` | **create** | ~50 LOC JS island. On DOM-ready, fetches the endpoint and swaps `.next-steps-grid` inner content; no-op on any failure. |
| `apps/ui5-bootstrap.ts` | **modify** | Conditional import of `apps/recommend.ts` gated on `document.querySelector('[data-recommend-slug]')`. |
| `test/unit/lib/recommend.test.js` | **create** | Vitest unit tests for ranker (centroid math, blend, filter, tiebreak, cold-start). |
| `test/unit/lib/tutorial-centroid.test.js` | **create** | Vitest unit tests for centroid averaging + LRU + null-on-empty. |
| `test/unit/handlers/recommendations.test.js` | **create** | Vitest tests for handler shape (400/404/200/500, anon vs auth, limit clamp). |
| `test/hybrid/recommend-hana.test.js` | **create** | Real-HANA test: centroids differ across tutorials; HANA cosine matches JS within 1e-4. |
| `test/smoke/recommendations.test.js` | **create** | HTTP smoke: 200/400/404 plus presence of `data-recommend-slug` wrapper in deployed Hugo HTML. |

No CDS schema change. No new entity. No new service.

## Ranking

### Score formula

For each candidate tutorial `c`, given current tutorial `t` and resolved user `u`:

```
score(c) = 0.6 · sim(t, c) + 0.4 · co(t, c)
```

- `sim(t, c)` — cosine similarity between centroid of `t` and centroid of `c`, normalized via `(cos + 1) / 2` to live in `[0, 1]`.
- `co(t, c)` — co-completion strength from `computeCoCompletions()`, normalized per snapshot by dividing by the maximum co-completion score observed in the cached aggregate (so `[0, 1]`).
- Constants `0.6 / 0.4` mirror `coWeight=0.6, tagWeight=0.4` already used in `scripts/parsers/recommendations.ts`. The runtime ranker swaps `tag` for `sim` but keeps the weighting philosophy. Constants live only in `srv/lib/recommend.js`.

### Filters

Applied before top-K:

1. `c.slug !== currentSlug` — never recommend self.
2. If user resolved: `!user.completedSlugs.has(c.slug)` — skip already-done tutorials.
3. `c` must have published HANA content (cheap join against existing `ContentManifest` ACTIVE rows). Tutorials whose HTML hasn't been published yet are not recommendable.

### Tiebreak

Deterministic: `score desc, primaryTag === currentPrimaryTag desc, title asc`. Stable so cache hits don't flicker the visible order.

### Personalization flag

`personalized: true` iff a user was resolved AND the completed-filter actually removed at least one candidate. Otherwise `false`. Exposed in the response; unused on the client in v1.

### Cold-start behavior

- If `getCentroid(currentTutorialId) === null` (no embeddings seeded yet for this tutorial) → endpoint returns `{ recommendations: [], personalized: false, reason: 'no_embedding' }`. Client leaves the server-rendered static rail in place. Silent.
- If `computeCoCompletions()` returns an empty/near-empty map → `co` term contributes 0 for everyone; ranker effectively becomes pure-similarity. Still strictly better than today's tag-only static fallback.

## API

### Endpoint

```
GET /api/recommendations?slug=<currentSlug>&limit=<n>
```

- **Auth:** not required. Reads `req.user.id` if XSUAA session cookie is present; otherwise treats as anonymous.
- **Query params:**
  - `slug` (required) — must match an existing `Tutorials.slug` row. Otherwise 404.
  - `limit` (optional) — clamped to `[1, 6]`, default `3`.
- **Rate limiting:** none new. Inherits the approuter's existing rate limits.

### Response 200 (happy path)

```json
{
  "currentSlug": "abap-dev-get-started",
  "personalized": true,
  "recommendations": [
    { "slug": "abap-rap-managed", "title": "Build a RAP Managed BO", "primaryTag": "ABAP", "score": 0.78 },
    { "slug": "btp-cf-deploy",    "title": "Deploy to Cloud Foundry", "primaryTag": "BTP",  "score": 0.62 }
  ]
}
```

### Response 200 (degraded — no embedding)

```json
{ "currentSlug": "...", "personalized": false, "recommendations": [], "reason": "no_embedding" }
```

### Errors

- `400` — missing `slug` query param.
- `404` — slug not found in `Tutorials`.
- `500` — unexpected error. Logged via `cds.log('recommend')`. Client falls back to static rail.

## Hugo partial change

```html
<div class="next-steps-rail" data-recommend-slug="{{ .Params.slug }}">
  <h4 class="next-steps-rail-heading">Related Tutorials</h4>
  <div class="next-steps-grid" data-recommend-target>
    {{- range .Params.recommendations -}}
      {{ partial "next-steps-card.html" . }}
    {{- end -}}
  </div>
  <template data-recommend-template>
    {{ partial "next-steps-card.html" (dict "slug" "" "title" "" "primaryTag" "") }}
  </template>
</div>
```

The curated next-card block (driven by `Params.next`) remains untouched directly above the rail.

## JS island (`apps/recommend.ts`, ~50 LOC)

- Loaded only when `document.querySelector('[data-recommend-slug]')` matches (gated in `ui5-bootstrap.ts` per memory `project_u11_progress`: cross-page features mounted in bootstrap, not `tutorial.ts`).
- On DOM-ready:
  1. Find the wrapper, read `slug`.
  2. `fetch('/api/recommendations?slug=...&limit=3', { credentials: 'include' })`.
  3. On 200 with non-empty `recommendations`: clone the inline `<template>` once per result, populate fields, replace the `.next-steps-grid` inner content.
  4. On any error / empty / non-200 / `reason: 'no_embedding'`: do nothing. Server-rendered static rail stays.
- `AbortController` on `pagehide` to avoid leaks during fast navigation.
- No skeleton or loading state — the static rail IS the loading state.

## Caching

| Layer | Key | TTL | Size cap | Invalidation |
|---|---|---|---|---|
| Centroid LRU (`tutorial-centroid.js`) | `tutorial_ID` | 30 min | 256 entries | TTL only; aligned with the existing embedding reconcile cron at minute :17 |
| Recommender LRU (`recommend.js`) | `${currentSlug}:${userIdOrAnon}` | 5 min | 1024 entries | TTL only; short enough that completing a tutorial reflects on the next page-load |
| Co-completion map | n/a | 1h | n/a | Reused as-is from `srv/lib/co-completion.js` |

Anonymous requests collapse to one entry per tutorial (`${slug}:anon`).

## Error handling matrix

| Failure | Server | Client | User sees |
|---|---|---|---|
| Slug not found | 404 | `console.warn`, no swap | Static rail |
| Tutorial has no embedding rows | 200 with `reason: 'no_embedding'` | No swap | Static rail |
| HANA query throws | 500, logged | No swap | Static rail |
| `computeCoCompletions()` errors | Caught in `recommend.js`; `co=0` for all | Swaps in similarity-only ranking | Personalized rail (degraded) |
| Vector dim mismatch on a row | Skip that row in average; warn once per tutorial | Swaps in ranking | Personalized rail |
| User auth resolution throws | Treat as anonymous; warn | Swaps in anon ranking | Personalized rail (no completed-filter) |
| Network error / abort | n/a | `catch` → no swap | Static rail |
| JS disabled | n/a | n/a | Static rail (server-rendered) |

Every failure path lands on the static rail. No broken state.

## Observability

- Namespace: `cds.log('recommend')`.
- One INFO line per request: `slug=... user=auth|anon personalized=t|f cacheHit=t|f durationMs=N count=N`.
- One WARN per recoverable degradation (co-completion failure, dim mismatch).
- One ERROR per 500.
- Existing CF Logs URL feature (memory: `cf_logs_url_shipped`) lets ops jump straight to the run window.

No new metrics infra in v1.

## Performance

- Corpus size: ~250 tutorials × ~5 steps avg × 1536-dim float = ~7.5M floats. Centroid LRU at 256 × 1536 × 4 B ≈ 1.5 MB. Negligible.
- Warm request: O(N) candidates × one cosine each ≈ sub-millisecond plus map lookups.
- Cold request: fetches all step embeddings for current tutorial + all candidate centroids (lazy-built process-wide map, invalidated by reconcile cron). First-page hit pays ~one HANA round-trip; subsequent hits served from cache.
- HANA path uses the existing carved exception to "no raw SQL": LOB-locator expiry forces `db.run()` raw SQL when selecting embedding BLOBs alongside metadata. Constraint is documented in `CLAUDE.md` and `srv/lib/embedding-query.js`.

## Testing

### Unit (`test/unit/lib/recommend.test.js`)

1. Centroid averaging: N step vectors averaged element-wise; null returned on empty input; cached on second call.
2. Ranker: mock similar tutorials + co-completion map → asserts top-K respects `0.6·sim + 0.4·co`.
3. Filter: `completedSlugs` excluded for auth user; included for anon.
4. Self-filter: current slug never appears in output.
5. Cold start: empty co-completion map → falls back to pure similarity, returns sorted list.
6. No embedding: `recommend()` returns `{ reason: 'no_embedding', recommendations: [], personalized: false }`.
7. Tiebreak: identical scores → same-tag candidate wins, then title-asc.

### Unit (`test/unit/lib/tutorial-centroid.test.js`)

1. Float32Array element-wise average.
2. `null` when no embeddings.
3. Same input → same Float32Array reference within TTL (cache hit).
4. Eviction at LRU cap.

### Unit (`test/unit/handlers/recommendations.test.js`)

1. Missing `slug` → 400.
2. Unknown slug → 404.
3. Anonymous → `personalized: false`.
4. Authenticated with `__TEST__` completion → that slug filtered out, `personalized: true`.
5. `limit=99` → clamped to 6.
6. Internal error → 500 with logged context.

### Hybrid (`test/hybrid/recommend-hana.test.js`)

Gated on `cf login` + `ALLOW_HYBRID_WRITES` (read-only here, but consistent with the other hybrid tests):

1. Real `TutorialEmbedding` rows produce centroids that are pairwise-different across at least 5 sampled tutorials.
2. End-to-end: ranking returns ≥1 candidate for each of those 5 sampled tutorials.
3. HANA raw-SQL cosine matches JS-computed cosine within 1e-4 tolerance on a small sample.

### Smoke (`test/smoke/recommendations.test.js`)

1. `GET /api/recommendations?slug=<known>` → 200, valid shape, `recommendations.length <= 3`.
2. Missing `slug` → 400.
3. Bogus slug → 404.
4. Hugo deployed page contains `<div ... data-recommend-slug="...">`.
5. The existing `next-steps-recommendations.test.js` smoke test still passes (server-rendered static rail unchanged).

## Deployment & rollout

- No feature flag. Graceful degradation is the safety net: if the endpoint 500s, the rail looks identical to today.
- Standard MTA build + cf deploy via the local deploy process (memory: `local_deploy_process`).
- Smoke tests run automatically post-deploy in CI.
- Manual sanity check on one known-seeded tutorial after deploy.

### Rollback

- Revert the one-line `data-recommend-slug` attribute change in `next-steps.html`. JS island becomes a no-op (`document.querySelector` returns null, never imports). Backend endpoint can stay live; nothing calls it.

## Open follow-ups (not in v1)

- `personalized: true` heading flip ("Recommended for you" vs "Related Tutorials").
- "Why this recommendation?" tooltip showing `sim` / `co` contribution.
- Click-through logging into the existing analytics-job pipeline for measuring lift over the static blender.
- Cross-locale handling (project is en-only today).
- Mid-session freshness (5-min cache TTL is good enough for now).

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Cold-cache HANA fetch latency on first request per process | Medium | Lazy process-wide centroid map; subsequent requests served from cache. Static rail covers any slow first hit. |
| Co-completion noise dominates niche tutorials with few completers | Medium | Per-snapshot normalization keeps `co` in `[0, 1]`; similarity term still contributes 0.6. |
| Embedding drift after content edits | Low | Existing reconcile cron at minute :17 reseeds; centroid TTL 30 min. |
| User completes a tutorial mid-session and sees it in the rail | Low | 5-min recommender TTL ensures next page-load reflects the change. |
| `req.user.id` resolution throws under unusual auth state | Low | Caught and treated as anonymous; warning logged; ranking still produced. |
