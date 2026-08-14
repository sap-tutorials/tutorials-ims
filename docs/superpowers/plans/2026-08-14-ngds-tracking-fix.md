# NGDS `trackingInfo.tracking` Parity Fix, Backfill & Resend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every TaskRecord carry a stable `submissionId` UUID (= NGDS `trackingInfo.tracking`) with 100% legacy parity, backfill historical rows, and provide a gated PROD resend of previously-filtered NGDS messages.

**Architecture:** A pure `stampSubmissionId` helper is applied at every status-bearing TaskRecord write across all services, reproducing legacy's `@PrePersist/@PreUpdate` only-if-null UUID stamping. Two idempotent operational scripts (thin CLI + unit-testable core lib) backfill missing ids and resend eligible completions via the existing `sendTaskRecordToNgds` path (failures queue to `NGDSFailedMessages`, drained by the 2h `ngds-retry` job).

**Tech Stack:** SAP CAP (Node.js, ESM), `@sap/cds` CQL, vitest (`cds.test('serve','--in-memory')`), scripts run via `cds bind --exec -- node`.

**Spec:** `docs/superpowers/specs/2026-08-14-ngds-tracking-fix-design.md`

## Global Constraints

- **Never write raw SQL** — use `cds.ql`/CQL only (backfill/resend included). A per-row `UPDATE(Entity, ID).set(...)` is required because each row needs a distinct UUID (single bulk UPDATE cannot assign unique values); this is the known row-by-row tradeoff — batch in a `db.tx` and log progress.
- **`submissionId*` columns already exist** on `TaskRecords` — **no schema change**, no `cds deploy` migration.
- **srv-qa cp-list audit** — the new `srv/lib/task-record-submission-id.js` is imported by `srv/lib/content-store.js` (already in the list), so it **must** be added to the `tutorials-srv-qa` `cp … srv/lib/` command in `.deploy/mta.yaml:164`, or QA boot crashes at MTA deploy.
- **Send parity is separate from data parity** — the `TUTORIAL/GROUP/MISSION` send allowlist in `maybeAutoSendCompletion` is unchanged; stamping applies to ALL task types.
- **PR over direct merge** — open `gh pr create`; never push to `main`.
- **Windows repo** — preserve line endings; do not reformat untouched lines.
- **Verify for real** — run the actual vitest suites and show output before claiming done.

---

### Task 1: `stampSubmissionId` helper

**Files:**
- Create: `srv/lib/task-record-submission-id.js`
- Test: `test/unit/task-record-submission-id.test.js`

