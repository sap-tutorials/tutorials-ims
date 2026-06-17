# Developer Advocates

In-codebase replacement for the legacy AEM `developer-advocates.html` page on
developers.sap.com. Single source of truth for the advocates roster, with
admin CRUD via Fiori Elements, public delivery via a Vue 3 island, and
photo storage in HANA.

Spec: [2026-06-17 design](../../superpowers/specs/2026-06-17-developer-advocates-design.md).

## Entities

Defined in [db/advocates.cds](../../../db/advocates.cds):

| Entity | Purpose |
| --- | --- |
| `Advocates` | Root entity. Fields: `slug`, `firstName`, `lastName`, `title`, `pronouns`, `location`, `region` (AMERICAS/EMEA/APJ), `bio`, `isActive`, `sortOverride`, `joinedDate`, `hasPhoto`, `photoUpdatedAt`. Slug auto-derived on create. `@odata.draft.enabled` for the admin Fiori UI. |
| `AdvocateTopics` | Composition. Joins to global `Tags` so the public page can filter by SAP product/topic. |
| `AdvocateLinks` | Composition. Social links by `kind` enum (LinkedIn / X / GitHub / Mastodon / BlueSky / YouTube / Blog / SapCommunity / Email / Other) with `url` + optional `label` + `sortOrder`. |
| `AdvocatePhotos` | Composition keyed by `advocate` association (1:1). Stores `photo256` + `photo64` as `LargeBinary @Core.MediaType`, plus `sha256`, `sizeBytes`, `uploadedAt`. |

Change-tracking is on for `Advocates`, `AdvocateTopics`, `AdvocateLinks` —
admin edits show up in the existing Changelog Fiori app at
`/admin-ui/#changelog-display`. **No `@PersonalData` annotations** —
advocate info is published-by-intent business directory data; tagging it
would incorrectly cascade through `_executeAnonymization` when the
advocate anonymizes their *learner* account.

## Public API

- **`GET /api/advocates`** — JSON list of active advocates, sorted by
  `(sortOverride NULLS LAST, lastName, firstName)` via `Intl.Collator`.
  Each row inlines denormalized topics (`{slug, label}` from joined
  `Tags`) and links. `ETag` derived from `MAX(modifiedAt)` across
  `Advocates` + `AdvocateTopics` + `AdvocateLinks`. `Cache-Control:
  public, max-age=60, stale-while-revalidate=600` — admin saves are
  visible publicly within ~60 s without a manual cache purge.
- **`GET /api/advocates/:slug/photo[?size=thumb]`** — WebP bytes from
  HANA. `ETag: "{sha256}"`, `Cache-Control: public, max-age=86400`.
  Returns 404 when the advocate has no photo or slug is unknown. Vue
  island falls back to `InitialsAvatar.vue`.

Both routes are mounted by [srv/routes/advocates-public.js](../../../srv/routes/advocates-public.js)
on `cds.on('bootstrap')` in [srv/server.js](../../../srv/server.js), and
the approuter exposes them as `authenticationType: "none"` ahead of the
otherwise XSUAA-gated `^/api/(.*)$` catch-all.

## Photo Pipeline

[srv/lib/advocate-photo-store.js](../../../srv/lib/advocate-photo-store.js)
takes raw upload bytes and produces the persisted shape the read path
serves. Steps:

1. Validate buffer + MIME header (jpeg / png / webp / gif).
2. Reject oversized (>5 MB) and animated-image (`sharp metadata.pages > 1`).
3. Resize to 256×256 WebP @ q85 (`photo256`) and 64×64 WebP @ q80 (`photo64`).
4. Compute `sha256` of `photo256` for the ETag.
5. Stamp `sizeBytes` and `uploadedAt`.

Triggered from the admin write path by `srv/handlers/advocate-handlers.js`:

- `before('CREATE'|'UPDATE')` on `AdvocatePhotos` and
  `before('NEW'|'PATCH')` on `AdvocatePhotos.drafts` runs the pipeline
  if the payload carries a `photo256`. The handler accepts both
  `Buffer` and `Readable` inputs (Fiori UploadSet streams; `toBuffer()`
  drains the stream).
- `after('CREATE'|'UPDATE')` flips `Advocates.hasPhoto = true` and
  stamps `photoUpdatedAt` for cache busting in the public `<img src>`.
- `after('DELETE')` flips `hasPhoto = false`.

## HANA Read Path

`LargeBinary @Core.MediaType` columns on HANA cannot be read alongside
metadata in a single CDS QL — the LOB locator expires before the
runtime consumes the bytes. `fetchPhoto(slug, size)` in
[srv/lib/advocate-photo-store.js](../../../srv/lib/advocate-photo-store.js)
splits the read into two raw `db.run()` SQL calls:

```sql
-- 1) slug → advocate_ID
SELECT "ID" FROM "com_sap_developers_ims_Advocates"
 WHERE LOWER("slug") = ?

-- 2) advocate_ID → BLOB
SELECT "<photo256|photo64>" AS "blob",
       "photoMimeType" AS "mimeType",
       "sha256" AS "sha256"
  FROM "com_sap_developers_ims_AdvocatePhotos"
 WHERE "advocate_ID" = ?
```

Mirrors the pattern already used in
[srv/lib/content-store.js](../../../srv/lib/content-store.js) for tutorial HTML.

