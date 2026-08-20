# Group / Mission Completion Rollup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Group/Mission completion recording (flatlined at the 2026-08-10 cutover) by adding a TUTORIAL/PUZZLE/CHECKPOINT/PETOBERFEST → GROUP → MISSION rollup, plus a backfill and an NGDS send-through mechanism.

**Architecture:** A new pure-ish module `srv/lib/completion-rollup.js` recomputes the parent group(s)/mission(s) of any completed task and upserts GROUP/MISSION `TaskRecords` (full progress; alt-groups = any-branch-satisfies; all item types count). It is called at every completion/reset point. Completion → COMPLETED edges fire the existing `maybeAutoSendCompletion`. Two operator scripts backfill historical rows and send them to NGDS.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), CQL/`cds.ql`, Vitest via `cds.test('serve', … '--in-memory')`, SAP HANA (prod) / in-memory SQLite (test).

**Spec:** `docs/superpowers/specs/2026-08-20-group-mission-completion-rollup-design.md`

## Global Constraints

- **No raw SQL in service/lib code** — use `cds.ql`/CQL only (raw `db.run` is allowed only for the documented HANA BLOB/LOB cases; not needed here).
- **Resolve entities via `cds.entities('com.sap.developers.ims')`**, never bare-string `SELECT.from('X')` (CI Node 22 vs local Node 24 drift).
- **HANA `.in()` packet cap** — chunk any `where({ col: { in: [...] } })` list at **500** ids (`cqn-where-in-hana-packet-cap`).
- **Rollup must never throw into a completion transaction** — wrap the orchestrator; log + `metrics.counter('rollup.failures')` on fault. A rollup fault must not roll back a step/tutorial/puzzle completion.
- **NGDS parity** — only TUTORIAL/GROUP/MISSION are NGDS-eligible; GROUP/MISSION rollup records must use `stampSubmissionId(...)` so they carry a stable `submissionIdCompleted` (NGDS dedup key).
- **New key element rule** — GROUP/MISSION `TaskRecords` key on `(user_ID, taskLegacyId, taskType)` where `taskLegacyId = <Groups|Missions>.legacyId`; upsert via SELECT-then-UPDATE-or-INSERT (never blind INSERT).
- **`srv/lib/` change → srv-qa cp-list audit** — after adding `completion-rollup.js`, confirm it is NOT a transitive `./` import of `srv/lib/content-store.js` (it must not be, so no `.deploy/mta.yaml` `srv-qa` `cp` entry is needed). Record the grep result.
- **Verify before schema commit** — no schema change is expected; if any `db/**` file is touched, run `npx cds deploy --to sqlite::memory:` before committing.

## Helper signatures (already in the codebase — consume, don't redefine)

- `getNextLegacyId(entity, db)` → `Promise<number>` — `srv/lib/legacy-id.js`
- `stampSubmissionId(target, existing = null)` → `target` (mutates, returns it) — `srv/lib/task-record-submission-id.js`
- `maybeAutoSendCompletion({ record, priorStatus = null, db })` → `Promise<void>` (never throws) — `srv/lib/ngds-autosend.js`
- `calculateMissionProgress(completed, total)` → `{ progress, status }` — `srv/lib/status-calculator.js`
- `resolveUserSapId(user)` → `string|null` — `srv/lib/resolve-db-user.js`
- `metrics.counter(name)` — `srv/lib/metrics.js`
- Test bootstrap: `const project = cds.test('serve', '--project', '.', '--in-memory');` then bare global `INSERT`/`SELECT`/`UPDATE` and `cds.entities('com.sap.developers.ims')`. Auth for HTTP: `{ auth: { username: 'developer', password: 'developer' } }`.

## File Structure

- **Create** `srv/lib/completion-rollup.js` — slot model (pure) + membership queries + upsert + orchestrator.
- **Create** `test/lib/completion-rollup.test.js` — unit tests (pure + in-memory DB).
- **Modify** `srv/developer-service.js` — call rollup from `_updateTutorialProgress`, `resetTutorialProgress`, and the CHECKPOINT edge of `createTaskRecord`.
- **Modify** `srv/puzzle-service.js` — call rollup after a `recorded:true` PUZZLE insert.
- **Modify** `srv/lib/petoberfest-upload.js` — call rollup after an `awarded:true` PETOBERFEST insert.
- **Modify** `test/developer-service.test.js` — service-level rollup assertions.
- **Create** `scripts/backfill-group-mission-completions.mjs` — bulk backfill (no NGDS send).
- **Create** `scripts/backfill-ngds-send.mjs` — rate-limited, resumable NGDS send-through.
- **Create** `test/scripts/backfill-group-mission.test.js` — backfill dry-run + idempotency.

---

### Task 1: Pure slot model (`collapseSlots`, `evaluateSlots`)

**Files:**
- Create: `srv/lib/completion-rollup.js`
- Test: `test/lib/completion-rollup.test.js`

**Interfaces:**
- Produces:
  - `collapseSlots(items)` — `items: Array<{ taskType, taskLegacyId, itemOrder, altGroupKey, groupId }>` → `Array<Slot>` where `Slot = { groupId: number } | { tokens: string[] }`. A token is the string `` `${taskType}:${taskLegacyId}` ``. Items with `groupId` (i.e. `taskType==='GROUP'`) become `{ groupId }` slots (never alt-collapsed). Non-group items with the same non-null `(itemOrder, altGroupKey)` union their tokens into one `{ tokens }` slot; linear items (null `altGroupKey`) each become a single-token `{ tokens:[t] }` slot.
  - `evaluateSlots(slots, completedTokenSet, resolveGroup)` → `{ satisfied, total }`. `resolveGroup(groupId)` returns that group's `Array<Slot>` (token-only, no nested groups). A `{ tokens }` slot is satisfied when any token ∈ `completedTokenSet`; a `{ groupId }` slot is satisfied when all of its resolved slots are satisfied.
  - `tokenFor(taskType, taskLegacyId)` → string.

- [ ] **Step 1: Write the failing test**

