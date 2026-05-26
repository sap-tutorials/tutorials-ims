# Navigator: Surface Standalone Groups, Nested Groups & Checkpoints

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three architectural blind spots in `/build/navigator` so that (1) standalone published Groups created in the Admin UI appear as peers of Missions, (2) Groups nested inside Missions (`CompletionPathItems` with `taskType='GROUP'`) expand into their member tutorials with proper `groupId/groupTitle/groupSlug` mappings, and (3) Checkpoints (`taskType='CHECKPOINT'`) surface as visible milestone markers on mission/group landing pages.

**Architecture:** The schema already models all three umbrella types correctly (`Missions`, `Groups`, `Tutorials`) with two parallel item tables (`CompletionPathItems` for Mission→Path→items; `GroupPathItems` for Group→items). The bug is in the **reader**: `srv/lib/navigator-catalog.js` queries only the pre-joined `NavigatorCatalog` view in [db/views.cds:42-61](../../db/views.cds#L42-L61), which inner-joins to `Tutorials` and filters `where item.taskType = 'TUTORIAL'`. The fix keeps that view (no schema risk to the existing tutorial path) and adds two more queries in the handler — one for nested Groups (`CompletionPathItems` with `taskType='GROUP'` joined to `GroupPathItems`) and one for standalone Groups (`Groups.published=true`, plus their `GroupPathItems`). Checkpoints emit as a separate `checkpointMappings` array (not interleaved with `tutorialMappings`) so the existing tutorial prev/next chain logic in [hugo-apps/src/navigator/TutorialNavigator.vue](../../hugo-apps/src/navigator/TutorialNavigator.vue) stays tutorial-only.

The 5-minute in-memory cache (`cachedResponse`/`cacheTimestamp` in [srv/lib/navigator-catalog.js:3-5](../../srv/lib/navigator-catalog.js#L3-L5)) gets a write-invalidation hook so authors don't wait up to 5 minutes after admin saves.

**Tech Stack:** CAP Node.js, CDS QL, Vitest (unit + hybrid). No new entities, no schema migration, no view changes (initially), no new endpoints.

**Spec:** None — investigation captured in this plan's "Background" section.

---

## Background

### Current behaviour (bug)

A Group created in the Admin UI with `Status: ACTIVE` and `Published: true` does not appear in the tutorial navigator (`/build/navigator` → consumed by `TutorialNavigator.vue`). The Mission counter row reads "0 Mission · 0 Group · 1390 Tutorial" even when published Groups exist.

Two reasons:

1. **Standalone Groups are silently invisible.** `srv/lib/navigator-catalog.js` queries only `NavigatorCatalog`, which only walks `CompletionPathItems`. Standalone Groups (Groups not referenced by any Mission's `CompletionPathItems`) live only in `Groups` + `GroupPathItems`, which the navigator never reads.
2. **Nested Groups are dropped.** When a Mission's `CompletionPath` includes a `CompletionPathItems` row with `taskType='GROUP'`, the view's `WHERE item.taskType = 'TUTORIAL'` filter drops it. The navigator never sees the Group, and the tutorials reachable via that Group's `GroupPathItems` get no `groupId/groupTitle/groupSlug` annotation.

Plus: Checkpoints (`taskType='CHECKPOINT'`) are filtered out the same way — Tom wants them visible as milestone markers.

### What the schema actually models

From [db/schema.cds](../../db/schema.cds):

- `Missions` has `published: Boolean default true`, plus a `completionPaths` composition.
- `Groups` has its own `published: Boolean default true`, plus an `items: Composition of many GroupPathItems` and a (legacy) `missions: Association to many Missions on missions.group = $self`.
- `CompletionPathItems` (under a Mission's path) carries `taskType: TUTORIAL|GROUP|CHECKPOINT`, plus discriminated associations: `tutorial`, `group`, and `checkpointTitle: String(255)`.
- `GroupPathItems` is a flat list under a standalone Group: `group + tutorial + itemOrder`. There's no path indirection.

So a tutorial can be navigator-reachable through any of:
- **Path A (existing, working):** Mission → CompletionPath → CompletionPathItems(taskType='TUTORIAL', tutorial → Tutorial)
- **Path B (broken):** Mission → CompletionPath → CompletionPathItems(taskType='GROUP', group → Group) → GroupPathItems(tutorial → Tutorial). Surfaces the tutorial as a member of the nested Group.
- **Path C (broken):** Group(published=true) → GroupPathItems(tutorial → Tutorial). Surfaces the tutorial as a member of a standalone Group, with no Mission.
- **Path D (existing, working — already in `Groups.missions` legacy assoc):** Mission.group → Group, but this is not how new content is authored. Out of scope.

### What the consumer expects

The Vue consumer in [hugo-apps/src/navigator/TutorialNavigator.vue](../../hugo-apps/src/navigator/TutorialNavigator.vue) buckets `tutorialMappings` independently by `missionId` and `groupId`. A tutorial reaches the Group rail if it has `groupId/groupTitle/groupSlug`, regardless of whether it also has `missionId`. Counters (lines 425-432) tally `mission`, `group`, `tutorial` types from the merged item list — so the response just needs `missions[]`, `groups[]`, and `tutorialMappings[]` populated correctly.

This means the response **shape** does not change. The fix is purely in the data the handler returns. We add a small `checkpointMappings[]` array for milestone markers — a new optional field, additive only.

---

## Resolved Open Questions

- **Checkpoint placement:** Checkpoints emit as a **separate `checkpointMappings` array**, not interleaved into `tutorialMappings`. Reason: `tutorialMappings` drives prev/next navigation chains in tutorial pages; mixing in checkpoints would break that. Mission/group landing pages render checkpoints inline as milestone cards. The Vue consumer ignores `checkpointMappings` until U-task adds a renderer (out of scope here, follow-up).
- **`Groups.published` semantics:** The handler filters Groups with `published = true`. Same rule for both standalone Groups and nested Groups (a nested Group with `published=false` collapses — its tutorials are not reachable via the Group rail; if they're in some other path they'll show up elsewhere). Aligns with how `published` is used for Missions.
- **Cache scope:** Single in-memory module-level cache stays per-handler. Write invalidation uses CAP `srv.after` hooks on `AdminService` for the five entities that affect the navigator: `Missions`, `Groups`, `CompletionPaths`, `CompletionPathItems`, `GroupPathItems`. (Not `Tutorials` — slug/title changes there are picked up on next 5-min cycle, which is acceptable.)
- **Sequencing within a path:** `GroupPathItems.itemOrder` and `CompletionPathItems.itemOrder` already sort. We preserve them. When a nested Group expands into `n` tutorials, those tutorials get the **outer** `itemOrder` of the GROUP item — so the Mission-level prev/next sequence walks them in order, then continues to whatever comes after the Group. Inside the Group's own `groupId` rail, they sort by `GroupPathItems.itemOrder`.
- **Build catalog parity:** [srv/lib/build-catalog.js](../../srv/lib/build-catalog.js) has the same `taskType === 'TUTORIAL'` filter at line 41. **Out of scope for this PR.** Hugo build-time catalog runs once and CI re-runs on content changes; bucketed differently. Captured as follow-up.

---

## Pre-flight (already done in this session)

- Worktree set up at `.worktrees/fix-navigator-groups` on branch `fix/navigator-groups` from `60a1ddc`.
- `npm install` complete; native `better-sqlite3` binding copied from parent worktree (Visual Studio not available; npmrc's `ignore-scripts=true` blocks postinstall — see memory `feedback_npm_ignore_scripts_native_modules`).
- `npm run prebuild:parsers-bundle` to populate `srv-qa/lib/parsers.bundle.mjs` so srv-qa unit tests can import `preview-renderer.js`.
- Baseline: `npx vitest run --project=unit` → 825 passing / 30 skipped / 0 failing.

## Pre-flight (do these before Task 1)

These verifications close gaps that could derail later tasks. Do them in order; do not skip.

- [ ] **PF-1: Verify required NOT NULL columns on Tutorials, Groups, Missions, CompletionPaths, CompletionPathItems, GroupPathItems**

```bash
# Inspect required fields and TaskBase aspect — fixtures must satisfy them
grep -nE "^\s*(key |\w+\s*:.*not null|\w+\s*:.*default)" db/schema.cds | grep -iE "Tutorial|Group|Mission|CompletionPath|TaskBase"
```

Use the output to pad the test fixtures in Tasks 1, 3, 5, 7, 8 so INSERTs satisfy NOT NULL constraints. Add explicit `description`, `experienceTag`, `primaryTagRef_ID`, `slug`, `status` values where required. SQLite is permissive; HANA is not — being explicit makes Task 8 (hybrid) painless.

- [ ] **PF-2: Verify the `cds.on('served')` block in `srv/server.js` is unconditional**

```bash
grep -nE "NODE_ENV|cds\.env\.profiles|process\.env\.\w+" srv/server.js | head -40
```

The Task 7 cache-invalidation hook is registered in this block. If the block (or anything inside it) is gated on `NODE_ENV !== 'test'`, the in-memory test in Task 7 Step 3 will silently never invalidate. If gated, hoist the `admin.after(...)` registration out of any `if (NODE_ENV !== 'test')` branch — register it unconditionally, like the existing `served` handler that wires `chatStreamHandler`. Confirm `registerJobs()` is the only thing that must stay gated.

- [ ] **PF-3: Verify TutorialNavigator.vue tolerates the unchanged response shape**

```bash
grep -nE "checkpointMappings|tutorialMappings\[|groups\.find|missions\.find" hugo-apps/src/navigator/TutorialNavigator.vue
```

Confirm the consumer reads `data.tutorialMappings`, `data.groups`, `data.missions` defensively (e.g. `(data.tutorialMappings || [])`). The new `checkpointMappings` field MUST be additive-only — if the consumer code does `Object.keys(data).forEach(...)` or similar, that would change behaviour. If it does, document the consumer change in this plan as a follow-up.

---

## Files Touched

**Modified:**
- [srv/lib/navigator-catalog.js](../../srv/lib/navigator-catalog.js) — add standalone Groups query, nested Groups expansion, checkpoint extraction, exported cache invalidator.
- [srv/server.js](../../srv/server.js) — wire `srv.after` cache-busting hook on AdminService writes (in the existing `cds.on('served')` block).

**Created:**
- `test/navigator-groups.test.js` — unit test (in-memory SQLite) covering all three paths plus the checkpoint surfacing rule.
- `test/hybrid/navigator-groups.test.js` — hybrid test (real HANA via `cds bind --exec`) covering the same paths to catch HANA-vs-SQLite divergence (e.g., LOB, JOIN behaviour, sequence backfill).

**No changes:**
- [db/views.cds](../../db/views.cds) — `NavigatorCatalog` stays as-is. We add JS-side queries beside it instead of mutating the view.
- [db/schema.cds](../../db/schema.cds) — no schema migration.
- [hugo-apps/src/navigator/TutorialNavigator.vue](../../hugo-apps/src/navigator/TutorialNavigator.vue) — response shape unchanged (only newly populated fields). Checkpoint rendering is a follow-up; absent renderer = silently ignored.
- [srv/lib/build-catalog.js](../../srv/lib/build-catalog.js) — explicitly out of scope; follow-up.

---

## Task 1: Failing unit test for standalone Groups

**Files:**
- Create: `test/navigator-groups.test.js`

- [ ] **Step 1: Write the failing test for standalone Groups**

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const TAG_ID       = 'aaaaaaaa-9001-0000-0000-000000000001';
const STANDALONE_GROUP_ID = 'cccccccc-9001-0000-0000-000000000001';
const STANDALONE_TUT1_ID  = 'cccccccc-9001-0000-0000-000000000011';
const STANDALONE_TUT2_ID  = 'cccccccc-9001-0000-0000-000000000012';
const STANDALONE_GPI1_ID  = 'cccccccc-9001-0000-0000-000000000021';
const STANDALONE_GPI2_ID  = 'cccccccc-9001-0000-0000-000000000022';

describe('/build/navigator: standalone Group surfacing', () => {
  beforeAll(async () => {
    const { Tags, Groups, Tutorials, GroupPathItems } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 99001, name: '__TEST__ Standalone Tag' });

    await INSERT.into(Tutorials).entries([
      { ID: STANDALONE_TUT1_ID, legacyId: 99011, title: '__TEST__ Standalone Tut 1', slug: 'test-standalone-tut-1', status: 'ACTIVE' },
      { ID: STANDALONE_TUT2_ID, legacyId: 99012, title: '__TEST__ Standalone Tut 2', slug: 'test-standalone-tut-2', status: 'ACTIVE' },
    ]);

    await INSERT.into(Groups).entries({
      ID: STANDALONE_GROUP_ID, legacyId: 99001,
      title: '__TEST__ Standalone Group', description: 'desc',
      experienceTag: 'beginner', primaryTagRef_ID: TAG_ID,
      published: true, status: 'ACTIVE',
    });

    await INSERT.into(GroupPathItems).entries([
      { ID: STANDALONE_GPI1_ID, legacyId: 99021, group_ID: STANDALONE_GROUP_ID, tutorial_ID: STANDALONE_TUT1_ID, itemOrder: 0 },
      { ID: STANDALONE_GPI2_ID, legacyId: 99022, group_ID: STANDALONE_GROUP_ID, tutorial_ID: STANDALONE_TUT2_ID, itemOrder: 1 },
    ]);
  });

  afterAll(async () => {
    const { Tags, Groups, Tutorials, GroupPathItems } = cds.entities('com.sap.developers.ims');
    await DELETE.from(GroupPathItems).where({ ID: { in: [STANDALONE_GPI1_ID, STANDALONE_GPI2_ID] } });
    await DELETE.from(Groups).where({ ID: STANDALONE_GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [STANDALONE_TUT1_ID, STANDALONE_TUT2_ID] } });
    await DELETE.from(Tags).where({ ID: TAG_ID });
  });

  it('returns the standalone Group in groups[] without a missionId', async () => {
    const { status, data } = await project.get('/build/navigator?nocache=1');
    expect(status).toBe(200);

    const ours = data.groups.find(g => g.id === 99001);
    expect(ours).toBeDefined();
    expect(ours.title).toBe('__TEST__ Standalone Group');
    expect(ours.missionId).toBeFalsy();
  });

  it('emits tutorialMappings for standalone Group tutorials with groupId but no missionId', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    const tut1 = data.tutorialMappings.find(t => t.slug === 'test-standalone-tut-1');
    expect(tut1).toBeDefined();
    expect(tut1.groupId).toBe(99001);
    expect(tut1.groupTitle).toBe('__TEST__ Standalone Group');
    expect(tut1.missionId).toBeFalsy();
  });

  it('preserves itemOrder for prev/next chaining within the standalone Group', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    const tut1 = data.tutorialMappings.find(t => t.slug === 'test-standalone-tut-1');
    const tut2 = data.tutorialMappings.find(t => t.slug === 'test-standalone-tut-2');
    expect(tut1.next).toBe('test-standalone-tut-2');
    expect(tut2.prev).toBe('test-standalone-tut-1');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run --project=unit test/navigator-groups.test.js
```

Expected: 3 failing assertions — `data.groups.find(...)` returns `undefined` because the handler never queries `Groups`/`GroupPathItems`.

- [ ] **Step 3: Commit failing test**

```bash
git add test/navigator-groups.test.js
git commit -m "test(navigator): failing test for standalone Group surfacing"
```

---

## Task 2: Implement standalone Groups query

**Files:**
- Modify: [srv/lib/navigator-catalog.js](../../srv/lib/navigator-catalog.js)

- [ ] **Step 1: Add standalone Groups query alongside the existing NavigatorCatalog query**

Add after the existing `NavigatorCatalog` SELECT (currently at line 18). Pseudocode (adapt to existing variable names):

```js
const { NavigatorCatalog, Groups, GroupPathItems, Tutorials } = cds.entities('com.sap.developers.ims');

const navRows = await SELECT.from(NavigatorCatalog).orderBy('missionId', 'pathId', 'itemOrder');

// All published Groups (standalone or nested — we filter standalone vs nested below)
const groupRows = await SELECT.from(Groups)
  .columns('ID', 'legacyId', 'title')
  .where({ published: true, or: [{ status: 'ACTIVE' }, { status: null }] });

// Their items + tutorials (one query, filter to published Groups only)
const gpiRows = await SELECT.from(GroupPathItems)
  .columns('group_ID', 'itemOrder', 'tutorial_ID')
  .where({ group_ID: { in: groupRows.map(g => g.ID) } })
  .orderBy('group_ID', 'itemOrder');

const tutorialIds = [...new Set(gpiRows.map(r => r.tutorial_ID))];
const tuts = tutorialIds.length
  ? await SELECT.from(Tutorials).columns('ID', 'legacyId', 'slug', 'title').where({ ID: { in: tutorialIds } })
  : [];
const tutById = new Map(tuts.map(t => [t.ID, t]));
```

Note: for SQLite (in-memory test) and HANA, the `Groups.published default true` means rows inserted without an explicit value are `true` — but use the explicit filter regardless to be defensive.

- [ ] **Step 2: Compute which Groups are referenced by a Mission's CompletionPathItems (so we can split standalone vs. nested)**

```js
// Group IDs referenced as nested items in any Mission CompletionPath (taskType='GROUP')
const nestedGroupRefIds = new Set();
{
  const { CompletionPathItems } = cds.entities('com.sap.developers.ims');
  const refs = await SELECT.from(CompletionPathItems)
    .columns('group_ID')
    .where({ taskType: 'GROUP', group_ID: { '!=': null } });
  for (const r of refs) if (r.group_ID) nestedGroupRefIds.add(r.group_ID);
}

const standaloneGroups = groupRows.filter(g => !nestedGroupRefIds.has(g.ID));
```

- [ ] **Step 3: Emit standalone Groups in `groups[]` and their tutorials in `tutorialMappings[]`**

For each standalone Group:
- Push `{ id: legacyId, title, slug: legacyId.toString(), missionId: undefined }` into `groupRefs`.
- For each `GroupPathItems` row in `gpiRows` with that `group_ID`, push a `tutorialMapping` with `slug`, `groupId`, `groupTitle`, `groupSlug`, `missionId: undefined`, `prev`, `next` (computed from itemOrder neighbours).

```js
for (const g of standaloneGroups) {
  const groupSlug = String(g.legacyId);
  groupRefs.push({ id: g.legacyId, title: g.title, slug: groupSlug });

  const items = gpiRows.filter(r => r.group_ID === g.ID);
  const slugs = items
    .map(r => tutById.get(r.tutorial_ID)?.slug)
    .filter(Boolean);

  for (let i = 0; i < slugs.length; i++) {
    tutorialMappings.push({
      slug: slugs[i],
      groupId: g.legacyId,
      groupTitle: g.title,
      groupSlug,
      prev: i > 0 ? slugs[i - 1] : null,
      next: i < slugs.length - 1 ? slugs[i + 1] : null,
    });
  }
}
```

(Adjust to match the existing variable names `missionRefs/groupRefs/tutorialMappings` already in the handler.)

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npx vitest run --project=unit test/navigator-groups.test.js
```

Expected: all three assertions pass.

- [ ] **Step 5: Run the full unit suite to confirm no regressions**

```bash
npx vitest run --project=unit
```

Expected: same baseline (825 passing / 30 skipped) + 3 new passing = 828 passing.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/navigator-catalog.js
git commit -m "feat(navigator): surface standalone published Groups + their tutorials"
```

---

## Task 3: Failing unit test for nested Groups

**Files:**
- Modify: `test/navigator-groups.test.js` (append a new `describe` block)

- [ ] **Step 1: Append failing test for a Mission whose CompletionPath contains a Group**

Within the same test file, add:

```js
describe('/build/navigator: nested Group inside a Mission', () => {
  const NESTED_TAG_ID    = 'aaaaaaaa-9002-0000-0000-000000000001';
  const NESTED_MISSION_ID = '11111111-9002-0000-0000-000000000001';
  const NESTED_PATH_ID    = '22222222-9002-0000-0000-000000000001';
  const NESTED_GROUP_ID   = 'cccccccc-9002-0000-0000-000000000001';
  const NESTED_TUT_ID     = 'cccccccc-9002-0000-0000-000000000011';
  const NESTED_GPI_ID     = 'cccccccc-9002-0000-0000-000000000021';
  const NESTED_CPI_ID     = 'cccccccc-9002-0000-0000-000000000031';

  beforeAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems, Groups, Tutorials, GroupPathItems } =
      cds.entities('com.sap.developers.ims');

    await INSERT.into(Tags).entries({ ID: NESTED_TAG_ID, legacyId: 99002, name: '__TEST__ Nested Tag' });
    await INSERT.into(Tutorials).entries({
      ID: NESTED_TUT_ID, legacyId: 99031, title: '__TEST__ Nested Tut', slug: 'test-nested-tut', status: 'ACTIVE',
    });
    await INSERT.into(Groups).entries({
      ID: NESTED_GROUP_ID, legacyId: 99002, title: '__TEST__ Nested Group',
      description: 'desc', experienceTag: 'beginner', primaryTagRef_ID: NESTED_TAG_ID,
      published: true, status: 'ACTIVE',
    });
    await INSERT.into(GroupPathItems).entries({
      ID: NESTED_GPI_ID, legacyId: 99041, group_ID: NESTED_GROUP_ID, tutorial_ID: NESTED_TUT_ID, itemOrder: 0,
    });
    await INSERT.into(Missions).entries({
      ID: NESTED_MISSION_ID, legacyId: 99002, title: '__TEST__ Nested Mission',
      slug: 'test-nested-mission', description: 'desc', experienceTag: 'beginner',
      primaryTagRef_ID: NESTED_TAG_ID, published: true, status: 'ACTIVE',
    });
    await INSERT.into(CompletionPaths).entries({
      ID: NESTED_PATH_ID, legacyId: 99003,
      mission_ID: NESTED_MISSION_ID, name: '__TEST__ Nested Path', slug: 'test-nested-path',
    });
    await INSERT.into(CompletionPathItems).entries({
      ID: NESTED_CPI_ID, legacyId: 99051,
      path_ID: NESTED_PATH_ID, taskType: 'GROUP',
      group_ID: NESTED_GROUP_ID, taskLegacyId: 99002, itemOrder: 0,
    });
  });

  afterAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems, Groups, Tutorials, GroupPathItems } =
      cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ ID: NESTED_CPI_ID });
    await DELETE.from(CompletionPaths).where({ ID: NESTED_PATH_ID });
    await DELETE.from(Missions).where({ ID: NESTED_MISSION_ID });
    await DELETE.from(GroupPathItems).where({ ID: NESTED_GPI_ID });
    await DELETE.from(Groups).where({ ID: NESTED_GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: NESTED_TUT_ID });
    await DELETE.from(Tags).where({ ID: NESTED_TAG_ID });
  });

  it('emits the nested Group as a member of the Mission', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    const grp = data.groups.find(g => g.id === 99002);
    expect(grp).toBeDefined();
    expect(grp.missionId).toBe(99002);
    expect(grp.title).toBe('__TEST__ Nested Group');
  });

  it('expands the nested Group: tutorial gets BOTH missionId and groupId', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    const tut = data.tutorialMappings.find(t => t.slug === 'test-nested-tut');
    expect(tut).toBeDefined();
    expect(tut.missionId).toBe(99002);
    expect(tut.missionTitle).toBe('__TEST__ Nested Mission');
    expect(tut.groupId).toBe(99002);
    expect(tut.groupTitle).toBe('__TEST__ Nested Group');
  });

  // Defines the merge semantics for the (intentionally edge-case) scenario where a
  // tutorial is referenced BOTH directly under a Mission CompletionPath AND under a
  // nested Group inside the same or a different Mission. We accept duplicate entries
  // in tutorialMappings (one from each path), and document that the Vue consumer's
  // `find(t => t.slug === ...)` returns the first match — so the direct-under-Mission
  // entry (emitted first via NavigatorCatalog) wins for prev/next chaining. If author
  // content needs the Group entry to win, restructure the content (don't dual-place).
  it('allows tutorial to appear in both direct Mission path and nested Group (no merge, both kept)', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    const matches = data.tutorialMappings.filter(t => t.slug === 'test-nested-tut');
    // At least one entry MUST be emitted; if author authors dual-placement, two are acceptable.
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // Whichever entry the consumer's .find() returns first must have the nested Group's groupId
    // (because in this fixture there is no direct-under-Mission CompletionPathItem for this tutorial).
    expect(matches[0].groupId).toBe(99002);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run --project=unit test/navigator-groups.test.js
```

Expected: nested Group assertions fail (the Mission appears, but its `tutorialMappings` is empty because the GROUP item is filtered out by the view, and `groups[]` doesn't include the nested Group).

- [ ] **Step 3: Commit failing test**

```bash
git add test/navigator-groups.test.js
git commit -m "test(navigator): failing test for nested Group expansion inside Mission"
```

---

## Task 4: Implement nested Groups expansion

**Files:**
- Modify: [srv/lib/navigator-catalog.js](../../srv/lib/navigator-catalog.js)

- [ ] **Step 1: Query nested GROUP items separately**

Adapt the existing handler. After loading `navRows` (the `NavigatorCatalog` view rows for `taskType='TUTORIAL'`), add a second query for nested GROUP items:

```js
const { CompletionPathItems, CompletionPaths, Missions } = cds.entities('com.sap.developers.ims');

const nestedGroupItems = await SELECT.from(CompletionPathItems)
  .columns('ID', 'path_ID', 'group_ID', 'itemOrder', 'taskType')
  .where({ taskType: 'GROUP', group_ID: { '!=': null } })
  .orderBy('path_ID', 'itemOrder');
```

(`navRows` already has the path/mission joined; for nested-group rows we need to look up the path and mission separately to avoid mutating the view.)

```js
// Resolve path → mission for each nested group item
const pathIds = [...new Set(nestedGroupItems.map(i => i.path_ID))];
const paths = pathIds.length
  ? await SELECT.from(CompletionPaths).columns('ID', 'legacyId', 'name', 'slug', 'mission_ID').where({ ID: { in: pathIds } })
  : [];
const pathById = new Map(paths.map(p => [p.ID, p]));

const missionIds = [...new Set(paths.map(p => p.mission_ID).filter(Boolean))];
const missions = missionIds.length
  ? await SELECT.from(Missions).columns('ID', 'legacyId', 'title', 'slug', 'published').where({ ID: { in: missionIds }, published: true })
  : [];
const missionById = new Map(missions.map(m => [m.ID, m]));
```

- [ ] **Step 2: Emit nested Group entries and their tutorialMappings**

**Invariant (assert by construction):** A given Group ID appears EITHER in `standaloneGroups` (Task 2) OR is referenced by `nestedGroupRefIds` and reaches the navigator via this nested loop — never both. The Task 2 standalone filter `g => !nestedGroupRefIds.has(g.ID)` enforces this. Do NOT remove that filter without also adding a `groupRefs.find(...)` check across both code paths. A future maintainer who deletes the standalone filter would silently produce duplicate `groups[]` entries.

For each `nestedGroupItem` whose Group is published AND whose Mission is published:

```js
for (const item of nestedGroupItems) {
  const path = pathById.get(item.path_ID);
  if (!path) continue;
  const mission = missionById.get(path.mission_ID);
  if (!mission) continue;                                // unpublished mission filtered above
  const group = groupRows.find(g => g.ID === item.group_ID);
  if (!group) continue;                                  // unpublished or missing group skipped

  const groupSlug = String(group.legacyId);
  // Add to groupRefs. Disjoint-by-construction with standaloneGroups (see invariant above);
  // dedup here only catches the case of the SAME Group nested under multiple Missions —
  // first Mission wins. If multi-mission nesting becomes real, switch to one entry per
  // (group, mission) pair and have the consumer bucket accordingly.
  if (!groupRefs.find(g => g.id === group.legacyId)) {
    groupRefs.push({
      id: group.legacyId,
      title: group.title,
      slug: groupSlug,
      missionId: mission.legacyId,
    });
  }

  // Expand: each GroupPathItems for this group becomes a tutorialMapping with BOTH missionId and groupId
  const groupItems = gpiRows.filter(r => r.group_ID === group.ID);
  const slugs = groupItems
    .map(r => tutById.get(r.tutorial_ID)?.slug)
    .filter(Boolean);

  for (let i = 0; i < slugs.length; i++) {
    tutorialMappings.push({
      slug: slugs[i],
      missionId: mission.legacyId,
      missionTitle: mission.title,
      missionSlug: mission.slug || String(mission.legacyId),
      groupId: group.legacyId,
      groupTitle: group.title,
      groupSlug,
      prev: i > 0 ? slugs[i - 1] : null,
      next: i < slugs.length - 1 ? slugs[i + 1] : null,
    });
  }
}
```

- [ ] **Step 3: Run the failing test to confirm it now passes**

```bash
npx vitest run --project=unit test/navigator-groups.test.js
```

Expected: all 5 tests pass (3 standalone + 2 nested).

- [ ] **Step 4: Run full suite**

```bash
npx vitest run --project=unit
```

Expected: no regressions. Note: the existing standalone Group's first test in Task 1 should still pass — make sure the nested-group code path doesn't accidentally double-count that group as both standalone AND nested.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/navigator-catalog.js
git commit -m "feat(navigator): expand nested Groups inside Mission CompletionPaths"
```

---

## Task 5: Failing test for Checkpoint surfacing

**Files:**
- Modify: `test/navigator-groups.test.js` (append a third `describe` block)

- [ ] **Step 1: Append failing test**

```js
describe('/build/navigator: Checkpoint markers', () => {
  const CP_TAG_ID     = 'aaaaaaaa-9003-0000-0000-000000000001';
  const CP_MISSION_ID = '11111111-9003-0000-0000-000000000001';
  const CP_PATH_ID    = '22222222-9003-0000-0000-000000000001';
  const CP_CPI_ID     = 'cccccccc-9003-0000-0000-000000000031';

  beforeAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: CP_TAG_ID, legacyId: 99003, name: '__TEST__ Checkpoint Tag' });
    await INSERT.into(Missions).entries({
      ID: CP_MISSION_ID, legacyId: 99003, title: '__TEST__ Checkpoint Mission',
      slug: 'test-checkpoint-mission', description: 'desc', experienceTag: 'beginner',
      primaryTagRef_ID: CP_TAG_ID, published: true, status: 'ACTIVE',
    });
    await INSERT.into(CompletionPaths).entries({
      ID: CP_PATH_ID, legacyId: 99004,
      mission_ID: CP_MISSION_ID, name: '__TEST__ Checkpoint Path', slug: 'test-checkpoint-path',
    });
    await INSERT.into(CompletionPathItems).entries({
      ID: CP_CPI_ID, legacyId: 99052,
      path_ID: CP_PATH_ID, taskType: 'CHECKPOINT',
      checkpointTitle: 'Win a coffee mug', itemOrder: 5,
    });
  });

  afterAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ ID: CP_CPI_ID });
    await DELETE.from(CompletionPaths).where({ ID: CP_PATH_ID });
    await DELETE.from(Missions).where({ ID: CP_MISSION_ID });
    await DELETE.from(Tags).where({ ID: CP_TAG_ID });
  });

  it('emits a checkpointMappings array with mission + title + itemOrder', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    expect(Array.isArray(data.checkpointMappings)).toBe(true);
    const cp = data.checkpointMappings.find(c => c.title === 'Win a coffee mug');
    expect(cp).toBeDefined();
    expect(cp.missionId).toBe(99003);
    expect(cp.itemOrder).toBe(5);
  });

  it('does not put checkpoints into tutorialMappings', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    const stray = data.tutorialMappings.find(t => t.slug === 'Win a coffee mug' || t.title === 'Win a coffee mug');
    expect(stray).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
npx vitest run --project=unit test/navigator-groups.test.js
```

Expected: `data.checkpointMappings` is `undefined` → `Array.isArray` false.

- [ ] **Step 3: Commit failing test**

```bash
git add test/navigator-groups.test.js
git commit -m "test(navigator): failing test for checkpointMappings"
```

---

## Task 6: Implement Checkpoint surfacing

**Files:**
- Modify: [srv/lib/navigator-catalog.js](../../srv/lib/navigator-catalog.js)

- [ ] **Step 1: Query CHECKPOINT items**

```js
const checkpointItems = await SELECT.from(CompletionPathItems)
  .columns('path_ID', 'checkpointTitle', 'itemOrder')
  .where({ taskType: 'CHECKPOINT' })
  .orderBy('path_ID', 'itemOrder');
```

- [ ] **Step 2: Build checkpointMappings**

```js
const checkpointMappings = [];
for (const item of checkpointItems) {
  const path = pathById.get(item.path_ID);
  if (!path) continue;
  const mission = missionById.get(path.mission_ID);
  if (!mission) continue;
  if (!item.checkpointTitle) continue;
  checkpointMappings.push({
    title: item.checkpointTitle,
    missionId: mission.legacyId,
    missionTitle: mission.title,
    missionSlug: mission.slug || String(mission.legacyId),
    pathId: path.legacyId,
    pathSlug: path.slug || String(path.legacyId),
    itemOrder: item.itemOrder,
  });
}
```

- [ ] **Step 3: Add to result**

```js
const result = { missions: missionRefs, groups: groupRefs, tutorialMappings, checkpointMappings };
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run --project=unit test/navigator-groups.test.js
npx vitest run --project=unit
```

Expected: all 7 navigator-groups tests pass + 825 baseline + 0 regressions.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/navigator-catalog.js
git commit -m "feat(navigator): emit checkpointMappings as milestone markers"
```

---

## Task 7: Cache invalidation hook on admin writes

**Files:**
- Modify: [srv/lib/navigator-catalog.js](../../srv/lib/navigator-catalog.js) — export an `invalidateNavigatorCache()` function.
- Modify: [srv/server.js](../../srv/server.js) — register `srv.after` hook on AdminService for the five entities.

- [ ] **Step 1: Export the invalidator**

In `navigator-catalog.js`:

```js
export function invalidateNavigatorCache() {
  cachedResponse = null;
  cacheTimestamp = 0;
}
```

(Place near top of file; module-level binding is already there.)

- [ ] **Step 2: Wire `srv.after` hook on AdminService**

In `srv/server.js`, inside the existing `cds.on('served')` block, find `AdminService` and add:

```js
const admin = await cds.connect.to('AdminService');
const navInvalidatingEntities = ['Missions', 'Groups', 'CompletionPaths', 'CompletionPathItems', 'GroupPathItems'];
admin.after(['CREATE', 'UPDATE', 'DELETE'], navInvalidatingEntities, () => {
  try {
    invalidateNavigatorCache();
  } catch (err) {
    console.error('[navigator] cache invalidation failed', err);
  }
});
```

(Confirm the import: add `import { navigatorCatalogHandler, invalidateNavigatorCache } from './lib/navigator-catalog.js';` at top.)

- [ ] **Step 3: Add a unit test for the invalidation hook**

Append to `test/navigator-groups.test.js`:

```js
describe('/build/navigator: cache invalidation on admin writes', () => {
  const INV_TAG_ID    = 'aaaaaaaa-9004-0000-0000-000000000001';
  const INV_GROUP_ID  = 'cccccccc-9004-0000-0000-000000000001';
  const INV_TUT_ID    = 'cccccccc-9004-0000-0000-000000000011';
  const INV_GPI_ID    = 'cccccccc-9004-0000-0000-000000000021';

  beforeAll(async () => {
    const { Tags, Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: INV_TAG_ID, legacyId: 99004, name: '__TEST__ Invalidation Tag' });
    await INSERT.into(Tutorials).entries({
      ID: INV_TUT_ID, legacyId: 99060, title: '__TEST__ Invalidation Tut',
      slug: 'test-invalidation-tut', status: 'ACTIVE',
    });
  });

  afterAll(async () => {
    const { Tags, Tutorials, Groups, GroupPathItems } = cds.entities('com.sap.developers.ims');
    await DELETE.from(GroupPathItems).where({ ID: INV_GPI_ID });
    await DELETE.from(Groups).where({ ID: INV_GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: INV_TUT_ID });
    await DELETE.from(Tags).where({ ID: INV_TAG_ID });
  });

  it('reflects newly inserted Group on next call without ?nocache=1', async () => {
    // First call populates the cache without our group present
    const a = await project.get('/build/navigator');
    expect(a.data.groups.find(g => g.id === 99004)).toBeUndefined();

    // Insert a Group via the AdminService projection (so the after-hook fires)
    const admin = await cds.connect.to('AdminService');
    await admin.run(INSERT.into('AdminService.Groups').entries({
      ID: INV_GROUP_ID, legacyId: 99004,
      title: '__TEST__ Invalidation Group',
      experienceTag: 'beginner', primaryTagRef_ID: INV_TAG_ID,
      published: true, status: 'ACTIVE',
    }));
    await admin.run(INSERT.into('AdminService.GroupPathItems').entries({
      ID: INV_GPI_ID, legacyId: 99070,
      group_ID: INV_GROUP_ID, tutorial_ID: INV_TUT_ID, itemOrder: 0,
    }));

    // Second call (no nocache flag) should reflect the new Group
    const b = await project.get('/build/navigator');
    expect(b.data.groups.find(g => g.id === 99004)).toBeDefined();
  });
});
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run --project=unit test/navigator-groups.test.js
npx vitest run --project=unit
```

Expected: 8 navigator-groups tests pass; full suite green.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/navigator-catalog.js srv/server.js
git commit -m "feat(navigator): bust cache on AdminService Mission/Group/path writes"
```