**Interfaces:**
- Produces: `stampSubmissionId(target, existing = null) → target` (mutates and returns `target`). Sets `target.submissionIdCompleted = cds.utils.uuid()` when the effective status is `COMPLETED` and neither `target` nor `existing` already has it; sets `target.submissionIdStarted` analogously for `IN_PROGRESS`; no-op for any other status. Effective status = `target.status ?? existing?.status`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/task-record-submission-id.test.js
import { describe, it, expect } from 'vitest';
import { stampSubmissionId } from '../../srv/lib/task-record-submission-id.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('stampSubmissionId', () => {
  it('stamps submissionIdCompleted on a COMPLETED INSERT target', () => {
    const t = stampSubmissionId({ status: 'COMPLETED' });
    expect(t.submissionIdCompleted).toMatch(UUID_RE);
    expect(t.submissionIdStarted).toBeUndefined();
  });

  it('stamps submissionIdStarted on an IN_PROGRESS INSERT target', () => {
    const t = stampSubmissionId({ status: 'IN_PROGRESS' });
    expect(t.submissionIdStarted).toMatch(UUID_RE);
    expect(t.submissionIdCompleted).toBeUndefined();
  });

  it('is a no-op for SUPERSEDED (and any non-completion status)', () => {
    expect(stampSubmissionId({ status: 'SUPERSEDED' })).toEqual({ status: 'SUPERSEDED' });
  });

  it('uses existing row status on an UPDATE .set() with no status', () => {
    const set = stampSubmissionId({ progress: 100 }, { status: 'COMPLETED' });
    expect(set.submissionIdCompleted).toMatch(UUID_RE);
  });

  it('honors only-if-null: keeps an id already on the existing row', () => {
    const set = stampSubmissionId({ status: 'COMPLETED' }, { status: 'IN_PROGRESS', submissionIdCompleted: 'keep-me' });
    expect(set.submissionIdCompleted).toBeUndefined(); // not re-generated onto target
  });

  it('honors only-if-null: keeps an id already on the target', () => {
    const t = stampSubmissionId({ status: 'COMPLETED', submissionIdCompleted: 'preset' });
    expect(t.submissionIdCompleted).toBe('preset');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/task-record-submission-id.test.js`
Expected: FAIL — cannot resolve `../../srv/lib/task-record-submission-id.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/task-record-submission-id.js
import cds from '@sap/cds';

// Stamp the legacy submission-id onto a TaskRecord write payload, mirroring
// com.sap.developers.ims TaskRecord.updateTaskRecordStatus (@PrePersist/@PreUpdate):
// a UUID is generated once, only-if-null, based on the row's status. The id is
// stable so every (re)send uses the same NGDS trackingInfo.tracking value.
//   target   — the object being written (INSERT .entries() or UPDATE .set()).
//   existing — the current DB row on an UPDATE (optional), so we never regenerate
//              a stable id and can read status when the .set() omits it.
// No-op for any status other than COMPLETED / IN_PROGRESS (e.g. SUPERSEDED).
export function stampSubmissionId(target, existing = null) {
  const status = target.status ?? existing?.status;
  if (status === 'COMPLETED') {
    if (!target.submissionIdCompleted && !existing?.submissionIdCompleted) {
      target.submissionIdCompleted = cds.utils.uuid();
    }
  } else if (status === 'IN_PROGRESS') {
    if (!target.submissionIdStarted && !existing?.submissionIdStarted) {
      target.submissionIdStarted = cds.utils.uuid();
    }
  }
  return target;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/task-record-submission-id.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/task-record-submission-id.js test/unit/task-record-submission-id.test.js
git commit -m "feat(ngds): stampSubmissionId helper for legacy trackingInfo.tracking parity"
```

---

### Task 2: Wire the helper into `developer-service.js` (all TUTORIAL/STEP paths)

**Files:**
- Modify: `srv/developer-service.js` (import at top; sites near :221, :298, :351, :374, :1132, :1145)
- Test: `test/integration/ngds-tracking-stamp.test.js`

**Interfaces:**
- Consumes: `stampSubmissionId` from Task 1.
- Produces: after any completion write, the persisted TaskRecord row has a non-null `submissionIdCompleted` (COMPLETED) or `submissionIdStarted` (IN_PROGRESS); the NGDS payload built by `resolveTaskRecordNgdsFields` contains `trackingInfo.tracking`.

- [ ] **Step 1: Write the failing test**

```js
// test/integration/ngds-tracking-stamp.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

// Proves the fix end-to-end: a completion persists a submissionId, and the NGDS
// payload the auto-send builds now carries trackingInfo.tracking. We force the
// PROD gates open with no reachable destination, so the send queues into
// NGDSFailedMessages — whose stored payload we inspect for `tracking`.
const project = cds.test('serve', '--project', '.', '--in-memory');
const ORIGINAL_VCAP = process.env.VCAP_APPLICATION;

async function setAutoSendFlag(enabled) {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  const existing = await SELECT.one.from(ImsConfig).where({ key: 'ngds.autosend.enabled' });
  if (existing) await UPDATE(ImsConfig, existing.ID).set({ value: String(enabled) });
  else await INSERT.into(ImsConfig).entries({ key: 'ngds.autosend.enabled', value: String(enabled) });
  const { resetAutoSendFlagCache } = await import('../../srv/lib/ngds-autosend.js');
  resetAutoSendFlagCache();
}

describe('NGDS trackingInfo.tracking is populated on completion', () => {
  beforeAll(async () => {
    const { Users, Missions } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({
      ID: 'aaaaaaaa-trk0-0000-0000-000000000001',
      uuid: 'P0007777001', legacyId: 8001, sapId: 'P0007777001',
    });
    await INSERT.into(Missions).entries({
      ID: 'bbbbbbbb-trk0-0000-0000-000000000001',
      slug: 'trk-mission', title: 'Tracking Mission', legacyId: 8101,
      status: 'ACTIVE', communityMissionId: 'comm-8101',
    });
  });

  afterAll(async () => {
    if (ORIGINAL_VCAP === undefined) delete process.env.VCAP_APPLICATION;
    else process.env.VCAP_APPLICATION = ORIGINAL_VCAP;
    await setAutoSendFlag(false);
  });

  it('persists submissionIdCompleted and emits trackingInfo.tracking', async () => {
    process.env.VCAP_APPLICATION = JSON.stringify({ space_name: 'prod' });
    await setAutoSendFlag(true);

    const { status } = await project.post('/api/createTaskRecord',
      { taskLegacyId: 8101, taskType: 'MISSION' },
      { auth: { username: 'P0007777001', password: 'P0007777001' } });
    expect(status).toBe(200);

    // 1. Persisted row carries the stamped id.
    const { TaskRecords, NGDSFailedMessages } = cds.entities('com.sap.developers.ims');
    const rec = await SELECT.one.from(TaskRecords).where({ taskLegacyId: 8101, taskType: 'MISSION' });
    expect(rec.submissionIdCompleted).toBeTruthy();

    // 2. The queued NGDS payload now contains trackingInfo.tracking (was missing before the fix).
    const queued = await SELECT.from(NGDSFailedMessages);
    const mine = queued.map(q => JSON.parse(q.payload)).find(p => p?.imsData?.IMSID === '8101');
    expect(mine).toBeTruthy();
    expect(mine.trackingInfo.tracking).toBe(rec.submissionIdCompleted);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/ngds-tracking-stamp.test.js`
Expected: FAIL — `rec.submissionIdCompleted` is null / `mine.trackingInfo.tracking` is undefined.

- [ ] **Step 3: Add the import**

At the top of `srv/developer-service.js`, alongside the other `./lib` imports (near the `maybeAutoSendCompletion` import on line 13):

```js
import { stampSubmissionId } from './lib/task-record-submission-id.js';
```

- [ ] **Step 4: Stamp the six write sites**

Apply these edits in `srv/developer-service.js`. For INSERTs, wrap the `entries({...})` object; for UPDATEs, stamp the `.set()` object using the already-fetched `existing` row.

**a) STEP insert (~:221):**
```js
        await INSERT.into(dbTaskRecords).entries(stampSubmissionId({
          user_ID: dbUser.ID,
          taskLegacyId: step.legacyId,
          taskType: 'STEP',
          status: 'COMPLETED',
          progress: 100,
          completionDate: now,
          titleSnapshot: step.title,
          legacyId: await getNextLegacyId('TaskRecords', db),
          attemptNumber,
        }));
```

**b) reset TUTORIAL insert (~:298):**
```js
      await INSERT.into(dbTaskRecords).entries(stampSubmissionId({
        user_ID: dbUser.ID,
        taskLegacyId: tutorial.legacyId,
        taskType: 'TUTORIAL',
        status: 'IN_PROGRESS',
        progress: 0,
        attemptNumber: maxAttempt + 1,
        titleSnapshot: tutorial.title,
        legacyId: newLegacyId,
      }));
```

**c) createTaskRecord UPDATE existing → COMPLETED (~:351):**
```js
          await UPDATE(dbTaskRecords, existing.ID).set(stampSubmissionId({
            status: 'COMPLETED',
            progress: 100,
            completionDate: new Date().toISOString()
          }, existing));
```

**d) createTaskRecord INSERT new → COMPLETED (~:363-374):** stamp the `record` object immediately before the INSERT:
```js
      stampSubmissionId(record);
      await INSERT.into(dbTaskRecords).entries(record);
```

**e) _updateTutorialProgress UPDATE existing (~:1132):**
```js
      await UPDATE(dbTaskRecords, existing.ID).set(stampSubmissionId({
        progress, status,
        completionDate: status === 'COMPLETED' ? new Date().toISOString() : existing.completionDate
      }, existing));
```

**f) _updateTutorialProgress INSERT new (~:1145):**
```js
      await INSERT.into(dbTaskRecords).entries(stampSubmissionId({
        user_ID: dbUser.ID,
        taskLegacyId: tutorial.legacyId,
        taskType: 'TUTORIAL',
        status, progress,
        titleSnapshot: tutorial.title,
        legacyId: newLegacyId,
        attemptNumber: currentAttempt,
      }));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/integration/ngds-tracking-stamp.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/developer-service.js test/integration/ngds-tracking-stamp.test.js
git commit -m "fix(ngds): stamp submissionId on developer-service TaskRecord writes (tracking parity)"
```

---

### Task 3: Wire the helper into puzzle/petoberfest/content-store + srv-qa cp list

**Files:**
- Modify: `srv/puzzle-service.js:208`
- Modify: `srv/lib/petoberfest-upload.js:39`
- Modify: `srv/lib/content-store.js` (import + :128)
- Modify: `.deploy/mta.yaml:164` (srv-qa cp list)
- Test: `test/integration/recompute-tutorial-progress-stamp.test.js`

**Interfaces:**
- Consumes: `stampSubmissionId` from Task 1.
- Produces: PUZZLE/PETOBERFEST completion inserts and `recomputeTutorialProgress` transitions all persist a `submissionId*`.

- [ ] **Step 1: Write the failing test**

```js
// test/integration/recompute-tutorial-progress-stamp.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { recomputeTutorialProgress } from '../../srv/lib/content-store.js';

// recomputeTutorialProgress flips a TUTORIAL TaskRecord's status based on STEP
// completions. Post-fix it must stamp the submissionId matching the new status.
const test = cds.test('serve', '--project', '.', '--in-memory');

describe('recomputeTutorialProgress stamps submissionId on status transition', () => {
  beforeAll(async () => {
    const { Users, Tutorials, Steps, TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: 'dddddddd-rec0-0000-0000-000000000001', uuid: 'P0006666001', legacyId: 9001, sapId: 'P0006666001' });
    await INSERT.into(Tutorials).entries({ ID: 'eeeeeeee-rec0-0000-0000-000000000001', slug: 'rec-tut', title: 'Recompute Tut', legacyId: 9100, status: 'ACTIVE' });
    await INSERT.into(Steps).entries({ ID: 'ffffffff-rec0-0000-0000-000000000001', tutorial_ID: 'eeeeeeee-rec0-0000-0000-000000000001', legacyId: 9110, title: 'S1' });
    // Completed STEP so recompute drives the TUTORIAL row to COMPLETED (stepCount=1).
    await INSERT.into(TaskRecords).entries({ ID: '11111111-rec0-0000-0000-000000000001', user_ID: 'dddddddd-rec0-0000-0000-000000000001', taskLegacyId: 9110, taskType: 'STEP', status: 'COMPLETED', progress: 100, legacyId: 9200, attemptNumber: 1 });
    // TUTORIAL row currently IN_PROGRESS with NO submissionIdCompleted.
    await INSERT.into(TaskRecords).entries({ ID: '22222222-rec0-0000-0000-000000000001', user_ID: 'dddddddd-rec0-0000-0000-000000000001', taskLegacyId: 9100, taskType: 'TUTORIAL', status: 'IN_PROGRESS', progress: 0, legacyId: 9201, attemptNumber: 1 });
  });

  it('stamps submissionIdCompleted when recompute flips the row to COMPLETED', async () => {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    await recomputeTutorialProgress('eeeeeeee-rec0-0000-0000-000000000001', 1);
    const row = await SELECT.one.from(TaskRecords).where({ ID: '22222222-rec0-0000-0000-000000000001' });
    expect(row.status).toBe('COMPLETED');
    expect(row.submissionIdCompleted).toBeTruthy();
  });
});
```

> Note: confirm the exported name/signature of `recomputeTutorialProgress` in `content-store.js` and adjust the import/call if it differs (it takes `(tutorialId, stepCount)` per :95-123).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/recompute-tutorial-progress-stamp.test.js`
Expected: FAIL — `row.submissionIdCompleted` is null.

- [ ] **Step 3: Edit `content-store.js`**

Add near the top imports:
```js
import { stampSubmissionId } from './task-record-submission-id.js';
```
At :126-128, stamp the `set` object with the existing `rec` (already carries all columns — the SELECT at :103 has no `.columns()`):
```js
    const set = { progress: newProgress, status: newStatus };
    if (newStatus !== 'COMPLETED') set.completionDate = null;
    stampSubmissionId(set, rec);
    await UPDATE(TaskRecords).where({ ID: rec.ID }).set(set);
```

- [ ] **Step 4: Edit `puzzle-service.js` (:208) and `petoberfest-upload.js` (:39)**

`puzzle-service.js` — add import near the other `./lib` imports:
```js
import { stampSubmissionId } from './lib/task-record-submission-id.js';
```
Wrap the insert (:208):
```js
      await INSERT.into(TaskRecords).entries(stampSubmissionId({
        user_ID: dbUser.ID,
        taskLegacyId: puzzle.legacyId,
        taskType: 'PUZZLE',
        status: 'COMPLETED',
        progress: 100,
        completionDate: new Date().toISOString(),
        titleSnapshot: puzzle.title,
        legacyId: await getNextLegacyId('TaskRecords', db),
        attemptNumber: prog?.attemptNumber ?? 1,
      }));
```

`petoberfest-upload.js` — add import near the top:
```js
import { stampSubmissionId } from './task-record-submission-id.js';
```
Wrap the insert (:39):
```js
    await db.run(INSERT.into(TaskRecords).entries(stampSubmissionId({
      user_ID: dbUser.ID,
      taskLegacyId: contest.legacyId,
      taskType: 'PETOBERFEST',
      status: 'COMPLETED',
      progress: 100,
      completionDate: new Date().toISOString(),
      titleSnapshot: contest.title,
      legacyId: await getNextLegacyId('TaskRecords', db),
      attemptNumber: 1,
    })));
```

- [ ] **Step 5: Add the helper to the srv-qa cp list (`.deploy/mta.yaml:164`)**

In the long `bash -c "…"` build command, find the `srv/lib/` copy group that ends with `../../srv/lib/page-fallback.js srv/lib/` and insert the new file into that group's source list, immediately before the `srv/lib/` destination:

```
… ../../srv/lib/page-key-map.js ../../srv/lib/page-fallback.js ../../srv/lib/task-record-submission-id.js srv/lib/ …
```

Verify only that one token was added:
```bash
grep -c "task-record-submission-id.js" .deploy/mta.yaml   # expect 1
```

- [ ] **Step 6: Run test + confirm nothing else broke in these files' suites**

Run:
```bash
npx vitest run test/integration/recompute-tutorial-progress-stamp.test.js
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add srv/puzzle-service.js srv/lib/petoberfest-upload.js srv/lib/content-store.js .deploy/mta.yaml test/integration/recompute-tutorial-progress-stamp.test.js
git commit -m "fix(ngds): stamp submissionId on puzzle/petoberfest/recompute writes + srv-qa cp list"
```

---

### Task 4: Full regression — fix any row-shape assertions broken by stamping

**Files:**
- Modify: any existing test that pins exact TaskRecord fields (candidates: `test/unit/reset-tutorial-progress.test.js`, `test/integration/full-workflow.test.js`) — only if they fail.

**Interfaces:** none new — this task guards that stamping did not regress existing behavior.

- [ ] **Step 1: Run the unit suite**

Run: `npm test`
Expected: all green. Stamping adds fields; it should not remove or change existing ones.

- [ ] **Step 2: If anything fails, inspect and fix the assertion (not the fix)**

For each failure, confirm the only difference is a newly-present `submissionIdStarted`/`submissionIdCompleted`. If a test used `toEqual` on a full row, switch to `toMatchObject` or add the expected id field. Do NOT weaken the fix to satisfy a brittle assertion. Re-read the failing test to be sure the new field is legitimately expected there.

- [ ] **Step 3: Re-run until green**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit (only if test files changed)**

```bash
git add test/
git commit -m "test(ngds): update row-shape assertions for submissionId stamping"
```

---

### Task 5: Backfill script + core lib

**Files:**
- Create: `scripts/lib/ngds-backfill.mjs` (unit-testable core)
- Create: `scripts/ngds-backfill-submission-ids.mjs` (thin CLI)
- Test: `test/integration/ngds-backfill.test.js`

**Interfaces:**
- Produces: `async backfillSubmissionIds(db, { dryRun = true, batchSize = 500, log = console }) → { completed, started, updated, dryRun }`. `completed`/`started` = candidate counts; `updated` = rows written (0 in dry-run). Idempotent (only-if-null WHERE).

- [ ] **Step 1: Write the failing test**

```js
// test/integration/ngds-backfill.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { backfillSubmissionIds } from '../../scripts/lib/ngds-backfill.mjs';

const test = cds.test('serve', '--project', '.', '--in-memory');

describe('backfillSubmissionIds', () => {
  beforeAll(async () => {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TaskRecords).entries([
      { ID: 'bf000001-0000-0000-0000-000000000001', taskLegacyId: 5001, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 5001 },
      { ID: 'bf000002-0000-0000-0000-000000000002', taskLegacyId: 5002, taskType: 'TUTORIAL', status: 'IN_PROGRESS', progress: 20, legacyId: 5002 },
      { ID: 'bf000003-0000-0000-0000-000000000003', taskLegacyId: 5003, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 5003, submissionIdCompleted: 'already-set' },
    ]);
  });

  it('dry-run reports candidates without writing', async () => {
    const db = await cds.connect.to('db');
    const r = await backfillSubmissionIds(db, { dryRun: true });
    expect(r.completed).toBe(1);  // only the one missing an id
    expect(r.started).toBe(1);
    expect(r.updated).toBe(0);
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(TaskRecords).where({ ID: 'bf000001-0000-0000-0000-000000000001' });
    expect(row.submissionIdCompleted).toBeFalsy();
  });

  it('execute stamps missing ids and is idempotent', async () => {
    const db = await cds.connect.to('db');
    const r1 = await backfillSubmissionIds(db, { dryRun: false });
    expect(r1.updated).toBe(2);
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const c = await SELECT.one.from(TaskRecords).where({ ID: 'bf000001-0000-0000-0000-000000000001' });
    const s = await SELECT.one.from(TaskRecords).where({ ID: 'bf000002-0000-0000-0000-000000000002' });
    const kept = await SELECT.one.from(TaskRecords).where({ ID: 'bf000003-0000-0000-0000-000000000003' });
    expect(c.submissionIdCompleted).toBeTruthy();
    expect(s.submissionIdStarted).toBeTruthy();
    expect(kept.submissionIdCompleted).toBe('already-set'); // untouched

    const r2 = await backfillSubmissionIds(db, { dryRun: false });
    expect(r2.updated).toBe(0); // idempotent
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/ngds-backfill.test.js`
Expected: FAIL — cannot resolve `scripts/lib/ngds-backfill.mjs`.

- [ ] **Step 3: Write the core lib**

```js
// scripts/lib/ngds-backfill.mjs
import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Backfill the legacy submission-id (= NGDS trackingInfo.tracking) onto historical
// TaskRecords that predate the stamping fix. Idempotent: only rows whose id column
// IS NULL are selected. Per-row UPDATE because each row needs a distinct UUID
// (CQL cannot assign unique values in a single bulk UPDATE); batched in a tx.
export async function backfillSubmissionIds(db, { dryRun = true, batchSize = 500, log = console } = {}) {
  const { TaskRecords } = cds.entities(NS);

  const completedMissing = await db.run(
    SELECT.from(TaskRecords).columns('ID').where({ status: 'COMPLETED', submissionIdCompleted: null })
  );
  const startedMissing = await db.run(
    SELECT.from(TaskRecords).columns('ID').where({ status: 'IN_PROGRESS', submissionIdStarted: null })
  );

  const plan = { completed: completedMissing.length, started: startedMissing.length };
  if (dryRun) {
    log.info?.(`[dry-run] would stamp submissionIdCompleted on ${plan.completed} COMPLETED row(s), submissionIdStarted on ${plan.started} IN_PROGRESS row(s)`);
    return { ...plan, updated: 0, dryRun: true };
  }

  let updated = 0;
  async function apply(rows, column) {
    for (const batch of chunk(rows, batchSize)) {
      await db.tx(async (tx) => {
        for (const r of batch) {
          await tx.run(UPDATE(TaskRecords, r.ID).set({ [column]: cds.utils.uuid() }));
          updated++;
        }
      });
      log.info?.(`${column}: ${updated} updated so far`);
    }
  }
  await apply(completedMissing, 'submissionIdCompleted');
  await apply(startedMissing, 'submissionIdStarted');

  log.info?.(`backfill complete: ${updated} row(s) stamped`);
  return { ...plan, updated, dryRun: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/ngds-backfill.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the CLI wrapper**

```js
// scripts/ngds-backfill-submission-ids.mjs
// Backfill submissionId (= NGDS trackingInfo.tracking) on historical TaskRecords.
// Run:  cds bind --exec -- node scripts/ngds-backfill-submission-ids.mjs [--execute] [--batch-size N]
// Dry-run by default. Idempotent — safe to re-run.
import cds from '@sap/cds';
import { backfillSubmissionIds } from './lib/ngds-backfill.mjs';

const args = process.argv.slice(2);
const dryRun = !args.includes('--execute');
const bi = args.indexOf('--batch-size');
const batchSize = bi >= 0 ? Number(args[bi + 1]) : 500;

const db = await cds.connect.to('db');
const result = await backfillSubmissionIds(db, { dryRun, batchSize });
console.log(JSON.stringify(result, null, 2));
if (dryRun) console.log('\n(dry-run — pass --execute to write)');
process.exit(0);
```

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/ngds-backfill.mjs scripts/ngds-backfill-submission-ids.mjs test/integration/ngds-backfill.test.js
git commit -m "feat(ngds): backfill script for historical submissionId (tracking) values"
```

---

### Task 6: Resend script + core lib

**Files:**
- Create: `scripts/lib/ngds-resend.mjs` (candidate selection + resend loop)
- Create: `scripts/ngds-resend-missing-tracking.mjs` (thin CLI)
- Test: `test/integration/ngds-resend.test.js`

**Interfaces:**
- Consumes: `sendTaskRecordToNgds` from `srv/lib/ngds-client.js`; `resolveAutoSendEpoch` from `srv/lib/ngds-autosend.js` (CLI only).
- Produces:
  - `async selectResendCandidates(db, { epochMs = null, completedBefore = null }) → TaskRecord[]` — COMPLETED rows of type TUTORIAL/GROUP/MISSION, excluding `createdBy==='migration'`, with `completionDate >= epochMs` (when set) and `< completedBefore` (when set), whose user has a canonical `sapId` (`/^[PSIps]\d{6,}$/`).
  - `async resendMissingTracking(db, { dryRun = true, limit = null, epochMs = null, completedBefore = null, delayMs = 50, log = console }) → { total, sent, queued, dryRun }`.

- [ ] **Step 1: Write the failing test**

```js
// test/integration/ngds-resend.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { selectResendCandidates, resendMissingTracking } from '../../scripts/lib/ngds-resend.mjs';

const test = cds.test('serve', '--project', '.', '--in-memory');
const EPOCH = new Date('2026-07-01T00:00:00Z').getTime();

describe('ngds-resend candidate selection + gates', () => {
  beforeAll(async () => {
    const { Users, TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries([
      { ID: 'us000001-0000-0000-0000-000000000001', uuid: 'P0005555001', legacyId: 6001, sapId: 'P0005555001' }, // canonical
      { ID: 'us000002-0000-0000-0000-000000000002', uuid: 'devuser', legacyId: 6002, sapId: 'devuser' },          // non-canonical
    ]);
    await INSERT.into(TaskRecords).entries([
      // eligible: completed tutorial, canonical user, after epoch, has id
      { ID: 'rs000001-0000-0000-0000-000000000001', user_ID: 'us000001-0000-0000-0000-000000000001', taskLegacyId: 6101, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 6101, completionDate: '2026-08-01T00:00:00Z', submissionIdCompleted: 'trk-6101' },
      // ineligible: migration-stamped
      { ID: 'rs000002-0000-0000-0000-000000000002', user_ID: 'us000001-0000-0000-0000-000000000001', taskLegacyId: 6102, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 6102, completionDate: '2026-08-01T00:00:00Z', submissionIdCompleted: 'trk-6102', createdBy: 'migration' },
      // ineligible: pre-epoch
      { ID: 'rs000003-0000-0000-0000-000000000003', user_ID: 'us000001-0000-0000-0000-000000000001', taskLegacyId: 6103, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 6103, completionDate: '2026-06-01T00:00:00Z', submissionIdCompleted: 'trk-6103' },
      // ineligible: non-canonical sapId
      { ID: 'rs000004-0000-0000-0000-000000000004', user_ID: 'us000002-0000-0000-0000-000000000002', taskLegacyId: 6104, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 6104, completionDate: '2026-08-01T00:00:00Z', submissionIdCompleted: 'trk-6104' },
      // ineligible: wrong task type
      { ID: 'rs000005-0000-0000-0000-000000000005', user_ID: 'us000001-0000-0000-0000-000000000001', taskLegacyId: 6105, taskType: 'STEP', status: 'COMPLETED', progress: 100, legacyId: 6105, completionDate: '2026-08-01T00:00:00Z', submissionIdCompleted: 'trk-6105' },
      // ineligible: not completed
      { ID: 'rs000006-0000-0000-0000-000000000006', user_ID: 'us000001-0000-0000-0000-000000000001', taskLegacyId: 6106, taskType: 'TUTORIAL', status: 'IN_PROGRESS', progress: 20, legacyId: 6106, completionDate: null, submissionIdStarted: 'trk-6106' },
    ]);
  });

  it('selects only the eligible record given the epoch gate', async () => {
    const db = await cds.connect.to('db');
    const candidates = await selectResendCandidates(db, { epochMs: EPOCH });
    expect(candidates.map(c => c.taskLegacyId)).toEqual([6101]);
  });

  it('dry-run resend sends nothing and reports the total', async () => {
    const db = await cds.connect.to('db');
    const { NGDSFailedMessages } = cds.entities('com.sap.developers.ims');
    const before = (await SELECT.from(NGDSFailedMessages)).length;
    const r = await resendMissingTracking(db, { dryRun: true, epochMs: EPOCH });
    expect(r.total).toBe(1);
    expect(r.sent).toBe(0);
    expect((await SELECT.from(NGDSFailedMessages)).length).toBe(before); // no send attempted
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/ngds-resend.test.js`
Expected: FAIL — cannot resolve `scripts/lib/ngds-resend.mjs`.

- [ ] **Step 3: Write the core lib**

```js
// scripts/lib/ngds-resend.mjs
import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';
// Legacy NGDS send allowlist (parity with maybeAutoSendCompletion).
const NGDS_ELIGIBLE = ['TUTORIAL', 'GROUP', 'MISSION'];
// context.user_id must be a canonical SCI/IAS uid or the send is unresolvable.
const CANONICAL_SAP_ID = /^[PSIps]\d{6,}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Select the completions that SHOULD have been delivered to NGDS. Mirrors the
// auto-send gates exactly, minus the CF-space gate (the operator targets PROD
// deliberately via `cds bind`).
export async function selectResendCandidates(db, { epochMs = null, completedBefore = null } = {}) {
  const { TaskRecords, Users } = cds.entities(NS);
  const rows = await db.run(
    SELECT.from(TaskRecords).where({ status: 'COMPLETED', taskType: { in: NGDS_ELIGIBLE } })
  );

  const out = [];
  for (const r of rows) {
    if (r.createdBy === 'migration') continue;                 // legacy already credited
    const when = r.completionDate || r.modifiedAt;
    const t = when ? new Date(when).getTime() : NaN;
    if (epochMs != null && Number.isFinite(t) && t < epochMs) continue;        // pre-cutover
    if (completedBefore != null && Number.isFinite(t) && t >= completedBefore) continue; // optional ceiling
    if (!r.user_ID) continue;
    const u = await db.run(SELECT.one.from(Users).columns('sapId').where({ ID: r.user_ID }));
    const sapId = u?.sapId;
    if (!(typeof sapId === 'string' && CANONICAL_SAP_ID.test(sapId.trim()))) continue; // identity gate
    out.push(r);
  }
  return out;
}

// Resend eligible completions via the existing send path (queues to
// NGDSFailedMessages on failure → drained by the 2h ngds-retry job).
export async function resendMissingTracking(db, {
  dryRun = true, limit = null, epochMs = null, completedBefore = null, delayMs = 50, log = console,
} = {}) {
  let candidates = await selectResendCandidates(db, { epochMs, completedBefore });
  if (limit != null) candidates = candidates.slice(0, limit);

  if (dryRun) {
    log.info?.(`[dry-run] ${candidates.length} record(s) would be resent`);
    return { total: candidates.length, sent: 0, queued: 0, dryRun: true };
  }

  const { sendTaskRecordToNgds } = await import('../../srv/lib/ngds-client.js');
  let sent = 0, queued = 0;
  for (const rec of candidates) {
    const outcome = await sendTaskRecordToNgds(rec, db);
    if (outcome?.success) sent++; else queued++;
    const done = sent + queued;
    if (done % 50 === 0) log.info?.(`resend progress: ${done}/${candidates.length} (sent=${sent}, queued=${queued})`);
    if (delayMs) await sleep(delayMs);
  }
  log.info?.(`resend complete: total=${candidates.length} sent=${sent} queued=${queued}`);
  return { total: candidates.length, sent, queued, dryRun: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/ngds-resend.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the CLI wrapper**

```js
// scripts/ngds-resend-missing-tracking.mjs
// Resend NGDS completions that were filtered for a missing trackingInfo.tracking.
// Run (after the fix is deployed AND backfill has run):
//   cds bind --exec -- node scripts/ngds-resend-missing-tracking.mjs [--execute] [--limit N] [--completed-before <iso>] [--delay-ms N]
// Dry-run by default. Reads the cutover floor from ImsConfig 'ngds.autosend.epoch'.
import cds from '@sap/cds';
import { resendMissingTracking } from './lib/ngds-resend.mjs';
import { resolveAutoSendEpoch } from '../srv/lib/ngds-autosend.js';

const args = process.argv.slice(2);
const dryRun = !args.includes('--execute');
const num = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : dflt; };
const str = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

const db = await cds.connect.to('db');
const epochMs = await resolveAutoSendEpoch(db);
const cb = str('--completed-before');
const completedBefore = cb ? new Date(cb).getTime() : null;

console.log(`epoch floor: ${epochMs ? new Date(epochMs).toISOString() : '(none)'}`);
const result = await resendMissingTracking(db, {
  dryRun,
  limit: num('--limit', null),
  epochMs,
  completedBefore,
  delayMs: num('--delay-ms', 50),
});
console.log(JSON.stringify(result, null, 2));
if (dryRun) console.log('\n(dry-run — pass --execute to send)');
process.exit(0);
```

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/ngds-resend.mjs scripts/ngds-resend-missing-tracking.mjs test/integration/ngds-resend.test.js
git commit -m "feat(ngds): resend script for completions filtered on missing tracking"
```

---

### Task 7: Final verification + PR

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 2: Sanity-check the scripts compile/parse under Node**

Run:
```bash
node --check scripts/lib/ngds-backfill.mjs
node --check scripts/ngds-backfill-submission-ids.mjs
node --check scripts/lib/ngds-resend.mjs
node --check scripts/ngds-resend-missing-tracking.mjs
```
Expected: no output (syntax OK).

- [ ] **Step 3: Re-walk the srv-qa cp-list audit**

Confirm `srv/lib/task-record-submission-id.js` is the only new transitive `./` import from `content-store.js`, and it is present in `.deploy/mta.yaml`:
```bash
grep -c "task-record-submission-id.js" .deploy/mta.yaml   # expect 1
```

- [ ] **Step 4: Push branch and open a draft PR**

```bash
git push -u origin worktree-ngds-tracking-fix
gh pr create --draft --base main \
  --title "fix(ngds): trackingInfo.tracking parity + backfill + resend scripts" \
  --body "Implements docs/superpowers/specs/2026-08-14-ngds-tracking-fix-design.md. Stamps submissionId on all TaskRecord writes (legacy parity), backfills historical rows, and adds gated backfill/resend scripts. Rollout: deploy → backfill --execute → resend --limit canary → resend --execute."
```

> Note: repo branch model targets `DEV` for some flows; confirm the correct base with Tom before marking ready.

---

## Self-Review

**Spec coverage:**
- Fix (all 9 sites, legacy parity) → Tasks 2 + 3. ✓
- Backfill (full integrity, idempotent, dry-run default) → Task 5. ✓
- Resend (auto-send gates, epoch floor, canary/limit/completed-before, queue-on-failure) → Task 6. ✓
- srv-qa cp-list deploy safety → Task 3 Step 5 + Task 7 Step 3. ✓
- Testing (helper truth table, end-to-end tracking, script gates) → Tasks 1, 2, 5, 6. ✓
- Field-parity verdict (IMSName/CommunityID present) → verified by the Task 2 payload assertion + existing `ngds-client.test.js`. ✓
- Rollout sequence → Task 7 PR body + spec. ✓

**Placeholder scan:** none — all steps carry real code/commands. The two `> Note:` lines flag verification-at-implementation (exact exported name of `recomputeTutorialProgress`; PR base branch), not deferred work.

**Type consistency:** `stampSubmissionId(target, existing)` signature identical across Tasks 1-3. `backfillSubmissionIds(db, opts)` and `selectResendCandidates`/`resendMissingTracking(db, opts)` signatures match between their lib, CLI, and tests. `CANONICAL_SAP_ID` regex identical to `ngds-autosend.js`.
