# #385 PR-3 — AuthorService Field Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Realize Riley's `AuthorService` contract per #385 PR-3 — 2 view renames + 3 new calc fields + 1 deletion on `MyTutorialsView`; new `Tags.actualTag` virtual; new `isSlugAvailable` action; doc + rename map.

**Architecture:** Pure projection-surface work. No schema changes (CDS view body + service projection only). Three CDS-portable additions land in `db/views.cds`; one HANA-native expression lands in `srv/author-service.cds`'s Tags projection with the unit-test surface gated on `db.kind === 'hana'`. One new service action with a small JS handler.

**Tech Stack:** CAP CDS (`db/views.cds`, `srv/author-service.cds`), Node.js (`srv/author-service.js`, `srv/lib/tutorial-review.js`), vitest, SAP HANA / SQLite.

**Spec:** [`docs/superpowers/specs/2026-06-21-issue-385-pr3-authorservice-design.md`](../specs/2026-06-21-issue-385-pr3-authorservice-design.md)

---

## File Structure

**Files modified (5):**
- [`db/views.cds`](../../../db/views.cds) — `MyTutorialsView` rewrite: 2 renames + 3 new calc fields + `outdated` deletion.
- [`srv/author-service.cds`](../../../srv/author-service.cds) — `Tags` projection extended with `actualTag : String`; `snoozeTutorial` return type renamed; new `isSlugAvailable` action.
- [`srv/author-service.js`](../../../srv/author-service.js) — new `isSlugAvailable` handler.
- [`srv/lib/tutorial-review.js`](../../../srv/lib/tutorial-review.js) — `snoozeTutorial` return key renamed.
- [`test/unit/lib/tutorial-review.test.js`](../../../test/unit/lib/tutorial-review.test.js) — assertion key update.

**Files modified (test consumers of the rename — same commit as the rename):**
- [`test/unit/author-service.test.js`](../../../test/unit/author-service.test.js) — fixture seeds + new + updated assertions.
- [`test/notification-reset.test.js`](../../../test/notification-reset.test.js) — remove the `MyTutorialsView.outdated calc field` describe block; update line 70's `outdated` assertion (delete it).

