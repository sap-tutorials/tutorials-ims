# Task-level value help (Tutorials + Puzzles) for Devtoberfest Activities

**Date:** 2026-07-31
**Pattern reference:** [`docs/developers/architecture/cross-container-integration.md`](../../developers/architecture/cross-container-integration.md) — the HDI↔HDI playbook. Read it for the *why* behind every decision below.
**Supersedes (extends):** [`2026-07-27-devtoberfest-cross-container-design.md`](2026-07-27-devtoberfest-cross-container-design.md) — the original tutorial-only value help. This spec adds a second, broader view alongside it.

## Summary

The Devtoberfest Planner's **Activity** entity currently links to a single tutorials-ims **Tutorial** (via the cross-container `TUTORIAL_VALUE_HELP_V1` view → synonym → facade → Fiori `@Common.ValueList`). We need an author to be able to assign **either a Tutorial or a Puzzle** to an Activity.

Approach: publish a **new versioned union view** `TASK_VALUE_HELP_V1` in tutorials-ims (the provider) that exposes both Tutorials and Puzzles with a `TASKTYPE` discriminator, grow the existing `tutorial_reader` role to cover it, then re-wire the planner's Activity value help onto the new view with a single discriminated association.

The existing `TUTORIAL_VALUE_HELP_V1` is left **untouched** (versioning policy D2 — add alongside, don't mutate a live contract).

## Goals

- A single planner-side value help lists both active Tutorials and active Puzzles, labelled with their kind.
- A picked task's GUID is stored on `Activity.task_ID`, with the task's kind in `Activity.taskType` and a denormalized `taskSlug`/`taskTitle` snapshot (workbook D6).
- Provider view exposes a superset of both task types' columns, type-specific columns NULL-padded, **`SOLUTION` never exposed** (server-only per `srv/puzzle-service.cds`).
- Existing tutorial links on Activities keep working after the migration.

## Non-goals

- **No change to `TUTORIAL_VALUE_HELP_V1`** — it stays as-is for any other/future consumer.
- **QA container** (`tutorials-hana-qa`) — out of scope; only `tutorials-hana` participates.
- No new reader **role** — grow the existing `tutorial_reader` role (workbook D3: broaden the API surface via the role, not the grant; consumer grants unchanged).
- No exposure of `Puzzles.solution`, ever. No exposure of Missions/Groups/Steps/Checkpoints (out of scope; the ask is Tutorials + Puzzles only).

## Key facts (verified against both repos)

| Fact | Value | Source |
|---|---|---|
| Our HDI container (pinned) | `tutorials-hana` | `.deploy/mta.yaml` |
| Planner HDI container | `devtoberfest-planner-db` | `D:\projects\devtoberfest-planner\mta.yaml` |
| Tutorials base table | `COM_SAP_DEVELOPERS_IMS_TUTORIALS` | `db/schema.cds` (`Tutorials : TaskBase`) |
| Puzzles base table | `COM_SAP_DEVELOPERS_IMS_PUZZLES` | `db/schema.cds:132` (`Puzzles : TaskBase`) |
| Shared columns (TaskBase) | `ID, title, description, status, primaryTag, experienceTag, averageTimeToComplete` (+`legacyId`) | `db/schema.cds:21` |
| Tutorial-only cols | `slug, mdFileUrl, stepCount, featuredOrder, …` | `db/schema.cds:32` |
| Puzzle-only cols | `slug, layout, **solution (SERVER-ONLY)**` | `db/schema.cds:132` |
| Published predicate | `status = 'ACTIVE' OR status IS NULL` | matches existing `TUTORIAL_VALUE_HELP_V1` |
| Existing provider view aliases columns | **UPPERCASE** (`AS "SLUG"`, `AS "TITLE"`) | `db/src/TUTORIAL_VALUE_HELP_V1.hdbview` |
| Existing reader roles | `tutorial_reader` + `tutorial_reader#` (grantable) | `db/src/tutorial_reader*.hdbrole` |
| Planner Activity link today | `tutorial : Association to external.tutorials.TUTORIAL_VALUE_HELP_V1` + `tutorialSlug`/`tutorialTitle` | `devtoberfest-planner db/schema.cds:107` |
| Planner value help today | `@Common.ValueList` CollectionPath `Tutorials` on `Activity.tutorial_ID` | `app/maintain-activities/annotations.cds:142` |
| Planner service serving activities | `SessionsService` `@(path:'/sessions')`, `Activities` is `@odata.draft.enabled` | `srv/sessions-service.cds:21` |
| Grants already request | `tutorial_reader` (`container_roles`) for object_owner + application_user | planner `db/src/tutorials-grants.hdbgrants` |

> **Case rule (workbook D4a):** the existing deployed view and the *consumer's generated view* both fold unquoted identifiers to UPPERCASE. All new view output aliases AND all new facade entity elements MUST be UPPERCASE. (The planner's existing `TUTORIAL_VALUE_HELP_V1` facade is camelCase and is being reconciled separately in the `tutorial-view-uppercase-cols` line of work; the **new** `TASK_VALUE_HELP_V1` facade is authored UPPERCASE from the start to avoid the same silent-resolve trap.)

