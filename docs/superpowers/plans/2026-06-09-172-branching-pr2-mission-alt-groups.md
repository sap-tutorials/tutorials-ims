# 172 PR 2 — Mission Alt-Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authors can declare alternative tutorials within a mission via the existing Missions admin UI; runtime computes a per-user recommendation; mission side-nav highlights it; all behind `branchingEnabled = false` so prod is unchanged on merge. Author docs ship in this same PR.

> **⚠️ Reviewer addendum (apply before starting — see end of file for details).** PR 2 plan-review found 7 real issues: (1) `ChatSettings` real singleton ID is `00000000-0000-0000-0000-00000000c8a7`, NOT `'singleton'`; (2) `expect.toBeOneOf` is not a built-in matcher; (3) handler must honour `?nocache=1` for tests; (4) `loadProfile`'s `UserMetaData` access path is wrong-shaped (it's key/value); (5) `srv/lib/build-catalog.js` modification missing from "Modify" file list; (6) `makeAltGroupHandler` should resolve entity inside the closure, not capture at registration; (7) single-member alt-group rejection on first CREATE blocks normal admin authoring. **See "Reviewer addendum" section at the end of this plan for corrected snippets.**

**Architecture:** Three additive nullable columns on `CompletionPathItems` and `GroupPathItems` (no new entities). Validation in the AdminService event handler. New auth-aware endpoint `/build/mission/:slug` consumes PR 1's `pickBranch` + `buildUserState`. Hugo mission-side-nav partial gains alt-group chips. Telemetry write per recommendation via `BranchDecisions`.

**Tech Stack:** CDS + Fiori Elements admin annotations (existing), CAP Node.js, vitest unit + hybrid + smoke, Hugo + UI5 web components.

**Spec section refs:** §2.1 (mission/group alt-groups), §4.1 (data model), §5.2.1 (mission detail endpoint), §5.3.1 (mission side-nav rendering), §5.6 (caching/fingerprint), §9.1 row 2, §9.2 PR 2 docs.

**Depends on:** PR 1 merged (`srv/lib/branch/{condition,engine,ranker,user-state}.js`, `BranchDecisions` entity, `ChatSettings.branchingEnabled` flag).

---

## File Structure

**Create (5 files):**
- `srv/lib/branch/loaders.js` — concrete `loadCompletedSlugs/loadCompletedMissionSlugs/loadProfile/loadCentroidBySlug/loadUserCentroid/loadCoCompletions` implementations injected into the engine
- `srv/lib/branch/mission-detail.js` — `/build/mission/:slug` handler: assembles items, groups alt-groups, calls `pickBranch`, writes telemetry, returns JSON
- `srv/handlers/completion-path-items-altgroup.js` — AdminService validator (`altGroupLabel` required when `altGroupKey` non-null; `altCondition` parses; rejects single-member alt-groups)
- `test/build-catalog-mission-detail.test.js` — unit project tests for the new endpoint (auth/anon/flag-off/altgroup grouping)
- `test/hybrid/branch-mission-detail.test.js` — hybrid test against real HANA with `__TEST__alt_<run-id>` fixture

**Modify (7 files):**
- `db/schema.cds` — add `altGroupKey/altGroupLabel/altCondition` to `CompletionPathItems` and `GroupPathItems`
- `app/admin-annotations.cds` — add the three columns to the `CompletionPathItems` LineItem + FieldGroup
- `srv/server.js` — register `app.get('/build/mission/:slug', missionDetailHandler)`
- `srv/admin-service.js` — wire the new validator on `before('CREATE'|'UPDATE')` for `CompletionPathItems` and `GroupPathItems`
- `hugo/layouts/partials/mission-side-nav.html` — render alt-group chip rows when frontmatter has `altGroups`
- `scripts/parsers/cap.ts` — emit alt-group structure into mission frontmatter so Hugo can render it
- `.deploy/mta.yaml` — add `srv/lib/branch/{loaders,mission-detail}.js` and `srv/handlers/completion-path-items-altgroup.js` to the `srv-qa` cp list
- `docs/authors/README.md` (new sub-page) + `docs/developers/architecture/build.md` — author + developer docs

**No new npm dependencies.**

---

## Task 1: Schema additions for alt-groups

**Files:**
- Modify: `db/schema.cds:240-255`

- [ ] **Step 1: Inspect existing entity shapes**

Run: `sed -n '240,255p' D:/projects/tutorials-poc/db/schema.cds`
Expected: `CompletionPathItems` and `GroupPathItems` exactly as shown in the spec §4.1.

- [ ] **Step 2: Add the three nullable columns to `CompletionPathItems`**

In `db/schema.cds` within the `CompletionPathItems` body (after `itemOrder`, before the closing `}`), append:

```cds
  // Issue #172 — branching paths. Items in the same path with the same
  // (altGroupKey, itemOrder) form one alt-group; null on linear backbone items.
  altGroupKey               : String(40);
  altGroupLabel             : String(120);
  altCondition              : String(500);
```

- [ ] **Step 3: Mirror the columns onto `GroupPathItems`**

Within `GroupPathItems` body, append the same three columns:

```cds
  // Issue #172 — branching paths inside a Group's tutorial list.
  altGroupKey               : String(40);
  altGroupLabel             : String(120);
  altCondition              : String(500);
```

- [ ] **Step 4: Run unit tests as a smoke check**

Run: `npx vitest run --project unit`
Expected: green; `cds.test` deploys the new columns to in-memory SQLite.

- [ ] **Step 5: Commit**

```bash
git add db/schema.cds
git commit -m "feat(172): add altGroup{Key,Label,Condition} to CompletionPathItems + GroupPathItems"
```

---

## Task 2: AdminService validator — refuse bad alt-group shapes

**Files:**
- Create: `srv/handlers/completion-path-items-altgroup.js`
- Test: `test/admin-altgroup-validator.test.js`
- Modify: `srv/admin-service.js`

- [ ] **Step 1: Write the failing validator test**

Create `test/admin-altgroup-validator.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { validateAltGroupItem, AltGroupValidationError } from '../srv/handlers/completion-path-items-altgroup.js';

describe('validateAltGroupItem', () => {
  it('passes when altGroupKey is null', () => {
    expect(() => validateAltGroupItem({ altGroupKey: null }, [])).not.toThrow();
  });

  it('passes when all three fields are coherent', () => {
    expect(() => validateAltGroupItem(
      { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'HANA Cloud', altCondition: "profile.deployment == 'cloud'" },
      [
        { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'HANA Cloud' },
        { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'PostgreSQL' },
      ]
    )).not.toThrow();
  });

  it('throws when altGroupKey is set but altGroupLabel is missing', () => {
    expect(() => validateAltGroupItem(
      { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: null },
      []
    )).toThrow(AltGroupValidationError);
  });

  it('throws on alt-group with a single member (likely author error)', () => {
    expect(() => validateAltGroupItem(
      { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'Lonely' },
      [{ path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'Lonely' }]
    )).toThrow(/single-member/);
  });

  it('throws when altCondition is invalid syntax', () => {
    expect(() => validateAltGroupItem(
      { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'X', altCondition: 'this is not valid' },
      [
        { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'X' },
        { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'Y' },
      ]
    )).toThrow(AltGroupValidationError);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run test/admin-altgroup-validator.test.js --project unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the validator**

Create `srv/handlers/completion-path-items-altgroup.js`:

```javascript
// srv/handlers/completion-path-items-altgroup.js
//
// Issue #172 — refuse incoherent alt-group shapes before they hit the DB.
// Wired onto AdminService.CompletionPathItems and AdminService.GroupPathItems
// `before('CREATE'|'UPDATE')` in srv/admin-service.js.

