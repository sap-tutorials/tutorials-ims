# Developer Advocates — Design Spec

**Date:** 2026-06-17
**Author:** Tom (with Claude)
**Status:** Approved by Tom in brainstorm; pending spec review.

## Goals

Replace the legacy AEM-served `developers.sap.com/developer-advocates.html` page with an in-codebase implementation that:

1. **Single source of truth** — advocate data lives in the CAP/HANA database; can be reused from any other surface (e.g. tutorial author attribution later).
2. **Easy to maintain** — admin Fiori UI for CRUD, mirrors the patterns already used by `Categories`, `Tags`, `Events`, etc.
3. **Public page with "wow"** — a Fiori-card design rendered as a Vue 3 island in Hugo, automatically sorted by last name, with hover-to-flip cards and a region-tinted gradient header.
4. **Photo storage in HANA** — uploaded by admin, processed server-side, served via a public photo endpoint (no external CDN dependency).

## Non-Goals (v1)

- Per-advocate detail pages (`/developer-advocates/<slug>`).
- Tutorials-by-author rail (requires schema change to `Tutorials`).
- Self-service edit per advocate (would need new XSUAA scope + row-level `@restrict`).
- AI-generated bio drafting.
- Geocoded per-advocate map pins (map is regional, stylized).
- Translations / i18n (project is English-only).
- `joinedDate` → "New advocate" badge UI (data captured, hook deferred).
- Audit-logging via `@PersonalData` — **deliberately excluded**. Advocate info is
  published-by-intent business directory data, not user-controlled PII;
  including it would incorrectly cascade through `_executeAnonymization` if
  the advocate later anonymizes their *learner* account.

## Architecture Overview

```text
Admin (XSUAA Admin role)
  → /admin-ui/#advocates-display (new Fiori Elements app)
    → AdminService OData: Advocates, AdvocateTopics, AdvocateLinks, AdvocatePhotos
      → ims.* entities in HANA (db/schema.cds)
      → AdvocatePhotos.photo256 / photo64 stored as gzip-WebP LargeBinary

Public (unauth)
  → /developer-advocates/  (Hugo content page, layout: list)
    → Vue 3 island /js/advocates.js (hugo-apps/src/advocates/)
      → fetch /api/advocates  (DeveloperService → ims.Advocates)
      → <img src="/api/advocates/:slug/photo?v={photoUpdatedAt}">
        → srv/lib/advocate-photo-store.js → HANA BLOB
```

## Data Model

Three new entities under `com.sap.developers.ims` in `db/schema.cds`.

```cds
entity Advocates : cuid, managed {
  slug          : String(64) @mandatory; // unique; auto-derived from name on insert
  firstName     : String(100) @mandatory;
  lastName      : String(100) @mandatory;
  title         : String(255);           // "Sr. Developer Advocate", "Chief..."
  pronouns      : String(32);
  location      : String(120);           // "Walldorf, Germany"
  region        : String(16) @assert.range enum { AMERICAS; EMEA; APJ };
  bio           : LargeString;           // 1-3 sentences, shown on flip back
  isActive      : Boolean default true;  // hide without deleting
  sortOverride  : Integer;               // null = alphabetical by lastName
  joinedDate    : Date;
  hasPhoto      : Boolean default false; // server-managed; flips on upload/delete
  photoUpdatedAt: Timestamp;             // cache-bust query string for <img src>
  topics        : Composition of many AdvocateTopics on topics.advocate = $self;
  links         : Composition of many AdvocateLinks  on links.advocate  = $self;
}

entity AdvocateTopics : cuid {
  advocate : Association to Advocates;
  tag      : Association to Tags;        // reuses global Tags registry
}

entity AdvocateLinks : cuid {
  advocate  : Association to Advocates;
  kind      : String(32) @assert.range enum {
    LinkedIn; X; Mastodon; BlueSky; GitHub; YouTube; Blog; SapCommunity; Email; Other;
  };
  url       : String(500) @mandatory;
  label     : String(80);                // optional display override
  sortOrder : Integer default 100;
}

entity AdvocatePhotos {
  key advocate_ID : UUID;                // composite key matches association
  advocate        : Association to Advocates not null;
  photo256        : LargeBinary @Core.MediaType: photoMimeType;
  photo64         : LargeBinary @Core.MediaType: 'image/webp';
  photoMimeType   : String(40)  @Core.IsMediaType default 'image/webp';
  sizeBytes       : Integer;
  sha256          : String(64);          // ETag value
  uploadedAt      : Timestamp;
}
```

