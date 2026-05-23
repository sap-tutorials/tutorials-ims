# Admin Data Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a one-click admin tool that exports CAP-backed equivalents of six legacy IMS reporting tables as a streamed CSV-ZIP or XLSX bundle, so off-platform reporting queries keep working after the IMS-to-CAP cutover.

**Architecture:** New CAP service `ExportsService` at `/admin/exports` declares a single action `exportLegacyData(format)`; the actual download is served by an Express bridge registered in `cds.on('bootstrap')` (browsers download via `window.location.href` GET, not OData POST). Six per-table modules in `srv/exports/` page through CDS entities with `OFFSET/LIMIT 5000` and a stable `ORDER BY`, yielding row arrays via async generators. Two assemblers stream those rows into either an `archiver`-zipped bundle of CSVs or a streaming `exceljs` workbook, piped directly to the HTTP response.

**Tech Stack:** CAP Node.js (`@sap/cds` 9.x), `cds.ql` (no raw SQL), Express bridge, `archiver`, `exceljs`, `csv-stringify`, SAPUI5 admin-shell custom view, XSUAA scope `$XSAPPNAME.Admin`, vitest (unit / hybrid / smoke).

**Spec:** [docs/superpowers/specs/2026-05-23-admin-data-export-design.md](../specs/2026-05-23-admin-data-export-design.md)

---

## File Structure

**Created (17 files):**

| Path | Responsibility |
|---|---|
| `srv/exports-service.cds` | CDS service + `@requires:'Admin'` + action declaration (metadata only) |
| `srv/exports-service.js` | Thin CDS handler — validates format, delegates to assembler. Body never reached in normal flow (UI uses GET bridge); kept for OData parity. |
| `srv/exports/tasks.js` | Per-table module for `IMS_TASK` (sources `Tasks` UNION view) |
| `srv/exports/task-records.js` | Per-table module for `IMS_TASK_RECORD` |
| `srv/exports/task-to-parent.js` | Per-table module for `IMS_TASK_TO_PARENT` (UNION of Steps→Tutorials and GroupPathItems Tutorial→Group) |
| `srv/exports/completion-path.js` | Per-table module for `IMS_COMPLETION_PATH` |
| `srv/exports/completion-path-to-task.js` | Per-table module for `IMS_COMPLETION_PATH_TO_TASK` |
| `srv/exports/step-failures.js` | Per-table module for `IMS_STEP_FAILURE` (emits 7 empty-string columns for missing legacy fields) |
| `srv/exports/assemble-csv-zip.js` | Streams 6 CSVs into a ZIP via `archiver` |
| `srv/exports/assemble-xlsx.js` | Streams 6 worksheets via `exceljs.stream.xlsx.WorkbookWriter` |
| `srv/exports/express-bridge.js` | Registers `GET /admin/exports/exportLegacyData`, enforces Admin scope, sets headers, dispatches to assembler |
| `app/admin-shell/webapp/view/DataExport.view.xml` | Custom view (panel + format SegmentedButton + download Button + MessageStrip) |
| `app/admin-shell/webapp/controller/DataExport.controller.js` | `onDownload` builds URL and sets `window.location.href` |
| `test/unit/exports/per-module.test.js` | One spec per module (6 modules, one file with 6 describe blocks — see Task 11) |
| `test/unit/exports/bundle-csv-zip.test.js` | Bundle assembler test for ZIP path |
| `test/unit/exports/bundle-xlsx.test.js` | Bundle assembler test for XLSX path |
| `test/hybrid/admin-exports.test.js` | Hybrid HANA: 200 + format + 6 entries; negative auth/format |
| `test/smoke/admin-exports.smoke.test.js` | Smoke: 200, content-type, content-disposition, ZIP magic bytes |

**Modified (5 files):**

| Path | Change |
|---|---|
| `srv/server.js` | Import `registerExportsBridge` from `srv/exports/express-bridge.js`; call inside `cds.on('bootstrap')` *before* CAP mounts ExportsService at `/admin/exports` |
| `app/admin-shell/webapp/view/Shell.view.xml` | New `<tnt:NavigationListItem text="Data Export" key="dataExport" icon="sap-icon://download" />` between "Statistics" and "Joule Settings" under System group |
| `app/admin-shell/webapp/controller/Shell.controller.js` | Add `dataExport: "dataExport"` to `NAV_KEY_TO_ROUTE`, `dataExport: "Data Export"` to `NAV_KEY_TO_TITLE` |
| `app/admin-shell/webapp/manifest.json` | New route `{ "name": "dataExport", "pattern": "dataExport", "target": "dataExportTarget" }` and target `"dataExportTarget": { "viewName": "DataExport", "viewLevel": 1 }` |
| `approuter/xs-app.json` | Insert new route `^/admin/exports/(.*)$` *before* the existing `^/admin/(.*)$`, with `timeout: 600000` |
| `package.json` | Add `archiver`, `exceljs`, `csv-stringify` (exact pinned versions, respecting `min-release-age=1` day) |

`package.json` is in both lists — call it once.

---

## Conventions for every task