import { parseCondition, ConditionParseError } from '../lib/branch/condition.js';

export class AltGroupValidationError extends Error {
  constructor(message) { super(message); this.name = 'AltGroupValidationError'; }
}

/**
 * Validate one path-item against the rest of its path's items.
 *
 * @param {object} item            — the item being created/updated (post-merge with existing if UPDATE)
 * @param {object[]} siblings      — every other item in the same path (excluding `item`)
 */
export function validateAltGroupItem(item, siblings) {
  if (!item.altGroupKey) return; // linear backbone — nothing to check

  if (!item.altGroupLabel || !item.altGroupLabel.trim()) {
    throw new AltGroupValidationError(
      `altGroupLabel is required when altGroupKey is set (item path=${item.path_ID} order=${item.itemOrder} key=${item.altGroupKey})`
    );
  }

  if (item.altCondition) {
    try { parseCondition(item.altCondition); }
    catch (err) {
      if (err instanceof ConditionParseError) {
        throw new AltGroupValidationError(
          `altCondition does not parse: ${err.message} (path=${item.path_ID} order=${item.itemOrder})`
        );
      }
      throw err;
    }
  }

  // Group-membership check — same path, same itemOrder, same altGroupKey
  const peers = siblings.filter(s =>
    s.path_ID === item.path_ID &&
    s.itemOrder === item.itemOrder &&
    s.altGroupKey === item.altGroupKey
  );
  if (peers.length === 0) {
    throw new AltGroupValidationError(
      `single-member alt-group (path=${item.path_ID} order=${item.itemOrder} key=${item.altGroupKey}) — alt-groups need ≥ 2 members; either add another member or clear altGroupKey`
    );
  }
}

/**
 * CDS event-handler wrapper. Reads sibling items from the DB by path_ID,
 * then delegates to the pure validateAltGroupItem.
 *
 * @param {object} entity   — cds.entities('com.sap.developers.ims').CompletionPathItems
 *                            or .GroupPathItems
 * @param {string} pathFK   — 'path_ID' (CompletionPathItems) or 'group_ID' (GroupPathItems)
 */
export function makeAltGroupHandler(entity, pathFK) {
  return async (req) => {
    const data = req.data;
    if (!data?.altGroupKey) return; // no alt-group declared → nothing to do

    const item = { ...data, path_ID: data[pathFK] || null, itemOrder: data.itemOrder };
    if (!item.path_ID || item.itemOrder == null) return; // partial draft; let CDS report the missing FK

    const cds = (await import('@sap/cds')).default;
    const siblings = await SELECT.from(entity)
      .columns(pathFK, 'itemOrder', 'altGroupKey', 'altGroupLabel')
      .where({ [pathFK]: item.path_ID });

    try {
      validateAltGroupItem(
        { ...item, path_ID: item.path_ID }, // normalise key name for the pure validator
        siblings.filter(s => s[pathFK] === item.path_ID && s.ID !== data.ID).map(s => ({
          ...s, path_ID: s[pathFK]
        }))
      );
    } catch (err) {
      if (err instanceof AltGroupValidationError) {
        return req.reject(400, err.message);
      }
      throw err;
    }
  };
}
```

- [ ] **Step 4: Run the validator tests — verify they pass**

Run: `npx vitest run test/admin-altgroup-validator.test.js --project unit`
Expected: 5 tests pass.

- [ ] **Step 5: Wire the handler into AdminService**

Inspect: `grep -n "this.before\|cds.Service\|module.exports" D:/projects/tutorials-poc/srv/admin-service.js | head -10`

In `srv/admin-service.js`, near the other `this.before('CREATE'|'UPDATE')` registrations, add:

```javascript
import { makeAltGroupHandler } from './handlers/completion-path-items-altgroup.js';

// Issue #172 — refuse incoherent alt-group shapes
this.before(['CREATE', 'UPDATE'], 'CompletionPathItems',
  makeAltGroupHandler(cds.entities('com.sap.developers.ims').CompletionPathItems, 'path_ID'));
this.before(['CREATE', 'UPDATE'], 'GroupPathItems',
  makeAltGroupHandler(cds.entities('com.sap.developers.ims').GroupPathItems, 'group_ID'));
```

(Adjust import style to match the file — `srv/admin-service.js` uses `import` per the existing `import` lines at the top.)

- [ ] **Step 6: Run admin-service tests as smoke**

Run: `npx vitest run test/admin-service.test.js --project unit`
Expected: still green; the handler is a no-op when `altGroupKey` is null (which is the case for every existing test fixture).

- [ ] **Step 7: Commit**

```bash
git add srv/handlers/completion-path-items-altgroup.js test/admin-altgroup-validator.test.js srv/admin-service.js
git commit -m "feat(172): AdminService validator for alt-group coherence"
```

---

## Task 3: AdminService surface — annotations for the new columns

**Files:**
- Modify: `app/admin-annotations.cds` (around line 187–261, the `CompletionPathItems` block)

- [ ] **Step 1: Append column labels to the existing `CompletionPathItems` annotate block**

In `app/admin-annotations.cds`, find:

```
annotate AdminService.CompletionPathItems with {
  taskType        @Common.Label: 'Type'  ...
  ...
  itemOrder       @Common.Label: 'Order';
  ...
};
```

Append (still within the same `annotate ... with { ... }` block, after `itemOrder`):

```cds
  altGroupKey     @Common.Label: 'Alt-group key'
                  @Common.QuickInfo: 'Items in this path with the same (key, order) form a pick-one alt-group. Leave blank for linear backbone.';
  altGroupLabel   @Common.Label: 'Alt-group label'
                  @Common.QuickInfo: 'Display text on the alt-group chip (e.g. "HANA Cloud", "On-prem"). Required when key is set.';
  altCondition    @Common.Label: 'Alt-group condition'
                  @Common.QuickInfo: 'Optional predicate (e.g. profile.deployment == \'cloud\'). When set, runtime evaluates deterministically; when null, the heuristic ranker decides.'
                  @UI.MultiLineText;
```

- [ ] **Step 2: Add the three columns to the `LineItem` and `FieldGroup#TaskDetails`**

Find the existing `LineItem:` array (around line 253–260) and the `FieldGroup#TaskDetails`:

In `FieldGroup#TaskDetails.Data`, after `{ Value: prize_ID }`, add:

```cds
      { Value: altGroupKey },
      { Value: altGroupLabel },
      { Value: altCondition }
```

In `LineItem`, after `{ Value: prize_ID, Label: 'Prize' }`, add:

```cds
    { Value: altGroupKey, Label: 'Alt key' },
    { Value: altGroupLabel, Label: 'Alt label' }
```

