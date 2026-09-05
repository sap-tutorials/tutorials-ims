# Channels Hub + Four Data Surfaces — Design

**Date:** 2026-09-05
**Status:** Design (awaiting Tom's spec review before writing-plans)
**Repo:** `sap-tutorials/tutorials-ims` (folder `tutorials-poc`) · target branch **DEV**

## Overview

The existing `/channels/` directory page is good and stays. On top of it we turn
`/channels/` into a **hub**: a top-of-page explainer + a four-card navigation band,
rendered **above** the current filter/grid, that leads visitors into four new
data-driven surfaces built from the same `Channels` dataset:

1. **Channel Atlas** — a visual force-directed map of the ecosystem (`/channels/atlas/`).
2. **Learn ↔ Follow crosswalk** — bidirectional links between tutorial topics and
   the channels that cover them (topic band on `/topics/:slug/`, plus new per-channel
   pages `/channels/:slug/`).
3. **Ecosystem-health radar** — an aggregate dashboard of the channel landscape
   (`/channels/health/`).
4. **Build-your-media-diet** — a recommender that turns selected topics (anon) or a
   user's completions (signed-in) into a personal channel bundle, exportable as
   browser bookmarks **and true OPML** (`/channels/media-diet/`).

All four are children of `/channels/`. All four launch **content-complete** — that
requires seeding the topic↔channel crosswalk data first (see Data Prerequisites).

## Goals

- Keep the existing `/channels/` grid unchanged; add a hub band above it.
- Ship four working, visibly-populated surfaces off the hub at launch.
- Do not break topic/channel rendering if any new surface's data is thin (fail-open,
  additive — the existing pattern in `topics-query.js:204`).
- Respect all project constraints: no raw SQL (CQL only), no secrets in source,
  anon `/api/*` needs approuter `authenticationType:none`, `srv/lib` changes get a
  `srv-qa` cp-list audit, schema changes go through `db/persistence.cds` +
  `cds build --production`.

## Tech Stack

- **Hugo** static pages + data files (`hugo/data/*.json`, baked by `scripts/fetch-*.ts`).
- **Vue 3 islands** (`hugo-apps/src/*` → `hugo/static/js/`) for the hub band, health
  radar, and media-diet picker.
- **Vite+Vue standalone SPA** (`app/channel-atlas/`, forked from `app/explore/`) using
  Sigma 3.0.3 + graphology 0.26.0 + graphology-layout-forceatlas2 0.10.1 for the Atlas.
- **CAP Node.js** custom Express endpoints under `/build/*` (public) and `/api/*`
  (auth), + HANA-BLOB content routes under `/content/*` for the channel-detail pages.
- **SAP HANA Cloud** — `Channels`, `ChannelTopicMap`, `Tags`, `TutorialTags`,
  `TaskRecords`, `Users`.

## Global Constraints

- Target branch is **DEV**; `main` is protected; open a PR, never direct-merge. NO
  main-hotfix path.
- **No raw SQL** anywhere — `SELECT.from(...)` CQL / `cds.ql` only.
- Tutorial/channel slug comparisons are **lowercase-canonical** — `.toLowerCase()`
  before comparing.
- **Never SELECT a HANA BLOB alongside metadata in one CDS QL query** — use raw
  `db.run()` for BLOB serve paths (existing `content-store.js` pattern).
- **`focusAreas`/`tags`/`relatedUrls` are HANA JSON NCLOB arrays** — no DB-side
  array-contains filter; filter in application code after fetching (existing
  `/build/channels` `parseArr` pattern in `srv/server.js`).
- Anon browser endpoints (`/build/*`, `/api/media-diet/export`) must have an approuter
  route with `authenticationType:none`; signed-in endpoints use `xsuaa`.
- Any new `srv/lib/*` file + its transitive `./` imports must be added to
  `.deploy/mta.yaml`'s `srv-qa` `cp` list.
- Schema changes: new columns need a `db/persistence.cds` `@cds.persistence.journal`
  entry and `cds build --production` to emit the `.hdbmigrationtable` ALTER — never
  hand-author the migration.
- New Vue islands must register any `ui5-li icon` in `hugo-apps/src/ui5/ui5-core.ts`.

## Data Prerequisites (blocking — do first)

`ChannelTopicMap` (`db/channels.cds:66`) is the spine for surface #2 and the signed-in
path of #4. It is **empty on DEV** and its consumers filter `authoringStatus =
'REVIEWED'`. Launch-complete requires this sequence, run once before the dependent
surfaces render:

1. **Dry-run** `node scripts/seed-channel-topic-map.cjs` (no `--commit`) to preview
   proposed rows. Needs AICore via `cds bind --exec` (`AICore-btp` in hybrid).
2. **Commit** `npm run seed-channel-topic-map -- --commit` → rows land as
   `authoringStatus = 'AI_SEEDED'`.
3. **Admin review** at `/admin-ui/#channelTopicMap` — promote acceptable rows to
   `REVIEWED`. (Policy decision recorded below: the REVIEWED gate is **kept**.)
