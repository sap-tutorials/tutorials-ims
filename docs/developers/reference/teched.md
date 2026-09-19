# SAP TechEd Sessions Subsystem

This document covers the SAP TechEd 2026 session subsystem (issue [#2312](https://github.com/sap-tutorials/tutorials-ims/issues/2312)): the `TechEd*` source-of-truth entities, the RainFocus ingest, the delta-schedule cron jobs, the `/build/teched` feed, the `/teched/` Hugo page + island, the knowledge-graph projection, the semantic-search corpus entry, and Devtoberfest cross-linking.

The subsystem is delivered in units. The **foundation** (entities, RainFocus fetcher, normalizer, idempotent seed, `/build/teched` feed) is merged. PR [#2332](https://github.com/sap-tutorials/tutorials-ims/pull/2332) then **corrects the fetcher to the live-confirmed RainFocus contract** (see below) and adds the **delta-schedule cron jobs**. The remaining **later units** (`/teched/` page + island, KG projection population, embeddings, Devtoberfest cross-linking) build on the foundation and are tracked in the same issue — sections below mark what is **present** vs **planned-later**.

TechEd sessions are intentionally modelled as **new** `TechEd*` entities rather than reusing `CommunityEvents` (`db/external-content.cds`). They carry per-session structure (tracks, speakers, schedule, abstracts) that the flat `CommunityEvents` chassis does not.

---

## Source: RainFocus live contract

The SAP TechEd catalog SPA (Berlin + Virtual) is backed by the RainFocus JSON API. Sessions come from a single POST endpoint with offset pagination. **This contract is confirmed live** — proven across repeated production runs against both venues (stable, both venues, repeated), and implemented by the corrected fetcher shipped in PR [#2332](https://github.com/sap-tutorials/tutorials-ims/pull/2332) (`srv/lib/teched/rainfocus-fetcher.js`).

> ⚠️ **Superseded contract.** The merged **foundation** fetcher was written against a wrong, constructed guess (`POST /api/search` + a separate `type=speaker` catalog scrape) *before* the contract could be verified. PR #2332 replaces it with the real contract documented below. Any older revision of this doc that mentions `/api/search`, a standalone speaker catalog, or "unverified candidate" IDs is obsolete.

```
POST https://events.rainfocus.com/api/sessions
content-type: application/x-www-form-urlencoded; charset=UTF-8
rfapiprofileid: <per-venue api profile id>
rfwidgetid:     <per-venue widget id>

type=session&browserTimezone=Europe%2FBerlin&catalogDisplay=list&from=0&size=50
```

- **Auth is the two `rf*` headers only** — no cookie / bearer token required.
- **Offset pagination:** advance `from += size` (`size = 50`) until `from >= totalSearchItems`. `size` is **hard-capped at 50 server-side** (a larger value is clamped; omitting it defaults to 20), so 50 is a per-*page* ceiling, **not** a per-venue cap — the loop pages through the entire catalog. A runaway-paging guard (`PAGINATION_MAX = 10000`) and an empty-page safety break bound the loop.

Success response:

```jsonc
{
  "responseCode": "0",                 // non-"0" ⇒ error (e.g. "Invalid API Profile")
  "responseMessage": "Success",
  "totalSearchItems": 299,             // drives the pagination loop
  "sectionList": [ { "total": 299, "from": 0, "size": 50, "items": [ /* session records */ ] } ]
}
```

- **Success gate:** `responseCode === "0"`. Any other code throws (`[venue] RainFocus error responseCode=<code>: <message>`) and fails **that venue softly** under `Promise.allSettled` — the other venue still ingests.
- **Items path:** `sectionList[].items[]` flattened across sections; a flat top-level `items` array is a defensive fallback.
- **Speakers are embedded per session** in `participants[]` — there is **NO separate speaker endpoint or scrape**. Each participant carries `speakerId`, `fullName` (`globalFullName`), `companyName`, `jobtitle` (`globalJobtitle`), `bio`, `photoURL`, and a speaker role; speakers are deduped by `speakerId` across sessions.
- **Tracks** come from `attributevalues[]` entries whose `attribute === "Track"` (other facets — "Products (offerings)", "Session level", subtracks — also live in `attributevalues[]` and are ignored). Keyed on the stable, cross-venue **`rf_attributevalue_id`** (fallback `attributevalue_code` / `attributevalue_id` / `id`).
- **Timestamps:** `utcStartTime` / `utcEndTime` arrive as `"YYYY/MM/DD HH:MM:SS"` in **UTC** (slash-separated, no zone). A plain `Date.parse` would misread them as local time, so the fetcher normalizes them to explicit ISO-`Z`.
- **Field aliases:** RainFocus field names vary; the fetcher reads common aliases defensively (`sessionID`/`sessionId`/`id`/`code`, `fullName`/`globalFullName`, `jobtitle`/`globalJobtitle`, `photoURL`/`photoUrl`/`imageUrl`, …). See `parseSession` / `parseSpeakers` / `parseTrack` in `srv/lib/teched/rainfocus-fetcher.js`.

### Venue flow IDs and per-venue credentials

Flow ids come from the catalog SPA URLs `www.sap.com/events/teched/{virtual,berlin}/flow/sap/{tev26,te26}/…`:

| Venue | Flow | Sessions (live-verified) |
|---|---|---|
| Berlin | `te26` | 297 (of `totalSearchItems` 299 — 2 all-day / invalid rows dropped) |
| Virtual | `tev26` | 49 |

Full-catalog retrieval is confirmed across repeated live runs: **Berlin 297 + Virtual 49 = 346 sessions, 362 speakers, 10 tracks.**

Each venue needs an `rfapiprofileid` + `rfwidgetid`. These are **confirmed working** (live-verified — not candidates), static for the event lifetime but **may rotate**. The fetcher ships them as defaults and lets env vars override:

| Env var | Venue | Confirmed 2026 value (default) |
|---|---|---|
| `RAINFOCUS_TE26_PROFILE` / `RAINFOCUS_TE26_WIDGET` | Berlin (`te26`) | `rfapiprofileid` `e8GkmAN9xTm5w6ZMi76B5wL0V9uhHEl1` · `rfwidgetid` `WO1M8ZqF9INWQDVqfJueEsSg3eT4veku` |
| `RAINFOCUS_TEV26_PROFILE` / `RAINFOCUS_TEV26_WIDGET` | Virtual (`tev26`) | `rfapiprofileid` `KHfXyIUaP8kwISNUh32sNyjJAYKBXYYv` · `rfwidgetid` `Zk0wC45uzrCrfscqh7YqpcF26iUuP9Rf` |

> **If the IDs rotate**, re-derive them by opening the live catalog and either (a) inspecting `/api/widgetConfig`, or (b) watching the Network tab for the `POST /api/sessions` request and copying the `rfapiprofileid` / `rfwidgetid` request headers. Supply the current values via the env vars above — no code change needed (they merely override the shipped defaults).

> **Soft rate-limit — NOT a hard cap.** Aggressive rapid probing (many offset pages back-to-back) can trip a soft RainFocus throttle that makes `from > 0` pages transiently return **empty** rows. The empty-page safety break handles this gracefully: that cycle does a partial ingest and the next scheduled run recovers (the seed is idempotent, so no data is lost). This is **not** a hard 50-item or per-venue cap; the retry/backoff also spaces requests out.

The test fixture (`test/fixtures/teched/rainfocus-search.json`) is now a **real, trimmed capture** of `/api/sessions` for both venues (PR #2332 replaced the earlier constructed fixture); `test/fixtures/teched/teched-feed.json` is derived by running the real fetcher over that capture.

### Fetcher resilience

`fetchAllTechEdSessions(opts)` (`srv/lib/teched/rainfocus-fetcher.js`) returns `{ sessions, speakers, tracks }` for **both** venues:

- Both venues fetched under `Promise.allSettled` — one venue failing (including a non-`"0"` `responseCode`) does not sink the other (the failure is logged, that venue's rows are simply absent).
- Each venue offset-paginates `/api/sessions` (`from += 50` until `from >= totalSearchItems`); speakers and tracks are read from the embedded session payload, so there is **no** separate speaker fetch.
- The outbound POST is routed through `srv/lib/safe-fetch.js` `safeFetch` (SSRF / private-IP guard + redirect handling + `AbortSignal` timeout, #895) — SSRF/redirect verdicts are terminal (never retried, fail the venue).
- Retry/backoff reuses `srv/lib/img-cdn-retry.cjs` (equal-jitter exponential backoff, retry on 429 / 5xx / network); a server `Retry-After` is honored up to `RETRY_AFTER_CAP_MS` (60 s) so a hostile value can't stall the cron. `MAX_RETRIES = 4`.
- Guards: `REQUEST_TIMEOUT_MS` 20 s; `MAX_BODY_BYTES` 25 MiB streamed cap; `PAGE_SIZE = 50`; `PAGINATION_MAX = 10000` (runaway-paging ceiling); empty-page safety break.
- `_fetch` is a swappable transport seam passed through to `safeFetch`'s `fetchImpl`, so tests inject fixtures without hitting the network.
- Cross-venue dedup by `sourceId` (first-writer-wins); past sessions (`scheduledEnd` before `now`) are dropped by default (`opts.dropPast`, undated rows kept).

---

## Data model

### `TechEd*` entities

- **File:** `db/external/teched.cds`
- **Namespace:** `com.sap.developers.ims.external`
- **Entities:** `TechEdSessions`, `TechEdSpeakers`, `TechEdTracks`, `TechEdSessionSpeakers` (session↔speaker junction), `TechEdSessionConceptLinks` (KG link table).

> ⚠️ **Entities load via a `using` side-effect — do NOT delete the import.** CAP only loads `db/` subfolder files that are reached via a `using`. `db/external/teched.cds` is pulled into the served model by `using from './external/teched';` at the top of `db/external-content.cds`. That line has no named import — it exists purely to load the entities. Removing it silently drops all `TechEd*` entities from the served model (and the `/build/teched` feed 500s with "entity not found").

Key design points (delta-ingest chassis mirrors `CommunityEvents`):

- **Unique dedup key:** `sourceId` (String 200, `@mandatory`) — the upstream RainFocus id; `@assert.unique.sourceId` enforces it. Every entity also carries a unique `slug`.
- **`slug`** (String 200) — kebab-case stable id assigned **once** (first time a `sourceId` is seen) and reused verbatim on re-ingest; deliberately **not** part of the content hash.
- **`contentHash`** (String 64) — SHA-256 of **source-owned fields only**, order-independent (arrays sorted before hashing so upstream speaker-order churn does not flip the hash).
- **`lastExtractedHash`** (String 64) — KG/embedding crash-safety; populated by the KG-projection unit, **never** by the seed.
- **Lifecycle columns** (`firstSeenAt` `@cds.on.insert: $now`, `lastSeenAt`, `pinUntil`) — never overwritten by re-ingest.
- **`venue`** on `TechEdSessions` is an `@assert.range enum { BERLIN; VIRTUAL }` so the page can split Berlin vs Virtual.
- **LOB columns:** `TechEdSessions.abstract`, `TechEdTracks.description`, `TechEdSpeakers.bio` are `LargeString` (NCLOB on HANA). Per the CLAUDE.md LOB rule, they must be SELECTed in their **own** query, never alongside metadata (locators expire) — the `/build/teched` feed does exactly this.
- **`TechEdSessionConceptLinks`** — session↔`Concepts` link table with `predicate` (default `'covers'`) and `confidence` (Decimal 3,2). Defined in the foundation so the schema is stable, but **populated by the later KG-projection unit**.

---

## Ingest CLI (`seed-teched`)

```bash
# dry-run from a fetcher-output fixture (no --commit ⇒ dry-run)
npx cds bind --exec -- node scripts/seed-teched.cjs --file test/fixtures/teched/teched-feed.json

# commit
npx cds bind --exec -- node scripts/seed-teched.cjs --file test/fixtures/teched/teched-feed.json --commit

# live (needs the per-venue widget/apiProfile env vars above)
npx cds bind --exec -- node scripts/seed-teched.cjs --commit
```

- **CLI wrapper:** `scripts/seed-teched.cjs` — with `--file`, seeds from a saved fetcher-output JSON; without it, calls the live fetcher.
- **Normalizer:** `srv/lib/teched/normalize.js` — `computeContentHash`, `generateSlug` / `toKebabSlug`, `normalizeSession` / `normalizeSpeaker` / `normalizeTrack`.
- **Core:** `srv/lib/teched/seed-core.js` — `runSeed({ db, entities, data, commit, force, now })`.

### Behaviour (idempotent SELECT-then-UPSERT)

Mirrors `scripts/seed-channels.cjs`: **manual** SELECT-then-UPDATE-or-INSERT keyed on `sourceId` (NOT CQL `UPSERT`).

| Situation | Action |
|---|---|
| Row not in DB | `INSERT` with a new `cds.utils.uuid()` as `ID` |
| Row in DB, hash unchanged (no `--force`) | Skip (`skipped++`) |
| Row in DB, hash changed (or `--force`) | `UPDATE` source-owned columns only; lifecycle columns (`pinUntil`, `lastExtractedHash`, `firstSeenAt`) untouched |

- **Order:** tracks + speakers first (no FKs), then sessions (resolves `track_ID` via the track map), then the **junction reconciliation**.
- **Junction reconciliation:** for every session **in the batch**, missing `(session, speaker)` links are added and stale ones pruned (a speaker dropped upstream must not linger). Sessions **not** in the batch are left untouched. Speakers not in the batch are skipped rather than linked to a dangling id.

### Flags

| Flag | Effect |
|---|---|
| `--file <path>` | Seed from a saved fetcher-output JSON (dry-run source); omit to call the live fetcher |
| `--commit` | Write to DB; omit for dry-run |
| `--force` | Re-process all rows regardless of `contentHash` match |

Requires a live DB binding (`cds bind --exec`).

---

## Cron jobs (delta schedule) — shipped in PR [#2332](https://github.com/sap-tutorials/tutorials-ims/pull/2332)

The recurring delta ingest runs as two scheduled jobs under `srv/jobs/`, wired through CAP 10's Scheduling API via the internal `CronService` (`srv/cron-service.js`, #958), same as the other jobs:

- **Fetch — `srv/jobs/fetch-teched-sessions-job.js` (weekly, Sun 05:43 UTC):** full `fetchAllTechEdSessions` → `runSeed` upsert + `contentHash` delta + junction reconciliation (**always runs** — the must-have). Optional KG concept-link enrichment (embed + LLM `covers` extraction → `TechEdSessionConceptLinks`, then `lastExtractedHash`) is **double-gated** (`KNOWLEDGE_GRAPH_ENABLED` + `KG_TECHED_SESSIONS_ENABLED`, both default OFF) and fail-open (#708 crash-safety).
- **Refresh — `srv/jobs/refresh-teched-sessions-job.js` (every 6h at :23):** metadata-only upsert (`seed-core` `metadataOnly` mode) to catch room/time/abstract edits and late speaker changes; no LLM, never touches `contentHash` / `lastExtractedHash`.

Both are idempotent (the `contentHash` skip makes a no-op re-run cheap) and fail-open (a RainFocus outage logs and leaves the last-good rows in place). `TechEdSessions` is wired into `gc-external-content-job` (`teched-session`, 730-day TTL, cascades the junction + concept links).

> To seed ad-hoc outside the cron cadence, run `scripts/seed-teched.cjs` (see above).

---

## Directory data path

```
/build/teched (CAP Express feed)
  ↓
scripts/fetch-teched.ts   →   hugo/data/teched.json        (planned-later)
  ↓
/teched Hugo page  →  teched-directory Vue island          (planned-later)
```

### `/build/teched` feed (foundation-present)

- **Location:** `srv/server.js` Express middleware (`app.get('/build/teched', …)`, around line 640)
- **Auth:** public, unauthenticated; `Cache-Control: public, max-age=60`
- **Explicit public projection:** the handler **never** spreads the full row — it selects only display columns, dropping `sourceId`, `contentHash`, `lastExtractedHash`, `firstSeenAt`, `lastSeenAt`, `pinUntil`, `createdBy`/`modifiedBy`.
- **LOB discipline:** `abstract` (sessions), `description` (tracks), and `bio` (speakers) are each fetched in a **dedicated LOB-only query** and merged back by `ID` — never SELECTed alongside metadata (CLAUDE.md LOB rule; mirrors `kg-projection.js`).
- **Response shape:** `{ sessions, speakers, tracks, buildAt }`. Sessions carry `venue` (`BERLIN`|`VIRTUAL`) plus `track` (track slug) and `speakers` (sorted array of speaker slugs) so the page can render splits and cross-reference speakers/tracks by slug.

### `fetch-teched.ts` + `/teched` page + island — planned-later

Following the `/channels` pattern:

- **`scripts/fetch-teched.ts`** — build-time fetch of `/build/teched` → `hugo/data/teched.json`, wired into `build:all`, **fail-open** (writes an empty payload + warning if the CAP feed is unreachable during a cold build, so the page still renders with zero items).
- **`/teched` Hugo page** — content under `hugo/content/teched/`, a `list.html` layout that embeds the feed JSON in a `<script type="application/json">` block and mounts `<div data-island="teched-directory">` with a `<noscript>` fallback.
- **`teched-directory` Vue island** (`hugo-apps/src/teched-directory/`) — Berlin/Virtual split, track + speaker facets, search. **Load via the `island-src.html` partial** (hashed path from the island manifest); never hardcode `/js/teched-directory.js`.

The `/teched/` page HTML is served from HANA as a `page-<key>` BLOB like the other top-level content pages (`/browse/`, `/topics/`, `/channels/`) — see [rebuild-content-workflow.md](../operations/rebuild-content-workflow.md).

---

## Knowledge graph + semantic search — planned-later

### KG projection

The KG-projection unit populates `TechEdSessionConceptLinks` (session → `Concepts`, `predicate: 'covers'`, `confidence`), driven off `TechEdSessions.lastExtractedHash` for crash-safe, delta-only reprocessing. This wires TechEd sessions into the same property-graph the tutorial neighborhood uses.

The KG neighborhood service (`srv/knowledge-graph-service.cds`) surfaces sessions through its **`otherResources` arm** (the same arm that already carries `CommunityEvents` rows with `eventType` `'codejam' | 'teched' | 'devtoberfest' | 'usergroup'`), so a tutorial's sidebar can show related TechEd sessions that teach shared concepts.

### Semantic-search corpus entry

TechEd session titles + abstracts are added as a semantic-search corpus entry (the `SearchService` embedding corpus), so vector search over the developer-content corpus returns TechEd sessions alongside tutorials, concepts, and external content. The `search_events` tool already accepts `eventType: 'teched'` for keyword/faceted event search.

---

## Devtoberfest cross-linking — planned-later

TechEd and Devtoberfest (#2311) are sibling event subsystems that share the KG. Cross-linking is bidirectional and concept-mediated:

- **Shared concepts** — a TechEd session and a Devtoberfest session that teach the same `Concepts` are surfaced as related on each other's detail views via the KG `otherResources` arm.
- **`/teched/` ↔ `/devtoberfest/`** — the `/teched/` page links across to `/devtoberfest/` (and back), reusing the shared TechEd/Devtoberfest logo asset (`hugo/static/images/devtoberfest/teched-logo.svg`).
- **Unified event type** — both flow through the `eventType` discriminator (`'teched'` / `'devtoberfest'`) used by `CommunityEvents`, the KG service, and the `search_events` tool.

---

## Foundation scope / deferred to later units

**Foundation-present** (merged): `TechEd*` entities (`db/external/teched.cds`), RainFocus fetcher (`srv/lib/teched/rainfocus-fetcher.js`), normalizer (`srv/lib/teched/normalize.js`), idempotent seed (`srv/lib/teched/seed-core.js` + `scripts/seed-teched.cjs`), `/build/teched` feed, unit tests + fixtures under `test/`.

**Planned-later** (build on the foundation, tracked in #2312):

- **`/teched/` page + island** — `scripts/fetch-teched.ts`, `hugo/content/teched/`, `teched-directory` Vue island.
- **KG projection** — populate `TechEdSessionConceptLinks`; property-graph arms in the KG neighborhood. (The enrichment loop ships behind the `KG_TECHED_SESSIONS_ENABLED` gate in the #2332 fetch job.)
- **Semantic-search corpus entry** — TechEd sessions in the embedding corpus.
- **Devtoberfest cross-linking** — shared-concept surfacing + `/teched/` ↔ `/devtoberfest/` links.

**Shipped in PR [#2332](https://github.com/sap-tutorials/tutorials-ims/pull/2332)** (on top of the foundation): the corrected live RainFocus `/api/sessions` fetcher and the two delta-schedule cron jobs (`fetch-teched-sessions-job.js`, `refresh-teched-sessions-job.js`).

---

## Session cards on author + advocate pages (issue #2354)

Author (`/authors/<login>/`) and Developer-Advocate (`/developer-advocates/<slug>/`) pages show cards for the TechEd **and** Devtoberfest sessions where that person is a speaker.

**Speaker → person match** (`srv/lib/session-speaker-match.js`, pure + unit-tested):

- **Devtoberfest** — email match against `Speaker.EMAIL`, normalized-name fallback. The schedule route (`srv/routes/devtoberfest-schedule.js`) deliberately omits EMAIL; the reusable loader `srv/lib/devtoberfest-feed-load.js` adds it and returns `{ feed, speakerEmailById }`.
- **TechEd** — **normalized-name match only**. `TechEdSpeakers` has no email, and the RainFocus source exposes none (`parseSpeakers` reads no email alias; the real fixture has zero email keys). Reliability caveat: name collisions and "Tom" vs "Thomas" drift are possible.

**Where the match runs:**

- **Advocate pages** (live) — `/api/advocates/:slug` attaches `sessions: { teched: [], devtoberfest: [] }` (omitted when empty). Advocate email comes from the linked user, so Devtoberfest gets a true email match here.
- **Author pages** (build time) — `scripts/fetch-tutorials.ts` `computeAuthorSessions()` fetches `/build/teched` + `/api/devtoberfest/schedule` once and matches each author. Advocate-authors (present in the `/api/advocates` roster) match on email+name; other authors match on `displayName` (name only). Result rides inside `hugo/data/author_index.json`.

`/build/teched`'s query logic now lives in `srv/lib/teched-feed.js` `loadTechEdFeed(db,{venue,upcoming})` (the route is a thin wrapper) so the advocate route can reuse it without an HTTP round-trip. The LOB-only passes moved with it (CLAUDE.md LOB rule preserved).

**Fail-open everywhere:** the cross-container Devtoberfest planner facades are absent on unit SQLite and the feeds can be cold — every read degrades to empty session arrays and never throws, so neither page type blanks on a session hiccup.

The card is one shared design: `hugo/layouts/partials/session-card.html` (authors, SSR) and `hugo-apps/src/advocate-profile/SessionCard.vue` (advocates, Vue) render the same `{ event, title, sourceUrl, track, venue, date }` DTO with the `.next-steps-*` card classes. Advocate tutorial links, previously a `<ul>`, are now the same card grid.

---

## Favorite sessions (issue #2393)

A signed-in user can favorite TechEd **and** Devtoberfest sessions, and filter any view to "favorites only". Anonymous visitors see neither the star nor the filter — the feature is fully auth-gated and fails open to the normal (unfiltered) view.

**Data model** — one user-scoped entity `com.sap.developers.ims.SessionFavorites` (`db/schema.cds`): `cuid, managed` + `user` (Association to Users), `sourceType` (enum `TECHED | DEVTOBERFEST`), `sessionRef` (String 200). Discriminator + loose `sessionRef` because the two event families key differently — TechEd favorites store the session **slug**; Devtoberfest store the planner facade **ID** (`String(36)`). Same pattern as `TaskRecords`' `taskType`+`taskLegacyId`. Favorite = a row exists; unfavorite = row deleted (no soft-delete). `@assert.unique.favorite: [user, sourceType, sessionRef]` blocks dup triples. GDPR: `db/audit-logging.cds` annotates it `@PersonalData … cascade: 'delete'` so DSR erasure cascades — **any new per-user entity needs this or it's silently missed**.

**Service ops** (`DeveloperService`, `srv/developer-service.{cds,js}`), both `@requires: 'authenticated-user'`, user always resolved from the JWT in-handler (never a param — IDOR):
- `function getMyFavorites() returns array of { sourceType; sessionRef }` — only the caller's rows; anonymous is blocked by the guard (401), which the client degrades to an empty overlay.
- `action toggleSessionFavorite(sourceType, sessionRef) returns { favorited : Boolean }` — idempotent insert/delete toggle; validates `sourceType ∈ {TECHED,DEVTOBERFEST}` and non-empty `sessionRef` (else 400); `provisionDbUser(req.user, ['ID'])` get-or-creates the row owner. IDOR-safe: covered by a unit test asserting the row lands on the JWT user.

**Client** — a shared reactive store `hugo-apps/src/devtoberfest-schedule-shared/favorites.ts`: a module-singleton `favSet: Ref<Set<string>>` keyed `"${sourceType}:${sessionRef}"`, with `isFavorite`, `loadFavorites` (seeds from `fetchMyFavorites` in `feed.ts` — 401/non-2xx/non-JSON/throw all degrade to `{authenticated:false, favorites:[]}`), and an **optimistic** `toggleFavorite` (mutates the Set, POSTs, reverts on failure). One singleton means favoriting in the grid reflects instantly in the schedule/calendar with no reload.

**UI reach** — auth-gated star + "★ Favorites only" filter across all views:
- **TechEd** grid (`teched-sessions-grid`), schedule (`teched-schedule`), calendar (`teched-calendar`) — the grid & schedule get a per-card/row star; all three get the filter. The grid persists the facet as `fav=1` in the URL (`filter.ts` gains `favorites`/`favKeys`, `url-state.ts` gains `fav`); the calendar persists `fav=1` via its own `url-state.ts`.
- **Devtoberfest** schedule, sessions-grid, sessions-calendar — star on the session rows/cards (sessions only — activities aren't favoritable), filter in all three.
- **Calendars have no per-entry star** (TechEd + Devtoberfest): the week/day agenda cells render via the *shared* `WeekAgenda`/`DayAgenda` components used by both families; favoriting is done from the grid/schedule and the shared `favSet` reflects into the calendar filter. This keeps the shared agenda components untouched.

Tests: `test/unit/session-favorites*.test.js` (model + service, in-memory SQLite), `hugo-apps/src/devtoberfest-schedule-shared/__tests__/favorites.test.ts` (store), and the TechEd `filter.test.ts`/`url-state.test.ts` favorites cases.
