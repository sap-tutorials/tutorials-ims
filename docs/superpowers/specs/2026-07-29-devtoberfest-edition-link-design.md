# Devtoberfest Edition link on DevtoberfestConfig

**Date:** 2026-07-29
**Depends on:** [`2026-07-27-devtoberfest-cross-container-design.md`](2026-07-27-devtoberfest-cross-container-design.md) — the HDI↔HDI plumbing this feature consumes.

## Summary

Add an **Edition** field to the tutorial system's `DevtoberfestConfig` entity and its
Fiori Elements admin UI (`/admin-ui/#/devtoberfest`). The field lets an admin choose a
Devtoberfest **Edition** from the Devtoberfest Planner, via a value help backed by the
already-deployed cross-container view. This Edition link is the **primary key linkage
between the two systems** — a tutorial-system config row names exactly which planner
Edition it corresponds to.

## Context — what already exists

The cross-container path from the planner into our container is **already live** (built by
the 2026-07-27 cross-container change):

- `external.devtoberfest.Edition` — a `@cds.persistence.exists` facade (`db/external/devtoberfest.cds`)
  over the planner's `DTF_EDITION_V1` view, wired via `EXTERNAL_DEVTOBERFEST_EDITION.hdbsynonymconfig`
  + the `devtoberfest_reader` grant (`db/src/devtoberfest-grants.hdbgrants`).
- Available columns: `ID` (String(36), the planner GUID), `YEAR`, `NAME`, `STARTDATE`, `ENDDATE`, `ISCURRENT`.
- Already projected read-only as `DevtoberfestService.Edition` at `/devtoberfest`.

So no new grants, synonyms, or facades are needed. This feature is: **a new association
field + a value-help projection on AdminService + admin UI annotations.**

## Goals

- Admin can assign a planner Edition to a `DevtoberfestConfig` row through a value help.
- The value help reads live from the planner's `DTF_EDITION_V1` view (via the existing facade).
- The picked Edition renders as its `NAME` in the admin UI (list + object page).
- Edition is visible as a List Report column and usable as a selection filter.

## Non-goals

- No snapshot/denormalized copy of the edition label — storage is a live cross-container
  Association only (explicit design decision; a retired/unreachable edition renders a blank label).
- No new cross-container plumbing (grants/synonyms/facades already deployed).
- No PROD enablement yet — see Environment scope.
- No reverse write (tutorial system does not write back to the planner).

## Decisions

| Question | Decision |
|---|---|
| Storage | **CDS Association** to `external.devtoberfest.Edition` → FK `edition_ID : String(36)` holds the planner GUID. |
| Value help contents | **Name + Year + Start/End dates + Is-Current** columns; picked cell renders `NAME`. |
| Label resilience | **Association only** — no denormalized snapshot columns. |
| UI placement | **Object Page field group + List Report column + selection filter.** |
| Environment scope | **DEV-first, PROD deferred** (cross-container blocked in PROD until planner lands on PROD HANA instance). |

## Architecture / data flow (value help)

```
Admin edits a DevtoberfestConfig row at /admin-ui/#/devtoberfest, opens the Edition value help.
  → FE: GET /admin/DevtoberfestEditionPickList?$search=…  (AdminService)
    → CAP resolves DevtoberfestEditionPickList → external.devtoberfest.Edition facade
      → synonym EXTERNAL_DEVTOBERFEST_EDITION → DTF_EDITION_V1 in devtoberfest-planner-db (in-DB SQL)
        → returns ID, YEAR, NAME, STARTDATE, ENDDATE, ISCURRENT
  → Admin picks → FE sets DevtoberfestConfig.edition_ID (= planner Edition.ID)
```

A Fiori value help's `CollectionPath` resolves **within the same service** as the field.
`DevtoberfestConfig` is on `AdminService`, but `Edition` today is only projected on
`DevtoberfestService`. Hence the new read-only `DevtoberfestEditionPickList` projection on
`AdminService` (mirrors how `TutorialPickList` backs the `Tutorials.redirectTo` picker).

## Artifacts

### 1. `db/devtoberfest.cds` — schema

Add the association on `DevtoberfestConfig`:

```cds
using { external.devtoberfest as planner } from './external/devtoberfest';
...
entity DevtoberfestConfig : cuid, managed {
  isActive          : Boolean default false;
  currentEvent      : Association to ims.Events;
  edition           : Association to planner.Edition;   // NEW — planner GUID in edition_ID
  termsText         : LargeString;
  termsVersion      : Integer default 1;
  contentRulesUrl   : String(500);
  faqUrl            : String(500);
  gameboardUrl      : String(500);
  activitiesUrl     : String(500);
}
```

