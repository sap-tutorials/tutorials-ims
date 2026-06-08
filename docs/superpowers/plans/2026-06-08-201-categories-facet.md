# Categories Facet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Categories facet to `/browse/`'s left filter rail (multi-select, OR-combined), backed by a hybrid embedding-similarity + LLM-fallback classifier with admin override via both per-entity inline editing and a dedicated Categories Fiori app.

**Architecture:** New `Categories` master entity + 3 junction tables (`MissionCategories`, `GroupCategories`, `TutorialCategories`) mirroring the `Tags` shape. Classifier in `srv/lib/category-classifier.js` runs embedding-similarity first against pre-cached category-seed embeddings; falls back to forced-tool-call LLM (Claude 4.6 Sonnet by default via `ChatSettings.modelName`, same orchestration pattern as [srv/lib/code-check-llm.js](../../../srv/lib/code-check-llm.js)) for no-match or ambiguous cases. Persistence is delete-then-insert per item (no provenance tracking). Triggered on-demand via admin action + entity-create/update after-hooks (debounced 5s). Catalog payload extends `categorySlugs[]` per card; `urlSync.ts` gains a 9th field `categories`.

**Tech Stack:** SAP CAP (Node.js) + HANA Cloud (prod) / SQLite (unit) + `@sap-ai-sdk/foundation-models` (embeddings, already in use) + `@sap-ai-sdk/orchestration` (LLM forced tool call, already in use) + Vitest + Vue 3 + Hugo + Fiori Elements V4.

**Spec:** [`docs/superpowers/specs/2026-06-07-categories-facet-design.md`](../specs/2026-06-07-categories-facet-design.md)

