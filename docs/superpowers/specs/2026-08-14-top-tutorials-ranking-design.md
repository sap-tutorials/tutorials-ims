# Time-fenced "Top Tutorials" ranking — design

**Issue:** [#1782](https://github.com/sap-tutorials/tutorials-ims/issues/1782) (follow-up from #1771)
**Date:** 2026-08-14
**Status:** Design — approved in brainstorming, pending spec review

## Summary

Add a completions-based **"Top Tutorials"** ranking to the homepage, with a
user-facing time-window selector (**90 / 180 / 360 days**, default **180**).
Rather than a separate rail, the existing PageRank-based **"Featured missions"**
carousel is evolved into a **single carousel that flips between two modes**:

- **Featured** — the existing KG-PageRank missions surface (unchanged, default mode).
- **Top Tutorials** — the new completions ranking, with the window selector.

Each card carries a small **source label** at its top ("Featured" / "Top Tutorial")
so it is always clear which list is showing.

The metric is **raw completion records** (every completed `TUTORIAL` `TaskRecord`
in the window; no per-user dedup). This is genuinely net-new: the homepage has no
completions/views-based popularity ranking today (Featured missions ranks by graph
centrality — all-time, no time dimension; the personalized top-8 is hand-curated).

## Decisions (locked in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Metric | Raw completion records | Tom: completions are first-party + reliable; "more meaningful than views." No dedup, per issue answer. |
| Window options | 90 / 180 / 360 days | From the issue. |
| Default window | 180 days | Tom's answer. |
| Selector | User-facing | Tom's answer. Fixed set — not admin-configurable (YAGNI). |
| Relationship to Featured | **Merge** into one carousel that flips between modes | Tom's answer. Per-card source label near top. |
| Default carousel mode | **Featured** | No regression to current homepage; toggle reveals Top Tutorials. |
| `SUPERSEDED` rows | **Counted** | They retain `completionDate`; matches the `exportMissionCompletions` windowed-count precedent. A reset-then-recompleted run still represents an in-window completion event. |
| Top-N per window | **8** | Matches the carousel's existing 8-slot convention. |
| Compute strategy | **Nightly sidecar** (precompute all 3 windows) | Mirrors PageRank / featured-topics. Keeps the request path fast; pure selection logic is JS-unit-testable and the windowed aggregation runs cross-adapter (JS-`Date` cutoff, no HANA-only fn). |
| Freshness | Nightly (≤ ~24h stale) | Negligible for 90–360-day windows. |
| Top Tutorials SSR | **Runtime-hydrated only** | It sits behind a toggle (not the default mode); no `/build` feed or `hugo/data` bake needed. Featured keeps its SSR path. |

## Architecture

The feature mirrors the **featured-topics snapshot pattern** end-to-end:

```
srv/jobs/top-tutorials-job.js         (nightly @ 04:53 UTC, fail-open)
  → srv/lib/top-tutorials-snapshot.js  recompute(tx)
      → windowed COUNT aggregation over TaskRecords ⋈ Tutorials  (per 90/180/360)
      → top-8 per window
      → atomic TRUNCATE + INSERT into TopTutorialsSnapshot sidecar
                                           │
srv/homepage-service.(cds|js)              │
  topTutorials() OData fn  ── readForFeed(tx) ──┘   (hydrate cards, ETag, 60s cache)
      served under /homepage/*  (anonymous; no approuter change)
                                           │
hugo-apps/src/featured-topics-carousel/    ▼  (island — evolved, not new)
  mode toggle (Featured | Top Tutorials) + window selector (90/180/360, localStorage)
  fetch /homepage/topTutorials() lazily on first flip; switch windows client-side
```

### Component 1 — Sidecar entity

New file `db/homepage-top-tutorials.cds`, namespace `com.sap.developers.ims`,
following the `ConceptRank` / `FeaturedTopicsSnapshot` derived-table convention
(no `cuid`/`managed`; `computedAt` captures batch time; kept off the OData surface):

```cds
namespace com.sap.developers.ims;

@cds.autoexpose: false
entity TopTutorialsSnapshot {
  key windowDays  : Integer;      // 90 | 180 | 360
  key rank        : Integer;      // 1..8
      slug        : String(255);  // matches Tutorials.slug width
      completions : Integer;      // raw count in window
      computedAt  : Timestamp;
}
```

Key is `(windowDays, rank)` — deterministic slot per window. HANA table name
resolves to `COM_SAP_DEVELOPERS_IMS_TOPTUTORIALSSNAPSHOT` (used raw by the job).

### Component 2 — Snapshot lib (`srv/lib/top-tutorials-snapshot.js`)

Two exported functions plus reuse of featured-topics card hydration:

- **`recomputeSnapshot(tx)`** — for each window `N ∈ {90,180,360}` runs the
  aggregation, takes top-8, then atomically `DELETE.from(TopTutorialsSnapshot)`
  + `INSERT` all rows in the caller's transaction. Returns `{ count, computedAt }`.

  **Window predicate uses a JS-computed cutoff bound as a parameter** — NOT
  HANA `ADD_DAYS`. This mirrors `exportMissionCompletions`
  (`srv/admin-service.js`), which does `.and(\`completionDate >= \`, cutoffDate)`
  with a JS `Date`. Because it binds a parameter rather than calling a HANA-only
  date function, **the identical query runs on both SQLite (unit) and HANA
  (hybrid)** — the whole aggregation becomes unit-testable. Cutoff is
  `new Date(Date.now() - N * 86_400_000)` per window (N from the fixed allowlist
  `[90,180,360]`, never user input).

  Aggregation via `cds.ql` over the `TaskRecordsAnalytics` projection (which
  already carries the `tutorial` soft-link association on
  `tutorial.legacyId = taskLegacyId AND taskType = 'TUTORIAL'`), grouped by
  `tutorial.slug`. Conceptual shape, one run per window:
  ```sql
  SELECT tut.slug, count(*) AS completions, max(tr.completionDate) AS lastCompletion
    FROM TaskRecords tr
    JOIN Tutorials  tut ON tut.legacyId = tr.taskLegacyId
   WHERE tr.taskType = 'TUTORIAL'
     AND tr.status IN ('COMPLETED','SUPERSEDED')
     AND tr.completionDate >= :cutoff          -- bound JS Date, not ADD_DAYS
     AND (tut.status = 'ACTIVE' OR tut.status IS NULL)
   GROUP BY tut.slug
   ORDER BY completions DESC, lastCompletion DESC, tut.slug ASC
   LIMIT 8
  ```
  `count(*)` / `max()` grouping/ordering is proven cross-adapter by the
  `TutorialCompletionStats` view (its unit test runs on SQLite in-memory).
  Tie-break: `completions DESC, lastCompletion DESC, slug ASC` (stable).

- **`readSnapshotForFeed(tx)`** — reads all sidecar rows, groups by `windowDays`,
  hydrates each slug into a tutorial card (reusing the featured-topics card
  builder + LOB-safe raw description fetch on HANA), computes an ETag, returns:
  ```js
  {
    computedAt: Date,
    etag: string,
    windows: {
      "90":  [ { rank, slug, completions, card:{ slug, title, description,
                                                  level, time, primaryTag,
                                                  href, isNew } }, ... ],
      "180": [ ... ],
      "360": [ ... ]
    }
  }
  ```
- **`resetTopTutorialsCache()`** — clears the 60s in-process cache (called by the
  admin manual-recompute path, mirroring `resetFtCache()`).

### Component 3 — Nightly job (`srv/jobs/top-tutorials-job.js`)

- `export async function runTopTutorials(logId)` — `cds.connect.to('db')`,
  `db.tx(...)` → `recomputeSnapshot(tx)`. Emits metrics
  `top_tutorials_{duration_ms,rows,failures}`.
- Uses raw HANA table name for the TRUNCATE+INSERT (job may run via
  `cf run-task node -e` outside the CAP bootstrap, where `cds.entities()` is
  undefined — same reason as `kg-pagerank-job.js`).
- **Fail-open:** throws on error (→ `runWithLock` records a FAILED PipelineLog row
  + `ScheduledJobFailed` alert); the atomic swap means readers keep yesterday's
  rows on a mid-batch failure, never a partial write. Request-time reads also
  tolerate an empty/missing sidecar (renders as "no data", never a 500).
- Also exports the **pure** selection helper (e.g. `selectTopN(rowsByWindow)`) for
  JS unit testing without a DB.

### Component 4 — Scheduler registration (`srv/jobs/scheduler.js`)

Add inside `registerJobs()` (import `runTopTutorials` at top):

```js
// Daily 04:53 UTC — rebuild the Top Tutorials completions ranking sidecar.
registerJob({
  jobName: 'top-tutorials',
  schedule: '53 4 * * *',                 // free off-minute (verified against registry)
  ttlMs: 600000,
  description: 'Rebuild TopTutorials ranking from windowed completions',
  fn: (logId) => runTopTutorials(logId),
});
```

`04:53 UTC` is unused in the current registry (03:53 is kg-pagerank; the 04:xx
nightly cluster's taken minutes are 00/07/11/12/13/17/23/33/37/47; 43 is Sunday-only).
`CronService.init()` auto-discovers it; it appears in admin `JobControls` for manual
re-run with no extra wiring.

### Component 5 — Endpoint (`srv/homepage-service.cds` + `.js`)

Add an unbound OData function on `HomepageService` (which is `@requires: 'any'`,
served at `/homepage`, anonymous — the `^/homepage/(.*)$` approuter route already
covers it, `authenticationType: none`):

```cds
function topTutorials() returns TopTutorialsFeed;   // shape mirrors readSnapshotForFeed
```

Handler mirrors `featuredTopics()`: `_getTopTutorialsPayload()` → `readSnapshotForFeed(cds.tx({}))`,
wrapped as `{ computedAt, etag, windows }`, with a **60s in-process cache** and
`If-None-Match`/ETag → `304`. All three windows returned in one payload so the
selector switches client-side with **zero refetch**.

### Component 6 — Frontend island (evolve `hugo-apps/src/featured-topics-carousel/`)

Modify the **existing** carousel island (do not add a new one). Changes:

- **Mode toggle** — a segmented control (`Featured` | `Top Tutorials`), `Featured`
  default. `aria-pressed` per the events-band chip pattern.
- **Window selector** — chips `90 / 180 / 360`, shown only in Top Tutorials mode,
  default **180**, persisted in `localStorage` (new `window-storage.ts` modeled on
  `homepage-events-band`'s `region-storage.ts`, with a validation allowlist `[90,180,360]`).
- **Per-card source label** — small label at the top of each card
  ("Featured" / "Top Tutorial").
- **Data** — Featured mode keeps the existing SSR-baked + `/homepage/featuredTopics()`
  rehydrate path untouched. On the **first flip** to Top Tutorials, fetch
  `/homepage/topTutorials()` (ETag/304, `credentials:'include'`), cache all three
  windows in component state; switching windows thereafter is client-side only.
- **Hugo partial** `hugo/layouts/partials/homepage/featured-topics-carousel.html`
  gains the toggle chrome (SSR renders it in the default Featured state);
  the Top Tutorials region is empty until hydrated (progressive enhancement —
  no-JS visitors see Featured).
- **No new Vite entry, no new island-src line, no new `hugo/data` file** — we are
  extending an existing island, so its manifest/fingerprint wiring is unchanged.

## Data flow

**Nightly (write):** scheduler tick → `runTopTutorials` → `recomputeSnapshot` runs 3
windowed aggregations over `TaskRecords ⋈ Tutorials` → top-8 each → atomic
TRUNCATE+INSERT into `TopTutorialsSnapshot`.

**Request (read):** browser loads homepage → Featured SSR paints immediately →
island hydrates Featured from `/homepage/featuredTopics()` → on first flip to Top
Tutorials, island fetches `/homepage/topTutorials()` once → user toggles
90/180/360 client-side with no further network.

## Error handling / resilience

- **Job failure:** atomic swap → readers keep yesterday's rows; FAILED PipelineLog +
  alert raised by the shared `runWithLock` chassis.
- **Empty/missing sidecar** (first deploy before first nightly run, or all rows
  aged out): `readSnapshotForFeed` returns empty `windows`; the endpoint returns a
  valid empty payload; the island shows Featured normally and renders an empty/"no
  data" state if the user flips to Top Tutorials. Never a 500.
- **Endpoint read throw:** caught; returns empty payload (fail-open), never breaks
  the homepage.
- **LOB safety:** description hydration uses the featured-topics raw parameterised
  `SELECT "SLUG","DESCRIPTION" ... WHERE "SLUG" IN (...)` on HANA to avoid
  LOB-locator expiry; never SELECT a BLOB alongside metadata in one CDS QL query.
- **Packet-cap safety:** at most 8 slugs per window (≤ 24 total) — well under the
  HANA `IN (...)` packet cap; no chunking needed.

## Testing strategy

| Layer | What | Where |
|---|---|---|
| Pure selection | top-N + tie-break from in-memory rows | unit (no DB) |
| Snapshot recompute | recompute over seeded `TaskRecords`/`Tutorials` with fixed `completionDate`s spanning/straddling the window boundaries; assert per-window top-8, `SUPERSEDED` inclusion, active-tutorial filter, tie-break. Runs on SQLite because the window predicate binds a JS-`Date` cutoff (no `ADD_DAYS`). | unit |
| Endpoint | payload shape (all 3 windows), ETag/304, empty-safe, 60s cache | unit + hybrid |
| Job | pure compute with injected rows; fail-open on DB throw; atomic-swap keeps prior rows on mid-batch fault | unit |
| Windowed aggregation on real HANA | same assertions against real HANA (adapter/casing/real data volume) | hybrid (`--project hybrid`, `cds bind`) |
| Island | toggle + window selector + lazy fetch + per-card label + localStorage persist | hugo-apps Vue test (`vitest run --project unit` from repo root), mirroring events-band specs |
| E2e (advisory) | committed `test/e2e` spec for the merged carousel (per the user-facing-UI nudge) | post-deploy e2e job |

The window predicate binds a JS-computed cutoff `Date` (parameterised), so the
aggregation behaves identically on the SQLite unit harness and on HANA — no
HANA-only date function on the query path. The hybrid run still exists to catch
adapter/casing/data-volume surprises. Run `npx cds deploy --to sqlite::memory:`
after adding `db/homepage-top-tutorials.cds`.

## Deploy / rollout notes

- New sidecar entity → `cds build --production` after adding the `.cds`; the
  `.hdbtable`/migration artifact emits automatically (no hand-authored ALTER).
- `srv/lib/top-tutorials-snapshot.js` is a new `srv/lib/` module → **re-walk the
  `srv-qa` `cp` list** in `.deploy/mta.yaml` for any transitive `./` imports (QA
  boot crashes on a missing transitive dep). It reuses featured-topics hydration —
  confirm those deps are already listed.
- Island change touches `hugo-apps/**` → advisory e2e-coverage nudge; add the e2e
  spec.
- First deploy: sidecar is empty until the first 04:53 nightly run (or an admin
  manual `runJob('top-tutorials')`). Trigger it manually post-deploy so Top
  Tutorials isn't empty on day one.
- PR targets `DEV` (branch `feat/1782-top-tutorials`).

## Out of scope (YAGNI)

- Page-views metric (completions only, per Tom).
- Admin-configurable window set / default (fixed 90/180/360, default 180).
- Per-user personalization of the Top list.
- SSR baking of the Top Tutorials mode (runtime-hydrated only).
- A/B testing infrastructure.