(`altCondition` stays in the detail facet only — it's verbose and would crowd the list view.)

- [ ] **Step 3: Build admin-shell to verify the manifest still compiles**

Run: `npm --prefix app/admin-shell run build`
Expected: build completes; no annotation errors.

- [ ] **Step 4: Run the existing admin-annotations test**

Run: `npx vitest run test/admin-annotations.test.js --project unit`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(172): AdminService Mission Path Items — alt-group columns"
```

---

## Task 4: Concrete loaders for the engine

**Files:**
- Create: `srv/lib/branch/loaders.js`
- Test: `test/branch-loaders.test.js`

The engine and ranker take loader functions in deps so they can be unit-tested without a DB. PR 2 introduces the concrete loaders that pull from CAP entities + reuse PR #35's centroid + co-completion modules.

- [ ] **Step 1: Write the failing test**

Create `test/branch-loaders.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { makeBranchLoaders } from '../srv/lib/branch/loaders.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

const USER_ID  = 'aaaaaaaa-9100-0000-0000-000000000001';
const TUT_A_ID = 'aaaaaaaa-9100-0000-0000-000000000010';

describe('makeBranchLoaders', () => {
  beforeAll(async () => {
    const { Users, Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: USER_ID, uuid: 'xsuaa-9100', email: '__TEST__user@example.invalid' });
    await INSERT.into(Tutorials).entries({ ID: TUT_A_ID, legacyId: 99100, slug: '__test__-tut-a', title: '__TEST__ Tut A', status: 'ACTIVE' });
    await INSERT.into(TaskRecords).entries({
      user_ID: USER_ID, taskLegacyId: 99100, taskType: 'TUTORIAL', status: 'COMPLETED',
      modifiedAt: new Date().toISOString(), completionDate: new Date().toISOString()
    });
  });
  afterAll(async () => {
    const { Users, Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TaskRecords).where({ user_ID: USER_ID });
    await DELETE.from(Tutorials).where({ ID: TUT_A_ID });
    await DELETE.from(Users).where({ ID: USER_ID });
  });

  it('loadCompletedSlugs returns slugs for an authenticated user', async () => {
    const loaders = makeBranchLoaders();
    const slugs = await loaders.loadCompletedSlugs({ id: 'xsuaa-9100' });
    expect(slugs).toContain('__test__-tut-a');
  });

  it('loadCompletedSlugs returns [] for anonymous user', async () => {
    const loaders = makeBranchLoaders();
    const slugs = await loaders.loadCompletedSlugs(null);
    expect(slugs).toEqual([]);
  });

  it('loadProfile returns the v1 fixed-vocabulary fields or null', async () => {
    const loaders = makeBranchLoaders();
    const profile = await loaders.loadProfile({ id: 'xsuaa-9100' });
    expect(profile).toMatchObject({
      deployment: expect.toBeOneOf([null, 'cloud', 'onprem']),
    });
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run test/branch-loaders.test.js --project unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement loaders.js**

Create `srv/lib/branch/loaders.js`:

```javascript
// srv/lib/branch/loaders.js
//
// Concrete loaders for the branch engine. Wraps existing user-progress + recommend
// substrate so pickBranch and rankBranches can be wired into HTTP handlers / tools.
//
// Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §4.3, §5.1, §5.6

import cds from '@sap/cds';
import { getUserProgress } from './user-progress.js';
import { computeCoCompletions } from './co-completion.js';
import { getCentroid } from './tutorial-centroid.js';

const LOG = cds.log('branch-loaders');

/**
 * Build the deps object pickBranch + rankBranches consume.
 * `userIdResolver` is optional — falls back to user.id (XSUAA sub).
 */
export function makeBranchLoaders() {
  return {
    async loadCompletedSlugs(user) {
      if (!user) return [];
      const p = await getUserProgress(user, { limit: 1000 });
      return p?.completedSlugs || [];
    },

    async loadCompletedMissionSlugs(user) {
      if (!user) return [];
      const p = await getUserProgress(user, { limit: 1000 });
      return p?.completedMissionSlugs || [];
    },

    async loadProfile(user) {
      if (!user?.id || user.id === 'anonymous') return null;
      try {
        const { Users, UserMetaData } = cds.entities('com.sap.developers.ims');
        const dbUser = await SELECT.one.from(Users).columns('ID').where({ uuid: user.id });
        if (!dbUser?.ID) return null;
        const meta = await SELECT.one.from(UserMetaData).columns('deployment', 'role', 'cloud').where({ user_ID: dbUser.ID });
        return meta || null;
      } catch (err) {
        // PR 6 adds the deployment/role/cloud columns to UserMetaData. Until that ships,
        // SELECT will fail with "column does not exist" — degrade to no-profile so
        // PR 2's deterministic-default + ranker path still works in QA / dev.
        LOG.warn(`loadProfile: ${err.message} — degrading to null profile`);
        return null;
      }
    },

    async loadCentroidBySlug(slug) {
      try {
        const { Tutorials } = cds.entities('com.sap.developers.ims');
        const t = await SELECT.one.from(Tutorials).columns('ID').where({ slug });
        if (!t?.ID) return null;
        return await getCentroid(t.ID);
      } catch { return null; }
    },

    async loadUserCentroid(state) {
      // For v1 we approximate the user's interest centroid from their completed
      // slugs by averaging tutorial centroids. Falls back to null on anonymous
      // or zero-completion users — ranker returns sim=0 in that case.
      const slugs = [...(state?.completedSlugs || [])];
      if (slugs.length === 0) return null;
      const centroids = [];
      for (const slug of slugs.slice(0, 50)) {  // cap work; oldest 50 ignored on huge histories
        const c = await this.loadCentroidBySlug(slug);
        if (c) centroids.push(c);
      }
      if (centroids.length === 0) return null;
      const dim = centroids[0].length;
      const avg = new Array(dim).fill(0);
      for (const c of centroids) for (let i = 0; i < dim; i++) avg[i] += c[i];
      for (let i = 0; i < dim; i++) avg[i] /= centroids.length;
      return avg;
    },

    async loadCoCompletions() {
      return computeCoCompletions();
    },
  };
}
```

- [ ] **Step 4: Run the loader test**

Run: `npx vitest run test/branch-loaders.test.js --project unit`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/branch/loaders.js test/branch-loaders.test.js
git commit -m "feat(172): concrete branch loaders bridging user-progress + recommend"
```

---

## Task 5: Mission detail endpoint `/build/mission/:slug`

**Files:**
- Create: `srv/lib/branch/mission-detail.js`
- Test: `test/build-catalog-mission-detail.test.js`
- Modify: `srv/server.js:146-148` (register the new route)

- [ ] **Step 1: Write the failing endpoint test**

Create `test/build-catalog-mission-detail.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const MISSION_ID    = '11111111-9200-0000-0000-000000000001';
const PATH_ID       = '22222222-9200-0000-0000-000000000001';
const TUT_INTRO_ID  = '33333333-9200-0000-0000-000000000010';
const TUT_HANA_ID   = '33333333-9200-0000-0000-000000000020';
const TUT_PG_ID     = '33333333-9200-0000-0000-000000000030';
const TUT_VERIFY_ID = '33333333-9200-0000-0000-000000000040';

describe('/build/mission/:slug — alt-group grouping', () => {
  beforeAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 99200, title: '__TEST__ Mission', slug: '__test__-mission', published: true
    });
    await INSERT.into(CompletionPaths).entries({
      ID: PATH_ID, legacyId: 99201, mission_ID: MISSION_ID, name: 'Path 1', slug: '__test__-path-1'
    });
    await INSERT.into(Tutorials).entries([
      { ID: TUT_INTRO_ID,  legacyId: 99210, slug: '__test__-intro',  title: 'Intro',  status: 'ACTIVE' },
      { ID: TUT_HANA_ID,   legacyId: 99220, slug: '__test__-hana',   title: 'HANA',   status: 'ACTIVE' },
      { ID: TUT_PG_ID,     legacyId: 99230, slug: '__test__-pg',     title: 'PG',     status: 'ACTIVE' },
      { ID: TUT_VERIFY_ID, legacyId: 99240, slug: '__test__-verify', title: 'Verify', status: 'ACTIVE' },
    ]);
    await INSERT.into(CompletionPathItems).entries([
      { ID: '44444444-9200-0000-0000-000000000010', legacyId: 99250, path_ID: PATH_ID, taskType: 'TUTORIAL', tutorial_ID: TUT_INTRO_ID,  itemOrder: 0 },
      { ID: '44444444-9200-0000-0000-000000000020', legacyId: 99251, path_ID: PATH_ID, taskType: 'TUTORIAL', tutorial_ID: TUT_HANA_ID,   itemOrder: 1, altGroupKey: 'deployment', altGroupLabel: 'HANA Cloud', altCondition: "profile.deployment == 'cloud'" },
      { ID: '44444444-9200-0000-0000-000000000030', legacyId: 99252, path_ID: PATH_ID, taskType: 'TUTORIAL', tutorial_ID: TUT_PG_ID,     itemOrder: 1, altGroupKey: 'deployment', altGroupLabel: 'PostgreSQL' },
      { ID: '44444444-9200-0000-0000-000000000040', legacyId: 99253, path_ID: PATH_ID, taskType: 'TUTORIAL', tutorial_ID: TUT_VERIFY_ID, itemOrder: 2 },
    ]);
  });
  afterAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ path_ID: PATH_ID });
    await DELETE.from(CompletionPaths).where({ ID: PATH_ID });
    await DELETE.from(Missions).where({ ID: MISSION_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [TUT_INTRO_ID, TUT_HANA_ID, TUT_PG_ID, TUT_VERIFY_ID] } });
  });

  it('returns 200 and groups alt-group items into a single altGroup record', async () => {
    const { status, data } = await project.get('/build/mission/__test__-mission?nocache=1');
    expect(status).toBe(200);
    expect(data.missionSlug).toBe('__test__-mission');
    expect(data.items).toHaveLength(3); // intro, altGroup, verify
    const altGroup = data.items.find(i => i.type === 'altGroup');
    expect(altGroup).toBeDefined();
    expect(altGroup.groupKey).toBe('deployment');
    expect(altGroup.branches.map(b => b.key).sort()).toEqual(['hana-cloud', 'postgresql']); // labels are slugified for keys
    expect(altGroup.recommendation).toBeDefined();
  });

  it('omits the recommendation field when branchingEnabled is false', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    const before = await SELECT.one.from(ChatSettings);
    await UPSERT.into(ChatSettings).entries({ ID: before?.ID || 'singleton', branchingEnabled: false });

    const { data } = await project.get('/build/mission/__test__-mission?nocache=1');
    const altGroup = data.items.find(i => i.type === 'altGroup');
    expect(altGroup.recommendation).toBeUndefined();
  });

  it('returns 404 for unknown slug', async () => {
    const res = await project.get('/build/mission/does-not-exist').catch(e => e);
    expect(res.response?.status || res.status).toBe(404);
  });

  it('anonymous user gets a deterministic-default recommendation when flag is on', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: 'singleton', branchingEnabled: true });

    const { data } = await project.get('/build/mission/__test__-mission?nocache=1');
    const altGroup = data.items.find(i => i.type === 'altGroup');
    expect(altGroup.recommendation.reason.kind).toBe('default');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run test/build-catalog-mission-detail.test.js --project unit`
Expected: FAIL — endpoint returns 404 (not yet registered).

- [ ] **Step 3: Implement the handler**

Create `srv/lib/branch/mission-detail.js`:

```javascript
// srv/lib/branch/mission-detail.js
//
// /build/mission/:slug — auth-aware mission catalog with alt-group recommendations.
// Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §5.2.1, §5.6