4. **Full content rebuild** `gh workflow run rebuild-content.yml … -f mode=full` so
   topic BLOBs re-render with `relatedChannels` populated.

This is operational work, not code, but it gates surfaces #2 and #4-signed-in. The
implementation plan will schedule it as an explicit task before those surfaces' PRs.

## Schema Migrations (both in scope for v1)

Two nullable columns on `Channels` (`db/channels.cds`), each with a
`db/persistence.cds` journal entry + `cds build --production` migration:

- **`slug : String(200)`** — user-facing stable slug for `/channels/:slug/` detail
  URLs (cleaner than internal `sourceId`). Populated in
  `srv/lib/channels/normalize.js` from `name` (kebab-case, dedup-suffixed), unique.
  Detail route resolves by `slug` with `.toLowerCase()`; falls back to `sourceId`
  for rows not yet re-normalized.
- **`feedUrl : String(500)`** — RSS/Atom feed URL, enabling true OPML export in
  media-diet. Populated in `normalize.js` from the raw dataset's feed field where
  present; left null otherwise (export emits OPML entries only for non-null `feedUrl`,
  and bookmarks-HTML for the rest).

Both require a re-ingest (`npm run seed-channels`) to populate. `normalize.js` lives in
`srv/lib/channels/` → **srv-qa cp-list audit required**.

## Architecture by Surface

### Hub band (existing `/channels/` page)

- **Where:** `hugo-apps/src/channels-directory/ChannelsDirectory.vue` gains a header
  section rendered before the existing filter/grid — a one-paragraph explainer + four
  linked cards (Atlas, Crosswalk, Health, Media diet), each with icon + one-line
  description. No new route; no new island. Card icons must be registered in
  `ui5-core.ts` (candidates already present: `org-chart`, `chain-link`, `sys-monitor`,
  `favorite`).
- **Data:** static links; no new endpoint.

### 1. Channel Atlas — `/channels/atlas/`

- **New standalone SPA** `app/channel-atlas/`, forked from `app/explore/`: reuse the
  Sigma/graphology/ForceAtlas2 stack and the `ExploreGraph.vue` / `FilterDropdown.vue`
  / `NodeDetailPanel.vue` component shapes.
- **Hosting:** new Hugo layout `hugo/layouts/channels/atlas.html` +
  `hugo/content/channels/atlas/_index.md`; approuter route for the SPA assets; new MTA
  module in `.deploy/mta.yaml` (4th SPA build surface).
- **Data feed:** new `scripts/fetch-channel-atlas.ts` → `hugo/data/channel_atlas.json`,
  built from a new public `GET /build/channel-atlas` endpoint that extends the
  `/build/channels` projection with `subscribers`, `githubStars`, `focusAreas`,
  `ownerType`, and (post-seed) `ChannelTopicMap` topic tags.
- **Graph model:** nodes = channels, sized by `log1p(subscribers ?? githubStars ?? 0)`
  with a sane floor (sparse data → uniform-ish sizing, documented), colored by
  `ownerType` (9-value palette). Edges phase-1 from shared `focusAreas`; phase-2
  (post-seed) from shared `ChannelTopicMap` topic tags for tighter clustering.
- **Fail-open:** if the feed is empty/thin, the SPA renders an empty-state message,
  never a crash.

### 2. Learn ↔ Follow crosswalk

Two directions, both keyed on `topicTag = titlePathToMdFormat(tag.titlePath)`
(`srv/lib/tag-md-format.js`).

- **Direction 1 (topic → channels): already coded, dark.**
  `srv/lib/topics-query.js:178-209` already queries `ChannelTopicMap` (REVIEWED) and
  returns `relatedChannels`; `srv/lib/topic-detail-render.js` already renders the
  `<section class="topic-channels">` band. **Zero new code** — it lights up once
  ChannelTopicMap is seeded + reviewed + rebuilt (Data Prerequisites). This spec adds
  only styling polish + a unit test pinning the band's presence when rows exist.
