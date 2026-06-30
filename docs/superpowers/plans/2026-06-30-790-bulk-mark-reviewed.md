# Bulk Mark-reviewed from ListReport — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-select "Mark selected as reviewed" action to the ListReport of all three homepage-explainer admin apps (Verb Definitions, Shelf Definitions, Homepage Shelves / Shelf Entries), so an admin can flip an arbitrary number of AI_SEEDED rows to REVIEWED in one click without drilling into each ObjectPage.

**Architecture:** Three new unbound `AdminService` actions (`bulkMarkVerbExplainerReviewed` / `bulkMarkShelfExplainerReviewed` / `bulkMarkShelfEntryExplainerReviewed`), each taking `ids: array of String` and sharing one server-side helper that filters out `BLANK` + `REVIEWED` rows server-side, then runs a single `UPDATE ... WHERE ID IN (...) AND authoringStatus = 'AI_SEEDED'`. UI side: each of the three Fiori Elements apps gains a `markReviewedSelected` LineItem action with `requiresSelection: true` (mirrors the existing `regenerateSelected` precedent on lines 74-80 of each manifest.json) and one new method `onMarkReviewedSelected` on its `ActionsController.js`.

**Tech Stack:** CAP Node.js (CDS service actions + raw SQL via `cds.connect.to('db')`), Fiori Elements V4 (`controlConfiguration[LineItem].actions`), Vitest (unit + hybrid).