**Files created (2):**
- [`test/hybrid/385-pr3-authorservice.test.js`](../../../test/hybrid/385-pr3-authorservice.test.js) — read-only hybrid verification (runs post-deploy).
- [`docs/developers/architecture/author-service.md`](../../../docs/developers/architecture/author-service.md) — new architecture doc with the old→new rename map (file doesn't exist yet).

**Files NOT changed:**
- `db/schema.cds` — no schema change; only view body.
- `srv/admin-service.cds`, `srv/admin-service.js` — already verified by spec §6: AdminService reads the raw `TutorialMeta` entity (NOT the view), and the underlying column names are NOT renamed. Unaffected.
- `test/lib/content-store-tutorial-meta.test.js`, `test/lib/contributor-notifications.test.js` — also read/write raw `TutorialMeta`, NOT the view. Unaffected.

---

## Task 0: Pre-flight branch + baseline tests

**Files:** None modified. Sanity check only.

- [ ] **Step 1: Verify branch + clean tree**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/385-pr3-authorservice
git branch --show-current     # expect: worktree-385-pr3-authorservice
git status --short            # expect: clean (spec already committed)
```

- [ ] **Step 2: Run baseline test suite to capture pre-PR test count**

```bash
npx vitest run test/unit/author-service.test.js test/unit/lib/tutorial-review.test.js test/notification-reset.test.js 2>&1 | tail -10
```

Expected: all green. Record the test count (e.g. "23 tests, all passing"). Each subsequent task's verification compares against this baseline.

- [ ] **Step 3: Verify `cds compile` baseline**

```bash
npx cds compile srv/author-service.cds 2>&1 | tail -3
```

Expected: exit 0, no errors. (No code change yet; just a baseline check.)

- [ ] **Step 4: Verify PR-1 dependency is on this branch**

```bash
grep -n 'repository\s*:\s*Association to TutorialRepositories' db/schema.cds
```

Expected: 1 match. If 0 matches, PR-1's schema reshape isn't on this branch — STOP and rebase on `origin/main` (which has PR-1 merged) before proceeding.

- [ ] **Step 5: Verify test convention (srv.tx pattern)**

```bash
grep -n 'srv\.tx' test/unit/author-service.test.js | head -3
```

Expected: existing matches use `srv.tx({ user: ... }, (tx) => tx.send(...))` shape. Task 4's new test cases follow the same shape — confirm the pattern matches before writing the new tests.

No commit for Task 0 — it's a sanity gate.

---

## Task 1: MyTutorialsView rewrite (renames + 3 new fields + outdated deletion)

This task does the riskiest single change in PR-3: renaming + deleting view aliases that test files depend on. **TDD pattern: write the new tests against the new shape first; they fail; then update the view; then the tests pass.**

**Files:**
- Modify: [`db/views.cds`](../../../db/views.cds) — view body rewrite.
- Modify: [`test/unit/author-service.test.js`](../../../test/unit/author-service.test.js) — new assertions for renames + new fields.
- Modify: [`test/notification-reset.test.js`](../../../test/notification-reset.test.js) — delete the `outdated` describe block; update outdated assertion on line 70.
- Modify: [`test/unit/lib/tutorial-review.test.js`](../../../test/unit/lib/tutorial-review.test.js) — `lastNotificationDate` → `notificationDate` in the assertion (line 46).

### Step 1: Write new failing assertions in author-service.test.js

Open `test/unit/author-service.test.js`. The existing `describe('MyTutorialsView', ...)` block (lines ~22-62) and the `describe('AuthorService.MyTutorials filtering', ...)` block both rely on the seeded fixture. **Extend the existing `describe('MyTutorialsView', ...)` block** with new tests, AND **add a new top-level `describe('MyTutorialsView #385 PR-3 shape', ...)` block** at the end of the file (just before the trailing line). The new tests:

```javascript
describe('MyTutorialsView #385 PR-3 shape', () => {
  let MyTutorialsView;

  beforeAll(async () => {
    MyTutorialsView = cds.entities('com.sap.developers.ims').MyTutorialsView;
  });

  it('emits new fields: repositoryName, monitored, daysSinceReview', () => {
    expect(MyTutorialsView.elements.repositoryName).toBeDefined();
    expect(MyTutorialsView.elements.monitored).toBeDefined();
    expect(MyTutorialsView.elements.daysSinceReview).toBeDefined();
  });

  it('emits renamed fields: owner (not ownerName), notificationDate (not lastNotificationDate)', () => {
    expect(MyTutorialsView.elements.owner).toBeDefined();
    expect(MyTutorialsView.elements.notificationDate).toBeDefined();
    expect(MyTutorialsView.elements.ownerName).toBeUndefined();
    expect(MyTutorialsView.elements.lastNotificationDate).toBeUndefined();
  });

  it('does NOT emit the deleted outdated field', () => {
    expect(MyTutorialsView.elements.outdated).toBeUndefined();
  });

  it('daysSinceReview is null when reviewedDate is null', async () => {
    const { Tutorials, TutorialMeta, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries(
      { ID: 'u-pr3-1', uuid: 'uuid-pr3-1', email: 'nullreview@example.com', firstName: 'N', lastName: 'R', displayName: 'N R' }
    );
    await INSERT.into(Tutorials).entries(
      { ID: 't-pr3-nullreview', slug: 'pr3-nullreview', title: 'No Review', status: 'ACTIVE' }
    );
    await INSERT.into(TutorialMeta).entries(
      { ID: 'm-pr3-nullreview', tutorial_ID: 't-pr3-nullreview', owner: 'X', ownerEmail: 'nullreview@example.com', reviewedDate: null }
    );
    const row = await SELECT.one.from(MyTutorialsView).where({ ID: 't-pr3-nullreview' });
    expect(row).toBeTruthy();
    expect(row.daysSinceReview).toBeNull();
  });

  it('daysSinceReview is a positive integer when reviewedDate is in the past', async () => {
    const { Tutorials, TutorialMeta, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries(
      { ID: 'u-pr3-2', uuid: 'uuid-pr3-2', email: 'oldreview@example.com', firstName: 'O', lastName: 'R', displayName: 'O R' }
    );
    await INSERT.into(Tutorials).entries(
      { ID: 't-pr3-oldreview', slug: 'pr3-oldreview', title: 'Old Review', status: 'ACTIVE' }
    );
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    await INSERT.into(TutorialMeta).entries(
      { ID: 'm-pr3-oldreview', tutorial_ID: 't-pr3-oldreview', owner: 'X', ownerEmail: 'oldreview@example.com', reviewedDate: tenDaysAgo }
    );
    const row = await SELECT.one.from(MyTutorialsView).where({ ID: 't-pr3-oldreview' });
    expect(row).toBeTruthy();
    expect(row.daysSinceReview).toBeGreaterThanOrEqual(10);
    expect(row.daysSinceReview).toBeLessThanOrEqual(11); // allow 1-day tolerance for test timing
  });

  it('monitored is true when monitoredStatus is ACTIVE, false otherwise', async () => {
    const { Tutorials, TutorialMeta, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries([
      { ID: 'u-pr3-3', uuid: 'uuid-pr3-3', email: 'active@example.com', firstName: 'A', lastName: 'C', displayName: 'A C' },
      { ID: 'u-pr3-4', uuid: 'uuid-pr3-4', email: 'inactive@example.com', firstName: 'I', lastName: 'A', displayName: 'I A' }
    ]);
    await INSERT.into(Tutorials).entries([
      { ID: 't-pr3-active', slug: 'pr3-active', title: 'Active', status: 'ACTIVE' },
      { ID: 't-pr3-inactive', slug: 'pr3-inactive', title: 'Inactive', status: 'ACTIVE' }
    ]);
    await INSERT.into(TutorialMeta).entries([
      { ID: 'm-pr3-active', tutorial_ID: 't-pr3-active', owner: 'X', ownerEmail: 'active@example.com', monitoredStatus: 'ACTIVE' },
      { ID: 'm-pr3-inactive', tutorial_ID: 't-pr3-inactive', owner: 'X', ownerEmail: 'inactive@example.com', monitoredStatus: 'INACTIVE' }
    ]);
    const activeRow = await SELECT.one.from(MyTutorialsView).where({ ID: 't-pr3-active' });
    const inactiveRow = await SELECT.one.from(MyTutorialsView).where({ ID: 't-pr3-inactive' });
    expect(activeRow.monitored).toBe(true);
    expect(inactiveRow.monitored).toBe(false);
  });

  it('repositoryName is null when TutorialMeta.repository_ID is unset (chain query NULL-safe)', async () => {
    // Fixture above seeds rows without a repository_ID — chain returns null.
    const row = await SELECT.one.from(MyTutorialsView).where({ ID: 't-pr3-active' });
    expect(row.repositoryName).toBeNull();
  });
});
```

### Step 2: Update existing tests that reference renamed/deleted fields

**`test/unit/lib/tutorial-review.test.js`, line 46** (the `snoozeTutorial sets lastNotificationDate` test):

OLD:
```javascript
const delta = Date.parse(result.lastNotificationDate) - Date.now();
```

NEW:
```javascript
const delta = Date.parse(result.notificationDate) - Date.now();
```

Also update the test name on line 44 from `'snoozeTutorial sets lastNotificationDate days into the future'` to `'snoozeTutorial sets notificationDate days into the future'`.

**`test/unit/author-service.test.js`, line 177** (the `snoozeTutorial accepts days` test):

OLD:
```javascript
expect(ok.lastNotificationDate).toBeDefined();
```

NEW:
```javascript
expect(ok.notificationDate).toBeDefined();
```

**`test/notification-reset.test.js`:**

- Line 70: DELETE the line `expect(reviewedRow.outdated).toBe(false);` (the `outdated` field no longer exists on the view).
- Lines 131-154: DELETE the entire `describe('MyTutorialsView.outdated calc field', ...)` block. The `outdated` field is removed in PR-3.

After deleting line 70, the `it('resets notificationNumber to 0 and clears lastNotificationDate', ...)` test still has valid assertions (line 68's `reviewedRow` check + line 71's `notificationNumber`).

### Step 3: Run tests to verify the new + updated assertions fail

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/385-pr3-authorservice
npx vitest run test/unit/author-service.test.js test/unit/lib/tutorial-review.test.js test/notification-reset.test.js 2>&1 | tail -20
```

Expected: many failures with messages like `repositoryName is not defined`, `Cannot read properties of undefined (reading 'notificationDate')`, `outdated is undefined on row`. These confirm the tests reach the view and the new shape is not yet in place.

### Step 4: Rewrite `db/views.cds` MyTutorialsView

Open `db/views.cds`. Find the `view MyTutorialsView as` block (~line 145). Replace the entire view body with:

```cds
view MyTutorialsView as
  select from ims.Tutorials as t
    inner join ims.TutorialMeta as m on m.tutorial.ID = t.ID
    inner join ims.Users        as u on u.email       = m.ownerEmail
  {
    key t.ID,
        t.slug,
        t.title,
        t.primaryTag,
        t.status,
        m.reviewedDate,
        m.monitoredStatus,
        m.notificationNumber,
        // #385 PR-3 rename: lastNotificationDate → notificationDate (view alias only;
        // underlying TutorialMeta column unchanged).
        m.lastNotificationDate    as notificationDate,
        m.firstNotificationDate,
        // #385 PR-3 rename: ownerName → owner (the underlying TutorialMeta.owner
        // column was already named `owner`; the previous view alias added a
        // confusing `Name` suffix).
        m.owner                   as owner,
        m.ownerEmail              as ownerEmail,
        u.uuid                    as ownerUserId,
        // #385 PR-3 NEW: chain through PR-1's TutorialMeta.repository Association.
        // NULL-safe — yields null when repository_ID is unset (the dominant case
        // until PR-2's backfill runs on DEV).
        m.repository.name         as repositoryName : String,
        // #385 PR-3 NEW: HANA strict-SQL rejects bare boolean comparisons in
        // SELECT projections (see feedback_hana_boolean_case_when). Wrap in
        // CASE WHEN ... THEN true ELSE false END for portability.
        case when m.monitoredStatus = 'ACTIVE'
             then true else false end                       as monitored : Boolean,
        // #385 PR-3 NEW: CAP-portable date arithmetic (HANA DAYS_BETWEEN,
        // SQLite julianday). Sage filters on this server-side via OData
        // $filter, so it must remain a CDS-side column (not a JS after-handler).
        // Returns NULL when reviewedDate is NULL — standard SQL semantics; OData
        // $filter automatically excludes NULL rows.
        days_between($now, m.reviewedDate)                  as daysSinceReview : Integer
  };
```

**Changes summary:**
- Renamed `m.lastNotificationDate` (alias only) → `notificationDate`.
- Renamed `m.owner as ownerName` → `m.owner as owner` (drops the misleading `Name` suffix).
- DELETED the entire `case when m.notificationNumber >= 4 ... outdated : Boolean` line.
- Added `m.repository.name as repositoryName : String` chain.
- Added `monitored` Boolean via CASE WHEN.
- Added `daysSinceReview` Integer via `days_between($now, m.reviewedDate)`.

### Step 5: Run tests to verify pass

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/385-pr3-authorservice
npx vitest run test/unit/author-service.test.js test/unit/lib/tutorial-review.test.js test/notification-reset.test.js 2>&1 | tail -10
```

Expected: tests in `test/notification-reset.test.js` may still fail until Task 2 renames the `snoozeTutorial` return key (its `notificationDate` rename). That's OK — Task 1's assertions are the MyTutorialsView shape; those should be GREEN now.

**Specifically, expect these results:**
- `test/unit/author-service.test.js`: the new `MyTutorialsView #385 PR-3 shape` describe block all PASS.
- `test/notification-reset.test.js`: the deleted `outdated` test cases are gone; the rest still pass.
- `test/unit/lib/tutorial-review.test.js`: still FAILING on the `notificationDate` assertion (because `snoozeTutorial` returns `lastNotificationDate` until Task 2).

If you see different results — investigate. A failing MyTutorialsView shape test is a bug in Step 4.

### Step 6: Verify cds compile still succeeds

```bash
npx cds compile db/schema.cds 2>&1 | tail -3
```

Expected: exit 0. (View compile errors show up here.)

### Step 7: Commit

```bash
git add db/views.cds test/unit/author-service.test.js test/notification-reset.test.js test/unit/lib/tutorial-review.test.js
git commit -m "feat(author): #385 PR-3 — MyTutorialsView renames + 3 calc fields + outdated deletion"
```

---

## Task 2: snoozeTutorial return-key rename

The `snoozeTutorial` lib function and the AuthorService action both still return `{ lastNotificationDate, notificationNumber }`. Task 1 already wrote the test expecting `notificationDate`. This task makes the implementation match.

**Files:**
- Modify: [`srv/author-service.cds`](../../../srv/author-service.cds) — action return type.
- Modify: [`srv/lib/tutorial-review.js`](../../../srv/lib/tutorial-review.js) — return-shape key.

### Step 1: Update the CDS action return type

Open `srv/author-service.cds`. Find the `snoozeTutorial` action declaration (~lines 24-27):

OLD:
```cds
action snoozeTutorial(tutorialId : UUID, days : Integer) returns {
  lastNotificationDate : Timestamp;
  notificationNumber   : Integer;
};
```

NEW:
```cds
action snoozeTutorial(tutorialId : UUID, days : Integer) returns {
  notificationDate     : Timestamp;   // #385 PR-3 rename (was lastNotificationDate)
  notificationNumber   : Integer;
};
```

### Step 2: Update the lib function return key

Open `srv/lib/tutorial-review.js`. Find `snoozeTutorial` (line 21-32). Replace line 31:

OLD:
```javascript
return { lastNotificationDate: snoozeUntil, notificationNumber: meta.notificationNumber };
```

NEW:
```javascript
return { notificationDate: snoozeUntil, notificationNumber: meta.notificationNumber };
```

The `UPDATE` call on line 30 still writes to the column `lastNotificationDate` — that's correct (the underlying DB column doesn't rename).

### Step 3: Run tests

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/385-pr3-authorservice
npx vitest run test/unit/author-service.test.js test/unit/lib/tutorial-review.test.js test/notification-reset.test.js 2>&1 | tail -10
```

Expected: ALL 3 test files pass now (Task 1's MyTutorialsView shape + Task 2's snoozeTutorial return).

### Step 4: Commit

```bash
git add srv/author-service.cds srv/lib/tutorial-review.js
git commit -m "feat(author): #385 PR-3 — rename snoozeTutorial return key lastNotificationDate→notificationDate"
```

---

## Task 3: Tags.actualTag virtual via HANA SUBSTR_AFTER

This task adds a HANA-only virtual column on `AuthorService.Tags`. Unit tests on SQLite **must skip** the `actualTag` assertions because SQLite doesn't have `SUBSTR_AFTER`. The hybrid test (Task 5) is the canonical verification.

**Files:**
- Modify: [`srv/author-service.cds`](../../../srv/author-service.cds) — Tags projection expansion.
- Modify: [`test/unit/author-service.test.js`](../../../test/unit/author-service.test.js) — gated assertion block.

### Step 1: Write the failing test (HANA-gated)

In `test/unit/author-service.test.js`, append at the END (after the new `MyTutorialsView #385 PR-3 shape` describe block from Task 1):

```javascript
const isHana = cds.env.requires.db?.kind === 'hana';

describe.skipIf(!isHana)('AuthorService.Tags #385 PR-3 actualTag (HANA-only)', () => {
  it('emits actualTag virtual column', async () => {
    const srv = await cds.connect.to('AuthorService');
    expect(srv.entities.Tags.elements.actualTag).toBeDefined();
  });

  // Note: behavioral tests for actualTag's SUBSTR_AFTER semantics live in the
  // hybrid test (test/hybrid/385-pr3-authorservice.test.js). On SQLite, the
  // `cds.env.requires.db.kind === 'hana'` gate above skips this entire block.
});
```

**Why only the metadata test on the unit side:** `cds.test('serve', '--in-memory')` boots SQLite, which doesn't understand `SUBSTR_AFTER`. Even running the metadata check (which doesn't actually exercise the SQL) is borderline — that's why we gate the whole describe block. CDS compile may or may not emit a SQL-compatible artefact on SQLite; gating is the safe bet.

### Step 2: Run test to verify it skips on SQLite (no failure)

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/385-pr3-authorservice
npx vitest run test/unit/author-service.test.js 2>&1 | tail -10
```

Expected: the new `AuthorService.Tags #385 PR-3 actualTag` describe block appears as **SKIPPED** (vitest reports `1 skipped` for the suite). Test failures elsewhere in the file would indicate breakage from Tasks 1-2; investigate if any.

### Step 3: Update srv/author-service.cds Tags projection

In `srv/author-service.cds`, find the `Tags` projection (~line 14):

OLD:
```cds
@Capabilities.ChangeTracking : { Supported: true }
@readonly entity Tags as projection on ims.Tags;
```

NEW:
```cds
@Capabilities.ChangeTracking : { Supported: true }
@readonly entity Tags as projection on ims.Tags {
  *,
  // #385 PR-3: HANA-native SUBSTR_AFTER returns the substring after the LAST
  // occurrence of the delimiter — exactly matches Riley's "leaf after last '>'"
  // contract. NOT portable to SQLite. Unit tests gate actualTag assertions
  // behind cds.env.requires.db.kind === 'hana'. Hybrid test
  // (test/hybrid/385-pr3-authorservice.test.js) is the canonical verification.
  // Trade-off pattern: see feedback_hana_boolean_case_when.
  SUBSTR_AFTER(name, '>') as actualTag : String
};
```

### Step 4: Verify cds compile

```bash
npx cds compile srv/author-service.cds 2>&1 | tail -5
```

Expected: exit 0. CDS should accept `SUBSTR_AFTER` as a native function reference — same parsing path as `ifnull` per CAP docs.

### Step 5: Re-run unit tests

```bash
npx vitest run test/unit/author-service.test.js 2>&1 | tail -10
```

Expected: results identical to Step 2. The new describe block stays SKIPPED on SQLite. Existing tests (including the Task 1 + Task 2 cases) stay PASSING.

**If SQLite tries to evaluate the `SUBSTR_AFTER` and fails at boot:** the `describe.skipIf` only skips the assertions, not the cds.test() boot. If boot fails, we need to investigate whether `cds.test('serve', '--in-memory')` can be configured to skip the unknown function, OR move the projection to a non-default-projected column. **Quick test:** run `npx vitest run test/unit/author-service.test.js 2>&1 | head -30` and look for boot errors. If the suite fails to load, escalate as BLOCKED and we'll adjust the gating strategy.

### Step 6: Commit

```bash
git add srv/author-service.cds test/unit/author-service.test.js
git commit -m "feat(author): #385 PR-3 — Tags.actualTag virtual via HANA SUBSTR_AFTER (SQLite-gated tests)"
```

---

## Task 4: isSlugAvailable action

Server-side case-insensitive `LOWER()` match against `Tutorials.slug`.

**Files:**
- Modify: [`srv/author-service.cds`](../../../srv/author-service.cds) — declare action.
- Modify: [`srv/author-service.js`](../../../srv/author-service.js) — handler.
- Modify: [`test/unit/author-service.test.js`](../../../test/unit/author-service.test.js) — 4 new test cases.

### Step 1: Write failing tests

Append at the END of `test/unit/author-service.test.js`:

```javascript
describe('AuthorService.isSlugAvailable #385 PR-3', () => {
  it('returns true for a non-existent slug', async () => {
    const srv = await cds.connect.to('AuthorService');
    const result = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.send('isSlugAvailable', { slug: 'definitely-not-real-slug-pr3' })
    );
    expect(result).toBe(true);
  });

  it('returns false for an existing slug (the fixture seeds tut-1)', async () => {
    const srv = await cds.connect.to('AuthorService');
    const result = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.send('isSlugAvailable', { slug: 'tut-1' })
    );
    expect(result).toBe(false);
  });

  it('matches case-insensitively (TUT-1 matches existing tut-1)', async () => {
    const srv = await cds.connect.to('AuthorService');
    const result = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.send('isSlugAvailable', { slug: 'TUT-1' })
    );
    expect(result).toBe(false);
  });

  it('returns 400 when slug is empty or null', async () => {
    const srv = await cds.connect.to('AuthorService');
    await expect(
      srv.tx(
        { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
        (tx) => tx.send('isSlugAvailable', { slug: '' })
      )
    ).rejects.toMatchObject({ code: 400 });
    await expect(
      srv.tx(
        { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
        (tx) => tx.send('isSlugAvailable', { slug: null })
      )
    ).rejects.toMatchObject({ code: 400 });
  });
});
```

### Step 2: Run tests to verify failure

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/385-pr3-authorservice
npx vitest run test/unit/author-service.test.js 2>&1 | tail -10
```

Expected: 4 FAIL with "operation not found" / "isSlugAvailable is not a function".

### Step 3: Declare the action in srv/author-service.cds

Find the end of the `service AuthorService { ... }` block. **Before** the closing `}`, add (immediately after the `AnalyticsBranchTopPick` entity declaration):

```cds
  // #385 PR-3 — server-side case-insensitive slug uniqueness check.
  // Sage calls this before creating a new tutorial to surface name conflicts
  // before submitting the write. The check is intentionally a UX hint, not a
  // lock: a benign TOCTOU window exists between the check and a subsequent
  // insert. The write-side @assert.unique.slug constraint catches any race.
  action isSlugAvailable(slug : String) returns Boolean;
```

### Step 4: Implement the handler in srv/author-service.js

Open `srv/author-service.js`. Find the `cds.service.impl` block (`export default cds.service.impl(async function () { ... })`). **Before** the closing `})`, add (immediately after the existing `generateOsVariants` handler):

```javascript
  this.on('isSlugAvailable', async (req) => {
    const { slug } = req.data;
    if (!slug || typeof slug !== 'string') {
      return req.reject(400, 'slug must be a non-empty string');
    }
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    // LOWER()-based case-insensitive match. Mirrors the publish-side upsert
    // shape in srv/lib/content-publish-session.js so this UX check uses the
    // same key space as @assert.unique.slug's enforcement at write time.
    const row = await SELECT.one.from(Tutorials)
      .columns('ID')
      .where`LOWER(slug) = ${slug.toLowerCase()}`;
    return !row;  // true = available
  });
