# Search Service Design

**Date:** 2026-04-30
**Status:** Approved
**Replaces:** AEM Solr Search endpoint (`/bin/sapdx/v3/solr/search`)

## Purpose

Replace the AEM Solr-backed search endpoint with a CAP-native search service that leverages SAP HANA Cloud's built-in full-text fuzzy search. The new service provides:

- Typo-tolerant fuzzy text search across tutorials, missions, and groups
- Field-weighted ranking (title > description > tags)
- Faceted aggregation (counts by task type, experience level, primary tag)
- Tag-based search via associated tag names
- Standard OData query composition ($search, $filter, $orderby, $top/$skip, $count)
- Unauthenticated access (public, no XSUAA required)

## Architecture

### Overview

```text
Client (Hugo frontend / tutorial navigator)
  |
  +- GET /search/SearchableItems?$search=...&$filter=...&$top=20
  |    -> CAP OData handler -> HANA CONTAINS() with FUZZY(0.7)
  |    -> before READ handler injects tag-matched IDs into WHERE clause
  |    -> CAP applies $top/$skip pagination AFTER merged filter
  |    -> Returns ranked OData result set
  |
  +- GET /search/getFacets(search='...')
  |    -> Custom function -> aggregation queries
  |    -> Returns { typeCounts, experienceCounts, tagCounts, totalCount }
  |
  +- GET /search/Tags
       -> Standard OData read on Tags entity
       -> Returns available tags for filter UI
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| Search view | `db/views.cds` | UNION view across Tutorials/Missions/Groups with search annotations |
| Service definition | `srv/search-service.cds` | Public OData service exposing SearchableItems, Tags, getFacets |
| Custom handler | `srv/search-service.js` | Tag-search augmentation (before READ) + getFacets implementation |
| Configuration | `package.json` (cds section) | HANA fuzzy threshold setting |
| AppRouter route | `approuter/xs-app.json` | Unauthenticated route for `/search/` path |

## Deployment

### AppRouter Route

Add to `approuter/xs-app.json` (before the catch-all static route, after `/health`):

```json
{
  "source": "^/search/(.*)$",
  "target": "/search/$1",
  "destination": "srv-api",
  "authenticationType": "none",
  "csrfProtection": false
}
```

This mirrors the existing `/build/` route pattern. Without this route, the AppRouter will not proxy search requests to the CAP backend in production.

## Data Model

### SearchableItems View

A new UNION view in `db/views.cds` combining Tutorials, Missions, and Groups (excludes Steps and Checkpoints which are not user-navigable):

```cds
view SearchableItems as
  SELECT from ims.Tutorials {
    key ID, legacyId, title, description, slug,
    primaryTag, experienceTag, averageTimeToComplete, status,
    'TUTORIAL' as taskType : String(20)
  } where status = 'active'
  UNION ALL
  SELECT from ims.Missions {
    ID, legacyId, title, description, slug,
    primaryTag, experienceTag, averageTimeToComplete, status,
    'MISSION' as taskType : String(20)
  } where status = 'active'
  UNION ALL
  SELECT from ims.Groups {
    ID, legacyId, title, description, null as slug : String(255),
    primaryTag, experienceTag, averageTimeToComplete, status,
    'GROUP' as taskType : String(20)
  } where status = 'active';
```

**Client contract:** The `slug` field is nullable. GROUP results will always have `slug = null` because the `Groups` entity does not have a slug field in the schema. Clients must handle this — e.g., fall back to `legacyId` for constructing GROUP navigation URLs.

### Search Ranking

Field-weighted ranking uses `@Search.ranking` annotations on the service projection. Note: ranking on UNION views is best-effort — HANA may not apply the same weighting optimizations as it does on base tables. Hybrid tests gate this.

| Field | Ranking | Rationale |
|-------|---------|-----------|
| `title` | HIGH | Primary identifier, most relevant for user intent |
| `description` | MEDIUM | Secondary context, useful for broader matches |
| `primaryTag` | LOW | Categorical match, less likely to be free-text searched |
| `Tags.name` (via handler) | MEDIUM | Associated tag names supplement fuzzy matching |

### Risk: CONTAINS on UNION View

HANA's `CONTAINS()` with `FUZZY()` on a UNION ALL view is not a widely documented pattern. CAP translates `$search` into CONTAINS predicates, but behavior on UNION views (especially ranking quality) is not guaranteed to match single-table performance.

**Mitigation:** Hybrid tests (against real HANA) must verify:

1. Fuzzy search returns results from all three entity types
2. Typo tolerance works (e.g., "hanna" matches "hana")
3. Performance is acceptable with full dataset (~1700 items)

If CONTAINS on the UNION view proves unreliable, the fallback is to query each base entity separately and merge results in the handler.

## Service Definition

File: `srv/search-service.cds`

```cds
using from '../db/views';
using { com.sap.developers.ims as ims } from '../db/schema';

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

