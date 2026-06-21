# Author Review Lifecycle Long-tail Fix-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #450 by adding `TutorialMeta.firstNotificationAt` + `MyTutorialsView.outdated` to the already-working author-review nag system, tightening the stale threshold 180 → 90 days across 4 call sites, and clearing the new field in all 3 reset code paths.

**Architecture:** Surgical: 8 source files modified + 3 test files extended. No new files. No new entities. No new cron. No data migration. Schema-first → view → lib (with TDD for behavior changes) → threshold sweep → hook + dev-data seeder → integration test → finalize.

**Tech Stack:** SAP CAP Node.js, SAP HANA Cloud (HDI deploy via additive `migration=3` ALTER), Vitest (in-memory SQLite for unit; live HANA via `cds bind` for hybrid), CDS view extension.

**Spec:** [docs/superpowers/specs/2026-06-21-issue-450-author-review-lifecycle-design.md](../specs/2026-06-21-issue-450-author-review-lifecycle-design.md) (approved iter-3 reviewer; 13 findings folded across 3 iterations; commit `2087ddfb`)

**Branch:** `worktree-issue-450-author-review-lifecycle` (already checked out in worktree).

## Explicit out-of-scope (NICE-TO-HAVE callout, top-of-plan)

- No `NotificationLog` audit entity (counter on `TutorialMeta` is sufficient; see spec).
- No threshold-via-`ImsConfig`. 90 is hardcoded.
- No daily cron change. Weekly Monday 09:00 stays.
- No `daysSinceReview` calc field — that's #385 (still open).
- No email-template change.
- No data migration. Rows already at notification level 1-3 stay with `firstNotificationAt = NULL` forever.

## Commit-checkpoint reminders

Every Task below ends with a `git add ... && git commit -m "..."` step. Treat each Task's commit as a checkpoint:

- Run the Task's verification (`node --check`, `npx vitest`, `npx cds compile`, `npm run test`) BEFORE the commit.
- If verification fails, fix forward — do NOT commit broken state.
- After a successful commit, the worktree is recoverable to that point even if the next Task breaks.

## Rollback notes

Each Task is independently revertable. If a Task lands but later proves wrong:

- **Task 1 (schema)**: `git revert <task-commit-sha>` is safe; the new column is nullable so existing rows are unaffected. HDI redeploy will DROP the column on revert.
- **Task 2 (view)**: revert is safe; view recompiles on next deploy.
- **Tasks 3-4 (lib changes with tests)**: revert pair; test changes go with impl changes.
- **Tasks 5-6 (threshold + hook/seeder)**: revert is safe; threshold returns to 180.
- **Task 7 (integration test)**: revert is safe; it's test-only.

---

## Worktree state (verified pre-flight)

Worktree branched from `origin/main` at `f6ddc4d0`. Verified 2026-06-21:

- `srv/lib/contributor-notifications.js` exists with `STALE_DAYS_DEFAULT = 180` at line 3, `markNotificationSent` at line 64 ✓
- `srv/lib/tutorial-review.js` exists with `reviewTutorial` `.set({...})` block at lines 12-16 ✓
- `srv/jobs/scheduler.js` line 135 has `computeStaleNotifications(180)` ✓
- `srv/admin-service.js` line 794 has `computeStaleNotifications(180)` ✓
- `srv/admin-service.js` line 356 has `before('UPDATE', 'TutorialMeta', ...)` hook ✓
- `scripts/seed-tutorial-meta.js` lines 50 + 60 each have `daysAgo > 180` ✓
- `db/views.cds:145` declares `view MyTutorialsView`, with `lastNotificationDate` at line 158 ✓
- `test/notification-reset.test.js` has the `owner: 'owner@sap.com'` seed (display-name column, NOT `ownerEmail`) and no Users row at lines 10-35 ✓
- `test/lib/contributor-notifications.test.js` exists with 2 tests at lines 43-53 ✓

**No rebase risk expected.** No worktree-state-aware branching needed.

---

## File Structure

### Modified files (8 source + 3 test = 11)

| File | Change |
| --- | --- |
| `db/schema.cds` | Add `firstNotificationAt : Timestamp;` to `TutorialMeta` entity (Task 1) |
| `db/views.cds` | Extend `MyTutorialsView` select-list with `firstNotificationAt` + `outdated : Boolean` (Task 2) |
| `srv/lib/contributor-notifications.js` | `STALE_DAYS_DEFAULT` 180 → 90 (Task 5); `markNotificationSent` sets `firstNotificationAt` on first nag (Task 3) |
| `srv/lib/tutorial-review.js` | `reviewTutorial` `.set({...})` adds `firstNotificationAt: null` (Task 4) |
| `srv/jobs/scheduler.js` | Line 135 `computeStaleNotifications(180)` → `(90)` (Task 5) |
| `srv/admin-service.js` | Line 794 `computeStaleNotifications(180)` → `(90)` (Task 5); line 356 `before('UPDATE','TutorialMeta')` hook adds `req.data.firstNotificationAt = null` (Task 6) |
| `scripts/seed-tutorial-meta.js` | Lines 50 + 60 `180` → `90` + extract `STALE_THRESHOLD_DAYS` constant (Task 6) |
| `test/unit/lib/tutorial-review.test.js` | Extend existing `reviewTutorial` test with `firstNotificationAt: null` assertion (Task 4) |
| `test/lib/contributor-notifications.test.js` | Update 2 existing tests for `(90)` threshold + adjust fixture dates; add 4 new tests in same describe block (Tasks 3 + 5) |
| `test/notification-reset.test.js` | Amend `beforeAll` fixture (add `ownerEmail` + insert Users row); add `MyTutorialsView.outdated` assertions via direct CDS db query (Task 7) |

### New files (0)

No new files.

### Generated files (auto-regenerated by `cds build`)

- `gen/db/src/gen/com.sap.developers.ims.TutorialMeta.hdbmigrationtable` — new `migration=3` block with `ALTER TABLE ... ADD (firstNotificationAt TIMESTAMP)` (auto-generated; do NOT hand-edit; verify in Task 1.5 + Task 8)
- `gen/db/src/gen/com.sap.developers.ims.MyTutorialsView.hdbview` — regenerated with new columns (auto-generated)

---

## Pre-flight (Step 0)

Before any task, the implementer subagent runs these checks. Each should return the expected output; any deviation means STOP and re-orient.

- [ ] **Step 0.1: Confirm working in the worktree**

  ```bash
  cd D:/projects/tutorials-poc/.claude/worktrees/issue-450-author-review-lifecycle
  pwd
  git branch --show-current
  ```

  Expected: pwd ends in `issue-450-author-review-lifecycle`; branch is `worktree-issue-450-author-review-lifecycle`.

  Memory [[feedback_subagent_writes_can_leak_to_parent_repo]]: writes to the parent `D:/projects/tutorials-poc/` will be missed by the rebase + push. STOP and re-`cd` if wrong.

- [ ] **Step 0.2: Verify all 6 spec-cited line numbers still match**

  ```bash
  grep -n "STALE_DAYS_DEFAULT = 180" srv/lib/contributor-notifications.js
  grep -n "export async function markNotificationSent" srv/lib/contributor-notifications.js
  grep -n "computeStaleNotifications(180)" srv/jobs/scheduler.js srv/admin-service.js
  grep -n "this.before('UPDATE', 'TutorialMeta'" srv/admin-service.js
  grep -n "daysAgo > 180" scripts/seed-tutorial-meta.js
  ```

  Expected:
  - `srv/lib/contributor-notifications.js:3` → `const STALE_DAYS_DEFAULT = 180;`
  - `srv/lib/contributor-notifications.js:64` → `export async function markNotificationSent(tutorialId) {`
  - `srv/jobs/scheduler.js:135` → `const notifications = await computeStaleNotifications(180);`
  - `srv/admin-service.js:794` → `const notifications = await computeStaleNotifications(180);`
  - `srv/admin-service.js:356` (or nearby) → `this.before('UPDATE', 'TutorialMeta', (req) => {`
  - `scripts/seed-tutorial-meta.js:50` AND `:60` → both have `daysAgo > 180`

  If any line has drifted, the corresponding Task's Edit anchor may need adjustment. Note the new line and proceed.