```

### Step 5: Run tests to verify pass

```bash
npx vitest run test/unit/author-service.test.js 2>&1 | tail -10
```

Expected: 4 PASS (plus all earlier tests still passing).

### Step 6: Commit

```bash
git add srv/author-service.cds srv/author-service.js test/unit/author-service.test.js
git commit -m "feat(author): #385 PR-3 — isSlugAvailable action with case-insensitive LOWER match"
```

---

## Task 5: Hybrid test (post-deploy verification)

Read-only verification against real HANA. Cannot run pre-deploy.

**Files:**
- Create: [`test/hybrid/385-pr3-authorservice.test.js`](../../../test/hybrid/385-pr3-authorservice.test.js)

### Step 1: Look at the established hybrid test pattern

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/385-pr3-authorservice
head -25 test/hybrid/385-pr2-migrator.test.js
```

Confirm the cds.test() boot pattern + namespace access shape.

### Step 2: Create the hybrid test file

Write `test/hybrid/385-pr3-authorservice.test.js`:

```javascript
/**
 * #385 PR-3 hybrid test — verifies AuthorService projection emits the new
 * fields with real data after PR-2's migration pass populates the underlying
 * columns.
 *
 * Read-only — no fixture writes, no cleanup. Spec:
 * docs/superpowers/specs/2026-06-21-issue-385-pr3-authorservice-design.md
 *
 * Run with: cf login + cds bind --exec -- npx vitest run test/hybrid/385-pr3-authorservice.test.js
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('#385 PR-3 — AuthorService projection (hybrid)', () => {
  let MyTutorialsView, Tags, Tutorials;

  beforeAll(async () => {
    const ns = cds.entities('com.sap.developers.ims');
    MyTutorialsView = ns.MyTutorialsView;
    Tags            = ns.Tags;
    Tutorials       = ns.Tutorials;
  });

  it('MyTutorialsView emits the 3 new fields with correct types', async () => {
    const row = await SELECT.one.from(MyTutorialsView)
      .columns('ID', 'repositoryName', 'monitored', 'daysSinceReview');
    expect(row).toBeTruthy();
    // monitored is always a boolean; daysSinceReview is integer-or-null;
    // repositoryName is string-or-null.
    expect(typeof row.monitored).toBe('boolean');
  });

  it('MyTutorialsView has at least one row with non-null repositoryName (PR-2 backfill verification)', async () => {
    // Softer than a hard expect — if PR-2's migration hasn't actually run on
    // DEV yet, this should skip rather than fail noisily for a reason
    // unrelated to PR-3 code. PR-2's hybrid test asserts the underlying data;
    // this test only verifies the AuthorService projection surfaces it.
    const row = await SELECT.one.from(MyTutorialsView).where('repositoryName is not null');
    if (!row) {
      console.warn('[skip] No MyTutorials rows with repositoryName — PR-2 migration may not have run yet');
      return;
    }
    expect(typeof row.repositoryName).toBe('string');
  });

  it('Tags projection emits actualTag matching SUBSTR_AFTER semantics', async () => {
    // Find a tag whose name has '>' in it
    const tag = await SELECT.one.from(Tags).columns('name', 'actualTag').where(`name like '%>%'`);
    if (!tag) {
      console.warn('[skip] No Tags rows with > in name — tag dataset may be flat-only');
      return;
    }
    // actualTag should be the substring after the LAST '>'
    const expected = tag.name.slice(tag.name.lastIndexOf('>') + 1);
    expect(tag.actualTag).toBe(expected);
  });

  it('isSlugAvailable returns true for a generated unique slug', async () => {
    const AuthorService = await cds.connect.to('AuthorService');
    const result = await AuthorService.send('isSlugAvailable', {
      slug: `pr3-probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    });
    expect(result).toBe(true);
  });

  it('isSlugAvailable returns false for an existing slug (case-insensitive)', async () => {
    // Find any existing tutorial slug
    const tut = await SELECT.one.from(Tutorials).columns('slug').where('slug is not null');
    if (!tut?.slug) {
      console.warn('[skip] No Tutorials with slug — Tutorials table may be empty');
      return;
    }
    const AuthorService = await cds.connect.to('AuthorService');
    const result = await AuthorService.send('isSlugAvailable', { slug: tut.slug.toUpperCase() });
    expect(result).toBe(false);
  });
});
```

### Step 3: Verify parse

```bash
node --check test/hybrid/385-pr3-authorservice.test.js
```

Expected: no output (success).

**Do NOT run the test** — it requires real HANA + `cds bind --exec`, neither available right now.

### Step 4: Commit

```bash
git add test/hybrid/385-pr3-authorservice.test.js
git commit -m "test(hybrid): #385 PR-3 — AuthorService projection verification (post-deploy)"
```

---

## Task 6: Documentation — author-service.md

Create the architecture doc with Riley's old→new rename map.

**Files:**
- Create: [`docs/developers/architecture/author-service.md`](../../../docs/developers/architecture/author-service.md)

### Step 1: Create the doc

Write the file with this content (or amend if it already exists):

```markdown
# AuthorService architecture

