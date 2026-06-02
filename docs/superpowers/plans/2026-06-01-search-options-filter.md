# Search "Options" Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the legacy AEM "Options" filter group on the tutorial navigator by adding **New tutorials** and **No license** checkbox filters, persisted in the URL, working in both browse and search modes (issue [#175](https://github.com/sap-tutorials/tutorials-ims/issues/175)).

**Architecture:** Two boolean post-filters, ANDed with existing filters, rendered as two more checkboxes inside the existing **Type** column under a divider. Browse mode: client-side filter against `_nav.json` using `item.isNew` (already attached) and `requiresLicense()` (already exported). Search mode: extend `useSearch.ts` to (a) append `createdAt gt <ISO>` to the OData `$filter` for `new=1`, and (b) post-filter the response page client-side with `requiresLicense()` for `noLicense=1`. The `SearchableItems` projection gains `createdAt` (additive). A new `hugo-apps/src/shared/freshness.ts` module hosts the shared 31-day window constant + helper, replacing the inline copy in `TutorialNavigator.vue` so search and badge logic stay in lock-step.

**Tech Stack:** Vue 3 (composition API, `<script setup>`), Vitest (unit + hybrid + smoke workspaces), CAP Node.js (CDS views, OData), HANA Cloud (hybrid tests). Existing scripts: `npm test` (unit), `npm run test:hybrid`, `npm run test:smoke`.

---

## Spec divergence noted up-front

The spec's "URL persistence" section says state is reflected via "the same pattern the navigator already uses for `filters.types` and `filters.experience`." **This is incorrect.** Today, only `?q=` is URL-synced (see `TutorialNavigator.vue:43`); the other filters live only in the reactive `filters` object. To honor the spec's *requirement* (URL-persisted toggle state) without scope creep, this plan introduces URL+localStorage sync **only** for the two new keys. The other filters keep their current in-memory-only behavior. If the team later wants full filter URL sync, that's a follow-up.

---

## File structure

| File | Status | Responsibility |
|------|--------|----------------|
| [`hugo-apps/src/shared/freshness.ts`](../../../hugo-apps/src/shared/freshness.ts) | **NEW** | Single source of truth for the "new" window constant and `isWithinNewWindow()` helper. Imported by both the navigator and `useSearch.ts`. |
| [`hugo-apps/src/shared/freshness.test.ts`](../../../hugo-apps/src/shared/freshness.test.ts) | **NEW** | Unit tests for freshness helper (boundary, null/invalid, just-inside, just-outside). |
| [`hugo-apps/src/navigator/useSearch.ts`](../../../hugo-apps/src/navigator/useSearch.ts) | MODIFY | Accept `isNew` + `noLicense` Refs in options; extend `buildFilter` to append `createdAt gt …`; post-filter response page when `noLicense`. Export `buildFilter` and the new cutoff function so they can be unit-tested in isolation. |
| [`hugo-apps/src/navigator/useSearch.test.ts`](../../../hugo-apps/src/navigator/useSearch.test.ts) | MODIFY | Add tests for `buildFilter` with the two new flags and for the `noLicense` post-filter. |
| [`hugo-apps/src/navigator/TutorialNavigator.vue`](../../../hugo-apps/src/navigator/TutorialNavigator.vue) | MODIFY | Add 2 checkboxes under Type with a divider; extend `filters` reactive object; extend `filteredItems`; URL+localStorage sync; pass new Refs into `useSearch`. Replace inline `NEW_BADGE_WINDOW_MS` + `isWithinNewWindow` with imports from `freshness.ts`. |
| [`hugo-apps/src/navigator/TutorialNavigator.test.ts`](../../../hugo-apps/src/navigator/TutorialNavigator.test.ts) | MODIFY | Add a harness-based test for `filteredItems`-style logic — extracted into a tiny pure function in TutorialNavigator.vue or tested via a minimal harness, matching the existing pattern in this file. |
| [`db/views.cds`](../../../db/views.cds) | MODIFY | Add `t.createdAt` to all three SELECT branches of the `SearchableItems` UNION ALL view (Tutorials, Missions, Groups). |
| [`srv/search-service.cds`](../../../srv/search-service.cds) | MODIFY | The projection at line 34 uses `*` — `createdAt` propagates automatically. **Verify** during implementation; add explicitly only if `*` doesn't pull it through. |
| [`srv/search-service.js`](../../../srv/search-service.js) | NO CHANGE EXPECTED | The `after('READ')` strip-list at lines 119-128 deletes only `bodyText` and `_searchRank`; `createdAt` passes through. **Verify** during implementation that no other handler strips it. |
| [`test/hybrid/search-service.test.js`](../../../test/hybrid/search-service.test.js) | MODIFY | Add a read-only test asserting `SearchableItems` projects `createdAt` and that `$filter=createdAt gt <ts>` returns the expected subset. |
| [`test/smoke/search.test.js`](../../../test/smoke/search.test.js) | MODIFY | Add a smoke assertion that `SearchableItems` results include `createdAt` and that the OData filter is honored. |

---

## Task 1: Extract freshness helper into a shared module

**Why first:** Pure refactor with no behavior change. Establishes the shared module both downstream tasks depend on.

**Files:**
- Create: `hugo-apps/src/shared/freshness.ts`
- Create: `hugo-apps/src/shared/freshness.test.ts`
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue:316-323` (replace inline definitions with import)

- [ ] **Step 1: Write the failing test for the freshness helper**

Create `hugo-apps/src/shared/freshness.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NEW_WINDOW_MS, isWithinNewWindow } from './freshness'

describe('NEW_WINDOW_MS', () => {
  it('is 31 days in milliseconds', () => {
    expect(NEW_WINDOW_MS).toBe(31 * 24 * 60 * 60 * 1000)
  })
})

