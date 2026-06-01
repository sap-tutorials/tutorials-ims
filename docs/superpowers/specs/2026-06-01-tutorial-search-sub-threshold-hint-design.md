# Tutorial Search Sub-Threshold Hint

**Issue:** [sap-tutorials/tutorials-ims#176](https://github.com/sap-tutorials/tutorials-ims/issues/176)
**Date:** 2026-06-01
**Scope:** UX polish on the public tutorial navigator search input.

## Problem

The tutorial navigator at `/tutorials/` (component
[hugo-apps/src/navigator/TutorialNavigator.vue](../../../hugo-apps/src/navigator/TutorialNavigator.vue))
runs server-side search through the `useSearch` composable
([hugo-apps/src/navigator/useSearch.ts](../../../hugo-apps/src/navigator/useSearch.ts)).
Search activates at **2 characters** — below that, `searchMode` is `false` and the
result list is wiped to `[]`.

The bug Tom reported on issue #176: when the user has typed exactly **one**
character, `searchTerm` is non-empty but `searchMode` is still `false`, so
`searchResults` is `[]`, the browse-grid path is suppressed, and the
`NoFilterResults` illustrated message renders ("No results match your filters").
The user reads this as "search broke" instead of "keep typing".

The issue title says "needs at least three characters" — that's an
approximation; the actual threshold in code is 2. We keep the threshold at 2
and fix the sub-threshold UX.

## Behavior matrix

| Chars typed | `searchMode` | Result area renders                                            |
| ----------- | ------------ | -------------------------------------------------------------- |
| 0           | `false`      | Browse grid (paginated, client-side filtered)                  |
| 1           | `false`      | **NEW** sub-threshold hint illustration                        |
| 2+          | `true`       | Server search results                                          |
| 2+, 0 hits  | `true`       | Existing `NoFilterResults` illustration (unchanged)            |

Backspace symmetrically restores: `2 → 1` reveals the hint; `1 → 0` restores
the browse grid.

## Implementation

### 1. `useSearch.ts`

Hoist the magic number into an exported constant and expose a new computed
flag for the sub-threshold state:

```ts
export const MIN_SEARCH_CHARS = 2

const searchMode      = computed(() => searchTerm.value.length >= MIN_SEARCH_CHARS)
const isSubThreshold  = computed(() =>
  searchTerm.value.length > 0 && searchTerm.value.length < MIN_SEARCH_CHARS
)
```

Replace the literal `2` at the existing `>= 2` (line 69) and `< 2` (line 75)
sites with `MIN_SEARCH_CHARS`. Add `isSubThreshold` to the returned object.

The defense-in-depth `< 2` guard inside `executeSearch` already prevents a
fetch from firing when the user is sub-threshold; no new logic is needed
there.

### 2. `TutorialNavigator.vue`

Destructure `isSubThreshold` from `useSearch()`. Wrap the four mutually
exclusive result-area branches in a single `<Transition>` with
`mode="out-in"`:

```vue
<Transition name="navigator-fade" mode="out-in">
  <div v-if="isSubThreshold" key="subthreshold" class="navigator-hint">
    <ui5-illustrated-message name="SearchEarth" design="Spot">
      <span slot="title">Keep typing…</span>
      <span slot="subtitle">Search starts at 2 characters.</span>
    </ui5-illustrated-message>
  </div>

  <div v-else-if="isSearching" key="loading" class="navigator-loading">…</div>

  <section v-else-if="displayedItems.length > 0" key="results" class="navigator-grid">…</section>

  <div v-else key="empty" class="navigator-empty">
    <ui5-illustrated-message name="NoFilterResults" …>
  </div>
</Transition>
```

The keys are required so Vue treats each branch as a distinct vnode and the
fade fires on swap. The exact branch order and conditions are finalized
during implementation; the design constraint is that **exactly one** branch
renders at a time and the `Transition` wrapper is shared across all of them.

### 3. CSS

Scoped to the component, with a `prefers-reduced-motion` guard:

```css
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

.navigator-result-area {
  min-height: 320px; /* prevents layout jump during out-in fade */
}
```

`min-height` is set on the result-area wrapper (the parent of the
`<Transition>`) — without it, the moment between leave and enter shrinks the
container to 0, causing the page to jump.

## Out of scope

- Changing the threshold itself (stays at 2; issue title was approximate).
- Server-side changes — `srv/search-service.js` already validates `>= 2` and
  is correct as-is.
- i18n of the hint copy — the navigator is currently en-only
  (`placeholder="Search for a tutorial"` is hardcoded too).
- Any change to filter chips, debounce timing, or the search endpoint.
- Adding a Vue Test Utils unit test — there is no existing test infra for
  navigator UI in this project; the change is small enough to validate
  manually.

## Verification

Manual on `npm run dev` (Hugo dev server at <http://localhost:1313>) against
the `/tutorials/` navigator:

1. Empty input → browse grid visible.
2. Type one letter → fade to hint illustration; browse grid hidden;
   network tab shows **no** request to `/search/SearchableItems`.
3. Type a second letter → fade to results; request fires.
4. Backspace `2 → 1` → fade back to hint.
5. Backspace `1 → 0` → fade back to browse grid.
6. With `prefers-reduced-motion: reduce` set in OS/browser, transitions are
   instant.
7. Quick consecutive typing (`a → ab → abc`) within `searchMode=true` does
   not flicker — the wrapper element stays the same, only the cards inside
   change.

No automated test added; smoke (`test/smoke/`) covers
`/search/SearchableItems` HTTP behavior, which is unaffected.

## Files touched

- [hugo-apps/src/navigator/useSearch.ts](../../../hugo-apps/src/navigator/useSearch.ts) — `MIN_SEARCH_CHARS` constant, `isSubThreshold` computed.
- [hugo-apps/src/navigator/TutorialNavigator.vue](../../../hugo-apps/src/navigator/TutorialNavigator.vue) — `<Transition>` wrapper, sub-threshold branch, scoped CSS, `min-height` on result-area wrapper.

No backend, schema, route, or build-pipeline changes.