**Issue:** [#790](https://github.com/sap-tutorials/tutorials-ims/issues/790)
**Parent spec:** [docs/superpowers/specs/2026-06-29-759-homepage-explainers-design.md](../specs/2026-06-29-759-homepage-explainers-design.md)
**Worktree branch:** `worktree-790-bulk-mark-reviewed`

---

## File map

| File | Action | Purpose |
|---|---|---|
| [srv/admin-service.cds](../../../srv/admin-service.cds) | Modify near line 598 (next to existing `generate*Explainers` block) | Declare 3 new unbound actions |
| [srv/admin-service.js](../../../srv/admin-service.js) | Modify near line 1722 (next to existing `runMarkReviewed` helper) | Add `runBulkMarkReviewed` helper + 3 `this.on(...)` wirings |
| [test/unit/srv/admin-service-explainer-actions.test.js](../../../test/unit/srv/admin-service-explainer-actions.test.js) | Modify (extend existing file) | Unit tests for the three bulk actions: filter behaviour, status transitions, no-op on empty array |
| [test/hybrid/homepage-shelves-new-fields.test.js](../../../test/hybrid/homepage-shelves-new-fields.test.js) | Modify (extend existing file) | One hybrid happy-path: insert 3 rows (BLANK / AI_SEEDED / REVIEWED), invoke `bulkMarkShelfEntryExplainerReviewed` with all 3 ids, verify only the AI_SEEDED row flips |
| [app/admin/verb-definitions/webapp/manifest.json](../../../app/admin/verb-definitions/webapp/manifest.json) | Modify around line 80 | Add `markReviewedSelected` LineItem action entry |
| [app/admin/verb-definitions/webapp/ext/ActionsController.js](../../../app/admin/verb-definitions/webapp/ext/ActionsController.js) | Modify (add new method to returned object) | Add `onMarkReviewedSelected` |
| [app/admin/shelf-definitions/webapp/manifest.json](../../../app/admin/shelf-definitions/webapp/manifest.json) | Modify | Same as verb-definitions |
| [app/admin/shelf-definitions/webapp/ext/ActionsController.js](../../../app/admin/shelf-definitions/webapp/ext/ActionsController.js) | Modify | Same as verb-definitions |
| [app/admin/homepage/webapp/manifest.json](../../../app/admin/homepage/webapp/manifest.json) | Modify around line 105 | Same as verb-definitions (uses `bulkMarkShelfEntryExplainerReviewed`) |
| [app/admin/homepage/webapp/ext/ActionsController.js](../../../app/admin/homepage/webapp/ext/ActionsController.js) | Modify | Same as verb-definitions |
| [docs/developers/architecture/homepage-explainers.md](../../developers/architecture/homepage-explainers.md) | Modify the "Admin actions" section | Document the three new bulk actions next to the existing `generate*Explainers` table |

**Out of scope (per issue):** no confirm dialog (flipping AI_SEEDED → REVIEWED is reversible by re-generating), no UI changes to existing bulk-regenerate or per-row mark-reviewed, no Hugo / island / build-feed changes (status flips don't change rendered HTML semantics beyond the existing data feed).

---

## Background: existing code shape

The plan mirrors a precedent already in this repo. Two existing patterns are reused:

**Pattern A — multi-select LineItem action with `requiresSelection: true`.** Live in [app/admin/verb-definitions/webapp/manifest.json:74-80](../../../app/admin/verb-definitions/webapp/manifest.json#L74-L80):

```json
"regenerateSelected": {
  "press": "sap.tutorials.admin.verbDefinitions.ext.ActionsController.onRegenerateSelected",
  "visible": true,
  "enabled": true,
  "text": "Regenerate selected with AI",
  "requiresSelection": true
}
```

The handler in [ActionsController.js:88-118](../../../app/admin/verb-definitions/webapp/ext/ActionsController.js#L88-L118) reads `selectedContexts` from `oEvent`, extracts `.ID` from each, and posts to `/admin/generateVerbExplainers`. Bulk Mark-reviewed copies this shape exactly — only difference: no confirm dialog, no cost line in the toast.

**Pattern B — server-side helper called from `this.on(actionName, req)`.** Live in [srv/admin-service.js:1722-1738](../../../srv/admin-service.js#L1722-L1738):

```js
async function runMarkReviewed({ entityName, id, req }) {
  const db = await cds.connect.to('db');
  const row = await db.run(SELECT.one.from(entityName).where({ ID: id }));
  if (!row) { req.reject(404, `not found: ${id}`); return; }
  await db.run(UPDATE(entityName).set({ authoringStatus: 'REVIEWED' }).where({ ID: id }));
  return { processed: 1, skipped: 0, cost: '$0.00' };
}
this.on('markVerbExplainerReviewed', (req) =>
  runMarkReviewed({ entityName: 'com.sap.developers.ims.VerbDefinitions', id: req.data.id, req }));
```

The bulk variant generalises this — `ids: array of String` → one SELECT with `WHERE ID IN (...)` to learn current statuses → one UPDATE with `WHERE ID IN (...) AND authoringStatus = 'AI_SEEDED'`. The existing single-id `markVerbExplainerReviewed` actions (used by the OP "Mark as reviewed" button via ActionsController) stay untouched — refactoring them to accept array would break the OP call site, and the per-row case has no skip semantics anyway. Keeping single + bulk as separate actions matches what the issue body asked for.

**Status filter on the server, not the client.** The issue specifies that BLANK and REVIEWED rows are skipped. Implementing this filter in the SQL `WHERE` clause (not in JS after fetching) costs zero round-trips and means a malicious / stale-client call that passes any ID set will only mutate the AI_SEEDED subset.

---

## Tasks

### Task 1: Add the CDS action declarations

**Files:**
- Modify: [srv/admin-service.cds](../../../srv/admin-service.cds) around line 598 (next to the existing `generateVerbExplainers` / `generateShelfExplainers` / `generateShelfEntryExplainers` block)

**Why this comes first:** Server-side TDD. The unit tests in Task 3 can't run until the action surface compiles, so declare it before the handler. Also lets `cds compile` catch any typo in the type or action name immediately.

- [ ] **Step 1: Read the surrounding CDS context to confirm placement**

Open [srv/admin-service.cds](../../../srv/admin-service.cds) and find the existing comment block that precedes the three `generate*Explainers` actions (around line 590). Confirm the existing `markVerbExplainerReviewed` / `markShelfExplainerReviewed` / `markShelfEntryExplainerReviewed` actions are also nearby (they share the same comment).

- [ ] **Step 2: Add the three bulk actions immediately after the existing single-id Mark-reviewed declarations**

Add this CDS exactly:

```cds
  // (#790) Bulk Mark-reviewed actions — flip every AI_SEEDED row in `ids`
  // to REVIEWED in one round-trip. BLANK and REVIEWED rows are filtered
  // out server-side (see srv/admin-service.js:runBulkMarkReviewed). No
  // confirm dialog on the UI side because the flip is reversible by
  // re-generating. Used by the multi-select LineItem action in
  // app/admin/{verb,shelf,homepage}/webapp/manifest.json.
  action bulkMarkVerbExplainerReviewed(ids       : array of String) returns ExplainerActionResult;
  action bulkMarkShelfExplainerReviewed(ids      : array of String) returns ExplainerActionResult;
  action bulkMarkShelfEntryExplainerReviewed(ids : array of String) returns ExplainerActionResult;
```

(`ExplainerActionResult` is the existing return-type alias used by `generate*Explainers`; reusing it keeps the wire shape identical: `{ processed, skipped, cost }`. If you discover the existing actions use an inline-typed return instead, match whichever form is already used in this file — consistency wins.)

- [ ] **Step 3: Compile the CDS to verify syntax**

```bash
npx cds compile srv/admin-service.cds --to json > /dev/null
```

Expected: exit 0, no output. If you see a `ExplainerActionResult` not found error, fall back to the inline return shape:

```cds
  action bulkMarkVerbExplainerReviewed(ids : array of String)
    returns { processed : Integer; skipped : Integer; cost : String };
```

- [ ] **Step 4: Run `cds build --production` so `db/last-dev/` reflects the new action**

```bash
npx cds build --production
```

Expected: build succeeds (no schema change so no `db/last-dev/` diff, but the staging guard in CI runs this and will fail if `db/src/` is stale — see [feedback_cds_build_staging_fires_on_any_service_change.md](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_cds_build_staging_fires_on_any_service_change.md)).

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds
git commit -m "feat(#790): declare three bulk Mark-reviewed actions on AdminService"
```

---

### Task 2: Write the failing unit test for the shared server helper

**Files:**
- Modify: [test/unit/srv/admin-service-explainer-actions.test.js](../../../test/unit/srv/admin-service-explainer-actions.test.js) — append a new `describe` block

**Why this comes before the implementation:** TDD per [test-driven-development skill]. We want red → green → refactor. The test asserts the filter semantics, return shape, and empty-array behaviour all at once so the implementation can't paper over edge cases.

- [ ] **Step 1: Read the existing test file to learn the harness conventions**

Open the file and look at the existing `describe('AdminService.generate*Explainers — action handlers (#759 PR 3a)')` block starting at line 38. Note these specific patterns (the appended block below uses them verbatim):

- `const project = cds.test('serve', '--project', '.', '--in-memory');` (line 39) — declared at describe scope, shared across all `it`s
- `const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };` (line 36) — module-scope constant, **already in scope** for any new describe appended to the file
- Service calls go through `project.post('/admin/<action>', payload, ADMIN_AUTH)`, return `{ status, data, ... }`. Assertions read `res.data.processed`, not `res.processed`.
- `db` is acquired locally inside each `it` via `const db = await cds.connect.to('db');` — there is no test-scope `db`.
- The existing `beforeEach` (line 51) wipes Verb / Shelf / Shelf-entry tables, then triggers Verb / Shelf auto-init via `project.get('/admin/VerbDefinitions', ADMIN_AUTH)` and `/admin/ShelfDefinitions` so the 6+4 seed rows are present. The new describe must do the same wipe so its inserts don't collide with auto-init.

- [ ] **Step 2: Append a new `describe` block at the bottom of the file**

```js
describe('AdminService — bulk Mark-reviewed actions (issue #790)', () => {
  const project = cds.test('serve', '--project', '.', '--in-memory');

  beforeAll(async () => { await project; });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    // Wipe before each test so our explicit fixture is the only state.
    await db.run(DELETE.from('com.sap.developers.ims.VerbDefinitions'));
    await db.run(DELETE.from('com.sap.developers.ims.ShelfDefinitions'));
    await db.run(DELETE.from('com.sap.developers.ims.HomepageShelves'));
    // Seed three VerbDefinitions rows: one BLANK, one AI_SEEDED, one REVIEWED.
    await db.run(INSERT.into('com.sap.developers.ims.VerbDefinitions').entries([
      { ID: '11111111-1111-1111-1111-111111111111', verbKey: 'LEARN',     label: 'L', authoringStatus: 'BLANK'     },
      { ID: '22222222-2222-2222-2222-222222222222', verbKey: 'BUILD',     label: 'B', authoringStatus: 'AI_SEEDED' },
      { ID: '33333333-3333-3333-3333-333333333333', verbKey: 'INTEGRATE', label: 'I', authoringStatus: 'REVIEWED'  },
    ]));
  });

  it('flips only AI_SEEDED rows to REVIEWED, skipping BLANK and REVIEWED', async () => {
    const db = await cds.connect.to('db');
    const res = await project.post('/admin/bulkMarkVerbExplainerReviewed', {
      ids: [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
      ],
    }, ADMIN_AUTH);
    expect(res.status).toBe(200);
    expect(res.data.processed).toBe(1);
    expect(res.data.skipped).toBe(2);
    expect(res.data.cost).toBe('$0.00');

    const rows = await db.run(SELECT.from('com.sap.developers.ims.VerbDefinitions').orderBy('verbKey'));
    const status = Object.fromEntries(rows.map(r => [r.verbKey, r.authoringStatus]));
    expect(status).toEqual({ BUILD: 'REVIEWED', INTEGRATE: 'REVIEWED', LEARN: 'BLANK' });
  });

  it('returns processed=0 when ids array is empty', async () => {
    const res = await project.post('/admin/bulkMarkVerbExplainerReviewed', { ids: [] }, ADMIN_AUTH);
    expect(res.data.processed).toBe(0);
    expect(res.data.skipped).toBe(0);
  });

  it('counts unknown UUIDs as skipped (rows not found in DB)', async () => {
    // Deliberate semantics: ids.length - aiSeededIds.length bucket includes both
    // BLANK/REVIEWED known rows AND rows that weren't returned by the SELECT
    // (i.e. unknown IDs). Callers see one "skipped" count for everything that
    // wasn't flipped, which matches the issue's toast wording ("M skipped").
    const res = await project.post('/admin/bulkMarkVerbExplainerReviewed', {
      ids: ['ffffffff-ffff-ffff-ffff-ffffffffffff'],
    }, ADMIN_AUTH);
    expect(res.data.processed).toBe(0);
    expect(res.data.skipped).toBe(1);
  });

  it('routes to ShelfDefinitions for bulkMarkShelfExplainerReviewed', async () => {
    const db = await cds.connect.to('db');
    await db.run(INSERT.into('com.sap.developers.ims.ShelfDefinitions').entries([
      { ID: '44444444-4444-4444-4444-444444444444', shelfKey: 'START_HERE', label: 'S', authoringStatus: 'AI_SEEDED' },
    ]));
    const res = await project.post('/admin/bulkMarkShelfExplainerReviewed', {
      ids: ['44444444-4444-4444-4444-444444444444'],
    }, ADMIN_AUTH);
    expect(res.data.processed).toBe(1);
  });

  it('routes to HomepageShelves for bulkMarkShelfEntryExplainerReviewed', async () => {
    // Mandatory fields: verb, shelf, title, url. Mirror the fixture shape used
    // by test/hybrid/homepage-shelves-new-fields.test.js (e.g. line 27).
    const db = await cds.connect.to('db');
    const ID = '55555555-5555-5555-5555-555555555555';
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries([
      { ID, verb: 'LEARN', shelf: 'START_HERE',
        title: 'Bulk-790 unit', url: 'https://example.com/790-unit',
        sortOrder: 1, authoringStatus: 'AI_SEEDED' },
    ]));
    const res = await project.post('/admin/bulkMarkShelfEntryExplainerReviewed', { ids: [ID] }, ADMIN_AUTH);
    expect(res.data.processed).toBe(1);
  });
});
```

This block sits at the bottom of the file. `ADMIN_AUTH` is already module-scope from line 36, so don't redeclare it. The `cds.test('serve', ...)` line is per-describe (matches the existing #759 describe's pattern at line 39) — `cds.test` is idempotent and reuses the running instance across describes.

- [ ] **Step 3: Run the test and confirm it fails**

```bash
npm test -- test/unit/srv/admin-service-explainer-actions.test.js
```

Expected: failures along the lines of `action 'bulkMarkVerbExplainerReviewed' not found`. If you see different errors (e.g. ID format rejection), fix the test fixture before moving on — the failure must be "action not implemented yet" so Task 3 can clearly green it.

- [ ] **Step 4: Commit the failing test**

```bash
git add test/unit/srv/admin-service-explainer-actions.test.js
git commit -m "test(#790): failing unit tests for bulk Mark-reviewed actions"
```

---

### Task 3: Implement `runBulkMarkReviewed` and wire the three handlers

**Files:**
- Modify: [srv/admin-service.js](../../../srv/admin-service.js) near line 1722 (right after `runMarkReviewed`)

- [ ] **Step 1: Add the helper function**

Place this function definition immediately after the existing `runMarkReviewed` function (around line 1731). It uses the same `cds.connect.to('db')` pattern, same direct SQL bypass of `@Common.FieldControl: #ReadOnly`, and the same return shape:

```js
    // (#790) Bulk Mark-reviewed — flip every AI_SEEDED row in `ids` to
    // REVIEWED in one round-trip. BLANK rows are skipped (no content to
    // review yet); REVIEWED rows are skipped (no-op); IDs not present in
    // the DB are also counted as skipped (the SELECT silently drops them,
    // so `ids.length - aiSeededIds.length` rolls them into one bucket
    // with BLANK + REVIEWED). Callers see a single "skipped" total that
    // matches the issue's toast wording. Same authoringStatus FieldControl
    // bypass as runMarkReviewed.
    async function runBulkMarkReviewed({ entityName, ids }) {
      if (!Array.isArray(ids) || ids.length === 0) {
        return { processed: 0, skipped: 0, cost: '$0.00' };
      }
      const db = await cds.connect.to('db');
      // SELECT current statuses to compute processed vs skipped accurately.
      // A blind UPDATE would only return affectedRows (driver-dependent on
      // HANA via @sap/hana-client) and we'd lose the BLANK/REVIEWED breakdown.
      const rows = await db.run(
        SELECT.from(entityName).columns('ID', 'authoringStatus').where({ ID: { in: ids } })
      );
      const aiSeededIds = rows.filter(r => r.authoringStatus === 'AI_SEEDED').map(r => r.ID);
      if (aiSeededIds.length === 0) {
        return { processed: 0, skipped: ids.length, cost: '$0.00' };
      }
      await db.run(
        UPDATE(entityName).set({ authoringStatus: 'REVIEWED' }).where({ ID: { in: aiSeededIds } })
      );
      return {
        processed: aiSeededIds.length,
        skipped: ids.length - aiSeededIds.length,
        cost: '$0.00',
      };
    }
```

- [ ] **Step 2: Wire the three action handlers**

Add these `this.on(...)` calls immediately after the existing `markShelfEntryExplainerReviewed` wiring (around line 1738), before the bound-action block that starts with `// (#759 hotfix) Bound versions of...`:

```js
    this.on('bulkMarkVerbExplainerReviewed', (req) =>
      runBulkMarkReviewed({ entityName: 'com.sap.developers.ims.VerbDefinitions', ids: req.data.ids }));
    this.on('bulkMarkShelfExplainerReviewed', (req) =>
      runBulkMarkReviewed({ entityName: 'com.sap.developers.ims.ShelfDefinitions', ids: req.data.ids }));
    this.on('bulkMarkShelfEntryExplainerReviewed', (req) =>
      runBulkMarkReviewed({ entityName: 'com.sap.developers.ims.HomepageShelves', ids: req.data.ids }));
```

Note: the helper signature does **not** take a `req` because we never `req.reject` — unknown IDs are accounted for as `skipped`, not errors. This matches the issue's spec: "Skip rows already in REVIEWED status; surface a toast like 'Marked N reviewed (M already reviewed, skipped)'."

- [ ] **Step 3: Run the unit test from Task 2 and confirm it passes**

```bash
npm test -- test/unit/srv/admin-service-explainer-actions.test.js
```

Expected: the new describe block now passes (5 tests green). All previously-green tests in this file remain green.

- [ ] **Step 4: Run the full unit suite to make sure no regressions**

```bash
npm test
```

Expected: same pass count as before plus 5. If something else breaks, almost certainly because the helper placement conflicts with an existing line — re-read [srv/admin-service.js:1722](../../../srv/admin-service.js#L1722) and confirm placement.

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.js
git commit -m "feat(#790): runBulkMarkReviewed helper + three action handlers"
```

---

### Task 4: Add the hybrid test against real HANA

**Files:**

- Modify: [test/hybrid/homepage-shelves-new-fields.test.js](../../../test/hybrid/homepage-shelves-new-fields.test.js) — append one new `it` block to the existing describe

**Why hybrid:** Per [feedback_skip_hybrid_test_costs_two_pr_cycles.md](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_skip_hybrid_test_costs_two_pr_cycles.md) — any DB-touching action that goes to production HANA needs at least one hybrid happy-path. Our helper uses `WHERE ID IN (...)` and direct UPDATE; HANA's behaviour on a NOT-IN-status filter has bitten us before with empty result sets. One hybrid call de-risks PROD cutover.

- [ ] **Step 1: Read the existing test file**

Open [test/hybrid/homepage-shelves-new-fields.test.js](../../../test/hybrid/homepage-shelves-new-fields.test.js). Confirm these specific shapes (the appended test below uses them verbatim):

- The file imports `isSafeForWrites` from `./_guard.js` and wraps the suite with `describe.runIf(isSafeForWrites())` (line 7) — this is the `ALLOW_HYBRID_WRITES` gate.
- `let db; beforeAll(async () => { db = await cds.connect.to('db'); });` (line 9) — `db` is suite-scope, already available.
- `const TEST_TITLE_PREFIX = '__TEST__759_';` (line 5) and the existing `afterEach` (line 11) cleans up everything where `title LIKE '__TEST__759_%'`. **The new test rows must use this same prefix** so the existing cleanup picks them up — do not introduce a `__TEST__790_` prefix that would leak rows on the DEV space.
- The file has **no HTTP client and no `cds.test('serve')` bootstrap** — every existing test goes through `db.run(...)` directly. We follow the same pattern: invoke the action through a service connection rather than an HTTP POST.

- [ ] **Step 2: Append a new test inside the existing describe**

```js
  it('(#790) bulkMarkShelfEntryExplainerReviewed flips only AI_SEEDED rows', async () => {
    // Action invocation: via cds.connect.to('AdminService').send(...). This file
    // has no HTTP client by design — every test uses db.run directly — so we
    // call the action on the bound service instance instead of bootstrapping
    // cds.test('serve').
    const adminSrv = await cds.connect.to('AdminService');

    // Three rows, distinct statuses. Reuse the existing __TEST__759_ prefix so
    // the existing afterEach (line 11) cleans up. Mandatory fields match the
    // other inserts in this file (verb / shelf / title / url).
    const { randomUUID } = await import('node:crypto');
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries([
      { ID: ids[0], verb: 'LEARN', shelf: 'START_HERE',
        title: TEST_TITLE_PREFIX + 'bulk790-blank',
        url: 'https://example.com/790-hybrid-1',
        sortOrder: 9001, authoringStatus: 'BLANK'     },
      { ID: ids[1], verb: 'LEARN', shelf: 'START_HERE',
        title: TEST_TITLE_PREFIX + 'bulk790-aiseed',
        url: 'https://example.com/790-hybrid-2',
        sortOrder: 9002, authoringStatus: 'AI_SEEDED' },
      { ID: ids[2], verb: 'LEARN', shelf: 'START_HERE',
        title: TEST_TITLE_PREFIX + 'bulk790-reviewed',
        url: 'https://example.com/790-hybrid-3',
        sortOrder: 9003, authoringStatus: 'REVIEWED'  },
    ]));

    const result = await adminSrv.send('bulkMarkShelfEntryExplainerReviewed', { ids });
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(2);

    const rows = await db.run(
      SELECT.from('com.sap.developers.ims.HomepageShelves')
        .columns('ID', 'authoringStatus')
        .where({ ID: { in: ids } })
    );
    const byId = Object.fromEntries(rows.map(r => [r.ID, r.authoringStatus]));
    expect(byId[ids[0]]).toBe('BLANK');
    expect(byId[ids[1]]).toBe('REVIEWED');
    expect(byId[ids[2]]).toBe('REVIEWED');
  });
```

- [ ] **Step 3: Run the hybrid test**

```bash
cf target -s dev   # confirm DEV space — never run hybrid against PROD per the memory
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- test/hybrid/homepage-shelves-new-fields.test.js
```

Expected: PASS. Per [memory: Worktree Tests Hang], hard-timeout the run at 5 min if it stalls.

- [ ] **Step 4: Commit**

```bash
git add test/hybrid/homepage-shelves-new-fields.test.js
git commit -m "test(#790): hybrid happy-path for bulkMarkShelfEntryExplainerReviewed"
```

---

### Task 5: Wire the LineItem action in `verb-definitions` manifest

**Files:**

- Modify: [app/admin/verb-definitions/webapp/manifest.json](../../../app/admin/verb-definitions/webapp/manifest.json) around line 80

- [ ] **Step 1: Add the new `markReviewedSelected` entry inside `actions`**

Place it immediately after the existing `regenerateSelected` action (which ends at line 80 with the closing `}` of that block). The new block keeps the same shape — only `text`, `press`, and the absence of a confirm dialog distinguish it:

```json
                    "markReviewedSelected": {
                      "press": "sap.tutorials.admin.verbDefinitions.ext.ActionsController.onMarkReviewedSelected",
                      "visible": true,
                      "enabled": true,
                      "text": "Mark selected as reviewed",
                      "requiresSelection": true
                    }
