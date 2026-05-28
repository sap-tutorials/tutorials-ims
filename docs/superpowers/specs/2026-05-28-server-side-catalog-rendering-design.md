# Server-side Rendering for Group & Mission Pages

**Issue:** [sap-tutorials/tutorials-ims#91](https://github.com/sap-tutorials/tutorials-ims/issues/91)
**Status:** Approved design — ready for implementation plan
**Date:** 2026-05-28

## Problem

Group and mission pages (`/tutorials/group-*`, `/tutorials/mission-*`) are pure DB content maintained through the Admin UI, but today they are rendered through the same pipeline as tutorial bodies: `fetch-tutorials.ts` reads them from `/build/catalog`, writes them as Hugo `.md` frontmatter files, Hugo builds HTML, and `publish-content.ts` ships that HTML back to HANA as `ContentFiles` BLOBs.

Because the slug list is captured at CI time, **any group or mission created or renamed after the last `rebuild-content.yml` run has no published HTML**. The `serveHandler` in [srv/lib/content-store.js](srv/lib/content-store.js) detects this and falls through to a synthesized fallback in [srv/lib/render-catalog-page.js](srv/lib/render-catalog-page.js) that emits a stripped-down page (no header, no footer, no joule panel, no breadcrumbs, no glossary popover, no cmd palette) with the warning comment "We deliberately do NOT reproduce baseof.html in full."

The result is Issue #91: edit a group title in the Admin UI → the URL works but the page looks broken until CI runs.

The pipeline exists for tutorials whose markdown is sourced from GitHub. Groups and missions never touch GitHub. Routing them through GitHub-fetch → Hugo build → HANA publish is a Rube Goldberg detour over data that started one DB query away.

## Goal

Move group and mission rendering out of the Hugo build and into the CAP backend. `/tutorials/group-*` and `/tutorials/mission-*` are rendered server-side from DB content, with chrome (header, footer, breadcrumbs, joule panel, lightbox, glossary, cmd palette, toast) byte-identical to what Hugo emits for tutorial pages today, so visitors can't tell the difference.

Tutorials remain Hugo-built — their content really does come from GitHub markdown.

## Non-goals

- **No change to tutorial-page rendering or storage.** `/tutorials/<tutorial-slug>` continues to serve gzipped HTML BLOBs from `ContentFiles`.
- **No new rendering engine for arbitrary content.** This is scoped to group + mission catalog pages.
- **No feature flag, no dual-path, no parity-test PR phase.** The system is pre-launch with one production group; we cut over directly and validate in DEV.
- **No removal of `GroupSlugRedirects` / `MissionSlugRedirects` tables.** They still handle bookmarks of pre-rename slugs and existing internal links.
- **No pixel-diff visual regression test.** Chrome shell is shared with Hugo output via the same CSS/JS bundles, so visual parity is structural.

## Detection signal

The existing `serveHandler` in [srv/lib/content-store.js](srv/lib/content-store.js) already inspects slug prefixes for the redirect lookup:

```js
if (slug.startsWith('group-') || slug.startsWith('mission-')) { ... }
```

The new rendering branch reuses this prefix test. No frontmatter, no annotation, no schema change.

## Architecture

```
Today:
  GET /tutorials/group-foo
    → AppRouter → CAP /content/tutorials/group-foo
    → ContentFiles BLOB lookup → serve gzipped HTML
    → if missing → stripped fallback (issue #91)

New:
  GET /tutorials/group-foo
    → AppRouter → CAP /content/tutorials/group-foo
    → prefix detect → renderCatalogPage()
        ├── load chrome shell from ContentFiles slug "__shell__" (cached)
        ├── load body data from Groups/Missions/Tutorials (DB)
        ├── render body HTML against same data the Hugo template used
        └── splice body into shell, return HTML
    → cache full HTML in existing LRU under key "render:group-foo"
```

The chrome shell is treated as a special `ContentFiles` slug (`__shell__`) that ships with every publish. Hugo emits it via a new `_shell` layout containing `baseof.html`'s chrome around a single `<!-- MAIN -->` marker. `publish-content.ts` extracts this file and uploads it alongside tutorial bodies. The shell is version-locked with tutorial markup through the existing `ContentManifest` mechanism: when a manifest activates, both shell and bodies switch atomically, and the existing `cache.invalidate()` call clears all `render:*` entries.

## Components

### `srv/lib/catalog-data.js` (new)

Pure DB access. Two exported functions:

- `loadGroupContext(slug)` → `{ group, tutorials }` or `null`
- `loadMissionContext(slug)` → `{ mission, groups }` (each group has nested `tutorials`) or `null`

Returns `null` for: slug not found, `published === false`, `status !== 'ACTIVE'`.

Adds these fields the current fallback omits, all needed for parity with `hugo/layouts/groups/single.html` and `hugo/layouts/missions/single.html`:

- `Tutorials.experienceTag` (mapped to `level`)
- `Tutorials.averageTimeToComplete` (mapped to `time`)
- `Tutorials.stepCount` if available; else derived (or omitted with empty span)
- `Tutorials.createdAt` (for the NEW-badge 31-day window from the existing Hugo template)
- `primaryTag`: first non-License tag, humanized
- `displayTags` per group/mission: union of child `displayTags`, dedup, drop `"License"` (which the existing license-icon partial handles separately), cap at 6

No HTML, no HTTP, no caching. ~150 lines.

### `srv/lib/catalog-renderer.js` (new — replaces `render-catalog-page.js`)

Pure rendering. Takes a context object and a chrome shell, returns `{ status, contentType, body }`.

- `renderGroupBody(ctx)` → body HTML string matching `hugo/layouts/groups/single.html`:
  - `.group-wrapper > breadcrumbs > .group-hero > .group-body > .tutorial-timeline`
  - level / totalTime / tutorialCount in `.group-meta`
  - `.tag-pill` row from `displayTags`, license icon if applicable
  - `.timeline-item > .timeline-card` per tutorial with NEW badge for fresh ones, primary tag chip, `.start-btn`
- `renderMissionBody(ctx)` → body HTML string matching `hugo/layouts/missions/single.html`:
  - `.mission-wrapper > breadcrumbs > .mission-hero > .mission-body > .groups-section`
  - `.group-card` per group with expand-collapse hook (the existing inline `onclick` from the Hugo template; first card auto-expanded in JS)
  - Inner `.group-tutorials > .tutorial-item` list with link to group page

HTML escaping helper applied to all DB-sourced strings. ~250 lines.

### `srv/lib/chrome-shell.js` (new)

Loads the chrome shell from `ContentFiles` slug `__shell__` lazily on first use, caches parsed `{before, after}` halves keyed by current `ContentManifest.version`. Reloads when version changes.

- `get()` → `{ before, after, version }` — splits on `<!-- MAIN -->` marker once
- `compose(before, after, body, pageMeta)` → full HTML, with attribute substitution for `data-page-kind`, `data-page-slug`, `data-page-title`, `<title>`, `<meta name="description">`
- Throws typed error if marker is missing or duplicated; caller catches and degrades to a minimal stripped shell (today's fallback shell) so a broken publish never 500s catalog requests
- ~80 lines

### `srv/lib/content-store.js` (modified)

- New branch in `serveHandler` after the slug-redirect lookup:
  ```js
  if (slug.startsWith('group-') || slug.startsWith('mission-')) {
    const cached = cache.get(`render:${slug}`)
    if (cached) return serveCachedHtml(cached, req, res)
    const rendered = await renderCatalogPage(slug)
    if (!rendered) return serveNotFound(res, slug)
    cache.set(`render:${slug}`, Buffer.from(rendered.body), hashBody(rendered.body))
    res.setHeader('X-Content-Source', 'rendered')
    return res.status(200).send(rendered.body)
  }
  ```
- Remove the existing fallback wiring (~15 lines). The `render-catalog-page.js` import is replaced by `catalog-renderer.js`.
- Add `cache.invalidateByPrefix(prefix)` helper on the `ContentCache` class.

Net delta: ~-30 / +50 lines.

### `srv/admin-service.js` (modified)

`after('UPDATE'|'CREATE'|'DELETE', ...)` hook on Groups, Missions, Tutorials, CompletionPathItems, GroupPathItems. Single helper that wraps `cache.invalidateByPrefix('render:')` in a try/catch (a future bug there must not fail the admin save). ~30 lines.

The cache surface is small (~150 entries max for the entire catalog). Coarse "flush all render entries" is correct and trivially cheap.

### `scripts/fetch-tutorials.ts` (modified)

Phase 4 ("Fetching missions & groups from CAP", lines ~813–1045) reduced to a minimal lookup that still populates `missionTitle`, `missionSlug`, `groupTitle`, `groupSlug` in tutorial-page frontmatter for the existing breadcrumb partial. The page-emission code (`writeMissionPage`, `writeGroupPage`, the orderly flatten + level/time aggregations) is deleted. Net delta: ~-300 lines.

### `scripts/publish-content.ts` (modified)

After uploading tutorial bodies, read `hugo/public/_shell/index.html`, slice out `<main>...</main>`, replace it with `<!-- MAIN -->`, and add the result to the upload payload as slug `__shell__`. Same publish round-trip, one extra entry. If shell extraction fails (Hugo didn't emit the file or the slice is empty), the script throws and CI fails loudly — never publish a partial set. ~30 lines.

### `hugo/layouts/_shell/single.html` (new)

A one-page layout whose only purpose is to emit `baseof.html`'s chrome around `<!-- MAIN -->`. Driven by a single `hugo/content/_shell/_index.md` so Hugo materializes it as `public/_shell/index.html`.

### `hugo/layouts/groups/single.html` + `hugo/layouts/missions/single.html` (deleted)

### `hugo-apps/src/tutorial-breadcrumbs/` (new)

Small JS island that fetches `/build/breadcrumb-context?tutorial=<slug>` on `DOMContentLoaded` and overwrites parent breadcrumb `<li>` text + href. Falls back silently to whatever's in the static HTML on error. Loaded via `<script>` tag from `baseof.html`. ~50 lines.

### `hugo/layouts/partials/breadcrumbs.html` (modified)

Add `data-bc-role="mission"` and `data-bc-role="group"` attributes to the parent `<li>` elements so the JS island can target them without brittle CSS-position selectors.

### `srv/build-routes.js` (modified)

New endpoint `GET /build/breadcrumb-context?tutorial=<slug>`. Looks up tutorial → parent group → parent mission, returns `{ missionTitle, missionSlug, groupTitle, groupSlug }`. Anonymous, public, cached `max-age=60`. ~30 lines.

## Data flow

### Request — cache miss

```
1. Browser → /tutorials/group-foo
2. AppRouter "^/tutorials/(.*)$" → CAP /content/tutorials/group-foo
3. content-store.serveHandler:
   a. slug validation, lowercase redirect, GroupSlugRedirects lookup (unchanged)
   b. NEW: prefix detect → catalog branch
   c. cache.get('render:group-foo') → miss
   d. catalog-data.loadGroupContext('foo'):
        SELECT Groups WHERE slug='foo'                  (1 row)
        SELECT GroupPathItems WHERE group_ID=? ORDER BY itemOrder
        SELECT Tutorials WHERE ID IN (...)              (incl. level, time, etc.)
   e. catalog-renderer.renderGroupBody(ctx) → body HTML
   f. chrome-shell.get() → { before, after, version }   (loaded once per manifest)
   g. chrome-shell.compose(before, after, body, pageMeta) → full HTML
   h. cache.set('render:group-foo', html, hash)
   i. ETag, Cache-Control: public, max-age=300, X-Content-Source: rendered
   j. res.send(html)
```

### Request — cache hit

Steps c, ETag check (existing helper), send. Microseconds.

### Publish

```
1. CI builds Hugo → public/_shell/index.html + tutorial bodies
   (no group/mission pages anymore)
2. publish-content.ts hashes each tutorial body
3. NEW: reads public/_shell/index.html, slices <main>, substitutes
   <!-- MAIN --> marker, adds as slug "__shell__"
4. POST /content/publish (existing endpoint, payload one entry larger)
5. content-store.publishHandler: new manifest version, atomic activate,
   cache.invalidate() clears LRU including all render: entries
6. Next catalog request → cache miss → loads new shell → renders → caches
```

### Admin write

```
1. Admin saves Group rename in admin-shell (draft activate)
2. AdminService.before/on(UPDATE) runs slug-rename + redirect logic (unchanged)
3. NEW: AdminService.after('UPDATE','Groups') hook → cache.invalidateByPrefix('render:')
4. Next /tutorials/group-* request → miss → fresh DB → fresh HTML
5. Same hook fires for Tutorials (title/level changes affect cards),
   CompletionPathItems and GroupPathItems (membership), Missions (rename)
```

### Tutorial breadcrumbs

```
1. Browser loads /tutorials/abap-rap-hello-world (static blob from HANA)
2. tutorial-breadcrumbs.ts island fires on DOMContentLoaded
3. fetch /build/breadcrumb-context?tutorial=abap-rap-hello-world
4. CAP returns { missionTitle, missionSlug, groupTitle, groupSlug } from current DB
5. Island finds breadcrumb <li> by data-bc-role attributes, overwrites text + href
6. On error → no-op, static text stays
```

## Error handling

The hierarchy is **fail-soft on chrome, fail-hard on data**.

- **DB lookup fails** (HANA timeout, connection drop): error propagates, `serveHandler` catches it (existing `try/catch`), logs `[content/serve:catalog]`, returns 500 via existing helpers. We do not serve a stale rendered cache entry on DB error.
- **Group/mission not found** / `published=false` / `status='INACTIVE'`: loader returns `null` → `serveNotFound` (existing path).
- **Shell load fails** (no `__shell__` row, e.g. fresh dev DB): `chrome-shell.get()` returns synthetic minimal shell (today's fallback shell), one-time WARN log: `chrome shell missing — degraded rendering until next publish`. Page renders with body but without joule panel / cmd palette / lightbox / glossary. Smoke test asserts `__shell__` exists in DEV after deploy.
- **Shell parse fails** (malformed marker): caught in `chrome-shell.get()`, ERROR log, falls back to minimal shell.
- **Cache corruption** (rare): manifest version mismatch reloads shell on next request; LRU is cleared on every `publishHandler` activation.
- **Admin-write hook fails**: in-memory `.delete()` loop in a `try/catch`. Cannot meaningfully fail.
- **Tutorial breadcrumb fetch fails**: island silently no-ops, static text stays. Worst case is stale parent text, never a broken page.
- **publish-content shell extraction fails**: script throws, CI fails non-zero. Whole publish aborts, prior manifest stays active. Production never sees a half-broken publish.
- **Slug-redirect interaction**: existing `GroupSlugRedirects` / `MissionSlugRedirects` lookup runs before the render branch (already early in `serveHandler`). Renamed group's old slug 301s to new slug → fresh request → fresh render.

## Testing

### Unit (`test/`, fast, no DB or network)

- `test/catalog-renderer.test.js` — feeds fixture `{group, tutorials}` and `{mission, groups}` into `renderGroupBody` / `renderMissionBody`:
  - All DOM hooks the existing CSS expects: `.timeline-item`, `.group-card`, `.timeline-card--new`, `.type-badge--group`, `.tag-pill`, `.start-btn`
  - level / totalTime / tutorialCount surfacing
  - NEW badge for `createdAt < 31 days`, not for older
  - HTML escaping (`<script>` payload in title → escaped)
  - Empty-tutorials group renders without crashing
- `test/chrome-shell.test.js`:
  - `parse()` splits cleanly on `<!-- MAIN -->`
  - `compose()` substitutes attrs, escapes special chars
  - Missing/duplicate marker → typed error
- `test/catalog-data.test.js` — uses existing `cds.test()` in-memory SQLite pattern from `test/admin-slug-history.test.js`. Asserts query shape, ordering, and the `published`/`status` filters.

### Hybrid (`test/hybrid/`, real HANA via `cds bind --exec`)

- `test/hybrid/catalog-renderer-hana.test.js` — load real Group + tutorials from HANA, render, assert chrome shell loads from `ContentFiles`, end-to-end HTML contains expected slug + tutorial titles. Validates HANA LOB locator behavior (the shell is a BLOB column; project memo "HANA LOB locator expiry" applies). Read-only; uses existing `_guard.js`.

### Smoke (`test/smoke/`, HTTP against deployed)

- `test/smoke/catalog-pages.test.js`:
  - GET `/tutorials/group-test-two` → 200, `text/html`, body contains `<ui5-popover id="glossary-popover"`, `<ui5-toast id="step-toast"`, `id="cmd-palette"`, `data-page-kind="group"`, group title, ≥1 tutorial link
  - GET `/tutorials/mission-<known-slug>` → same shape, `data-page-kind="mission"`
  - GET `/tutorials/group-does-not-exist` → 404
  - Response header `X-Content-Source: rendered` (proves new path, not leftover ContentFiles row)
  - Same URL twice → second response time < first (loose cache check)
- Existing smoke tests stay; their assertions don't reference Hugo group pages.

### Parity guard (one-time, manual)

`scripts/parity-check.js`: snapshot current DEV `/tutorials/group-test-two` HTML, deploy PR, snapshot again, structural diff (drop comments, normalize whitespace, ignore `data-cap-base`). Not a recurring test — used as a verification artifact attached to the PR description.

## Migration

Pre-launch system, one production group, no feature flag. Single PR, cut over directly, validate in DEV.

Steps in order so we never have a half-state in version control:

1. Add `srv/lib/catalog-data.js`, `catalog-renderer.js`, `chrome-shell.js` with unit tests passing
2. Add `hugo/layouts/_shell/single.html` + `hugo/content/_shell/_index.md`
3. Modify `scripts/publish-content.ts` to upload `__shell__`
4. Modify `srv/lib/content-store.js` `serveHandler` to use the new branch; delete `render-catalog-page.js` import
5. Modify `srv/admin-service.js` admin-write hooks
6. Modify `scripts/fetch-tutorials.ts` Phase 4 (drop `writeMissionPage`/`writeGroupPage`)
7. Delete `hugo/layouts/groups/single.html` + `hugo/layouts/missions/single.html`
8. Add `srv/build-routes.js` `/build/breadcrumb-context` + `hugo-apps/src/tutorial-breadcrumbs/` island + `breadcrumbs.html` data-bc-role attributes
9. Add hybrid + smoke tests
10. Deploy to DEV, run parity check, validate visually

After validation: delete `srv/lib/render-catalog-page.js` and its test (already obsolete after step 4 — kept until end as a fallback while iterating).

## Acceptance criteria

- `/tutorials/group-test-two` and `/tutorials/mission-<known-slug>` render with full chrome (header, footer, joule panel, lightbox, glossary, cmd palette, breadcrumbs) — visually indistinguishable from current Hugo-built pages aside from the bug-fix items below
- Editing a Group title or membership in the Admin UI is reflected on the next page load (no CI run required)
- Renaming a Group's slug → old URL 301s to new URL via existing `GroupSlugRedirects`
- Tutorial pages still show correct parent breadcrumb text after a Group rename, on the next request (via the new client-side breadcrumb island)
- `rebuild-content.yml` no longer emits group/mission HTML; `publish-content` payload size drops by ~150 entries
- All unit, hybrid, and smoke tests pass
- Issue #91 closes
