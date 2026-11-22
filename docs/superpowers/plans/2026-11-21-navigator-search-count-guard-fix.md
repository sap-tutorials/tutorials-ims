# Navigator Search Count-Guard Fix + Pinned Filters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a matched mission/group actually render in navigator search results (fix #3112, which PR #3123 failed to fix), and pin selected filters above each facet list.

**Architecture:** One root cause — the `before('READ', SearchableItems)` hook bails on `$count=true` (`srv/search-service.js:283`), which the navigator always sends, so the word-boundary filter + rank never run on the live cards query. Fix: apply the filter on all reads; gate only the `_searchRank` column+orderBy behind `!sel.count`. Plus a client-side per-column pinned selected-chips block in the navigator Vue island.

**Tech Stack:** CAP Node.js (`@sap/cds` 10.2.2), Vitest + in-memory SQLite (unit), CAP OData over SQLite, Vue 3 island (`hugo-apps/`), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-11-21-navigator-search-count-guard-fix-design.md`

## Global Constraints

- Branch from fresh `origin/DEV`; PR targets `DEV` (not `main` — no main-hotfix path). Already on branch `worktree-3112-navigator-search-count-guard` off `origin/DEV`.
- Never change match semantics (word-boundary tokenization, stopwords, KG/community rerank). The fix is about *when* the filter/rank run, not *what* matches.
- Anti-goal: never push `_searchRank` onto a `COUNT(*)` projection (the guard's original real concern).
- CDS/API work: verify against cds-mcp before changing CDS; no raw SQL outside the existing `applyWordBoundarySearch`/`attachSearchRank` string-built clauses (which are pre-existing and out of scope to rewrite).
- Fresh worktree: `srv/lib/_shared/mcp.bundle.mjs` must exist before unit tests run — generate with `node scripts/bundle-shared.cjs` (already run this session; re-run after a clean).
- Full unit suite is hook-blocked locally; run scoped: `npm test -- <file>` / `npx vitest run <file>`.

## Review Focus

- **Count path with no `$search`** (`$count=true` alone): must still short-circuit via the phrase guard and return the full-corpus count unchanged — pinned by Task 1 test "plain $count unaffected".
- **Internal `srv.run(SELECT…search…)` callers with no `sel.columns`** (MCP `search_tutorials`, semantic search): `attachSearchRank` self-bails at `:232`; the guard change must not break them — pinned by Task 1 test "internal search-without-columns still filters".
- **getFacets vs pager count agreement** after the fix (both should be the word-boundary set): a residual off-by-set would show a lozenge the grid can't fill — pinned by Task 1 test "count agrees with getFacets totalCount".
- **e2e self-skip masking the bug**: the existing G2 test uses `SAP` and skips if the lozenge is 0, so it can stay green before and after — Task 3 switches it to `Device` and asserts the pre→post flip.
- **Pinned-chip removal wiring**: clicking a pinned chip must clear exactly that selection (not toggle a neighbor) — pinned by Task 2 test "removing a pinned chip clears only that filter".

---

## Task 1: Server — split the count guard so search filter + rank apply on the cards query

**Files:**
- Modify: `srv/search-service.js:279-323` (the `before('READ', SearchableItems)` hook)
- Test: `test/search-service.test.js` (add cases to the existing `describe('SearchableItems'…)` block)

**Interfaces:**
- Consumes: existing `applyWordBoundarySearch(query, term) -> string[]` (`:137`), `attachSearchRank(query, tokens, kgFragment?, communityFragment?)` (`:191`, self-bails when `!sel.columns`).
- Produces: nothing new; behavior change only. After this task, a `$search`+`$count=true` read returns the word-boundary-filtered count and (on the data read) rank-ordered rows with `searchScore` populated.

- [ ] **Step 1: Write the failing tests** in `test/search-service.test.js` (SearchableItems block). Use the existing fixtures (`search-t2` cap-getting-started, `search-m1` full-stack-mission both match `CAP`; `search-mprobe` mission matches `missionprobe`):

```js
it('$search + $count=true returns the word-boundary-filtered count (not 0, not whole corpus)', async () => {
  const { data } = await project.get('/search/SearchableItems?$search=CAP&$count=true&$top=48');
  const slugs = data.value.map(i => i.slug);
  expect(data['@odata.count']).toBeGreaterThan(0);
  expect(slugs).toContain('cap-getting-started');
  expect(slugs).toContain('full-stack-mission');
  expect(slugs).not.toContain('hana-cloud-setup'); // no CAP word → filter really applied
});

