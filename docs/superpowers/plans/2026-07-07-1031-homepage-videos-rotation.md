# Homepage video band expand + popularity rotation — Implementation Plan (#1031)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the homepage latest-videos strip from 3 to 6 tiles (3 anchor + 3 rotation), backed by a 4-hour reshuffle cron picking top-velocity videos from a materialised sidecar.

**Architecture:** New `ext.Videos` statistics columns + new `HomepageVideoRotation` sidecar + new `reshuffle-video-rotation` cron. `GET /homepage/videos` merges anchors (`ext.Videos ORDER BY publishedAt DESC`) with rotation (sidecar) and tags each item `kind: 'anchor' | 'popular'`. `VideoBand.vue` renders up to 6 tiles with a "Popular" chip on rotation items. Admin controls at `/admin-ui/#videos` (opt-out + manual re-pick), `/admin-ui/#video-rotation` (read-only), and expanded `/admin-ui/#homepageConfig` (tuning knobs).

**Tech Stack:** CAP Node.js (CDS + `cds.ql`), SAP HANA Cloud (via `db/last-dev/*` on hybrid), Hugo static site, Vue 3 island (`hugo-apps/`), Vitest, Fiori Elements V4 (admin UIs).

## Global Constraints

- **Spec reference:** [docs/superpowers/specs/2026-07-07-1031-homepage-videos-rotation-design.md](../specs/2026-07-07-1031-homepage-videos-rotation-design.md) — every task honors it.
- **DEV-only in v1.** PROD rollout deferred, matching the `#917` KG-communities pattern.
- **No raw SQL** — use `cds.ql` / CQL. `db.run(SELECT.from(...))` etc.
- **New DB columns nullable / defaulted.** No data migration.
- **CSV / schema hygiene:** run `npx cds deploy --to sqlite::memory:` after every `db/*.cds` edit before committing (~4 s — catches `@assert.unique.*` violations that `cds compile` misses).
- **CAP 10 outbox scheduling:** register new cron via `registerJob()` in `srv/jobs/scheduler.js`. Do NOT add `srv.schedule()` calls in `srv/cron-service.js` directly — the registry loop wires them.
- **Never touch `hugo/public/js/homepage-bands.js`** — it is generated. Edit `hugo-apps/src/homepage-bands/VideoBand.vue`; rebuild via `npm run build:apps` (or `npm run build:all`).
- **Response backward compatibility:** `/homepage/videos` keeps the `{ featured, recent, error }` shape. Only additive: new `kind` field per `recent` item.
- **HANA gotcha:** anchor + rotation SELECTs are bounded (≤ 6 rows). Do NOT use `.where({ID: {in: bigArray}})` patterns.
- **YouTube quota budget:** statistics pass is 1 unit per 50 IDs — a full-corpus refresh (say 500 videos) costs ≤ 10 units per cron cycle. Trivial vs. the 10 000 unit daily cap. Statistics failures must log-warn + continue (never abort the cycle).
- **Metrics naming:** all new metrics use the `homepage.videos.*` prefix (existing `homepage.videos.fallback[...]` idiom).
- **SuperAdmin gate:** `recomputeHomepageVideoRotation` action requires `@requires: 'SuperAdmin'` (matches `recomputeFeaturedTopics`).
- **Commit style:** every task ends with one commit, subject prefix `feat(#1031):` / `test(#1031):` / `docs(#1031):`.

---

## File map

**Create:**
- `srv/jobs/reshuffle-video-rotation.js` — reshuffle cron body
- `test/unit/reshuffle-video-rotation.test.js` — unit tests for the reshuffle cron
- `test/unit/youtube-corpus-fetcher-statistics.test.js` — unit tests for the new `fetchStatistics`
- `test/hybrid/homepage-videos-1031.test.js` — hybrid smoke against real HANA
- `app/admin/videos/webapp/manifest.json`
- `app/admin/videos/webapp/Component.js`
- `app/admin/videos/webapp/i18n/i18n.properties`
- `app/admin/video-rotation/webapp/manifest.json`
- `app/admin/video-rotation/webapp/Component.js`
- `app/admin/video-rotation/webapp/i18n/i18n.properties`

**Modify:**
- `db/external-content.cds` — statistics columns + `excludeFromHomepage` on `Videos`
- `db/homepage.cds` — `HomepageVideoRotation` entity + `HomepageConfig` new fields
- `srv/lib/youtube-corpus-fetcher.js` — export `fetchStatistics`
- `srv/jobs/fetch-videos-job.js` — second pass writing statistics
- `srv/jobs/scheduler.js` — register `reshuffle-video-rotation` job
- `srv/homepage-service.js` — merge anchors + rotation, emit `kind`
- `srv/admin-service.cds` — Videos + HomepageVideoRotation projections + action
- `srv/admin-service.js` — action handler + Videos entity restrictions
- `app/admin-annotations.cds` — Fiori annotations for the two new projections
- `app/admin-shell/webapp/manifest.json` — component + route + target for videos + video-rotation
- `app/admin-shell/webapp/model/navigation.json` — nav entries under Homepage group
- `app/admin-shell/webapp/controller/Shell.controller.js` — NAV_KEY_TO_ROUTE + NAV_KEY_TO_TITLE
- `hugo-apps/src/homepage-bands/VideoBand.vue` — render 6 tiles + Popular chip
- `hugo-apps/src/homepage-bands/VideoBand.test.ts` — new tests
- `test/smoke/homepage.smoke.test.ts` — assert `kind` field
- `docs/developers/architecture/homepage.md` — diagram, failure modes, components
- `docs/developers/reference/tutorials-ims-gotchas.md` — reshuffle-cron TRUNCATE-in-tx hazard note

Task order optimizes to keep each task self-contained and end-to-end testable. Tasks 1–5 land server + data. Task 6 wires the cron. Task 7 rewrites the endpoint. Task 8 delivers the client. Tasks 9–10 deliver admin surfaces. Task 11 handles docs.

---

### Task 1: DB schema — statistics columns + rotation sidecar + config knobs

**Files:**
- Modify: `db/external-content.cds` — add fields after existing `pinUntil` (near line 216)
- Modify: `db/homepage.cds` — add sidecar entity + HomepageConfig fields (near line 90)

**Interfaces:**
- Consumes: nothing (schema-first task)
- Produces:
  - `com.sap.developers.ims.external.Videos.viewCount / likeCount / commentCount / statsLastFetchedAt / excludeFromHomepage`
  - `com.sap.developers.ims.HomepageVideoRotation { ID, video (Association to ext.Videos), rank, pickedAt }`
  - `com.sap.developers.ims.HomepageConfig.videoBandAnchorCount / videoBandRotationCount / videoBandRotationWindowDays`

- [ ] **Step 1: Add fields to `db/external-content.cds`**

Locate the `entity Videos` block (around line 201). After the `pinUntil : Timestamp;` line and before the `links` composition, insert:

```cds
  // (#1031) Popularity statistics — refreshed by srv/jobs/fetch-videos-job.js.
  // Integer64 because YouTube view counts routinely exceed 32-bit for popular
  // clips. All four columns are nullable so freshly-inserted rows can carry no
  // statistics until the next fetch-videos-job pass fills them in.
  viewCount           : Integer64;
  likeCount           : Integer64;
  commentCount        : Integer64;
  statsLastFetchedAt  : Timestamp;

  // (#1031) Curation flag — excludes video from BOTH homepage anchors and
  // the rotation pool. Admins toggle via /admin-ui/#videos.
  @title: 'Exclude from homepage'
  excludeFromHomepage : Boolean default false;
```

- [ ] **Step 2: Add HomepageVideoRotation entity to `db/homepage.cds`**

At the top of the file (after `using { managed, cuid } from '@sap/cds/common';`), add:

```cds
using { com.sap.developers.ims.external as ext } from './external-content';
```

At the end of `db/homepage.cds`, append:

```cds
/**
 * (#1031) Materialised rotation slot set for the homepage video band.
 *
 * Rewritten every 4h by srv/jobs/reshuffle-video-rotation.js and on-demand
 * by AdminService.recomputeHomepageVideoRotation. Read by
 * HomepageService.videos() as the "popular / recently active" pool that
 * fills slots after the anchor slots.
 *
 * Sidecar pattern parallels FeaturedTopicsSnapshot (#1032), ConceptRank,
 * TutorialRank, KgIsolation.
 */
entity HomepageVideoRotation : cuid {
  video    : Association to ext.Videos @assert.notNull;
  rank     : Integer @assert.notNull;   // 1 = highest velocity in rotation
  pickedAt : Timestamp @cds.on.insert: $now;
}
```

- [ ] **Step 3: Add HomepageConfig tuning knobs**

In `db/homepage.cds`, locate the `entity HomepageConfig` block (around line 82). Before the closing `}`, add:

```cds
  // (#1031) Video band tuning knobs. Total tiles = anchor + rotation (deduped
  // by youtubeVideoId). Set videoBandRotationCount = 0 to disable the
  // popularity slots while keeping the band otherwise unchanged.
  videoBandAnchorCount        : Integer default 3;
  videoBandRotationCount      : Integer default 3;
  videoBandRotationWindowDays : Integer default 90;
```

- [ ] **Step 4: Verify the schema compiles and deploys**

Run:

```bash
npx cds compile db/ srv/ -2 sql > /dev/null && echo COMPILE_OK
npx cds deploy --to sqlite::memory: > /dev/null && echo DEPLOY_OK
```

Expected: both `COMPILE_OK` and `DEPLOY_OK` printed. If deploy fails, most likely the `@assert.notNull` on the association wants a `not null` variant — check the diagnostic and adjust.

- [ ] **Step 5: Commit**

```bash
git add db/external-content.cds db/homepage.cds
git commit -m "feat(#1031): add Videos statistics + HomepageVideoRotation sidecar + config knobs"
```

---

### Task 2: YouTube corpus fetcher — statistics endpoint

**Files:**
- Modify: `srv/lib/youtube-corpus-fetcher.js` — add `fetchStatistics` export
- Create: `test/unit/youtube-corpus-fetcher-statistics.test.js`

**Interfaces:**
- Consumes: none
- Produces: `fetchStatistics({ apiKey, videoIds }) → Promise<Map<videoId, { viewCount, likeCount, commentCount }>>`. Missing IDs in the response are absent from the Map (never included with `null`/`0`). Batches internally at 50 IDs per HTTP call. Throws on network failure of the first batch; on any batch after the first, throws too (caller decides whether to abort or continue).

- [ ] **Step 1: Write the failing test**

Create `test/unit/youtube-corpus-fetcher-statistics.test.js`:

```javascript
// test/unit/youtube-corpus-fetcher-statistics.test.js
//
// (#1031) Unit tests for youtube-corpus-fetcher.fetchStatistics.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fetchStatistics,
  _setMockFetcher,
  _resetForTests,
} from '../../srv/lib/youtube-corpus-fetcher.js';

describe('fetchStatistics (#1031)', () => {
  afterEach(() => _resetForTests());

  it('returns viewCount/likeCount/commentCount per requested id in one batch', async () => {
    _setMockFetcher(async (url) => {
      expect(url).toContain('/videos?');
      expect(url).toContain('part=statistics');
      expect(url).toContain('id=a%2Cb'); // "a,b" url-encoded
      return {
        items: [
          { id: 'a', statistics: { viewCount: '1234', likeCount: '10', commentCount: '3' } },
          { id: 'b', statistics: { viewCount: '5', likeCount: '0', commentCount: '0' } },
        ],
      };
    });

    const result = await fetchStatistics({ apiKey: 'k', videoIds: ['a', 'b'] });
    expect(result.get('a')).toEqual({ viewCount: 1234, likeCount: 10, commentCount: 3 });
    expect(result.get('b')).toEqual({ viewCount: 5, likeCount: 0, commentCount: 0 });
  });

  it('splits >50 ids into batches of 50', async () => {
    const calls = [];
    _setMockFetcher(async (url) => {
      calls.push(url);
      const idsParam = decodeURIComponent(url.split('id=')[1].split('&')[0]);
      const ids = idsParam.split(',');
      return { items: ids.map(id => ({ id, statistics: { viewCount: '1', likeCount: '0', commentCount: '0' } })) };
    });

    const ids = Array.from({ length: 120 }, (_, i) => `v${i}`);
    const result = await fetchStatistics({ apiKey: 'k', videoIds: ids });
    expect(calls).toHaveLength(3);  // 50 + 50 + 20
    expect(result.size).toBe(120);
  });

  it('omits ids YouTube does not return (deleted/private videos)', async () => {
    _setMockFetcher(async () => ({
      items: [ { id: 'a', statistics: { viewCount: '1', likeCount: '0', commentCount: '0' } } ],
    }));

    const result = await fetchStatistics({ apiKey: 'k', videoIds: ['a', 'b'] });
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(false);
  });

  it('returns an empty Map when given no ids without hitting the API', async () => {
    let called = false;
    _setMockFetcher(async () => { called = true; return { items: [] }; });
    const result = await fetchStatistics({ apiKey: 'k', videoIds: [] });
    expect(result.size).toBe(0);
    expect(called).toBe(false);
  });

  it('propagates HTTP errors (403 quota exceeded)', async () => {
    _setMockFetcher(async () => {
      const err = new Error('YouTube API 403');
      err.status = 403;
      throw err;
    });
    await expect(fetchStatistics({ apiKey: 'k', videoIds: ['a'] })).rejects.toThrow('403');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run test/unit/youtube-corpus-fetcher-statistics.test.js
```

Expected: FAIL with `fetchStatistics is not exported` (or similar).

- [ ] **Step 3: Implement `fetchStatistics` in `srv/lib/youtube-corpus-fetcher.js`**

At the bottom of `srv/lib/youtube-corpus-fetcher.js` (after `fetchSapDevsVideoCorpus`), append:

```javascript
/**
 * (#1031) Batch-fetch YouTube video statistics for a list of video IDs.
 *
 * YouTube's videos?part=statistics endpoint accepts up to 50 comma-separated
 * IDs per request at a cost of 1 quota unit each (vs. 100 for search). This
 * function batches at 50, deserialises numeric statistics into numbers, and
 * returns a Map keyed by videoId.
 *
 * IDs missing from the response (deleted / made private) are omitted from
 * the Map — callers should treat "absent" as "unknown", not zero.
 *
 * @param {object} opts
 * @param {string}   opts.apiKey
 * @param {string[]} opts.videoIds
 * @returns {Promise<Map<string, { viewCount: number, likeCount: number, commentCount: number }>>}
 */
export async function fetchStatistics({ apiKey, videoIds }) {
  const result = new Map();
  if (!videoIds || videoIds.length === 0) return result;
  if (!apiKey) throw new Error('youtube-corpus-fetcher.fetchStatistics: apiKey required');

  const BATCH = 50;
  for (let i = 0; i < videoIds.length; i += BATCH) {
    const chunk = videoIds.slice(i, i + BATCH);
    const idParam = encodeURIComponent(chunk.join(','));
    const url = `${API_BASE}/videos?part=statistics&id=${idParam}&key=${encodeURIComponent(apiKey)}`;
    const data = await fetchJson(url);
    for (const item of data.items ?? []) {
      const s = item.statistics ?? {};
      result.set(item.id, {
        viewCount:    Number(s.viewCount ?? 0),
        likeCount:    Number(s.likeCount ?? 0),
        commentCount: Number(s.commentCount ?? 0),
      });
    }
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run test/unit/youtube-corpus-fetcher-statistics.test.js
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/youtube-corpus-fetcher.js test/unit/youtube-corpus-fetcher-statistics.test.js
git commit -m "feat(#1031): fetchStatistics — batch YouTube videos?part=statistics"
```

---

### Task 3: Statistics pass in fetch-videos-job

**Files:**
- Modify: `srv/jobs/fetch-videos-job.js` — add statistics second-pass after existing snippet upsert loop; extend `summary` with `statsUpdated`; extend `summary.errors` counting

**Interfaces:**
- Consumes: `fetchStatistics` from Task 2
- Produces: `summary.statsUpdated: number` — added to job summary; ext.Videos.viewCount/likeCount/commentCount/statsLastFetchedAt written

- [ ] **Step 1: Add `statsUpdated` to the summary shape**

In `srv/jobs/fetch-videos-job.js`, locate the `summary` object initialisation (near line 78). After `errors: 0,` add:

```javascript
    statsUpdated: 0,
```

- [ ] **Step 2: Import `fetchStatistics`**

At the top of `srv/jobs/fetch-videos-job.js`, extend the existing corpus-fetcher import (line ~39):

```javascript
import { fetchSapDevsVideoCorpus, fetchStatistics } from '../lib/youtube-corpus-fetcher.js';
```

- [ ] **Step 3: Add the statistics second pass**

In `srv/jobs/fetch-videos-job.js`, after the extraction loop finishes (after `for (const e of extractQueue) { … }`, near line 379 — but BEFORE the `LOG.info` summary line), insert:

```javascript
  // 9. (#1031) Statistics second pass — batch-refresh viewCount/likeCount/
  //    commentCount for the full corpus so the reshuffle cron has current
  //    signal to rank against. Statistics failures log-warn but do not
  //    abort the cycle — snippet upserts already succeeded above.
  try {
    const allRows = await SELECT.from(Videos).columns('ID', 'youtubeVideoId');
    const ids = allRows.map(r => r.youtubeVideoId).filter(Boolean);
    if (ids.length > 0) {
      const stats = await fetchStatistics({ apiKey, videoIds: ids });
      const statsNow = new Date().toISOString();
      for (const row of allRows) {
        const s = stats.get(row.youtubeVideoId);
        if (!s) continue;
        await UPDATE(Videos)
          .set({
            viewCount:          s.viewCount,
            likeCount:          s.likeCount,
            commentCount:       s.commentCount,
            statsLastFetchedAt: statsNow,
          })
          .where({ ID: row.ID });
        summary.statsUpdated++;
      }
    }
  } catch (err) {
    LOG.warn(`fetch-videos: statistics pass failed: ${err.message}`);
    summary.errors++;
  }
```