**Tracking issue:** [sap-tutorials/tutorials-ims#201](https://github.com/sap-tutorials/poc-tutorials-poc/issues/201)

**Depends on:** PR #206 (shared cards), PR #217 (`/browse/` SSR + island), PR #220 (`rebuild-trigger.js`), PR #197 (`urlSync.ts` 8-field schema).

---

## Working assumptions

- Branch: `feat/201-categories-facet` (already cut from `main`; spec already committed at `7a4b9bb` or similar — verify with `git log --oneline -1`).
- **Branch hygiene:** the harness can silently flip the branch between Bash invocations (per [feedback_verify_branch_before_commit](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_verify_branch_before_commit.md)). EVERY commit step in this plan starts with `git branch --show-current` in the SAME Bash invocation as `git commit` and ABORTS if it shows anything other than `feat/201-categories-facet`.
- **Worktrees:** if working in parallel agents, each agent MUST use its own worktree per [feedback_parallel_agents_worktrees](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_parallel_agents_worktrees.md). For solo execution, the existing branch checkout is fine.
- **TDD discipline:** every new module is Red→Green→Commit. Tests live in `__tests__/` co-located with the module under test.
- **`cf login`** is required only for hybrid tests in Phase 9 (gated by `HYBRID_AI_TESTS=true`). Phases 1–8 run against in-memory SQLite.
- **`npm test` reliably hangs** in fresh worktrees per [feedback_worktree_tests_hang](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_worktree_tests_hang.md). Run targeted Vitest files only with `npx vitest run <file>` and a 60s timeout.
- **Hugo + esbuild on Windows:** fresh worktrees need `npm run setup` after `npm install` to populate `hugo-apps/node_modules` and rebuild `better-sqlite3` (per [npm_ignore_scripts_native_modules](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_npm_ignore_scripts_native_modules.md)).
- **PR over direct merge:** finish with `gh pr create`, NOT a fast-merge to main (per [feedback_pr_over_direct_merge](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_pr_over_direct_merge.md)).

## Useful skills

- `superpowers:test-driven-development` — TDD discipline on each new module.
- `superpowers:verification-before-completion` — before claiming a phase done.
- `superpowers:using-git-worktrees` — if running parallel agents.
- `superpowers:dispatching-parallel-agents` — for the 6+ admin-UI tasks that are independent.

---

## File map

### New files

**Database / seed:**
- `db/data/com.sap.developers.ims-Categories.csv` — 8-row taxonomy seed (auto-loaded by CAP).

**Service layer:**
- `srv/lib/category-classifier.js` — `classifyAndPersist(kind, id, opts)` decision tree.
- `srv/lib/__tests__/category-classifier.test.js` — unit tests (mock embed + LLM).
- `srv/lib/category-seed-embeddings.js` — in-memory `Map<categoryId, Float32Array>` cache; `getSeedEmbeddings()`, `invalidateSeedEmbedding(id)`, `embedAdHoc(text)` helper.
- `srv/lib/__tests__/category-seed-embeddings.test.js` — cache lifecycle tests.
- `srv/lib/category-classifier-llm.js` — forced-tool-call wrapper around `OrchestrationClient` (mirrors `srv/lib/code-check-llm.js`); returns `{ assigned: [{slug, confidence}], modelName, promptTokens, completionTokens }`.
- `srv/lib/__tests__/category-classifier-llm.test.js` — wrapper unit tests.
- `srv/handlers/categories-after-hooks.js` — register CAP after-hooks on Missions/Groups/Tutorials INSERT/UPDATE; per-item 5s debounce.
- `srv/handlers/__tests__/categories-after-hooks.test.js` — debounce + diff-detection tests.
- `srv/__tests__/admin-service-categories.test.js` — `classifyCategories` action + junction OData CRUD via cds.test.

**Backfill / scripts:**
- `scripts/backfill-categories.cjs` — CLI that walks all items and calls classifier; concurrency 4, resumable via `--from-id`.
- `scripts/__tests__/backfill-categories.test.js` — argument parsing + resumability logic (no real classify).

**Frontend (Vue / TypeScript):**
- `hugo-apps/src/shared/composables/__tests__/useNavigatorFilters-categories.test.ts` — new branch tests for `selectedCategories` filter.
- `hugo-apps/src/navigator/__tests__/urlSync-category.test.ts` — `?category=` round-trip tests.

**Frontend (Hugo SSR — partial):**
- `hugo/layouts/partials/browse/_partials/category-rail-group.html` — opt-in template fragment if filter-rail.html grows; otherwise inline.

**Admin UI:**
- `app/admin/categories/` — full Fiori Elements app folder, mirroring `app/admin/tags/`:
  - `package.json`, `ui5.yaml`, `webapp/manifest.json`, `webapp/Component.js`, `webapp/i18n/i18n.properties`.
- `app/admin/categories/webapp/ext/CategoryActionsController.controller.js` — bulk-ops bar bound actions.
- `app/admin/categories/webapp/ext/ClassifyConfirmDialog.fragment.xml` — destructive confirm dialog.

**Tests (cross-cutting):**
- `test/hybrid/categories-classifier.test.js` — real HANA + AI Core, gated by `HYBRID_AI_TESTS=true`.
- `test/smoke/browse-categories.test.js` — HTTP `/build/catalog` payload + `/browse/?category=ai` SSR check.

**Docs:**
- `docs/developers/architecture/categories-classifier.md` — flow diagram, decision-tree table, seedDescription tuning runbook, deploy choreography (~80 lines).

### Modified files

**Database / model:**
- `db/schema.cds` — add `Categories` entity + 3 junction entities + 3 `Composition of many` inverses on `Missions`/`Groups`/`Tutorials`.

**Service layer:**
- `srv/admin-service.cds` — expose `Categories`, 3 junctions, `classifyCategories` action.
- `srv/admin-service.js` — bind `classifyCategories` action to classifier.
- `srv/server.js` — register `categories-after-hooks` on `cds.on('served')`.
- `srv/lib/build-catalog.js` — extend each card with `categorySlugs[]` (top-3, sorted by score DESC then sortOrder ASC); add top-level `categories[]` array with `activeCount`.
- `srv/__tests__/build-catalog.test.js` — extend existing tests with category fields (if file doesn't exist, create alongside the modification).

**Frontend (TypeScript):**
- `hugo-apps/src/shared/types.ts` — add `categorySlugs: string[]` to `CardItem`.
- `hugo-apps/src/shared/composables/useNavigatorFilters.ts` — add `selectedCategories: Ref<Set<string>>` to filter state + apply branch.
- `hugo-apps/src/navigator/urlSync.ts` — add `categories` 9th field to `PARAM`/`NavState`/`EMPTY_STATE`/parser.
- `hugo-apps/src/shared/cards/MissionCard.vue` — render `categorySlugs[0]` chip.
- `hugo-apps/src/shared/cards/GroupCard.vue` — render `categorySlugs[0]` chip.
- `hugo-apps/src/shared/cards/TutorialCard.vue` — render `categorySlugs[0]` chip.
- `hugo-apps/src/shared/cards/cards.test.ts` — extend existing tests with category-chip cases.
- `hugo-apps/src/browse/controller.ts` — wire SSR'd `<input name="category">` checkboxes to `selectedCategories`.

**Frontend (Hugo / parsers):**
- `hugo/layouts/partials/browse/_partials/filter-rail.html` — add Categories `<details>` group above existing facets.
- `hugo/layouts/browse/list.html` — honor `?category=` for SSR first paint.
- `scripts/parsers/cap.ts` — thread `categorySlugs` from `/build/catalog` into card payloads + add `categories[]` to `browse.json` shape.

**Admin UI:**
- `app/admin-shell/src/router/Routes.ts` (or wherever side-nav is wired) — add Categories entry.
- `app/admin-shell/package.json` — `componentUsages` for the new app.
- `app/admin-annotations.cds` — `@UI` annotations on `Categories` and a `Categories` facet on each of `Missions`/`Groups`/`Tutorials`. Plus `@cds.changetracking.exclude` on the new entities.

**Build / deploy:**
- `.deploy/mta.yaml` — confirm `srv-qa` `cp` list still covers transitive imports from `srv/lib/build-catalog.js` (per [feedback_check_srv_qa_when_changing_srv](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_check_srv_qa_when_changing_srv.md)). Add `category-classifier.js`, `category-classifier-llm.js`, `category-seed-embeddings.js` to the cp list. Also add the new admin app to the `app-deployer` resource if needed.
- `package.json` — new `backfill-categories` npm script.
- `CLAUDE.md` — Gotchas entry: Categories taxonomy is fixed in v1, reclassify is destructive, `HYBRID_AI_TESTS=true` to opt into real-AI hybrid tests.

---

## Phase overview

| # | Phase | TDD-able | End state |
|---|---|---|---|
| 1 | Schema + seed | Partly | `Categories` + 3 junctions deploy; CSV seeds 8 rows; `cds watch` boots clean |
| 2 | Seed-embedding cache | Yes | Cache module + lifecycle tests pass; ad-hoc embed helper works |
| 3 | Classifier core (decision tree) | Yes | `classifyAndPersist()` works against in-memory SQLite with mocked embed + LLM |
| 4 | After-hooks + admin action | Yes | INSERT/UPDATE on Mission/Group/Tutorial triggers async classify; admin `classifyCategories` action returns counts |
| 5 | Backfill script | Partly | `node scripts/backfill-categories.cjs --kind=all` walks the catalog and persists assignments |
| 6 | Catalog + Hugo data | Yes | `/build/catalog` returns `categorySlugs[]` per card + top-level `categories[]`; `browse.json` carries categories |
| 7 | Frontend (filter + chip + URL) | Yes | `/browse/?category=ai` filters; chip renders on cards; URL round-trips |
| 8 | Admin UI (Fiori app) | Manual | Categories app at `/admin-ui/#categories-display`; per-OP Categories facet on Missions/Groups/Tutorials |
| 9 | Hybrid + smoke + deploy choreography | Manual | Hybrid tests pass against real HANA+AI; smoke tests pass on deployed `/browse/` |

Each phase ends with at minimum one green commit. Phases 2–4, 6, and 7 can in principle run in parallel via worktrees once Phase 1's schema is committed.

---

## Phase 1 — Schema + seed

End state: `Categories` + 3 junction entities deploy cleanly to in-memory SQLite (and HANA via the hybrid run); CSV seeds 8 rows; `cds watch` boots clean and exposes the entities at `/admin/Categories`.

### Task 1.1: Add `Categories` entity to `db/schema.cds`

**Files:**
- Modify: `db/schema.cds` (append at end of file, before any final closing brace if present)

- [ ] **Step 1: Verify branch**

```bash
cd D:/projects/tutorials-poc && git branch --show-current
```

Expected output: `feat/201-categories-facet`. Abort if anything else.

- [ ] **Step 2: Find insertion point**

Run: `grep -n "^entity Tags " db/schema.cds`

Note the line. The new entity should sit alongside `Tags` so reviewers find it where they expect.

- [ ] **Step 3: Add the `Categories` entity**

Insert after the `Tags` entity block:

```cds
// Master taxonomy for the /browse/ Categories facet (#201). Seeded once
// via db/data/com.sap.developers.ims-Categories.csv; v1 admins edit only
// label/sortOrder/seedDescription. Add/remove categories is a v2 follow-up.
entity Categories : cuid, managed {
  slug             : String(64) @mandatory;
  label            : String(255) @mandatory;
  sortOrder        : Integer default 100;
  seedDescription  : LargeString;  // editable; tunes classifier accuracy
}
```

- [ ] **Step 4: Verify CDS compiles**

Run: `npx cds compile db/schema.cds 2>&1 | tail -5`

Expected: no errors. If `Categories` already exists somewhere else, rename or remove the old definition.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add db/schema.cds && \
  git commit -m "feat(201): add Categories master entity

cuid + managed shape mirroring Tags. Editable fields: label, sortOrder,
seedDescription. v1 admins cannot add/remove categories (follow-up)."
```

### Task 1.2: Add 3 junction entities

**Files:**
- Modify: `db/schema.cds`

- [ ] **Step 1: Add `MissionCategories`, `GroupCategories`, `TutorialCategories`**

Append after the `Categories` entity:

```cds
entity MissionCategories : cuid {
  mission   : Association to Missions;
  category  : Association to Categories;
  score     : Decimal(5, 4) default 1.0;  // cosine score; manual writes = 1.0
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

- [ ] **Step 2: Add inverse `Composition of many` to Missions/Groups/Tutorials**

Find each of the three entity definitions (e.g. `entity Missions : TaskBase {`), and add this line at the end of the field block, before the closing `}`:

For `Missions`:
```cds
  categories : Composition of many MissionCategories on categories.mission = $self;
```

For `Groups`:
```cds
  categories : Composition of many GroupCategories on categories.group = $self;
```

For `Tutorials`:
```cds
  categories : Composition of many TutorialCategories on categories.tutorial = $self;
```

- [ ] **Step 3: Verify CDS compiles**

Run: `npx cds compile db/schema.cds 2>&1 | tail -10`

Expected: no errors. Common pitfall: forgetting the `on categories.<assoc> = $self;` filter — CDS will throw "must specify managed association" if missing.

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add db/schema.cds && \
  git commit -m "feat(201): add 3 junction entities + Composition inverses

MissionCategories/GroupCategories/TutorialCategories with score:Decimal(5,4)
defaulting to 1.0 (cosine score; manual edits write 1.0)."
```

### Task 1.3: Seed CSV with the 8 categories

**Files:**
- Create: `db/data/com.sap.developers.ims-Categories.csv`

- [ ] **Step 1: Inspect the existing CSV-seed convention**

Run: `head -3 db/data/com.sap.developers.ims-ChatSettings.csv`

Two important conventions to copy verbatim:

- **Field separator is `;` (semicolon)**, not `,`. CAP's csvParser accepts both but every existing seed in this project uses `;`.
- **Audit fields are NOT in the CSV** for `managed` entities. CAP populates `createdAt/createdBy/modifiedAt/modifiedBy` automatically on first deploy. Header row is just `ID;<data columns>`.

CAP CSV seeds expect a header row matching the entity field names exactly, plus the `cuid` key (`ID`) explicitly populated. Auto-load triggers in `cds deploy` AND in `cds watch` against in-memory SQLite.

- [ ] **Step 2: Create the seed file**

Stable UUIDs are required so admin URLs don't break across deploys. Use these (deterministic; generated once and treated as constants):

```csv
ID;slug;label;sortOrder;seedDescription
c0a7e9f1-1101-4001-8001-000000000001;app-dev-automation;Application Development & Automation;10;Building business applications with SAP CAP, ABAP RAP, BTP runtimes (Cloud Foundry, Kyma), and low-code tooling like SAP Build Apps. Core programming model and developer productivity.
c0a7e9f1-1101-4001-8001-000000000002;data-analytics;Data & Analytics;20;SAP HANA Cloud, Datasphere, analytical models, calculation views, embedded analytics, BI integration, and data pipeline patterns.
c0a7e9f1-1101-4001-8001-000000000003;extended-planning;Extended Planning & Analysis;30;SAP Analytics Cloud planning, data actions, predictive forecasting, allocation models, and integrated business planning workflows.
c0a7e9f1-1101-4001-8001-000000000004;integration;Integration;40;SAP Integration Suite, Cloud Integration (CPI), event-driven architecture, APIs, destinations, OData services, and connectivity patterns.
c0a7e9f1-1101-4001-8001-000000000005;artificial-intelligence;Artificial Intelligence;50;SAP AI Core, AI Foundation, embeddings, LLMs, Joule integration, generative AI agents, RAG, and machine learning workflows.
c0a7e9f1-1101-4001-8001-000000000006;frontend-ux;Frontend & UX;60;SAP Fiori, UI5, Fiori Elements, freestyle UIs, mobile development, accessibility, and design-system patterns.
c0a7e9f1-1101-4001-8001-000000000007;cloud-operations;Cloud & Operations;70;BTP cockpit, Cloud Foundry, Kyma, security operations, identity & authorization (XSUAA, IAS), monitoring, and cost management.
c0a7e9f1-1101-4001-8001-000000000008;abap-core;ABAP & Core;80;ABAP Cloud, RAP, CDS views, ATC, transports, ABAP Development Tools (ADT), and S/4HANA extension patterns.
```

If a `seedDescription` value contains a literal `;`, wrap that field in double quotes per RFC 4180 — none of the seeds above need it.

- [ ] **Step 3: Verify seed loads**

Run: `npx cds deploy --to sqlite:test.db 2>&1 | grep -i categor; rm -f test.db`

Expected: no errors mentioning Categories. If you see "ASSERT_NOT_NULL" on slug/label — check the CSV column order matches the entity definition.

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add db/data/com.sap.developers.ims-Categories.csv && \
  git commit -m "feat(201): seed 8 categories (DC 5 + 3 project-specific)

Discovery Center reference set: app-dev-automation, data-analytics,
extended-planning, integration, artificial-intelligence. Project
additions: frontend-ux, cloud-operations, abap-core. Stable UUIDs so
admin URLs survive across deploys."
```

### Task 1.4: Expose entities via AdminService

**Files:**
- Modify: `srv/admin-service.cds`

- [ ] **Step 1: Find the `service AdminService` block**

Run: `grep -n "service AdminService" srv/admin-service.cds`

- [ ] **Step 2: Add projections**

Add inside the service block, near the other entity projections:

```cds
  entity Categories          as projection on db.Categories;
  entity MissionCategories   as projection on db.MissionCategories;
  entity GroupCategories     as projection on db.GroupCategories;
  entity TutorialCategories  as projection on db.TutorialCategories;
```

- [ ] **Step 3: Add the action signature**

Add inside the same service block:

```cds
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
```

- [ ] **Step 4: Verify CDS compiles**

Run: `npx cds compile srv/admin-service.cds 2>&1 | tail -5`

Expected: clean compile.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add srv/admin-service.cds && \
  git commit -m "feat(201): expose Categories + junctions + classifyCategories action"
```

### Task 1.5: Smoke-test cds watch boot

**Files:** none (manual verification)

- [ ] **Step 1: Boot cds watch**

Run: `npx cds watch 2>&1 | head -50`

Wait for the "[cds] - server listening on { url: 'http://localhost:4004' }" line. Note the entity-deploy logs — should include `Categories`, `MissionCategories`, `GroupCategories`, `TutorialCategories`.

- [ ] **Step 2: Probe the OData metadata**

In a second terminal:
```bash
curl -s http://localhost:4004/admin/$metadata | grep -E "EntityType.*(Categor|MissionCateg|GroupCateg|TutorialCateg)"
```

Expected: lines naming all four entities.

- [ ] **Step 3: Probe the Categories list**

```bash
curl -s http://localhost:4004/admin/Categories | python -c "import sys,json; d=json.load(sys.stdin); print(len(d['value']))"
```

Expected: `8` (the seed loaded into SQLite). Note: cds watch's in-memory SQLite picks up CSV seeds on boot.

- [ ] **Step 4: Stop cds watch**

Ctrl+C in the cds-watch terminal. No commit — this task is verification-only.

---

## Phase 2 — Seed-embedding cache

End state: `srv/lib/category-seed-embeddings.js` exposes `getSeedEmbeddings()` (lazy-loaded `Map<categoryId, Float32Array>`), `invalidateSeedEmbedding(id)`, and `embedAdHoc(text)`. Boot is fast — no eager embedding at startup; the cache populates on first classifier call. Unit tests cover lazy load, invalidation, ad-hoc embed, and cache-miss recompute.

### Task 2.1: Create the seed-embedding cache module skeleton (Red)

**Files:**
- Create: `srv/lib/__tests__/category-seed-embeddings.test.js`

- [ ] **Step 1: Verify branch**

```bash
cd D:/projects/tutorials-poc && git branch --show-current
```

Expected: `feat/201-categories-facet`.

- [ ] **Step 2: Write the failing test file**

```js
// srv/lib/__tests__/category-seed-embeddings.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the embedding-client BEFORE the cache module imports it.
vi.mock('../embedding-client.js', () => ({
  embed: vi.fn(async (inputs) =>
    inputs.map((_, i) => new Float32Array([0.1 * (i + 1), 0.2, 0.3]))
  ),
}));

// Mock cds — getSeedEmbeddings reads Categories rows.
vi.mock('@sap/cds', () => {
  const log = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() });
  log.info = vi.fn();
  return {
    default: {
      log,
      entities: () => ({
        Categories: { name: 'Categories' },
      }),
    },
  };
});

// Stub global SELECT used by the cache.
beforeEach(() => {
  globalThis.SELECT = {
    from: () => ({
      columns: () => Promise.resolve([
        { ID: 'cat-1', seedDescription: 'AI and ML' },
        { ID: 'cat-2', seedDescription: 'CAP and ABAP' },
      ]),
    }),
  };
});

import { getSeedEmbeddings, invalidateSeedEmbedding, embedAdHoc, _resetCache } from '../category-seed-embeddings.js';
import { embed } from '../embedding-client.js';

describe('category-seed-embeddings', () => {
  beforeEach(() => {
    _resetCache();
    embed.mockClear();
  });

  it('lazy-loads on first call and caches', async () => {
    const m1 = await getSeedEmbeddings();
    const m2 = await getSeedEmbeddings();
    expect(m1).toBe(m2);                         // same Map instance
    expect(m1.size).toBe(2);
    expect(embed).toHaveBeenCalledTimes(1);      // not called twice
  });

  it('invalidates one entry and recomputes only that one on next call', async () => {
    await getSeedEmbeddings();
    invalidateSeedEmbedding('cat-1');
    const m = await getSeedEmbeddings();
    expect(m.has('cat-1')).toBe(true);
    // Two embed calls: first batch of 2, then 1 for the recompute.
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it('embedAdHoc returns a Float32Array', async () => {
    const v = await embedAdHoc('hello world');
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBeGreaterThan(0);
  });

  it('skips empty seedDescription entries', async () => {
    globalThis.SELECT = {
      from: () => ({
        columns: () => Promise.resolve([
          { ID: 'cat-3', seedDescription: '' },
          { ID: 'cat-4', seedDescription: 'real text' },
        ]),
      }),
    };
    _resetCache();
    embed.mockClear();
    const m = await getSeedEmbeddings();
    expect(m.has('cat-3')).toBe(false);          // skipped
    expect(m.has('cat-4')).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to confirm Red**

```bash
cd D:/projects/tutorials-poc && npx vitest run srv/lib/__tests__/category-seed-embeddings.test.js 2>&1 | tail -10
```

Expected: failure on `Cannot find module '../category-seed-embeddings.js'`.

### Task 2.2: Implement the cache module (Green)

**Files:**
- Create: `srv/lib/category-seed-embeddings.js`

- [ ] **Step 1: Implement**

```js
// srv/lib/category-seed-embeddings.js
//
// In-memory cache of category seed embeddings. Lazy: populates on first
// `getSeedEmbeddings()` call; entries invalidated by ID on
// `seedDescription` edits (called from the Categories OData UPDATE
// after-hook). `embedAdHoc(text)` is the helper used by the classifier
// to embed missions/groups (which don't have a persistent embedding row)
// and tutorials whose TutorialEmbedding row is missing.
//
// Why no persistent column on Categories.seedEmbedding:
//   - 8 rows, recomputable, ~1.5KB Float32Array per row
//   - Saves a LOB churn on every seedDescription edit
//   - Boot cost is paid lazily on first classify, not on cds boot
//
// Threading note: `getSeedEmbeddings()` is async and re-entrant. If two
// classify calls race the first load, both see the in-flight Promise via
// `_loadingPromise`, so only one batch embed call goes out.

import cds from '@sap/cds';
import { embed } from './embedding-client.js';

const LOG = cds.log('category-seed-embeddings');
let _cache = null;            // Map<categoryId, Float32Array> | null
let _loadingPromise = null;   // Promise<Map> | null — in-flight loader

/** Test-only — resets module state between tests. */
export function _resetCache() {
  _cache = null;
  _loadingPromise = null;
}

async function loadAll() {
  const { Categories } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(Categories).columns('ID', 'seedDescription');
  const usable = rows.filter(r => r.seedDescription && r.seedDescription.trim().length > 0);
  if (usable.length === 0) {
    LOG.warn('No categories with seedDescription found — classifier will fall back to LLM for everything');
    return new Map();
  }
  const vectors = await embed(usable.map(r => r.seedDescription));
  const m = new Map();
  for (let i = 0; i < usable.length; i++) {
    m.set(usable[i].ID, vectors[i]);
  }
  return m;
}

export async function getSeedEmbeddings() {
  if (_cache) return _cache;
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = (async () => {
    try {
      _cache = await loadAll();
      return _cache;
    } finally {
      _loadingPromise = null;
    }
  })();
  return _loadingPromise;
}

/** Drop one entry; next getSeedEmbeddings() call recomputes only it. */
export async function invalidateSeedEmbedding(categoryId) {
  if (!_cache) return; // not loaded yet — nothing to do
  _cache.delete(categoryId);
  // Recompute only that row eagerly so callers see consistent state.
  const { Categories } = cds.entities('com.sap.developers.ims');
  const [row] = await SELECT.from(Categories)
    .columns('ID', 'seedDescription')
    .where({ ID: categoryId });
  if (row?.seedDescription) {
    const [vec] = await embed([row.seedDescription]);
    _cache.set(categoryId, vec);
  }
}

/** Embed an ad-hoc piece of text (used for missions/groups/uncached tutorials). */
export async function embedAdHoc(text) {
  if (!text || !text.trim()) {
    throw new Error('embedAdHoc: empty text');
  }
  const [vec] = await embed([text]);
  return vec;
}
```

- [ ] **Step 2: Run test to confirm Green**

```bash
cd D:/projects/tutorials-poc && npx vitest run srv/lib/__tests__/category-seed-embeddings.test.js 2>&1 | tail -10
```

Expected: 4 tests passing.

- [ ] **Step 3: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add srv/lib/category-seed-embeddings.js srv/lib/__tests__/category-seed-embeddings.test.js && \
  git commit -m "feat(201): seed-embedding cache + embedAdHoc helper

Lazy load on first classify call (no eager boot cost). In-flight Promise
guards against the load racing itself. invalidateSeedEmbedding(id) drops
one entry and eagerly recomputes for consistent caller state.

4 unit tests."
```

---

## Phase 3 — Classifier core (decision tree)

End state: `classifyAndPersist(kind, id)` runs the embedding-then-LLM decision tree. Persists via delete-then-insert in a transaction. Tunable constants live at the top of the file. LLM wrapper is its own module so the classifier can be unit-tested without a real `OrchestrationClient`.

### Task 3.1: LLM-wrapper Red — failing tests

**Files:**
- Create: `srv/lib/__tests__/category-classifier-llm.test.js`

- [ ] **Step 1: Write the test file (mocks `OrchestrationClient`)**

Refer to the spec for the prompt shape and the codebase for the import idiom.
The test uses `vi.mock('@sap-ai-sdk/orchestration', ...)` to stub `OrchestrationClient`. Cover four cases:

1. Forced tool-call returns 2 valid categories → assigned has both.
2. Tool-call returns one valid + one made-up slug → made-up filtered out.
3. Tool-call array empty → `classifyViaLlm` throws `/no tool call/i`.
4. Tool-call returns duplicate slugs → de-duplicated; cap of 3 honored.

Test scaffold:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
const mockChatCompletion = vi.fn();
vi.mock('@sap-ai-sdk/orchestration', () => ({
  OrchestrationClient: vi.fn().mockImplementation(() => ({ chatCompletion: mockChatCompletion })),
}));
vi.mock('@sap/cds', () => {
  const log = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() });
  log.info = vi.fn();
  return { default: { log, env: {} } };
});
beforeEach(() => {
  globalThis.SELECT = { one: { from: () => Promise.resolve({ modelName: null, deploymentId: null }) } };
  mockChatCompletion.mockReset();
});
import { classifyViaLlm } from '../category-classifier-llm.js';
const TAXONOMY = [
  { slug: 'artificial-intelligence', label: 'Artificial Intelligence' },
  { slug: 'app-dev-automation',      label: 'Application Development & Automation' },
];
// ...assertions per the four cases above...
```

- [ ] **Step 2: Confirm Red**

```bash
cd D:/projects/tutorials-poc && npx vitest run srv/lib/__tests__/category-classifier-llm.test.js 2>&1 | tail -8
```

Expected: cannot find module `../category-classifier-llm.js`.

### Task 3.2: LLM-wrapper Green — implementation

**Files:**
- Create: `srv/lib/category-classifier-llm.js`

- [ ] **Step 1: Implement, mirroring `srv/lib/code-check-llm.js`**

Key shape:
- `OrchestrationClient` with `tool_choice: { type: 'function', function: { name: 'submit_categories' } }`.
- Tool schema enums `slug` to the supplied taxonomy so the model cannot hallucinate.
- Default model resolves through `ChatSettings.modelName` → `process.env.CHAT_MODEL_NAME` → `'anthropic--claude-4.6-sonnet'` (same fallback chain as code-check-llm).
- `MAX_TOKENS=512`, `TEMPERATURE=0` (deterministic).

Module skeleton:

```js
import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';

const LOG = cds.log('category-classifier-llm');
const TOOL_NAME = 'submit_categories';

function toolSchema(taxonomy) { /* enum slugs to taxonomy */ }
function buildSystem(taxonomy) { /* lines: `- ${slug}: ${label}` */ }
function buildUser({ title, description, tagSlugs }) { /* 3-line prompt */ }

export async function classifyViaLlm({ title, description, tagSlugs, taxonomy }) {
  // 1. resolve modelName / deploymentId via SELECT.one.from('ChatSettings') with try/catch
  // 2. construct OrchestrationClient with promptTemplating.model.params.tool_choice
  // 3. await client.chatCompletion({ messagesHistory: [{role:'user', content: buildUser(...)}] })
  // 4. response.getToolCalls() — throw if empty
  // 5. JSON.parse the function.arguments string; filter to taxonomy slugs; de-dup; cap at 3
  // 6. read getTokenUsage() best-effort; return { assigned, modelName, promptTokens, completionTokens }
}
```

The full implementation is mechanical — copy the structure of `srv/lib/code-check-llm.js` lines 80–161, swap the verdict tool for the categories tool, and emit the filter-and-cap logic for tool-call args.

- [ ] **Step 2: Confirm Green**

```bash
cd D:/projects/tutorials-poc && npx vitest run srv/lib/__tests__/category-classifier-llm.test.js 2>&1 | tail -8
```

Expected: 4 tests passing.

- [ ] **Step 3: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add srv/lib/category-classifier-llm.js srv/lib/__tests__/category-classifier-llm.test.js && \
  git commit -m "feat(201): forced-tool-call LLM wrapper for categorization"
```

### Task 3.3: Classifier core — Red

**Files:**
- Create: `srv/lib/__tests__/category-classifier.test.js`

- [ ] **Step 1: Write the failing test**

Mocks `getSeedEmbeddings`, `embedAdHoc`, and `classifyViaLlm` so the test is pure JS. Constructs deterministic vectors so the cosines are predictable: `[1,0,0]` for cat-ai, `[0.6,0.6,0]` for cat-app, `[0,1,0]` for cat-data.

Four assertions:

1. **Embedding clear win** — item vector `[1,0,0]` → top match cat-ai with cosine 1.0; LLM never called.
2. **Ambiguous → LLM** — item `[0.8,0.6,0]` → cat-ai 0.8, cat-app 0.96 (within `AMBIGUITY_GAP=0.05`) → LLM called; LLM returns `app-dev-automation`.
3. **Below threshold → LLM** — item `[0,0,1]` → all cosines 0; LLM called; LLM returns `data-analytics`.
4. **LLM also fails → skip** — `mockClassifyViaLlm.mockRejectedValue(...)` → result has `path: 'skip'`, empty assigned.

Test scaffold:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
const seedMap = new Map();
const mockGetSeed = vi.fn();
const mockEmbedAdHoc = vi.fn();
const mockClassifyViaLlm = vi.fn();
vi.mock('../category-seed-embeddings.js', () => ({
  getSeedEmbeddings: () => mockGetSeed(),
  embedAdHoc: (...a) => mockEmbedAdHoc(...a),
}));
vi.mock('../category-classifier-llm.js', () => ({
  classifyViaLlm: (...a) => mockClassifyViaLlm(...a),
}));
vi.mock('@sap/cds', () => { /* tx + entities + log */ });
// In beforeEach: stub SELECT.from(...).where(...) chains and globalThis.SELECT
// Then import { classifyAndPersist } from '../category-classifier.js';
```

- [ ] **Step 2: Confirm Red**

```bash
cd D:/projects/tutorials-poc && npx vitest run srv/lib/__tests__/category-classifier.test.js 2>&1 | tail -8
```

Expected: cannot find module `../category-classifier.js`.

### Task 3.4: Classifier core — Green

**Files:**
- Create: `srv/lib/category-classifier.js`

- [ ] **Step 1: Implement**

Tunable constants at the top:

```js
export const HIGH_THRESHOLD = 0.32;   // calibrated for text-embedding-3-small (1536-dim)
export const AMBIGUITY_GAP = 0.05;
export const MAX_CATEGORIES = 3;
```

Kind dispatch table:

```js
const KIND_TO_ENTITY = {
  mission:  { itemEntity: 'Missions',  junction: 'MissionCategories',  fk: 'mission_ID'  },
  group:    { itemEntity: 'Groups',    junction: 'GroupCategories',    fk: 'group_ID'    },
  tutorial: { itemEntity: 'Tutorials', junction: 'TutorialCategories', fk: 'tutorial_ID' },
};
```

Pure helpers:

- `cosine(a, b)` — Float32Array dot product, returns 0 on zero-norm.
- `loadItemText(kind, id)` — reads title/description/primaryTag, joins with newlines.
- `loadTaxonomy()` — `SELECT.from(Categories).columns('ID','slug','label','sortOrder')`.
- `rankByCosine(itemVec, seedMap, taxonomy)` — produces sorted-DESC scored array; tie-breaks by taxonomy `sortOrder` ASC.
- `pickEmbeddingResult(scored)` — returns `null` when top < `HIGH_THRESHOLD` OR top-1/top-2 gap < `AMBIGUITY_GAP`; else top-N (≤3) above threshold; rounds score to 4 decimals.

Public function:

```js
export async function classifyAndPersist(kind, id, _opts = {}) {
  const item = await loadItemText(kind, id);
  if (!item) return { kept: 0, assigned: [], path: 'skip' };
  const taxonomy = await loadTaxonomy();
  if (taxonomy.length === 0) return { kept: 0, assigned: [], path: 'skip' };

  let path = 'embedding';
  let assigned = null;

  // Embedding path
  try {
    const seedMap = await getSeedEmbeddings();
    const itemVec = await embedAdHoc(item.text);
    const scored = rankByCosine(itemVec, seedMap, taxonomy);
    const pick = pickEmbeddingResult(scored);
    if (pick) assigned = pick;
  } catch (e) { LOG.warn(`embedding path failed for ${kind}/${id}: ${e.message}`); }

  // LLM fallback
  if (!assigned) {
    path = 'llm';
    try {
      const { assigned: llmAssigned } = await classifyViaLlm({
        title: item.raw.title,
        description: item.raw.description,
        tagSlugs: item.raw.primaryTag ? [item.raw.primaryTag] : [],
        taxonomy: taxonomy.map(t => ({ slug: t.slug, label: t.label })),
      });
      const idBySlug = new Map(taxonomy.map(t => [t.slug, t.ID]));
      assigned = llmAssigned
        .filter(a => idBySlug.has(a.slug))
        .slice(0, MAX_CATEGORIES)
        .map(a => ({ ID: idBySlug.get(a.slug), slug: a.slug, score: Math.round(a.confidence * 10000) / 10000 }));
    } catch (e) {
      LOG.warn(`LLM path failed for ${kind}/${id}: ${e.message}`);
      assigned = null;
    }
  }

  if (!assigned) return { kept: 0, assigned: [], path: 'skip' };

  // Persist: delete-then-insert in one tx
  const cfg = KIND_TO_ENTITY[kind];
  await cds.tx(async (tx) => {
    await tx.run(DELETE.from(cfg.junction).where({ [cfg.fk]: id }));
    if (assigned.length === 0) return;
    await tx.run(INSERT.into(cfg.junction).entries(
      assigned.map(a => ({ [cfg.fk]: id, category_ID: a.ID, score: a.score ?? 1.0 }))
    ));
  });

  return { kept: 1, assigned: assigned.map(a => ({ slug: a.slug, score: a.score })), path };
}
```

- [ ] **Step 2: Confirm Green**

```bash
cd D:/projects/tutorials-poc && npx vitest run srv/lib/__tests__/category-classifier.test.js 2>&1 | tail -10
```

Expected: 4 tests passing.

- [ ] **Step 3: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add srv/lib/category-classifier.js srv/lib/__tests__/category-classifier.test.js && \
  git commit -m "feat(201): classifier core (embedding-first, LLM fallback)

HIGH_THRESHOLD 0.32 / AMBIGUITY_GAP 0.05 / MAX_CATEGORIES 3 — exported as
named constants for plan-time tuning. Persist via delete-then-insert in
one cds.tx (no provenance, no upsert per spec decision #9). 4 unit tests."
```

---

## Phase 4 — After-hooks + admin action

End state: New entity rows trigger async classification (fire-and-forget). UPDATEs that touch `title`/`description`/`primaryTag` re-classify after a 5s per-item debounce. Admin can call `classifyCategories({ kind, ids?, force })` and receive a counts summary — under a `job-lock` so two admins can't race.

### Task 4.1: Debounced after-hook module — Red

**Files:**
- Create: `srv/handlers/__tests__/categories-after-hooks.test.js`

- [ ] **Step 1: Write failing test (debounce + diff-detection logic only — no CAP wiring)**

Export a pure helper from the after-hooks module that returns `'classify' | 'reclassify' | 'skip'`. Test cases:

1. INSERT → `'classify'`.
2. UPDATE that changes `title` → `'reclassify'`.
3. UPDATE that changes `description` → `'reclassify'`.
4. UPDATE that changes `primaryTag` → `'reclassify'`.
5. UPDATE that changes only `featuredOrder` → `'skip'`.
6. UPDATE with no `req.diff()` available → `'skip'` (defensive).

Then test the debounce: with a fake-timer harness, two calls within 5s collapse into one classify; the second classify call uses the latest item ID.

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decideOnUpdate, makeDebouncedDispatcher } from '../categories-after-hooks.js';

describe('decideOnUpdate', () => {
  it('returns reclassify for title change', () => {
    expect(decideOnUpdate({ title: ['old', 'new'] })).toBe('reclassify');
  });
  it('returns reclassify for description change', () => {
    expect(decideOnUpdate({ description: ['old', 'new'] })).toBe('reclassify');
  });
  it('returns reclassify for primaryTag change', () => {
    expect(decideOnUpdate({ primaryTag: ['old', 'new'] })).toBe('reclassify');
  });
  it('returns skip for unrelated field change', () => {
    expect(decideOnUpdate({ featuredOrder: [1, 2] })).toBe('skip');
  });
  it('returns skip for empty diff', () => {
    expect(decideOnUpdate(null)).toBe('skip');
    expect(decideOnUpdate({})).toBe('skip');
  });
});

describe('makeDebouncedDispatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses two calls within 5s into one', async () => {
    const calls = [];
    const dispatch = makeDebouncedDispatcher({ delayMs: 5000, run: (kind, id) => { calls.push([kind, id]); } });
    dispatch('mission', 'm1');
    vi.advanceTimersByTime(2000);
    dispatch('mission', 'm1');
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([['mission', 'm1']]);
  });

  it('separate items debounce independently', () => {
    const calls = [];
    const dispatch = makeDebouncedDispatcher({ delayMs: 5000, run: (kind, id) => { calls.push([kind, id]); } });
    dispatch('mission', 'm1');
    dispatch('mission', 'm2');
    vi.advanceTimersByTime(5000);
    expect(calls.sort()).toEqual([['mission', 'm1'], ['mission', 'm2']]);
  });
});
```

- [ ] **Step 2: Confirm Red**

```bash
cd D:/projects/tutorials-poc && npx vitest run srv/handlers/__tests__/categories-after-hooks.test.js 2>&1 | tail -8
```

Expected: cannot find module.

### Task 4.2: After-hook module — Green

**Files:**
- Create: `srv/handlers/categories-after-hooks.js`

- [ ] **Step 1: Implement the pure helpers + the CAP `register` function**

```js
// srv/handlers/categories-after-hooks.js
//
// Fire-and-forget categorization after CRUD on Missions/Groups/Tutorials.
// INSERT → classify immediately (1s smear so the after-handler returns fast).
// UPDATE → reclassify only if title/description/primaryTag changed,
//          debounced 5s per item to collapse draft-activation PATCH storms.

import cds from '@sap/cds';
import { classifyAndPersist } from '../lib/category-classifier.js';

const LOG = cds.log('categories-after-hooks');
const DEBOUNCE_MS = 5000;
const RECLASSIFY_FIELDS = new Set(['title', 'description', 'primaryTag']);

export function decideOnUpdate(diff) {
  if (!diff || typeof diff !== 'object') return 'skip';
  for (const k of Object.keys(diff)) {
    if (RECLASSIFY_FIELDS.has(k)) return 'reclassify';
  }
  return 'skip';
}

export function makeDebouncedDispatcher({ delayMs = DEBOUNCE_MS, run }) {
  const timers = new Map(); // key: `${kind}:${id}` → timeoutId
  return function dispatch(kind, id) {
    const key = `${kind}:${id}`;
    const prev = timers.get(key);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => { timers.delete(key); run(kind, id); }, delayMs);
    timers.set(key, t);
  };
}

const dispatcher = makeDebouncedDispatcher({
  run: (kind, id) => {
    classifyAndPersist(kind, id).catch(e =>
      LOG.warn(`after-hook classify failed for ${kind}/${id}: ${e.message}`)
    );
  },
});

export function register(srv) {
  // INSERT — classify immediately on next tick.
  for (const [entity, kind] of [['Missions', 'mission'], ['Groups', 'group'], ['Tutorials', 'tutorial']]) {
    srv.after('CREATE', entity, async (data) => {
      const id = data?.ID;
      if (!id) return;
      setImmediate(() => {
        classifyAndPersist(kind, id).catch(e =>
          LOG.warn(`INSERT classify failed for ${kind}/${id}: ${e.message}`)
        );
      });
    });
    srv.after('UPDATE', entity, async (data, req) => {
      const id = data?.ID || req.data?.ID;
      if (!id) return;
      let diff = null;
      try { diff = await req.diff?.(); } catch { /* swallow */ }
      if (decideOnUpdate(diff) === 'reclassify') dispatcher(kind, id);
    });
  }
}
```

- [ ] **Step 2: Confirm Green**

```bash
cd D:/projects/tutorials-poc && npx vitest run srv/handlers/__tests__/categories-after-hooks.test.js 2>&1 | tail -8
```

Expected: 8 tests passing (6 decide + 2 debounce).

- [ ] **Step 3: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add srv/handlers/categories-after-hooks.js srv/handlers/__tests__/categories-after-hooks.test.js && \
  git commit -m "feat(201): after-hooks for INSERT/UPDATE classify

INSERT classifies on setImmediate (fire-and-forget). UPDATE inspects
req.diff() and only re-classifies when title/description/primaryTag
changed; per-item 5s debounce collapses draft-activation PATCH storms
(same pattern as srv/lib/rebuild-trigger.js from #220). 8 unit tests."
```

### Task 4.3: Wire after-hooks into `srv/server.js`

**Files:**
- Modify: `srv/server.js`

- [ ] **Step 1: Find the `cds.on('served', ...)` block**

Run: `grep -n "cds.on" srv/server.js`

The existing pattern attaches jobs there (see [srv/server.js](../../../srv/server.js)).

- [ ] **Step 2: Register the after-hooks**

Inside `cds.on('served', async () => { ... })`:

```js
const { register: registerCategoryHooks } = await import('./handlers/categories-after-hooks.js');
const adminSrv = await cds.connect.to('AdminService');
registerCategoryHooks(adminSrv);
```

(The hooks register on `AdminService` because Missions/Groups/Tutorials are projected on it.)

- [ ] **Step 3: Smoke-test `cds watch` boot**

Run: `npx cds watch 2>&1 | head -40`

Expected: no errors mentioning `categories-after-hooks` or `AdminService`. Ctrl+C.

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add srv/server.js && \
  git commit -m "feat(201): wire categories after-hooks on cds.on('served')"
```

### Task 4.4: Implement `classifyCategories` action — Red

**Files:**
- Create: `srv/__tests__/admin-service-categories.test.js`

- [ ] **Step 1: Write the failing test**

Use `cds.test` against the in-memory SQLite. Mock `classifyAndPersist` so the action returns predictable counts. Verify:

1. `kind: 'all'` → walks Missions + Groups + Tutorials (use seeded fixtures).
2. `kind: 'mission'` with `ids: ['m-1']` → only one classify call.
3. Two parallel callers of the action — second sees `{ skipped: <total> }` because `job-lock` is held.
4. On individual classify exception → counters increment `failed`, action does not throw.

```js
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(resolve(__dirname, '..', '..'));

const mockClassify = vi.fn().mockResolvedValue({ kept: 1, assigned: [{ slug: 'app-dev-automation', score: 0.9 }], path: 'embedding' });
vi.mock('../lib/category-classifier.js', () => ({ classifyAndPersist: mockClassify }));

const { server } = cds.test('serve', 'all');

describe('classifyCategories action', () => {
  // ...assertions per the four cases above using the bound POST /admin/classifyCategories...
});
```

- [ ] **Step 2: Confirm Red**

```bash
cd D:/projects/tutorials-poc && npx vitest run srv/__tests__/admin-service-categories.test.js 2>&1 | tail -8
```

Expected: action handler not registered → 404 / "no handler".

### Task 4.5: Implement the action — Green

**Files:**
- Modify: `srv/admin-service.js`

- [ ] **Step 1: Find the `module.exports = class AdminService extends ...` block**

Run: `grep -n "class AdminService" srv/admin-service.js`

- [ ] **Step 2: Add the `on('classifyCategories', ...)` handler**

```js
this.on('classifyCategories', async (req) => {
  const { kind, ids, force } = req.data;
  const { acquireLock, releaseLock } = await import('./jobs/job-lock.js');
  const LOCK_NAME = 'categories-classify';
  const INSTANCE_ID = process.env.CF_INSTANCE_INDEX || 'local';
  const LOCK_DURATION_MS = 30 * 60 * 1000;
  // Note actual signature: acquireLock(jobName, instanceId, durationMs).
  // releaseLock(jobName, instanceId). Mirror the convention used by
  // srv/lib/embedding-pipeline.js and srv/jobs/scheduler.js — confirm
  // by grepping `acquireLock(` in srv/ before adapting.
  const acquired = await acquireLock(LOCK_NAME, INSTANCE_ID, LOCK_DURATION_MS);
  if (!acquired) {
    return { processed: 0, succeeded: 0, failed: 0, skipped: 1 };
  }
  try {
    const { classifyAndPersist } = await import('./lib/category-classifier.js');
    const targets = await this._collectClassifyTargets(kind, ids);
    let succeeded = 0, failed = 0, skipped = 0;
    const CONCURRENCY = 4;
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(t => classifyAndPersist(t.kind, t.id, { force }))
      );
      for (const r of results) {
        if (r.status === 'rejected') failed++;
        else if (r.value.kept === 1) succeeded++;
        else skipped++;
      }
    }
    return { processed: targets.length, succeeded, failed, skipped };
  } finally {
    await releaseLock(LOCK_NAME, INSTANCE_ID);
  }
});

// Private helper at bottom of class.
async _collectClassifyTargets(kind, ids) {
  const out = [];
  const kinds = kind === 'all' ? ['mission', 'group', 'tutorial'] : [kind];
  for (const k of kinds) {
    const entityName = { mission: 'Missions', group: 'Groups', tutorial: 'Tutorials' }[k];
    const where = (Array.isArray(ids) && ids.length > 0) ? { ID: { in: ids } } : {};
    const rows = await SELECT.from(entityName).columns('ID').where(where);
    for (const r of rows) out.push({ kind: k, id: r.ID });
  }
  return out;
}
```

- [ ] **Step 2: Confirm Green**

```bash
cd D:/projects/tutorials-poc && npx vitest run srv/__tests__/admin-service-categories.test.js 2>&1 | tail -8
```

Expected: 4 tests passing.

- [ ] **Step 3: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add srv/admin-service.js srv/__tests__/admin-service-categories.test.js && \
  git commit -m "feat(201): classifyCategories admin action + job-lock

job-lock 'categories-classify' (30 min) prevents two admins racing a
bulk reclassify. Concurrency 4 inside the action — Promise.allSettled
so a single classify failure increments 'failed' counter without
aborting the batch. 4 unit tests."
```

---

## Phase 5 — Backfill script

End state: `node scripts/backfill-categories.cjs --kind=all` walks the entire catalog and persists category assignments via the classifier. Resumable via `--from-id`. Concurrency 4. Logs every 50 items. Idempotent (safe to re-run).

### Task 5.1: Backfill argument-parser — Red

**Files:**
- Create: `scripts/__tests__/backfill-categories.test.js`

- [ ] **Step 1: Failing test for the pure arg-parser**

```js
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../backfill-categories.cjs';

describe('parseArgs', () => {
  it('defaults kind=all, concurrency=4', () => {
    expect(parseArgs([])).toMatchObject({ kind: 'all', fromId: null, concurrency: 4, dryRun: false });
  });
  it('parses --kind=mission', () => {
    expect(parseArgs(['--kind=mission'])).toMatchObject({ kind: 'mission' });
  });
  it('parses --from-id <UUID>', () => {
    expect(parseArgs(['--from-id', 'abc-123'])).toMatchObject({ fromId: 'abc-123' });
  });
  it('parses --concurrency=8', () => {
    expect(parseArgs(['--concurrency=8'])).toMatchObject({ concurrency: 8 });
  });
  it('--dry-run is a boolean', () => {
    expect(parseArgs(['--dry-run'])).toMatchObject({ dryRun: true });
  });
  it('rejects unknown kind', () => {
    expect(() => parseArgs(['--kind=banana'])).toThrow();
  });
});
```

- [ ] **Step 2: Confirm Red**

```bash
cd D:/projects/tutorials-poc && npx vitest run scripts/__tests__/backfill-categories.test.js 2>&1 | tail -8
```

Expected: cannot find module.

### Task 5.2: Backfill script — Green

**Files:**
- Create: `scripts/backfill-categories.cjs`

- [ ] **Step 1: Implement** (CommonJS so we can call it directly without TS compile)

Key shape:

- `parseArgs(argv)` exported for tests; supports `--kind=all|mission|group|tutorial`, `--from-id <UUID>` or `--from-id=<UUID>`, `--concurrency=N` (default 4), `--dry-run`. Rejects unknown kind.
- `main(argv)` connects via `cds.connect.to('db')`, dynamic-imports `srv/lib/category-classifier.js`, walks each kind via `SELECT.from(<entity>).orderBy('ID')`, applies `--from-id` resume cutoff, batches `Promise.allSettled` at `args.concurrency`.
- Counters: `total`, `succeeded`, `failed`, `skipped`. Logs every 50 items + final summary. Exits non-zero if any failed.

Skeleton:

```js
#!/usr/bin/env node
'use strict';
const VALID_KINDS = ['all', 'mission', 'group', 'tutorial'];
function parseArgs(argv) {
  const args = { kind: 'all', fromId: null, concurrency: 4, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--kind=')) args.kind = a.slice('--kind='.length);
    else if (a === '--from-id') args.fromId = argv[++i];
    else if (a.startsWith('--from-id=')) args.fromId = a.slice('--from-id='.length);
    else if (a.startsWith('--concurrency=')) args.concurrency = Number.parseInt(a.slice('--concurrency='.length), 10) || 4;
    else if (a === '--dry-run') args.dryRun = true;
  }
  if (!VALID_KINDS.includes(args.kind)) throw new Error(`--kind must be one of ${VALID_KINDS.join('|')}`);
  return args;
}
async function main(argv) { /* ...as above... */ }
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error('[backfill] FATAL', e); process.exit(2); });
module.exports = { parseArgs };
```

- [ ] **Step 2: Confirm Green**

```bash
cd D:/projects/tutorials-poc && npx vitest run scripts/__tests__/backfill-categories.test.js 2>&1 | tail -8
```

Expected: 6 tests passing.

- [ ] **Step 3: Add npm script**

Edit `package.json` to add `"backfill-categories": "node scripts/backfill-categories.cjs"` to `scripts`.

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add scripts/backfill-categories.cjs scripts/__tests__/backfill-categories.test.js package.json && \
  git commit -m "feat(201): one-shot backfill script + npm run backfill-categories

Resumable via --from-id, concurrency 4, --dry-run preview. Exits
non-zero when any item failed. 6 unit tests on the arg parser."
```

---

## Phase 6 — Catalog payload + Hugo data

End state: `/build/catalog` returns `categorySlugs[]` per card (top-3, sorted by score DESC then sortOrder ASC) plus a top-level `categories[]` array with `{ slug, label, sortOrder, activeCount }`. `scripts/parsers/cap.ts` threads both into `hugo/data/browse.json` and per-card frontmatter.

### Task 6.1: Extend `srv/lib/build-catalog.js` — Red

**Files:**
- Create OR Modify: `srv/__tests__/build-catalog.test.js`

- [ ] **Step 1: Check whether a build-catalog test already exists**

```bash
cd D:/projects/tutorials-poc && find srv -name "build-catalog*test*" 2>/dev/null
```

If none exists, create one. If one exists, extend it with the new cases.

- [ ] **Step 2: Add (or write) failing tests**

Two cases:

1. With seeded categories + assignments → response body includes `categorySlugs: ['ai', 'app-dev-automation']` per card sorted by score DESC, plus top-level `categories: [{slug, label, sortOrder, activeCount}, ...]` length 8.
2. With NO category assignments yet → all `categorySlugs: []`, top-level `categories[]` still has 8 rows but every `activeCount` is 0.

- [ ] **Step 3: Confirm Red**

Expected: assertion failures on missing fields.

### Task 6.2: Implement payload extension — Green

**Files:**
- Modify: `srv/lib/build-catalog.js`

- [ ] **Step 1: Add the join + projection**

After the existing `SELECT.from(...)` calls that load `missions`, `groups`, `tutorials`, add:

```js
const categories = await SELECT.from(Categories).columns('ID', 'slug', 'label', 'sortOrder');
const catBySlug = new Map(categories.map(c => [c.ID, c]));

const missionAssign = await SELECT.from(MissionCategories).columns('mission_ID', 'category_ID', 'score');
const groupAssign   = await SELECT.from(GroupCategories).columns('group_ID', 'category_ID', 'score');
const tutorialAssign = await SELECT.from(TutorialCategories).columns('tutorial_ID', 'category_ID', 'score');

function categorySlugsFor(itemId, assignments, fk) {
  return assignments
    .filter(a => a[fk] === itemId)
    .map(a => ({ ...a, meta: catBySlug.get(a.category_ID) }))
    .filter(a => a.meta)
    .sort((a, b) => (b.score - a.score) || (a.meta.sortOrder - b.meta.sortOrder))
    .slice(0, 3)
    .map(a => a.meta.slug);
}
```

Then on each card-list mapper, add:

```js
categorySlugs: categorySlugsFor(m.ID, missionAssign, 'mission_ID'),  // for missions
// ...same for groups (group_ID) and tutorials (tutorial_ID)
```

And compute `activeCount` for the top-level array:

```js
function countActiveFor(catId) {
  const m = missionAssign.filter(a => a.category_ID === catId).length;
  const g = groupAssign.filter(a => a.category_ID === catId).length;
  const t = tutorialAssign.filter(a => a.category_ID === catId).length;
  return m + g + t;
}
const categoriesPayload = categories
  .map(c => ({ slug: c.slug, label: c.label, sortOrder: c.sortOrder ?? 100, activeCount: countActiveFor(c.ID) }))
  .sort((a, b) => a.sortOrder - b.sortOrder);
```

Add `categories: categoriesPayload` to the response object (sibling to `missions`, `groups`, `paths`).

- [ ] **Step 2: Confirm Green**

```bash
cd D:/projects/tutorials-poc && npx vitest run srv/__tests__/build-catalog.test.js 2>&1 | tail -8
```

Expected: tests pass.

- [ ] **Step 3: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add srv/lib/build-catalog.js srv/__tests__/build-catalog.test.js && \
  git commit -m "feat(201): /build/catalog returns categorySlugs[] + categories[]"
```

### Task 6.3: Thread through `scripts/parsers/cap.ts` — Red + Green

**Files:**
- Modify: `scripts/parsers/cap.ts`, `scripts/fetch-tutorials.ts`

- [ ] **Step 1: Inspect the `fetchBuildCatalog` return shape**

```bash
cd D:/projects/tutorials-poc && grep -nE "interface .*Catalog|categorySlugs|categories" scripts/parsers/cap.ts | head
```

- [ ] **Step 2: Add `categorySlugs` to per-card types and `categories` to the catalog return shape**

In the `Mission`/`Group`/`StandaloneGroup`/tutorial card type definitions, add:

```ts
categorySlugs: string[];
```

In the catalog-fetch return:

```ts
categories: Array<{ slug: string; label: string; sortOrder: number; activeCount: number }>;
```

When mapping the JSON response to typed cards, pass through the new field with default `[]` for older payloads (defensive).

- [ ] **Step 3: Update `hugo/data/browse.json` writer**

Find where `browse.json` is written (likely in `scripts/fetch-tutorials.ts`). Add the `categories` array there, sourced from `catalog.categories`.

- [ ] **Step 4: Run targeted parser tests**

```bash
cd D:/projects/tutorials-poc && npx vitest run scripts/parsers 2>&1 | tail -10
```

Expected: existing tests still pass; new field-presence tests also pass.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add scripts/parsers/cap.ts scripts/fetch-tutorials.ts && \
  git commit -m "feat(201): thread categorySlugs/categories through cap parser → browse.json"
```

---

## Phase 7 — Frontend (filter rail + chip + URL)

End state: `?category=` round-trips through `urlSync.ts`. The filter rail renders a Categories `<details>` group above existing facets. Each card shows a single primary-category chip. The `/browse/` Vue island filters cards reactively as checkboxes toggle. SSR honors `?category=` for first paint.

### Task 7.1: Add `categories` field to `urlSync.ts` — Red

**Files:**
- Create: `hugo-apps/src/navigator/__tests__/urlSync-category.test.ts`

- [ ] **Step 1: Failing test for round-trip**

Five cases:

1. `?category=ai,app-dev` → `state.categories === ['ai','app-dev']`.
2. No `?category=` → `state.categories === []`.
3. Writing `categories: ['ai','integration']` → URL contains `category=ai%2Cintegration`.
4. Writing `categories: []` strips an existing `?category=` from the URL.
5. Explicit-empty `?category=` → `state.categories === []` (URL wins over LS migration).

```ts
import { describe, it, expect } from 'vitest';
import { parseNavState, writeNavState, EMPTY_STATE } from '../urlSync';
// ...assertions per the five cases above...
```

- [ ] **Step 2: Confirm Red**

```bash
cd D:/projects/tutorials-poc && npx vitest run hugo-apps/src/navigator/__tests__/urlSync-category.test.ts 2>&1 | tail -8
```

Expected: failures because `categories` isn't in `NavState` yet.

### Task 7.2: Implement `categories` field — Green

**Files:**
- Modify: `hugo-apps/src/navigator/urlSync.ts`

- [ ] **Step 1: Add the field across `PARAM`, `NavState`, `EMPTY_STATE`, `parseNavState`, `writeNavState`**

In `PARAM` (after `page: 'page'`):

```ts
  categories: 'category',
```

In `NavState`:

```ts
  categories: string[]
```

In `EMPTY_STATE`:

```ts
  categories: [],
```

In `parseNavState`, mirror the `topics`/`products` `asArray` pattern, and include `categories` in the returned object.

In `writeNavState`, mirror the `topics`/`products` pattern:

```ts
if (next.categories.length === 0) url.searchParams.delete(PARAM.categories);
else url.searchParams.set(PARAM.categories, next.categories.join(','));
```

- [ ] **Step 2: Confirm Green**

```bash
cd D:/projects/tutorials-poc && npx vitest run hugo-apps/src/navigator 2>&1 | tail -10
```

Expected: 5 new tests pass; existing urlSync tests unchanged.

- [ ] **Step 3: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add hugo-apps/src/navigator/urlSync.ts hugo-apps/src/navigator/__tests__/urlSync-category.test.ts && \
  git commit -m "feat(201): add categories 9th field to urlSync.ts"
```

### Task 7.3: `CardItem.categorySlugs` + filter composable branch

**Files:**
- Modify: `hugo-apps/src/shared/types.ts`
- Modify: `hugo-apps/src/shared/composables/useNavigatorFilters.ts`
- Create: `hugo-apps/src/shared/composables/__tests__/useNavigatorFilters-categories.test.ts`

- [ ] **Step 1: Add `categorySlugs?: string[]` to `CardItem`**

Optional because the legacy `/` navigator may pass cards without it until backfill runs.

- [ ] **Step 2: Failing test for filter composable**

Four cases (see spec for OR-combine semantics):

1. No categories selected → all cards passed through.
2. Single selected → only matching items.
3. Multi selected → OR-combined within the group.
4. Items WITHOUT `categorySlugs` are excluded once any category filter is set (defensive).

- [ ] **Step 3: Add the filter branch to `useNavigatorFilters.ts`**

```ts
const selCats = filters.categories ?? []
if (selCats.length > 0) {
  result = result.filter(item =>
    Array.isArray(item.categorySlugs) && item.categorySlugs.some(s => selCats.includes(s))
  )
}
```

Wire `categories` into the `urlSync` ↔ `filters` translation if the composable does that for products/topics today.

- [ ] **Step 4: Confirm Green**

```bash
cd D:/projects/tutorials-poc && npx vitest run hugo-apps/src/shared/composables 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add hugo-apps/src/shared/types.ts hugo-apps/src/shared/composables/useNavigatorFilters.ts hugo-apps/src/shared/composables/__tests__/useNavigatorFilters-categories.test.ts && \
  git commit -m "feat(201): CardItem.categorySlugs + selectedCategories filter branch"
```

### Task 7.4: Render single primary-category chip on cards

**Files:**
- Modify: `hugo-apps/src/shared/cards/MissionCard.vue`, `GroupCard.vue`, `TutorialCard.vue`
- Modify: `hugo-apps/src/shared/cards/cards.test.ts`

- [ ] **Step 1: Extend `cards.test.ts`**

Two cases per card type (6 cases total):

1. With `categorySlugs: ['artificial-intelligence']` and label-lookup map → chip text "Artificial Intelligence".
2. Empty/undefined `categorySlugs` → no chip rendered.

- [ ] **Step 2: Add chip to each card's tag-strip area**

```vue
<ui5-tag
  v-if="item.categorySlugs && item.categorySlugs.length > 0"
  design="Set2"
  class="card-category-chip"
>
  {{ categoryLabel(item.categorySlugs[0]) }}
</ui5-tag>
```

`categoryLabel(slug)` reads from the inline `<script id="browse-data">` JSON (or accepts an override map for tests).

- [ ] **Step 3: Confirm Green**

```bash
cd D:/projects/tutorials-poc && npx vitest run hugo-apps/src/shared/cards 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add hugo-apps/src/shared/cards/ && \
  git commit -m "feat(201): single primary-category chip on cards (Set2 design)"
```

### Task 7.5: Filter-rail SSR + `controller.ts` wiring

**Files:**
- Modify: `hugo/layouts/partials/browse/_partials/filter-rail.html`
- Modify: `hugo/layouts/browse/list.html`
- Modify: `hugo-apps/src/browse/controller.ts`

- [ ] **Step 1: Add the rail group above existing facets**

In `filter-rail.html`:

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

- [ ] **Step 2: SSR filter pre-application in `list.html`**

Find where `?product=` / `?topic=` are honored. Add the same shape for `?category=`. Apply to the SSR card list before render.

- [ ] **Step 3: Wire `name="category"` checkboxes in `controller.ts`**

Find the existing branches for `name="product"` and `name="topic"`. Add a parallel branch for `name="category"` → `filters.categories`. Two-way: change events flush; ref watcher syncs `checked` attributes.

- [ ] **Step 4: Smoke-build**

```bash
cd D:/projects/tutorials-poc && npm run fetch-tutorials && npx hugo --minify --quiet 2>&1 | tail -5
```

Expected: clean build. Inspect `hugo/public/browse/index.html` for the Categories `<details>` group.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add hugo/layouts/partials/browse/_partials/filter-rail.html hugo/layouts/browse/list.html hugo-apps/src/browse/controller.ts && \
  git commit -m "feat(201): Categories rail + SSR filter + controller wiring"
```

---

## Phase 8 — Admin UI (Categories Fiori app + per-OP facet)

End state: Dedicated Categories app at `/admin-ui/#categories-display` with master list, bulk-ops bar, and per-category Object Page. Each Mission/Group/Tutorial admin OP grows a Categories facet with `MultiInput` + "Classify this item" button. Annotations live in `app/admin-annotations.cds`. App tile registered in admin shell.

This phase is mostly mechanical — mirror `app/admin/tags/` for the dedicated app, mirror existing `Tags` facet annotations for the per-OP additions. Tasks here are coarser than Phases 1–7 because Fiori Elements doesn't lend itself to TDD; verification is manual via the deployed admin UI.

### Task 8.1: Scaffold the Categories Fiori Elements app

**Files:**
- Create: `app/admin/categories/` (full folder mirroring `app/admin/tags/`)

- [ ] **Step 1: Copy `tags/` skeleton**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  cp -r app/admin/tags app/admin/categories
```

- [ ] **Step 2: Sed-rename identifiers**

In every file under `app/admin/categories/`:

- `sap.tutorials.admin.tags` → `sap.tutorials.admin.categories`
- Component IDs `Tag*` → `Category*`
- Manifest semantic object `Tag` → `Category`
- App title and i18n keys `tag*` → `category*`

```bash
cd D:/projects/tutorials-poc && \
  sd -F 'sap.tutorials.admin.tags' 'sap.tutorials.admin.categories' app/admin/categories/**/*.* && \
  sd -F '"semanticObject": "Tag"' '"semanticObject": "Category"' app/admin/categories/**/*.json
```

(adjust the glob if your shell needs it; otherwise edit by hand for ≤5 files)

- [ ] **Step 3: Wire `mainService` to `/admin/Categories` (already at `/admin/`)**

The data-source path stays `/admin/`; the entity name in the manifest's `routing.targets` changes from `Tags` to `Categories`. Find the `routing.targets` block in `manifest.json` and rename target IDs accordingly.

- [ ] **Step 4: Add `componentUsages` in `app/admin-shell/package.json`**

Mirror the existing `tags` entry. Re-uses the same loader pattern.

- [ ] **Step 5: Smoke-build the admin shell**

```bash
cd D:/projects/tutorials-poc && \
  cd app/admin-shell && npm run build 2>&1 | tail -5
```

Expected: build succeeds; no missing component errors.

- [ ] **Step 6: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add app/admin/categories/ app/admin-shell/package.json && \
  git commit -m "feat(201): scaffold Categories Fiori Elements app

Copy of app/admin/tags/ with identifiers renamed. Wired into the admin
shell via componentUsages. No annotations yet — Task 8.2 adds them."
```

### Task 8.2: Add `@UI` annotations on `Categories`

**Files:**
- Modify: `app/admin-annotations.cds`

- [ ] **Step 1: Add the master-list annotations**

Append:

```cds
annotate AdminService.Categories with @(
  UI.HeaderInfo: {
    TypeName: 'Category',
    TypeNamePlural: 'Categories',
    Title: { Value: label }
  },
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: slug,            Label: 'Slug' },
    { $Type: 'UI.DataField', Value: label,           Label: 'Label' },
    { $Type: 'UI.DataField', Value: sortOrder,       Label: 'Sort order' },
    { $Type: 'UI.DataField', Value: seedDescription, Label: 'Seed description' },
  ],
  UI.FieldGroup #Main: {
    Data: [
      { $Type: 'UI.DataField', Value: slug,            Label: 'Slug' },
      { $Type: 'UI.DataField', Value: label,           Label: 'Label' },
      { $Type: 'UI.DataField', Value: sortOrder,       Label: 'Sort order' },
      { $Type: 'UI.DataField', Value: seedDescription, Label: 'Seed description' },
    ]
  },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'Main', Target: '@UI.FieldGroup#Main' }
  ]
);

annotate AdminService.Categories with {
  slug @UI.HiddenFilter; // master list filters by label, not slug
  seedDescription @Common.MultiLineText;
};
```

- [ ] **Step 2: Add `@cds.changetracking.exclude` on Categories + 3 junctions**

Per the spec — junction churn during reclassify produces audit-log noise without value:

```cds
annotate db.Categories         with @cds.changetracking.exclude: true;
annotate db.MissionCategories  with @cds.changetracking.exclude: true;
annotate db.GroupCategories    with @cds.changetracking.exclude: true;
annotate db.TutorialCategories with @cds.changetracking.exclude: true;
```

- [ ] **Step 3: Verify CDS compiles**

```bash
cd D:/projects/tutorials-poc && npx cds compile srv/ 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add app/admin-annotations.cds && \
  git commit -m "feat(201): @UI annotations on Categories + change-tracking opt-out"
```

### Task 8.3: Per-OP Categories facet on Mission/Group/Tutorial

**Files:**
- Modify: `app/admin-annotations.cds`

- [ ] **Step 1: Find the existing Tags facet**

```bash
cd D:/projects/tutorials-poc && grep -n "Tags.*Facet\|UI.Facets" app/admin-annotations.cds | head -10
```

- [ ] **Step 2: Add Categories facet alongside the Tags facet on each entity**

For each of `Missions`, `Groups`, `Tutorials`, add a `UI.ReferenceFacet` pointing to the categories composition:

```cds
{ $Type: 'UI.ReferenceFacet', Label: 'Categories', ID: 'CategoriesFacet',
  Target: 'categories/@UI.LineItem' }
```

And on the junction projections (`MissionCategories`, `GroupCategories`, `TutorialCategories`), add a `UI.LineItem` annotation showing `category` (with value-help to Categories) and `score`:

```cds
annotate AdminService.MissionCategories with @(
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: category_ID, Label: 'Category' },
    { $Type: 'UI.DataField', Value: score, Label: 'Score' },
  ]
);
annotate AdminService.MissionCategories.category with @Common: {
  ValueListWithFixedValues: true,
  Text: category.label,
  TextArrangement: #TextOnly,
  ValueList: { CollectionPath: 'Categories', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: category_ID, ValueListProperty: 'ID' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'label' },
  ]}
};
// Repeat for Group/Tutorial Categories projections
```

- [ ] **Step 3: Verify CDS compiles**

```bash
cd D:/projects/tutorials-poc && npx cds compile srv/ 2>&1 | tail -5
```

- [ ] **Step 4: Smoke-test admin OP**

Run `npx cds watch`. Open `http://localhost:4004/admin-ui/#missions-manage`. Open any Mission OP. Expected: a "Categories" tab/section now shows alongside the existing "Tags".

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add app/admin-annotations.cds && \
  git commit -m "feat(201): per-OP Categories facet on Missions/Groups/Tutorials"
```

### Task 8.4: Bulk-ops bar — "Classify uncategorized" / "Re-classify (force)" / "Embed seeds"

**Files:**
- Create: `app/admin/categories/webapp/ext/CategoryActionsController.controller.js`
- Create: `app/admin/categories/webapp/ext/ClassifyConfirmDialog.fragment.xml`

- [ ] **Step 1: Implement controller — three buttons**

Mirror `app/admin/tags/webapp/ext/TagImportController.controller.js`. Three actions:

1. **Classify uncategorized** — `POST /admin/classifyCategories` with `{ kind: 'all', force: false }`. Toast on result with counts.
2. **Re-classify everything (force)** — same body with `force: true`, gated behind the confirm dialog from `ClassifyConfirmDialog.fragment.xml`.
3. **Embed seeds** — calls a small admin-only endpoint that iterates all categories and calls `invalidateSeedEmbedding(id)` (which eagerly recomputes). Add this endpoint to `srv/admin-service.js` as a quick action.

- [ ] **Step 2: Implement the destructive confirm dialog**

`ClassifyConfirmDialog.fragment.xml`:

```xml
<core:FragmentDefinition xmlns="sap.m" xmlns:core="sap.ui.core">
  <Dialog title="Re-classify everything?" type="Message" state="Warning">
    <content>
      <Text text="This will overwrite every category assignment — including any you have manually edited. Reclassify is destructive (no undo)."/>
    </content>
    <buttons>
      <Button text="Re-classify" type="Reject" press=".onConfirmReclassify"/>
      <Button text="Cancel" press=".onCancelReclassify"/>
    </buttons>
  </Dialog>
</core:FragmentDefinition>
```

- [ ] **Step 3: Manifest extension entry**

In `app/admin/categories/webapp/manifest.json` `extends.extensions`, register the controller as a `view-extension` on the master ListReport.

- [ ] **Step 4: Manual smoke**

`npx cds watch`, open the Categories app, click "Classify uncategorized" — should fire the OData action and display a toast.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add app/admin/categories/webapp/ext/ app/admin/categories/webapp/manifest.json && \
  git commit -m "feat(201): bulk-ops bar — classify uncategorized / reclassify / embed seeds"
```

### Task 8.5: Admin shell side-nav entry

**Files:**
- Modify: `app/admin-shell/src/router/Routes.ts` (or wherever side-nav is wired)

- [ ] **Step 1: Add Categories side-nav entry**

Mirror the existing Tags side-nav entry. Tile color/icon the same family (taxonomy-themed).

- [ ] **Step 2: Build the shell**

```bash
cd D:/projects/tutorials-poc/app/admin-shell && npm run build 2>&1 | tail -5
```

Expected: clean build.

- [ ] **Step 3: Manual smoke**

Open `/admin-ui/#categories-display`. Confirm the side-nav highlights the entry and the master list renders.

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add app/admin-shell/ && \
  git commit -m "feat(201): Categories side-nav entry in admin shell"
```

---

## Phase 9 — Hybrid + smoke + deploy choreography + close-out

End state: Hybrid + smoke tests in place; CLAUDE.md updated; `srv-qa` cp list updated; deploy choreography documented; PR opened against main.

### Task 9.1: Hybrid test (real HANA + AI Core)

**Files:**
- Create: `test/hybrid/categories-classifier.test.js`

- [ ] **Step 1: Write the hybrid test, gated by `HYBRID_AI_TESTS=true`**

```js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const RUN = process.env.HYBRID_AI_TESTS === 'true';

(RUN ? describe : describe.skip)('hybrid: classifier against real HANA + AI Core', () => {
  it('classifies a known AI-themed mission into artificial-intelligence', async () => {
    await cds.connect.to('db');
    const { classifyAndPersist } = await import('../../srv/lib/category-classifier.js');
    // Pick a deterministic seed mission slug that should land in AI.
    const [m] = await SELECT.from('Missions').columns('ID').where({ slug: 'ai-mission-fixture' }).limit(1);
    if (!m) return; // skip if fixture missing
    const r = await classifyAndPersist('mission', m.ID);
    expect(r.kept).toBe(1);
    expect(r.assigned.map(a => a.slug)).toContain('artificial-intelligence');
  });
});
```

- [ ] **Step 2: Document the gate in CLAUDE.md**

Add a "Gotchas" entry: "**Hybrid AI tests** — `npm run test:hybrid` is $0/run by default. Set `HYBRID_AI_TESTS=true` to opt into category-classifier tests that consume real AI Core quota."

- [ ] **Step 3: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add test/hybrid/categories-classifier.test.js CLAUDE.md && \
  git commit -m "test(201): hybrid HANA+AI classifier test (gated by HYBRID_AI_TESTS)"
```

### Task 9.2: Smoke test (deployed `/browse/?category=…`)

**Files:**
- Create: `test/smoke/browse-categories.test.js`

- [ ] **Step 1: Write the smoke test**

```js
import { describe, it, expect } from 'vitest';

const SRV = process.env.SMOKE_SRV_URL;
const APP = process.env.SMOKE_BASE_URL;
const RUN = !!SRV && !!APP;

(RUN ? describe : describe.skip)('smoke: /browse/ Categories facet', () => {
  it('GET /build/catalog includes categorySlugs[] and top-level categories[]', async () => {
    const r = await fetch(`${SRV}/build/catalog`);
    expect(r.ok).toBe(true);
    const j = await r.json();
    expect(Array.isArray(j.categories)).toBe(true);
    expect(j.categories.length).toBe(8);
    expect(j.categories[0]).toHaveProperty('slug');
    expect(j.categories[0]).toHaveProperty('activeCount');
    expect(j.missions[0]).toHaveProperty('categorySlugs');
  });

  it('GET /browse/?category=artificial-intelligence renders only AI cards', async () => {
    const r = await fetch(`${APP}/browse/?category=artificial-intelligence`);
    expect(r.ok).toBe(true);
    const html = await r.text();
    expect(html).toMatch(/data-group="categories"/);
    expect(html).toMatch(/checked.*?artificial-intelligence/i);
  });
});
```

- [ ] **Step 2: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add test/smoke/browse-categories.test.js && \
  git commit -m "test(201): smoke test /build/catalog payload + /browse/?category= SSR"
```

### Task 9.3: `srv-qa` cp list audit

**Files:**
- Modify: `.deploy/mta.yaml`

- [ ] **Step 1: Re-walk the new transitive imports**

Per [feedback_check_srv_qa_when_changing_srv](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_check_srv_qa_when_changing_srv.md), `srv-qa`'s `cp` list is hand-curated. New files this PR adds that may be transitively imported by `srv/lib/build-catalog.js` or hot-path runtime:

- `srv/lib/category-classifier.js`
- `srv/lib/category-classifier-llm.js`
- `srv/lib/category-seed-embeddings.js`
- `srv/handlers/categories-after-hooks.js`

- [ ] **Step 2: Add them to the `cp` list**

Find the `srv-qa` resource in `.deploy/mta.yaml`; add `cp` lines for each.

- [ ] **Step 3: Verify mta build**

```bash
cd D:/projects/tutorials-poc/.deploy && mbt build 2>&1 | tail -10
```

Expected: clean build, no missing-file errors.

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add .deploy/mta.yaml && \
  git commit -m "build(201): add classifier modules to srv-qa cp list"
```

### Task 9.4: CLAUDE.md gotchas + architecture doc

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/developers/architecture/categories-classifier.md`
- Modify: `docs/.vitepress/config.ts` (sidebar entry for the new doc)

- [ ] **Step 1: Add three Gotchas to CLAUDE.md**

```markdown
- **Categories taxonomy is fixed in v1** — the 8 categories are seeded via `db/data/com.sap.developers.ims-Categories.csv` with stable UUIDs. Admins can edit `label`/`sortOrder`/`seedDescription` but not add or remove categories. Adding a new category is a v2 concern (master-list CRUD).
- **Reclassify is destructive** — `classifyCategories` and the per-OP "Classify this item" button DELETE then INSERT the junction rows. Manual edits survive only until the next reclassify. There is no provenance tracking (per spec decision #9).
- **`HYBRID_AI_TESTS=true`** — opt-in env var for the classifier hybrid test. `npm run test:hybrid` runs are $0/run by default; setting this consumes real AI Core quota.
```

- [ ] **Step 2: Write `docs/developers/architecture/categories-classifier.md` (~80 lines)**

Cover: flow diagram, decision-tree table, seedDescription tuning runbook, deploy choreography (db deploy → srv deploy → manual backfill → trigger rebuild-content), error-handling matrix, follow-ups list. Reference the spec at `docs/superpowers/specs/2026-06-07-categories-facet-design.md`.

- [ ] **Step 3: Add sidebar entry to `docs/.vitepress/config.ts`**

Find the architecture-section sidebar group. Add an entry for the new doc.

- [ ] **Step 4: Verify docs build**

```bash
cd D:/projects/tutorials-poc && npm run docs:build 2>&1 | tail -5
```

Expected: clean build, no broken links.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git add CLAUDE.md docs/developers/architecture/categories-classifier.md docs/.vitepress/config.ts && \
  git commit -m "docs(201): CLAUDE.md gotchas + categories-classifier architecture doc"
```

### Task 9.5: Receive code review + open PR

- [ ] **Step 1: Run the code-review skill on the diff vs. main**

Invoke the `code-review` skill (effort: high) — it reads HEAD vs. main and surfaces correctness/efficiency/cleanup findings. Address any genuine bugs; defer stylistic polish.

- [ ] **Step 2: Run the simplify skill on the diff**

Apply quality cleanups (DRY, dead code, naming). Re-run targeted tests.

- [ ] **Step 3: Push and open PR**

```bash
cd D:/projects/tutorials-poc && \
  test "$(git branch --show-current)" = "feat/201-categories-facet" || { echo "WRONG BRANCH"; exit 1; } && \
  git push -u origin feat/201-categories-facet && \
  gh pr create --base main --head feat/201-categories-facet \
    --title "feat: /browse/ Categories facet with hybrid embedding+LLM classifier (#201)" \
    --body-file - <<'EOF'
Closes #201.

## What this ships

- **Categories** master entity (8 seeded rows) + 3 junction tables.
- **Hybrid classifier** in `srv/lib/category-classifier.js` — embedding similarity primary, forced-tool-call LLM fallback (mirrors `srv/lib/code-check-llm.js`).
- **After-hooks** classify on entity create + on title/description/primaryTag changes (5s debounce).
- **Admin OData action** `classifyCategories({ kind, ids?, force })` under a `job-lock` for bulk reclassify.
- **Backfill script** `npm run backfill-categories` — resumable, concurrency 4, dry-run, idempotent.
- **Catalog payload** — `categorySlugs[]` per card + top-level `categories[]` with `activeCount`.
- **Frontend** — Categories `<details>` rail group above existing facets; URL via `urlSync.ts` 9th field; single primary chip on cards.
- **Admin UI** — Categories Fiori Elements app at `/admin-ui/#categories-display`; per-OP Categories facet on Missions/Groups/Tutorials; bulk-ops bar.

## Spec / plan

- Spec: [docs/superpowers/specs/2026-06-07-categories-facet-design.md](docs/superpowers/specs/2026-06-07-categories-facet-design.md)
- Plan: [docs/superpowers/plans/2026-06-08-201-categories-facet.md](docs/superpowers/plans/2026-06-08-201-categories-facet.md)

## Deploy choreography (manual; per spec decision #12, no feature flag)

1. Schema deploys land empty `Categories` (8 seeded rows) + 3 empty junctions.
2. Srv deploy lands the classifier service.
3. **Manual backfill** — `cds bind --exec -- node scripts/backfill-categories.cjs --kind=all` (~5–10 min for ~1,500 items at concurrency 4).
4. `gh workflow run rebuild-content.yml` to refresh `/browse/` rail `activeCount`s.

Before backfill the Categories rail group renders with all `activeCount=0` (honest zero-state). Rollback path: drop the rail group `<details>` from `filter-rail.html` (one HTML edit).

## Tests

- Unit: classifier (4) + LLM wrapper (4) + seed-embedding cache (4) + after-hooks (8) + admin action (4) + backfill arg parser (6) + urlSync field (5) + filter composable (4) + cards chip (6) + build-catalog (2) — **47 unit tests**.
- Hybrid: 1 test gated by `HYBRID_AI_TESTS=true`.
- Smoke: 2 tests against deployed URLs.

## Followups

Filed in the spec's "Followups" section: master-list CRUD; per-language labels; nested taxonomy; provenance tracking; `/` legacy navigator adoption; live progress streaming; confidence-based UI hint.
EOF
```

- [ ] **Step 4: After PR review, merge via PR (NOT direct push to main)**

Per [feedback_pr_over_direct_merge](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_pr_over_direct_merge.md), wait for Tom's review. Subagent code-review is not a substitute for human PR review.

---

## Closeout checklist

After PR merge:

- [ ] Run `cf login` against DEV target.
- [ ] Trigger MTA deploy: `cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f`.
- [ ] Run backfill: `cds bind --exec -- node scripts/backfill-categories.cjs --kind=all`.
- [ ] Trigger `rebuild-content.yml`.
- [ ] Open `https://<dev-app>/browse/` and confirm Categories rail renders with non-zero `activeCount`s.
- [ ] Click 2–3 categories and confirm grid filters as expected.
- [ ] Open admin UI, edit a Mission's categories, save, confirm change persists.
- [ ] Update memory at `C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/MEMORY.md` with `[201 Categories Facet Shipped](project_201_categories_facet_shipped.md)` once PR merges.