## Custom Handler

File: `srv/search-service.js`

### Tag-Search Augmentation (before READ)

When `$search` is present on SearchableItems, the handler intercepts the request **before** CAP's default processing to inject additional matching criteria. This ensures tag-matched results participate in standard pagination.

Logic:

1. In `before READ` of SearchableItems, detect if `req.query.search` is present
2. Query tutorial IDs whose associated tag names fuzzy-match the search term (via TutorialTags join)
3. Modify the CQL query to add an OR condition: `ID in (<tag-matched-IDs>)`
4. CAP's default handler then executes the enriched query — HANA applies CONTAINS on title/description/primaryTag AND includes the tag-matched IDs
5. Standard `$top/$skip` pagination applies correctly to the merged result set

This approach avoids the broken pattern of post-merge pagination (where merging after CAP applies $top would yield incorrect page sizes).

**Scope limitation:** Tag augmentation only applies to Tutorials (the only entity with a Tags association). Missions and Groups matched solely by title/description/primaryTag still participate via the UNION.

### getFacets Implementation

Executes aggregation queries against the SearchableItems view, applying the same fuzzy filter:

1. Count by `taskType` (TUTORIAL, MISSION, GROUP)
2. Count by `experienceTag` (beginner, intermediate, advanced)
3. Count by `primaryTag` (top N most common tags in matching results)
4. Total count of all matching items

When `taskTypes` or `experience` filter parameters are provided, they narrow the aggregation scope.

The function uses `cds.run()` with CQL queries directly against the SearchableItems view, applying CONTAINS/LIKE conditions that mirror what CAP's $search would generate.

## Configuration

Add to `package.json` in the `cds` section:

```json
{
  "cds": {
    "hana": {
      "fuzzy": 0.7
    }
  }
}
```

This sets the default fuzziness threshold globally (documented in CAP Node.js November 2024 release). The `@Search.fuzzinessThreshold: 0.7` annotation on the service entity provides the same value at the entity level for explicitness. A value of 0.7 allows moderate typo tolerance (e.g., "tutroial" matches "tutorial").

## Client Usage Examples

### Basic search

```http
GET /search/SearchableItems?$search=hana cloud&$top=20
```

### Filtered search

```http
GET /search/SearchableItems?$search=cap&$filter=taskType eq 'TUTORIAL'&$top=20
```

### Combined filters

```http
GET /search/SearchableItems?$search=fiori&$filter=taskType eq 'MISSION' and experienceTag eq 'intermediate'&$orderby=title&$top=10&$skip=0&$count=true
```

### Facets for filter panel

```http
GET /search/getFacets(search='hana cloud')
GET /search/getFacets(search='hana cloud',taskTypes=['TUTORIAL','MISSION'])
```

### Available tags for filter UI

```http
GET /search/Tags?$orderby=name
```

### Handling nullable slug (client responsibility)

```javascript
// CLIENT CODE — handle null slug for GROUP results
const url = item.slug
  ? `/tutorials/${item.slug}`
  : `/group/${item.legacyId}`;  // fallback for GROUPs
```

## Enhancements Over AEM Solr

| Capability | AEM Solr | CAP SearchService |
|-----------|----------|-------------------|
| Fuzzy/typo-tolerant search | No | Yes (HANA CONTAINS with FUZZY) |
| Field-weighted ranking | Limited | Yes (@Search.ranking HIGH/MEDIUM/LOW) |
| Tag-based fuzzy search | Exact match only | Yes (fuzzy on Tag.name via handler) |
| OData query composition | No (custom JSON protocol) | Yes ($search + $filter + $orderby + $top/$skip + $count) |
| Pagination | Custom (rows/start params) | Standard OData ($top/$skip) |
| Inline count | Separate field | Standard OData ($count=true) |
| Slug for deep linking | publicUrl with regex parsing | Direct slug field (nullable for GROUPs) |
| Filter composability | Fixed facet selections | Arbitrary $filter expressions |