- [ ] **Step 4: Run existing fetch-videos tests to confirm no regression**

Run:

```bash
npx vitest run test/unit/fetch-videos-job.test.js 2>&1 | tail -30
```

(If that file does not exist under that name, run `fd fetch-videos test/unit` and use whatever surfaces.) Expected: all existing tests still pass. If any test asserts an exact `summary` shape, extend the assertion to include `statsUpdated: 0` for the mocked-out path.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/fetch-videos-job.js
git commit -m "feat(#1031): fetch-videos-job statistics second pass"
```

---

### Task 4: Reshuffle rotation cron body

**Files:**
- Create: `srv/jobs/reshuffle-video-rotation.js`
- Create: `test/unit/reshuffle-video-rotation.test.js`

**Interfaces:**
- Consumes: `HomepageConfig` (read), `ext.Videos` (read), `HomepageVideoRotation` (write) from Task 1
- Produces: `export async function runReshuffleVideoRotation() → Promise<{ inserted: number, poolSize: number, durationMs: number }>` — safe to call from cron chassis AND from AdminService action

- [ ] **Step 1: Write the failing test**

Create `test/unit/reshuffle-video-rotation.test.js`:

```javascript
// test/unit/reshuffle-video-rotation.test.js
//
// (#1031) Unit tests for the reshuffle-video-rotation cron body.
// Uses an in-memory SQLite backend via cds.test('serve') so the test
// exercises the same CDS QL path as HANA (bounded SELECTs; no LOB columns).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';

const project = path.resolve(__dirname, '../..');
cds.test('serve', '--in-memory', '--project', project);

const NS_EXT = 'com.sap.developers.ims.external';
const NS = 'com.sap.developers.ims';
const HOMEPAGE_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8ae';

async function seedVideo(db, videoId, publishedDaysAgo, viewCount, opts = {}) {
  const publishedAt = new Date(Date.now() - publishedDaysAgo * 86400_000).toISOString();
  await INSERT.into(`${NS_EXT}.Videos`).entries({
    slug: `vd-${videoId}`,
    title: `Video ${videoId}`,
    description: '',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    youtubeVideoId: videoId,
    publishedAt,
    channelTitle: 'SAP Developers',
    thumbnailUrl: '',
    sourceId: videoId,
    contentHash: `hash-${videoId}`,
    viewCount: viewCount,
    likeCount: 0,
    commentCount: 0,
    statsLastFetchedAt: new Date().toISOString(),
    excludeFromHomepage: opts.excluded ?? false,
  });
}

async function seedConfig(db, overrides = {}) {
  await UPSERT.into(`${NS}.HomepageConfig`).entries({
    ID: HOMEPAGE_CONFIG_SINGLETON_ID,
    videoBandEnabled: true,
    videoBandAnchorCount: 3,
    videoBandRotationCount: 3,
    videoBandRotationWindowDays: 90,
    ...overrides,
  });
}

