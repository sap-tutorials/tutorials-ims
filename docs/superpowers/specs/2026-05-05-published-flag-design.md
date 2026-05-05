# Published Flag for Missions & Groups

## Problem

Missions and Groups need a publishing workflow — content should only be visible to end users after a super administrator explicitly publishes it. Regular admins can manage content but cannot control visibility.

## Decision

Add a `published` boolean field to Missions and Groups, guarded by a new `SuperAdmin` XSUAA scope. The build catalog, navigator catalog, and search index filter out unpublished records. The admin UI shows the field to all admins but disables it for non-SuperAdmins via dynamic `@UI.FieldControl`.

## Design

### CDS Model Changes

Add `published : Boolean default true` to both `Missions` and `Groups` entities in `db/schema.cds`. Not added to `TaskBase` since Steps, Tutorials, and Checkpoints don't need this concept.

Default `true` ensures existing records remain visible after deploy — no data migration required. This is an explicit choice: the feature gates future content changes, not a retroactive audit of existing data.

### XSUAA Security

Add to `xs-security.json` (reference documentation — the actual IMS XSUAA instance in BTP must also be updated via `cf update-service` or BTP cockpit to add the new scope and role template):

- **Scope**: `$XSAPPNAME.SuperAdmin` — controls published flag writes
- **Role template**: `SuperAdmin` — references SuperAdmin + Admin + Everyone scopes
- **Role collection**: `Tutorials SuperAdmin` — includes SuperAdmin, Admin, DisplayApp, DeveloperApp, Everyone templates

The SuperAdmin role subsumes Admin — anyone who can publish can also do all regular admin tasks.

**Operational note**: Since `xs-security.json` is reference-only (deployment binds to existing IMS XSUAA instances), the scope/role must be manually added to the deployed XSUAA service instance before the feature works in production.

### Authorization Enforcement

A `before` handler on **CREATE, UPDATE, and PATCH** (for draft-enabled entities) of Missions and Groups in AdminService:

1. Check if `req.data.published` is being set or changed
2. If the user lacks the `SuperAdmin` role, reject with 403 and a clear message
3. All other fields remain writable by regular Admins

In CAP Node.js, `req.user.is('SuperAdmin')` checks CDS pseudo-roles which map to XSUAA role templates. With the `SuperAdmin` role template defined in XSUAA, this works correctly. The `@requires: 'Admin'` on the service ensures only admins access the service at all; the handler provides field-level granularity within.

Draft considerations: Both Missions and Groups are `@odata.draft.enabled`. The PATCH event fires when a user edits draft fields. The handler must register on `['CREATE', 'UPDATE', 'PATCH']` to cover:
- `PATCH` — draft field editing (user toggles the checkbox in edit mode)
- `UPDATE` — draft activation (Save)
- `CREATE` — new record creation

### Dynamic UI Field Control

Add a virtual element `publishedFieldControl : Integer` to the Missions and Groups projections in AdminService:

```cds
entity Missions as projection on ims.Missions {
  *, virtual null as publishedFieldControl : Integer
};
entity Groups as projection on ims.Groups {
  *, virtual null as publishedFieldControl : Integer
};
```

An `after READ` handler computes the value per request:
- `7` (editable) if `req.user.is('SuperAdmin')`
- `1` (read-only) otherwise

The handler fires for both active and draft reads — CAP dispatches READ for both `IsActiveEntity=true` and `IsActiveEntity=false` through the same handler. The virtual element computation is stateless (based on user role, not entity state), so it works identically for both cases.

The `published` field annotation references this: `@UI.FieldControl: publishedFieldControl`

Fiori Elements renders the checkbox as disabled for regular admins without custom frontend code.

### Build Catalog Filtering

In `srv/lib/build-catalog.js`, change the missions query:

```js
const missions = await SELECT.from(Missions).where({ published: true });
```

CompletionPaths are filtered transitively — they join via `mission_ID`, so unpublished missions' paths are excluded from hierarchies automatically.

### Navigator Catalog View

The `NavigatorCatalog` view in `db/views.cds` performs a direct join on Missions. Add a filter condition:

```cds
where item.taskType = 'TUTORIAL' and tut.slug is not null and mission.published = true
```

This ensures `/build/navigator` (which queries this view) excludes unpublished missions without any changes to `srv/lib/navigator-catalog.js`.

### Search Index View

The `SearchableItems` view in `db/views.cds` feeds the SearchService. Add `published = true` (or `published is null or published = true` for backward compat) to the Missions and Groups UNION arms:

```cds
SELECT from ims.Missions {
  ...
} where (status is null or status = 'ACTIVE') and published = true
UNION ALL
SELECT from ims.Groups {
  ...
} where (status is null or status = 'ACTIVE') and published = true
```

Unpublished missions/groups will not appear in search results.

### Admin Annotations

Add `published` to Missions and Groups list tables and object pages in `app/admin-annotations.cds`:
- List: show as a column with `@UI.Importance: #High`
- Object page: show in header or first field group with `@UI.FieldControl: publishedFieldControl`

### Impact on Existing Data

- **TaskRecords**: Unpublishing a mission does NOT delete or invalidate existing user progress (TaskRecords). Re-publishing restores the mission seamlessly. This is intentional — unpublish controls visibility, not data integrity.
- **CompletionPaths / Groups within a mission**: Filtered transitively by the mission's published state in views and catalog queries.

## Files Changed

| File | Change |
|------|--------|
| `db/schema.cds` | Add `published` field to Missions and Groups |
| `db/views.cds` | Add `published = true` filter to NavigatorCatalog and SearchableItems views |
| `xs-security.json` | Add SuperAdmin scope, role template, role collection (reference) |
| `srv/admin-service.cds` | Virtual field projections for Missions and Groups |
| `srv/admin-service.js` | `before` handler on CREATE/UPDATE/PATCH (403 guard) + `after READ` handler (field control) |
| `srv/lib/build-catalog.js` | Filter `published: true` |
| `app/admin-annotations.cds` | Add published + fieldControl to UI |

## Operational Steps (not code)

- Add `SuperAdmin` scope and role template to deployed IMS XSUAA instance via BTP cockpit
- Create `Tutorials SuperAdmin` role collection and assign to designated users
- Deploy updated CAP service (HDI deploy will add the column with default true)

## Testing

- **Unit test**: Verify build catalog excludes unpublished missions
- **Unit test**: Verify navigator catalog excludes unpublished missions
- **Unit test**: Verify 403 on published field write without SuperAdmin scope (via UPDATE and PATCH)
- **Unit test**: Verify SuperAdmin can toggle published
- **Unit test**: Verify field control returns 1 for Admin, 7 for SuperAdmin (active and draft reads)
- **Hybrid test**: Verify HANA deploy adds column with default true

## Out of Scope

- Cascading unpublish (unpublishing a Group doesn't auto-unpublish its missions)
- Publish scheduling (future publish dates)
- Audit trail of publish/unpublish actions (already covered by `@cap-js/change-tracking`)
- TaskRecord cleanup on unpublish (progress is preserved; re-publishing restores visibility)