---

## Task 8: Hybrid (real HANA) integration test

**Files:**
- Create: `test/hybrid/navigator-groups.test.js`

The hybrid test mirrors the unit shape but runs against real HANA via `cds bind --exec` (Tom must be `cf login`'d to DEV space). Hybrid tests catch HANA-specific issues we can't reproduce in SQLite — boolean handling in `WHERE published = true`, JOIN fan-out, sequence-backed `legacyId` defaults.

- [ ] **Step 1: Write the hybrid test**

Pattern from [test/hybrid/views.test.js](../../test/hybrid/views.test.js):

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const HYB_TAG_ID    = 'aaaaaaaa-9999-0000-0000-000000000001';
const HYB_GROUP_ID  = 'cccccccc-9999-0000-0000-000000000001';
const HYB_TUT_ID    = 'cccccccc-9999-0000-0000-000000000011';
const HYB_GPI_ID    = 'cccccccc-9999-0000-0000-000000000021';

describe('navigator: standalone Group surfaces on HANA', () => {
  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') return;
    const { Tags, Groups, Tutorials, GroupPathItems } = cds.entities('com.sap.developers.ims');
    // Pre-clean: protect against legacyId collisions from prior aborted runs.
    // __TEST__ prefix protects names but not legacyIds; HANA sequence-backed IDs
    // would not collide, but legacyId 99099 is hand-picked here and must be free.
    await DELETE.from(GroupPathItems).where({ legacyId: { in: [99097] } });
    await DELETE.from(Groups).where({ or: [{ legacyId: 99099 }, { title: { like: '__TEST__ Hybrid%' } }] });
    await DELETE.from(Tutorials).where({ or: [{ legacyId: 99098 }, { slug: 'test-hybrid-tut' }] });
    await DELETE.from(Tags).where({ legacyId: 99099 });

    await INSERT.into(Tags).entries({ ID: HYB_TAG_ID, legacyId: 99099, name: '__TEST__ Hybrid Tag' });
    await INSERT.into(Tutorials).entries({
      ID: HYB_TUT_ID, legacyId: 99098, title: '__TEST__ Hybrid Tut',
      slug: 'test-hybrid-tut', status: 'ACTIVE',
    });
    await INSERT.into(Groups).entries({
      ID: HYB_GROUP_ID, legacyId: 99099, title: '__TEST__ Hybrid Group',
      experienceTag: 'beginner', primaryTagRef_ID: HYB_TAG_ID,
      published: true, status: 'ACTIVE',
    });
    await INSERT.into(GroupPathItems).entries({
      ID: HYB_GPI_ID, legacyId: 99097,
      group_ID: HYB_GROUP_ID, tutorial_ID: HYB_TUT_ID, itemOrder: 0,
    });
  });

  afterAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') return;
    const { Tags, Groups, Tutorials, GroupPathItems } = cds.entities('com.sap.developers.ims');
    await DELETE.from(GroupPathItems).where({ ID: HYB_GPI_ID });
    await DELETE.from(Groups).where({ ID: HYB_GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: HYB_TUT_ID });
    await DELETE.from(Tags).where({ ID: HYB_TAG_ID });
  });

  it('returns the test Group on /build/navigator (HANA)', async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      return;
    }
    const res = await fetch('http://localhost:4004/build/navigator?nocache=1');
    expect(res.status).toBe(200);
    const data = await res.json();
    const ours = data.groups.find(g => g.id === 99099);
    expect(ours).toBeDefined();
    const tut = data.tutorialMappings.find(t => t.slug === 'test-hybrid-tut');
    expect(tut).toBeDefined();
    expect(tut.groupId).toBe(99099);
  });
});
```

(Honour the existing `test/hybrid/_guard.js` `ALLOW_HYBRID_WRITES=true` requirement — the test no-ops without it. Same `__TEST__` prefix discipline.)

- [ ] **Step 2: Run hybrid suite**

```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- test/hybrid/navigator-groups.test.js
```

(Tom must be `cf login`'d to DEV. If not feasible in CI, this is fine to run locally before merge.)

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/navigator-groups.test.js
git commit -m "test(hybrid): standalone Group surfacing on real HANA"
```

