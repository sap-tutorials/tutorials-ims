# Navigator Search & Filter Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three Tutorial Navigator usability gaps (#3112): float selected filters to the top of each column, make a matching mission actually appear in search results (not just the count), and add a "My progress" (Completed / In progress) filter.

**Architecture:** Three mostly-independent slices. G1 is a presentational reorder of facet lists in the SFC. G2 is a server rank-boost (`srv/search-service.js`) + a `getFacets` filter-parity change (CDS + Node + client URL builder) + restoring real pagination in search mode (branch `totalPages` on `searchMode`, wire `currentPage`→`executeSearch`). G3 threads the existing `progress` ref into `useNavigatorFilters`, adds two URL-synced boolean flags mirroring `isNew`/`noLicense` across the ~6 sites that enumerate filter keys, and — when a progress toggle is active — forces the client-filter path (disabling server search) so counts stay exact.

**Tech Stack:** Vue 3 + TypeScript islands (`hugo-apps/src/`, Vitest), CAP Node.js service (`srv/search-service.js` + `srv/search-service.cds`), OData v4.

**Spec:** `docs/superpowers/specs/2026-11-12-navigator-search-filter-improvements-design.md`

## Global Constraints

- Client code is TypeScript Vue 3 under `hugo-apps/src/`; pure helpers must be unit-testable (Vitest). Server code is CAP Node.js — **no raw SQL** except via the existing `cds.parse.expr` rank pattern already in `attachSearchRank`; **no `req.user` without `@requires`** (no new endpoints here).
- Scoped unit tests only locally: `cd hugo-apps && npx vitest run <file>`. The full suite is hook-blocked locally and runs in CI.
- `useNavigatorFilters.ts` is **shared with `/browse/`** (a different SFC that supplies no `tutorials` and no `progress`). Every change must no-op cleanly when `progress` is absent: absent progress ⇒ no progress constraint, and no "My progress" column on `/browse/`.
- PR over direct merge; branch off fresh `origin/main`; target DEV. User-facing `hugo/**` change ⇒ add/extend a committed Playwright e2e spec (advisory; real e2e runs post-DEV-deploy).
- Progress data reuse only — no change to `/build/my-progress` or how progress is computed. Use `cardProgress(item, progress)` for all progress matching; never re-derive slugs.

## Review Focus

- **Anonymous shared link `?completed=1`** (G3): an anon session opening a link with a progress flag must NOT be filtered to an empty grid — the flag is scrubbed in `parseNavState` on load/reload. Test owned by Task 7.
- **Progress toggle + active search query** (G3): typing a query AND checking Completed must return exact completed cards (client path), not an inflated server count with empty pages. Test owned by Task 8.
- **Mission matches but ranks below page 1** (G2): a mission counted in the lozenge must be reachable — same filtered query feeds lozenge and pager, and rank-boost lifts it. Tests owned by Tasks 3 & 5.
- **`/browse/` mount (no progress, no tutorials)** (G3): the composable must not render a progress column or crash when `progress` is undefined. Test owned by Task 6.
- **Selected filter scrolled out of the 7.5rem box** (G1): a checked item below the fold must move to the top. Test owned by Task 1.

---

## Task 1: `partitionSelected` helper + wire into all four filter columns (G1)

**Files:**
- Create: `hugo-apps/src/shared/partitionSelected.ts`
- Create: `hugo-apps/src/shared/__tests__/partitionSelected.test.ts`
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue` (template columns ~L382, L400, L413, L423; add computeds in `<script setup>`)

**Interfaces:**
- Produces: `partitionSelected<T>(list: T[], isSelected: (item: T) => boolean): T[]` — returns a new array with selected items first, preserving relative order within the selected group and within the unselected group (stable partition). Pure.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { partitionSelected } from '../partitionSelected'

describe('partitionSelected', () => {
  it('moves selected to front, stable within each group', () => {
    const list = ['a', 'b', 'c', 'd']
    const sel = new Set(['b', 'd'])
    expect(partitionSelected(list, x => sel.has(x))).toEqual(['b', 'd', 'a', 'c'])
  })
  it('returns a new array and does not mutate input', () => {
    const list = ['a', 'b']
    const out = partitionSelected(list, () => false)
    expect(out).toEqual(['a', 'b'])
    expect(out).not.toBe(list)
  })
  it('all-selected and none-selected preserve original order', () => {
    expect(partitionSelected(['a','b','c'], () => true)).toEqual(['a','b','c'])
    expect(partitionSelected(['a','b','c'], () => false)).toEqual(['a','b','c'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/shared/__tests__/partitionSelected.test.ts`
