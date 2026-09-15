# SAP TechEd Sessions Subsystem

This document covers the SAP TechEd 2026 session subsystem (issue [#2312](https://github.com/sap-tutorials/tutorials-ims/issues/2312)): the `TechEd*` source-of-truth entities, the RainFocus ingest, the delta-schedule cron jobs, the `/build/teched` feed, the `/teched/` Hugo page + island, the knowledge-graph projection, the semantic-search corpus entry, and Devtoberfest cross-linking.

The subsystem is delivered in units. The **foundation** (entities, RainFocus fetcher, normalizer, idempotent seed, `/build/teched` feed) is merged. The **later units** (cron jobs, `/teched/` page + island, KG projection population, embeddings, Devtoberfest cross-linking) build on the foundation and are tracked in the same issue — sections below mark what is **foundation-present** vs **planned-later**.

TechEd sessions are intentionally modelled as **new** `TechEd*` entities rather than reusing `CommunityEvents` (`db/external-content.cds`). They carry per-session structure (tracks, speakers, schedule, abstracts) that the flat `CommunityEvents` chassis does not.

---

## Source: RainFocus live contract

The SAP TechEd catalog SPA (Berlin + Virtual) is backed by the RainFocus JSON search API. The catalog is a single POST search endpoint with offset pagination.

```
POST https://events.rainfocus.com/api/search
Content-Type: application/x-www-form-urlencoded
rfWidgetId: <per-venue widget id>
rfApiProfileId: <per-venue api profile id>

type=session&size=50&from=0        # sessions (offset pagination via `from`)
type=speaker&size=50&from=0        # speaker catalog
```

Success response:

```jsonc
{
  "responseCode": "0",            // non-"0" ⇒ error (e.g. "101" = Invalid API Profile)
  "responseMessage": "OK",
  "sectionList": [ { "items": [ /* session or speaker records */ ] } ]
}
```

- **Success gate:** `responseCode === "0"`. Any other code throws (`[venue/type] RainFocus error <code>: <message>`).
- **Items path:** `sectionList[].items[]` flattened across sections; some RainFocus deployments also return a flat top-level `items` array, which the fetcher falls back to.
- **Speakers** are embedded on each session in `participants[]` (aliased `speakers[]`), and are also available as a standalone `type=speaker` catalog. Embedded speakers fill gaps the standalone catalog missed.
- **Tracks** are read from `attributevalues[]` where `attribute` matches `/track/i`, falling back to `tracks[]` / `trackIds[]`.
- **Field aliases:** RainFocus field names vary per deployment; the fetcher reads common aliases defensively (`sessionID`/`sessionId`/`id`/`code`, `utcStartTime`/`startTimestamp`/`startTime`, `photoURL`/`photoUrl`/`imageUrl`, …). See `parseSession` / `parseSpeakers` in `srv/lib/teched/rainfocus-fetcher.js`.

### Venue flow IDs and per-venue credentials

Flow ids come from the catalog SPA URLs `www.sap.com/events/teched/{virtual,berlin}/flow/sap/{tev26,te26}/…`:

| Venue | Flow | Approx. sessions |
|---|---|---|
| Berlin | `te26` | ~299 |
| Virtual | `tev26` | ~49 |

Each venue needs a `rfWidgetId` + `rfApiProfileId`. These are **not** hard-coded — the fetcher reads them from env (or an explicit `opts.venues`):

| Env var | Venue |
|---|---|
| `TECHED_RF_TE26_WIDGET_ID` / `TECHED_RF_TE26_API_PROFILE` | Berlin (`te26`) |
| `TECHED_RF_TEV26_WIDGET_ID` / `TECHED_RF_TEV26_API_PROFILE` | Virtual (`tev26`) |

> ⚠️ **The per-venue IDs may rotate and must be verified live.** They live in the catalog SPA's JavaScript, which is Akamai bot-gated (a direct `curl` of the catalog page returns `Access Denied`). Candidate IDs observed for the 2026 event are:
>
> - Berlin `te26`: `e8GkmAN9xTm5w6ZMi76B5wL0V9uhHEl1`, `WO1M8ZqF9INWQDVqfJueEsSg3eT4veku`
> - Virtual `tev26`: `KHfXyIUaP8kwISNUh32sNyjJAYKBXYYv`, `Zk0wC45uzrCrfscqh7YqpcF26iUuP9Rf`
>
> Treat these as **unverified** — they are static per event but may rotate. **Re-derive** by opening the live catalog and either (a) inspecting `/api/widgetConfig`, or (b) watching the Network tab for the `POST /api/search` request and copying the `rfWidgetId` / `rfApiProfileId` request headers. Supply the current values via the env vars above.

Because the IDs were not confirmable at capture time, the test fixture (`test/fixtures/teched/rainfocus-search.json`) is **constructed** to match the contract, not a live capture. When the catalog goes live, capture a real response, diff the field names against `parseSession` / `parseSpeakers`, and refresh the fixture.

### Fetcher resilience

`fetchAllTechEdSessions(opts)` (`srv/lib/teched/rainfocus-fetcher.js`) returns `{ sessions, speakers, tracks }` for **both** venues:

- Both venues fetched under `Promise.allSettled` — one venue failing does not sink the other (the failure is logged, that venue's rows are simply absent).
- Per-venue `session` and `speaker` pages fetched in parallel; the speaker catalog is best-effort (`.catch(() => [])`).
- Retry: exponential backoff + jitter on 5xx / 429 / network errors, honoring `Retry-After`; fail-fast on other 4xx. `MAX_RETRIES = 4`.
- Guards: `AbortController` 20s timeout; `MAX_BODY_BYTES` 25 MiB streamed cap; `PAGE_SIZE = 50`; `MAX_PAGES = 60` (3000-row/venue ceiling against runaway paging).
- `_fetch` is a swappable seam so tests inject fixtures without hitting the network.
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

## Cron jobs (delta schedule) — planned-later

The recurring delta ingest runs as two scheduled jobs under `srv/jobs/`, wired through CAP 10's Scheduling API via the internal `CronService` (`srv/cron-service.js`, #958), same as the other jobs:

- **Fetch (weekly):** full `fetchAllTechEdSessions` → `runSeed` — picks up newly published sessions and structural changes.
- **Refresh (~6h):** lighter cadence during the event window to catch room/time/abstract edits and late speaker changes.

Both are idempotent (the `contentHash` skip makes a no-op re-run cheap) and fail-open (a RainFocus outage logs and leaves the last-good rows in place). The KG projection / embedding backfill runs off `lastExtractedHash` so it only reprocesses rows whose content actually changed.

> Until the cron unit lands, seed manually via `scripts/seed-teched.cjs` (see above).

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

- **Cron jobs** — weekly fetch + ~6h refresh delta schedule (`srv/jobs/`).
- **`/teched/` page + island** — `scripts/fetch-teched.ts`, `hugo/content/teched/`, `teched-directory` Vue island.
- **KG projection** — populate `TechEdSessionConceptLinks`; property-graph arms in the KG neighborhood.
- **Semantic-search corpus entry** — TechEd sessions in the embedding corpus.
- **Devtoberfest cross-linking** — shared-concept surfacing + `/teched/` ↔ `/devtoberfest/` links.
