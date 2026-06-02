# `/browse/` — Discovery-Center-style Alternative Homepage — Design

- **Issue:** [#174](https://github.com/sap-tutorials/tutorials-ims/issues/174)
- **Depends on:** [#195](https://github.com/sap-tutorials/tutorials-ims/issues/195) / [#197](https://github.com/sap-tutorials/tutorials-ims/pull/197) (URL sync — landed in `main`)
- **Date:** 2026-06-02
- **Author:** Claude (with Tom's design decisions)

## Problem

The current homepage at `/` ([hugo/layouts/index.html](../../../hugo/layouts/index.html)) stacks five sections vertically: navigator (with filters above the grid) → hero → featured missions → recently updated tutorials → topic chips. Tiles are constrained to a 1200px max-width container leaving room for only three columns at desktop, the navigator's filter chips compete with the tile grid for vertical space, and the curation sections (featured / recent / topics) duplicate content the navigator already surfaces when filtered.

Tom's reference image — SAP Discovery Center Missions — uses a different IA: compact title banner → left filter rail (~280px) → right column with curation rails *above* a sortable filterable grid that takes the full remaining horizontal space. The ask is structural, not visual: same Horizon styling, same tile aesthetics, just rearranged so tiles dominate the visual real estate and filters are persistently accessible without consuming grid space.

## Goal

Ship an alternative homepage layout at `/browse/` that mirrors the Discovery Center IA. Both `/` and `/browse/` coexist during an A/B test; whichever wins becomes the default after the test concludes.

## Non-goals

- Replacing `/`. The new layout is a parallel surface; cutover is a separate decision after the A/B.
- A new visual design language. Same Horizon tokens, same card components.
- A "Categories" facet beyond today's tag filters (filed as followup).
- Personalized recommendations on `/browse/` (filed as followup).
- Adding sort to the existing navigator on `/` (filed as followup).
- SSR on `/` (filed as followup; reuses this work's plumbing).
- Server-personalized SSR. Per-user data stays CSR-only; SSR handles catalog data only.

## Locked design decisions

Captured from Tom's `AskUserQuestion` answers during brainstorming.

| # | Question | Decision |
|---|---|---|
| 1 | Replace `/` or coexist? | Coexist at a new route during A/B |
| 2 | Route name | `/browse/` |
| 3 | Filter rail contents | One-to-one port of today's filters (search, types, levels, products, topics, isNew, noLicense) |
| 4 | Right-side rails | Two rails (Featured missions + Recently added) above full grid; both hide when any filter or search is active |
| 5 | Title banner | Compact banner only; surfaced via *both* a pill on `/` and a shellbar "Browse" item |
| 6 | Sort control | Full sort dropdown — Relevance (default), Recently updated, Recently added, Title A→Z, Time-to-complete (short→long) |
| 7 | Mobile breakpoint | Off-canvas drawer + filter button below 1024px; persistent left rail at ≥1024px |
| 8 | URL persistence | Reuse `urlSync.ts` from #195 verbatim; add `?sort=` independently in `/browse/` page code |
| 9 | Build approach | Extract `useNavigatorFilters()` composable + shared card components in `hugo-apps/src/shared/cards/`; build a fresh `BrowsePage.vue` |
| 10 | SSR vs CSR | Full SSR — Hugo emits rails+grid statically; Vue island hydrates over the rendered DOM |
| 11 | Data freshness | Piggyback on `rebuild-content.yml` for tutorial pushes AND wire admin writes (missions/groups/featured) to trigger the workflow (debounced) |
| 12 | Pagination | SSR honors `?page=N` for first paint; subsequent page navigation is CSR using in-memory dataset (page 1 SSR'd by default) |
| 13 | Per-user state | SSR catalog data, CSR per-user data; `<ClientOnly>` boundary at "catalog vs user"; animated draw-in for progress rings on hydration with `prefers-reduced-motion` guard |
| 14 | Search location | Search lives in the top banner (full-width), plumbs through `useNavigatorFilters` composable |
| 15 | Accessibility | Full ARIA landmark coverage with skip-link, banner, complementary rail, main, labeled sections |
| 16 | Followups | File 6 followup issues as children of #174 immediately after design commit |

## Architecture

### Module map

```
hugo-apps/src/
  shared/
    cards/                                    [NEW]
      MissionCard.vue                         shared markup, no per-user state
      GroupCard.vue
      TutorialCard.vue
      ProgressOverlay.vue                     CSR-only ring + completed badge
      types.ts                                CardItem props (re-export)
    composables/
      useNavigatorFilters.ts                  [NEW]
      useNavigatorFilters.test.ts             [NEW]
  navigator/
    TutorialNavigator.vue                     [CHANGED] thinned: cards & filter state extracted
    main.ts                                   [UNCHANGED]
    cardProgress.ts                           [UNCHANGED] still used by ProgressOverlay
    urlSync.ts                                [UNCHANGED] reused as-is from #195
    useSearch.ts                              [UNCHANGED]
  browse/                                     [NEW]
    main.ts                                   createSSRApp(BrowsePage).mount('#browse-root')
    BrowsePage.vue                            top-level: banner + rail + main
    BrowseFilterRail.vue                      left rail with form + facet groups
    BrowseRail.vue                            curation rail (Featured / Recently added)
    BrowseSortDropdown.vue                    sort UI bound to ?sort=
    BrowseGrid.vue                            paginated card grid
    browseUrl.ts                              ?sort= read/write helpers
    __tests__/
      BrowsePage.hydration.test.ts
      browseUrl.test.ts
      card-template-parity.test.ts

hugo/
  layouts/
    browse/
      list.html                               [NEW] SSR template for /browse/
      _partials/
        card-mission.html                     [NEW] Hugo mirror of MissionCard.vue
        card-group.html                       [NEW] mirror of GroupCard.vue
        card-tutorial.html                    [NEW] mirror of TutorialCard.vue
        rail.html                             [NEW] curation-rail wrapper
        filter-rail.html                      [NEW] filter form (rehydrated)
  content/
    browse/
      _index.md                               [NEW] minimal frontmatter, type=browse
  data/
    browse.json                               [NEW, gitignored] catalog dump
  assets/css/
    browse.css                                [NEW] page layout (left-rail grid, banner, drawer)

scripts/
  fetch-tutorials.ts                          [CHANGED] add writeBrowseData()

srv/
  server.js                                   [CHANGED] admin write hooks call rebuild-trigger
  lib/
    rebuild-trigger.js                        [NEW] debounced workflow_dispatch helper
    __tests__/rebuild-trigger.test.js         [NEW]

.github/workflows/
  rebuild-content.yml                         [CHANGED] add workflow_dispatch input "trigger-source"
```

### Boundary contract

| Module | Owns | Depends on | Public surface |
|---|---|---|---|
| `useNavigatorFilters` | reactive filter state, debounced URL sync, localStorage persistence, computed filtered cards, sort | `urlSync.ts`, `useSearch.ts`, `browseUrl.ts` (sort only on browse caller) | `useNavigatorFilters({ allCards, enableSort? }) → { searchQuery, filters, currentPage, sort, displayedItems, clearFilters, ... }` |
| `shared/cards/*` | card DOM markup & CSS, identical between `/` and `/browse/` | `cardProgress.ts` (via ProgressOverlay) | Component props: `{ item: CardItem, progress?: ProgressPayload }` |
| `ProgressOverlay` | per-user ring + badge, animated draw-in on mount | `cardProgress.ts` | `{ item, progress }` — renders nothing when no progress |
| `urlSync.ts` | URL ↔ `NavState` translation | none | unchanged from #195 |
| `browseUrl.ts` | `?sort=` read/write only | URLSearchParams | `readSort(href)`, `writeSort(href, sort)`; default `'relevance'` |
| Hugo `browse/list.html` | SSR rails + first page of grid | `hugo/data/browse.json` | renders DOM that `BrowsePage.vue` hydrates over |
| `BrowsePage.vue` | hydrate SSR DOM, fetch user progress, manage layout state (drawer open) | `useNavigatorFilters`, `shared/cards/*` | mounts on `#browse-root` via `createSSRApp().mount()` |
| `rebuild-trigger.js` | debounced `workflow_dispatch` to `rebuild-content.yml` | `@octokit/rest` (existing dep), `GITHUB_DISPATCH_TOKEN` env | `triggerRebuild(reason)` — dedupes within 60s window |

### Hydration boundary

The single rule: **if it comes from the catalog, SSR it. If it comes from the user, CSR it. No exceptions.**

#### `<ClientOnly>` implementation note

Vanilla Vue 3 does not ship a `<ClientOnly>` component (it's a Nuxt/VitePress convention). The implementation will provide a small local wrapper at `hugo-apps/src/shared/ClientOnly.vue` (~10 lines) using an `onMounted`-gated `v-if`:

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'
const mounted = ref(false)
onMounted(() => { mounted.value = true })
</script>

<template>
  <slot v-if="mounted" />
</template>
```

This component is reused by `ProgressOverlay` and any other CSR-only subtree. It's intentionally trivial so the hydration test (`BrowsePage.hydration.test.ts`) can reason about it: the SSR pass renders nothing inside the slot, and the post-mount paint adds it without a hydration mismatch warning.

| Bit | Origin | SSR? | Hydration behavior |
|---|---|---|---|
| Card chrome (title, desc, type lozenge, level, time) | catalog (`hugo/data/browse.json`) | yes | hydrates in place |
| `isNew` badge | catalog | yes | hydrates in place |
| `requiresLicense` icon | catalog | yes | hydrates in place |
| Card href | catalog | yes | hydrates in place |
| Featured rail content | catalog | yes | hides on filter/search via class toggle |
| Recently-added rail | catalog | yes | same |
| First page of grid | catalog | yes | hydrates in place |
| Pages 2+ of grid | catalog | no | CSR after mount; `?page=N≥2` re-renders client-side from in-memory dataset |
| Progress ring | per-user `/build/my-progress` | no | CSR-only, animated draw-in on mount, `prefers-reduced-motion` respected |
| `userStatus` annotation | per-user | no | CSR-only |
| Sort dropdown initial value | URL (`?sort=`) | yes | renders selected value statically; hydrates without re-render |
| Sort changes | UI | no | CSR re-orders in-memory dataset |
| Filter chips/checkboxes selected state | URL | yes | renders checked state from URL; hydrates without re-render |
| Filter changes | UI | no | CSR re-filters in-memory dataset |
| Mobile filter drawer | UI state | no | always CSR (closed by default in SSR) |

## Data flow

### Build-time (Hugo / fetch-tutorials)

```
CAP /build/catalog
    ↓
fetch-tutorials.ts (npm run fetch-tutorials)
    ├─► .tutorial-cache/cap-catalog.json    (existing — 24h TTL cache)
    └─► writeBrowseData(missions, hierarchies, standaloneGroups, navEntries)
            ↓
        hugo/data/browse.json
            {
              "all":      [/* CardItem[] — full catalog ~1400 cards */],
              "featured": ["mission-slug-1", ...],   // first N missions
              "recent":   ["tutorial-slug-1", ...],  // top N by isNew + lastmod
              "buildAt":  "2026-06-02T20:00:00Z"
            }
            ↓
        hugo build (reads .Site.Data.browse.{all,featured,recent})
            ├─► hugo/public/browse/index.html        (banner + rails + page-1 grid)
            └─► hugo/public/browse/data.json         (full card list — fetched after mount)
```

### Runtime (browser)

```
GET /browse/?type=mission&sort=recent
    ↓
Approuter serves hugo/public/browse/index.html  (SSR'd HTML — first paint, ~200ms)
    ↓
JS: createSSRApp(BrowsePage).mount('#browse-root')
    ├── reads ?type=mission&sort=recent from URL via parseNavState() + readSort()
    ├── hydrates static DOM with the URL filter state already applied
    │   (filter chip "Mission" checked; sort dropdown shows "Recently added")
    ├── fetches /browse/data.json   (full card list — async, doesn't block paint)
    │   - 404 → empty in-memory fallback; page-2+ disabled
    ├── fetches /build/my-progress  (auth-required; 401 → no progress overlays)
    └── on both fetches resolved:
            ↓
        ProgressOverlay components animate progress rings into view
        (stroke-dashoffset transition, ~250ms each, 30ms stagger;
         prefers-reduced-motion → instant)
            ↓
        Page is fully interactive
            ├── filter change      → useNavigatorFilters re-derives displayedItems
            │                       → BrowseGrid re-renders → URL writes via urlSync (300ms debounce)
            │                       → curation rails hide
            ├── sort change        → re-orders in-memory dataset → URL writes ?sort=
            ├── page change        → slices in-memory dataset → URL writes ?page=N
            └── search input       → debounced via useSearch (300ms)
                                   → server search OR client filter, same as today
                                   → URL writes ?q=, rails hide
```

### Admin-write rebuild trigger (CAP backend)

```
Admin clicks "Save" on Mission/Group/Featured-flag in admin UI
    ↓
CAP after('UPDATE'|'CREATE'|'DELETE') hook on Missions/Groups/FeaturedTasks
    ├── invalidateNavigatorCache()                  (existing — busts /build/navigator memo)
    └── rebuildTrigger.scheduleRebuild('admin-write')
            ↓
        rebuild-trigger.js — JobLock-guarded debounce window (60s)
            - acquire lock 'rebuild-trigger-pending'
            - if already pending: extend deadline, return
            - else: setTimeout(60_000) → fire dispatch, release lock
            ↓
        POST github.com/repos/.../actions/workflows/rebuild-content.yml/dispatches
            { ref: 'main', inputs: { 'trigger-source': 'admin-write' } }
            ↓
        rebuild-content.yml runs
            ├── npm run fetch-tutorials   → fresh hugo/data/browse.json
            ├── npm run build:all          → re-renders /browse/ SSR
            └── npm run publish-content    → publishes tutorial HTML to HANA
```

### Failure modes and bounded errors

| Failure | Recovery |
|---|---|
| `hugo/data/browse.json` missing at Hugo build | `fetch-tutorials` fails loud (existing behavior); `ALLOW_EMPTY_CAP=1` opt-out unchanged |
| `/browse/data.json` 404 at runtime | Vue island uses empty in-memory dataset; page-1 cards still interactive; page-2+ disabled with hint |
| `/build/my-progress` 401 (logged out) | No progress overlays; cards render without rings (same as `/`) |
| `urlSync.ts` parse fails on hand-edited URL | `EMPTY_STATE` fallback (existing #195 behavior) |
| `?sort=` is unknown value | `browseUrl.ts.readSort()` returns `'relevance'` |
| `rebuild-trigger.js` workflow_dispatch fails (rate limit, token expired) | Caught, logged, NOT rethrown — admin save still succeeds; next successful trigger picks up missed change |
| `GITHUB_DISPATCH_TOKEN` unset | `rebuild-trigger.js` no-ops with one startup warning; falls back to "next push triggers rebuild" cadence |

## Layout, visuals, and responsive behavior

### Desktop layout (≥1024px)

```
┌─────────────────────────────────────────────────────────────────────┐
│ [Shellbar — existing, with new "Browse" item]                       │
├─────────────────────────────────────────────────────────────────────┤
│ <header role="banner">                                              │
│   Browse SAP developer tutorials                                    │
│   [ 🔍 Search tutorials, missions, and groups…             ]        │
│ </header>                                                           │
│ <a class="skip-link" href="#browse-results">Skip to results</a>     │
├──────────────┬──────────────────────────────────────────────────────┤
│ <aside       │ <main id="browse-results" tabindex="-1">             │
│  role=       │   <section aria-label="Featured missions">           │
│  complement. │     Featured missions                  Show all →    │
│  >           │     [card] [card] [card] [card] [card]               │
│  <form role= │   <section aria-label="Recently added">              │
│   "search">  │     Recently added                     Show all →    │
│   Type       │     [card] [card] [card] [card] [card]               │
│   ☐ Mission  │   <section aria-label="All tutorials">               │
│   ☐ Group    │     All N items                  Sort: Relevance ▾   │
│   ☐ Tutorial │     [card] [card] [card] [card]                      │
│   Level      │     [card] [card] [card] [card]                      │
│   ☐ Beginner │     ‹ 1 2 3 … 30 ›                                   │
│   ☐ Inter.   │ </main>                                              │
│   ☐ Advanced │                                                      │
│   ▾ Products │                                                      │
│   ▾ Topics   │                                                      │
│   Quick      │                                                      │
│   ☐ New only │                                                      │
│   ☐ No lic.  │                                                      │
│   [Clear all]│                                                      │
│ </aside>     │                                                      │
└──────────────┴──────────────────────────────────────────────────────┘
```

### CSS layout primitive

```css
.browse-shell {
  display: grid;
  grid-template-columns: 280px 1fr;     /* rail | main */
  gap: 1.5rem;
  max-width: 1440px;                    /* wider than /'s 1200px — the redesign rationale */
  margin: 0 auto;
  padding: 1rem;
}

.browse-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.browse-rail-curation {
  display: grid;
  grid-template-columns: repeat(5, minmax(220px, 1fr));   /* 5 cards on desktop */
  gap: 1rem;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
}
.browse-rail-curation > * { scroll-snap-align: start; }
```

CSS grid (not flexbox) on the shell because flexbox atomizes children when content collapses ([[feedback-flex-atomizes-inline-prose]]). Grid keeps the two columns rigid.

### Tablet & mobile (<1024px)

```
┌────────────────────────────────────┐
│ [Shellbar]                         │
├────────────────────────────────────┤
│ Browse SAP developer tutorials     │
│ [ 🔍 Search… ]                     │
│ [⚙ Filters (3 active)]    Sort ▾  │  ← sticky
├────────────────────────────────────┤
│ Featured missions       Show all → │
│ [card] [card] [card] →             │  ← horizontal-scroll rail
│ Recently added          Show all → │
│ [card] [card] [card] →             │
│ All N items                        │
│ [    card    ] [    card    ]      │  ← 2-col tablet, 1-col phone
│ ‹ 1 2 3 ›                          │
└────────────────────────────────────┘

When ⚙ Filters tapped:
┌────────────────────────────────────┐
│ ╳ Filters                          │  ← <dialog> drawer slides from left
│ ── (form contents) ─────────────── │
│ ┌──────────────────────────────┐   │
│ │   Apply (1,398 results)      │   │  ← sticky bottom, live count
│ └──────────────────────────────┘   │
│ Clear all                          │
└────────────────────────────────────┘
```

### Mobile drawer mechanics

- `<dialog>` element (native focus-trap, ESC-to-close, backdrop, `aria-modal`).
- Slide-in: `transform: translateX(-100%)` → `translateX(0)`, 200ms ease.
- `prefers-reduced-motion: reduce` → no transition.
- Body scroll-lock while open (`overflow: hidden` on `<body>`).
- Apply button is a sticky-bottom explicit "done" affordance; filter changes are live as the user toggles them.

### Title banner

- `<h1>` "Browse SAP developer tutorials" using `--sapTitle_FontFamily` and Horizon h1 sizing.
- Search input full-width on mobile, ~480px max on desktop, centered under the title.
- No CTAs, no hero image, no marketing copy.
- Background `--sapShellColor` for a continuous header treatment with the shellbar.

### Curation rails

- 5 cards visible on desktop (≥1280px), 4 on 1024–1280px, horizontal scroll on <1024px.
- "Show all →" navigates to existing surfaces with filters pre-applied:
  - **Featured** → `/missions/`
  - **Recently added** → `/?new=1` (the `/` navigator with the New filter pre-applied)
- Hidden on filter or search via `<section data-rail hidden>` toggle. Fade-out 150ms (`prefers-reduced-motion`-guarded).

### Sort dropdown

- Native `<select>` — SSRs with the selected value preserved without hydration tricks.
- Positioned in the "All N items" section header on desktop; in the sticky toolbar on mobile.
- Options: Relevance (default), Recently updated, Recently added, Title A→Z, Time-to-complete (short→long).

### Card grid

- Reuses shared `<MissionCard>` / `<GroupCard>` / `<TutorialCard>` — identical visuals to `/`.
- Page size: 24 cards per page.
- Pagination: numeric pages with first/prev/next/last (existing pattern). Real `<a href="?page=N">` so middle-click and "open in new tab" work; JS intercepts to avoid full reload.

### SAP Fundamental Styles tokens

`--sapTile_Background`, `--sapTile_BorderColor`, `--sapTile_TitleTextColor`, `--sapShellColor`, `--sapButton_Background`, `--sapButton_Selected_Background`, `--sapLink_Color`, `--sapNeutralTextColor`, `--sapTextColor`. Same set as today's home/navigator. Dark mode auto-handled via existing `data-theme=dark` cascade.

### Surfacing during the A/B period

- **Pill on `/`** above the existing hero: "Try the new browse layout →" linking to `/browse/`. Easy to remove post-A/B.
- **Shellbar "Browse" item** alongside existing items, highlighted on `/browse/`.

## Test plan

### Test pyramid

| Layer | Tooling | Coverage | Where |
|---|---|---|---|
| Pure unit | Vitest, no JSDOM | `useNavigatorFilters`, `browseUrl.ts`, `rebuild-trigger.js` debounce | `npm test` |
| Component | Vitest + @vue/test-utils | Card components, `<ProgressOverlay>`, `<BrowseFilterRail>` form wiring | `npm test` |
| SSR/hydration parity | Vitest + happy-dom | `BrowsePage.vue` hydrates onto SSR DOM with no `[Vue warn]` mismatches | `npm test` |
| Hugo build smoke | shell + Hugo | `hugo/data/browse.json` exists, `hugo/public/browse/index.html` non-empty with expected slugs | `npm run test:smoke` |
| Hybrid | Vitest hybrid + cds bind | Admin write triggers `rebuild-trigger.js` (mocked GH dispatch); 60s debounce collapses bulk edits | `npm run test:hybrid` |
| HTTP smoke (deployed) | Vitest smoke + fetch | `GET /browse/` 200 with non-empty grid, `GET /browse/data.json` valid JSON, `GET /browse/?type=mission` filter chip prerendered checked, landmarks present | `npm run test:smoke` after deploy |
| Manual | Tom's checklist | Visual parity, drawer feel, ring animation, dark mode, keyboard nav | DEV after deploy |

### Critical-path test files (new)

1. **`hugo-apps/src/shared/composables/useNavigatorFilters.test.ts`** — pure-function tests of the extracted state. Round-trips with `urlSync`. Includes a snapshot of `displayedItems` for ~10 representative filter+search combinations to lock pre-refactor behavior on `/`.
2. **`hugo-apps/src/browse/browseUrl.test.ts`** — `?sort=` read/write, default fallback, unknown-value tolerance, composes cleanly with `urlSync` (doesn't touch other params).
3. **`hugo-apps/src/browse/__tests__/BrowsePage.hydration.test.ts`** — loads a captured snapshot of Hugo's SSR output, mounts `BrowsePage.vue` over it via `createSSRApp().mount()`, asserts no `[Vue warn]` console output, DOM equality (modulo Vue-added attributes), filter chip pre-checked from URL stays checked, sort dropdown selected value preserved.
4. **`hugo-apps/src/browse/__tests__/card-template-parity.test.ts`** — for each card type: render Vue card via `renderToString()` with a fixture, render Hugo partial with the same fixture, normalize, assert equivalent DOM. **The load-bearing test for the dual-edit tax — fails CI when Hugo template and Vue component drift.**
5. **`srv/lib/__tests__/rebuild-trigger.test.js`** — JobLock-guarded debounce. Two writes within 60s → one dispatch. Token missing → no-op. GitHub 4xx → caught and logged. GitHub 5xx → caught and logged (no retry).

### Regression protection for the existing navigator

The Q9 refactor (extract from `TutorialNavigator.vue`) is the highest-risk piece because it touches a 1,596-line production file. Defensive measures:

- **Pre-refactor snapshot lock** — capture `displayedItems` outputs for ~10 filter+search combos *before* the extraction, lock them in `useNavigatorFilters.test.ts`.
- **Refactor lands as its own PR** that doesn't introduce `/browse/` at all. CI must show snapshots green before merge.
- **Vitest + happy-dom DOM-level smoke test** of `/` covering filter-by-type, search "cap", clear-all (one-time addition under `hugo-apps/src/navigator/__tests__/navigator-regression.test.ts`). The project does not use Cypress or Playwright; happy-dom is sufficient for asserting DOM state changes after user-event simulation.

### Coverage of locked decisions

| Decision | Test |
|---|---|
| #3 filter parity with `/` | Snapshot of `displayedItems` pre/post refactor |
| #4 rails hide on filter/search | Component test: assert `[data-rail][hidden]` after a filter selection |
| #6 sort options work | Unit test on each sort comparator + browseUrl round-trip |
| #7 mobile drawer at <1024px | Component test with `matchMedia` mock + Tom's manual checklist |
| #8 urlSync reused verbatim | Existing #195 tests stay green; integration test asserts same param names |
| #10 SSR + hydration | `BrowsePage.hydration.test.ts` + `card-template-parity.test.ts` |
| #11 admin-write triggers rebuild | `rebuild-trigger.test.js` (debounce, error handling, token-missing) |
| #12 `?page=N` honored on first paint | Smoke test: `GET /browse/?page=2` returns `<a class="pagination-page-current">2</a>` |
| #13 animated draw-in on hydration | Tom's manual checklist + `prefers-reduced-motion` unit test |
| #14 search in banner plumbs to grid | Component test: type in banner search → grid filters |
| #15 landmarks present | Smoke test asserting `<header role="banner">`, `<aside role="complementary">`, `<main id="browse-results" tabindex="-1">`, skip-link |

### Tom's manual DEV checklist

- [ ] `/browse/` loads with rails visible
- [ ] Banner search "cap" → rails fade out, grid filters
- [ ] Click filter chip "Mission" → URL updates `?type=mission`, grid filters
- [ ] Reload → filter chip still checked
- [ ] Resize to mobile → filter button appears, drawer opens
- [ ] Drawer Apply button shows live count
- [ ] Sort dropdown changes order, URL writes `?sort=recent`
- [ ] Pagination forward/back works, `?page=N` updates
- [ ] Login → progress rings animate in on cards with progress
- [ ] `prefers-reduced-motion: reduce` (DevTools) → rings appear instantly
- [ ] Dark mode toggle → all surfaces correct
- [ ] Keyboard tab through skip-link → lands on `<main>`
- [ ] Tab through filter rail → tab order matches visual order
- [ ] Pill on `/` navigates to `/browse/`; shellbar "Browse" item highlighted on `/browse/`
- [ ] Edit a Mission in admin UI → wait 1–2 minutes → Actions tab shows `rebuild-content.yml` run with `trigger-source=admin-write`
- [ ] After rebuild + redeploy → `/browse/` reflects the edit

## Sequencing

Three PRs in order, each independently revertible and deployable:

```
PR 1: Refactor — extract useNavigatorFilters + shared cards
       │  No new behavior. /'s navigator works identically.
       │  Snapshot tests + card-template-parity test land here.
       ↓
PR 2: SSR plumbing — fetch-tutorials writes hugo/data/browse.json,
                     Hugo browse/list.html, BrowsePage.vue, browseUrl.ts
       │  /browse/ becomes reachable. Pill on / + shellbar item land here.
       │  Hydration parity tests land here.
       ↓
PR 3: Admin-write rebuild trigger — srv/lib/rebuild-trigger.js + CAP after-hooks
       │  Behind GITHUB_DISPATCH_TOKEN env var (no-op if unset).
       │  rebuild-trigger.test.js lands here.
       ↓
After merge: file the 6 followup issues as children of #174.
```

PR 1 must go first — it's the foundation for PR 2's shared components, and carries no behavior risk if snapshot tests pass. PR 2 ships independently of PR 3; without PR 3, content stays fresh via the existing push trigger. PR 3 is purely additive.

### Per-PR scope estimate

| PR | LOC | Files | Risk |
|---|---|---|---|
| PR 1 (refactor) | net +200 | ~12 in `hugo-apps/src/` + `shared/cards/` + `shared/composables/` | Medium — touches production navigator. Snapshot tests gate regression risk. |
| PR 2 (SSR + browse) | ~2,500 added | `hugo/layouts/browse/`, `hugo-apps/src/browse/`, `browse.css`, `fetch-tutorials.ts`, header partial, pill on `/` | High — biggest piece, new code paths, SSR/hydration. Mitigated by parity test. |
| PR 3 (rebuild trigger) | ~250 added | `srv/lib/rebuild-trigger.js`, `srv/server.js` hook, `rebuild-content.yml` workflow_dispatch input, tests, env doc, **`docs/developers/operations/github-dispatch-pat-rotation.md` rotation runbook** | Low — backend-only, gated by env var, falls back gracefully |

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Refactor introduces subtle behavior change on `/` | Medium | High | Pre-refactor snapshot tests + Cypress smoke + refactor lands alone before `/browse/` |
| Hydration mismatch on `/browse/` reaches prod silently | Medium | Medium | `card-template-parity.test.ts` + `BrowsePage.hydration.test.ts` in CI; flicker on Tom's checklist |
| `hugo/data/browse.json` size grows unboundedly | Low | Medium | If catalog grows past ~5K cards, revisit pagination strategy (followup) |
| `rebuild-trigger.js` storms Actions minutes during admin bulk edits | Medium | Medium | 60s JobLock-guarded debounce; PAT scoped to `actions:write` so worst case is bounded |
| `srv-qa` cp list misses `rebuild-trigger.js` ([[feedback-srv-qa-cp-list-recurring]]) | High | High | PR 3 description includes checklist to walk transitive `srv/lib/` imports; reviewer enforces |
| GitHub PAT for rebuild trigger leaks | Low | High | Fine-grained, scoped to `actions:write` on a single repo, expires every 90 days, stored in CF env not in code; PR 3 includes a `docs/developers/operations/github-dispatch-pat-rotation.md` runbook covering generation, env-var update, and revocation |
| `<dialog>` behavior differs across browsers | Low | Low | Smoke-tested on Tom's checklist; fallback to plain `<aside>` + JS focus-trap if needed |
| A/B test runs but no analytics to read it | High | High | Filed as followup #6 (analytics instrumentation) — blocks the eventual cutover decision |

## Definition of done

- [ ] PR 1 merged, `/` regression-tested green
- [ ] PR 2 merged, `/browse/` deployed to DEV
- [ ] PR 3 merged, `GITHUB_DISPATCH_TOKEN` set in CF env for DEV (and QA + PROD when rolling forward)
- [ ] Tom's manual checklist passes on DEV
- [ ] Pill on `/` and shellbar "Browse" item visible to all users on DEV
- [ ] All 6 followup issues filed and linked as children of #174

## Followup issues

Filed immediately after this design commits, each linked as a child of #174.

1. **Add sort dropdown to the existing `/` navigator** — once `/browse/` proves out, parity work for the existing surface (or merge them into one experience post-A/B).
2. **Add SSR to `/`** — reuse the SSR plumbing from this work after the layout proves stable.
3. **Categories facet** (deferred from Q3 alternative B) — coarser top-level categorization (Application Development / Data & Analytics / AI / Integration / Extensibility); needs a categorization model first (admin work).
4. **Personalized "for you" rail on `/browse/`** — extend with the embedding-centroid recommendations from PR #35.
5. **Per-user CSR rebuild-tax for the SSR'd grid** — if some catalog data becomes user-personalized later (e.g. per-user "best fit" sort), revisit the SSR boundary.
6. **Instrument `/browse/` vs `/` for A/B comparison** — emit analytics events for filter use, card click-through, time-on-page; without this the A/B test produces no comparable data. Blocks the cutover decision.

## References

- Issue: [#174](https://github.com/sap-tutorials/tutorials-ims/issues/174)
- URL-sync dependency: [#195](https://github.com/sap-tutorials/tutorials-ims/issues/195) / [#197](https://github.com/sap-tutorials/tutorials-ims/pull/197) — `urlSync.ts` (landed in `main`)
- Reference IA: SAP Discovery Center Missions homepage
- Existing surface: [hugo/layouts/index.html](../../../hugo/layouts/index.html), [hugo-apps/src/navigator/TutorialNavigator.vue](../../../hugo-apps/src/navigator/TutorialNavigator.vue) (1,596 LOC)
- URL-sync module: [hugo-apps/src/navigator/urlSync.ts](../../../hugo-apps/src/navigator/urlSync.ts)
- Catalog endpoint: [srv/lib/navigator-catalog.js](../../../srv/lib/navigator-catalog.js) (`/build/navigator`); [srv/server.js:131](../../../srv/server.js#L131); admin invalidation at [srv/server.js:268](../../../srv/server.js#L268)
- Build catalog endpoint: `CAP /build/catalog` consumed by [scripts/parsers/cap.ts](../../../scripts/parsers/cap.ts) and [scripts/fetch-tutorials.ts:740-781](../../../scripts/fetch-tutorials.ts#L740-L781)
- Rebuild workflow: [.github/workflows/rebuild-content.yml](../../../.github/workflows/rebuild-content.yml)
- Related memory pointers: [[project-issue-174-browse-layout-paused]] (now superseded by this spec), [[feedback-srv-qa-cp-list-recurring]], [[feedback-flex-atomizes-inline-prose]], [[feedback-pr-over-direct-merge]]
