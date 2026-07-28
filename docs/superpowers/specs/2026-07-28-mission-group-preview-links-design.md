# QA & Main preview links on the Missions and Groups admin Object Pages

**Date:** 2026-07-28
**Status:** Design approved, pending implementation plan
**Area:** Admin UI — Missions Object Page (`/admin-ui/#/missions`) and Groups Object Page (`/admin-ui/#/groups`), General facet

## Problem

The admin Tutorials Object Page now shows source & preview links in its
Lifecycle group (spec `2026-07-28-tutorial-lifecycle-source-preview-links`).
Missions and Groups have no equivalent — an admin viewing a mission or group
has no one-click path to preview the rendered page (QA channel) or open the
live page. GitHub links are not applicable to missions/groups (they are
DB-rendered catalog pages, not GitHub-sourced markdown), so only the two
preview links are wanted.

## Goals

- Add **QA preview** and **live/main** links to both the Missions and Groups
  Object Pages, in the existing **General** FieldGroup.
- Render both links **only when `published === true`**.
- Environment-correct (relative) preview URLs.
- Reuse the proven virtual-field + `after('READ')` + `DataFieldWithUrl`
  pattern; no new table, no client fetch.

## Non-goals

- No GitHub source/Contributions links (not applicable to catalog pages).
- No List Report changes (Object-Page only).
- No changes to the publish/draft workflow or the `published` gate itself.
- No RepoCatalog lookup (missions/groups have no repo mapping).

## Key routing fact

Missions and Groups are **served on the same `/tutorials/*` route as
tutorials**, distinguished by a slug prefix. `srv/lib/content-store.js`
(catalog branch, ~line 900-912) renders `mission-{slug}` and `group-{slug}`
via `renderCatalogPage`. Therefore the preview URLs are:

| Entity | QA link | Main link |
|---|---|---|
| Mission | `/tutorials-qa/mission-{slug}` | `/tutorials/mission-{slug}` |
| Group | `/tutorials-qa/group-{slug}` | `/tutorials/group-{slug}` |

There is no `/missions/*` or `/groups/*` approuter route; the `mission-` /
`group-` prefix on the `/tutorials/*` path is the canonical public URL shape
(the content-store 301-redirect logic at line 900-901 confirms this is the
target it redirects bare slugs to).

## Existing patterns this builds on

- The Tutorials feature's pure helper `srv/lib/tutorial-links.js` +
  `after('READ','Tutorials')` decorator in `srv/admin-service.js` +
  `DataFieldWithUrl` rows in `app/admin-annotations.cds`.
- Missions and Groups projections at `srv/admin-service.cds:92-93` already
  carry `virtual null as publishedFieldControl` — adding more `virtual`
  fields follows the same shape.
- `published : Boolean` exists on both entities (`db/schema.cds` Missions
  line 69, Groups line 83) and is already surfaced in each General
  FieldGroup.

Difference from Tutorials: missions/groups gate on `published` (boolean), not
a `status` ACTIVE enum. Each entity has a **single** `@UI` annotate block
(Missions ~line 102-135, Groups ~line 307-337 in `app/admin-annotations.cds`)
— no last-wins override hazard.

## Design

### Data: pure helper `srv/lib/preview-links.js` (new)

Kept separate from `tutorial-links.js` (which is tutorial-specific with GitHub
logic). Pure, dependency-free:

```js
buildPreviewLinks({ published, slug, kind })
// kind: 'mission' | 'group'
// → { qaPreviewUrl, qaPreviewLabel, mainPreviewUrl, mainPreviewLabel }
```

Behavior:
- Returns all-`undefined` unless `published === true` AND `slug` is truthy AND
  `kind` is `'mission'` or `'group'`.
- Otherwise:
  - `qaPreviewUrl   = /tutorials-qa/{kind}-{slug}`, `qaPreviewLabel = 'View QA Preview'`
  - `mainPreviewUrl = /tutorials/{kind}-{slug}`
  - `mainPreviewLabel = 'View Live Mission'` when kind is mission, `'View Live Group'` when group.

### Data: 4 virtual fields on each projection

In `srv/admin-service.cds`, extend the Missions and Groups projections
(currently one-liners at lines 92-93) to add:

```cds
virtual qaPreviewUrl : String, virtual qaPreviewLabel : String,
virtual mainPreviewUrl : String, virtual mainPreviewLabel : String
```

on **both** `Missions` and `Groups`.

### Population: two after('READ') decorators

In `srv/admin-service.js`, add `this.after('READ', 'Missions', ...)` and
`this.after('READ', 'Groups', ...)` decorators. Each maps its rows through
`buildPreviewLinks` with the appropriate `kind`:

```js
this.after('READ', 'Missions', (rows) => {
  const arr = Array.isArray(rows) ? rows : [rows];
  for (const r of arr) {
    if (!r) continue;
    Object.assign(r, buildPreviewLinks({ published: r.published, slug: r.slug, kind: 'mission' }));
  }
});
```

Groups is identical with `kind: 'group'`. No DB lookup and no throw source, so
no try/catch is required for correctness; a defensive `if (!r) continue` guard
plus the helper's own input validation keeps a malformed row from throwing.

### Rendering: annotations in `app/admin-annotations.cds`

For **both** Missions and Groups:

1. In the entity's existing `annotate AdminService.X with { ... }` field-label
   block, add `@Common.Label` + `@Common.FieldControl: #ReadOnly` for the 4
   new virtual fields.

2. Append two `UI.DataFieldWithUrl` rows to the entity's existing
   `FieldGroup#General` `Data` array:

```cds
{ $Type: 'UI.DataFieldWithUrl', Value: qaPreviewLabel,   Url: qaPreviewUrl,   Label: 'QA Preview' },
{ $Type: 'UI.DataFieldWithUrl', Value: mainPreviewLabel, Url: mainPreviewUrl, Label: 'Live Mission' }
```

(`Label: 'Live Group'` for Groups.) `Value` = the friendly `*Label` field,
`Url` = the `*Url` field. Unpublished rows leave the fields unset → FE renders
empty cells. This is the sole `published` gate (server-side).

## Edge cases & testing

| Case | Expected |
|---|---|
| published mission | both links, `mission-` prefix, 'View Live Mission' |
| published group | both links, `group-` prefix, 'View Live Group' |
| unpublished mission/group | all 4 fields unset (empty cells) |
| missing slug | all 4 fields unset |
| invalid kind | all 4 fields unset (helper guard) |

Tests:
- **Unit** `test/unit/preview-links.test.js`: drive `buildPreviewLinks` over
  every row above for both kinds.
- **Read** `test/unit/admin-mission-group-links-read.test.js`: seed one
  published + one unpublished Mission and Group; assert the published rows
  expose the prefixed QA/main links and the unpublished rows do not. (Follows
  the Tutorials read test that seeds rows directly — no CSV seed exists.)
- **`$metadata` regression** in `test/admin-annotations.test.js`: assert the 4
  virtual fields and the 2 `DataFieldWithUrl` rows appear for both the
  Missions and Groups General FieldGroups.
- Guards: `npx cds deploy --to sqlite::memory:` and `npm test`.

## Deploy considerations

- Admin annotations + admin projections change → full
  `npm run deploy -- --env <env>` (NO `--skip-build`, NO `-m` scoping) so the
  approuter admin bundle + `$metadata` rebuild.
- Bump `applicationVersion` in both manifests to bust the UI5 fragment cache:
  `app/admin/missions/webapp/manifest.json` `0.0.3` → `0.0.4`,
  `app/admin/groups/webapp/manifest.json` `0.0.1` → `0.0.2`.

## Files touched

- `srv/lib/preview-links.js` (new) — pure URL/label builder.
- `srv/admin-service.cds` — 4 virtual fields on each of Missions + Groups.
- `srv/admin-service.js` — two `after('READ')` decorators.
- `app/admin-annotations.cds` — labels + 2 DataFieldWithUrl rows on each of
  Missions + Groups General FieldGroups.
- `app/admin/missions/webapp/manifest.json` + `app/admin/groups/webapp/manifest.json` — applicationVersion bumps.
- Tests: new `preview-links` unit test, new mission/group read test, updated
  admin-annotations `$metadata` assertions.
