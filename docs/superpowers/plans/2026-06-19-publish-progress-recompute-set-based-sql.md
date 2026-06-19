# Set-Based SQL Recompute — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-tutorial N+1 query pattern in the publish progress-recompute path with a single set-based HANA `MERGE INTO` statement, restoring publish performance from 286+ seconds per /append batch to <5 seconds per batch and unblocking #382 phase E.

**Architecture:** New module `srv/lib/recompute-tutorial-progress-bulk-sql.js` exports `recomputeTutorialProgressBulkSQL(db, namespace, tutorialIds)` which branches by db kind: HANA → single MERGE INTO statement; SQLite → loop over the existing `recomputeTutorialProgress` JS implementation (kept for testability + as a fallback). Two call sites in `srv/lib/content-publish-session.js` and one in `srv/lib/content-store.js` switch from per-slug recompute to the new bulk function. No schema changes. Read paths unchanged.

**Tech Stack:** Node.js 20, SAP HANA (production), SQLite (tests), CDS, Vitest, MERGE INTO + JOIN + GROUP BY (HANA SQL).

**Spec:** [docs/superpowers/specs/2026-06-19-publish-progress-recompute-set-based-sql-design.md](../specs/2026-06-19-publish-progress-recompute-set-based-sql-design.md)

**Branch:** `fix/publish-progress-recompute-set-based-sql` (spec already committed)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| [`srv/lib/recompute-tutorial-progress-bulk-sql.js`](../../../srv/lib/recompute-tutorial-progress-bulk-sql.js) | Create | New bulk function. HANA → MERGE INTO; SQLite → JS fallback loop. ~80-100 lines. |
| [`srv/lib/content-publish-session.js`](../../../srv/lib/content-publish-session.js) | Modify | Replace per-slug recompute call inside `appendToSession` (line ~346) with batch-level bulk call. Replace per-slug loop in `recomputeProgressForChangedTutorials` (lines ~564-592) with single bulk call. |
| [`srv/lib/content-store.js`](../../../srv/lib/content-store.js) | Modify | Replace per-slug call in legacy `publishHandler` (line ~510) with bulk call routed through the new function. |
| [`test/recompute-tutorial-progress-bulk-sql.test.js`](../../../test/recompute-tutorial-progress-bulk-sql.test.js) | Create | Unit tests covering SQLite fallback parity, no-op cases, cross-tutorial isolation, legacy publishHandler parity. |
| [`test/hybrid/recompute-tutorial-progress-bulk-sql.test.js`](../../../test/hybrid/recompute-tutorial-progress-bulk-sql.test.js) | Create | Hybrid (HANA) test exercising the MERGE statement with a realistic fixture, plus a 1000-user scale assertion. |

**Preserved (no change):**

- [`srv/lib/content-store.js`](../../../srv/lib/content-store.js) `recomputeTutorialProgress` (lines 85-121) — kept as the SQLite fallback target and single-tutorial helper. Issue #89 test exercises it directly.
- [`srv/developer-service.js`](../../../srv/developer-service.js) user step-complete write path (lines 673-694) — unchanged. Still computes progress per step-complete via `calculateTutorialProgress` and writes to the cached columns.
- All read sites (`user-progress.js`, `co-completion.js`, `scanner-service.js`, `admin-service.js`, `exports/`) — unchanged. They still read the cached columns. Same shape.

---

## Phase ordering

Five phases, each producing working software:

- **Phase A — SQL pre-flight** (validate the MERGE statement compiles + runs on DEV HANA before writing any code that depends on it)
- **Phase B — New module + unit tests** (TDD: SQLite tests first, then the bulk function with the SQLite fallback)
- **Phase C — Hybrid test** (HANA-side correctness assertion against DEV via `cds bind --exec`)
- **Phase D — Wire up call sites** (replace the three callers with the bulk function)
- **Phase E — Live deploy + smoke** (PR, merge, trigger publish, watch it succeed in <90s)

---

## Phase A — SQL pre-flight

The most important risk in the spec is "did the MERGE statement we wrote actually compile and produce correct results on HANA?" Validate that **before** writing code that depends on it. This phase is 5-10 minutes and catches a whole class of "design-time SQL bug → discover at hybrid-test time" surprises.

### Task A1: Run the MERGE statement against DEV with a known fixture

**Files:** none modified — read-only HANA validation.

- [ ] **Step 1: Identify a small, real fixture on DEV**

Pick 1-2 tutorials whose stepCount is stable and which have a small number of TUTORIAL TaskRecords. Find them via:

