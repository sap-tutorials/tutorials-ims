# Devtoberfest configurable banner + overlaid CTA — design

**Date:** 2026-07-29
**Status:** approved (pending spec review)
**Related:** `2026-06-22-devtoberfest-homepage-design.md`, `2026-06-24-devtoberfest-config-multi-row-draft-design.md`, `2026-06-17-developer-advocates-design.md` (photo-upload pattern this mirrors)

## Problem

The Devtoberfest homepage (`/devtoberfest/`) renders a CSS-gradient header
built in the Vue island `hugo-apps/src/devtoberfest/DevtoberfestHome.vue`,
with the event title, date, TechEd/Devtoberfest logos, and a "Join the Fest"
CTA. SAP TechEd ships a designed **key visual** each year (a wide ~3:1
banner with all that text + a presenter photo baked in). Today, using it
would mean a code change + redeploy every Devtoberfest cycle.

We want the banner to be **event configuration**, uploaded through the
existing Devtoberfest admin Object Page and tied to the config row — so a
new Devtoberfest edition gets its own banner with no code change. The
"Join the Fest" CTA overlays the banner in the lower-right corner, and the
live event date/status continue to come from the API.

## Decisions (from brainstorming)

- **Header text:** the image *is* the banner visual. When a banner is
  present, the Vue-rendered title/date/logos are dropped (they'd duplicate
  the baked-in text); the **live API-driven date/status stays in the arcade
  strip below** the image (option 3).
- **CTA placement:** absolutely-positioned pill overlay, **lower-right**
  corner of the banner, with a subtle scrim for legibility over the
  presenter/background.
- **Responsive:** below 720px (matching the existing `.dtf-body`
  breakpoint) the CTA **reflows to its own bar beneath the banner** —
  overlay only where there's room.
- **Arcade strip:** kept as-is (`READY_PLAYER_1 · <live dates> · INSERT_COIN`),
  still driven by `/status`.
- **Storage & admin:** mirror the **Developer Advocates photo-upload
  pattern** exactly — binary in HANA, base64-over-OData bound action,
  `sharp` processing, anonymous public REST route, ETag/caching.
- **Seed:** the provided `key-visual-option1-banner-wide.png` is uploaded
  into the active DEV config via the new endpoint after deploy (NOT a CSV
  — binary + admin-editable; see the "CSV changes wipe editable columns"
  gotcha). Feature is fully functional empty (gradient fallback).

## Why mirror Advocates (not a Fiori UploadSet)

Confirmed in `srv/handlers/advocate-handlers.js:154-208`: a Fiori Elements
UploadSet against a **draft-enabled `Composition of one`** whose key IS the
parent association silently drops the uploaded bytes on activation. The
working path is a **bound OData action carrying base64 bytes**. Since
`DevtoberfestConfig` is `@odata.draft.enabled` and multi-row, the banner
composition has the identical shape, so we use the identical bound-action
approach.

## Architecture

```text
Admin (Devtoberfest Object Page, FE draft)
  → uploadBanner(imageBase64, mimeType)  [bound action on AdminService.DevtoberfestConfig]
    → sharp: resize to max-w 2000px WebP (q~82)
      → upsert DevtoberfestBanner (1:1 composition under DevtoberfestConfig)
        → flip DevtoberfestConfig.hasBanner + bannerUpdatedAt

Public Vue island (/devtoberfest/)
  GET /api/devtoberfest/status → { ..., bannerUrl }   (empty string when none)
  GET /api/devtoberfest/banner → WebP bytes from HANA (active config only)
    bannerUrl present → <img> banner + overlay CTA
    bannerUrl empty   → existing CSS-gradient header (fallback, unchanged)
```

## Data model (`db/devtoberfest.cds`)

Add to `DevtoberfestConfig`:

```cds
hasBanner        : Boolean default false;
bannerUpdatedAt  : Timestamp;
banner           : Composition of one DevtoberfestBanner on banner.config = $self;
```

New entity (mirrors `AdvocatePhotos`, `db/advocates.cds:92-103`):

```cds
entity DevtoberfestBanner {
  // 1:1 composition — the association IS the key (one banner per config row).
  key config    : Association to DevtoberfestConfig not null;
  image         : LargeBinary @Core.MediaType: mimeType;
  mimeType      : String(40)  @Core.IsMediaType default 'image/webp';
  sizeBytes     : Integer;
  sha256        : String(64);
  width         : Integer;
  height        : Integer;
  uploadedAt    : Timestamp;
}
```

Schema change → `cds build --production` regenerates the `hdbmigrationtable`
version bump (do NOT hand-edit the ALTER — see
`hdbmigrationtable-hand-edit-poisons-version-counter`). Run
`npx cds deploy --to sqlite::memory:` before commit.

## Service layer

### `srv/admin-service.cds` — projection + bound actions

On the `DevtoberfestConfig` projection (line 456) add:

```cds
action uploadBanner(imageBase64 : String, mimeType : String) returns DevtoberfestConfig;
action clearBanner() returns DevtoberfestConfig;
```

