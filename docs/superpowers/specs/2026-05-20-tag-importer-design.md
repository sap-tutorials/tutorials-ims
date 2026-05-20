# Tag Importer Design

**Date:** 2026-05-20
**Status:** Approved
**Resolves:** TODO entry "Tag Import — Implement bulk import of tags from an external source (e.g., CSV, API, or taxonomy system) into the Tags entity."

## Purpose

Allow administrators to bulk-import tags into the `Tags` entity from CSV or JSON files via the existing admin UI. The importer is a two-step preview/commit flow: the admin uploads a file, sees a classified preview (new / conflict / invalid rows), picks a conflict-resolution strategy, and confirms. This avoids both blind upserts and per-row click work, and gives the admin control over what happens when an imported tag name already exists.

## Architecture

### Overview

```text
Admin UI (app/admin/tags Fiori Elements list-report)
  |
  +- "Import…" header button (controller extension)
       opens TagImportDialog
  |
  +- step 1: upload (file picker OR JSON paste)
  |    -> POST /admin/previewTagImport(payload, format)
  |    -> { token, summary, rows[] }
  |
  +- step 2: preview (table of classified rows + strategy select)
  |    -> POST /admin/commitTagImport(token, strategy)
  |    -> { inserted, updated, skipped, total }
  |
  +- step 3: done (result summary + close)
       triggers extensionAPI.refresh() on the list-report
```

### Components

#### Backend — srv/lib/tag-import/

- **`parser.js`** — `parse(payload, format) -> { rows, parseErrors }`
  - CSV via `csv-parse/sync` with `columns: true, trim: true, skip_empty_lines: true`.
  - JSON: must be `Array<{ name, titlePath, ... }>`.
  - Required headers / fields: `name`, `titlePath`. Both required, non-empty after trim, ≤ 255 chars.
  - Hard caps: ≤ 5,000 rows, ≤ 1 MB raw payload.
  - Duplicates within the file (same `name`, case-insensitive after trim) → second+ occurrences dropped, surfaced in `parseErrors`.

- **`classifier.js`** — `classify(rows, tx) -> { summary, rows }`
  - Reads existing `Tags` (`SELECT ID, name, titlePath FROM Tags`).
  - Per row, status is one of `new`, `conflict`, `invalid`.
  - Conflict match is case-insensitive (`"ABAP" === "abap"`).
  - Output rows include `existingId` and `existingTitlePath` on conflicts; `reason` on invalid.

- **`applier.js`** — `apply(rows, strategy, tx) -> { inserted, updated, skipped, total }`
  - Runs inside a single CAP transaction.
  - Strategies: `upsert` | `skip-duplicates` | `abort-on-duplicate`.
  - `upsert`: INSERT new rows, UPDATE `titlePath` only when it differs.
  - `skip-duplicates`: INSERT new rows; conflicts left untouched.
  - `abort-on-duplicate`: throw if any conflict — transaction rolls back.
  - Re-classifies inside the transaction to catch races (another admin inserting between preview and commit).

- **`preview-cache.js`** — `Map`-based 5-min TTL token store
  - `set(token, value)`, `get(token)`, lazy expiry on read, FIFO eviction at 20 entries.
  - Tokens are `crypto.randomUUID()`.
  - In-memory only; cleared on srv restart. Acceptable for current single-instance srv.

#### Backend — srv/admin-service.cds + srv/admin-service.js

Two new unbound actions on `AdminService`, protected by the existing `@requires: 'Admin'`:

```cds
type TagImportRow {
  name              : String(255);
  titlePath         : String(255);
  status            : String(20);   // 'new' | 'conflict' | 'invalid'
  existingId        : UUID;
  existingTitlePath : String(255);
  reason            : String(500);
}

type TagImportPreview {
  token   : String(64);
  summary : {
    total    : Integer;
    new_     : Integer;  // 'new' is reserved
    conflict : Integer;
    invalid  : Integer;
  };
  rows    : many TagImportRow;
}

type TagImportResult {
  inserted : Integer;
  updated  : Integer;
  skipped  : Integer;
  total    : Integer;
}

action previewTagImport(payload: LargeString, format: String) returns TagImportPreview;
action commitTagImport(token: String, strategy: String) returns TagImportResult;
```

Handler logic in `srv/admin-service.js`:
- `previewTagImport`: call parser → classifier → cache result → return preview shape.
- `commitTagImport`: look up cached classification → re-classify in tx → call applier → log + return counts.

#### Frontend — app/admin/tags

Controller extension registered in `app/admin/tags/webapp/manifest.json`:

```json
"sap.ui5": {
  "extends": {
    "extensions": {
      "sap.ui.controllerExtensions": {
        "sap.fe.templates.ListReport.ListReportController": {
          "controllerName": "sap.tutorials.admin.tags.ext.TagImportController"
        }
      }
    }
  },
  "extension": {
    "sap.fe.templates.ListReport": {
      "controlConfiguration": {
        "@com.sap.vocabularies.UI.v1.LineItem": {
          "actions": {
            "TagImportAction": {
              "press": ".extension.sap.tutorials.admin.tags.openTagImportDialog",
              "visible": true,
              "enabled": true,
              "text": "{i18n>tagImport.action}"
            }
          }
        }
      }
    }
  }
}
```

Files:
- `app/admin/tags/webapp/ext/TagImportController.js` — opens dialog, orchestrates calls, manages `viewState` JSONModel (`upload | preview | done`), wires preview/commit calls via `extensionAPI.invokeAction`.
- `app/admin/tags/webapp/ext/TagImportDialog.fragment.xml` — single dialog with three states bound to `viewState`. Uses `IconTabBar` for File vs Paste, `Table` for preview, `Select` for strategy, `MessageStrip` for summary/result.
- `app/admin/tags/webapp/i18n/i18n.properties` — `tagImport.*` keys for all visible labels.

