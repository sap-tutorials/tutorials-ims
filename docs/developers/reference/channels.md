# External Channels Subsystem

This document covers the **P1 foundation** of the external-channels subsystem: the `Channels` source-of-truth entity, re-ingest CLI, `/build/channels` feed, `/channels` Hugo directory page, and `promote-channels` verb-lane fill. P2–P4 work (editorial collections, topic crosswalk, community submissions) are out of scope here and tracked separately.

---

## Data model

### `Channels` entity

- **File:** `db/channels.cds`
- **Namespace:** `com.sap.developers.ims`
- **Persistence:** annotated `@cds.persistence.journal` in `db/persistence.cds` — deploys as `.hdbmigrationtable` so schema evolution uses `ALTER TABLE` rather than drop-and-recreate.
- **Aggregation:** pulled into the global model via `using from './channels'` in `db/schema.cds`.

Key design points:

- **Unique dedup key:** `sourceId` (String 40) — the `id` field from the raw research dataset; `@assert.unique.sourceId` enforces it at DB level.
- **Array columns:** `relatedUrls`, `aliases`, `focusAreas`, `tags` are declared as `array of String(...)`. On SQLite these come back as native arrays; on HANA they are stored as JSON NCLOBs. The `/build/channels` feed handler (`srv/server.js`) applies `JSON.parse` for the HANA case; `seed-channels` calls `cds.linked(cds.model ?? ...).entities('com.sap.developers.ims')` to resolve the entity through CAP's linked model — the `cds.linked()` / `entities(NS)` pattern is required for correct array round-tripping.
- **Admin-curated columns** (never touched by re-ingest): `isPublished`, `isFeatured`, `editorialNote`, `linkStatus`, `linkStatusOverride`, `lastChecked`. These are preserved across every re-seed so editorial decisions survive data refreshes.
- **Enum columns:** `ownerType` (`ChannelOwnerType`) and `status` (`ChannelStatus`) both carry `@assert.range` — invalid values are rejected at the service layer.

---

## Re-ingest CLI (`seed-channels`)

```bash
npm run seed-channels -- --file <path-to-dataset.json> --commit
```

- **Script:** `scripts/seed-channels.cjs`  (npm script: `cds bind --exec -- node scripts/seed-channels.cjs`)
- **Normalizer:** `srv/lib/channels/normalize.js` — `normalizeChannel(raw, ingestBatch)` cleans citation markers, maps free-text `ownerType`/`status` to enum values, and computes a `contentHash` (SHA-256 of source-owned fields in sorted-key canonical JSON).

### Behaviour

| Situation | Action |
|---|---|
| Row not in DB | `INSERT` with a new `cds.utils.uuid()` as `ID` |
| Row in DB, hash unchanged (no `--force`) | Skip (`skipped++`) |
| Row in DB, hash changed (or `--force`) | `UPDATE` source-owned fields only; curated columns are deleted from the patch before writing |
| Row in DB but absent from this ingest batch | Soft-retire: `status = 'Archived'`; curated columns untouched |

### Flags

| Flag | Effect |
|---|---|
| `--file <path>` | Path to JSON dataset (default: `d:/tmp/External-SAP-Channels-Complete.json`) |
| `--commit` | Write to DB; omit for dry-run |
| `--force` | Re-process all rows regardless of `contentHash` match |

The script requires a live DB binding (`cds bind --exec`). Use `npm run seed-channels` rather than invoking the script directly.

---

## Directory data path

```
/build/channels (CAP Express feed)
  ↓
scripts/fetch-channels.ts   →   hugo/data/channels.json
  ↓
/channels Hugo page  →  channels-directory Vue island
```

### `/build/channels` feed

- **Location:** `srv/server.js` Express middleware (around line 418)
- **Auth:** public, unauthenticated; `Cache-Control: public, max-age=60`
- **Filtering:** returns only rows where `isPublished = true`; then excludes any where the effective `linkStatus` is `'BROKEN'` (override wins: `linkStatusOverride || linkStatus`)
- **Array parsing:** `focusAreas`, `tags`, `relatedUrls`, `aliases` are passed through a `parseArr` helper that calls `JSON.parse` for HANA string values and passes through native arrays from SQLite
- **Response shape:** `{ channels: Channel[], buildAt: string }`

### `fetch-channels.ts`

