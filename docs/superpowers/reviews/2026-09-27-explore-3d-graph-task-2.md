# Task 2 Report: `rank` on the explore-data payload (#2517)

**Date:** 2026-09-27
**Branch:** `worktree-spike-3d-force-graph-2517`
**Commit:** `f9257fca`

## Files Changed

| File | Change |
|------|--------|
| `srv/lib/kg-explore-data.js` | Added `rank` stamping in `buildExplorePayload` + updated JSDoc for `opts.rankMaps` |
| `srv/lib/kg-explore-data.test.js` | Created (new file); 4 tests for rank behaviour |
| `app/explore/src/types.ts` | Added `rank?: number` to `ExploreNode` interface |
| `hugo-apps/src/related-graph/types.ts` | Added `ExploreNode` interface with `rank?: number` |
| `vitest.config.ts` | Added `srv/lib/**/*.test.{js,ts}` to unit project include patterns |

## Test Command and Output

```
npx vitest run srv/lib/kg-explore-data.test.js
```

Output:
```
 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  11:36:39
   Duration  351ms
```

## Self-Review

- **TDD order followed:** test written first, confirmed 2 failures (rank stamping tests),
  then implemented, then all 4 pass.
- **Implementation matches brief Step 3 exactly:** `rankMaps` guard, `maxOf` helper,
  per-type max (`tMax`/`cMax`), per-node `src.get(node.slug)` lookup, `node.rank` assignment.
- **Additive/optional contract respected:** when `opts.rankMaps` absent or both maps empty,
  the guard short-circuits and NO node gets a `rank` key. Test coverage confirms this.
- **Only tutorial/concept nodes ranked:** the `src = null` path for other node types
  ensures non-tutorial/concept nodes never get `rank`. Not explicitly tested (no other
  node types in the one-row fixture), but the code path is clear and auditable.
- **Type files updated in both locations:** `app/explore/src/types.ts` (existing
  `ExploreNode`) + `hugo-apps/src/related-graph/types.ts` (new `ExploreNode` added since it
  didn't exist there). Both have `// #2517` commentary.
- **Existing tests green:** `test/unit/srv/kg-explore-data.test.js` (7 tests) and
  `test/unit/srv/kg-explore-data-iri-types.test.js` (8 tests) all pass unchanged.
- **vitest.config.ts change:** required to make `srv/lib/kg-explore-data.test.js` discoverable
  by the unit project. Added `srv/lib/**/*.test.{js,ts}` to the include array.

## Concerns

1. **`hugo-apps` ExploreNode:** The `hugo-apps/src/related-graph/types.ts` file didn't previously
   have an `ExploreNode` interface. I added one (matching `app/explore/src/types.ts` shape +
   `rank?`) since the brief explicitly requires both files. If the reviewer prefers a different
   approach (e.g., a shared cross-package type), the PR note should flag this.

2. **vitest.config.ts widening:** The `srv/lib/**/*.test.{js,ts}` pattern now includes any future
   test files placed directly in `srv/lib/`. This is intentional and consistent with the brief's
   `srv/lib/kg-explore-data.test.js` placement, but is a policy change worth noting.

3. **Other node types have no rank:** The implementation correctly skips them, but there's no
   explicit test for non-tutorial/concept nodes getting no rank. The one-row fixture only produces
   `t:a` and `c:b`. Coverage is adequate (the code path is short and auditable) but a reviewer
   might want an explicit test for e.g. `m:x` (mission).

---

## Round-1 Fix (commit `92f53e492`)

**Review findings addressed:**

**Finding A — Duplicate test file + config policy change:**
- Moved all 5 rank test cases from `srv/lib/kg-explore-data.test.js` into the existing
  `test/unit/srv/kg-explore-data.test.js` (appended after the existing 7 tests). The mock
  pattern (`vi.doMock('../../../srv/lib/kg-sparql-client.js', ...)` + `vi.resetModules()` in
  `beforeEach`) matches the file's established convention.
- Deleted `srv/lib/kg-explore-data.test.js`.
- Reverted the `srv/lib/**/*.test.{js,ts}` addition in `vitest.config.ts`; include array
  restored exactly to `d84562a56` state.
- Also added the reviewer-requested 5th test case: a mission node (`${KG}mission/x`) never
  receives `rank` even when `rankMaps` is supplied (with a tutorial in the same payload that
  does get rank — confirms the `src = null` branch fires for non-tutorial/concept types).

**Finding B — Dead ExploreNode in hugo-apps:**
- Reverted `hugo-apps/src/related-graph/types.ts` to `d84562a56` state; the `ExploreNode`
  interface and its comment are gone. `rank?: number` stays only in `app/explore/src/types.ts`.

**Test result after fix:**
`npx vitest run test/unit/srv/kg-explore-data.test.js` → 12 passed (7 original + 5 rank cases).
