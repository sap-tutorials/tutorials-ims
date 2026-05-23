# Admin Data Export — Design Spec

**Date:** 2026-05-23
**Status:** Draft for review
**Owner:** Tom Jung

## Goal

Provide a one-click admin tool that exports the CAP-backed equivalents of the legacy IMS reporting tables, in CSV and XLSX, so that the same off-platform reporting queries the team runs today against IMS keep working after the IMS-to-CAP cutover.

The legacy tables we replace:
- `IMS_TASK` — the polymorphic catalog row (Tutorial / Mission / Group / Step / Checkpoint)
- `IMS_TASK_RECORD` — per-user attempt and completion rows
- `IMS_TASK_TO_PARENT` — the polymorphic parent edge (Step→Tutorial, Tutorial→Group)
- `IMS_COMPLETION_PATH` — the named path that ties Tutorials, Groups, and Checkpoints into a Mission
- `IMS_COMPLETION_PATH_TO_TASK` — the path-to-task ordered membership rows
- `IMS_STEP_FAILURE` — per-step failure events captured during a TaskRecord

`IMS_COMPLETION_PATH` was added at design review (the master-file Groups→Missions and Tutorials→Missions queries need it; original list of 5 grew to 6).

## Non-Goals

- Live querying / ad-hoc SQL — that's the `AnalyticsService` shipped in PR #37 (`/admin/analytics`).
- Authoring of reports — consumers run their own SQL against the exported files in their reporting tool of choice.
- Incremental / delta export — full table dump every time.
- Scheduled / automated delivery — admin-triggered download only.
- Localization / i18n of column headers — legacy IMS column names are emitted as-is.
- Browser download UX polish (progress bars, partial recovery).

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ admin-shell side nav  →  System  →  Data Export              │
│ (custom view, Statistics-style, no Fiori Elements)           │
└────────────────────────────────┬─────────────────────────────┘
                                 │  GET /admin/exports/exportLegacyData?format=csv|xlsx
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ approuter   /admin/* → srv-api  (XSUAA, Admin scope)         │
│ timeout bumped to 600000 ms                                   │
└────────────────────────────────┬─────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ ExportsService  @path:'/admin/exports'  @requires:'Admin'    │
│ ─ action exportLegacyData(format) returns binary             │
│ ─ Express bridge in srv/server.js (cds.on('bootstrap'))      │
│   streams ZIP/XLSX directly to res; CDS handler delegates    │
└────────────────────────────────┬─────────────────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
   per-table modules         bundle assembler         streaming pipe
   srv/exports/*.js          (archiver / exceljs)     to HTTP response
        │                        │
        │  paged DB cursors      │
        ▼                        ▼
   cds.ql SELECTs            CSV via csv-stringify
   OFFSET/LIMIT 5000         XLSX via exceljs streaming
                             WorkbookWriter
```

The export is one HTTP action with two output formats, packaged into a single bundle so the consumer always gets a complete set.

## Backend

### Service

New CAP service `ExportsService` at path `/admin/exports`, gated by `@requires : 'Admin'`.

```cds
// srv/exports-service.cds
@requires : 'Admin'
service ExportsService @(path : '/admin/exports') {
  // Returns a binary stream; Content-Type set by the express bridge.
  // format ∈ {'csv', 'xlsx'}.
  action exportLegacyData(format : String) returns LargeBinary;
}
```

The action handler in `srv/exports-service.js` is intentionally thin — it validates `format`, sets `req._.res` headers, and delegates to one of two assemblers (`assembleCsvZip(res)` or `assembleXlsx(res)`). The assemblers write directly to the response stream via the express bridge registered in `srv/server.js cds.on('bootstrap')`. We follow the existing bridge pattern used by content-serve and feedback.

**Bridge serves GET; the CDS action exists for metadata.** CAP OData actions are POST-invoked, but the consumer is a browser triggering a download via `window.location.href` — that's a GET. The express bridge registered under `cds.on('bootstrap')` handles `GET /admin/exports/exportLegacyData`, leans on the existing XSUAA passport already wired for `/admin/*` for Admin-scope enforcement, and invokes the same assembler functions the CDS handler would call. The CDS action declaration exists so the OData metadata document advertises the operation and so the `@requires: 'Admin'` annotation reads consistently with the rest of the service surface — no client actually hits the OData action endpoint.

### Per-table modules

`srv/exports/` — one module per legacy file. Each module exports:
- `legacyHeader: string[]` — the legacy IMS column names in legacy order
- `async *rows(db, opts)` — async generator yielding row arrays in `legacyHeader` order, paging via `ORDER BY <stable-key> ASC LIMIT 5000 OFFSET n` against the source CDS entities. Stable key is `legacyId ASC` everywhere it exists; for `Tasks` (UNION-ALL view) we order by `(taskType ASC, legacyId ASC)` so OFFSET pagination is deterministic across pages.

Six modules:

| Module | Source entity / query | Legacy file emitted |
|---|---|---|
| `tasks.js` | `Tasks` UNION-ALL view (already in db/views.cds) | `IMS_TASK.csv` |
| `task-records.js` | `TaskRecords` | `IMS_TASK_RECORD.csv` |
| `task-to-parent.js` | UNION of (Steps→Tutorials parent edges) and (GroupPathItems where `tutorial != null` for Tutorial→Group edges) | `IMS_TASK_TO_PARENT.csv` |
| `completion-path.js` | `CompletionPaths` | `IMS_COMPLETION_PATH.csv` |
| `completion-path-to-task.js` | `CompletionPathItems` | `IMS_COMPLETION_PATH_TO_TASK.csv` |
| `step-failures.js` | `StepFailures` joined to `TaskRecords` | `IMS_STEP_FAILURE.csv` |

`task-to-parent.js` is the only synthesized file. The master-file SQL only queries the (Step→Tutorial) and (Tutorial→Group) directions, so we union those two and don't synthesize Group→Mission (CompletionPathItems already covers that for downstream joins).

### Column mapping (locked in Section 3 review)

Approach: emit **legacy IMS column names** so the consumers' existing SQL needs minimal rewrites. Where a legacy column has no CAP equivalent we emit the legacy column header and write empty strings for every row (documented in `IMS_STEP_FAILURE` below). UUID-string IDs replace the legacy integer IDs everywhere except `IMS_TASK`, where `legacyId` is emitted as `ID` so master-file joins on integer ID still work.

#### `IMS_TASK` columns

`ID, TITLE, DESCRIPTION, STATUS, DELETION_REASON, PRIMARY_TAG, EXPERIENCE_TAG, AVERAGE_TIME_TO_COMPLETE, TASK_TYPE, CREATED_AT, MODIFIED_AT`

Source: `Tasks` view. `ID` ← `legacyId`. All others map 1:1 from the view.

#### `IMS_TASK_RECORD` columns

`ID, USER_ID, TASK_ID, TASK_TYPE, STATUS, PROGRESS, COMPLETION_TIME, COMPLETION_DATE, CONTENT_LANGUAGE, SITE_LANGUAGE, SUBMISSION_ID_STARTED, SUBMISSION_ID_COMPLETED, TITLE_SNAPSHOT, PROGRESS_NOTE, EVENT, CREATED_AT, MODIFIED_AT`

Source: `TaskRecords`. `ID` and `USER_ID` are CAP UUIDs (string). `TASK_ID` ← `taskLegacyId`. `COMPLETION_DATE` is null for in-progress rows.

#### `IMS_TASK_TO_PARENT` columns

`PARENT_TASK_ID, CHILD_TASK_ID, ITEM_ORDER`

Source: UNION of:
- Steps → Tutorials: `(tutorial.legacyId, step.legacyId, stepOrder)`
- GroupPathItems where `tutorial != null`: `(group.legacyId, tutorial.legacyId, itemOrder)`

#### `IMS_COMPLETION_PATH` columns

`ID, NAME, MISSION_ID, ITEM_ORDER`

Source: `CompletionPaths`. `ID` ← `legacyId`. `MISSION_ID` ← `mission.legacyId`.

#### `IMS_COMPLETION_PATH_TO_TASK` columns

`PATH_ID, TUTORIAL_ID, GROUP_ID, CHECKPOINT_TITLE, PRIZE_ID, ITEM_ORDER`

Source: `CompletionPathItems`. Each row populates exactly one of `TUTORIAL_ID`, `GROUP_ID`, or `CHECKPOINT_TITLE` based on `taskType`; the others are null.

#### `IMS_STEP_FAILURE` columns

Legacy header emitted in full:

`ID, TASK_RECORD_ID, STEP_NUMBER, FAILURE_DATE, ERROR_MESSAGE, RULE, QUESTION, MATCH, ANSWER, STEP_URL, TUTORIAL_ID, TITLE, CREATED_AT`

CAP `StepFailures` only stores `id`, `taskRecord`, `stepNumber`, `failureDate`, `errorMessage`, `createdAt`. The other 7 legacy columns (`RULE, QUESTION, MATCH, ANSWER, STEP_URL, TUTORIAL_ID, TITLE`) are emitted as empty strings on every row. This was Tom's decision in review — preserves header shape so the existing reporting SQL doesn't blow up on missing columns.

### Constraints respected

- `cds.ql` only — no raw SQL. (The analytics-service raw-SQL exception does not apply here.)
- `@requires: 'Admin'` on the service — never read `req.user` without it.
- New deps (`archiver`, `exceljs`, `csv-stringify`) honor the global `min-release-age=1` and `save-exact=true` npmrc rules. All three are publicly published on npmjs.com (no `@sap/` prefix; no private-registry lockup).
- No secrets or API keys introduced.

## UI

New side-nav entry in `app/admin-shell/webapp/view/Shell.view.xml`, inserted under the **System** group between "Statistics" and "Joule Settings":

```xml
<tnt:NavigationListItem text="Data Export" key="dataExport" icon="sap-icon://download" />
```

New custom view `app/admin-shell/webapp/view/DataExport.view.xml` + controller, following the existing **Statistics** view pattern (which already does export-style downloads). Layout:

- Page title and short description ("Exports the legacy IMS-equivalent reporting files for use in external tools.")
- 6-row file list (one per legacy table) with name + brief description so admins know what's in the bundle
- Format `SegmentedButton` (CSV / XLSX), default CSV
- Download `Button` ("Download bundle"), `iconFirst="true"`, `icon="sap-icon://download"`
- `BusyDialog` shown during the request (export can take a while; no polling/progress, just busy)
- Error `MessageStrip` rendered above the button when the request fails

The controller's `onDownload` builds the URL `/admin/exports/exportLegacyData?format=<csv|xlsx>` and triggers a browser download by setting `window.location.href` (matches Statistics' approach for streaming binary). No XHR — letting the browser handle the download keeps memory off the SPA and respects content-disposition automatically.

Routing entry in `manifest.json` (or wherever Shell's router config lives — match Statistics' pattern):
```json
"target": "dataExport", "name": "dataExport", "pattern": "dataExport"
```

No new Fiori Elements component — `app/admin/` is untouched. This is a Statistics-style custom view, deployed with the shell.

## Streaming, memory, and timeouts

The export must stay flat in memory across all expected row counts. The pipeline:

1. Action handler validates `format`, looks up `db = await cds.connect.to('db')`, sets headers on the underlying express `res`.
2. Assembler creates the output stream:
   - **CSV mode:** `archiver('zip', { zlib: { level: 6 } })` piped to `res`. For each of the 6 modules, `archive.append(passThrough, { name: 'IMS_<TABLE>.csv' })`, then drive `csv-stringify` from the module's async-generator rows into the pass-through.
   - **XLSX mode:** `new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res })`. For each module, `wb.addWorksheet(legacyName)`, write `legacyHeader` row, then commit each generator-yielded row with `ws.addRow(values).commit()` and finally `ws.commit()`.
3. Each module pages with `OFFSET/LIMIT 5000` so the DB never returns more than 5000 rows at once. Exceljs streaming writer flushes rows to the underlying stream as they're committed; archiver emits zip chunks as each appended file completes.

Headers set before any data is written:
- CSV: `Content-Type: application/zip`, `Content-Disposition: attachment; filename="ims-export-csv-<yyyymmdd-hhmmss>.zip"`
- XLSX: `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `Content-Disposition: attachment; filename="ims-export-<yyyymmdd-hhmmss>.xlsx"`

**Approuter timeout** in `approuter/xs-app.json`: add a new route `^/admin/exports/(.*)$` *before* the existing `^/admin/(.*)$` entry, with the same XSUAA + Admin-scope settings and `timeout: 600000` (10 min). Placing the bump on a route-specific entry keeps the rest of `/admin/*` traffic on the existing default — only the export endpoint gets the longer ceiling.

**Failure modes:**
- DB error mid-stream — the response already has 200 + headers; we abort the stream and rely on the client to detect a truncated ZIP/XLSX. We log the error with `cds.log('exports').error({ stage, error })` so it's investigable. Documented in the spec; we do not try to swap status codes mid-stream.
- Approuter or load-balancer timeout — the consumer retries; full-table-dump-every-time means there's no resumable state to preserve.
- Memory regression — if any future change accidentally buffers a whole table, we'd see it on `cf app tutorials-srv` RSS. Documented as a one-time post-deploy memory check.

## Testing

### Unit (`test/unit/exports/`, in-memory SQLite, `npm test`)

Six per-module specs:
- `tasks.test.js` — seeds one of each task type; asserts exact `IMS_TASK` legacy header, `legacyId` emitted as `ID`, paging works at a small overridden page size.
- `task-records.test.js` — seeds 3 records spanning COMPLETED/IN_PROGRESS; asserts UUID-string IDs round-trip through CSV escaping, dates as ISO-8601, `COMPLETION_DATE` null for in-progress.
- `task-to-parent.test.js` — seeds Tutorial+Steps and Group+GroupPathItems(tutorial); asserts the UNION emits both edge directions and only those.
- `completion-path.test.js` — seeds 1 path; asserts singular row + legacy header.
- `completion-path-to-task.test.js` — seeds items spanning `tutorial`/`group`/`checkpointTitle`; asserts each row populates the right legacy ID column with nulls in the others.
- `step-failures.test.js` — seeds StepFailures via TaskRecord; asserts the full legacy header is emitted and the 7 missing legacy fields are empty strings on every row.

Two bundle-assembler specs:
- `bundle-csv-zip.test.js` — runs `exportLegacyData('csv')`, captures the response stream, opens the ZIP, asserts all 6 entries exist with the expected file names and the first row of each is the legacy header.
- `bundle-xlsx.test.js` — runs `exportLegacyData('xlsx')`, opens the workbook with `exceljs`, asserts 6 sheets with legacy names and matching header rows.

### Hybrid (`test/hybrid/admin-exports.test.js`, real HANA, `npm run test:hybrid`)

Read-only:
- `exportLegacyData('csv')` → 200, response is a ZIP, unpacks to 6 files, each has at least the header line.
- `exportLegacyData('xlsx')` → 200, workbook has 6 sheets.
- Negative auth: hit endpoint without Admin scope → 403.
- Invalid format: `exportLegacyData('json')` → 400.

No write paths.

### Smoke (`test/smoke/admin-exports.smoke.test.js`, deployed URL, `npm run test:smoke`)

- `GET /admin/exports/exportLegacyData?format=csv` → 200, `content-type: application/zip`, `content-disposition` attachment with `ims-export-csv-*.zip`, body starts with ZIP magic `PK\x03\x04`.
- `GET ?format=xlsx` → 200, `content-type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, body starts with ZIP magic.
- Unauthenticated → 401.

### Out of scope for automation

- Memory profiling under full prod row counts — manual `cf app tutorials-srv` check during a real export, with rollback path being to lower the page size.
- Excel-opens-in-Microsoft-Excel sanity check — manual release-checklist item.

### Not testing

- Cross-format row-count round-trip (would test the test harness, not the code — both formats pull from the same paged query).
- Concurrent export handling — single-admin-user feature.
- Browser download UX — covered by manual smoke.

## File structure

Created:
- `srv/exports-service.cds` — service + action declaration
- `srv/exports-service.js` — thin handler, dispatches on format
- `srv/exports/tasks.js`
- `srv/exports/task-records.js`
- `srv/exports/task-to-parent.js`
- `srv/exports/completion-path.js`
- `srv/exports/completion-path-to-task.js`
- `srv/exports/step-failures.js`
- `srv/exports/assemble-csv-zip.js`
- `srv/exports/assemble-xlsx.js`
- `app/admin-shell/webapp/view/DataExport.view.xml`
- `app/admin-shell/webapp/controller/DataExport.controller.js`
- `test/unit/exports/*.test.js` (6 module specs + 2 bundle specs)
- `test/hybrid/admin-exports.test.js`
- `test/smoke/admin-exports.smoke.test.js`

Modified:
- `srv/server.js` — register express bridge for `GET /admin/exports/exportLegacyData` under `cds.on('bootstrap')`
- `app/admin-shell/webapp/view/Shell.view.xml` — new "Data Export" nav item under System
- `app/admin-shell/webapp/manifest.json` (or router config) — new route to DataExport view
- `approuter/xs-app.json` — insert new `^/admin/exports/(.*)$` route with `timeout: 600000` *before* the existing `^/admin/(.*)$` route
- `package.json` — add `archiver`, `exceljs`, `csv-stringify` (exact pinned versions, respecting min-release-age)

Untouched:
- `db/schema.cds`, `db/views.cds`, `db/schema-ext.cds` — no model change
- `srv/admin-service.{cds,js}` — existing exportTaskRecords/etc. stays
- `srv/analytics-service.{cds,js}` — separate concern
- `app/admin/*` — no Fiori Elements component

## Rollout

1. Land the backend service + per-table modules + bundle assemblers + unit tests in one PR.
2. Land UI + approuter timeout bump + hybrid + smoke in a second PR (or fold into #1 if review finds the diff manageable).
3. Deploy via the local-deploy process (`mbt build && cf deploy -e dev.mtaext`).
4. Manual post-deploy: trigger an export from the deployed admin UI, watch `cf app tutorials-srv` RSS during streaming, open the resulting XLSX in Excel to confirm sheets render.
5. Hand off to the reporting-tool consumers; they validate their existing SQL still runs against the exported files.