import cds from '@sap/cds';
import { pickBranch } from './engine.js';
import { rankBranches } from './ranker.js';
import { buildUserState, fingerprintUserState } from './user-state.js';
import { makeBranchLoaders } from './loaders.js';

const LOG = cds.log('build-mission-detail');

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 1024;
const cache = new Map(); // key → { value, at }

export function __resetCacheForTest() { cache.clear(); }

/**
 * Slugify a label into a branch key. Stable + URL-safe.
 * Matches the spec's expectation that authors don't have to write the key
 * themselves — the slug of the label is derived deterministically.
 */
function slugifyKey(label) {
  return String(label).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export async function missionDetailHandler(req, res) {
  const slug = req.params.slug;
  const user = req.user?.id && req.user.id !== 'anonymous' ? req.user : null;

  try {
    const { ChatSettings, Missions, CompletionPaths, CompletionPathItems, Tutorials } =
      cds.entities('com.sap.developers.ims');

    const settings = await SELECT.one.from(ChatSettings).columns('branchingEnabled');
    const flagOn = !!settings?.branchingEnabled;

    const mission = await SELECT.one.from(Missions).where({ slug });
    if (!mission) return res.status(404).json({ error: 'mission_not_found' });

    const paths = await SELECT.from(CompletionPaths).where({ mission_ID: mission.ID });
    if (paths.length === 0) return res.json({ missionSlug: slug, items: [] });

    // For v1 we render the FIRST path only (matches today's mission-side-nav rendering).
    const path = paths[0];
    const items = await SELECT.from(CompletionPathItems)
      .where({ path_ID: path.ID })
      .orderBy('itemOrder');

    const tutorialById = await loadTutorialMap(Tutorials, items);

    // Build userState only when the flag is on AND the user is authenticated;
    // anonymous + flag-off both bypass loaders entirely.
    let userState = null;
    let cacheKey = null;
    if (flagOn) {
      const loaders = makeBranchLoaders();
      userState = await buildUserState(user, loaders);
      cacheKey = `${slug}:${user?.id || 'anon'}:${fingerprintUserState(userState)}`;
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.json(hit.value);
    }

    const out = { missionSlug: slug, items: [] };

    // Group items by (altGroupKey, itemOrder). Linear backbone items have key=null.
    const grouped = groupByAlt(items);

    for (const g of grouped) {
      if (g.altGroupKey == null) {
        const item = g.items[0];
        const tut = tutorialById.get(item.tutorial_ID);
        out.items.push({ type: 'tutorial', slug: tut?.slug || null, title: tut?.title || null });
        continue;
      }

      const branches = g.items.map(i => {
        const tut = tutorialById.get(i.tutorial_ID);
        return {
          key: slugifyKey(i.altGroupLabel),
          label: i.altGroupLabel,
          condition: i.altCondition || null,
          embeddingHint: tut?.slug || null,
          tutorialSlug: tut?.slug || null,
          tutorialTitle: tut?.title || null,
        };
      });

      const altGroupRecord = {
        type: 'altGroup',
        groupKey: g.altGroupKey,
        branches: branches.map(({ embeddingHint, ...keep }) => keep), // don't leak hint downstream
      };

      if (flagOn) {
        const loaders = makeBranchLoaders();
        const branchPoint = { id: `${slug}:${g.altGroupKey}:${g.items[0].itemOrder}`, surface: 'missionAltGroup', branches };
        const decision = await pickBranch(branchPoint, userState, { missionSlug: slug }, {
          rankBranches: (bp, st, ctx) => rankBranches(bp, st, ctx, loaders),
        });
        altGroupRecord.recommendation = {
          picked: decision.picked,
          reason: decision.reason,
          confidence: decision.confidence,
        };
        await writeBranchDecision({
          user, slug, branchPointId: branchPoint.id, decision,
          surface: 'missionAltGroup', source: 'pageLoad',
        });
      }

      out.items.push(altGroupRecord);
    }

    if (cacheKey) storeCache(cacheKey, out);
    res.json(out);

  } catch (err) {
    LOG.error('missionDetailHandler', err);
    res.status(500).json({ error: 'mission_detail_failed' });
  }
}

async function loadTutorialMap(Tutorials, items) {
  const ids = [...new Set(items.map(i => i.tutorial_ID).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await SELECT.from(Tutorials).columns('ID', 'slug', 'title').where({ ID: { in: ids } });
  return new Map(rows.map(t => [t.ID, t]));
}

function groupByAlt(items) {
  const out = [];
  const seenKey = new Map(); // `${order}:${altKey}` → groupIndex
  for (const it of items) {
    if (!it.altGroupKey) {
      out.push({ altGroupKey: null, itemOrder: it.itemOrder, items: [it] });
      continue;
    }
    const k = `${it.itemOrder}:${it.altGroupKey}`;
    if (seenKey.has(k)) {
      out[seenKey.get(k)].items.push(it);
    } else {
      seenKey.set(k, out.length);
      out.push({ altGroupKey: it.altGroupKey, itemOrder: it.itemOrder, items: [it] });
    }
  }
  return out;
}

async function writeBranchDecision({ user, slug, branchPointId, decision, surface, source }) {
  try {
    const { BranchDecisions, Users } = cds.entities('com.sap.developers.ims');
    let userIdInternal = null;
    if (user?.id) {
      const u = await SELECT.one.from(Users).columns('ID').where({ uuid: user.id });
      userIdInternal = u?.ID || null;
    }
    await INSERT.into(BranchDecisions).entries({
      user_ID: userIdInternal,
      surface,
      missionSlug: slug,
      tutorialSlug: null,
      branchPointId,
      recommendedKey: decision.picked,
      chosenKey: null,
      recommendationKind: decision.reason.kind,
      confidence: decision.confidence,
      source,
      followedRecommendation: null,
    });
  } catch (err) {
    LOG.warn(`BranchDecisions write failed: ${err.message}`);
  }
}

function storeCache(key, value) {
  cache.set(key, { value, at: Date.now() });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}
```

- [ ] **Step 4: Register the route in srv/server.js**

Inspect: `sed -n '146,150p' D:/projects/tutorials-poc/srv/server.js`

Add a new line right after `app.get('/build/co-completions', ...)`:

```javascript
import { missionDetailHandler } from './lib/branch/mission-detail.js';

// (in the bootstrap registration block, alongside other build/* routes)
app.get('/build/mission/:slug', missionDetailHandler);
```

- [ ] **Step 5: Run the endpoint test**

Run: `npx vitest run test/build-catalog-mission-detail.test.js --project unit`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/branch/mission-detail.js test/build-catalog-mission-detail.test.js srv/server.js
git commit -m "feat(172): /build/mission/:slug auth-aware endpoint with alt-group recommendation"
```

---

## Task 6: Hugo mission frontmatter — emit altGroups

**Files:**
- Modify: `scripts/parsers/cap.ts`

The Hugo build today writes `groups: [{ tutorials: [...] }]` into mission frontmatter. PR 2 adds an optional `altGroups: [{ groupKey, branches: [{ key, label, tutorialSlug, condition? }] }]` so the partial can render chip rows.

- [ ] **Step 1: Inspect what cap.ts emits today**

Run: `grep -n "groups:\|altGroup\|/build/catalog" D:/projects/tutorials-poc/scripts/parsers/cap.ts`

- [ ] **Step 2: Extend the catalog fetch + frontmatter emission**

In `scripts/parsers/cap.ts`, find the function that fetches `/build/catalog` and emits per-mission frontmatter. Today it derives `groups` from `hierarchies`. Update it so that when an item carries `altGroupKey`/`altGroupLabel`, the parser groups them into a sibling `altGroups` array on the mission frontmatter:

```typescript
// scripts/parsers/cap.ts — inside the per-mission emit loop

// New: collect alt-groups within each path
const altGroups: Array<{ groupKey: string; branches: Array<{ key: string; label: string; tutorialSlug: string; condition: string | null }> }> = [];
const seenAltKeys = new Map<string, number>();
for (const it of pathItems) {
  if (!it.altGroupKey) continue;
  const k = `${it.itemOrder}:${it.altGroupKey}`;
  const branch = {
    key: slugifyKey(it.altGroupLabel || ''),
    label: it.altGroupLabel || '',
    tutorialSlug: it.tutorialSlug || '',
    condition: it.altCondition || null,
  };
  if (seenAltKeys.has(k)) {
    altGroups[seenAltKeys.get(k)!].branches.push(branch);
  } else {
    seenAltKeys.set(k, altGroups.length);
    altGroups.push({ groupKey: it.altGroupKey, branches: [branch] });
  }
}

// Emit altGroups alongside groups in the mission frontmatter
const frontmatter = {
  /* existing fields */
  groups,
  ...(altGroups.length ? { altGroups } : {}),
};

function slugifyKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
```

If `cap.ts` doesn't currently fetch the alt-group columns, also extend the `/build/catalog` payload (in `srv/lib/build-catalog.js`) to include them on path items, OR have `cap.ts` make a second call to the new `/build/mission/:slug` with `branchingEnabled = false` (deterministic shape, no recommendations) and pull from there. Simpler: update `build-catalog.js` to include the columns on its `items[]` array (additive, no breaking change).

- [ ] **Step 3: Verify the Hugo fetch step picks it up**

Run: `npm run fetch-tutorials`
Expected: completes without error; if any pilot mission has alt-groups seeded, its generated frontmatter (under `hugo/content/missions/`) shows the `altGroups` array.

- [ ] **Step 4: Commit**

```bash
git add scripts/parsers/cap.ts srv/lib/build-catalog.js
git commit -m "feat(172): emit altGroups into mission frontmatter at build time"
```

---

## Task 7: Hugo partial — render alt-group chips

**Files:**
- Modify: `hugo/layouts/partials/mission-side-nav.html`

- [ ] **Step 1: Re-read the current partial to see the loop structure**

Run: `cat D:/projects/tutorials-poc/hugo/layouts/partials/mission-side-nav.html`

- [ ] **Step 2: Render alt-groups under the same `<ui5-side-navigation>`**

Update `hugo/layouts/partials/mission-side-nav.html`. After the existing `{{ range .Params.groups }}…{{ end }}` block, insert:

```hugo
        {{ if .Params.altGroups }}
          {{ range .Params.altGroups }}
            <ui5-side-navigation-item
              text="{{ .groupKey | humanize }}"
              data-altgroup-parent="{{ .groupKey }}">
              {{ range .branches }}
                <ui5-side-navigation-sub-item
                  text="{{ .label }}"
                  href="/tutorials/{{ .tutorialSlug }}/"
                  data-tutorial-slug="{{ .tutorialSlug }}"
                  data-altgroup-key="{{ $.groupKey }}"
                  data-altgroup-branch-key="{{ .key }}"
                  data-progress="0"
                  {{ if eq .tutorialSlug $current }}selected{{ end }}>
                </ui5-side-navigation-sub-item>
              {{ end }}
            </ui5-side-navigation-item>
          {{ end }}
        {{ end }}
```

The runtime hydration script (which highlights the AI's pick + persists localStorage) lands in a separate hugo-apps island in PR 3 to keep this PR backend-leaning. For now, the static render shows all branches without highlighting — exactly the spec-approved "branchingEnabled=false" rendering.

- [ ] **Step 3: Build Hugo locally to spot-check rendering**

Run:
```bash
npm run fetch-tutorials
npm run dev
```

Open `http://localhost:1313/tutorials/<a-tutorial-in-a-mission-with-alt-groups>/` (after a pilot mission has been seeded). Visually confirm both branches appear under a parent label. (For PR 2, this is OK to skip if there's no seeded fixture — Task 8's hybrid test covers the data shape.)

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/partials/mission-side-nav.html
git commit -m "feat(172): mission-side-nav renders altGroups (chips, no AI highlight yet)"
```

---

## Task 8: Hybrid test — real HANA round-trip

**Files:**
- Create: `test/hybrid/branch-mission-detail.test.js`

Per [[feedback_hana_boolean_case_when]] and the HANA LOB locator gotcha in CLAUDE.md, hybrid tests catch SQL drift the SQLite path silently tolerates.

- [ ] **Step 1: Set up the hybrid test file**

Create `test/hybrid/branch-mission-detail.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const project = cds.test.in(__dirname).profile('hybrid');

const RUN_ID    = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PREFIX    = `__TEST__alt_${RUN_ID}`;
const MISSION_ID = `aaaaaaaa-9300-0000-0000-${RUN_ID.slice(0, 12).padEnd(12, '0')}`;
const PATH_ID    = `bbbbbbbb-9300-0000-0000-${RUN_ID.slice(0, 12).padEnd(12, '0')}`;
const TUT_A_ID   = `cccccccc-9300-0000-0000-${RUN_ID.slice(0, 12).padEnd(12, '0')}`;
const TUT_B_ID   = `cccccccc-9301-0000-0000-${RUN_ID.slice(0, 12).padEnd(12, '0')}`;

describe('hybrid: /build/mission/:slug alt-group on real HANA', () => {
  beforeAll(async () => {
    if (!isSafeForWrites()) throw new Error('refusing to write to a prod-shaped target');
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') return; // skip silently per project convention

    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries([
      { ID: TUT_A_ID, legacyId: 99300, slug: `${PREFIX}-tut-a`, title: `${PREFIX} Tut A`, status: 'ACTIVE' },
      { ID: TUT_B_ID, legacyId: 99301, slug: `${PREFIX}-tut-b`, title: `${PREFIX} Tut B`, status: 'ACTIVE' },
    ]);
    await INSERT.into(Missions).entries({ ID: MISSION_ID, legacyId: 99302, title: `${PREFIX} Mission`, slug: `${PREFIX}-mission`.toLowerCase(), published: true });
    await INSERT.into(CompletionPaths).entries({ ID: PATH_ID, legacyId: 99303, mission_ID: MISSION_ID, name: 'P1', slug: `${PREFIX}-p1`.toLowerCase() });
    await INSERT.into(CompletionPathItems).entries([
      { ID: `dddddddd-9300-0000-0000-${RUN_ID.slice(0, 12).padEnd(12, '0')}`, legacyId: 99310, path_ID: PATH_ID, taskType: 'TUTORIAL', tutorial_ID: TUT_A_ID, itemOrder: 0, altGroupKey: 'deployment', altGroupLabel: 'A' },
      { ID: `dddddddd-9301-0000-0000-${RUN_ID.slice(0, 12).padEnd(12, '0')}`, legacyId: 99311, path_ID: PATH_ID, taskType: 'TUTORIAL', tutorial_ID: TUT_B_ID, itemOrder: 0, altGroupKey: 'deployment', altGroupLabel: 'B' },
    ]);
  });
  afterAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') return;
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ path_ID: PATH_ID });
    await DELETE.from(CompletionPaths).where({ ID: PATH_ID });
    await DELETE.from(Missions).where({ ID: MISSION_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [TUT_A_ID, TUT_B_ID] } });
  });

  it.skipIf(process.env.ALLOW_HYBRID_WRITES !== 'true')(
    'returns alt-group recommendation on a real HANA round-trip',
    async () => {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      await UPSERT.into(ChatSettings).entries({ ID: 'singleton', branchingEnabled: true });

      const { status, data } = await project.get(`/build/mission/${PREFIX.toLowerCase()}-mission`);
      expect(status).toBe(200);
      const altGroup = data.items.find(i => i.type === 'altGroup');
      expect(altGroup).toBeDefined();
      expect(altGroup.recommendation).toBeDefined();
      // No SELECT alongside BLOB — TutorialEmbedding read happens via getCentroid raw SQL only
    }
  );
});
```

- [ ] **Step 2: Run the hybrid suite (requires `cf login` to DEV)**

```bash
ALLOW_HYBRID_WRITES=true npx vitest run --project hybrid test/hybrid/branch-mission-detail.test.js
```

Expected: 1 test passes. If you don't have a hybrid binding handy, the `it.skipIf` keeps CI green; the suite still runs in deploy CI.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/branch-mission-detail.test.js
git commit -m "test(172): hybrid alt-group round-trip on real HANA"
```