On SQLite (unit tests) plain CDS QL works — but two CAP gotchas still
bite there:

1. `SELECT.from(AdvocatePhotos)` excludes `LargeBinary` columns from the
   default projection, so callers must list `'photo256'`, `'photo64'`
   explicitly in `.columns(...)`.
2. The `photo256`/`photo64` value comes back as a Node `Readable`
   stream, not a `Buffer`. The `toBuffer()` helper drains it.

A bounded LRU (10 MB, evicts oldest first) sits in front of the read
path. `_resetCache()` is exported for unit-test isolation.

## Public UI

[hugo-apps/src/advocates/](../../../hugo-apps/src/advocates/) is a Vue 3
island bundled by Vite to `hugo/static/js/advocates.js`. Mounted by the
Hugo template at
[hugo/layouts/developer-advocates/list.html](../../../hugo/layouts/developer-advocates/list.html).

Highlights:

- Hover-to-flip cards with region-tinted gradient hero (different palette
  for AMERICAS / EMEA / APJ).
- Slim gradient header band with title + count + region pills + topic
  chips + search + inline animated 220×86 world map. Map dot click
  filters by region; pulse animation auto-pauses on tab-hidden and on
  `prefers-reduced-motion`.
- Sticky 48 px collapsed strip via `IntersectionObserver` once user
  scrolls past the main mount.
- Filter state lives in the URL hash (`#region=eu&topic=cap&q=joule`)
  with `flush:'pre'` watcher deferred past `nextTick` to avoid the
  watcher-clobber-on-mount bug noted in PR #197.
- A11y: card root is `role="button"` + `tabindex=0` + `aria-pressed`;
  Enter/Space toggle, Escape unflips and refocuses; reduced-motion
  swaps the 3D flip for an instant cross-fade.
- Bundle budget: ≤ 30 KB gzip enforced by `advocatesBudget()` in
  [hugo-apps/vite.config.ts](../../../hugo-apps/vite.config.ts). Current
  shipping size is ~4.3 KB gzip.

## Admin UI

[app/admin/advocates/](../../../app/admin/advocates/) is a Fiori Elements
List Report → Object Page mounted at `/admin-ui/#advocates-display`. The
shell loads it as a `componentUsage` from
[app/admin-shell/webapp/manifest.json](../../../app/admin-shell/webapp/manifest.json).

UI annotations live in
[app/admin-annotations.cds](../../../app/admin-annotations.cds). Object
Page facets: Identity, Bio, Visibility, Topics (inline table with
Tags value-help), Social links (inline table). The photo upload
section is **not yet wired** in v1 — admins can use the OData
media-stream PUT or a future custom Section. The public photo serving
works end-to-end; this is a UX gap, not a functional one.

## Sample Data

**No CSV seeds.** Earlier drafts shipped placeholder rows in
`db/data/com.sap.developers.ims-Advocates.csv` etc., but CAP's HDI deployer
re-imports CSVs on every deploy as an UPSERT keyed on the row's primary
key — meaning admin edits to those rows would be silently reverted to the
CSV values on the next deploy. For an entity that admins actively edit,
that's a footgun. CSVs were removed (PR #397).

Net effect: a fresh deploy starts with zero advocate rows. Admins populate
the roster via the Fiori admin UI at `/admin-ui/#advocates`. Use the
List Report's Create button or `MassEdit` for bulk imports.

For local dev, the same applies — `cds watch` against in-memory SQLite
starts empty.

## Tests

- **Unit** ([test/unit/advocates/](../../../test/unit/advocates/)) — 38
  tests. Slug derivation, sharp pipeline (incl. rejections), `/api/`
  routes (sorting, ETag, 304, inactive exclusion), photo serve (LRU,
  HANA fallback), upload handler (mutation + stream input).
- **Hybrid** ([test/hybrid/advocates-photo-hana.test.js](../../../test/hybrid/advocates-photo-hana.test.js))
  — 4 tests, gated by `ALLOW_HYBRID_WRITES=true` + `cf login`. Round-trip
  the LOB-locator workaround on real HANA.
- **Smoke** ([test/smoke/advocates.smoke.test.js](../../../test/smoke/advocates.smoke.test.js))
  — HTTP against deployed approuter + srv URLs. Set `SMOKE_BASE_URL`
  and `SMOKE_SRV_URL` env vars.

## Lessons Captured As Memory

This implementation surfaced three CAP runtime gotchas that no
spec/plan reviewer caught without booting and writing real code. Each
is recorded as a memory entry for future me:

- `feedback_cap_explicit_fk_conflicts_with_association.md` — `key
  advocate_ID : UUID` + sibling `Association to Advocates` fails CAP
  compile; use `key advocate : Association` instead.
- `feedback_cap_esm_type_module_needs_esm_libs.md` — when
  `package.json` has `"type":"module"`, `srv/lib/*.js` must be ESM
  (`export function`); CJS `module.exports` modules fail at
  `cds run` boot even though Vitest's interop hides the problem in
  unit tests.
- `feedback_cap_largebinary_default_select_and_stream.md` —
  `LargeBinary @Core.MediaType` columns are excluded from default
  `SELECT.*` projections AND returned as Node `Readable` streams, not
  `Buffer`s.
