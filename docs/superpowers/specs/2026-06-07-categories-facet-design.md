# Categories Facet on `/browse/` (with LLM-Assisted Classification) — Design

- **Issue:** [#201](https://github.com/sap-tutorials/tutorials-ims/issues/201)
- **Parent:** [#174](https://github.com/sap-tutorials/tutorials-ims/issues/174) (now shipped — `/browse/` lives in `main`)
- **Depends on:** existing `Tags` admin app, existing `TutorialEmbedding` infra, existing AI Core / Azure OpenAI client used by [srv/lib/embedding-pipeline.js](../../../srv/lib/embedding-pipeline.js) and [srv/lib/chat-orchestrator.js](../../../srv/lib/chat-orchestrator.js).
- **Date:** 2026-06-07
- **Author:** Claude (with Tom's design decisions)

## Problem

Today's `/browse/` filter rail ports the navigator's existing facets (search, type, level, products, topics, isNew, noLicense). The SAP Discovery Center reference image that drove [#174](https://github.com/sap-tutorials/tutorials-ims/issues/174) shows a higher-level **Categories** group at the top of the rail (Application Development & Automation / Data & Analytics / Extended Planning & Analysis / Integration / Artificial Intelligence). That group acts as a coarse top-level taxonomy complementing the more granular product/topic filters below it.

#174's design alternative B deferred Categories explicitly because adding it required a categorization model — either a tag→category lookup, a new field on Missions/Groups, or derivation from existing tag prefixes — that would have dragged the A/B-able layout work out indefinitely. [#201](https://github.com/sap-tutorials/tutorials-ims/issues/201) picks that deferred work up.

The original #201 scope explicitly excluded *"auto-categorization via embeddings or LLM classification"*. This spec brings LLM-assisted classification back into scope as a hybrid — embedding similarity primary, LLM fallback for ambiguous cases — because hand-classifying ~1,500 catalog items (87 missions + 66 groups + ~1,400 tutorials) is real work and the project already runs both an embedding pipeline (`TutorialEmbedding`) and an AI Core / Azure OpenAI client.

## Goal

Add a **Categories** facet to the `/browse/` left filter rail, sitting above the existing groups. Each Mission, Group, and Tutorial gets up to 3 category assignments produced automatically by a hybrid embedding + LLM classifier, with admin override via both per-entity inline editing and a dedicated Categories Fiori app. Filtering is multi-select OR-combined within the group (matches Products/Topics behavior). The primary (top-confidence) category is shown as a chip on each card.

## Non-goals

- **No master-list CRUD** for the taxonomy in v1 — it's seeded once at deploy. Add/remove/rename categories is a follow-up.
- **No provenance tracking** — re-classification is destructive overwrite (reclassify deletes existing assignments and writes the new ones). Admin manual edits last only until next reclassify.
- **No per-language labels** — English-only matches the project's existing locale stance.
- **No nested taxonomy** — flat list, ~8–10 entries.
- **No secondary categories on cards** — only the primary chip.
- **No live progress streaming** during long backfills — single completion payload.
- **No feature flag** — schema and rail group are harmless before backfill (zero counts), so the rail can ship before assignments exist.
- **No auto-lock of admin overrides** against future re-classification.
- **No replacement of the Topics filter** — Categories and Topics coexist in the rail.

## Locked design decisions

Captured from Tom's `AskUserQuestion` answers during brainstorming.

| # | Question | Decision |
|---|---|---|
| 1 | Filter target | Categories apply to all card types (missions, groups, tutorials) |
| 2 | Cardinality | Multi-select checkboxes (OR-combined within the group) |
| 3 | Taxonomy | Discovery Center 5 + a few project-specific (~8–10 total) |
| 4 | Topics interaction | Categories above Topics in the rail; both coexist |
| 5 | Storage model | New `Categories` entity + 3 junction tables (mirrors how `Tags` works) |
| 6 | Classifier | Hybrid — embedding similarity primary, LLM fallback for no-match / ambiguous |
| 7 | Trigger | On-demand admin action + entity-create/update after-hook |
| 8 | Override UX | Both — inline (per-entity admin OP) + dedicated Categories Fiori app |
| 9 | Provenance | None — reclassify is destructive overwrite |
| 10 | URL | `?category=` in the shared `urlSync.ts` schema, comma-separated multi-value |
| 11 | Card display | Single primary chip, picked by top-confidence score |
| 12 | Rollout | Single PR with one-shot backfill on deploy (no feature flag) |
| 13 | LLM provider | Reuse existing AI Core client (Azure OpenAI / GPT-4o-mini) |

## Architecture

### Module map

```
db/
  schema.cds                          [CHANGED] +Categories, +MissionCategories,
                                      +GroupCategories, +TutorialCategories;
                                      inverse Composition of many on Missions,
                                      Groups, Tutorials.
  data/
    com.sap.developers.ims-Categories.csv
                                      [NEW] one-shot taxonomy seed (8 rows).
                                      File name follows the existing
                                      auto-load convention used by
                                      ChatSettings / TimeZones seeds.

srv/
  admin-service.cds                   [CHANGED] expose Categories + 3 junctions
                                      + classifyCategories() bound action.
  admin-service.js                    [CHANGED] bind classifyCategories() to
                                      classifier service.
  developer-service.cds               [CHANGED] expose Categories read-only
                                      via /build/catalog handler.
  lib/
    category-classifier.js            [NEW] decision tree (embedding → LLM
                                      fallback), batch + per-item modes.
    category-classifier.test.js       [NEW]
    category-seed-embeddings.js       [NEW] manage in-memory seed-embedding
                                      cache; recompute on seedDescription edit.
    build-catalog.js                  [CHANGED] include categorySlugs[] per
                                      card and top-level categories[] array.
                                      (Existing module wired in
                                      srv/server.js as buildCatalogHandler.)
  handlers/
    categories-after-hooks.js         [NEW] async fire-and-forget on insert,
                                      debounced 5s on update.
  __tests__/
    admin-service-categories.test.js  [NEW]

scripts/
  backfill-categories.cjs             [NEW] one-shot backfill, resumable,
                                      concurrency=4.
  parsers/
    cap.ts                            [CHANGED] thread categorySlugs from
                                      /build/catalog into hugo/data/browse.json
                                      and per-tutorial frontmatter.

hugo/
  layouts/
    partials/browse/_partials/
      filter-rail.html                [CHANGED] add Categories <details> group
                                      above existing facets.
    browse/
      list.html                       [CHANGED] honor ?category= for SSR
                                      first paint.
  data/
    browse.json                       [CHANGED] include categories[] (slug,
                                      label, sortOrder, activeCount).

hugo-apps/src/
  navigator/
    urlSync.ts                        [CHANGED] add 9th field 'category';
                                      comma-separated multi-value reader/writer.
    urlSync.test.ts                   [CHANGED] cover ?category= round-trip.
  shared/
    composables/
      useNavigatorFilters.ts          [CHANGED] selectedCategories: Ref<Set>;
                                      filter-application branch.
      useNavigatorFilters.test.ts     [CHANGED] multi-select OR-combine cases.
    cards/
      MissionCard.vue                 [CHANGED] category chip from
                                      categorySlugs[0].
      GroupCard.vue                   [CHANGED] (same)
      TutorialCard.vue                [CHANGED] (same)
      cards.test.ts                   [CHANGED] cover chip rendering.
      types.ts                        [CHANGED] CardItem.categorySlugs: string[].
  browse/
    BrowsePage.vue                    [UNCHANGED] uses useNavigatorFilters.
    controller.ts                     [CHANGED] wire SSR'd category checkboxes
                                      to selectedCategories ref.

app/admin/
  categories/                         [NEW] Fiori Elements app — master list,
                                      per-category OP, bulk-ops bar.
  admin-shell/                        [CHANGED] componentUsages + side-nav
                                      entry "Categories".
  admin-annotations.cds               [CHANGED] @UI annotations on Categories
                                      and on the 3 Mission/Group/Tutorial OPs
                                      to surface a Categories facet.

test/
  hybrid/
    categories-classifier.test.js     [NEW] real HANA + AI Core, gated by
                                      HYBRID_AI_TESTS=true.
  smoke/
    browse-categories.test.js         [NEW] HTTP /build/catalog +
                                      /browse/?category=ai checks.
```

## Component design

### 1. Taxonomy

The master taxonomy ships as a one-shot DB seed. v1 admins can edit `label`, `sortOrder`, and `seedDescription` via the Categories app, but not add or remove rows.

| slug | label | sortOrder |
|---|---|---|
| `app-dev-automation` | Application Development & Automation | 10 |
| `data-analytics` | Data & Analytics | 20 |
| `extended-planning` | Extended Planning & Analysis | 30 |
| `integration` | Integration | 40 |
| `artificial-intelligence` | Artificial Intelligence | 50 |
| `frontend-ux` | Frontend & UX | 60 |
| `cloud-operations` | Cloud & Operations | 70 |
| `abap-core` | ABAP & Core | 80 |

The first 5 mirror the SAP Discovery Center reference set verbatim. The last 3 cover catalog content that wouldn't fit the first 5 cleanly: SAP Fiori / UI5 / Mobile (`frontend-ux`), Cloud Foundry / HANA Cloud / security ops (`cloud-operations`), ABAP RAP / CDS / transports (`abap-core`).

`sortOrder` controls rail render order **and** tie-breaks when classifier scores are identical.

### 2. Schema

Three new entities + three junction tables, all under `com.sap.developers.ims`:

```cds
entity Categories : cuid, managed {
  slug             : String(64) @mandatory;
  label            : String(255) @mandatory;
  sortOrder        : Integer default 100;
  seedDescription  : LargeString;        // editable; tunes classifier accuracy
}

entity MissionCategories : cuid {
  mission   : Association to Missions;
  category  : Association to Categories;
  score     : Decimal(5, 4) default 1.0; // cosine score; manual = 1.0
}

entity GroupCategories : cuid {
  group     : Association to Groups;
  category  : Association to Categories;
  score     : Decimal(5, 4) default 1.0;
}

entity TutorialCategories : cuid {
  tutorial  : Association to Tutorials;
  category  : Association to Categories;
  score     : Decimal(5, 4) default 1.0;
}
```

And inverse `Composition of many` on `Missions`, `Groups`, `Tutorials`:

```cds
entity Missions : TaskBase {
  // ...existing fields
  categories : Composition of many MissionCategories on categories.mission = $self;
}
```

#### Why `Decimal(5,4)` not `Float`

HANA `DECIMAL(p,s)` is exact and ordered deterministically — no floating-point drift on the `MAX(score)` query that picks the primary chip. 4 decimal places is plenty for cosine similarity (we round before insert).

#### Why `seedDescription` is editable

Each category row carries a 1–3 sentence prose description fed into the seed-embedding step ("Building business apps with CAP, ABAP RAP, BTP runtimes, and low-code tooling like SAP Build Apps."). Edit → re-embed that one row → next classify run uses the new vector. Tunes classifier behavior without code changes.

#### Seed-embedding cache

Seed embeddings are loaded into an in-memory `Map<categoryId, Float32Array>` at srv boot (see [srv/lib/category-seed-embeddings.js](../../../srv/lib/category-seed-embeddings.js)). On `seedDescription` edit (admin save), the cache invalidates that one entry; next classify lazily recomputes. Boot cost: ~200ms for 8 categories at the embedding endpoint's typical latency. We do **not** persist a `seedEmbedding` LOB column — small cache, recomputable, and avoids LOB churn on description edits.

#### What we're NOT adding

- No `assignedBy` / provenance column (per locked decision #9).
- No `Tags.kind` discriminator (categories are first-class entities, not tags).
- No `category` field on `TaskBase`.
- No `isPrimary` boolean (computed from `MAX(score)` at query time).

### 3. Classifier

A new module at [srv/lib/category-classifier.js](../../../srv/lib/category-classifier.js) exposing one public function:

```js
classifyAndPersist(itemKind, itemId, { force = false } = {})
// itemKind: 'mission' | 'group' | 'tutorial'
// returns: { kept: 0|1, assigned: [{slug, score}], path: 'embedding'|'llm'|'skip' }
```

#### Decision tree

```
classifyAndPersist(kind, id):
  1. Load item (title + description + tag slugs joined as text)
  2. Try EMBEDDING path:
       a. If kind=tutorial AND TutorialEmbedding exists → use it
       b. Else generate item embedding via embedAdHoc(itemText) (new helper;
          calls the same Azure embedding model as embedding-pipeline.js but
          does NOT persist the vector — missions/groups don't get a
          permanent embedding row)
       c. score = cosine(itemEmbedding, seedEmbedding) for each category
       d. Pick categories with score ≥ HIGH_THRESHOLD (0.32), up to top-3
  3. If embedding path returned ≥1 category AND top-1 vs top-2 gap ≥
     AMBIGUITY_GAP (0.05):
       → use embedding result
  4. Else (no result above threshold, or ambiguous top picks):
       → fallback to LLM:
           prompt: system=taxonomy + user=itemText
           expect: JSON {categories: [{slug, confidence}]} via OpenAI
                   structured outputs (response_format strict)
           model: gpt-4o-mini via existing AI Core client
                  (cf-bound destination 'aicore')
           timeout: 8s; on failure → log, skip (no categories assigned)
  5. Persist:
       BEGIN TX
         DELETE FROM <junction> WHERE <fk> = id
         INSERT one row per assigned (categoryId, score), score rounded to
         4 decimals, score = 1.0 for manual writes
       COMMIT
```

#### Tunable constants (live at the top of the module)

| Constant | Value | Why |
|---|---|---|
| `HIGH_THRESHOLD` | 0.32 | Cosine on Azure `text-embedding-3-small` (1536 dim) for genuinely-related content typically lands 0.30–0.55. Below 0.32 is generally noise. |
| `MAX_CATEGORIES_PER_ITEM` | 3 | Enough for "CAP + AI + Cloud" without diluting the primary-chip picker. |
| `AMBIGUITY_GAP` | 0.05 | Top-2 within 0.05 cosine triggers the LLM tiebreak. |
| `LLM_TIMEOUT_MS` | 8000 | Same as `srv/lib/chat-orchestrator.js` for parity. |
| `BACKFILL_CONCURRENCY` | 4 | Conservative; AI Core deployment quotas vary per BTP subaccount. |

`HIGH_THRESHOLD` is the variable expected to actually be tuned after seeing real data. Surfacing it as a constant + the editable `seedDescription` gives operators the two real knobs: "what does this category mean" and "how confident is enough."

#### LLM prompt shape

```
SYSTEM:
You classify SAP developer content into one or more categories from this
fixed list:
- app-dev-automation: Application Development & Automation
- data-analytics: Data & Analytics
- extended-planning: Extended Planning & Analysis
- integration: Integration
- artificial-intelligence: Artificial Intelligence
- frontend-ux: Frontend & UX
- cloud-operations: Cloud & Operations
- abap-core: ABAP & Core

Return JSON: {"categories":[{"slug":"...","confidence":0.0-1.0}]}.
Pick 1-3 best fits. Confidence reflects how strongly the content fits
the category.

USER:
Title: {item.title}
Description: {item.description ?? ''}
Tags: {item.displayTagSlugs?.join(', ')}
```

The schema is enforced via OpenAI structured outputs (`response_format: { type: 'json_schema', strict: true }`). On schema violation or timeout we log the item ID and skip — that item stays uncategorized for the moment.

#### After-hooks (entity create / update)

Wired in [srv/handlers/categories-after-hooks.js](../../../srv/handlers/categories-after-hooks.js):

| Trigger | Mode | Notes |
|---|---|---|
| `INSERT` on `Missions` / `Groups` / `Tutorials` | async, fire-and-forget | New item gets categorized within ~5s |
| `UPDATE` of `title`, `description`, or `primaryTag` on those entities | async, debounced 5s per item | Multi-PATCH draft activation collapses to one classify; same per-item-`setTimeout` pattern as [srv/lib/rebuild-trigger.js](../../../srv/lib/rebuild-trigger.js) from #220 |
| Other UPDATEs (e.g., `featuredOrder`) | none | Not relevant signal |

Detection of meaningful UPDATE diffs uses CAP `req.diff()`.

#### Reclassify endpoint

Exposed both as a CDS bound action (so Fiori can call via the framework) and as a raw HTTP route (so the backfill script can call from CLI):

```cds
extend service AdminService with {
  action classifyCategories(
    kind   : String enum { all; mission; group; tutorial },
    ids    : array of String,
    force  : Boolean
  ) returns {
    processed : Integer;
    succeeded : Integer;
    failed    : Integer;
    skipped   : Integer;
  };
}
```

Bearer-auth (admin scope). Backed by the existing `srv/jobs/job-lock.js` distributed lock — two admins can't run a bulk reclassify concurrently. The action returns one summary payload; long-running, but no streaming progress in v1.

### 4. Frontend

#### Filter rail (Hugo SSR + Vue island)

[hugo/layouts/partials/browse/_partials/filter-rail.html](../../../hugo/layouts/partials/browse/_partials/filter-rail.html) gets a new `<details>` accordion above existing groups (the per-rail collapse landed in #285):

```html
<details class="filter-group" open data-group="categories">
  <summary>Categories</summary>
  {{ range .Site.Data.browse.categories }}
    <label class="cat-row">
      <input type="checkbox" name="category" value="{{ .slug }}">
      <span class="label">{{ .label }}</span>
      <span class="count">({{ .activeCount }})</span>
    </label>
  {{ end }}
</details>
```

`Site.Data.browse.categories` is a new array in [hugo/data/browse.json](../../../hugo/data/browse.json), written by `fetch-tutorials --target hugo` after pulling from `/build/catalog`:

```json
{
  "categories": [
    {
      "slug": "app-dev-automation",
      "label": "Application Development & Automation",
      "sortOrder": 10,
      "activeCount": 412
    }
  ]
}
```

`activeCount` is the count of cards matching the category at SSR time — same shape as today's product/topic counts.

#### Vue side — `useNavigatorFilters.ts` extension

A new field on filter state:

```ts
interface FilterState {
  // ...existing fields
  selectedCategories: Ref<Set<string>>  // category slugs
}
```

Added to `applyFilters()`:

```ts
if (filters.selectedCategories.value.size > 0) {
  result = result.filter(item =>
    item.categorySlugs.some(slug => filters.selectedCategories.value.has(slug))
  )
}
```

`item.categorySlugs: string[]` is a new field on `CardItem`, populated from `/build/catalog` (sorted descending by score, so `categorySlugs[0]` is the primary).

#### URL plumbing — `urlSync.ts`

Per locked decision #10, the `category` filter lives in the shared `urlSync.ts` (not `browse/browseUrl.ts`). Today's `urlSync.ts` exposes 8 fields via the `PARAM` map and `NavState` interface — `q, types, levels, products, topics, isNew, noLicense, page` — using **plural NavState keys** mapped to **singular URL param names** (e.g. `topics → ?topic=`). `categories` is added as a 9th field following the same pattern:

```ts
// hugo-apps/src/navigator/urlSync.ts
export const PARAM = {
  q: 'q',
  types: 'type',
  levels: 'level',
  products: 'product',
  topics: 'topic',
  isNew: 'new',
  noLicense: 'noLicense',
  page: 'page',
  categories: 'category',   // NEW — plural state, singular URL param
} as const

export interface NavState {
  // ...existing fields
  categories: string[]
}

export const EMPTY_STATE: NavState = Object.freeze({
  // ...existing fields
  categories: [],
}) as NavState
```

Reader/writer reuses the existing `asArray()` helper used by `products` and `topics`. URL: `?category=artificial-intelligence,app-dev-automation`. Slugs are kebab-case and stable, so they survive URL encoding cleanly.

> **Note:** `?sort=` is **not** in `urlSync.ts` — it lives in `hugo-apps/src/browse/browseUrl.ts` because it's a `/browse/`-only concern (the legacy `/` navigator doesn't sort). `?category=` goes into `urlSync.ts` because we want both surfaces to share the URL contract for the shared filter facets.

#### Card chip

`MissionCard.vue` / `GroupCard.vue` / `TutorialCard.vue` (the shared cards extracted in PR #206) gain a single chip:

```vue
<ui5-tag
  v-if="item.categorySlugs.length > 0"
  design="Set2"
  class="card-category-chip"
>
  {{ categoryLabel(item.categorySlugs[0]) }}
</ui5-tag>
```

Chip sits in the existing tag-strip row alongside `level`, the `NEW` badge, and (for tutorials) the time-to-complete pill. `Set2` is a Horizon ui5-tag color preset distinct from the level/time chips. We don't show secondaries.

`categoryLabel(slug)` reads from the inlined `<script id="browse-data">` JSON payload — same pattern as the topic-label resolver today.

#### SSR-side filter pre-application

[hugo/layouts/browse/list.html](../../../hugo/layouts/browse/list.html) (the SSR template) and [hugo/layouts/partials/browse/_partials/filter-rail.html](../../../hugo/layouts/partials/browse/_partials/filter-rail.html) (its filter-rail partial) honor `?category=` for first paint by feeding the URL params into the Hugo template's filter loop — same pattern as `?product=` and `?topic=` today. The Vue island then re-evaluates on hydration; subsequent changes flow through `urlSync.ts`. No new SSR pattern, just one more field.

### 5. Admin UI

#### Dedicated Categories Fiori app

New entry under [app/admin/](../../../app/admin/) — `categories/` — wired into the admin shell's `componentUsages` and side-nav. Mirrors the existing `tags/` app shape.

**Master list view** at `/admin-ui/#categories-display`:

- Grid of all categories: `slug`, `label`, `sortOrder`, `seedDescription`, live counts (`Mission count`, `Group count`, `Tutorial count`).
- Inline editing on `label`, `sortOrder`, `seedDescription`.
- **No create/delete in v1** (taxonomy is fixed).
- Saving `seedDescription` invalidates that row's seed-embedding cache and triggers re-embed on next classify call.

**Bulk Operations bar** at the top of the master list:

- "Classify uncategorized" — POSTs `classifyCategories({ kind: 'all', force: false })`. Toast on completion with counts.
- "Re-classify everything (force)" — same with `force: true`. **Confirm dialog with explicit "this overwrites all manual assignments" warning** (per decision #9 — admins must know this is destructive).
- "Embed seeds" — recompute seed embeddings for all categories. Rare op.

**Per-category detail page** (`/admin-ui/#categories-display&/Categories(...)`):

- Object Page with category metadata + tabbed list of all assigned items (Missions / Groups / Tutorials), sorted by score descending.
- Lets admins spot-check classifier output and remove obvious mis-assignments without bouncing to each item's page.

#### Inline editing on Mission / Group / Tutorial admin pages

Each existing admin OP gains a `Categories` section (sibling to the existing `Tags` section), rendered as a `MultiInput` ui5-tag chooser:

```
Categories: [Artificial Intelligence ✕] [Application Dev & Automation ✕] [+ Add]
```

- **Add** opens value-help dialog populated from `Categories` master list.
- **Remove** (✕) deletes the junction row.
- **"Classify this item"** button next to the section runs the classifier on just this one item and replaces the assignments. Same destructive overwrite as bulk; same confirm dialog.

Inline edits write `score = 1.0` to the junction. When the item is later re-classified, classifier scores overwrite — admin's manual assignment is **not** locked (per decision #9, accepted risk).

#### Annotations + service exposure

[app/admin-annotations.cds](../../../app/admin-annotations.cds) gets:

- `@UI` (HeaderInfo, LineItem, FieldGroup) on `Categories` for the master list and OP.
- `@UI.Facets` extended on `Missions` / `Groups` / `Tutorials` with a "Categories" facet.
- ValueHelp on `MissionCategories.category`, `GroupCategories.category`, `TutorialCategories.category` pointing to `Categories`.

[srv/admin-service.cds](../../../srv/admin-service.cds) gets:

```cds
extend service AdminService with {
  entity Categories          as projection on db.Categories;
  entity MissionCategories   as projection on db.MissionCategories;
  entity GroupCategories     as projection on db.GroupCategories;
  entity TutorialCategories  as projection on db.TutorialCategories;
  action classifyCategories(...) returns {...};
}
```

#### Audit + change-tracking

`Categories` and the 3 junction tables get `@cds.changetracking.exclude`:

- `Categories` is master data; low traffic; audit value low.
- Junctions churn during reclassify; audit-log noise would be massive without much value.

If we ever need provenance, we revisit by adding `assignedBy` + tracking on the junctions.

### 6. Build, deploy, testing

#### Catalog payload changes

[srv/lib/build-catalog.js](../../../srv/lib/build-catalog.js) (the existing `buildCatalogHandler`, wired in [srv/server.js](../../../srv/server.js)) extends each card payload with:

```js
{
  // ...existing fields
  categorySlugs: ['artificial-intelligence', 'app-dev-automation']
  // sorted: score DESC, then category sortOrder ASC
}
```

The query joins the relevant junction → `Categories`, sorts by `score DESC, sortOrder ASC` (taxonomy order tie-breaks identical scores), and emits up to 3 slugs per card. Plus a top-level array:

```js
categories: [
  { slug, label, sortOrder, activeCount }, ...
]
```

[scripts/parsers/cap.ts](../../../scripts/parsers/cap.ts) consumes those new fields and threads them into `hugo/data/browse.json` (drives the rail) and into each generated mission/group/tutorial frontmatter (drives card chips on `/`'s legacy navigator if/when that adopts categories).

#### Backfill script

[scripts/backfill-categories.cjs](../../../scripts/backfill-categories.cjs):

```bash
# Run once on first deploy after this PR lands.
cds bind --exec -- node scripts/backfill-categories.cjs --kind=all
# Resumable — `--from-id <UUID>` skips ahead. Logs every 50 items.
# Concurrency: 4 (matches BACKFILL_CONCURRENCY)
```

Also wired as `npm run backfill-categories`. Idempotent — re-running overwrites all assignments with fresh classifier output. On per-item failure logs the item-id and continues; prints `{ ok, failed, skipped }` totals at end.

#### Deploy choreography

Per locked decision #12:

```bash
# 1. Schema deploy lands the new tables empty (Categories seeded from CSV).
cf push tutorials-db-deployer ...

# 2. Srv deploy lands the classifier service.
cf push tutorials-srv ...

# 3. Manual backfill (~5–10 min for 1,500 items at concurrency 4).
cds bind --exec -- node scripts/backfill-categories.cjs --kind=all

# 4. Trigger rebuild-content.yml to refresh the /browse/ rail's activeCounts.
gh workflow run rebuild-content.yml
```

Step 4 happens automatically via the `rebuild-trigger.js` after-hook (#220) once the backfill writes hit the DB — but doing it manually after backfill avoids ~1,500 individual debounced rebuild triggers.

The post-backfill rebuild **does** include the upload of `RepoCatalog` (no `--no-catalog`-style skip), because the categories live in the DB and the rebuild is what regenerates `browse.json` from the latest `/build/catalog` payload.

#### Tests

| Layer | Files | Coverage |
|---|---|---|
| **Unit** (in-memory SQLite) | `srv/lib/category-classifier.test.js` | Decision tree per branch (high-confidence embedding, ambiguous→LLM, no-match→skip), threshold edges, transactional delete-then-insert |
| **Unit** | `srv/__tests__/admin-service-categories.test.js` | `classifyCategories` action, junction CRUD via OData, value-help reads |
| **Unit** | `hugo-apps/src/shared/composables/useNavigatorFilters.test.ts` | New `selectedCategories` filter branch, multi-select OR-combine |
| **Unit** | `hugo-apps/src/navigator/__tests__/urlSync.test.ts` | New `?category=` field, comma-separated multi-value, encode/decode round-trip |
| **Unit** | `hugo-apps/src/shared/cards/cards.test.ts` | `categorySlugs[0]` chip rendering, fallback when empty |
| **Hybrid** (real HANA, `npm run test:hybrid`) | `test/hybrid/categories-classifier.test.js` | End-to-end against real embedding + chat models. **Gated by `HYBRID_AI_TESTS=true`** to avoid AI Core costs in default runs |
| **Smoke** (HTTP, `npm run test:smoke`) | `test/smoke/browse-categories.test.js` | `/browse/?category=ai` returns filtered grid; `/build/catalog` includes `categorySlugs` and top-level `categories` |

#### No feature flag

Per decision #12. Rationale:

- Schema migration is forward-only and small.
- Filter rail group renders with `activeCount` 0 if no assignments exist → harmless zero-state UI, not a half-broken state.
- The backfill is a deliberate post-deploy step; before it runs, the rail group shows zero counts, which is honest UX.
- Rollback path: drop the rail group `<details>` from `filter-rail.html` (one HTML edit). Schema and admin app stay; harmless without UI exposure.

## Data flow

### Read (catalog → rail + cards)

```
HANA: Missions/Groups/Tutorials + their *Categories junctions + Categories
   ↓ (CAP read handler in build-catalog.js)
   ↓ join + sort by score DESC, sortOrder ASC; top-3 per card
GET /build/catalog
   {
     items: [{ ...card, categorySlugs: ['ai', 'app-dev'] }, ...],
     categories: [{ slug, label, sortOrder, activeCount }, ...]
   }
   ↓ (scripts/parsers/cap.ts during fetch-tutorials)
hugo/data/browse.json + per-tutorial frontmatter
   ↓ (Hugo SSR + Vue island JSON inline)
/browse/ DOM:
   - filter rail (categories <details> with checkboxes + counts)
   - card chips (categorySlugs[0])
```

### Filter (URL → rendered grid)

```
URL: /browse/?category=artificial-intelligence,app-dev-automation
   ↓ urlSync.ts read
useNavigatorFilters.selectedCategories: Set { 'artificial-intelligence', 'app-dev-automation' }
   ↓ applyFilters()
   ↓ result = items.filter(i =>
       i.categorySlugs.some(s => selectedCategories.has(s)))  // OR-combine
displayedItems → BrowseGrid renders
```

### Classify (admin action / after-hook → DB writes)

```
Trigger: admin "Classify this item" button OR after-hook OR backfill script
   ↓
classifyAndPersist(kind, id):
   load item text → embedAdHoc OR existing TutorialEmbedding
   cosine vs. seed embeddings
   if ≥1 match above HIGH_THRESHOLD AND not ambiguous → use embedding
   else → LLM fallback (gpt-4o-mini, structured output)
   ↓
TX:
  DELETE FROM <junction> WHERE <fk> = id
  INSERT one row per assigned (categoryId, score)
COMMIT
   ↓ rebuild-trigger.js (debounced 60s, #220)
GitHub Actions: rebuild-content.yml
   ↓ refreshes browse.json activeCounts
```

## Error handling

| Failure | Behavior |
|---|---|
| Embedding endpoint timeout / 5xx | Fall through to LLM path |
| LLM endpoint timeout / 5xx | Log item-id, skip — item stays uncategorized; no junction writes |
| LLM response fails JSON-schema validation | Same as above (skip) |
| LLM returns slugs not in master taxonomy | Filter to known slugs; if none remain → skip |
| Backfill script: per-item exception | Log item-id, increment `failed` counter, continue |
| Backfill script: AI Core 429 (quota) | Exponential backoff (1s, 2s, 4s, 8s, 16s) then continue; if 5 consecutive 429s on different items → abort with non-zero exit |
| `seedDescription` edit but embedding endpoint down | Cache invalidation succeeds (it's local); next classify will retry the embed; classifier falls back to LLM in the meantime |
| Filter rail group renders before backfill | All `activeCount` = 0; checking a category yields empty grid — honest zero-state |
| Two admins run bulk reclassify simultaneously | Second one fails the `job-lock` check; toast "Another classify run is in progress" |

## Test strategy

| What | Where | How |
|---|---|---|
| Schema deploys cleanly to HANA | `test/hybrid/schema-deploy.test.js` (existing) | Re-run after `db/schema.cds` edits |
| Classifier decision tree | `srv/lib/category-classifier.test.js` | Mock embedding + LLM clients; assert per-branch behavior + the delete-then-insert transaction shape |
| `classifyCategories` action over OData | `srv/__tests__/admin-service-categories.test.js` | In-memory SQLite + cds.test |
| Filter composable | `hugo-apps/src/shared/composables/useNavigatorFilters.test.ts` | Vitest unit; OR-combine; empty-set short-circuit |
| URL round-trip | `hugo-apps/src/navigator/__tests__/urlSync.test.ts` | `?category=a,b` → Set → `?category=a,b` |
| Card chip render | `hugo-apps/src/shared/cards/cards.test.ts` | Empty `categorySlugs` → no chip; populated → first slug rendered |
| Real HANA + AI end-to-end | `test/hybrid/categories-classifier.test.js` | `HYBRID_AI_TESTS=true npm run test:hybrid`; classifies 3 known items, asserts each lands in the expected category |
| Deployed surface | `test/smoke/browse-categories.test.js` | Asserts `/build/catalog` payload shape and `/browse/?category=...` SSR behavior against deployed URLs |

The hybrid AI tests gate behind `HYBRID_AI_TESTS=true` because they consume real AI Core quota — same pattern as the chat-orchestrator hybrid tests today. Default `npm run test:hybrid` runs stay $0/run.

## Open questions for the planning phase

These are deliberate punt-points to revisit during plan-writing:

1. **Should the classifier service start on `cds.on('served')` and pre-warm seed embeddings, or load lazily on first classify call?** Pre-warm gives consistent latency but slows boot; lazy is simpler. Defer to plan.
2. **Should `categories.activeCount` be live (computed on every `/build/catalog` read) or pre-aggregated?** Live is fine for ~10 categories × ~1,500 items; revisit if measurements show otherwise.
3. **Do we backfill via the action endpoint (HTTP from CLI script) or via direct DB-side classifier calls?** Latter is faster (no JWT round-trip), former is consistent with admin UX. Defer to plan.

## Followups (post-merge)

- **Master-list CRUD** for the taxonomy (add/remove/rename categories with reclassify cascade).
- **Per-language category labels** (i18n; gated on broader project-wide localization).
- **Nested taxonomy** (e.g., `artificial-intelligence > joule`).
- **Show secondary categories on cards** (chips for top-2 instead of top-1).
- **Live progress streaming** during long backfills via existing `EventStreamService` WebSocket.
- **Track provenance + lock admin overrides** against future re-classification (the mode we explicitly skipped).
- **Auto-classify on `/`'s legacy navigator** (currently scoped to `/browse/`).
- **Confidence-based UI hint** ("AI suggested this; confidence 0.78") on the per-OP Categories section.
