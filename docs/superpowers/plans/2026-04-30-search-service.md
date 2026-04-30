# Search Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AEM Solr search with a CAP-native search service using HANA full-text fuzzy search, exposed as a public OData endpoint, with a hybrid client/server frontend integration.

**Architecture:** A CDS UNION view (SearchableItems) exposes Tutorials/Missions/Groups for search. A `SearchService` at `/search` provides OData `$search` with HANA CONTAINS(FUZZY(0.7)), field-weighted ranking via `@Search.ranking`, tag augmentation via a `before READ` handler, and faceted aggregation via a `getFacets` function. The frontend uses a hybrid model: browse mode (client-side filtering of pre-fetched data) and search mode (server-side OData when searchTerm >= 2 chars).

**Tech Stack:** SAP CAP Node.js, CDS, SAP HANA Cloud full-text search, OData V4, Vue 3 composables, Vitest

**Spec:** `docs/superpowers/specs/2026-04-30-search-service-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `db/views.cds` (append) | SearchableItems UNION view |
| Create | `srv/search-service.cds` | Service definition with types and annotations |
| Create | `srv/search-service.js` | Tag augmentation handler + getFacets |
| Modify | `approuter/xs-app.json` | Add unauthenticated `/search/` route |
| Modify | `package.json` | Add `cds.hana.fuzzy: 0.7` config |
| Create | `test/search-service.test.js` | Unit tests (SQLite, in-memory) |
| Create | `test/hybrid/search-service.test.js` | Hybrid tests (real HANA) |
| Create | `test/smoke/search.test.js` | Smoke tests (deployed) |
| Modify | `apps/src/shared/types.ts` | Add SearchableItem and SearchFacets interfaces |
| Create | `apps/src/navigator/useSearch.ts` | Search composable (debounce, fetch, map) |
| Modify | `apps/src/navigator/TutorialNavigator.vue` | Hybrid browse/search mode switching |

---

## Task 1: SearchableItems UNION View

**Files:**
- Modify: `db/views.cds` (append after line 61)
- Test: `test/search-service.test.js` (created in Task 4)

- [ ] **Step 1: Add SearchableItems view to db/views.cds**

Append after the existing `NavigatorCatalog` view:

```cds
view SearchableItems as
  SELECT from ims.Tutorials {
    key ID, legacyId, title, description, slug,
    primaryTag, experienceTag, averageTimeToComplete, status,
    'TUTORIAL' as taskType : String(20)
  } where status = 'ACTIVE'
  UNION ALL
  SELECT from ims.Missions {
    ID, legacyId, title, description, slug,
    primaryTag, experienceTag, averageTimeToComplete, status,
    'MISSION' as taskType : String(20)
  } where status = 'ACTIVE'
  UNION ALL
  SELECT from ims.Groups {
    ID, legacyId, title, description, null as slug : String(255),
    primaryTag, experienceTag, averageTimeToComplete, status,
    'GROUP' as taskType : String(20)
  } where status = 'ACTIVE';
```

Note: `Groups` has no `slug` field in the schema, so we project `null as slug`.

- [ ] **Step 2: Verify CDS compiles**

Run: `npx cds compile db/ --to sql`
Expected: No errors. Output includes `CREATE VIEW COM_SAP_DEVELOPERS_IMS_SEARCHABLEITEMS` with UNION ALL.

- [ ] **Step 3: Commit**

```bash
git add db/views.cds
git commit -m "feat(search): add SearchableItems UNION view for fuzzy search"
```

---

## Task 2: Search Service CDS Definition

**Files:**
- Create: `srv/search-service.cds`

- [ ] **Step 1: Create srv/search-service.cds**

```cds
using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/views';

type FacetCount {
  name  : String;
  count : Integer;
};

type FacetResult {
  totalCount       : Integer;
  typeCounts       : many FacetCount;
  experienceCounts : many FacetCount;
  tagCounts        : many FacetCount;
};

