# Feedback Irrelevant Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow admins to mark `TutorialFeedback` entries as irrelevant/inappropriate so they are excluded from all aggregation views and author-visible surfaces.

**Architecture:** Add a `isIrrelevant` Boolean field (default `false`) and an optional `irrelevantReason` String(500) to `ims.TutorialFeedback`. Filter `WHERE isIrrelevant IS NOT TRUE` into both aggregate views (`TutorialFeedbackAggregate`, `AuthorSurveyDistribution`). Expose `AdminService` actions `markFeedbackIrrelevant(id, reason)` / `unmarkFeedbackIrrelevant(id)` (admin-only) rather than making the entity directly updatable. Update admin-annotations and the feedback digest to honour the flag. Author-service and analytics-service projections inherit the filter automatically through the views.

**Tech Stack:** CAP CDS (Node.js), Fiori Elements (SAP UI5), Vitest unit tests.

**Spec:** GitHub issue [#2947](https://github.com/sap-tutorials/tutorials-ims/issues/2947)

## Global Constraints

- Never write raw SQL — use CDS QL (`cds.ql`) or CQL.
- Never make `TutorialFeedback` entity directly updatable via OData (retain `Capabilities.UpdateRestrictions: { Updatable: false }`).
- Actions `markFeedbackIrrelevant` / `unmarkFeedbackIrrelevant` must be on `AdminService` only.
- The flag MUST NOT be settable through `DeveloperService` (public submission endpoint).
- Field name: `isIrrelevant : Boolean default false`, reason field: `irrelevantReason : String(500)`.
- `TutorialFeedbackAggregate` and `AuthorSurveyDistribution` must filter `WHERE isIrrelevant IS NOT TRUE` (handles both `false` and `null` / pre-migration rows).
- Feedback digest (`srv/lib/feedback-digest.js`) must exclude irrelevant rows.
- No changes to the public submission flow (`submitTutorialFeedback`).

## Review Focus

- **NULL vs false**: `isIrrelevant IS NOT TRUE` must be used (not `= false`) so rows inserted before the migration (HANA NULL) are treated as relevant. Covered by Task 1 view filter test.
- **Aggregate count correctness**: `responseCount` in `TutorialFeedbackAggregate` must not include flagged rows. Covered by Task 1 test.
- **AuthorSurveyDistribution all 7 legs**: each UNION ALL leg must also filter. Covered by Task 1 test.
- **Unauthorized flag attempt**: a non-admin caller to `markFeedbackIrrelevant` must receive 403. The action is declared on `AdminService` whose `@requires` already enforces `Tutorial.Admin`; verified by the cds.test mock-auth assertion in Task 2.
- **Digest skip**: flagged rows with non-empty comments must be excluded from digest computation. Covered by Task 4 test.

---

### Task 1: Add `isIrrelevant` and `irrelevantReason` fields and filter both aggregate views

**Files:**
- Modify: `db/schema.cds:919-933`
- Modify: `db/views.cds:441-455` (`TutorialFeedbackAggregate`)
- Modify: `db/views.cds:650-698` (`AuthorSurveyDistribution`)
- Test: `srv/__tests__/tutorial-feedback-aggregate.test.js`

**Interfaces:**
- Produces: `ims.TutorialFeedback.isIrrelevant : Boolean default false` — used by Tasks 2, 3, 4, 5.
- Produces: `ims.TutorialFeedback.irrelevantReason : String(500)` — used by Tasks 3, 5.
- Produces: both views filter `WHERE isIrrelevant IS NOT TRUE` — verified by this task's tests.

- [ ] **Step 1: Write failing tests**

Add a new describe block to `srv/__tests__/tutorial-feedback-aggregate.test.js`:

```js
describe('isIrrelevant filtering', () => {
  afterEach(async () => {
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TutorialFeedback).where({ tutorialSlug: { like: 'flag-test%' } });
  });

  it('excludes flagged rows from TutorialFeedbackAggregate responseCount', async () => {
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TutorialFeedback).entries([
      { tutorialSlug: 'flag-test-1', npsScore: 9, isIrrelevant: false },
      { tutorialSlug: 'flag-test-1', npsScore: 0, isIrrelevant: true }
    ]);
    const [row] = await SELECT.from('com.sap.developers.ims.TutorialFeedbackAggregate')
      .where({ tutorialSlug: 'flag-test-1' });
    expect(row.responseCount).toBe(1);
    expect(row.promoters).toBe(1);
    expect(row.detractors).toBe(0);
  });

  it('AuthorSurveyDistribution excludes flagged rows across all legs', async () => {
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TutorialFeedback).entries([
      { tutorialSlug: 'flag-test-2', npsScore: 8, ratingStructure: 7, isIrrelevant: false },
      { tutorialSlug: 'flag-test-2', npsScore: 1, ratingStructure: 2, isIrrelevant: true }
    ]);
    const rows = await SELECT.from('com.sap.developers.ims.AuthorSurveyDistribution')
      .where({ tutorialSlug: 'flag-test-2' });
    // Flagged row had scores 1 (nps) and 2 (structure) — neither should appear
    expect(rows.every(r => r.score !== 1 && r.score !== 2)).toBe(true);
    // Non-flagged row's scores 8 (nps) and 7 (structure) must appear
    expect(rows.some(r => r.score === 8)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --reporter=verbose --testPathPattern=tutorial-feedback-aggregate`
Expected: FAIL — `isIrrelevant` column does not exist.

- [ ] **Step 3: Add fields to `db/schema.cds` after the `comment` field (line 932)**

```cds
  isIrrelevant      : Boolean default false;
  irrelevantReason  : String(500);
```

- [ ] **Step 4: Add `WHERE isIrrelevant IS NOT TRUE` to `TutorialFeedbackAggregate` in `db/views.cds`**

The view on line 442 (`select from ims.TutorialFeedback { ... } group by tutorialSlug`) gains a `where isIrrelevant IS NOT TRUE` clause between the field list and the `group by`.

- [ ] **Step 5: Add `AND isIrrelevant IS NOT TRUE` to all 7 UNION ALL legs in `AuthorSurveyDistribution`**

Each leg has a `where <dimension> is not null` clause; extend each to `where <dimension> is not null AND isIrrelevant IS NOT TRUE`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- --reporter=verbose --testPathPattern=tutorial-feedback-aggregate`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add db/schema.cds db/views.cds srv/__tests__/tutorial-feedback-aggregate.test.js
git commit -m "feat(feedback): add isIrrelevant field and filter aggregate views (#2947)"
```

---

### Task 2: Expose `markFeedbackIrrelevant` / `unmarkFeedbackIrrelevant` actions on AdminService

**Files:**
- Modify: `srv/admin-service.cds` (actions section near line 851)
- Modify: `srv/admin-service.js` (add handlers near other action handlers)
- Test: `srv/__tests__/tutorial-feedback.test.js` (new describe block)

**Interfaces:**
- Consumes: `ims.TutorialFeedback.isIrrelevant`, `ims.TutorialFeedback.irrelevantReason` from Task 1.
- Produces:
  - `AdminService.markFeedbackIrrelevant(id: UUID @mandatory, reason?: String(500)) returns {}`
  - `AdminService.unmarkFeedbackIrrelevant(id: UUID @mandatory) returns {}`

- [ ] **Step 1: Write failing tests**

Add to `srv/__tests__/tutorial-feedback.test.js` after the existing describe blocks:

```js
describe('markFeedbackIrrelevant / unmarkFeedbackIrrelevant', () => {
  let adminSrv;
  let feedbackId;

  beforeAll(async () => {
    adminSrv = await cds.connect.to('AdminService');
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    const rows = await INSERT.into(TutorialFeedback)
      .entries([{ tutorialSlug: 'demo-tutorial', npsScore: 5 }])
      .returning('ID');
    feedbackId = rows[0].ID;
  });

  afterAll(async () => {
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TutorialFeedback).where({ ID: feedbackId });
  });

  it('marks a feedback entry irrelevant with a reason', async () => {
    await adminSrv.send('markFeedbackIrrelevant', { id: feedbackId, reason: 'Off-topic' });
    const [row] = await SELECT.from('com.sap.developers.ims.TutorialFeedback').where({ ID: feedbackId });
    expect(row.isIrrelevant).toBe(true);
    expect(row.irrelevantReason).toBe('Off-topic');
  });

  it('unmarks a feedback entry and clears the reason', async () => {
    await adminSrv.send('unmarkFeedbackIrrelevant', { id: feedbackId });
    const [row] = await SELECT.from('com.sap.developers.ims.TutorialFeedback').where({ ID: feedbackId });
    expect(row.isIrrelevant).toBe(false);
    expect(row.irrelevantReason).toBeNull();
  });

  it('returns 404 for an unknown id', async () => {
    await expect(
      adminSrv.send('markFeedbackIrrelevant', { id: '00000000-0000-0000-0000-000000000000' })
    ).rejects.toMatchObject({ code: 404 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --reporter=verbose --testPathPattern=tutorial-feedback.test`
Expected: FAIL — actions not defined.

- [ ] **Step 3: Add action declarations to `srv/admin-service.cds`**

After line 849 (`@readonly entity TutorialFeedbackAggregate ...`), add:

```cds
  action markFeedbackIrrelevant(id : UUID @mandatory, reason : String(500)) returns {};
  action unmarkFeedbackIrrelevant(id : UUID @mandatory) returns {};
```

- [ ] **Step 4: Implement handlers in `srv/admin-service.js`**

Using `cds.entities('com.sap.developers.ims').TutorialFeedback`, add inside the service init:

`this.on('markFeedbackIrrelevant', async (req) => { ... })`:
- `const { TutorialFeedback } = cds.entities('com.sap.developers.ims');`
- `const row = await SELECT.one.from(TutorialFeedback).where({ ID: req.data.id });`
- If `!row` → `req.error(404, 'Feedback entry not found')`.
- `await UPDATE(TutorialFeedback).set({ isIrrelevant: true, irrelevantReason: req.data.reason ?? null }).where({ ID: req.data.id });`
- `return {};`

`this.on('unmarkFeedbackIrrelevant', async (req) => { ... })`:
- Same 404 guard.
- `await UPDATE(TutorialFeedback).set({ isIrrelevant: false, irrelevantReason: null }).where({ ID: req.data.id });`
- `return {};`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --reporter=verbose --testPathPattern=tutorial-feedback.test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js srv/__tests__/tutorial-feedback.test.js
git commit -m "feat(feedback): add markFeedbackIrrelevant/unmarkFeedbackIrrelevant admin actions (#2947)"
```

---

### Task 3: Update admin-annotations for the Feedback list and object page

**Files:**
- Modify: `app/admin-annotations.cds:2206-2286`

**Interfaces:**
- Consumes: `isIrrelevant`, `irrelevantReason` from Task 1; `AdminService.markFeedbackIrrelevant`, `AdminService.unmarkFeedbackIrrelevant` from Task 2.

- [ ] **Step 1: Add field labels in the field-level `annotate AdminService.TutorialFeedback with { }` block**

After the existing label for `tutorialSlug` (line ~2207), add:
```cds
  isIrrelevant     @Common.Label: 'Irrelevant';
  irrelevantReason @Common.Label: 'Reason';
```

- [ ] **Step 2: Add `isIrrelevant` to `UI.SelectionFields`**

Change `UI.SelectionFields: [tutorialSlug, wasAuthenticated, submittedAt]` to:
```cds
  UI.SelectionFields: [tutorialSlug, wasAuthenticated, submittedAt, isIrrelevant],
```

- [ ] **Step 3: Add flag columns and action buttons to `UI.LineItem`**

In the `UI.LineItem` array (line ~2228), add at the end before the closing `]`:
```cds
    { Value: isIrrelevant,     Label: 'Irrelevant' },
    { Value: irrelevantReason, Label: 'Reason' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.markFeedbackIrrelevant',   Label: 'Mark Irrelevant' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.unmarkFeedbackIrrelevant', Label: 'Unmark Irrelevant' }