- [ ] **Step 0.3: Verify existing tests pass on baseline**

  ```bash
  npx vitest run test/lib/contributor-notifications.test.js test/unit/lib/tutorial-review.test.js test/notification-reset.test.js 2>&1 | tail -10
  ```

  Expected: all 3 files green. Establishes baseline; if red, fix env before adding more.

- [ ] **Step 0.4: Confirm HDI migration table is at `migration=2`**

  ```bash
  grep -E "^==.*migration=" db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable 2>/dev/null | tail -3 || \
    echo "(file may not exist locally yet — first cds build will create it)"
  ```

  Expected: last block is `== migration=2`. Task 1's build will produce `== migration=3`.

  If file doesn't exist, run `npx cds build --production` once to materialize the baseline; commit it ONLY if the file was missing from main (highly unusual; check `git status` first).

- [ ] **Step 0.5: Verify CDS compiles on baseline**

  ```bash
  npx cds compile srv/admin-service.cds > /dev/null 2>&1 && echo OK
  npx cds compile srv/author-service.cds > /dev/null 2>&1 && echo OK
  npx cds compile db/views.cds > /dev/null 2>&1 && echo OK
  ```

  Expected: 3× `OK`. Confirms the baseline schema/view compile before we change anything.

---

## Task 1: Schema — add `firstNotificationAt` column to `TutorialMeta`

**Files:**

- Modify: `db/schema.cds`
- Verify (generated): `db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable` after `cds build`

This is a pure schema-additive change. No behavior yet. Must land before Tasks 3 / 4 / 7 which reference the new column.

- [ ] **Step 1.1: Locate the existing `lastNotificationDate` line in `TutorialMeta`**

  ```bash
  grep -n "lastNotificationDate" db/schema.cds
  ```

  Note the line (expected: there should be exactly 1 occurrence inside the `entity TutorialMeta` block).

- [ ] **Step 1.2: Add the new column**

  Use Edit. Anchor on the exact existing line:

  ```cds
  lastNotificationDate      : Timestamp;
  ```

  (Match the surrounding indentation — read the file first to confirm the exact whitespace; the existing block uses 2-space outer indent with name-padding so the `:` column-aligns across fields.)

  Replace with:

  ```cds
  lastNotificationDate      : Timestamp;
  firstNotificationAt       : Timestamp;
  ```

  **Verification of indent**: the new line MUST match the existing column-alignment style — the field name is left-padded so the `:` column lines up with `lastNotificationDate`'s `:`. Read 5 lines around the insertion to confirm visual alignment.

- [ ] **Step 1.3: Verify CDS compiles**

  ```bash
  npx cds compile db/schema.cds > /dev/null 2>&1 && echo OK
  npx cds compile srv/admin-service.cds > /dev/null 2>&1 && echo OK
  npx cds compile srv/author-service.cds > /dev/null 2>&1 && echo OK
  ```

  Expected: 3× `OK`. If any fails, the column wasn't added correctly.