it('$search + $count=true ranks a matching MISSION ahead of tutorial body-only matches', async () => {
  // missionprobe: mission body-match (2+2 type-boost=4) must out-rank tutorial body-only (2).
  const { data } = await project.get('/search/SearchableItems?$search=missionprobe&$count=true&$top=48');
  const idx = data.value.findIndex(i => i.slug === 'missionprobe-mission');
  expect(idx).toBe(0);
  expect(data.value[0].searchScore).toBeGreaterThanOrEqual(4);
});

it('plain $count=true with no $search is unaffected (full corpus count)', async () => {
  const { data } = await project.get('/search/SearchableItems?$count=true');
  expect(data['@odata.count']).toBeGreaterThanOrEqual(5);
});
```

- [ ] **Step 2: Run tests to verify they FAIL** — Run: `npx vitest run test/search-service.test.js -t "count"`. Expected: the first two FAIL on current code (count=0 / mission not at idx 0, because the guard bails); the third PASSES already.

- [ ] **Step 3: Implement the guard split** in `srv/search-service.js:279-323`. Change `if (!sel || sel.count) return;` (`:283`) to `if (!sel) return;`. Leave the phrase guard (`:284-287`) and `applyWordBoundarySearch` call (`:288-289`) unconditional. Wrap the KG/community fragment block (`:291-320`) **and** the `attachSearchRank(...)` call (`:322`) in a single `if (!sel.count) { … }` so the rank column/orderBy and the KG work run only on the data read, never the count projection. Update the `:281-282` comment to describe the split (filter always; rank only when not a count projection).

- [ ] **Step 4: Run tests to verify they PASS** — Run: `npx vitest run test/search-service.test.js -t "count"`. Expected: all three PASS.

- [ ] **Step 5: Run the full search-service suite for regressions** — Run: `npx vitest run test/search-service.test.js`. Expected: all green (existing `$search`, pagination, bodyText, word-boundary cases still pass).

- [ ] **Step 6: Commit**

```bash
git add srv/search-service.js test/search-service.test.js
git commit -m "fix(search): apply word-boundary filter+rank on \$count reads so missions surface (#3112)"
```

---

## Task 2: Client — per-column pinned selected-filter chips above each facet list

**Files:**
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue` (filter section `:391-476`)
- Modify: `hugo/assets/css/home.css` (add `.filter-selected-pins`)
- Test: `hugo-apps/src/navigator/__tests__/TutorialNavigator.*` if present, else add a focused Vitest component test alongside the island (check for existing test dir first).

**Interfaces:**
- Consumes: existing reactive `filters.topics/products/levels/types` arrays and the toggles `toggleFilter(dimension, value)` / `toggleProduct(value)` / `isProductSelected(value)` from `useNavigatorFilters.ts` (`:630-646`); the `ordered*` computeds (`:208-227`) and `partitionSelected` stay as-is (keep the in-list float).
- Produces: a `.filter-selected-pins` block per column; no new composable API.

- [ ] **Step 1: Write the failing component test** asserting that when a topic/product/level/type is selected, a chip with its label renders in the `.filter-selected-pins` block for that column, and clicking the chip's remove control calls the matching toggle so the selection clears. (If no island component-test harness exists, add a minimal Vitest + `@vue/test-utils` mount test; name it `renders and removes pinned selected filter chips`.)

- [ ] **Step 2: Run test to verify it FAILS** — Run: `npm --prefix hugo-apps run test -- TutorialNavigator` (or the discovered test command). Expected: FAIL (no `.filter-selected-pins` element).