### Annotations

- **`db/change-tracking.cds`** — `@cds.changetracking.modified` on `Advocates`,
  `AdvocateTopics`, `AdvocateLinks`. Admin edits surface in the existing
  `Changelog` Fiori app at `/admin-ui/#changelog-display`.
- **No `@PersonalData` annotations.** Advocate info is published-by-intent
  business directory data; advocates do not own its lifecycle. Adding it would
  silently wipe their advocate row when they anonymize their *learner* account.
  See "Non-Goals."

### Slug derivation

On `before('CREATE', 'Advocates')`:

1. Build `${firstName} ${lastName}` → lowercase → strip diacritics
   (NFD + filter `̀-ͯ`) → replace non-`[a-z0-9]+` with `-` → trim
   leading/trailing `-`.
2. If the slug exists, append `-2`, `-3`, ... until unique.
3. If `slug` was provided explicitly by the admin, validate against the same
   regex but skip auto-derivation.

## Services

### Admin: `srv/admin-service.cds` (extend existing service)

```cds
extend service AdminService with {
  @odata.draft.enabled
  entity Advocates       as projection on ims.Advocates;
  entity AdvocateTopics  as projection on ims.AdvocateTopics;
  entity AdvocateLinks   as projection on ims.AdvocateLinks;
  entity AdvocatePhotos  as projection on ims.AdvocatePhotos;
}
```

`AdminService` already declares `@requires: 'Admin'` at service level. Drafts
are on so partial edits do not dirty the public read.

A new admin app at `app/admin/advocates/` (Fiori Elements List Report → Object
Page) is generated from the same scaffold as `app/admin/categories/`.
Annotations live in `app/admin-annotations.cds` next to every other admin app's
annotations.

- **List Report:** columns `lastName, firstName, title, region, isActive`;
  filter bar on `region` and `isActive`; default sort `lastName asc`. Search
  on name + title.
- **Object Page:**
  - Header facet: photo upload control (driven by `@Core.MediaType` on
    `AdvocatePhotos.photo256` — Fiori Elements renders an `UploadSet`
    automatically), name fields, region, `isActive`, `sortOverride`.
  - Body facets: General (title, pronouns, location, joinedDate, bio), Topics
    (table with value-help linked to `Tags`), Links (table with `kind` enum
    dropdown + `url` + optional `label`).
- The component is loaded by `app/admin-shell/` via `componentUsages` —
  identical wiring to every other admin app.

### Public: `srv/developer-service.cds` (extend existing service)

```cds
extend service DeveloperService with {
  @readonly
  entity Advocates as projection on ims.Advocates {
    *,
    topics, links
  } excluding { hasPhoto };  // public clients use the photo URL, not the flag
}
```

### Custom Express routes (registered in `srv/server.js` on `bootstrap`)

#### `GET /api/advocates`

- Public, unauthenticated.
- Returns `{ advocates: [...] }` with `isActive=true` rows only.
- Sorted by `(sortOverride NULLS LAST, lastName, firstName)`.
- Each row inlines `topics` (denormalized to `[{ slug, label }]` from joined
  `Tags`) and `links` (sorted by `sortOrder, kind`).
- `ETag` header derived from `MAX(modifiedAt)` across `Advocates`,
  `AdvocateTopics`, and `AdvocateLinks`. Server returns `304 Not Modified`
  when the client's `If-None-Match` matches.