```

Remember to add the trailing comma to the preceding `regenerateSelected` block.

- [ ] **Step 2: Validate JSON syntax**

```bash
node -e "JSON.parse(require('fs').readFileSync('app/admin/verb-definitions/webapp/manifest.json'))"
```

Expected: exit 0, no output. Any error → fix the comma placement.

- [ ] **Step 3: Commit**

```bash
git add app/admin/verb-definitions/webapp/manifest.json
git commit -m "feat(#790): Mark-reviewed-selected LineItem action in verb-definitions manifest"
```

---

### Task 6: Add `onMarkReviewedSelected` to the verb-definitions ActionsController

**Files:**

- Modify: [app/admin/verb-definitions/webapp/ext/ActionsController.js](../../../app/admin/verb-definitions/webapp/ext/ActionsController.js) — add a new method to the returned object

- [ ] **Step 1: Add the new method**

Add this method to the returned object, immediately after `onRegenerateSelected` and before `onRegenerateOne`. The pattern mirrors `onRegenerateSelected` but is simpler — no confirm dialog, no cost line:

```js
    onMarkReviewedSelected: async function (oEvent) {
      const selectedContexts = oEvent.getParameter?.("selectedContexts") ?? [];
      const ids = selectedContexts.map(c => c.getObject().ID);
      if (ids.length === 0) {
        MessageToast.show("Select one or more rows first.");
        return;
      }
      try {
        const result = await postAdminAction("bulkMarkVerbExplainerReviewed", { ids });
        const msg = result.skipped > 0
          ? `Marked ${result.processed} reviewed (${result.skipped} skipped — already reviewed or still blank).`
          : `Marked ${result.processed} reviewed.`;
        MessageToast.show(msg);
        await refreshContext(oEvent);
      } catch (e) {
        MessageBox.error(`Mark-reviewed failed: ${e.message}`);
      }
    },
