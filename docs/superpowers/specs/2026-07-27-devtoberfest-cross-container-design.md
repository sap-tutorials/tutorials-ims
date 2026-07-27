# Devtoberfest Planner ↔ Tutorials cross-container integration

**Date:** 2026-07-27
**Issue:** [sap-tutorials/tutorials-ims#1347](https://github.com/sap-tutorials/tutorials-ims/issues/1347)
**Pattern reference:** [`docs/developers/architecture/cross-container-integration.md`](../../developers/architecture/cross-container-integration.md) — read the workbook for the *why* behind every decision; this spec is its first worked example and stays concrete.

## Summary

Establish **bi-directional HDI-to-HDI cross-container access** between this system (`tutorials-hana`) and the Devtoberfest Planner (`devtoberfest-planner-db`), both in the same DEV subaccount and HANA instance. The first consuming feature: a **tutorial value help** in the planner, so an author can assign a specific Tutorial (by GUID) to a planner **Session** for completion tracking.

Both legs are wired in this change even though only the planner→tutorials leg has a consumer today; the reciprocal leg proves the round-trip and reserves the surface.

## Goals

- Planner reads active tutorials from our container via a **versioned view** → synonym → `@cds.persistence.exists` facade → OData value help on `Session`.
- A picked tutorial's GUID (`Tutorials.ID`) is stored on the planner's `Session`, with a denormalized slug/title snapshot for resilience.
- Reciprocal leg: our container can read a versioned view the planner publishes (facade sits unused until a feature needs it).
- The generic pattern is captured in the workbook; this spec is the reference implementation.

## Non-goals

- **QA container** (`tutorials-hana-qa`) — out of scope; only `tutorials-hana` participates.
- No tutorials-ims-side *feature* consuming planner data yet (Leg B facade is reserved, unused).
- No `published` boolean on Tutorials — "published" for a tutorial means the row exists in `tutorials-hana` **and** `status='ACTIVE' OR status IS NULL` (there is no separate publish flag; only Missions have one).
- No OData/HTTP federation — direct DB synonym only (enables SQL JOINs, no HTTP hop).

## Key facts (verified against both repos)

| Fact | Value | Source |
|---|---|---|
| Our HDI container (pinned) | `tutorials-hana` | `mta.yaml` / `.deploy/mta.yaml` |
| Planner HDI container | `devtoberfest-planner-db` — **`service-name` NOT yet pinned** | `D:\projects\devtoberfest-planner\mta.yaml` |
| Tutorials base table | `com_sap_developers_ims_Tutorials` (`ID` NVARCHAR(36), `slug`, `title`, `primaryTag`, `status`) | `db/schema.cds`, `.hdbmigrationtable` |
| Published-tutorial predicate | `status = 'ACTIVE' OR status IS NULL` | `AdminService.TutorialPickList` (`srv/admin-service.cds:72`) |
| Planner completion target | `Session` entity, `namespace devtoberfest` → `devtoberfest_Session` | `D:\projects\devtoberfest-planner\db\schema.cds` |
| Planner service serving sessions | `SessionsService` `@(path:'/sessions')`, `Sessions` is `@odata.draft.enabled` | `srv/sessions-service.cds` |
| Value-help pattern to mirror | `track` field `@Common.ValueList` | `app/devtoberfest/sessions-annotations.cds:256` |
| Planner cross-container plumbing today | **none** (no `.hdbgrants`/`.hdbsynonym`/grantor) | greenfield |

## Architecture

```
LEG A (feature): planner reads tutorials
  tutorials-hana                          devtoberfest-planner-db
  ─────────────────                       ────────────────────────
  base: com_sap_developers_ims_Tutorials
   │ publish
   ▼
  VIEW TUTORIAL_VALUE_HELP_V1  ◄────────  .hdbsynonym  ◄─ requires: tutorials-hana (existing-service)
   (ID,slug,title,primaryTag;             .hdbgrants (grantor = tutorials-hana tech user;
    status ACTIVE/null)                     request container_role tutorial_value_help_reader)
   │ + tutorial_value_help_reader           ▼
   │   .hdbrole (SELECT on view)          @cds.persistence.exists facade  external.tutorials.TutorialValueHelpV1
                                             ▼
                                           SessionsService: read-only Tutorials projection
                                             ▼
                                           @Common.ValueList on Session.tutorial_ID  →  Fiori value help

LEG B (reciprocal, reserved): tutorials reads planner
  devtoberfest-planner-db                 tutorials-hana
  publish VIEW ACTIVITY_SESSION_V1  ◄───  .hdbsynonym + .hdbgrants (grantor = planner tech user;
   + activity_session_reader .hdbrole       request container_role activity_session_reader)
                                             ▼
                                           @cds.persistence.exists facade external.devtoberfest.ActivitySessionV1  (UNUSED)
```

`.hdbgrants` + synonym + facade always live on the **consumer** side; the provider only publishes the view (per workbook D3).

## Artifacts

### Leg A — tutorials-ims (provider)

1. **`db/src/TUTORIAL_VALUE_HELP_V1.hdbview`** — versioned published view:
   ```sql
   VIEW "TUTORIAL_VALUE_HELP_V1" AS
     SELECT "ID"         AS "ID",
            "slug"       AS "slug",
            "title"      AS "title",
            "primaryTag" AS "primaryTag"
     FROM "com_sap_developers_ims_Tutorials"
     WHERE "status" = 'ACTIVE' OR "status" IS NULL
   ```
   (Author as `.hdbview`, or as a CDS view compiled to this physical name — keep the `_V1` suffix. Explicit column aliases make the exposed names/case the stable proxy contract — workbook D4a; confirm the base column case against the deployed table first.)
1a. **`db/src/tutorial_value_help_reader.hdbrole`** — least-privilege reader role granting `SELECT` on `TUTORIAL_VALUE_HELP_V1`. This role is the versioned API contract the planner requests; we broaden/narrow the planner's reach by editing this role, not the planner's grants file (workbook D3).

### Leg A — devtoberfest-planner (consumer)

2. **`mta.yaml`** — pin `service-name: devtoberfest-planner-db` on the hdi-container resource; add `tutorials-hana` as an `existing-service` resource; `devtoberfest-planner-db-deployer` gains `requires: - name: tutorials-hana`.
3. **`db/src/tutorials-grants.hdbgrants`** — keyed by `tutorials-hana`, request the provider's `tutorial_value_help_reader` role (`container_roles`) for `object_owner` + `application_user` (see workbook C1).
4. **`db/src/TUTORIAL_VALUE_HELP_V1.hdbsynonym`** — target the provider view. **No `.hdbsynonymconfig`** — not needed for HDI-to-HDI.
5. **`db/external/tutorials.cds`** — `@cds.persistence.exists` facade `external.tutorials.TutorialValueHelpV1` (generate via `hana-cli inspectView --output cds`).
6. **`db/schema.cds`** — extend `Session`:
   ```cds
   tutorial      : Association to external.tutorials.TutorialValueHelpV1;  // stores tutorial_ID
   tutorialSlug  : String(255);   // denormalized snapshot at pick-time (workbook D6)
   tutorialTitle : String(255);   // denormalized snapshot at pick-time
   ```
7. **`srv/sessions-service.cds`** — expose `@readonly entity Tutorials as projection on external.tutorials.TutorialValueHelpV1;`
8. **`app/devtoberfest/sessions-annotations.cds`** — `@Common.ValueList` on `Session.tutorial_ID`, `CollectionPath: 'Tutorials'`, `ValueListParameterOut` mapping the picklist key `ID` → `Session.tutorial_ID`, plus display-only params for `slug`/`title` (mirror the `track` value help at line 256). A small `after` handler on Session draft-save copies the picked row's `slug`/`title` into `tutorialSlug`/`tutorialTitle`.

### Leg B — devtoberfest-planner (provider)

9. **`db/src/ACTIVITY_SESSION_V1.hdbview`** — slim view over `devtoberfest_Session` (+ `devtoberfest_Track` for `isActivityTrack`). Proposed columns: `ID, sessionCode, title, trackTitle, isActivityTrack, tutorial_ID, scheduledDate`. **Exact column list confirmed at implementation** with the planner owner; no PII.
9a. **`db/src/activity_session_reader.hdbrole`** — least-privilege reader role granting `SELECT` on `ACTIVITY_SESSION_V1`.

### Leg B — tutorials-ims (consumer)

10. **`mta.yaml` + `.deploy/mta.yaml`** — add `devtoberfest-planner-db` as `existing-service`; `tutorials-db-deployer` gains `requires: - name: devtoberfest-planner-db`. (**QA deployer untouched.**)
11. **`db/src/planner-grants.hdbgrants`** — keyed by `devtoberfest-planner-db`, request the planner's `activity_session_reader` role (`container_roles`). *(Note: this is a **new** file/key; the existing `db/src/_grants.hdbgrants` keyed by `tutorials-kg-grantor` stays untouched — keep grantor channels in separate files per the `_grants.hdbgrants.md` rule.)*
12. **`db/src/ACTIVITY_SESSION_V1.hdbsynonym`** — target the planner view.
13. **`db/external/devtoberfest-planner.cds`** — `@cds.persistence.exists` facade `external.devtoberfest.ActivitySessionV1`. **Not projected in any service** (reserved). Documented as intentionally-unused in the registry.

## Data flow (value help)

1. Author edits a Session in `app/devtoberfest`, opens the Tutorial field value help.
2. FE → `GET /sessions/Tutorials?$search=…` on `SessionsService`.
3. CAP resolves `Tutorials` → facade (`@cds.persistence.exists`) → synonym → `TUTORIAL_VALUE_HELP_V1` in `tutorials-hana` (in-database SQL).
4. View applies the `status` filter provider-side; returns `ID, slug, title, primaryTag`.
5. Author picks → FE sets `Session.tutorial_ID`; `after`-save copies `slug`/`title` into the snapshot columns.
6. Stored GUID = tutorials-ims `Tutorials.ID`; resolvable later via the same synonym (SQL JOIN) or our OData for display.

## Error handling & least-privilege

- Grant is `SELECT` on the **specific view only** — never schema-wide, never the base table.
- Synonym target missing → HDI deploy fails loudly; provider-first sequencing prevents it.
- **Dangling GUID:** no cross-container FK; if a tutorial is retired the value help won't resolve it, but the `tutorialSlug`/`tutorialTitle` snapshot still renders a label (workbook D6).
- Dropping/renaming `_V1` breaks consumer synonyms → follow versioning policy (add `_V2`, migrate, retire).

## Deploy sequence (first-time DEV bootstrap)

Per workbook D5 — base-then-enable, provider-first. Confirm scope with maintainer before each deploy.

```
Phase 0  Pin service-name on devtoberfest-planner-db (tutorials-hana already pinned).
Phase 1  BASE — publish views + reader roles only, no grants/synonyms:
         ├─ tutorials-ims db-deployer  → TUTORIAL_VALUE_HELP_V1 + tutorial_value_help_reader role
         └─ planner     db-deployer    → ACTIVITY_SESSION_V1 + activity_session_reader role
Phase 2  ENABLE — add grants + synonyms + facades (targets now exist):
         ├─ planner     db-deployer    → tutorials-grants (request reader role) + synonym + facade  (Leg A) + value help
         └─ tutorials-ims db-deployer  → planner-grants  (request reader role) + synonym + facade   (Leg B, unused)
Phase 3  VERIFY — hana-cli SQL probe through each synonym returns rows before trusting facades.
```

Steady-state redeploys are order-independent (both views persist).

## Testing

- **tutorials-ims (unit):** `TUTORIAL_VALUE_HELP_V1` returns only `ACTIVE`/null-status rows (SQLite view equivalent for unit; real filter verified in hybrid).
- **planner (hybrid):** facade + `SessionsService.Tutorials` returns rows over the real synonym (needs both containers deployed to DEV).
- **Cross-container smoke:** `hana-cli` query through each synonym confirms resolution (Phase 3 gate).
- **planner (e2e, optional):** value help opens on the Session object page and a pick persists `tutorial_ID` + snapshot.

## Open items for implementation

- **`ACTIVITY_SESSION_V1` exact columns + deployed physical names** — confirm with planner owner (no PII). Before authoring the view, **introspect the deployed `devtoberfest-planner-db` container in DEV with `hana-cli`** to read the true physical table/column names and their case — CDS source names (`devtoberfest.Session`, camelCase fields) will NOT match the deployed identifiers. Alias columns in the view (quoted identifiers) so they match exactly what the `@cds.persistence.exists` proxy expects, including case (workbook D4a). Same rule applies to the Leg A facade over `TUTORIAL_VALUE_HELP_V1`.
- **Snapshot copy mechanism** — `after`-save handler vs. FE-side; decide during Leg A build.

*Resolved during design:* `.hdbsynonymconfig` is **not** needed for HDI-to-HDI — grants + synonyms suffice (confirmed against the [XSA cross-container tutorial](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials/xsa-cross-container-access), identical on CF + HANA Cloud). Grants request a provider-defined reader **role** (`container_roles`), not direct object privileges, so the API surface is adjustable provider-side without touching consumer grants.

## Repos touched

- `sap-tutorials/tutorials-ims` (this repo): provider view (Leg A) + consumer synonym/facade/grants (Leg B) + mta wiring.
- `github.tools.sap/developer-relations/devtoberfest-planner` (`D:\projects\devtoberfest-planner`): consumer synonym/facade/grants + Session field + value help (Leg A) + provider view (Leg B) + `service-name` pin. **Separate PR in that repo.**
