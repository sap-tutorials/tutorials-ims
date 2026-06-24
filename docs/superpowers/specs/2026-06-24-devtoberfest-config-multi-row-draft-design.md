# Devtoberfest Config: multi-row history + draft-enabled admin

**Date:** 2026-06-24
**Status:** PROPOSED
**Author:** Claude (driven by Tom Jung)
**Supersedes:** singleton-only sections of [2026-06-22-devtoberfest-homepage-design.md](2026-06-22-devtoberfest-homepage-design.md) §5.1

## Why

Today `DevtoberfestConfig` is **schema-multi-row but code-singleton** (one row pinned to UUID `00000000-0000-0000-0000-00d0fe57feed` via `srv/lib/devtoberfest-singleton.js`). Multiple historic Devtoberfest events all share one row, so editing this year's terms text overwrites last year's. The admin tile is a custom UI5 view, not Fiori Elements, and is not draft-enabled — every save is an immediate batch submit with no Save/Discard semantics.

Tom's directive (2026-06-24): Fiori editing of CAP entities should be draft-enabled by default. Devtoberfest needs multi-row history so each event year has its own config row, with exactly one row marked **active** at any time for public-facing queries.

## Decisions (locked 2026-06-24)

1. **Active-row rule** — explicit `isActive : Boolean` column on `DevtoberfestConfig` with a DB constraint enforcing **at most one row with `isActive = true`**. Admin picks which is live; public handlers query `WHERE isActive = true`.
2. **Existing row** — clean slate. Drop the historic singleton row on DEV at cutover. Admin creates a fresh row for the current cycle. PROD never had data here.
3. **Tests** — update all five affected test files in the same PR.

## Schema

```cds
entity DevtoberfestConfig : cuid, managed {
  isActive          : Boolean default false;
  currentEvent      : Association to ims.Events;
  termsText         : LargeString;
  termsVersion      : Integer default 1;
  contentRulesUrl   : String(500);
  faqUrl            : String(500);
  gameboardUrl      : String(500);
  activitiesUrl     : String(500);
}
```

**Constraint:** add a HANA partial-unique index (or CDS `@assert.unique` on a computed expression) that enforces "at most one row with `isActive = true`". CDS-native option:

```cds
@assert.unique.activeFlag : { fields: [isActive], when: [isActive] }
```

If CDS doesn't support a conditional `@assert.unique` directly, fall back to a HANA `hdbindex` artefact via `@cds.persistence.exists`. (Validate at implementation time.)

**Drop:** the `ensureDevtoberfestConfigSingleton()` bootstrap function and its hardcoded UUID. The admin creates rows explicitly through the UI.

## Service shape

```cds
service AdminService {
  @odata.draft.enabled
  @requires: 'Admin'
  entity DevtoberfestConfig as projection on ims.DevtoberfestConfig;
}
```

- **Drop** `@odata.singleton` — it's a regular list entity now.
- **Add** `@odata.draft.enabled` — Save/Discard semantics in the admin UI.

## Public handlers — active-row lookup

Replace `await SELECT.one.from(DevtoberfestConfig)` with `await SELECT.one.from(DevtoberfestConfig).where({ isActive: true })` everywhere:

| File | Function | Change |
| --- | --- | --- |
| [srv/routes/devtoberfest-public.js](../../../srv/routes/devtoberfest-public.js) | `statusHandler`, `termsHandler` | drop `ensureDevtoberfestConfigSingleton()`; query active row; return 503 EVENT_NOT_CONFIGURED if no row found |
| [srv/routes/devtoberfest-auth.js](../../../srv/routes/devtoberfest-auth.js) | join handler | same lookup; rejects join with clear error if no active config |
| [srv/lib/devtoberfest-joule-tool.js](../../../srv/lib/devtoberfest-joule-tool.js) | tool entrypoint | same lookup |
| [srv/admin-service.js](../../../srv/admin-service.js) | before-READ handler | drop singleton-init (admin sees the raw list) |

**Delete** `srv/lib/devtoberfest-singleton.js` entirely after callsites are updated.

## Admin UI — Fiori Elements LR/OP

Replace the current custom UI5 tile (`app/admin/devtoberfest/`) with a Fiori Elements List Report + Object Page scaffold, matching the pattern of every other admin tile (events, missions, groups, accomplishments, etc.).