- **Direction 2 (channel → topics): new per-channel detail page** `/channels/:slug/`,
  served as a HANA BLOB mirroring the `/topics/:slug/` architecture:
  - `srv/lib/build-channel-detail.js` — `buildChannelDetailPayload(db, slug)`: resolve
    channel by `slug` (lowercase; fallback `sourceId`), fetch its REVIEWED
    `ChannelTopicMap` rows, enrich each `topicTag` with tutorial count via
    `loadLiveTags(db)` (match on `titlePathToMdFormat(t.titlePath) === topicTag`),
    return `{ slug, name, url, purpose, ownerType, topics[], buildAt }`.
  - `srv/lib/channel-detail-render.js` — HTML body renderer (mirrors
    `topic-detail-render.js`); lists topics with tutorial counts + links to
    `/topics/:slug/`.
  - `srv/lib/publish-channels.js` — render-into-session publisher (mirrors
    `publish-topics.js`), emits `channel-<slug>` BLOBs with the same ≥5% error-rate
    abort guard.
  - `srv/server.js`: `GET /build/channel-detail/:slug` (public, `Cache-Control: 60`)
    runtime feed + `GET /content/channel-detail/:slug` BLOB serve via existing
    `serveHandler`.
  - `scripts/publish-content.ts`: wire the render-channel-detail phase alongside
    render-topics.
  - approuter `xs-app.json`: `"^/channels/([^/?]+)/?$"` → `/content/channel-detail/$1`,
    `authenticationType:none`. **Ordering:** this route must sit **after** the static
    child routes for `atlas`/`health`/`media-diet` (and `crosswalk` if used) so those
    literal paths are not swallowed by the `:slug` catch-all.
  - **srv-qa cp-list audit:** add `build-channel-detail.js`,
    `channel-detail-render.js`, `publish-channels.js` (+ confirm `topics-query.js`,
    `content-publish-session.js` already listed).
- **Direction 3 (optional, additive): topic chips in the channels directory island** —
  enrich `/build/channels` with per-channel `topicTags:[{tag,relevance}]` so
  `channels-directory` can render topic-tag browse chips. Fully additive; include only
  if it doesn't grow the endpoint's latency materially.

### 3. Ecosystem-health radar — `/channels/health/`

- **Hugo page + Vue island:** `hugo/content/channels/health/_index.md` +
  `hugo/layouts/channels/health.html` (injects `<script type="application/json">`
  stats) + `hugo-apps/src/channels-health/` island.
- **Data feed:** new public `GET /build/channels-stats` aggregate endpoint +
  `scripts/fetch-channels-stats.ts` → `hugo/data/channels-stats.json`.
- **v1 metrics use only reliably-populated fields:** counts and breakdowns by
  `status` (Active/Archived/Closed/Discontinued/EOL), `ownerType` (9-value),
  `category`/`subcategory`, `isSapOwned`, `isPublished`. Totals, SAP-vs-community
  split, category coverage, active-vs-inactive ratio.
- **Explicitly out of v1 (data not populated):** `linkStatus`, `lastChecked`,
  `updateFrequency` are NOT populated for channels (the link-health job only checks
  HomepageShelves/ForYouCandidates; `updateFrequency` is free text). The radar must
  not render dead panels for these. A follow-up may extend the link-health job to
  cover `Channels` and normalize `updateFrequency` — **out of scope here**, noted as
  the natural phase-2 enrichment.

### 4. Build-your-media-diet — `/channels/media-diet/`

- **Hugo page + Vue island:** `hugo/content/channels/media-diet/_index.md` +
  `hugo/layouts/channels/media-diet.html` (injects the full `hugo/data/channels.json`
  already baked by `fetch-channels`) + `hugo-apps/src/media-diet/` island.
- **Flow A (anon) — focus-area picker, pure client-side:** derive unique focus areas
  from the baked catalog, user picks 1–3, filter
  `channels.filter(c => c.focusAreas?.some(f => selected.includes(f)))` ranked by match
  count, cap ~12. No round-trip for matching.
- **Flow B (signed-in) — inferred from completions:** island probes `/auth/user`,
  checks `body.authenticated === true` (not `r.ok`), then calls new
  `GET /api/media-diet/my-picks` (`xsuaa`). Endpoint (Express in `srv/server.js`):
  resolve internal user via `resolveUserSapId(req.user)` → `Users.ID`; gather
  `TaskRecords` COMPLETED TUTORIALs → `Tutorials` → `TutorialTags` → `Tags.mdFormat`;
  match `ChannelTopicMap.topicTag IN (mdFormats)` ordered by `relevance desc`; fetch
  those published `Channels`. If ChannelTopicMap yields nothing, respond with an empty
  set + a `source` flag so the island **falls back to the anon picker** with a
  "pick some topics" message.
- **Export — new `GET /api/media-diet/export?ids[]=…&format=opml|bookmarks|json`**
  (anon, `authenticationType:none`, cap 50 ids): fetch published `Channels` by id.
  `format=opml` emits valid OPML with `xmlUrl` set **only** for rows with non-null
  `feedUrl` (populated by the v1 `feedUrl` migration); rows without `feedUrl` are
  emitted in the bookmarks/JSON forms or omitted from OPML. `format=bookmarks` emits a
  browser-importable HTML bookmarks file (`Content-Disposition: attachment`).