```bash
cd D:/projects/tutorials-poc
```

Then via the hana-cli MCP tool (`mcp__hana-cli__hana_query_simple`):

```sql
SELECT TOP 5 t.ID, t.SLUG, t.STEPCOUNT,
  (SELECT COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS tr
    WHERE tr.TASKLEGACYID = t.LEGACYID AND tr.TASKTYPE='TUTORIAL') AS user_count
FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS t
WHERE t.STEPCOUNT BETWEEN 3 AND 8
ORDER BY user_count DESC
```

Pick a tutorial with `user_count BETWEEN 5 AND 50` (small enough to verify by eye, large enough to exercise the JOIN). Note its `ID`.

- [ ] **Step 2: Capture the BEFORE state**

```sql
SELECT TOP 20 tr.ID, tr.USER_ID, tr.PROGRESS, tr.STATUS, tr.MODIFIEDAT
FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS tr
JOIN COM_SAP_DEVELOPERS_IMS_TUTORIALS t ON t.LEGACYID = tr.TASKLEGACYID
WHERE t.ID = '<the-id-from-step-1>' AND tr.TASKTYPE = 'TUTORIAL'
```

Save the result to a scratchpad (just paste into your chat or notes). You'll compare AFTER state to this.

- [ ] **Step 3: Run the spec's MERGE statement against the single tutorial**

Take the SQL from the spec's "Approach — set-based MERGE INTO" section. Bind `<the-id-from-step-1>` to both `:tutorialIds` placeholders. Run it.

Expected:
- HANA returns "N rows updated" where N is between 0 (everything was already correct) and the user_count from Step 1
- No SQL syntax errors
- The query completes in < 2 seconds

If HANA returns a syntax error, dial in the syntax. Likely fixes: bare-keyword reserved words (e.g. `OUTER` is a reserved keyword — rename the alias to `O` or `BASE` or `TR2`); missing `WITH PARAMETERS` clauses; integer arithmetic overflow.

- [ ] **Step 4: Capture the AFTER state and compare**