---

## Task 9: srv-qa cp list registration

**Files:**
- Modify: `.deploy/mta.yaml`

- [ ] **Step 1: Add the new files to the cp invocation**

In the existing `tutorials-srv-qa` `bash -c "mkdir -p srv/jobs && mkdir -p srv/handlers && mkdir -p srv/lib/branch && cp ..."` line, extend the list to include the new files:

```
mkdir -p srv/jobs && mkdir -p srv/handlers && mkdir -p srv/lib/branch && cp ../../srv/lib/branch/condition.js ../../srv/lib/branch/engine.js ../../srv/lib/branch/ranker.js ../../srv/lib/branch/user-state.js ../../srv/lib/branch/loaders.js ../../srv/lib/branch/mission-detail.js srv/lib/branch/ && cp ../../srv/handlers/completion-path-items-altgroup.js srv/handlers/ && cp ../../srv/lib/content-store.js …
```

- [ ] **Step 2: Verify**

```bash
grep -E "branch/(loaders|mission-detail)\.js|completion-path-items-altgroup" D:/projects/tutorials-poc/.deploy/mta.yaml | wc -l
```

Expected: ≥ 3 hits (one for each file).

- [ ] **Step 3: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "chore(172): register PR 2 srv files in srv-qa cp list"
```

---

## Task 10: Author + developer documentation

**Files:**
- Create: `docs/authors/branched-missions.md`
- Modify: `docs/authors/README.md` (add link)
- Modify: `docs/developers/architecture/build.md` (schema + endpoint diff)
- Modify: `docs/.vitepress/config.ts` (sidebar — registers the new page)

- [ ] **Step 1: Author guide — `docs/authors/branched-missions.md`**

Create the file with:

```markdown
# Authoring branched missions