---

## Task 9: Documentation update

**Files:**
- Modify: [docs/developers/architecture/build.md](../../docs/developers/architecture/build.md) — note that `/build/navigator` now surfaces standalone Groups + nested Groups + checkpoints.
- Modify: [docs/developers/operations/testing-endpoints.md](../../docs/developers/operations/testing-endpoints.md) — update `/build/navigator` response shape note (add `checkpointMappings`).

- [ ] **Step 1: Locate and read the build docs**

```bash
grep -n "build/navigator\|navigator-catalog\|NavigatorCatalog" docs/developers/architecture/build.md docs/developers/operations/testing-endpoints.md
```

- [ ] **Step 2: Add a short paragraph** describing the three navigator data paths (existing tutorial path, nested-Group expansion, standalone-Group surfacing) and the new `checkpointMappings` field.

- [ ] **Step 3: Verify VitePress sidebar guard passes**

```bash
npm run docs:build
```

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: navigator now surfaces standalone Groups, nested Groups, checkpoints"
```

---

## Task 10: Open PR

**Files:** none — PR creation only.

- [ ] **Step 1: Push branch**

```bash
git push -u origin fix/navigator-groups
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "fix(navigator): surface standalone Groups, nested Groups, and checkpoints" --body "$(cat <<'EOF'
## Summary