## Testing

### Unit tests (SQLite, in-memory)

- SearchableItems returns results from all three entity types
- getFacets returns correct aggregation counts
- $filter narrows results by taskType, experienceTag
- Tag search augmentation includes tag-matched tutorials in results
- Empty search returns all items (no $search = no fuzzy filter)
- Nullable slug: GROUP results have null slug

### Hybrid tests (HANA) — GATES deployment

These tests are mandatory before production deployment. They validate HANA-specific behavior that SQLite cannot replicate:

- Fuzzy search matches typos (e.g., "hanna" -> "hana")
- @Search.ranking produces correct ordering (title matches rank higher) — best-effort verification
- CONTAINS with FUZZY threshold respects configured 0.7
- **CONTAINS on UNION view returns results from all entity types** (critical gate)
- Tag augmentation via before-handler correctly injects IDs
- Performance acceptable with full dataset (~1400 tutorials + ~87 missions + ~194 groups)

### Smoke tests (deployed)

- `/search/SearchableItems?$search=cap` returns 200 with results
- `/search/Tags` returns 200 with tag list
- `/search/getFacets(search='cap')` returns 200 with counts
- No authentication required (anonymous access works via AppRouter)
- Response times under 500ms for typical searches

## Security

- Service is `@requires: 'any'` (unauthenticated) — same as AEM endpoint it replaces
- AppRouter route uses `authenticationType: "none"` — matching `/build/` pattern
- No write operations exposed (all entities are `@readonly`, function is read-only)
- No user-specific data exposed (only catalog metadata)
- HANA fuzzy search is parameterized (no SQL injection risk via $search)

## Frontend Integration

### Current State (`apps/src/navigator/TutorialNavigator.vue`)

The TutorialNavigator currently performs **all search and filtering client-side**:

1. On mount, fetches entire dataset: `/tutorials/_nav.json` (tutorials) + `/build/navigator` (missions/groups)
2. Constructs `CardItem[]` array by grouping tutorials into missions/groups locally
3. Search: `String.includes()` on title, description, and displayTags
4. Filters: level, type, product, topic — all applied as computed property filters
5. Pagination: client-side slice of filtered results (48 items per page)
6. Facet counts: computed from the filtered results array

This approach loads ~1700 items upfront and offers no fuzzy/typo tolerance.

### Target State

Replace the client-side search/filter with server-side OData queries to the SearchService. The navigator becomes a thin search UI that delegates to the backend.

### Changes Required

#### File: `apps/src/navigator/TutorialNavigator.vue`

**Data fetching — replace bulk load with on-demand search:**

| Current | New |
| ------- | --- |
| `fetch('/tutorials/_nav.json')` on mount | Remove — no longer needed for search |
| `fetch('/build/navigator')` on mount | Remove — SearchableItems already includes missions/groups |
| Local `allCards` computed property | Server query: `GET /search/SearchableItems?$search=...&$filter=...&$top=48&$skip=...&$count=true` |
| Local `counts` computed property | Server query: `GET /search/getFacets(search='...')` |

**Search behavior:**

- Debounce text input (300ms) before issuing `$search` query
- Show loading indicator while request is in flight
- Empty search box → omit `$search` param (returns all items, server-paginated)
- Minimum 2 characters before triggering search (avoid expensive single-char queries)

**Filter mapping to OData $filter:**

| UI Filter | OData $filter expression |
| --------- | ----------------------- |
| Type (mission/group/tutorial) | `taskType eq 'MISSION'` (uppercase to match UNION view) |
| Experience (beginner/intermediate/advanced) | `experienceTag eq 'intermediate'` |
| Product/Topic (tag-based) | `primaryTag eq 'SAP HANA Cloud'` |

Multiple selections within a filter group use `or`:
```text
$filter=taskType eq 'TUTORIAL' or taskType eq 'MISSION'
```