Expected: FAIL — module not found / `partitionSelected` undefined.

- [ ] **Step 3: Implement `partitionSelected` in `hugo-apps/src/shared/partitionSelected.ts`**

Single stable pass: push selected into one array and unselected into another, concat. Do not sort.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/shared/__tests__/partitionSelected.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the SFC template**

In `TutorialNavigator.vue` `<script setup>`, add four computeds that wrap the existing lists with `partitionSelected`:
- `orderedTopics` over `filteredTopics`, selected = `filters.topics.includes(topic)`.
- `orderedProducts` over `filteredProducts`, selected = `isProductSelected(product.slugs)`.
- `orderedLevels` over the literal `['beginner','intermediate','advanced']`, selected = `filters.levels.includes(level)`.
- `orderedTypes` over the literal `['mission','group','tutorial']`, selected = `filters.types.includes(type)`.

Change the four `v-for` sources (L382 `filteredTopics`→`orderedTopics`, L400 `filteredProducts`→`orderedProducts`, L413 inline array→`orderedLevels`, L423 inline array→`orderedTypes`). Leave `isNew`/`noLicense` checkboxes (below the `<hr>`) unchanged. `:key` stays the same field.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/shared/partitionSelected.ts hugo-apps/src/shared/__tests__/partitionSelected.test.ts hugo-apps/src/navigator/TutorialNavigator.vue
git commit -m "feat(navigator): float selected filters to top of each column (#3112)"
```

---

## Task 2: Mission/group rank boost (G2, server)

**Files:**
- Modify: `srv/search-service.js` — `attachSearchRank` (~L206-212), add a type-weight term
- Test: `srv/test/search-rank.test.js` (create if absent; otherwise extend the existing search-service rank test — grep `attachSearchRank`/`_searchRank` under `srv/test/` first)

**Interfaces:**
- `attachSearchRank(query, tokens, kgFragment?, communityFragment?)` signature is unchanged. The rank SQL gains an additive, token-independent term: `+ case when taskType in ('MISSION','GROUP') then <W> else 0 end`. `<W>` is the builder's call (start ~2; it must let a mission's title match out-rank a tutorial body-only match, i.e. `3(title)` floor stays dominant but a mission with a title hit clears the tutorial tail). Pure additive; does not change what matches.

- [ ] **Step 1: Write the failing test**

Assert the generated rank SQL (or the parsed expr / an integration query against the in-memory SQLite `SearchableItems`) includes the mission/group boost and that, for a term matching one mission title and several tutorial bodies, the mission sorts first. Prefer an integration-style assertion over string-matching the SQL if the existing test harness already runs `SELECT.from(SearchableItems).search(term)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd . && npx vitest run srv/test/search-rank.test.js` (or the project's `npm test -- <file>` for that path)
Expected: FAIL — mission not ranked first / boost term absent.

- [ ] **Step 3: Implement the boost in `attachSearchRank`**

Add the `taskType in ('MISSION','GROUP')` case to `rankSQL` before the `cds.parse.expr(rankSQL)` call. Keep it inside the same parenthesised sum so `_searchRank` stays a single expression. Do not touch the KG/community fragments.

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/search-service.js srv/test/search-rank.test.js
git commit -m "feat(search): boost missions/groups in search rank so they surface (#3112)"
```

---

## Task 3: `getFacets` filter parity — products + isNew (G2, server)

**Files:**
- Modify: `srv/search-service.cds` — `getFacets` function params (~L69-73)
- Modify: `srv/search-service.js` — `getFacets` handler (~L545-582)
- Test: `srv/test/search-facets.test.js` (create/extend; grep `getFacets` under `srv/test/`)

**Interfaces:**
- Produces: `getFacets(search: String, taskTypes: array of String, experience: array of String, products: array of String, isNewCutoffISO: String)` — adds `products` (exact `primaryTag` match, OR within the list) and `isNewCutoffISO` (when non-empty, `createdAt gt <iso>`). Bucketing output shape (`FacetResult`) unchanged. This makes the facet count apply the SAME filter as `SearchableItems`, so per-type lozenge counts match the paginated set.