```

- [ ] **Step 2: Verify the file still parses as JavaScript**

```bash
node --check app/admin/verb-definitions/webapp/ext/ActionsController.js
```

Expected: exit 0. (UI5 `sap.ui.define(...)` is plain JS at the parser level.)

- [ ] **Step 3: Commit**

```bash
git add app/admin/verb-definitions/webapp/ext/ActionsController.js
git commit -m "feat(#790): onMarkReviewedSelected handler in verb-definitions controller"
```

---

### Task 7: Mirror Tasks 5 + 6 in `shelf-definitions`

**Files:**

- Modify: [app/admin/shelf-definitions/webapp/manifest.json](../../../app/admin/shelf-definitions/webapp/manifest.json)
- Modify: [app/admin/shelf-definitions/webapp/ext/ActionsController.js](../../../app/admin/shelf-definitions/webapp/ext/ActionsController.js)

Same shape as Tasks 5 + 6 with three substitutions:

- App namespace: `sap.tutorials.admin.shelfDefinitions` (lowercase-camel — check the existing `regenerateSelected.press` value at line 75 to confirm)
- Action endpoint: `bulkMarkShelfExplainerReviewed`
- Controller method name: still `onMarkReviewedSelected`

- [ ] **Step 1: Add `markReviewedSelected` to manifest.json** (same JSON block as Task 5 with the namespace fix)

- [ ] **Step 2: Validate manifest JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('app/admin/shelf-definitions/webapp/manifest.json'))"
```

