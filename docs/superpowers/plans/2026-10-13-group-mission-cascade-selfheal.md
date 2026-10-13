# Group/Mission Completion Cascade + Self-Heal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Group/Mission completion self-healing — stop downgrading completed parents, stop counting retired tutorials as required slots, and reconcile stored records when completion paths change.

**Architecture:** Keep the stored GROUP/MISSION `TaskRecords` and the existing event-driven forward rollup (`srv/lib/completion-rollup.js`). Harden `upsertRollupRecord` (no-downgrade) and the slot loaders (INACTIVE filter + empty-slot guard), add a new `srv/lib/completion-reconcile.js` (targeted + full reconcile), wire a targeted reconcile on admin path-item SAVE and a nightly `reconcile-completions` job, and expose an on-demand admin health endpoint.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds` ≥ 10.1.0), CDS QL / `cds.ql`, in-memory SQLite for unit tests via `cds.test`, ESM modules.

**Spec:** `docs/superpowers/specs/2026-10-13-group-mission-cascade-selfheal-design.md`

## Global Constraints

- **No schema migration** — reuse existing entities/enums (`TaskRecords`, `TaskStatus{ACTIVE,INACTIVE}`). `npx cds deploy --to sqlite::memory:` must stay clean.
- **Never throw into a caller/SAVE transaction** — all rollup/reconcile entry points wrapped in `try/catch` → `cds.log('rollup').error(...)` + `metrics.counter('rollup.failures')`. Fail-open everywhere.
- **No raw SQL** — use `cds.ql` / CQL only.
- **Namespace:** `com.sap.developers.ims` (constant `NS` in each module).
- **HANA `.in()` packet cap** — chunk any `.in()` over user/entity sets by `IN_CHUNK = 500` (reuse the existing `chunkedIn` helper).
- **Tutorials status semantics:** `status === 'INACTIVE'` = retired/excluded; `NULL` and `'ACTIVE'` = kept.
- **Stored records stay the source of truth** — do NOT change `/build/my-progress` or `NavigatorCatalog`.
- **Branch base:** `origin/DEV` (feature PRs target DEV, not main).
- **Commit style:** conventional commits, scope `(#2732)`.

---

### Task 1: No-downgrade short-circuit in `upsertRollupRecord`

**Files:**
- Modify: `srv/lib/completion-rollup.js` (`upsertRollupRecord` ~:203-235; `rollUpParentsForCompletion` signature ~:242 + its two `upsertRollupRecord` calls ~:299, ~:309)
- Test: `test/lib/completion-rollup-nodowngrade.test.js` (new)

**Interfaces:**
- Consumes: existing `upsertRollupRecord({ dbUser, taskType, legacyId, title, progress, status, completionDate, db, send })`.
- Produces: `upsertRollupRecord({ ..., allowDowngrade = false })` — when an existing record is `COMPLETED`, the recomputed `status` is lower, and `allowDowngrade === false`: keep `status='COMPLETED'`, set `progress = max(existing.progress, progress)`, do not change `completionDate`, do not fire NGDS. `rollUpParentsForCompletion({ dbUser, task, db, send = true, allowDowngrade = false })` threads `allowDowngrade` into both internal `upsertRollupRecord` calls.

- [ ] **Step 1: Write the failing test**

```js
// test/lib/completion-rollup-nodowngrade.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { upsertRollupRecord } from '../../srv/lib/completion-rollup.js';

const NS = 'com.sap.developers.ims';
const { test, data } = cds;
const cdsTest = test(cds.root);

describe('upsertRollupRecord no-downgrade', () => {
  let db, TaskRecords, dbUser;
  beforeEach(async () => {
    db = await cds.connect.to('db');
    ({ TaskRecords } = cds.entities(NS));
    const { Users } = cds.entities(NS);
    await db.run(INSERT.into(Users).entries({ ID: 'u-nd-1', sapId: 'NDU1' }));
    dbUser = { ID: 'u-nd-1' };
    await db.run(INSERT.into(TaskRecords).entries({
      ID: 'tr-nd-1', user_ID: 'u-nd-1', taskLegacyId: 9001, taskType: 'MISSION',
      status: 'COMPLETED', progress: 100, legacyId: 990001, attemptNumber: 1,
      completionDate: '2026-01-01T00:00:00.000Z',
    }));
  });
  afterEach(async () => {
    await db.run(DELETE.from(TaskRecords).where({ user_ID: 'u-nd-1' }));
    const { Users } = cds.entities(NS);
    await db.run(DELETE.from(Users).where({ ID: 'u-nd-1' }));
  });

  it('does NOT demote a COMPLETED record when allowDowngrade is false (default)', async () => {
    await upsertRollupRecord({
      dbUser, taskType: 'MISSION', legacyId: 9001, title: 'M',
      progress: 50, status: 'IN_PROGRESS', completionDate: null, db, send: false,
    });
    const [row] = await db.run(SELECT.from(TaskRecords).where({ ID: 'tr-nd-1' }));
    expect(row.status).toBe('COMPLETED');
    expect(row.progress).toBe(100); // max(100, 50)
    expect(row.completionDate).toContain('2026-01-01');
  });

  it('DOES demote when allowDowngrade is true', async () => {
    await upsertRollupRecord({
      dbUser, taskType: 'MISSION', legacyId: 9001, title: 'M',
      progress: 50, status: 'IN_PROGRESS', completionDate: null, db, send: false,
      allowDowngrade: true,
    });
    const [row] = await db.run(SELECT.from(TaskRecords).where({ ID: 'tr-nd-1' }));
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.progress).toBe(50);
    expect(row.completionDate).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/completion-rollup-nodowngrade.test.js` (or `npx mocha` per repo runner — check `package.json` `scripts.test`)
Expected: FAIL — first test gets `status: 'IN_PROGRESS'` (current code demotes).

- [ ] **Step 3: Implement the short-circuit**

In `srv/lib/completion-rollup.js`, change `upsertRollupRecord` signature to accept `allowDowngrade = false` and replace the `if (existing) { ... }` UPDATE block:

```js
export async function upsertRollupRecord({ dbUser, taskType, legacyId, title, progress, status, completionDate, db, send, allowDowngrade = false }) {
  const { TaskRecords } = cds.entities(NS);
  const existing = await db.run(SELECT.one.from(TaskRecords).where({
    user_ID: dbUser.ID, taskLegacyId: legacyId, taskType, status: { '!=': 'SUPERSEDED' },
  }));
  if (existing) {
    // Legacy short-circuit (#2732): never downgrade a COMPLETED parent on a
    // recompute/reconcile. Progress may still ratchet UP; status holds.
    const wouldDowngrade = existing.status === 'COMPLETED' && status !== 'COMPLETED';
    if (wouldDowngrade && !allowDowngrade) {
      const heldProgress = Math.max(existing.progress ?? 0, progress ?? 0);
      if (heldProgress === existing.progress) return; // no change
      await db.run(UPDATE(TaskRecords, existing.ID).set({ progress: heldProgress }));
      return;
    }
    if (existing.progress === progress && existing.status === status) return; // no-op
    const priorStatus = existing.status;
    await db.run(UPDATE(TaskRecords, existing.ID).set(stampSubmissionId({
      progress, status,
      completionDate: status === 'COMPLETED'
        ? (completionDate || existing.completionDate || new Date().toISOString())
        : null,
    }, existing)));
    if (send && status === 'COMPLETED' && priorStatus !== 'COMPLETED') {
      const [row] = await db.run(SELECT.from(TaskRecords).where({ ID: existing.ID }));
      await maybeAutoSendCompletion({ record: row, priorStatus, db });
    }
    metrics.counter(`rollup.${taskType.toLowerCase()}.${status === 'COMPLETED' ? 'completed' : 'progress'}`);
    return;
  }
  // ... INSERT path unchanged ...
}
```

Then thread the flag through `rollUpParentsForCompletion`:

```js
export async function rollUpParentsForCompletion({ dbUser, task, db, send = true, allowDowngrade = false }) {
```

and add `allowDowngrade` to the two `upsertRollupRecord({ ... })` calls (GROUP loop and MISSION loop).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/completion-rollup-nodowngrade.test.js`
Expected: PASS (both).

- [ ] **Step 5: Point the reset caller at the downgrade path**

In `srv/developer-service.js:295` (the reset/supersede caller — comment "a COMPLETED rollup drops back to IN_PROGRESS"), add `allowDowngrade: true`:

```js
      await rollUpParentsForCompletion({
        dbUser,
        task: { taskType: 'TUTORIAL', taskLegacyId: tutorial.legacyId, tutorialId: tutorial.ID },
        db,
        allowDowngrade: true,
      });
```

Leave all other callers (`:421`, `:442`, `:1221`, puzzle `:223`, petoberfest `:132`, account-merge `:214`) unchanged — they keep the `false` default.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/completion-rollup.js srv/developer-service.js test/lib/completion-rollup-nodowngrade.test.js
git commit -m "fix(#2732): never downgrade a COMPLETED group/mission on recompute (opt-in on reset)"
```

---

### Task 2: Filter INACTIVE tutorials out of slot loaders

**Files:**
- Modify: `srv/lib/completion-rollup.js` (`loadGroupSlots` ~:98-116, `loadMissionSlots` ~:119-138)
- Test: `test/lib/completion-rollup-inactive.test.js` (new)

**Interfaces:**
- Consumes: `loadGroupSlots(groupUuid, db)`, `loadMissionSlots(missionUuid, db)` (existing exports).
- Produces: both loaders exclude any `TUTORIAL` item whose referenced `Tutorials.status === 'INACTIVE'` before `collapseSlots`. Non-tutorial items (PUZZLE/CHECKPOINT/PETOBERFEST) and nested GROUP items are untouched (groups are filtered recursively via `loadGroupSlots`). Return shape unchanged.

- [ ] **Step 1: Write the failing test**

```js
// test/lib/completion-rollup-inactive.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadGroupSlots } from '../../srv/lib/completion-rollup.js';

const NS = 'com.sap.developers.ims';
cds.test(cds.root);

describe('slot loaders exclude INACTIVE tutorials', () => {
  let db;
  beforeEach(async () => {
    db = await cds.connect.to('db');
    const { Tutorials, Groups, GroupPathItems } = cds.entities(NS);
    await db.run(INSERT.into(Tutorials).entries(
      { ID: 't-act', legacyId: 7001, slug: 'active-tut', status: 'ACTIVE' },
      { ID: 't-ina', legacyId: 7002, slug: 'retired-tut', status: 'INACTIVE' },
    ));
    await db.run(INSERT.into(Groups).entries({ ID: 'g-1', legacyId: 8001, title: 'G' }));
    await db.run(INSERT.into(GroupPathItems).entries(
      { ID: 'gpi-1', group_ID: 'g-1', tutorial_ID: 't-act', itemOrder: 10 },
      { ID: 'gpi-2', group_ID: 'g-1', tutorial_ID: 't-ina', itemOrder: 20 },
    ));
  });
  afterEach(async () => {
    const { Tutorials, Groups, GroupPathItems } = cds.entities(NS);
    await db.run(DELETE.from(GroupPathItems).where({ group_ID: 'g-1' }));
    await db.run(DELETE.from(Groups).where({ ID: 'g-1' }));
    await db.run(DELETE.from(Tutorials).where({ ID: { in: ['t-act', 't-ina'] } }));
  });

  it('drops the INACTIVE tutorial slot, keeps the ACTIVE one', async () => {
    const slots = await loadGroupSlots('g-1', db);
    expect(slots).toHaveLength(1);
    expect(slots[0].tokens).toEqual(['TUTORIAL:7001']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/completion-rollup-inactive.test.js`
Expected: FAIL — `slots` has length 2 (INACTIVE included).

- [ ] **Step 3: Implement the filter in `loadGroupSlots`**

Add `'status'` to the tutorial fetch and build an exclusion set:

```js
export async function loadGroupSlots(groupUuid, db) {
  const { GroupPathItems, Tutorials } = cds.entities(NS);
  const gpItems = await db.run(
    SELECT.from(GroupPathItems).where({ group_ID: groupUuid }).orderBy('itemOrder')
  );
  if (gpItems.length === 0) return [];
  const tuts = await chunkedIn(Tutorials, 'ID', gpItems.map(i => i.tutorial_ID), db, ['ID', 'legacyId', 'status']);
  const legacyById = new Map(tuts.map(t => [t.ID, t.legacyId]));
  const inactiveIds = new Set(tuts.filter(t => t.status === 'INACTIVE').map(t => t.ID));
  const items = gpItems
    .filter(i => legacyById.get(i.tutorial_ID) != null && !inactiveIds.has(i.tutorial_ID))
    .map(i => ({ taskType: 'TUTORIAL', taskLegacyId: legacyById.get(i.tutorial_ID), itemOrder: i.itemOrder, altGroupKey: i.altGroupKey, groupId: null }));
  return collapseSlots(items);
}
```

- [ ] **Step 4: Implement the filter in `loadMissionSlots`**

Direct mission items store `taskLegacyId` (not a tutorial UUID). After building `norm`, fetch INACTIVE tutorial legacyIds and drop matching `TUTORIAL` tokens:

```js
  // ... after norm is built, before collapseSlots:
  const tutorialLegacyIds = norm.filter(i => i.taskType === 'TUTORIAL' && i.taskLegacyId != null).map(i => i.taskLegacyId);
  let inactiveLegacy = new Set();
  if (tutorialLegacyIds.length) {
    const { Tutorials } = cds.entities(NS);
    const tuts = await chunkedIn(Tutorials, 'legacyId', tutorialLegacyIds, db, ['legacyId', 'status']);
    inactiveLegacy = new Set(tuts.filter(t => t.status === 'INACTIVE').map(t => t.legacyId));
  }
  const filtered = norm.filter(i => !(i.taskType === 'TUTORIAL' && inactiveLegacy.has(i.taskLegacyId)));
  return collapseSlots(filtered);
```

(Replace the existing final `return collapseSlots(norm);`.)

- [ ] **Step 5: Add a mission-level test case**

Append to the same test file a mission fixture (`Missions` + `CompletionPaths` + `CompletionPathItems` with one ACTIVE + one INACTIVE `TUTORIAL` item) asserting `loadMissionSlots` returns only the ACTIVE slot. Import `loadMissionSlots` alongside `loadGroupSlots`.

```js
import { loadGroupSlots, loadMissionSlots } from '../../srv/lib/completion-rollup.js';
// ... in a second describe/it:
it('loadMissionSlots drops INACTIVE direct tutorial items', async () => {
  const { Missions, CompletionPaths, CompletionPathItems } = cds.entities(NS);
  await db.run(INSERT.into(Missions).entries({ ID: 'm-1', legacyId: 8501, title: 'M' }));
  await db.run(INSERT.into(CompletionPaths).entries({ ID: 'cp-1', mission_ID: 'm-1', legacyId: 8601 }));
  await db.run(INSERT.into(CompletionPathItems).entries(
    { ID: 'cpi-1', path_ID: 'cp-1', taskType: 'TUTORIAL', taskLegacyId: 7001, itemOrder: 10 },
    { ID: 'cpi-2', path_ID: 'cp-1', taskType: 'TUTORIAL', taskLegacyId: 7002, itemOrder: 20 },
  ));
  const slots = await loadMissionSlots('m-1', db);
  expect(slots).toHaveLength(1);
  expect(slots[0].tokens).toEqual(['TUTORIAL:7001']);
  await db.run(DELETE.from(CompletionPathItems).where({ path_ID: 'cp-1' }));
  await db.run(DELETE.from(CompletionPaths).where({ ID: 'cp-1' }));
  await db.run(DELETE.from(Missions).where({ ID: 'm-1' }));
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/lib/completion-rollup-inactive.test.js`
Expected: PASS (both).

- [ ] **Step 7: Commit**

```bash
git add srv/lib/completion-rollup.js test/lib/completion-rollup-inactive.test.js
git commit -m "fix(#2732): exclude INACTIVE tutorials from group/mission completion slots"
```

---

### Task 3: Empty-slot guard (no false-complete after filtering)

**Files:**
- Modify: `srv/lib/completion-rollup.js` (`rollUpParentsForCompletion` GROUP loop ~:292-303 and MISSION loop ~:304-313)
- Test: `test/lib/completion-rollup-emptyguard.test.js` (new)

**Interfaces:**
- Consumes: `evaluateSlots(slots, tokenSet, resolveGroup)` returning `{ satisfied, total }`.
- Produces: when `total === 0` for a group or mission, `rollUpParentsForCompletion` skips `calculateMissionProgress`/`upsertRollupRecord`, calls `metrics.counter('rollup.empty_slots')` and `cds.log('rollup').warn('empty slots after INACTIVE filter', { kind, legacyId })`. No `TaskRecord` is written.

- [ ] **Step 1: Write the failing test**

```js
// test/lib/completion-rollup-emptyguard.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rollUpParentsForCompletion } from '../../srv/lib/completion-rollup.js';

const NS = 'com.sap.developers.ims';
cds.test(cds.root);

describe('empty-slot guard', () => {
  let db;
  beforeEach(async () => {
    db = await cds.connect.to('db');
    const { Users, Tutorials, Missions, CompletionPaths, CompletionPathItems } = cds.entities(NS);
    await db.run(INSERT.into(Users).entries({ ID: 'u-eg', sapId: 'EG1' }));
    // Mission whose only slot is an INACTIVE tutorial → filters to total 0.
    await db.run(INSERT.into(Tutorials).entries({ ID: 't-dead', legacyId: 6001, slug: 'dead', status: 'INACTIVE' }));
    await db.run(INSERT.into(Missions).entries({ ID: 'm-eg', legacyId: 6500, title: 'Empty' }));
    await db.run(INSERT.into(CompletionPaths).entries({ ID: 'cp-eg', mission_ID: 'm-eg', legacyId: 6600 }));
    await db.run(INSERT.into(CompletionPathItems).entries({ ID: 'cpi-eg', path_ID: 'cp-eg', taskType: 'TUTORIAL', taskLegacyId: 6001, itemOrder: 10 }));
  });
  afterEach(async () => {
    const E = cds.entities(NS);
    await db.run(DELETE.from(E.TaskRecords).where({ user_ID: 'u-eg' }));
    await db.run(DELETE.from(E.CompletionPathItems).where({ path_ID: 'cp-eg' }));
    await db.run(DELETE.from(E.CompletionPaths).where({ ID: 'cp-eg' }));
    await db.run(DELETE.from(E.Missions).where({ ID: 'm-eg' }));
    await db.run(DELETE.from(E.Tutorials).where({ ID: 't-dead' }));
    await db.run(DELETE.from(E.Users).where({ ID: 'u-eg' }));
  });

  it('writes NO mission record when all slots filtered to INACTIVE', async () => {
    // trigger as if the (now-inactive) tutorial completed
    await rollUpParentsForCompletion({ dbUser: { ID: 'u-eg' }, task: { taskType: 'TUTORIAL', taskLegacyId: 6001 }, db, send: false });
    const { TaskRecords } = cds.entities(NS);
    const rows = await db.run(SELECT.from(TaskRecords).where({ user_ID: 'u-eg', taskType: 'MISSION' }));
    expect(rows).toHaveLength(0); // NOT auto-completed
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/completion-rollup-emptyguard.test.js`
Expected: FAIL — a MISSION row is written with `status COMPLETED` (total===0 → 100%).

- [ ] **Step 3: Implement the guard**

In `rollUpParentsForCompletion`, in BOTH the GROUP loop and the MISSION loop, after `const { satisfied, total } = evaluateSlots(...)`:

```js
      const { satisfied, total } = evaluateSlots(slots, tokenSet, resolveGroup);
      if (total === 0) {
        cds.log('rollup').warn('empty slots after INACTIVE filter', { kind: 'MISSION', legacyId: m.legacyId });
        metrics.counter('rollup.empty_slots');
        continue;
      }
      const { progress, status } = calculateMissionProgress(satisfied, total);
```

(Use `kind: 'GROUP', legacyId` in the group loop, `kind: 'MISSION', legacyId: m.legacyId` in the mission loop. The existing `slots.length === 0` early-`continue` stays — this guard additionally covers the filtered-to-empty case and emits the counter/log.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/completion-rollup-emptyguard.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/completion-rollup.js test/lib/completion-rollup-emptyguard.test.js
git commit -m "fix(#2732): guard empty slots after INACTIVE filter (no false-complete)"
```

---

### Task 4: Reconcile module — `reconcileEntityForUsers` + `findUnhealthyEntities`

**Files:**
- Create: `srv/lib/completion-reconcile.js`
- Test: `test/lib/completion-reconcile.test.js` (new)

**Interfaces:**
- Consumes (import from `./completion-rollup.js`): `loadGroupSlots`, `loadMissionSlots`, `evaluateSlots`, `getUserCompletedMap`, `upsertRollupRecord`, `tokenFor`. (Export any not already exported — `evaluateSlots`, `getUserCompletedMap`, `upsertRollupRecord`, `loadGroupSlots`, `loadMissionSlots` are already exported; confirm `tokenFor` export exists — it does.)
- Produces:
  - `reconcileEntityForUsers({ kind, legacyId, db, userIds, send = false })` → `{ created, updated, completed, flagged }`. `kind ∈ {'GROUP','MISSION'}`. Resolves entity UUID from legacyId, loads INACTIVE-filtered slots; `total===0` → `{ flagged: 1 }` and no writes. Candidate users = `userIds` if given, else the union of (a) users with a non-SUPERSEDED `TaskRecord` for `(legacyId, kind)` and (b) users with a COMPLETED child record matching any slot token. Per user: `getUserCompletedMap` → `evaluateSlots` → `upsertRollupRecord({ allowDowngrade: false, send })`.
  - `findUnhealthyEntities(db)` → `[{ kind, legacyId, title, slug, badSlots: [{ taskLegacyId, reason }] }]` — published missions + groups whose raw path items reference an INACTIVE tutorial (`reason:'inactive'`) or an unresolvable `taskLegacyId`/`tutorial_ID` (`reason:'unresolved'`), or that filter to `total===0` (`reason:'empty'`).

- [ ] **Step 1: Write the failing test**

```js
// test/lib/completion-reconcile.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { reconcileEntityForUsers, findUnhealthyEntities } from '../../srv/lib/completion-reconcile.js';

const NS = 'com.sap.developers.ims';
cds.test(cds.root);

describe('completion-reconcile', () => {
  let db;
  beforeEach(async () => {
    db = await cds.connect.to('db');
    const E = cds.entities(NS);
    await db.run(INSERT.into(E.Users).entries({ ID: 'u-rc', sapId: 'RC1' }));
    // Mission with two ACTIVE tutorials; user completed BOTH as TUTORIAL records
    // but has a STALE mission record stuck at IN_PROGRESS/50 (simulating drift).
    await db.run(INSERT.into(E.Tutorials).entries(
      { ID: 't-a', legacyId: 5001, slug: 'a', status: 'ACTIVE' },
      { ID: 't-b', legacyId: 5002, slug: 'b', status: 'ACTIVE' },
    ));
    await db.run(INSERT.into(E.Missions).entries({ ID: 'm-rc', legacyId: 5500, title: 'RC', published: true }));
    await db.run(INSERT.into(E.CompletionPaths).entries({ ID: 'cp-rc', mission_ID: 'm-rc', legacyId: 5600 }));
    await db.run(INSERT.into(E.CompletionPathItems).entries(
      { ID: 'i-a', path_ID: 'cp-rc', taskType: 'TUTORIAL', taskLegacyId: 5001, itemOrder: 10 },
      { ID: 'i-b', path_ID: 'cp-rc', taskType: 'TUTORIAL', taskLegacyId: 5002, itemOrder: 20 },
    ));
    await db.run(INSERT.into(E.TaskRecords).entries(
      { ID: 'r-a', user_ID: 'u-rc', taskLegacyId: 5001, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 550001, attemptNumber: 1 },
      { ID: 'r-b', user_ID: 'u-rc', taskLegacyId: 5002, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 550002, attemptNumber: 1 },
      { ID: 'r-m', user_ID: 'u-rc', taskLegacyId: 5500, taskType: 'MISSION', status: 'IN_PROGRESS', progress: 50, legacyId: 550003, attemptNumber: 1 },
    );
  });
  afterEach(async () => {
    const E = cds.entities(NS);
    for (const e of ['TaskRecords','CompletionPathItems','CompletionPaths','Missions','Tutorials','Users'])
      await db.run(DELETE.from(E[e]).where(e === 'Users' ? { ID: 'u-rc' } : {}).or({})); // simplest: clear fixtures
  });

  it('repairs a stale mission record to COMPLETED', async () => {
    const res = await reconcileEntityForUsers({ kind: 'MISSION', legacyId: 5500, db, send: false });
    const { TaskRecords } = cds.entities(NS);
    const [row] = await db.run(SELECT.from(TaskRecords).where({ user_ID: 'u-rc', taskType: 'MISSION' }));
    expect(row.status).toBe('COMPLETED');
    expect(row.progress).toBe(100);
    expect(res.completed).toBeGreaterThan(0);
  });

  it('findUnhealthyEntities flags a mission with an INACTIVE slot', async () => {
    const { Tutorials } = cds.entities(NS);
    await db.run(UPDATE(Tutorials, 't-b').set({ status: 'INACTIVE' }));
    const bad = await findUnhealthyEntities(db);
    const m = bad.find(e => e.legacyId === 5500);
    expect(m).toBeDefined();
    expect(m.badSlots.some(s => s.taskLegacyId === 5002 && s.reason === 'inactive')).toBe(true);
  });
});
```

> Note: simplify the `afterEach` to explicit deletes by fixture IDs if the `.or({})` form misbehaves on the repo's sqlite — the plan's intent is "clear only this test's fixtures."

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/completion-reconcile.test.js`
Expected: FAIL — module `srv/lib/completion-reconcile.js` does not exist.

- [ ] **Step 3: Implement `srv/lib/completion-reconcile.js`**

```js
// srv/lib/completion-reconcile.js
//
// Self-heal for GROUP/MISSION completion records (#2732). Recomputes stored
// TaskRecords when a completion path changes (targeted) or on a nightly sweep
// (reconcileAll, Task 6). Reuses the slot/eval primitives from
// completion-rollup.js. Never throws into a caller's transaction.
//
// Spec: docs/superpowers/specs/2026-10-13-group-mission-cascade-selfheal-design.md
import cds from '@sap/cds';
import {
  loadGroupSlots, loadMissionSlots, evaluateSlots, getUserCompletedMap, upsertRollupRecord, tokenFor,
} from './completion-rollup.js';
import * as metrics from './metrics.js';

const NS = 'com.sap.developers.ims';
const IN_CHUNK = 500;
const LOG = cds.log('rollup');

/** Flatten slot tokens (recursively resolving nested-group slots) into a legacyId set. */
function slotLegacyIds(slots, resolveGroup) {
  const out = new Set();
  const walk = (ss) => ss.forEach(s => {
    if (s.groupId != null) walk(resolveGroup(s.groupId) || []);
    else s.tokens.forEach(t => out.add(Number(t.split(':')[1])));
  });
  walk(slots);
  return out;
}

export async function reconcileEntityForUsers({ kind, legacyId, db, userIds, send = false }) {
  const result = { created: 0, updated: 0, completed: 0, flagged: 0 };
  try {
    const { Groups, Missions, TaskRecords } = cds.entities(NS);
    const entity = kind === 'GROUP' ? Groups : Missions;
    const [e] = await db.run(SELECT.from(entity).where({ legacyId }).columns('ID', 'legacyId', 'title'));
    if (!e) return result;

    // Build slots (+ a group resolver for nested-group missions).
    const groupSlotCache = new Map();
    const resolveGroup = (lid) => groupSlotCache.get(lid) || [];
    async function ensureGroup(lid) {
      if (groupSlotCache.has(lid)) return;
      const [g] = await db.run(SELECT.from(Groups).where({ legacyId: lid }).columns('ID', 'legacyId'));
      groupSlotCache.set(lid, g ? await loadGroupSlots(g.ID, db) : []);
    }
    let slots;
    if (kind === 'GROUP') { slots = await loadGroupSlots(e.ID, db); }
    else {
      slots = await loadMissionSlots(e.ID, db);
      for (const s of slots) if (s.groupId != null) await ensureGroup(s.groupId);
    }
    if (slots.length === 0) return result;

    // total===0 can only happen for groups whose items all filtered out;
    // mission total is slots.length. Guard both.
    const probe = evaluateSlots(slots, new Set(), resolveGroup);
    if (probe.total === 0) { metrics.counter('rollup.empty_slots'); result.flagged = 1; return result; }

    // Candidate users: holders of a parent record + holders of a satisfying child record.
    const tokenLegacyIds = [...slotLegacyIds(slots, resolveGroup)];
    const candidates = new Set(userIds || []);
    if (!userIds) {
      const parentHolders = await db.run(SELECT.from(TaskRecords)
        .columns('user_ID').where({ taskLegacyId: legacyId, taskType: kind, status: { '!=': 'SUPERSEDED' } }));
      parentHolders.forEach(r => candidates.add(r.user_ID));
      for (let i = 0; i < tokenLegacyIds.length; i += IN_CHUNK) {
        const childHolders = await db.run(SELECT.from(TaskRecords)
          .columns('user_ID').where({ status: 'COMPLETED', taskLegacyId: { in: tokenLegacyIds.slice(i, i + IN_CHUNK) } }));
        childHolders.forEach(r => candidates.add(r.user_ID));
      }
    }

    for (const user_ID of candidates) {
      const dbUser = { ID: user_ID };
      const { tokenSet } = await getUserCompletedMap(dbUser, tokenLegacyIds, db);
      const { satisfied, total } = evaluateSlots(slots, tokenSet, resolveGroup);
      if (total === 0) continue;
      const progress = Math.round((satisfied / total) * 100);
      const status = progress >= 100 ? 'COMPLETED' : 'IN_PROGRESS';
      const before = await db.run(SELECT.one.from(TaskRecords)
        .where({ user_ID, taskLegacyId: legacyId, taskType: kind, status: { '!=': 'SUPERSEDED' } }));
      await upsertRollupRecord({ dbUser, taskType: kind, legacyId, title: e.title, progress, status, completionDate: null, db, send, allowDowngrade: false });
      if (!before) result.created++; else result.updated++;
      if (status === 'COMPLETED' && (!before || before.status !== 'COMPLETED')) result.completed++;
    }
  } catch (err) {
    LOG.error('reconcileEntityForUsers failed (non-fatal):', err.message);
    metrics.counter('rollup.failures');
    result.flagged = result.flagged || 0;
  }
  return result;
}

/** Published missions + groups whose path items reference INACTIVE / unresolved tutorials, or filter to empty. */
export async function findUnhealthyEntities(db) {
  const out = [];
  const { Missions, Groups, Tutorials, GroupPathItems, CompletionPaths, CompletionPathItems } = cds.entities(NS);
  const activeStatus = (s) => s == null || s === 'ACTIVE';

  // Groups
  const groups = await db.run(SELECT.from(Groups).columns('ID', 'legacyId', 'title', 'slug').where({ published: true }));
  for (const g of groups) {
    const items = await db.run(SELECT.from(GroupPathItems).where({ group_ID: g.ID }));
    const tuts = await db.run(SELECT.from(Tutorials).columns('ID', 'legacyId', 'status').where({ ID: { in: items.map(i => i.tutorial_ID) } }));
    const byId = new Map(tuts.map(t => [t.ID, t]));
    const badSlots = [];
    for (const i of items) {
      const t = byId.get(i.tutorial_ID);
      if (!t) badSlots.push({ taskLegacyId: null, reason: 'unresolved' });
      else if (!activeStatus(t.status)) badSlots.push({ taskLegacyId: t.legacyId, reason: 'inactive' });
    }
    if (items.length && items.every(i => { const t = byId.get(i.tutorial_ID); return !t || !activeStatus(t.status); }))
      badSlots.push({ taskLegacyId: null, reason: 'empty' });
    if (badSlots.length) out.push({ kind: 'GROUP', legacyId: g.legacyId, title: g.title, slug: g.slug, badSlots });
  }

  // Missions (direct TUTORIAL items only; nested GROUP handled by its own group entry)
  const missions = await db.run(SELECT.from(Missions).columns('ID', 'legacyId', 'title', 'slug').where({ published: true }));
  for (const m of missions) {
    const paths = await db.run(SELECT.from(CompletionPaths).columns('ID').where({ mission_ID: m.ID }));
    if (!paths.length) continue;
    const items = await db.run(SELECT.from(CompletionPathItems).where({ path_ID: { in: paths.map(p => p.ID) }, taskType: 'TUTORIAL' }));
    const legacyIds = items.map(i => i.taskLegacyId).filter(v => v != null);
    const tuts = legacyIds.length ? await db.run(SELECT.from(Tutorials).columns('legacyId', 'status').where({ legacyId: { in: legacyIds } })) : [];
    const byLegacy = new Map(tuts.map(t => [t.legacyId, t]));
    const badSlots = [];
    for (const i of items) {
      const t = byLegacy.get(i.taskLegacyId);
      if (!t) badSlots.push({ taskLegacyId: i.taskLegacyId, reason: 'unresolved' });
      else if (!activeStatus(t.status)) badSlots.push({ taskLegacyId: t.legacyId, reason: 'inactive' });
    }
    if (badSlots.length) out.push({ kind: 'MISSION', legacyId: m.legacyId, title: m.title, slug: m.slug, badSlots });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/completion-reconcile.test.js`
Expected: PASS (both). Fix the `afterEach` to explicit per-ID deletes if sqlite rejects the `.or({})` shorthand.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/completion-reconcile.js test/lib/completion-reconcile.test.js
git commit -m "feat(#2732): completion-reconcile module (reconcileEntityForUsers + findUnhealthyEntities)"
```

---

### Task 5: `reconcileAll` sweep + nightly job registration

**Files:**
- Modify: `srv/lib/completion-reconcile.js` (add `reconcileAll`)
- Modify: `srv/jobs/scheduler.js` (import + `registerJob`)
- Test: `test/lib/completion-reconcile-all.test.js` (new)

**Interfaces:**
- Consumes: `reconcileEntityForUsers`.
- Produces: `reconcileAll({ db, batch = 500, send = false })` → `{ entities, created, updated, completed, flagged }`. Iterates published `Missions` + `Groups`, calls `reconcileEntityForUsers` per entity (no `userIds`), accumulates counts. Registered as job `reconcile-completions`.

- [ ] **Step 1: Write the failing test**

```js
// test/lib/completion-reconcile-all.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { reconcileAll } from '../../srv/lib/completion-reconcile.js';

const NS = 'com.sap.developers.ims';
cds.test(cds.root);

describe('reconcileAll', () => {
  it('sweeps published entities and returns accumulated counts (idempotent)', async () => {
    const db = await cds.connect.to('db');
    const E = cds.entities(NS);
    await db.run(INSERT.into(E.Users).entries({ ID: 'u-ra', sapId: 'RA1' }));
    await db.run(INSERT.into(E.Tutorials).entries({ ID: 't-ra', legacyId: 4001, slug: 'ra', status: 'ACTIVE' }));
    await db.run(INSERT.into(E.Groups).entries({ ID: 'g-ra', legacyId: 4500, title: 'RA', published: true }));
    await db.run(INSERT.into(E.GroupPathItems).entries({ ID: 'gi-ra', group_ID: 'g-ra', tutorial_ID: 't-ra', itemOrder: 10 }));
    await db.run(INSERT.into(E.TaskRecords).entries({ ID: 'tr-ra', user_ID: 'u-ra', taskLegacyId: 4001, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 440001, attemptNumber: 1 }));

    const r1 = await reconcileAll({ db });
    expect(r1.completed).toBeGreaterThan(0);
    const [grp] = await db.run(SELECT.from(E.TaskRecords).where({ user_ID: 'u-ra', taskType: 'GROUP' }));
    expect(grp.status).toBe('COMPLETED');

    const countBefore = (await db.run(SELECT.from(E.TaskRecords).where({ user_ID: 'u-ra', taskType: 'GROUP' }))).length;
    await reconcileAll({ db });
    const countAfter = (await db.run(SELECT.from(E.TaskRecords).where({ user_ID: 'u-ra', taskType: 'GROUP' }))).length;
    expect(countAfter).toBe(countBefore); // no duplicate rows
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/completion-reconcile-all.test.js`
Expected: FAIL — `reconcileAll` is not exported.

- [ ] **Step 3: Implement `reconcileAll`**

Append to `srv/lib/completion-reconcile.js`:

```js
export async function reconcileAll({ db, batch = 500, send = false } = {}) {
  const totals = { entities: 0, created: 0, updated: 0, completed: 0, flagged: 0 };
  try {
    const { Missions, Groups } = cds.entities(NS);
    const groups = await db.run(SELECT.from(Groups).columns('legacyId').where({ published: true }));
    const missions = await db.run(SELECT.from(Missions).columns('legacyId').where({ published: true }));
    for (const g of groups) {
      const r = await reconcileEntityForUsers({ kind: 'GROUP', legacyId: g.legacyId, db, send });
      totals.entities++; totals.created += r.created; totals.updated += r.updated; totals.completed += r.completed; totals.flagged += r.flagged;
    }
    for (const m of missions) {
      const r = await reconcileEntityForUsers({ kind: 'MISSION', legacyId: m.legacyId, db, send });
      totals.entities++; totals.created += r.created; totals.updated += r.updated; totals.completed += r.completed; totals.flagged += r.flagged;
    }
  } catch (err) {
    LOG.error('reconcileAll failed (non-fatal):', err.message);
    metrics.counter('rollup.failures');
  }
  return totals;
}
```

(`batch` is reserved for future per-user chunking; `reconcileEntityForUsers` already chunks its `.in()` queries.)

- [ ] **Step 4: Register the nightly job**

In `srv/jobs/scheduler.js`, add the import near the other job imports:

```js
import { reconcileAll } from '../lib/completion-reconcile.js';
```

and add a `registerJob` call alongside the other completion jobs (e.g. after `materialize-co-completions`):

```js
  // #2732 — nightly self-heal of GROUP/MISSION completion records. Repairs
  // drift from mapping edits + the ~50 pre-existing dead-slot entities, and
  // keeps them healed. Off-minute :17 avoids the 04:00/:33 cluster. Fail-open:
  // reconcileAll never throws. Manually runnable via AdminService.runJob.
  registerJob({
    jobName: 'reconcile-completions',
    schedule: '17 4 * * *',
    ttlMs: 1_800_000,
    description: 'Self-heal GROUP/MISSION completion records (drift + INACTIVE)',
    fn: () => reconcileAll({ db: cds.db }),
  });
```

- [ ] **Step 5: Run tests + confirm registry wiring**

Run: `npx vitest run test/lib/completion-reconcile-all.test.js`
Expected: PASS.
Also run the scheduler's existing registry test if present (`npx vitest run test/jobs/` or grep for a `JOB_REGISTRY`/`scheduler` test) to confirm no duplicate-jobName throw.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/completion-reconcile.js srv/jobs/scheduler.js test/lib/completion-reconcile-all.test.js
git commit -m "feat(#2732): reconcileAll sweep + nightly reconcile-completions job"
```

---

### Task 6: Targeted reconcile on admin path-item SAVE

**Files:**
- Modify: `srv/admin-service.js` (near the alt-group `before` wiring ~:1144-1147; import `reconcileEntityForUsers`)
- Test: `test/admin-service-reconcile.test.js` (new) — if the repo's admin tests use a different harness, mirror an existing admin test file's setup instead.

**Interfaces:**
- Consumes: `reconcileEntityForUsers({ kind, legacyId, db })`.
- Produces: `after(['CREATE','UPDATE','DELETE'], 'CompletionPathItems')` → resolve parent mission legacyId → fire-and-forget `reconcileEntityForUsers({kind:'MISSION', legacyId})`. `after(['CREATE','UPDATE','DELETE'], 'GroupPathItems')` → resolve parent group legacyId → reconcile that GROUP, then resolve + reconcile each MISSION that nests the group. Never blocks or fails the SAVE.

- [ ] **Step 1: Write the failing test**

```js
// test/admin-service-reconcile.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const NS = 'com.sap.developers.ims';
const { GET, POST, PATCH } = cds.test(cds.root); // adjust to repo's admin test auth harness

// If admin requires auth in tests, copy the auth/user setup from an existing
// admin-service test file (e.g. test/admin-service*.test.js) rather than GET/POST raw.

describe('admin path-item SAVE reconciles affected users', () => {
  it('completing-then-remapping reconciles the stored mission record', async () => {
    const db = await cds.connect.to('db');
    const E = cds.entities(NS);
    // Fixture: user completed t-x; mission maps to t-x (so mission should be COMPLETE
    // once reconciled). Insert the mapping via the admin service to fire the hook.
    await db.run(INSERT.into(E.Users).entries({ ID: 'u-adm', sapId: 'ADM1' }));
    await db.run(INSERT.into(E.Tutorials).entries({ ID: 't-x', legacyId: 3001, slug: 'x', status: 'ACTIVE' }));
    await db.run(INSERT.into(E.Missions).entries({ ID: 'm-x', legacyId: 3500, title: 'X', published: true }));
    await db.run(INSERT.into(E.CompletionPaths).entries({ ID: 'cp-x', mission_ID: 'm-x', legacyId: 3600 }));
    await db.run(INSERT.into(E.TaskRecords).entries({ ID: 'tr-x', user_ID: 'u-adm', taskLegacyId: 3001, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 330001, attemptNumber: 1 }));

    // Create a CompletionPathItems row through the admin service to trigger after-hook.
    // (Use the service API the repo's admin tests use; pseudo-shown here.)
    await POST('/admin/CompletionPathItems', { ID: 'cpi-x', path_ID: 'cp-x', taskType: 'TUTORIAL', taskLegacyId: 3001, itemOrder: 10 });

    // after-hook is fire-and-forget; wait a tick for the detached tx.
    await new Promise(r => setTimeout(r, 150));
    const [row] = await db.run(SELECT.from(E.TaskRecords).where({ user_ID: 'u-adm', taskType: 'MISSION' }));
    expect(row?.status).toBe('COMPLETED');
  });
});
```

> The exact admin invocation + auth differs per repo harness. Before writing, open an existing `test/admin-service*.test.js` and copy its service-call/auth pattern; the assertion (mission record becomes COMPLETED after the SAVE settles) is the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin-service-reconcile.test.js`
Expected: FAIL — no reconcile hook; mission record stays absent/IN_PROGRESS.

- [ ] **Step 3: Implement the after-hooks**

In `srv/admin-service.js`, add the import:

```js
import { reconcileEntityForUsers } from './lib/completion-reconcile.js';
```

Add, right after the alt-group `before` wiring (~:1147):

```js
    // #2732 — self-heal: when a completion path mapping changes, reconcile the
    // affected mission/group's stored GROUP/MISSION records for all touched
    // users. Fire-and-forget in a detached tx; a reconcile fault must never
    // fail the author's SAVE.
    const fireReconcile = (kind, legacyId) => {
      if (legacyId == null) return;
      setImmediate(() => {
        cds.tx(async (tx) => { await reconcileEntityForUsers({ kind, legacyId, db: tx }); })
          .catch(err => cds.log('rollup').error('SAVE-triggered reconcile failed (non-fatal):', err.message));
      });
    };

    const resolveMissionLegacyForPath = async (pathId) => {
      if (!pathId) return null;
      const { CompletionPaths, Missions } = cds.entities('com.sap.developers.ims');
      const [p] = await SELECT.from(CompletionPaths).columns('mission_ID').where({ ID: pathId });
      if (!p?.mission_ID) return null;
      const [m] = await SELECT.from(Missions).columns('legacyId').where({ ID: p.mission_ID });
      return m?.legacyId ?? null;
    };
    const resolveGroupLegacy = async (groupId) => {
      if (!groupId) return null;
      const { Groups } = cds.entities('com.sap.developers.ims');
      const [g] = await SELECT.from(Groups).columns('legacyId').where({ ID: groupId });
      return g?.legacyId ?? null;
    };
    const resolveMissionsNestingGroup = async (groupId) => {
      if (!groupId) return [];
      const { CompletionPathItems, CompletionPaths, Missions } = cds.entities('com.sap.developers.ims');
      const items = await SELECT.from(CompletionPathItems).columns('path_ID').where({ taskType: 'GROUP', group_ID: groupId });
      if (!items.length) return [];
      const paths = await SELECT.from(CompletionPaths).columns('mission_ID').where({ ID: { in: items.map(i => i.path_ID) } });
      const missionIds = [...new Set(paths.map(p => p.mission_ID).filter(Boolean))];
      if (!missionIds.length) return [];
      const missions = await SELECT.from(Missions).columns('legacyId').where({ ID: { in: missionIds } });
      return missions.map(m => m.legacyId).filter(v => v != null);
    };

    const onCompletionPathItemChange = async (_data, req) => {
      const pathId = req.data?.path_ID ?? (Array.isArray(req.params) && req.params[0]?.path_ID);
      let legacyId = await resolveMissionLegacyForPath(pathId);
      if (legacyId == null && Array.isArray(req.params) && req.params[0]?.ID) {
        // DELETE by key only: look up the row's path before/after via the key
        const { CompletionPathItems } = cds.entities('com.sap.developers.ims');
        const [it] = await SELECT.from(CompletionPathItems).columns('path_ID').where({ ID: req.params[0].ID });
        legacyId = await resolveMissionLegacyForPath(it?.path_ID);
      }
      fireReconcile('MISSION', legacyId);
    };
    const onGroupPathItemChange = async (_data, req) => {
      const groupId = req.data?.group_ID ?? (Array.isArray(req.params) && req.params[0]?.group_ID);
      let gid = groupId;
      if (!gid && Array.isArray(req.params) && req.params[0]?.ID) {
        const { GroupPathItems } = cds.entities('com.sap.developers.ims');
        const [it] = await SELECT.from(GroupPathItems).columns('group_ID').where({ ID: req.params[0].ID });
        gid = it?.group_ID;
      }
      const groupLegacy = await resolveGroupLegacy(gid);
      fireReconcile('GROUP', groupLegacy);
      for (const mLegacy of await resolveMissionsNestingGroup(gid)) fireReconcile('MISSION', mLegacy);
    };

    this.after(['CREATE', 'UPDATE', 'DELETE'], 'CompletionPathItems', onCompletionPathItemChange);
    this.after(['CREATE', 'UPDATE', 'DELETE'], 'GroupPathItems', onGroupPathItemChange);
```

> Caveat for the implementer: on DELETE, the parent FK may already be gone from `req.data`; resolve from `req.params[0].ID` BEFORE the row is physically removed if the harness deletes pre-after — if the lookup returns nothing on DELETE, capture the parent in a matching `before('DELETE')` into `req.context`/a WeakMap and read it in the after-hook. Verify which fires with the row still present in this CAP version during Step 4.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/admin-service-reconcile.test.js`
Expected: PASS. If DELETE resolution is flaky, add the `before('DELETE')` capture described above and re-run.

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.js test/admin-service-reconcile.test.js
git commit -m "feat(#2732): reconcile affected users when admin edits a completion path item"
```

---

### Task 7: Admin health endpoint (`completionHealth`)

**Files:**
- Modify: `srv/admin-service.cds` (add unbound `function completionHealth()` near `runJob` ~:632)
- Modify: `srv/admin-service.js` (add `this.on('completionHealth', ...)` handler)
- Test: `test/admin-service-health.test.js` (new)

**Interfaces:**
- Consumes: `findUnhealthyEntities(db)`.
- Produces: `AdminService.completionHealth()` → `array of { kind: String, legacyId: Integer, title: String, slug: String, badSlots: array of { taskLegacyId: Integer, reason: String } }`.

- [ ] **Step 1: Write the failing test**

```js
// test/admin-service-health.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const NS = 'com.sap.developers.ims';
cds.test(cds.root); // + admin auth harness as per existing admin tests

describe('AdminService.completionHealth', () => {
  it('returns missions/groups with INACTIVE slots', async () => {
    const db = await cds.connect.to('db');
    const E = cds.entities(NS);
    await db.run(INSERT.into(E.Tutorials).entries({ ID: 't-h', legacyId: 2001, slug: 'h', status: 'INACTIVE' }));
    await db.run(INSERT.into(E.Groups).entries({ ID: 'g-h', legacyId: 2500, title: 'H', slug: 'h-grp', published: true }));
    await db.run(INSERT.into(E.GroupPathItems).entries({ ID: 'gi-h', group_ID: 'g-h', tutorial_ID: 't-h', itemOrder: 10 }));

    const admin = await cds.connect.to('AdminService');
    const res = await admin.send('completionHealth');
    const g = res.find(e => e.legacyId === 2500);
    expect(g).toBeDefined();
    expect(g.badSlots.some(s => s.reason === 'inactive')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin-service-health.test.js`
Expected: FAIL — `completionHealth` action not defined.

- [ ] **Step 3: Define the function in CDS**

In `srv/admin-service.cds`, near the other admin actions (~:632), add:

```cds
    // #2732 — on-demand list of missions/groups whose completion paths contain
    // an INACTIVE or unresolvable tutorial (so authors can fix the mapping).
    function completionHealth() returns array of {
      kind      : String;
      legacyId  : Integer;
      title     : String;
      slug      : String;
      badSlots  : array of { taskLegacyId : Integer; reason : String; };
    };
```

- [ ] **Step 4: Implement the handler**

In `srv/admin-service.js`, add the import if not already present:

```js
import { reconcileEntityForUsers, findUnhealthyEntities } from './lib/completion-reconcile.js';
```

and register the handler (alongside the other `this.on(..., 'JobControls'...)` admin handlers):

```js
    this.on('completionHealth', async () => {
      const db = await cds.connect.to('db');
      return findUnhealthyEntities(db);
    });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/admin-service-health.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js test/admin-service-health.test.js
git commit -m "feat(#2732): AdminService.completionHealth lists missions/groups with INACTIVE slots"
```

---

### Task 8: Full suite, deploy check, srv-qa cp-list audit, PR

**Files:**
- Verify only (no new files unless the cp-list audit requires an `.deploy/mta.yaml` entry).

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: all green, including the five new test files. Fix any regressions in the touched modules.

- [ ] **Step 2: Clean schema deploy**

Run: `npx cds deploy --to sqlite::memory:`
Expected: no errors (confirms no accidental schema change).

- [ ] **Step 3: srv-qa cp-list audit (per CLAUDE.md)**

`completion-reconcile.js` is imported by `scheduler.js` and `admin-service.js`, NOT by `srv/lib/content-store.js`. Confirm:

Run: `grep -rn "completion-reconcile" srv/lib/content-store.js` → expect **no match**.
If no match, no `.deploy/mta.yaml` `srv-qa` `cp` change is needed. (Document this in the PR body.)

- [ ] **Step 4: Lint**

Run: `npx cds lint` (or the repo's `npm run lint` if defined)
Expected: clean on the touched files.

- [ ] **Step 5: Push + open PR targeting DEV**

```bash
git push -u origin worktree-issue-2732-cascade-selfheal
gh pr create --repo sap-tutorials/tutorials-ims --base DEV \
  --title "fix(#2732): group/mission completion cascade + self-heal" \
  --body "$(cat <<'EOF'
Closes #2732 (root cause of #2718/#2719/#2722).

- Never downgrade a COMPLETED group/mission on recompute (legacy short-circuit); opt-in demote on explicit reset.
- Exclude INACTIVE tutorials from completion slots; guard the filtered-to-empty case (no false-complete).
- New `srv/lib/completion-reconcile.js`: targeted reconcile on admin completion-path SAVE + nightly `reconcile-completions` job (repairs the ~50 pre-existing dead-slot entities).
- `AdminService.completionHealth()` lists missions/groups with INACTIVE/unresolvable slots.

No schema change. srv-qa cp-list audit: completion-reconcile.js is not a content-store.js dep — no mta.yaml change.

Spec: docs/superpowers/specs/2026-10-13-group-mission-cascade-selfheal-design.md

Rollout: deploy DEV → run reconcile-completions via admin runJob → verify missions 12479/12052/16326 complete for earners → check completionHealth list.
EOF
)"
```

- [ ] **Step 6: Verify PR targets DEV**

Run: `gh pr view --repo sap-tutorials/tutorials-ims --json baseRefName -q .baseRefName`
Expected: `DEV`.

---

## Self-Review

**Spec coverage:**
- Defect A (no downgrade) → Task 1. ✓
- Defect B (INACTIVE filter) → Task 2; empty-slot guard → Task 3. ✓
- Defect C (self-heal): reconcile module → Task 4; nightly job → Task 5; targeted SAVE → Task 6. ✓
- Goal 4 (admin visibility) → Task 7. ✓
- Non-goals (no derive-on-read, no schema change, NavigatorCatalog untouched, NGDS send=false) → honored across tasks + Global Constraints. ✓
- Rollout/cp-list audit → Task 8. ✓

**Placeholder scan:** test harness specifics for admin auth (Tasks 6/7) are flagged as "copy the existing admin test harness" rather than invented — this is a deliberate instruction to match the repo, not a TBD; the behavioral contract/assertions are concrete. All code steps have real code.

**Type consistency:** `reconcileEntityForUsers({ kind, legacyId, db, userIds, send })` and `findUnhealthyEntities(db)` signatures match between Task 4 (definition), Task 5 (`reconcileAll` caller), Task 6 (SAVE hook caller), Task 7 (endpoint caller). `upsertRollupRecord(..., allowDowngrade)` and `rollUpParentsForCompletion(..., allowDowngrade)` consistent between Tasks 1, 4. `badSlots[].reason ∈ {inactive,unresolved,empty}` consistent between Task 4 impl and Task 7 CDS/test.