- `Cache-Control: public, max-age=60, stale-while-revalidate=600` — admin
  saves are visible publicly within ~60 s without manual cache purge.
- Response excludes `hasPhoto` (clients use `/api/advocates/:slug/photo`
  directly; absence → 404 → fallback avatar).

#### `GET /api/advocates/:slug/photo`

- Public, unauthenticated.
- `?size=thumb` → 64×64 WebP; no query (or `?size=full`) → 256×256 WebP.
- `ETag: "{sha256}"`, `Cache-Control: public, max-age=86400`.
- 404 when `hasPhoto=false` (slug exists but no photo) or slug unknown. The
  Vue island falls back to `InitialsAvatar.vue`.
- Implementation in `srv/lib/advocate-photo-store.js` uses raw `cds.db.run()`
  SQL on HANA for the BLOB read (LOB-locator workaround per the
  `srv/lib/content-store.js` precedent), CDS QL on SQLite for unit tests.
  Bounded LRU cache keyed by `(slug, size)`, 10 MB cap, evicted on photo
  update.

#### Photo upload (CAP standard, no custom route)

The Fiori `UploadSet` PUTs the binary against `AdvocatePhotos.photo256` per
the `@Core.MediaType` contract. A `before('UPDATE', 'AdvocatePhotos')` handler
in `srv/admin-service.js`:

1. Validates MIME header against allowed list (jpeg/png/webp).
2. Streams the body through `sharp()` to produce:
   - `photo256` — 256×256 WebP, quality 85.
   - `photo64` — 64×64 WebP, quality 80.
3. Computes `sha256(photo256)`.
4. Replaces the upload payload before write (the original bytes never hit the
   DB).
5. Rejects on: oversized (> 5 MB), non-image MIME, animated content
   (sharp metadata `pages > 1`), unreadable bytes.

An `after('UPDATE', 'AdvocatePhotos')` handler stamps `Advocates.hasPhoto =
true` and `Advocates.photoUpdatedAt = $now`. Photo delete (DELETE on
`AdvocatePhotos`) flips `hasPhoto = false`.

## Public Page

### Hugo content

`hugo/content/developer-advocates/_index.md`:

```yaml
---
title: Developer Advocates
description: Meet the SAP Developer Advocates building samples, running CodeJams, and connecting the community.
type: developer-advocates
layout: list
---
```

### Hugo template

`hugo/layouts/developer-advocates/list.html`:

```html
{{ define "main" }}
<main id="advocates-mount"
      data-api="/api/advocates"
      data-photo-base="/api/advocates"></main>
<noscript>
  <p>JavaScript is required to view the advocates directory. To reach a
     regional team:</p>
  <ul>
    {{ range $.Site.Data.advocate_fallback }}
    <li><a href="mailto:{{ .email }}">{{ .region }} ({{ .email }})</a></li>
    {{ end }}
  </ul>
</noscript>
<script type="module" src="{{ "/js/advocates.js" | relURL }}"></script>
{{ end }}
```

The shell is intentionally empty — the island owns rendering. SSR does NOT
bake the list (runtime fetch was the agreed model). The `<noscript>` block
falls back to a small `hugo/data/advocate_fallback.json` (3 region-team
mailtos, hand-maintained).

### Vue island

```
hugo-apps/src/advocates/
  index.ts              # createApp(App).mount('#advocates-mount')
  App.vue               # page shell — fetches /api/advocates, owns filter state
  components/
    AdvocateCard.vue    # the flip card (front + back faces)
    HeaderBand.vue      # gradient header + slim metadata + chips + search
    WorldMap.vue        # 220×86 inline animated map (pure SVG/CSS)
    StickyMini.vue      # 48px collapsed header on scroll
    EmptyState.vue      # ui5-illustrated-message when filters return 0
    InitialsAvatar.vue  # fallback when hasPhoto=false
  composables/
    useAdvocateFilter.ts  # region + topic + search; URL-synced via #region=eu&topic=cap
    useFlipCard.ts        # hover flip + a11y (Enter/Space toggles is-flipped)
  styles/
    advocates.css        # Horizon tokens; gradient definitions; flip 3D
  shared/
    advocate-types.ts    # TS types matching /api/advocates response
```