- [ ] **Step 1: Write the failing test**

Seed `SearchableItems` with rows across products/dates. Call `getFacets` with `products: ['cloud-application-programming-model']` and assert `typeCounts`/`totalCount` exclude non-matching-product rows; call with an `isNewCutoffISO` and assert older rows are excluded. Assert default (no products, empty cutoff) matches today's behavior.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/test/search-facets.test.js`
Expected: FAIL — params ignored, counts unfiltered.

- [ ] **Step 3: Implement**

In the CDS function, add the two params. In the handler, after the existing `taskTypes`/`experience` `.where`, add: `if (products?.length) q.where({ primaryTag: { in: products } });` and `if (isNewCutoffISO) q.where\`createdAt > ${isNewCutoffISO}\`;` using cds.ql (no raw SQL string). Keep the Node-side bucketing unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/search-service.cds srv/search-service.js srv/test/search-facets.test.js
git commit -m "feat(search): apply product + isNew filter to getFacets counts (#3112)"
```

---

## Task 4: Client `buildFacetsUrl` forwards products + isNew (G2, client)

**Files:**
- Modify: `hugo-apps/src/navigator/useSearch.ts` — `buildFacetsUrl` (~L87-99) + its call site in `executeSearch` (~L203)
- Test: `hugo-apps/src/navigator/__tests__/useSearch-facets.test.ts` (create; or extend an existing useSearch test — grep `buildFacetsUrl`)

**Interfaces:**
- Consumes: Task 3's `getFacets(..., products, isNewCutoffISO)`.
- Produces: `buildFacetsUrl(term, taskTypes, experience, searchBase?, products?, isNewCutoffISO?)` — appends `products=@p` (JSON array literal, same encoding as `taskTypes`) and `isNewCutoffISO=@n` (OData string literal, same as `@s`) when non-empty. Existing 4-arg calls stay valid (new params optional).

- [ ] **Step 1: Write the failing test**

Assert `buildFacetsUrl('cap', ['TUTORIAL'], [], '/search', ['abap'], '2026-01-01T00:00:00.000Z')` contains `products=@p`, `@p=` with the JSON-encoded `["abap"]`, and `isNewCutoffISO=@n` with the quoted ISO; assert the 4-arg form emits neither.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/navigator/__tests__/useSearch-facets.test.ts`
Expected: FAIL — extra params absent.

- [ ] **Step 3: Implement**

Extend `buildFacetsUrl` signature + body (mirror the `taskTypes`/`@s` encoding exactly — `encodeODataValue`, `escOData`). In `executeSearch`, pass `filterProducts.value` and the already-computed `isNewCutoffISO` to the call at L203.

- [ ] **Step 4: Run test to verify it passes**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/navigator/useSearch.ts hugo-apps/src/navigator/__tests__/useSearch-facets.test.ts
git commit -m "feat(navigator): forward products + isNew to getFacets for count parity (#3112)"
```

---

## Task 5: Restore search-mode pagination (G2, client)

**Files:**
- Modify: `hugo-apps/src/shared/composables/useNavigatorFilters.ts` — `totalPages` (~L610), add a `currentPage`→`executeSearch` watcher; expose/return `searchTotalCount` if needed by the SFC
- Modify: `hugo-apps/src/navigator/useSearch.ts` — ensure `executeSearch(page)` is callable externally (it is returned already); confirm `searchTotalCount` reflects the filtered `@odata.count`
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue` — pager guard L536
- Test: `hugo-apps/src/navigator/__tests__/search-pagination.test.ts` (create) — unit-test the pure `totalPages` branching via a small extracted helper, OR a composable-level test with a mocked `useSearch`

**Interfaces:**
- Consumes: `searchMode`, `searchTotalCount` from `useSearch` (already destructured in the composable, L322-324); `executeSearch(page, pageSize)` (returned by `useSearch`, currently NOT destructured into the composable — add it).
- Produces: `totalPages` now = `searchMode ? ceil(searchTotalCount / pageSize) : ceil(filteredItems.length / pageSize)` when `tutorials && !clientSearch`, matching the existing `displayedItems`/`displayedTotalCount` branch condition.

- [ ] **Step 1: Write the failing test**