- [ ] **Step 1.4: Verify the column is in the CSN**

  ```bash
  npx cds compile db/schema.cds --to json 2>/dev/null | python -c "
  import json, sys
  d = json.load(sys.stdin)
  m = d['definitions'].get('com.sap.developers.ims.TutorialMeta', {})
  print('firstNotificationAt:', m.get('elements', {}).get('firstNotificationAt', 'MISSING'))
  "
  ```

  Expected: `firstNotificationAt: {'type': 'cds.Timestamp'}` (or similar; key is that it's NOT `MISSING`).

- [ ] **Step 1.5: Run `cds build` and verify `.hdbmigrationtable` regen**

  ```bash
  npx cds build --production 2>&1 | tail -10
  grep -E "^==.*migration=" gen/db/src/gen/com.sap.developers.ims.TutorialMeta.hdbmigrationtable | tail -3
  grep -A1 "migration=3" gen/db/src/gen/com.sap.developers.ims.TutorialMeta.hdbmigrationtable | head -5
  ```

  Expected:
  - `cds build` succeeds.
  - `migration=3` block exists (in addition to existing `migration=1` and `migration=2`).
  - The new block contains `ALTER TABLE ... ADD (FIRSTNOTIFICATIONAT TIMESTAMP)` (HDI uppercases identifiers per memory [[feedback_hana_raw_sql_uppercase]]).

  If `migration=3` is absent, `cds build` may have skipped regeneration; delete `gen/` and retry.

- [ ] **Step 1.6: Verify line endings preserved**

  ```bash
  file db/schema.cds | grep -v CRLF || echo "CRLF_DETECTED — fix"
  ```

  Memory [[feedback_crlf_regression_on_windows]]. Expected: NOT CRLF.

- [ ] **Step 1.7: Commit**

  ```bash
  git add db/schema.cds db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable
  git commit -m "feat(schema): add TutorialMeta.firstNotificationAt (#450)

  Nullable Timestamp column. Populated by markNotificationSent on the
  first nag only (when notificationNumber=0 before increment); cleared
  by reviewTutorial. Existing rows already at notification level 1-3
  stay with firstNotificationAt=NULL forever (no data migration per
  spec).

  HDI emits migration=3 block with ALTER TABLE ... ADD column. Purely
  additive; safe against feedback_hdi_deploys_can_wipe_data."
  ```

  **Note:** if `db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable` is a generated file that the repo doesn't track (check `git status` after `cds build` — if it shows as untracked, it's gen/-style and shouldn't be committed), drop it from the `git add` list. The generated path under `gen/` is gitignored; the source-tracked path under `db/src/` may exist depending on project conventions. **Determine which path exists in the repo's tracking:**

  ```bash
  ls db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable 2>/dev/null && echo "tracked under db/src" || \
    ls gen/db/src/gen/com.sap.developers.ims.TutorialMeta.hdbmigrationtable 2>/dev/null && echo "only under gen/ (gitignored)"
  git status db/ gen/ 2>&1 | grep hdbmigrationtable || echo "(no migration file changes staged/unstaged)"
  ```

  Commit only what `git status` shows as modified or new under `db/`.

---

## Task 2: View — extend `MyTutorialsView` with `firstNotificationAt` + `outdated`

**Files:**

- Modify: `db/views.cds`

- [ ] **Step 2.1: Locate the existing `lastNotificationDate` line in `MyTutorialsView`**

  ```bash
  grep -n -A 14 "view MyTutorialsView as" db/views.cds | head -25
  ```

  Identify the line in the select-list with `m.lastNotificationDate,`. Expected: around line 158.

- [ ] **Step 2.2: Add the two new columns**

  Use Edit. Anchor on this exact line (match indent — 8 spaces of leading whitespace per the file's convention):

  ```cds
          m.lastNotificationDate,
  ```

  Replace with:

  ```cds
          m.lastNotificationDate,
          m.firstNotificationAt,
          m.notificationNumber >= 4 as outdated : Boolean,
  ```

  The `outdated` calc field returns a CDS-typed Boolean. Both SQLite (unit tests) and HANA (hybrid + prod) support this inline boolean expression — memory [[feedback_hana_boolean_case_when]] applies to WHERE-clause comparisons, NOT select-list booleans, so this is safe.

- [ ] **Step 2.3: Verify view compiles**

  ```bash
  npx cds compile db/views.cds > /dev/null 2>&1 && echo OK
  npx cds compile srv/author-service.cds > /dev/null 2>&1 && echo OK
  ```

  Expected: 2× `OK`. If a compile fails with "element not found: firstNotificationAt", Task 1 didn't add the column correctly.

- [ ] **Step 2.4: Verify the calc field landed in CSN**

  ```bash
  npx cds compile db/views.cds --to json 2>/dev/null | python -c "
  import json, sys
  d = json.load(sys.stdin)
  v = d['definitions'].get('com.sap.developers.ims.MyTutorialsView', {})
  print('outdated:', v.get('elements', {}).get('outdated', 'MISSING'))
  print('firstNotificationAt:', v.get('elements', {}).get('firstNotificationAt', 'MISSING'))
  "
  ```

  Expected: both elements present; `outdated` has `type: 'cds.Boolean'`.

- [ ] **Step 2.5: Run `cds build` and verify the view's `.hdbview` file regenerates**

  ```bash
  npx cds build --production 2>&1 | tail -5
  grep -i "firstnotificationat\|outdated" gen/db/src/gen/com.sap.developers.ims.MyTutorialsView.hdbview | head -5
  ```

  Expected: both column names appear in the generated `.hdbview`.

- [ ] **Step 2.6: Line-ending check**

  ```bash
  file db/views.cds | grep -v CRLF || echo "CRLF_DETECTED"
  ```

- [ ] **Step 2.7: Commit**

  ```bash
  git add db/views.cds
  git commit -m "feat(view): expose firstNotificationAt + outdated on MyTutorialsView (#450)

  outdated : Boolean = (notificationNumber >= 4) — derived inline; no
  new column. Sage can render an OUTDATED chip on author tutorials
  that have been nagged 4+ times without a reviewTutorial reset.

  firstNotificationAt is the new TutorialMeta column from Task 1;
  pass-through so Sage can show '1st nag sent on YYYY-MM-DD' context."
  ```

---

## Task 3: Lib — `markNotificationSent` sets `firstNotificationAt` on first nag (TDD)

**Files:**

- Modify: `srv/lib/contributor-notifications.js:64-72` (the `markNotificationSent` body)
- Modify: `test/lib/contributor-notifications.test.js` (extend with 2 new tests inside the existing describe block)

- [ ] **Step 3.1: Read the existing `markNotificationSent` to anchor the Edit**

  ```bash
  sed -n '60,75p' srv/lib/contributor-notifications.js
  ```

  Expected current shape:

  ```javascript
  export async function markNotificationSent(tutorialId) {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');
    const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
    if (!meta) return;
    await UPDATE(TutorialMeta, meta.ID).set({
      notificationNumber: (meta.notificationNumber || 0) + 1,
      lastNotificationDate: new Date().toISOString()
    });
  }
  ```

- [ ] **Step 3.2: Add 2 new tests for `markNotificationSent` (red phase)**

  Use Edit on `test/lib/contributor-notifications.test.js`. Anchor on the closing `});` of the existing `describe('contributor-notifications', () => {` block (last line of the file before line 55).

  Insert BEFORE that closing `});`, after the existing `it('returns empty when no tutorials are stale', ...)`:

  ```javascript

    describe('markNotificationSent firstNotificationAt tracking', () => {
      let markNotificationSent;

      beforeAll(async () => {
        ({ markNotificationSent } = await import('../../srv/lib/contributor-notifications.js'));
      });

      it('sets firstNotificationAt on the first nag (notificationNumber=0)', async () => {
        const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
        const tutorialId = 'ffffffff-fn01-0000-0000-000000000001';
        const metaId = 'aaaaaaaa-fn01-0000-0000-000000000001';

        await INSERT.into(Tutorials).entries({
          ID: tutorialId, slug: 'fn-first-nag', title: 'First Nag Test',
          legacyId: 9001, status: 'ACTIVE',
        });
        await INSERT.into(TutorialMeta).entries({
          ID: metaId, tutorial_ID: tutorialId,
          reviewedDate: new Date(Date.now() - 200 * 86400000).toISOString(),
          owner: 'fn@sap.com', monitoredStatus: 'ACTIVE',
          notificationNumber: 0, legacyId: 9101,
        });

        await markNotificationSent(tutorialId);

        const updated = await SELECT.one.from(TutorialMeta).where({ ID: metaId });
        expect(updated.notificationNumber).toBe(1);
        expect(updated.firstNotificationAt).toBeTruthy();
        expect(updated.lastNotificationDate).toBeTruthy();
        // On the first nag, firstNotificationAt and lastNotificationDate are equal
        expect(updated.firstNotificationAt).toBe(updated.lastNotificationDate);
      });

      it('does NOT overwrite firstNotificationAt on subsequent nags (notificationNumber=2 → 3)', async () => {
        const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
        const tutorialId = 'ffffffff-fn02-0000-0000-000000000001';
        const metaId = 'aaaaaaaa-fn02-0000-0000-000000000001';
        const originalFirstNag = new Date(Date.now() - 90 * 86400000).toISOString();

        await INSERT.into(Tutorials).entries({
          ID: tutorialId, slug: 'fn-subsequent', title: 'Subsequent Nag Test',
          legacyId: 9002, status: 'ACTIVE',
        });
        await INSERT.into(TutorialMeta).entries({
          ID: metaId, tutorial_ID: tutorialId,
          reviewedDate: new Date(Date.now() - 200 * 86400000).toISOString(),
          owner: 'fn2@sap.com', monitoredStatus: 'ACTIVE',
          notificationNumber: 2,
          firstNotificationAt: originalFirstNag,
          lastNotificationDate: new Date(Date.now() - 30 * 86400000).toISOString(),
          legacyId: 9102,
        });

        await markNotificationSent(tutorialId);

        const updated = await SELECT.one.from(TutorialMeta).where({ ID: metaId });
        expect(updated.notificationNumber).toBe(3);
        // firstNotificationAt is UNCHANGED (still the 90-day-old value)
        expect(updated.firstNotificationAt).toBe(originalFirstNag);
        // lastNotificationDate IS updated to now
        expect(new Date(updated.lastNotificationDate).getTime()).toBeGreaterThan(Date.now() - 5000);
      });
    });
  ```

- [ ] **Step 3.3: Run the new tests — expect FAIL**

  ```bash
  npx vitest run test/lib/contributor-notifications.test.js 2>&1 | tail -15
  ```

  Expected: the 2 new tests FAIL because `firstNotificationAt` is never written. Specifically:
  - Test 1: `updated.firstNotificationAt` is `null` or `undefined` (not truthy).
  - Test 2: `updated.firstNotificationAt` is unchanged but `markNotificationSent` doesn't read or write it (passes accidentally? — actually depends; if the column exists as nullable, the test should still verify it stays equal to the originally-inserted value, which it WILL be since we don't touch it. Test 2 may pass at red. Test 1 is the critical failing test.)

  If Test 1 passes accidentally, something's wrong — re-verify the assertion.

- [ ] **Step 3.4: Implement the fix in `markNotificationSent`**

  Use Edit on `srv/lib/contributor-notifications.js`. Anchor on the existing `markNotificationSent` body:

  ```javascript
  export async function markNotificationSent(tutorialId) {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');
    const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
    if (!meta) return;
    await UPDATE(TutorialMeta, meta.ID).set({
      notificationNumber: (meta.notificationNumber || 0) + 1,
      lastNotificationDate: new Date().toISOString()
    });
  }
  ```

  Replace with:

  ```javascript
  export async function markNotificationSent(tutorialId) {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');
    const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
    if (!meta) return;
    const now = new Date().toISOString();
    const isFirstNag = !meta.notificationNumber;
    await UPDATE(TutorialMeta, meta.ID).set({
      notificationNumber: (meta.notificationNumber || 0) + 1,
      lastNotificationDate: now,
      // #450: set firstNotificationAt ONLY on the first nag. The
      // spread-conditional pattern keeps the UPDATE atomic and avoids
      // overwriting on subsequent nags.
      ...(isFirstNag && { firstNotificationAt: now }),
    });
  }
  ```

- [ ] **Step 3.5: Run the new tests — expect PASS**

  ```bash
  npx vitest run test/lib/contributor-notifications.test.js 2>&1 | tail -10
  ```

  Expected: all 4 tests pass (2 original + 2 new). If a new test still fails, re-check the spread-conditional syntax.

- [ ] **Step 3.6: Run the broader unit suite to confirm no regression**

  ```bash
  npx vitest run test/lib/ test/unit/ 2>&1 | tail -5
  ```

  Expected: no new failures vs baseline (from Step 0.3).

- [ ] **Step 3.7: Line-ending checks**

  ```bash
  file srv/lib/contributor-notifications.js test/lib/contributor-notifications.test.js | grep -v CRLF || echo "CRLF_DETECTED"
  ```

- [ ] **Step 3.8: Commit**

  ```bash
  git add srv/lib/contributor-notifications.js test/lib/contributor-notifications.test.js
  git commit -m "feat(lib): markNotificationSent sets firstNotificationAt on first nag (#450)

  Spread-conditional pattern: when meta.notificationNumber=0 BEFORE the
  increment, set firstNotificationAt=now alongside the existing
  lastNotificationDate update. On nags 2/3/4, firstNotificationAt is
  untouched, preserving the original first-nag-date for Sage's '1st
  nag sent on YYYY-MM-DD' display.

  Tests: 2 new inside test/lib/contributor-notifications.test.js
  describe('markNotificationSent firstNotificationAt tracking'):
  - sets firstNotificationAt on the first nag
  - does NOT overwrite on subsequent nags"
  ```

---

## Task 4: Lib — `reviewTutorial` clears `firstNotificationAt` (TDD)

**Files:**

- Modify: `srv/lib/tutorial-review.js:12-17` (the `reviewTutorial` `.set({...})` block)
- Modify: `test/unit/lib/tutorial-review.test.js` (extend existing test)

- [ ] **Step 4.1: Read the existing test to anchor**

  ```bash
  cat test/unit/lib/tutorial-review.test.js
  ```

  Note the existing `reviewTutorial` test (around lines 27-32) that asserts `result.notificationNumber === 0` and `result.reviewedDate` is recent. We extend it.

- [ ] **Step 4.2: Extend the existing test fixture + assertion (red phase)**

  The existing `beforeEach` (lines 13-24) seeds a `TutorialMeta` row with `notificationNumber: 5, lastNotificationDate: '2024-01-01T00:00:00Z'` (but no `firstNotificationAt`). We need to:

  1. Add `firstNotificationAt: '2024-01-01T00:00:00Z'` to the existing INSERT so the test has something to clear.
  2. Add an assertion that after `reviewTutorial`, the persisted row has `firstNotificationAt: null`.

  Use Edit on `test/unit/lib/tutorial-review.test.js`. Anchor on the existing INSERT block:

  ```javascript
      await INSERT.into(TutorialMeta).entries({
        ID: 'm-rev', tutorial_ID: 't-rev', owner: 'X',
        reviewedDate: '2020-01-01T00:00:00Z',
        notificationNumber: 5,
        lastNotificationDate: '2024-01-01T00:00:00Z'
      });
  ```

  Replace with:

  ```javascript
      await INSERT.into(TutorialMeta).entries({
        ID: 'm-rev', tutorial_ID: 't-rev', owner: 'X',
        reviewedDate: '2020-01-01T00:00:00Z',
        notificationNumber: 5,
        lastNotificationDate: '2024-01-01T00:00:00Z',
        firstNotificationAt: '2024-01-01T00:00:00Z'
      });
  ```

  Then locate the existing `reviewTutorial` test assertion block (around lines 28-31):

  ```javascript
    it('reviewTutorial resets reviewedDate and notification counters', async () => {
      const result = await reviewTutorial('t-rev');
      expect(result.notificationNumber).toBe(0);
      expect(result.reviewedDate).toBeDefined();
      expect(new Date(result.reviewedDate).getTime()).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'));
    });
  ```

  Replace with:

  ```javascript
    it('reviewTutorial resets reviewedDate and ALL notification counters', async () => {
      const result = await reviewTutorial('t-rev');
      expect(result.notificationNumber).toBe(0);
      expect(result.reviewedDate).toBeDefined();
      expect(new Date(result.reviewedDate).getTime()).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'));

      // #450: verify ALL 4 review-state fields cleared in the persisted row
      const { TutorialMeta } = cds.entities('com.sap.developers.ims');
      const persisted = await SELECT.one.from(TutorialMeta).where({ ID: 'm-rev' });
      expect(persisted.notificationNumber).toBe(0);
      expect(persisted.lastNotificationDate).toBeNull();
      expect(persisted.firstNotificationAt).toBeNull();
    });
  ```

- [ ] **Step 4.3: Run the test — expect FAIL**

  ```bash
  npx vitest run test/unit/lib/tutorial-review.test.js 2>&1 | tail -15
  ```

  Expected: the test FAILS on the new assertion `expect(persisted.firstNotificationAt).toBeNull()` — the current `reviewTutorial` doesn't clear that field, so it stays at `'2024-01-01T00:00:00Z'`.

- [ ] **Step 4.4: Implement the fix in `reviewTutorial`**

  Use Edit on `srv/lib/tutorial-review.js`. Anchor on:

  ```javascript
    await UPDATE(TutorialMeta, meta.ID).set({
      reviewedDate: now,
      notificationNumber: 0,
      lastNotificationDate: null
    });
  ```

  Replace with:

  ```javascript
    await UPDATE(TutorialMeta, meta.ID).set({
      reviewedDate: now,
      notificationNumber: 0,
      lastNotificationDate: null,
      firstNotificationAt: null
    });
  ```

- [ ] **Step 4.5: Run the test — expect PASS**

  ```bash
  npx vitest run test/unit/lib/tutorial-review.test.js 2>&1 | tail -10
  ```

  Expected: PASS.

- [ ] **Step 4.6: Run broader unit suite to confirm no regression**

  ```bash
  npx vitest run test/lib/ test/unit/ 2>&1 | tail -5
  ```

  Expected: no new failures.

- [ ] **Step 4.7: Line-ending check**

  ```bash
  file srv/lib/tutorial-review.js test/unit/lib/tutorial-review.test.js | grep -v CRLF || echo "CRLF_DETECTED"
  ```

- [ ] **Step 4.8: Commit**

  ```bash
  git add srv/lib/tutorial-review.js test/unit/lib/tutorial-review.test.js
  git commit -m "feat(lib): reviewTutorial clears firstNotificationAt (#450)

  reviewTutorial now resets all 4 review-state fields atomically:
  reviewedDate (set to now), notificationNumber (0),
  lastNotificationDate (null), firstNotificationAt (null).

  Test extended: now also asserts the persisted row has both
  lastNotificationDate=null and firstNotificationAt=null."
  ```

---

## Task 5: Threshold sweep — 180 → 90 across 4 callsites + 2 existing tests + 2 new edge-case tests

**Files:**

- Modify: `srv/lib/contributor-notifications.js:3` (`STALE_DAYS_DEFAULT`)
- Modify: `srv/jobs/scheduler.js:135` (`computeStaleNotifications(180)`)
- Modify: `srv/admin-service.js:794` (`computeStaleNotifications(180)`)
- Modify: `test/lib/contributor-notifications.test.js` (update 2 existing tests for new threshold; add 2 new edge-case tests)

- [ ] **Step 5.1: Update 2 existing tests' threshold args + adjust fixture dates (red phase)**

  Use Edit on `test/lib/contributor-notifications.test.js`. The existing tests (around lines 43-53) hard-code `computeStaleNotifications(180)` and `computeStaleNotifications(365)`. The 200-day stale fixture date works fine under either threshold; the test just needs the arg updated to match the new default.

  Locate:

  ```javascript
    it('identifies stale tutorials needing notification (>180 days)', async () => {
      const notifications = await computeStaleNotifications(180);
      expect(notifications.length).toBe(1);
      expect(notifications[0].slug).toBe('stale-tutorial');
      expect(notifications[0].contributors[0].email).toBe('alice@sap.com');
    });

    it('returns empty when no tutorials are stale', async () => {
      const notifications = await computeStaleNotifications(365);
      expect(notifications.length).toBe(0);
    });
  ```

  Replace with:

  ```javascript
    it('identifies stale tutorials needing notification (>90 days)', async () => {
      const notifications = await computeStaleNotifications(90);
      expect(notifications.length).toBe(1);
      expect(notifications[0].slug).toBe('stale-tutorial');
      expect(notifications[0].contributors[0].email).toBe('alice@sap.com');
    });

    it('returns empty when no tutorials are stale', async () => {
      const notifications = await computeStaleNotifications(365);
      expect(notifications.length).toBe(0);
    });
  ```

  (Only the first test changes — title + the `(180)` arg. The second test's `(365)` is unchanged since both fixtures are <365 days old.)

- [ ] **Step 5.2: Add 2 new edge-case tests inside the same describe block**

  Use Edit on `test/lib/contributor-notifications.test.js`. Anchor on the closing `});` of the `describe('markNotificationSent firstNotificationAt tracking', ...)` block (added in Task 3).

  Insert BEFORE that closing `});` of the OUTER `describe('contributor-notifications', () => {`:

  ```javascript

    describe('computeStaleNotifications filtering edge cases', () => {
      it('filters out tutorials at notificationNumber >= 4', async () => {
        const { Tutorials, TutorialMeta, TutorialContributors } = cds.entities('com.sap.developers.ims');
        const tutorialId = 'ffffffff-flt1-0000-0000-000000000001';
        const metaId = 'aaaaaaaa-flt1-0000-0000-000000000001';

        await INSERT.into(Tutorials).entries({
          ID: tutorialId, slug: 'maxed-tutorial', title: 'Maxed Out',
          legacyId: 9003, status: 'ACTIVE',
        });
        await INSERT.into(TutorialMeta).entries({
          ID: metaId, tutorial_ID: tutorialId,
          reviewedDate: new Date(Date.now() - 200 * 86400000).toISOString(),
          owner: 'maxed@sap.com', monitoredStatus: 'ACTIVE',
          notificationNumber: 4, legacyId: 9103,
        });
        await INSERT.into(TutorialContributors).entries({
          ID: 'bbbbbbbb-flt1-0000-0000-000000000001',
          tutorial_ID: tutorialId,
          name: 'Maxed', email: 'maxed@sap.com', role: 'AUTHOR', legacyId: 9203,
        });

        const notifications = await computeStaleNotifications(90);
        const slugs = notifications.map((n) => n.slug);
        expect(slugs).not.toContain('maxed-tutorial');
      });

      it("filters out tutorials with tutorial.status = 'INACTIVE'", async () => {
        const { Tutorials, TutorialMeta, TutorialContributors } = cds.entities('com.sap.developers.ims');
        const tutorialId = 'ffffffff-flt2-0000-0000-000000000001';
        const metaId = 'aaaaaaaa-flt2-0000-0000-000000000001';

        await INSERT.into(Tutorials).entries({
          ID: tutorialId, slug: 'inactive-tutorial', title: 'Inactive Tut',
          legacyId: 9004, status: 'INACTIVE',
        });
        await INSERT.into(TutorialMeta).entries({
          ID: metaId, tutorial_ID: tutorialId,
          reviewedDate: new Date(Date.now() - 200 * 86400000).toISOString(),
          owner: 'inactive@sap.com', monitoredStatus: 'ACTIVE',
          notificationNumber: 0, legacyId: 9104,
        });
        await INSERT.into(TutorialContributors).entries({
          ID: 'bbbbbbbb-flt2-0000-0000-000000000001',
          tutorial_ID: tutorialId,
          name: 'Inactive', email: 'inactive@sap.com', role: 'AUTHOR', legacyId: 9204,
        });

        const notifications = await computeStaleNotifications(90);
        const slugs = notifications.map((n) => n.slug);
        expect(slugs).not.toContain('inactive-tutorial');
      });
    });
  ```

- [ ] **Step 5.3: Run the tests — expect first 2 still PASS, new 2 PASS (they pre-exercise existing filter logic)**

  The 2 new edge-case tests should PASS without source change — they're verifying behavior the lib already implements (the `notificationNumber <= MAX_NOTIFICATION_LEVEL` filter at line 17 and the `tutorial.status !== 'ACTIVE'` filter at line 27). They're characterizing the existing behavior so the threshold change doesn't accidentally regress it.

  ```bash
  npx vitest run test/lib/contributor-notifications.test.js 2>&1 | tail -10
  ```

  Expected: 6 tests pass (2 existing-updated + 2 markNotificationSent from Task 3 + 2 new edge cases).

  If a new edge-case test fails, the existing filter logic isn't behaving as the spec described — STOP and investigate. (This would indicate a real bug in `computeStaleNotifications` that the spec assumes works correctly.)

- [ ] **Step 5.4: Update `STALE_DAYS_DEFAULT` in the lib**

  Use Edit on `srv/lib/contributor-notifications.js`. Anchor on line 3:

  ```javascript
  const STALE_DAYS_DEFAULT = 180;
  ```

  Replace with:

  ```javascript
  const STALE_DAYS_DEFAULT = 90;
  ```

- [ ] **Step 5.5: Update scheduler.js call site (line 135)**

  Use Edit on `srv/jobs/scheduler.js`. Anchor on:

  ```javascript
        const notifications = await computeStaleNotifications(180);
  ```

  **Caution**: this exact line may appear in MULTIPLE files (and we touch 2 of them). The Edit will match within the file scope. Verify there's only ONE match in scheduler.js:

  ```bash
  grep -c "computeStaleNotifications(180)" srv/jobs/scheduler.js
  ```

  Expected: `1`. Then Edit replaces it with:

  ```javascript
        const notifications = await computeStaleNotifications(90);
  ```

- [ ] **Step 5.6: Update admin-service.js call site (line 794)**

  Use Edit on `srv/admin-service.js`. Same anchor + replacement as Step 5.5.

  ```bash
  grep -c "computeStaleNotifications(180)" srv/admin-service.js
  ```

  Expected: `1`. Edit replaces.

- [ ] **Step 5.7: Verify all 4 call sites moved**

  ```bash
  grep -rn "computeStaleNotifications(180)" srv/ scripts/ test/
  grep -rn "STALE_DAYS_DEFAULT = 180" srv/
  grep -rn "computeStaleNotifications(90)" srv/
  grep -rn "STALE_DAYS_DEFAULT = 90" srv/
  ```

  Expected:
  - First 2 greps: ZERO matches.
  - Third grep: 2 matches (scheduler.js + admin-service.js).
  - Fourth grep: 1 match (contributor-notifications.js).

- [ ] **Step 5.8: Run the full unit suite to confirm green**

  ```bash
  npx vitest run test/lib/ test/unit/ test/notification-reset.test.js 2>&1 | tail -10
  ```

  Expected: all green. The 6-test contributor-notifications file + the extended tutorial-review test + the unchanged notification-reset test.

- [ ] **Step 5.9: Line-ending checks**

  ```bash
  file srv/lib/contributor-notifications.js srv/jobs/scheduler.js srv/admin-service.js test/lib/contributor-notifications.test.js | grep -v CRLF || echo "CRLF_DETECTED"
  ```

- [ ] **Step 5.10: Commit**

  ```bash
  git add srv/lib/contributor-notifications.js srv/jobs/scheduler.js srv/admin-service.js test/lib/contributor-notifications.test.js
  git commit -m "feat(threshold): tighten stale-tutorial threshold 180 → 90 days (#450)

  Riley's IMS rule said 90 OR 120 days for the first nag; current
  implementation defaulted to 180. Tightening to 90 matches the lower
  bound + the 'every quarter' mental model.

  4 call-site sweep:
  - srv/lib/contributor-notifications.js:3 STALE_DAYS_DEFAULT
  - srv/jobs/scheduler.js:135 (weekly Mon 09:00 UTC cron)
  - srv/admin-service.js:794 (admin 'send now' action)
  - (srv/admin-service.js:356 hook handled in Task 6)

  Tests: 2 existing tests updated; 2 new edge-case tests pin the
  existing filter behavior (notificationNumber>=4 filtered;
  tutorial.status='INACTIVE' filtered) so a future threshold change
  doesn't accidentally regress it.

  Deploy-time: weekly cron's first run after deploy may send first
  nags to authors whose tutorials are 90-179 days stale. Memory:
  Tom posts in #devrel-tools pre-deploy to flag the wave."
  ```

---

## Task 6: Admin hook + dev-data seeder — symmetric clear + threshold consistency

**Files:**

- Modify: `srv/admin-service.js:356` (the `before('UPDATE', 'TutorialMeta')` hook)
- Modify: `scripts/seed-tutorial-meta.js` (2 hardcoded `180`s at lines 50 + 60)

Both changes are defensive (the hook is unreachable in production per spec; the seeder is dev-only) but ship together for cleanliness.

- [ ] **Step 6.1: Read the existing admin hook to anchor**

  ```bash
  sed -n '354,361p' srv/admin-service.js
  ```

  Expected:

  ```javascript

      // Reset notification escalation when reviewedDate is updated via Fiori UI
      this.before('UPDATE', 'TutorialMeta', (req) => {
        if (req.data.reviewedDate) {
          req.data.notificationNumber = 0;
          req.data.lastNotificationDate = null;
        }
      });
  ```

- [ ] **Step 6.2: Edit the hook**

  Use Edit on `srv/admin-service.js`. Anchor:

  ```javascript
      this.before('UPDATE', 'TutorialMeta', (req) => {
        if (req.data.reviewedDate) {
          req.data.notificationNumber = 0;
          req.data.lastNotificationDate = null;
        }
      });
  ```

  Replace with:

  ```javascript
      this.before('UPDATE', 'TutorialMeta', (req) => {
        if (req.data.reviewedDate) {
          req.data.notificationNumber = 0;
          req.data.lastNotificationDate = null;
          req.data.firstNotificationAt = null;  // #450: clear all 3 fields atomically
        }
      });
  ```

- [ ] **Step 6.3: Read the seeder to anchor**

  ```bash
  sed -n '45,65p' scripts/seed-tutorial-meta.js
  ```

  Identify the exact lines 50 + 60 with `daysAgo > 180`.

- [ ] **Step 6.4: Add a constant + replace both 180 literals**

  Use Edit on `scripts/seed-tutorial-meta.js`. First, find where module-level constants would naturally live (top of file, after imports). Read lines 1-15:

  ```bash
  sed -n '1,15p' scripts/seed-tutorial-meta.js
  ```

  Then add a new constant near the top (after the existing imports/constants). The exact anchor depends on the file's shape; use Read to find a suitable insertion point.

  For each of the two `daysAgo > 180` occurrences, use Edit to replace with `daysAgo > STALE_THRESHOLD_DAYS`. Use sufficient surrounding context to make each Edit unique:

  **Edit 1** (line 50 area):

  ```javascript
      const lastNotificationDate = daysAgo > 180
        ? new Date(now - notifDaysAgo * 86400000).toISOString()
        : null;
  ```

  →

  ```javascript
      const lastNotificationDate = daysAgo > STALE_THRESHOLD_DAYS
        ? new Date(now - notifDaysAgo * 86400000).toISOString()
        : null;
  ```

  **Edit 2** (line 60 area):

  ```javascript
        notificationNumber: daysAgo > 180 ? Math.floor(Math.random() * 4) + 1 : 0,
  ```

  →

  ```javascript
        notificationNumber: daysAgo > STALE_THRESHOLD_DAYS ? Math.floor(Math.random() * 4) + 1 : 0,
  ```

  **Edit 3** (add the constant near the top of the file — adjust insertion anchor per the actual file structure):

  Insert after any existing top-level `const`s, e.g. after the last `import` or near the existing `owners` / `statuses` constants if present:

  ```javascript

  // #450: matches the runtime cron threshold (srv/lib/contributor-notifications.js
  // STALE_DAYS_DEFAULT). Seed dev data so notificationNumber populates for rows
  // older than the runtime threshold — keeps dev/prod semantics aligned.
  const STALE_THRESHOLD_DAYS = 90;
  ```

- [ ] **Step 6.5: Verify the seeder still runs without throwing (dry-run)**

  ```bash
  node --check scripts/seed-tutorial-meta.js && echo OK
  ```

  Expected: `OK`. If the script has a runtime guard against execution outside `cds bind`, we don't need to actually run it — `node --check` confirms syntax.

- [ ] **Step 6.6: Verify all 4 threshold call sites are now consistent**

  ```bash
  echo "180 should appear in: nothing (except maybe comments)"
  grep -rn "180" srv/lib/contributor-notifications.js srv/jobs/scheduler.js srv/admin-service.js scripts/seed-tutorial-meta.js | grep -v "^.*//\|^.*\*" | head -10
  echo "90 should appear at runtime sites"
  grep -rn "STALE_DAYS_DEFAULT = 90\|computeStaleNotifications(90)\|STALE_THRESHOLD_DAYS = 90" srv/ scripts/ | head -10
  ```

  Expected: first grep returns no functional `180`s (only comments/docs). Second grep returns 4 hits.

- [ ] **Step 6.7: Syntax-check the modified files**

  ```bash
  node --check srv/admin-service.js && echo OK
  node --check scripts/seed-tutorial-meta.js && echo OK
  ```

  Expected: 2× `OK`.

- [ ] **Step 6.8: Line-ending checks**

  ```bash
  file srv/admin-service.js scripts/seed-tutorial-meta.js | grep -v CRLF || echo "CRLF_DETECTED"
  ```

- [ ] **Step 6.9: Commit**

  ```bash
  git add srv/admin-service.js scripts/seed-tutorial-meta.js
  git commit -m "feat(admin+seed): symmetric firstNotificationAt clear + 90-day seeder (#450)

  srv/admin-service.js:356 — extend before('UPDATE','TutorialMeta')
  hook so it clears all 3 notification fields when reviewedDate is
  touched (matches reviewTutorial's reset semantics from Task 4).
  Defensive — the hook is unreachable in production per the comment
  at test/notification-reset.test.js:103-108, but keeping it
  symmetric prevents drift if it ever fires via a future admin UI
  direct-edit flow.

  scripts/seed-tutorial-meta.js — two hardcoded 180s replaced with
  STALE_THRESHOLD_DAYS=90 constant. Dev-data semantics now match the
  runtime threshold; tutorials seeded 91-180 days stale would
  previously have notificationNumber=0 but get nagged by the cron."
  ```

---

## Task 7: Integration test — extend `test/notification-reset.test.js` with `MyTutorialsView.outdated` assertions

**Files:**

- Modify: `test/notification-reset.test.js` (amend `beforeAll` fixture + add new assertions)

This is the end-to-end check that schema + view + reviewTutorial chain produces the right `outdated` value.

- [ ] **Step 7.1: Read the existing test file end-to-end**

  ```bash
  cat test/notification-reset.test.js
  ```

  Confirm:
  - `beforeAll` seeds `Tutorials` + `TutorialMeta` (with `owner: 'owner@sap.com'`, NOT `ownerEmail`) + `TutorialContributors`.
  - No `Users` row is inserted.
  - The existing test posts to `/admin/reviewTutorial` and asserts persisted state.

- [ ] **Step 7.2: Amend the `beforeAll` fixture (BLOCKING per spec iter-2 review)**

  Use Edit on `test/notification-reset.test.js`. Anchor on the existing `TutorialMeta` insert:

  ```javascript
      await INSERT.into(TutorialMeta).entries({
        ID: metaId, tutorial_ID: tutorialId,
        reviewedDate: staleDate, owner: 'owner@sap.com',
        monitoredStatus: 'ACTIVE', notificationNumber: 2,
        lastNotificationDate: lastNotified, legacyId: 7101
      });
  ```

  Replace with:

  ```javascript
      await INSERT.into(TutorialMeta).entries({
        ID: metaId, tutorial_ID: tutorialId,
        reviewedDate: staleDate, owner: 'owner@sap.com',
        ownerEmail: 'owner@sap.com',  // #450: required for MyTutorialsView inner-join on Users.email
        monitoredStatus: 'ACTIVE', notificationNumber: 2,
        lastNotificationDate: lastNotified,
        firstNotificationAt: lastNotified,  // #450: pre-existing value to verify reviewTutorial clears it
        legacyId: 7101
      });
  ```

  Then locate the existing `TutorialContributors` insert at the end of `beforeAll`. After it (still inside `beforeAll`), add a Users seed:

  Anchor on:

  ```javascript
      await INSERT.into(TutorialContributors).entries({
        ID: 'bbbbbbbb-7201-0000-0000-000000000001',
        tutorial_ID: tutorialId,
        name: 'Owner', email: 'owner@sap.com', role: 'OWNER', legacyId: 7201
      });
    });
  ```

  (Note the closing `});` of `beforeAll`.) Replace with:

  ```javascript
      await INSERT.into(TutorialContributors).entries({
        ID: 'bbbbbbbb-7201-0000-0000-000000000001',
        tutorial_ID: tutorialId,
        name: 'Owner', email: 'owner@sap.com', role: 'OWNER', legacyId: 7201
      });

      // #450: MyTutorialsView inner-joins on Users.email = TutorialMeta.ownerEmail.
      // Without a matching Users row, the reviewed tutorial is filtered out of
      // the view entirely, and the outdated assertions below would crash.
      const { Users } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Users).entries({
        ID: 'cccccccc-7301-0000-0000-000000000001',
        uuid: 'user-uuid-7301',
        email: 'owner@sap.com'
      });
    });
  ```

- [ ] **Step 7.3: Add `MyTutorialsView.outdated` assertions to the existing test**

  Read the existing `reviewTutorial` test body around lines 50-60 — find where the assertion block ends (after the existing `SELECT.one.from(TutorialMeta)` check).

  ```bash
  sed -n '47,67p' test/notification-reset.test.js
  ```

  Use Edit. Anchor on the closing of the existing `reviewTutorial` test:

  ```javascript
        // Verify persisted state
        const { TutorialMeta } = cds.entities('com.sap.developers.ims');
        const meta = await SELECT.one.from(TutorialMeta).where({ ID: metaId });
        expect(meta.notificationNumber).toBe(0);
        expect(meta.lastNotificationDate).toBeNull();
        expect(new Date(meta.reviewedDate).getTime()).toBeGreaterThan(Date.now() - 5000);
      });
  ```

  (Match the exact whitespace from the actual file — the indent + brace style.)

  Replace with:

  ```javascript
        // Verify persisted state
        const { TutorialMeta, MyTutorialsView } = cds.entities('com.sap.developers.ims');
        const meta = await SELECT.one.from(TutorialMeta).where({ ID: metaId });
        expect(meta.notificationNumber).toBe(0);
        expect(meta.lastNotificationDate).toBeNull();
        expect(meta.firstNotificationAt).toBeNull();  // #450: clearing extends to the new field
        expect(new Date(meta.reviewedDate).getTime()).toBeGreaterThan(Date.now() - 5000);

        // #450: after review, the row should be queryable from MyTutorialsView
        // and outdated should be false (notificationNumber=0 < 4).
        const reviewedRow = await SELECT.one.from(MyTutorialsView).where({ ID: tutorialId });
        expect(reviewedRow).toBeTruthy();  // confirms the inner-join with Users resolves
        expect(reviewedRow.outdated).toBe(false);
        expect(reviewedRow.notificationNumber).toBe(0);
      });
  ```

- [ ] **Step 7.4: Add a new test for the `outdated=true` case**

  Use Edit. Anchor on the closing `});` of the `describe('reviewTutorial action', ...)` block (find via `grep -n "^  describe" test/notification-reset.test.js`).

  Insert AFTER that closing `});`, but still inside the outer `describe('Notification reset on review', ...)`:

  ```javascript

    describe('MyTutorialsView.outdated calc field', () => {
      it('returns true for a tutorial at notificationNumber >= 4', async () => {
        const { Tutorials, TutorialMeta, MyTutorialsView } = cds.entities('com.sap.developers.ims');
        // Reuses the Users row seeded in beforeAll (owner@sap.com)
        const outdatedTutorialId = 'ffffffff-7001-0000-0000-000000000002';

        await INSERT.into(Tutorials).entries({
          ID: outdatedTutorialId, slug: 'outdated-tutorial', title: 'Outdated',
          legacyId: 7002, status: 'ACTIVE'
        });
        await INSERT.into(TutorialMeta).entries({
          ID: 'aaaaaaaa-7101-0000-0000-000000000002',
          tutorial_ID: outdatedTutorialId,
          ownerEmail: 'owner@sap.com', monitoredStatus: 'ACTIVE',
          reviewedDate: new Date(Date.now() - 365 * 86400000).toISOString(),
          notificationNumber: 4, legacyId: 7102
        });

        const outdatedRow = await SELECT.one.from(MyTutorialsView).where({ ID: outdatedTutorialId });
        expect(outdatedRow).toBeTruthy();
        expect(outdatedRow.outdated).toBe(true);
        expect(outdatedRow.notificationNumber).toBe(4);
      });
    });
  ```

  Use strict `.toBe(true)` / `.toBe(false)` (not truthy) — CAP normalizes SQLite's `0/1` to JS booleans only for declared `Boolean`-typed view columns.

- [ ] **Step 7.5: Run the test — expect PASS**

  ```bash
  npx vitest run test/notification-reset.test.js 2>&1 | tail -15
  ```

  Expected: all tests pass. If `reviewedRow.outdated` returns `0` or `1` instead of `false` / `true`, the view's `Boolean` type declaration didn't propagate — re-check Task 2's Step 2.2 edit.

- [ ] **Step 7.6: Run the full unit suite to confirm no regression**

  ```bash
  npx vitest run 2>&1 | tail -15
  ```

  Expected: all green. The new tests + extended fixtures don't break any other suite.

- [ ] **Step 7.7: Line-ending check**

  ```bash
  file test/notification-reset.test.js | grep -v CRLF || echo "CRLF_DETECTED"
  ```

- [ ] **Step 7.8: Commit**

  ```bash
  git add test/notification-reset.test.js
  git commit -m "test(notification-reset): MyTutorialsView.outdated assertions (#450)

  Extends the existing reviewTutorial integration test:
  1. beforeAll fixture amended: TutorialMeta gets ownerEmail (the
     display-name 'owner' column was used previously); Users row
     inserted so MyTutorialsView's inner-join resolves; existing
     fixture seeded with firstNotificationAt to verify it clears.
  2. Existing test extended with assertions on reviewedRow.outdated
     (=false post-review) + reviewedRow.notificationNumber.
  3. New test: seeds a tutorial at notificationNumber=4, asserts
     MyTutorialsView returns it with outdated=true.

  Uses strict .toBe(true) / .toBe(false) (not truthy) — CAP normalizes
  SQLite 0/1 to JS bools for Boolean-typed view columns."
  ```

---

## Task 8: End-to-end verification + finalize

- [ ] **Step 8.1: Run the full unit test suite**

  ```bash
  npx vitest run 2>&1 | tail -15
  ```

  Expected: all green. Establishes the entire test surface is consistent.

- [ ] **Step 8.2: Run `cds build` end-to-end and verify the migration file is sane**

  ```bash
  npx cds build --production 2>&1 | tail -10
  echo "=== Migration table latest block ==="
  grep -E "^==.*migration=" db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable 2>/dev/null | tail -3 || \
    grep -E "^==.*migration=" gen/db/src/gen/com.sap.developers.ims.TutorialMeta.hdbmigrationtable | tail -3
  ```

  Expected:
  - `cds build` succeeds.
  - Latest migration block is `migration=3` with the `ALTER TABLE ADD (FIRSTNOTIFICATIONAT TIMESTAMP)` body.

- [ ] **Step 8.3: Verify no `STALE_DAYS_DEFAULT = 180` survives anywhere**

  ```bash
  grep -rn "180" srv/lib/contributor-notifications.js srv/jobs/scheduler.js srv/admin-service.js scripts/seed-tutorial-meta.js | grep -v "//\|^.*\*" | head -5
  ```

  Expected: no functional `180`s remain in those files.

- [ ] **Step 8.4: Verify the 4 threshold sites + the 3 reset paths land together**

  ```bash
  echo "--- threshold call sites (expect 3 hits at 90, 0 at 180) ---"
  grep -rn "computeStaleNotifications(90)\|STALE_DAYS_DEFAULT = 90" srv/
  echo "--- markNotificationSent firstNotificationAt set ---"
  grep -n "firstNotificationAt: now\|isFirstNag" srv/lib/contributor-notifications.js
  echo "--- reviewTutorial firstNotificationAt clear ---"
  grep -n "firstNotificationAt: null" srv/lib/tutorial-review.js srv/admin-service.js
  ```

  Expected:
  - 3 hits on the threshold (1 default + 2 call sites).
  - 1 hit on the set.
  - 2 hits on the clear (one in `tutorial-review.js`, one in `admin-service.js` hook).

- [ ] **Step 8.5: Confirm commit chain**

  ```bash
  git log --oneline main..HEAD | head -15
  ```

  Expected: ~7 commits (Tasks 1-7), one per task, descriptive messages, in order. No merge commits.

- [ ] **Step 8.6: Push the branch**

  ```bash
  git push -u origin worktree-issue-450-author-review-lifecycle 2>&1 | tail -5
  ```

  Expected: push succeeds.

- [ ] **Step 8.7: Open the PR via `gh pr create`**

  Use a body matching the spec's settled decisions. Reference the spec doc + the brainstorming session.

  ```bash
  gh pr create --base main --head worktree-issue-450-author-review-lifecycle \
    --title "feat(author-review): close #450 long-tail (firstNotificationAt + outdated + 90d threshold)" \
    --body-file - <<'BODY'
  Closes #450.

  ## Summary

  Completes the author-review nag system's long tail (#450). Most of the
  system already shipped via #355 + earlier PRs (counter on TutorialMeta,
  weekly cron, recipient escalation, reviewTutorial/snoozeTutorial actions,
  ImsConfig kill-switch). This PR adds the 5 remaining pieces.

  ## What's in this PR

  **Schema + view (Tasks 1-2):**
  - `TutorialMeta.firstNotificationAt : Timestamp` (nullable; populated on
    first nag, cleared on review).
  - `MyTutorialsView` exposes `firstNotificationAt` + `outdated : Boolean`
    (derived from `notificationNumber >= 4`).

  **Lib changes (Tasks 3-4):**
  - `markNotificationSent`: spread-conditional set of `firstNotificationAt`
    on the first nag only (`!meta.notificationNumber` before increment).
  - `reviewTutorial`: clears all 3 notification fields atomically.

  **Threshold sweep (Task 5):**
  - 180 → 90 days across `STALE_DAYS_DEFAULT` + scheduler.js:135 +
    admin-service.js:794. Riley's lower bound; matches "every quarter"
    mental model.

  **Defensive symmetry (Task 6):**
  - `admin-service.js:356` `before('UPDATE','TutorialMeta')` hook also
    clears `firstNotificationAt`.
  - `scripts/seed-tutorial-meta.js` dev-data threshold matches runtime via
    `STALE_THRESHOLD_DAYS = 90` constant.

  **Tests (Tasks 3-7):**
  - `test/lib/contributor-notifications.test.js` extended: 6 tests total
    (2 updated for new threshold + 2 firstNotificationAt + 2 filter-edge).
  - `test/unit/lib/tutorial-review.test.js` extended: assertion that
    `firstNotificationAt: null` post-reset.
  - `test/notification-reset.test.js` extended: fixture amended for
    MyTutorialsView reachability + `outdated` assertions.

  ## Deploy-time impact

  Tightening the threshold means **the Monday after deploy**, the weekly
  cron will send first nags to any authors whose tutorials are 90-179
  days stale (currently silenced). One-time catch-up only; the 30-day
  resend interval bounds the wave to ≤1 email per author.

  **Pre-deploy:** Tom posts in `#devrel-tools` to flag the upcoming wave.

  ## Out of scope

  - No `NotificationLog` audit entity. Counter is sufficient.
  - No threshold-via-`ImsConfig`. Hardcoded 90.
  - No `daysSinceReview` calc field. That's #385 (still open).
  - No email-template change.
  - No data migration. Rows already at notification level 1-3 stay with
    `firstNotificationAt = NULL`.

  ## Spec + brainstorm trail

  - Spec: `docs/superpowers/specs/2026-06-21-issue-450-author-review-lifecycle-design.md`
    (iter-3 reviewer approved; 13 findings folded across 3 iterations)
  - Plan: `docs/superpowers/plans/2026-06-21-issue-450-author-review-lifecycle.md`
  BODY
  ```

  Note: the actual `gh pr create` command above is a heredoc — adjust quoting if your shell needs it. If `gh` rejects the body, write it to a file and use `--body-file <path>`.

- [ ] **Step 8.8: Commit the spec + plan to the worktree (if not already)**

  The spec was committed in this worktree as part of brainstorming/writing-plans. Verify both files are tracked:

  ```bash
  git log --oneline -- docs/superpowers/specs/2026-06-21-issue-450-author-review-lifecycle-design.md
  git log --oneline -- docs/superpowers/plans/2026-06-21-issue-450-author-review-lifecycle.md
  ```

  Expected: both files have at least one commit. The PR body references both.

- [ ] **Step 8.9: Mark Tom's checklist for post-deploy comms**

  Not a code step — print the reminder so the implementer surfaces it to Tom:

  ```
  After PR merge + DEV deploy succeeds:
  1. Post in #devrel-tools: "Author review nag threshold drops 180 → 90
     days. Next Monday's cron may produce a one-time wave of first nags
     for authors with tutorials 90-179 days stale. 30-day resend interval
     bounds the wave to ≤1 email/author."
  2. Soak DEV for 48h after the Monday cron fires.
  3. Verify the audit log shows expected SecretValueRead-style entries
     (notification-job emits SecurityEvent via cds-audit-logging? Check
     post-deploy.)
  4. Promote to PROD after soak.
  ```

---

## Acceptance criteria (verify before requesting review)

- [ ] `TutorialMeta.firstNotificationAt` exists as a nullable Timestamp column
- [ ] `MyTutorialsView` exposes `firstNotificationAt` and `outdated` (derived from `notificationNumber >= 4`)
- [ ] `STALE_DAYS_DEFAULT = 90` in `srv/lib/contributor-notifications.js` AND `srv/jobs/scheduler.js:135` call site AND `srv/admin-service.js:794` call site
- [ ] `scripts/seed-tutorial-meta.js` uses a top-level `STALE_THRESHOLD_DAYS = 90` constant in place of the two `180` literals
- [ ] `markNotificationSent` sets `firstNotificationAt` ONLY when prior `notificationNumber === 0`
- [ ] `reviewTutorial` clears all 4 review-state fields (`reviewedDate→now`, `notificationNumber→0`, `lastNotificationDate→null`, `firstNotificationAt→null`)
- [ ] `srv/admin-service.js:356` `before('UPDATE', 'TutorialMeta')` hook also clears `firstNotificationAt` when `reviewedDate` is touched
- [ ] Existing `test/unit/lib/tutorial-review.test.js` extended with `firstNotificationAt: null` assertion
- [ ] Existing `test/notification-reset.test.js` extended with `MyTutorialsView.outdated` assertions via direct CDS db query (not OData `/author/MyTutorials`)
- [ ] Existing `test/lib/contributor-notifications.test.js` has **6 tests total** (2 updated + 4 new) and all pass
- [ ] `npm run test` (unit suite) is green
- [ ] HDI build emits a new `migration=3` block on `db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable` (or `gen/...` if that's the tracked path) with `ALTER TABLE ... ADD (FIRSTNOTIFICATIONAT TIMESTAMP)`
- [ ] HDI deploy succeeds (additive nullable column + view extension; no destructive operations per memory `[feedback_hdi_deploys_can_wipe_data]`)
- [ ] No new `cf set-env` required (no new env vars)

---

## Notes for the implementer

- **TDD discipline**: Tasks 3, 4, and parts of 5 follow strict TDD — write the test FIRST, run red, then implement. Tasks 1, 2, 6, 7 are not strictly TDD because the changes are either pure schema/view (no observable behavior at the file's level) or defensive (no natural test home).
- **Worktree-discipline**: All edits land in `D:/projects/tutorials-poc/.claude/worktrees/issue-450-author-review-lifecycle`. After every commit, verify `cd D:/projects/tutorials-poc && git status -s` to ensure no writes leak to the parent. Memory `[feedback_subagent_writes_can_leak_to_parent_repo]` warns this leaked in PR #454.
- **Line-ending discipline**: After every Edit, verify with `file <path> | grep -v CRLF || echo CRLF_DETECTED`. Memory `[feedback_crlf_regression_on_windows]`.
- **HANA case-sensitivity**: HANA uppercases identifiers; CDS quoted-lowercase identifiers fail under HDI deploy. The new `firstNotificationAt` will be `FIRSTNOTIFICATIONAT` in `.hdbmigrationtable`. Memory `[feedback_hana_raw_sql_uppercase]`.
- **Don't add comments unless they explain non-obvious "why"**: Some spec sections suggest verbose comments. Match the existing file's comment density rather than the spec's prose density. Brevity > completeness for stable code.