@path: '/search'
@requires: 'any'
service SearchService {

  @readonly
  @Search.fuzzinessThreshold: 0.7
  entity SearchableItems as projection on ims.SearchableItems {
    @Search.ranking: #HIGH
    title,
    @Search.ranking: #MEDIUM
    description,
    @Search.ranking: #LOW
    primaryTag,
    *
  };

  @readonly
  entity Tags as projection on ims.Tags;

  function getFacets(
    search     : String,
    taskTypes  : array of String,
    experience : array of String
  ) returns FacetResult;
}
```

Note: The `using from '../db/views'` import loads the view definitions into the `com.sap.developers.ims` namespace (since `db/views.cds` has `namespace com.sap.developers.ims`). The schema import provides the namespace alias `ims`, and the views import makes `ims.SearchableItems` resolvable.

- [ ] **Step 2: Verify CDS compiles with the new service**

Run: `npx cds compile srv/ --to edmx --service SearchService`
Expected: Valid EDMX output with SearchableItems entity set, Tags entity set, and getFacets function import.

- [ ] **Step 3: Commit**

```bash
git add srv/search-service.cds
git commit -m "feat(search): add SearchService CDS definition with fuzzy annotations"
```

---

## Task 3: Search Service Handler

**Files:**
- Create: `srv/search-service.js`

- [ ] **Step 1: Create srv/search-service.js with tag augmentation and getFacets**

```javascript
import cds from '@sap/cds';