## Architecture

```
tutorials-hana (PROVIDER)                       devtoberfest-planner-db (CONSUMER)
─────────────────                               ────────────────────────
base: COM_SAP_DEVELOPERS_IMS_TUTORIALS
base: COM_SAP_DEVELOPERS_IMS_PUZZLES
   │ publish (UNION ALL, UPPERCASE aliases,
   │          SOLUTION excluded)
   ▼
VIEW TASK_VALUE_HELP_V1  ◄───────────────────  .hdbsynonym TASK_VALUE_HELP_V1
 (ID,SLUG,TITLE,PRIMARYTAG,EXPERIENCETAG,          (grants unchanged — tutorial_reader
  AVERAGETIMETOCOMPLETE,DESCRIPTION,                 role now also covers this view)
  TASKTYPE, MDFILEURL,STEPCOUNT, LAYOUT)           ▼
   │ + tutorial_reader role grows to add          @cds.persistence.exists facade
   │   SELECT on TASK_VALUE_HELP_V1                external.tutorials.TASK_VALUE_HELP_V1
   │   (tutorial_reader# too)                       ▼
   (TUTORIAL_VALUE_HELP_V1 untouched)             SessionsService: @readonly Tasks projection
                                                    ▼
                                                  @Common.ValueList on Activity.task_ID
                                                  (+ taskType, title, slug, primaryTag)
```

## Artifacts

### Repo A — tutorials-ims (provider, this repo)

**A1. `db/src/TASK_VALUE_HELP_V1.hdbview`** — versioned union view. Superset shape, UPPERCASE aliases, `SOLUTION` never selected, `STATUS` filter per branch:

```sql
VIEW "TASK_VALUE_HELP_V1" AS
  SELECT "ID"                    AS "ID",
         "SLUG"                  AS "SLUG",
         "TITLE"                 AS "TITLE",
         "PRIMARYTAG"            AS "PRIMARYTAG",
         "EXPERIENCETAG"         AS "EXPERIENCETAG",
         "AVERAGETIMETOCOMPLETE" AS "AVERAGETIMETOCOMPLETE",
         "DESCRIPTION"           AS "DESCRIPTION",
         'TUTORIAL'              AS "TASKTYPE",
         "MDFILEURL"             AS "MDFILEURL",
         "STEPCOUNT"             AS "STEPCOUNT",
         CAST(NULL AS NCLOB)     AS "LAYOUT"
  FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
  WHERE "STATUS" = 'ACTIVE' OR "STATUS" IS NULL
  UNION ALL
  SELECT "ID"                    AS "ID",
         "SLUG"                  AS "SLUG",
         "TITLE"                 AS "TITLE",
         "PRIMARYTAG"            AS "PRIMARYTAG",
         "EXPERIENCETAG"         AS "EXPERIENCETAG",
         "AVERAGETIMETOCOMPLETE" AS "AVERAGETIMETOCOMPLETE",
         "DESCRIPTION"           AS "DESCRIPTION",
         'PUZZLE'                AS "TASKTYPE",
         CAST(NULL AS NVARCHAR(1000)) AS "MDFILEURL",
         CAST(NULL AS INTEGER)   AS "STEPCOUNT",
         "LAYOUT"                AS "LAYOUT"
  FROM "COM_SAP_DEVELOPERS_IMS_PUZZLES"
  WHERE "STATUS" = 'ACTIVE' OR "STATUS" IS NULL
```

> Exact base physical column names/types (and NULL cast types for the padded columns) **verified against the deployed `tutorials-hana` container with `hana-cli` before authoring** (workbook D4a / pre-flight checklist). The union branches must be column-count- and type-compatible; NULL-pad the other type's columns with an explicit `CAST`.