```

- [ ] **Step 4: Add a `#FlagGroup` FieldGroup**

After `UI.FieldGroup #CommentGroup` (line ~2250), add:
```cds
  UI.FieldGroup #FlagGroup: { Data: [
    { Value: isIrrelevant },
    { Value: irrelevantReason }
  ]},
```

- [ ] **Step 5: Add a Facet for the Object Page**

In `UI.Facets`, add:
```cds
    { $Type: 'UI.ReferenceFacet', Label: 'Relevance Flag', Target: '@UI.FieldGroup#FlagGroup' }
```

- [ ] **Step 6: Run linter**

```bash
npx cds lint app/admin-annotations.cds
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(feedback): expose irrelevant flag in admin Fiori Elements UI (#2947)"
```

---

### Task 4: Exclude irrelevant rows from the feedback digest

**Files:**
- Modify: `srv/lib/feedback-digest.js` (`computeFeedbackDigests` function)
- Test: `test/lib/feedback-digest.test.js`

**Interfaces:**
- Consumes: `isIrrelevant` from Task 1.

- [ ] **Step 1: Write a failing test**

Add to the `computeFeedbackDigests` describe block in `test/lib/feedback-digest.test.js`:

```js
it('excludes irrelevant feedback rows from digest computation', async () => {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const until = new Date(Date.now() + 1000).toISOString();
  const { TutorialFeedback, TutorialMeta } = cds.entities('com.sap.developers.ims');
  await INSERT.into(TutorialMeta).entries([
    { tutorialSlug: 'digest-irr-test', ownerEmail: 'author@example.com' }
  ]);
  await INSERT.into(TutorialFeedback).entries([
    { tutorialSlug: 'digest-irr-test', comment: 'Great tutorial!', isIrrelevant: false },
    { tutorialSlug: 'digest-irr-test', comment: 'Ignore me',       isIrrelevant: true }
  ]);
  const digests = await computeFeedbackDigests({ since, until });
  const entry = digests.find(d => d.email === 'author@example.com');
  expect(entry?.items).toHaveLength(1);
  expect(entry?.items[0].comment).toBe('Great tutorial!');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --reporter=verbose --testPathPattern=feedback-digest`