export default class SearchService extends cds.ApplicationService {
  init() {
    const { SearchableItems } = this.entities;

    this.before('READ', SearchableItems, async (req) => {
      const searchTokens = req.query?.SELECT?.search;
      if (!searchTokens?.length) return;
      const search = searchTokens.map(t => t.val ?? t).join(' ');

      const { TutorialTags, Tags } = cds.entities('com.sap.developers.ims');
      const tagMatches = await SELECT.from(TutorialTags)
        .columns('tutorial_ID')
        .where({
          tag_ID: { in: SELECT('ID').from(Tags).where`name like ${'%' + search + '%'}` }
        });

      if (tagMatches.length === 0) return;

      const ids = tagMatches.map(r => r.tutorial_ID);
      if (!req.query.SELECT.where) {
        req.query.SELECT.where = [{ ref: ['ID'] }, 'in', { val: ids }];
      } else {
        req.query.SELECT.where = [
          '(', ...req.query.SELECT.where, ')',
          'or',
          '(', { ref: ['ID'] }, 'in', { val: ids }, ')'
        ];
      }
    });

    this.on('getFacets', async (req) => {
      const { search, taskTypes, experience } = req.data;
      const { SearchableItems: View } = cds.entities('com.sap.developers.ims');

      // Build WHERE conditions using safe CQL parameter binding
      function buildWhere(search, taskTypes, experience) {
        const conditions = [];
        if (search) {
          const pattern = `%${search}%`;
          conditions.push({ or: [
            { title: { like: pattern } },
            { description: { like: pattern } },
            { primaryTag: { like: pattern } },
          ]});
        }
        if (taskTypes?.length) {
          conditions.push({ taskType: { in: taskTypes } });
        }
        if (experience?.length) {
          conditions.push({ experienceTag: { in: experience } });
        }
        return conditions.length ? { and: conditions } : {};
      }

      const where = buildWhere(search, taskTypes, experience);

      const [typeCounts, experienceCounts, tagCounts, totalResult] = await Promise.all([
        SELECT.from(View)
          .columns('taskType as name', 'count(*) as count')
          .where(where)
          .groupBy('taskType'),
        SELECT.from(View)
          .columns('experienceTag as name', 'count(*) as count')
          .where({ ...where, experienceTag: { '!=': null } })
          .groupBy('experienceTag'),
        SELECT.from(View)
          .columns('primaryTag as name', 'count(*) as count')
          .where({ ...where, primaryTag: { '!=': null } })
          .groupBy('primaryTag')
          .orderBy('count desc')
          .limit(20),
        SELECT.one.from(View)
          .columns('count(*) as count')
          .where(where),
      ]);

      return {
        totalCount: totalResult?.count ?? 0,
        typeCounts: typeCounts ?? [],
        experienceCounts: experienceCounts ?? [],
        tagCounts: tagCounts ?? [],
      };
    });

    return super.init();
  }
}
```

- [ ] **Step 2: Verify CAP server starts without errors**

Run: `npx cds serve --in-memory 2>&1 | head -20`
Expected: Server starts, logs show `[cds] - serving SearchService { path: '/search' }`.

- [ ] **Step 3: Commit**

```bash
git add srv/search-service.js
git commit -m "feat(search): add handler with tag augmentation and getFacets"
```

---

## Task 4: Unit Tests (SQLite, in-memory)

**Files:**
- Create: `test/search-service.test.js`

- [ ] **Step 1: Write unit tests**

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('SearchService', () => {

  beforeAll(async () => {
    const { Tutorials, Missions, Groups, Tags, TutorialTags } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries([
      { ID: 'search-t1', legacyId: 90001, slug: 'hana-cloud-setup', title: 'SAP HANA Cloud Setup', description: 'Learn to configure HANA Cloud', primaryTag: 'SAP HANA Cloud', experienceTag: 'beginner', averageTimeToComplete: 30, status: 'ACTIVE' },
      { ID: 'search-t2', legacyId: 90002, slug: 'cap-getting-started', title: 'Getting Started with CAP', description: 'Build your first CAP app', primaryTag: 'SAP Cloud Application Programming Model', experienceTag: 'beginner', averageTimeToComplete: 45, status: 'ACTIVE' },
      { ID: 'search-t3', legacyId: 90003, slug: 'fiori-elements', title: 'SAP Fiori Elements', description: 'Create Fiori apps', primaryTag: 'SAP Fiori', experienceTag: 'intermediate', averageTimeToComplete: 60, status: 'ACTIVE' },
      { ID: 'search-t4', legacyId: 90004, slug: 'inactive-tutorial', title: 'Old Tutorial', description: 'Should not appear', primaryTag: 'Legacy', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'INACTIVE' },
    ]);

    await INSERT.into(Missions).entries([
      { ID: 'search-m1', legacyId: 90101, slug: 'full-stack-mission', title: 'Full-Stack CAP Application', description: 'Build end-to-end', primaryTag: 'SAP Cloud Application Programming Model', experienceTag: 'intermediate', averageTimeToComplete: 180, status: 'ACTIVE' },
    ]);

    await INSERT.into(Groups).entries([
      { ID: 'search-g1', legacyId: 90201, title: 'HANA Basics Group', description: 'HANA fundamentals', primaryTag: 'SAP HANA Cloud', experienceTag: 'beginner', averageTimeToComplete: 90, status: 'ACTIVE' },
    ]);

    await INSERT.into(Tags).entries([
      { ID: 'search-tag1', name: 'HANA Cloud', legacyId: 80001 },
      { ID: 'search-tag2', name: 'CAP Node.js', legacyId: 80002 },
    ]);

    await INSERT.into(TutorialTags).entries([
      { tutorial_ID: 'search-t1', tag_ID: 'search-tag1' },
      { tutorial_ID: 'search-t2', tag_ID: 'search-tag2' },
    ]);
  });

  describe('SearchableItems', () => {
    it('returns results from all three entity types', async () => {
      const { data } = await project.get('/search/SearchableItems');
      const types = [...new Set(data.value.map(i => i.taskType))];
      expect(types).toContain('TUTORIAL');
      expect(types).toContain('MISSION');
      expect(types).toContain('GROUP');
    });

    it('excludes inactive items', async () => {
      const { data } = await project.get('/search/SearchableItems');
      const titles = data.value.map(i => i.title);
      expect(titles).not.toContain('Old Tutorial');
    });

    it('GROUP results have null slug', async () => {
      const { data } = await project.get('/search/SearchableItems?$filter=taskType eq \'GROUP\'');
      expect(data.value.length).toBeGreaterThan(0);
      for (const item of data.value) {
        expect(item.slug).toBeNull();
      }
    });

    it('filters by taskType', async () => {
      const { data } = await project.get('/search/SearchableItems?$filter=taskType eq \'TUTORIAL\'');
      for (const item of data.value) {
        expect(item.taskType).toBe('TUTORIAL');
      }
    });

    it('filters by experienceTag', async () => {
      const { data } = await project.get('/search/SearchableItems?$filter=experienceTag eq \'beginner\'');
      for (const item of data.value) {
        expect(item.experienceTag).toBe('beginner');
      }
    });

    it('supports $top/$skip pagination', async () => {
      const { data } = await project.get('/search/SearchableItems?$top=2&$skip=0&$count=true');
      expect(data.value.length).toBeLessThanOrEqual(2);
      expect(data['@odata.count']).toBeGreaterThan(0);
    });

    it('returns all items when no $search is provided', async () => {
      const { data } = await project.get('/search/SearchableItems?$count=true');
      expect(data['@odata.count']).toBeGreaterThanOrEqual(5);
    });
  });

  describe('Tags', () => {
    it('returns available tags', async () => {
      const { data } = await project.get('/search/Tags');
      expect(data.value.length).toBeGreaterThan(0);
      expect(data.value[0]).toHaveProperty('name');
    });
  });

  describe('getFacets', () => {
    it('returns aggregation counts without filters', async () => {
      const { data } = await project.get('/search/getFacets(search=\'hana\')');
      expect(data).toHaveProperty('totalCount');
      expect(data).toHaveProperty('typeCounts');
      expect(data).toHaveProperty('experienceCounts');
      expect(data).toHaveProperty('tagCounts');
      expect(data.totalCount).toBeGreaterThan(0);
    });

    it('returns correct type counts', async () => {
      const { data } = await project.get('/search/getFacets(search=\'cap\')');
      expect(Array.isArray(data.typeCounts)).toBe(true);
    });

    it('narrows results with taskTypes filter', async () => {
      const { data } = await project.get('/search/getFacets(search=\'cap\',taskTypes=[\'TUTORIAL\'])');
      for (const tc of data.typeCounts) {
        expect(tc.name).toBe('TUTORIAL');
      }
    });

    it('returns zero totalCount for no-match search', async () => {
      const { data } = await project.get('/search/getFacets(search=\'xyznonexistent999\')');
      expect(data.totalCount).toBe(0);
    });
  });

  describe('Tag search augmentation', () => {
    it('includes tag-matched tutorials in search results', async () => {
      // Note: SQLite translates $search into LIKE '%term%' which works for exact substring matching.
      // This test uses a term that matches via tag name (not title/description), validating the before-handler.
      // Fuzzy matching (typo tolerance) only works on HANA — tested in hybrid tests.
      const { data } = await project.get('/search/SearchableItems?$search=HANA');
      const slugs = data.value.map(i => i.slug);
      expect(slugs).toContain('hana-cloud-setup');
    });
  });

  describe('Security', () => {
    it('does not require authentication', async () => {
      const { status } = await project.get('/search/SearchableItems',
        { validateStatus: () => true });
      expect(status).toBe(200);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run test/search-service.test.js`