- [ ] **Step 3: Add `onMarkReviewedSelected` to ActionsController.js** (same body as Task 6 but call `bulkMarkShelfExplainerReviewed`)

- [ ] **Step 4: `node --check`**

```bash
node --check app/admin/shelf-definitions/webapp/ext/ActionsController.js
```

- [ ] **Step 5: Commit**

```bash
git add app/admin/shelf-definitions/webapp/manifest.json app/admin/shelf-definitions/webapp/ext/ActionsController.js
git commit -m "feat(#790): Mark-reviewed-selected wiring in shelf-definitions admin app"
```

---

### Task 8: Mirror Tasks 5 + 6 in `homepage`

**Files:**

- Modify: [app/admin/homepage/webapp/manifest.json](../../../app/admin/homepage/webapp/manifest.json) around line 105
- Modify: [app/admin/homepage/webapp/ext/ActionsController.js](../../../app/admin/homepage/webapp/ext/ActionsController.js)

This is the high-value case — 60+ rows. Same shape with:

- App namespace: confirm by reading the existing `regenerateSelected.press` value (likely `sap.tutorials.admin.homepage` or similar)
- Action endpoint: `bulkMarkShelfEntryExplainerReviewed`

The `homepage` app's manifest may bind the LineItem to the `HomepageShelves` entity (the "Shelf Entries (Links)" tile that #790 references) rather than at the page root — confirm placement matches where `regenerateSelected` lives.