Expected: FAIL — irrelevant row is included.

- [ ] **Step 3: Add filter in `srv/lib/feedback-digest.js`**

Locate the `SELECT.from(TutorialFeedback)` (or equivalent) in `computeFeedbackDigests`. Add a CQL condition `AND isIrrelevant IS NOT TRUE`. The exact form depends on whether the query uses `.where()` chaining or an inline filter — keep the same style as the rest of the function.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --reporter=verbose --testPathPattern=feedback-digest`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add srv/lib/feedback-digest.js test/lib/feedback-digest.test.js
git commit -m "feat(feedback): exclude irrelevant entries from owner digest emails (#2947)"
```

---

### Task 5: Add flag columns to the Tutorials Object Page embedded feedback panel

**Files:**
- Modify: `app/admin-annotations.cds:2273-2286` (`UI.LineItem #TutorialFeedback` block)

**Interfaces:**
- Consumes: `isIrrelevant`, `irrelevantReason` from Task 1; actions from Task 2.

- [ ] **Step 1: Add flag columns to `UI.LineItem #TutorialFeedback`**

In the `annotate AdminService.TutorialFeedback with @UI: { LineItem #TutorialFeedback: [ ... ] }` block, add at the end:
```cds
    { Value: isIrrelevant,     Label: 'Irrelevant' },
    { Value: irrelevantReason, Label: 'Reason' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.markFeedbackIrrelevant',   Label: 'Mark Irrelevant' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.unmarkFeedbackIrrelevant', Label: 'Unmark Irrelevant' }
```