### Data Flow

1. Admin clicks **Import…** → dialog opens in `upload` state.
2. Admin selects a CSV/JSON file or pastes content → clicks **Preview**.
3. UI calls `previewTagImport(payload, format)`. Backend parses, validates, classifies, caches. Returns `{ token, summary, rows }`.
4. Dialog enters `preview` state. Admin sees `MessageStrip` (`12 new, 3 conflicts, 1 invalid`), table of rows, and a strategy `Select`.
5. Admin picks a strategy (or clicks **Back** to return to `upload`).
6. Admin clicks **Import**. UI calls `commitTagImport(token, strategy)`. Backend re-classifies inside a transaction, applies the strategy, returns counts.
7. Dialog enters `done` state showing the result. **Close** button refreshes the list-report binding.

## Error Handling

| Case | Behavior |
| ---- | -------- |
| Empty payload / missing required CSV header | `req.error(400, '...')` from parser |
| JSON not an array | `req.error(400, 'Expected array')` |
| Row count > 5,000 or payload > 1 MB | `req.error(413, 'Limit exceeded')` |
| Malformed CSV | `req.error(400, '<parser message at line N>')` |
| Per-row missing/empty/oversize field | Row marked `invalid`, included in preview |
| Duplicate within file | Second+ occurrence dropped, surfaced via `parseErrors` and shown in preview banner |
| Token not found / expired on commit | `req.error(410, 'Preview expired, please re-upload')` — UI falls back to `upload` state |
| `abort-on-duplicate` and conflicts present | `req.error(409, 'N conflicts found')`, transaction rolls back |
| DB error mid-apply | CAP transaction rolls back; client gets sanitized `500`; full error logged |
| Race: new conflict appears between preview and commit | Re-classify inside tx catches it; result counts reflect actual outcome |
| Encoding (non-UTF-8) | Garbled names visible in preview; admin can correct (no auto-detection v1) |

## Observability

- `cds.log('tag-import')` channel emits one structured log per action call:
  - `{ event: 'tag-import.preview' | 'tag-import.commit', user, total, summary?, strategy?, durationMs }`
- No raw tag names in logs — only counts.
- Tags is not in `db/audit-logging.cds` (no `@PersonalData`); structured log is sufficient — no audit-log entries added.

## Testing

### Unit (`test/unit/tag-import/`)

- **`parser.test.js`** — CSV header validation, trimming, BOM stripping, empty lines, missing required field, oversized payload, in-file duplicate detection. JSON array validation, non-array rejection. 255-char enforcement.
- **`classifier.test.js`** — fixture seed of existing Tags + various inputs producing known `summary`/`rows` shape. Case-insensitive matching. Mixed `new`/`conflict`/`invalid` in one report.
- **`applier.test.js`** — each strategy in isolation against seeded SQLite. Verify counts. Confirm `abort-on-duplicate` fully rolls back. Concurrency simulation: insert between classify and apply, confirm re-classify catches it.
- **`preview-cache.test.js`** — TTL expiry, FIFO eviction at cap, lazy cleanup on read.

### Hybrid (`test/hybrid/tag-import.test.js`)

One end-to-end happy path against real HANA, gated by `ALLOW_HYBRID_WRITES`:
1. POST `previewTagImport` with 3-row CSV (`__TEST__` prefix on names; 1 existing, 2 new).
2. Assert summary shape and token returned.
3. POST `commitTagImport(token, 'upsert')`.
4. Assert insertions visible via SELECT and conflict row's `titlePath` updated.
5. `afterAll` deletes `__TEST__`-prefixed tags.

### Frontend

No automated UI tests this iteration — admin shell has no Karma/QUnit infrastructure today. Manual smoke checklist included in implementation plan.

### Smoke

None. Smoke runs unauthenticated public endpoints; admin actions live behind XSUAA.

## Out of Scope (v1)

- CSV character-encoding detection (assume UTF-8; BOMs stripped).
- Undo. `cleanupUnusedTags` is the existing escape hatch.
- Async/background mode. The 5,000-row cap keeps everything well under request timeout.
- Importing tag relationships (`TutorialTags`, `MissionTags`, `GroupTags`) — only `Tags` itself.
- Importing `legacyId` from the file — always system-assigned via the existing sequence.

## Files to Add / Modify

```
ADD: srv/lib/tag-import/parser.js
ADD: srv/lib/tag-import/classifier.js
ADD: srv/lib/tag-import/applier.js
ADD: srv/lib/tag-import/preview-cache.js
ADD: srv/lib/tag-import/index.js              (barrel export)
ADD: app/admin/tags/webapp/ext/TagImportController.js
ADD: app/admin/tags/webapp/ext/TagImportDialog.fragment.xml
ADD: test/unit/tag-import/parser.test.js
ADD: test/unit/tag-import/classifier.test.js
ADD: test/unit/tag-import/applier.test.js
ADD: test/unit/tag-import/preview-cache.test.js
ADD: test/hybrid/tag-import.test.js
EDIT: srv/admin-service.cds                   (declare types + 2 actions)
EDIT: srv/admin-service.js                    (wire handlers)
EDIT: app/admin/tags/webapp/manifest.json     (register controller extension)
EDIT: app/admin/tags/webapp/i18n/i18n.properties (tagImport.* keys)
EDIT: package.json                            (add csv-parse dependency)
EDIT: TODO.md                                 (mark Tag Import done)
```

## Dependencies

- New runtime dependency: `csv-parse` (sync API, small, battle-tested). No CSV library currently in use.
- No new dev dependencies — vitest, supertest, and `@cap-js/cds-test` already cover testing.