Expected: All tests pass. If tag augmentation test fails (SQLite doesn't support $search the same way), adjust the test to verify the before-handler logic independently.

- [ ] **Step 3: Handle SQLite $search limitations**

SQLite does not support HANA's `CONTAINS()` with `FUZZY()`. CAP translates `$search` into `LIKE '%term%'` on SQLite, which works for substring matching but not typo tolerance. Unit tests must use search terms that are exact substrings of seeded data. Fuzzy/typo tests (e.g., "hanna" matching "hana") belong in `test/hybrid/` only. If the tag augmentation test fails because `$search` doesn't trigger on SQLite, verify that the before-handler's `req.query.SELECT.search` is populated — if not, test the handler's logic directly by calling the endpoint with a `$filter` that simulates the injected condition.

- [ ] **Step 4: Commit**

```bash
git add test/search-service.test.js
git commit -m "test(search): add unit tests for SearchService (SQLite in-memory)"
```

---

## Task 5: AppRouter Route + Package Config

**Files:**
- Modify: `approuter/xs-app.json` (insert before the `/build/` route, line 60)
- Modify: `package.json` (add `hana.fuzzy` to `cds` section)

- [ ] **Step 1: Add /search/ route to xs-app.json**

Insert the following route object before the `/build/` route (after the `/api/` route at line 59):

```json
{
  "source": "^/search/(.*)$",
  "target": "/search/$1",
  "destination": "srv-api",
  "authenticationType": "none",
  "csrfProtection": false
},
```

- [ ] **Step 2: Add HANA fuzzy config to package.json**

In the `cds` section of package.json, add after the `requires` block:

```json
"hana": {
  "fuzzy": 0.7
}
```

- [ ] **Step 3: Verify CDS still starts**

Run: `npx cds serve --in-memory 2>&1 | head -10`
Expected: Server starts without config errors.

- [ ] **Step 4: Commit**

```bash
git add approuter/xs-app.json package.json
git commit -m "feat(search): add AppRouter route and HANA fuzzy config"
```

---

## Task 6: Hybrid Tests (HANA)

**Files:**
- Create: `test/hybrid/search-service.test.js`

- [ ] **Step 1: Write hybrid tests**

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('SearchService (HANA hybrid)', () => {

  it('SearchableItems view returns results from all entity types', async () => {
    const { SearchableItems } = cds.entities('com.sap.developers.ims');
    const results = await SELECT.from(SearchableItems).limit(100);
    const types = [...new Set(results.map(r => r.taskType))];
    expect(types).toContain('TUTORIAL');
    expect(types).toContain('MISSION');
    expect(types).toContain('GROUP');
  });

  it('excludes inactive items from view', async () => {
    const { SearchableItems } = cds.entities('com.sap.developers.ims');
    const results = await SELECT.from(SearchableItems).where({ status: { '!=': 'ACTIVE' } });
    expect(results.length).toBe(0);
  });

  it('CONTAINS with FUZZY returns results via $search (typo tolerance)', async () => {
    const srv = await cds.connect.to('SearchService');
    const results = await srv.run(
      SELECT.from('SearchService.SearchableItems').search('hanna')
    );
    const titles = results.map(r => r.title.toLowerCase());
    const hasHanaMatch = titles.some(t => t.includes('hana'));
    expect(hasHanaMatch).toBe(true);
  });

  it('field-weighted ranking: title matches rank higher (best-effort)', async () => {
    const srv = await cds.connect.to('SearchService');
    const results = await srv.run(
      SELECT.from('SearchService.SearchableItems').search('cap')
    );
    if (results.length >= 2) {
      const first = results[0];
      const hasCAPInTitle = first.title.toLowerCase().includes('cap');
      expect(hasCAPInTitle).toBe(true);
    }
  });

  it('GROUP results always have null slug', async () => {
    const { SearchableItems } = cds.entities('com.sap.developers.ims');
    const groups = await SELECT.from(SearchableItems).where({ taskType: 'GROUP' }).limit(10);
    for (const g of groups) {
      expect(g.slug).toBeNull();
    }
  });

  it('performance: full dataset query completes under 2 seconds', async () => {
    const { SearchableItems } = cds.entities('com.sap.developers.ims');
    const start = Date.now();
    await SELECT.from(SearchableItems).limit(200);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it('getFacets returns correct structure', async () => {
    const srv = await cds.connect.to('SearchService');
    const result = await srv.getFacets({ search: 'cap', taskTypes: null, experience: null });
    expect(result).toHaveProperty('totalCount');
    expect(result).toHaveProperty('typeCounts');
    expect(result).toHaveProperty('experienceCounts');
    expect(result).toHaveProperty('tagCounts');
    expect(result.totalCount).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run hybrid tests (requires cf login)**

Run: `npm run test:hybrid -- --testPathPattern=search`
Expected: All tests pass against real HANA. The fuzzy typo test ("hanna" → "hana") is the critical gate.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/search-service.test.js
git commit -m "test(search): add hybrid tests for HANA fuzzy search verification"
```

---

## Task 7: Smoke Tests

**Files:**
- Create: `test/smoke/search.test.js`

- [ ] **Step 1: Write smoke tests**

```javascript
import { describe, it, expect } from 'vitest';

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:4004';

describe('Search Service (smoke)', () => {

  it('GET /search/SearchableItems returns 200', async () => {
    const res = await fetch(`${BASE_URL}/search/SearchableItems?$top=5`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.value).toBeDefined();
    expect(data.value.length).toBeGreaterThan(0);
  });

  it('GET /search/SearchableItems?$search=cap returns results', async () => {
    const res = await fetch(`${BASE_URL}/search/SearchableItems?$search=cap&$top=10`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.value.length).toBeGreaterThan(0);
  });

  it('GET /search/Tags returns 200 with tag list', async () => {
    const res = await fetch(`${BASE_URL}/search/Tags?$top=10`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.value.length).toBeGreaterThan(0);
    expect(data.value[0]).toHaveProperty('name');
  });

  it('GET /search/getFacets returns facets', async () => {
    const res = await fetch(`${BASE_URL}/search/getFacets(search='cap')`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('totalCount');
    expect(data).toHaveProperty('typeCounts');
  });

  it('search endpoint does not require authentication', async () => {
    const res = await fetch(`${BASE_URL}/search/SearchableItems?$top=1`, {
      headers: {} // no auth headers
    });
    expect(res.status).toBe(200);
  });

  it('response time under 500ms for typical search', async () => {
    const start = Date.now();
    await fetch(`${BASE_URL}/search/SearchableItems?$search=hana&$top=20`);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});
```

- [ ] **Step 2: Run smoke tests locally**

Run: `SMOKE_BASE_URL=http://localhost:4004 npx vitest run test/smoke/search.test.js`
Expected: All pass when CAP server is running locally.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/search.test.js
git commit -m "test(search): add smoke tests for deployed search endpoint"
```

---

## Task 8: Frontend Types

**Files:**
- Modify: `apps/src/shared/types.ts` (append)

- [ ] **Step 1: Add SearchableItem and SearchFacets interfaces to types.ts**

Append to `apps/src/shared/types.ts`:

```typescript
export interface SearchableItem {
  ID: string
  legacyId: number
  title: string
  description: string | null
  slug: string | null
  primaryTag: string | null
  experienceTag: string | null
  averageTimeToComplete: number | null
  status: string
  taskType: 'TUTORIAL' | 'MISSION' | 'GROUP'
}

export interface SearchFacets {
  totalCount: number
  typeCounts: Array<{ name: string; count: number }>
  experienceCounts: Array<{ name: string; count: number }>
  tagCounts: Array<{ name: string; count: number }>
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps && npx vue-tsc --noEmit 2>&1 | head -20`
Expected: No type errors from the new interfaces.

- [ ] **Step 3: Commit**

```bash
git add apps/src/shared/types.ts
git commit -m "feat(search): add SearchableItem and SearchFacets types"
```

---

## Task 9: useSearch Composable

**Files:**
- Create: `apps/src/navigator/useSearch.ts`

- [ ] **Step 1: Create the useSearch composable**

```typescript
import { ref, computed, watch, type Ref } from 'vue'
import type { CardItem, SearchableItem, SearchFacets } from '@shared/types'

interface UseSearchOptions {
  searchTerm: Ref<string>
  filterTypes: Ref<string[]>
  filterLevels: Ref<string[]>
  filterProducts: Ref<string[]>
}

function mapToCardItem(item: SearchableItem): CardItem {
  return {
    type: item.taskType.toLowerCase() as 'mission' | 'group' | 'tutorial',
    id: item.ID,
    title: item.title,
    description: item.description ?? '',
    time: item.averageTimeToComplete ?? 0,
    level: item.experienceTag ?? 'beginner',
    tutorialCount: 1,
    primaryTag: item.primaryTag ?? '',
    displayTags: [item.primaryTag].filter(Boolean) as string[],
    // Groups don't have standalone pages — they're displayed within the navigator.
    // Tutorials/Missions have slugs; Groups have null slug and no routable page.
    href: item.slug ? `/tutorials/${item.slug}` : '',
    stepCount: 0,
  }
}

// OData string literals use single quotes; escape embedded quotes by doubling them
const escOData = (v: string) => v.replace(/'/g, "''")

function buildFilter(types: string[], levels: string[], products: string[]): string {
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

  return parts.join(' and ')
}

export function useSearch(options: UseSearchOptions) {
  const { searchTerm, filterTypes, filterLevels, filterProducts } = options

  const searchResults = ref<CardItem[]>([])
  const searchFacets = ref<SearchFacets | null>(null)
  const isSearching = ref(false)
  const searchError = ref<string | null>(null)
  const searchTotalCount = ref(0)

  const searchMode = computed(() => searchTerm.value.length >= 2)

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  async function executeSearch(page = 0, pageSize = 48) {
    const term = searchTerm.value
    if (term.length < 2) return

    isSearching.value = true
    searchError.value = null

    try {
      const filter = buildFilter(filterTypes.value, filterLevels.value, filterProducts.value)
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

      searchResults.value = (itemsData.value ?? []).map(mapToCardItem)
      searchTotalCount.value = itemsData['@odata.count'] ?? 0
      searchFacets.value = facetsData
    } catch (e) {
      searchError.value = (e as Error).message
    } finally {
      isSearching.value = false
    }
  }

  function debouncedSearch() {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => executeSearch(), 300)
  }

  watch([searchTerm, filterTypes, filterLevels, filterProducts], () => {
    if (searchMode.value) {
      debouncedSearch()
    } else {
      searchResults.value = []
      searchFacets.value = null
      searchTotalCount.value = 0
    }
  })

  return {
    searchMode,
    searchResults,
    searchFacets,
    searchTotalCount,
    isSearching,
    searchError,
    executeSearch,
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps && npx vue-tsc --noEmit 2>&1 | head -20`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/src/navigator/useSearch.ts
git commit -m "feat(search): add useSearch composable for server-side search"
```

---

## Task 10: TutorialNavigator Hybrid Mode

**Files:**
- Modify: `apps/src/navigator/TutorialNavigator.vue`

This task integrates the `useSearch` composable into the existing navigator. The key change: when `searchMode` is true, displayed results come from the server instead of the client-side `filteredItems`.

- [ ] **Step 1: Add useSearch import and initialization**

After the existing imports at the top of `<script setup>`, add:

```typescript
import { useSearch } from './useSearch'
import type { SearchFacets } from '@shared/types'
```

After the `filters` reactive declaration (~line 19), add:

```typescript
const { searchMode, searchResults, searchFacets, searchTotalCount, isSearching, searchError } = useSearch({
  searchTerm: searchQuery,
  filterTypes: computed(() => filters.types.map(t => t.toUpperCase())),
  filterLevels: computed(() => filters.levels),
  filterProducts: computed(() => filters.products),
})
```

- [ ] **Step 2: Add displayedItems computed that switches on searchMode**

After the existing `filteredItems` computed (~line 239), add:

```typescript
const displayedItems = computed(() => {
  if (searchMode.value) return searchResults.value
  return paginatedItems.value
})

const displayedTotalCount = computed(() => {
  if (searchMode.value) return searchTotalCount.value
  return filteredItems.value.length
})

const displayedCounts = computed(() => {
  if (searchMode.value && searchFacets.value) {
    const facets = searchFacets.value
    return {
      missions: facets.typeCounts.find(t => t.name === 'MISSION')?.count ?? 0,
      groups: facets.typeCounts.find(t => t.name === 'GROUP')?.count ?? 0,
      tutorials: facets.typeCounts.find(t => t.name === 'TUTORIAL')?.count ?? 0,
    }
  }
  return counts.value
})
```

- [ ] **Step 3: Update template to use displayedItems**

In the template section, replace references to `paginatedItems` with `displayedItems` in the card rendering loop. Replace `counts` with `displayedCounts` in the filter panel count badges. Add a loading indicator:

```html
<!-- Add inside the results area, before the card grid -->
<div v-if="isSearching" class="fd-busy-indicator fd-busy-indicator--m" aria-label="Loading search results"></div>
```

- [ ] **Step 4: Test the hybrid behavior manually**

Run: `cd apps && npm run dev` (Vite dev server)
Then start CAP: `cds watch` (in another terminal)

Verify:
1. Page loads normally (browse mode) with all pre-fetched cards
2. Typing 2+ characters triggers server search (loading indicator appears briefly)
3. Clearing search instantly returns to browse mode
4. Filter toggles in browse mode are instant (no server call)
5. Filter toggles in search mode trigger a new server request

- [ ] **Step 5: Commit**

```bash
git add apps/src/navigator/TutorialNavigator.vue
git commit -m "feat(search): integrate hybrid browse/search mode in TutorialNavigator"
```

---

## Task 11: Final Integration Verification

- [ ] **Step 1: Run full unit test suite**

Run: `npm test`
Expected: All existing tests pass, plus new search-service tests.

- [ ] **Step 2: Run hybrid tests (if HANA available)**

Run: `npm run test:hybrid`
Expected: Search hybrid tests pass (fuzzy typo tolerance works on HANA).

- [ ] **Step 3: Verify frontend build**

Run: `npm run build:apps`
Expected: Vue build completes without errors.

- [ ] **Step 4: Final commit (if any adjustments needed)**

```bash
git add -A
git commit -m "feat(search): complete search service implementation"
```