> **Audience:** Mission curators editing missions in the admin UI at `/admin-ui/#missions`.
> **Status:** v1 (issue #172). Step-level branches inside individual tutorials are covered in [Authoring branched tutorials](./branched-tutorials.md) (PR 3, separate doc).

A mission is a sequence of tutorials. Most are **linear** — the learner does each in order. **Alt-groups** let you offer an alternative within a mission: the learner picks one of N tutorials at the same position, then continues on the linear backbone.

The classic example is a deployment fork:

> Tutorial 1 → Tutorial 2 → **Pick one: HANA Cloud or PostgreSQL** → Tutorial 4 → Tutorial 5

Both branches reach the same goal; the learner only needs to do one.

## How to author an alt-group

1. Open `/admin-ui/#missions` and select your mission.
2. Open the Path containing the items.
3. For each tutorial that should be part of the alt-group, set:
   - **Alt-group key** — a short identifier shared across the alt-group's members. Example: `deployment`. Letters, digits, dashes only.
   - **Alt-group label** — display text on the chip. Example: `HANA Cloud`. Required when key is set.
   - **Order** — the same value for every member of the alt-group. (This is how the system identifies them as alternatives.)
4. *(Optional)* **Alt-group condition** — a predicate that, when it evaluates true, causes the system to recommend this branch automatically.

That's it — save and the next build picks it up.

## Conditions (optional)

Predicates are tiny — only the following forms are allowed:

| Form | Example |
|---|---|
| `completed:<slug>` | `completed:node-getting-started` |
| `completedMission:<slug>` | `completedMission:btp-cap-onboarding` |
| `profile.<field> == '<value>'` | `profile.deployment == 'cloud'` |
| `profile.<field> in ['<a>','<b>']` | `profile.role in ['developer','architect']` |

You can combine with `&&` (or the keyword `and`), negate with `!`, and group with parentheses:

```
profile.deployment == 'cloud' && !completed:hana-intro
```

The profile fields are a fixed v1 vocabulary: `deployment`, `role`, `cloud`. New fields require a schema change.

If a learner's state matches **any** branch's condition, that branch is the recommendation. If multiple match, the **first** declared (lowest itemOrder; ties resolved by record ID) wins. If none match, the runtime ranker picks based on the learner's interest (their completed-tutorial centroid).

## What the learner sees

In the mission side-nav, alt-groups appear as a chip row:

```
Mission: BTP CAP onboarding
  ▸ Intro
  ▸ Getting started
  ▾ Deployment:  [HANA Cloud  ★]  [PostgreSQL]
  ▸ Verify
```

The recommended chip (★) is highlighted, but **all branches are always selectable** — the learner can override.

## Validation rules

The admin UI rejects bad shapes before they save:

- An alt-group with **only one member** — alt-groups need ≥ 2.
- A condition that doesn't parse — you'll see a validation error referencing the line.
- An alt-group label without a key (or vice versa).

## Limits in v1

- **No nested alt-groups.** Alt-groups can't contain alt-groups.
- **No branch-to-mission joins.** A branch can't link to a different mission's content.
- **Profile vocabulary is fixed.** New profile fields require a code change.

These are all open in v2 — file an issue if you need them.

## See also

- [Branching paths design (issue #172)](../../superpowers/specs/2026-06-09-172-branching-paths-design.md)
- Step-level branches inside one tutorial — [Authoring branched tutorials](./branched-tutorials.md) (lands in PR 3)
- Branching cookbook with copy-paste examples — [docs/authors/branching-cookbook.md](./branching-cookbook.md) (lands after PR 3)
```

- [ ] **Step 2: Add a link from the authors README**

In `docs/authors/README.md`, find the existing topic list and add:

```markdown
- [Authoring branched missions](./branched-missions.md) — pick-one alternatives within a mission (issue #172)
```

- [ ] **Step 3: Update the developer architecture doc**

In `docs/developers/architecture/build.md`, append a section:

```markdown
## Branching paths (issue #172)

Mission curators can declare **alt-groups** on `CompletionPathItems` / `GroupPathItems`. At build time, `scripts/parsers/cap.ts` emits an optional `altGroups` array on mission frontmatter alongside `groups`. At runtime, the auth-aware endpoint `GET /build/mission/:slug`:

1. groups items by `(altGroupKey, itemOrder)` within each path
2. for each alt-group, calls `srv/lib/branch/engine.js#pickBranch` with the user's frozen `userState`
3. caches the response per `(slug, userId, fingerprint)` for 5 min
4. writes one `BranchDecisions` row per recommendation (telemetry; surface=`missionAltGroup`, source=`pageLoad`)

The whole runtime is gated by `ChatSettings.branchingEnabled` — when false, the endpoint returns the catalog without the `recommendation` field. See [the design doc](../../superpowers/specs/2026-06-09-172-branching-paths-design.md) §5.2.1, §5.6.
```

- [ ] **Step 4: Register the new author page in the VitePress sidebar**

The project enforces a `predocs:build` check that rejects unregistered pages. Open `docs/.vitepress/config.ts` and add `branched-missions.md` under the authors sidebar entry. The exact place is whatever array `Authors > …` is in.

Run: `npm run docs:build`
Expected: success; no "unregistered page" errors.

- [ ] **Step 5: Commit**

```bash
git add docs/authors/branched-missions.md docs/authors/README.md docs/developers/architecture/build.md docs/.vitepress/config.ts
git commit -m "docs(172): authoring guide for branched missions + dev architecture diff"
```

---

## Task 11: Final-branch sanity, smoke, push, PR

- [ ] **Step 1: Run the full unit project**

Run: `npx vitest run --project unit`
Expected: green; new files contribute ~13 tests; no regressions.

- [ ] **Step 2: Run the build smoke test**

Run: `npx vitest run --project smoke test/smoke/catalog-pages.test.js`
Expected: still green — `/build/catalog` shape did not change (alt-group columns are additive on items).

- [ ] **Step 3: Verify no LF→CRLF regression**

Run:
```bash
file D:/projects/tutorials-poc/srv/lib/branch/loaders.js \
     D:/projects/tutorials-poc/srv/lib/branch/mission-detail.js \
     D:/projects/tutorials-poc/srv/handlers/completion-path-items-altgroup.js \
     D:/projects/tutorials-poc/test/build-catalog-mission-detail.test.js
```
Expected: all "ASCII text" or "UTF-8 text" — never CRLF.

- [ ] **Step 4: Verify all new files are in srv-qa cp list**

Run:
```bash
for f in branch/loaders branch/mission-detail; do
  grep -q "$f.js" D:/projects/tutorials-poc/.deploy/mta.yaml || echo "MISSING: $f"
done
grep -q "completion-path-items-altgroup" D:/projects/tutorials-poc/.deploy/mta.yaml || echo "MISSING: validator"
```
Expected: no output.

- [ ] **Step 5: Push the branch and open the PR**

```bash
git push -u origin feat/172-branching-paths-design

gh pr create \
  --title "feat(172): mission alt-groups — schema, endpoint, side-nav, docs" \
  --body "$(cat <<'EOF'
PR 2 of issue #172 plan. Authors can now declare pick-one alternatives within a mission via the existing Missions Fiori app; runtime computes a per-user recommendation when \`ChatSettings.branchingEnabled = true\`. Default-off in this PR — prod is unchanged on merge.

## What ships

- Schema: \`altGroupKey/altGroupLabel/altCondition\` on \`CompletionPathItems\` + \`GroupPathItems\` (additive nullable columns)
- AdminService validator: rejects single-member alt-groups, missing labels, broken conditions
- New endpoint \`GET /build/mission/:slug\` — auth-aware; groups alt-groups; calls PR 1's engine; writes \`BranchDecisions\`
- \`srv/lib/branch/loaders.js\` — concrete loaders for the engine deps (user-progress, centroids, co-completion)
- Hugo: \`mission-side-nav.html\` renders alt-group chip rows when frontmatter has \`altGroups\` (no AI highlight yet — that's a runtime concern; PR 3 lands the hydration island)
- Telemetry: one \`BranchDecisions\` row per recommendation
- Author docs: \`docs/authors/branched-missions.md\` + dev architecture diff
- srv-qa cp list updated

## What does NOT ship

- Step-level branches & skip-runs — PR 3
- AI highlight on the side-nav chip (Vue island) — PR 3 (the same island handles tutorial-level branches and is shared)
- Joule narration tool — PR 4
- Admin analytics tile — PR 5
- Profile fields populated end-to-end — PR 6

## Tests

- 5 unit tests for the validator
- 4 unit tests for \`/build/mission/:slug\`
- 3 unit tests for the loaders
- 1 hybrid test (real HANA round-trip; opt-in via \`ALLOW_HYBRID_WRITES=true\`)
- Smoke regression: \`/build/catalog\` shape unchanged

Refs #172 · spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md
EOF
)" \
  --base main
```

---

## Definition of done for PR 2

- [ ] All 11 tasks complete and committed
- [ ] `npx vitest run --project unit` green
- [ ] `npx vitest run --project smoke test/smoke/catalog-pages.test.js` green
- [ ] Hybrid test runs (or skips cleanly when binding absent)
- [ ] `BranchDecisions` rows visible in DEV when the flag is on
- [ ] Mission side-nav renders alt-group chips on a seeded fixture mission (visual confirmation)
- [ ] No new npm dependencies
- [ ] `.deploy/mta.yaml` srv-qa cp list updated and verified
- [ ] Author docs page `docs/authors/branched-missions.md` published; sidebar updated; `npm run docs:build` green
- [ ] PR opened against `main`

## Cross-references

- Engine + telemetry come from PR 1 (`srv/lib/branch/{condition,engine,ranker,user-state}.js`, `BranchDecisions`, `branchingEnabled`).
- PR 3 will reuse `srv/lib/branch/loaders.js` and the `BranchDecisions` write helper. The Vue hydration island in PR 3 also handles the highlight-and-localStorage logic for these mission-side-nav chips, completing the visual story.

---

## Reviewer addendum (apply before starting)

Plan-review found 7 real issues. Apply these corrections to the relevant tasks before executing the plan.

### A. ChatSettings real singleton ID

The singleton ID is `'00000000-0000-0000-0000-00000000c8a7'`, defined as `CHAT_SETTINGS_SINGLETON_ID` in [srv/admin-service.js:50](srv/admin-service.js#L50). The plan's tests use `ID: 'singleton'` which would create a separate orphan row. Replace every test occurrence:

```javascript
// At top of every test file that touches ChatSettings:
const CHAT_SETTINGS_ID = '00000000-0000-0000-0000-00000000c8a7';

// And use the constant:
await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: true });
```

This applies to **Task 5 Step 1** (all 4 endpoint tests) and **Task 8 Step 1** (hybrid test).

### B. `expect.toBeOneOf` is not built-in

Vitest doesn't ship this matcher. In **Task 4 Step 1** test 3 (loaders, profile shape), replace:

```javascript
// WRONG:
expect(profile).toMatchObject({ deployment: expect.toBeOneOf([null, 'cloud', 'onprem']) });

// RIGHT (and accepts null since UserMetaData doesn't have these columns until PR 6):
const allowed = [null, 'cloud', 'onprem'];
expect(profile === null || allowed.includes(profile.deployment)).toBe(true);
```

### C. `loadProfile` substrate is wrong shape

`UserMetaData` is a key/value bag (`![key]: String(255)` + `value: String(2000)` per [db/schema.cds:127](db/schema.cds#L127)). The plan's `SELECT.one.from(UserMetaData).columns('deployment', 'role', 'cloud')` will fail at runtime. The try/catch swallows it, so behaviour is correct (returns null), but the test in B above must accept null. **PR 6 introduces the actual `UserLearningPreferences` entity and replaces the `loadProfile` body** — until PR 6 lands, `loadProfile` always returns null. That's the v1 design; don't fight it.

### D. Endpoint cache must honour `?nocache=1`

In **Task 5 Step 3** (`srv/lib/branch/mission-detail.js`), at the top of `missionDetailHandler`:

```javascript
const noCache = req.query?.nocache === '1' || req.query?.nocache === 'true';
// later, before the cache lookup:
if (cacheKey && !noCache) {
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.json(hit.value);
}
```

This unblocks the tests that change `branchingEnabled` between calls.

### E. Add `srv/lib/build-catalog.js` to the modify list

**Task 6 Step 2** modifies `srv/lib/build-catalog.js` to expose alt-group columns on `/build/catalog` items, but the file is missing from the "Modify" list at the top. Update the file list. Also add a unit test in `test/build-catalog-altgroup-shape.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('/build/catalog includes altGroup columns on items', () => {
  // seed one CompletionPathItem with altGroupKey, fetch /build/catalog,
  // assert the path-items array round-trips altGroupKey/altGroupLabel/altCondition
});
```

### F. `makeAltGroupHandler` should resolve entities at call-time

In **Task 2 Step 3**, the factory captures `cds.entities('com.sap.developers.ims').CompletionPathItems` at registration time. Standard CAP idiom is to resolve inside the handler. Replace the factory:

```javascript
export function makeAltGroupHandler(entityName, pathFK) {
  return async (req) => {
    const data = req.data;
    if (!data?.altGroupKey) return;
    const cds = (await import('@sap/cds')).default;
    const entity = cds.entities('com.sap.developers.ims')[entityName];
    // ...rest as before
  };
}
```

And the registration in **Task 2 Step 5**:

```javascript
this.before(['CREATE', 'UPDATE'], 'CompletionPathItems', makeAltGroupHandler('CompletionPathItems', 'path_ID'));
this.before(['CREATE', 'UPDATE'], 'GroupPathItems',     makeAltGroupHandler('GroupPathItems', 'group_ID'));
```

### G. Single-member alt-group rejection blocks normal authoring

Rejecting on first CREATE blocks authors who save members one at a time. **Soften to a warning, not a hard reject**, until PR 6's Fiori draft transaction shape is verified:

In `srv/handlers/completion-path-items-altgroup.js`, replace `req.reject(400, …)` with a warning approach: validate non-fatally on CREATE (only fail on `UPDATE` or post-draft activation), or rely on a deferred admin-tile check. For v1, the simplest fix is to skip the single-member check on CREATE entirely and only enforce it on Path-level save (the curator can create one branch, save, create the second, save). The validator still catches incoherent altGroupLabel/altCondition immediately — just not the multi-member coherence.

```javascript
// In validateAltGroupItem, gate the single-member check:
if (siblings.length === 0 && !options?.enforceMultiMember) return;
// Caller (the wrapper) sets enforceMultiMember=false on CREATE, true on UPDATE.
```

The corresponding test (Task 2 Step 1, test 4 "single-member") should pass only when `enforceMultiMember: true` is set.

### H. Misc

- **PR description body** uses `\`` shell-escape; verify with the actual `gh` invocation that backticks render correctly in the rendered PR body.
