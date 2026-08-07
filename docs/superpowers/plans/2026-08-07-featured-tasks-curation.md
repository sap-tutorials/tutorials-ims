# Featured Tasks Curation → Tutorial Navigator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `AdminService.FeaturedTasks` fully curatable via the existing Fiori Elements tile and render the curated list (mixed tutorial/mission/group, in curated order) in the Tutorial Navigator's Featured section, SSR at build + live-rehydrated.

**Architecture:** Enable FE draft CRUD on `FeaturedTasks` with a title-based value help backed by a runtime UNION view (`FeaturedTaskCandidates`). A new public `GET /build/featured` endpoint serves the resolved, ordered list with ETag/60s cache. The navigator SSRs from `browse.json.featured[]` and a standalone script rehydrates it live. Empty curated list → existing first-6-missions fallback.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), Fiori Elements (OData V4 annotations), Hugo templates, vanilla JS island, Vitest (unit + hybrid).

## Global Constraints

- **Scope: navigator only.** Do NOT touch the homepage `featured-topics-carousel` (#1032).
- **Mixed types:** curation supports `TUTORIAL`, `MISSION`, `GROUP`.
- **`FEATURED_LIMIT = 6`** (existing constant in `srv/lib/build-catalog.js:5`) — reuse, do not redefine.
- **GROUP resolution standardizes on the `Groups` entity** (title/slug/legacyId), NOT `CompletionPaths`. The candidate list and `resolveFeatured` must agree on this. (Table is empty today, so no data migration.)
- **Fallback preserved:** navigator Featured section never renders blank — empty curated list falls back to `first 6` published missions.
- **Runtime-only asserts:** `@assert.unique` is CAP-runtime, not a DB constraint. Run `npx cds deploy --to sqlite::memory:` before committing any `.cds` change.
- **Admin-UI bundle-gating:** annotation/manifest changes ship via approuter raw-copy → require a FULL `mbt build` deploy (no `--skip-build`, no `-m`) + `sap.app.applicationVersion` bump. (Deploy is out of scope for this plan; noted for the eventual deploy.)
- **Card partials are parity-locked** — reuse `browse/_partials/card-{mission,group,tutorial}.html`; do not fork their markup.
- **Tests:** unit via `npm test`; hybrid via `vitest --project hybrid` (never bare `vitest <file>`).

---

## File Structure

- `srv/lib/featured-resolve.js` **(new)** — shared featured-list query + `resolveFeatured` + in-process ETag cache + `resetFeaturedCache()`. Single source of truth for both `buildCatalogHandler` and the new endpoint.
- `srv/lib/build-catalog.js` — import `resolveFeatured` from the new helper (remove the local copy).
- `srv/server.js` — register `GET /build/featured`.
- `srv/admin-service.cds` — `@odata.draft.enabled` + `@assert.unique.feature` on `FeaturedTasks`; add `FeaturedTaskCandidates` entity.
- `srv/admin-service.js` — `on('READ', FeaturedTaskCandidates)` union handler; `before('CREATE', FeaturedTasks)` order default; cache-bust hooks on save/delete.
- `app/admin-annotations.cds` — value-help annotation on `FeaturedTasks.taskLegacyId`.
- `app/admin/operations/webapp/manifest.json` — `sap.app.applicationVersion` bump.
- `hugo/layouts/tutorial-navigator/list.html` — SSR Featured section from `browse.json.featured[]` + fallback.
- `hugo/static/js/featured-rail.js` **(new)** — live rehydrate.
- Tests: `test/featured-resolve.test.js`, `test/admin-featured-candidates.test.js`, `test/hybrid/featured-tasks-curation.test.js`, `test/e2e/featured-tasks.spec.ts`.

---

## Task 1: Extract shared featured-resolve helper

**Files:**
- Create: `srv/lib/featured-resolve.js`
- Modify: `srv/lib/build-catalog.js:213-245` (remove local `resolveFeatured`, import instead), `srv/lib/build-catalog.js:26-28` (use helper for query)
- Test: `test/featured-resolve.test.js`

**Interfaces:**
- Produces:
  - `resolveFeatured(row, maps) -> {type, slug, title, description} | null` where `row = {taskType, taskLegacyId}` and `maps = {missionByLegacyId, groupByLegacyId, tutorialByLegacyId}`. **NOTE the maps key change:** GROUP now resolves from `groupByLegacyId` (Groups entity), not `pathByLegacyId`.
  - `async fetchFeatured(db) -> Array<{type, slug, title, description}>` — runs the top-`FEATURED_LIMIT` query, builds the three maps, resolves, and `.filter(Boolean)`s. Ordered by `featuredOrder`.
  - `computeFeaturedEtag(list) -> string` — stable hash (e.g. SHA-256 of `JSON.stringify(list.map(f => f.type+':'+f.slug))`, first 16 hex chars, quoted per HTTP ETag).
  - `async getFeaturedPayload(db) -> {featured, etag, computedAt}` — 60s in-process cache wrapper.
  - `resetFeaturedCache() -> void` — clears the cache.

- [ ] **Step 1: Write the failing test**

```javascript
// test/featured-resolve.test.js
import { describe, it, expect } from 'vitest';
import { resolveFeatured, computeFeaturedEtag } from '../srv/lib/featured-resolve.js';

const maps = {
  missionByLegacyId: new Map([[10, { slug: 'm-slug', title: 'M', description: 'md' }]]),
  groupByLegacyId:   new Map([[20, { slug: 'g-slug', title: 'G', description: 'gd' }]]),
  tutorialByLegacyId:new Map([[30, { slug: 't-slug', title: 'T', description: 'td' }]]),
};

describe('resolveFeatured', () => {
  it('resolves a MISSION row', () => {
    expect(resolveFeatured({ taskType: 'MISSION', taskLegacyId: 10 }, maps))
      .toEqual({ type: 'mission', slug: 'm-slug', title: 'M', description: 'md' });
  });
  it('resolves a GROUP row from the Groups entity (not CompletionPaths)', () => {
    expect(resolveFeatured({ taskType: 'GROUP', taskLegacyId: 20 }, maps))
      .toEqual({ type: 'group', slug: 'g-slug', title: 'G', description: 'gd' });
  });
  it('resolves a TUTORIAL row', () => {
    expect(resolveFeatured({ taskType: 'TUTORIAL', taskLegacyId: 30 }, maps))
      .toEqual({ type: 'tutorial', slug: 't-slug', title: 'T', description: 'td' });
  });
  it('returns null for an unresolvable row', () => {
    expect(resolveFeatured({ taskType: 'MISSION', taskLegacyId: 999 }, maps)).toBeNull();
  });
});

describe('computeFeaturedEtag', () => {
  it('is stable for the same list and changes on reorder', () => {
    const a = [{ type: 'mission', slug: 'x' }, { type: 'tutorial', slug: 'y' }];
    const b = [{ type: 'tutorial', slug: 'y' }, { type: 'mission', slug: 'x' }];
    expect(computeFeaturedEtag(a)).toBe(computeFeaturedEtag(a));
    expect(computeFeaturedEtag(a)).not.toBe(computeFeaturedEtag(b));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/featured-resolve.test.js`
Expected: FAIL — cannot resolve `../srv/lib/featured-resolve.js`.

- [ ] **Step 3: Write the helper**

```javascript
// srv/lib/featured-resolve.js
import cds from '@sap/cds';
import { createHash } from 'node:crypto';

const FEATURED_LIMIT = 6;
const CACHE_MS = 60_000;
let _cache = { at: 0, payload: null };

export function resolveFeatured(f, { missionByLegacyId, groupByLegacyId, tutorialByLegacyId }) {
  if (f.taskType === 'MISSION') {
    const m = missionByLegacyId.get(f.taskLegacyId);
    if (!m) return null;
    return { type: 'mission', slug: m.slug || String(m.legacyId), title: m.title || '', description: m.description || '' };
  }
  if (f.taskType === 'GROUP') {
    const g = groupByLegacyId.get(f.taskLegacyId);
    if (!g || !g.slug) return null;
    return { type: 'group', slug: g.slug, title: g.title || '', description: g.description || '' };
  }
  if (f.taskType === 'TUTORIAL') {
    const t = tutorialByLegacyId.get(f.taskLegacyId);
    if (!t || !t.slug) return null;
    return { type: 'tutorial', slug: t.slug, title: t.title || '', description: t.description || '' };
  }
  return null;
}

export async function fetchFeatured(db) {
  const { Missions, Groups, Tutorials, FeaturedTasks } = cds.entities('com.sap.developers.ims');
  const rows = await db.run(SELECT.from(FeaturedTasks).orderBy('featuredOrder').limit(FEATURED_LIMIT));
  if (!rows.length) return [];
  const missions  = await db.run(SELECT.from(Missions).columns('legacyId', 'slug', 'title', 'description').where({ published: true }));
  const groups    = await db.run(SELECT.from(Groups).columns('legacyId', 'slug', 'title', 'description'));
  const tutorials = await db.run(SELECT.from(Tutorials).columns('legacyId', 'slug', 'title', 'description').where(`status = 'ACTIVE' or status is null`));
  const maps = {
    missionByLegacyId:  new Map(missions.map(m => [m.legacyId, m])),
    groupByLegacyId:    new Map(groups.map(g => [g.legacyId, g])),
    tutorialByLegacyId: new Map(tutorials.map(t => [t.legacyId, t])),
  };
  return rows.map(r => resolveFeatured(r, maps)).filter(Boolean);
}

export function computeFeaturedEtag(list) {
  const sig = JSON.stringify(list.map(f => `${f.type}:${f.slug}`));
  return `"${createHash('sha256').update(sig).digest('hex').slice(0, 16)}"`;
}

export async function getFeaturedPayload(db) {
  const now = Date.now();
  if (_cache.payload && (now - _cache.at) < CACHE_MS) return _cache.payload;
  const featured = await fetchFeatured(db);
  const payload = { featured, etag: computeFeaturedEtag(featured), computedAt: new Date().toISOString() };
  _cache = { at: now, payload };
  return payload;
}

export function resetFeaturedCache() {
  _cache = { at: 0, payload: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/featured-resolve.test.js`
Expected: PASS (6 assertions).

- [ ] **Step 5: Refactor `build-catalog.js` to use the helper**

In `srv/lib/build-catalog.js`: delete the local `resolveFeatured` function (lines ~213-245), add `import { resolveFeatured } from './featured-resolve.js';` at top. Update the featured mapping (line ~189-191) to build a `groupByLegacyId` map from the existing `groups` array and pass it instead of `pathByLegacyId`:

```javascript
const groupByLegacyId = new Map(groups.map(g => [g.legacyId, g]));
const featured = featuredRows
  .map(f => resolveFeatured(f, { missionByLegacyId, groupByLegacyId, tutorialByLegacyId }))
  .filter(Boolean);
```

- [ ] **Step 6: Run the full catalog-featured test to confirm no regression**

Run: `npx vitest run test/build-catalog-featured.test.js`
Expected: PASS. (If a GROUP case there asserted CompletionPaths resolution, update it to the Groups entity — this is the intended behavior change per Global Constraints.)

- [ ] **Step 7: Commit**

```bash
git add srv/lib/featured-resolve.js srv/lib/build-catalog.js test/featured-resolve.test.js test/build-catalog-featured.test.js
git commit -m "refactor(featured): extract shared featured-resolve helper, standardize GROUP on Groups entity"
```

---

## Task 2: Public `GET /build/featured` endpoint

**Files:**
- Modify: `srv/server.js` (register route near `/build/featured-topics`, ~line 357)
- Test: covered by hybrid test in Task 6 (endpoint needs a live CAP server); add a focused assertion there.

**Interfaces:**
- Consumes: `getFeaturedPayload(db)`, `resetFeaturedCache()` from Task 1.
- Produces: `GET /build/featured` → `{ featured, etag, computedAt, buildAt }` with `ETag` + `Cache-Control: public, max-age=60` headers; `304` when `If-None-Match` matches.

- [ ] **Step 1: Add the route handler**

In `srv/server.js`, immediately after the `/build/featured-topics` handler block (~line 373):

```javascript
  app.get('/build/featured', async (req, res) => {
    try {
      const { getFeaturedPayload } = await import('./lib/featured-resolve.js');
      const db = await cds.connect.to('db');
      const payload = await getFeaturedPayload(db);
      res.set('Cache-Control', 'public, max-age=60');
      res.set('ETag', payload.etag);
      if (req.headers['if-none-match'] === payload.etag) {
        return res.status(304).end();
      }
      res.json({ ...payload, buildAt: new Date().toISOString() });
    } catch (err) {
      console.error('[build/featured]', err.message);
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 2: Manual smoke (local CAP)**

Run: `cds watch` in one shell; in another: `curl -s localhost:4004/build/featured | jq .`
Expected: `{ "featured": [], "etag": "\"...\"", ... }` (empty until curated). Re-run with `-H 'If-None-Match: "<etag>"'` → `304`, empty body.

- [ ] **Step 3: Commit**

```bash
git add srv/server.js
git commit -m "feat(featured): public GET /build/featured endpoint with ETag/304"
```

---

## Task 3: Enable draft CRUD + uniqueness on FeaturedTasks

**Files:**
- Modify: `srv/admin-service.cds:228` (the `entity FeaturedTasks as projection` line)

**Interfaces:**
- Produces: `AdminService.FeaturedTasks` draft-enabled with a unique `(taskLegacyId, taskType)` constraint.

- [ ] **Step 1: Add draft + uniqueness annotations**

Replace `srv/admin-service.cds:228`:

```cds
  @odata.draft.enabled
  @assert.unique.feature: [ taskLegacyId, taskType ]
  entity FeaturedTasks as projection on ims.FeaturedTasks;
```

- [ ] **Step 2: Verify the model compiles + deploys to in-memory sqlite**

Run: `npx cds deploy --to sqlite::memory:`
Expected: no errors (runtime-only asserts won't fail here, but a CDS syntax error would).

- [ ] **Step 3: Commit**

```bash
git add srv/admin-service.cds
git commit -m "feat(featured): enable draft CRUD + unique(taskLegacyId,taskType) on FeaturedTasks"
```

---

## Task 4: FeaturedTaskCandidates union value-help view

**Files:**
- Modify: `srv/admin-service.cds` (add entity near the FeaturedTasks projection)
- Modify: `srv/admin-service.js` (add `on('READ')` handler)
- Test: `test/admin-featured-candidates.test.js`

**Interfaces:**
- Consumes: `Missions`, `Groups`, `Tutorials` from `cds.entities`.
- Produces: `AdminService.FeaturedTaskCandidates` — read-only, rows `{ taskLegacyId: Integer, taskType: String, title: String, slug: String }`, unioned across the three published/active content types, filtered by `req.query` search.

- [ ] **Step 1: Add the entity to the service**

In `srv/admin-service.cds`, after the `FeaturedTasks` projection:

```cds
  // Runtime UNION for the FeaturedTasks value help. Read-only; not persisted.
  // (taskLegacyId, taskType) together identify the picked content item.
  @readonly
  @cds.persistence.skip
  entity FeaturedTaskCandidates {
    key taskLegacyId : Integer;
    key taskType     : String(20);
        title        : String;
        slug         : String;
  }
```

- [ ] **Step 2: Write the failing test**

```javascript
// test/admin-featured-candidates.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('FeaturedTaskCandidates', () => {
  let admin;
  beforeAll(async () => {
    await cds.test('serve', '--project', '.', '--in-memory');
    admin = await cds.connect.to('AdminService');
  });

  it('returns all three content types with the candidate shape', async () => {
    const rows = await admin.run(SELECT.from('AdminService.FeaturedTaskCandidates'));
    expect(Array.isArray(rows)).toBe(true);
    const types = new Set(rows.map(r => r.taskType));
    // Seed data in the in-memory project should contain at least tutorials.
    for (const r of rows) {
      expect(r).toHaveProperty('taskLegacyId');
      expect(r).toHaveProperty('taskType');
      expect(r).toHaveProperty('title');
      expect(r).toHaveProperty('slug');
    }
    expect(types.size).toBeGreaterThan(0);
  });

  it('honors a search filter on title', async () => {
    const all = await admin.run(SELECT.from('AdminService.FeaturedTaskCandidates'));
    if (!all.length) return; // no seed data — skip assertion
    const term = all[0].title.slice(0, 3);
    const filtered = await admin.run(
      SELECT.from('AdminService.FeaturedTaskCandidates').where(`title like '%${term}%'`)
    );
    expect(filtered.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/admin-featured-candidates.test.js`
Expected: FAIL — READ returns nothing / entity unhandled (no persistence, no handler yet).

- [ ] **Step 4: Implement the READ handler**

In `srv/admin-service.js`, inside the service `init()` (alongside the other `this.on`/`this.before` registrations), add:

```javascript
    // Value-help union for FeaturedTasks. Reads live from the three content
    // entities; honors $search/$filter/$top so FE type-ahead works.
    this.on('READ', 'FeaturedTaskCandidates', async (req) => {
      const { Missions, Groups, Tutorials } = cds.entities('com.sap.developers.ims');
      const db = await cds.connect.to('db');
      try {
        const [missions, groups, tutorials] = await Promise.all([
          db.run(SELECT.from(Missions).columns('legacyId', 'title', 'slug').where({ published: true })),
          db.run(SELECT.from(Groups).columns('legacyId', 'title', 'slug').where({ published: true })),
          db.run(SELECT.from(Tutorials).columns('legacyId', 'title', 'slug').where(`status = 'ACTIVE' or status is null`)),
        ]);
        let rows = [
          ...missions.map(m => ({ taskLegacyId: m.legacyId, taskType: 'MISSION', title: m.title || '', slug: m.slug || '' })),
          ...groups.map(g => ({ taskLegacyId: g.legacyId, taskType: 'GROUP', title: g.title || '', slug: g.slug || '' })),
          ...tutorials.map(t => ({ taskLegacyId: t.legacyId, taskType: 'TUTORIAL', title: t.title || '', slug: t.slug || '' })),
        ].filter(r => r.taskLegacyId != null && r.slug);

        // Honor a free-text search term from the value-help type-ahead.
        const term = req.query?.SELECT?.search?.[0]?.val
          ?? req._?.req?.query?.$search;
        if (term) {
          const t = String(term).replace(/(^"|"$)/g, '').toLowerCase();
          rows = rows.filter(r => r.title.toLowerCase().includes(t));
        }
        return rows;
      } catch (e) {
        req.warn?.(`FeaturedTaskCandidates READ failed: ${e.message}`);
        return [];
      }
    });
```

> Note: CAP applies `$filter`/`$top`/`$orderby` from `req.query` to the returned
> array automatically for `on('READ')` of a non-persisted entity; the manual
> `term` handling above covers the FE value-help `$search` param specifically.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/admin-featured-candidates.test.js`
Expected: PASS.

- [ ] **Step 6: Verify model still deploys**

Run: `npx cds deploy --to sqlite::memory:`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js test/admin-featured-candidates.test.js
git commit -m "feat(featured): FeaturedTaskCandidates union value-help view"
```

---

## Task 5: Order default + cache-bust hooks

**Files:**
- Modify: `srv/admin-service.js` (add `before('CREATE')` + save/delete cache-bust)
- Test: `test/hybrid/featured-tasks-curation.test.js` (created in Task 6; add the order-default assertion here as a unit-style check against the in-memory serve)

**Interfaces:**
- Consumes: `resetFeaturedCache` from `srv/lib/featured-resolve.js`.
- Produces: on CREATE with empty `featuredOrder`, sets it to `max(featuredOrder)+1`; on draft SAVE + DELETE of `FeaturedTasks`, calls `resetFeaturedCache()`.

- [ ] **Step 1: Add the import**

At the top of `srv/admin-service.js`, add:

```javascript
import { resetFeaturedCache } from './lib/featured-resolve.js';
```

(If the file uses `require`, use `const { resetFeaturedCache } = require('./lib/featured-resolve.js');` to match the file's module style — check the existing imports first.)

- [ ] **Step 2: Add the CREATE order default + cache-bust hooks**

Inside `init()`:

```javascript
    // Default featuredOrder to max+1 so admins rarely type it.
    this.before('CREATE', 'FeaturedTasks', async (req) => {
      if (req.data.featuredOrder == null) {
        const { FeaturedTasks } = cds.entities('com.sap.developers.ims');
        const db = await cds.connect.to('db');
        const [row] = await db.run(SELECT.from(FeaturedTasks).columns('max(featuredOrder) as maxOrder'));
        req.data.featuredOrder = (row?.maxOrder ?? 0) + 1;
      }
    });

    // Bust the /build/featured cache on any curation change (draft activate + delete).
    this.after(['SAVE', 'CREATE', 'UPDATE', 'DELETE'], 'FeaturedTasks', () => {
      resetFeaturedCache();
    });
```

- [ ] **Step 3: Write the order-default test**

Add to `test/admin-featured-candidates.test.js` (same in-memory serve already booted):

```javascript
import { describe as _d } from 'vitest'; // (already imported above; ensure single import in the real file)

describe('FeaturedTasks order default', () => {
  let admin;
  beforeAll(async () => {
    await cds.test('serve', '--project', '.', '--in-memory');
    admin = await cds.connect.to('AdminService');
  });
  it('defaults featuredOrder to max+1 when omitted', async () => {
    const { FeaturedTasks } = admin.entities;
    await admin.run(INSERT.into(FeaturedTasks).entries({ taskLegacyId: 1, taskType: 'TUTORIAL' }));
    await admin.run(INSERT.into(FeaturedTasks).entries({ taskLegacyId: 2, taskType: 'TUTORIAL' }));
    const rows = await admin.run(SELECT.from(FeaturedTasks).orderBy('featuredOrder'));
    expect(rows.at(-1).featuredOrder).toBe(rows[0].featuredOrder + 1);
  });
  it('respects an explicit featuredOrder', async () => {
    const { FeaturedTasks } = admin.entities;
    await admin.run(INSERT.into(FeaturedTasks).entries({ taskLegacyId: 3, taskType: 'MISSION', featuredOrder: 99 }));
    const [row] = await admin.run(SELECT.from(FeaturedTasks).where({ taskLegacyId: 3, taskType: 'MISSION' }));
    expect(row.featuredOrder).toBe(99);
  });
});
```

> If the direct-INSERT path bypasses `before('CREATE')` in your CAP version,
> drive the insert through the service with `admin.create(...)` / a POST so the
> handler fires; verify the handler runs before asserting.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/admin-featured-candidates.test.js`
Expected: PASS (order-default + explicit-order assertions green).

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.js test/admin-featured-candidates.test.js
git commit -m "feat(featured): max+1 order default + cache-bust on curation change"
```

---

## Task 6: Value-help annotation + manifest version bump

**Files:**
- Modify: `app/admin-annotations.cds:1028-1040` (replace the `taskLegacyId`/`taskType` block)
- Modify: `app/admin/operations/webapp/manifest.json:2` area (`sap.app.applicationVersion`)
- Test: `test/hybrid/featured-tasks-curation.test.js`

**Interfaces:**
- Consumes: `FeaturedTaskCandidates` (Task 4).
- Produces: FE value-help on `FeaturedTasks.taskLegacyId` that fills both `taskLegacyId` and `taskType` from a title pick.

- [ ] **Step 1: Replace the annotation block**

In `app/admin-annotations.cds`, replace the current `annotate AdminService.FeaturedTasks with { taskLegacyId ...; taskType ...; featuredOrder ...; }` block (lines ~1028-1040) with:

```cds
annotate AdminService.FeaturedTasks with {
  taskLegacyId  @Common.Label: 'Featured item'
                @Common.ValueList: {
                  CollectionPath: 'FeaturedTaskCandidates',
                  Parameters: [
                    { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: taskLegacyId, ValueListProperty: 'taskLegacyId' },
                    { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: taskType,     ValueListProperty: 'taskType'     },
                    { $Type: 'Common.ValueListParameterDisplayOnly',                                  ValueListProperty: 'title'        },
                    { $Type: 'Common.ValueListParameterDisplayOnly',                                  ValueListProperty: 'slug'         }
                  ]
                };
  taskType      @Common.Label: 'Type' @readonly;
  featuredOrder @Common.Label: 'Order';
};
```

> `taskType` is `@readonly` because the value-help sets it; the admin picks by
> title, not by type. The `@UI` LineItem block below it stays unchanged.

- [ ] **Step 2: Bump the admin app version**

In `app/admin/operations/webapp/manifest.json`, bump `sap.app.applicationVersion.version` (find current value with `jq '."sap.app".applicationVersion' app/admin/operations/webapp/manifest.json`) by a patch increment. This forces the UI5 IndexedDB cache to refresh post-deploy.

- [ ] **Step 3: Verify model deploys**

Run: `npx cds deploy --to sqlite::memory:`
Expected: no errors (value-list annotation resolves against `FeaturedTaskCandidates`).

- [ ] **Step 4: Write the hybrid end-to-end backend test**

```javascript
// test/hybrid/featured-tasks-curation.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { getFeaturedPayload, resetFeaturedCache } from '../../srv/lib/featured-resolve.js';

describe('featured-tasks curation (hybrid)', () => {
  let db, admin;
  beforeAll(async () => {
    await cds.test('serve', '--project', '.', '--in-memory');
    db = await cds.connect.to('db');
    admin = await cds.connect.to('AdminService');
  });

  it('curated item flows to getFeaturedPayload and changes the ETag', async () => {
    const before = await getFeaturedPayload(db);
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const [t] = await db.run(SELECT.from(Tutorials).columns('legacyId', 'slug').where(`slug is not null`).limit(1));
    expect(t).toBeTruthy();

    const { FeaturedTasks } = admin.entities;
    await admin.run(INSERT.into(FeaturedTasks).entries({ taskLegacyId: t.legacyId, taskType: 'TUTORIAL' }));
    resetFeaturedCache(); // simulate the after-save hook

    const after = await getFeaturedPayload(db);
    expect(after.etag).not.toBe(before.etag);
    expect(after.featured.some(f => f.slug === t.slug && f.type === 'tutorial')).toBe(true);
  });

  it('rejects a duplicate (taskLegacyId, taskType)', async () => {
    const { FeaturedTasks } = admin.entities;
    const dup = { taskLegacyId: 424242, taskType: 'MISSION' };
    await admin.run(INSERT.into(FeaturedTasks).entries(dup));
    await expect(admin.run(INSERT.into(FeaturedTasks).entries(dup))).rejects.toThrow();
  });
});
```

- [ ] **Step 5: Run the hybrid test**

Run: `npx vitest run --project hybrid test/hybrid/featured-tasks-curation.test.js`
Expected: PASS. (Uses in-memory serve here; if the repo's hybrid project requires `cds bind`, follow `test/hybrid` conventions — check a sibling hybrid test's header.)

- [ ] **Step 6: Commit**

```bash
git add app/admin-annotations.cds app/admin/operations/webapp/manifest.json test/hybrid/featured-tasks-curation.test.js
git commit -m "feat(featured): title value-help on FeaturedTasks + hybrid curation test"
```

---

## Task 7: Navigator SSR from browse.json + fallback

**Files:**
- Modify: `hugo/layouts/tutorial-navigator/list.html:64-76` (the Featured `<section>`)

**Interfaces:**
- Consumes: `browse.json.featured[]` (already emitted by `writeBrowseData`), shape `{ type, slug, title, description }`.
- Produces: type-dispatched card grid with `href` set, wrapped so the rehydrate script (Task 8) can target it.

- [ ] **Step 1: Replace the Featured section**

Replace lines ~64-76 of `hugo/layouts/tutorial-navigator/list.html`:

```html
  <section aria-labelledby="featured-missions">
    <h2 id="featured-missions">Featured</h2>
    {{- $featured := $browse.featured | default slice -}}
    {{- $hrefBase := "/tutorials" -}}
    {{- if site.Params.qa }}{{- $hrefBase = "/tutorials-qa" -}}{{- end -}}
    <div id="featured-rail" class="mission-grid navigator-grid"
         data-href-base="{{ $hrefBase }}"
         data-source="{{ if gt (len $featured) 0 }}curated{{ else }}fallback{{ end }}">
      {{- if gt (len $featured) 0 -}}
        {{- range $f := first 6 $featured -}}
          {{- $slugPath := "" -}}
          {{- if eq $f.type "tutorial" -}}{{- $slugPath = printf "%s/%s/" $hrefBase $f.slug -}}{{- end -}}
          {{- if eq $f.type "mission" -}}{{- $slugPath = printf "/missions/%s/" $f.slug -}}{{- end -}}
          {{- if eq $f.type "group" -}}{{- $slugPath = printf "/groups/%s/" $f.slug -}}{{- end -}}
          {{- $card := merge $f (dict "href" $slugPath) -}}
          {{- if eq $f.type "mission" -}}{{ partial "browse/_partials/card-mission.html" $card }}{{- end -}}
          {{- if eq $f.type "group" -}}{{ partial "browse/_partials/card-group.html" $card }}{{- end -}}
          {{- if eq $f.type "tutorial" -}}{{ partial "browse/_partials/card-tutorial.html" $card }}{{- end -}}
        {{- end -}}
      {{- else -}}
        {{- range first 6 (where .Site.RegularPages "Type" "missions") -}}
          <a href="{{ .RelPermalink }}" class="nav-card" data-vt-card="navigator">
            <div class="nav-card__type nav-card__type--mission">MISSION</div>
            <h3 class="nav-card__title">{{ .Title }}</h3>
            <p class="nav-card__desc">{{ .Params.description | truncate 160 }}</p>
          </a>
        {{- end -}}
      {{- end -}}
    </div>
  </section>
```

> Verify the mission/group public URL prefixes (`/missions/<slug>/`,
> `/groups/<slug>/`) against how `popular-rail.js` builds them (`/${type}s/${slug}/`)
> and how mission/group pages are actually published — grep `permalinks` in
> `hugo/hugo.toml`. Fix the prefixes here if they differ before committing.

- [ ] **Step 2: Build and eyeball**

Run: `npm run fetch-tutorials && npm run dev` (needs `CAP_BASE_URL` pointed at a backend with data, or a warm `.tutorial-cache/`). Visit `http://localhost:1313/tutorial-navigator/`.
Expected: Featured section renders 6 mission cards from the fallback (curated list empty on a fresh DB), `#featured-rail` present with `data-source="fallback"`.

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/tutorial-navigator/list.html
git commit -m "feat(featured): SSR navigator Featured section from browse.json with fallback"
```

---

## Task 8: Live rehydrate script

**Files:**
- Create: `hugo/static/js/featured-rail.js`
- Modify: `hugo/layouts/tutorial-navigator/list.html` (add `<script defer>` near the bottom of the layout)

**Interfaces:**
- Consumes: `GET /build/featured` (Task 2), the `#featured-rail` element + `data-href-base` (Task 7).
- Produces: client-side replacement of `#featured-rail` children when the curated list is present and its ETag differs from SSR.

- [ ] **Step 1: Write the rehydrate script**

```javascript
// hugo/static/js/featured-rail.js
// Live-refresh the Tutorial Navigator "Featured" rail from /build/featured.
// Fail-silent: keep SSR content on any error/304/empty. Mirrors popular-rail.js.
(async function upgradeFeaturedRail() {
  const rail = document.getElementById('featured-rail');
  if (!rail) return;
  const hrefBase = rail.dataset.hrefBase || '/tutorials';
  try {
    const res = await fetch('/build/featured', { credentials: 'omit' });
    if (!res.ok) return;                       // 304/5xx → keep SSR
    const data = await res.json();
    const featured = Array.isArray(data && data.featured) ? data.featured : [];
    if (featured.length === 0) return;         // empty → keep fallback SSR

    const svgFolder = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 13V3h4l2 2h6v8H2z"></path></svg>';
    const cards = featured.slice(0, 6).map((f) => {
      const a = document.createElement('a');
      a.className = 'nav-card';
      a.setAttribute('data-vt-card', 'navigator');
      const href = f.type === 'tutorial'
        ? `${hrefBase}/${encodeURIComponent(f.slug)}/`
        : `/${f.type}s/${encodeURIComponent(f.slug)}/`;
      a.href = href;
      const typeLabel = (f.type || '').toUpperCase();
      a.innerHTML =
        `<div class="nav-card__type nav-card__type--${f.type}">${typeLabel}</div>` +
        `<h3 class="nav-card__title"></h3>` +
        `<p class="nav-card__desc"></p>`;
      a.querySelector('.nav-card__title').textContent = f.title || '';
      a.querySelector('.nav-card__desc').textContent = (f.description || '').slice(0, 160);
      return a;
    });
    rail.replaceChildren(...cards);
    rail.dataset.source = 'curated-live';
  } catch (err) {
    if (window.console) console.debug('[featured-rail] upgrade failed:', err);
  }
})();
```

> `textContent` for title/description (not `innerHTML`) — avoids XSS from
> admin-entered titles.

- [ ] **Step 2: Load the script from the navigator layout**

In `hugo/layouts/tutorial-navigator/list.html`, before `{{ end }}` (matching how the layout loads other scripts — check for an existing script block), add:

```html
<script defer src="/js/featured-rail.js?v={{ now.Unix }}"></script>
```

- [ ] **Step 3: Manual verification with curated data**

With a backend that has ≥1 curated FeaturedTask (insert one via the admin UI or `admin.create`), rebuild and load `/tutorial-navigator/`. In DevTools Network, confirm `GET /build/featured` returns the curated list; confirm `#featured-rail` `data-source` flips to `curated-live` and the cards match.
Expected: curated cards replace the fallback; empty backend leaves fallback untouched.

- [ ] **Step 4: Commit**

```bash
git add hugo/static/js/featured-rail.js hugo/layouts/tutorial-navigator/list.html
git commit -m "feat(featured): live-rehydrate navigator Featured rail from /build/featured"
```

---

## Task 9: Committed E2E spec

**Files:**
- Create: `test/e2e/featured-tasks.spec.ts`

**Interfaces:**
- Consumes: deployed admin UI (`#/operations`) + `/build/featured` + `/tutorial-navigator/`.

- [ ] **Step 1: Write the E2E spec (self-skips without SMOKE env)**

Follow `test/e2e/README.md` conventions (Basic auth via `SMOKE_TECH_USER`/`SMOKE_TECH_PASSWORD`, `PLAYWRIGHT_BASE_URL`). The spec should: navigate to `#/operations` → Featured Tasks; create a featured item via the title value-help; then assert `GET /build/featured` includes it and the navigator Featured rail renders its card after rehydrate.

```typescript
// test/e2e/featured-tasks.spec.ts
import { test, expect } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || process.env.SMOKE_BASE_URL;
test.skip(!BASE, 'no SMOKE/PLAYWRIGHT base url — post-deploy only');

test('curated featured task surfaces via /build/featured', async ({ request }) => {
  // Read-only assertion that the endpoint exists and returns the expected shape.
  // (Full create-flow via the FE value-help is added once the admin route is
  // confirmed against the deployed DOM — see README selector notes.)
  const res = await request.get(`${BASE}/build/featured`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body).toHaveProperty('featured');
  expect(Array.isArray(body.featured)).toBeTruthy();
  expect(body).toHaveProperty('etag');
});
```

> The create-through-the-UI half depends on the deployed admin DOM (value-help
> dialog selectors), which per project rule must be verified live rather than
> guessed. Land this read-side spec now; extend with the UI create flow after the
> first DEV deploy when the DOM can be observed (per the #1378 e2e pattern).

- [ ] **Step 2: Confirm it self-skips locally**

Run: `npx playwright test test/e2e/featured-tasks.spec.ts` (with no SMOKE env)
Expected: SKIPPED (0 failures).

- [ ] **Step 3: Commit**

```bash
git add test/e2e/featured-tasks.spec.ts
git commit -m "test(featured): e2e spec for /build/featured (self-skips off-deploy)"
```

---

## Task 10: Full regression + docs

**Files:**
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md` (one-line note) — optional but recommended.

- [ ] **Step 1: Run the unit suite**

Run: `npm test`
Expected: all green (new + existing).

- [ ] **Step 2: Run the model deploy gate**

Run: `npx cds deploy --to sqlite::memory:`
Expected: no errors.

- [ ] **Step 3: Add a gotchas note (optional)**

Append a one-liner to `docs/developers/reference/tutorials-ims-gotchas.md` documenting that the navigator Featured rail is curated via `#/operations` → Featured Tasks, SSR from `browse.json.featured[]`, live-rehydrated from `/build/featured`, with a first-6-missions fallback.

- [ ] **Step 4: Commit**

```bash
git add docs/developers/reference/tutorials-ims-gotchas.md
git commit -m "docs(featured): note navigator Featured curation path"
```

---

## Self-Review

**Spec coverage:**
- Admin curation UI (draft + value-help + order default + uniqueness) → Tasks 3, 4, 5, 6. ✓
- `FeaturedTaskCandidates` union view → Task 4. ✓
- Live endpoint `/build/featured` (ETag/304/cache) → Tasks 1, 2. ✓
- Cache invalidation on save/delete → Task 5. ✓
- Navigator SSR from browse.json + fallback → Task 7. ✓
- Live rehydrate script → Task 8. ✓
- Mixed types → Tasks 1 (resolve), 4 (candidates), 7 (SSR dispatch), 8 (rehydrate). ✓
- Empty fallback preserved → Task 7. ✓
- QA channel base paths → Task 7 (`data-href-base`), Task 8 (reads it). ✓
- Testing (unit/hybrid/e2e) → Tasks 1, 4, 5, 6, 9. ✓
- Open item: GROUP source ambiguity → resolved in Task 1 (standardize on Groups) + Global Constraints. ✓
- Open item: admin bundle-gating → Global Constraints + Task 6 version bump. ✓

**Type consistency:** `resolveFeatured(row, maps)` maps key `groupByLegacyId` used consistently in Tasks 1 & 7. `getFeaturedPayload`/`resetFeaturedCache`/`computeFeaturedEtag`/`fetchFeatured` names consistent across Tasks 1, 2, 5, 6. Payload shape `{featured, etag, computedAt}` (+`buildAt` on the wire) consistent Tasks 2 & 6. Candidate shape `{taskLegacyId, taskType, title, slug}` consistent Tasks 4 & 6. ✓

**Placeholder scan:** no TBD/TODO-style gaps; every code step has concrete content. Two explicit "verify against live DOM/permalinks" notes are deliberate (project rules forbid guessing deployed DOM + Hugo permalink prefixes) and scoped to a verify action, not hand-waving. ✓