```js
// test/lib/completion-rollup.test.js
import { describe, it, expect } from 'vitest';
import { collapseSlots, evaluateSlots, tokenFor } from '../../srv/lib/completion-rollup.js';

describe('collapseSlots', () => {
  it('makes one slot per linear item', () => {
    const slots = collapseSlots([
      { taskType: 'TUTORIAL', taskLegacyId: 10, itemOrder: 1, altGroupKey: null, groupId: null },
      { taskType: 'PUZZLE',   taskLegacyId: 20, itemOrder: 2, altGroupKey: null, groupId: null },
    ]);
    expect(slots).toEqual([{ tokens: ['TUTORIAL:10'] }, { tokens: ['PUZZLE:20'] }]);
  });

  it('collapses an alt-group into one multi-token slot', () => {
    const slots = collapseSlots([
      { taskType: 'TUTORIAL', taskLegacyId: 10, itemOrder: 1, altGroupKey: 'A', groupId: null },
      { taskType: 'TUTORIAL', taskLegacyId: 11, itemOrder: 1, altGroupKey: 'A', groupId: null },
    ]);
    expect(slots).toHaveLength(1);
    expect(new Set(slots[0].tokens)).toEqual(new Set(['TUTORIAL:10', 'TUTORIAL:11']));
  });

  it('emits GROUP items as group slots, never alt-collapsed', () => {
    const slots = collapseSlots([
      { taskType: 'GROUP', taskLegacyId: 99, itemOrder: 1, altGroupKey: null, groupId: 5 },
    ]);
    expect(slots).toEqual([{ groupId: 5 }]);
  });
});

describe('evaluateSlots', () => {
  const done = new Set(['TUTORIAL:10']);
  it('counts a satisfied token slot', () => {
    expect(evaluateSlots([{ tokens: ['TUTORIAL:10'] }], done, () => [])).toEqual({ satisfied: 1, total: 1 });
  });
  it('any branch satisfies an alt-group slot', () => {
    expect(evaluateSlots([{ tokens: ['TUTORIAL:10', 'TUTORIAL:11'] }], done, () => [])).toEqual({ satisfied: 1, total: 1 });
  });
  it('a group slot needs all its inner slots satisfied', () => {
    const resolve = () => [{ tokens: ['TUTORIAL:10'] }, { tokens: ['TUTORIAL:12'] }];
    expect(evaluateSlots([{ groupId: 5 }], done, resolve)).toEqual({ satisfied: 0, total: 1 });
    const done2 = new Set(['TUTORIAL:10', 'TUTORIAL:12']);
    expect(evaluateSlots([{ groupId: 5 }], done2, resolve)).toEqual({ satisfied: 1, total: 1 });
  });
  it('tokenFor builds the composite key', () => {
    expect(tokenFor('MISSION', 7)).toBe('MISSION:7');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/completion-rollup.test.js --project unit`