- [ ] **Step 2: Run linter**

```bash
npx cds lint app/admin-annotations.cds
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(feedback): add flag columns to tutorial feedback embedded panel (#2947)"
```

---

### Task 6: Full suite pass and PR

- [ ] **Step 1: Run full unit test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Run CDS lint on all modified CDS files**

```bash
npx cds lint db/schema.cds db/views.cds srv/admin-service.cds app/admin-annotations.cds
```
Expected: no errors.

- [ ] **Step 3: Verify author-service and analytics-service tests still pass**

Run: `npm test -- --reporter=verbose --testPathPattern=author-service-feedback`
Expected: PASS (projections are read-only; no changes to their CDS definitions needed).

- [ ] **Step 4: Open PR targeting DEV**

```bash
gh pr create \
  --title "feat(feedback): mark entries as irrelevant/inappropriate (#2947)" \
  --base DEV \
  --body "$(cat <<'EOF'
Closes #2947

## What changed
- Added `isIrrelevant` (Boolean, default false) and `irrelevantReason` (String 500) to `TutorialFeedback`.
- Both aggregate views (`TutorialFeedbackAggregate`, `AuthorSurveyDistribution`) now filter flagged rows with `WHERE isIrrelevant IS NOT TRUE`.
- Admin-only actions `markFeedbackIrrelevant` / `unmarkFeedbackIrrelevant` on `AdminService`.
- Fiori Elements list, object page, and embedded tutorial panel updated with flag columns and action buttons.
- Feedback digest excludes flagged rows.

## Testing
- All unit tests pass.
- Aggregate views exclude flagged rows (new tests, Task 1).
- Mark/unmark actions return correct state; 404 for unknown IDs (new tests, Task 2).
- Digest excludes flagged rows (new test, Task 4).
EOF
)"
```
