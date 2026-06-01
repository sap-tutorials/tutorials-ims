# Tutorial Search Sub-Threshold Hint

**Issue:** [sap-tutorials/tutorials-ims#176](https://github.com/sap-tutorials/tutorials-ims/issues/176)
**Date:** 2026-06-01
**Scope:** UX polish on the public tutorial navigator search input.

## Problem

The tutorial navigator at `/tutorials/` (component
[hugo-apps/src/navigator/TutorialNavigator.vue](../../../hugo-apps/src/navigator/TutorialNavigator.vue))
runs server-side search through the `useSearch` composable
([hugo-apps/src/navigator/useSearch.ts](../../../hugo-apps/src/navigator/useSearch.ts)).
Server search activates at **2 characters** — below that, `searchMode` is
`false` and `searchResults` is `[]`.

The bug Tom reported on issue #176: when the user has typed exactly **one**
character, two things go wrong simultaneously:

1. The browse grid (`paginatedItems` via `displayedItems`) is filtered by the
   single character — the existing `filteredItems` computed at
   [TutorialNavigator.vue:432-462](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L432-L462)
   does a substring `includes(q)` on title/description/tags. A single
   character matches a lot, but combined with active level/type/product
   filters it can collapse to zero.
2. When the result list IS zero (single char + filters, OR empty catalog
   with single char, OR a single char that genuinely matches nothing in the
   client-side cache), the existing `NoFilterResults` illustrated message at
   [TutorialNavigator.vue:792](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L792)
   fires with copy "No results match your filters" — which reads to the
   user as "search broke".

The issue title says "needs at least three characters" — that's an
approximation; the actual server threshold is 2 and we keep it at 2. The
fix is the sub-threshold UX layer, not the threshold itself.

## Behavior matrix

The result-area is **one** mutually-exclusive chain. In priority order:

| Priority | Condition                                               | Renders                                   |
| -------- | ------------------------------------------------------- | ----------------------------------------- |
| 1        | `loading` (initial catalog fetch in flight)             | Skeleton grid (existing)                  |
| 2        | `isSearching` (debounced server search in flight)       | Spinner (existing)                        |
| 3        | `isSubThreshold` (1 char typed, catalog already loaded) | **NEW** `BeforeSearch` illustrated msg    |
| 4        | `displayedItems.length > 0`                             | Card grid (existing)                      |
| 5        | `displayedItems.length === 0`                           | `NoFilterResults` empty state (existing)  |

`isSubThreshold` is gated on `!loading` so it never co-renders with the
initial skeleton. Backspace symmetrically restores: `2 → 1` reveals the hint;
`1 → 0` restores the browse grid (or its `NoFilterResults` empty state if
filters reduce to zero).

## Implementation

### 1. `useSearch.ts`

Hoist the threshold and add a sub-threshold computed flag:

```ts
export const MIN_SEARCH_CHARS = 2

const searchMode      = computed(() => searchTerm.value.length >= MIN_SEARCH_CHARS)
const isSubThreshold  = computed(() =>
  searchTerm.value.length > 0 && searchTerm.value.length < MIN_SEARCH_CHARS
)
```

Replace the two literal `2`s ([line 69](../../../hugo-apps/src/navigator/useSearch.ts#L69)
and [line 75](../../../hugo-apps/src/navigator/useSearch.ts#L75)) with
`MIN_SEARCH_CHARS`. Add `isSubThreshold` to the returned object.

The `< 2` defense-in-depth guard inside `executeSearch` already prevents a
fetch when sub-threshold; no other logic changes.

### 2. `TutorialNavigator.vue`

The current template has **five separate `v-if` blocks** in the result
area, not a chain — they can co-render:

- [Line 712](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L712): `v-if="isSearching"` spinner
- [Line 715](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L715): `v-if="loading"` skeleton (paired with `v-else` at line 718)
- [Line 718](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L718): `v-else` card grid
- [Line 769](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L769): `v-if="totalPages > 1 && !searchMode"` pagination
- [Line 792](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L792): `v-if="displayedItems.length === 0 && !isSearching && (tutorials.length > 0 || searchMode)"` empty state

The fix replaces lines 712–718 and line 792 with **one** unified
mutually-exclusive chain inside a `<Transition>` wrapper. The pagination
block at line 769 is a separate concern and stays where it is — it sits
*outside* the transition so it doesn't fade with content swaps.

Add a wrapper `<div class="navigator-result-area">` around the new
`<Transition>` so we have a stable parent for the `min-height` rule:

```vue
<div class="navigator-result-area">
  <Transition name="navigator-fade" mode="out-in">
    <section
      v-if="loading"
      key="skeleton"
      class="navigator-grid navigator-grid--loading"
      aria-label="Loading tutorials"
    >
      <Skeleton kind="card" :count="6" />
    </section>

    <div v-else-if="isSearching" key="searching" class="navigator-loading">
      <div class="fd-busy-indicator fd-busy-indicator--m" aria-label="Loading search results"></div>
    </div>

    <div v-else-if="isSubThreshold" key="subthreshold" class="navigator-hint">
      <ui5-illustrated-message name="BeforeSearch" design="Spot">
        <span slot="title">Keep typing…</span>
        <span slot="subtitle">Search starts at 2 characters.</span>
      </ui5-illustrated-message>
    </div>

    <section v-else-if="displayedItems.length > 0" key="results" class="navigator-grid">
      <!-- existing card-grid <a> loop unchanged -->
    </section>

    <div v-else key="empty" class="navigator-empty">
      <ui5-illustrated-message name="NoFilterResults" design="Spot">
        <span slot="title">No results match your filters</span>
        <span slot="subtitle">Try removing a filter or broadening your search.</span>
        <ui5-button design="Emphasized" @click="clearFilters">Clear all filters</ui5-button>
      </ui5-illustrated-message>
    </div>
  </Transition>
</div>
```

`<Transition mode="out-in">` works correctly with this chain: only one
branch is in the DOM at any moment, each has a stable `:key`, and Vue 3
treats them as a single child slot. (Vue 3 supports `v-if/v-else-if/v-else`
chains as direct children of `<Transition>`; the single-child constraint is
about *rendered* children, not authored siblings.)

`BeforeSearch` is the default-loaded illustration on
`@ui5/webcomponents-fiori`, so no extra import is needed (verified via
ui5-webcomponents MCP). `NoFilterResults` is already in use elsewhere on
the page, so it's already imported.

Destructure `isSubThreshold` from `useSearch()` alongside the existing
`searchMode`, `isSearching`, etc.

### 3. CSS

Scoped to the component:

```css
.navigator-result-area {
  /* Prevents collapse-to-zero during out-in fade. The Spot-design
     illustrated message renders ~220–240px tall; 320px gives headroom for
     the title + subtitle slots without dictating browse-grid height. */
  min-height: 320px;
}

@media (prefers-reduced-motion: no-preference) {
  .navigator-fade-enter-active,
  .navigator-fade-leave-active {
    transition: opacity 150ms ease-out;
  }
  .navigator-fade-enter-from,
  .navigator-fade-leave-to {
    opacity: 0;
  }
}
```

`min-height` only prevents the wrapper collapsing to zero during the
out-in handoff — it does not eliminate height differences between branches
(grid is much taller than the illustration). That tall-to-short transition
is acceptable; the goal is "no jarring zero-height flash", not "no height
change at all".

Users with `prefers-reduced-motion: reduce` get an instant swap (no CSS
defines the transition properties for them).

## Out of scope

- Changing the threshold itself (stays at 2; issue title was approximate).
- Server-side changes — `srv/search-service.js` already validates `>= 2`.
- i18n of the hint copy — the navigator is currently en-only
  (`placeholder="Search for a tutorial"` is hardcoded too).
- Filter chips, debounce timing, search endpoint, pagination layout.
- Animating into/out of the pagination block.
- Adding a Vue Test Utils unit test — there is no existing test infra for
  navigator UI in this project; the change is small enough to validate
  manually.
- Differentiating the `NoFilterResults` copy between browse-mode filter
  collapse and search-mode zero-hits. Both currently show the same "No
  results match your filters" message — a pre-existing conflation. The
  sub-threshold fix here addresses the 1-character "search broke" reading
  but leaves the genuine-search-zero-hits copy untouched. A follow-up issue
  should split that copy if it's worth doing.

## Verification

Manual on `npm run dev` (Hugo dev server at <http://localhost:1313>) against
the `/tutorials/` navigator:

1. Empty input → browse grid visible.
2. Type one letter → fade to `BeforeSearch` hint; browse grid hidden;
   network tab shows **no** request to `/search/SearchableItems`.
3. Type a second letter → fade to results; request fires.
4. Backspace `2 → 1` → fade back to hint.
5. Backspace `1 → 0` → fade back to browse grid.
6. Apply level/type filters first, then type one letter → still shows the
   hint (not `NoFilterResults`).
7. With `prefers-reduced-motion: reduce` set in the OS/browser, transitions
   are instant.
8. Quick consecutive typing (`a → ab → abc`) within `searchMode=true` does
   not flicker — the wrapper element stays the same, only the cards inside
   change.
9. Reload the page with a one-char value pre-populated (if URL state
   restoration is in play) — the hint shows from the start, not the empty
   state.

No automated test added; smoke (`test/smoke/`) covers
`/search/SearchableItems` HTTP behavior, which is unaffected.

## Files touched

- [hugo-apps/src/navigator/useSearch.ts](../../../hugo-apps/src/navigator/useSearch.ts) — `MIN_SEARCH_CHARS` constant, `isSubThreshold` computed, return-object additions.
- [hugo-apps/src/navigator/TutorialNavigator.vue](../../../hugo-apps/src/navigator/TutorialNavigator.vue) — `<Transition>` wrapper around five mutually-exclusive branches; replaces lines 712–718 and line 792; new `navigator-result-area` wrapper; new `navigator-hint` and `.navigator-fade-*` scoped CSS. Also: add `isSubThreshold` to the `useSearch()` destructure at line 34.

No backend, schema, route, or build-pipeline changes.
