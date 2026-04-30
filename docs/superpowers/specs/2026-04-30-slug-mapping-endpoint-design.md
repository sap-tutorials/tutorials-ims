# Slug Mapping Endpoint & getEventProgress URL Fix

**Date:** 2026-04-30
**Status:** Approved
**Scope:** New slug mapping endpoint + data completeness fix for getEventProgress URLs

## Problem

The `getEventProgress` CAP endpoint (consumed by AppSpace.vue) returns empty `url` fields for tutorials whose `slug` column is not populated. Additionally, external consumers (build pipeline, admin UI, frontend components) have no way to look up the mapping between IMS legacy numeric IDs and URL slugs.

## Solution

1. **Shared slug-mapping module** that queries all entities (Tutorials, Missions, CompletionPaths) with populated `legacyId` + `slug` pairs
2. **Dual-exposed endpoint** returning three response formats (flat, grouped, keyed)
3. **Defensive fallback** in `getEventProgress` for partially-migrated data
4. **Admin visibility** for data gaps (CompletionPathItems referencing tutorials without slugs)

## Assumptions

- **`legacyId` is unique within each entity type** (Tutorials, Missions, CompletionPaths). It is NOT guaranteed unique across types — a Tutorial and a Mission may share the same numeric legacyId. The `taskMap` in `getEventProgress` uses composite keys (`TUTORIAL:5001`) to handle this.
- **`@mandatory` on `Tutorials.slug`** enforces non-null only on CDS-layer writes. Rows inserted via direct migration (HANA SQL, CSV import) may have null slugs. The endpoint filters defensively regardless of the constraint.

## Design

### Data Layer (`srv/lib/slug-mapping.js`)

Shared module exporting two functions. Uses `cds.entities('com.sap.developers.ims')` and the CDS global `SELECT` (bound to `cds.db` after startup) — no `db` parameter needed.

#### `buildSlugMapping()`

Queries Tutorials, Missions, and CompletionPaths where both `legacyId` and `slug` are non-null. Returns:

> **Note:** `Groups` entity has no `slug` field. `CompletionPaths` (which represents navigational tracks within missions) does have `slug` and is what the build pipeline uses for URL generation.

```json
{
  "flat": [
    { "legacyId": 5001, "slug": "cp100-1-setup-btp-account", "type": "TUTORIAL", "title": "Set Up Your BTP Account" },
    { "legacyId": 24609, "slug": "developer-advocate-mission", "type": "MISSION", "title": "Developer Advocate Mission" },
    { "legacyId": 1001, "slug": "track-1-basics", "type": "PATH", "title": "Track 1: Basics" }
  ],
  "grouped": {
    "tutorials": [{ "legacyId": 5001, "slug": "cp100-1-setup-btp-account", "title": "Set Up Your BTP Account" }],
    "missions": [{ "legacyId": 24609, "slug": "developer-advocate-mission", "title": "Developer Advocate Mission" }],
    "paths": [{ "legacyId": 1001, "slug": "track-1-basics", "title": "Track 1: Basics" }]
  },
  "keyed": [
    { "compositeKey": "TUTORIAL:5001", "slug": "cp100-1-setup-btp-account", "title": "Set Up Your BTP Account" },
    { "compositeKey": "MISSION:24609", "slug": "developer-advocate-mission", "title": "Developer Advocate Mission" },
    { "compositeKey": "PATH:1001", "slug": "track-1-basics", "title": "Track 1: Basics" }
  ]
}
```

#### `findMissingSlugs()`

Joins `CompletionPathItems` → `CompletionPaths` (via `path_ID`) → `Missions` (via `mission_ID`), then matches each item's `taskLegacyId` against `Tutorials` (where `taskType = 'TUTORIAL'`). Returns items where the referenced tutorial has no slug populated.

- `pathName` comes from `CompletionPaths.name`
- `missionTitle` comes from `Missions.title` (two hops from the item)

Returns:

```json
[
  { "taskLegacyId": 5002, "taskType": "TUTORIAL", "pathName": "Track 1", "missionTitle": "Developer Advocate Mission" }
]
```

### Endpoint: Authenticated CDS Function

Added to `srv/developer-service.cds`:

```cds
function getSlugMapping() returns {
  flat    : many { legacyId : Integer; slug : String; entityType : String; title : String };
  grouped : {
    tutorials : many { legacyId : Integer; slug : String; title : String };
    missions  : many { legacyId : Integer; slug : String; title : String };
    paths     : many { legacyId : Integer; slug : String; title : String };
  };
  keyed   : many { compositeKey : String; slug : String; title : String };
};
```

> **Note:** The `keyed` format uses `compositeKey` (not `key`) because `key` is a CDS reserved word. The field contains values like `"TUTORIAL:5001"`. The `flat` format uses `entityType` (not `type`) to avoid shadowing CDS builtins.