Mints `edition_ID : String(36)`. Mirrors the reciprocal leg's
`Session.tutorial → external.tutorials.TutorialValueHelpV1` from the 2026-07-27 doc.

### 2. `srv/admin-service.cds` — value-help projection

Add at the top:

```cds
using { external.devtoberfest as external_dtf } from '../db/external/devtoberfest';
```

Add the read-only picklist projection:

```cds
// Value-help picklist for DevtoberfestConfig.edition — planner Editions via the
// cross-container facade. Read-only; mirrors TutorialPickList. Returns no rows in
// environments where the devtoberfest-planner-db synonym/grant is not deployed (e.g. PROD today).
@readonly
@cds.redirection.target: false
entity DevtoberfestEditionPickList as projection on external_dtf.Edition {
  ID, YEAR, NAME, STARTDATE, ENDDATE, ISCURRENT
};
```

The existing `DevtoberfestConfig` projection (`as projection on ims.DevtoberfestConfig`)
carries `edition`/`edition_ID` through its `*` wildcard — no projection-body change needed.

### 3. `app/admin-annotations.cds` — admin UI

In the existing `DevtoberfestConfig` annotate blocks (~line 2733):

**Field-level:**

```cds
edition @Common.Label: 'Devtoberfest Edition'
        @title: 'Devtoberfest Edition'
        @Common.Text: edition.NAME  @Common.TextArrangement: #TextOnly
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

**UI placement:**
- `SelectionFields`: `[ isActive, currentEvent_ID, edition_ID ]`
- `LineItem`: add `{ Value: edition.NAME, Label: 'Edition' }`
- `FieldGroup#General`: add `{ Value: edition_ID, Label: 'Devtoberfest Edition' }` next to the Event picker

**FK-annotation propagation caveat:** the `@Common.ValueList` + `@Common.Text` on the
`edition` managed association must propagate to the generated `edition_ID` FK (cds-compiler's
managed-association annotation feature — same mechanism as `Tutorials.author`). Pinned by the
admin-annotations regression test in `$metadata`; if it regresses, fall back to an explicit
`annotate { edition_ID @... }` block.

### 4. Value-help picklist UI annotations

`DevtoberfestEditionPickList` needs minimal `@UI` (HeaderInfo + LineItem + SelectionFields)
so the value-help dialog renders columns — mirror `TutorialPickList`'s annotate block.

## Testing

- **Unit** — extend `test/unit/devtoberfest-config-schema.test.js`: assert `edition`/`edition_ID`
  on `AdminService.DevtoberfestConfig`, and `DevtoberfestEditionPickList` is projected.
- **Admin-annotations regression test** — assert the `@Common.ValueList` + `@Common.Text`
  propagate to `edition_ID` in `$metadata`.
- **Model compile gate** — `cds compile` clean with the new association (pre-existing unrelated
  `SearchService` duplicate-def compile error noted; confirm it's not newly introduced).
- **Unit-DB caveat** — `@cds.persistence.exists` facades have no SQLite table under `npm test`;
  follow the existing bootstrap precedent used by the current `DevtoberfestService.Edition`
  projection (which predates this change).
- **Hybrid (optional)** — with both containers in DEV, `DevtoberfestEditionPickList` returns
  rows over the real synonym.

## Deploy

- **DB migration** — `edition_ID` is a new column on `com.sap.developers.ims.DevtoberfestConfig`;
  regenerate `.hdbmigrationtable` via `cds build --for hana` (never hand-author the ALTER).
- **Admin-UI change → FULL bundle-gated deploy** — the `devtoberfest` admin FE app changes.
  Deploy with `npm run deploy -- --env dev` (NO `--skip-build`, NO `-m` scoping; Step 3.5 gates
  the shipped admin bundle). Bump `sap.app.applicationVersion` in
  `app/admin/devtoberfest/webapp/manifest.json` to bust the UI5 IndexedDB fragment cache.
- **PROD deferred** — ships everywhere (field + annotations), but the value help returns no
  rows in PROD until the planner container is on the same PROD HANA instance.

## Repos touched

- `sap-tutorials/tutorials-ims` (this repo) only. No planner-side change — the planner already
  publishes `DTF_EDITION_V1`, which this repo already consumes.