Expose the `DevtoberfestBanner` projection (mirrors
`AdvocatePhotos as projection` at line 869). Keep the
`@cds.server.body_parser.limit` consideration in mind — banner base64 is
larger than an avatar; set a limit adequate for a ~2000px WebP (a few
hundred KB → base64 ~+33%). Reuse/extend the existing limit annotation
Advocates already added (`srv/admin-service.cds:14`).

### `srv/handlers/devtoberfest-banner-handlers.js` — new

Mirror `srv/handlers/advocate-handlers.js` upload/clear actions:

- `uploadBanner`: strip optional `data:` prefix → `Buffer.from(base64)` →
  sharp resize (max-w 2000, WebP q82) → capture width/height/sha256/size →
  upsert `DevtoberfestBanner` by `config_ID` → flip
  `DevtoberfestConfig.hasBanner=true` + `bannerUpdatedAt`. Return refreshed
  config.
- `clearBanner`: `DELETE` banner row + flip `hasBanner=false`,
  `bannerUpdatedAt` cleared.
- Registered from `AdminService.init()` alongside `advocateHandlers.register`.

### `srv/lib/devtoberfest-banner-store.js` — new

Sharp pipeline + upsert helper (mirrors `advocate-photo-store.js` +
`advocate-photo-upsert.js`, but single wide rendition instead of 256/64
squares). Unit-testable in isolation.

### `srv/routes/devtoberfest-public.js` — extend

- New `GET /api/devtoberfest/banner` (anonymous): SELECT active config →
  its banner bytes via **raw `db.run()`** (LOB locator rule: never SELECT a
  HANA BLOB alongside metadata in one CDS QL query — see the
  `content-store.js` precedent). Headers: `ETag: "{sha256}"`,
  `Cache-Control: public, max-age=86400`. 304 on `if-none-match`. 404 when
  no active config or no banner.
- `statusHandler`: add `bannerUrl: config.hasBanner ? '/api/devtoberfest/banner' : ''`
  to the JSON response.

## Approuter (`approuter/xs-app.json`)

Extend the existing anonymous Devtoberfest allowlist entry (line 123)
`^/api/devtoberfest/(status|terms)$` → `^/api/devtoberfest/(status|terms|banner)$`
so the banner route is reachable unauthenticated ahead of the XSUAA
`^/api/(.*)$` catch-all. (Easy-to-miss step — same class as the
`xs-app.json route allowlist` gotcha.)

## Frontend (`hugo-apps/src/devtoberfest/`)

### `types.ts`
Add `bannerUrl: string` to `StatusResponse`.

### `DevtoberfestHome.vue`
- Compute `hasBanner = !!status.value?.bannerUrl`.
- Template: when `hasBanner`, render `<img class="dtf-banner-img" :src="status.bannerUrl" :alt="eventName">`
  inside `.dtf-header` and suppress the `.dtf-brand` text/logos block +
  gradient; the `.dtf-cta-wrap` becomes an overlay child of `.dtf-header`.
- When `!hasBanner`, render exactly today's header (fallback).
- Arcade strip + `.dtf-body` unchanged. All CTA states unchanged.

### `styles.css`
- `.dtf-header[data-has-banner]`: remove gradient/padding, `position:relative`,
  set an aspect-ratio box using stored width/height (via inline style or a
  CSS var) to prevent layout shift.
- `.dtf-banner-img`: `width:100%; height:auto; display:block; border-radius:12px`.
- `.dtf-cta-wrap` (overlay variant): `position:absolute; right/bottom`,
  z-index above image, with a translucent scrim behind the pill for
  legibility.
- `@media (max-width:720px)`: overlay reverts to static flow beneath the
  banner (a bar), matching the existing `.dtf-body` breakpoint.
- Dark-mode: the img has no gradient to swap; scrim tuned for both themes.

## Seed (post-deploy, DEV)

After the full deploy, upload `D:\tmp\devtoberfest\key-visual-option1-banner-wide.png`
into the active DEV `DevtoberfestConfig` by calling the `uploadBanner`
bound action (base64) — either through the Object Page UI or a scripted
OData call against the deployed admin service. NOT seeded via CSV.

## Testing

- **Unit:** `devtoberfest-banner-store` sharp pipeline (resize dims, WebP
  out, sha256/size) + upsert (insert vs update by `config_ID`); mirror
  advocate-photo tests.
- **Route:** `/api/devtoberfest/banner` → 200 + `ETag` + `Content-Type`,
  304 on matching `if-none-match`, 404 when active config has no banner /
  no active config.
- **Island:** image-vs-gradient-fallback rendering keyed on `bannerUrl`;
  overlay-vs-reflow at the 720px breakpoint.
- `npx cds deploy --to sqlite::memory:` (schema) before commit.
- `npm test` green.

## Deploy considerations

- **Full deploy required** — touches db schema (hdbmigrationtable bump),
  admin UI (bundle-gated: full `mbt build`, **no `--skip-build`, no `-m`
  scoping** — else stale admin UI ships), the srv, and approuter
  (`xs-app.json`). Use `npm run deploy -- --env dev`.
- **PR, not direct merge** to main.

## Out of scope (v1)

- Multiple banner renditions / art-directed mobile crop (single wide WebP
  + CSS for now).
- Focal-point / cropping controls in the admin UI.
- Automatic import of the banner from the TechEd/Planner system.