Handler in `srv/developer-service.js`:

```js
this.on('getSlugMapping', async () => {
  const { buildSlugMapping } = await import('./lib/slug-mapping.js');
  return buildSlugMapping();
});
```

Callable as `GET /api/getSlugMapping()`. Requires `DeveloperApp` scope (inherited from service-level `@requires`).

### Endpoint: Unauthenticated Build Route

Registered in `srv/server.js` on `cds.on('bootstrap')`, same pattern as existing `/build/catalog`:

```js
app.get('/build/slug-mapping', async (req, res) => {
  const { buildSlugMapping } = await import('./lib/slug-mapping.js');
  const mapping = await buildSlugMapping();
  res.json(mapping);
});
```

No auth required. The dynamic `import()` ensures `cds.db` is connected before querying (requests only arrive after server startup). This matches the pattern used by existing `/build/catalog` and `/build/navigator` routes.

> **Middleware note:** `srv/server.js` registers `basicAuthMiddleware` globally before build routes. This middleware is passthrough-safe for unauthenticated callers — it calls `next()` when no Basic Auth header is present. No exemption needed.

### getEventProgress Fix

In the `getEventProgress` handler (`srv/developer-service.js` lines 209-283), after building the `taskMap`, add a fallback for tutorials with missing slugs:

```js
// For TUTORIAL items where task exists but task.slug is empty,
// re-query Tutorials by legacyId to pick up recently-populated slugs
const missingSlugIds = allItems
  .filter(i => i.taskType === 'TUTORIAL' && taskMap.has(`TUTORIAL:${i.taskLegacyId}`))
  .filter(i => !taskMap.get(`TUTORIAL:${i.taskLegacyId}`).slug)
  .map(i => i.taskLegacyId);

if (missingSlugIds.length > 0) {
  const freshTutorials = await SELECT.from(dbTutorials)
    .where({ legacyId: { in: missingSlugIds }, slug: { '!=': null } });
  for (const t of freshTutorials) {
    taskMap.set(`TUTORIAL:${t.legacyId}`, t);
  }
}
```

This is defensive — once all slugs are populated via migration, the fallback never triggers.

### Admin Visibility: findMissingSlugs

Added to `srv/admin-service.cds`:

```cds
function findMissingSlugs() returns many {
  taskLegacyId : Integer;
  taskType     : String;
  pathName     : String;
  missionTitle : String;
};
```

Allows operators to identify and fix data gaps.

### AppSpace.vue — No Changes

The Vue component already consumes `getEventProgress` correctly. The response shape is unchanged. Items that previously had `url: ""` will have proper `/tutorials/{slug}.html` URLs once slug data is populated.

## Files Changed

| File | Change |
|------|--------|
| `srv/lib/slug-mapping.js` | **New** — shared `buildSlugMapping()` and `findMissingSlugs()` |
| `srv/developer-service.cds` | Add `getSlugMapping` function definition |
| `srv/developer-service.js` | Add `getSlugMapping` handler + fallback in `getEventProgress` |
| `srv/server.js` | Register `/build/slug-mapping` express route |
| `srv/admin-service.cds` | Add `findMissingSlugs` function definition |
| `srv/admin-service.js` | Add `findMissingSlugs` handler |

## No Schema Changes

- `Tutorials.slug` is already `String(255) @mandatory` (enforces on CDS writes only; migrated rows may still have nulls)
- `Missions.slug` is already `String(255)`
- `CompletionPaths.slug` is already `String(255)`
- `Groups` has NO `slug` field and is excluded from this endpoint
- Slug population is handled by existing migration: `node scripts/migrate-reference-data.js populate-slugs`

## Consumers

| Consumer | Endpoint | Auth |
|----------|----------|------|
| Build pipeline (`scripts/parsers/cap.ts`) | `GET /build/slug-mapping` | None |
| AppSpace.vue / frontend components | `GET /api/getSlugMapping()` | DeveloperApp scope |
| Admin operators | `GET /admin/findMissingSlugs()` | Admin scope |

## Testing

- **Unit test**: Mock Tutorials/Missions/CompletionPaths with legacyId+slug pairs, verify all three response formats (flat, grouped, keyed)
- **Unit test**: Mock CompletionPathItems with missing-slug tutorials, verify `findMissingSlugs` returns them
- **Unit test**: Mock `getEventProgress` with a tutorial in taskMap that has null slug, verify the fallback re-queries and populates the URL
- **Hybrid test**: Call `/build/slug-mapping` against real HANA, verify non-empty response
- **Smoke test**: Call `/build/slug-mapping` on deployed instance, verify 200 + JSON shape
