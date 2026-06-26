# Event Type — Design Spec

- **Issue:** [#646 — Add an event type with enums - Devtoberfest, TechEd, CodeJam, Challenge, Other](https://github.com/sap-tutorials/tutorials-ims/issues/646)
- **Status:** Approved (design phase)
- **Date:** 2026-06-26
- **Author:** Tom Jung
- **Reviewer:** spec-document-reviewer (pending)

## Problem

The `Events` entity in [db/schema.cds:204-212](../../../db/schema.cds#L204-L212) has no way to distinguish *kinds* of events. Today every Devtoberfest event, every TechEd, every CodeJam, and every ad-hoc challenge sits in the same table with no shared dimension. That makes it impossible to:

- Filter events by program type in the admin tile or in analytics
- Drive future per-type UI behavior (e.g. theming, alert defaults, public homepage scoping) without resorting to fragile `name LIKE '%Devtoberfest%'` heuristics
- Group event metrics by program in `AnalyticsService` queries
- Let public consumers (AppSpace, Vue islands) branch behavior on event type

The issue title pins the enum values explicitly: **Devtoberfest, TechEd, CodeJam, Challenge, Other**. All existing rows must default to **Other**, which is also the default for new rows created without an explicit value.

## Goals

1. Add a single typed column `eventType` to `Events` with a fixed, validated enum.
2. Backfill all existing rows to `OTHER` in the same HDI migration that adds the column.
3. Expose the column for admin editing with an inline dropdown — no extra value-help table.
4. Make `eventType` queryable as an analytics dimension.
5. Expose `eventType` on the public API so authenticated consumers (AppSpace, Vue islands) can read and filter by event type.
6. Stay additive — no existing reader breaks, no migration runbook beyond the standard cds-build pipeline.

## Non-goals (explicit YAGNI)

- ❌ Admin-editable master list of event types — the enum is closed in v1. Adding a new type means a code change and a schema migration, intentionally.
- ❌ `/build/catalog` exposure — not requested; the public Hugo build doesn't currently render events by type, and the `events` array isn't part of the existing catalog payload.
- ❌ Filtering AppSpace / Display dashboards by `eventType` — backend will be ready, but the UI work to *use* the filter is a separate concern.
- ❌ Migrating legacy data into non-`OTHER` types — we don't know which historical events belong to which program. Admins re-classify in the admin UI after deploy.
- ❌ Adding `eventType` to the migration scripts or LegacyKeyed export — internal-only field for now.
- ❌ Exposing `Events.mission`, `prizes`, or `taskRecords` associations on the public OData projection.

## Approach

Use a CAP-level `String(20) enum` type with `@assert.range`, exactly mirroring the existing `MissionType` precedent at [db/schema.cds:16](../../../db/schema.cds#L16). The HDI migration adds the column with `DEFAULT 'OTHER'`, which back-populates every existing row in a single ALTER. Fiori Elements renders an inline dropdown via `@Common.ValueListWithFixedValues` because the value list IS the enum — no `EventTypes` reference table required.

A reference-table approach (`EventTypes` entity with FK from `Events.eventType`) was considered and rejected: it would mean an extra HDI table, seed CSV, value-help wiring, FK-redirect risk, and admin-master-list UI — all to support a flexibility the issue explicitly doesn't ask for.

A free-text `String` column was also considered and rejected: no validation, no enum filter in analytics, typo-prone.

## Enum values

All values UPPER_SNAKE in storage to match `MissionType` and `TaskStatus`:

| Stored value     | Issue-title label |
| ---------------- | ----------------- |
| `DEVTOBERFEST`   | Devtoberfest      |
| `TECHED`         | TechEd            |
| `CODEJAM`        | CodeJam           |
| `CHALLENGE`      | Challenge         |
| `OTHER`          | Other (default)   |

Fiori Elements renders the stored values directly in the dropdown. If a friendlier label is ever wanted, that is a `@Common.Text` annotation on a future text-map — out of scope for v1.

## Architecture

### 1. Schema — `db/schema.cds`

Add a new type alongside the existing enum types near [db/schema.cds:13-17](../../../db/schema.cds#L13-L17):

```cds
type EventType : String(20) enum {
  DEVTOBERFEST; TECHED; CODEJAM; CHALLENGE; OTHER;
}
```

Extend the `Events` entity at [db/schema.cds:204-212](../../../db/schema.cds#L204-L212) with one new field, placed after `timeZone`:

```cds
entity Events : cuid, managed, LegacyKeyed {
  name        : String(255);
  startDate   : Timestamp;
  endDate     : Timestamp;
  timeZone    : String(50);
  eventType   : EventType default 'OTHER' @assert.range;  // NEW
  mission     : Association to Missions;
  taskRecords : Association to many TaskRecords on taskRecords.event = $self;
  prizes      : Association to many Prizes on prizes.event = $self;
}
```

The `default 'OTHER'` ensures rows created via OData without a value land on `OTHER`. `@assert.range` rejects any other string at CAP runtime with HTTP 400 `ASSERT_RANGE` — same error path every other enum on the platform uses.

### 2. HDI migration — `db/src/com.sap.developers.ims.Events.hdbmigrationtable`

Auto-regenerated by `cds build --production`. Bumps from `version=2` to `version=3`, adds the new column to the CREATE TABLE shape, and prepends a `migration=3` block that backfills every existing row to `OTHER` in one ALTER:

```sql
== version=3
COLUMN TABLE com_sap_developers_ims_Events (
  ID NVARCHAR(36) NOT NULL,
  createdAt TIMESTAMP,
  ... (existing columns unchanged) ...
  "TIMEZONE" NVARCHAR(50),
  eventType NVARCHAR(20) DEFAULT 'OTHER',
  mission_ID NVARCHAR(36),
  PRIMARY KEY(ID)
)

== migration=3
-- generated by cds-compiler version 6.9.0
ALTER TABLE com_sap_developers_ims_Events ADD (eventType NVARCHAR(20) DEFAULT 'OTHER');

== migration=2
-- (existing block, unchanged)
ALTER TABLE com_sap_developers_ims_Events ADD (mission_ID NVARCHAR(36));
```

HANA back-populates every existing row with `'OTHER'` as part of the ALTER — no separate UPDATE pass required.

`NVARCHAR(20)` matches the `String(20)` declaration. Longest enum value `DEVTOBERFEST` is 12 chars, well under budget.

### 3. CSN refresh — `db/last-dev/csn.json`

Also regenerated by `cds build --production`. CI's `check-cds-build-staging` fails if this file diverges from the schema, so the regen step is mandatory.

### 4. Admin UI — `app/admin-annotations.cds`

Three additions to the existing Events annotation block at [app/admin-annotations.cds:13-65](../../../app/admin-annotations.cds#L13-L65).

**(a) Label + dropdown** inside the `annotate AdminService.Events with { ... };` block:

```cds
eventType @Common.Label: 'Event Type'
          @Common.ValueListWithFixedValues
          @mandatory;
```

`@Common.ValueListWithFixedValues` makes Fiori Elements source the dropdown from the CDS enum metadata — no separate value-help entity needed. Same pattern as `Missions.missionType` at [app/admin-annotations.cds:78](../../../app/admin-annotations.cds#L78).

**(b) LineItem column** — insert into the list-report table:

```cds
LineItem: [
  { Value: legacyIdStr },
  { Value: name },
  { Value: eventType },        // NEW
  { Value: startDate },
  { Value: endDate },
  { Value: timeZone }
],
```

**(c) SelectionFields filter + General field group:**

```cds
SelectionFields: [ name, eventType, startDate, endDate ],   // add eventType

FieldGroup#General: { Data: [
  { Value: name },
  { Value: eventType },        // NEW
  { Value: startDate },
  { Value: endDate },
  { Value: timeZone }
]}
```

No app/-side rebuild work — FE picks all of this up from CDS metadata at runtime.

### 5. Analytics — `db/schema-ext.cds`

One line added to the existing `annotate ims.Events with { ... }` block at [db/schema-ext.cds:83-87](../../../db/schema-ext.cds#L83-L87):

```cds
annotate ims.Events with {
  name      @analytics.filter: { mode: 'enum', sample: true };
  startDate @analytics.filter: { mode: 'date' };
  endDate   @analytics.filter: { mode: 'date' };
  eventType @analytics.filter: { mode: 'enum', sample: true };  // NEW
};
```

`eventType` then shows up as an enum-style filter chip in the Analytics Explorer entity browser and is groupable in `AnalyticsService.runSelectQuery` SQL.

### 6. Public API — `srv/developer-service.cds` + `srv/developer-service.js`

**(a) Read-only OData projection.** New entity on `DeveloperService` exposing the safe public fields — narrower than the AdminService projection (no associations):

```cds
@(requires: 'authenticated-user')
@readonly entity Events as projection on ims.Events {
  ID, legacyId, name, startDate, endDate, timeZone, eventType
};
```

Add this near the other `@readonly entity` declarations around [srv/developer-service.cds:24](../../../srv/developer-service.cds#L24). Authenticated clients can `GET /api/Events?$filter=eventType eq 'DEVTOBERFEST'` etc.

**(b) Function RPC return shape.** Add `eventType : String` to both function signatures at [srv/developer-service.cds:122-167](../../../srv/developer-service.cds#L122-L167):

```cds
function getEventProgress(missionLegacyId : Integer) returns {
  eventId   : Integer;
  eventType : String;       // NEW
  type      : String;       // unchanged — path-rendering style ('COMPLEX')
  paths     : many { ... };
};

function getAppSpaceProgress(eventLegacyId : Integer) returns {
  eventId   : Integer;
  eventName : String;
  eventType : String;       // NEW
  type      : String;       // unchanged
  paths     : many { ... };
};
```

The existing `type: 'COMPLEX'` literal stays — that field already means "path-rendering style", not event type. The two fields coexist.

**(c) Handler wiring.** Two one-liners in [srv/developer-service.js](../../../srv/developer-service.js):

- Around line 451 (in `getEventProgress`): add `eventType: event?.eventType ?? 'OTHER',` next to `eventId: event?.legacyId ?? 0,`.
- Around line 542 (in `getAppSpaceProgress`): add `eventType: event.eventType ?? 'OTHER',` next to `eventName: event.name || '',`.

The `?? 'OTHER'` fallback matches the schema default — guards against any pre-migration cached read returning NULL.

## Data flow

```text
Admin edits eventType in /admin-ui/#events-display
  → OData PATCH /admin/Events(ID=...) with { eventType: 'DEVTOBERFEST' }
    → AdminService projection on ims.Events
      → CAP @assert.range validates value
        → HANA UPDATE com_sap_developers_ims_Events SET eventType=...

Public Vue island fetches events
  → GET /api/Events?$filter=eventType eq 'DEVTOBERFEST'&$select=name,startDate,endDate
    → DeveloperService.Events read-only projection
      → ims.Events SELECT
        → returns slim public payload

AppSpace island calls progress
  → POST /api/getAppSpaceProgress with { eventLegacyId: 38 }
    → handler reads Events row including eventType
      → returns { eventId, eventName, eventType, type, paths: [...] }

AnalyticsService groupby
  → runSelectQuery('SELECT eventType, COUNT(*) FROM Events GROUP BY eventType')
    → SQL validator allows (Events is @analytics.exposed)
      → result includes new enum dimension
```

## Components affected

| File                                                       | Change                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `db/schema.cds`                                            | Add `EventType` type + `eventType` field on `Events`         |
| `db/src/com.sap.developers.ims.Events.hdbmigrationtable`   | Auto-regenerated (version 2 → 3)                             |
| `db/last-dev/csn.json`                                     | Auto-regenerated                                             |
| `app/admin-annotations.cds`                                | Label, dropdown, LineItem, SelectionFields, FieldGroup       |
| `db/schema-ext.cds`                                        | `@analytics.filter` annotation                               |
| `srv/developer-service.cds`                                | New `Events` projection + `eventType` on two function shapes |
| `srv/developer-service.js`                                 | Two-line handler wiring                                      |
| `test/unit/event-type.test.js`                             | NEW — schema + RPC coverage                                  |

No changes to `srv/admin-service.cds` (existing `*` projection auto-picks up the new column), `srv/analytics-service.cds`, `srv/display-service.cds`, `db/persistence.cds`, `db/views.cds`, `db/devtoberfest.cds`, or any migration script — all are forward-compatible.

## Error handling

- **Invalid enum value on PATCH/POST** — CAP's `@assert.range` rejects with HTTP 400 `ASSERT_RANGE` before the row reaches HANA. Same handler as every other enum on the platform; no custom code.
- **NULL eventType on existing rows after deploy** — impossible: HDI ALTER … DEFAULT 'OTHER' back-populates every row in one shot. Belt-and-suspenders `?? 'OTHER'` in the two RPC handlers guards against any pre-migration cached read.
- **Migration safety** — `NVARCHAR(20)` matches `String(20)`; all enum values fit. The migration is reversible by removing the column (a follow-up `version=4` ALTER DROP), though there's no business reason to revert.

## Testing

One new unit test, no hybrid test:

**`test/unit/event-type.test.js`** — runs under the existing in-memory SQLite unit workspace.

1. `INSERT.into(Events).entries({ name: 'x', startDate, endDate })` succeeds and the resulting row has `eventType === 'OTHER'`.
2. `INSERT.into(Events).entries({ name: 'x', ..., eventType: 'TECHED' })` succeeds.
3. `INSERT.into(Events).entries({ name: 'x', ..., eventType: 'NOT_A_REAL_TYPE' })` rejects with `ASSERT_RANGE`.
4. `getAppSpaceProgress` handler result includes `eventType` matching the source row.

Why no hybrid test: the change is purely a column addition with `@assert.range` and a `default` clause. The existing `MissionType` enum exercises the exact same machinery in production today. The HDI migration is a single ALTER with DEFAULT — covered by the standard `cds bind --exec` deploy pipeline, no behavioral risk.

Why no smoke test: the new `Events` projection on DeveloperService will surface in `/api/$metadata` automatically; existing OData enforcement tests at `test/smoke/odata-metadata.smoke.test.js` will exercise the metadata path and confirm anonymous reads are rejected.

## Risks and mitigations

- **CSN drift** — forgetting to run `cds build --production` after editing `db/schema.cds` will leave `db/last-dev/csn.json` stale and fail CI. Mitigation: it's the second step in the plan; CI's `check-cds-build-staging` is the safety net.
- **Admin UI lag** — annotation changes need the srv app restarted, not just an admin-UI reload. Mitigation: documented in the plan; the standard `cds watch` / deploy cycle handles it.
- **Reading code that hasn't been re-deployed** — the RPC `?? 'OTHER'` fallback handles the transient window where the column exists but a cached connection or stale row returns NULL.
- **Future programs needing a new type** (e.g. a new conference brand in 2027) — adding to the enum is a small schema PR + migration. Acceptable cadence; matches every other enum on the platform.

## Implementation steps (preview — full plan from writing-plans skill)

1. Edit `db/schema.cds` — add `EventType` type + `eventType` field.
2. Run `cds build --production` — regenerates `hdbmigrationtable` + `db/last-dev/csn.json`.
3. Edit `app/admin-annotations.cds` — label/dropdown, LineItem column, SelectionFields, FieldGroup.
4. Edit `db/schema-ext.cds` — analytics filter annotation.
5. Edit `srv/developer-service.cds` — new `Events` projection + `eventType` on two function shapes.
6. Edit `srv/developer-service.js` — wire `eventType` into both handler results.
7. Add `test/unit/event-type.test.js`.
8. Run `npm test`.
9. Open PR: `gh pr create` referencing `Closes #646`.

## References

- Issue: <https://github.com/sap-tutorials/tutorials-ims/issues/646>
- Existing `MissionType` precedent: [db/schema.cds:16](../../../db/schema.cds#L16)
- Existing `missionType` admin annotation precedent: [app/admin-annotations.cds:78](../../../app/admin-annotations.cds#L78)
- HDI migration table convention: [db/src/com.sap.developers.ims.Missions.hdbmigrationtable](../../../db/src/com.sap.developers.ims.Missions.hdbmigrationtable)
- Analytics filter annotation pattern: [db/schema-ext.cds:83-87](../../../db/schema-ext.cds#L83-L87)
- Public DeveloperService surface: [srv/developer-service.cds](../../../srv/developer-service.cds)
- `cds build --production` requirement: [feedback_cds_build_production_not_cds_compile_for_last_dev](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_cds_build_production_not_cds_compile_for_last_dev.md)