- **TDD always** — write the failing test first, run it to confirm it fails, then implement.
- **`cds.ql` only** — never write raw SQL in any of these modules.
- **Stable ordering** — every paged query uses `ORDER BY` per the spec (`legacyId ASC` everywhere; `(taskType ASC, legacyId ASC)` for the Tasks view).
- **Page size 5000** — let modules accept an `opts.pageSize` override so unit tests can use a smaller value (e.g. 2) to exercise pagination.
- **Async generators yield row arrays** in the legacy header order, not objects. Keeps memory flat and CSV/XLSX writers symmetric.
- **`@requires:'Admin'`** on the service and an explicit `is('Admin')` check in the bridge (the bridge bypasses CAP's auth/auth on the OData router).
- **Frequent commits** — one commit per step; never bundle test+impl into one commit.
- **Use Read on package-lock.json after npm install** to verify the exact pinned version, then commit `package.json` + `package-lock.json` together.

---

## Task 1: Add npm dependencies

**Files:**
- Modify: `package.json` (dependencies block)
- Modify: `package-lock.json` (regenerated by npm)

**Why first:** every module test needs `csv-stringify`; bundle tests need `archiver` and `exceljs`. Get the deps in before any test can run.

- [ ] **Step 1: Verify the global npmrc constraints**

Run: `cat ~/.npmrc | grep -E 'save-exact|min-release-age|ignore-scripts'`
Expected output includes:
```
save-exact=true
min-release-age=1
ignore-scripts=true
```

If any line is missing, STOP — fix the user-level npmrc first (this is a global guarantee documented in CLAUDE memory under `npm_security_config.md`).

- [ ] **Step 2: Install the three deps**

Run: `npm install archiver exceljs csv-stringify`

Expected: three `+ <pkg>@<version>` lines, no peer-dep warnings that mention security or breaking changes. `npm install` honors `save-exact=true` automatically (no `^` or `~` prefix in `package.json`).

- [ ] **Step 3: Verify versions are pinned and not pre-release**

Run: `jq '.dependencies | {archiver, exceljs, "csv-stringify"}' package.json`
Expected: each value is a literal version string (e.g. `"7.0.1"`), no `^`, no `~`, no `-rc`, no `-beta`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add archiver, exceljs, csv-stringify for admin data export"
```

---

## Task 2: Per-table module — `tasks.js`

**Files:**
- Create: `srv/exports/tasks.js`
- Test: `test/unit/exports/per-module.test.js` (Tasks describe block)

The `Tasks` UNION-ALL view in [db/views.cds:5-39](../../db/views.cds#L5-L39) aggregates 5 task types. Stable order is `(taskType ASC, legacyId ASC)`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/exports/per-module.test.js`:

```javascript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

const schemaPath = path.join(process.cwd(), 'db');
cds.test(schemaPath);

describe('exports/tasks', () => {
  let mod;
  beforeAll(async () => {
    mod = await import('../../../srv/exports/tasks.js');
  });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { Tutorials, Missions, Groups, Steps, Checkpoints } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(Tutorials));
    await db.run(DELETE.from(Missions));
    await db.run(DELETE.from(Groups));
    await db.run(DELETE.from(Steps));
    await db.run(DELETE.from(Checkpoints));
  });

  it('emits the legacy IMS_TASK header', () => {
    expect(mod.legacyHeader).toEqual([
      'ID', 'TITLE', 'DESCRIPTION', 'STATUS', 'DELETION_REASON',
      'PRIMARY_TAG', 'EXPERIENCE_TAG', 'AVERAGE_TIME_TO_COMPLETE',
      'TASK_TYPE', 'CREATED_AT', 'MODIFIED_AT'
    ]);
  });

  it('yields legacyId as ID and pages stably across types', async () => {
    const db = await cds.connect.to('db');
    const { Tutorials, Missions } = cds.entities('com.sap.developers.ims');
    await db.run(INSERT.into(Tutorials).entries([
      { ID: '11111111-1111-1111-1111-111111111111', legacyId: 101, title: 'T1', slug: 't1', status: 'ACTIVE' },
      { ID: '22222222-2222-2222-2222-222222222222', legacyId: 102, title: 'T2', slug: 't2', status: 'ACTIVE' }
    ]));
    await db.run(INSERT.into(Missions).entries([
      { ID: '33333333-3333-3333-3333-333333333333', legacyId: 201, title: 'M1', status: 'ACTIVE' }
    ]));

    const rows = [];
    for await (const row of mod.rows(db, { pageSize: 2 })) rows.push(row);

    // Sorted by (taskType ASC, legacyId ASC): MISSION 201, TUTORIAL 101, TUTORIAL 102
    expect(rows).toHaveLength(3);
    expect(rows[0][0]).toBe(201); // ID column = legacyId
    expect(rows[0][8]).toBe('MISSION');
    expect(rows[1][0]).toBe(101);
    expect(rows[1][8]).toBe('TUTORIAL');
    expect(rows[2][0]).toBe(102);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/exports/per-module.test.js`
Expected: FAIL with "Cannot find module '../../../srv/exports/tasks.js'".

- [ ] **Step 3: Implement `srv/exports/tasks.js`**

```javascript
import cds from '@sap/cds';

export const legacyHeader = [
  'ID', 'TITLE', 'DESCRIPTION', 'STATUS', 'DELETION_REASON',
  'PRIMARY_TAG', 'EXPERIENCE_TAG', 'AVERAGE_TIME_TO_COMPLETE',
  'TASK_TYPE', 'CREATED_AT', 'MODIFIED_AT'
];

export async function* rows(db, opts = {}) {
  const pageSize = opts.pageSize ?? 5000;
  const { Tasks } = cds.entities('com.sap.developers.ims');
  let offset = 0;
  while (true) {
    const page = await db.run(
      SELECT.from(Tasks)
        .orderBy('taskType asc', 'legacyId asc')
        .limit(pageSize, offset)
    );
    if (!page.length) return;
    for (const r of page) {
      yield [
        r.legacyId,
        r.title ?? '',
        r.description ?? '',
        r.status ?? '',
        r.deletionReason ?? '',
        r.primaryTag ?? '',
        r.experienceTag ?? '',
        r.averageTimeToComplete ?? '',
        r.taskType,
        r.createdAt ?? '',
        r.modifiedAt ?? ''
      ];
    }
    if (page.length < pageSize) return;
    offset += pageSize;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/exports/per-module.test.js`
Expected: PASS — both tests in the `exports/tasks` describe block green.

- [ ] **Step 5: Commit**

```bash
git add srv/exports/tasks.js test/unit/exports/per-module.test.js
git commit -m "feat(exports): per-table module for IMS_TASK"
```

---

## Task 3: Per-table module — `task-records.js`

**Files:**
- Create: `srv/exports/task-records.js`
- Test: append a `describe('exports/task-records', ...)` block to `test/unit/exports/per-module.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/exports/per-module.test.js`:

```javascript
describe('exports/task-records', () => {
  let mod;
  beforeAll(async () => {
    mod = await import('../../../srv/exports/task-records.js');
  });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(TaskRecords));
    await db.run(DELETE.from(Users));
  });

  it('emits the legacy IMS_TASK_RECORD header', () => {
    expect(mod.legacyHeader).toEqual([
      'ID', 'USER_ID', 'TASK_ID', 'TASK_TYPE', 'STATUS', 'PROGRESS',
      'COMPLETION_TIME', 'COMPLETION_DATE', 'CONTENT_LANGUAGE', 'SITE_LANGUAGE',
      'SUBMISSION_ID_STARTED', 'SUBMISSION_ID_COMPLETED', 'TITLE_SNAPSHOT',
      'PROGRESS_NOTE', 'EVENT', 'CREATED_AT', 'MODIFIED_AT'
    ]);
  });

  it('emits UUID strings for ID/USER_ID, taskLegacyId for TASK_ID, null COMPLETION_DATE for in-progress', async () => {
    const db = await cds.connect.to('db');
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await db.run(INSERT.into(Users).entries({ ID: userId, uuid: userId }));
    await db.run(INSERT.into(TaskRecords).entries([
      { ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', user_ID: userId, taskLegacyId: 101, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: '2026-05-23T10:00:00Z', legacyId: 1 },
      { ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc', user_ID: userId, taskLegacyId: 102, taskType: 'TUTORIAL', status: 'IN_PROGRESS', legacyId: 2 }
    ]));

    const rows = [];
    for await (const row of mod.rows(db, { pageSize: 100 })) rows.push(row);

    expect(rows).toHaveLength(2);
    expect(typeof rows[0][0]).toBe('string'); // ID is UUID string
    expect(rows[0][1]).toBe(userId);            // USER_ID
    expect(rows[0][2]).toBe(101);               // TASK_ID = taskLegacyId
    // First row was COMPLETED (legacyId:1, ordered first)
    expect(rows[0][7]).toBeTruthy();            // COMPLETION_DATE present
    expect(rows[1][7] ?? '').toBe('');          // COMPLETION_DATE empty for IN_PROGRESS
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/exports/per-module.test.js -t "task-records"`
Expected: FAIL with "Cannot find module '../../../srv/exports/task-records.js'".

- [ ] **Step 3: Implement `srv/exports/task-records.js`**

```javascript
export const legacyHeader = [
  'ID', 'USER_ID', 'TASK_ID', 'TASK_TYPE', 'STATUS', 'PROGRESS',
  'COMPLETION_TIME', 'COMPLETION_DATE', 'CONTENT_LANGUAGE', 'SITE_LANGUAGE',
  'SUBMISSION_ID_STARTED', 'SUBMISSION_ID_COMPLETED', 'TITLE_SNAPSHOT',
  'PROGRESS_NOTE', 'EVENT', 'CREATED_AT', 'MODIFIED_AT'
];

export async function* rows(db, opts = {}) {
  const pageSize = opts.pageSize ?? 5000;
  const cds = (await import('@sap/cds')).default;
  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  let offset = 0;
  while (true) {
    const page = await db.run(
      SELECT.from(TaskRecords)
        .columns('ID','user_ID','taskLegacyId','taskType','status','progress',
                 'completionTime','completionDate','contentLanguage','siteLanguage',
                 'submissionIdStarted','submissionIdCompleted','titleSnapshot',
                 'progressNote','event_ID','createdAt','modifiedAt','legacyId')
        .orderBy('legacyId asc')
        .limit(pageSize, offset)
    );
    if (!page.length) return;
    for (const r of page) {
      yield [
        r.ID, r.user_ID, r.taskLegacyId, r.taskType, r.status, r.progress ?? '',
        r.completionTime ?? '', r.completionDate ?? '',
        r.contentLanguage ?? '', r.siteLanguage ?? '',
        r.submissionIdStarted ?? '', r.submissionIdCompleted ?? '',
        r.titleSnapshot ?? '', r.progressNote ?? '',
        r.event_ID ?? '', r.createdAt ?? '', r.modifiedAt ?? ''
      ];
    }
    if (page.length < pageSize) return;
    offset += pageSize;
  }
}
```

Note: top-level `import cds` instead of dynamic import is fine here. Use whichever style matches the project's other `srv/lib/*.js` files (check `srv/lib/embedding-stats.js` for the convention).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/exports/per-module.test.js -t "task-records"`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add srv/exports/task-records.js test/unit/exports/per-module.test.js
git commit -m "feat(exports): per-table module for IMS_TASK_RECORD"
```

---

## Task 4: Per-table module — `task-to-parent.js`

**Files:**
- Create: `srv/exports/task-to-parent.js`
- Test: append a `describe('exports/task-to-parent', ...)` block to `test/unit/exports/per-module.test.js`

This is the only synthesized file: UNION of (Steps→Tutorials parent edges via `Steps.tutorial` + `Steps.stepOrder`) and (`GroupPathItems` where `tutorial != null`, giving Tutorial→Group edges).

- [ ] **Step 1: Write the failing test**

Append:

```javascript
describe('exports/task-to-parent', () => {
  let mod;
  beforeAll(async () => {
    mod = await import('../../../srv/exports/task-to-parent.js');
  });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { Steps, Tutorials, Groups, GroupPathItems } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(GroupPathItems));
    await db.run(DELETE.from(Steps));
    await db.run(DELETE.from(Tutorials));
    await db.run(DELETE.from(Groups));
  });

  it('emits the legacy IMS_TASK_TO_PARENT header', () => {
    expect(mod.legacyHeader).toEqual(['PARENT_TASK_ID', 'CHILD_TASK_ID', 'ITEM_ORDER']);
  });

  it('unions Step->Tutorial and Tutorial->Group edges', async () => {
    const db = await cds.connect.to('db');
    const { Tutorials, Steps, Groups, GroupPathItems } = cds.entities('com.sap.developers.ims');
    const tutId = '11111111-1111-1111-1111-111111111111';
    const grpId = '22222222-2222-2222-2222-222222222222';
    await db.run(INSERT.into(Tutorials).entries({ ID: tutId, legacyId: 500, title: 'T', slug: 't' }));
    await db.run(INSERT.into(Groups).entries({ ID: grpId, legacyId: 700, title: 'G' }));
    await db.run(INSERT.into(Steps).entries({
      ID: '33333333-3333-3333-3333-333333333333',
      legacyId: 600, title: 'S1', tutorial_ID: tutId, stepOrder: 1
    }));
    await db.run(INSERT.into(GroupPathItems).entries({
      ID: '44444444-4444-4444-4444-444444444444',
      legacyId: 800, group_ID: grpId, tutorial_ID: tutId, itemOrder: 2
    }));

    const rows = [];
    for await (const row of mod.rows(db, { pageSize: 100 })) rows.push(row);

    // Step->Tutorial: parent=500 (tutorial.legacyId), child=600 (step.legacyId), order=1
    // GroupPathItem: parent=700 (group.legacyId), child=500 (tutorial.legacyId), order=2
    expect(rows).toEqual(expect.arrayContaining([
      [500, 600, 1],
      [700, 500, 2]
    ]));
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/exports/per-module.test.js -t "task-to-parent"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `srv/exports/task-to-parent.js`**

Two paged sub-queries, drained sequentially. Each ordered by its own primary key for stable pagination (Steps by `legacyId`, GroupPathItems by `legacyId`).

```javascript
import cds from '@sap/cds';

export const legacyHeader = ['PARENT_TASK_ID', 'CHILD_TASK_ID', 'ITEM_ORDER'];

export async function* rows(db, opts = {}) {
  const pageSize = opts.pageSize ?? 5000;
  const { Steps, GroupPathItems } = cds.entities('com.sap.developers.ims');

  // Step -> Tutorial edges
  let offset = 0;
  while (true) {
    const page = await db.run(
      SELECT.from(Steps)
        .columns('legacyId', 'stepOrder', 'tutorial.legacyId as parentLegacyId')
        .where({ tutorial_ID: { '!=': null } })
        .orderBy('legacyId asc')
        .limit(pageSize, offset)
    );
    if (!page.length) break;
    for (const r of page) yield [r.parentLegacyId, r.legacyId, r.stepOrder ?? ''];
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  // Tutorial -> Group edges (GroupPathItems.tutorial is not null)
  offset = 0;
  while (true) {
    const page = await db.run(
      SELECT.from(GroupPathItems)
        .columns('legacyId', 'itemOrder', 'group.legacyId as parentLegacyId', 'tutorial.legacyId as childLegacyId')
        .where({ tutorial_ID: { '!=': null } })
        .orderBy('legacyId asc')
        .limit(pageSize, offset)
    );
    if (!page.length) break;
    for (const r of page) yield [r.parentLegacyId, r.childLegacyId, r.itemOrder ?? ''];
    if (page.length < pageSize) break;
    offset += pageSize;
  }
}
```

Note on path-expression columns: `tutorial.legacyId as parentLegacyId` is valid CDS QL. If the runtime resolves this differently across SQLite vs HANA, fall back to two `cds.ql` queries (Steps with managed assoc → resolve `tutorial_ID`s → batch SELECT Tutorials by `ID in (...)` and join in JS). Validate with the unit test before committing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/exports/per-module.test.js -t "task-to-parent"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/exports/task-to-parent.js test/unit/exports/per-module.test.js
git commit -m "feat(exports): per-table module for IMS_TASK_TO_PARENT"
```

---

## Task 5: Per-table module — `completion-path.js`

**Files:**
- Create: `srv/exports/completion-path.js`
- Test: append a `describe('exports/completion-path', ...)` block

- [ ] **Step 1: Write the failing test**

```javascript
describe('exports/completion-path', () => {
  let mod;
  beforeAll(async () => { mod = await import('../../../srv/exports/completion-path.js'); });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { CompletionPaths, Missions } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(CompletionPaths));
    await db.run(DELETE.from(Missions));
  });

  it('emits the legacy IMS_COMPLETION_PATH header', () => {
    expect(mod.legacyHeader).toEqual(['ID', 'NAME', 'MISSION_ID', 'ITEM_ORDER']);
  });

  it('emits legacyId as ID and mission.legacyId as MISSION_ID', async () => {
    const db = await cds.connect.to('db');
    const { Missions, CompletionPaths } = cds.entities('com.sap.developers.ims');
    const misId = '11111111-1111-1111-1111-111111111111';
    await db.run(INSERT.into(Missions).entries({ ID: misId, legacyId: 900, title: 'M' }));
    await db.run(INSERT.into(CompletionPaths).entries({
      ID: '22222222-2222-2222-2222-222222222222',
      legacyId: 1000, name: 'P1', mission_ID: misId
    }));

    const rows = [];
    for await (const row of mod.rows(db, { pageSize: 100 })) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe(1000); // ID
    expect(rows[0][1]).toBe('P1'); // NAME
    expect(rows[0][2]).toBe(900);  // MISSION_ID
  });
});
```

Note: `IMS_COMPLETION_PATH` legacy schema includes `ITEM_ORDER` per spec — `CompletionPaths` has no native order field, so emit `''` (empty string) until the legacy data model needs it. Document inline.

- [ ] **Step 2: Run test, verify FAIL**

Run: `npx vitest run --project unit test/unit/exports/per-module.test.js -t "completion-path"`

- [ ] **Step 3: Implement**

```javascript
import cds from '@sap/cds';