- **File:** `scripts/fetch-channels.ts`
- **npm script:** `fetch-channels` (`tsx scripts/fetch-channels.ts`)
- **Wired into `build:all`:** yes — `npm run fetch-channels` is one of the steps in the `build:all` script in `package.json`
- **Output:** `hugo/data/channels.json` (created with `mkdirSync` if missing)
- **Fail-open:** if the CAP feed is unreachable (e.g., during a cold build before `cds watch` starts), the script writes an empty-channels payload with `error` set and a warning to stdout — the build continues; the `/channels` page renders with zero items

### `/channels` Hugo page

- **Content directory:** `hugo/content/channels/` (`_index.md` sets title + description)
- **Layout:** `hugo/layouts/channels/list.html` — renders the channel list JSON into a `<script id="channels-data" type="application/json">` block, mounts `<div data-island="channels-directory">`, and provides a `<noscript>` fallback list
- **Island loading:** `<script type="module" src="{{ partial "island-src.html" "channels-directory" }}"></script>` — uses the `island-src.html` partial (hashed path from the island manifest); **never hardcode `/js/channels-directory.js`**

### `channels-directory` Vue island

- **Location:** `hugo-apps/src/channels-directory/`
- **Entry:** `index.ts`
- **Component:** `ChannelsDirectory.vue`
- **Filter logic:** `filter.ts` exports `filterChannels(channels, state)` where `state` is `{ query?, category?, platform?, ownerScope? }`. Facets:
  - **category** — exact match on `channel.category`
  - **platform** — exact match on `channel.platform`
  - **ownerScope** — `'sap'` (only `isSapOwned === true`), `'community'` (only `isSapOwned !== true`), or `'all'`
  - **query** — case-insensitive substring match across `name`, `purpose`, and `tags`

---

## Verb-lane fill (`promote-channels`)

```bash
npm run promote-channels
```

- **CLI wrapper:** `scripts/promote-channels-to-shelves.cjs`
- **npm script:** `cds bind --exec -- node scripts/promote-channels-to-shelves.cjs`
- **Core logic:** `srv/lib/channels/promote-to-shelves.js` — exports `promoteFeatured(db)`, `mapChannelToShelf(channel)`, `CATEGORY_TO_SHELF`, `FOCUS_TO_VERB`

### Mapping rules

`mapChannelToShelf` converts a channel row to `{ verb, shelf }`:

1. **shelf** from `CATEGORY_TO_SHELF[channel.category]` (default `'REFERENCE'`)
2. **community / third-party guard:** if the computed shelf is `'START_HERE'` but `channel.isSapOwned !== true`, the shelf is downgraded to `'REFERENCE'` — community items **never** land in `START_HERE`
3. **verb** from `pickVerb(channel.focusAreas)` which walks `FOCUS_TO_VERB` (ordered priority list of keyword arrays → `INTEGRATE / OPERATE / AI / MODEL / BUILD / LEARN`); default is `'BUILD'`

`promoteFeatured(db)` selects all rows with `isFeatured = true, isPublished = true`, maps each to a shelf/verb pair, and inserts into `HomepageShelves` with:
- `badge: 'THIRD_PARTY'` when `!isSapOwned`
- `authoringStatus: 'AI_SEEDED'`, `isExternal: true`, `isActive: true`, `sortOrder: 500`
- **Idempotent:** upserts on `(verb, url)` — existing rows are skipped, not overwritten

---

## Admin surface

- **OData projection:** `AdminService.Channels` in `srv/admin-service.cds` (line 296–297), annotated `@odata.draft.enabled`
- **FE app:** `app/admin/channels/` (UI5 Fiori Elements; bootstrapped from `package.json` + `ui5.yaml`)
- **Shell wiring:** `app/admin-shell/scripts/admin-shell-overrides.js` registers `'channels'` in the component list (explicit ordering) with router prefix `'ch'`. The shell manifest is **generated** by `app/admin-shell/scripts/generate-manifest.js`; do NOT hand-edit the generated `manifest.json` — run the generator (triggered automatically at `npm run prebuild`)

---

## P1 scope / deferred to P2–P4

Items explicitly **not** in this subsystem yet:

- **P2 — Editorial `ChannelCollections`:** curated groupings (e.g., "Getting Started", "CAP ecosystem") with their own Hugo/island surface
- **P3 — `ChannelTopicMap` crosswalk:** per-topic bands on `/topics/<name>` pages wiring channels relevant to each topic
- **P4 — `ChannelSubmissions`:** community submission form + moderation loop
- **Nightly link-health extension:** the existing link-health job already knows how to check URLs; wiring it to `Channels.url` / `linkStatus` is a follow-up, not yet implemented. P1 already filters `BROKEN` channels out of the feed so stale data is not surfaced to users.
