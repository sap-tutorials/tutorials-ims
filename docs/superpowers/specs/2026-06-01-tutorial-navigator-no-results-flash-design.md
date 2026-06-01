# Tutorial navigator: stop the no-results flash

**Issue:** [sap-tutorials/tutorials-ims#159](https://github.com/sap-tutorials/tutorials-ims/issues/159)
**Reporter:** Daniel Wroblewski (2026-06-01)
**Scope:** `TutorialNavigator.vue` (the `/tutorial-navigator/` filter page)
**Out of scope:** CommandPalette (`⌘K`) text-swap flicker; result-page transitions; client-side caching of `/search`

---

## Problem

Typing into the navigator's search box, when the query has no matches, makes the
empty-state illustration visibly flash on every additional keystroke. The empty
state's `ui5-illustrated-message` is being unmounted and re-mounted between
keystrokes rather than held stable.

The reporter's acceptance criteria:

- Debounce the search input (200–300 ms).
- Keep the "no results" component mounted; only update its label; no transition flicker.

## Root cause

`TutorialNavigator.vue` wraps the entire result region in a single
`<Transition name="navigator-fade" mode="out-in">` whose four branches
(`loading` / `isSearching` / `isSubThreshold` / `displayedItems.length > 0` / empty)
each carry their own `key`. The `<Transition>` element is acting as a
state-machine discriminator, so every change between branches mounts/unmounts a
heavy `ui5-illustrated-message` (Spot-design SVG illustration).

`useSearch.ts` already debounces `executeSearch` at 300 ms, so the *server* is
not being hammered. But the round-trip flow for a no-match query like `zzzz`
typed one character at a time is:

1. `z` → `isSubThreshold` branch → mount `BeforeSearch` illustration.
2. `zz` → debounce fires → `isSearching=true` → unmount illustration, mount busy
   spinner → empty response → unmount spinner, mount `NoFilterResults`
   illustration.
3. `zzz` → debounce fires again → unmount `NoFilterResults`, mount busy spinner
   → empty response → unmount spinner, mount `NoFilterResults` again.
4. `zzzz` → repeat (3).

`mode="out-in"` sequences leave-then-enter, which makes the gap (where the pane
is empty between two illustrated messages) visible.

## Approach

Render the result-region states as **persistent siblings** gated by `v-show`,
not as `v-if` branches inside a `<Transition>`. The illustrated empty-state and
the sub-threshold hint mount once and stay mounted; their visibility toggles
via `display`. A separate, non-displacing busy indicator overlays the region
while a search is in flight.

`<Transition>` is reserved for the **initial load skeleton**, which only ever
appears once.

This is the smallest change that satisfies the acceptance criteria literally:
the empty-state component is never unmounted while the user is typing, so
there is no flash.

## Files

- **Modified:** `hugo-apps/src/navigator/TutorialNavigator.vue`
  - `.navigator-result-area` template restructured (see below).
  - One CSS rule added for the absolute-positioned busy indicator.
- **New:** `hugo-apps/src/navigator/TutorialNavigator.test.ts` — sibling-style
  test, matching existing `useSearch.test.ts` and `cardProgress.test.ts`.
- **Unchanged:** `hugo-apps/src/navigator/useSearch.ts` — current behavior is correct.

## Template restructure

### Before

```vue
<div class="navigator-result-area">
  <Transition name="navigator-fade" mode="out-in">
    <section v-if="loading" key="skeleton" …><Skeleton kind="card" :count="6" /></section>
    <div v-else-if="isSearching" key="searching" class="navigator-loading">
      <div class="fd-busy-indicator …" aria-label="Loading search results"></div>
    </div>
    <div v-else-if="isSubThreshold" key="subthreshold" class="navigator-hint">
      <ui5-illustrated-message name="BeforeSearch" design="Spot">…</ui5-illustrated-message>
    </div>
    <section v-else-if="displayedItems.length > 0" key="results" class="navigator-grid">
      <a v-for="item in displayedItems" …>…</a>
    </section>
    <div v-else key="empty" class="navigator-empty">
      <ui5-illustrated-message name="NoFilterResults" design="Spot">…</ui5-illustrated-message>
    </div>
  </Transition>
</div>
```

### After

```vue
<div class="navigator-result-area" :aria-busy="isSearching">
  <!-- Initial load skeleton: still uses Transition because it appears at most once. -->
  <Transition name="navigator-fade" mode="out-in">
    <section
      v-if="loading"
      key="skeleton"
      class="navigator-grid navigator-grid--loading"
      aria-label="Loading tutorials"
    >
      <Skeleton kind="card" :count="6" />
    </section>
  </Transition>

  <!-- In-flight indicator: positioned absolutely, does not displace siblings. -->
  <ui5-busy-indicator
    v-if="!loading"
    data-region-busy
    size="Medium"
    :active="isSearching"
    delay="400"
  ></ui5-busy-indicator>

  <!-- Persistent siblings: each mounts once and toggles via v-show. -->
  <div v-show="!loading && isSubThreshold" class="navigator-hint">
    <ui5-illustrated-message name="BeforeSearch" design="Spot">
      <span slot="title">Keep typing&hellip;</span>
      <span slot="subtitle">Search starts at 2 characters.</span>
    </ui5-illustrated-message>
  </div>

  <section
    v-show="!loading && !isSubThreshold && displayedItems.length > 0"
    class="navigator-grid"
  >
    <a v-for="item in displayedItems" :key="item.id" …>…</a>
  </section>

  <div
    v-show="!loading && !isSubThreshold && displayedItems.length === 0"
    class="navigator-empty"
  >
    <ui5-illustrated-message name="NoFilterResults" design="Spot">
      <span slot="title">No results match your filters</span>
      <span slot="subtitle">Try removing a filter or broadening your search.</span>
      <ui5-button design="Emphasized" @click="clearFilters">Clear all filters</ui5-button>
    </ui5-illustrated-message>
  </div>
</div>
```

Key invariant: when the user types two characters whose search returns no
results, then types a third character whose search also returns no results,
the `.navigator-empty` `<div>` and its child `ui5-illustrated-message` are the
same DOM nodes throughout. No mount, no unmount, no visible flash.

## Busy-indicator behavior

`ui5-busy-indicator` with `delay="400"` only renders the spinner if the busy
state persists for 400 ms. Since `useSearch.ts` debounces requests by 300 ms
and most empty/cached searches resolve in tens of milliseconds, fast searches
trigger no visible spinner. Only genuinely slow searches (uncached, large
result set) show one — and it overlays the previous content rather than
replacing it.

This replaces the existing `fd-busy-indicator` div used in the current
template's `key="searching"` branch. `ui5-busy-indicator` is part of the UI5
web components already loaded site-wide via the `ui5-bootstrap` shared
module — the planner should confirm the bootstrap is on the navigator entry
chunk, but no new dependency is expected.

## CSS

Additive only:

```css
.navigator-result-area {
  position: relative;
}

.navigator-result-area > [data-region-busy] {
  position: absolute;
  top: 0.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1;
}
```

The existing `.navigator-fade-*` keyframes stay as-is; they still apply to the
skeleton's `<Transition>`.

## Accessibility

- `.navigator-result-area` carries `:aria-busy="isSearching"`. Screen readers
  announce the busy state without the visual churn of a swapped spinner.
- `displayedTotalCount` (the count bar above the result area) updates in real
  time and is announced naturally as content updates — providing the live
  "you now have N results" feedback that the empty-state alone cannot.
- The empty-state title remains in the live `ui5-illustrated-message` slot;
  because it never unmounts, AT does not get repeated "No results match"
  announcements on every keystroke. (This is an accessibility *win* alongside
  the visual fix.)

## Testing

New Vitest component test in `hugo-apps/src/navigator/__tests__/`:

```ts
import { mount, flushPromises } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'
import TutorialNavigator from '../TutorialNavigator.vue'

describe('TutorialNavigator — no-results stability (#159)', () => {
  it('keeps the empty-state node mounted across consecutive empty searches', async () => {
    // Stub /search/SearchableItems to always return []
    // Stub /build/catalog with a couple of fake tutorials
    // Mount component
    const wrapper = mount(TutorialNavigator, { /* ... */ })
    const input = wrapper.get('input[type="text"]')

    await input.setValue('zz')
    await flushPromises()
    // Wait past the 300ms debounce
    await new Promise(r => setTimeout(r, 350))

    const emptyBefore = wrapper.find('.navigator-empty').element

    await input.setValue('zzz')
    await flushPromises()
    await new Promise(r => setTimeout(r, 350))

    const emptyAfter = wrapper.find('.navigator-empty').element

    // Same node reference: never unmounted between keystrokes.
    expect(emptyAfter).toBe(emptyBefore)
  })

  it('marks the result region aria-busy while a search is in flight', async () => {
    // Stub fetch with a controllable promise
    // Assert .navigator-result-area aria-busy="true" between input and resolution
  })
})
```

DOM-node identity across keystrokes is a strong proxy for "never unmounted",
which is the user-facing guarantee we want.

## Manual verification (post-deploy)

1. Visit `/tutorial-navigator/` on the deployed DEV approuter.
2. Slowly type `zzzzz` into the search input.
3. Confirm: the "No results match your filters" illustration appears once after
   the second character and stays put. No flicker.
4. Type `cap` — confirm result cards appear.
5. Backspace to empty input — confirm browse view (paginated `displayedItems`)
   returns.

## Risk

- Pure UI change in one Vue island.
- No schema / API / auth / persistence changes.
- One added CSS rule, additive only.
- Rollout via the normal Hugo + approuter path. Hugo **must** finish before
  any approuter packaging step (see [[feedback-hugo-before-mbt]]):
  1. `npm run build:hugo-apps` — Vite re-bundles the navigator island into
     `hugo/static/js/`.
  2. `npm run build:hugo` (or full `npm run build:all`) — Hugo emits
     `hugo/public/` referencing the new bundle.
  3. Either `cd .deploy && mbt build && cf deploy …` (full MTA) or, since this
     is approuter-static-only, `cf push tutorials-approuter -p approuter`
     after copying `hugo/public/` into `approuter/static/` per
     `mta.yaml`'s build-result step. The fast path skips `mbt build`
     (~10 min) but **only** works if Hugo has just been rebuilt.

## Out of scope (deferred)

- CommandPalette (cmd-K palette) text-swap flicker — same mechanism, different
  surface. File a sibling issue if Tom wants.
- Reactive "last good result" pattern (Option C from brainstorming) — would
  also smooth result-page transitions, but Daniel's report is empty-state
  specific. YAGNI.
- Client-side caching of `/search/SearchableItems` responses — orthogonal.
