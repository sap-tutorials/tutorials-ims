# Tutorial Navigator — Search & Filter Improvements (#3112)

Date: 2026-11-12
Author: Thomas Jung (issue) / design by Claude
Issue: https://github.com/sap-tutorials/tutorials-ims/issues/3112

## Intent & why

The Tutorial Navigator (Vue 3 island on the homepage `/`, shared with `/browse/`)
is the primary way developers find tutorials. Three usability gaps make it harder
to trust and harder to narrow:

1. **Selected filters disappear.** When you check a facet (e.g. a Software Product),
   the checked item stays in its alphabetical position inside a short scrolling box
   (`max-height: 7.5rem`), so it can scroll out of view. You lose track of what you
   picked. Floating selected items to the top of each column keeps the current
   selection visible.

2. **Search silently drops missions.** When you type a query, the result lozenge can
   show a mission exists ("1") while no mission card is rendered. In tag/filter mode
   missions ARE shown, so the behavior is inconsistent and looks broken. The intent
   ("missions are generally shown, even when selecting by tags") is that a mission
   that matches a search should actually appear in results.

3. **No way to find your own tutorials.** Users want to filter to tutorials they have
   **completed** or **started (in progress)**. The per-user progress data is already
   fetched client-side for card badges but is not exposed as a filter.

Success = a developer can (a) always see which filters are active, (b) find a mission
by typing its name, and (c) narrow the grid to just their completed or in-progress
tutorials.

## Goals

- **G1 (Ask 1):** In each filter column, checked items render at the top of that
  column (preserving relative order among checked, and among unchecked), so the active
  selection is always visible without scrolling. Applies to all four columns: Topic,
  Software Product, Experience, Type.
- **G2 (Ask 2):** A mission that matches a search query appears in the rendered result
  grid — not merely in the count. Achieved by (a) boosting mission/group rows in the
  server-side search rank so they surface near the top, and (b) restoring pagination in
  search mode so any counted-but-unrendered item is reachable.
- **G3 (Ask 3):** A "My progress" filter column with two independent toggles,
  **Completed** and **In progress**. Checking one or both narrows the grid to cards
  matching that progress state. Works in both the client-filter path and the
  server-search path. Hidden entirely for anonymous (not-signed-in) users.

## Non-goals

- No change to how progress is tracked or computed server-side; we reuse the existing
  `/build/my-progress` payload as-is.
- No new sort control exposed to the user (ordering of results stays rank/date driven;
  only the facet-list ordering within a column changes, for G1).
- Partial mission/group progress is out of scope — the Navigator feed treats
  missions/groups as binary complete (documented limitation); "In progress" applies to
  tutorials, and missions/groups match "Completed" only when fully complete.
- No redesign of the filter panel layout beyond adding the one "My progress" column.
- The QA `clientSearch=true` path already routes search through the client filter
  pipeline; G2's server-rank change does not affect it, and that is acceptable.
- While a progress filter is active, full-text server ranking is intentionally not
  applied (search falls back to client substring match on the loaded set) — this is a
  deliberate trade for exact counts, not a bug.

## Anti-goals (would be a failure even if it "works")

- The progress filter must never show other users' state or leak progress for anonymous
  sessions — showing an empty/greyed filter to an anonymous user, or showing stale
  progress, is a failure.
- The "selected floats to top" reorder must not cause the checkbox you just clicked to
  jump under your cursor and get mis-clicked, or make the list visibly "jump" in a way
  that feels broken. Reorder on selection commit, keep it smooth.