describe('runReshuffleVideoRotation (#1031)', () => {
  let db;
  let runReshuffleVideoRotation;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    ({ runReshuffleVideoRotation } = await import('../../srv/jobs/reshuffle-video-rotation.js'));
  });

  beforeEach(async () => {
    await db.run(DELETE.from(`${NS}.HomepageVideoRotation`));
    await db.run(DELETE.from(`${NS_EXT}.Videos`));
    await db.run(DELETE.from(`${NS}.HomepageConfig`));
    await seedConfig(db);
  });

  it('picks top-N by view velocity (views per day since publishedAt)', async () => {
    await seedVideo(db, 'A', 10, 1000);  // 100/day
    await seedVideo(db, 'B', 10, 500);   // 50/day
    await seedVideo(db, 'C', 10, 5000);  // 500/day  ← top
    await seedVideo(db, 'D', 10, 2000);  // 200/day  ← 2nd
    await seedVideo(db, 'E', 10, 1500);  // 150/day  ← 3rd

    const result = await runReshuffleVideoRotation();
    expect(result.inserted).toBe(3);
    expect(result.poolSize).toBe(5);

    const rows = await SELECT.from(`${NS}.HomepageVideoRotation`)
      .columns('video_ID', 'rank')
      .orderBy({ rank: 'asc' });
    const rankedIds = await Promise.all(rows.map(async (r) => {
      const v = await SELECT.one.from(`${NS_EXT}.Videos`).columns('youtubeVideoId').where({ ID: r.video_ID });
      return v.youtubeVideoId;
    }));
    expect(rankedIds).toEqual(['C', 'D', 'E']);
  });

  it('filters out excludeFromHomepage=true rows', async () => {
    await seedVideo(db, 'X', 10, 999999, { excluded: true });  // huge velocity but excluded
    await seedVideo(db, 'A', 10, 100);
    const result = await runReshuffleVideoRotation();
    expect(result.poolSize).toBe(1);
    const rows = await SELECT.from(`${NS}.HomepageVideoRotation`);
    expect(rows.length).toBe(1);
  });

  it('filters out videos older than videoBandRotationWindowDays', async () => {
    await seedVideo(db, 'OLD', 200, 999999);  // 200 days ago — outside 90d window
    await seedVideo(db, 'NEW', 30, 100);
    const result = await runReshuffleVideoRotation();
    expect(result.poolSize).toBe(1);
  });

  it('deprioritises null-viewCount rows (velocity = 0)', async () => {
    await INSERT.into(`${NS_EXT}.Videos`).entries({
      slug: 'vd-NULL', title: 'no stats', description: '', url: '',
      youtubeVideoId: 'NULL', publishedAt: new Date(Date.now() - 10 * 86400_000).toISOString(),
      channelTitle: 'x', thumbnailUrl: '', sourceId: 'NULL', contentHash: 'h',
      excludeFromHomepage: false,
    });
    await seedVideo(db, 'A', 10, 1);  // 0.1/day — beats NULL's 0
    await seedConfig(db, { videoBandRotationCount: 1 });
    const result = await runReshuffleVideoRotation();
    expect(result.inserted).toBe(1);
    const rows = await SELECT.from(`${NS}.HomepageVideoRotation`);
    const v = await SELECT.one.from(`${NS_EXT}.Videos`).columns('youtubeVideoId').where({ ID: rows[0].video_ID });
    expect(v.youtubeVideoId).toBe('A');
  });

  it('returns { inserted: 0 } when the pool is empty (no crash)', async () => {
    const result = await runReshuffleVideoRotation();
    expect(result.inserted).toBe(0);
    expect(result.poolSize).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run test/unit/reshuffle-video-rotation.test.js
```

Expected: FAIL with `Cannot find module '../../srv/jobs/reshuffle-video-rotation.js'`.

- [ ] **Step 3: Implement `srv/jobs/reshuffle-video-rotation.js`**

Create the file:

```javascript
// srv/jobs/reshuffle-video-rotation.js
//
// (#1031) Every-4h cron: rewrites HomepageVideoRotation with the top-N
// videos by view velocity (views per day since publishedAt) over the
// trailing videoBandRotationWindowDays window.
//
// Runs inside a single cds.tx so a partial write cannot half-populate the
// sidecar: if any statement throws, the transaction ROLLBACKs and the
// previous rotation stays live.
//
// Fail-quiet: on any thrown error, previous rotation continues to serve
// (visitors keep seeing yesterday's picks). Cron chassis records the
// error via runWithLock's finally block.

import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';

const NS_EXT = 'com.sap.developers.ims.external';
const NS = 'com.sap.developers.ims';
const HOMEPAGE_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8ae';
const LOG = cds.log('reshuffle-video-rotation');

/**
 * @returns {Promise<{inserted: number, poolSize: number, durationMs: number}>}
 */
export async function runReshuffleVideoRotation() {
  const startedAt = Date.now();
  const db = cds.db ?? await cds.connect.to('db');

  // 1. Read config knobs; fall back to safe defaults if the config row is missing.
  let rotationCount = 3;
  let windowDays = 90;
  try {
    const cfg = await db.run(
      SELECT.one.from(`${NS}.HomepageConfig`)
        .columns('videoBandRotationCount', 'videoBandRotationWindowDays')
        .where({ ID: HOMEPAGE_CONFIG_SINGLETON_ID })
    );
    if (cfg) {
      if (Number.isFinite(cfg.videoBandRotationCount))       rotationCount = cfg.videoBandRotationCount;
      if (Number.isFinite(cfg.videoBandRotationWindowDays))  windowDays    = cfg.videoBandRotationWindowDays;
    }
  } catch (err) {
    LOG.warn(`config read failed; using defaults: ${err.message}`);
  }

  // 2. Candidate pool — bounded by window + exclude flag.
  const windowCutoff = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const pool = await db.run(
    SELECT.from(`${NS_EXT}.Videos`)
      .columns('ID', 'publishedAt', 'viewCount')
      .where({ excludeFromHomepage: false, publishedAt: { '>=': windowCutoff } })
  );
  metrics.gauge('homepage.videos.rotation.pool_size', pool.length);

  // 3. Rank by velocity.
  const now = Date.now();
  const ranked = pool
    .map(r => {
      const publishedMs = new Date(r.publishedAt).getTime();
      const daysSince = Math.max(1, (now - publishedMs) / 86400_000);
      const velocity = (Number(r.viewCount) || 0) / daysSince;
      return { id: r.ID, velocity };
    })
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, rotationCount);

  // 4. Single transaction: DELETE all + INSERT new rows.
  try {
    await cds.tx(async (tx) => {
      await tx.run(DELETE.from(`${NS}.HomepageVideoRotation`));
      if (ranked.length > 0) {
        await tx.run(INSERT.into(`${NS}.HomepageVideoRotation`).entries(
          ranked.map((r, idx) => ({ video_ID: r.id, rank: idx + 1 }))
        ));
      }
    });
  } catch (err) {
    LOG.error(`reshuffle transaction failed; rotation unchanged: ${err.message}`);
    metrics.counter('homepage.videos.rotation.reshuffle[result=error]');
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  metrics.observe('homepage.videos.rotation.duration_ms', durationMs);
  metrics.counter('homepage.videos.rotation.reshuffle[result=ok]');
  LOG.info(`reshuffle: inserted=${ranked.length} pool=${pool.length} ms=${durationMs}`);
  return { inserted: ranked.length, poolSize: pool.length, durationMs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run test/unit/reshuffle-video-rotation.test.js
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/reshuffle-video-rotation.js test/unit/reshuffle-video-rotation.test.js
git commit -m "feat(#1031): reshuffle-video-rotation cron body + unit tests"
```

---

### Task 5: Register the reshuffle cron

**Files:**
- Modify: `srv/jobs/scheduler.js` — one `registerJob(...)` call

**Interfaces:**
- Consumes: `runReshuffleVideoRotation` from Task 4
- Produces: registered `reshuffle-video-rotation` cron running `19 */4 * * *`; visible on the admin `#board` cron-health tile via existing chassis

- [ ] **Step 1: Add the `registerJob` call**

In `srv/jobs/scheduler.js`, locate the `homepage-link-health` registration block (around line 899). Immediately after that block's closing `});`, insert:

```javascript
  // (#1031) Every 4h at :19 past — reshuffle HomepageVideoRotation with the
  // top-N videos by view velocity. Off-minute (:19) avoids the 03:11 fetch-videos,
  // 03:57 kg-communities, 04:00 homepage-link-health, 04:07 kg-wcc, and 04:13
  // kg-featured-topics slots. Lazy-import matches the fetch-videos pattern above
  // and keeps boot fast.
  registerJob({
    jobName: 'reshuffle-video-rotation',
    schedule: '19 */4 * * *',
    ttlMs: 5 * 60 * 1000,
    description: 'Reshuffle homepage video rotation (top-N by view velocity, every 4h)',
    fn: async () => {
      const { runReshuffleVideoRotation } = await import('./reshuffle-video-rotation.js');
      return runReshuffleVideoRotation();
    },
  });
```

- [ ] **Step 2: Verify boot-time registration**

Run:

```bash
npx cds run --in-memory 2>&1 | grep -E "reshuffle-video-rotation|CronService wired" | head -5
```

Expected output includes `CronService wired NN scheduled jobs` where NN is one higher than before, AND no `Duplicate jobName` error surfaces.

- [ ] **Step 3: Commit**

```bash
git add srv/jobs/scheduler.js
git commit -m "feat(#1031): register reshuffle-video-rotation cron (19 */4 * * *)"
```

---

### Task 6: HomepageService `videos()` — merge anchors + rotation + emit `kind`

**Files:**
- Modify: `srv/homepage-service.js` — rewrite the `this.on('videos', ...)` handler (starting at line 147)
- Modify: `test/unit/homepage-service-endpoints.test.js` — extend tests

**Interfaces:**
- Consumes: `HomepageConfig` (Task 1 fields), `ext.Videos` (Task 1 statistics + `excludeFromHomepage`), `HomepageVideoRotation` (Task 1)
- Produces: `GET /homepage/videos` response shape — `{ featured: object|null, recent: Array<{ videoId, title, thumbnail, publishedAt, kind: 'anchor' | 'popular' }>, error: string|null }`

- [ ] **Step 1: Write failing tests**

Add to `test/unit/homepage-service-endpoints.test.js` (near any existing `videos()` describe). If none exist yet, add a new `describe` block that follows the existing suite's setup pattern (in-memory SQLite via `cds.test`):

```javascript
describe('/homepage/videos merges anchors + rotation (#1031)', () => {
  const NS_EXT = 'com.sap.developers.ims.external';
  const NS = 'com.sap.developers.ims';
  const HOMEPAGE_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8ae';

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    await db.run(DELETE.from(`${NS}.HomepageVideoRotation`));
    await db.run(DELETE.from(`${NS_EXT}.Videos`));
    await db.run(DELETE.from(`${NS}.HomepageConfig`));
    await UPSERT.into(`${NS}.HomepageConfig`).entries({
      ID: HOMEPAGE_CONFIG_SINGLETON_ID,
      videoBandEnabled: true,
      videoBandAnchorCount: 3,
      videoBandRotationCount: 3,
    });
  });

  async function seed(videoId, daysAgo) {
    await INSERT.into(`${NS_EXT}.Videos`).entries({
      slug: `vd-${videoId}`, title: `V-${videoId}`, description: '',
      url: '', youtubeVideoId: videoId,
      publishedAt: new Date(Date.now() - daysAgo * 86400_000).toISOString(),
      channelTitle: 'SAP Developers', thumbnailUrl: `https://y/${videoId}.jpg`,
      sourceId: videoId, contentHash: `h-${videoId}`, viewCount: 0,
      excludeFromHomepage: false,
    });
    return SELECT.one.from(`${NS_EXT}.Videos`).columns('ID').where({ youtubeVideoId: videoId });
  }

  it('returns anchors tagged kind=anchor and rotation tagged kind=popular', async () => {
    await seed('newest1', 1);
    await seed('newest2', 2);
    await seed('newest3', 3);
    const pop1 = await seed('pop1', 30);
    const pop2 = await seed('pop2', 60);
    await INSERT.into(`${NS}.HomepageVideoRotation`).entries([
      { video_ID: pop1.ID, rank: 1 },
      { video_ID: pop2.ID, rank: 2 },
    ]);

    const srv = await cds.connect.to('HomepageService');
    const res = await srv.send('videos');
    const anchors = res.recent.filter(r => r.kind === 'anchor');
    const populars = res.recent.filter(r => r.kind === 'popular');
    expect(anchors.map(a => a.videoId)).toEqual(['newest1', 'newest2', 'newest3']);
    expect(populars.map(p => p.videoId)).toEqual(['pop1', 'pop2']);
  });

  it('dedupes rotation entries that are already in anchors', async () => {
    const a = await seed('shared', 1);
    await seed('newest2', 2);
    await seed('newest3', 3);
    await INSERT.into(`${NS}.HomepageVideoRotation`).entries([
      { video_ID: a.ID, rank: 1 },
    ]);

    const srv = await cds.connect.to('HomepageService');
    const res = await srv.send('videos');
    const ids = res.recent.map(r => r.videoId);
    expect(new Set(ids).size).toBe(ids.length);       // no dupes
    expect(ids.filter(x => x === 'shared')).toHaveLength(1);
    expect(res.recent.find(r => r.videoId === 'shared').kind).toBe('anchor');
  });

  it('honors excludeFromHomepage on both anchors and rotation', async () => {
    const db = await cds.connect.to('db');
    const excluded = await seed('excluded', 1);
    await db.run(UPDATE(`${NS_EXT}.Videos`).set({ excludeFromHomepage: true }).where({ ID: excluded.ID }));
    await seed('keep1', 5);

    const srv = await cds.connect.to('HomepageService');
    const res = await srv.send('videos');
    expect(res.recent.find(r => r.videoId === 'excluded')).toBeUndefined();
  });

  it('when videoBandRotationCount = 0, returns anchors only', async () => {
    const db = await cds.connect.to('db');
    await db.run(UPDATE(`${NS}.HomepageConfig`).set({ videoBandRotationCount: 0 })
      .where({ ID: HOMEPAGE_CONFIG_SINGLETON_ID }));
    await seed('a', 1);
    const pop = await seed('p', 30);
    await INSERT.into(`${NS}.HomepageVideoRotation`).entries([{ video_ID: pop.ID, rank: 1 }]);

    const srv = await cds.connect.to('HomepageService');
    const res = await srv.send('videos');
    expect(res.recent.map(r => r.videoId)).toEqual(['a']);
    expect(res.recent.every(r => r.kind === 'anchor')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run test/unit/homepage-service-endpoints.test.js -t "#1031"
```

Expected: 4 failed (kind field undefined, rotation not merged, etc.).

- [ ] **Step 3: Rewrite the `videos()` handler**

In `srv/homepage-service.js`, replace the entire `this.on('videos', async () => { … });` block (starting around line 147, ending around line 212) with:

```javascript
    // (#1031, extends #639/#1007) videos() — merges three sources into a single
    // {featured, recent, error} payload.
    //
    //   - featured  ← YouTube playlist (developerNewsPlaylistId), unchanged.
    //   - recent    ← [anchors from ext.Videos ORDER BY publishedAt DESC,
    //                   popular from HomepageVideoRotation ORDER BY rank ASC],
    //                 deduped by youtubeVideoId, each tagged kind: 'anchor'|'popular'.
    //   - fallback  ← if the DB path yields zero rows AND fetchSapDevsVideos gave
    //                 us live.recent, wrap those as kind:'anchor' (preserves the
    //                 #1007 pre-rotation behavior — never a 500).
    this.on('videos', async () => {
      let cfg;
      try {
        const db = await cds.connect.to('db');
        cfg = await db.run(
          SELECT.one.from('com.sap.developers.ims.HomepageConfig')
            .where({ ID: HOMEPAGE_CONFIG_SINGLETON_ID })
        );
      } catch (err) {
        log.warn('[videos] HomepageConfig read failed:', err.message);
      }

      if (cfg?.videoBandEnabled === false) {
        return { featured: null, recent: [], error: 'disabled' };
      }

      const anchorCount   = Number.isFinite(cfg?.videoBandAnchorCount)   ? cfg.videoBandAnchorCount   : 3;
      const rotationCount = Number.isFinite(cfg?.videoBandRotationCount) ? cfg.videoBandRotationCount : 3;

      const apiKey = await resolveSecret('YOUTUBE_API_KEY', { logTag: '[homepage-service/videos]' });
      const live = await fetchSapDevsVideos({
        apiKey: apiKey || '',
        playlistId: cfg?.developerNewsPlaylistId || '',
        channelHandle: '@sapdevs',
      });

      // Anchors from ext.Videos.
      let anchors = [];
      try {
        const db = await cds.connect.to('db');
        const { Videos } = cds.entities('com.sap.developers.ims.external');
        anchors = await db.run(
          SELECT.from(Videos)
            .columns('youtubeVideoId', 'title', 'thumbnailUrl', 'publishedAt')
            .where({ excludeFromHomepage: false })
            .orderBy({ publishedAt: 'desc' })
            .limit(anchorCount)
        );
      } catch (err) {
        metrics.counter('homepage.videos.anchors[result=error]');
        log.warn('[videos] anchors SELECT failed:', err.message);
      }

      // Rotation from HomepageVideoRotation (skip when rotationCount = 0).
      let rotation = [];
      if (rotationCount > 0) {
        try {
          const db = await cds.connect.to('db');
          rotation = await db.run(
            SELECT.from('com.sap.developers.ims.HomepageVideoRotation as r')
              .join('com.sap.developers.ims.external.Videos as v').on('r.video_ID = v.ID')
              .columns(
                'v.youtubeVideoId as youtubeVideoId',
                'v.title as title',
                'v.thumbnailUrl as thumbnailUrl',
                'v.publishedAt as publishedAt',
                'r.rank as rank',
              )
              .where({ 'v.excludeFromHomepage': false })
              .orderBy({ 'r.rank': 'asc' })
              .limit(rotationCount)
          );
        } catch (err) {
          metrics.counter('homepage.videos.rotation.read[result=error]');
          log.warn('[videos] rotation SELECT failed:', err.message);
        }
      }

      const toItem = (r, kind) => ({
        videoId:     r.youtubeVideoId,
        title:       r.title,
        thumbnail:   r.thumbnailUrl,
        publishedAt: r.publishedAt,
        kind,
      });

      const anchorIds = new Set(anchors.map(a => a.youtubeVideoId));
      const rotationDeduped = rotation.filter(r => !anchorIds.has(r.youtubeVideoId));
      let recent = [
        ...anchors.map(a => toItem(a, 'anchor')),
        ...rotationDeduped.map(r => toItem(r, 'popular')),
      ];

      // #1007 fallback — never a 500 when the DB path is dry.
      if (recent.length === 0 && (live.recent?.length ?? 0) > 0) {
        metrics.counter('homepage.videos.fallback[result=hit]');
        recent = live.recent.map(r => ({ ...r, kind: 'anchor' }));
      } else if (recent.length === 0) {
        metrics.counter('homepage.videos.fallback[result=empty]');
      }

      const featured = live.featured ?? recent[0] ?? null;
      return { featured, recent, error: live.error ?? null };
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run test/unit/homepage-service-endpoints.test.js -t "#1031"
```

Expected: 4 passed. Then re-run the full file to catch any pre-existing videos-test regression:

```bash
npx vitest run test/unit/homepage-service-endpoints.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add srv/homepage-service.js test/unit/homepage-service-endpoints.test.js
git commit -m "feat(#1031): /homepage/videos merges anchors + rotation with kind tag"
```

---

### Task 7: VideoBand.vue — render 6 tiles + Popular chip

**Files:**
- Modify: `hugo-apps/src/homepage-bands/VideoBand.vue`
- Modify: `hugo-apps/src/homepage-bands/VideoBand.test.ts`

**Interfaces:**
- Consumes: `/homepage/videos` response shape from Task 6 (`recent[].kind`)
- Produces: renders one card per `recent` entry (no `slice(0, 3)` cap); adds `<span class="hb-video-band__chip">Popular</span>` inside `.hb-video-band__recent-card` when `kind === 'popular'`

- [ ] **Step 1: Write failing tests**

Extend `hugo-apps/src/homepage-bands/VideoBand.test.ts` with new tests appended before the final `});`:

```typescript
  it('renders 6 tiles when the server returns anchors + rotation with kind field', async () => {
    const payload = {
      featured: { videoId: 'f', title: 'Feat', thumbnail: 'https://yt/f.jpg', publishedAt: '2026-07-06T00:00:00Z' },
      recent: [
        { videoId: 'a1', title: 'Anchor 1', thumbnail: 'https://yt/a1.jpg', publishedAt: '2026-07-05T00:00:00Z', kind: 'anchor' },
        { videoId: 'a2', title: 'Anchor 2', thumbnail: 'https://yt/a2.jpg', publishedAt: '2026-07-04T00:00:00Z', kind: 'anchor' },
        { videoId: 'a3', title: 'Anchor 3', thumbnail: 'https://yt/a3.jpg', publishedAt: '2026-07-03T00:00:00Z', kind: 'anchor' },
        { videoId: 'p1', title: 'Popular 1', thumbnail: 'https://yt/p1.jpg', publishedAt: '2026-05-01T00:00:00Z', kind: 'popular' },
        { videoId: 'p2', title: 'Popular 2', thumbnail: 'https://yt/p2.jpg', publishedAt: '2026-04-01T00:00:00Z', kind: 'popular' },
        { videoId: 'p3', title: 'Popular 3', thumbnail: 'https://yt/p3.jpg', publishedAt: '2026-03-01T00:00:00Z', kind: 'popular' },
      ],
      error: null,
    };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));

    const wrapper = mount(VideoBand, { attachTo: document.body });
    for (let i = 0; i < 6; i++) await flushPromises();
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    const cards = wrapper.findAll('a.hb-video-band__recent-card');
    expect(cards).toHaveLength(6);
    // Only rotation cards carry the Popular chip.
    const chips = wrapper.findAll('.hb-video-band__chip');
    expect(chips).toHaveLength(3);
    for (const chip of chips) expect(chip.text()).toBe('Popular');
    // First 3 cards must NOT have a chip.
    for (let i = 0; i < 3; i++) {
      expect(cards[i].find('.hb-video-band__chip').exists()).toBe(false);
    }
    wrapper.unmount();
  });

  it('renders anchor-only when server returns rotation of length 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      featured: null,
      recent: [
        { videoId: 'a1', title: 'Only anchor', thumbnail: '', publishedAt: '2026-07-05T00:00:00Z', kind: 'anchor' },
      ],
      error: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const wrapper = mount(VideoBand, { attachTo: document.body });
    for (let i = 0; i < 6; i++) await flushPromises();
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('a.hb-video-band__recent-card')).toHaveLength(1);
    expect(wrapper.find('.hb-video-band__chip').exists()).toBe(false);
    wrapper.unmount();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd hugo-apps && npx vitest run src/homepage-bands/VideoBand.test.ts
```

Expected: 2 new tests fail (only 3 cards render because of `.slice(0, 3)`; no `.hb-video-band__chip` element exists).

- [ ] **Step 3: Update VideoBand.vue script + template**

In `hugo-apps/src/homepage-bands/VideoBand.vue`:

**Script section** — replace the interface + the `recentSlice` computed:

```typescript
interface VideoItem {
  videoId: string;
  title: string;
  thumbnail?: string;
  publishedAt?: string;
  tags?: string[];
  kind?: 'anchor' | 'popular';
}
```

Delete the line `const recentSlice = computed(() => recent.value.slice(0, 3));`.

**Template section** — replace the recent stack render block (`<div v-if="recentSlice.length" class="hb-video-band__stack">…</div>`) with:

```html
      <!-- Recent stack (right column) — anchors + rotation, up to N tiles -->
      <div v-if="recent.length" class="hb-video-band__stack">
        <a
          v-for="(vid, idx) in recent"
          :key="idx"
          :href="watchUrl(vid.videoId)"
          target="_blank"
          rel="noopener noreferrer"
          class="hb-video-band__recent-card"
          :aria-label="'Watch: ' + vid.title"
        >
          <span
            v-if="vid.kind === 'popular'"
            class="hb-video-band__chip"
            aria-label="Popular video"
          >Popular</span>
          <img
            :src="thumbUrl(vid)"
            :alt="vid.title"
            class="hb-video-band__recent-thumb"
            loading="lazy"
          />
          <p class="hb-video-band__recent-title">{{ vid.title }}</p>
        </a>
      </div>
```

Also remove the now-unused `computed` import from the top-of-file `import { ref, computed, onMounted } from 'vue';` — leave `import { ref, onMounted } from 'vue';`.

**Style section** — inside `<style scoped>`, locate `.hb-video-band__recent-card { … }` and add `position: relative;` at the top of the block. Then, immediately after the `.hb-video-band__recent-title { … }` rule, add:

```css
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
  line-height: 1.2;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd hugo-apps && npx vitest run src/homepage-bands/VideoBand.test.ts
```

Expected: all pass (existing 3 tests + 2 new tests).

- [ ] **Step 5: Rebuild the compiled Vue island bundle**

Run:

```bash
cd hugo-apps && npm run build
```

This regenerates `hugo/static/js/homepage-bands.js` (the file `hugo/public/js/homepage-bands.js` will be freshened during a full `npm run build:all` — do NOT hand-edit either).

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/homepage-bands/VideoBand.vue hugo-apps/src/homepage-bands/VideoBand.test.ts hugo/static/js/homepage-bands.js
git commit -m "feat(#1031): VideoBand renders up to N tiles with Popular chip"
```

---

### Task 8: AdminService — Videos projection + recompute action

**Files:**
- Modify: `srv/admin-service.cds`
- Modify: `srv/admin-service.js`

**Interfaces:**
- Consumes: `runReshuffleVideoRotation` from Task 4; `Videos` + `HomepageVideoRotation` from Task 1
- Produces:
  - `AdminService.Videos` — editable projection on `ext.Videos` limited to `excludeFromHomepage` (all other columns read-only via annotations in Task 9)
  - `AdminService.HomepageVideoRotationView` — read-only projection on `HomepageVideoRotation`
  - `AdminService.recomputeHomepageVideoRotation()` action — SuperAdmin-gated

- [ ] **Step 1: Extend `srv/admin-service.cds`**

At the end of `srv/admin-service.cds` (after the FeaturedTopics section that closes with `action recomputeFeaturedTopics()`), append:

```cds
// (#1031) Homepage video band admin surfaces.
// - Videos: editable projection on ext.Videos (only `excludeFromHomepage` is
//   admin-writable; other columns read-only via app/admin-annotations.cds).
// - HomepageVideoRotationView: read-only join over the sidecar for the
//   "what's in rotation now" viewer at /admin-ui/#video-rotation.
// - recomputeHomepageVideoRotation: SuperAdmin manual trigger; runs the same
//   body as the 4h cron. Precedent: recomputeFeaturedTopics (#1032).
extend service AdminService with {
  @odata.draft.enabled
  @requires: 'Admin'
  entity Videos as projection on external.Videos;

  @readonly
  @requires: 'Admin'
  entity HomepageVideoRotationView as projection on ims.HomepageVideoRotation;

  @requires: 'SuperAdmin'
  action recomputeHomepageVideoRotation() returns {
    inserted   : Integer;
    poolSize   : Integer;
    durationMs : Integer;
  };
}
```

You will likely need to add `using { com.sap.developers.ims.external } from '../db/external-content';` near the existing `using` statements at the top of `srv/admin-service.cds` — check the file's existing pattern. Use the same alias other admin-service entries use (e.g. `external.Videos` if `using ... as external` is already present).

- [ ] **Step 2: Wire the action handler in `srv/admin-service.js`**

Import at the top of `srv/admin-service.js` (near the other `srv/lib` imports around line 30):

```javascript
import { runReshuffleVideoRotation } from './jobs/reshuffle-video-rotation.js';
```

Locate the `recomputeFeaturedTopics` handler (around line 2869). Immediately after its closing `});`, add:

```javascript
    // (#1031) recomputeHomepageVideoRotation — SuperAdmin manual trigger.
    // Same code path as the 4h cron; used for the DEV cutover to populate
    // HomepageVideoRotation immediately without waiting for the next tick.
    this.on('recomputeHomepageVideoRotation', async () => {
      return runReshuffleVideoRotation();
    });
```

- [ ] **Step 3: Verify compile + admin surface**

Run:

```bash
npx cds compile srv/ -2 sql > /dev/null && echo COMPILE_OK
npx cds deploy --to sqlite::memory: > /dev/null && echo DEPLOY_OK
```

Expected: both OK. Then run any existing admin-service unit tests to catch cross-cutting regressions:

```bash
npx vitest run test/unit/admin-service.test.js 2>&1 | tail -20
```

Expected: no new failures.

- [ ] **Step 4: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js
git commit -m "feat(#1031): AdminService.Videos + HomepageVideoRotation + recompute action"
```

---

### Task 9: Fiori annotations + admin-shell wiring for Videos + Video Rotation

**Files:**
- Modify: `app/admin-annotations.cds`
- Create: `app/admin/videos/webapp/manifest.json`, `Component.js`, `i18n/i18n.properties`
- Create: `app/admin/video-rotation/webapp/manifest.json`, `Component.js`, `i18n/i18n.properties`
- Modify: `app/admin-shell/webapp/manifest.json`
- Modify: `app/admin-shell/webapp/model/navigation.json`
- Modify: `app/admin-shell/webapp/controller/Shell.controller.js`

**Interfaces:**
- Consumes: `AdminService.Videos`, `AdminService.HomepageVideoRotationView`, `AdminService.recomputeHomepageVideoRotation` from Task 8
- Produces: `/admin-ui/#videos` list report (editable `excludeFromHomepage` + toolbar action); `/admin-ui/#video-rotation` read-only viewer

- [ ] **Step 1: Add Fiori annotations for Videos**

At the end of `app/admin-annotations.cds`, append:

```cds
// --- (#1031) Videos + HomepageVideoRotation admin surfaces ---
// Videos: single-column editability (excludeFromHomepage) with statistics
// columns visible read-only. Toolbar surfaces recomputeHomepageVideoRotation
// (SuperAdmin-gated by the CDS annotation on the action itself).

annotate AdminService.Videos with @(
  UI.HeaderInfo: {
    TypeName: 'Video',
    TypeNamePlural: 'Videos',
    Title: { Value: title }
  },
  UI.LineItem: [
    { Value: title,               Label: 'Title' },
    { Value: channelTitle,        Label: 'Channel' },
    { Value: publishedAt,         Label: 'Published' },
    { Value: viewCount,           Label: 'Views' },
    { Value: likeCount,           Label: 'Likes' },
    { Value: excludeFromHomepage, Label: 'Excluded' },
    { $Type: 'UI.DataFieldForAction',
      Action: 'AdminService.recomputeHomepageVideoRotation',
      Label: 'Recompute rotation' },
  ],
  UI.SelectionFields: [ excludeFromHomepage ],
  UI.FieldGroup #Main: { Data: [
    { Value: title,               Label: 'Title' },
    { Value: channelTitle,        Label: 'Channel' },
    { Value: publishedAt,         Label: 'Published' },
    { Value: viewCount,           Label: 'View count' },
    { Value: likeCount,           Label: 'Like count' },
    { Value: commentCount,        Label: 'Comment count' },
    { Value: statsLastFetchedAt,  Label: 'Stats last refreshed' },
    { Value: excludeFromHomepage, Label: 'Exclude from homepage' },
  ]},
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Main', Label: 'Details' },
  ],
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.DeleteRestrictions.Deletable : false
);

annotate AdminService.Videos with {
  title              @Common.FieldControl: #ReadOnly;
  channelTitle       @Common.FieldControl: #ReadOnly;
  publishedAt        @Common.FieldControl: #ReadOnly;
  viewCount          @Common.FieldControl: #ReadOnly;
  likeCount          @Common.FieldControl: #ReadOnly;
  commentCount       @Common.FieldControl: #ReadOnly;
  statsLastFetchedAt @Common.FieldControl: #ReadOnly;
};

annotate AdminService.HomepageVideoRotationView with @(
  UI.HeaderInfo: {
    TypeName: 'Rotation slot',
    TypeNamePlural: 'Rotation slots'
  },
  UI.LineItem: [
    { Value: rank,     Label: 'Rank' },
    { Value: video_ID, Label: 'Video' },
    { Value: pickedAt, Label: 'Picked at' },
  ],
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable : false,
  Capabilities.DeleteRestrictions.Deletable : false
);
```

Also add the three HomepageConfig fields to whatever field-group already annotates `AdminService.HomepageConfig` (search `app/admin-annotations.cds` for `HomepageConfig`). Add three lines to the Main field group:

```cds
    { Value: videoBandAnchorCount,        Label: 'Video band anchor slots' },
    { Value: videoBandRotationCount,      Label: 'Video band rotation slots' },
    { Value: videoBandRotationWindowDays, Label: 'Rotation window (days)' },
```

- [ ] **Step 2: Create `app/admin/videos/webapp/`**

Create `app/admin/videos/webapp/manifest.json`:

```json
{
  "_version": "1.65.0",
  "sap.app": {
    "id": "sap.tutorials.admin.videos",
    "type": "application",
    "title": "{{appTitle}}",
    "description": "{{appDescription}}",
    "applicationVersion": { "version": "0.0.1" },
    "i18n": "i18n/i18n.properties",
    "dataSources": {
      "mainService": {
        "uri": "/admin/",
        "type": "OData",
        "settings": { "odataVersion": "4.0" }
      }
    },
    "crossNavigation": {
      "inbounds": {
        "Videos-manage": {
          "semanticObject": "Videos",
          "action": "manage",
          "title": "{{appTitle}}",
          "signature": { "parameters": {}, "additionalParameters": "allowed" }
        }
      }
    }
  },
  "sap.ui5": {
    "dependencies": {
      "minUI5Version": "1.136.0",
      "libs": { "sap.fe.templates": {} }
    },
    "models": {
      "": {
        "dataSource": "mainService",
        "preload": true,
        "settings": {
          "synchronizationMode": "None",
          "operationMode": "Server",
          "autoExpandSelect": true,
          "earlyRequests": true
        }
      },
      "i18n": {
        "type": "sap.ui.model.resource.ResourceModel",
        "settings": { "bundleName": "sap.tutorials.admin.videos.i18n.i18n" }
      }
    },
    "routing": {
      "routes": [
        { "name": "VideosList", "pattern": ":?query:", "target": "VideosListTarget" },
        { "name": "VideosOP",   "pattern": "Videos({key}):?query:", "target": "VideosOPTarget" }
      ],
      "targets": {
        "VideosListTarget": {
          "type": "Component",
          "name": "sap.fe.templates.ListReport",
          "id": "VideosListTarget",
          "options": {
            "settings": {
              "contextPath": "/Videos",
              "variantManagement": "Page",
              "initialLoad": "Enabled",
              "navigation": {
                "Videos": { "detail": { "route": "VideosOP" } }
              }
            }
          }
        },
        "VideosOPTarget": {
          "type": "Component",
          "name": "sap.fe.templates.ObjectPage",
          "id": "VideosOPTarget",
          "options": {
            "settings": {
              "contextPath": "/Videos",
              "editableHeaderContent": false
            }
          }
        }
      }
    }
  }
}
```

Create `app/admin/videos/webapp/Component.js`:

```javascript
sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.videos.Component", {
    metadata: { manifest: "json" }
  });
});
```

Create `app/admin/videos/webapp/i18n/i18n.properties`:

```properties
#XTIT: Application title (admin tile, browser tab)
appTitle=Videos

#YDES: Application description
appDescription=SAP Developers YouTube corpus. Toggle exclusion from the homepage video band.
```

- [ ] **Step 3: Create `app/admin/video-rotation/webapp/`**

Same three-file pattern. `manifest.json`:

```json
{
  "_version": "1.65.0",
  "sap.app": {
    "id": "sap.tutorials.admin.videoRotation",
    "type": "application",
    "title": "{{appTitle}}",
    "description": "{{appDescription}}",
    "applicationVersion": { "version": "0.0.1" },
    "i18n": "i18n/i18n.properties",
    "dataSources": {
      "mainService": {
        "uri": "/admin/",
        "type": "OData",
        "settings": { "odataVersion": "4.0" }
      }
    },
    "crossNavigation": {
      "inbounds": {
        "VideoRotation-manage": {
          "semanticObject": "VideoRotation",
          "action": "manage",
          "title": "{{appTitle}}",
          "signature": { "parameters": {}, "additionalParameters": "allowed" }
        }
      }
    }
  },
  "sap.ui5": {
    "dependencies": {
      "minUI5Version": "1.136.0",
      "libs": { "sap.fe.templates": {} }
    },
    "models": {
      "": {
        "dataSource": "mainService",
        "preload": true,
        "settings": {
          "synchronizationMode": "None",
          "operationMode": "Server",
          "autoExpandSelect": true,
          "earlyRequests": true
        }
      },
      "i18n": {
        "type": "sap.ui.model.resource.ResourceModel",
        "settings": { "bundleName": "sap.tutorials.admin.videoRotation.i18n.i18n" }
      }
    },
    "routing": {
      "routes": [
        { "name": "VideoRotationList", "pattern": ":?query:", "target": "VideoRotationListTarget" }
      ],
      "targets": {
        "VideoRotationListTarget": {
          "type": "Component",
          "name": "sap.fe.templates.ListReport",
          "id": "VideoRotationListTarget",
          "options": {
            "settings": {
              "contextPath": "/HomepageVideoRotationView",
              "variantManagement": "Page",
              "initialLoad": "Enabled"
            }
          }
        }
      }
    }
  }
}
```

`Component.js`:

```javascript
sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.videoRotation.Component", {
    metadata: { manifest: "json" }
  });
});
```

`i18n/i18n.properties`:

```properties
#XTIT: Application title (admin tile, browser tab)
appTitle=Video Rotation

#YDES: Application description
appDescription=Read-only view of the current homepage video band rotation slots (top-N by view velocity).
```

- [ ] **Step 4: Register both apps in the admin shell**

In `app/admin-shell/webapp/manifest.json`, locate the `componentUsages` block (around line 285). After the `featuredTopicsComponent` entry, add:

```json
      ,
      "videosComponent": {
        "name": "sap.tutorials.admin.videos",
        "settings": {},
        "componentData": {},
        "lazy": true
      },
      "videoRotationComponent": {
        "name": "sap.tutorials.admin.videoRotation",
        "settings": {},
        "componentData": {},
        "lazy": true
      }
```

(Or omit the leading comma if the block already ends with one — match existing punctuation.)

In the same file, locate the `routing.routes` block (around line 364). After the `featuredTopics` route entry, add:

```json
        { "name": "videos",         "pattern": "videos",         "target": [{"name": "videosTarget",         "prefix": "vd"}] },
        { "name": "videoRotation",  "pattern": "video-rotation", "target": [{"name": "videoRotationTarget",  "prefix": "vr"}] },
```

Then in `routing.targets` (around line 598), after `featuredTopicsTarget`, add:

```json
        "videosTarget": {
          "type": "Component",
          "usage": "videosComponent",
          "id": "videosTarget",
          "viewLevel": 1,
          "prefix": "vd"
        },
        "videoRotationTarget": {
          "type": "Component",
          "usage": "videoRotationComponent",
          "id": "videoRotationTarget",
          "viewLevel": 1,
          "prefix": "vr"
        },
```

- [ ] **Step 5: Add navigation entries**

In `app/admin-shell/webapp/model/navigation.json`, extend the `homepageGroup` items array (around line 32). Append `videos` and `videoRotation` inside the same `items` array:

```json
        { "key": "videos",            "title": "Videos" },
        { "key": "videoRotation",     "title": "Video Rotation" }
```

- [ ] **Step 6: Extend `Shell.controller.js` maps**

In `app/admin-shell/webapp/controller/Shell.controller.js`, add to `NAV_KEY_TO_ROUTE` (around line 9):

```javascript
    videos: "videos",
    videoRotation: "videoRotation",
```

And to `NAV_KEY_TO_TITLE` (around line 55):

```javascript
    videos: "Videos",
    videoRotation: "Video Rotation",
```

- [ ] **Step 7: Verify admin shell still builds**

Run:

```bash
cd app/admin-shell && npm run build 2>&1 | tail -5
```

Expected: build succeeds (no missing-manifest errors).

- [ ] **Step 8: Commit**

```bash
git add app/admin-annotations.cds app/admin/videos/ app/admin/video-rotation/ app/admin-shell/webapp/manifest.json app/admin-shell/webapp/model/navigation.json app/admin-shell/webapp/controller/Shell.controller.js
git commit -m "feat(#1031): admin Videos + Video Rotation Fiori surfaces"
```

---

### Task 10: Hybrid smoke + deployed-endpoint smoke

**Files:**
- Create: `test/hybrid/homepage-videos-1031.test.js`
- Modify: `test/smoke/homepage.smoke.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8 running against real HANA (hybrid) or a deployed URL (smoke)
- Produces: two additional test suites

- [ ] **Step 1: Write the hybrid test**

Create `test/hybrid/homepage-videos-1031.test.js`:

```javascript
// test/hybrid/homepage-videos-1031.test.js
//
// (#1031) Hybrid smoke — runs against real HANA via `cds bind --exec`.
// Verifies the reshuffle cron writes rows against HANA and the merged
// endpoint returns items with the `kind` field.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const NS = 'com.sap.developers.ims';
const NS_EXT = 'com.sap.developers.ims.external';
const TEST_TAG = '__TEST__1031_';

describe.runIf(isSafeForWrites())('Homepage video band on HANA (#1031)', () => {
  let db;
  let seededVideoId;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    // Seed one exclusion-safe video the reshuffle will pick up regardless
    // of what's in the real Videos table.
    seededVideoId = `${TEST_TAG}${Date.now()}`;
    await db.run(INSERT.into(`${NS_EXT}.Videos`).entries({
      slug: `vd-${seededVideoId}`,
      title: `${TEST_TAG}fake title`,
      description: '', url: '',
      youtubeVideoId: seededVideoId,
      publishedAt: new Date(Date.now() - 30 * 86400_000).toISOString(),
      channelTitle: 'test',
      thumbnailUrl: '',
      sourceId: seededVideoId,
      contentHash: `h-${seededVideoId}`,
      viewCount: 999999999,
      likeCount: 0,
      commentCount: 0,
      excludeFromHomepage: false,
    }));
  });

  afterAll(async () => {
    await db.run(DELETE.from(`${NS_EXT}.Videos`).where("slug LIKE '" + `vd-${TEST_TAG}` + "%'"));
  });

  it('reshuffle cron writes rows and endpoint tags them kind=popular', async () => {
    const { runReshuffleVideoRotation } = await import('../../srv/jobs/reshuffle-video-rotation.js');
    const result = await runReshuffleVideoRotation();
    expect(result.inserted).toBeGreaterThanOrEqual(1);

    const rows = await SELECT.from(`${NS}.HomepageVideoRotation`);
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const homepage = await cds.connect.to('HomepageService');
    const res = await homepage.send('videos');
    for (const item of res.recent) {
      expect(['anchor', 'popular']).toContain(item.kind);
    }
  });
});
```

- [ ] **Step 2: Extend the smoke test**

In `test/smoke/homepage.smoke.test.ts`, locate any existing describe that hits `/homepage/videos` (search for `homepage/videos`). If none exists, append a new describe near the end of the file:

```typescript
describe.skipIf(!BASE)('Video band #1031 kind field', () => {
  it('GET /homepage/videos returns items tagged kind: anchor|popular', async () => {
    const res = await fetch(BASE + '/homepage/videos');
    expect(res.status).toBe(200);
    const body: { recent: Array<{ kind?: string }> } = await res.json();
    expect(Array.isArray(body.recent)).toBe(true);
    for (const item of body.recent) {
      expect(['anchor', 'popular']).toContain(item.kind);
    }
  });
});
```

- [ ] **Step 3: Run unit test suite as a smoke check on the new tests**

Hybrid test cannot be run without `cds bind`; smoke test cannot be run without `SMOKE_BASE_URL`. Verify both parse and load correctly:

```bash
npx vitest --run --reporter=verbose test/hybrid/homepage-videos-1031.test.js 2>&1 | tail -10
npx vitest --run --reporter=verbose test/smoke/homepage.smoke.test.ts 2>&1 | tail -10
```

Expected: both are marked "skipped" (guarded by `isSafeForWrites()` / `!BASE`) rather than "failed".

- [ ] **Step 4: Commit**

```bash
git add test/hybrid/homepage-videos-1031.test.js test/smoke/homepage.smoke.test.ts
git commit -m "test(#1031): hybrid + smoke coverage for merged endpoint"
```

---

### Task 11: Docs — architecture + gotchas

**Files:**
- Modify: `docs/developers/architecture/homepage.md`
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md`