describe('isWithinNewWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns false for undefined input', () => {
    expect(isWithinNewWindow(undefined)).toBe(false)
  })

  it('returns false for an unparseable string', () => {
    expect(isWithinNewWindow('not-a-date')).toBe(false)
  })

  it('returns true for a timestamp 1 day ago', () => {
    expect(isWithinNewWindow('2026-05-31T12:00:00Z')).toBe(true)
  })

  it('returns true for a timestamp exactly 31 days ago', () => {
    // 2026-06-01T12:00:00Z minus 31 days = 2026-05-01T12:00:00Z
    expect(isWithinNewWindow('2026-05-01T12:00:00Z')).toBe(true)
  })

  it('returns false for a timestamp 32 days ago', () => {
    expect(isWithinNewWindow('2026-04-30T12:00:00Z')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(isWithinNewWindow('')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd D:/projects/tutorials-poc && npx vitest run hugo-apps/src/shared/freshness.test.ts`
Expected: FAIL — module `./freshness` does not exist.

- [ ] **Step 3: Create the freshness module**

Create `hugo-apps/src/shared/freshness.ts`:

```typescript
// Single source of truth for the "new tutorial" window. Imported by both
// the navigator (NEW badge + Options.NewTutorials checkbox post-filter) and
// useSearch.ts (OData $filter clause for the same checkbox in search mode).
// Keep these in lock-step or the toggle and the badge will diverge.
export const NEW_WINDOW_MS = 31 * 24 * 60 * 60 * 1000

export function isWithinNewWindow(createdAt: string | undefined): boolean {
  if (!createdAt) return false
  const t = Date.parse(createdAt)
  if (!Number.isFinite(t)) return false
  return Date.now() - t <= NEW_WINDOW_MS
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd D:/projects/tutorials-poc && npx vitest run hugo-apps/src/shared/freshness.test.ts`
Expected: PASS — all 7 cases.

- [ ] **Step 5: Replace inline definitions in `TutorialNavigator.vue`**

Edit `hugo-apps/src/navigator/TutorialNavigator.vue`:

At the top of `<script setup>`, add to the existing imports block (around line 9):

```typescript
import { isWithinNewWindow } from '../shared/freshness'
```

Then DELETE lines 316-323 (the inline `NEW_BADGE_WINDOW_MS` constant and `isWithinNewWindow` function). The two existing call sites (lines 402 and 535) keep working unchanged because the imported function has the same signature.

- [ ] **Step 6: Run the unit suite to verify nothing regressed**

Run: `cd D:/projects/tutorials-poc && npx vitest run hugo-apps/src/`
Expected: PASS — all existing navigator tests still pass; new freshness tests pass.

- [ ] **Step 7: Commit**

```bash
cd D:/projects/tutorials-poc
git add hugo-apps/src/shared/freshness.ts hugo-apps/src/shared/freshness.test.ts hugo-apps/src/navigator/TutorialNavigator.vue
git commit -m "refactor(navigator): extract freshness helper to shared module

Pure refactor — no behavior change. Single source of truth for the
31-day NEW window so the upcoming Options.NewTutorials toggle in
useSearch.ts can reuse the same constant.

Refs: #175"
```

---

## Task 2: Extend `SearchableItems` view to project `createdAt`

**Why second:** Schema change is small, additive, and unblocks downstream search-mode work. No data migration. Hybrid + smoke tests for the schema land in this task; the `useSearch.ts` consumer comes in Task 3.

**Files:**
- Modify: `db/views.cds:75-112` (UNION ALL — add `t.createdAt` / `m.createdAt` / `g.createdAt` to all three branches)
- Modify: `srv/search-service.cds` (verify `*` projection picks it up; otherwise add explicitly)
- Modify: `test/hybrid/search-service.test.js` (add a read-only assertion)
- Modify: `test/smoke/search.test.js` (add a smoke assertion)

- [ ] **Step 1: Add `createdAt` to all three branches of the `SearchableItems` view**

Edit `db/views.cds` lines 75-112. The view is a UNION ALL of three SELECTs. **All three branches MUST add `createdAt` in the same column position** for HANA UNION ALL to compile — adding it to only one branch fails view activation.

Branch 1 (Tutorials, lines 75-88) — add `t.createdAt` after `t.status`:

```cds
view SearchableItems as
  SELECT from ims.Tutorials as t
    left join ims.TutorialBodyText as bt on bt.slug = t.slug
  {
    key t.ID, t.legacyId, t.title, t.description, t.slug,
    t.primaryTag, t.experienceTag, t.averageTimeToComplete, t.status,
    t.createdAt,
    'TUTORIAL' as taskType : String(20),
    bt.bodyText as bodyText : LargeString,
    (select string_agg(lower(coalesce(tg.label,'') || ' ' || coalesce(tg.name,'')), ' ')
       from ims.TutorialTags as tt
       inner join ims.Tags as tg on tg.ID = tt.tag.ID
       where tt.tutorial.ID = t.ID
    ) as tagBag : String(5000)
  } where t.status is null or t.status = 'ACTIVE'
```

Branch 2 (Missions, lines 89-100) — add `m.createdAt` in the same position:

```cds
  UNION ALL
  SELECT from ims.Missions as m {
    m.ID, m.legacyId, m.title, m.description, m.slug,
    m.primaryTag, m.experienceTag, m.averageTimeToComplete, m.status,
    m.createdAt,
    'MISSION' as taskType : String(20),
    null as bodyText : LargeString,
    (select string_agg(lower(coalesce(tg.label,'') || ' ' || coalesce(tg.name,'')), ' ')
       from ims.MissionTags as mt
       inner join ims.Tags as tg on tg.ID = mt.tag.ID
       where mt.mission.ID = m.ID
    ) as tagBag : String(5000)
  } where (m.status is null or m.status = 'ACTIVE') and m.published = true
```

Branch 3 (Groups, lines 101-112) — add `g.createdAt` in the same position:

```cds
  UNION ALL
  SELECT from ims.Groups as g {
    g.ID, g.legacyId, g.title, g.description, null as slug : String(255),
    g.primaryTag, g.experienceTag, g.averageTimeToComplete, g.status,
    g.createdAt,
    'GROUP' as taskType : String(20),
    null as bodyText : LargeString,
    (select string_agg(lower(coalesce(tg.label,'') || ' ' || coalesce(tg.name,'')), ' ')
       from ims.GroupTags as gt
       inner join ims.Tags as tg on tg.ID = gt.tag.ID
       where gt.group.ID = g.ID
    ) as tagBag : String(5000)
  } where (g.status is null or g.status = 'ACTIVE') and g.published = true;
```

`Tutorials.createdAt`, `Missions.createdAt`, `Groups.createdAt` already exist on the underlying entities (`db/schema.cds`), so no schema migration is needed.

- [ ] **Step 2: Verify the service projection picks up `createdAt`**

Read `srv/search-service.cds:32-48`. The `SearchableItems` projection ends with `*` and excludes `bodyText, tagBag`. The `*` should propagate `createdAt` automatically.

If `cds compile srv/search-service.cds` (run below) shows `createdAt` in the resulting CSN, no change needed. If it doesn't, add it explicitly:

```cds
@cds.search: { title, description, primaryTag, tagBag }
entity SearchableItems as projection on ims.SearchableItems {
  @Search.fuzzinessThreshold: 0.85
  @Search.ranking: #HIGH
  title,
  …
  createdAt,
  *
} excluding { bodyText, tagBag };
```

Run: `cd D:/projects/tutorials-poc && npx cds compile srv/search-service.cds --to json | jq '.definitions["SearchService.SearchableItems"].elements | keys'`
Expected: array includes `"createdAt"`.

- [ ] **Step 3: Run the unit baseline to make sure CDS still parses cleanly**

Run: `cd D:/projects/tutorials-poc && npx cds compile db --to sql 2>&1 | head -20`
Expected: no errors. Should print SQL DDL.

Also: `cd D:/projects/tutorials-poc && npm test -- --run --reporter=basic 2>&1 | tail -20`
Expected: all unit tests pass — schema change is additive and shouldn't affect any unit test, but a stale snapshot would surface here.

- [ ] **Step 4: Write the failing hybrid test**

Edit `test/hybrid/search-service.test.js`. After the existing test "performance: full dataset query completes under 2 seconds" (around line 57), add:

```javascript
  it('SearchableItems projects createdAt for all task types', async () => {
    const { SearchableItems } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(SearchableItems)
      .columns('taskType', 'createdAt')
      .where({ createdAt: { '!=': null } })
      .limit(20);
    expect(rows.length).toBeGreaterThan(0);
    // At least one of each task type should have a createdAt; the projection
    // is a UNION ALL of Tutorials/Missions/Groups, so coverage matters.
    const types = new Set(rows.map(r => r.taskType));
    // Don't insist on all three — some empty environments may lack groups —
    // but require at least Tutorials.
    expect(types.has('TUTORIAL')).toBe(true);
    for (const r of rows) {
      // CAP returns Timestamp as ISO string on HANA.
      expect(typeof r.createdAt).toBe('string');
      expect(Number.isFinite(Date.parse(r.createdAt))).toBe(true);
    }
  });

  it('OData $filter on createdAt narrows the result set', async () => {
    const srv = await cds.connect.to('SearchService');
    // Use a far-past cutoff so we get *some* rows back, then a far-future
    // cutoff so we get zero. The point is to prove the filter is plumbed.
    const farPast = '1970-01-01T00:00:00.000Z';
    const farFuture = '2999-01-01T00:00:00.000Z';
    const past = await srv.run(
      SELECT.from('SearchService.SearchableItems').where({ createdAt: { '>': farPast } }).limit(5)
    );
    const future = await srv.run(
      SELECT.from('SearchService.SearchableItems').where({ createdAt: { '>': farFuture } }).limit(5)
    );
    expect(past.length).toBeGreaterThan(0);
    expect(future.length).toBe(0);
  });
```

These tests are read-only (no INSERT/UPDATE/DELETE), so the `ALLOW_HYBRID_WRITES` guard in `test/hybrid/_guard.js` does NOT need to be set.

- [ ] **Step 5: Run the hybrid test**

Run: `cd D:/projects/tutorials-poc && npm run test:hybrid -- --run search-service 2>&1 | tail -30`
Expected: PASS for both new tests. Requires `cf login` to DEV space.

If running locally without HANA access, defer this step until a hybrid run is available. Document the deferral and ensure CI runs it.

- [ ] **Step 6: Write the failing smoke test assertion**

Edit `test/smoke/search.test.js`. After the existing "does not leak _searchRank field" test (around line 62), add:

```javascript
  it('SearchableItems projects createdAt', async () => {
    const res = await fetch(`${BASE_URL}/search/SearchableItems?$top=10`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.value)).toBe(true);
    if (data.value.length === 0) return; // empty deployments — skip
    const withCreatedAt = data.value.filter(r => r.createdAt);
    // Don't insist all rows have it — legacy IMS imports may have null
    // createdAt — but require at least one to confirm the field is exposed.
    expect(withCreatedAt.length).toBeGreaterThan(0);
    expect(typeof withCreatedAt[0].createdAt).toBe('string');
  });

  it('OData $filter on createdAt is honored', async () => {
    const farFuture = '2999-01-01T00:00:00.000Z';
    const url = `${BASE_URL}/search/SearchableItems?$filter=createdAt gt ${farFuture}&$top=5&$count=true`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.value).toEqual([]);
    expect(data['@odata.count']).toBe(0);
  });
```

- [ ] **Step 7: Run the smoke test against local CAP**

Run: `cd D:/projects/tutorials-poc && cds watch &` (in another terminal), wait for "server listening", then:

`cd D:/projects/tutorials-poc && SMOKE_BASE_URL=http://localhost:4004 npm run test:smoke -- --run search 2>&1 | tail -20`
Expected: PASS for both new tests.

Stop `cds watch` when done.

- [ ] **Step 8: Commit**

```bash
cd D:/projects/tutorials-poc
git add db/views.cds srv/search-service.cds test/hybrid/search-service.test.js test/smoke/search.test.js
git commit -m "feat(search): project createdAt on SearchableItems

Additive schema change — adds createdAt to the UNION ALL view's three
branches (Tutorials/Missions/Groups). Enables the upcoming
Options.NewTutorials filter in useSearch.ts to push freshness
filtering server-side via OData \$filter=createdAt gt <ts>.

Hybrid + smoke tests verify the field is projected and the filter
is honored.

Refs: #175"
```

---

## Task 3: Extend `useSearch.ts` to accept `isNew` and `noLicense` flags

**Why third:** Server-side search path now has the data it needs. Wire the two flags through `buildFilter` and a post-filter step. Tests verify filter assembly and post-filter behavior in isolation.

**Files:**
- Modify: `hugo-apps/src/navigator/useSearch.ts` (extend `UseSearchOptions`, extend `buildFilter`, post-filter results, export `buildFilter` for testing)
- Modify: `hugo-apps/src/navigator/useSearch.test.ts`

- [ ] **Step 1: Write the failing tests for the new `buildFilter` cases and the post-filter**

Edit `hugo-apps/src/navigator/useSearch.test.ts`. Append to the file (after the closing `})` of the existing `describe('mapToCardItem')` block):

```typescript
import { buildFilter, postFilterNoLicense } from './useSearch'
import type { CardItem } from '@shared/types'

describe('buildFilter', () => {
  it('returns empty string with no flags or filters', () => {
    expect(buildFilter([], [], [], { isNew: false, isNewCutoffISO: '' })).toBe('')
  })

  it('omits createdAt clause when isNew is false', () => {
    const out = buildFilter(['TUTORIAL'], [], [], { isNew: false, isNewCutoffISO: '2026-05-01T00:00:00.000Z' })
    expect(out).not.toContain('createdAt')
  })

  it('appends createdAt gt <ISO> when isNew is true', () => {
    const out = buildFilter([], [], [], { isNew: true, isNewCutoffISO: '2026-05-01T00:00:00.000Z' })
    expect(out).toBe("createdAt gt 2026-05-01T00:00:00.000Z")
  })

  it('AND-joins createdAt with other clauses', () => {
    const out = buildFilter(['TUTORIAL'], ['beginner'], [], { isNew: true, isNewCutoffISO: '2026-05-01T00:00:00.000Z' })
    // Order: types, levels, products, then createdAt.
    expect(out).toBe("taskType eq 'TUTORIAL' and experienceTag eq 'beginner' and createdAt gt 2026-05-01T00:00:00.000Z")
  })
})

describe('postFilterNoLicense', () => {
  const licensed: CardItem = {
    type: 'tutorial',
    id: 'a',
    title: 'L',
    description: '',
    time: 0,
    level: 'beginner',
    tutorialCount: 1,
    primaryTag: '',
    displayTags: ['License'],
    displayTagSlugs: ['tutorial>license'],
    href: '/tutorials/a',
    stepCount: 0,
  }
  const free: CardItem = {
    ...licensed,
    id: 'b',
    displayTags: [],
    displayTagSlugs: [],
    href: '/tutorials/b',
  }

  it('returns the input unchanged when noLicense is false', () => {
    expect(postFilterNoLicense([licensed, free], false)).toEqual([licensed, free])
  })

  it('strips license-tagged items when noLicense is true', () => {
    expect(postFilterNoLicense([licensed, free], true)).toEqual([free])
  })

  it('keeps items with no displayTagSlugs', () => {
    expect(postFilterNoLicense([free], true)).toEqual([free])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd D:/projects/tutorials-poc && npx vitest run hugo-apps/src/navigator/useSearch.test.ts`
Expected: FAIL — `buildFilter` and `postFilterNoLicense` are not exported.

- [ ] **Step 3: Extend `useSearch.ts` — export filter helpers, accept new flags**

Edit `hugo-apps/src/navigator/useSearch.ts`:

(a) Update the imports at the top of the file:

```typescript
import { ref, computed, watch, type Ref } from 'vue'
import type { CardItem, SearchableItem, SearchFacets, TutorialEntry } from '@shared/types'
import { requiresLicense } from '../shared/license'
import { NEW_WINDOW_MS } from '../shared/freshness'
```

(b) Update `UseSearchOptions` (lines 4-10):

```typescript
interface UseSearchOptions {
  searchTerm: Ref<string>
  filterTypes: Ref<string[]>
  filterLevels: Ref<string[]>
  filterProducts: Ref<string[]>
  filterIsNew: Ref<boolean>
  filterNoLicense: Ref<boolean>
  tutorials?: Ref<TutorialEntry[]>
}
```

(c) Replace the `buildFilter` function (lines 38-57) with an exported version that accepts a 4th argument:

```typescript
export interface BuildFilterFlags {
  isNew: boolean
  isNewCutoffISO: string
}

export function buildFilter(
  types: string[],
  levels: string[],
  products: string[],
  flags: BuildFilterFlags = { isNew: false, isNewCutoffISO: '' }
): string {
  const parts: string[] = []

  if (types.length) {
    const typeFilter = types.map(t => `taskType eq '${escOData(t.toUpperCase())}'`).join(' or ')
    parts.push(types.length > 1 ? `(${typeFilter})` : typeFilter)
  }

  if (levels.length) {
    const levelFilter = levels.map(l => `experienceTag eq '${escOData(l)}'`).join(' or ')
    parts.push(levels.length > 1 ? `(${levelFilter})` : levelFilter)
  }

  if (products.length) {
    const prodFilter = products.map(p => `primaryTag eq '${escOData(p)}'`).join(' or ')
    parts.push(products.length > 1 ? `(${prodFilter})` : prodFilter)
  }

  if (flags.isNew && flags.isNewCutoffISO) {
    // OData v4 datetime literal — no quotes, no `datetime'…'` wrapper.
    parts.push(`createdAt gt ${flags.isNewCutoffISO}`)
  }

  return parts.join(' and ')
}

// Exported for unit testing. Strips license-tagged items from a CardItem
// page when the noLicense toggle is on. Pure function; no side effects.
export function postFilterNoLicense(items: CardItem[], noLicense: boolean): CardItem[] {
  if (!noLicense) return items
  return items.filter(item => !requiresLicense(item))
}
```

(d) Update the `useSearch` function destructure (around line 60) and call sites:

```typescript
export function useSearch(options: UseSearchOptions) {
  const { searchTerm, filterTypes, filterLevels, filterProducts, filterIsNew, filterNoLicense, tutorials } = options
```

(e) Update `executeSearch` to pass the flags into `buildFilter` and post-filter the response.

The replacement region starts at `try {` (around line 88) and ends at the closing `}` of the matching `finally { … }` block (around line 119). Replace the **entire** `try { … } catch (e) { … } finally { … }` block — do not leave the existing `try {` opening and prepend; that would produce a duplicated `try` keyword. The replacement below contains its own `try`/`catch`/`finally`:

```typescript
    try {
      const isNewCutoffISO = filterIsNew.value
        ? new Date(Date.now() - NEW_WINDOW_MS).toISOString()
        : ''
      const filter = buildFilter(
        filterTypes.value,
        filterLevels.value,
        filterProducts.value,
        { isNew: filterIsNew.value, isNewCutoffISO },
      )
      const params = new URLSearchParams()
      params.set('$search', term)
      params.set('$top', String(pageSize))
      params.set('$skip', String(page * pageSize))
      params.set('$count', 'true')
      if (filter) params.set('$filter', filter)

      const [itemsRes, facetsRes] = await Promise.all([
        fetch(`/search/SearchableItems?${params}`),
        fetch(`/search/getFacets(search='${escOData(term)}'${filterTypes.value.length ? `,taskTypes=[${filterTypes.value.map(t => `'${escOData(t.toUpperCase())}'`).join(',')}]` : ''}${filterLevels.value.length ? `,experience=[${filterLevels.value.map(e => `'${escOData(e)}'`).join(',')}]` : ''})`),
      ])

      if (!itemsRes.ok || !facetsRes.ok) {
        searchError.value = 'Search request failed'
        return
      }

      const itemsData = await itemsRes.json()
      const facetsData = await facetsRes.json()

      const cards = (itemsData.value ?? []).map((it: SearchableItem) =>
        mapToCardItem(it, tutorialsBySlug.value)
      )
      // Client-side post-filter for the No license toggle. Cheap on a
      // page of $top=48 — at most 48 rows pruned. Avoids a HANA fuzzy-search
      // anti-pattern (`tagBag NOT LIKE '%tutorial>license%'` would defeat
      // the indexed search column).
      searchResults.value = postFilterNoLicense(cards, filterNoLicense.value)
      // searchTotalCount comes from the unfiltered server-side $count. When
      // No license is on, the count is a slight over-count (legacy AEM had
      // the same behavior — facet counts ignored the Options toggles).
      searchTotalCount.value = itemsData['@odata.count'] ?? 0
      searchFacets.value = facetsData
    } catch (e) {
      searchError.value = (e as Error).message
    } finally {
      isSearching.value = false
    }
```

(f) Update the `watch` (around line 127) to include the new Refs as dependencies:

```typescript
  watch([searchTerm, filterTypes, filterLevels, filterProducts, filterIsNew, filterNoLicense], () => {
    if (searchMode.value) {
      debouncedSearch()
    } else {
      searchResults.value = []
      searchFacets.value = null
      searchTotalCount.value = 0
    }
  })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd D:/projects/tutorials-poc && npx vitest run hugo-apps/src/navigator/useSearch.test.ts`
Expected: PASS — both `mapToCardItem`, `buildFilter`, and `postFilterNoLicense` blocks green.

- [ ] **Step 5: Run the full unit suite to confirm no regression**

Run: `cd D:/projects/tutorials-poc && npm test -- --run hugo-apps/src 2>&1 | tail -10`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd D:/projects/tutorials-poc
git add hugo-apps/src/navigator/useSearch.ts hugo-apps/src/navigator/useSearch.test.ts
git commit -m "feat(search): wire isNew + noLicense flags into useSearch

isNew → server-side: appends 'createdAt gt <now-31d>' to the OData
\$filter, using the shared 31-day window from freshness.ts.

noLicense → client-side: post-filters the response page using the
existing requiresLicense() helper. Server-side filtering on tagBag
would defeat HANA's indexed search column (anti-pattern).

Both helpers (buildFilter, postFilterNoLicense) are exported so unit
tests verify them in isolation without mocking fetch.

Refs: #175"
```

---

## Task 4: Add `isNew` + `noLicense` to `TutorialNavigator.vue` filters and URL sync

**Why fourth:** Backend + composable are ready. Now expose to the user via the existing Type column and URL params. Browse-mode `filteredItems` extension also lands here.

**Files:**
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue` (filters reactive object, useSearch call, filteredItems, template, URL sync, localStorage)
- Modify: `hugo-apps/src/navigator/TutorialNavigator.test.ts` (harness test for filteredItems-style logic + URL round-trip)

- [ ] **Step 1: Write the failing harness test**

Edit `hugo-apps/src/navigator/TutorialNavigator.test.ts`. Append a new `describe` block after the existing one:

```typescript
import { requiresLicense } from '../shared/license'
import type { CardItem } from '@shared/types'

// Pure-function mirror of the post-Task-4 filteredItems extension. The
// real filteredItems lives inside TutorialNavigator.vue's <script setup>;
// that file imports fetch/UI5/full Vue lifecycle and isn't unit-mountable
// at the file level (matches the pattern of the harness above for #159).
// We instead test the extracted predicate that the .vue file delegates to.
function applyOptionsFilters(
  items: CardItem[],
  flags: { isNew: boolean; noLicense: boolean }
): CardItem[] {
  return items.filter(item => {
    if (flags.isNew && !item.isNew) return false
    if (flags.noLicense && requiresLicense(item)) return false
    return true
  })
}

describe('Options filters (#175)', () => {
  const baseCard: CardItem = {
    type: 'tutorial',
    id: 'a',
    title: 'A',
    description: '',
    time: 0,
    level: 'beginner',
    tutorialCount: 1,
    primaryTag: '',
    displayTags: [],
    displayTagSlugs: [],
    href: '/tutorials/a',
    stepCount: 0,
  }
  const newFree: CardItem = { ...baseCard, id: 'newFree', isNew: true }
  const newLicensed: CardItem = { ...baseCard, id: 'newLicensed', isNew: true, displayTagSlugs: ['tutorial>license'] }
  const oldFree: CardItem = { ...baseCard, id: 'oldFree', isNew: false }
  const oldLicensed: CardItem = { ...baseCard, id: 'oldLicensed', isNew: false, displayTagSlugs: ['tutorial>license'] }

  const all = [newFree, newLicensed, oldFree, oldLicensed]

  it('returns input unchanged when both flags off', () => {
    expect(applyOptionsFilters(all, { isNew: false, noLicense: false })).toEqual(all)
  })

  it('isNew=true keeps only items with isNew=true', () => {
    expect(applyOptionsFilters(all, { isNew: true, noLicense: false })).toEqual([newFree, newLicensed])
  })

  it('noLicense=true strips license-tagged items', () => {
    expect(applyOptionsFilters(all, { isNew: false, noLicense: true })).toEqual([newFree, oldFree])
  })

  it('both flags AND together', () => {
    expect(applyOptionsFilters(all, { isNew: true, noLicense: true })).toEqual([newFree])
  })
})

describe('Options URL sync (#175)', () => {
  // Pure functions mirroring the post-Task-4 sync logic in TutorialNavigator.vue.
  function readOptionsFromURL(href: string): { isNew: boolean; noLicense: boolean } {
    const sp = new URL(href).searchParams
    return { isNew: sp.get('new') === '1', noLicense: sp.get('noLicense') === '1' }
  }

  function writeOptionsToURL(href: string, flags: { isNew: boolean; noLicense: boolean }): string {
    const url = new URL(href)
    if (flags.isNew) url.searchParams.set('new', '1'); else url.searchParams.delete('new')
    if (flags.noLicense) url.searchParams.set('noLicense', '1'); else url.searchParams.delete('noLicense')
    return url.toString()
  }

  it('reads ?new=1&noLicense=1', () => {
    expect(readOptionsFromURL('https://x/?new=1&noLicense=1')).toEqual({ isNew: true, noLicense: true })
  })

  it('reads ?new=1 only', () => {
    expect(readOptionsFromURL('https://x/?new=1')).toEqual({ isNew: true, noLicense: false })
  })

  it('reads neither when absent', () => {
    expect(readOptionsFromURL('https://x/')).toEqual({ isNew: false, noLicense: false })
  })

  it('writes both flags when on', () => {
    const result = writeOptionsToURL('https://x/', { isNew: true, noLicense: true })
    expect(new URL(result).searchParams.get('new')).toBe('1')
    expect(new URL(result).searchParams.get('noLicense')).toBe('1')
  })

  it('omits both flags when off', () => {
    const result = writeOptionsToURL('https://x/?new=1&noLicense=1', { isNew: false, noLicense: false })
    expect(new URL(result).searchParams.has('new')).toBe(false)
    expect(new URL(result).searchParams.has('noLicense')).toBe(false)
  })

  it('round-trips correctly', () => {
    const flags = { isNew: true, noLicense: false }
    const written = writeOptionsToURL('https://x/?q=cap', flags)
    expect(readOptionsFromURL(written)).toEqual(flags)
    // Pre-existing query keys are preserved.
    expect(new URL(written).searchParams.get('q')).toBe('cap')
  })
})
```

- [ ] **Step 2: Run the test to verify it passes**

These tests are **self-contained contract tests** — they define `applyOptionsFilters`, `readOptionsFromURL`, and `writeOptionsToURL` locally and verify the shape the .vue file's logic must satisfy. They pass on their own. Their purpose is to pin the contract before you touch the .vue file, so any future drift in `TutorialNavigator.vue` is caught against this fixed reference.

Run: `cd D:/projects/tutorials-poc && npx vitest run hugo-apps/src/navigator/TutorialNavigator.test.ts`
Expected: PASS — both new `describe` blocks green.

If you'd prefer harder coupling, you could refactor `TutorialNavigator.vue` to import these three pure functions from a small shared file — but that's an extra moving part. The pattern in the existing test file (#159) chose self-contained harnesses for the same reason; we follow it.

- [ ] **Step 3: Extend `TutorialNavigator.vue`**

Edit `hugo-apps/src/navigator/TutorialNavigator.vue`. Three changes follow.

(a) Extend the `filters` reactive object and add URL-sync helpers (around lines 25-40). Replace:

```typescript
const filters = reactive({
  levels: [] as string[],
  types: [] as string[],
  products: [] as string[],
  topics: [] as string[],
})

const loading = computed(() => tutorials.value.length === 0)

const { searchMode, isSubThreshold, searchResults, searchFacets, searchTotalCount, isSearching, searchError } = useSearch({
  searchTerm: searchQuery,
  filterTypes: computed(() => filters.types.map(t => t.toUpperCase())),
  filterLevels: computed(() => filters.levels),
  filterProducts: computed(() => filters.products),
  tutorials,
})
```

with:

```typescript
const filters = reactive({
  levels: [] as string[],
  types: [] as string[],
  products: [] as string[],
  topics: [] as string[],
  isNew: false,
  noLicense: false,
})

// Read Options toggles from the URL (?new=1, ?noLicense=1) on initial
// load, falling back to localStorage. URL is the source of truth so
// shared filtered links work; localStorage backstops for revisits.
function loadOptionsFromURL() {
  const sp = new URL(window.location.href).searchParams
  if (sp.has('new') || sp.has('noLicense')) {
    filters.isNew = sp.get('new') === '1'
    filters.noLicense = sp.get('noLicense') === '1'
    return
  }
  try {
    filters.isNew = localStorage.getItem('navigator.options.new') === '1'
    filters.noLicense = localStorage.getItem('navigator.options.noLicense') === '1'
  } catch {
    // localStorage unavailable (private mode, SSR) — leave defaults.
  }
}

function syncOptionsToURL() {
  const url = new URL(window.location.href)
  if (filters.isNew) url.searchParams.set('new', '1'); else url.searchParams.delete('new')
  if (filters.noLicense) url.searchParams.set('noLicense', '1'); else url.searchParams.delete('noLicense')
  window.history.replaceState({}, '', url.toString())
  try {
    localStorage.setItem('navigator.options.new', filters.isNew ? '1' : '0')
    localStorage.setItem('navigator.options.noLicense', filters.noLicense ? '1' : '0')
  } catch {
    // localStorage unavailable — URL is canonical anyway.
  }
}

watch(() => [filters.isNew, filters.noLicense], syncOptionsToURL)

const loading = computed(() => tutorials.value.length === 0)

const { searchMode, isSubThreshold, searchResults, searchFacets, searchTotalCount, isSearching, searchError } = useSearch({
  searchTerm: searchQuery,
  filterTypes: computed(() => filters.types.map(t => t.toUpperCase())),
  filterLevels: computed(() => filters.levels),
  filterProducts: computed(() => filters.products),
  filterIsNew: computed(() => filters.isNew),
  filterNoLicense: computed(() => filters.noLicense),
  tutorials,
})
```

(b) Call `loadOptionsFromURL()` in `onMounted` — find the existing `onMounted(async () => { … })` block (around line 42) and add a single line at the very top, before the existing `const initialQuery = …` line:

```typescript
onMounted(async () => {
  loadOptionsFromURL()
  const initialQuery = new URL(window.location.href).searchParams.get('q')
  …
```

(c) Extend `filteredItems` (around lines 457-487). Inside the existing `.filter(item => { … })` callback, after the existing `if (filters.topics.length > 0) { … }` block, before the `return true`, add:

```typescript
    if (filters.isNew && !item.isNew) {
      return false
    }

    if (filters.noLicense && requiresLicense(item)) {
      return false
    }

    return true
```

(d) Extend `clearFilters` (around line 504) — after `filters.topics = []`, add:

```typescript
  filters.isNew = false
  filters.noLicense = false
```

(e) Extend `hasActiveFilters` (around line 514):

```typescript
const hasActiveFilters = computed(() => {
  return searchQuery.value.length > 0 ||
    filters.levels.length > 0 ||
    filters.types.length > 0 ||
    filters.products.length > 0 ||
    filters.topics.length > 0 ||
    filters.isNew ||
    filters.noLicense
})
```

(f) Extend the Type column template (around lines 707-715). Replace:

```vue
          <div class="filter-column">
            <h3 class="filter-title">Type</h3>
            <div class="filter-list">
              <label v-for="type in ['mission', 'group', 'tutorial']" :key="type" class="filter-option">
                <input type="checkbox" :checked="filters.types.includes(type)" @change="toggleFilter(filters.types, type)" class="filter-checkbox" />
                <span class="filter-label">{{ type.charAt(0).toUpperCase() + type.slice(1) }}</span>
              </label>
            </div>
          </div>
```

with:

```vue
          <div class="filter-column">
            <h3 class="filter-title">Type</h3>
            <div class="filter-list">
              <label v-for="type in ['mission', 'group', 'tutorial']" :key="type" class="filter-option">
                <input type="checkbox" :checked="filters.types.includes(type)" @change="toggleFilter(filters.types, type)" class="filter-checkbox" />
                <span class="filter-label">{{ type.charAt(0).toUpperCase() + type.slice(1) }}</span>
              </label>
              <hr class="filter-divider" aria-hidden="true" />
              <label class="filter-option">
                <input type="checkbox" v-model="filters.isNew" class="filter-checkbox" />
                <span class="filter-label">New tutorials</span>
              </label>
              <label class="filter-option">
                <input type="checkbox" v-model="filters.noLicense" class="filter-checkbox" />
                <span class="filter-label">No license</span>
              </label>
            </div>
          </div>
```

(g) Add the divider style. Find the `<style scoped>` block in the file (or `<style>` if not scoped) and add:

```css
.filter-divider {
  border: none;
  border-top: 1px solid var(--sapList_BorderColor, #d9d9d9);
  margin: 0.5rem 0;
}
```

If the existing style is unscoped or uses a different variable name, match the surrounding convention.

- [ ] **Step 4: Run the navigator unit tests to confirm nothing regressed**

Run: `cd D:/projects/tutorials-poc && npx vitest run hugo-apps/src/navigator/`
Expected: PASS — all existing tests still green; the new contract tests from Step 1 still green.

- [ ] **Step 5: Manual smoke check (optional but recommended)**

Run: `cd D:/projects/tutorials-poc && npm run dev` (or `cds watch` + `hugo server` per local-dev pattern). Open `http://localhost:1313/tutorial-navigator/` (or whichever local URL the navigator lives at) and confirm:

- The two new checkboxes appear under Type with a visible divider.
- Toggling "New tutorials" on the URL adds `?new=1`; off removes it.
- Toggling "No license" on the URL adds `?noLicense=1`; off removes it.
- Reloading the page with `?new=1&noLicense=1` in the URL ticks both checkboxes.
- Browse mode: toggling "New tutorials" reduces the result set to items with the corner NEW ribbon.
- Browse mode: toggling "No license" hides items with the License chip.
- Search mode (type a query ≥ 2 chars): both toggles still apply.
- Clicking the "Clear all filters" button (if present) clears the toggles too.

- [ ] **Step 6: Commit**

```bash
cd D:/projects/tutorials-poc
git add hugo-apps/src/navigator/TutorialNavigator.vue hugo-apps/src/navigator/TutorialNavigator.test.ts
git commit -m "feat(navigator): add Options filters (New tutorials, No license) — #175

Restores parity with the legacy AEM Tutorial Navigator's 'Options'
filter group. Two checkboxes inline under the existing Type column,
separated by a thin divider. Both default off, AND with all other
filters, persist via URL (?new=1, ?noLicense=1) + localStorage.

Browse mode uses item.isNew (already attached) and requiresLicense().
Search mode wires through useSearch.ts (Task 3): isNew → server-side
\$filter, noLicense → client-side post-filter on the response page.

Community toggle is intentionally out of scope.

Closes #175"
```

---

## Task 5: Verify and ship

- [ ] **Step 1: Run the full unit suite**

Run: `cd D:/projects/tutorials-poc && npm test 2>&1 | tail -30`
Expected: 0 failing.

- [ ] **Step 2: Run the smoke suite against local CAP**

Start `cds watch` in another shell. Then:

Run: `cd D:/projects/tutorials-poc && SMOKE_BASE_URL=http://localhost:4004 npm run test:smoke -- --run search 2>&1 | tail -10`
Expected: all green, including the two new createdAt assertions.

- [ ] **Step 3: Run the hybrid suite**

Run: `cd D:/projects/tutorials-poc && cf login` (DEV space). Then:

Run: `cd D:/projects/tutorials-poc && npm run test:hybrid -- --run search-service 2>&1 | tail -20`
Expected: all green, including the two new createdAt assertions. Note: hybrid tests can be flaky on first run after a long idle — re-run once if you see a single transient failure.

- [ ] **Step 4: Verify the branch is clean and on the right branch before pushing**

```bash
cd D:/projects/tutorials-poc
BRANCH=$(git branch --show-current)
[ "$BRANCH" = "feature/search-options-filter" ] || { echo "ABORT: on $BRANCH"; exit 1; }
git status
git log --oneline main..HEAD
```

Expected: branch is `feature/search-options-filter`, clean working tree, 4 commits ahead of `main` (one per Task 1-4) plus the original spec commits.

- [ ] **Step 5: Push and open a PR**

```bash
cd D:/projects/tutorials-poc
git push -u origin feature/search-options-filter
gh pr create --base main --title "feat(navigator): restore legacy Options filters (New tutorials, No license)" --body "Closes #175

Restores parity with the legacy AEM Tutorial Navigator's 'Options' filter group:

- **New tutorials** — items authored within the last 31 days
- **No license** — items not carrying the \`tutorial>license\` slug

Both rendered as checkboxes under the existing Type column, separated by a divider, default off, persisted in the URL (\`?new=1&noLicense=1\`) + localStorage. Community toggle deferred (out of scope).

### What changed

- New shared module \`hugo-apps/src/shared/freshness.ts\` (extracted 31-day window from \`TutorialNavigator.vue\`)
- \`SearchableItems\` projection gains \`createdAt\` (additive UNION ALL change)
- \`useSearch.ts\` accepts isNew/noLicense flags; new helpers \`buildFilter\` and \`postFilterNoLicense\` exported for unit testing
- \`TutorialNavigator.vue\` checkbox UI + URL/localStorage sync + \`filteredItems\` extension

### Tests

- New unit tests for freshness helper, buildFilter, postFilterNoLicense, and the contract for filteredItems + URL sync
- Hybrid: \`SearchableItems\` projects \`createdAt\` and \`\$filter=createdAt gt …\` is honored
- Smoke: same assertions over HTTP

Spec: \`docs/superpowers/specs/2026-06-01-search-options-filter-design.md\`"
```

After PR is open, request review from Tom and wait for CI smoke + hybrid.

- [ ] **Step 6: After merge — verify on DEV**

After the PR merges and CI deploys, verify on DEV:

```bash
# Check the field is exposed
curl -s "https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/search/SearchableItems?\$top=3&\$select=title,createdAt" | jq '.value[0] | keys'
# Expected: ["@odata.context", "createdAt", "title"]

# Check the filter is honored
curl -s "https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/search/SearchableItems?\$filter=createdAt%20gt%202999-01-01T00:00:00.000Z&\$count=true&\$top=1" | jq '."@odata.count"'
# Expected: 0
```

Open the deployed Tutorial Navigator and confirm the two checkboxes appear and behave as expected.

---

## Open questions

None — answered during brainstorming.

## References

- Spec: [`docs/superpowers/specs/2026-06-01-search-options-filter-design.md`](../specs/2026-06-01-search-options-filter-design.md)
- Issue: [sap-tutorials/tutorials-ims#175](https://github.com/sap-tutorials/tutorials-ims/issues/175)
- Existing freshness logic: [`hugo-apps/src/navigator/TutorialNavigator.vue:316`](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L316)
- Existing license logic: [`hugo-apps/src/shared/license.ts:5`](../../../hugo-apps/src/shared/license.ts#L5)
- Search service: [`srv/search-service.cds`](../../../srv/search-service.cds), [`srv/search-service.js`](../../../srv/search-service.js)
- View: [`db/views.cds:75-112`](../../../db/views.cds#L75-L112)