> Service path: `/author`. Auth: `@requires: 'Tutorial.Author'`. Source: `srv/author-service.cds`.

## Overview

`AuthorService` is the OData V4 surface for tutorial authors. It exposes a read-only view of the author's own tutorials (`MyTutorials`), the tag taxonomy (`Tags`), branch analytics, and a handful of actions (review/snooze/OS-variant generation/slug-availability check).

The service is consumed by:
- The Sage VS Code extension (primary consumer).
- The admin shell at `/admin-ui/` (indirectly — most admin reads go through `AdminService`).

## Entities

| Entity | Shape | Notes |
|---|---|---|
| `Tutorials` | projection on `Tutorials` (ID, slug, title, primaryTag, status) | Read-only. Lightweight metadata only. |
| `Tags` | projection on `Tags` with virtual `actualTag` | `actualTag` is HANA-native `SUBSTR_AFTER(name, '>')`. |
| `MyTutorials` | projection on `MyTutorialsView` | Filtered to `ownerUserId == req.user.id` by a before-handler. |
| `AnalyticsBranchPerformance` / `AnalyticsBranchTopPick` | aggregated branch analytics | See `srv/analytics-service.cds` for the canonical definition. |

## Actions

| Action | Inputs | Returns | Notes |
|---|---|---|---|
| `reviewTutorial` | `tutorialId : UUID` | `{ reviewedDate, notificationNumber }` | Owner-only. Resets the 4-nag state. |
| `snoozeTutorial` | `tutorialId, days` | `{ notificationDate, notificationNumber }` | Owner-only. Pushes the next nag out. |
| `generateOsVariants` | `sourceMarkdown, sourceOS, targetOSes, context` | `{ variants, model, tokensUsed, requestId }` | Per-user rate-limited (60/hr). |
| `isSlugAvailable` | `slug : String` | `Boolean` | Server-side case-insensitive uniqueness check. UX hint, not a lock. |