- [ ] **Step 3: Implement the pinned block.** In `TutorialNavigator.vue`, above each `.filter-list` in the four facet columns (`:394-460`), add a `.filter-selected-pins` block that `v-for`s over the selected values for that dimension (derive from `filters.*`), rendering a removable chip per selection whose click invokes the existing toggle for that dimension. Keep the existing in-list `ordered*`/`partitionSelected` float untouched. Add `.filter-selected-pins` + chip styles in `home.css` using existing Horizon token variables; do not change the `.filter-list` `max-height`.

- [ ] **Step 4: Run test to verify it PASSES** — Run the same command. Expected: PASS.

- [ ] **Step 5: Typecheck/lint the island** — Run: `npm --prefix hugo-apps run build` (or `lint`/`typecheck` if faster). Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/navigator/TutorialNavigator.vue hugo/assets/css/home.css hugo-apps/src/navigator/__tests__/
git commit -m "feat(navigator): pin selected filters above each facet list (#3112)"
```

---

## Task 3: e2e — make the G2 mission-search test actually exercise the dropped-mission path

**Files:**
- Modify: `test/e2e/navigator-search-filter.spec.ts:106-173` (G2 test)

**Interfaces:**
- Consumes: deployed navigator (post-fix on DEV). No code interface.

- [ ] **Step 1: Change the search term and tighten the assertion.** Replace the `searchInput.fill('SAP')` (`:140`) with `'Device'` — the proven repro term that matches a mission buried past `$top=48` pre-fix and ranked onto page 1 post-fix. Keep the "lozenge ≥ 1 ⇒ mission card MUST be visible" invariant. Add a comment citing #3112 and the design doc. Do **not** widen the graceful-skip; if `Device` yields a 0 lozenge on the target env the test should still skip (content varies) — but on DEV/PROD with the Devtoberfest mission present it will assert.

- [ ] **Step 2: Verify the test flips.** Against the current PROD (pre-fix) the assertion fails; against a post-fix DEV deploy it passes. Document the manual check: `SMOKE_BASE_URL=<dev-url> npx playwright test test/e2e/navigator-search-filter.spec.ts -g "G2"`. (This runs post-deploy, not in CI PRs — note it in the PR description.)

- [ ] **Step 3: Commit**

```bash
git add test/e2e/navigator-search-filter.spec.ts
git commit -m "test(e2e): search 'Device' so G2 exercises the buried-mission path (#3112)"
```

---

## Task 4: Hybrid confirmation + PR

**Files:** none (verification + PR).

- [ ] **Step 1: Hybrid assertion (real HANA)** — if a hybrid search test exists (`test/*hybrid*`/`npm run test:hybrid`), add/confirm an assertion that `$search=Device&$top=48&$count=true` returns `@odata.count` 56 (or current PROD value) with a MISSION at `searchScore` 7 on page 1, and that `getFacets(search='Device')` totalCount equals that `@odata.count`. Requires `cf login`. If no hybrid harness fits cheaply, record the two-row curl proof from the design doc against the DEV deploy in the PR instead.

- [ ] **Step 2: Full scoped verification** — Run: `npx vitest run test/search-service.test.js` and the island test. Expected: green. Re-generate the shared bundle first if the worktree was cleaned (`node scripts/bundle-shared.cjs`).

- [ ] **Step 3: Open the PR to DEV** — `gh pr create --base DEV` with a body covering: the real root cause (guard shadowing #3123's boost), the proof table, what #3123 got wrong, the pinned-filters default, and the post-deploy e2e/hybrid steps. Link #3112.

---

## Notes carried from the design (decided, not open)

- One PR for both server fix and pinned filters (Tom, 2026-11-21).
- Keep the in-list `partitionSelected` float (dropping it breaks the existing G1 e2e).
- getFacets product-mirroring already works — no re-fix, locked by Task 1's count-agreement test.
- Q1 spike **already run this session**: the bug is unit-reproducible on SQLite (`$search=CAP&$count=true` → count 0 on buggy code), so the count assertion lives in the unit test (Task 1), with hybrid as confirmation (Task 4).
