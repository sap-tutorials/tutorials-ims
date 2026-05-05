# Published Flag for Missions & Groups

## Problem

Missions and Groups need a publishing workflow — content should only be visible to end users after a super administrator explicitly publishes it. Regular admins can manage content but cannot control visibility.

## Decision

Add a `published` boolean field to Missions and Groups, guarded by a new `SuperAdmin` XSUAA scope. The build catalog and public APIs filter out unpublished records. The admin UI shows the field to all admins but disables it for non-SuperAdmins via dynamic `@UI.FieldControl`.

## Design

### CDS Model Changes

Add `published : Boolean default true` to both `Missions` and `Groups` entities in `db/schema.cds`. Not added to `TaskBase` since Steps, Tutorials, and Checkpoints don't need this concept.

Default `true` ensures existing records remain visible after deploy — no data migration needed.

### XSUAA Security

Add to `xs-security.json`:

- **Scope**: `$XSAPPNAME.SuperAdmin` — controls published flag writes
- **Role template**: `SuperAdmin` — references SuperAdmin + Admin + Everyone scopes
- **Role collection**: `Tutorials SuperAdmin` — includes SuperAdmin, Admin, DisplayApp, DeveloperApp, Everyone templates

The SuperAdmin role subsumes Admin — anyone who can publish can also do all regular admin tasks.

### Authorization Enforcement

A `before` handler on CREATE and UPDATE of Missions and Groups in AdminService:

1. Check if `req.data.published` is being set or changed
2. If the user lacks the `SuperAdmin` scope, reject with 403 and a clear message
3. All other fields remain writable by regular Admins

This is server-side enforcement — the UI control is cosmetic.

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

The `published` field annotation references this: `@UI.FieldControl: publishedFieldControl`

Fiori Elements renders the checkbox as disabled for regular admins without custom frontend code.

### Build Catalog Filtering

In `srv/lib/build-catalog.js`, change the missions query:

```js
const missions = await SELECT.from(Missions).where({ published: true });
```

CompletionPaths are filtered transitively — they join via `mission_ID`, so unpublished missions' paths are excluded from hierarchies automatically.

### Admin Annotations

Add `published` to Missions and Groups list tables and object pages in `app/admin-annotations.cds`:
- List: show as a column with `@UI.Importance: #High`
- Object page: show in header or first field group with `@UI.FieldControl: publishedFieldControl`

### Groups in Public APIs

The `Groups` entity is used for top-level grouping. Any public-facing service or endpoint that exposes Groups (currently the build catalog exposes them as CompletionPaths within missions) must also respect the published filter. If Groups are surfaced independently elsewhere, add `.where({ published: true })` there too.

## Files Changed

| File | Change |
|------|--------|
| `db/schema.cds` | Add `published` field to Missions and Groups |
| `xs-security.json` | Add SuperAdmin scope, role template, role collection |
| `srv/admin-service.cds` | Virtual field projections for Missions and Groups |
| `srv/admin-service.js` | `before` handler (403 guard) + `after READ` handler (field control) |
| `srv/lib/build-catalog.js` | Filter `published: true` |
| `app/admin-annotations.cds` | Add published + fieldControl to UI |

## Testing

- **Unit test**: Verify build catalog excludes unpublished missions
- **Unit test**: Verify 403 on published field write without SuperAdmin scope
- **Unit test**: Verify SuperAdmin can toggle published
- **Unit test**: Verify field control returns 1 for Admin, 7 for SuperAdmin
- **Hybrid test**: Verify HANA deploy adds column with default true

## Out of Scope

- Cascading unpublish (unpublishing a Group doesn't auto-unpublish its missions)
- Publish scheduling (future publish dates)
- Audit trail of publish/unpublish actions (already covered by `@cap-js/change-tracking`)
