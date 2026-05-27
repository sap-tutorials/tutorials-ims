# Navigator Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three gaps left by PR #65: mirror group-surfacing fixes into `srv/lib/build-catalog.js` (so the Hugo build pipeline matches the runtime navigator), drop the unused `checkpointMappings` field, and clarify the `NavigatorCatalog` CDS view comment.

**Architecture:** Three independent fixes against the freshly-merged `fix(navigator): surface standalone Groups, nested Groups, and checkpoints` (PR #65). The build-time handler `/build/catalog` (consumed by Hugo's static-site generator) currently has the same blind spots the runtime `/build/navigator` had before PR #65: it drops nested Groups (CompletionPathItems with `taskType='GROUP'`) and never queries standalone Groups (Groups not referenced by any mission's CompletionPath). This plan applies the same query patterns from `srv/lib/navigator-catalog.js` to `srv/lib/build-catalog.js`, threads the new shape through `scripts/parsers/cap.ts` and `scripts/fetch-tutorials.ts`, removes the unused `checkpointMappings` plumbing (AppSpace renders checkpoints via `getEventProgress`, not via `/build/navigator`), fixes a per-mission counting bug in the homepage card grid, and updates the misleading `NavigatorCatalog` CDS view comment.

**Tech Stack:** SAP CAP Node.js (cds.ql, no raw SQL), Vitest (in-memory SQLite for unit), Hugo + TypeScript build pipeline, Vue 3 (homepage navigator), CDS views.

**Reference context (read before starting):**
- PR #65: https://github.com/SAP-tutorials/tutorials-poc/pull/65 — the merged fix this plan extends
- `srv/lib/navigator-catalog.js` — the canonical pattern to mirror in build-catalog.js
- `db/schema.cds:175-198` — `CompletionPaths`, `CompletionPathItems`, `GroupPathItems` shape
- `db/schema.cds:65` — `Checkpoints` entity (Tom: "checkpoints are only part of missions")
- `srv/developer-service.js:262-351` — `getEventProgress` (how AppSpace renders checkpoints today)
- `hugo-apps/src/app-space/AppSpace.vue:24,195,398,936` — AppSpace already renders checkpoints

**Design decisions locked by Tom (2026-05-26):**
1. Checkpoints stay out of `/build/catalog` — they're mission-only and AppSpace owns rendering.
2. Render venue for checkpoints = AppSpace event view only (already wired via `getEventProgress`). No Hugo mission/group page changes, no navigator card-grid changes.
3. `NavigatorCatalog` CDS view: comment-only update (don't rename — the view is `@analytics.exposed`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `srv/lib/build-catalog.js` | Modify | Backend handler for `/build/catalog` — surface nested + standalone Groups |
| `test/build-catalog-groups.test.js` | Create | Unit tests covering nested Group expansion + standaloneGroups[] |
| `scripts/parsers/cap.ts` | Modify | Type + cache shape for new `standaloneGroups` field |
| `scripts/fetch-tutorials.ts` | Modify | Iterate `standaloneGroups`, generate `/groups/{slug}/` pages for orphan groups |
| `srv/lib/navigator-catalog.js` | Modify | Drop unused `checkpointMappings` (AppSpace doesn't fetch this endpoint) |
| `test/navigator-groups.test.js` | Modify | Drop the orphan `checkpointMappings` test case |
| `hugo-apps/src/navigator/TutorialNavigator.vue` | Modify | Fix per-mission group count (line ~304: `groupMap.size` is global today) |
| `db/views.cds` | Modify | Update `NavigatorCatalog` comment to reflect handler-bypass reality |

---

## Task 1: Build-catalog — surface nested Groups in mission hierarchies

**Problem:** `srv/lib/build-catalog.js:41` does `pathItems.filter(i => i.taskType === 'TUTORIAL')`. CompletionPathItems with `taskType='GROUP'` (a Group nested inside a mission's CompletionPath) are silently dropped. The tutorials those Groups contain (via `GroupPathItems`) never reach Hugo's mission-page generator.

**Fix:** When iterating a mission's path-items, branch on `taskType`. For `'TUTORIAL'`, keep the current behavior. For `'GROUP'`, resolve `item.group_ID` → query its `GroupPathItems` → emit a `HierarchyGroup` with the group's title/slug + the resolved tutorialSlugs.

**Files:**
- Modify: `srv/lib/build-catalog.js:36-61` (the `hierarchies = missions.map(...)` block)
- Test: `test/build-catalog-groups.test.js` (new — created in this task)

- [ ] **Step 1: Read the navigator-catalog.js nested-group pattern (no edits)**

Read `srv/lib/navigator-catalog.js:90-194` (the nested-group resolution loop). The build-catalog version will be simpler because we don't need cross-mission dedup (each Mission owns its own `groupsToProcess` list — duplicate groupRefs across missions are fine in build-catalog, since Hugo generates one page per (mission,group) combo).

- [ ] **Step 2: Write the failing test for nested-Group expansion**

Create `test/build-catalog-groups.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const TAG_ID     = 'aaaaaaaa-c001-0000-0000-000000000001';
const MISSION_ID = '11111111-c001-0000-0000-000000000001';
const PATH_ID    = '22222222-c001-0000-0000-000000000001';
const GROUP_ID   = 'cccccccc-c001-0000-0000-000000000001';
const TUT_ID     = 'cccccccc-c001-0000-0000-000000000011';
const GPI_ID     = 'cccccccc-c001-0000-0000-000000000021';
const CPI_ID     = 'cccccccc-c001-0000-0000-000000000031';

describe('/build/catalog: nested Group inside a Mission', () => {
  beforeAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems, Groups, Tutorials, GroupPathItems } =
      cds.entities('com.sap.developers.ims');

    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 91001, name: '__TEST__ Nested Tag' });
    await INSERT.into(Tutorials).entries({
      ID: TUT_ID, legacyId: 91011, title: '__TEST__ Nested Tut', slug: 'test-bc-nested-tut', status: 'ACTIVE',
    });
    await INSERT.into(Groups).entries({
      ID: GROUP_ID, legacyId: 91001, title: '__TEST__ BC Nested Group',
      description: 'desc', experienceTag: 'beginner', primaryTagRef_ID: TAG_ID,
      published: true, status: 'ACTIVE', slug: 'test-bc-nested-group',
    });
    await INSERT.into(GroupPathItems).entries({
      ID: GPI_ID, legacyId: 91021, group_ID: GROUP_ID, tutorial_ID: TUT_ID, itemOrder: 0,
    });
    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 91001, title: '__TEST__ BC Nested Mission',
      slug: 'test-bc-nested-mission', description: 'desc', experienceTag: 'beginner',
      primaryTagRef_ID: TAG_ID, published: true,
    });
    await INSERT.into(CompletionPaths).entries({
      ID: PATH_ID, legacyId: 91001, mission_ID: MISSION_ID,
      name: 'Path 1', slug: 'test-bc-path',
    });
    await INSERT.into(CompletionPathItems).entries({
      ID: CPI_ID, legacyId: 91031, path_ID: PATH_ID,
      taskType: 'GROUP', taskLegacyId: 91001, group_ID: GROUP_ID, itemOrder: 0,
    });
  });

  afterAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems, Groups, Tutorials, GroupPathItems } =
      cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ ID: CPI_ID });
    await DELETE.from(CompletionPaths).where({ ID: PATH_ID });
    await DELETE.from(Missions).where({ ID: MISSION_ID });
    await DELETE.from(GroupPathItems).where({ ID: GPI_ID });
    await DELETE.from(Groups).where({ ID: GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: TUT_ID });
    await DELETE.from(Tags).where({ ID: TAG_ID });
  });

  it('emits the nested Group as a HierarchyGroup on the mission with resolved tutorialSlugs', async () => {
    const { status, data } = await project.get('/build/catalog');
    expect(status).toBe(200);

    const hier = data.hierarchies.find(h => h.missionImsId === 91001);
    expect(hier).toBeDefined();
    const ourGroup = hier.groups.find(g => g.imsId === 91001);
    expect(ourGroup).toBeDefined();
    expect(ourGroup.title).toBe('__TEST__ BC Nested Group');
    expect(ourGroup.slug).toBe('test-bc-nested-group');
    expect(ourGroup.tutorialSlugs).toEqual(['test-bc-nested-tut']);
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `npx vitest run test/build-catalog-groups.test.js`
Expected: FAIL — `ourGroup` is `undefined` (current handler drops `taskType='GROUP'` items).

- [ ] **Step 4: Implement nested-Group expansion in build-catalog.js**

Two surgical edits — keep the existing variable names (`missions`, `paths`, `items`, `tutorials`):

**Edit 4a — entity destructure (line 6-7):** add `Groups, GroupPathItems`:

```javascript
const { Missions, CompletionPaths, CompletionPathItems, Tutorials, FeaturedTasks, Groups, GroupPathItems } =
  cds.entities('com.sap.developers.ims');
```

**Edit 4b — extend the existing `tutorials` query at line 13-15 to also select `ID`** (so `tutorialByUuid` honors the same status filter — no second query):

```javascript
const tutorials = await SELECT.from(Tutorials)
  .columns('ID', 'legacyId', 'slug', 'title', 'description')
  .where(`status = 'ACTIVE' or status is null`);
```

**Edit 4c — INSERT new queries + maps after line 18 (after the `featuredRows` SELECT, before the `slugByLegacyId` map at line 20):**

```javascript
const groups = await SELECT.from(Groups)
  .columns('ID', 'legacyId', 'title', 'slug', 'description', 'published', 'status');
const groupById = new Map(groups.map(g => [g.ID, g]));

const groupPathItems = await SELECT.from(GroupPathItems)
  .columns('group_ID', 'tutorial_ID', 'itemOrder');

const tutorialByUuid = new Map(tutorials.map(t => [t.ID, t.slug]));
```

**Edit 4d — REPLACE the existing `hierarchies = missions.map(...)` block (lines 36-61) with:**

```javascript
const hierarchies = missions.map(m => {
  const missionPaths = paths.filter(p => p.mission_ID === m.ID);
  const groupHierarchies = missionPaths.flatMap(p => {
    const pathItems = items.filter(i => i.path_ID === p.ID);

    // TUTORIAL items in this path → the path's own slug list
    const pathTutorialSlugs = pathItems
      .filter(i => i.taskType === 'TUTORIAL')
      .sort((a, b) => a.itemOrder - b.itemOrder)
      .map(i => slugByLegacyId.get(i.taskLegacyId))
      .filter(Boolean);

    // Emit one HierarchyGroup for the path itself (existing behavior)
    const pathGroup = {
      imsId: p.legacyId,
      title: p.name || '',
      slug: p.slug || String(p.legacyId),
      description: '',
      tutorialSlugs: pathTutorialSlugs,
    };

    // Plus one HierarchyGroup per nested GROUP item in this path
    const nestedGroups = pathItems
      .filter(i => i.taskType === 'GROUP' && i.group_ID)
      .sort((a, b) => a.itemOrder - b.itemOrder)
      .map(i => {
        const g = groupById.get(i.group_ID);
        if (!g) return null;
        const gpItems = groupPathItems
          .filter(gpi => gpi.group_ID === g.ID)
          .sort((a, b) => a.itemOrder - b.itemOrder);
        const tutorialSlugs = gpItems
          .map(gpi => tutorialByUuid.get(gpi.tutorial_ID))
          .filter(Boolean);
        return {
          imsId: g.legacyId,
          title: g.title || '',
          slug: g.slug || String(g.legacyId),
          description: g.description || '',
          tutorialSlugs,
        };
      })
      .filter(Boolean);

    return [pathGroup, ...nestedGroups];
  });

  // isFlat must remain true for single-path no-nested-group missions (existing
  // behavior). groupHierarchies.length === 1 means: one path AND no nested
  // groups under it (path → 1 entry; each nested group → +1 entry).
  const isFlat = missionPaths.length === 1
    && missionPaths[0].name === m.title
    && groupHierarchies.length === 1;

  return {
    missionImsId: m.legacyId,
    groups: isFlat ? [] : groupHierarchies,
    tutorialSlugs: isFlat ? (groupHierarchies[0]?.tutorialSlugs || []) : [],
  };
});
```

- [ ] **Step 4b: Add an isFlat regression test (single-path, no nested groups)**

Add a third `describe` block to `test/build-catalog-groups.test.js` that asserts: a mission with one path (path name === mission title) and zero nested groups still gets `groups: []` and `tutorialSlugs: [<slug>]` in its hierarchy. Use legacyIds in the 91100s to avoid collision. This guards against the `groupHierarchies.length === 1` predicate breaking.

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run test/build-catalog-groups.test.js`
Expected: PASS.

- [ ] **Step 6: Run the existing build-catalog test to confirm no regression**

Run: `npx vitest run test/build-catalog-featured.test.js`
Expected: PASS (2/2 — featured array shape preserved).

- [ ] **Step 7: Commit**

```bash
git add srv/lib/build-catalog.js test/build-catalog-groups.test.js
git commit -m "feat(build-catalog): expand nested Groups in mission hierarchies

CompletionPathItems with taskType='GROUP' were silently dropped by the
TUTORIAL-only filter, so the Hugo build pipeline missed any tutorials
reachable through a nested Group. Mirror the navigator-catalog pattern:
resolve the Group association, query GroupPathItems for its tutorials,
and emit them as an additional HierarchyGroup on the mission."
```

---

## Task 2: Build-catalog — surface standalone Groups via `standaloneGroups[]`

**Problem:** Standalone Groups (Groups not referenced by any mission's CompletionPath) are never queried by the build-catalog handler. Hugo can't generate `/groups/{slug}/` pages for them. The current response shape `{ missions, hierarchies, featured }` has no slot for orphan groups — they're conceptually mission-less.

**Fix:** Add a top-level `standaloneGroups[]` field to the catalog response. Each entry: `{ imsId, title, slug, description, tutorialSlugs }`. Use the same disjointness invariant as `navigator-catalog.js:96` — a Group is "standalone" iff its ID does not appear as `group_ID` on any `taskType='GROUP'` `CompletionPathItem`.

**Files:**
- Modify: `srv/lib/build-catalog.js` (add standaloneGroups computation + return-shape field)
- Test: `test/build-catalog-groups.test.js` (extend with a new `describe` block)

- [ ] **Step 1: Write the failing test for standaloneGroups[]**

Append a second `describe` block to `test/build-catalog-groups.test.js`:

```javascript
describe('/build/catalog: standalone Group surfacing', () => {
  const SA_TAG_ID     = 'aaaaaaaa-c002-0000-0000-000000000001';
  const SA_GROUP_ID   = 'cccccccc-c002-0000-0000-000000000001';
  const SA_TUT1_ID    = 'cccccccc-c002-0000-0000-000000000011';
  const SA_TUT2_ID    = 'cccccccc-c002-0000-0000-000000000012';
  const SA_GPI1_ID    = 'cccccccc-c002-0000-0000-000000000021';
  const SA_GPI2_ID    = 'cccccccc-c002-0000-0000-000000000022';

  beforeAll(async () => {
    const { Tags, Groups, Tutorials, GroupPathItems } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: SA_TAG_ID, legacyId: 91002, name: '__TEST__ SA Tag' });
    await INSERT.into(Tutorials).entries([
      { ID: SA_TUT1_ID, legacyId: 91012, title: '__TEST__ SA Tut 1', slug: 'test-bc-sa-tut-1', status: 'ACTIVE' },
      { ID: SA_TUT2_ID, legacyId: 91013, title: '__TEST__ SA Tut 2', slug: 'test-bc-sa-tut-2', status: 'ACTIVE' },
    ]);
    await INSERT.into(Groups).entries({
      ID: SA_GROUP_ID, legacyId: 91002, title: '__TEST__ SA Group',
      description: 'sa-desc', experienceTag: 'beginner', primaryTagRef_ID: SA_TAG_ID,
      published: true, status: 'ACTIVE', slug: 'test-bc-sa-group',
    });
    await INSERT.into(GroupPathItems).entries([
      { ID: SA_GPI1_ID, legacyId: 91022, group_ID: SA_GROUP_ID, tutorial_ID: SA_TUT1_ID, itemOrder: 0 },
      { ID: SA_GPI2_ID, legacyId: 91023, group_ID: SA_GROUP_ID, tutorial_ID: SA_TUT2_ID, itemOrder: 1 },
    ]);
  });

  afterAll(async () => {
    const { Tags, Groups, Tutorials, GroupPathItems } = cds.entities('com.sap.developers.ims');
    await DELETE.from(GroupPathItems).where({ ID: { in: [SA_GPI1_ID, SA_GPI2_ID] } });
    await DELETE.from(Groups).where({ ID: SA_GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [SA_TUT1_ID, SA_TUT2_ID] } });
    await DELETE.from(Tags).where({ ID: SA_TAG_ID });
  });

  it('emits standalone Groups in standaloneGroups[] with ordered tutorialSlugs', async () => {
    const { status, data } = await project.get('/build/catalog');
    expect(status).toBe(200);
    expect(Array.isArray(data.standaloneGroups)).toBe(true);

    const ours = data.standaloneGroups.find(g => g.imsId === 91002);
    expect(ours).toBeDefined();
    expect(ours.title).toBe('__TEST__ SA Group');
    expect(ours.slug).toBe('test-bc-sa-group');
    expect(ours.description).toBe('sa-desc');
    expect(ours.tutorialSlugs).toEqual(['test-bc-sa-tut-1', 'test-bc-sa-tut-2']);
  });

  it('does NOT include nested Groups in standaloneGroups[] (disjointness invariant)', async () => {
    const { data } = await project.get('/build/catalog');
    // The nested Group from the prior describe block has legacyId 91001 — it must be excluded.
    const nested = data.standaloneGroups.find(g => g.imsId === 91001);
    expect(nested).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run test/build-catalog-groups.test.js -t standalone`
Expected: FAIL — `data.standaloneGroups` is `undefined`.

- [ ] **Step 3: Implement standaloneGroups computation**

In `srv/lib/build-catalog.js`, after the `hierarchies = missions.map(...)` block but before `for (const m of missionList)`, add:

```javascript
// Standalone groups: published Groups whose ID never appears as group_ID on any
// taskType='GROUP' CompletionPathItem. Disjointness invariant matches navigator-catalog.js.
const nestedGroupIds = new Set(
  items
    .filter(i => i.taskType === 'GROUP' && i.group_ID)
    .map(i => i.group_ID)
);

const standaloneGroups = groups
  .filter(g => g.published)
  .filter(g => g.status === 'ACTIVE' || g.status === null || g.status === undefined)
  .filter(g => !nestedGroupIds.has(g.ID))
  .map(g => {
    const gpItems = groupPathItems
      .filter(gpi => gpi.group_ID === g.ID)
      .sort((a, b) => a.itemOrder - b.itemOrder);
    const tutorialSlugs = gpItems
      .map(gpi => tutorialByUuid.get(gpi.tutorial_ID))
      .filter(Boolean);
    return {
      imsId: g.legacyId,
      title: g.title || '',
      slug: g.slug || String(g.legacyId),
      description: g.description || '',
      tutorialSlugs,
    };
  });
```

Update the response at the bottom of the handler (currently `res.json({ missions: missionList, hierarchies, featured });`) to:

```javascript
res.json({ missions: missionList, hierarchies, featured, standaloneGroups });
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run test/build-catalog-groups.test.js`
Expected: PASS (3/3 — nested + standaloneGroups + disjointness).

- [ ] **Step 5: Verify the existing featured-array test still passes**

Run: `npx vitest run test/build-catalog-featured.test.js`
Expected: PASS (the new field is additive, no shape regression).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/build-catalog.js test/build-catalog-groups.test.js
git commit -m "feat(build-catalog): add standaloneGroups[] for orphan Groups

Standalone Groups (no parent mission) had nowhere to live in the
{ missions, hierarchies, featured } shape. Add an additive top-level
standaloneGroups[] field so the Hugo build pipeline can generate
/groups/{slug}/ pages for them. Disjointness from nested Groups is
enforced via the same nestedGroupIds set used in navigator-catalog.js."
```

---

## Task 3: Hugo consumer — extend `cap.ts` type and cache shape

**Problem:** `scripts/parsers/cap.ts:33` returns `{ missions, hierarchies }`. The new `standaloneGroups[]` field needs a TypeScript type, must round-trip through the on-disk cache (`.tutorial-cache/cap-catalog.json`), and must reach `fetch-tutorials.ts`.

**Fix:** Add a `StandaloneGroup` interface to `scripts/parsers/types.ts`, extend the `fetchBuildCatalog` return type, extend the `CapCacheData` shape, and update save/load paths. Make the field optional in the cache type so older caches don't break load (auto-evict if missing — simpler than adding a migration).

**Files:**
- Modify: `scripts/parsers/types.ts` (add `StandaloneGroup` interface)
- Modify: `scripts/parsers/cap.ts` (extend return type + cache shape)

- [ ] **Step 1: Add StandaloneGroup interface to types.ts**

Append to `scripts/parsers/types.ts`:

```typescript
export interface StandaloneGroup {
  imsId: number
  title: string
  slug: string
  description: string
  tutorialSlugs: string[]
}
```

- [ ] **Step 2: Update cap.ts return + cache types**

Modify `scripts/parsers/cap.ts`:

```typescript
import type { Mission, MissionHierarchy, StandaloneGroup } from './types.js'

interface CapCacheData {
  timestamp: number
  missions: Mission[]
  hierarchies: MissionHierarchy[]
  standaloneGroups?: StandaloneGroup[]  // optional — older caches won't have it
}

export function loadCapCache(): CapCacheData | null {
  if (!existsSync(CACHE_FILE)) return null
  try {
    const data: CapCacheData = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
    if (Date.now() - data.timestamp > CACHE_TTL_MS) return null
    // Treat caches missing the new field as stale to force refetch.
    if (!Array.isArray(data.standaloneGroups)) return null
    return data
  } catch {
    return null
  }
}

export function saveCapCache(
  missions: Mission[],
  hierarchies: MissionHierarchy[],
  standaloneGroups: StandaloneGroup[]
): void {
  mkdirSync(dirname(CACHE_FILE), { recursive: true })
  const data: CapCacheData = { timestamp: Date.now(), missions, hierarchies, standaloneGroups }
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

export async function fetchBuildCatalog(baseUrl: string): Promise<{
  missions: Mission[]
  hierarchies: MissionHierarchy[]
  standaloneGroups: StandaloneGroup[]
}> {
  const url = `${baseUrl}/build/catalog`
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } })

  if (!res.ok) {
    throw new Error(`CAP build catalog failed: ${res.status} ${res.statusText}`)
  }

  const data = await res.json() as {
    missions: Mission[]
    hierarchies: MissionHierarchy[]
    standaloneGroups?: StandaloneGroup[]
  }
  return {
    missions: data.missions,
    hierarchies: data.hierarchies,
    standaloneGroups: data.standaloneGroups ?? [],
  }
}
```

- [ ] **Step 3: Type-check cap.ts**

Run: `npx tsc --noEmit scripts/parsers/cap.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/parsers/cap.ts scripts/parsers/types.ts
git commit -m "feat(parsers): thread standaloneGroups through cap.ts cache + return type

Older on-disk caches without the new field are evicted on load (return
null) to force a refetch. Empty array fallback at the API boundary
keeps fetch-tutorials.ts safe when CAP returns the older shape during
rolling deploy."
```

---

## Task 4: fetch-tutorials.ts — generate `/groups/{slug}/` for standalone Groups

**Problem:** `scripts/fetch-tutorials.ts:835` only iterates `missions`. Standalone Groups must be processed via a separate loop. The existing `writeGroupPage(group, mission, ...)` signature requires a mission — we need to either thread a sentinel or skip the mission link in the rendered page.

**Fix:** After the mission loop (line 922), iterate `standaloneGroups`. For each, write a group page using `writeGroupPage` with `mission = null`, push the resulting `GroupRef` into `allGroupRefs` (with `missionId: 0` since the type requires a number — Hugo templates can branch on `groupRef.missionId === 0` if they care). Update `nav.groupId/groupTitle/groupSlug` on each tutorial and chain prev/next within the group.

**Files:**
- Modify: `scripts/fetch-tutorials.ts:797-940` (the CAP phase)
- Modify: `scripts/fetch-tutorials.ts` `writeGroupPage` callsite (need to inspect — may need `mission?: Mission`)

- [ ] **Step 1: Inspect writeGroupPage signature**

Run: `grep -n "function writeGroupPage" scripts/fetch-tutorials.ts`
Read the function body to check whether `mission` is mandatory in its template output. Note any null-handling required.

- [ ] **Step 2: Make `mission` optional in writeGroupPage if it's used in output**

If `writeGroupPage` references `mission.imsId`, `mission.title`, etc., loosen the param to `mission: Mission | null` and add `if (mission) { ... }` guards around mission-specific frontmatter fields. Standalone-group pages should still get `type: 'groups'` and a meaningful title — they just don't have a parent mission breadcrumb.

- [ ] **Step 3: Read standaloneGroups from the catalog fetch**

Modify `scripts/fetch-tutorials.ts:800-826`:

```typescript
let missions: Mission[] = []
let hierarchies: MissionHierarchy[] = []
let standaloneGroups: StandaloneGroup[] = []
let capCacheUsed = false
let coCompletions: Map<string, Map<string, number>> = new Map()

const forceRefresh = process.argv.includes('--force-cap')
const cached = forceRefresh ? null : loadCapCache()

if (cached) {
  missions = cached.missions
  hierarchies = cached.hierarchies
  standaloneGroups = cached.standaloneGroups ?? []
  capCacheUsed = true
  console.log(`  [cap] Using cached data (${missions.length} missions, ${standaloneGroups.length} standalone groups)`)
} else {
  try {
    const capBaseUrl = process.env.CAP_BASE_URL || 'http://localhost:4004'
    const catalog = await fetchBuildCatalog(capBaseUrl)
    missions = catalog.missions
    hierarchies = catalog.hierarchies
    standaloneGroups = catalog.standaloneGroups
    saveCapCache(missions, hierarchies, standaloneGroups)
    console.log(`  [cap] Fetched ${missions.length} missions, ${standaloneGroups.length} standalone groups`)
    coCompletions = await fetchCoCompletions(capBaseUrl)
    console.log(`  [cap] co-completion map: ${coCompletions.size} source slugs`)
  } catch (err) {
    console.warn(`  [cap-warn] CAP fetch failed: ${err instanceof Error ? err.message : err}`)
    console.warn('  [cap-warn] Continuing without missions/groups')
  }
}
```

Add `StandaloneGroup` to the imports at line 14:

```typescript
import type { Mission, MissionHierarchy, HierarchyGroup, StandaloneGroup, TutorialStep, TutorialNavEntry, NavData, MissionMeta, GroupRef } from './parsers/types.js'
```

- [ ] **Step 4: Add a standalone-groups loop after the mission loop**

After line 922 (after `writeMissionPage(...)`), add:

```typescript
for (const sg of standaloneGroups) {
  const groupRef: GroupRef = {
    id: sg.imsId,
    title: sg.title,
    slug: sg.slug,
    missionId: 0,  // sentinel: standalone group, no parent mission
    tutorials: [],
  }

  const groupTutorialEntries: Array<{
    slug: string
    title: string
    description: string
    time: number
    level: string
    stepCount: number
    primaryTag: string
  }> = []

  for (let i = 0; i < sg.tutorialSlugs.length; i++) {
    const tSlug = sg.tutorialSlugs[i]
    const nav = navBySlug.get(tSlug)
    if (!nav) {
      unmatchedTutorials++
      continue
    }
    matchedTutorials++
    groupRef.tutorials.push(tSlug)

    nav.groupId = sg.imsId
    nav.groupTitle = sg.title
    nav.groupSlug = sg.slug

    const prevSlug = i > 0 ? sg.tutorialSlugs[i - 1] : null
    const nextSlug = i < sg.tutorialSlugs.length - 1 ? sg.tutorialSlugs[i + 1] : null
    if (prevSlug && navBySlug.has(prevSlug)) nav.prev = prevSlug
    if (nextSlug && navBySlug.has(nextSlug)) nav.next = nextSlug

    groupTutorialEntries.push({
      slug: nav.slug,
      title: nav.title,
      description: nav.description,
      time: nav.time,
      level: nav.level,
      stepCount: nav.stepCount,
      primaryTag: nav.primaryTag,
    })
  }

  allGroupRefs.push(groupRef)
  writeGroupPage(
    { imsId: sg.imsId, title: sg.title, slug: sg.slug, description: sg.description, tutorialSlugs: sg.tutorialSlugs },
    null,  // no parent mission
    groupTutorialEntries,
    OUTPUT_DIR,
    target
  )
}
console.log(`  [cap] Generated ${standaloneGroups.length} standalone group pages`)
```

- [ ] **Step 5: Smoke-build locally**

Run (local CAP must be up — see `npm run dev:hybrid`):
```bash
rm -rf .tutorial-cache/cap-catalog.json
CAP_BASE_URL=http://localhost:4004 npm run fetch-tutorials
```

Expected: log line `Generated N standalone group pages` where N matches the count of published standalone Groups in your DB. No `unmatchedTutorials` count blowup. Inspect `hugo/content/groups/` for new files.

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-tutorials.ts
git commit -m "feat(fetch-tutorials): generate Hugo pages for standalone Groups

Iterate the new standaloneGroups[] from /build/catalog and emit one
/groups/{slug}/ page per orphan group, plus update each tutorial's
groupId/groupTitle/groupSlug nav metadata so prev/next chaining works
within the group. mission=null is passed to writeGroupPage to suppress
mission breadcrumb fields in the standalone case."
```

---

## Task 5: Drop unused `checkpointMappings` from `/build/navigator`

**Problem:** PR #65 added `checkpointMappings[]` to the `/build/navigator` response as forward-compat plumbing. With Tom's design call (2026-05-26: render venue = AppSpace only, which uses `getEventProgress`), the field has no consumer. Carrying dead plumbing in a "central component" goes against Tom's clean directive.

**Fix:** Remove the `checkpointMappings` array (and its push loop) from `srv/lib/navigator-catalog.js`. Keep the `checkpointItems` query — it still feeds `pathById/missionById` populations for the nested-group loop. Drop the test case that asserts `checkpointMappings` exists.

**Files:**
- Modify: `srv/lib/navigator-catalog.js:196-219` (remove the build-and-push block + the field on `result`)
- Modify: `test/navigator-groups.test.js:195-198` (drop the it() block asserting `checkpointMappings`)

- [ ] **Step 1: Remove checkpointMappings from navigator-catalog.js**

In `srv/lib/navigator-catalog.js`:

1. Delete lines 196-217 (the comment block + the `for (const item of checkpointItems)` push loop).
2. Change line 219 from:
   ```javascript
   const result = { missions: missionRefs, groups: groupRefs, tutorialMappings, checkpointMappings };
   ```
   to:
   ```javascript
   const result = { missions: missionRefs, groups: groupRefs, tutorialMappings };
   ```

Keep the `checkpointItems` query at lines 135-138 — it's still needed to populate `pathIds` (line 142-144) for the nested-group resolution loop. Add a brief comment so future readers understand why we still query it:

```javascript
// Also query checkpoint items: they're not surfaced in the response (AppSpace
// renders checkpoints via getEventProgress), but their path_IDs still need to
// be resolved into pathById/missionById so the nested-group loop below can
// resolve any nested Groups that share a path with a checkpoint.
const checkpointItems = await SELECT.from(CompletionPathItems)
  .columns('path_ID', 'itemOrder')
  .where({ taskType: 'CHECKPOINT' })
  .orderBy('path_ID', 'itemOrder');
```

(Note: dropped the `checkpointTitle` column since we no longer emit it.)

- [ ] **Step 2: Drop the orphan test case in navigator-groups.test.js**

In `test/navigator-groups.test.js`, delete ONLY the `it('emits a checkpointMappings array with mission + title + itemOrder', ...)` block. Keep the `it('does not put checkpoints into tutorialMappings', ...)` block immediately following it — that assertion is still valuable (guarantees checkpoints don't leak into tutorialMappings even though we no longer surface them separately). Keep all other test cases in that file.

- [ ] **Step 3: Run navigator tests to confirm nothing else regressed**

Run: `npx vitest run test/navigator-groups.test.js`
Expected: PASS (all remaining test cases — standalone groups, nested groups, prev/next chaining).

- [ ] **Step 4: Commit**

```bash
git add srv/lib/navigator-catalog.js test/navigator-groups.test.js
git commit -m "refactor(navigator): drop unused checkpointMappings field

PR #65 added checkpointMappings as forward-compat plumbing for a
checkpoint-rendering venue that won't materialize: AppSpace renders
checkpoints via getEventProgress (auth + event-scoped), not via the
unauthenticated /build/navigator endpoint. Hugo mission/group pages
won't render checkpoint markers either (per design call 2026-05-26).
Drop the dead plumbing now rather than carrying it indefinitely.

The checkpointItems query stays — it's still needed to populate
pathById/missionById for the nested-group resolution loop."
```

---

## Task 6: Fix per-mission group count in `TutorialNavigator.vue`

**Problem:** `hugo-apps/src/navigator/TutorialNavigator.vue:304` emits a mission-card subtitle like `Includes ${mTuts.length} tutorials across ${groupMap.size} groups`. `groupMap.size` is the GLOBAL group count (every group across every mission, plus standalone groups). Mission cards now show inflated subtitles after PR #65.

**Fix:** Compute per-mission group count from the mission's own tutorials. Same `groupMap` data, just filtered by `t.missionId === m.id`.

**Files:**
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue:280-310` (the `missionGroups` / `groupMap` computation block)

- [ ] **Step 1: Read the existing computation block**

Read `hugo-apps/src/navigator/TutorialNavigator.vue:280-310` to confirm exact line numbers and surrounding code (this file is large; line numbers may have drifted).

- [ ] **Step 2: Replace `groupMap.size` with a per-mission count**

The mission-card subtitle is built inside a `for (const [missionId, mTuts] of missionGroups)` loop where `missionId` is the loop variable (number). The existing `m` reference is from `missionsMeta.value.find(m => m.id === missionId)`. Use the loop variable, NOT `m.id`.

Replace:

```javascript
`Includes ${mTuts.length} tutorials across ${groupMap.size} groups`
```

with:

```javascript
(() => {
  const missionGroupIds = new Set(
    tutorials.value
      .filter(t => t.missionId === missionId && t.groupId != null)
      .map(t => t.groupId)
  )
  return `Includes ${mTuts.length} tutorials across ${missionGroupIds.size} groups`
})()
```

Or, cleaner — add a `missionGroupCount(missionId)` helper alongside the existing helpers and call it from the template. Match whatever pattern the surrounding code already uses (helpers are defined earlier in this same `<script setup>` block).

- [ ] **Step 3: Build the bundle to verify no TypeScript / Vue compile errors**

Run: `cd hugo-apps && npm run build`
Expected: success, no errors. Bundles emit to `hugo/static/js/`.

- [ ] **Step 4: Manual smoke (browser)**

Run `npm run dev` (Hugo dev server at http://localhost:1313). Open the homepage. Inspect a mission card with a known group count (e.g., a multi-path mission). Confirm the subtitle shows the per-mission count, not the global count.

If you don't have local CAP running you may need `CAP_BASE_URL` or a pre-built `.tutorial-cache/`. Skip this step if blocked and rely on Step 3 + spec reviewer to catch issues.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/navigator/TutorialNavigator.vue
git commit -m "fix(navigator): per-mission group count in mission card subtitle

groupMap.size aggregates groups across all missions plus standalone
groups, so 'Includes N tutorials across M groups' showed an inflated
M after PR #65 surfaced standalone groups. Filter the underlying
tutorials by mission before counting distinct groupIds."
```

---

## Task 7: Update `NavigatorCatalog` CDS view comment

**Problem:** `db/views.cds:41-61` defines `NavigatorCatalog` with `where item.taskType = 'TUTORIAL' and tut.slug is not null and mission.published = true`. The current handler (`srv/lib/navigator-catalog.js`) intentionally bypasses this view for nested Groups, standalone Groups, and (was for) checkpoints — querying `CompletionPathItems`/`Groups`/`GroupPathItems` directly. The view itself is correct for what it claims (mission-published TUTORIAL items), but a casual reader assumes the view IS the navigator catalog and gets confused.

**Fix:** Comment-only update. Tom selected option (a) — don't rename (would break `@analytics.exposed` surface in `db/schema-ext.cds` + saved analytics queries).

**Files:**
- Modify: `db/views.cds:41-61` (replace the existing inline comment at line 41 + add a body comment)

- [ ] **Step 1: Update the comment**

In `db/views.cds`, replace the comment at line 41 (currently `// Pre-joined view for the navigator: only missions/paths/items that reference actual tutorials`) with:

```cds
// MissionTutorialItems — a slice, NOT the full navigator catalog.
//
// Returns one row per (mission-published, slug-set, taskType='TUTORIAL') item.
// Excluded by design: nested Groups (taskType='GROUP'), standalone Groups (no
// parent CompletionPath), and checkpoints (taskType='CHECKPOINT'). The
// /build/navigator handler at srv/lib/navigator-catalog.js queries those cases
// directly against CompletionPathItems / Groups / GroupPathItems and unions
// the results with this view's rows — never assume this view alone produces
// the navigator response shape.
//
// Kept under the legacy name `NavigatorCatalog` because it's @analytics.exposed
// (see db/schema-ext.cds) and renaming would break saved Analytics Explorer
// queries. The comment is the source of truth for intent.
view NavigatorCatalog as
  ...
```

(Keep the rest of the view body unchanged.)

- [ ] **Step 2: Run cds compile to verify the comment doesn't break the model**

Run: `npx cds compile srv > /dev/null`
Expected: no errors, no warnings. Comments are non-load-bearing but `cds compile` is the cheapest sanity check that nothing structural was touched.

- [ ] **Step 3: Run the unit suite to confirm no regression**

Run: `npm test`
Expected: PASS — full unit baseline (620+ passing per memory `project_main_test_failures`).

- [ ] **Step 4: Commit**

```bash
git add db/views.cds
git commit -m "docs(views): clarify NavigatorCatalog scope vs handler reality

The view filters to taskType='TUTORIAL', mission-published, slug-set
items. The /build/navigator handler intentionally bypasses it for
nested Groups, standalone Groups, and checkpoints — querying base
entities directly. Update the comment so future readers don't assume
the view alone produces the navigator response shape. Name is kept
because the view is @analytics.exposed."
```

---

## Final verification

- [ ] **Step 1: Full unit suite**

Run: `npm test`
Expected: all unit tests pass, no new failures vs main baseline.

- [ ] **Step 2: Hybrid HANA test (Tom runs after `cf login`)**

Provide Tom this command in the PR description:
```bash
npm run test:hybrid -- test/build-catalog-groups.test.js test/navigator-groups.test.js
```
Expected: PASS against real HANA.

- [ ] **Step 3: Open PR (do NOT direct-merge)**

Per memory `feedback_pr_over_direct_merge`:
```bash
gh pr create --base main --title "fix(navigator): build-catalog parity, drop unused checkpointMappings, view comment" --body "$(cat <<'EOF'
## Summary
Three follow-ups from PR #65, scoped per Tom's design call (2026-05-26):

- **build-catalog parity** (Tasks 1+2): mirror standalone + nested Group surfacing from /build/navigator into /build/catalog so the Hugo build pipeline matches the runtime navigator
- **drop checkpointMappings** (Task 5): unused plumbing removed — AppSpace renders checkpoints via getEventProgress, not /build/navigator
- **view comment** (Task 7): NavigatorCatalog clarified, not renamed (it's @analytics.exposed)
- **counting bug** (Task 6): mission-card subtitle was using global groupMap.size

## Test plan
- [ ] `npm test` — unit baseline (full suite)
- [ ] `npm run test:hybrid -- test/build-catalog-groups.test.js test/navigator-groups.test.js` (Tom)
- [ ] Local Hugo build with `npm run fetch-tutorials && npm run build` to confirm new /groups/{slug}/ pages emit for standalone groups
- [ ] Post-deploy smoke: `curl https://<dev>/build/catalog | jq '.standaloneGroups | length'` shows expected count

## Out of scope
- Rendering checkpoint markers anywhere — AppSpace already does this via getEventProgress (per design call)
- Renaming NavigatorCatalog — analytics-breaking
EOF
)"
```

---

## Reminders for executors

- DRY: don't re-derive `nestedGroupIds` twice — compute once, reuse.
- YAGNI: no checkpoint surfacing in /build/catalog. No new analytics field.
- TDD: failing test before implementation in every code-touching task.
- Frequent commits: one per task. Don't bundle.
- Never write raw SQL — `cds.ql` only (per CLAUDE.md).
- HANA boolean: `case when col = true` (not bare `case when col`). N/A here but mind it for future.
- Verify CRLF didn't sneak in on Windows after multi-section edits (memory `feedback_crlf_regression_on_windows`).