**A2. `db/src/tutorial_reader.hdbrole`** — add a second `object_privileges` entry granting `SELECT` on `TASK_VALUE_HELP_V1` (keep the existing `TUTORIAL_VALUE_HELP_V1` entry). Same edit in **`db/src/tutorial_reader_grantable.hdbrole`** (`privileges_with_grant_option`). No new role, no consumer grant change (workbook D3).

**A3. Unit test** — assert `TASK_VALUE_HELP_V1` (SQLite view equivalent): returns both `TUTORIAL` and `PUZZLE` rows, only `ACTIVE`/null-status, and the projection has **no `SOLUTION`/`solution` column**. Real cross-container filter verified in Phase-2 `hana-cli` probe.

### Repo B — devtoberfest-planner (consumer, separate repo + separate PR)

**B1. `db/src/TASK_VALUE_HELP_V1.hdbsynonym`** — target the new provider view:

```jsonc
{ "TASK_VALUE_HELP_V1": { "target": { "object": "TASK_VALUE_HELP_V1" } } }
```

No `.hdbsynonymconfig`; existing `tutorials-grants.hdbgrants` already requests `tutorial_reader`, which now covers this view.

**B2. `db/external/tutorials.cds`** — add facade (UPPERCASE elements, generated from the deployed view via `hana-cli inspectView --output cds`):

```cds
@cds.persistence.exists
entity TASK_VALUE_HELP_V1 {
  key ID                    : String(36);
      SLUG                  : String(255);
      TITLE                 : String(255);
      PRIMARYTAG            : String(255);
      EXPERIENCETAG         : String(255);
      AVERAGETIMETOCOMPLETE : Integer;
      DESCRIPTION           : LargeString;
      TASKTYPE              : String(20);
      MDFILEURL             : String(1000);
      STEPCOUNT             : Integer;
      LAYOUT                : LargeString;
}
```

**B3. `db/schema.cds` — `Activity`:** replace the tutorial-specific link with a discriminated task link.

```cds
// was: tutorial : Association to tutorials.TUTORIAL_VALUE_HELP_V1 …
task      : Association to tutorials.TASK_VALUE_HELP_V1 @mandatory @changelog @title: 'Task';
taskType  : String(20) @title: 'Type';   // 'TUTORIAL' | 'PUZZLE' — snapshot of task.TASKTYPE
taskSlug  : String(255);                  // denormalized snapshot (D6)
taskTitle : String(255);                  // denormalized snapshot (D6)
```

**B4. `srv/sessions-service.cds`** — replace the `Tutorials` projection with `Tasks`:

```cds
@readonly entity Tasks as projection on tutorials.TASK_VALUE_HELP_V1;
```

**B5. `srv/sessions-service-auth.cds`** — add the READ restriction for `SessionsService.Tasks` mirroring the current `Tutorials` grant (`['SystemAdmin','TrackOwner','TrackViewer']`); remove the now-dead `Tutorials` annotation.

**B6. `app/maintain-activities/annotations.cds`** — repoint the value help and surface the kind:
- `@Common.ValueList` on `task_ID`: `CollectionPath: 'Tasks'`, `ValueListParameterOut ID → task_ID`, display-only `TASKTYPE`, `TITLE`, `SLUG`, `PRIMARYTAG`. `Common.Text: task.TITLE`, `#TextOnly`.
- LineItem: swap the `tutorialTitle` column for `taskTitle` + add a `taskType` column.
- FieldGroup #Details: swap `tutorial_ID` for `task_ID` and add `taskType` (read-only, populated from the pick).

**B7. Snapshot + discriminator copy** — `after`/`before`-save handler (or FE-side) on Activity draft-save copies the picked row's `TASKTYPE`/`SLUG`/`TITLE` into `taskType`/`taskSlug`/`taskTitle`. Decide handler-vs-FE during build (mirror whatever the original tutorial snapshot used).

**B8. Data migration** — existing `Activity` rows carry a tutorial GUID in the old `tutorial_ID` column. After the rename, backfill `task_ID` from the old value (same GUID; it exists in the union view) and set `taskType='TUTORIAL'`, `taskSlug`/`taskTitle` from the old snapshot columns. One-shot SQL / CSV, DEV only (no PROD planner data yet — confirm with planner owner).