**ListReport columns:**
- `currentEvent.name` (active event name)
- `currentEvent.startDate` / `endDate`
- `termsVersion`
- `isActive` (with green/red ObjectStatus)
- `modifiedAt`

**ObjectPage sections:**
- Header: event name + isActive switch
- **Active flag** section: single Boolean switch (toggling on auto-deactivates whichever other row was active; toggle-off requires confirm)
- **Configuration** section: currentEvent picker (ComboBox of Events filtered by `IsActiveEntity eq true`), termsVersion StepInput
- **Terms** section: termsText (large TextArea)
- **Sub-pages** section: 4 URL inputs (contentRulesUrl, faqUrl, gameboardUrl, activitiesUrl)
- **Registrations** section: read-only Table of `EventRegistrations` filtered to `event_ID eq <this row's currentEvent_ID>` (replaces the current cross-event registrations table — now per-config-row)

The "make this the active row" toggle needs a custom backend handler: when `isActive` flips `false → true` on a draft activation, deactivate every other row in one transaction so the unique constraint stays satisfied. Implement this as a `before` action handler in `srv/admin-service.js` on the draft-activate event.

## Data migration

DEV cutover:
```sql
DELETE FROM com_sap_developers_ims_DevtoberfestConfig
  WHERE ID = '00000000-0000-0000-0000-00d0fe57feed';
```

Admin re-creates the row through the new UI as the first authentic row. No production data to migrate (PROD cutover for tutorials is end-of-July 2026 — Devtoberfest hasn't shipped to PROD yet).

## Test updates (5 files)

| File | Current assertion | New assertion |
| --- | --- | --- |
| [test/unit/devtoberfest-status-handler.test.js](../../../test/unit/devtoberfest-status-handler.test.js) | Calls handler; expects singleton-from-bootstrap behaviour | Seed a row with `isActive: true`; expect that row's data |
| [test/unit/devtoberfest-terms-handler.test.js](../../../test/unit/devtoberfest-terms-handler.test.js) | Same singleton pattern | Same fix |
| [test/unit/devtoberfest-config-schema.test.js](../../../test/unit/devtoberfest-config-schema.test.js) | Schema validations on the singleton row | Drop singleton-ID assertions; assert `isActive` exists; assert unique constraint via duplicate-insert |
| [test/unit/devtoberfest-join-handler.test.js](../../../test/unit/devtoberfest-join-handler.test.js) | Seeds the singleton then asserts join | Seed active row + assert join uses active.currentEvent_ID |
| [test/unit/devtoberfest-me-handler.test.js](../../../test/unit/devtoberfest-me-handler.test.js) | Same | Same |
| [test/hybrid/devtoberfest-registration-hana.test.js](../../../test/hybrid/devtoberfest-registration-hana.test.js) | HANA end-to-end | Update setup to insert active row |
| [test/devtoberfest-joule-tool.test.js](../../../test/devtoberfest-joule-tool.test.js) | Tool wiring | Update mock to return active row |

Also add: a **new test** asserting the `isActive` unique constraint actually fires when two rows try to be active simultaneously.

## Roll-out plan

1. Schema PR: add `isActive` + unique constraint; CDS build + HDI deploy to DEV
2. Service + handlers PR: drop `@odata.singleton`, add `@odata.draft.enabled`, switch all 5 callsites to active-row lookup, delete `devtoberfest-singleton.js`
3. Admin UI PR: scaffold FE LR/OP under `app/admin/devtoberfest/`, replace custom tile, add to `componentUsages` in admin-shell
4. Tests PR (can ride with #2): update all 7 test files
5. DEV cleanup: DELETE the singleton row
6. Manual smoke: create one DevtoberfestConfig row, flip isActive on, verify homepage `/devtoberfest/status` returns its data, verify admin tile shows it with green status

All four PRs land before any PROD cutover.

## Open questions

- **Active-flag toggle UX**: when admin flips isActive from false→true on draft, do we auto-deactivate the other row server-side? Or refuse activation and require admin to deactivate the other row first? **Recommendation**: auto-deactivate in the same transaction. The unique constraint enforces correctness; the UX should match the user's mental model of "this is now the active one".
- **What happens if zero rows are active?** Public site returns 503 EVENT_NOT_CONFIGURED, same as today's no-event case. Documented.