- [ ] **Step 1: Add `markReviewedSelected` to manifest.json**

- [ ] **Step 2: Validate manifest JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('app/admin/homepage/webapp/manifest.json'))"
```

- [ ] **Step 3: Add `onMarkReviewedSelected` to ActionsController.js (calling `bulkMarkShelfEntryExplainerReviewed`)**

- [ ] **Step 4: `node --check`**

```bash
node --check app/admin/homepage/webapp/ext/ActionsController.js
```

- [ ] **Step 5: Commit**

```bash
git add app/admin/homepage/webapp/manifest.json app/admin/homepage/webapp/ext/ActionsController.js
git commit -m "feat(#790): Mark-reviewed-selected wiring in homepage admin app (high-value case)"
```

---

### Task 9: Update the architecture doc

**Files:**

- Modify: [docs/developers/architecture/homepage-explainers.md](../../developers/architecture/homepage-explainers.md) — add three rows to the "Admin actions" table (or section equivalent)

- [ ] **Step 1: Read the existing Admin actions section**

Find the section that documents `generateVerbExplainers` / `generateShelfExplainers` / `generateShelfEntryExplainers` and the existing single-id mark-reviewed actions. Add a brief subsection or extend the table.

- [ ] **Step 2: Add the bulk actions**

Append (or insert in matching format):

```markdown
### Bulk Mark-reviewed actions (#790)

