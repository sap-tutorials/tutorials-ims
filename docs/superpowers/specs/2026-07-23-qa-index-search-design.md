# Browsable QA Index with Search — Design

- **Date:** 2026-07-23
- **Status:** Approved (pending spec review)
- **Issue:** TBD
- **Author:** Tom (via Claude)

## Problem

The QA author-preview channel (`/tutorials-qa/*`) has no browsable entry point. To view a QA
preview today an author must already know the exact tutorial slug and construct
`/tutorials-qa/<slug>` by hand. There is no index, no grid, and no working search:

- `/tutorials-qa/` (root) **404s** — the approuter has no route for the bare root, so the
  catch-all `^/tutorials-qa/(.*)$` intercepts it and rewrites to srv-qa `/content/tutorials/`
  with an empty slug.
- `/tutorials-qa/search/` **404s by design** — `hugo.qa.toml` carries
  `ignoreFiles = ["^(missions|groups|me|search)/.*$"]`, so the search shell is never generated,
  even though an approuter route for it exists.

## What already exists (and why this is reconnect-and-repoint, not build-from-scratch)

- **`hugo/public-qa/index.html` IS built** by `npm run build:qa` — a full QA home carrying the
  shared `#tutorial-navigator` island (`/js/navigator.js`), a "Recently updated" grid, and a
  "Browse by topic" tag cloud, all with real `/tutorials-qa/tutorials/<slug>/` links.
- **srv-qa serves `SearchService`** — confirmed in `gen/srv-qa/srv/csn.json`
  (`SearchService`, `SearchService.Tutorials`) plus `gen/srv-qa/srv/odata/v4/SearchService.xml`.
  srv-qa has its own source dir (`srv-qa/`) with its own `server.js`, distinct from the main `srv/`.
- **The QA search proxy is already routed** — `^/qa-search/(.*)$` → `srv-qa-api` → `/search/$1`,
  XSUAA + `Tutorial.Author`. Search over `tutorials-hana-qa` works end to end at the API layer.
- **`fetch-tutorials.ts` is already channel-aware** — `parseChannel`, `getHugoContentDir`,
  `getNavJsonDir` all branch prod/qa. The one gap: `writeBrowseData` writes a hardcoded
  `BROWSE_DATA_FILE = join(HUGO_DATA_DIR, 'browse.json')` with no channel branch.

Two defects make the built QA home non-functional:

1. **Unreachable** — the root is not routed (see above).
2. **Points at the wrong backend** — the navigator island hardcodes `/search/`
   (`hugo-apps/src/navigator/useSearch.ts:82` in `buildFacetsUrl`, and `:181` for the
   `SearchableItems` fetch). On the approuter, `/search/*` routes to the **public prod** srv-api,
   not srv-qa. Result cards also hardcode `href: /tutorials/<slug>` (`useSearch.ts:33`,
   `mapToCardItem`), which for QA must be `/tutorials-qa/<slug>`.
   In addition, `TutorialNavigator.vue`'s `onMounted` (`:234-238`) fetches three more hardcoded
   **prod** endpoints: `/tutorials/_nav.json`, `/build/navigator`, `/build/my-progress`.

### Endpoint-repoint decision (post-approval discovery)

Reading the live island revealed more hardcoded prod fetches than the initial spec captured.
Decision (Tom, 2026-07-23): **repoint search + `/tutorials/_nav.json` + card href only.**

| Island fetch | Feeds | QA action |
|---|---|---|
| `/search/SearchableItems` + `getFacets` | live search | repoint via `searchBase` → `/qa-search` |
| `/tutorials/_nav.json` | tutorials list (search-result enrichment: isNew badges, slug→createdAt) | repoint via `navBase` → `/tutorials-qa` (route `^/tutorials-qa/_nav\.json$` already exists) |
| card `href` | grid + result links | repoint via `hrefBase` → `/tutorials-qa` |
| `/build/navigator` | missions/groups rails | **leave on prod** — rails are out of QA scope; unused on the flat-grid QA page |
| `/build/my-progress` | progress badges | **leave on prod** — user-global; prod and QA return the same rows |

Rationale: the two left-on-prod endpoints feed either out-of-scope UI (rails) or user-global data
(progress), so they carry no QA-vs-prod correctness risk. Repointing them would add srv-qa surface
for no functional gain and contradict the "no missions/groups rails" scope.

## Goal

A browsable QA index served at **`/tutorials-qa/`** (root), containing:

- A **full-catalog grid** rendered from build-time data (works with JS off).
- A **live search box** (≥ 2 chars) querying QA-published content via the existing
  `/qa-search` proxy, with facets.
- Result and grid cards linking to `/tutorials-qa/<slug>`.

Scope is **search + flat grid** — no missions/groups/for-you rails (QA content is tutorials only).

## Non-goals

- Prod-parity browse (rails, for-you personalization, mission/group hierarchy).
- Any change to prod (`/`, `/browse/`) search behavior — prod must remain byte-identical.
- Writes through the QA channel; QA remains read/preview only.

## Approach

**Config-driven reuse of the shared navigator island.** The same island code powers prod and QA;
QA passes two endpoint bases via mount `data-*` attributes. Defaults preserve exact prod behavior.

### Components

