# Restore `sm_tech_ids` meta tags for the search crawler

**Date:** 2026-09-07
**Status:** Design — awaiting review
**Issue context:** AEM→tutorials-ims migration; search-team request (Frederique DUFY, wiki `https://wiki.one.int.sap/wiki/x/5Izyc`)

## Problem

The legacy AEM developers.sap.com pages emitted `<meta name="sm_tech_ids">`
tags carrying Semaphore/PPMS **meaning IDs** (product IDs). The site-search
crawler reads these IDs and expands each one into its full PPMS hierarchy
(product → product line → category) to power faceted filtering (product,
language, type, region). The wiki describes only how the crawler *reads*
Semaphore given an ID — our responsibility is limited to **emitting the seed
product IDs into page `<head>`**, exactly as AEM did.

An earlier (incorrect) assessment claimed these IDs were AEM-internal and had
no replacement. They are not: they are Semaphore IDs that were carried across
in the IMS migration. Their absence in the current output means migrated
documents cannot be filtered by the search crawler.

## What the data confirms (hybrid check, DEV HANA)

- `Tags.semaphoreId` (`String(255)`, added in #385 PR-1, backfilled in PR-2)
  is populated for **160/160** tag rows.
- **19** tags are `isActualTag = true` product tags — the population we emit.
- **2867/2931** tutorials (97.8%) link to at least one semaphore-bearing tag.
- Sample IDs (e.g. `7355…` prefix) and `titlePath` values
  (`Software Product : Technology Platform / SAP AI Services`) match the
  format the search team supplied.

The data is present and correct. This is purely an **emission** feature — no
schema change, no migration.

## Scope (approved)

- **Format:** one meta tag per page, `content="en-US,<id>,<id>,…"` — the
  literal locale `en-US` first (all current content is en-US), then the
  page's product semaphore IDs, comma-separated. No spaces.
- **Which IDs:** the semaphore IDs of the page's associated **product tags
  only** (`Tags.isActualTag = true` AND `semaphoreId` non-null). Non-product
  tags (topic/verb/etc.) and null-semaphore tags are excluded.
- **Which pages:** all content pages, in one change —
  - tutorials (Hugo-baked)
  - missions + groups (CAP SSR, served via `composeShell`)
  - topic **detail** pages `/topics/<slug>/` (CAP SSR, baked as `topic-<slug>`
    BLOBs by `publish-topics.js`)
  - **excluded:** `/browse/`, verb lanes, sitemaps, homepage, **the topics
    index `/topics/`**, concepts, puzzles, channels — aggregate/navigation
    pages with no single product-tag identity.

## The join key (resolved)

Tutorial frontmatter tag slugs (`primaryTag`, `tags`, `displayTagSlugs`) are
in **mdFormat** (e.g. `software-product>sap-hana-cloud`). `Tags.titlePath`
stores the **human form** (`Software Product : Technology Platform / SAP HANA`).
The two are related by the deterministic, Java-`TagUtil`-parity transform
`titlePathToMdFormat(titlePath)` (`srv/lib/tag-md-format.js`, guarded by
`srv/__tests__/lib/tag-md-format.test.js`).

`/build/tags` already uses exactly this transform to emit the canonical
frontmatter-tag set (`srv/server.js:480`). **We key the semaphore map on
`titlePathToMdFormat(titlePath)`** so it joins to frontmatter tag slugs the
same proven way.

> Note: `srv/lib/tag-label-map.js` keys its map on raw `titlePath` while its
> comment claims slug form — a latent inconsistency in that module. We do NOT
> depend on it; keying on `titlePathToMdFormat` sidesteps the ambiguity.

## Architecture

One shared resolution module feeds two emission paths (build-time for Hugo,
runtime for SSR), each ending at the same `<meta name="sm_tech_ids">` output.

```
                        srv/lib/semaphore-tags.js
                        ┌───────────────────────────────────────┐
                        │ getSemaphoreMdMap(db)                   │
                        │  → { [mdFormat]: semaphoreId }          │
                        │    (isActualTag=true, semaphoreId≠null) │
                        │ formatSmTechIds(ids, locale='en-US')    │
                        │  → "en-US,<id>,<id>"  ('' when no ids)   │
                        └───────────────────────────────────────┘
                             │                          │
             build-time      │                          │   runtime (SSR)
                             ▼                          ▼
   GET /build/tag-semaphore                  loadMissionContext / loadGroupContext
   (srv/server.js, anon, 60s cache)          publish-topics.js (topic detail)
        │                                        │ resolve entity's product tags → ids
        ▼                                        ▼
   fetch-tutorials.ts fetchSemaphoreMap()   pageMeta.smTechIds = [ids]
        │                                        │
        ▼                                        ▼
   render-frontmatter.ts                     composeShell() INSERTS
   → fm.smTechIds: string[]                  <meta name="sm_tech_ids" …>
        │
        ▼
   head-meta.html emits <meta name="sm_tech_ids" content="en-US,…">
```

### Component 1 — `srv/lib/semaphore-tags.js` (new)

Single source of truth for the mapping and the format string.

- `getSemaphoreMdMap(db)` → `Promise<Record<mdFormat, semaphoreId>>`.
  Selects `titlePath, semaphoreId` from `Tags` where
  `isActualTag = true AND semaphoreId != null`; keys by
  `titlePathToMdFormat(titlePath)`, drops empty mdFormat. Duplicate mdFormat
  keys: last-write-wins (deterministic — mirrors `/build/tags` dedupe).
- `formatSmTechIds(ids, locale = 'en-US')` → string. Returns `''` for an
  empty/nullish list (caller then emits **no** meta tag). De-dupes IDs,
  preserves first-seen order, prefixes locale: `en-US,id1,id2`.

Reachable from `content-store.js`? Its `getSemaphoreMdMap` is used only by the
build feed; the SSR resolution lives in `catalog-data.js` and
`publish-topics.js`, which are already `srv-qa` cp-list members. The new file
must be added to the `srv-qa` `cp` list in `.deploy/mta.yaml` **only if** it
becomes a transitive `./` import of `content-store.js`; audit at
implementation time.

### Component 2 — `/build/tag-semaphore` feed (new, `srv/server.js`)

Mirrors `/build/tags`/`/build/tag-labels`: anonymous route registered before
CDS auth, reads `db` directly, `Cache-Control: public, max-age=60`, 500s on
error. Returns `{ map: { [mdFormat]: semaphoreId }, buildAt }` from
`getSemaphoreMdMap(db)`.

### Component 3 — build-time frontmatter (`fetch-tutorials.ts`, `render-frontmatter.ts`)

- `fetch-tutorials.ts`: add `fetchSemaphoreMap()` alongside
  `fetchTagLabelRegistry()` (~line 623); parallel fetch; pass the map into the
  render args. Fail-open: on fetch error, empty map → no `sm_tech_ids` emitted
  (matches the tag-label registry's fail-open posture).
- `render-frontmatter.ts`: add `semaphoreMap?: Record<string,string>` to
  `RenderHugoFrontmatterArgs`. Compute
  `fm.smTechIds = dedupedRawSlugs.map(s => semaphoreMap[s]).filter(Boolean)`
  (dedupe preserved). Omit the key entirely when empty (no stray frontmatter).

### Component 4 — Hugo emit (`hugo/layouts/partials/head-meta.html`)

Adjacent to the existing `keywords` emit (lines 15–17):

```go-html-template
{{- with .Params.smTechIds }}
<meta name="sm_tech_ids" content="en-US,{{ delimit . "," }}">
{{- end }}
```

`with` skips emission when the slice is absent/empty. Because `head.html`
passes the full `Page` object to `head-meta.html`, this reaches every Hugo
page type — but only tutorials populate `smTechIds`, so only they emit it.

### Component 5 — SSR emit: `composeShell` + its opt-in callers

`composeShell` currently only *rewrites* baked meta tags. The `_shell` BLOB
carries no `sm_tech_ids` placeholder (the `_shell` Hugo page has no
`smTechIds` param), so we **insert** rather than replace — **once, inside
`composeShell`** so every caller benefits from one code path:

- In `composeShell({before, after}, bodyHtml, meta)`: when
  `meta.smTechIds?.length`, inject
  `<meta name="sm_tech_ids" content="{formatSmTechIds(meta.smTechIds)}">`
  immediately **after** the description-meta rewrite anchor. Idempotent:
  strip any pre-existing `sm_tech_ids` meta first (matching the module's
  defensive `.replace` style). `content` escaped via existing `escapeAttr`.
  When `meta.smTechIds` is absent/empty, no meta is emitted — a no-op for
  every caller that doesn't opt in.

`composeShell` has many callers (concepts, puzzles, channels, topics **index**,
topic **detail**, group/mission serve). The emit is purely opt-in: a page
carries `sm_tech_ids` **only if its caller populates `meta.smTechIds`**. The
two callers that opt in:

- **Group / mission serve** — `content-store.js:1205` calls
  `composeShell(shell, rendered.body, rendered.pageMeta)`, so `pageMeta`
  **is** the `meta` arg. `catalog-data.js` `loadMissionContext` /
  `loadGroupContext` resolve the entity's product tags
  (`MissionTags` / `GroupTags` → `tag_ID` → `Tags` where
  `isActualTag = true AND semaphoreId != null`) and attach
  `smTechIds: string[]`; `catalog-renderer.js` copies it into `pageMeta`.
  Read `Tags.semaphoreId` directly (SSR has the rows — no mdFormat round trip).
- **Topic detail** — `publish-topics.js:84` calls
  `composeShell(shell, body, meta)` for each `topic-<slug>` BLOB. A topic *is*
  a tag: `buildTopicDetailPayload` (`topics-query.js`) carries the tag's own
  `semaphoreId`; publish-topics sets `meta.smTechIds = [semaphoreId]` **only
  when** the topic tag is `isActualTag` with a non-null `semaphoreId` (else
  left unset → no meta).

Concepts, puzzles, channels, and the topics index deliberately do **not** set
`meta.smTechIds`, so they emit nothing — matching approved scope. Adding any
of them later is a one-line `meta.smTechIds = …` at that caller; no
`composeShell` change.

Fail-open everywhere: any resolution error → empty list → no meta tag; never
throw into the render/serve/publish path.

## Data flow summary

| Page type | Resolution | Emission site |
|-----------|-----------|---------------|
| Tutorial | build: `/build/tag-semaphore` map, frontmatter tags → ids | `head-meta.html` |
| Mission | runtime: `MissionTags` → `Tags.semaphoreId` → `pageMeta.smTechIds` | `composeShell` insert (via `content-store.js:1205`) |
| Group | runtime: `GroupTags` → `Tags.semaphoreId` → `pageMeta.smTechIds` | `composeShell` insert (via `content-store.js:1205`) |
| Topic detail | publish: topic tag's own `semaphoreId` → `meta.smTechIds` | `composeShell` insert (via `publish-topics.js:84`) |
| Topics index, browse, verb, sitemap, home, concept, puzzle, channel | — (caller leaves `meta.smTechIds` unset) | none |

## Error handling

- Every path fails **open**: missing/erroring data → no `sm_tech_ids` meta,
  never a broken page or a thrown error into serve/render.
- The `/build/tag-semaphore` fetch mirrors the tag-labels fetch: a build-time
  failure logs and yields an empty map (tutorials build without the meta).
- No new env flags; feature is always-on emission of already-migrated data
  (it restores prior behaviour, not a gated experiment).

## Testing

- **Unit (`srv/lib/semaphore-tags.js`):** `getSemaphoreMdMap` keys by
  mdFormat, excludes non-product/null-semaphore tags, last-write-wins on dup
  mdFormat; `formatSmTechIds` — locale prefix, dedupe, order, `''` on empty.
- **Unit (`titlePathToMdFormat` parity):** already covered; reuse as the join
  contract.
- **Unit (`render-frontmatter`):** emits `smTechIds` for a tutorial whose tags
  hit the map; omits the key when none match.
- **Unit (`composeShell`):** inserts one meta when `meta.smTechIds` present;
  no meta and no-op when absent; idempotent (no duplicate on re-compose);
  attribute-escaped.
- **Unit (`head-meta.html`):** existing Hugo partial test harness (if present)
  — assert `<meta name="sm_tech_ids" content="en-US,…">` renders for a page
  with `smTechIds` and is absent otherwise.
- **Hybrid (`test/hybrid`):** against DEV HANA, assert `/build/tag-semaphore`
  returns a non-empty map and at least one known product tag
  (`software-product>*`) maps to a `7355…`-style ID. (Reuses the existing
  #385 hybrid test's HANA binding.)
- **Smoke (post-deploy):** `curl` a known tutorial, a known mission, and a
  known `/topics/<slug>/` product-tag detail page; grep the served HTML for
  `name="sm_tech_ids"` with a locale-prefixed content. Confirm the topics
  **index** `/topics/` and a `/browse/` page emit **none**.
- Emit format is byte-checked against the search team's expected shape before
  PROD (locale-first, comma-joined, no spaces).

## Out of scope / follow-ups

- Multi-locale content: locale is hardcoded `en-US` (only locale today). If
  localized content lands, `formatSmTechIds`'s `locale` param is the seam.
- Language/type/region dimensions the legacy AEM tags also carried: **not**
  restored — approved scope is locale + product IDs only.
- Homepage `/`: excluded (aggregate page); revisit only if search asks.
- Fixing `tag-label-map.js`'s key-form comment/behaviour inconsistency: noted,
  not in scope (we don't use it).

## Files touched

- `srv/lib/semaphore-tags.js` — **new**
- `srv/server.js` — new `/build/tag-semaphore` route
- `srv/lib/chrome-shell.js` — `composeShell` insertion (single, opt-in on `meta.smTechIds`)
- `srv/lib/catalog-data.js` — resolve mission/group product tags → `smTechIds`
- `srv/lib/catalog-renderer.js` — copy `smTechIds` into `pageMeta`
- `srv/lib/topics-query.js` — carry topic tag's `semaphoreId` in the detail payload
- `srv/lib/publish-topics.js` — set `meta.smTechIds` for product-tag topics
- `scripts/fetch-tutorials.ts` — `fetchSemaphoreMap()`
- `scripts/parsers/render-frontmatter.ts` — `smTechIds` frontmatter field
- `hugo/layouts/partials/head-meta.html` — emit meta (after keywords, line 17)
- tests as above; `.deploy/mta.yaml` srv-qa cp-list audit if new lib becomes a
  content-store transitive dep (`publish-topics.js` / `catalog-data.js` are
  already cp-list members).