- Fixing the mission count must not make the honest count *wrong in the other
  direction* (e.g. rendering a mission that doesn't match, or double-counting).

## Current architecture (as mapped)

- **`hugo-apps/src/navigator/TutorialNavigator.vue`** — main SFC. Search input
  (~L336), filter panel (~L368-438), result grid (~L512-521), three data fetches in
  `onMounted` (~L248-253): `{navBase}/_nav.json`, `/build/navigator`, `/build/my-progress`.
  `allCards` (~L90-182) builds unified `CardItem[]` with `type: mission|group|tutorial`.
  The `progress` ref holds the parsed `ProgressPayload` and is passed to each card.
- **`hugo-apps/src/shared/composables/useNavigatorFilters.ts`** — filter state, URL sync,
  client-side `filteredItems` (~L496-548), `counts` (~L550-557), facet lists
  `availableProducts` (~L414-436, alpha sort), `availableTopics` (~L444-456, alpha sort),
  `displayedItems`/`displayedCounts` switch on `searchMode` (~L617-651). Shared with `/browse/`.
- **`hugo-apps/src/navigator/useSearch.ts`** — server `$search`. `executeSearch`
  (~L169-232) fetches `/search/SearchableItems?$search=…&$top=48&$skip=0` (rank-ordered,
  **no paging**). `getFacets` call via `buildFacetsUrl` (~L87-99) returns unbounded
  `typeCounts`. `mapToCardItem` (~L24-52) maps `taskType`→`type`. `postFilterNoLicense`
  (~L139-142) is the precedent for a client-side post-filter on search results.
- **`hugo-apps/src/navigator/cardProgress.ts`** — `ProgressPayload`:
  `tutorials.completedSlugs: Set<string>`, `tutorials.inProgress: Map<string, number>`,
  `missionSlugs`/`groupSlugs: Set<string>`, `authenticated: boolean`.
- **`srv/search-service.js`** — `attachSearchRank` (~L191-232): +3 title, +2 description,
  +1 primaryTag/tagBag; `before('READ')` (~L274-318); `getFacets` (~L545-582).
- **`db/views.cds`** (~L98-138) — `SearchableItems` UNION ALL view; mission branch carries
  `'MISSION' as taskType` + title/description/tagBag.
- **`srv/lib/my-progress-handler.js`** — `/build/my-progress`; empty for anonymous;
  `Cache-Control: private, no-store`. Registered `srv/server.js:2118` behind `contextMw, authMw`.

## The how — decided

### G1 — selected filters float to top

Decided behavior: checked items move to the top of their column; relative order within
the checked group and within the unchecked group is preserved (stable partition).

- Implement as a presentational reorder of the already-computed facet lists. Add a small
  helper (e.g. `partitionSelected(list, isSelectedFn)`) applied where each column's list
  is rendered in `TutorialNavigator.vue` (Topic ~L382, Product ~L400, Experience ~L413,
  Type ~L423). The underlying facet lists in `useNavigatorFilters.ts` keep their
  alphabetical/fixed order; the partition is layered on top so URL sync and counts are
  unaffected.
- Reorder is driven by the committed filter state (the same `filters` reactive the
  checkboxes bind to), so it updates when a box is checked/unchecked. To avoid the
  "checkbox jumps under the cursor" anti-goal, reorder on the committed selection (Vue
  re-render after the `v-model` write is acceptable and expected — verify it does not
  feel janky; if it does, debounce the reorder to blur/next-tick).
- Decision (builder's call): the per-column product/topic **search inputs**
  (`productSearch`/`topicSearch`) still substring-filter first; the selected-float-to-top
  partition applies to the filtered list. A selected item filtered out by the search box
  stays hidden (consistent with today) — selection is still reflected by the lozenge.

### G2 — missions appear in search results

Two coordinated changes:

1. **Rank boost (server).** In `srv/search-service.js` `attachSearchRank` (~L206-212),
   add a type weight so mission/group rows get a boost that lifts a genuine
   title/description match above the long tail of tutorial body matches — enough to land
   within the first page for realistic corpora, without drowning out a strong tutorial
   title hit. Exact weight is the builder's call; validate against real search terms that
   today show "1 mission, none rendered". Keep it a pure additive term in the existing
   formula; do not change what counts as a match.

2. **Restore search-mode pagination (client).** In `useSearch.ts` `executeSearch`
   (~L169-232), stop hard-capping at `$top=48, $skip=0` with no pager. This is NOT a
   one-line guard removal — the wiring to re-fetch on page change does not exist today.
   Required work (builder-check confirmed against the real code):
   - **Branch `totalPages` on `searchMode`.** Today `totalPages = ceil(filteredItems.length
     / pageSize)` (useNavigatorFilters.ts:~610) — the client-filtered set, wrong in search
     mode. In search mode it must derive from `searchTotalCount` (the SearchableItems
     `@odata.count`), the same way `displayedItems`/`displayedTotalCount`/`displayedCounts`
     already branch on `searchMode`.
   - **Wire page → refetch.** `executeSearch(page)` accepts a page arg but is only ever
     called with `0`; nothing watches `currentPage`. Add a watcher (or route
     `goToPage` → `executeSearch(currentPage)`) so changing page issues
     `$skip = currentPage * pageSize`. Confirm the existing page-reset watcher
     (~L700, resets page on `searchQuery` change) fires relative to the search debounce so a
     new query starts on page 1.
   - **Remove the pager guard.** In `TutorialNavigator.vue` drop `&& !searchMode` on the
     pager (~L536) so it shows when `totalPages > 1` in search mode.

3. **Unify the count sources (DECIDED — Q2).** The pager total AND the per-type lozenge
   counts must both derive from the **`SearchableItems` `@odata.count`** (`searchTotalCount`),
   which applies the full `$filter` (products / isNew) plus the client noLicense post-filter —
   NOT from `getFacets`, which today ignores `$filter`/noLicense (search-service.js:~545) and
   can therefore count an item the paged list can never reach. Forward `products`/`isNew` to
   `getFacets` (`buildFacetsUrl`, useSearch.ts:~87-99) so its per-type buckets agree, OR derive
   the per-type lozenge counts from a filtered count query consistent with `SearchableItems`.
   The success criterion ("every counted item reachable by paging; the mission is shown") is
   only guaranteed when the lozenge and the pager derive from the *same* filtered query — this
   reconciliation is **load-bearing, not optional polish**. This supersedes the
   leave-the-divergence option; the pre-existing over-count class
   (`2026-06-01-search-options-filter-design.md`) is closed for the mission case here.

Net effect: rank boost pulls a matching mission onto (or near) page 1, the honest filtered
count feeds both lozenge and pager, and paging reaches every counted item — satisfying
"missions are generally shown."

### G3 — "My progress" filter (Completed / In progress)

- **New filter state.** Add `completed: boolean` and `inProgress: boolean` to the
  `filters` reactive in `useNavigatorFilters.ts` (~L271-279), with URL sync parity to the
  other facets. **This touches ~6 scattered sites** that each hand-enumerate the filter
  keys (builder-check confirmed): the `NavState` type + `currentNavState()` (~L281-293),
  `parseNavState`/`writeNavStateToWindow` (separate module, ~L348-350), `EMPTY_STATE`,
  `hasActiveFilters` (~L585), `clearFilters` (~L599), and the page-reset watcher (~L700).
  Miss one and the filter won't reset page / clear / persist / count as active. Add
  all of them.
- **Thread progress into the composable.** `useNavigatorFilters` does not currently
  receive the `progress` ref — add it as an **optional** option/param so the filter
  predicate can read `completedSlugs` / `inProgress` / `missionSlugs` / `groupSlugs`.
  `TutorialNavigator.vue` passes its existing `progress` ref in. **`/browse/` does NOT
  pass it** (Q3: Navigator-only) — so the composable must treat absent/undefined progress
  as "no progress constraint," and the "My progress" column renders only when progress is
  supplied AND `authenticated === true`. `/browse/` thus shows no column and is unchanged.
- **Slug-keyed predicate (builder-check #3).** The progress Sets are keyed by **slug**,
  but `CardItem`s carry an href with a type prefix. Reuse the existing per-type extraction
  in `cardProgress.ts` — the predicate should be "`cardProgress(item, progress)` reports
  complete / in-progress," NOT a hand-rolled slug lookup (that mis-keys missions/groups).
  Client path, in `filteredItems` (~L496-548): `completed` on → keep cards `cardProgress`
  marks complete (tutorial in `completedSlugs`, mission in `missionSlugs`, group in
  `groupSlugs`); `inProgress` on → keep tutorial cards in the `inProgress` map with
  percent > 0 (missions/groups have no partial state → excluded). Both on = union. Both
  off = no constraint.
- **Search interaction (DECIDED — Q1).** When either progress toggle is active, **disable
  server search and route through the client-filter pipeline** (the same path `/browse/`
  and the QA `clientSearch` channel already use): force `searchMode` off (or treat the
  progress filter as suppressing the server path) so `filteredItems` applies both the
  search substring AND the progress predicate over the full loaded card set. This yields
  exact progress filtering, an honest paged count, and sidesteps the server
  count-divergence and slug-extraction problems entirely. Trade-off (acceptable):
  full-text server ranking is not applied while a progress filter is active — search
  degrades to client substring match on the loaded set. Do NOT post-filter server pages
  (rejected: inflates lozenge/pager with mostly-empty pages).
- **Anonymous handling.** When `progress.authenticated === false` (or progress absent),
  the "My progress" column is **hidden** (not greyed) and both flags are forced off. The
  anon scrub lives in **`parseNavState`** (the URL→state parser) so a shared
  `?completed=1` link is neutralised on load/reload for anonymous sessions, not just at
  first mount. If auth resolves after mount, the column's visibility must react (it keys
  off the reactive `progress.authenticated`); a late-arriving auth that reveals the column
  should NOT retroactively apply a scrubbed URL flag.

## Constraints

- Follow repo conventions: PR over direct merge; branch from fresh `origin/main`
  (per memory/CLAUDE.md). Target DEV via PR.
- Client changes are TypeScript Vue 3 islands under `hugo-apps/src/`; server change is
  CAP Node.js (`srv/search-service.js`) — no raw SQL, use existing patterns.
- User-facing UI change on `hugo/**`/`app/**` → wants a committed e2e spec (advisory);
  real e2e runs post-DEV-deploy. Add/extend a Playwright spec for the three behaviors.
- Testing: `npm test -- <file>` for scoped unit tests (full suite is hook-blocked
  locally, runs in CI). Unit-test the pure helpers (partition, progress predicate, rank).

## Decisions locked after builder review

- **Q1 — progress filter + search:** disable server search while a progress toggle is
  active; route through the client-filter pipeline (see G3). Not post-filtering.
- **Q2 — count sources:** unify lozenge + pager on the `SearchableItems` filtered count;
  forward products/isNew to `getFacets` (see G2 step 3). Load-bearing.
- **Q3 — scope:** Navigator (`/`) only; `/browse/` unchanged, no "My progress" column.
- **My calls** (settle without changing what ships): URL-sync must touch all ~6 enumerated
  sites; anon scrub lives in `parseNavState` (reload-safe); `/browse/` no-ops via
  absent-progress = no constraint; progress predicate goes through `cardProgress()` not a
  hand-rolled slug lookup.

## What's left to the builder

- Exact rank-boost weight for missions/groups (validate empirically against the real
  "1 mission, none shown" search terms).
- Whether the on-select reorder needs debouncing to avoid jank (G1).
- Precise placement/label of the "My progress" column in the filter panel and its i18n
  strings (match existing column styling).
- Unit + e2e test specifics.