Re-run the SELECT from Step 2. Confirm:
- Rows where the JS recompute would have produced the same value should still have the same `PROGRESS` and `STATUS`. Their `MODIFIEDAT` should be UNCHANGED (the MERGE's `WHEN MATCHED AND (inequality)` predicate skipped them).
- Rows that genuinely needed a change show the new value.
- No row shows `PROGRESS = NULL` if it had a non-null value before (regression check).

If anything is wrong, refine the SQL until correct **before proceeding to Phase B**.

- [ ] **Step 5: Run the SQL twice in a row and confirm idempotency**

```sql
-- Run the MERGE again immediately
<paste the same MERGE>
```

Expected: 0 rows updated. The `WHEN MATCHED AND (inequality)` predicate filters out everything because the first run already converged the rows.

If non-zero rows are updated on the second run, the predicate is wrong. Fix.

- [ ] **Step 6: Capture the validated SQL and document any tweaks**

Whatever the SQL form actually is when it works correctly on DEV — keep that as the canonical statement. Paste it into a comment block in the new module's source file (Phase B **Task B2** — the implementation file `srv/lib/recompute-tutorial-progress-bulk-sql.js`, NOT the test file). Future maintainers see what was actually validated, not just what was speced.

**Phase A acceptance:** The MERGE statement runs on DEV HANA, produces correct results, and is idempotent. Document the final form (which may differ slightly from the spec's example).

---

## Phase B — New module + unit tests

### Task B1: Write the failing unit test

**Files:**
- Create: `test/recompute-tutorial-progress-bulk-sql.test.js`

- [ ] **Step 1: Read the existing JS implementation as the parity baseline**

```bash
cd D:/projects/tutorials-poc
sed -n '85,121p' srv/lib/content-store.js
```

Confirm the function signature: `recomputeTutorialProgress(db, namespace, tutorialId, stepCount) → { rechecked, updated }`.

- [ ] **Step 2: Read the issue-89 test for the test fixture pattern**

```bash
sed -n '1,80p' test/issue-89-progress-denominator.test.js
```

Match its setup pattern (cds.test, namespace, fixture seeding).

- [ ] **Step 3: Write the failing test**

Create `test/recompute-tutorial-progress-bulk-sql.test.js`:

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll } from 'vitest';
import { recomputeTutorialProgressBulkSQL } from '../srv/lib/recompute-tutorial-progress-bulk-sql.js';
import { recomputeTutorialProgress } from '../srv/lib/content-store.js';

const NS = 'com.sap.developers.ims';
const cds_test = cds.test('serve', '--in-memory').in(__dirname, '..');

describe('recomputeTutorialProgressBulkSQL — SQLite fallback parity (#382 phase E)', () => {
  let db, Tutorials, Steps, TaskRecords, Users;

  beforeAll(async () => {
    await cds_test;
    db = await cds.connect.to('db');
    ({ Tutorials, Steps, TaskRecords, Users } = cds.entities(NS));
  });

  it('matches per-tutorial recomputeTutorialProgress for a single tutorialId', async () => {
    // Seed: one user, one tutorial with stepCount=4, three STEP completions, one stale TUTORIAL record at progress=0
    const userId = cds.utils.uuid();
    const tutorialId = cds.utils.uuid();
    const tutorialLegacyId = 11000001;
    const stepLegacyIds = [11000002, 11000003, 11000004, 11000005];

    await INSERT.into(Users).entries({ ID: userId, imsId: 'fixture-user-1' });
    await INSERT.into(Tutorials).entries({
      ID: tutorialId, legacyId: tutorialLegacyId, slug: 'fixture-tutorial-bulk-1',
      title: 'Fixture', stepCount: 4, status: 'ACTIVE'
    });
    for (let i = 0; i < 4; i++) {
      await INSERT.into(Steps).entries({
        ID: cds.utils.uuid(), tutorial_ID: tutorialId, stepOrder: i + 1,
        title: `Step ${i+1}`, legacyId: stepLegacyIds[i], status: 'ACTIVE'
      });
    }
    // 3 of 4 steps completed
    for (let i = 0; i < 3; i++) {
      await INSERT.into(TaskRecords).entries({
        ID: cds.utils.uuid(), user_ID: userId, taskType: 'STEP',
        status: 'COMPLETED', taskLegacyId: stepLegacyIds[i], progress: 100
      });
    }
    // Stale TUTORIAL record at progress=0
    const tutRecId = cds.utils.uuid();
    await INSERT.into(TaskRecords).entries({
      ID: tutRecId, user_ID: userId, taskType: 'TUTORIAL',
      status: 'IN_PROGRESS', taskLegacyId: tutorialLegacyId, progress: 0
    });

    // Run the bulk function — SQLite path delegates to recomputeTutorialProgress per tutorial
    const result = await recomputeTutorialProgressBulkSQL(db, NS, [tutorialId]);
    expect(result.rechecked).toBeGreaterThanOrEqual(1);
    expect(result.updated).toBe(1);

    const updated = await SELECT.one.from(TaskRecords).where({ ID: tutRecId });
    expect(updated.progress).toBe(75);  // round(3/4 * 100) = 75
    expect(updated.status).toBe('IN_PROGRESS');
  });

  it('no-op when tutorialIds is empty', async () => {
    const result = await recomputeTutorialProgressBulkSQL(db, NS, []);
    expect(result).toEqual({ rechecked: 0, updated: 0 });
  });

  it('handles multiple tutorialIds in one call (cross-tutorial isolation)', async () => {
    // Seed two tutorials, modify TUTORIAL TaskRecords on both
    // Assert the bulk call updates both correctly
    // (Test left as an exercise; pattern mirrors the first test)
  });

  it('legacy publishHandler parity: identical end-state via bulk function', async () => {
    // Seed a tutorial with stale TUTORIAL records.
    // Snapshot the post-state of calling the OLD recomputeTutorialProgress directly.
    // Roll back; then call the new bulk function with the same input.
    // Assert end-states are identical.
    // (Test pattern: use a test database that supports rollback, OR seed two parallel fixtures.)
  });
});
```

The first test concretely fails until the new module exists. The other three are stub-shaped — fill them in completely once the basic test passes.

- [ ] **Step 4: Run the test to verify it fails on import**

```bash
npx vitest run test/recompute-tutorial-progress-bulk-sql.test.js
```

Expected: FAIL with `Cannot find module '../srv/lib/recompute-tutorial-progress-bulk-sql.js'`. Confirms the test is wired up correctly and ready to drive implementation.

### Task B2: Implement the new module

**Files:**
- Create: `srv/lib/recompute-tutorial-progress-bulk-sql.js`

- [ ] **Step 1: Write the module with SQLite fallback first**

Create `srv/lib/recompute-tutorial-progress-bulk-sql.js`:

```js
import cds from '@sap/cds';
import { recomputeTutorialProgress } from './content-store.js';

const LOG = cds.log('content-publish');

// The validated MERGE statement from Phase A, copied verbatim.
// Generated and validated against DEV HANA on 2026-06-19 against fixture
// tutorial <ID-noted-during-Phase-A>. See spec for design rationale and
// docs/superpowers/specs/2026-06-19-publish-progress-recompute-set-based-sql-design.md.
const BULK_RECOMPUTE_MERGE_SQL = `
MERGE INTO "COM_SAP_DEVELOPERS_IMS_TASKRECORDS" AS "T"
USING (
  /* paste the EXACT SQL from Phase A here */
) AS "S"
ON "T"."ID" = "S"."TR_ID"
WHEN MATCHED AND (
  ...
) THEN UPDATE SET
  ...
`;

/**
 * Bulk-recompute progress and status on TUTORIAL TaskRecords for a set of
 * tutorials. On HANA, executes a single MERGE INTO statement that does the
 * math set-based; on SQLite (test path), loops the per-tutorial JS
 * implementation.
 *
 * @param {object} db          - cds db service (from cds.connect.to('db'))
 * @param {string} namespace   - CDS namespace, e.g. "com.sap.developers.ims"
 * @param {string[]} tutorialIds - UUIDs (Tutorials.ID) of tutorials whose
 *                                 progress should be recomputed.
 * @returns {Promise<{rechecked: number, updated: number}>}
 */
export async function recomputeTutorialProgressBulkSQL(db, namespace, tutorialIds) {
  if (!Array.isArray(tutorialIds) || tutorialIds.length === 0) {
    return { rechecked: 0, updated: 0 };
  }

  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';

  if (!isHana) {
    // SQLite test path: loop the existing per-tutorial JS implementation.
    // Test fixtures are tiny so the JS overhead is negligible.
    const { Tutorials } = cds.entities(namespace);
    let totalRechecked = 0, totalUpdated = 0;
    for (const tutorialId of tutorialIds) {
      const tutorial = await SELECT.one.from(Tutorials)
        .where({ ID: tutorialId })
        .columns('ID', 'stepCount');
      if (!tutorial?.stepCount) continue;
      const result = await recomputeTutorialProgress(db, namespace, tutorialId, tutorial.stepCount);
      totalRechecked += result.rechecked || 0;
      totalUpdated += result.updated || 0;
    }
    return { rechecked: totalRechecked, updated: totalUpdated };
  }

  // HANA fast path: single set-based MERGE. The same tutorialIds list is bound
  // twice (inner aggregate scope + outer MERGE scope). HANA's parameter binding
  // for IN (...) varies by driver — if param-bind doesn't work, fall back to
  // string-interpolating a sanitized comma-separated list of single-quoted
  // UUIDs (UUIDs are not SQL-injection vectors).
  const start = Date.now();
  const result = await db.run(BULK_RECOMPUTE_MERGE_SQL, [tutorialIds, tutorialIds]);
  const durationMs = Date.now() - start;
  const updated = result?.affectedRows ?? null;
  LOG.info(`recomputeTutorialProgressBulkSQL: tutorialIds=${tutorialIds.length} updated=${updated ?? '(unknown)'} durationMs=${durationMs}`);
  return { rechecked: tutorialIds.length, updated };
}
```

If HANA's `db.run` doesn't accept array binding for `IN (...)`, fall back to string interpolation:

```js
const idsList = tutorialIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
const sql = BULK_RECOMPUTE_MERGE_SQL.replace(/:tutorialIds/g, idsList);
const result = await db.run(sql);
```

UUIDs are alphanumeric + `-` only — the `replace(/'/g, "''")` is belt-and-suspenders for the unlikely case of a malformed UUID.

- [ ] **Step 2: Re-run the test**

```bash
npx vitest run test/recompute-tutorial-progress-bulk-sql.test.js
```

Expected: first test PASSES. Other tests are stubs — fill them in next.

- [ ] **Step 3: Fill in the remaining unit tests (cross-tutorial isolation, legacy parity, no-op)**

The three skeleton tests above (cross-tutorial isolation, legacy parity, scale) are not real tests until you fill in their bodies. **This step is the gate** — do not move to Task B2 thinking the test file is "done" when it has stubs.

Specific assertions to write:

- **`cross-tutorial isolation`**: seed tutorials A and B, each with one user and a stale TUTORIAL TaskRecord. Call the bulk function with only A's tutorialId. Assert A's row updated, B's row untouched (its `progress`/`status`/`modifiedAt` all unchanged from the seeded values).
- **`legacy publishHandler parity`**: seed a tutorial with stale TUTORIAL records. Take a snapshot of post-state via the OLD `recomputeTutorialProgress` directly. Reset (use `cds.test`'s in-memory db reset between tests, OR seed a parallel fixture with different IDs). Call the new bulk function with the same input. Assert end-states are identical row-for-row.
- **`no-op when tutorialIds is empty`**: already in the file as the third test — just confirm it runs.

All three must produce real PASS results, not stubbed comments. The unit-test sweep at Task B2 Step 4 won't differentiate stubs from skipped tests, so verify each test name shows in the output before moving on.

- [ ] **Step 4: Run the full unit-test suite for regressions**

```bash
npm test -- --run srv/ test/
```

Expected: all tests pass (or only pre-existing unrelated noise like the publish-retry 502 mocks).

- [ ] **Step 5: Commit Phase B**

```bash
git add srv/lib/recompute-tutorial-progress-bulk-sql.js test/recompute-tutorial-progress-bulk-sql.test.js
git commit -m "feat(srv): add recomputeTutorialProgressBulkSQL with SQLite fallback (#382 phase E)"
```

---

## Phase C — Hybrid test

### Task C1: Write the hybrid test

**Files:**
- Create: `test/hybrid/recompute-tutorial-progress-bulk-sql.test.js`

The hybrid test runs against real HANA via `cds bind --exec`. It must follow the project's hybrid-test guards: `ALLOW_HYBRID_WRITES=true` envs, `__TEST__` data prefix, cleanup in `afterAll`.

- [ ] **Step 1: Read an existing hybrid test for the pattern**

```bash
cat test/hybrid/_guard.js
sed -n '1,80p' test/hybrid/duplicate-slugs.test.js
```

Note: hybrid tests share the cleanup convention `where slug like '__TEST__%'`.

- [ ] **Step 2: Write the hybrid test**

Create `test/hybrid/recompute-tutorial-progress-bulk-sql.test.js`:

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { recomputeTutorialProgressBulkSQL } from '../../srv/lib/recompute-tutorial-progress-bulk-sql.js';
import './_guard.js';

const NS = 'com.sap.developers.ims';
const TEST_PREFIX = '__TEST__bulk-recompute-';

describe('recomputeTutorialProgressBulkSQL — HANA MERGE (#382 phase E)', () => {
  let db;
  const seededTutorialIds = [];
  const seededUserIds = [];

  beforeAll(async () => {
    db = await cds.connect.to('db');
  });

  afterAll(async () => {
    if (seededTutorialIds.length === 0) return;
    const { Tutorials, Steps, TaskRecords, Users } = cds.entities(NS);
    // Cascade-delete the fixture rows
    await DELETE.from(TaskRecords).where({ user_ID: { in: seededUserIds } });
    await DELETE.from(Steps).where({ tutorial_ID: { in: seededTutorialIds } });
    await DELETE.from(Tutorials).where({ ID: { in: seededTutorialIds } });
    await DELETE.from(Users).where({ ID: { in: seededUserIds } });
  });

  it('correctness: 5 tutorials × 10 users with mixed completion produces correct progress + status', async () => {
    // Seed the fixture, run the bulk function, assert end-state
    // (Implementation: ~80 lines; pattern from the unit test scaled up)
  });

  it('idempotency: second run on identical state updates 0 rows', async () => {
    // Run the bulk function once; check updated > 0
    // Run again immediately; check updated == 0
  });

  it('cross-tutorial isolation: bulk call for tutorial A does not touch tutorial B', async () => {
    // Seed A and B; run only with A; assert B's TaskRecords unchanged
  });

  it('NULL-safe: row with NULL old PROGRESS gets updated to a non-NULL new value', async () => {
    // Seed a TUTORIAL TaskRecord with PROGRESS=NULL, run, assert PROGRESS is now non-NULL
  });

  it('scale: 1 tutorial × 1000 users completes in < 5 seconds', async () => {
    // Seed 1 tutorial × 1000 users with 50% completion. Time the bulk call.
    // Asserts the MERGE remains set-based at higher cardinality.
    // (This is the production shape; toy 5×10 fixtures don't exercise it.)
  });

  it('concurrent step-complete write does not corrupt MERGE result', async () => {
    // While the MERGE is running, fire a parallel UPDATE on one TUTORIAL
    // record. After both settle, assert the row's PROGRESS matches one of
    // the two valid orderings (HANA snapshot semantics).
  });
});
```

- [ ] **Step 3: Run the hybrid test**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/recompute-tutorial-progress-bulk-sql.test.js
```

Expected: all 6 tests pass against DEV HANA. **Each test body must have real assertions, not stub comments.** The 6-test scaffold above shows shape; you fill in seed/exercise/assert.

Fixture sizes per test:
- correctness: 5 tutorials × 10 users
- idempotency: 1 tutorial × 5 users (re-uses correctness fixture)
- cross-tutorial isolation: 2 tutorials × 3 users each
- NULL-safe: 1 tutorial × 1 user
- scale: 1 tutorial × 1000 users (the actual production shape)
- concurrent: 1 tutorial × 10 users with parallel UPDATE injection

If a test fails:
- Correctness: the MERGE statement is wrong. Go back to Phase A and re-validate.
- Performance: the scale assertion missed. The MERGE may be falling back to a row-iteration plan; check `EXPLAIN` output via hana-cli.
- Concurrency: the test may be racy. Investigate before assuming the SQL is wrong.

- [ ] **Step 4: Commit Phase C**

```bash
git add test/hybrid/recompute-tutorial-progress-bulk-sql.test.js
git commit -m "test(hybrid): MERGE INTO bulk recompute correctness + scale + concurrency (#382 phase E)"
```

---

## Phase D — Wire up call sites

Now that the bulk function is proven, switch the three callers.

### Task D1: Replace the per-slug call in appendToSession

**Files:**
- Modify: `srv/lib/content-publish-session.js` (line ~346 + the metadata loop above it)

- [ ] **Step 1: Identify the exact lines**

```bash
cd D:/projects/tutorials-poc
grep -n "recomputeTutorialProgress\|upsertTutorialMetadata" srv/lib/content-publish-session.js | head -10
```

Confirm line numbers haven't shifted from the spec.

- [ ] **Step 2: Make the change**

In `appendToSession`, the metadata-upsert loop builds tutorialIds in `upsertTutorialMetadata`. We need to expose those tutorialIds back to the caller. **First, audit `upsertTutorialMetadata`'s current signature and its single caller** (it's currently called only from `appendToSession`):

```bash
grep -n "upsertTutorialMetadata" srv/lib/content-publish-session.js srv/lib/content-store.js
```

Confirm only one caller. Then choose:

(a) **Recommended:** Modify `upsertTutorialMetadata` to return `{ tutorialIds, ... }` (instead of its current return shape — note what it is and either extend the return object or rename if more invasive)
(b) Capture them in a local Set inside `upsertTutorialMetadata` and pass via a callback

Option (a) is cleaner and safe given the single-caller audit. Adjust `upsertTutorialMetadata` to return an object including the array of touched tutorialIds. In `appendToSession`, after the upsert call, extract the array and pass to the bulk function.

Add the import at the top of the file:

```js
import { recomputeTutorialProgressBulkSQL } from './recompute-tutorial-progress-bulk-sql.js';
```

Remove the now-unused `recomputeTutorialProgress` import if no other call site in this file uses it.

- [ ] **Step 3: Run the existing tests**

```bash
npx vitest run test/issue-89-progress-denominator.test.js test/recompute-tutorial-progress-bulk-sql.test.js
```

Expected: all green. Issue-89's tests still call `recomputeTutorialProgress` directly (not through the new function), so they exercise the JS path; the new tests exercise the bulk path.

- [ ] **Step 4: Commit**

```bash
git add srv/lib/content-publish-session.js
git commit -m "refactor(publish): replace per-slug recompute in appendToSession with bulk SQL (#382)"
```

### Task D2: Replace the loop in recomputeProgressForChangedTutorials

**Files:**
- Modify: `srv/lib/content-publish-session.js` (lines ~564-592)

- [ ] **Step 1: Replace the function body**

The function currently loops slugs and calls `recomputeTutorialProgress` per-slug. Replace with one bulk slug→tutorialId resolution + one bulk recompute call.

**Important:** the slug-resolve loop in the existing code is N round-trips. With ~1400 slugs × ~50ms HANA latency that's ~70s — eating into the 90s publish budget all by itself. **Resolve all slugs in one query** instead:

```js
async function recomputeProgressForChangedTutorials(namespace, newVersion) {
  const { ContentFiles } = cds.entities(namespace);
  const db = await cds.connect.to('db');

  const rows = await SELECT.from(ContentFiles)
    .columns('slug')
    .where({ version: newVersion });
  const slugs = [...new Set(rows.map(r => r.slug))];
  if (slugs.length === 0) return;

  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  const { table, idCol, slugCol } = tutorialsTableInfo(namespace, isHana);

  // [#382] Resolve all slugs → tutorialIds in ONE query, not N. With 1400
  // slugs × ~50ms HANA latency, the per-slug loop alone would burn 70+ seconds
  // of the 90s publish budget before the bulk recompute even starts.
  const lowerSlugs = slugs.map(s => s.toLowerCase());
  const placeholders = lowerSlugs.map(() => '?').join(',');
  const hits = await db.run(
    `SELECT ${idCol}, LOWER(${slugCol}) AS LSLUG FROM ${table} WHERE LOWER(${slugCol}) IN (${placeholders})`,
    lowerSlugs
  );
  const tutorialIds = hits.map(h => h.ID ?? h.id).filter(Boolean);
  if (tutorialIds.length === 0) return;

  await recomputeTutorialProgressBulkSQL(db, namespace, tutorialIds);
}
```

This goes from ~30 lines per-slug-loop with N+1 inner SELECTs to one slug-resolution batch + one bulk recompute. The whole function should run in <2 seconds for a full publish.

**HANA `IN (?, ?, ...)` parameter binding caveat:** if the HANA driver doesn't accept array-style binding for IN clauses (driver-specific), fall back to UUID-list interpolation as in Phase B Task B2 Step 1. The slug list isn't UUIDs, so for that path you'd interpolate single-quoted SQL-escaped strings:

```js
const lit = lowerSlugs.map(s => `'${s.replace(/'/g, "''")}'`).join(',');
const hits = await db.run(
  `SELECT ${idCol}, LOWER(${slugCol}) AS LSLUG FROM ${table} WHERE LOWER(${slugCol}) IN (${lit})`
);
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run test/recompute-tutorial-progress-bulk-sql.test.js test/issue-89-progress-denominator.test.js
```

- [ ] **Step 3: Commit**

```bash
git add srv/lib/content-publish-session.js
git commit -m "refactor(publish): replace per-slug loop in recomputeProgressForChangedTutorials with bulk SQL (#382)"
```

### Task D3: Replace the call in legacy publishHandler

**Files:**
- Modify: `srv/lib/content-store.js` (line ~510)

- [ ] **Step 1: Make the change**

The legacy `publishHandler` (one-shot endpoint, pre-chunked protocol) also calls `recomputeTutorialProgress` per-slug. Replace with bulk call routed through the new function. The SQLite fallback in the bulk function will loop `recomputeTutorialProgress` internally — semantically identical for SQLite tests.

Add the import:

```js
import { recomputeTutorialProgressBulkSQL } from './recompute-tutorial-progress-bulk-sql.js';
```

Replace the call site.

- [ ] **Step 2: Run tests + smoke test the legacy publish endpoint via the chunked test**

```bash
npx vitest run test/recompute-tutorial-progress-bulk-sql.test.js test/issue-89-progress-denominator.test.js
```

The full `test/hybrid/content-publish-chunked.test.js` exercises the chunked path which is now the primary; the legacy `publishHandler` only matters for SQLite tests.

- [ ] **Step 3: Commit**

```bash
git add srv/lib/content-store.js
git commit -m "refactor(publish): legacy publishHandler uses bulk SQL via the new function (#382)"
```

---

## Phase E — Live deploy + smoke

### Task E1: Push, open PR, merge

- [ ] **Step 1: Push the branch**

```bash
cd D:/projects/tutorials-poc
git push -u origin fix/publish-progress-recompute-set-based-sql
```

- [ ] **Step 2: Open the PR**

Write a PR-body file first, then create the PR with `--body-file`:

```bash
cat > .pr-body-c4.tmp.md <<'EOF'
## Summary

