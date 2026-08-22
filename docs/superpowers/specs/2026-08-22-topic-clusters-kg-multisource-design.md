# Expand homepage "Explore topic clusters" to KG multi-source content

**Date:** 2026-08-22
**Status:** Design — awaiting review
**Issue:** TBD (file before implementation)

## Problem

The homepage "Explore topic clusters" band (`hugo/layouts/partials/homepage/topic-clusters-band.html`) shows **tutorials only**. Each card is a labeled Louvain community with up to 4 tutorial links. The Knowledge Graph already links 15 node types to shared concepts, and the Louvain communities the band is built from are internally mixed-type — but the builder discards every non-tutorial member before display. We want each cluster to surface the full breadth of KG-linked content (blogs, videos, missions, learning journeys, API docs, samples, help docs, community events, groups, …), so the band becomes a true multi-source discovery surface rather than a tutorial list.

## Current state (verified)

- **Band render:** `hugo/layouts/partials/homepage/topic-clusters-band.html` — SSR-only, no island, no hydration. Reads `.Site.Data.topic_clusters`, iterates clusters, renders `label` + `rationale` + a `<ul>` of tutorial links. Empty-safe by omission.
- **Data file:** `hugo/data/topic_clusters.json` — `{ clusters:[{label, rationale, communityFingerprint, tutorialCount, tutorials:[{slug,title,url}]}], buildAt, error }`.
- **Build fetch:** `scripts/fetch-topic-clusters.ts` GETs `${CAP_BASE}/build/topic-clusters`, writes the JSON, fail-open to `{clusters:[]}`.
- **Builder:** `srv/lib/build-topic-clusters.js` (`buildTopicClustersPayload`), wired at `srv/server.js:292`. Reads labeled communities from `KgCommunityLabel`, per-fingerprint `tutorialCount` from `KgCommunitySummaryV`, ranks by tutorialCount (MIN_TUTORIALS=3, MAX_CLUSTERS=6), reads members from `KgCommunity` **filtered to `vertexType:'tutorial'`**, resolves against `Tutorials` (ACTIVE), caps at 4/card.
- **KG multi-source data exists:** node-type registry `KG_IRI_PREFIXES` in `srv/lib/kg-projection.js` covers tutorial, concept, mission, group, product, category, tag, learning-journey, blog-post, discovery-mission, video, api-doc, sample, help-doc, community-event. Concept link tables: `TutorialConceptLinks` (teaches), `LearningJourneyConceptLinks` (covers), `BlogPostConceptLinks` (discusses), `DiscoveryMissionConceptLinks` (teaches), `VideoConceptLinks` (teaches), `ApiDocConceptLinks` (officialReferenceFor), `SampleConceptLinks` (embodies), `HelpDocConceptLinks` (explains), `CommunityEventConceptLinks` (covers). External content entities live in `com.sap.developers.ims.external` (`db/external-content.cds`).
- **Precedent for mixed rendering:** the Featured-missions carousel (`hugo/layouts/partials/homepage/featured-topics-carousel.html`) is a Vue island that dispatches cards by `kind` (`tutorial` / `mission`) and rehydrates via a `/homepage/*` endpoint with `If-None-Match`. Registered in `hugo/data/island_manifest.json` + Vite manifest.

## Decisions (locked with product)

1. **Content mix:** everything the KG links (all applicable node types), with ranking + per-type caps deciding the on-card mix — not a curated subset.
2. **Render:** **hybrid** — SSR-bake the stable tier, live-hydrate the volatile tier via an island.
3. **Card layout:** flat ranked list per card, each item tagged with a source-type badge.
4. **Phasing:** build the full hybrid now (SSR stable tier + volatile island together).

## Design

### Tiering by freshness

Members of each community are resolved into two tiers:

- **Stable tier (baked at build into `topic_clusters.json`):** tutorials, missions, groups, learning journeys, discovery missions, API docs, samples, help docs. These change only at deploy/rebuild cadence, so baking them keeps the band useful with zero JS (LCP/SEO preserved).
- **Volatile tier (hydrated live by the island):** community events, recent blog posts, recent videos. Freshness matters (a past event is dead weight; recent blogs/videos churn), so these are fetched at runtime and merged on top.

### Item normalization

Every resolved item — regardless of source — normalizes to:

```
{ kind, slug, title, href, isNew, rank }
```

- `kind` ∈ the KG node types above; drives the badge label + styling.
- `href` is the type-specific route (`/tutorials/<slug>`, `/missions/<slug>`, blog/video external URL, etc.).
- `isNew` — reuse existing new-badge logic where the source carries a date.
- `rank` — blended score (below).

### Ranking + caps