Cross-group filters combine with `and`:
```text
$filter=(taskType eq 'TUTORIAL' or taskType eq 'MISSION') and experienceTag eq 'beginner'
```

**Pagination — server-side:**

- Pass `$top=48&$skip={(page-1)*48}&$count=true`
- Use `@odata.count` from response for total page calculation
- No more client-side slice

**Facet counts — from getFacets:**

- Call `getFacets(search='...', taskTypes=[...], experience=[...])` alongside the main search query
- Map response `typeCounts` → toolbar count badges (Mission · Group · Tutorial)
- Update counts reactively when search/filter changes

**Result mapping — SearchableItems → CardItem:**

```typescript
// Map OData response to existing CardItem interface
function mapToCardItem(item: SearchableItem): CardItem {
  return {
    type: item.taskType.toLowerCase() as 'mission' | 'group' | 'tutorial',
    id: item.ID,
    title: item.title,
    description: item.description ?? '',
    time: item.averageTimeToComplete ?? 0,
    level: item.experienceTag ?? 'beginner',
    tutorialCount: 1,  // server doesn't aggregate this; display 1 for now
    primaryTag: item.primaryTag ?? '',
    displayTags: [item.primaryTag].filter(Boolean),
    href: item.slug ? `/tutorials/${item.slug}` : `/tutorials/?id=${item.legacyId}`,
    stepCount: 0,  // not available from search view
  }
}
```

**Note on `tutorialCount` and `stepCount`:** These fields are computed client-side today by grouping tutorials. The SearchableItems view returns flat results (each mission/group is its own row without child counts). For the MVP, these display as 1/0. A follow-up could add computed columns to the view or a separate detail lookup.

#### File: `apps/src/shared/types.ts`

Add a `SearchableItem` interface matching the OData response shape:

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

#### File: `apps/src/navigator/useSearch.ts` (new composable)

Extract search logic into a composable for testability:

```typescript
// Responsibilities:
// - Debounced $search query construction
// - $filter building from reactive filter state
// - Parallel fetch of SearchableItems + getFacets
// - Loading/error state management
// - Response mapping to CardItem[]
```

### UX Behavior Changes

| Behavior | Before (client-side) | After (server-side) |
| -------- | -------------------- | ------------------- |
| Initial load | Shows all ~1700 items immediately | Shows first page (48 items) immediately |
| Search latency | Instant (in-memory filter) | ~100-300ms (network + HANA query) |
| Typo tolerance | None | Yes (HANA fuzzy at 0.7 threshold) |
| Loading indicator | None needed | Required (spinner/skeleton during fetch) |
| Filter panel products/topics | Derived from loaded data | Derived from `getFacets` response (`tagCounts`) |
| URL state | Not reflected | Reflect search/filter in URL params for shareability |
| Offline / slow network | Works after initial load | Requires connectivity per search |

### Progressive Enhancement Strategy

To avoid a jarring transition, implement in two phases:

**Phase 1 (this spec):** Wire up server search for the text search box only. Keep the facet filters working against a locally-cached initial load (first page of all items via `/search/SearchableItems?$top=200`). This lets users experience fuzzy search immediately while filters still feel instant.

**Phase 2 (follow-up):** Move all filters to server-side `$filter` queries. Remove the bulk initial load entirely. Add URL state synchronization. Add loading skeletons.

### Filter Panel: Available Options

Currently, the "Software Product" and "Topic" filter lists are derived from the loaded tutorials' `displayTags` array. With server-side search, these need a source:

- **Experience levels:** Static list (beginner, intermediate, advanced) — no change needed
- **Types:** Static list (Mission, Group, Tutorial) — no change needed  
- **Products/Topics:** Use `/search/Tags?$orderby=name` to populate the filter panel. This replaces the client-side derivation from `displayTags`.

## Migration

The AEM Solr endpoint reference in `scripts/parsers/aem.ts` (Pattern A: full discovery) is already replaced by `/build/catalog`. The remaining client-side usage (Pattern B: icon/tag lookup for tutorial cards) will be replaced by this SearchService.

After deployment, remove:

- AEM Solr references from `TODO.md`
- Any remaining AEM fetch calls that used the search endpoint