For clearing a backlog of `AI_SEEDED` rows after a bulk regeneration, the ListReport of all three explainer apps exposes a **Mark selected as reviewed** multi-select action. It calls one of three unbound `AdminService` actions:

| Action | Entity |
|---|---|
| `bulkMarkVerbExplainerReviewed`       | `VerbDefinitions`  |
| `bulkMarkShelfExplainerReviewed`      | `ShelfDefinitions` |
| `bulkMarkShelfEntryExplainerReviewed` | `HomepageShelves`  |

Each accepts `{ ids: string[] }` and returns `{ processed, skipped, cost: "$0.00" }`. Server-side filter skips `BLANK` (no content to review yet) and `REVIEWED` (no-op) rows. No confirm dialog — the flip is reversible via per-row Regenerate.
```

- [ ] **Step 3: Verify the predocs:build sidebar guard still passes**

```bash
npm run predocs:build
```

Expected: PASS (no sidebar changes needed because the page already exists).

- [ ] **Step 4: Commit**

```bash
git add docs/developers/architecture/homepage-explainers.md
git commit -m "docs(#790): document bulk Mark-reviewed actions"
```

---

### Task 10: End-to-end verification with the admin shell

**Files:** none — manual verification

- [ ] **Step 1: Boot the local hybrid dev environment**

```bash
npm run dev:hybrid
```

Wait for `cds serve` and the approuter on port 5000 to both come up. Per [memory: Local Hybrid Dev Setup].

- [ ] **Step 2: Open the admin shell**

Navigate to <http://localhost:5000/admin-ui/#verb-definitions-display>. Log in if prompted.

- [ ] **Step 3: Set up a test state**

In the list, find at least one row in `BLANK`, one in `AI_SEEDED`, and one in `REVIEWED`. If none of these mixed states exist, use the existing "Regenerate selected with AI" to push a row to `AI_SEEDED`, or manually toggle via the OP "Mark as reviewed".

- [ ] **Step 4: Exercise the new action**

- Select one row of each status (or any mix).
- Confirm the **Mark selected as reviewed** button is enabled (it should not be enabled when zero rows are selected — that's the `requiresSelection: true` contract).
- Click it.
- Verify the toast reads `Marked 1 reviewed (2 skipped — already reviewed or still blank).` (numbers depending on your selection).
- Verify the list re-binds (`window.location.reload()` in `refreshContext`) and the AI_SEEDED row is now REVIEWED.

- [ ] **Step 5: Repeat for `shelf-definitions-display` and `homepage-display` (Shelf Entries tile)**

The 60-row homepage tile is the value case — confirm selecting all 60 and clicking the button completes in < 2 s (single-UPDATE round trip).

- [ ] **Step 6: Optional — test the toast wording when all selected rows are skipped**

Select only REVIEWED rows. Confirm the toast still surfaces (`Marked 0 reviewed (N skipped...)`) rather than reading "Mark-reviewed failed" — the action returns 2xx with `processed: 0`, not an error.

- [ ] **Step 7: Note any issues, fix in the relevant Task's file, and re-test**

---

### Task 11: Open the PR

- [ ] **Step 1: Confirm branch + commit log**

```bash
git branch --show-current   # → worktree-790-bulk-mark-reviewed
git log --oneline main..HEAD
```

Expected: 8-10 commits matching the task headings above.

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(#790): bulk Mark-reviewed action on ListReport for homepage explainers" \
  --body "Closes #790.

Adds a multi-select \"Mark selected as reviewed\" action to the ListReport of all three homepage-explainer admin apps (Verb Definitions, Shelf Definitions, Homepage Shelves). Server-side filters out BLANK and REVIEWED rows; no confirm dialog because the flip is reversible by re-generating.

**Implementation:**

- 3 new unbound \`AdminService\` actions sharing one \`runBulkMarkReviewed\` helper (single SELECT + single UPDATE WHERE ID IN)
- 3 new \`markReviewedSelected\` LineItem actions in the manifests with \`requiresSelection: true\`
- 3 new \`onMarkReviewedSelected\` methods on the ActionsControllers

**Tests:**

- Unit: 5 new tests covering filter behaviour, empty array, unknown IDs, routing per entity
- Hybrid: 1 new test against real HANA for the high-value HomepageShelves case (\`ALLOW_HYBRID_WRITES=true\`)
- Manual: verified end-to-end in local hybrid mode for all 3 apps

**Out of scope** (per issue): no confirm dialog, no UI changes to existing bulk-regenerate or per-row mark-reviewed, no Hugo / island / build-feed changes.

**Design notes:** server-side status filter (vs client-side filter then UPDATE) — zero extra round-trips and means a stale client cannot mutate the BLANK/REVIEWED partition. Existing single-id \`markVerbExplainerReviewed\` etc. actions stay untouched — the OP button uses them and refactoring to array would break that call site for no gain."
```