**Interfaces:** none (docs-only)

- [ ] **Step 1: Update `homepage.md`**

In `docs/developers/architecture/homepage.md`, edit the Row 4 diagram (around line 50-52). Replace:

```
│ Row 4 · SAPDevs video band                                           │
│   LEFT — Weekly Developer News. RIGHT — 3-4 recent @sapdevs videos. │
│   Runtime: /api/homepage/videos (15-min cache; YouTube Data API v3). │
```

With:

```
│ Row 4 · SAPDevs video band                                           │
│   LEFT — Weekly Developer News. RIGHT — up to 6 tiles: 3 newest      │
│   (anchors) + 3 popular (rotation, every 4h). #1031                  │
│   Runtime: /api/homepage/videos (15-min cache; YouTube Data API v3). │
```

In the Components table (around line 17-29), after the fetch-videos row, add:

```
| **Cron** | Reshuffle video rotation (`srv/jobs/reshuffle-video-rotation.js`) | Every 4h @ :19; ranks `ext.Videos` by view velocity into `HomepageVideoRotation` |
```

In the Failure Modes table (around line 192-201), add rows:

```
| Reshuffle cron throws | `HomepageVideoRotation` untouched (single-tx ROLLBACK). Stale rotation continues to serve. |
| `HomepageVideoRotation` empty (fresh deploy) | Response returns anchors only; client renders 3 tiles until first cron pass. |
| Statistics fetch fails in `fetch-videos-job` | Snippet upsert already succeeded; view/like counts stay stale. Rotation deprioritises null-viewCount rows to bottom. |
```