## Data flow (value help)

1. Author edits an Activity in `app/maintain-activities`, opens the Task field value help.
2. FE → `GET /sessions/Tasks?$search=…` on `SessionsService`.
3. CAP resolves `Tasks` → facade → synonym → `TASK_VALUE_HELP_V1` in `tutorials-hana` (in-database SQL).
4. View unions active Tutorials + Puzzles, applies the `STATUS` filter provider-side; returns the superset columns incl. `TASKTYPE`.
5. Author picks → FE sets `Activity.task_ID`; save-handler copies `TASKTYPE`/`SLUG`/`TITLE` into the snapshot columns.
6. Stored GUID = tutorials-ims `Tutorials.ID` or `Puzzles.ID`; resolvable later via the same synonym or the snapshot fallback.

## Error handling & least-privilege

- Grant is `SELECT` on the **specific views only** — never schema-wide, never a base table. `SOLUTION` is not in the view, so a puzzle answer key is unreachable cross-container even with the grant.
- Synonym target missing → HDI deploy fails loudly; provider-first sequencing (D5) prevents it.
- **Dangling GUID:** no cross-container FK; if a task is retired the value help won't resolve it, but `taskSlug`/`taskTitle` still render a label (D6).
- Dropping/renaming `_V1` breaks the consumer synonym → follow versioning policy (add `_V2`, migrate, retire).

## Deploy sequence (D5 — base-then-enable, provider-first)

```
Phase 1  PROVIDER — deploy tutorials-ims: TASK_VALUE_HELP_V1 view + grow tutorial_reader role(s).
         (TUTORIAL_VALUE_HELP_V1 unchanged; ordinary redeploy, no cross-dep.)
Phase 2  VERIFY — hana-cli SQL probe through the planner's (new) synonym returns both TUTORIAL and
         PUZZLE rows before trusting the facade. Gate.
Phase 3  CONSUMER — deploy devtoberfest-planner: synonym + facade + schema rename + migration +
         service projection + auth + value-help annotations.
```

Steady-state redeploys are order-independent (both views persist).

## Testing

- **tutorials-ims (unit):** `TASK_VALUE_HELP_V1` returns both task types, ACTIVE/null only, no `SOLUTION` column (SQLite view equivalent; real filter in hybrid/probe).
- **Cross-container smoke (Phase 2 gate):** `hana-cli` query through the planner synonym confirms resolution + both types present.
- **planner (hybrid):** `SessionsService.Tasks` returns rows over the real synonym.
- **planner (e2e):** value help opens on the Activity object page, a Tutorial pick and a Puzzle pick each persist `task_ID` + `taskType` + snapshot. (Committed spec per the e2e-coverage pattern, since this touches `app/**/webapp/**`-adjacent annotations.)

## Open items for implementation

- **Exact deployed physical column names/types for Puzzles** (`COM_SAP_DEVELOPERS_IMS_PUZZLES`) — introspect the deployed `tutorials-hana` DEV container with `hana-cli` before authoring the view; confirm `LAYOUT`/`MDFILEURL`/`STEPCOUNT` catalog types for the `CAST(NULL …)` pads. Do NOT retype from CDS source (D4a).
- **Snapshot copy mechanism** — handler vs FE; match the original tutorial value help's approach.
- **Migration ownership** — confirm with the planner owner that DEV Activity data can be backfilled/renamed (no PROD planner data expected yet).
- **Old `Tutorials` projection** — replaced by `Tasks` (per approved design: single discriminated field). Confirm no other planner consumer references `SessionsService.Tutorials` before deleting it.

## Repos touched

- `sap-tutorials/tutorials-ims` (this repo): provider view A1 + reader-role growth A2 + unit test A3. **This PR.**
- `github.tools.sap/developer-relations/devtoberfest-planner` (`D:\projects\devtoberfest-planner`): synonym/facade/schema/migration/service/auth/annotations (B1–B8). **Separate PR in that repo.**

## Registry update

Add to the cross-container link registry (`docs/developers/architecture/cross-container-integration.md`):

| Provider | Published view | Consumer | Consumer facade | Version | Status | Feature |
|---|---|---|---|---|---|---|
| `tutorials-hana` | `TASK_VALUE_HELP_V1` | `devtoberfest-planner-db` | `external.tutorials.TASK_VALUE_HELP_V1` | V1 | planned | Activity task (tutorial/puzzle) value help |
