# Homepage video band: expand slots + popularity rotation (#1031)

**Status:** Draft
**Issue:** [sap-tutorials/tutorials-ims#1031](https://github.com/sap-tutorials/tutorials-ims/issues/1031)
**Date:** 2026-07-07

## 1. Summary

The homepage "latest videos" strip (Row 4, right column) currently caps at three tiles and leaves visible whitespace next to the developer news column. Repeat visitors see the same three tiles for days between weekly SAP Developer News releases, and SAP's back catalog on YouTube never surfaces. This design expands the right stack to **six tiles** (3 newest + 3 popular) and adds a **4-hour rotation** for the popularity slots driven by real YouTube view velocity.

## 2. Goals

- Fill the whitespace next to the Developer News column.
- Surface older, high-signal videos (Tech Bytes, conference talks, live streams) alongside the newest three.
- Make the section feel fresh to repeat visitors without random-shuffle jitter.
- Keep the failure story as good as today: no crashes, sensible degradation.
- Give admins visible, tunable controls without a deploy.

## 3. Non-goals

- No change to the featured Developer News tile on the left (`developerNewsPlaylistId` flow unchanged).
- No per-user personalization of the rotation beyond the existing `applyVideoFilter` tag-boost. The rotation itself is global.
- No YouTube comment-signal or engagement-velocity blend — view velocity only for v1.
- No editorial curation UI for the rotation pool. Admin controls are opt-out (`excludeFromHomepage`) and tuning knobs, not hand-picked slot assignment.
- PROD rollout — DEV-only in v1, following the `#917` KG-communities pattern. PROD deferred.

## 4. Design decisions (from brainstorming)

| Decision | Value |
|---|---|
| Popularity signal | YouTube `videos?part=statistics` (viewCount / likeCount / commentCount) — velocity computed in Node |
| Layout | Extend right stack from 3 → 6 tiles (3 anchor + 3 rotation) |
| Rotation cadence | Scheduled cron every 4h |
| Where rotation lives | Sidecar table (`HomepageVideoRotation`) rewritten by the cron — matches the `FeaturedTopicsSnapshot` / `ConceptRank` / `TutorialRank` idiom |
| Admin controls | Tunable counts + `excludeFromHomepage` opt-out + manual re-pick action |
| Rotation labeling | "Popular" chip on rotation tiles; anchors have no chip |
| Trailing window | 90 days (configurable) |

## 5. Architecture

Row 4 right column becomes:

```
┌────────────────────────────────────────────────────┐
│  SAPDevs Video Band                                │
├──────────────────┬─────────────────────────────────┤
│                  │  ┌─────────┐  Recent 1 (anchor) │
│                  │  └─────────┘                     │
│  Featured        │  ┌─────────┐  Recent 2 (anchor) │
│  (Developer      │  └─────────┘                     │
│  News            │  ┌─────────┐  Recent 3 (anchor) │
│  playlist,       │  └─────────┘                     │
│  unchanged)      │  ┌─────────┐  [Popular]         │
│                  │  └─────────┘                     │
│                  │  ┌─────────┐  [Popular]         │
│                  │  └─────────┘                     │
│                  │  ┌─────────┐  [Popular]         │
│                  │  └─────────┘                     │
└──────────────────┴─────────────────────────────────┘
```

Data flow:

```
YouTube Data API v3
  ├─ playlistItems (featured slot)      ← existing, unchanged
  ├─ search (anchors, live)             ← existing, kept as belt-and-suspenders
  └─ videos?part=statistics (NEW)       ← added to fetch-videos-job.js
        │
        ▼
  ext.Videos + viewCount / likeCount / commentCount / statsLastFetchedAt
        │
        ▼ every 4h @ :19 past
  reshuffle-video-rotation.js cron
        │
        ▼
  HomepageVideoRotation sidecar (top-N by view velocity)
        │
        ▼ on request
  GET /homepage/videos
        │  merges: featured (live) + anchors (ext.Videos DESC) + rotation (sidecar)
        │  dedupes rotation vs anchor IDs
        │  emits `kind: "anchor" | "popular"` per item
        ▼
  VideoBand.vue renders 1 featured + up to 6 recent tiles with chips
```

## 6. Data model

### 6.1 `ext.Videos` new fields (`db/external-content.cds`)

```cds
entity Videos : cuid, managed {
  // ... existing fields (slug, title, description, url, youtubeVideoId,
  //     publishedAt, channelTitle, thumbnailUrl, sourceId, contentHash,
  //     lastExtractedHash, firstSeenAt, lastSeenAt, pinUntil, links, services)

  // Popularity statistics (#1031). Refreshed by fetch-videos-job.
  viewCount           : Integer64;
  likeCount           : Integer64;
  commentCount        : Integer64;
  statsLastFetchedAt  : Timestamp;

  // Curation flag (#1031). Excludes video from BOTH anchors + rotation.
  @title: 'Exclude from homepage'
  excludeFromHomepage : Boolean default false;
}
```

All new fields nullable / defaulted; no data migration needed.

### 6.2 New sidecar (`db/homepage.cds`)

```cds
/**
 * Materialised rotation slot set for the homepage video band. (#1031)
 * Rewritten every 4h by srv/jobs/reshuffle-video-rotation.js and on-demand
 * by AdminService.recomputeHomepageVideoRotation. Read by
 * HomepageService.videos() as the "popular / recently active" pool that
 * fills slots after the anchor slots.
 */
entity HomepageVideoRotation : cuid {
  video    : Association to ext.Videos @assert.notNull;
  rank     : Integer @assert.notNull;   // 1 = highest velocity in rotation
  pickedAt : Timestamp @cds.on.insert: $now;
}
```

Sidecar pattern parallels `FeaturedTopicsSnapshot` (#1032), `ConceptRank`, `TutorialRank`, `KgIsolation`.

### 6.3 `HomepageConfig` new fields (`db/homepage.cds`)

```cds
// (#1031) Video band tuning knobs.
videoBandAnchorCount        : Integer default 3;    // Newest-N slots, always shown
videoBandRotationCount      : Integer default 3;    // Popularity slots (total ≈ 6 tiles)
videoBandRotationWindowDays : Integer default 90;   // Trailing window for velocity calc
```

Existing fields untouched: `videoBandEnabled`, `developerNewsPlaylistId`, `eventsBandEnabled`, `communityLaneEnabled`.

## 7. Server

### 7.1 `srv/lib/youtube-corpus-fetcher.js` — statistics pass

Add `fetchStatistics({ apiKey, videoIds })`: batches `videos?part=statistics&id=<up to 50 ids>` calls (1 quota unit each). Returns `Map<videoId, { viewCount, likeCount, commentCount }>`. YouTube may return partial results if a video was deleted / made private — missing IDs stay unset in the map (caller handles).

### 7.2 `srv/jobs/fetch-videos-job.js` — write statistics on upsert

After the existing snippet-upsert loop, run a second pass calling `fetchStatistics` over **all** rows in `ext.Videos` (batched 50 at a time), not just the fresh page. Statistics refresh is decoupled from concept-extraction budget — it's just column writes, no LLM cost.

```
for each batch of 50:
  stats = fetchStatistics({apiKey, videoIds: batch})
  for each row:
    UPDATE ext.Videos SET viewCount=..., likeCount=..., commentCount=...,
                          statsLastFetchedAt=now
    WHERE ID = row.ID
```

`summary` gains `statsUpdated: number` for observability. Statistics failures log warnings but do not abort the cycle.

### 7.3 `srv/jobs/reshuffle-video-rotation.js` — new cron

Schedule: `19 */4 * * *` (every 4h at :19 past — avoids collisions with 03:11 fetch-videos, 03:57 kg-communities, 04:00 homepage-link-health, 04:07 kg-wcc, 04:13 kg-featured-topics).

```
1. Read HomepageConfig → { videoBandRotationCount, videoBandRotationWindowDays }.
2. windowCutoff = now - windowDays days.
3. rows = SELECT ID, publishedAt, viewCount FROM ext.Videos
          WHERE excludeFromHomepage = false
            AND publishedAt >= windowCutoff.
4. For each row:
     daysSincePublished = max(1, (now - publishedAt) / 86400_000)
     velocity = (viewCount ?? 0) / daysSincePublished
5. Sort by velocity DESC. Take top rotationCount.
6. Single transaction:
     BEGIN
       TRUNCATE HomepageVideoRotation           (or DELETE FROM ... on SQLite)
       INSERT rows with rank = 1..N, pickedAt = now.
     COMMIT
7. Metrics: homepage.videos.rotation.reshuffle[result=ok|error],
           homepage.videos.rotation.pool_size = candidate-pool count from step 3.
```

Registered in `srv/cron-service.js`. **Fail-quiet:** the TRUNCATE + INSERT run inside a single CAP transaction (`cds.tx`). If any statement throws, the whole transaction ROLLBACKs and the existing rotation stays in place — visitors keep seeing the previous rotation until the next successful run.

### 7.4 `srv/homepage-service.js` — expand `videos()` handler

Rewrite to merge three sources:

```
1. cfg = SELECT.one FROM HomepageConfig
   (unchanged auto-init fallback for missing config)

2. If cfg.videoBandEnabled === false:
     return { featured: null, recent: [], error: 'disabled' }

3. live = fetchSapDevsVideos({apiKey, playlistId, channelHandle: '@sapdevs'})
   (existing helper — provides `featured` from playlistId and up to 3
   `recent` as belt-and-suspenders if the DB path fails)

4. anchors = SELECT youtubeVideoId, title, thumbnailUrl, publishedAt
             FROM ext.Videos
             WHERE excludeFromHomepage = false
             ORDER BY publishedAt DESC
             LIMIT cfg.videoBandAnchorCount

5. rotation = SELECT v.youtubeVideoId, v.title, v.thumbnailUrl, v.publishedAt,
                     r.rank
              FROM HomepageVideoRotation r
              JOIN ext.Videos v ON r.video_ID = v.ID
              WHERE v.excludeFromHomepage = false
              ORDER BY r.rank ASC
              LIMIT cfg.videoBandRotationCount

6. anchorIds = new Set(anchors.map(a => a.youtubeVideoId))
   rotationDeduped = rotation.filter(r => !anchorIds.has(r.youtubeVideoId))

7. recent = [
     ...anchors.map(a => ({...toItem(a), kind: 'anchor'})),
     ...rotationDeduped.map(r => ({...toItem(r), kind: 'popular'})),
   ]

8. Fallback: if anchors.length === 0 AND rotation.length === 0
   AND live.recent?.length > 0:
     recent = live.recent.map(r => ({...r, kind: 'anchor'}))
   (preserves the #1007 fallback behavior — never a 500)

9. return { featured: live.featured, recent, error: live.error ?? null }
```

**Response shape (backward compatible):**

```json
{
  "featured": { "videoId": "...", "title": "...", "thumbnail": "...", "publishedAt": "..." },
  "recent": [
    { "videoId": "...", "title": "...", "thumbnail": "...", "publishedAt": "...", "kind": "anchor" },
    ...
    { "videoId": "...", "title": "...", "thumbnail": "...", "publishedAt": "...", "kind": "popular" }
  ],
  "error": null
}
```

Old clients ignore the new `kind` field; new client reads it for the chip.

### 7.5 `AdminService` — new action

```cds
action recomputeHomepageVideoRotation() returns String;
```

SuperAdmin-gated (matches `recomputeFeaturedTopics` guard pattern). Invokes `runReshuffleVideoRotation()` inline, returns a one-line summary (e.g. `"3 rows inserted; pool_size=42"`). Wired at `/admin-ui/#videos` LR toolbar.

### 7.6 CQL / HANA caveats

- No BLOB columns involved — CDS QL works on both SQLite (unit tests) and HANA.
- `viewCount` / `likeCount` / `commentCount` typed `Integer64` — YouTube's counters exceed 32-bit for popular videos.
- Anchor + rotation SELECTs are bounded (≤ 6 rows each) — no risk of the `#1032` CQN `.where({in: bigArray})` HANA packet-size trap.

## 8. Client

### 8.1 `hugo-apps/src/homepage-bands/VideoBand.vue`

- Drop the hard-coded `recent.slice(0, 3)`. Render everything in `body.recent`.
- Extend the `VideoItem` interface with `kind?: 'anchor' | 'popular'`.
- Render a small chip on `kind === 'popular'` tiles:
  ```html
  <span class="hb-video-band__chip">Popular</span>
  ```
  Positioned absolute top-left over the thumbnail. Anchor tiles show no chip.
- `applyVideoFilter` continues to run over the full `recent` array — it may reorder but not truncate. Keeps the tag-boost behavior visitor-side without interfering with server ranking.

### 8.2 CSS

```css
.hb-video-band__recent-card { position: relative; /* new — for chip anchor */ }

.hb-video-band__chip {
  position: absolute;
  top: 4px;
  left: 4px;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--sapInformativeBackground, #e8f2ff);
  color: var(--sapInformativeTextColor, #0064d9);
  font-weight: 600;
  z-index: 1;
}
```

Stack layout unchanged: `.hb-video-band__stack` remains `flex-direction: column; gap: 0.75rem`. Six tiles fit naturally; each row is 72 px tall (~54 px thumb + padding + title), so 6 tiles ≈ 432 px — matches Developer News column height with room to spare.

Mobile (`max-width: 768px`): stack becomes single-column beneath featured — unchanged.

## 9. Admin UI

### 9.1 `/admin-ui/#videos` — new list report

Projection: `AdminService.Videos` over `ext.Videos`. Columns:

- `title` (read-only)
- `channelTitle` (read-only)
- `publishedAt` (read-only, ISO date)
- `viewCount` (read-only)
- `likeCount` (read-only)
- `excludeFromHomepage` (editable, single-field draft)

Toolbar action: `recomputeHomepageVideoRotation` (SuperAdmin-gated).

### 9.2 `/admin-ui/#video-rotation` — read-only rotation viewer

Projection: `AdminService.HomepageVideoRotation` joined to `Videos`. Columns:

- `rank`
- `title`
- `viewCount`
- `publishedAt`
- `pickedAt`

Read-only. Lets admins verify "what's in rotation right now" without curling `/homepage/videos`.

### 9.3 `/admin-ui/#homepage` Config tab additions

Add three new fields under a "Video band" facet on the existing Config Object Page:

- `videoBandAnchorCount` (default 3)
- `videoBandRotationCount` (default 3)
- `videoBandRotationWindowDays` (default 90)

Hint text: "Total tiles = anchor + rotation (deduped). Set rotation to 0 to disable popularity slots."

## 10. Failure modes

| Failure | Behavior |
|---|---|
| Reshuffle cron throws | `HomepageVideoRotation` untouched (transaction ROLLBACK). Stale rotation continues to serve. Metric `homepage.videos.rotation.reshuffle[result=error]` increments. |
| `HomepageVideoRotation` empty (fresh install, first cron hasn't fired) | Response returns anchors only. Client renders 3 tiles until cron runs. No 500. |
| Statistics fetch fails in `fetch-videos-job.js` | Snippet upsert already succeeded. `viewCount`/`likeCount` stay stale (or null on first insert). Rotation uses whatever is there; velocity = 0 for null-viewCount rows → they sort to the bottom → naturally deprioritized. |
| YouTube quota exceeded during statistics pass | Statistics phase logs a warning + moves on. `summary.errors++`. Snippet upserts already complete. |
| `videoBandEnabled = false` | Short-circuit unchanged — `{ featured: null, recent: [], error: 'disabled' }`. Cron still runs (writes rotation), but nothing consumes it — cheap. |
| `HomepageConfig` missing (fresh subaccount) | Existing auto-init handler applies defaults; new fields default to `anchor=3, rotation=3, window=90`. Total tiles = 6. |
| Anchor list < `videoBandAnchorCount` (near-empty corpus) | Return whatever anchors we have + rotation. No padding, no fake tiles. |
| `applyVideoFilter` receives 0-length `recent` | Returns `[]` (existing behavior). VideoBand's guard already handles this. |
| Live `fetchSapDevsVideos` fails AND `ext.Videos` empty | Client renders error card → link to `@sapdevs` YouTube channel (existing behavior). |

## 11. Kill switches

Two levels, in order of severity:

1. **Rotation only:** set `videoBandRotationCount = 0` at `/admin-ui/#homepage`. Endpoint returns anchors only; existing three-tile behavior restored within one cache tick (≤ 15 min). Zero deploy.
2. **Whole band:** existing `videoBandEnabled = false` toggle. Unchanged from today.

Full revert path if something goes sideways: revert the two DB migrations (`ext.Videos` new columns + `HomepageVideoRotation` table) + Hugo apps redeploy. `HomepageConfig` new fields are additive with defaults — safe to leave in place.

## 12. Testing

### 12.1 Unit tests (Node / Vitest)

- `srv/lib/youtube-corpus-fetcher.test.js` — statistics-pass mock: happy path, 403 quota-exceeded, partial response (some IDs missing statistics), empty ID list.
- `srv/jobs/reshuffle-video-rotation.test.js` — velocity ranking correct; excluded rows filtered; window filter respected; TRUNCATE-then-INSERT atomic (rotation isn't half-written on throw); null-viewCount rows deprioritized.
- `srv/homepage-service.test.js` — extend existing `videos()` tests:
  - anchors + rotation deduped by youtubeVideoId
  - `kind` field emitted correctly per source
  - anchors-only fallback when rotation empty
  - `videoBandRotationCount = 0` skips rotation SELECT
  - personalization `applyVideoFilter` runs post-merge
- `hugo-apps/src/homepage-bands/VideoBand.test.ts` — 6-tile render; "Popular" chip visibility keyed on `kind`; empty-rotation resilience; back-compat with legacy 3-item response (no `kind` field).

### 12.2 Hybrid smoke (real HANA via `cds bind`)

- `test/hybrid/homepage-videos-1031.test.js` — call `runReshuffleVideoRotation`, assert N rows in `HomepageVideoRotation`, GET `/homepage/videos`, assert response has `kind` on every `recent` item.

### 12.3 Post-deploy smoke (`test/smoke/homepage.js`)

- Assert `/homepage/videos` returns `recent.length >= anchorCount` (lower bound; rotation may be 0 immediately after deploy).
- Assert every `recent` item has `kind ∈ {"anchor", "popular"}`.
- Preserves the existing "≥ 3 items" contract as a floor.

## 13. Migration + rollout

- Schema deploy via `cds build --production` + MTA deploy. All new columns nullable / defaulted, no data migration needed.
- **First run:** after deploy, `HomepageVideoRotation` is empty. Options:
  - Let the next 4h cron populate it (visitors see 3-tile behavior for ≤ 4h). Acceptable.
  - Trigger `recomputeHomepageVideoRotation()` from `/admin-ui/#videos` post-deploy to populate immediately. **Recommended for the DEV cutover.**
- Statistics on `ext.Videos` start populating on the next `fetch-videos-job.js` cycle (Sun/Wed 03:11 UTC). To fast-forward: run the job manually.
- **DEV-only in v1.** PROD rollout deferred, matching the `#917` KG-communities pattern. Cutover to PROD after ≥ 1 week of DEV soak with no regressions.

## 14. Docs

Update `docs/developers/architecture/homepage.md`:

- Row 4 diagram: `LEFT — Weekly Developer News. RIGHT — 6 tiles: 3 newest + 3 popular (rotates every 4h).`
- Failure-modes table: add reshuffle-cron, empty-rotation, statistics-fetch rows.
- Components table: add `reshuffle-video-rotation` cron entry.
- Admin operations: how to tune counts and exclude a video.

Add hazard note to `docs/developers/reference/tutorials-ims-gotchas.md`:

- Reshuffle cron is TRUNCATE + INSERT — must run inside a single transaction; do NOT split.

## 15. Metrics

New metrics via existing `srv/lib/metrics.js`:

- `homepage.videos.rotation.reshuffle[result=ok|error]` — cron outcome counter
- `homepage.videos.rotation.pool_size` — gauge of candidate rows pre-rank
- `homepage.videos.rotation.duration_ms` — histogram of reshuffle wall-clock
- `homepage.videos.statistics_updated` — counter incremented per successful `viewCount` UPDATE

## 16. Open questions

None outstanding. All open questions from issue #1031 resolved in Section 4.

## 17. Related

- Issue: https://github.com/sap-tutorials/tutorials-ims/issues/1031
- Architecture doc: [../../developers/architecture/homepage.md](../../developers/architecture/homepage.md)
- Sidecar pattern precedent (#1032): [2026-07-06-1032-featured-missions-carousel-design.md](2026-07-06-1032-featured-missions-carousel-design.md)
- `#1007` fallback path in `HomepageService.videos()` (preserved intact)