Replace the per-tutorial N+1 query pattern in publish progress-recompute with a single set-based HANA `MERGE INTO` statement.

## Why

The publish step in #382 phase E has been failing repeatedly with `HeadersTimeoutError`. Diagnosis traced this to `recomputeTutorialProgress` in `srv/lib/content-store.js` — for each of ~1400 tutorials in a publish, it issues 3 + 2N SQL queries where N = users with TaskRecords on that tutorial. With 10.8M total TaskRecords, a single /append batch (25 slugs) was taking 286+ seconds — past undici's 30s headers timeout. See failing runs:

- <https://github.com/sap-tutorials/tutorials-ims/actions/runs/27790881959>
- <https://github.com/sap-tutorials/tutorials-ims/actions/runs/27823662006>

## Fix

A single set-based `MERGE INTO` statement in the new function `recomputeTutorialProgressBulkSQL` does what the JS recompute did, but as one HANA-native column-store operation. SQLite path (unit tests) keeps the existing JS implementation as a fallback.

Three call sites switch to the bulk function:

- `srv/lib/content-publish-session.js` `appendToSession` (per-batch)
- `srv/lib/content-publish-session.js` `recomputeProgressForChangedTutorials` (commit-time safety net, also batched slug-resolution)
- `srv/lib/content-store.js` legacy `publishHandler`