- Base score blends concept/tutorial **PageRank** (already available via `loadRankMaps()` in `knowledge-graph-service.js`) with a **recency** term for the time-sensitive volatile types.
- **Per-type caps** prevent any high-volume source from flooding a card. Initial caps (tunable): tutorials ≤3, missions ≤2, blogs ≤2, videos ≤2, events ≤1, others ≤1. **Total items per card ≈ 6–8.**
- Final on-card list is the merged stable+volatile set, sorted by `rank`, then capped to the total.

### Backend components

1. **Widen `srv/lib/build-topic-clusters.js`:**
   - Stop hard-filtering to `vertexType:'tutorial'`. For each community, resolve members across all vertex types, plus concept-linked external content via the concept link tables (community → concept members → linked blogs/videos/etc.).
   - Return the **stable tier** in the `/build/topic-clusters` payload (extend, don't break: keep `tutorials` for back-compat if any consumer relies on it, add a new `items` array with normalized shape).
   - Each per-type resolution in its **own try/catch** → a throwing/empty link table contributes nothing, never a 500.
   - **HANA discipline:** chunk every `.in()` at ≤500 (packet cap); never SELECT a HANA BLOB alongside metadata; UPPERCASE columns in any raw SQL.
2. **New volatile endpoint** `GET /homepage/topicClusterVolatile` (or a bound function on HomepageService), keyed by `communityFingerprint`:
   - Returns only the volatile-tier items per fingerprint.
   - `ETag` + `If-None-Match` support, 60s cache, fail-open to empty.
3. **srv-qa cp-list audit:** confirm `build-topic-clusters.js` is not a transitive `./` dependency of `srv/lib/content-store.js`. If it is, add it (and any new deps) to the `srv-qa` `cp` list in `.deploy/mta.yaml`. (Expected: it is not — no action.)

### Frontend components

1. **`topic-clusters-band.html`:** keep rendering the **stable tier server-side** (flat list + type badges), and add a `data-app="topic-clusters-band"` mount so the island can augment. Preserve empty-by-omission.
2. **New Vue island** (`hugo-apps/`): fetch the volatile tier from the new endpoint, merge into each card's flat list keyed by `communityFingerprint`, re-sort by `rank`, re-apply the total cap. On fetch failure, leave SSR content untouched. Register in `hugo/data/island_manifest.json` and confirm it emits into the Vite manifest.
3. **Badges:** reuse the Featured-missions `kind`-dispatch + badge styling patterns; add badge variants for the new kinds.

### Data flow

```
Build:   fetch-topic-clusters.ts → GET /build/topic-clusters (stable tier)
                                  → hugo/data/topic_clusters.json → SSR band (baked)
Runtime: island → GET /homepage/topicClusterVolatile (If-None-Match)
                → merge volatile items into cards → re-rank → render
```

### Error handling / fail-open

- Band is empty-safe by omission today; that property is preserved end-to-end.
- Per-type resolution try/catch on the backend; endpoint fail-open to empty; island fetch failure is a no-op over intact SSR content.

## Risks & pre-implementation verification

- **PROD data population (blocking spike, do first):** count rows in `BlogPostConceptLinks`, `VideoConceptLinks`, `CommunityEventConceptLinks`, `LearningJourneyConceptLinks`, `DiscoveryMissionConceptLinks`, `ApiDocConceptLinks`, `SampleConceptLinks`, `HelpDocConceptLinks` in **DEV and PROD**. Community membership + labels are DEV-populated / nightly-rebuilt; several external link tables may be sparse or empty in PROD. If a type is empty it silently no-ops (acceptable), but this determines what actually lights up at launch and whether the volatile island earns its JS cost. Report counts before building the island.
- **`communityId` volatility:** all stable references key on `communityFingerprint`, never `communityId` (reshuffles each Louvain pass). The volatile endpoint keys on fingerprint accordingly.
- **Island bundle wiring:** `island_manifest.json` must be produced by the explicit `build:island-manifest` step (lifecycle hooks are silenced by `ignore-scripts=true`); verify the baked homepage references the hashed island path, not the unhashed fallback.

## Testing

- **Unit — widened builder:** mixed vertex types resolved; per-type caps enforced; fail-open when a link table throws or is empty; ranking order (PageRank + recency); back-compat of existing `tutorials` field.
- **Unit — volatile endpoint:** ETag/304 round-trip; empty fail-open; fingerprint keying.
- **Hugo SSR band test:** badge rendering for each stable kind; stable-tier-only present in baked HTML; empty-by-omission.
- **Island hydrate test:** merges volatile items by fingerprint, re-ranks, survives fetch failure (SSR content intact).
- **e2e:** touches `hugo/layouts/**` + `hugo-apps/**` → the advisory e2e-coverage nudge fires; add/update a `test/e2e/` spec exercising the band on a deployed env.

## Out of scope

- No changes to the Louvain / community-labeling pipeline (`kg-communities-job.js`, `kg-community-label-job.js`) — we consume its output.
- No changes to the `/topics/` gallery or Featured-missions carousel beyond reusing their patterns.
- No new curation UI for cluster contents (the mix is graph-driven + capped).
