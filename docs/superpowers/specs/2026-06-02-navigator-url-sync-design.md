# Navigator URL Sync — Design

- **Issue:** [#195](https://github.com/sap-tutorials/tutorials-ims/issues/195)
- **Parent:** [#152](https://github.com/sap-tutorials/tutorials-ims/issues/152) (closed by [#194](https://github.com/sap-tutorials/tutorials-ims/pull/194))
- **Branch:** `fix/issue-195-navigator-url-sync`
- **Worktree:** `D:\projects\tutorials-poc\.claude\worktrees\issue-195-navigator-url-sync`
- **Date:** 2026-06-02
- **Author:** Claude (with Tom's design decisions)

## Problem

The Tutorial Navigator's filters (Mission/Group/Tutorial type, level, product, topic, search query, current page) live only in Vue reactive state. The URL stays at `/` regardless of filter state, so:

- Users can't share, bookmark, or paste a filtered view.
- Reloading the page resets all filters.
- Linking from chat / docs / Joule to a specific filter set is impossible.

Daniel raised this in [#152's comment thread](https://github.com/sap-tutorials/tutorials-ims/issues/152#issuecomment-4602071625). [#194](https://github.com/sap-tutorials/tutorials-ims/pull/194) shipped the contrast fix and explicitly deferred URL sync to this issue to keep scope focused.

## Goal

Selecting filters or typing a search term updates the URL in place via `history.replaceState`. Pasting that URL elsewhere, reloading, or opening it in a new tab reproduces the same filtered view.

## Non-goals

- Server-side rendering of a deep-linked filter URL. The navigator is a client-rendered Vue island; SSR-personalized navigator pages are a separate (much larger) change.
- `pushState`-based back-button history of every filter change. The existing Options toggles use `replaceState`; this design matches that to keep the API surface consistent.
- URL filters on the catalog page (`/build/catalog`) or individual mission / group pages. Different surfaces, different audiences.
- New filter dimensions. Schema is exactly today's filter set: `q`, `types`, `levels`, `products`, `topics`, `isNew`, `noLicense`, `page`.

## Locked design decisions

Captured from Tom's `AskUserQuestion` answers during brainstorming:

| Question | Decision |
|---|---|
| Pagination | Sync `?page=N` only when `N > 1`; omit on page 1; reset to 1 on filter change |
| Write cadence | Use the existing 300ms `debouncedSearch` tick — same edge as the search request |
| `localStorage` scope | Backstop applies to filters (`types` / `levels` / `products` / `topics` / `isNew` / `noLicense`); `q` stays transient |
| Read precedence | URL > `localStorage` > defaults — for any field, presence in URL wins (including explicit-empty) |
| Canonicalization | Sort multi-value params alphabetically before serialization |
| Sub-threshold `q` | Still written to URL — preserves what the user typed even when search hasn't fired |
| `clearFilters()` | Wipes URL params and resets `currentPage` |

## Approach (chosen: extract a pure module)

Three approaches were considered:

- **A — Pure `urlSync.ts` module + thin Vue glue (CHOSEN).** Pure functions own URL ↔ state translation; the SFC keeps a thin watcher + debounce. Tests don't need Vue or JSDOM.
- **B — Inline expansion in the SFC.** Smaller diff but the SFC is already 1556 lines, and tests need JSDOM / `window` shims.
- **C — Vue composable `useNavigatorURL`.** Idiomatic Vue but couples URL serialization to ref shape; harder to unit-test; same JSDOM cost as B.

A wins on (1) testability without Vue infrastructure, (2) single source of truth for the URL contract — usable from Hugo build scripts or analytics later if needed, and (3) the existing in-place helpers migrate cleanly into the same module.

## Architecture

### Module layout

```
hugo-apps/src/navigator/
  urlSync.ts              (NEW — pure helpers + 2 thin window wrappers)
  urlSync.test.ts         (NEW — Vitest, no JSDOM)
  TutorialNavigator.vue   (rewired — deletes loadOptionsFromURL/syncOptionsToURL)
  useSearch.ts            (UNCHANGED)
  useSearch.test.ts       (UNCHANGED)
  cardProgress.ts         (UNCHANGED)
```

### Public API of `urlSync.ts`

```ts
export const PARAM = {
  q: 'q', types: 'type', levels: 'level', products: 'product',
  topics: 'topic', isNew: 'new', noLicense: 'noLicense', page: 'page',
} as const

export interface NavState {
  q: string
  types: string[]
  levels: string[]
  products: string[]
  topics: string[]
  isNew: boolean
  noLicense: boolean
  page: number          // 1-indexed; 1 means "no page param emitted"
}

export const EMPTY_STATE: NavState

// Pure parse: URL string + optional Storage → NavState
export function parseNavState(href: string, ls?: Storage | null): NavState

// Pure serialize: URL string + state → new URL string (never mutates state)
export function serializeNavState(href: string, state: NavState): string

// localStorage persistence (filters only — `q` excluded by design)
export function persistFilters(state: NavState, ls: Storage): void
export function readPersistedFilters(ls: Storage): Partial<NavState>

// Thin window wrappers — only impure surface
export function readNavStateFromWindow(): NavState
export function writeNavStateToWindow(state: NavState): void
```

### Parameter schema

| State field | URL param | Form | Empty-state behavior |
|---|---|---|---|
| `q` | `?q=` | URL-encoded string, sub-threshold values still emitted | omit when empty string |
| `types` | `?type=` | comma-joined, sorted alphabetically, lowercased on read | omit when empty array |
| `levels` | `?level=` | comma-joined, sorted alphabetically | omit when empty |
| `products` | `?product=` | comma-joined slugs, sorted | omit when empty |
| `topics` | `?topic=` | comma-joined slugs, sorted | omit when empty |
| `isNew` | `?new=1` | literal `1` only (no `?new=true`) | omit when false |
| `noLicense` | `?noLicense=1` | literal `1` only | omit when false |
| `page` | `?page=N` | integer ≥ 2 | omit when ≤ 1 |

### Canonicalization rules

1. **Sort multi-values alphabetically before serialize.** `?type=mission,group` and `?type=group,mission` produce the same URL; bookmarks don't thrash.
2. **Lowercase types on read** (`?type=Mission` → `mission`) — defensive for hand-edited URLs. Other slug-typed params are case-sensitive because their domain is.
3. **Comma-separator, no encoding gymnastics.** Slugs in this project never contain commas (they use `-` and `>`).
4. **Unknown params are preserved** (e.g. `utm_source`). The serializer uses `URLSearchParams.set/delete` per known key — never wipes the whole query string.
5. **`q` always written when non-empty**, even sub-threshold (< 2 chars).

### Read precedence

```
parseNavState(href, ls)
├── q          → URL only (NEVER from localStorage)
├── types      → URL if param present, else localStorage if present, else []
├── levels     → URL if param present, else localStorage if present, else []
├── products   → URL if param present, else localStorage if present, else []
├── topics     → URL if param present, else localStorage if present, else []
├── isNew      → URL if param present, else localStorage if present, else false
├── noLicense  → URL if param present, else localStorage if present, else false
└── page       → URL if `?page=N` parses as integer ≥ 2, else 1
```

**"URL is present"** means `searchParams.has(key)`, not "value non-empty". An explicit `?type=` (user manually clearing) overrides a non-empty localStorage entry — otherwise the bookmarked-empty state wouldn't reproduce. This mirrors the existing `?new=0` behavior.

### Write path

```
filters.types changes
    ↓ (Vue watcher in TutorialNavigator.vue)
debouncedURLSync(state)              ← 300ms debounce, same as useSearch
    ↓
writeNavStateToWindow(state)         ← thin wrapper
    ↓
serializeNavState(window.location.href, state)   ← pure
    ↓
window.history.replaceState({}, '', newHref)     ← side effect
    ↓ (also)
persistFilters(state, localStorage)              ← swallows quota / disabled errors
```

The `writeNavStateToWindow` wrapper checks `if (next !== window.location.href)` before calling `replaceState` — prevents the mount-time write-back loop where `onMounted` reads from URL, sets reactive state, and the watcher then immediately writes the same URL back.

## SFC integration (`TutorialNavigator.vue` changes)

### Zone 1 — Imports

```ts
+ import { onScopeDispose } from 'vue'
+ import {
+   parseNavState, writeNavStateToWindow, type NavState,
+ } from './urlSync'
```

### Zone 2 — Replace lines 35-66

Delete `loadOptionsFromURL`, `syncOptionsToURL`, and their `watch`. Replace with a `currentNavState()` helper, debounced `scheduleURLSync()`, and a wider `watch` covering all syncable state:

```ts
function currentNavState(): NavState {
  return {
    q: searchQuery.value,
    types: [...filters.types],
    levels: [...filters.levels],
    products: [...filters.products],
    topics: [...filters.topics],
    isNew: filters.isNew,
    noLicense: filters.noLicense,
    page: currentPage.value,
  }
}

let urlSyncTimer: ReturnType<typeof setTimeout> | null = null
function scheduleURLSync() {
  if (urlSyncTimer) clearTimeout(urlSyncTimer)
  urlSyncTimer = setTimeout(() => writeNavStateToWindow(currentNavState()), 300)
}
watch(
  [searchQuery, () => filters.levels, () => filters.types,
   () => filters.products, () => filters.topics,
   () => filters.isNew, () => filters.noLicense, currentPage],
  scheduleURLSync,
  { deep: true },
)
onScopeDispose(() => { if (urlSyncTimer) clearTimeout(urlSyncTimer) })
```

### Zone 3 — `onMounted` (lines 80-83)

Replace the two-call URL read with one parse:

```ts
onMounted(async () => {
- loadOptionsFromURL()
- const initialQuery = new URL(window.location.href).searchParams.get('q')
- if (initialQuery) searchQuery.value = initialQuery
+ const initial = parseNavState(window.location.href,
+   typeof localStorage !== 'undefined' ? localStorage : null)
+ searchQuery.value = initial.q
+ filters.types     = initial.types
+ filters.levels    = initial.levels
+ filters.products  = initial.products
+ filters.topics    = initial.topics
+ filters.isNew     = initial.isNew
+ filters.noLicense = initial.noLicense
+ currentPage.value = initial.page
  …
})
```

### Zone 4 — `clearFilters` (line 542)

One-line addition; the URL wipe falls out of the existing reactivity (the `watch` runs on the next tick, sees `EMPTY_STATE`, and `serializeNavState` produces a bare URL):

```ts
function clearFilters() {
  searchQuery.value = ''
  filters.levels = []
  filters.types = []
  filters.products = []
  filters.topics = []
  filters.isNew = false
  filters.noLicense = false
  productSearch.value = ''
  topicSearch.value = ''
+ currentPage.value = 1   // also reset page so URL drops `?page=` cleanly
}
```

### What does NOT change

- `useSearch.ts`, `useSearch.test.ts`, `cardProgress.ts` — untouched.
- The pagination-reset watcher at line 642-644 — untouched (filter changes still reset `currentPage` to 1; our `watch` covers `currentPage` so URL drops `?page=` automatically).
- Hugo / approuter / CAP — no changes; this is hugo-apps-only.

## Test plan

`hugo-apps/src/navigator/urlSync.test.ts` — Vitest, pure-function tests, no JSDOM. ~31 cases covering:

**`parseNavState` URL-only:** empty → `EMPTY_STATE`; `?q=`, `?type=`, `?level=`, `?product=`, `?topic=`, `?new=`, `?noLicense=`, `?page=` parsing; case tolerance (`Mission` → `mission`); explicit-empty (`?type=` → `[]`); only literal `1` parses booleans true; page bounds (`0`, `-2`, `foo`, `''` → 1); `?page=1` not upgraded.

**`parseNavState` precedence:** URL absent + localStorage present → fall through; URL present + localStorage present → URL wins; URL explicit-empty + localStorage non-empty → URL wins (empty); `q` never read from localStorage.

**`serializeNavState`:** `EMPTY_STATE` → bare URL; single-value emit; multi-value sort; `isNew=true` → `?new=1`; page omission for ≤ 1 / emit for ≥ 2; preserves unknown `utm_source` standalone and under update; never mutates input (defensive copy on sort).

**Round-trip:** parse ∘ serialize on 5 representative states deep-equals; canonicalization stable.

**`persistFilters` / `readPersistedFilters`:** filter arrays + booleans round-trip; `q` is NOT persisted; empty array `''` round-trip; `Partial<NavState>` shape.

**Defensive:** malformed `?type=,,mission,,` filters empty splits → `['mission']`.

`useSearch.test.ts` and other tests stay green.

## Failure modes

| Mode | Cause | Handling |
|---|---|---|
| `localStorage` throws | Private mode, full disk, blocked iframe | `try/catch` swallows; URL is canonical |
| `URL` constructor throws | Malformed `window.location.href` | Caller wraps `parseNavState` in `try/catch`; falls back to `EMPTY_STATE` |
| `replaceState` throws | Cross-origin rewrite (defensive) | `try/catch`; URL stays at previous value |
| Hand-edited junk values | `?type=BANANA`, `?page=NaN` | Each parser validates / normalizes; never throws |
| Stale `localStorage` shape | Schema change in a future version | Per-field type validation in `readPersistedFilters`; junk → defaults |
| SSR / `window` undefined | Hugo build evaluating component at build time | Module never touches `window` at import; only the two thin wrappers do; SFC already mount-gated |

## Acceptance criteria

1. Selecting any filter (`type`, `level`, `product`, `topic`) updates the corresponding URL param via `history.replaceState`.
2. Typing into the search box debounces a `?q=` write at the same 300ms cadence as the existing search.
3. Clicking a page-2 button writes `?page=2`; page 1 emits no `?page=` param.
4. Multi-value filter values appear sorted alphabetically in the URL.
5. Reloading the page reproduces the same filter set + search query + page.
6. `localStorage` backstops filter selections (not `q`) when no URL params are present.
7. `clearFilters()` wipes URL params AND resets `currentPage` to 1.
8. Unknown params (`utm_source` etc.) are preserved across writes.
9. Existing Options-toggle behavior (`?new`, `?noLicense`) is byte-identical to pre-change behavior.
10. `urlSync.test.ts` passes; all existing tests stay green.
11. `npm run build` (hugo-apps) succeeds with no new warnings.
12. Smoke check on deployed DEV: pasting `https://…/?q=cap&type=mission&level=beginner` opens the navigator with the expected filter chips lit and matching results.

## References

- Issue: [#195](https://github.com/sap-tutorials/tutorials-ims/issues/195)
- Parent: [#152](https://github.com/sap-tutorials/tutorials-ims/issues/152)
- Closing PR for parent: [#194](https://github.com/sap-tutorials/tutorials-ims/pull/194)
- Existing precedent: [TutorialNavigator.vue:35-66](../../../hugo-apps/src/navigator/TutorialNavigator.vue) (`loadOptionsFromURL` / `syncOptionsToURL`)
- Composable: [useSearch.ts](../../../hugo-apps/src/navigator/useSearch.ts)
- Tests: [useSearch.test.ts](../../../hugo-apps/src/navigator/useSearch.test.ts)
