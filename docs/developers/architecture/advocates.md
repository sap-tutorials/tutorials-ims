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

## Per-advocate profile pages

Spec: [2026-06-27 per-advocate-profile design](../../superpowers/specs/2026-06-27-601-advocate-profile-pages-design.md).
Issue: [#601](https://github.com/sap-tutorials/tutorials-ims/issues/601).

Each active advocate has a stable, sharable URL of the form
`/developer-advocates/<slug>/` rendering a server-side HTML page (crawlable,
og:profile meta tags) with a Vue island that hydrates a tutorial list
fetched live from `/api/advocates/:slug`.

- **Single-advocate endpoint** — `GET /api/advocates/:slug` mounted by
  [srv/routes/advocates-public.js](../../../srv/routes/advocates-public.js)
  on `cds.on('bootstrap')`. Returns the same row shape as a list item from
  `/api/advocates` but as a single object (not wrapped in
  `{ advocates: [...] }`). 404 on unknown slug or `isActive: false`.
  `ETag` + `Cache-Control: public, max-age=60, stale-while-revalidate=600`.
  Lowercase slug comparison so `Thomas-Jung` resolves the same as
  `thomas-jung`. Both `handleAdvocates` and `handleSingle` share a
  `buildAdvocateLookups()` helper so list-vs-single response shapes stay
  in lockstep (and any future schema-driven field addition is a single edit).
- **Build step** —
  [scripts/fetch-advocates.ts](../../../scripts/fetch-advocates.ts)
  pulls `GET /api/advocates` at build time, renders each `bio` via
  `markdown-it` (`linkify: true`, `html: false`) and sanitizes via the
  `sanitize-html` npm package, then emits one `<slug>.md` per active
  advocate into `hugo/content/developer-advocates/`. Slugless rows are
  skipped defensively. Trailing UTF-16 surrogate halves are trimmed before
  emitting the 200-char `bioText` so emoji never split mid-codepoint.
  Stale per-slug files are cleaned up against the live roster;
  `_index.md` is never touched. The per-slug files are gitignored
  (`.gitignore` line near the existing `hugo/content/tutorials/` entry).
- **Wired into the build pipeline** — `npm run fetch-advocates` is a peer
  of `npm run fetch-tutorials` in [package.json](../../../package.json);
  `build:all` chains them. The CI `rebuild-content.yml` workflow runs a
  "Fetch advocates" step unconditionally (all three modes
  `catalog-only` / `slug-targeted` / `full`) so an admin advocate edit
  classified as `catalog-only` still regenerates the per-advocate pages.
- **Rebuild classifier** —
  [srv/lib/_classify-rebuild-mode.js](../../../srv/lib/_classify-rebuild-mode.js)
  treats CRUD on `Advocates`, `AdvocateTopics`, and `AdvocateLinks` as
  `catalog-only`. Admin saves trigger a debounced workflow dispatch that
  rebuilds the catalog + advocate pages within ~3-5 min.
- **Page rendering** —
  [hugo/layouts/developer-advocates/single.html](../../../hugo/layouts/developer-advocates/single.html)
  server-renders the hero (photo or initials fallback, name, pronouns,
  title, location, region, social-link icons) and bio (HTML from
  markdown, emitted with `safeHTML` since sanitization ran at build time).
  Topic chips link to `/developer-advocates/#topic=<slug>` so the
  existing
  [hugo-apps/src/advocates/composables/useAdvocateFilter.ts](../../../hugo-apps/src/advocates/composables/useAdvocateFilter.ts)
  filter composable picks them up on initial mount. Meta tags
  (`og:type=profile`, `og:title`, `og:description`, `og:image`,
  `profile:first_name`, `profile:last_name`) come from the centralized
  [head-og.html](../../../hugo/layouts/partials/head-og.html) partial
  which now branches on `.Type == "developer-advocates"`.
- **Hydration** —
  [hugo-apps/src/advocate-profile/](../../../hugo-apps/src/advocate-profile/)
  is a Vue 3 island bundled at `hugo/static/js/advocate-profile.js`
  (≤ 25 KB gzip enforced by `advocateProfileBudget()` in
  [hugo-apps/vite.config.ts](../../../hugo-apps/vite.config.ts); current
  size is < 1 KB gzip). Fetches `GET /api/advocates/<slug>` and renders
  the "Tutorials authored" + "Tutorials contributed to" sections.
  On 404 (advocate deactivated since the last rebuild) shows a small
  "no longer listed" banner. On generic 5xx error renders nothing —
  the static Hugo page is still complete.
- **Roster card → profile link** —
  [hugo-apps/src/advocates/components/AdvocateCard.vue](../../../hugo-apps/src/advocates/components/AdvocateCard.vue)
  "View profile →" button on the card back navigates to
  `/developer-advocates/<slug>/` (was: first matching external profile URL).
  External social-link icons on the card itself keep their original
  `target="_blank"` behavior.

### Out of scope for v1

These were considered and explicitly deferred (see spec Non-goals):

- **Missions and Groups attribution.** Only `Tutorials.author` exists in
  the schema today. `Missions` and `Groups` inherit from `TaskBase` with
  no `author` association. Surfacing "missions curated" or "groups
  curated" on profile pages would require a schema migration + admin UI
  + classifier wiring + backfill. Tracked as a follow-up.
- **Events authored.** Same reason — `Events` has no `author`
  association today.
- RSS / Atom feeds.
- Long-form embedded media in bios (videos, code samples) beyond what
  markdown can express.

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

## Admin OP data dependencies

The Advocate Object Page has two data dependencies that, if violated, cause
visible rendering issues. The bugs are documented in issue #638; the
operational fixes are scripts that have already been run on DEV but may
need re-running after future migrations or schema reseeding.

### Topics column shows the tag GUID

**Symptom:** The Topics inline table renders the tag's primary key (UUID)
instead of the human label.

**Root cause:** `Tags.label` is NULL for the referenced tag row.
`@Common.Text: tag.label` on `AdvocateTopics.tag_ID` resolves to null, and
FE V4 falls back to the FK GUID.

**Fix (re-run as needed):**

```bash
ADMIN_BEARER_TOKEN=<admin-XSUAA-token> npm run seed-tag-labels
```

The seeder harvests labels from the legacy AEM Solr endpoint and writes
them to `Tags.label`. See `scripts/seed-tag-labels.ts` for details.

### Linked User field shows '-'

**Symptom:** The Linked User field on the Identity tab shows a dash even
when a user IS linked.

**Root cause:** `Users.displayName` is NULL for the linked user. Migrated
rows often have firstName + lastName populated but displayName=null
(the IMS migrator never copied displayName). The OP's
`@Common.Text: user/displayName` resolves to null and FE V4 renders the
empty placeholder.

**Fix (re-run as needed):**

```bash
# Dry-run preview
npx cds bind --exec -- node scripts/backfill-users-displayname.cjs

# After confirming output:
npx cds bind --exec -- node scripts/backfill-users-displayname.cjs --commit
```

Script is idempotent. Safe to run any time displayName drift recurs (e.g.
after a fresh migration batch where IDP backfill hasn't yet fired).