A new entry in `hugo-apps/vite.config.ts` named `advocates` writes to
`hugo/static/js/advocates.js`. Goes through the Vite-vs-Hugo `js.Build`
collision check at `postbuild:apps`.

### Card behaviour

- **Front (region-tinted gradient hero):**
  - Americas: `#0070f2 → #6c3dff → #ff6db5` (blue → purple → pink).
  - EMEA: `#0a6ed1 → #1c63dc → #2b9fd8` (blue → teal).
  - APJ: `#7858d8 → #b056d1 → #f96fb0` (purple → pink).
  - Photo from `/api/advocates/:slug/photo?v={photoUpdatedAt}` (or
    `InitialsAvatar` fallback).
  - Name + pronouns + title + location + topic chips.
  - "hover to flip" legend (hidden after first interaction).
- **Back (deep blue):** linear gradient `#001a4f → #0a3d91 → #0070f2`, full
  bio, social links as Horizon icon buttons (one per `AdvocateLinks` row,
  brand-icon resolved by `kind`), "View profile →" link to whichever URL the
  advocate has marked as their primary (highest-priority `kind` per a fixed
  preference list: `Blog > SapCommunity > LinkedIn > GitHub > X > BlueSky >
  Mastodon > YouTube > Email`).
- **A11y:** card root is a `<button>` with `aria-pressed` reflecting flipped
  state; Enter/Space toggle; back-face focus traps within card while flipped;
  Escape returns focus to front and unflips.
- **Reduced motion:** `prefers-reduced-motion` swaps the 3D flip for an
  instant cross-fade.

### Header band

- Gradient: `#001a4f → #0a3d91 → #0070f2 → #6c3dff` with pink/purple radial
  accents.
- Single row: title + count metadata + region pills + topic chips + search +
  inline animated 220×86 world map.
- Stylized abstract map (three SVG blobs with pulsing dots colored by
  region). Clicking a dot is identical to clicking the matching region pill
  (single source of filter state). Pulse animation paused via
  `animation-play-state: paused` when the page is hidden
  (`document.visibilityState`) and on `prefers-reduced-motion`.
- Sticky collapsed strip (48 px) shows only title + active filter chips on
  scroll.

### Filter state