| # | Unit | File | Change |
|---|------|------|--------|
| 1 | Search + nav endpoints | `hugo-apps/src/navigator/useSearch.ts` | `buildFacetsUrl(term, taskTypes, experience, searchBase='/search')`, the `SearchableItems` fetch, and `mapToCardItem(item, tutorialsBySlug, hrefBase='/tutorials')` take base parameters. Defaults reproduce current prod strings exactly. |
| 2 | Endpoint config plumbing | `hugo-apps/src/shared/composables/useNavigatorFilters.ts` | Accept optional `searchBase`/`hrefBase`/`navBase` on `UseNavigatorFiltersOptions`; forward `searchBase`/`hrefBase` into the `useSearch({...})` call (`:314`); expose `navBase` for the `.vue` to use on its `_nav.json` fetch. |
| 3 | Mount config + nav fetch | `hugo-apps/src/navigator/TutorialNavigator.vue` | On setup, read `el.dataset.searchBase` / `navBase` / `hrefBase` from the `#tutorial-navigator` mount; pass into `useNavigatorFilters`; change the `onMounted` `fetch('/tutorials/_nav.json')` (`:235`) to `fetch(\`${navBase}/_nav.json\`)`. Absent attributes → defaults (`/search`, `/tutorials`). |
| 4 | QA browse.json | `scripts/fetch-tutorials.ts` | Make `BROWSE_DATA_FILE` channel-aware (`hugo/data/browse.json` → `hugo/data-qa/browse.json` for the qa channel), and invoke `writeBrowseData` on the QA run. `hugo.qa.toml` already sets `dataDir = "data-qa"`. |
| 5 | Root route | `approuter/xs-app.json` | Add `^/tutorials-qa/?$` → `localDir: static`, `target: /qa/index.html`, `authenticationType: xsuaa`, `scope: $XSAPPNAME.Tutorial.Author`. **Must be ordered before** the catch-all `^/tutorials-qa/(.*)$`. |
| 6 | QA template attrs | `hugo/layouts/tutorial-navigator/list.html` | On the `#tutorial-navigator` mount div (`:33`), emit `{{ if site.Params.qa }}data-search-base="/qa-search" data-nav-base="/tutorials-qa" data-href-base="/tutorials-qa"{{ end }}`. This layout already carries `site.Params.qa` conditionals, so the prod home stays untouched. |

Interfaces are entirely data-attribute / default-parameter based. No new modules, no shared mutable
state. Prod calls the same functions with defaults; QA passes two strings.

### Data flow

- **Initial grid (no query):** `npm run fetch-tutorials:qa` writes `hugo/data-qa/browse.json` →
  `npm run build:qa` bakes the full-catalog grid into `public-qa/index.html`
  (via the existing `#browse-data` JSON block / `.Site.Data.browse`). Renders with JS off.
  Freshness = last QA build.
- **Live search (≥ 2 chars):** island → `/qa-search/SearchableItems?...` + `/qa-search/getFacets(...)`
  → approuter → `srv-qa-api` → srv-qa `SearchService` over `tutorials-hana-qa`.
- **Card links:** `/tutorials-qa/<slug>` (both grid and search results).

### Request path

```
author → GET /tutorials-qa/            (XSUAA + Tutorial.Author)
       → approuter serves static /qa/index.html
       → navigator island boots, reads data-search-base=/qa-search, data-href-base=/tutorials-qa
       → initial grid from baked #browse-data
       → on type (≥2 chars): fetch /qa-search/SearchableItems + /qa-search/getFacets
       → approuter routes /qa-search/* → srv-qa-api → srv-qa SearchService → tutorials-hana-qa
       → cards link to /tutorials-qa/<slug>
```

## Error handling

All fail-soft; no new failure modes introduced.

- **`browse.json` missing / empty** → the existing graceful empty-state (the `#243` defensive
  default already present in `browse/list.html` and the home template) renders an illustrated
  "catalog being prepared" message; page chrome + search box stay usable.
- **`/qa-search` request fails** → the island's existing `searchError` banner ("Search request
  failed").
- **Unauthorized (no `Tutorial.Author`)** → approuter returns 403 (unchanged behavior).

## Testing

- **`hugo-apps/src/navigator/useSearch.test.ts`** — assert that with **default** bases the emitted
  URLs are byte-identical to today (`/search/SearchableItems...`, `/search/getFacets...`,
  `href: /tutorials/<slug>`), AND that QA bases produce `/qa-search/...` and `/tutorials-qa/<slug>`.
  This is the prod-safety invariant.
- **`hugo-apps/src/navigator/__tests__/navigator-regression.test.ts`** — extend the existing stub
  matcher to cover the `/qa-search/*` prefix; confirm no regression on the prod path.
- **`test/unit/approuter/xs-app-graph-routes.test.js`** — assert the new `^/tutorials-qa/?$` route
  precedes the catch-all `^/tutorials-qa/(.*)$` (order is load-bearing).
- **`scripts/check-xs-app-mta.ts`** — keep xs-app.json / mta.yaml in sync (existing guard).
- **`scripts/verify-qa-build.ts`** — add an assertion that `public-qa/index.html`'s `#browse-data`
  block is non-empty after a QA build.

## Rollout

1. Merge behind no flag — QA channel is internal-only (`Tutorial.Author` gated), so no user-facing
   exposure risk.
2. Requires a QA-channel deploy: `fetch-tutorials:qa` + `build:qa` must run before `mbt build`
   (the approuter copies `hugo/public-qa/.` → `static/qa/`), then MTA deploy. The new approuter
   route ships with the same deploy.
3. Verify at `https://tutorial-system-<env>-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/`
   after logging in with a `Tutorials Author` role-collection assignment.

## Open questions

None. All scoping decisions resolved during brainstorming:
- Scope: search + flat grid.
- Grid data: build-time `browse.json` (initial) + live `/qa-search` (typed queries).
- Entry URL: `/tutorials-qa/` root.
- Search backend: live `/qa-search` API.
- Approach: config-driven reuse of the shared navigator island.
