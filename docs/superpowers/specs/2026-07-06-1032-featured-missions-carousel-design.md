# Featured Missions Carousel — Design

**Issue:** [#1032](https://github.com/sap-tutorials/tutorials-ims/issues/1032)
**Status:** Draft — brainstorm complete, pending user review
**Date:** 2026-07-06

## 1. Summary

Replace Row 5 of the developer-portal homepage (the single "Featured missions"
strip fed by `hugo/data/browse.json`) with a **topic-based carousel**. Each of
eight slides shows one Knowledge Graph concept plus four missions that teach it.
The carousel auto-advances every 30 seconds, respects `prefers-reduced-motion`,
supports keyboard navigation, and exposes a deep-link anchor per slide.

Topics are chosen by a blended rule — PageRank primary, weakly-connected
communities as a diversity filter — with a human-editable override so
up-and-coming topics can also be featured. Editorial picks always lead;
KG-derived picks fill the remaining slots.

Data reaches the page via two layers: a build-baked `hugo/data/featured_topics.json`
provides SSR content (fast first paint, SEO-visible); a Vue 3 island fetches
`/api/homepage/featuredTopics` with `If-None-Match` at hydration time and
swaps in fresher content if the server has newer data. `304 Not Modified`
keeps the SSR content.

## 2. Motivation

Today's single strip only surfaces one slice of the catalog — good missions
for other topics never reach the homepage. The KG already ranks concepts
(#916 PageRank, #917 communities) and knows which tutorials and missions teach
each concept; the data to build "top N concepts + their best missions" is
already in HANA. Editors need a way to promote new/emerging topics that
haven't built up enough graph signal yet (e.g. a brand-new Joule capability,
a fresh CodeJam theme).

## 3. Decisions locked in brainstorm

| Question | Decision |
|----------|----------|
| KG signal | PageRank primary; weakly-connected communities as diversity filter (one concept per community). |
| Slide count | 8 slides fixed (4-minute full cycle at 30s per slide). |
| Missions per slide | 4 missions per slide. |
| Personalization in v1 | None. Existing `HomepageForYouCandidates` remains the personalized surface. |
| Preference persistence | None — pause/slide state resets each visit. `prefers-reduced-motion` fully respected. |
| Editorial vs. KG ranking | Editorial picks always occupy the first slots by `sortOrder`; KG fills the rest. |
| Data-model location | New entity `HomepageFeaturedTopics` (not shelf, not `Concepts` extension). |
| Data delivery | Build-time baseline via `hugo/data/featured_topics.json` + runtime hydration via `/api/homepage/featuredTopics` with ETag. |

## 4. Architecture

Row 5 of the homepage — currently rendered by
`hugo/layouts/partials/homepage/tutorials-teaser.html` — is **replaced** by
`hugo/layouts/partials/homepage/featured-topics-carousel.html`. Structure:

```
sap-tutorials KG (nightly)
  → kg-featured-topics-job.js (04:11 UTC)
    → FeaturedTopicsSnapshot table (8 rows)
      → GET /build/featured-topics  → hugo/data/featured_topics.json  → SSR carousel
      → GET /api/homepage/featuredTopics + ETag → Vue island hydration

Admin
  → AdminService.FeaturedTopics (CRUD)
    → after-SAVE: debounced rebuild dispatch (60s) + AdminService.recomputeFeaturedTopics()
      → new snapshot → next visitor load picks it up via /api/homepage/featuredTopics
```

## 5. Data model

New file `db/homepage-featured.cds`:

```cds
namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';
using { Concepts } from './knowledge-graph';

@assert.unique.concept: [concept]
entity HomepageFeaturedTopics : cuid, managed {
  concept        : Association to Concepts @mandatory;
  displayTitle   : String(80);              // optional override of Concepts.name
  sortOrder      : Integer default 100;
  validFrom      : Timestamp;               // null = active now
  validUntil     : Timestamp;               // null = never expires
  missionSlugs   : array of String(255);    // null/empty = fall back to TutorialRank order
  isActive       : Boolean default true;
  notes          : String(500);
}

@cds.autoexpose: false
entity FeaturedTopicsSnapshot {
  key slotOrder    : Integer;               // 1..8
      source       : String(10);            // 'EDITORIAL' | 'KG'
      conceptSlug  : String(80);
      displayTitle : String(120);
      missionSlugs : array of String(255);  // up to 4 slugs
      computedAt   : Timestamp;
}
```

Notes:

- `HomepageFeaturedTopics.concept` is FK-by-cuid on `Concepts`; runtime lookup joins by `Concepts.slug`, which is the stable identifier.
- The `@assert.unique.concept` guard prevents duplicate editorial rows for the same concept.
- `missionSlugs` is `array of String`, matching the `personaTags` precedent on `HomepageShelves` — no separate join table.
- `FeaturedTopicsSnapshot` has no cuid/managed. The nightly job (and every editorial save) truncates and rewrites up to eight rows atomically in one transaction, the same pattern as `ConceptRank`/`TutorialRank`. If candidates are exhausted the snapshot may hold fewer rows; the SSR partial and Vue island both render whatever `slotOrder` values are present.

## 6. Selection algorithm

Runs inside `srv/jobs/kg-featured-topics-job.js` and inside `AdminService.recomputeFeaturedTopics()`.

```
1. editorial = SELECT * FROM HomepageFeaturedTopics
     WHERE isActive
       AND (validFrom IS NULL OR validFrom <= NOW())
       AND (validUntil IS NULL OR validUntil >= NOW())
       AND concept.status = 'ACTIVE'
       AND concept.publishedAt IS NOT NULL
     ORDER BY sortOrder ASC, createdAt ASC
     LIMIT 8

2. For each editorial row: resolve missionSlugs.
   If the row's missionSlugs array is non-empty and every slug resolves to an
     active mission-or-tutorial: use it (verbatim, truncated to 4).
   Else: take the top-4 by TutorialRank.score of tutorials linked to the
     concept via TutorialConceptLinks WHERE predicate = 'teaches'.

3. slots[1..N] := editorial rows (N = min(len(editorial), 8)).

4. If N < 8, fill remaining (8 - N) slots from KG:
     candidates = SELECT c.slug, cr.score, kc.communityFingerprint
                  FROM Concepts c
                  JOIN ConceptRank cr ON cr.slug = c.slug
                  LEFT JOIN KgCommunity kc ON kc.vertexSlug = c.slug
                                          AND kc.vertexKind = 'CONCEPT'
                  WHERE c.status = 'ACTIVE' AND c.publishedAt IS NOT NULL
                  ORDER BY cr.score DESC

     usedCommunities = { fingerprint(c) for c in slots[1..N] } ∪ { null-sentinel? no }
     for candidate in candidates:
       if candidate.slug in slots: continue
       if candidate.communityFingerprint IS NOT NULL
          AND candidate.communityFingerprint in usedCommunities:
         continue
       append candidate to slots
       usedCommunities.add(candidate.communityFingerprint)
       if len(slots) == 8: break

5. TRUNCATE FeaturedTopicsSnapshot;
   INSERT rows 1..len(slots) in one tx, stamping source ('EDITORIAL' | 'KG')
     and computedAt := $now.
```

Notes:

- Concepts with `NULL communityFingerprint` (isolated concepts, WCC size 1) are treated as their own community — they pass the filter freely. Diversity is a soft goal, not a hard cap.
- The algorithm is deterministic given the same inputs. Ordering ties are broken by `createdAt ASC` for editorial and by `slug ASC` for KG (secondary sort in the outer query).
- Empty editorial + empty ConceptRank → empty snapshot; Row 5 disappears cleanly.

## 7. Services & endpoints

### 7.1 AdminService additions

`srv/admin-service.cds`:

```cds
extend service AdminService with {
  @odata.draft.enabled
  @requires: 'Tutorial.Author'
  entity FeaturedTopics as projection on db.HomepageFeaturedTopics;

  @readonly
  @requires: 'Tutorial.Author'
  entity FeaturedTopicsSnapshotView as projection on db.FeaturedTopicsSnapshot;

  @requires: 'Tutorial.SuperAdmin'
  action recomputeFeaturedTopics() returns { count : Integer; computedAt : Timestamp };
}
```

`srv/admin-service.js`:

- Draft-enabled CRUD, standard managed/cuid handling.
- `@Common.ValueList` on `concept_ID` filters to `AdminService.Concepts` where `status='ACTIVE' AND publishedAt IS NOT NULL` — editors pick from published concepts only.
- **`@UI.RecommendationState: 0`** on the `concept_ID` value-help field to avoid the `@cap-js/ai` `AICore` runtime crash (memory `cap-ai-plugin-aicore-kind-resolution` — same escape hatch as #1019).
- After-SAVE on `FeaturedTopics`: (a) call `recomputeFeaturedTopics` inline (fast — 8 rows) so admins see the new snapshot immediately; (b) trigger the debounced rebuild dispatcher used by `HomepageShelves` writes (60s debounce → `gh workflow run rebuild-content.yml -f mode=full`).
- `recomputeFeaturedTopics` action runs the same code path as the nightly job; SuperAdmin-gated so accidental clicks by regular authors don't churn the snapshot mid-review.

### 7.2 Build feed

`srv/developer-service.js` (already houses `/build/*`):

```
GET /build/featured-topics
→ 200 { snapshot: [ { slotOrder, source, conceptSlug, displayTitle,
                      missions: [ { slug, title, summary, imageUrl, kind } ] } ],
        computedAt: ISO-8601,
        etag: string }
```

- No auth (build-time consumer is `fetch-tutorials.ts` on CI; endpoint is on the same internal network).
- Dereferences `missionSlugs` to full mission/tutorial cards using the same helper as `/build/catalog` — the Hugo partial can render without a second lookup.
- Slug case is lowercased on both sides (memory `tutorial-slugs-lowercase-canonical`).

### 7.3 Runtime feed

`srv/homepage-service.cds` + `srv/homepage-service.js`:

```
GET /api/homepage/featuredTopics
→ same payload shape as /build/featured-topics
Headers:
  ETag: "sha1(computedAt + '/' + concat(conceptSlug + ':' + join(missionSlugs, ',')))"
  Cache-Control: public, max-age=60
Responses:
  200 with body when no If-None-Match match
  304 Not Modified when ETag matches
```

- No auth (public homepage surface).
- 60s server-side cache in `srv/homepage-service.js` following the Row 3 events pattern.
- ETag is stable across identical snapshots and changes only when the snapshot content changes — hydration is a no-op when data hasn't moved.

### 7.4 Cron

`srv/jobs/kg-featured-topics-job.js`:

- Cron: `11 04 * * *` (04:11 UTC) — after PageRank (03:53) and communities (03:57).
- Wired through CAP 10's Scheduling API via `srv/cron-service.js` (the pattern established by #958).
- Fail-open: on exception, snapshot table untouched; readers see stale but correct data. Metric `featured_topics_failures` increments; error logged.
- Metrics: `featured_topics_duration_ms`, `featured_topics_kg_count`, `featured_topics_editorial_count`, `featured_topics_failures`.

## 8. Frontend

### 8.1 SSR partial

`hugo/layouts/partials/homepage/featured-topics-carousel.html` replaces `tutorials-teaser.html` at Row 5 in `hugo/layouts/index.html`. Reads `.Site.Data.featured_topics`, emits eight slide `div`s (first `.is-active`, others `hidden`), plus prev/next arrows, play/pause button, dot indicators. Missions inside each slide are rendered via the existing `browse/_partials/card-mission.html` partial (same card as today's strip).

Structural markup:

```html
<section class="hp-featured-carousel"
         data-app="featured-topics-carousel"
         data-etag="{{ .Site.Data.featured_topics.etag }}"
         aria-roledescription="carousel"
         aria-label="Featured missions by topic">
  <div class="hp-featured-carousel__header">
    <h2 id="hp-featured-title" class="hp-band__title">Featured missions</h2>
    <a class="hp-featured-carousel__see-all" href="/tutorial-navigator/">Browse all →</a>
  </div>
  <div class="hp-featured-carousel__viewport" aria-live="polite">
    {{ range $i, $slide := .Site.Data.featured_topics.snapshot }}
      <div class="hp-featured-carousel__slide {{ if eq $i 0 }}is-active{{ else }}hidden{{ end }}"
           id="featured-{{ $slide.conceptSlug }}"
           role="group"
           aria-roledescription="slide"
           aria-label="{{ $slide.displayTitle }}, slide {{ add $i 1 }} of {{ len $.Site.Data.featured_topics.snapshot }}">
        <h3 class="hp-featured-carousel__topic">{{ $slide.displayTitle }}</h3>
        <div class="hp-featured-carousel__grid cards">
          {{ range $slide.missions }}{{ partial "browse/_partials/card-mission.html" . }}{{ end }}
        </div>
      </div>
    {{ end }}
  </div>
  <nav class="hp-featured-carousel__controls" aria-label="Carousel controls">
    <button data-action="prev" aria-label="Previous topic">‹</button>
    <button data-action="play-pause" aria-label="Pause auto-advance" aria-pressed="false">⏸</button>
    <button data-action="next" aria-label="Next topic">›</button>
    <ol class="hp-featured-carousel__dots" role="tablist"> ... </ol>
  </nav>
</section>
```

If `.Site.Data.featured_topics.snapshot` is empty or missing, the partial renders nothing — Row 5 disappears cleanly.

### 8.2 Vue island

New island at `hugo-apps/apps/featured-topics-carousel/`; bundle emits to `hugo/static/js/featured-topics-carousel.js`. Same shared mount loader (`data-app="featured-topics-carousel"` on the SSR container) as other islands.

Responsibilities:

1. **Hydrate.** On mount, fetch `/api/homepage/featuredTopics` with `If-None-Match: <etag from data-etag attr>`. `200` → Vue re-renders slots with fresh data; `304` → keep SSR content. Silent fail on any error — SSR content stays.
2. **Auto-advance** — 30s tick, `requestAnimationFrame` + `setTimeout` combined so backgrounded tabs don't pile up work. Manual nav stops auto-advance until the play button re-enables it.
3. **Pause conditions** (any active → auto-advance paused; all clear → resume unless play button was manually toggled off):
   - Pointer hover inside the carousel bounding box
   - Focus-within (keyboard nav focused any control)
   - `document.hidden === true` (`visibilitychange` listener)
   - Play/pause button pressed to paused (sticky — user intent overrides everything)
4. **Manual nav** — prev/next arrows, dot click, `ArrowLeft`/`ArrowRight` when carousel container has focus. Manual nav stops auto-advance and updates `history.replaceState` with the current slide anchor.
5. **Deep-link** — on mount, parse `location.hash`. If it matches `#featured/<slug>` and that slug is in the snapshot, jump to that slide and start paused. On any manual nav, update `history.replaceState` so the URL is shareable.
6. **ARIA live** — the `aria-live="polite"` viewport announces the topic name on each transition (Vue re-renders the visible slide's `aria-label` which the SR picks up).

### 8.3 Accessibility & motion

- `prefers-reduced-motion: reduce` → auto-advance disabled at mount time, slide transition becomes instant swap (no fade). Play/pause button stays available so a keyboard user can opt back in.
- Keyboard: Tab reaches controls in DOM order; Enter/Space activates; ArrowLeft/Right cycles slides when any control has focus.
- Screen-reader labels on every button; slide count in each slide's `aria-label` ("Concept name, slide 3 of 8").

### 8.4 Styling

New CSS in `hugo/assets/css/homepage/_featured-carousel.css`, imported by `hugo/assets/css/homepage.css`. Uses the SAP Horizon token palette shared with `hp-teaser`/`hp-band__title`. Slide transition: 300ms `opacity` cross-fade + a hairline horizontal translate (10px) for visual continuity. `@media (prefers-reduced-motion: reduce)` overrides both to instant.

## 9. Testing

### 9.1 Unit (SQLite, `npm test`)

| Suite | Location | Covers |
|-------|----------|--------|
| `featured-topics-selection.test.js` | `test/unit/srv/` | Editorial-first ordering; community diversity constraint; validity-window filter; `missionSlugs` override vs default TutorialRank order; truncation to 8; skipping unpublished/vetoed concepts; deterministic ordering. |
| `featured-topics-etag.test.js` | `test/unit/srv/` | ETag stability across identical snapshots; `If-None-Match` → 304; changed snapshot → new ETag. |
| `featured-topics-endpoint.test.js` | `test/unit/srv/` | `GET /build/featured-topics` and `GET /api/homepage/featuredTopics` return the current snapshot; empty snapshot → empty array, not 500. |
| `admin-featured-topics-crud.test.js` | `test/unit/srv/` | Draft create/update/delete on `AdminService.FeaturedTopics`; `@requires` gate; `@assert.unique.concept` duplicate rejection; after-SAVE fires `recomputeFeaturedTopics`. |
| `featured-topics-carousel.spec.ts` | `hugo-apps/apps/featured-topics-carousel/` (vitest + jsdom) | Vue island — auto-advance timer with fake timers; pause on hover/focus/hidden/manual-nav; deep-link parse; `prefers-reduced-motion` disables auto-advance; ETag hydration path (200 replaces, 304 keeps SSR); keyboard nav. |

### 9.2 Hybrid (real HANA, `npm run test:hybrid`)

`featured-topics-hybrid.test.js` — seed 3 editorial rows + fake ConceptRank/TutorialRank/KgCommunity fixtures → invoke `AdminService.recomputeFeaturedTopics()` → SELECT from `FeaturedTopicsSnapshot` → assert 8 rows in expected order → `GET /api/homepage/featuredTopics` → assert dereferenced payload shape. Also guards the slug-lowercase-canonical invariant.

### 9.3 Smoke (`npm run test:smoke`)

`smoke-featured-topics.test.js` — hit deployed `/api/homepage/featuredTopics`; assert 200, ≥1 slide, each mission slug resolves via `/tutorials/<slug>` HEAD 200.

## 10. Error handling & failure modes

| Failure | Behavior |
|---------|----------|
| Nightly job throws | Snapshot table untouched; readers see yesterday's slides. Metric `featured_topics_failures++`; job logs error. |
| `ConceptRank` empty | Job logs warning; emits editorial-only slides (up to 8). If both empty → empty snapshot → Row 5 disappears cleanly. |
| `KgCommunity` empty | Diversity filter no-ops (every candidate has null fingerprint → all pass). Slides may cluster around one topic area — acceptable degradation. |
| CAP endpoint 5xx during build | `fetch-tutorials.ts` catches; `featured_topics.json` written with `{ snapshot: [], etag: '' }`. Hugo renders nothing; Vue island still attempts runtime hydration and can recover. |
| Runtime endpoint 5xx | Vue island keeps SSR content silently. |
| Concept referenced by editorial gets vetoed/unpublished | Selection filters at snapshot time; editorial row survives in the entity, admin LR shows a `CONCEPT_UNPUBLISHED` warning column, but the slide is skipped. |
| `@cap-js/ai` `Common.ValueList` crash | Prevented per-field on `concept_ID` via `@UI.RecommendationState: 0`. |
| SSR JSON stale between rebuilds | Runtime hydration overlays. `304` for identical, `200` for changed. Cost of stale SSR: up to 24h older topics on the first paint until the next scheduled rebuild or editorial save. Acceptable. |

## 11. Observability

Metrics via `srv/lib/metrics.js`:

- `featured_topics_duration_ms` (histogram) — job wall-clock.
- `featured_topics_kg_count` (gauge) — KG-derived slots in last run.
- `featured_topics_editorial_count` (gauge) — editorial slots in last run.
- `featured_topics_failures` (counter).
- `featured_topics_endpoint_hits` (counter) — total requests.
- `featured_topics_endpoint_304s` (counter) — cache hits; ratio measures hydration effectiveness.

Admin surface at `/admin-ui/#featured-topics`:

- LR + OP over `AdminService.FeaturedTopics` (draft-enabled).
- Read-only tile "Last recomputed" pulling `MAX(computedAt)` from `FeaturedTopicsSnapshotView`.
- "Recompute now" action (SuperAdmin-gated) invoking `AdminService.recomputeFeaturedTopics()`.
- Read-only Snapshot facet on the LR object page showing the current slot ordering — auditability without a second nav.

## 12. Rebuild wiring

- Editorial save on `AdminService.FeaturedTopics` → after-write hook (a) calls `recomputeFeaturedTopics` inline so admin sees the new snapshot immediately; (b) triggers the debounced rebuild dispatcher (60s debounce, same code path as `HomepageShelves`) which runs `gh workflow run rebuild-content.yml -f mode=full`.
- Nightly job → **no rebuild dispatch**. Runtime hydration handles freshness for visitors. SSR JSON stays up to 24h stale between full rebuilds, which is acceptable because the Vue island overlays it within milliseconds of load.

## 13. Rollout

- **DEV first.** No environment flag; the entity is empty on first deploy, so the snapshot is KG-only until an editor adds picks. No visible surface change for developers who haven't published any concepts yet.
- **PROD cutover** end of July 2026 — same window as the AEM decommission. No separate feature flag needed; if the empty snapshot causes concerns, admins can seed `HomepageFeaturedTopics` rows before the cutover to guarantee content.
- **Kill switch:** if the carousel ships broken, revert Row 5's partial include in `hugo/layouts/index.html` back to `tutorials-teaser.html` and redeploy. The entity and endpoint stay in place, cost nothing when unused.

## 14. Related

- Homepage architecture: `docs/developers/architecture/homepage.md`
- KG PageRank job (#916): `srv/jobs/kg-pagerank-job.js` + `ConceptRank` sidecar
- KG communities (#917): `srv/jobs/kg-communities-job.js` + `KgCommunity`/`KgCommunityMembers`
- KG on-demand extraction (#948): supplies concepts for topics without prior graph coverage
- Existing homepage editorial surface: `HomepageService` / `HomepageForYouCandidates`
- CAP 10 Scheduling API wiring pattern: `srv/cron-service.js` (#958)
- CAP-AI `Common.ValueList` escape hatch: memory `cap-ai-plugin-aicore-kind-resolution` (#1019)

## 15. Non-goals

- Per-user personalization of slide order or content — the existing `HomepageForYouCandidates` row remains the personalized surface.
- Cross-visit persistence of the visitor's pause state or last-viewed slide — v1 resets each visit.
- Editorial pin-first flag beyond `sortOrder` — sort-order handles this.
- Rebuild-dispatch on nightly job — runtime hydration is sufficient; extra rebuild churn is not worth the freshness delta.
- Replacing `hugo/data/browse.json` — the JSON stays in place for `/browse/` and `/tutorial-navigator/`; only the homepage partial changes.