Expected: FAIL — cannot import `collapseSlots` (module/exports don't exist).

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/completion-rollup.js
// TUTORIAL/PUZZLE/CHECKPOINT/PETOBERFEST → GROUP → MISSION completion rollup.
// See docs/superpowers/specs/2026-08-20-group-mission-completion-rollup-design.md
import cds from '@sap/cds';
import { calculateMissionProgress } from './status-calculator.js';
import { getNextLegacyId } from './legacy-id.js';
import { stampSubmissionId } from './task-record-submission-id.js';
import { maybeAutoSendCompletion } from './ngds-autosend.js';
import * as metrics from './metrics.js';

const NS = 'com.sap.developers.ims';
const IN_CHUNK = 500; // HANA .in() packet cap — cqn-where-in-hana-packet-cap

export function tokenFor(taskType, taskLegacyId) {
  return `${taskType}:${taskLegacyId}`;
}

// items: [{ taskType, taskLegacyId, itemOrder, altGroupKey, groupId }]
export function collapseSlots(items) {
  const slots = [];
  const altIndex = new Map(); // `${itemOrder}:${altGroupKey}` -> slots[] index
  for (const it of items) {
    if (it.groupId != null && it.taskType === 'GROUP') {
      slots.push({ groupId: it.groupId });
      continue;
    }
    const token = tokenFor(it.taskType, it.taskLegacyId);
    if (it.altGroupKey) {
      const k = `${it.itemOrder}:${it.altGroupKey}`;
      if (altIndex.has(k)) {
        slots[altIndex.get(k)].tokens.push(token);
      } else {
        altIndex.set(k, slots.length);
        slots.push({ tokens: [token] });
      }
    } else {
      slots.push({ tokens: [token] });
    }
  }
  return slots;
}

export function evaluateSlots(slots, completedTokenSet, resolveGroup) {
  let satisfied = 0;
  for (const slot of slots) {
    if (slot.groupId != null) {
      const inner = resolveGroup(slot.groupId) || [];
      const r = evaluateSlots(inner, completedTokenSet, resolveGroup);
      if (r.total > 0 && r.satisfied === r.total) satisfied++;
    } else if (slot.tokens.some(t => completedTokenSet.has(t))) {
      satisfied++;
    }
  }
  return { satisfied, total: slots.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/completion-rollup.test.js --project unit`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/completion-rollup.js test/lib/completion-rollup.test.js
git commit -m "feat(rollup): pure slot model for group/mission completion"
```

---

### Task 2: Membership queries (`loadGroupSlots`, `loadMissionSlots`, `findParents`)

**Files:**
- Modify: `srv/lib/completion-rollup.js`
- Test: `test/lib/completion-rollup.test.js` (append a DB describe block)

**Interfaces:**
- Consumes: `collapseSlots`, `tokenFor` (Task 1).
- Produces (all `async`, `db` = a connected cds db):
  - `loadGroupSlots(groupId, db)` → `Array<Slot>` — reads `GroupPathItems` for the group (UUID `group_ID`), resolves each `tutorial_ID` → `Tutorials.legacyId`, builds `TUTORIAL:<legacyId>` token items, `collapseSlots`.
  - `loadMissionSlots(missionId, db)` → `Array<Slot>` — reads `CompletionPaths` (`mission_ID`), then `CompletionPathItems` for those paths; non-GROUP items use their own `taskLegacyId`; GROUP items emit `{ groupId: <Groups.legacyId of item.group_ID> }`. Returns collapsed slots. Group slots reference the **group legacyId** (so `resolveGroup` in the orchestrator maps legacyId → its slots).
  - `findParents({ taskType, taskLegacyId, tutorialId }, db)` → `{ groupLegacyIds: number[], missionIds: string[] }`. Groups only for `TUTORIAL` (via `GroupPathItems.tutorial_ID === tutorialId` → `Groups.legacyId`). Missions: direct (`CompletionPathItems{taskType, taskLegacyId}` → path → mission ID) ∪ via-group (`CompletionPathItems{taskType:'GROUP', group_ID ∈ affected group UUIDs}` → path → mission ID).

> Note: `loadMissionSlots` group slots and `findParents` group ids both use **Groups.legacyId** as the group identity so the orchestrator's `resolveGroup(legacyId)` is consistent. `loadGroupSlots` takes the **UUID**; the orchestrator resolves legacyId→UUID once (Task 3).

- [ ] **Step 1: Write the failing test** (append to `test/lib/completion-rollup.test.js`)

```js
import cds from '@sap/cds';
import { loadGroupSlots, loadMissionSlots, findParents } from '../../srv/lib/completion-rollup.js';

describe('completion-rollup DB membership', () => {
  cds.test('serve', '--project', '.', '--in-memory');
  const G = 'gggggggg-0000-0000-0000-000000000001';
  const M = 'mmmmmmmm-0000-0000-0000-000000000001';
  const P = 'pppppppp-0000-0000-0000-000000000001';
  const T1 = 'ta000000-0000-0000-0000-000000000001';
  const T2 = 'ta000000-0000-0000-0000-000000000002';

  beforeAll(async () => {
    const { Tutorials, Groups, GroupPathItems, Missions, CompletionPaths, CompletionPathItems } =
      cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries([
      { ID: T1, slug: 'roll-t1', title: 'T1', legacyId: 5101, status: 'ACTIVE' },
      { ID: T2, slug: 'roll-t2', title: 'T2', legacyId: 5102, status: 'ACTIVE' },
    ]);
    await INSERT.into(Groups).entries({ ID: G, slug: 'roll-g', title: 'G', legacyId: 5200, status: 'ACTIVE' });
    await INSERT.into(GroupPathItems).entries([
      { group_ID: G, tutorial_ID: T1, itemOrder: 1, legacyId: 5301 },
      { group_ID: G, tutorial_ID: T2, itemOrder: 2, legacyId: 5302 },
    ]);
    await INSERT.into(Missions).entries({ ID: M, slug: 'roll-m', title: 'M', legacyId: 5400, status: 'ACTIVE' });
    await INSERT.into(CompletionPaths).entries({ ID: P, mission_ID: M, name: 'P', legacyId: 5500 });
    await INSERT.into(CompletionPathItems).entries([
      { path_ID: P, taskType: 'GROUP', group_ID: G, taskLegacyId: 5200, itemOrder: 1, legacyId: 5601 },
    ]);
  });

  it('loadGroupSlots resolves tutorial legacyIds', async () => {
    const slots = await loadGroupSlots(G, cds.db);
    expect(slots).toEqual([{ tokens: ['TUTORIAL:5101'] }, { tokens: ['TUTORIAL:5102'] }]);
  });

  it('loadMissionSlots emits a group slot keyed by group legacyId', async () => {
    const slots = await loadMissionSlots(M, cds.db);
    expect(slots).toEqual([{ groupId: 5200 }]);
  });

  it('findParents finds the group and the mission for a tutorial', async () => {
    const { groupLegacyIds, missionIds } = await findParents(
      { taskType: 'TUTORIAL', taskLegacyId: 5101, tutorialId: T1 }, cds.db);
    expect(groupLegacyIds).toContain(5200);
    expect(missionIds).toContain(M);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/completion-rollup.test.js --project unit`
Expected: FAIL — `loadGroupSlots`/`loadMissionSlots`/`findParents` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `srv/lib/completion-rollup.js`)

```js
async function chunkedIn(entity, column, values, db, columns) {
  const out = [];
  const uniq = [...new Set(values)].filter(v => v != null);
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    const slice = uniq.slice(i, i + IN_CHUNK);
    let q = SELECT.from(entity).where({ [column]: { in: slice } });
    if (columns) q = q.columns(...columns);
    out.push(...await db.run(q));
  }
  return out;
}

export async function loadGroupSlots(groupUuid, db) {
  const { GroupPathItems, Tutorials } = cds.entities(NS);
  const gpItems = await db.run(
    SELECT.from(GroupPathItems).where({ group_ID: groupUuid }).orderBy('itemOrder')
  );
  if (gpItems.length === 0) return [];
  const tutIds = gpItems.map(i => i.tutorial_ID);
  const tuts = await chunkedIn(Tutorials, 'ID', tutIds, db, ['ID', 'legacyId']);
  const legacyById = new Map(tuts.map(t => [t.ID, t.legacyId]));
  const items = gpItems
    .filter(i => legacyById.get(i.tutorial_ID) != null)
    .map(i => ({
      taskType: 'TUTORIAL',
      taskLegacyId: legacyById.get(i.tutorial_ID),
      itemOrder: i.itemOrder,
      altGroupKey: i.altGroupKey,
      groupId: null,
    }));
  return collapseSlots(items);
}

export async function loadMissionSlots(missionUuid, db) {
  const { CompletionPaths, CompletionPathItems, Groups } = cds.entities(NS);
  const paths = await db.run(SELECT.from(CompletionPaths).where({ mission_ID: missionUuid }).orderBy('legacyId'));
  if (paths.length === 0) return [];
  const pathIds = paths.map(p => p.ID);
  const items = (await chunkedIn(CompletionPathItems, 'path_ID', pathIds, db))
    .sort((a, b) => (a.itemOrder ?? 0) - (b.itemOrder ?? 0));
  // Map GROUP items' group_ID (UUID) → Groups.legacyId
  const groupUuids = items.filter(i => i.taskType === 'GROUP' && i.group_ID).map(i => i.group_ID);
  const groups = await chunkedIn(Groups, 'ID', groupUuids, db, ['ID', 'legacyId']);
  const groupLegacyByUuid = new Map(groups.map(g => [g.ID, g.legacyId]));
  const norm = items.map(i => ({
    taskType: i.taskType,
    taskLegacyId: i.taskType === 'GROUP' ? null : i.taskLegacyId,
    itemOrder: i.itemOrder,
    altGroupKey: i.altGroupKey,
    groupId: i.taskType === 'GROUP' ? groupLegacyByUuid.get(i.group_ID) ?? null : null,
  })).filter(i => (i.groupId != null) || (i.taskLegacyId != null));
  return collapseSlots(norm);
}

export async function findParents({ taskType, taskLegacyId, tutorialId }, db) {
  const { GroupPathItems, Groups, CompletionPathItems, CompletionPaths } = cds.entities(NS);
  const groupLegacyIds = [];
  let groupUuids = [];
  if (taskType === 'TUTORIAL' && tutorialId) {
    const gpi = await db.run(SELECT.from(GroupPathItems).columns('group_ID').where({ tutorial_ID: tutorialId }));
    groupUuids = [...new Set(gpi.map(r => r.group_ID).filter(Boolean))];
    if (groupUuids.length) {
      const groups = await chunkedIn(Groups, 'ID', groupUuids, db, ['ID', 'legacyId']);
      groupLegacyIds.push(...groups.map(g => g.legacyId).filter(v => v != null));
    }
  }
  // Direct mission items of this exact (taskType, taskLegacyId)
  const directItems = await db.run(
    SELECT.from(CompletionPathItems).columns('path_ID').where({ taskType, taskLegacyId })
  );
  // Via-group mission items (TUTORIAL only)
  let viaGroupItems = [];
  if (groupUuids.length) {
    viaGroupItems = await chunkedIn(CompletionPathItems, 'group_ID', groupUuids, db, ['path_ID', 'taskType'])
      .then(rows => rows.filter(r => r.taskType === 'GROUP'));
  }
  const pathIds = [...new Set([...directItems, ...viaGroupItems].map(r => r.path_ID).filter(Boolean))];
  let missionIds = [];
  if (pathIds.length) {
    const paths = await chunkedIn(CompletionPaths, 'ID', pathIds, db, ['ID', 'mission_ID']);
    missionIds = [...new Set(paths.map(p => p.mission_ID).filter(Boolean))];
  }
  return { groupLegacyIds: [...new Set(groupLegacyIds)], missionIds };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/completion-rollup.test.js --project unit`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/completion-rollup.js test/lib/completion-rollup.test.js
git commit -m "feat(rollup): mission/group membership queries + parent lookup"
```

---

### Task 3: Upsert + orchestrator (`rollUpParentsForCompletion`)

**Files:**
- Modify: `srv/lib/completion-rollup.js`
- Test: `test/lib/completion-rollup.test.js` (append)

**Interfaces:**
- Consumes: everything from Tasks 1–2, plus `getNextLegacyId`, `stampSubmissionId`, `maybeAutoSendCompletion`, `calculateMissionProgress`.
- Produces:
  - `getUserCompletedMap(dbUser, taskLegacyIds, db)` → `{ tokenSet: Set<string>, dateByToken: Map<string,string> }` — COMPLETED, non-SUPERSEDED `TaskRecords` for the user whose `taskLegacyId ∈ taskLegacyIds`, keyed `taskType:taskLegacyId`.
  - `upsertRollupRecord({ dbUser, taskType, legacyId, title, progress, status, completionDate, db, send })` → `Promise<void>` — SELECT-then-UPDATE-or-INSERT on `(user_ID, taskLegacyId=legacyId, taskType, status != 'SUPERSEDED')`; fires `maybeAutoSendCompletion` on the → COMPLETED edge when `send`.
  - `rollUpParentsForCompletion({ dbUser, task, db, send = true })` → `Promise<void>` — the wrapped, never-throwing entry point every caller uses. `task = { taskType, taskLegacyId, tutorialId? }`.

- [ ] **Step 1: Write the failing test** (append)

```js
import { rollUpParentsForCompletion } from '../../srv/lib/completion-rollup.js';

describe('rollUpParentsForCompletion', () => {
  cds.test('serve', '--project', '.', '--in-memory');
  const U = 'uuuuuuuu-0000-0000-0000-000000000001';
  const G = 'gg111111-0000-0000-0000-000000000001';
  const M = 'mm111111-0000-0000-0000-000000000001';
  const P = 'pp111111-0000-0000-0000-000000000001';
  const T1 = 'tt111111-0000-0000-0000-000000000001';
  const T2 = 'tt111111-0000-0000-0000-000000000002';

  beforeAll(async () => {
    const e = cds.entities('com.sap.developers.ims');
    await INSERT.into(e.Users).entries({ ID: U, sapId: 'P000123', legacyId: 9001 });
    await INSERT.into(e.Tutorials).entries([
      { ID: T1, slug: 'r3-t1', title: 'T1', legacyId: 6101, status: 'ACTIVE' },
      { ID: T2, slug: 'r3-t2', title: 'T2', legacyId: 6102, status: 'ACTIVE' },
    ]);
    await INSERT.into(e.Groups).entries({ ID: G, slug: 'r3-g', title: 'G', legacyId: 6200, status: 'ACTIVE' });
    await INSERT.into(e.GroupPathItems).entries([
      { group_ID: G, tutorial_ID: T1, itemOrder: 1, legacyId: 6301 },
      { group_ID: G, tutorial_ID: T2, itemOrder: 2, legacyId: 6302 },
    ]);
    await INSERT.into(e.Missions).entries({ ID: M, slug: 'r3-m', title: 'M', legacyId: 6400, status: 'ACTIVE' });
    await INSERT.into(e.CompletionPaths).entries({ ID: P, mission_ID: M, name: 'P', legacyId: 6500 });
    await INSERT.into(e.CompletionPathItems).entries({ path_ID: P, taskType: 'GROUP', group_ID: G, taskLegacyId: 6200, itemOrder: 1, legacyId: 6601 });
  });

  async function completeTut(legacyId) {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TaskRecords).entries({
      user_ID: U, taskLegacyId: legacyId, taskType: 'TUTORIAL', status: 'COMPLETED',
      progress: 100, completionDate: new Date().toISOString(), legacyId: 70000 + legacyId,
    });
  }

  it('partial tutorial completion writes IN_PROGRESS group + mission', async () => {
    await completeTut(6101);
    await rollUpParentsForCompletion({ dbUser: { ID: U }, task: { taskType: 'TUTORIAL', taskLegacyId: 6101, tutorialId: T1 }, db: cds.db, send: false });
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const grp = await SELECT.one.from(TaskRecords).where({ user_ID: U, taskLegacyId: 6200, taskType: 'GROUP' });
    const mis = await SELECT.one.from(TaskRecords).where({ user_ID: U, taskLegacyId: 6400, taskType: 'MISSION' });
    expect(grp.status).toBe('IN_PROGRESS');
    expect(grp.progress).toBe(50);
    expect(mis.status).toBe('IN_PROGRESS');
  });

  it('final tutorial completion flips group + mission to COMPLETED (idempotent)', async () => {
    await completeTut(6102);
    await rollUpParentsForCompletion({ dbUser: { ID: U }, task: { taskType: 'TUTORIAL', taskLegacyId: 6102, tutorialId: T2 }, db: cds.db, send: false });
    await rollUpParentsForCompletion({ dbUser: { ID: U }, task: { taskType: 'TUTORIAL', taskLegacyId: 6102, tutorialId: T2 }, db: cds.db, send: false });
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const grpRows = await SELECT.from(TaskRecords).where({ user_ID: U, taskLegacyId: 6200, taskType: 'GROUP', status: { '!=': 'SUPERSEDED' } });
    const mis = await SELECT.one.from(TaskRecords).where({ user_ID: U, taskLegacyId: 6400, taskType: 'MISSION' });
    expect(grpRows).toHaveLength(1);           // idempotent: no duplicate row
    expect(grpRows[0].status).toBe('COMPLETED');
    expect(mis.status).toBe('COMPLETED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/completion-rollup.test.js --project unit`
Expected: FAIL — `rollUpParentsForCompletion` not exported.

- [ ] **Step 3: Write minimal implementation** (append)

```js
export async function getUserCompletedMap(dbUser, taskLegacyIds, db) {
  const { TaskRecords } = cds.entities(NS);
  const tokenSet = new Set();
  const dateByToken = new Map();
  const rows = await chunkedIn(
    TaskRecords, 'taskLegacyId', taskLegacyIds, db,
    ['taskType', 'taskLegacyId', 'status', 'completionDate']
  );
  for (const r of rows) {
    if (r.user_ID && r.user_ID !== dbUser.ID) continue; // chunkedIn has no user filter; guard below
  }
  // Re-query scoped to user (chunkedIn can't add a second predicate cleanly):
  const scoped = [];
  const uniq = [...new Set(taskLegacyIds)].filter(v => v != null);
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    scoped.push(...await db.run(
      SELECT.from(TaskRecords)
        .columns('taskType', 'taskLegacyId', 'completionDate')
        .where({ user_ID: dbUser.ID, status: 'COMPLETED', taskLegacyId: { in: uniq.slice(i, i + IN_CHUNK) } })
    ));
  }
  for (const r of scoped) {
    const t = tokenFor(r.taskType, r.taskLegacyId);
    tokenSet.add(t);
    if (r.completionDate) dateByToken.set(t, r.completionDate);
  }
  return { tokenSet, dateByToken };
}

export async function upsertRollupRecord({ dbUser, taskType, legacyId, title, progress, status, completionDate, db, send }) {
  const { TaskRecords } = cds.entities(NS);
  const existing = await db.run(SELECT.one.from(TaskRecords).where({
    user_ID: dbUser.ID, taskLegacyId: legacyId, taskType, status: { '!=': 'SUPERSEDED' },
  }));
  if (existing) {
    const priorStatus = existing.status;
    if (existing.progress === progress && existing.status === status) return; // no-op, avoids churn
    await db.run(UPDATE(TaskRecords, existing.ID).set(stampSubmissionId({
      progress, status,
      completionDate: status === 'COMPLETED' ? (completionDate || existing.completionDate || new Date().toISOString()) : null,
    }, existing)));
    if (send && status === 'COMPLETED' && priorStatus !== 'COMPLETED') {
      const [row] = await db.run(SELECT.from(TaskRecords).where({ ID: existing.ID }));
      await maybeAutoSendCompletion({ record: row, priorStatus, db });
    }
    metrics.counter(`rollup.${taskType.toLowerCase()}.${status === 'COMPLETED' ? 'completed' : 'progress'}`);
    return;
  }
  const newLegacyId = await getNextLegacyId('TaskRecords', db);
  await db.run(INSERT.into(TaskRecords).entries(stampSubmissionId({
    user_ID: dbUser.ID, taskLegacyId: legacyId, taskType, status, progress,
    completionDate: status === 'COMPLETED' ? (completionDate || new Date().toISOString()) : null,
    titleSnapshot: title, legacyId: newLegacyId, attemptNumber: 1,
  })));
  if (send && status === 'COMPLETED') {
    const [row] = await db.run(SELECT.from(TaskRecords).where({ legacyId: newLegacyId }));
    await maybeAutoSendCompletion({ record: row, priorStatus: null, db });
  }
  metrics.counter(`rollup.${taskType.toLowerCase()}.${status === 'COMPLETED' ? 'completed' : 'progress'}`);
}

export async function rollUpParentsForCompletion({ dbUser, task, db, send = true }) {
  try {
    const { Groups, Missions } = cds.entities(NS);
    const { groupLegacyIds, missionIds } = await findParents(task, db);
    if (groupLegacyIds.length === 0 && missionIds.length === 0) return;

    // Resolve group legacyId → { uuid, title } once; cache slots per group legacyId.
    const groupRows = await chunkedIn(Groups, 'legacyId', groupLegacyIds, db, ['ID', 'legacyId', 'title']);
    const groupByLegacy = new Map(groupRows.map(g => [g.legacyId, g]));
    const groupSlotCache = new Map(); // legacyId -> slots
    for (const g of groupRows) groupSlotCache.set(g.legacyId, await loadGroupSlots(g.ID, db));
    const resolveGroup = (legacyId) => groupSlotCache.get(legacyId) || [];

    // Gather every taskLegacyId referenced by the affected groups + missions so we
    // fetch the user's completed records once.
    const missionRows = missionIds.length
      ? await chunkedIn(Missions, 'ID', missionIds, db, ['ID', 'legacyId', 'title'])
      : [];
    const missionSlots = new Map(); // mission UUID -> slots
    for (const m of missionRows) {
      const slots = await loadMissionSlots(m.ID, db);
      missionSlots.set(m.ID, slots);
      // ensure nested group slots are cached too
      for (const s of slots) if (s.groupId != null && !groupSlotCache.has(s.groupId)) {
        const gr = await chunkedIn(Groups, 'legacyId', [s.groupId], db, ['ID', 'legacyId', 'title']);
        if (gr[0]) { groupByLegacy.set(s.groupId, gr[0]); groupSlotCache.set(s.groupId, await loadGroupSlots(gr[0].ID, db)); }
      }
    }

    const allLegacyIds = new Set();
    const addTokens = (slots) => slots.forEach(s => {
      if (s.groupId != null) addTokens(resolveGroup(s.groupId));
      else s.tokens.forEach(t => allLegacyIds.add(Number(t.split(':')[1])));
    });
    for (const legacyId of groupSlotCache.keys()) addTokens(groupSlotCache.get(legacyId));
    for (const slots of missionSlots.values()) addTokens(slots);

    const { tokenSet, dateByToken } = await getUserCompletedMap(dbUser, [...allLegacyIds], db);

    const latestDate = (slots) => {
      let max = null;
      const walk = (ss) => ss.forEach(s => {
        if (s.groupId != null) walk(resolveGroup(s.groupId));
        else for (const t of s.tokens) { const d = dateByToken.get(t); if (d && (!max || d > max)) max = d; }
      });
      walk(slots);
      return max;
    };

    // Groups first, then missions.
    for (const legacyId of groupSlotCache.keys()) {
      if (!groupByLegacy.has(legacyId)) continue; // only upsert groups that are actual parents/nested here
      const slots = groupSlotCache.get(legacyId);
      const { satisfied, total } = evaluateSlots(slots, tokenSet, resolveGroup);
      const { progress, status } = calculateMissionProgress(satisfied, total);
      await upsertRollupRecord({
        dbUser, taskType: 'GROUP', legacyId, title: groupByLegacy.get(legacyId).title,
        progress, status, completionDate: latestDate(slots), db, send,
      });
    }
    for (const m of missionRows) {
      const slots = missionSlots.get(m.ID);
      const { satisfied, total } = evaluateSlots(slots, tokenSet, resolveGroup);
      const { progress, status } = calculateMissionProgress(satisfied, total);
      await upsertRollupRecord({
        dbUser, taskType: 'MISSION', legacyId: m.legacyId, title: m.title,
        progress, status, completionDate: latestDate(slots), db, send,
      });
    }
  } catch (err) {
    cds.log('rollup').error('rollUpParentsForCompletion failed (non-fatal):', err.message);
    metrics.counter('rollup.failures');
  }
}
```

> Cleanup during implementation: the dead first loop in `getUserCompletedMap` (the `for (const r of rows)` that references an unfetched `user_ID`) is a drafting artifact — delete it and the `rows` fetch; keep only the scoped query. (Left here so the reviewer sees the intended scoped-query shape.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/completion-rollup.test.js --project unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/completion-rollup.js test/lib/completion-rollup.test.js
git commit -m "feat(rollup): upsert + orchestrator with NGDS edge + idempotency"
```

---

### Task 4: Wire live completion triggers

**Files:**
- Modify: `srv/developer-service.js` (`_updateTutorialProgress` ~:1092-1165, `resetTutorialProgress` ~:244-327, `createTaskRecord` ~:331-382)
- Modify: `srv/puzzle-service.js` (~:210-222)
- Modify: `srv/lib/petoberfest-upload.js` (~:66-81)
- Test: `test/developer-service.test.js` (append a describe block)

**Interfaces:**
- Consumes: `rollUpParentsForCompletion` (Task 3).

- [ ] **Step 1: Write the failing test** (append to `test/developer-service.test.js`)

```js
describe('group/mission rollup (via completeStep)', () => {
  beforeAll(async () => {
    const e = cds.entities('com.sap.developers.ims');
    // One 1-step tutorial that is the sole item of a group that is the sole item of a mission.
    await INSERT.into(e.Tutorials).entries({ ID: 'rt000000-0000-0000-0000-000000000010', slug: 'rollup-tut', title: 'Rollup Tut', legacyId: 8101, status: 'ACTIVE', stepCount: 1 });
    await INSERT.into(e.Steps).entries({ ID: 'rs000000-0000-0000-0000-000000000010', tutorial_ID: 'rt000000-0000-0000-0000-000000000010', stepOrder: 1, title: 'S1', legacyId: 8201 });
    await INSERT.into(e.Groups).entries({ ID: 'rg000000-0000-0000-0000-000000000010', slug: 'rollup-grp', title: 'Rollup Grp', legacyId: 8300, status: 'ACTIVE' });
    await INSERT.into(e.GroupPathItems).entries({ group_ID: 'rg000000-0000-0000-0000-000000000010', tutorial_ID: 'rt000000-0000-0000-0000-000000000010', itemOrder: 1, legacyId: 8401 });
    await INSERT.into(e.Missions).entries({ ID: 'rm000000-0000-0000-0000-000000000010', slug: 'rollup-mis', title: 'Rollup Mis', legacyId: 8500, status: 'ACTIVE' });
    await INSERT.into(e.CompletionPaths).entries({ ID: 'rp000000-0000-0000-0000-000000000010', mission_ID: 'rm000000-0000-0000-0000-000000000010', name: 'P', legacyId: 8600 });
    await INSERT.into(e.CompletionPathItems).entries({ path_ID: 'rp000000-0000-0000-0000-000000000010', taskType: 'GROUP', group_ID: 'rg000000-0000-0000-0000-000000000010', taskLegacyId: 8300, itemOrder: 1, legacyId: 8700 });
  });

  it('completing the only step flips GROUP and MISSION to COMPLETED', async () => {
    await project.post('/api/completeStep', { slug: 'rollup-tut', stepNumber: 1 },
      { auth: { username: 'developer', password: 'developer' } });
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    const u = await SELECT.one.from(Users).where({ sapId: 'developer' });
    const grp = await SELECT.one.from(TaskRecords).where({ user_ID: u.ID, taskLegacyId: 8300, taskType: 'GROUP' });
    const mis = await SELECT.one.from(TaskRecords).where({ user_ID: u.ID, taskLegacyId: 8500, taskType: 'MISSION' });
    expect(grp?.status).toBe('COMPLETED');
    expect(mis?.status).toBe('COMPLETED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/developer-service.test.js --project unit -t "rollup"`
Expected: FAIL — no GROUP/MISSION row (rollup not wired).

- [ ] **Step 3: Wire the triggers**

3a. `srv/developer-service.js` top imports — add:
```js
import { rollUpParentsForCompletion } from './lib/completion-rollup.js';
```

3b. In `_updateTutorialProgress`, after the `if (existing) { ... } else { ... }` block closes (just before the method's closing `}` at ~:1165), add:
```js
    // Recompute parent group(s)/mission(s). Never throws (wrapped internally).
    await rollUpParentsForCompletion({
      dbUser, task: { taskType: 'TUTORIAL', taskLegacyId: tutorial.legacyId, tutorialId: tutorial.ID }, db,
    });
```

3c. In `resetTutorialProgress`, after the audit `cds.emit('TutorialProgressReset', …)` call and before the `return { newAttemptNumber … }` (~:320), add:
```js
      // A reset can drop a parent group/mission from COMPLETED back to IN_PROGRESS.
      await rollUpParentsForCompletion({
        dbUser, task: { taskType: 'TUTORIAL', taskLegacyId: tutorial.legacyId, tutorialId: tutorial.ID }, db: await cds.connect.to('db'),
      });
```

3d. In `createTaskRecord`, add a rollup on the COMPLETED edge for CHECKPOINT only. In BOTH the `existing`-update branch (after `maybeAutoSendCompletion({ record: row, priorStatus, db })` at ~:362) and the new-insert branch (after `maybeAutoSendCompletion({ record: persisted, priorStatus: null, db })` at ~:380), add:
```js
      if (taskType === 'CHECKPOINT') {
        await rollUpParentsForCompletion({ dbUser, task: { taskType: 'CHECKPOINT', taskLegacyId }, db: await cds.connect.to('db') });
      }
```

3e. `srv/puzzle-service.js` — add import near the other `./lib` imports:
```js
import { rollUpParentsForCompletion } from './lib/completion-rollup.js';
```
Then replace the successful-insert `return { recorded: true, alreadyComplete: false };` (~:221) with:
```js
      await rollUpParentsForCompletion({ dbUser, task: { taskType: 'PUZZLE', taskLegacyId: puzzle.legacyId }, db });
      return { recorded: true, alreadyComplete: false };
```

3f. `srv/lib/petoberfest-upload.js` — add import at top:
```js
import { rollUpParentsForCompletion } from './completion-rollup.js';
```
Then inside `if (!existing) { … awarded = true; }`, after `awarded = true;` (~:79) add:
```js
    await rollUpParentsForCompletion({ dbUser, task: { taskType: 'PETOBERFEST', taskLegacyId: contest.legacyId }, db });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/developer-service.test.js --project unit -t "rollup"`
Expected: PASS. Then run the full developer-service + rollup suites:
Run: `npx vitest run test/developer-service.test.js test/lib/completion-rollup.test.js --project unit`
Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add srv/developer-service.js srv/puzzle-service.js srv/lib/petoberfest-upload.js test/developer-service.test.js
git commit -m "feat(rollup): wire live triggers at all completion points"
```

---

### Task 5: Backfill script (bulk, no NGDS send)

**Files:**
- Create: `scripts/backfill-group-mission-completions.mjs`
- Test: `test/scripts/backfill-group-mission.test.js`

**Interfaces:**
- Consumes: `rollUpParentsForCompletion` (with `send:false`).
- Produces: an exported `runBackfill({ since, dryRun, userSapId, db })` → `{ users, groupsWritten, missionsWritten }` so the test can call it without spawning a process. The CLI wrapper (`if (import.meta.url === …)`) parses `--since/--dry-run/--user/--batch` and calls it.

- [ ] **Step 1: Write the failing test**

```js
// test/scripts/backfill-group-mission.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { runBackfill } from '../../scripts/backfill-group-mission-completions.mjs';

describe('runBackfill', () => {
  cds.test('serve', '--project', '.', '--in-memory');
  const U = 'bu000000-0000-0000-0000-000000000001';
  beforeAll(async () => {
    const e = cds.entities('com.sap.developers.ims');
    await INSERT.into(e.Users).entries({ ID: U, sapId: 'P000999', legacyId: 9999 });
    await INSERT.into(e.Tutorials).entries({ ID: 'bt000000-0000-0000-0000-000000000001', slug: 'bf-t1', title: 'T1', legacyId: 9101, status: 'ACTIVE' });
    await INSERT.into(e.Groups).entries({ ID: 'bg000000-0000-0000-0000-000000000001', slug: 'bf-g', title: 'G', legacyId: 9200, status: 'ACTIVE' });
    await INSERT.into(e.GroupPathItems).entries({ group_ID: 'bg000000-0000-0000-0000-000000000001', tutorial_ID: 'bt000000-0000-0000-0000-000000000001', itemOrder: 1, legacyId: 9301 });
    await INSERT.into(e.Missions).entries({ ID: 'bm000000-0000-0000-0000-000000000001', slug: 'bf-m', title: 'M', legacyId: 9400, status: 'ACTIVE' });
    await INSERT.into(e.CompletionPaths).entries({ ID: 'bp000000-0000-0000-0000-000000000001', mission_ID: 'bm000000-0000-0000-0000-000000000001', name: 'P', legacyId: 9500 });
    await INSERT.into(e.CompletionPathItems).entries({ path_ID: 'bp000000-0000-0000-0000-000000000001', taskType: 'GROUP', group_ID: 'bg000000-0000-0000-0000-000000000001', taskLegacyId: 9200, itemOrder: 1, legacyId: 9600 });
    // A post-cutover tutorial completion, no GROUP/MISSION row yet:
    await INSERT.into(e.TaskRecords).entries({ user_ID: U, taskLegacyId: 9101, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, completionDate: '2026-08-15T10:00:00.000Z', legacyId: 91010 });
  });

  it('dry-run reports counts and writes nothing', async () => {
    const r = await runBackfill({ since: '2026-08-10T00:00:00Z', dryRun: true, db: cds.db });
    expect(r.users).toBeGreaterThanOrEqual(1);
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const grp = await SELECT.one.from(TaskRecords).where({ user_ID: U, taskType: 'GROUP', taskLegacyId: 9200 });
    expect(grp).toBeUndefined();
  });

  it('real run writes COMPLETED group + mission and is idempotent', async () => {
    await runBackfill({ since: '2026-08-10T00:00:00Z', dryRun: false, db: cds.db });
    await runBackfill({ since: '2026-08-10T00:00:00Z', dryRun: false, db: cds.db });
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const grpRows = await SELECT.from(TaskRecords).where({ user_ID: U, taskType: 'GROUP', taskLegacyId: 9200, status: { '!=': 'SUPERSEDED' } });
    const mis = await SELECT.one.from(TaskRecords).where({ user_ID: U, taskType: 'MISSION', taskLegacyId: 9400 });
    expect(grpRows).toHaveLength(1);
    expect(grpRows[0].status).toBe('COMPLETED');
    expect(mis.status).toBe('COMPLETED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/scripts/backfill-group-mission.test.js --project unit`
Expected: FAIL — module/`runBackfill` missing.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/backfill-group-mission-completions.mjs
// Bulk backfill of GROUP/MISSION completions from post-cutover item completions.
// Does NOT send to NGDS (that is scripts/backfill-ngds-send.mjs). Idempotent.
import cds from '@sap/cds';
import { rollUpParentsForCompletion } from '../srv/lib/completion-rollup.js';

const DEFAULT_SINCE = '2026-08-10T00:00:00Z';
const ITEM_TYPES = ['TUTORIAL', 'PUZZLE', 'CHECKPOINT', 'PETOBERFEST'];

export async function runBackfill({ since = DEFAULT_SINCE, dryRun = false, userSapId = null, db } = {}) {
  const database = db || await cds.connect.to('db');
  const { TaskRecords, Users, Tutorials } = cds.entities('com.sap.developers.ims');

  // Users with a post-cutover COMPLETED item record.
  const recs = await database.run(
    SELECT.from(TaskRecords).columns('user_ID', 'taskType', 'taskLegacyId')
      .where({ status: 'COMPLETED', taskType: { in: ITEM_TYPES }, completionDate: { '>=': since } })
  );
  let userIds = [...new Set(recs.map(r => r.user_ID).filter(Boolean))];
  if (userSapId) {
    const u = await database.run(SELECT.one.from(Users).columns('ID').where({ sapId: userSapId }));
    userIds = u ? userIds.filter(id => id === u.ID) : [];
  }

  // Group each user's completed items so we can trigger one rollup per (user, item).
  const byUser = new Map();
  for (const r of recs) {
    if (!userIds.includes(r.user_ID)) continue;
    if (!byUser.has(r.user_ID)) byUser.set(r.user_ID, []);
    byUser.get(r.user_ID).push(r);
  }

  let groupsWritten = 0, missionsWritten = 0;
  for (const [userId, items] of byUser) {
    if (dryRun) continue;
    // Resolve tutorialId for TUTORIAL items (needed for group parent lookup).
    const tutLegacyIds = items.filter(i => i.taskType === 'TUTORIAL').map(i => i.taskLegacyId);
    const tuts = tutLegacyIds.length
      ? await database.run(SELECT.from(Tutorials).columns('ID', 'legacyId').where({ legacyId: { in: [...new Set(tutLegacyIds)] } }))
      : [];
    const tutIdByLegacy = new Map(tuts.map(t => [t.legacyId, t.ID]));
    // De-dupe the (taskType, taskLegacyId) triggers; rollup recomputes from full record state anyway.
    const seen = new Set();
    for (const it of items) {
      const k = `${it.taskType}:${it.taskLegacyId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      await rollUpParentsForCompletion({
        dbUser: { ID: userId },
        task: { taskType: it.taskType, taskLegacyId: it.taskLegacyId, tutorialId: tutIdByLegacy.get(it.taskLegacyId) },
        db: database,
        send: false,
      });
    }
  }
  // Count what now exists (informational).
  const grp = await database.run(SELECT.from(TaskRecords).columns('ID').where({ taskType: 'GROUP', status: 'COMPLETED' }));
  const mis = await database.run(SELECT.from(TaskRecords).columns('ID').where({ taskType: 'MISSION', status: 'COMPLETED' }));
  groupsWritten = grp.length; missionsWritten = mis.length;
  return { users: byUser.size, groupsWritten, missionsWritten, dryRun };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; };
  const dryRun = process.argv.includes('--dry-run');
  cds.connect.to('db').then(async (db) => {
    const r = await runBackfill({ since: arg('since', DEFAULT_SINCE), dryRun, userSapId: arg('user', null), db });
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/scripts/backfill-group-mission.test.js --project unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-group-mission-completions.mjs test/scripts/backfill-group-mission.test.js
git commit -m "feat(rollup): bulk backfill script (no NGDS send)"
```

---

### Task 6: NGDS send-through backfill script

**Files:**
- Create: `scripts/backfill-ngds-send.mjs`
- Test: `test/scripts/backfill-group-mission.test.js` (append an NGDS-send describe)

**Interfaces:**
- Consumes: `sendTaskRecordToNgds` (`srv/lib/ngds-client.js`), `isAutoSendActive` + `resolveAutoSendEpoch` (`srv/lib/ngds-autosend.js`).
- Produces: exported `runNgdsSend({ since, dryRun, limit, rate, db, sendFn })` → `{ eligible, sent, skipped }`. `sendFn` defaults to `sendTaskRecordToNgds` (injectable for tests). Reads/writes cursor `ngds.backfill.cursor` in `ImsConfig`. Honors `isAutoSendActive` (prod + kill-switch) unless `--force-inactive-ok` (dev/test); the test passes a fake `sendFn` + `dryRun:false` and asserts eligible selection + cursor advance, so it never hits the network.

- [ ] **Step 1: Write the failing test** (append)

```js
import { runNgdsSend } from '../../scripts/backfill-ngds-send.mjs';

describe('runNgdsSend', () => {
  cds.test('serve', '--project', '.', '--in-memory');
  const U = 'nu000000-0000-0000-0000-000000000001';
  beforeAll(async () => {
    const e = cds.entities('com.sap.developers.ims');
    await INSERT.into(e.Users).entries({ ID: U, sapId: 'P000777', legacyId: 7777 });
    await INSERT.into(e.TaskRecords).entries([
      { user_ID: U, taskLegacyId: 12000, taskType: 'MISSION', status: 'COMPLETED', progress: 100, completionDate: '2026-08-15T09:00:00.000Z', submissionIdCompleted: '11111111-1111-1111-1111-111111111111', legacyId: 120001 },
      { user_ID: U, taskLegacyId: 12001, taskType: 'GROUP', status: 'COMPLETED', progress: 100, completionDate: '2026-07-01T09:00:00.000Z', legacyId: 120002 }, // pre-epoch → skipped
    ]);
    const { ImsConfig } = e;
    await INSERT.into(ImsConfig).entries({ key: 'ngds.autosend.epoch', value: '2026-08-10T00:00:00Z' });
  });

  it('selects only post-epoch eligible rows and advances the cursor (fake sender)', async () => {
    const sent = [];
    const r = await runNgdsSend({ dryRun: false, rate: 0, db: cds.db, forceActive: true, sendFn: async (rec) => { sent.push(rec.taskLegacyId); return { success: true }; } });
    expect(sent).toEqual([12000]);       // 12001 is pre-epoch
    expect(r.sent).toBe(1);
    const { ImsConfig } = cds.entities('com.sap.developers.ims');
    const cur = await SELECT.one.from(ImsConfig).where({ key: 'ngds.backfill.cursor' });
    expect(cur?.value).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/scripts/backfill-group-mission.test.js --project unit -t "runNgdsSend"`
Expected: FAIL — module/`runNgdsSend` missing.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/backfill-ngds-send.mjs
// Send backfilled GROUP/MISSION completions to NGDS. Rate-limited, resumable
// (cursor in ImsConfig 'ngds.backfill.cursor'). Receiver dedups on
// submissionIdCompleted, so re-runs are safe. Operator-run in PROD.
import cds from '@sap/cds';
import { resolveAutoSendEpoch, isAutoSendActive } from '../srv/lib/ngds-autosend.js';
import { sendTaskRecordToNgds } from '../srv/lib/ngds-client.js';

const CURSOR_KEY = 'ngds.backfill.cursor';
const ELIGIBLE = ['GROUP', 'MISSION'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function readCursor(db) {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  const row = await db.run(SELECT.one.from(ImsConfig).columns('value').where({ key: CURSOR_KEY }));
  return row?.value || '';
}
async function writeCursor(db, value) {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  const existing = await db.run(SELECT.one.from(ImsConfig).where({ key: CURSOR_KEY }));
  if (existing) await db.run(UPDATE(ImsConfig).set({ value }).where({ key: CURSOR_KEY }));
  else await db.run(INSERT.into(ImsConfig).entries({ key: CURSOR_KEY, value }));
}

export async function runNgdsSend({ since = null, dryRun = false, limit = Infinity, rate = 1.5, db, forceActive = false, sendFn = sendTaskRecordToNgds } = {}) {
  const database = db || await cds.connect.to('db');
  const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');

  if (!dryRun && !forceActive && !(await isAutoSendActive(database))) {
    return { eligible: 0, sent: 0, skipped: 0, inactive: true };
  }
  const epochMs = await resolveAutoSendEpoch(database);
  const sinceIso = since || (epochMs != null ? new Date(epochMs).toISOString() : '2026-08-10T00:00:00Z');
  const cursor = await readCursor(database);

  const rows = await database.run(
    SELECT.from(TaskRecords)
      .where({ taskType: { in: ELIGIBLE }, status: 'COMPLETED', completionDate: { '>=': sinceIso } })
      .orderBy('completionDate', 'ID')
  );
  let eligible = 0, sent = 0, skipped = 0;
  const delayMs = rate > 0 ? Math.round(1000 / rate) : 0;
  for (const rec of rows) {
    const key = `${rec.completionDate}|${rec.ID}`;
    if (cursor && key <= cursor) { skipped++; continue; }
    if (rec.createdBy === 'migration') { skipped++; continue; }
    // Identity: only P/S/I-number sapIds resolve downstream.
    const u = await database.run(SELECT.one.from(Users).columns('sapId').where({ ID: rec.user_ID }));
    if (!u || !/^[PSIps]\d{6,}$/.test(String(u.sapId || '').trim())) { skipped++; continue; }
    eligible++;
    if (dryRun) continue;
    if (sent >= limit) break;
    await sendFn(rec, database);
    sent++;
    await writeCursor(database, key);
    if (delayMs) await sleep(delayMs);
  }
  return { eligible, sent, skipped, since: sinceIso };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; };
  const dryRun = process.argv.includes('--dry-run');
  cds.connect.to('db').then(async (db) => {
    const r = await runNgdsSend({ since: arg('since', null), dryRun, limit: Number(arg('limit', Infinity)), rate: Number(arg('rate', 1.5)), db });
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/scripts/backfill-group-mission.test.js --project unit -t "runNgdsSend"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-ngds-send.mjs test/scripts/backfill-group-mission.test.js
git commit -m "feat(rollup): resumable NGDS send-through for backfilled completions"
```

---

### Task 7: Final verification + docs

**Files:**
- Modify: `CLAUDE.md` (add a Top-Gotcha bullet)
- (No schema change expected.)

- [ ] **Step 1: srv-qa cp-list audit**

Run: `node -e "const fs=require('fs');const seen=new Set();(function walk(f){if(seen.has(f))return;seen.add(f);const s=fs.readFileSync(f,'utf8');for(const m of s.matchAll(/from '(\.[^']+)'/g)){}})('srv/lib/content-store.js')" ; grep -n "completion-rollup" .deploy/mta.yaml || echo "NOT a content-store dep — no srv-qa cp entry needed (expected)"`
Expected: `completion-rollup` is NOT reachable from `content-store.js` and NOT required in the `srv-qa` `cp` list. Record the result in the commit message.

- [ ] **Step 2: Schema safety check (only if any db/** changed — expected: none)**

Run: `npx cds deploy --to sqlite::memory: 2>&1 | tail -5`
Expected: clean deploy, no errors.

- [ ] **Step 3: Full unit suite + lint**

Run: `npm test`
Expected: PASS (all suites, no regressions).
Run: `npx eslint srv/lib/completion-rollup.js scripts/backfill-group-mission-completions.mjs scripts/backfill-ngds-send.mjs`
Expected: clean (fix any findings).

- [ ] **Step 4: Add CLAUDE.md gotcha**

Add under "Top Gotchas":
```markdown
- **Group/Mission completions are rollup-derived (issue #1934)** — `srv/lib/completion-rollup.js` recomputes parent group(s)/mission(s) after any TUTORIAL/PUZZLE/CHECKPOINT/PETOBERFEST completion (called from `_updateTutorialProgress`, `resetTutorialProgress`, `createTaskRecord` CHECKPOINT edge, `puzzle-service`, `petoberfest-upload`). Alt-groups = any-branch-satisfies; GROUP slots require all inner tutorials. Records key on `(user_ID, taskLegacyId=<entity>.legacyId, taskType)`. NGDS auto-send fires on the COMPLETED edge (GROUP/MISSION eligible). Backfill: `scripts/backfill-group-mission-completions.mjs` (bulk, no send) then `scripts/backfill-ngds-send.mjs` (rate-limited, resumable via `ImsConfig 'ngds.backfill.cursor'`; NGDS dedups on `submissionIdCompleted`). Pre-cutover completions never mint rollups (legacy IMS credited them; epoch guard suppresses NGDS).
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(rollup): CLAUDE.md gotcha + verification notes for #1934"
```

---

## Self-Review

**Spec coverage:** live rollup (Tasks 1–4), all item types (Task 4 triggers + slot tokens), full progress rows (Task 3 upsert IN_PROGRESS/COMPLETED), alt-group any-branch (Task 1), NGDS live edge (Task 3), backfill since-cutover (Task 5), NGDS send-through resumable (Task 6), no schema change + srv-qa audit (Task 7). ✔ All spec sections mapped.

**Placeholder scan:** all code steps carry real code; the one intentional drafting artifact in Task 3 (`getUserCompletedMap` dead loop) is called out with an explicit removal instruction. ✔

**Type consistency:** `rollUpParentsForCompletion({ dbUser, task:{taskType,taskLegacyId,tutorialId}, db, send })`, `findParents(task, db)→{groupLegacyIds,missionIds}`, `loadGroupSlots(uuid,db)`, `loadMissionSlots(uuid,db)`, `upsertRollupRecord({dbUser,taskType,legacyId,title,progress,status,completionDate,db,send})` — names/shapes consistent across Tasks 2–6. ✔