URL hash: `#region=eu&topic=cap&q=joule`. Same approach as `/browse/`
(PR #197):

- Pure `urlSync.ts` module, no Vue dependencies.
- Single 8-field watcher in `App.vue` with `flush: 'pre'`.
- Dependent assignments deferred past `nextTick` to avoid the watcher-clobber-
  on-mount issue documented in `feedback_vue_watcher_clobber_on_mount`.

### States

- **Loading:** skeleton cards during the initial `fetch('/api/advocates')` —
  same shimmer treatment as the U14 skeleton loaders.
- **Empty (filtered):** `ui5-illustrated-message` (per the U7 follow-up) with
  a "Clear filters" button.
- **Empty (unfiltered):** "No advocates published yet." with a link to
  `/admin-ui/#advocates-display` for users with the Admin role.
- **API error:** "Couldn't load advocates. Please try again." with a retry
  button. Logs to the existing client-side error pipeline.

### Bundle budget

Target ≤ 30 KB gzip for `advocates.js`. Inline SVG world map (~3 KB), no
chart library, no animation library. Vue 3 + shared composables already in
the chunk graph from other islands → marginal cost is small.

## Build, Deploy, Operations

### Build sequence

Fits the existing `npm run build:all` chain unchanged:

1. `npm run build:apps` → bundles `advocates.js` because the entry was added
   to `hugo-apps/vite.config.ts`.
2. `postbuild:apps` runs `tsx scripts/check-build-collisions.ts` — catches
   any collision between `advocates.js` and a Hugo `js.Build` output.
3. Hugo build picks up `hugo/content/developer-advocates/_index.md`
   automatically → `hugo/public/developer-advocates/index.html`.
4. `mbt build` then `cf deploy` ships everything through the existing MTA
   modules.

No new MTA modules. No CI changes. Schema-only in `db-deployer`. No
`srv-qa` cp-list audit *strictly required* (only one new lib file, contained
imports), but the transitive walk is run as a sanity check before merging.

### HDI deploy verification

Per the `feedback_hdi_deploys_can_wipe_data` lesson (2026-06-05): three new
entities with no FK changes to existing tables should not trigger reorgs,
but row counts of `Categories`, `Tags`, and `Tutorials` are snapshotted
before/after the first DEV deploy as cheap insurance.

### Routing

`approuter/xs-app.json` gets two new entries (placed before the catch-all):

```json
{
  "source": "^/developer-advocates(/.*)?$",
  "target": "$1",
  "service": "html5-apps-repo-rt",
  "destination": "tutorials-static",
  "authenticationType": "none"
},
{
  "source": "^/api/advocates(/.*)?$",
  "target": "/api/advocates$1",
  "destination": "tutorials-srv",
  "authenticationType": "none"
}
```

Both are `authenticationType: "none"` — public, like the existing
`/build/catalog` and `/api/qrcode` routes.

### Caching

- `/api/advocates` JSON: 60 s `max-age` + 600 s `stale-while-revalidate`.
  ETag from `MAX(modifiedAt)`. Admin save → public reflects in ~60 s.
- `/api/advocates/:slug/photo`: 86400 s `max-age`. ETag from `sha256`.
  Cache-bust via `?v={photoUpdatedAt}` in the `<img src>`.

### Environment

No new env vars. Photo upload uses existing `Admin` XSUAA scope. Public
reads use no auth.

### Sample data

- `db/data/com.sap.developers.ims-Advocates.csv` — 5 placeholder rows (one
  with Tom's name + role, four marked `TODO: replace with real advocate`).
  Provides on-screen data immediately post-deploy without waiting for an
  admin to populate.
- One linked `AdvocateLinks` row per placeholder (LinkedIn).
- No CSV photos — `hasPhoto=false`. `InitialsAvatar.vue` fills the gap.

## Testing

Three workspaces, matches the existing setup.

### Unit (`test/unit/advocates.test.js`, in-memory SQLite)

- Schema deploys cleanly.
- `processUpload` with sample JPG/PNG/WebP → produces correct dimensions +
  WebP MIME.
- `processUpload` rejects: oversized (> 5 MB), non-image MIME, animated GIF,
  invalid bytes, sharp metadata read failure.
- `GET /api/advocates` returns active rows only, sorted correctly, includes
  denormalized topics + links.
- `GET /api/advocates/:slug/photo` 404s when `hasPhoto=false`.
- Photo upload flips `hasPhoto=true` and stamps `photoUpdatedAt`.
- Slug auto-derivation handles unicode (`André Müller` → `andre-muller`) and
  collisions (`-2` suffix).

### Hybrid (`test/hybrid/advocates-photo-hana.test.js`, real HANA via `cds bind --exec`)

- Round-trip a real binary upload + read on HANA, validating the LOB-locator
  workaround (separate raw-SQL read after CDS QL metadata read). This is
  the test that actually exercises the gotcha `srv/lib/advocate-photo-store.js`
  exists to avoid.
- Cleanup uses the standard `__TEST__` slug prefix and `afterAll`.

### Smoke (`test/smoke/advocates.smoke.test.js`, HTTP against deployed URLs)

- `GET /developer-advocates/` → 200, body contains `<main id="advocates-mount">`
  and a script tag for `/js/advocates.js` (regex tolerant of Hugo minifier
  quote-stripping per `feedback_hugo_minifier_strips_quotes`).
- `GET /api/advocates` → 200 JSON with at least the 5 seeded rows.
- `GET /api/advocates/:seeded-slug/photo` → 404 (placeholders have no
  photos).

## Documentation

- New page `docs/developers/architecture/advocates.md` — entity model,
  photo pipeline, public API contract.
- One-line entry in
  [docs/developers/operations/testing-endpoints.md](../../developers/operations/testing-endpoints.md)
  for `/api/advocates` and `/api/advocates/:slug/photo`.
- Sidebar update in `docs/.vitepress/config.ts`. The `predocs:build` guard
  fails the build if it is forgotten.
- One-paragraph addition to the project `CLAUDE.md` Architecture section so
  future agents have orientation.

## Rollout

Single MTA deploy. No feature flag — empty-state illustration handles the
"no data yet" case.

1. Merge PR → CI builds + deploys to DEV.
2. Smoke tests confirm `/developer-advocates/` and `/api/advocates` reachable.
3. Admin (Tom) logs into `/admin-ui/#advocates-display`, replaces 5 seeded
   placeholder rows with the real roster (Fiori `MassEdit` available on
   List Report).
4. Public page reflects within ~60 s of save.
5. Update existing `developer-advocates.html` redirect on developers.sap.com
   to the new path (`/developer-advocates/`) — coordinated with the AEM
   redirect-tree owner per `project_aem_redirect_tree_access_blocked.md`.

No data migration. No backfill. No flag flip.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| HANA LOB-locator expiry on photo reads | Separate `AdvocatePhotos` entity + raw SQL read in `srv/lib/advocate-photo-store.js`; explicitly tested in the hybrid suite. |
| HDI deploy disturbs existing tables | Snapshot row counts of `Categories`, `Tags`, `Tutorials` before/after first DEV deploy. |
| Vite/Hugo `js.Build` collision | New entry name `advocates` checked by existing `postbuild:apps` collision script. |
| `srv-qa` cp-list drift | One new lib file (`advocate-photo-store.js`); added to cp list and transitive walk re-run before merge. |
| Hugo minifier strips quotes from smoke regex | Smoke regex pattern accepts both quoted and unquoted attribute forms. |
| Sharp-induced memory spike on 5 MB upload | Sharp processes streams; size cap enforced before sharp sees the bytes. |
| Photo cache LRU evicts under load | 10 MB cap is generous for ~50 advocates × ~25 KB. Revisit if catalog exceeds ~200 advocates. |
| `prefers-reduced-motion` users get queasy from flips | Card respects the media query — flip becomes instant cross-fade. |
| Map dot animation drains laptop battery | `animation-play-state: paused` when `document.visibilityState !== 'visible'` and on reduced-motion. |
| Slug collision on identical first+last names | Slug auto-derivation appends `-2`, `-3`, ... admin can override. |
| Long advocate name overflows card | Front uses `text-overflow: ellipsis`; back uses scrollable bio area. Tested at 40-char names. |

## Open Questions

None remaining at design time. All structural choices are decided:

- Edit access: Admin only (no per-advocate self-service in v1).
- Topics: linked to existing `Tags` registry (filterable on public page).
- Links: child entity with `kind` enum (extensible without schema change).
- Public delivery: runtime fetch via `/api/advocates`.
- Image storage: HANA BLOBs in separate `AdvocatePhotos` entity.
- Image processing: 256+64 WebP via sharp on upload.
- Layout: hybrid — gradient header band + slim metadata + inline animated
  world map.
- Card: A+C blend — gradient hero front, hover flip to deep-blue back.
- Detail page: none in v1.
- Audit/anonymization: change-tracking only; no `@PersonalData` (advocate
  info is published-by-intent).
