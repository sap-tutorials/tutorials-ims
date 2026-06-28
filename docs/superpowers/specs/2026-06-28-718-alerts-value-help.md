# Issue #718 — Value Help for Alerts severity & audience

**Date:** 2026-06-28
**Issue:** [sap-tutorials/tutorials-ims#718](https://github.com/sap-tutorials/tutorials-ims/issues/718)
**Scope:** Admin UI only — Alerts object page editor.

## Problem

On `/admin-ui/#alerts-display`, opening an Alert in edit/draft mode renders `severity` and `audience` as plain text input fields. Both are CDS inline enums:

- `severity` — `Information | Success | Warning | Error` (default `Information`)
- `audience` — `ALL | AUTHENTICATED | ADMIN` (default `ALL`)

Both fields already carry `@Common.ValueListWithFixedValues: true` in [app/admin-annotations.cds](../../../app/admin-annotations.cds) at the `annotate AdminService.Alerts` block (around line 2767). In Fiori Elements V4 that flag alone is unreliable for inline CDS enums — the EDMX emits a `Validation.AllowedValues` collection, but FE V4 does not consistently translate it into a Select control on the object-page editor. The repo's established pattern for every other working enum dropdown pairs the flag with a `@Common.ValueList` that points at a `@cds.persistence.skip` code-list entity.

Working precedents in this codebase:

- `Missions.missionType` → `MissionTypes` ([srv/admin-service.cds:236](../../../srv/admin-service.cds#L236), [srv/admin-service.js:147-149](../../../srv/admin-service.js#L147-L149), [app/admin-annotations.cds:153-156](../../../app/admin-annotations.cds#L153-L156))
- `Tasks.status` → `TaskStatuses` ([srv/admin-service.cds:235](../../../srv/admin-service.cds#L235))
- `CompletionPathItems.taskType` → `TaskTypes` ([app/admin-annotations.cds:192-196](../../../app/admin-annotations.cds#L192-L196))
- `AdvocateLinks.kind` → `AdvocateLinkKinds`

The Alerts page is the only enum-bearing entity in `AdminService` that skipped this pattern.

## Solution

Apply the same pattern to `Alerts.severity` and `Alerts.audience`: two new code-list stub entities, two READ handlers that return the codes with friendly labels, and a `@Common.ValueList` annotation on each field pointing at the new collection.

## Components touched

### 1. `srv/admin-service.cds`

Add two `@readonly @cds.persistence.skip` entities next to the existing `TaskStatuses` / `MissionTypes` / `TaskTypes` stubs (around line 235). Both carry a `label` column so the dropdown can show a friendly string while the persisted value stays the raw enum code:

```cds
@readonly @cds.persistence.skip entity AlertSeverities { key code : String(20); label : String(40); }
@readonly @cds.persistence.skip entity AlertAudiences  { key code : String(20); label : String(40); }
```

### 2. `srv/admin-service.js`

Add two `this.on('READ', …)` handlers next to the existing block at line 144. Static lists — no DB access:

```js
this.on('READ', 'AlertSeverities', () => [
  { code: 'Information', label: 'Information' },
  { code: 'Success',     label: 'Success'     },
  { code: 'Warning',     label: 'Warning'     },
  { code: 'Error',       label: 'Error'       },
]);
this.on('READ', 'AlertAudiences', () => [
  { code: 'ALL',           label: 'All visitors'    },
  { code: 'AUTHENTICATED', label: 'Signed-in users' },
  { code: 'ADMIN',         label: 'Admins only'     },
]);
```

The label for severities mirrors the code (the codes are already human-readable); audiences get friendlier labels because `ALL` / `AUTHENTICATED` are jargon-y.

### 3. `app/admin-annotations.cds`

Replace the existing minimal annotation on `severity` and `audience` (around line 2770) with the canonical pattern — keep `@Common.ValueListWithFixedValues: true` (renders as a Select rather than the search-style F4 dialog), add `@Common.ValueList` pointing at the new collections, and add `@Common.Text: label` with `#TextOnly` arrangement so the user sees the friendly label in the dropdown items:

```cds
severity    @Common.Label: 'Severity'
            @Common.ValueListWithFixedValues: true
            @Common.ValueList: {
              CollectionPath: 'AlertSeverities',
              Parameters: [
                { $Type: 'Common.ValueListParameterInOut',     LocalDataProperty: severity, ValueListProperty: 'code' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'label' }
              ]
            }
            @assert.range: true;
audience    @Common.Label: 'Audience'
            @Common.ValueListWithFixedValues: true
            @Common.ValueList: {
              CollectionPath: 'AlertAudiences',
              Parameters: [
                { $Type: 'Common.ValueListParameterInOut',     LocalDataProperty: audience, ValueListProperty: 'code' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'label' }
              ]
            }
            @assert.range: true;
```

The `@assert.range: true` line is kept verbatim from the existing annotation — it enforces the enum at the CAP write path even when the request comes from a non-UI client (REST, draft tools, CSV import). The CDS enum stays inline on `db/schema.cds` — no schema change, no `cds build` / `db/last-dev/` staging.

The List Report column for `severity` keeps reading the raw code (so the existing `severityCrit` virtual + `UI.DataField.Criticality` keep coloring the cell). The friendly label only surfaces inside the editor's Select dropdown.

## Data flow

1. Author opens `/admin-ui/#alerts-display`, picks an Alert, clicks Edit.
2. FE V4 reads `$metadata`, sees `Common.ValueList` on `Alerts/severity` + `Alerts/audience`.
3. FE V4 issues `GET /admin/AlertSeverities` and `GET /admin/AlertAudiences`.
4. The two READ handlers in `srv/admin-service.js` return the static arrays — no DB hit.
5. FE V4 renders a Select control with friendly labels; on change it PATCHes the draft with the raw `code`.
6. On Save, the active row commits via the existing draft flow. `@assert.range` continues to enforce valid codes.

## Public-contract & cache impact

Nothing public moves:

- `/api/alerts*` ([srv/routes/alerts-public.js](../../../srv/routes/alerts-public.js)) reads the same `Alerts` rows with the same column shape — wire format unchanged.
- The in-memory alerts cache ([srv/lib/alerts-cache.js](../../../srv/lib/alerts-cache.js)) is keyed on `Alerts` and continues to bust on save.
- The rebuild classifier already returns `mode: 'none'` for `Alerts` ([srv/lib/_classify-rebuild-mode.js](../../../srv/lib/_classify-rebuild-mode.js)) — no Hugo rebuild triggered.
- DB schema unchanged → no HDI deploy needed.

## Testing

**Existing:**

- [srv/lib/__tests__/alerts-endpoint.test.js](../../../srv/lib/__tests__/alerts-endpoint.test.js) — public endpoint shape, must keep passing.

**Manual / hybrid (the bug surface is FE V4 metadata + handler, neither has hybrid coverage today):**

1. `npm run dev:hybrid`
2. Navigate to `/admin-ui/#alerts-display`, edit an Alert.
3. Confirm both `severity` and `audience` render as dropdowns with the friendly labels.
4. Save, reopen — values persist as raw codes.
5. Confirm the list-report `severity` column still renders with semantic coloring (sanity check that `severityCrit` was not disturbed).
6. `curl https://<approuter>/api/alerts` — wire shape unchanged.

**Optional unit test:** add two cases to `srv/lib/__tests__/alerts-endpoint.test.js` (or a new `alerts-value-help.test.js`) that hit `GET /admin/AlertSeverities` and `GET /admin/AlertAudiences`, asserting the shape `[{ code, label }, …]` and exact counts (4 / 3). Optional because the READ handlers are pure constants — a regression would be one-line obvious in code review.

## Out of scope

- Renaming the audience codes (`ALL` → `EVERYONE` etc.) — would break stored rows and the public endpoint contract.
- A List-Report filter-bar value help — the existing `UI.SelectionFields` + `Validation.AllowedValues` filter dropdown is unaffected by this fix and already works.
- Promoting the inline enums to named types (`type AlertSeverity`, `type AlertAudience`) — purely cosmetic refactor, no consumer to benefit.
- Adding labels for the `severity` codes themselves (they're already human-readable English words).

## Rollback

Single PR, no DB migration. Revert reverses both the dropdown and the handler in one commit. No data state to roll back.