Append a new section at the end (after "## Deferred enhancement — Joule chat handler routes to catalog"):

```markdown
---

## Video band rotation (#1031)

Row 4's right stack expands from 3 to 6 tiles (configurable via `HomepageConfig.videoBandAnchorCount` + `videoBandRotationCount`). Anchors always show the most recently published videos; the rotation slot set is materialised into `HomepageVideoRotation` every 4h by `srv/jobs/reshuffle-video-rotation.js`, ranked by view velocity (views per day since publishedAt) over the trailing `videoBandRotationWindowDays` (default 90).

**Admin surfaces:**
- `/admin-ui/#videos` — toggle `excludeFromHomepage` per video; manual `recomputeHomepageVideoRotation` action (SuperAdmin-gated).
- `/admin-ui/#video-rotation` — read-only view of the current rotation.
- `/admin-ui/#homepageConfig` — tuning knobs.

**Kill switches:**
1. `videoBandRotationCount = 0` → anchor-only (existing 3-tile behaviour). Zero deploy.
2. `videoBandEnabled = false` → whole band disabled (unchanged from before).
```

- [ ] **Step 2: Add hazard note to gotchas**

In `docs/developers/reference/tutorials-ims-gotchas.md`, add near a related "cron" or "transaction" hazard note:

```markdown
- **Reshuffle-video-rotation cron is TRUNCATE + INSERT — must run inside a single transaction.** `srv/jobs/reshuffle-video-rotation.js` uses `cds.tx` to wrap `DELETE FROM HomepageVideoRotation` + bulk INSERT. If a future refactor splits these into two top-level `db.run(...)` calls, a mid-cycle failure will empty the sidecar and visitors will see anchor-only tiles until the next successful cron pass — silently. #1031.
```

- [ ] **Step 3: Commit**

```bash
git add docs/developers/architecture/homepage.md docs/developers/reference/tutorials-ims-gotchas.md
git commit -m "docs(#1031): homepage video band expand + rotation"
```

---

## Post-implementation checklist (not a task — reviewer runs after Task 11 merges)

1. Deploy to DEV via `npm run build:all && cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f`.
2. From `/admin-ui/#videos`, click **Recompute rotation** to populate the sidecar immediately (do not wait 4h).
3. Trigger a fetch-videos run manually from the admin cron board (`/admin-ui/#board`) to fast-forward statistics.
4. Load `https://<dev-approuter>/` and confirm Row 4 shows 6 tiles, three with a "Popular" chip.
5. Watch `cf logs tutorials-srv --recent | grep reshuffle` for 24h to confirm the cron fires without error.
6. Then flip PROD after ≥ 1 week of DEV soak.