## #385 PR-3 field renames (2026-06-21)

The `MyTutorials` entity in `AuthorService` underwent renames as part of unifying field names with Sage's expectations. Consumers migrating from the previous schema can use this table:

| Old name (pre-PR-3) | New name (post-PR-3) | Notes |
|---|---|---|
| `ownerName` | `owner` | Pure rename; underlying `TutorialMeta.owner` column unchanged. |
| `lastNotificationDate` | `notificationDate` | Pure rename; applies to `MyTutorials` AND `snoozeTutorial` action return. Underlying `TutorialMeta.lastNotificationDate` column unchanged. |
| `outdated` | _(deleted)_ | Use `daysSinceReview` with a client-side threshold (Sage owns the UX). |
| _(none — new)_ | `repositoryName` | Repo group name from `TutorialRepositories` (#385 PR-1 schema, PR-2 backfill). NULL until backfill runs. |
| _(none — new)_ | `monitored` | Boolean: `true` iff `monitoredStatus === 'ACTIVE'`. |
| _(none — new)_ | `daysSinceReview` | Integer: `DAYS_BETWEEN(NOW, reviewedDate)`. Server-side `$filter`/`$orderby` supported. NULL when `reviewedDate` is NULL. |
| _(none — new on `Tags`)_ | `actualTag` | `Tags` virtual; HANA-native `SUBSTR_AFTER(name, '>')`. Leaf after last `>`. |

### New action: `isSlugAvailable`

`isSlugAvailable(slug : String) returns Boolean` — server-side case-insensitive uniqueness check across all `Tutorials.slug`. Use before creating a new tutorial to surface conflicts to the user; the write-side `@assert.unique.slug` remains the source of truth at insert time.

The check is intentionally a UX hint, not a lock. A benign TOCTOU window exists between the check and a subsequent insert; the write-side constraint catches any race condition.

## Authorization

Service-level `@requires: 'Tutorial.Author'` is the only gate. All entities, actions, and read paths require the caller's `req.user.roles['Tutorial.Author']` to be true.

The `MyTutorials` projection additionally filters by `ownerUserId == req.user.id` via a `this.before('READ', ...)` handler. The ownership assertion for `reviewTutorial` and `snoozeTutorial` is enforced in handlers (`srv/author-service.js`).
```

If the file already exists, only append the new `## #385 PR-3 field renames` section and (if not already present) the `### New action: isSlugAvailable` block.

### Step 2: Verify the doc passes the VitePress dead-link guard

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/385-pr3-authorservice
node scripts/check-sidebar.ts 2>&1 | tail -5 || true
```

If `scripts/check-sidebar.ts` doesn't exist or fails for unrelated reasons, skip this — VitePress sidebar maintenance is handled by `docs/.vitepress/config.ts` and the project's `predocs:build` script. The new doc may need to be added to the sidebar, but that's a docs-site concern, not a code one. Add a note in the PR description if so.

### Step 3: Commit

```bash
git add docs/developers/architecture/author-service.md
git commit -m "docs(author): #385 PR-3 — author-service.md with rename map + isSlugAvailable"
```

---

## Task 7: Final sanity pass

**Files:** None modified — verification only.

- [ ] **Step 1: Branch + scope check**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/385-pr3-authorservice
git branch --show-current     # expect: worktree-385-pr3-authorservice
git log --oneline main..HEAD  # expect: ~7-8 commits, all PR-3
git diff --name-only main..HEAD | sort
```

Expected file scope (matches §"File Structure"):
```
db/views.cds
docs/developers/architecture/author-service.md
docs/superpowers/plans/2026-06-21-issue-385-pr3-authorservice.md
docs/superpowers/specs/2026-06-21-issue-385-pr3-authorservice-design.md
srv/author-service.cds
srv/author-service.js
srv/lib/tutorial-review.js
test/hybrid/385-pr3-authorservice.test.js
test/notification-reset.test.js
test/unit/author-service.test.js
test/unit/lib/tutorial-review.test.js
```

If anything else is listed, investigate (likely a CRLF flip — see memory `feedback_crlf_regression_on_windows`).

- [ ] **Step 2: Full in-scope test run**

```bash
npx vitest run test/unit/author-service.test.js test/unit/lib/tutorial-review.test.js test/notification-reset.test.js 2>&1 | tail -10
```

Expected: all green (the `actualTag` describe block skips on SQLite — that's correct).

- [ ] **Step 3: Compile check**

```bash
npx cds compile db/schema.cds 2>&1 | tail -3
npx cds compile srv/author-service.cds 2>&1 | tail -3
```

Both exit 0.

- [ ] **Step 4: Rebase on origin/main (in case main moved)**

```bash
git fetch origin
git log --oneline origin/main..HEAD | head -10
git log --oneline HEAD..origin/main | head -10
```

If origin/main has new commits, rebase:

```bash
git rebase origin/main
# re-run Step 2's tests after rebase
```

- [ ] **Step 5: Commit the plan itself (if not yet committed)**

```bash
git add docs/superpowers/plans/2026-06-21-issue-385-pr3-authorservice.md
git status --short    # confirm only the plan file is pending
git commit -m "docs(plan): #385 PR-3/3 AuthorService field expansion implementation plan"
```

---

## Task 8: Open the PR

**Files:** None modified — PR creation step.

- [ ] **Step 1: Push the branch**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/385-pr3-authorservice
git push -u origin worktree-385-pr3-authorservice
```

- [ ] **Step 2: Draft the PR body**

Use this template verbatim (substitute commit SHAs and final test count):

````markdown
Final PR of the #385 sequence. Depends on PR #517 (PR-1 schema redesign) and PR #528 (PR-2 migrator extension), both merged 2026-06-21.

## Why

PR-1 reshaped the CAP schema. PR-2 wired the migrator + backfill to populate the new columns. PR-3 (this PR) exposes the new surface to Sage via `AuthorService`, completing Riley's #385 contract (settled 2026-06-19).

After this PR merges + deploys, Sage's VS Code extension can replace its local SQLite cache with on-demand OData calls against the new `MyTutorials` shape.

## What's in this PR

**`db/views.cds` — MyTutorialsView rewrite:**

- RENAMED: `m.lastNotificationDate as notificationDate` (was `lastNotificationDate`).
- RENAMED: `m.owner as owner` (was `m.owner as ownerName` — dropped the misleading "Name" suffix).
- DELETED: `outdated` Boolean field. Use `daysSinceReview` with a client-side threshold (Sage owns the UX; see #450 for the 4-nag cron lifecycle).
- NEW: `repositoryName : String` via 2-level Association chain `m.repository.name` (PR-1 schema, PR-2 backfill).
- NEW: `monitored : Boolean` via CASE WHEN `monitoredStatus = 'ACTIVE'`.
- NEW: `daysSinceReview : Integer` via portable `days_between($now, m.reviewedDate)`. CDS-side so Sage can `$filter`/`$orderby`.

**`srv/author-service.cds` — Tags projection + action declarations:**

- Tags now projects `*` plus HANA-native `SUBSTR_AFTER(name, '>') as actualTag : String`. SQLite unit tests gate `actualTag` assertions behind `cds.env.requires.db.kind === 'hana'`.
- `snoozeTutorial` action return type renamed (`lastNotificationDate → notificationDate`).
- New action: `isSlugAvailable(slug : String) returns Boolean`.

**`srv/author-service.js`:**

- New `isSlugAvailable` handler: case-insensitive `LOWER()` match against `Tutorials.slug`. UX hint (TOCTOU window is benign; `@assert.unique.slug` is the write-side enforcer).

**`srv/lib/tutorial-review.js`:**

- `snoozeTutorial` return key renamed (`lastNotificationDate → notificationDate`). Underlying DB column unchanged.

**Tests:**

- `test/unit/author-service.test.js` — extended with: MyTutorialsView shape assertions (renames, new fields, deleted fields), `monitored` truth table, `daysSinceReview` NULL + positive-integer cases, `repositoryName` NULL-safe chain, `isSlugAvailable` 4 cases (true, false, case-insensitive, 400), HANA-gated `actualTag` shape check.
- `test/unit/lib/tutorial-review.test.js` — `snoozeTutorial` return key updated.
- `test/notification-reset.test.js` — `outdated` assertion + dedicated `MyTutorialsView.outdated calc field` describe block removed.
- `test/hybrid/385-pr3-authorservice.test.js` — new read-only post-deploy hybrid test (5 assertions; soft-skips when PR-2 backfill data isn't present yet).

**Docs:**

- `docs/developers/architecture/author-service.md` — new architecture doc with the old→new rename map (carries the spec's table verbatim).

## Old → new rename map

(See `docs/developers/architecture/author-service.md` for the canonical table.)

| Old name (pre-PR-3) | New name (post-PR-3) | Notes |
|---|---|---|
| `ownerName` | `owner` | Pure rename. |
| `lastNotificationDate` | `notificationDate` | View alias AND `snoozeTutorial` return key. |
| `outdated` | _(deleted)_ | Use `daysSinceReview`. |
| _(new)_ | `repositoryName` | Chain via TutorialMeta.repository. NULL until PR-2 backfill runs. |
| _(new)_ | `monitored` | `monitoredStatus === 'ACTIVE'`. |
| _(new)_ | `daysSinceReview` | `DAYS_BETWEEN(NOW, reviewedDate)`. Server-side filterable. |
| _(new on Tags)_ | `actualTag` | HANA `SUBSTR_AFTER(name, '>')`. |
| _(new action)_ | `isSlugAvailable(slug)` | Server-side `LOWER()` match. Returns Boolean. |

## Test results

```
vitest run test/unit/author-service.test.js test/unit/lib/tutorial-review.test.js test/notification-reset.test.js
Test Files  3 passed (3)
     Tests  N passed (... skipped on SQLite gate)
```

`npx cds compile db/schema.cds` — exit 0.
`npx cds compile srv/author-service.cds` — exit 0.

## Rollout

1. Merge PR-3.
2. Standard MTA deploy (no schema migration; just a view + service projection).
3. Verify with hybrid test: `cf login` + `npx cds bind --exec -- npx vitest run test/hybrid/385-pr3-authorservice.test.js`. All 5 should pass.
4. Coordinate with Riley — Sage updates its OData calls to the new field names. The rename map in `author-service.md` is the canonical migration table.

## Backout

- Revert the PR. View reverts to the pre-PR-3 shape; Sage falls back to pre-PR-3 fields.
- No data risk — no schema changes, no migration tables.

## Spec + plan trail

- Spec: `docs/superpowers/specs/2026-06-21-issue-385-pr3-authorservice-design.md`
- Plan: `docs/superpowers/plans/2026-06-21-issue-385-pr3-authorservice.md`
- PR-1: #517 (merged 2026-06-21)
- PR-2: #528 (merged 2026-06-21)

Closes #385.
````

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "feat(author): #385 PR-3/3 — AuthorService field expansion + isSlugAvailable action" \
             --body-file <pr-body-file> \
             --base main
```

- [ ] **Step 4: Confirm + record**

```bash
gh pr view --json number,url,state,changedFiles
```

Record the PR number.

---

## Notes for the executor

- **Branch is `worktree-385-pr3-authorservice`.** Verify with `git branch --show-current` before EVERY commit. See memories `[[feedback_branch_slip_after_long_session]]` and `[[feedback_verify_branch_before_commit]]`.
- **Git Bash on Windows:** prefix every Bash invocation with `cd d:/projects/tutorials-poc/.claude/worktrees/385-pr3-authorservice && ` since shell cwd doesn't persist between Bash tool calls.
- **PR-3 closes the 3-PR sequence.** Use `Closes #385.` in the PR body (last line). The two predecessor PRs (#517, #528) already partially addressed it but didn't close it. GitHub will close it on PR-3's merge.
- **Renames are coordinated with Riley.** Don't merge without confirming Sage is ready to flip to the new field names — the spec's Rollout step 4 names this dependency.
- **`SUBSTR_AFTER` is HANA-only.** The unit-test gate is the safety net; the hybrid test is the canonical verification. If Task 3 Step 5 reveals SQLite can't boot with `SUBSTR_AFTER` in the view, escalate as BLOCKED — Tom will help redesign.
- **No `cf set-env`, no deploy env changes.** PR-3 is service-surface only. The next-deployment runbook is unchanged.