export const legacyHeader = ['ID', 'NAME', 'MISSION_ID', 'ITEM_ORDER'];

export async function* rows(db, opts = {}) {
  const pageSize = opts.pageSize ?? 5000;
  const { CompletionPaths } = cds.entities('com.sap.developers.ims');
  let offset = 0;
  while (true) {
    const page = await db.run(
      SELECT.from(CompletionPaths)
        .columns('legacyId', 'name', 'mission.legacyId as missionLegacyId')
        .orderBy('legacyId asc')
        .limit(pageSize, offset)
    );
    if (!page.length) return;
    for (const r of page) yield [r.legacyId, r.name ?? '', r.missionLegacyId ?? '', ''];
    if (page.length < pageSize) return;
    offset += pageSize;
  }
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add srv/exports/completion-path.js test/unit/exports/per-module.test.js
git commit -m "feat(exports): per-table module for IMS_COMPLETION_PATH"
```

---

## Task 6: Per-table module — `completion-path-to-task.js`

**Files:**
- Create: `srv/exports/completion-path-to-task.js`
- Test: append a `describe('exports/completion-path-to-task', ...)` block

Per spec: each row populates exactly one of `TUTORIAL_ID`, `GROUP_ID`, or `CHECKPOINT_TITLE` based on `taskType`; the others are empty strings.

- [ ] **Step 1: Write the failing test**

```javascript
describe('exports/completion-path-to-task', () => {
  let mod;
  beforeAll(async () => { mod = await import('../../../srv/exports/completion-path-to-task.js'); });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { CompletionPathItems, CompletionPaths, Tutorials, Groups, Prizes } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(CompletionPathItems));
    await db.run(DELETE.from(CompletionPaths));
    await db.run(DELETE.from(Tutorials));
    await db.run(DELETE.from(Groups));
    await db.run(DELETE.from(Prizes));
  });

  it('emits the legacy IMS_COMPLETION_PATH_TO_TASK header', () => {
    expect(mod.legacyHeader).toEqual(['PATH_ID', 'TUTORIAL_ID', 'GROUP_ID', 'CHECKPOINT_TITLE', 'PRIZE_ID', 'ITEM_ORDER']);
  });

  it('populates exactly one of TUTORIAL_ID/GROUP_ID/CHECKPOINT_TITLE per row', async () => {
    const db = await cds.connect.to('db');
    const { CompletionPaths, CompletionPathItems, Tutorials, Groups } = cds.entities('com.sap.developers.ims');
    const pathId = '11111111-1111-1111-1111-111111111111';
    const tutId  = '22222222-2222-2222-2222-222222222222';
    const grpId  = '33333333-3333-3333-3333-333333333333';
    await db.run(INSERT.into(CompletionPaths).entries({ ID: pathId, legacyId: 1000, name: 'P' }));
    await db.run(INSERT.into(Tutorials).entries({ ID: tutId, legacyId: 100, title: 'T', slug: 't' }));
    await db.run(INSERT.into(Groups).entries({ ID: grpId, legacyId: 200, title: 'G' }));
    await db.run(INSERT.into(CompletionPathItems).entries([
      { ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', legacyId: 1, path_ID: pathId, taskType: 'TUTORIAL', tutorial_ID: tutId, taskLegacyId: 100, itemOrder: 1 },
      { ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', legacyId: 2, path_ID: pathId, taskType: 'GROUP', group_ID: grpId, taskLegacyId: 200, itemOrder: 2 },
      { ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc', legacyId: 3, path_ID: pathId, taskType: 'CHECKPOINT', checkpointTitle: 'Final boss', itemOrder: 3 }
    ]));

    const rows = [];
    for await (const row of mod.rows(db, { pageSize: 100 })) rows.push(row);
    expect(rows).toHaveLength(3);

    const [tut, grp, chk] = rows;
    expect([tut[1], tut[2], tut[3]]).toEqual([100, '', '']); // TUTORIAL row: TUTORIAL_ID set
    expect([grp[1], grp[2], grp[3]]).toEqual(['', 200, '']); // GROUP row: GROUP_ID set
    expect([chk[1], chk[2], chk[3]]).toEqual(['', '', 'Final boss']); // CHECKPOINT row
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement**

```javascript
import cds from '@sap/cds';

export const legacyHeader = ['PATH_ID', 'TUTORIAL_ID', 'GROUP_ID', 'CHECKPOINT_TITLE', 'PRIZE_ID', 'ITEM_ORDER'];

export async function* rows(db, opts = {}) {
  const pageSize = opts.pageSize ?? 5000;
  const { CompletionPathItems } = cds.entities('com.sap.developers.ims');
  let offset = 0;
  while (true) {
    const page = await db.run(
      SELECT.from(CompletionPathItems)
        .columns('legacyId', 'taskType', 'itemOrder',
                 'path.legacyId as pathLegacyId',
                 'tutorial.legacyId as tutorialLegacyId',
                 'group.legacyId as groupLegacyId',
                 'checkpointTitle',
                 'prize.legacyId as prizeLegacyId')
        .orderBy('legacyId asc')
        .limit(pageSize, offset)
    );
    if (!page.length) return;
    for (const r of page) {
      const tut = r.taskType === 'TUTORIAL' ? (r.tutorialLegacyId ?? '') : '';
      const grp = r.taskType === 'GROUP'    ? (r.groupLegacyId ?? '')    : '';
      const chk = r.taskType === 'CHECKPOINT' ? (r.checkpointTitle ?? '') : '';
      yield [r.pathLegacyId ?? '', tut, grp, chk, r.prizeLegacyId ?? '', r.itemOrder ?? ''];
    }
    if (page.length < pageSize) return;
    offset += pageSize;
  }
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add srv/exports/completion-path-to-task.js test/unit/exports/per-module.test.js
git commit -m "feat(exports): per-table module for IMS_COMPLETION_PATH_TO_TASK"
```

---

## Task 7: Per-table module — `step-failures.js`

**Files:**
- Create: `srv/exports/step-failures.js`
- Test: append a `describe('exports/step-failures', ...)` block

Spec section "IMS_STEP_FAILURE columns" — emit the full legacy header. CAP only stores 6 of 13 fields; emit `''` for the other 7 (`RULE`, `QUESTION`, `MATCH`, `ANSWER`, `STEP_URL`, `TUTORIAL_ID`, `TITLE`).

- [ ] **Step 1: Write the failing test**

```javascript
describe('exports/step-failures', () => {
  let mod;
  beforeAll(async () => { mod = await import('../../../srv/exports/step-failures.js'); });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { StepFailures, TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(StepFailures));
    await db.run(DELETE.from(TaskRecords));
    await db.run(DELETE.from(Users));
  });

  it('emits the FULL legacy IMS_STEP_FAILURE header (13 columns)', () => {
    expect(mod.legacyHeader).toEqual([
      'ID', 'TASK_RECORD_ID', 'STEP_NUMBER', 'FAILURE_DATE', 'ERROR_MESSAGE',
      'RULE', 'QUESTION', 'MATCH', 'ANSWER', 'STEP_URL', 'TUTORIAL_ID', 'TITLE',
      'CREATED_AT'
    ]);
  });

  it('emits empty strings for the 7 missing legacy fields on every row', async () => {
    const db = await cds.connect.to('db');
    const { Users, TaskRecords, StepFailures } = cds.entities('com.sap.developers.ims');
    const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const trId   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await db.run(INSERT.into(Users).entries({ ID: userId, uuid: userId }));
    await db.run(INSERT.into(TaskRecords).entries({
      ID: trId, user_ID: userId, taskLegacyId: 100, taskType: 'TUTORIAL', status: 'IN_PROGRESS', legacyId: 1
    }));
    await db.run(INSERT.into(StepFailures).entries({
      ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      legacyId: 2, taskRecord_ID: trId, stepNumber: 3, errorMessage: 'boom'
    }));

    const rows = [];
    for await (const row of mod.rows(db, { pageSize: 100 })) rows.push(row);
    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(r[1]).toBe(trId);    // TASK_RECORD_ID = UUID string
    expect(r[2]).toBe(3);       // STEP_NUMBER
    expect(r[4]).toBe('boom');  // ERROR_MESSAGE
    // 7 missing columns (indices 5..11) are empty strings
    [5, 6, 7, 8, 9, 10, 11].forEach(i => expect(r[i]).toBe(''));
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement**

```javascript
import cds from '@sap/cds';

export const legacyHeader = [
  'ID', 'TASK_RECORD_ID', 'STEP_NUMBER', 'FAILURE_DATE', 'ERROR_MESSAGE',
  'RULE', 'QUESTION', 'MATCH', 'ANSWER', 'STEP_URL', 'TUTORIAL_ID', 'TITLE',
  'CREATED_AT'
];

export async function* rows(db, opts = {}) {
  const pageSize = opts.pageSize ?? 5000;
  const { StepFailures } = cds.entities('com.sap.developers.ims');
  let offset = 0;
  while (true) {
    const page = await db.run(
      SELECT.from(StepFailures)
        .columns('ID', 'taskRecord_ID', 'stepNumber', 'failureDate', 'errorMessage', 'createdAt', 'legacyId')
        .orderBy('legacyId asc')
        .limit(pageSize, offset)
    );
    if (!page.length) return;
    for (const r of page) {
      yield [
        r.ID, r.taskRecord_ID, r.stepNumber ?? '', r.failureDate ?? '', r.errorMessage ?? '',
        '', '', '', '', '', '', '',  // RULE, QUESTION, MATCH, ANSWER, STEP_URL, TUTORIAL_ID, TITLE
        r.createdAt ?? ''
      ];
    }
    if (page.length < pageSize) return;
    offset += pageSize;
  }
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add srv/exports/step-failures.js test/unit/exports/per-module.test.js
git commit -m "feat(exports): per-table module for IMS_STEP_FAILURE"
```

---

## Task 8: CSV-ZIP bundle assembler

**Files:**
- Create: `srv/exports/assemble-csv-zip.js`
- Test: `test/unit/exports/bundle-csv-zip.test.js`

The assembler creates an `archiver('zip')`, appends a pass-through stream per module driven by `csv-stringify`, and pipes the archive to the response.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { PassThrough } from 'node:stream';
import { Buffer } from 'node:buffer';
// Use a programmatic ZIP reader. yauzl is reasonable; if not already a dev-dep,
// substitute streamed parsing via node:stream/web. Pick whichever works on Win.
import yauzl from 'yauzl';

cds.test(path.join(process.cwd(), 'db'));

describe('assemble-csv-zip', () => {
  let assemble;
  beforeAll(async () => {
    assemble = (await import('../../../srv/exports/assemble-csv-zip.js')).assembleCsvZip;
  });

  beforeEach(async () => {
    // Truncate every table the modules read from.
    const db = await cds.connect.to('db');
    for (const name of ['Tutorials','Missions','Groups','Steps','Checkpoints',
                        'TaskRecords','StepFailures','CompletionPaths','CompletionPathItems',
                        'GroupPathItems','Users']) {
      await db.run(DELETE.from(cds.entities('com.sap.developers.ims')[name]));
    }
  });

  it('produces a ZIP with 6 entries, each named IMS_*.csv with the legacy header line', async () => {
    const sink = new PassThrough();
    const chunks = [];
    sink.on('data', c => chunks.push(c));

    const db = await cds.connect.to('db');
    await assemble(db, sink);
    const buf = Buffer.concat(chunks);

    const entries = await new Promise((resolve, reject) => {
      yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        const names = [];
        zipfile.on('entry', e => { names.push(e.fileName); zipfile.readEntry(); });
        zipfile.on('end', () => resolve(names));
        zipfile.readEntry();
      });
    });

    expect(entries.sort()).toEqual([
      'IMS_COMPLETION_PATH.csv',
      'IMS_COMPLETION_PATH_TO_TASK.csv',
      'IMS_STEP_FAILURE.csv',
      'IMS_TASK.csv',
      'IMS_TASK_RECORD.csv',
      'IMS_TASK_TO_PARENT.csv'
    ]);
  });
});
```

If `yauzl` isn't installed, install as a **dev** dependency: `npm install --save-dev yauzl` (subject to the same exact-pin rule).

- [ ] **Step 2: Run test, verify FAIL**

Run: `npx vitest run --project unit test/unit/exports/bundle-csv-zip.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `srv/exports/assemble-csv-zip.js`**

```javascript
import archiver from 'archiver';
import { stringify as csvStringify } from 'csv-stringify';
import { PassThrough } from 'node:stream';

import * as tasks from './tasks.js';
import * as taskRecords from './task-records.js';
import * as taskToParent from './task-to-parent.js';
import * as completionPath from './completion-path.js';
import * as completionPathToTask from './completion-path-to-task.js';
import * as stepFailures from './step-failures.js';

const FILES = [
  ['IMS_TASK.csv',                     tasks],
  ['IMS_TASK_RECORD.csv',              taskRecords],
  ['IMS_TASK_TO_PARENT.csv',           taskToParent],
  ['IMS_COMPLETION_PATH.csv',          completionPath],
  ['IMS_COMPLETION_PATH_TO_TASK.csv',  completionPathToTask],
  ['IMS_STEP_FAILURE.csv',             stepFailures]
];

export async function assembleCsvZip(db, outStream, opts = {}) {
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(outStream);

  for (const [name, mod] of FILES) {
    const pass = new PassThrough();
    archive.append(pass, { name });

    const stringifier = csvStringify({ header: true, columns: mod.legacyHeader });
    stringifier.pipe(pass);

    for await (const row of mod.rows(db, opts)) {
      // Backpressure-aware write.
      if (!stringifier.write(row)) {
        await new Promise(res => stringifier.once('drain', res));
      }
    }
    stringifier.end();
    // Wait until this entry is fully consumed before appending the next, so
    // archiver can finalize entries one-at-a-time without buffering everything.
    await new Promise((res, rej) => { pass.on('end', res); pass.on('error', rej); });
  }

  await archive.finalize();
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add srv/exports/assemble-csv-zip.js test/unit/exports/bundle-csv-zip.test.js package.json package-lock.json
git commit -m "feat(exports): CSV-ZIP bundle assembler"
```

(Stage `package.json` + `package-lock.json` only if `yauzl` was just added.)

---

## Task 9: XLSX bundle assembler

**Files:**
- Create: `srv/exports/assemble-xlsx.js`
- Test: `test/unit/exports/bundle-xlsx.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { PassThrough } from 'node:stream';
import { Buffer } from 'node:buffer';
import ExcelJS from 'exceljs';

cds.test(path.join(process.cwd(), 'db'));

describe('assemble-xlsx', () => {
  let assemble;
  beforeAll(async () => { assemble = (await import('../../../srv/exports/assemble-xlsx.js')).assembleXlsx; });

  // Identical truncate-everything beforeEach as the ZIP test.

  it('produces a workbook with 6 sheets, legacy names, header rows', async () => {
    const sink = new PassThrough();
    const chunks = [];
    sink.on('data', c => chunks.push(c));

    const db = await cds.connect.to('db');
    await assemble(db, sink);
    const buf = Buffer.concat(chunks);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheetNames = wb.worksheets.map(ws => ws.name).sort();
    expect(sheetNames).toEqual([
      'IMS_COMPLETION_PATH',
      'IMS_COMPLETION_PATH_TO_TASK',
      'IMS_STEP_FAILURE',
      'IMS_TASK',
      'IMS_TASK_RECORD',
      'IMS_TASK_TO_PARENT'
    ]);

    const taskSheet = wb.getWorksheet('IMS_TASK');
    expect(taskSheet.getRow(1).values.slice(1)).toEqual([
      'ID', 'TITLE', 'DESCRIPTION', 'STATUS', 'DELETION_REASON',
      'PRIMARY_TAG', 'EXPERIENCE_TAG', 'AVERAGE_TIME_TO_COMPLETE',
      'TASK_TYPE', 'CREATED_AT', 'MODIFIED_AT'
    ]);
  });
});
```

(`getRow(1).values` is 1-indexed in exceljs; slice(1) drops the leading null.)

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement `srv/exports/assemble-xlsx.js`**

```javascript
import ExcelJS from 'exceljs';

import * as tasks from './tasks.js';
import * as taskRecords from './task-records.js';
import * as taskToParent from './task-to-parent.js';
import * as completionPath from './completion-path.js';
import * as completionPathToTask from './completion-path-to-task.js';
import * as stepFailures from './step-failures.js';

const SHEETS = [
  ['IMS_TASK',                     tasks],
  ['IMS_TASK_RECORD',              taskRecords],
  ['IMS_TASK_TO_PARENT',           taskToParent],
  ['IMS_COMPLETION_PATH',          completionPath],
  ['IMS_COMPLETION_PATH_TO_TASK',  completionPathToTask],
  ['IMS_STEP_FAILURE',             stepFailures]
];

export async function assembleXlsx(db, outStream, opts = {}) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: outStream, useStyles: false });
  for (const [name, mod] of SHEETS) {
    const ws = wb.addWorksheet(name);
    ws.addRow(mod.legacyHeader).commit();
    for await (const row of mod.rows(db, opts)) {
      ws.addRow(row).commit();
    }
    ws.commit();
  }
  await wb.commit();
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add srv/exports/assemble-xlsx.js test/unit/exports/bundle-xlsx.test.js
git commit -m "feat(exports): XLSX bundle assembler"
```

---

## Task 10: CDS service + handler

**Files:**
- Create: `srv/exports-service.cds`
- Create: `srv/exports-service.js`

The CDS action exists for OData metadata parity (and to centralize the `@requires:'Admin'` annotation). The actual download path is the GET bridge (Task 11). The handler in `.js` validates `format` and returns a small JSON body if invoked over OData; the streaming path is exclusively via the bridge.

- [ ] **Step 1: Create `srv/exports-service.cds`**

```cds
@requires : 'Admin'
service ExportsService @(path : '/admin/exports') {
  action exportLegacyData(format : String) returns LargeBinary;
}
```

- [ ] **Step 2: Create `srv/exports-service.js`**

```javascript
import cds from '@sap/cds';

export default cds.service.impl(function () {
  this.on('exportLegacyData', async (req) => {
    const format = (req.data?.format || '').toLowerCase();
    if (format !== 'csv' && format !== 'xlsx') {
      return req.reject(400, `Unsupported format: ${req.data?.format}. Use 'csv' or 'xlsx'.`);
    }
    // OData clients should not be invoking this — the UI uses the GET bridge.
    // Returning a hint keeps the metadata document honest while preventing
    // surprise OData callers from receiving a half-streamed binary they cannot
    // reassemble. The bridge is the single source of truth for streaming.
    return req.reject(501, 'Use GET /admin/exports/exportLegacyData?format=<csv|xlsx> for streaming downloads.');
  });
});
```

- [ ] **Step 3: Verify CAP boots cleanly**

Run: `npx cds compile srv/exports-service.cds 2>&1 | head -20`
Expected: no errors, no `[ERROR]` lines.

- [ ] **Step 4: Commit**

```bash
git add srv/exports-service.cds srv/exports-service.js
git commit -m "feat(exports): ExportsService action declaration with Admin guard"
```

---

## Task 11: Express bridge + server.js wiring

**Files:**
- Create: `srv/exports/express-bridge.js`
- Modify: `srv/server.js` (add import + register call inside `cds.on('bootstrap')`)
- Test: extend `test/unit/exports/bundle-csv-zip.test.js` (or add `bridge.test.js`) — see Step 1

The bridge MUST be registered in `bootstrap` (before `cds.serve` mounts ExportsService at `/admin/exports`), mirroring the late-bound pattern at [srv/server.js:30-36](srv/server.js#L30-L36) for `analyticsOdataRouter`. Use `is('Admin')` for scope enforcement after `cds.middlewares.auth` runs.

- [ ] **Step 1: Write the failing test**

Create `test/unit/exports/bridge.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import http from 'node:http';

cds.test(path.join(process.cwd())); // load full project (server.js)

describe('GET /admin/exports/exportLegacyData', () => {
  it('rejects an anonymous user with 401 or 403', async () => {
    const res = await fetch(`http://localhost:${cds.app?.server?.address()?.port}/admin/exports/exportLegacyData?format=csv`);
    expect([401, 403]).toContain(res.status);
  });

  it('rejects an unsupported format with 400 (admin user)', async () => {
    // cds.test by default authenticates as 'alice' with role Admin in dev.
    const res = await fetch(`http://localhost:${cds.app?.server?.address()?.port}/admin/exports/exportLegacyData?format=parquet`, {
      headers: { Authorization: 'Basic ' + Buffer.from('alice:').toString('base64') }
    });
    expect(res.status).toBe(400);
  });

  it('returns a ZIP with content-disposition for format=csv (admin user)', async () => {
    const res = await fetch(`http://localhost:${cds.app?.server?.address()?.port}/admin/exports/exportLegacyData?format=csv`, {
      headers: { Authorization: 'Basic ' + Buffer.from('alice:').toString('base64') }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="ims-export-csv-\d{8}-\d{6}\.zip"$/);
  });
});
```

If `cds.test()` mock-users come up differently (the project's [srv/server.js:213-226](srv/server.js#L213-L226) reads `cds.context.user`), check `package.json` `cds.requires.auth` or the existing hybrid tests for the user fixture pattern. Adjust the auth header per project convention.

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement `srv/exports/express-bridge.js`**

```javascript
import cds from '@sap/cds';
import { assembleCsvZip } from './assemble-csv-zip.js';
import { assembleXlsx } from './assemble-xlsx.js';

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

let bridgeHandler = (req, res) => res.status(503).json({ error: 'service_starting' });

export function registerExportsBridge(app) {
  // Reserve the GET path BEFORE CAP mounts ExportsService at /admin/exports.
  // ExportsService's OData adapter would otherwise interpret 'exportLegacyData'
  // as a resource path and fail.
  app.get('/admin/exports/exportLegacyData', (req, res, next) => bridgeHandler(req, res, next));
}

export function wireExportsBridge() {
  const contextMw = cds.middlewares?.context?.() || ((req, res, next) => next());
  const authMw    = cds.middlewares?.auth?.()    || ((req, res, next) => next());

  bridgeHandler = (req, res, next) => {
    contextMw(req, res, (err) => {
      if (err) return next(err);
      authMw(req, res, async (err) => {
        if (err) return next(err);
        try {
          const user = cds.context?.user;
          if (!user?.id || user.id === 'anonymous') return res.status(401).json({ error: 'unauthenticated' });
          if (!(user.is && user.is('Admin'))) return res.status(403).json({ error: 'forbidden' });

          const format = String(req.query.format || '').toLowerCase();
          if (format !== 'csv' && format !== 'xlsx') {
            return res.status(400).json({ error: `unsupported format: ${req.query.format}` });
          }

          const ts = timestamp();
          const db = await cds.connect.to('db');

          if (format === 'csv') {
            res.status(200);
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="ims-export-csv-${ts}.zip"`);
            await assembleCsvZip(db, res);
          } else {
            res.status(200);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="ims-export-${ts}.xlsx"`);
            await assembleXlsx(db, res);
          }
        } catch (err) {
          cds.log('exports').error({ stage: 'bridge', error: err.message, stack: err.stack });
          // Headers may already be flushed — best-effort end of stream.
          if (!res.headersSent) res.status(500).json({ error: 'export_failed' });
          else res.end();
        }
      });
    });
  };
}
```

- [ ] **Step 4: Wire into `srv/server.js`**

Add `import { registerExportsBridge, wireExportsBridge } from './exports/express-bridge.js';` near the other imports.

Inside `cds.on('bootstrap', (app) => { ... })`, after the `app.use('/admin/analytics', ...)` line, add:

```javascript
registerExportsBridge(app);
```

Inside `cds.on('served', async () => { ... })` (the first `served` block), after the `analyticsOdataRouter` wiring, add:

```javascript
wireExportsBridge();
```

- [ ] **Step 5: Run test, verify PASS**

Run: `npx vitest run --project unit test/unit/exports/bridge.test.js`
Expected: PASS on all three cases.

- [ ] **Step 6: Run the full unit suite to make sure nothing else broke**

Run: `npm test`
Expected: 620+ passing (per `project_main_test_failures.md` baseline as of 2026-05-23). 0 new failures.

- [ ] **Step 7: Commit**

```bash
git add srv/exports/express-bridge.js srv/server.js test/unit/exports/bridge.test.js
git commit -m "feat(exports): GET bridge for streaming downloads with Admin scope"
```

---

## Task 12: UI — DataExport view and controller

**Files:**
- Create: `app/admin-shell/webapp/view/DataExport.view.xml`
- Create: `app/admin-shell/webapp/controller/DataExport.controller.js`

Pattern mirrors [Statistics.view.xml](../../app/admin-shell/webapp/view/Statistics.view.xml) but the controller uses `window.location.href` rather than the OData binding download (because the bridge serves the file as a streamed GET, not an OData action POST). See [Statistics.controller.js:14-20](../../app/admin-shell/webapp/controller/Statistics.controller.js#L14-L20) for the Blob+createObjectURL pattern that we are *not* reusing here.

- [ ] **Step 1: Create the view**

`app/admin-shell/webapp/view/DataExport.view.xml`:

```xml
<mvc:View
  controllerName="sap.tutorials.admin.shell.controller.DataExport"
  xmlns:mvc="sap.ui.core.mvc"
  xmlns="sap.m"
  xmlns:core="sap.ui.core">
  <Page title="Data Export" enableScrolling="true">
    <content>
      <Panel headerText="Legacy IMS Reporting Files" class="sapUiSmallMargin">
        <content>
          <Text text="Exports the legacy IMS-equivalent reporting files for use in external tools." class="sapUiSmallMarginBottom"/>
          <List headerText="Bundle contents" class="sapUiSmallMarginBottom">
            <StandardListItem title="IMS_TASK"                description="Polymorphic catalog rows: Tutorials, Missions, Groups, Steps, Checkpoints"/>
            <StandardListItem title="IMS_TASK_RECORD"         description="Per-user attempt and completion rows"/>
            <StandardListItem title="IMS_TASK_TO_PARENT"      description="Parent edges: Step -> Tutorial, Tutorial -> Group"/>
            <StandardListItem title="IMS_COMPLETION_PATH"     description="Named paths that tie Tutorials/Groups/Checkpoints into Missions"/>
            <StandardListItem title="IMS_COMPLETION_PATH_TO_TASK" description="Path-to-task ordered membership rows"/>
            <StandardListItem title="IMS_STEP_FAILURE"        description="Per-step failure events captured during a TaskRecord"/>
          </List>
          <HBox alignItems="Center" class="sapUiSmallMarginBottom">
            <Label text="Format" labelFor="formatSelect" class="sapUiTinyMarginEnd"/>
            <SegmentedButton id="formatSelect" selectedKey="csv">
              <items>
                <SegmentedButtonItem key="csv" text="CSV (ZIP)"/>
                <SegmentedButtonItem key="xlsx" text="Excel (XLSX)"/>
              </items>
            </SegmentedButton>
          </HBox>
          <MessageStrip
            id="errorStrip"
            visible="false"
            type="Error"
            showIcon="true"
            class="sapUiSmallMarginBottom"/>
          <Button
            text="Download bundle"
            icon="sap-icon://download"
            iconFirst="true"
            type="Emphasized"
            press=".onDownload"/>
        </content>
      </Panel>
    </content>
  </Page>
</mvc:View>
```

- [ ] **Step 2: Create the controller**

`app/admin-shell/webapp/controller/DataExport.controller.js`:

```javascript
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/BusyDialog"
], function (Controller, BusyDialog) {
  "use strict";
  return Controller.extend("sap.tutorials.admin.shell.controller.DataExport", {
    onInit: function () {
      this._busy = new BusyDialog({
        title: "Generating export",
        text: "This can take several minutes for large datasets."
      });
    },

    onDownload: function () {
      var sFormat = this.byId("formatSelect").getSelectedKey() || "csv";
      var oStrip = this.byId("errorStrip");
      oStrip.setVisible(false);

      // No XHR — the browser handles the binary stream, content-disposition,
      // and saves to disk. window.location.href is the right primitive for
      // server-driven downloads where the response is too large to buffer.
      this._busy.open();
      try {
        window.location.href = "/admin/exports/exportLegacyData?format=" + encodeURIComponent(sFormat);
      } catch (e) {
        oStrip.setText("Could not initiate download: " + (e && e.message));
        oStrip.setVisible(true);
      } finally {
        // Close the busy dialog after a short delay; once the browser starts
        // the download, navigation does not actually happen, so this is the
        // simplest reliable way to clear the UI.
        setTimeout(function () { this._busy.close(); }.bind(this), 1500);
      }
    }
  });
});
```

- [ ] **Step 3: Quick smoke load via the dev approuter (manual)**

Run: `npm run dev:hybrid` (starts CAP + approuter). Navigate to `http://localhost:5000/admin-ui/#/dataExport` — expect "Cannot match any route" (we haven't wired the manifest yet, that's Task 13). Confirms the view file at least parses on the next task once routing exists. Skip if already familiar with the project's local dev loop.

- [ ] **Step 4: Commit**

```bash
git add app/admin-shell/webapp/view/DataExport.view.xml app/admin-shell/webapp/controller/DataExport.controller.js
git commit -m "feat(admin): DataExport view + controller (window.location.href download)"
```

---

## Task 13: Wire the new view into the shell (nav + routing)

**Files:**
- Modify: `app/admin-shell/webapp/view/Shell.view.xml`
- Modify: `app/admin-shell/webapp/controller/Shell.controller.js`
- Modify: `app/admin-shell/webapp/manifest.json`

- [ ] **Step 1: Add the nav item**

In `app/admin-shell/webapp/view/Shell.view.xml`, inside the System group at line 90-102, insert between "Statistics" (line 99) and "Joule Settings" (line 100):

```xml
<tnt:NavigationListItem text="Data Export" key="dataExport" icon="sap-icon://download" />
```

- [ ] **Step 2: Add the route key**

In `app/admin-shell/webapp/controller/Shell.controller.js`:

In `NAV_KEY_TO_ROUTE` (line 8-29), add:
```javascript
dataExport: "dataExport",
```

In `NAV_KEY_TO_TITLE` (line 31-52), add:
```javascript
dataExport: "Data Export",
```

- [ ] **Step 3: Add the manifest route + target**

In `app/admin-shell/webapp/manifest.json`:

In the `routes` array (after the `statistics` entry at line 183), add:
```json
{ "name": "dataExport", "pattern": "dataExport", "target": "dataExportTarget" },
```

In the `targets` object (after `statisticsTarget` at line 290), add:
```json
"dataExportTarget": {
  "viewName": "DataExport",
  "viewLevel": 1
},
```

- [ ] **Step 4: Manually verify nav works**

Run: `npm run dev:hybrid`, navigate to `http://localhost:5000/admin-ui/#/dataExport`. Expect to see the Data Export view rendered, "Download bundle" button visible. Click it — for now it should fire a request and either stream the bundle (if Tasks 8-11 already deployed locally) or show 404/connection error (acceptable; we'll verify end-to-end in Task 16).

- [ ] **Step 5: Commit**

```bash
git add app/admin-shell/webapp/view/Shell.view.xml app/admin-shell/webapp/controller/Shell.controller.js app/admin-shell/webapp/manifest.json
git commit -m "feat(admin): wire Data Export into shell nav and router"
```

---

## Task 14: Approuter route + timeout

**Files:**
- Modify: `approuter/xs-app.json`

Insert a new route `^/admin/exports/(.*)$` *before* the existing `^/admin/(.*)$` (line 96-102) so it wins the match. Carry the same XSUAA + `$XSAPPNAME.Admin` settings, but bump `timeout` to 600000 ms.

- [ ] **Step 1: Edit `approuter/xs-app.json`**

Insert before the `^/admin/(.*)$` route block:

```json
{
  "source": "^/admin/exports/(.*)$",
  "target": "/admin/exports/$1",
  "destination": "srv-api",
  "authenticationType": "xsuaa",
  "scope": "$XSAPPNAME.Admin",
  "csrfProtection": false,
  "timeout": 600000
},
```

- [ ] **Step 2: Validate JSON syntax**

Run: `jq '.routes[] | select(.source | test("admin/exports"))' approuter/xs-app.json`
Expected: prints exactly the inserted object. No `parse error`.

- [ ] **Step 3: Verify ordering**

Run: `jq '.routes | map(.source) | to_entries[] | select(.value | test("admin"))' approuter/xs-app.json`
Expected: `^/admin/exports/(.*)$` index < `^/admin/analytics/(.*)$` index < `^/admin/(.*)$` index. (The `analytics` route already comes before the catch-all; ours must come before `analytics` too — admin/exports is more specific than admin/analytics in path overlap terms only if any analytics path starts with `exports`, which it doesn't. Either ordering before `^/admin/(.*)$` works. Pick the position right above `^/admin/analytics/(.*)$` for readability.)

- [ ] **Step 4: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(approuter): route /admin/exports with 10-minute timeout"
```

---

## Task 15: Hybrid HANA test

**Files:**
- Create: `test/hybrid/admin-exports.test.js`

Read-only test against real HANA via `cds bind --exec`. Honors the `_guard.js` write-safety convention — no inserts, deletes, or updates.

- [ ] **Step 1: Write the test**

```javascript
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import yauzl from 'yauzl';
import { Buffer } from 'node:buffer';
import ExcelJS from 'exceljs';

cds.test(path.join(process.cwd()));

const baseUrl = () => `http://localhost:${cds.app?.server?.address()?.port}`;
const adminAuth = { Authorization: 'Basic ' + Buffer.from('alice:').toString('base64') }; // adjust to project convention

describe('admin exports (hybrid HANA)', () => {
  it('csv: returns ZIP with 6 IMS_*.csv entries', async () => {
    const res = await fetch(`${baseUrl()}/admin/exports/exportLegacyData?format=csv`, { headers: adminAuth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const buf = Buffer.from(await res.arrayBuffer());
    const names = await new Promise((resolve, reject) => {
      yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
        if (err) return reject(err);
        const out = [];
        zip.on('entry', e => { out.push(e.fileName); zip.readEntry(); });
        zip.on('end', () => resolve(out));
        zip.readEntry();
      });
    });
    expect(names.sort()).toEqual([
      'IMS_COMPLETION_PATH.csv','IMS_COMPLETION_PATH_TO_TASK.csv',
      'IMS_STEP_FAILURE.csv','IMS_TASK.csv','IMS_TASK_RECORD.csv','IMS_TASK_TO_PARENT.csv'
    ]);
  });

  it('xlsx: returns workbook with 6 IMS_* sheets', async () => {
    const res = await fetch(`${baseUrl()}/admin/exports/exportLegacyData?format=xlsx`, { headers: adminAuth });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    expect(wb.worksheets.map(w => w.name).sort()).toEqual([
      'IMS_COMPLETION_PATH','IMS_COMPLETION_PATH_TO_TASK',
      'IMS_STEP_FAILURE','IMS_TASK','IMS_TASK_RECORD','IMS_TASK_TO_PARENT'
    ]);
  });

  it('rejects anonymous with 401/403', async () => {
    const res = await fetch(`${baseUrl()}/admin/exports/exportLegacyData?format=csv`);
    expect([401, 403]).toContain(res.status);
  });

  it('rejects invalid format with 400', async () => {
    const res = await fetch(`${baseUrl()}/admin/exports/exportLegacyData?format=json`, { headers: adminAuth });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run hybrid suite**

Pre-req: `cf login` to DEV space. Run: `npm run test:hybrid -- test/hybrid/admin-exports.test.js`
Expected: all 4 tests PASS against real HANA.

If a test reveals a path-expression / CDS QL incompatibility on HANA that didn't show up on SQLite (e.g. for `task-to-parent.js` step→tutorial join), patch the offending module and re-run.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/admin-exports.test.js
git commit -m "test(exports): hybrid HANA test for /admin/exports/exportLegacyData"
```

---

## Task 16: Smoke test against deployed environment

**Files:**
- Create: `test/smoke/admin-exports.smoke.test.js`

- [ ] **Step 1: Write the test**

```javascript
import { describe, it, expect } from 'vitest';

const APPROUTER = process.env.SMOKE_BASE_URL;
const SRV       = process.env.SMOKE_SRV_URL;

describe.runIf(APPROUTER && SRV)('admin exports smoke', () => {
  it('rejects anonymous request to approuter with 401', async () => {
    const res = await fetch(`${APPROUTER}/admin/exports/exportLegacyData?format=csv`, { redirect: 'manual' });
    // Approuter returns 401 (or 302 to XSUAA login) for unauthenticated; both prove the route is protected
    expect([401, 302]).toContain(res.status);
  });

  // The remaining cases hit srv directly with a tech-user / smoke token
  // exposed via SMOKE_ADMIN_TOKEN. If the project does not provide one,
  // these cases must be skipped in CI but kept for ad-hoc local runs.
  const ADMIN_TOKEN = process.env.SMOKE_ADMIN_TOKEN;
  describe.runIf(ADMIN_TOKEN)('with admin token', () => {
    it('GET csv: 200, content-type application/zip, ZIP magic', async () => {
      const res = await fetch(`${SRV}/admin/exports/exportLegacyData?format=csv`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/zip');
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="ims-export-csv-\d{8}-\d{6}\.zip"$/);
      const buf = Buffer.from(await res.arrayBuffer());
      // PK\x03\x04 = local file header signature
      expect(buf.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    });

    it('GET xlsx: 200, correct content-type, ZIP magic (xlsx is a zip container)', async () => {
      const res = await fetch(`${SRV}/admin/exports/exportLegacyData?format=xlsx`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    });
  });
});
```

`describe.runIf` keeps the suite passive when smoke env vars are absent (matches the `qa-routes.test.ts` self-skip pattern).

- [ ] **Step 2: Local sanity check**

Run: `npm run test:smoke` with both `SMOKE_BASE_URL` and `SMOKE_SRV_URL` unset. Expected: file is collected but every test is skipped.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/admin-exports.smoke.test.js
git commit -m "test(exports): smoke test for deployed /admin/exports endpoint"
```

---

## Task 17: Local deploy + manual verification

This is a manual step done outside CI per the project's documented local-deploy process (`feedback_standalone_approuter_deploy.md`, `project_local_deploy_process.md`).

- [ ] **Step 1: Build and deploy via local MTA**

Run:
```bash
cd .deploy
mbt build
cf deploy mta_archives/tutorials-poc_1.0.0.mtar -e ../deploy/dev.mtaext
```

Expected: both `tutorials-srv` and approuter restart cleanly. No new service bindings required.

- [ ] **Step 2: Click the download in the deployed admin UI**

Navigate to `https://<approuter-url>/admin-ui/#/dataExport`. Login as Admin. Click "Download bundle" with CSV format. Verify the browser saves `ims-export-csv-<timestamp>.zip`. Open the ZIP — 6 entries, each with the legacy header row. Repeat with XLSX format; open in Excel — 6 sheets, headers present.

- [ ] **Step 3: Watch the srv RSS during a streaming download**

In another terminal: `cf app tutorials-srv` (or `cf logs tutorials-srv --recent`). Trigger a download. Confirm RSS does not balloon — should stay near baseline (a few hundred MB at most). Document the observation in the PR description.

- [ ] **Step 4: Run the deployed smoke suite**

Run: `SMOKE_BASE_URL=<approuter-url> SMOKE_SRV_URL=<srv-url> SMOKE_ADMIN_TOKEN=<token> npm run test:smoke -- test/smoke/admin-exports.smoke.test.js`
Expected: PASS.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin worktree-admin-data-export-spec
gh pr create --title "feat(admin): legacy IMS data export tool" --body "$(cat <<'EOF'
## Summary
- New `ExportsService` at `/admin/exports` with `exportLegacyData(format)` action and Express GET bridge for streamed downloads
- Six per-table modules (`IMS_TASK`, `IMS_TASK_RECORD`, `IMS_TASK_TO_PARENT`, `IMS_COMPLETION_PATH`, `IMS_COMPLETION_PATH_TO_TASK`, `IMS_STEP_FAILURE`) paged at 5000 rows
- CSV-ZIP and XLSX bundle assemblers (streaming, no full-table buffering)
- Admin shell side-nav entry under System and a custom DataExport view
- Approuter route with 10-minute timeout for the export endpoint
- Unit (per-module + bundle + bridge), hybrid HANA, and smoke coverage

## Test plan
- [ ] `npm test` — unit suite green (620+ baseline + new exports tests)
- [ ] `npm run test:hybrid -- test/hybrid/admin-exports.test.js` — green against DEV HANA
- [ ] Local deploy via `mbt build && cf deploy`
- [ ] Manual: download CSV bundle from deployed admin UI, open ZIP, verify 6 IMS_*.csv entries
- [ ] Manual: download XLSX bundle, open in Excel, verify 6 IMS_* sheets
- [ ] Manual: watch `cf app tutorials-srv` RSS during stream, confirm no buffering balloon
- [ ] `SMOKE_*` smoke run against deployed environment
EOF
)"
```

(Per `feedback_pr_over_direct_merge.md`: open a PR, do not direct-push to main. Tom reviews; subagent review ≠ PR review.)

---

## Done criteria

- All 17 tasks committed.
- Unit suite green (620+ baseline + new tests).
- Hybrid suite green against DEV HANA.
- Local deploy succeeds; download works end-to-end for both formats.
- PR open, awaiting Tom's review.
- No raw SQL, no `req.user` without `@requires`, no new `@sap/*` deps. `min-release-age=1` and `save-exact=true` honored for the three new top-level deps.