Issues #420 (worker_threads pool) and #421 (split publish-worker app) were the wrong-tier diagnoses — both predicted to remain de-prioritized after this lands since the publish event loop is no longer saturated. Will close them after PR merge confirms.

## Spec + plan

- Spec: docs/superpowers/specs/2026-06-19-publish-progress-recompute-set-based-sql-design.md
- Plan: docs/superpowers/plans/2026-06-19-publish-progress-recompute-set-based-sql.md

## Live deploy validation history

(filled in after Phase E2-E3 smoke completes)

Closes #382 phase E.
EOF

gh pr create --title "fix(publish): bulk SQL recompute for TUTORIAL TaskRecords (closes #382 phase E)" --body-file .pr-body-c4.tmp.md
rm .pr-body-c4.tmp.md
```

- [ ] **Step 3: Confirm with Tom before merge**

The change touches the publish path; not auto-mergeable. Surface the PR for review.

- [ ] **Step 4: Squash-merge after approval**

```bash
gh pr merge <pr-url> --squash --delete-branch
```

### Task E2: Trigger publish + watch

- [ ] **Step 1: Fire the rebuild-content workflow**

```bash
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f environment=dev -f trigger-source=manual -f ai-author-enabled=true \
  -f ai-author-build-cap=200 -f force-cap-refetch=false