- **srv-qa cp-list audit:** the my-picks/export handlers live in `srv/server.js`
  (already listed); any extracted helper under `srv/lib/` gets audited.
- **approuter routes:** `^/api/media-diet/export(\?.*)?$` (none) and
  `^/api/media-diet/my-picks(\?.*)?$` (xsuaa).

## Recorded Decisions (from Tom, 2026-09-05)

- **Seed ChannelTopicMap first** — all four surfaces launch content-complete; the
  seed→review→rebuild sequence is a prerequisite task.
- **Full Sigma SPA** for Atlas (fork `app/explore/` → `app/channel-atlas/`, new MTA
  module) — not a lighter island.
- **Both `feedUrl` and `slug` migrations in v1.**
- **REVIEWED gate kept** — AI_SEEDED rows require admin promotion before surfacing.

## Error Handling & Fail-Open

- Every new read endpoint wraps its enrichment in try/catch and degrades to
  empty-but-valid (`relatedChannels`-style), never throwing into page render.
- BLOB serve paths use raw `db.run()`; never mix BLOB + metadata in one CQL query.
- Publishers carry the existing ≥5% error-rate abort guard.
- Islands treat empty/thin feeds as an empty-state UI, not an error.

## Testing

- **Unit (`npm test`, in-memory SQLite via `cds.test('serve', …, '--in-memory')`):**
  - crosswalk Direction 2: `buildChannelDetailPayload` returns topics + tutorial counts
    for a channel with seeded REVIEWED rows; returns `notFound` for unknown slug.
  - crosswalk Direction 1: topic payload includes `relatedChannels` when REVIEWED rows
    exist (pins the dark code against regression).
  - media-diet: tag-derivation chain from `TaskRecords` → `Tags.mdFormat` →
    `ChannelTopicMap` returns ranked channels; empty ChannelTopicMap → empty + fallback
    flag; user resolved by `sapId` not uuid.
  - health: `/build/channels-stats` aggregates use only the reliable fields; no
    reference to `linkStatus`/`lastChecked`/`updateFrequency`.
  - export: OPML emitted only for non-null `feedUrl`; id cap enforced.
  - Vue islands (`--project unit` from repo root): hub band renders four cards;
    media-diet picker filters client-side; health island renders from injected JSON.
  - Use `cds.entities(NS)` (not bare `SELECT.from('X')`) for CI Node-version safety.
- **Migration safety:** `npx cds deploy --to sqlite::memory:` after `db/**` edits;
  `cds build --production` produces the `slug`/`feedUrl` migration.
- **Post-deploy e2e (advisory):** committed Playwright specs for the new
  user-facing pages (hub band links resolve; atlas/health/media-diet render).

## Risks

1. **ChannelTopicMap seeding quality + review burden.** AI-seeded pairs may be many;
   each needs promotion to REVIEWED. Mitigation: dry-run first to size it; the REVIEWED
   gate is intentional (kept). If volume is unmanageable, Tom may relax the gate later —
   out of scope here.
2. **4th standalone SPA (Atlas) grows the MTA build/deploy surface** and shares the
   Sigma stack's bundle weight. Mitigation: fork cleanly from `app/explore/`; reuse its
   MTA module shape verbatim.
3. **Sparse `subscribers`/`githubStars`/`focusAreas`** weaken Atlas sizing/edges.
   Mitigation: log-scale with floor + documented empty-state; phase-2 edges from
   ChannelTopicMap once seeded.
4. **`/channels/:slug/` catch-all route ordering** could swallow
   `atlas`/`health`/`media-diet`. Mitigation: register literal child routes before the
   `:slug` route in `xs-app.json`; add a route-ordering test/assertion.
5. **srv-qa boot crash from new `srv/lib` files or transitive deps** missing from the
   cp list. Mitigation: explicit cp-list audit task per new file + lazy-import any AI/
   heavy dep below the boot path (the classifier/AI-SDK precedent).
6. **HANA NCLOB arrays can't be filtered DB-side** — media-diet anon match and stats
   run in application code over the published set. Fine at current channel counts;
   revisit if it grows into the thousands.

## Suggested Phasing (for the implementation plan)

- **Phase 0 — data + schema:** `slug` + `feedUrl` migrations; `normalize.js` +
  re-ingest; seed + review ChannelTopicMap; full rebuild. (Unblocks everything.)
- **Phase 1 — hub band + health radar + media-diet anon.** (No crosswalk data needed
  for anon media-diet + hub; health uses reliable fields.)
- **Phase 2 — crosswalk (both directions) + media-diet signed-in + export.** (Needs
  Phase 0 seed complete.)
- **Phase 3 — Channel Atlas SPA** (heaviest; independent; can overlap Phase 1/2).

Each phase is its own PR to DEV.