Tag the PR with whatever labels match the repo convention.

- [ ] **Step 3: Wait for CI to pass, then request review**

CI runs `cds build --production` staging check, unit + hybrid suites, and smoke tests post-deploy. The staging-guard hook ([memory: check-cds-build-staging fires on ANY srv/ change]) is the most likely failure source — if it fires, `npx cds build --production` and commit `db/last-dev/` updates.

---

## Risks and notes

- **Concurrent OData PATCH on `authoringStatus`** — already blocked by `@Common.FieldControl: #ReadOnly` (see comment at [srv/admin-service.js:1716-1721](../../../srv/admin-service.js#L1716)). Our bulk action bypasses via direct SQL, identical to the existing single-id helper. No new attack surface.

- **HANA UPDATE with `WHERE ID IN (long list)`** — the `homepage-display` worst case is ~60 IDs in one statement. HANA's parameter limit is much higher (32K positional params); not a concern. If a future use case pushes past several thousand IDs, the helper would need to chunk — note it but don't preemptively add the code (YAGNI).

- **`window.location.reload()` in `refreshContext`** — heavy-handed but reliable; matches existing `regenerateSelected` flow. A future polish could move to `extensionAPI.refresh()` across all four buttons together — not in scope here.

- **Catalog-only rebuild dispatch** — `authoringStatus` changes do NOT propagate to visitors via the `/build/*-definitions` data feeds because those endpoints return the status field but the Hugo templates ignore it for rendering. No rebuild needed. ([srv/lib/_classify-rebuild-mode.js](../../../srv/lib/_classify-rebuild-mode.js) classifies any write on these entities as `catalog-only`, so even if a rebuild does fire it's the cheapest mode at ~5 min.)

- **Bound vs unbound** — the existing OP button uses both an unbound action (via `ActionsController.postAdminAction`) AND a bound `markReviewed()` (via the FE V4 DataFieldForAction registered in CDS). For bulk, only the unbound form is needed — Fiori Elements V4's `requiresSelection: true` only supports unbound actions on the ListReport (a bound action requires a single context). Don't add a bound bulk variant.

## References

- Issue: [#790](https://github.com/sap-tutorials/tutorials-ims/issues/790)
- Parent spec: [docs/superpowers/specs/2026-06-29-759-homepage-explainers-design.md](../specs/2026-06-29-759-homepage-explainers-design.md)
- Precedent: existing `regenerateSelected` LineItem action in all three admin apps
- Memory pointers:
  - [feedback_skip_hybrid_test_costs_two_pr_cycles.md](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_skip_hybrid_test_costs_two_pr_cycles.md) — why Task 4 is non-skippable
  - [feedback_cds_build_staging_fires_on_any_service_change.md](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_cds_build_staging_fires_on_any_service_change.md) — why Task 1 runs `cds build`
  - [feedback_pr_over_direct_merge.md](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_pr_over_direct_merge.md) — why Task 11 opens a PR