Extract a pure `computeTotalPages(searchMode: boolean, searchTotalCount: number, filteredLen: number, pageSize: number): number` into the composable module (exported) and test: `computeTotalPages(true, 100, 5, 48) === 3`; `computeTotalPages(false, 100, 5, 48) === 1`. (This isolates the branch the builder-check flagged as wrong today.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/navigator/__tests__/search-pagination.test.ts`
Expected: FAIL — helper not exported / wrong branch.

- [ ] **Step 3: Implement**

- Add `searchTotalCount` and `executeSearch` to the `useSearch(...)` destructure (~L322-324).
- Replace `totalPages` (L610) with the branched form using the same `searchMode.value && tutorials && !clientSearch` guard already used by `displayedTotalCount` (L636-639); in search mode divide `searchTotalCount.value` by `pageSize`.
- Add a watcher: `watch(currentPage, (p) => { if (searchMode.value && tutorials && !clientSearch) executeSearch(p - 1, pageSize) })`. `currentPage` is 1-based; `executeSearch` is 0-based → pass `p - 1`. The existing reset watcher (L700) already resets `currentPage` to 1 on query/filter change, so a new query re-fetches page 0 via that reset → this watcher. Confirm the reset fires (it watches `searchQuery`).
- In the SFC, change pager guard L536 from `v-if="totalPages > 1 && !searchMode"` to `v-if="totalPages > 1"`.

- [ ] **Step 4: Run test to verify it passes + manual smoke note**

Run: same as Step 2. Expected: PASS. (Full interactive paging is covered by the e2e task.)

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/shared/composables/useNavigatorFilters.ts hugo-apps/src/navigator/useSearch.ts hugo-apps/src/navigator/TutorialNavigator.vue hugo-apps/src/navigator/__tests__/search-pagination.test.ts
git commit -m "fix(navigator): paginate search results so counted items are reachable (#3112)"
```

---

## Task 6: NavState gains `completed`/`inProgress` across all enumeration sites (G3, URL sync)

**Files:**
- Modify: `hugo-apps/src/navigator/urlSync.ts` — `PARAM` (~L16), `NavState` (L29), `EMPTY_STATE` (L42), `parseNavState` (L72-93), `serializeNavState` (L103-109), the persisted-options object (L137-148), the legacy/migration read (L164-178 — no legacy key needed, just the JSON-persist branch)
- Test: `hugo-apps/src/navigator/__tests__/urlSync-progress.test.ts` (create)

**Interfaces:**
- Produces: `NavState` gains `completed: boolean`, `inProgress: boolean`. URL params `completed`/`inProgress` (`?completed=1`). Round-trips through `serializeNavState`/`parseNavState` exactly like `isNew`/`noLicense`. **Anon scrub param is Task 7** — this task only adds the fields and their serialization.

- [ ] **Step 1: Write the failing test**

`serializeNavState` with `{...EMPTY_STATE, completed: true}` → URL contains `completed=1`; `parseNavState` of that URL → `completed === true`, `inProgress === false`. Both default false from a bare URL. Mirror the existing `isNew`/`noLicense` round-trip test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/navigator/__tests__/urlSync-progress.test.ts`
Expected: FAIL — fields/params absent.

- [ ] **Step 3: Implement**

Add the two keys to `PARAM`, `NavState`, `EMPTY_STATE` (both `false`), the `parseNavState` read (`asBool(sp.get(PARAM.completed)) ?? persisted.completed ?? false`), `serializeNavState` write (set `'1'` / delete, exactly like `isNew`), and the persisted-options object + JSON-persist read branch. No new legacy-migration key.

- [ ] **Step 4: Run test to verify it passes**

Run: same as Step 2. Expected: PASS. Also run the existing `urlSync.test.ts` + `urlSync-category.test.ts` to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/navigator/urlSync.ts hugo-apps/src/navigator/__tests__/urlSync-progress.test.ts
git commit -m "feat(navigator): add completed/inProgress to NavState URL sync (#3112)"
```

---

## Task 7: Thread `progress` into the composable + client-path progress predicate + anon scrub (G3, core)

**Files:**
- Modify: `hugo-apps/src/shared/composables/useNavigatorFilters.ts` — options type (add optional `progress?: Ref<ProgressPayload>`), `filters` reactive (L271-279 add `completed`/`inProgress`), `currentNavState` (L281-293), both watchers' key lists (L306-312 urlSync, L700-706 reset), `clearFilters` (L585-597), `hasActiveFilters` (L599-608), `filteredItems` predicate (L496-548)
- Modify: `hugo-apps/src/navigator/urlSync.ts` — `parseNavState` scrub: accept an `authenticated` signal so anon forces `completed`/`inProgress` to false
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue` — pass `progress` into `useNavigatorFilters({... progress})`
- Test: `hugo-apps/src/shared/composables/__tests__/progress-filter.test.ts` (create)

**Interfaces:**
- Consumes: `cardProgress(item, progress)` from `cardProgress.ts`; `ProgressPayload` (has `authenticated`).
- Produces: `filteredItems` gains a progress predicate: when `filters.completed` → keep items where `cardProgress(item, progress)?.complete === true`; when `filters.inProgress` → keep items where a `cardProgress` result exists with `complete === false` (percent>0, tutorials only); both on → union; neither → no constraint. When `progress` is undefined (e.g. `/browse/`) the predicate is a no-op. Anon (`progress.authenticated === false`) forces both flags off.

- [ ] **Step 1: Write the failing test**

Build a small `allCards` + `ProgressPayload` (authenticated, one completed tutorial slug, one in-progress slug, one completed mission slug). Drive the composable (or a pure extracted `matchesProgress(item, filters, progress)` helper — preferred for unit isolation) and assert: `completed` on → completed tutorial + completed mission, excludes in-progress; `inProgress` on → only the in-progress tutorial, excludes mission (binary); both → union; neither → all pass; `progress` undefined → all pass regardless of flags.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/shared/composables/__tests__/progress-filter.test.ts`
Expected: FAIL — predicate/helper absent.

- [ ] **Step 3: Implement**

Extract `matchesProgress(item, { completed, inProgress }, progress?)` pure helper and use it inside `filteredItems`. Add `progress` to options. Add `completed`/`inProgress` to `filters`, `currentNavState`, both watcher key lists, `clearFilters` (reset to false), `hasActiveFilters` (`|| filters.completed || filters.inProgress`). In `parseNavState`, add an optional `authenticated` arg; when false, force `completed`/`inProgress` to false in the returned state (scrub). The composable's mount read (L342-364) passes `progress?.value.authenticated ?? false`. SFC passes `progress` into the composable options.

- [ ] **Step 4: Run test to verify it passes**

Run: same as Step 2. Expected: PASS. Re-run Task 6's urlSync test (parseNavState signature change must stay backward-compatible — `authenticated` optional, defaults to allowing the flags so existing callers/tests are unaffected).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/shared/composables/useNavigatorFilters.ts hugo-apps/src/navigator/urlSync.ts hugo-apps/src/navigator/TutorialNavigator.vue hugo-apps/src/shared/composables/__tests__/progress-filter.test.ts
git commit -m "feat(navigator): My progress filter predicate + anon scrub (#3112)"
```

---

## Task 8: Force client-filter path while a progress toggle is active (G3, search interaction)

**Files:**
- Modify: `hugo-apps/src/shared/composables/useNavigatorFilters.ts` — the `searchMode && tutorials && !clientSearch` guard used by `displayedItems` (L617-634), `displayedTotalCount` (L636-639), `displayedCounts` (L641-651), and `totalPages` (Task 5): gate all four on ALSO `!progressFilterActive`
- Test: extend `hugo-apps/src/shared/composables/__tests__/progress-filter.test.ts`

**Interfaces:**
- Consumes: `filters.completed`/`filters.inProgress` (Task 7), `searchMode`.
- Produces: `progressFilterActive = computed(() => !!(progress?.value.authenticated && (filters.completed || filters.inProgress)))`. When true, the four display computeds take the CLIENT branch even if `searchMode` is true, so the search substring (`filteredItems` already applies `searchQuery`) AND the progress predicate both run over `allCards`, with honest counts/pagination.

- [ ] **Step 1: Write the failing test**

With `tutorials` supplied, `searchQuery='hana'` (searchMode true), `filters.completed=true`, authenticated progress: assert `displayedItems` comes from the client `filteredItems` path (completed cards whose title/desc/tags include "hana"), NOT from `searchResults`; assert `displayedCounts`/`displayedTotalCount` equal the client `counts`/`filteredItems.length` (not facet-derived). With `filters.completed=false` the search path is used as before.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/shared/composables/__tests__/progress-filter.test.ts`
Expected: FAIL — still takes server branch while progress active.

- [ ] **Step 3: Implement**

Add `progressFilterActive`. Change the branch condition in all four computeds from `searchMode.value && tutorials && !clientSearch` to `searchMode.value && tutorials && !clientSearch && !progressFilterActive.value`. (The client branch already applies `searchQuery` inside `filteredItems`, so search text still narrows.)

- [ ] **Step 4: Run test to verify it passes**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/shared/composables/useNavigatorFilters.ts hugo-apps/src/shared/composables/__tests__/progress-filter.test.ts
git commit -m "feat(navigator): disable server search while a progress filter is active (#3112)"
```

---

## Task 9: "My progress" filter column in the SFC (G3, UI)

**Files:**
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue` — add a filter column + expose `completed`/`inProgress` binding; the column renders only when `progress.authenticated`
- Modify: `hugo-apps/src/shared/composables/useNavigatorFilters.ts` — return nothing new if `filters` is already returned (it is, L711); confirm `filters.completed`/`inProgress` are reachable via the returned `filters` reactive

**Interfaces:**
- Consumes: `filters` (reactive, already returned), `progress` ref (in SFC).
- Produces: a new `.filter-column` with heading "My progress" and two checkboxes (`Completed` → `filters.completed`, `In progress` → `filters.inProgress`) via `v-model`, inside `v-if="progress.authenticated"`. Styling mirrors the Experience/Type `filter-list--static` column.

- [ ] **Step 1: Write the failing e2e-ish/unit guard**

A component test (or extend the e2e in Task 10) asserting: when `progress.authenticated` is false the "My progress" heading is absent; when true, two checkboxes bound to `filters.completed`/`inProgress` render. If component-mount testing isn't set up for this SFC, fold this assertion into Task 10's Playwright spec and note it here as covered-by-e2e.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run <the test file>` (or mark covered-by-e2e).
Expected: FAIL / column absent.

- [ ] **Step 3: Implement**

Add the column in `.filters-grid` after the Type column, wrapped in `v-if="progress.authenticated"`. Two `<label class="filter-option">` with `<input type="checkbox" v-model="filters.completed">` / `filters.inProgress` and labels "Completed" / "In progress". Match existing column markup/classes.

- [ ] **Step 4: Run test to verify it passes**

Run: same as Step 2. Expected: PASS (or green in Task 10).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/navigator/TutorialNavigator.vue hugo-apps/src/shared/composables/useNavigatorFilters.ts
git commit -m "feat(navigator): My progress filter column (signed-in only) (#3112)"
```

---

## Task 10: Playwright e2e spec for the three behaviors (G1/G2/G3)

**Files:**
- Create/Modify: a spec under `test/e2e/` (grep `test/e2e/*.spec.*` for the navigator spec; extend it if one exists, else create `test/e2e/navigator-search-filter.spec.ts`)

**Interfaces:**
- Consumes: deployed Navigator; self-skips without `SMOKE_BASE_URL` (follow `test/e2e/README.md` + the existing e2e pattern).

- [ ] **Step 1: Write the spec (self-skipping)**

Three scenarios: (G1) check a product deep in the list, assert it is now the first `.filter-option` in that column; (G2) search a term known to match a mission, assert a mission card renders in results and the Mission lozenge count ≥ 1 is reachable; (G3) as a signed-in tech user, check "Completed", assert only completed cards show and the "My progress" column is present; as anon, assert the column is absent and a `?completed=1` URL does not empty the grid. Guard the signed-in parts on `SMOKE_TECH_USER`/`PASSWORD` like the existing e2e.

- [ ] **Step 2: Run locally if env present, else confirm self-skip**

Run: `npm run test:e2e` (self-skips without `SMOKE_BASE_URL`).
Expected: PASS or skip.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/navigator-search-filter.spec.ts
git commit -m "test(e2e): navigator search & filter improvements (#3112)"
```

---

## Notes for the executor

- Tasks 1, 2 are independent. Tasks 3→4 are a server/client pair (count parity). Task 5 depends on nothing but is clearer after 3-4. Tasks 6→7→8→9 are a chain (NavState fields → predicate+scrub → search-interaction → UI). Task 10 last.
- After the client tasks, run `npx vitest run` scoped to each new/changed test; the full suite + UI5 lint run in CI. Do NOT run the full suite locally (hook-blocked).
- `cardProgress()` is the only correct slug→state mapping — missions/groups use `mission-`/`group-` href prefixes; never strip prefixes by hand.
