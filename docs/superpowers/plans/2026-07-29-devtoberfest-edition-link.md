# Devtoberfest Edition Link — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Edition field to `DevtoberfestConfig` and its Fiori Elements admin UI so an admin can pick a Devtoberfest Planner Edition via a cross-container value help — the primary link between the tutorial system and the planner.

**Architecture:** A CDS Association `edition → external.devtoberfest.Edition` (an already-deployed `@cds.persistence.exists` facade over the planner's `DTF_EDITION_V1` view) mints an `edition_ID` FK on `DevtoberfestConfig`. A new read-only `DevtoberfestEditionPickList` projection on `AdminService` backs the Fiori value help (value-help `CollectionPath` must resolve within the same service). Admin-UI annotations wire the field into the Object Page, List Report column, and selection filter.

**Tech Stack:** SAP CAP (Node.js), CDS, Fiori Elements V4, HANA Cloud (HDI cross-container), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-devtoberfest-edition-link-design.md`

## Global Constraints

- **No new cross-container plumbing** — grants/synonyms/facades for `external.devtoberfest.Edition` are already deployed. This change only *consumes* them.
- **Association only** — no denormalized snapshot columns for the edition label.
- **DEV-first, PROD deferred** — field + annotations ship everywhere; the value help returns no rows where the planner synonym isn't wired (PROD today). No error in that state.
- **Never hand-author `.hdbmigrationtable` ALTERs** — regenerate via `cds build --for hana`.
- **`@cds.persistence.exists` facades have no SQLite table** under `npm test` — do NOT write unit tests that READ `DevtoberfestEditionPickList` rows; only assert model compile / `$metadata` presence.
- **Admin-UI changes require a FULL bundle-gated deploy** — `npm run deploy -- --env dev` (NO `--skip-build`, NO `-m` scoping).
- **Column case:** planner facade columns are UPPERCASE (`ID`, `YEAR`, `NAME`, `STARTDATE`, `ENDDATE`, `ISCURRENT`) — match exactly in projections/annotations.

---

## File Structure

- **`db/devtoberfest.cds`** (modify) — add `edition` association + `using` for the external facade.
- **`srv/admin-service.cds`** (modify) — add `using` for the external facade + the `DevtoberfestEditionPickList` read-only projection.
- **`app/admin-annotations.cds`** (modify) — Edition field-level annotations + UI placement on `DevtoberfestConfig`, and `@UI` for the new picklist.
- **`app/admin/devtoberfest/webapp/manifest.json`** (modify) — bump `applicationVersion` to bust the UI5 IndexedDB fragment cache.
- **`test/unit/devtoberfest-config-schema.test.js`** (modify) — assert `edition_ID` on the schema entity.
- **`test/admin-annotations.test.js`** (modify) — assert the Edition value help + FK propagation land in `/admin/$metadata`.

---

## Task 1: Add the `edition` association to the schema

**Files:**
- Modify: `db/devtoberfest.cds` (top `using` line + `DevtoberfestConfig` entity body)
- Test: `test/unit/devtoberfest-config-schema.test.js`

**Interfaces:**
- Consumes: `external.devtoberfest.Edition` (existing facade in `db/external/devtoberfest.cds`, key `ID : String(36)`).
- Produces: `com.sap.developers.ims.DevtoberfestConfig.edition` association → FK element `edition_ID : String(36)`. Later tasks reference `edition` / `edition_ID`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/devtoberfest-config-schema.test.js` inside the top-level `describe` block:

```javascript
  it('DevtoberfestConfig has an edition association FK', () => {
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    // Managed association mints a foreign-key element edition_ID.
    expect(DevtoberfestConfig.elements.edition).toBeDefined();
    expect(DevtoberfestConfig.elements.edition_ID).toBeDefined();
    expect(DevtoberfestConfig.elements.edition_ID.type).toBe('cds.String');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/devtoberfest-config-schema.test.js -t "edition association"`
Expected: FAIL — `DevtoberfestConfig.elements.edition` is `undefined`.

- [ ] **Step 3: Add the association**

In `db/devtoberfest.cds`, extend the top `using` (line 3) to import the external facade namespace:

```cds
using { com.sap.developers.ims as ims, cuid, managed } from './schema';
using { external.devtoberfest as planner } from './external/devtoberfest';
```

Then add the `edition` association to `DevtoberfestConfig` (after `currentEvent`, line 28):

```cds
  isActive          : Boolean default false;
  currentEvent      : Association to ims.Events;
  edition           : Association to planner.Edition;   // planner GUID stored in edition_ID
  termsText         : LargeString;          // markdown body
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/devtoberfest-config-schema.test.js -t "edition association"`
Expected: PASS. Also run the full file to confirm no regression:
Run: `npx vitest run test/unit/devtoberfest-config-schema.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add db/devtoberfest.cds test/unit/devtoberfest-config-schema.test.js
git commit -m "feat(devtoberfest): add edition association to DevtoberfestConfig"
```

---

## Task 2: Expose the Edition value-help projection on AdminService

**Files:**
- Modify: `srv/admin-service.cds` (top `using` block, lines 1-9; add projection near the `DevtoberfestConfig` projection at line 453-455)
- Test: `test/admin-annotations.test.js`

**Interfaces:**
- Consumes: `external.devtoberfest.Edition` facade; `AdminService.DevtoberfestConfig` (existing projection, line 453-455).
- Produces: `AdminService.DevtoberfestEditionPickList` — read-only projection exposing `ID, YEAR, NAME, STARTDATE, ENDDATE, ISCURRENT`. Task 3's value help uses `CollectionPath: 'DevtoberfestEditionPickList'` and `ValueListProperty: 'ID' | 'NAME' | 'YEAR' | 'STARTDATE' | 'ENDDATE' | 'ISCURRENT'`.

- [ ] **Step 1: Write the failing test**

Add a new `describe` block to `test/admin-annotations.test.js` (the top-of-file `metadata` is fetched by the first `it`; reuse it — add this block after the existing `Missions annotations` block):

```javascript
  describe('DevtoberfestConfig edition value help', () => {
    it('exposes the DevtoberfestEditionPickList entity set', () => {
      expect(metadata).toContain('DevtoberfestEditionPickList');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin-annotations.test.js -t "DevtoberfestEditionPickList"`
Expected: FAIL — `DevtoberfestEditionPickList` absent from `$metadata`.

- [ ] **Step 3: Add the using + projection**

In `srv/admin-service.cds`, add after the existing `using` lines (after line 9):

```cds
using { external.devtoberfest as external_dtf } from '../db/external/devtoberfest';
```

Add the projection immediately after the `DevtoberfestConfig` projection block (after line 455 `entity DevtoberfestConfig as projection on ims.DevtoberfestConfig;`):

```cds
  // Value-help picklist for DevtoberfestConfig.edition — Devtoberfest Planner
  // Editions via the cross-container facade (external.devtoberfest.Edition →
  // DTF_EDITION_V1). Read-only; mirrors TutorialPickList. Returns no rows in
  // environments where the devtoberfest-planner-db synonym/grant is not
  // deployed (e.g. PROD today) — no error, empty picker.
  @readonly
  @cds.redirection.target: false
  entity DevtoberfestEditionPickList as projection on external_dtf.Edition {
    ID, YEAR, NAME, STARTDATE, ENDDATE, ISCURRENT
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/admin-annotations.test.js -t "DevtoberfestEditionPickList"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds test/admin-annotations.test.js
git commit -m "feat(devtoberfest): expose DevtoberfestEditionPickList value-help projection"
```

---

## Task 3: Wire the Edition field into the admin UI annotations

**Files:**
- Modify: `app/admin-annotations.cds` (the two `DevtoberfestConfig` annotate blocks at lines 2733-2804; add a new `@UI` block for `DevtoberfestEditionPickList`)
- Test: `test/admin-annotations.test.js`

**Interfaces:**
- Consumes: `AdminService.DevtoberfestConfig.edition` / `edition_ID` (Task 1); `AdminService.DevtoberfestEditionPickList` (Task 2).
- Produces: value help + text arrangement on `edition_ID`; List Report column, filter, and OP field-group entry.

- [ ] **Step 1: Write the failing test**

Add to the `DevtoberfestConfig edition value help` describe block in `test/admin-annotations.test.js`:

```javascript
    it('has a ValueList on edition_ID pointing at DevtoberfestEditionPickList', () => {
      // CollectionPath propagates to the FK; verify both the target and the FK property exist.
      expect(metadata).toContain('DevtoberfestEditionPickList');
      expect(metadata).toContain('Name="edition_ID"');
      // Text arrangement / Common.Text propagation to the FK.
      expect(metadata).toContain('Common.ValueList');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin-annotations.test.js -t "ValueList on edition_ID"`
Expected: FAIL — `Name="edition_ID"` not present (association not yet surfaced through annotations/projection metadata).

- [ ] **Step 3: Add field-level annotations**

In `app/admin-annotations.cds`, inside the first `annotate AdminService.DevtoberfestConfig with { ... }` block (after the `currentEvent` annotation, before `termsText`, ~line 2749):

```cds
  edition           @title: 'Devtoberfest Edition'
                    @Common.Label: 'Devtoberfest Edition'
                    @Common.Text: edition.NAME @Common.TextArrangement: #TextOnly
                    @Common.ValueList: {
                      Label: 'Edition',
                      CollectionPath: 'DevtoberfestEditionPickList',
                      Parameters: [
                        { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: edition_ID, ValueListProperty: 'ID' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'NAME' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'YEAR' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'STARTDATE' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'ENDDATE' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'ISCURRENT' }
                      ]
                    };
```

- [ ] **Step 4: Add UI placement (LineItem, SelectionFields, FieldGroup)**

In the second block, `annotate AdminService.DevtoberfestConfig with @UI: { ... }` (lines 2760-2804):

Change `SelectionFields` (line 2774) to add `edition_ID`:

```cds
  SelectionFields: [ isActive, currentEvent_ID, edition_ID ],
```

Add an Edition column to `LineItem` (after the Event line at line 2776):

```cds
    { Value: currentEvent.name,      Label: 'Event' },
    { Value: edition.NAME,           Label: 'Edition' },
```

Add the field to `FieldGroup#General` (after `currentEvent_ID` at line 2791):

```cds
  FieldGroup#General: { Data: [
    { Value: currentEvent_ID, Label: 'Event' },
    { Value: edition_ID, Label: 'Devtoberfest Edition' },
    { Value: isActive },
    { Value: termsVersion }
  ]},
```

- [ ] **Step 5: Add @UI for the picklist dialog**

Append a new annotate block after the `DevtoberfestConfig` blocks (after line 2804), mirroring `TutorialPickList`:

```cds
// Value-help dialog columns for the Edition picker.
annotate AdminService.DevtoberfestEditionPickList with {
  ID        @Common.Label: 'Edition ID';
  NAME      @Common.Label: 'Name';
  YEAR      @Common.Label: 'Year';
  STARTDATE @Common.Label: 'Start';
  ENDDATE   @Common.Label: 'End';
  ISCURRENT @Common.Label: 'Is Current';
};

annotate AdminService.DevtoberfestEditionPickList with @(
  UI: {
    HeaderInfo: { TypeName: 'Edition', TypeNamePlural: 'Editions', Title: { Value: NAME } },
    SelectionFields: [ NAME, YEAR, ISCURRENT ],
    LineItem: [
      { Value: NAME },
      { Value: YEAR },
      { Value: STARTDATE },
      { Value: ENDDATE },
      { Value: ISCURRENT }
    ]
  }
);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/admin-annotations.test.js`
Expected: all PASS (including the new `edition_ID` + `DevtoberfestEditionPickList` assertions).

- [ ] **Step 7: Commit**

```bash
git add app/admin-annotations.cds test/admin-annotations.test.js
git commit -m "feat(devtoberfest): add Edition value help to admin UI annotations"
```

---

## Task 4: Bump the admin app version + regenerate the HANA migration table

**Files:**
- Modify: `app/admin/devtoberfest/webapp/manifest.json` (line 8, `applicationVersion.version`)
- Modify (generated): `db/src/com.sap.developers.ims.DevtoberfestConfig.hdbmigrationtable` (+ any `db/last-dev/` artifacts touched by the build)

**Interfaces:**
- Consumes: schema change from Task 1.
- Produces: bumped UI version (cache-bust) + regenerated migration table carrying the new `edition_ID` column.

- [ ] **Step 1: Bump the admin app version**

In `app/admin/devtoberfest/webapp/manifest.json`, change line 8:

```json
    "applicationVersion": { "version": "0.0.3" },
```

- [ ] **Step 2: Regenerate the HANA build artifacts**

Run the production HANA build to regenerate the migration table with the new column (do NOT hand-edit the ALTER):

Run: `npx cds build --for hana --src db`
Expected: `db/src/com.sap.developers.ims.DevtoberfestConfig.hdbmigrationtable` updated with an `edition_ID` NVARCHAR(36) column and a bumped version counter; migration table gains an ALTER step (not a table rewrite).

- [ ] **Step 3: Verify the migration table diff**

Run: `git diff --no-ext-diff db/src/com.sap.developers.ims.DevtoberfestConfig.hdbmigrationtable`
Expected: shows a new `EDITION_ID` column addition + incremented `== version` counter. Confirm it is an additive ALTER, not a destructive rewrite. If the full `--production` build suppressed the version bump, regenerate with the documented `cds build --for hana --src db --opts model=[db]` form (per the hdbmigrationtable memory rule).

- [ ] **Step 4: Commit**

```bash
git add app/admin/devtoberfest/webapp/manifest.json db/src/com.sap.developers.ims.DevtoberfestConfig.hdbmigrationtable db/last-dev
git commit -m "chore(devtoberfest): bump admin app version + regenerate edition_ID migration"
```

---

## Task 5: Full model compile + regression gate

**Files:** none (verification only)

- [ ] **Step 1: Compile the full model**

Run: `npx cds compile srv --to sqlite > /dev/null`
Expected: compiles without NEW errors. NOTE: a pre-existing `SearchService` duplicate-definition error may surface — confirm it is unchanged from `origin/main` (`git stash`-free check: compare against a clean checkout) and NOT introduced by this change. If only that pre-existing error appears, proceed.

- [ ] **Step 2: Run the affected unit tests**

Run: `npx vitest run test/unit/devtoberfest-config-schema.test.js test/admin-annotations.test.js`
Expected: all PASS.

- [ ] **Step 3: Run the devtoberfest-related unit suite**

Run: `npx vitest run test/unit/devtoberfest-config-schema.test.js test/unit/admin-shell-devtoberfest-planner-link.test.js`
Expected: all PASS (confirms the existing planner-link nav test is untouched).

- [ ] **Step 4: Commit (if any test-only fixups were needed)**

```bash
git add -A
git commit -m "test(devtoberfest): verify edition link compile + regression gate" --allow-empty
```

---

## Deploy (post-merge, manual — not a plan task)

Per the design doc and CLAUDE.md admin-UI rule:

```bash
export CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"
npm run deploy -- --env dev      # FULL build; NO --skip-build, NO -m scoping (Step 3.5 gates the admin bundle)
```

Then verify in DEV: open `/admin-ui/#/devtoberfest`, edit a config row, confirm the Edition value help lists planner editions and a pick persists `edition_ID`. PROD is deferred until the planner container lands on the PROD HANA instance.

---

## Self-Review

**Spec coverage:**
- Schema association (Association-only storage) → Task 1 ✓
- Value-help projection on AdminService (same-service `CollectionPath`) → Task 2 ✓
- Field annotations + Name/Year/dates/Is-Current value help, Name in cell → Task 3 ✓
- UI placement: OP field group + List Report column + selection filter → Task 3 ✓
- App version bump (cache bust) + migration regen → Task 4 ✓
- Compile gate + unit tests + `@cds.persistence.exists` no-read caveat → Task 5 + Global Constraints ✓
- DEV-first / PROD-deferred, no new plumbing → Global Constraints + Deploy ✓

**Placeholder scan:** No TBD/TODO; every code step has literal content.

**Type consistency:** `edition` / `edition_ID` (String(36)) consistent across Tasks 1-4. Value-help `ValueListProperty` names (`ID/NAME/YEAR/STARTDATE/ENDDATE/ISCURRENT`) match the projection columns in Task 2 and the facade columns (UPPERCASE) verbatim. `CollectionPath: 'DevtoberfestEditionPickList'` matches the entity name defined in Task 2.