Three architectural blind spots in `/build/navigator`:
- Standalone published Groups (created in Admin UI) were silently invisible — handler queried only `NavigatorCatalog`, which walks `CompletionPathItems` and never sees `GroupPathItems`.
- Groups nested inside a Mission's `CompletionPath` (`taskType='GROUP'`) were dropped by the view's `where item.taskType = 'TUTORIAL'` filter — and the tutorials reachable through them never got `groupId/groupTitle/groupSlug`.
- Checkpoints (`taskType='CHECKPOINT'`) were filtered out the same way; Tom wants them visible as milestone markers.

This PR keeps the existing `NavigatorCatalog` view unchanged and adds JS-side queries in `srv/lib/navigator-catalog.js` for the two missing paths plus a new `checkpointMappings[]` field. Adds a `srv.after` cache-invalidation hook on AdminService writes to `Missions/Groups/CompletionPaths/CompletionPathItems/GroupPathItems` so authors don't wait up to 5 minutes after saving.

`build-catalog.js` (Hugo build-time) has the same blind spots — out of scope here, follow-up.

## Test plan
- [x] Unit: 8 new tests in `test/navigator-groups.test.js` (standalone Groups, nested Groups, checkpoints, cache invalidation)
- [x] Unit baseline: 825 pass / 30 skipped / 0 fail (no regressions)
- [ ] Hybrid: `test/hybrid/navigator-groups.test.js` requires `cf login` to DEV; run locally before merge with `ALLOW_HYBRID_WRITES=true npm run test:hybrid -- test/hybrid/navigator-groups.test.js`
- [ ] Manual smoke after deploy: confirm Test Group from Admin UI appears in `/tutorials/` navigator
EOF
)"
```

Returns the PR URL. Tom reviews; once approved + merged, deploy planning is a separate confirmation per memory `feedback_confirm_deploy_scope`.

---

## Out of Scope (follow-up tickets)

- **`srv/lib/build-catalog.js` parity** — same three fixes for the Hugo build-time catalog. Will affect mission/group landing page rendering at build. Open after this PR merges.
- **TutorialNavigator.vue checkpoint rendering** — `checkpointMappings` is currently silently ignored by the consumer. Follow-up to render checkpoints as milestone cards on Mission/Group landing pages.
- **`db/views.cds` cleanup** — the `WHERE item.taskType = 'TUTORIAL'` filter in `NavigatorCatalog` is now misleading (we route around it). Consider renaming to `NavigatorTutorialItems` or removing the type filter so the view name matches the contract. Defer to a separate cleanup PR.

---

## Remember

- TDD: failing test → minimal implementation → verify → commit, in tight loops.
- DRY: factor `tutById`/`groupRows` lookup helpers if they end up duplicated across nested vs. standalone code paths.
- YAGNI: do not pre-build for a checkpoint renderer that doesn't exist; emit `checkpointMappings` and stop.
- HANA gotchas in scope: bool comparisons (`published = true` not bare `published`); LOB locator expiry irrelevant here (no BLOB columns touched); sequence-backed `legacyId` is fine for inserts because we set `legacyId` explicitly in the test fixtures.
- Frequent commits — one per Task subsection.