```

- [ ] **Step 2: Watch it**

```bash
sleep 5
RUN_ID=$(gh run list --repo sap-tutorials/tutorials-ims --workflow=rebuild-content.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch --repo sap-tutorials/tutorials-ims "$RUN_ID"
```

- [ ] **Step 3: Confirm publish step completes < 90s**

After the run, inspect the Publish step duration:

```bash
gh run view --repo sap-tutorials/tutorials-ims "$RUN_ID" --log 2>&1 | grep -A2 "Publish tutorial content to HANA"
```

The publish step should complete in 60-90 seconds wall clock (vs the 286s/batch failure pattern from yesterday).

### Task E3: Smoke-test the 4 meta-tutorials slugs (#382 phase E)

- [ ] **Step 1: HTTP 200 on all 4 slugs**

```bash
SRV="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"
for slug in use-codecheck-to-ai-grade-reader-code use-validate-to-ai-grade-free-text-answers use-autoauthor-to-generate-quiz-questions tutorial-platform-feature-cookbook; do
  status=$(curl -s -o /dev/null -w "%{http_code}" "$SRV/content/tutorials/$slug")
  echo "$slug: $status"
done
```

Expected: all four return 200.

- [ ] **Step 2: Spot-check a known user's progress card**

The MERGE should have re-graded TUTORIAL TaskRecords correctly. Pick a known test user via hana-cli and SELECT a few of their TUTORIAL records to confirm `PROGRESS` and `STATUS` are sane.

- [ ] **Step 3: Surface the smoke result on the PR**

Comment on the closed PR with the run URL + the 4 HTTP 200s. Mark #382 phase E complete.

---

## Definition of Done

- [ ] Phase A: MERGE INTO statement validated on DEV HANA, idempotent, fast
- [ ] Phase B: New module + 4 unit tests, all passing on SQLite
- [ ] Phase C: 6 hybrid tests passing on DEV HANA (correctness + scale + concurrency)
- [ ] Phase D: Three call sites switched; full unit test sweep green
- [ ] Phase E: PR merged; live publish completes in <90s; 4 phase-E slugs return 200

---

## Risks for the executor

1. **Phase A is the most important.** If the MERGE statement has any HANA-specific bug that wasn't caught by the spec reviewer, you'll find it here. Don't skip pre-flight validation; it's 5-10 minutes that saves an hour of "why is the hybrid test wrong" later.
2. **The legacy publishHandler may be exercised by tests we don't think about.** Run `git grep -l "publishHandler\|/content/publish'" test/` to confirm coverage before merge.
3. **HANA driver param-binding for IN clauses.** If the param-bind doesn't work for the duplicate `:tutorialIds`, fall back to UUID-list interpolation. Both are spelled out in the spec.
4. **`MODIFIEDAT` write** — the bulk MERGE bumps every changed row's `MODIFIEDAT`. If grep finds a read site filtering on `MODIFIEDAT` for "user activity", introduce a separate column or skip the MODIFIEDAT write. Spec Risk #6 covers this.
