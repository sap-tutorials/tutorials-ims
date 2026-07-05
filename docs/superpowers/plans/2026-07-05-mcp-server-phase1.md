# MCP Server Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a hosted, anonymous MCP server at `/mcp/*` that exposes SearchService, HomepageService, and KnowledgeGraphService plus eight curated tutorial/mission/news/KG tools, letting AI agents replace the tutorial-content parts of `sap-devs` with no local install.

**Architecture:** Enable CAP 10's `@cap-js/ai` MCP protocol adapter (already installed for #959) by adding `@mcp` to three existing anonymous CAP services, then add eight hand-authored CDS `function`s whose handlers delegate to existing service internals (`content-store.serveHandler`, `SearchableItems` fuzzy search, `neighborhood()`). No new DB tables, no new app, no auth in Phase 1.

**Tech Stack:** CAP Node.js 22, `@cap-js/ai` ^1.0.1, HANA Cloud, existing approuter, Vitest (unit + hybrid + smoke), MTA deploy.

**Spec:** [docs/superpowers/specs/2026-07-05-mcp-server-design.md](../specs/2026-07-05-mcp-server-design.md)

## Global Constraints

- **Phase 1 is anonymous.** Curated-tool handlers MUST NOT read `req.user`. Reject any code review that reads it.
- **Every curated tool declares a `limit`** with an explicit maximum enforced server-side (search: max 100, lists: max 50). Ignore client-supplied values above the max.
- **`@cds.query.limit: 200`** on every entity annotated with `@mcp` (belt-and-braces cap on auto-exposed queries).
- **Reserved URL namespace:** `/mcp-auth/*` — do NOT route or use in Phase 1. Phase 2 lives there.
- **`@cap-js/ai` version pinned** — `~1.0.1` (patch updates only). Do not `npm add` or `npm update` it.
- **Doc-comments are the MCP tool description.** Every curated function MUST have a `/** ... */` block with a one-line summary, then `@param` lines for each argument, then a `@returns` line. If the block is missing or empty the contract test fails and blocks merge.
- **Tool names use lowercase snake_case** (`search_tutorials`, `kg_prerequisites`). CDS accepts this and it matches sap-devs conventions LLMs already know.
- **All new CDS functions live in the existing service `.cds` file**, not a new one. All handlers live in the existing service `.js` file, not a new module.
- **No new hana tables, no schema changes, no new views.** Every query hits existing entities/views.
- **CRLF discipline:** committed files must be LF. Run `git config core.autocrlf false` in the worktree once.
- **Every code-touching task ends with `git commit`.** Never batch commits across tasks.

## File Structure

**Modified files (existing — small, targeted edits):**

- `srv/search-service.cds` — add `@mcp` and `@cds.query.limit: 200`; add 4 curated function declarations (`search_tutorials`, `get_tutorial`, `list_missions`, `get_mission`) with doc-comments.
- `srv/search-service.js` — add 4 handlers for the curated functions.
- `srv/homepage-service.cds` — add `@mcp`; add 2 curated function declarations (`get_recent_news`, `get_recent_videos`).
- `srv/homepage-service.js` — add 2 handlers.
- `srv/knowledge-graph-service.cds` — add `@mcp` and `@cds.query.limit: 200`; add 2 curated function declarations (`kg_prerequisites`, `kg_what_to_learn_next`).
- `srv/knowledge-graph-service.js` — add 2 handlers.
- `package.json` — add `cds.requires.ai.mcp.path` config; pin `@cap-js/ai` to `~1.0.1` (change from `^1.0.1`).
- `approuter/xs-app.json` — add `/mcp/*` route with `authenticationType: none`.
- `.deploy/mta.yaml` — no change expected; sanity-verify approuter route change deploys.

**New files:**

- `test/unit/mcp-search-tools.test.js`
- `test/unit/mcp-homepage-tools.test.js`
- `test/unit/mcp-kg-tools.test.js`
- `test/unit/mcp-contract.test.js` — spins CAP, sends MCP `initialize` + `tools/list`, asserts all 8 curated tools present with descriptions.
- `test/hybrid/mcp-tools.test.js` — real-HANA smokes, one per curated tool.
- `test/smoke/mcp.smoke.test.js` — 2 checks against deployed URL.
- `docs/developers/reference/mcp-server.md` — tool reference (~200 lines).
- `docs/users/mcp-quickstart.md` — Claude Desktop + Claude Code recipes.
- `docs/developers/operations/mcp-server.md` — operator runbook.

## Task Overview

Tasks in dependency order — each ends with an independently testable deliverable and a commit:

1. **Enable `@mcp` on SearchService** — annotation + query limit, verify wire surface exists.
2. **Enable `@mcp` on HomepageService** — annotation, verify.
3. **Enable `@mcp` on KnowledgeGraphService** — annotation + query limit, verify.
4. **Pin `@cap-js/ai` and add MCP config** — package.json changes.
5. **Add `search_tutorials` curated tool** — CDS function + handler + unit test.
6. **Add `list_missions` curated tool** — CDS function + handler + unit test.
7. **Add `get_mission` curated tool** — CDS function + handler + unit test.
8. **Add `get_tutorial` curated tool** — CDS function + handler + unit test (content-store delegation).
9. **Add `get_recent_news` + `get_recent_videos`** — CDS functions + handlers + unit tests.
10. **Add `kg_prerequisites` + `kg_what_to_learn_next`** — CDS functions + handlers + unit tests.
11. **Add MCP protocol contract test** — CI-blocking check on tool enumeration and doc-comments.
12. **Add hybrid smoke tests** — one per curated tool against real HANA.
13. **Add approuter `/mcp/*` route** — anonymous, deploys.
14. **Add deployed-target smoke test** — `initialize` + `search_tutorials` canary.
15. **Author consumer quickstart doc** — Claude Desktop + Claude Code recipes.
16. **Author tool reference doc** — one row per tool with example JSON.
17. **Author operator runbook** — disable-tool, rollback, rate-limit tuning.

Tasks 5-10 can be executed in any order after tasks 1-4. Tasks 11-14 depend on 5-10. Tasks 15-17 (docs) can run in parallel with 11-14.

---

### Task 1: Enable `@mcp` on SearchService

**Files:**
- Modify: `srv/search-service.cds:16-20` (add `@mcp` alongside `@path`, `@requires`, `@graphql`)
- Modify: `srv/search-service.cds:33-56` (add `@cds.query.limit: 200` on `SearchableItems`)
- Modify: `srv/search-service.cds:56-57` (add `@cds.query.limit: 200` on `Tags`)

**Interfaces:**
- Produces: `SearchService` now speaks MCP at `/mcp/SearchService`. Later tasks add curated functions to this service.

- [ ] **Step 1: Read the current SearchService header**

Run: `sed -n '1,60p' srv/search-service.cds`
Expected: Shows service declared as `@path: '/search' @requires: 'any' @graphql service SearchService { ... }`.

- [ ] **Step 2: Write the failing test**

Create `test/unit/mcp-enabled-services.test.js`:

```js
import { expect, describe, it } from 'vitest';
import cds from '@sap/cds';

describe('MCP enablement (Phase 1)', () => {
  it('SearchService is annotated with @mcp', async () => {
    const csn = await cds.load('srv/search-service.cds');
    const svc = csn.definitions['SearchService'];
    expect(svc['@mcp']).toBe(true);
  });

  it('SearchService.SearchableItems has @cds.query.limit', async () => {
    const csn = await cds.load('srv/search-service.cds');
    const ent = csn.definitions['SearchService.SearchableItems'];
    expect(ent['@cds.query.limit']).toBe(200);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-enabled-services.test.js`
Expected: FAIL — both assertions fail (annotation not present).

- [ ] **Step 4: Add `@mcp` and query limits to SearchService**

Edit `srv/search-service.cds`. Change the service header from:

```cds
@path: '/search'
@requires: 'any'
@graphql
service SearchService {
```

to:

```cds
@path: '/search'
@requires: 'any'
@graphql
@mcp
service SearchService {
```

Add `@cds.query.limit: 200` to `SearchableItems`:

```cds
  @readonly
  @cds.search: { title, description, primaryTag, tagBag }
  @cds.query.limit: 200
  entity SearchableItems as projection on ims.SearchableItems {
```

And to `Tags`:

```cds
  @readonly
  @cds.query.limit: 200
  entity Tags as projection on ims.Tags;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-enabled-services.test.js -t "SearchService"`
Expected: PASS on both SearchService assertions.

- [ ] **Step 6: Commit**

```bash
git add srv/search-service.cds test/unit/mcp-enabled-services.test.js
git commit -m "feat(#912): enable @mcp on SearchService with query limits"
```

---

### Task 2: Enable `@mcp` on HomepageService

**Files:**
- Modify: `srv/homepage-service.cds:22-24` (add `@mcp`)
- Modify: `test/unit/mcp-enabled-services.test.js` (add HomepageService assertion)

**Interfaces:**
- Produces: `HomepageService` speaks MCP at `/mcp/HomepageService`.

- [ ] **Step 1: Add the failing test**

Append inside the existing `describe` block in `test/unit/mcp-enabled-services.test.js`:

```js
  it('HomepageService is annotated with @mcp', async () => {
    const csn = await cds.load('srv/homepage-service.cds');
    const svc = csn.definitions['HomepageService'];
    expect(svc['@mcp']).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-enabled-services.test.js -t "HomepageService is annotated"`
Expected: FAIL — `@mcp` annotation missing.

- [ ] **Step 3: Add `@mcp` to HomepageService**

Edit `srv/homepage-service.cds`. Change the service header from:

```cds
@path: '/homepage'
@requires: 'any'
service HomepageService {
```

to:

```cds
@path: '/homepage'
@requires: 'any'
@mcp
service HomepageService {
```

No `@cds.query.limit` is needed on HomepageService — it exposes callable functions (`events`, `videos`, `news`) that return already-bounded arrays, not queryable entities.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-enabled-services.test.js -t "HomepageService"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/homepage-service.cds test/unit/mcp-enabled-services.test.js
git commit -m "feat(#912): enable @mcp on HomepageService"
```

---

### Task 3: Enable `@mcp` on KnowledgeGraphService

**Files:**
- Modify: `srv/knowledge-graph-service.cds:35-37` (add `@mcp`)
- Modify: `srv/knowledge-graph-service.cds:68-73` (add `@cds.query.limit: 200` on `PublishedConcepts`)
- Modify: `test/unit/mcp-enabled-services.test.js` (add KG assertions)

**Interfaces:**
- Produces: `KnowledgeGraphService` speaks MCP at `/mcp/KnowledgeGraphService`.

- [ ] **Step 1: Add the failing tests**

Append inside the existing `describe` block:

```js
  it('KnowledgeGraphService is annotated with @mcp', async () => {
    const csn = await cds.load('srv/knowledge-graph-service.cds');
    const svc = csn.definitions['KnowledgeGraphService'];
    expect(svc['@mcp']).toBe(true);
  });

  it('KnowledgeGraphService.PublishedConcepts has @cds.query.limit', async () => {
    const csn = await cds.load('srv/knowledge-graph-service.cds');
    const ent = csn.definitions['KnowledgeGraphService.PublishedConcepts'];
    expect(ent['@cds.query.limit']).toBe(200);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-enabled-services.test.js -t "KnowledgeGraphService"`
Expected: FAIL on both.

- [ ] **Step 3: Add `@mcp` and query limit**

Edit `srv/knowledge-graph-service.cds`. Change from:

```cds
@requires : 'any'
@graphql
service KnowledgeGraphService @(path : '/graph') {
```

to:

```cds
@requires : 'any'
@graphql
@mcp
service KnowledgeGraphService @(path : '/graph') {
```

Locate the `PublishedConcepts` entity and add `@cds.query.limit: 200`:

```cds
  @readonly
  @cds.query.limit: 200
  entity PublishedConcepts as projection on ims.Concepts {
    ID, slug, name, description, publishedAt, publishedBy, status
  } where publishedAt is not null and status = 'ACTIVE';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-enabled-services.test.js`
Expected: PASS on all four service-level assertions.

- [ ] **Step 5: Commit**

```bash
git add srv/knowledge-graph-service.cds test/unit/mcp-enabled-services.test.js
git commit -m "feat(#912): enable @mcp on KnowledgeGraphService with query limits"
```

---

### Task 4: Pin `@cap-js/ai` and add MCP config

**Files:**
- Modify: `package.json` — pin `@cap-js/ai` to `~1.0.1`; merge `cds.requires.ai.mcp.path`.

**Interfaces:**
- Produces: `/mcp` path prefix is set by config; the adapter mounts under it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp-package-config.test.js`:

```js
import { expect, describe, it } from 'vitest';
import fs from 'node:fs';

describe('MCP package.json configuration', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  it('pins @cap-js/ai to ~1.0 (patch-only updates)', () => {
    expect(pkg.dependencies['@cap-js/ai']).toMatch(/^~1\.0/);
  });

  it('configures MCP protocol path', () => {
    expect(pkg.cds?.requires?.ai?.mcp?.path).toBe('/mcp');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-package-config.test.js`
Expected: FAIL — `^1.0.1` not `~`, `mcp.path` undefined.

- [ ] **Step 3: Update package.json**

Change `"@cap-js/ai": "^1.0.1"` to `"@cap-js/ai": "~1.0.1"` in `dependencies`.

Merge into `cds.requires` (must not replace existing keys — the aicore config from #959 lives under `cds.requires.ai`). Use `jq` for a safe in-place merge:

```bash
jq '.cds.requires.ai = ((.cds.requires.ai // {}) + {mcp: {path: "/mcp"}}) | .dependencies["@cap-js/ai"] = "~1.0.1"' package.json > package.json.tmp && mv package.json.tmp package.json
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-package-config.test.js`
Expected: PASS both assertions.

- [ ] **Step 5: Refresh lockfile**

Run: `npm install --package-lock-only && npm ls @cap-js/ai`
Expected: `@cap-js/ai@1.0.1` resolved.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json test/unit/mcp-package-config.test.js
git commit -m "chore(#912): pin @cap-js/ai to ~1.0.1 and configure MCP path"
```

---

### Task 5: Add `search_tutorials` curated tool

**Files:**
- Modify: `srv/search-service.cds` — add function declaration after the existing `getFacets` function.
- Modify: `srv/search-service.js` — add handler.
- Create: `test/unit/mcp-search-tools.test.js`.

**Interfaces:**
- Produces: `SearchService.search_tutorials(query, tags?, experience?, limit?) => array of { slug, title, snippet, tags }`. Later tasks in this service (get_tutorial, list_missions, get_mission) declare their own signatures.

- [ ] **Step 1: Read current SearchService handler**

Run: `cat srv/search-service.js | head -60`
Expected: See the existing handler pattern — likely `module.exports = cds.service.impl(async function () { this.on('READ', 'SearchableItems', ...); this.on('getFacets', ...); })` or ESM equivalent.

- [ ] **Step 2: Write the failing test**

Create `test/unit/mcp-search-tools.test.js`:

```js
import { expect, describe, it, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('MCP curated tool: search_tutorials', () => {
  let SearchService;
  beforeAll(async () => {
    await cds.deploy('srv').to('sqlite::memory:');
    SearchService = await cds.connect.to('SearchService');
  });

  it('returns bounded result array with slug + title + snippet + tags', async () => {
    const results = await SearchService.send('search_tutorials', { query: 'test', limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(5);
    for (const r of results) {
      expect(r).toHaveProperty('slug');
      expect(r).toHaveProperty('title');
      expect(r).toHaveProperty('snippet');
      expect(Array.isArray(r.tags)).toBe(true);
    }
  });

  it('clamps limit at 100 even when caller passes more', async () => {
    const results = await SearchService.send('search_tutorials', { query: 'a', limit: 999 });
    expect(results.length).toBeLessThanOrEqual(100);
  });

  it('does not read req.user (anonymous tier)', async () => {
    // Call without any auth context — must not throw.
    const results = await SearchService.send('search_tutorials', { query: 'x' });
    expect(Array.isArray(results)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-search-tools.test.js`
Expected: FAIL — `search_tutorials` action not defined.

- [ ] **Step 4: Add CDS function declaration**

Edit `srv/search-service.cds`. Immediately after the closing `);` of the existing `getFacets(...)` function, add:

```cds
  /**
   * Fuzzy full-text search across published tutorials. Returns slug + title +
   * short snippet + tag list. Use this to discover tutorials by topic.
   *
   * @param query      Search terms (natural language accepted; HANA fuzzy
   *                   matching handles typos and stemming).
   * @param tags       Optional exact-match filter on tutorial tags.
   * @param experience Optional experience-level filter: 'beginner',
   *                   'intermediate', 'advanced'.
   * @param limit      Max results (default 10, hard max 100).
   * @returns          Array of tutorial matches ordered by relevance score.
   */
  function search_tutorials(
    query      : String,
    tags       : many String,
    experience : String,
    limit      : Integer
  ) returns array of {
    slug    : String;
    title   : String;
    snippet : String;
    tags    : many String;
  };
```

- [ ] **Step 5: Add handler**

Edit `srv/search-service.js`. Inside the service implementation, add the handler:

```js
  this.on('search_tutorials', async (req) => {
    const { query, tags, experience } = req.data;
    const limit = Math.min(Math.max(req.data.limit ?? 10, 1), 100);

    let cql = SELECT.from('SearchService.SearchableItems')
      .columns('slug', 'title', 'description', 'tags')
      .limit(limit)
      .where({ func: 'contains', args: [{ ref: ['title'] }, { val: query }, { val: 'FUZZY(0.85)' }] });

    if (tags?.length) cql = cql.where({ tags: { in: tags } });
    if (experience)   cql = cql.where({ experience });

    const rows = await cds.run(cql);
    return rows.map(r => ({
      slug:    r.slug,
      title:   r.title,
      snippet: (r.description ?? '').slice(0, 240),
      tags:    Array.isArray(r.tags) ? r.tags : (r.tags ? r.tags.split(',').map(s => s.trim()) : []),
    }));
  });
```

**Note for implementer:** If the existing `SearchableItems` handler already knows how to build a fuzzy CQL statement (check for a helper like `buildFuzzyPredicate` in `srv/search-service.js`), delegate to it instead of duplicating the `{func: 'contains', ...}` block. Do NOT invent new fuzzy logic — the goal is to reuse the same query path the OData `$search` endpoint hits.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-search-tools.test.js`
Expected: PASS all three assertions.

- [ ] **Step 7: Commit**

```bash
git add srv/search-service.cds srv/search-service.js test/unit/mcp-search-tools.test.js
git commit -m "feat(#912): add search_tutorials MCP tool"
```

---

### Task 6: Add `list_missions` curated tool

**Files:**
- Modify: `srv/search-service.cds` — add function declaration after `search_tutorials`.
- Modify: `srv/search-service.js` — add handler.
- Modify: `test/unit/mcp-search-tools.test.js` — add describe block.

**Interfaces:**
- Consumes: `ims.Missions` DB entity + `ims.CompletionPaths` for tutorial counts.
- Produces: `SearchService.list_missions(tags?, limit?) => array of { slug, title, description, tutorialCount }`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/mcp-search-tools.test.js`:

```js
describe('MCP curated tool: list_missions', () => {
  let SearchService;
  beforeAll(async () => {
    await cds.deploy('srv').to('sqlite::memory:');
    SearchService = await cds.connect.to('SearchService');
  });

  it('returns bounded mission list with tutorial counts', async () => {
    const results = await SearchService.send('list_missions', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(5);
    for (const m of results) {
      expect(m).toHaveProperty('slug');
      expect(m).toHaveProperty('title');
      expect(m).toHaveProperty('tutorialCount');
      expect(typeof m.tutorialCount).toBe('number');
    }
  });

  it('clamps limit at 50', async () => {
    const results = await SearchService.send('list_missions', { limit: 999 });
    expect(results.length).toBeLessThanOrEqual(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-search-tools.test.js -t "list_missions"`
Expected: FAIL — action not defined.

- [ ] **Step 3: Add CDS function declaration**

Add after `search_tutorials`:

```cds
  /**
   * List published missions with the number of tutorials in each. Anonymous
   * — the same missions the /missions/ page shows.
   *
   * @param tags  Optional tag filter (returns only missions carrying any of
   *              these tags).
   * @param limit Max results (default 20, hard max 50).
   * @returns     Missions ordered by title.
   */
  function list_missions(
    tags  : many String,
    limit : Integer
  ) returns array of {
    slug          : String;
    title         : String;
    description   : String;
    tutorialCount : Integer;
  };
```

- [ ] **Step 4: Add handler**

In `srv/search-service.js`:

```js
  this.on('list_missions', async (req) => {
    const { tags } = req.data;
    const limit = Math.min(Math.max(req.data.limit ?? 20, 1), 50);
    const { Missions } = cds.entities('com.sap.developers.ims');

    let cql = SELECT.from(Missions)
      .columns('slug', 'title', 'description',
        { xpr: [{ func: 'count', args: [{ ref: ['completionPath', 'items', 'ID'] }] }], as: 'tutorialCount' })
      .where({ published: true })
      .orderBy('title asc')
      .limit(limit);

    if (tags?.length) cql = cql.where({ tags: { in: tags } });

    return await cds.run(cql);
  });
```

**Note for implementer:** If the CQL join above doesn't produce `tutorialCount` cleanly on SQLite (unit test) or HANA (hybrid test), fall back to a two-query approach: fetch missions, then `SELECT mission_ID, count(*) FROM CompletionPathItems GROUP BY mission_ID`. Prefer whichever the existing `AdminService.Missions` list-report handler uses — do NOT invent a new join pattern.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-search-tools.test.js -t "list_missions"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/search-service.cds srv/search-service.js test/unit/mcp-search-tools.test.js
git commit -m "feat(#912): add list_missions MCP tool"
```

---

### Task 7: Add `get_mission` curated tool

**Files:**
- Modify: `srv/search-service.cds` — add function.
- Modify: `srv/search-service.js` — add handler.
- Modify: `test/unit/mcp-search-tools.test.js` — add describe block.

**Interfaces:**
- Consumes: `ims.Missions`, `ims.CompletionPaths`, `ims.CompletionPathItems`, `ims.Tutorials`.
- Produces: `SearchService.get_mission(slug) => { slug, title, description, tutorials: array of { slug, title, order } }` or null if not found.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/mcp-search-tools.test.js`:

```js
describe('MCP curated tool: get_mission', () => {
  let SearchService;
  beforeAll(async () => {
    await cds.deploy('srv').to('sqlite::memory:');
    SearchService = await cds.connect.to('SearchService');
  });

  it('returns null for unknown slug', async () => {
    const result = await SearchService.send('get_mission', { slug: 'does-not-exist' });
    expect(result).toBeNull();
  });

  it('lowercases slug before lookup', async () => {
    // Global memory-fact: tutorial slugs are lowercase canonical.
    // A mixed-case query must still resolve if the underlying row exists.
    const a = await SearchService.send('get_mission', { slug: 'test-mission' });
    const b = await SearchService.send('get_mission', { slug: 'TEST-MISSION' });
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-search-tools.test.js -t "get_mission"`
Expected: FAIL — action not defined.

- [ ] **Step 3: Add CDS function**

```cds
  /**
   * Fetch a mission by slug, with its ordered tutorial list. Returns null if
   * no published mission matches. Slug is case-insensitive.
   *
   * @param slug Mission slug (lowercased server-side).
   * @returns    Mission or null.
   */
  function get_mission(slug : String) returns {
    slug        : String;
    title       : String;
    description : String;
    tutorials   : array of {
      slug  : String;
      title : String;
      order : Integer;
    };
  };
```

- [ ] **Step 4: Add handler**

```js
  this.on('get_mission', async (req) => {
    const slug = (req.data.slug ?? '').toLowerCase();
    if (!slug) return null;

    const { Missions, CompletionPathItems } = cds.entities('com.sap.developers.ims');

    const mission = await SELECT.one.from(Missions)
      .columns('slug', 'title', 'description')
      .where({ slug, published: true });
    if (!mission) return null;

    const items = await SELECT.from(CompletionPathItems)
      .columns('tutorial.slug as slug', 'tutorial.title as title', 'sortOrder as order')
      .where({ 'completionPath.mission.slug': slug })
      .orderBy('sortOrder asc');

    return { ...mission, tutorials: items };
  });
```

**Note for implementer:** The exact composition path (`CompletionPaths` → `CompletionPathItems` → `Tutorials`) may differ. Grep for `list_missions`-adjacent code and `AdminService.Missions` list-report to see how the schema is walked today. Do NOT invent field names — verify against `db/schema.cds` first.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-search-tools.test.js -t "get_mission"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/search-service.cds srv/search-service.js test/unit/mcp-search-tools.test.js
git commit -m "feat(#912): add get_mission MCP tool"
```

---

### Task 8: Add `get_tutorial` curated tool

**Files:**
- Modify: `srv/search-service.cds` — add function.
- Modify: `srv/search-service.js` — add handler that delegates to `content-store.js`.
- Modify: `test/unit/mcp-search-tools.test.js` — add describe block.

**Interfaces:**
- Consumes: `srv/lib/content-store.js` — its `renderTutorialHTML(slug, step)` or equivalent internal function (grep to find the actual export).
- Produces: `SearchService.get_tutorial(slug, step?) => { slug, title, tags, steps: array of { number, title }, html?: String }`. When `step` is omitted, `html` is absent — the caller must ask for a specific step.

- [ ] **Step 1: Verify the delegation target exists**

Run: `grep -n "export\|module.exports\|function render\|function serve" srv/lib/content-store.js | head -20`
Expected: See exports. `serveHandler` and helpers like `renderTutorialHTML(slug, step)` or `getTutorialMetadata(slug)` are the candidates. If no helper exists, the handler must be shaped to reuse whatever internal function `serveHandler` calls.

- [ ] **Step 2: Write the failing test**

Append to `test/unit/mcp-search-tools.test.js`:

```js
describe('MCP curated tool: get_tutorial', () => {
  let SearchService;
  beforeAll(async () => {
    await cds.deploy('srv').to('sqlite::memory:');
    SearchService = await cds.connect.to('SearchService');
  });

  it('returns null for unknown slug', async () => {
    const result = await SearchService.send('get_tutorial', { slug: 'does-not-exist' });
    expect(result).toBeNull();
  });

  it('omits html when step is not provided', async () => {
    const result = await SearchService.send('get_tutorial', { slug: 'test-tutorial' });
    if (result) {
      expect(result.html).toBeUndefined();
      expect(Array.isArray(result.steps)).toBe(true);
    }
  });

  it('includes html when a specific step is requested', async () => {
    const result = await SearchService.send('get_tutorial', { slug: 'test-tutorial', step: 1 });
    if (result) expect(typeof result.html).toBe('string');
  });

  it('lowercases slug before lookup', async () => {
    const a = await SearchService.send('get_tutorial', { slug: 'test-tutorial' });
    const b = await SearchService.send('get_tutorial', { slug: 'TEST-TUTORIAL' });
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-search-tools.test.js -t "get_tutorial"`
Expected: FAIL — action not defined.

- [ ] **Step 4: Add CDS function**

```cds
  /**
   * Fetch tutorial metadata, step list, and optionally the rendered HTML for
   * one step. Anonymous — same content path /content/tutorials/:slug serves.
   *
   * @param slug  Tutorial slug (case-insensitive).
   * @param step  Optional 1-indexed step number. When omitted, `html` is not
   *              included and the caller must request a specific step to get
   *              the body (keeps responses bounded).
   * @returns     Tutorial or null.
   */
  function get_tutorial(slug : String, step : Integer) returns {
    slug  : String;
    title : String;
    tags  : many String;
    steps : array of { number : Integer; title : String; };
    html  : String;
  };
```

- [ ] **Step 5: Add handler**

Add to `srv/search-service.js`:

```js
  this.on('get_tutorial', async (req) => {
    const slug = (req.data.slug ?? '').toLowerCase();
    if (!slug) return null;

    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const meta = await SELECT.one.from(Tutorials)
      .columns('slug', 'title', 'tags')
      .where({ slug, published: true });
    if (!meta) return null;

    // Delegate to content-store for step list + optional HTML render.
    const { getStepList, renderStepHTML } = await import('./lib/content-store.js');
    const steps = await getStepList(slug);

    const result = {
      slug:  meta.slug,
      title: meta.title,
      tags:  Array.isArray(meta.tags) ? meta.tags : (meta.tags ? meta.tags.split(',').map(s => s.trim()) : []),
      steps,
    };
    if (req.data.step != null) {
      result.html = await renderStepHTML(slug, req.data.step);
    }
    return result;
  });
```

**Note for implementer:** `getStepList` and `renderStepHTML` are aspirational names — `srv/lib/content-store.js` may not export functions with these exact signatures today. Grep first (`grep -n "export" srv/lib/content-store.js`) and either (a) call whatever the file currently exports that returns the step list / rendered HTML, or (b) if only `serveHandler` exists, extract a shared helper from it and export it, then call from both the Express handler and this MCP tool. **Do not duplicate the BLOB-fetch logic** — the memory-fact "Never SELECT a HANA BLOB alongside metadata in a single CDS QL query" applies here too, so this MUST use whatever raw-`db.run()` helper `content-store.js` already has.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-search-tools.test.js -t "get_tutorial"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add srv/search-service.cds srv/search-service.js srv/lib/content-store.js test/unit/mcp-search-tools.test.js
git commit -m "feat(#912): add get_tutorial MCP tool (delegates to content-store)"
```

---

### Task 9: Add `get_recent_news` and `get_recent_videos` curated tools

**Files:**
- Modify: `srv/homepage-service.cds` — add 2 curated functions.
- Modify: `srv/homepage-service.js` — add 2 handlers delegating to the existing `news()` and `videos()` handlers.
- Create: `test/unit/mcp-homepage-tools.test.js`.

**Interfaces:**
- Consumes: existing `HomepageService.news()` returning `array of RssItem` and `HomepageService.videos()` returning `VideoPayload { featured, recent, error }`.
- Produces: `HomepageService.get_recent_news(limit?) => array of { title, link, publishedAt, description }` and `get_recent_videos(limit?) => array of { videoId, title, thumbnail, publishedAt }`.

- [ ] **Step 1: Read existing HomepageService handlers**

Run: `grep -n "on\(\|action\|function" srv/homepage-service.js | head -30`
Expected: See `this.on('news', ...)`, `this.on('videos', ...)` handlers.

- [ ] **Step 2: Write the failing tests**

Create `test/unit/mcp-homepage-tools.test.js`:

```js
import { expect, describe, it, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('MCP curated tools: HomepageService', () => {
  let HomepageService;
  beforeAll(async () => {
    await cds.deploy('srv').to('sqlite::memory:');
    HomepageService = await cds.connect.to('HomepageService');
  });

  describe('get_recent_news', () => {
    it('returns bounded news array', async () => {
      const results = await HomepageService.send('get_recent_news', { limit: 5 });
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeLessThanOrEqual(5);
      for (const n of results) {
        expect(n).toHaveProperty('title');
        expect(n).toHaveProperty('link');
        expect(n).toHaveProperty('publishedAt');
      }
    });

    it('clamps limit at 50', async () => {
      const results = await HomepageService.send('get_recent_news', { limit: 999 });
      expect(results.length).toBeLessThanOrEqual(50);
    });
  });

  describe('get_recent_videos', () => {
    it('returns flattened featured+recent list', async () => {
      const results = await HomepageService.send('get_recent_videos', { limit: 10 });
      expect(Array.isArray(results)).toBe(true);
      for (const v of results) {
        expect(v).toHaveProperty('videoId');
        expect(v).toHaveProperty('title');
        expect(v).toHaveProperty('thumbnail');
      }
    });

    it('clamps limit at 50', async () => {
      const results = await HomepageService.send('get_recent_videos', { limit: 999 });
      expect(results.length).toBeLessThanOrEqual(50);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/mcp-homepage-tools.test.js`
Expected: FAIL — actions not defined.

- [ ] **Step 4: Add CDS function declarations**

Add to `srv/homepage-service.cds` after the existing `news()` and `videos()` declarations:

```cds
  /**
   * Recent SAP developer news items — the same feed the homepage news band
   * shows. Bounded by `limit`; use this to answer "what's new in SAP?".
   *
   * @param limit Max items (default 10, hard max 50).
   * @returns     Recent RSS items ordered by publish date desc.
   */
  function get_recent_news(limit : Integer) returns array of RssItem;

  /**
   * Recent SAP developer videos from the homepage videos band, featured
   * items first then chronological.
   *
   * @param limit Max items (default 10, hard max 50).
   * @returns     Recent video items flattened from featured+recent.
   */
  function get_recent_videos(limit : Integer) returns array of VideoItem;
```

- [ ] **Step 5: Add handlers**

Add to `srv/homepage-service.js`:

```js
  this.on('get_recent_news', async (req) => {
    const limit = Math.min(Math.max(req.data.limit ?? 10, 1), 50);
    const items = await this.send('news');            // reuse existing handler
    return (items ?? []).slice(0, limit);
  });

  this.on('get_recent_videos', async (req) => {
    const limit = Math.min(Math.max(req.data.limit ?? 10, 1), 50);
    const payload = await this.send('videos');        // reuse existing handler
    const flat = [];
    if (payload?.featured) flat.push(payload.featured);
    if (Array.isArray(payload?.recent)) flat.push(...payload.recent);
    return flat.slice(0, limit);
  });
```

**Note for implementer:** `this.send('news')` re-enters the service's own `news()` handler. If the existing handler assumes `req.user` or some context the MCP call doesn't provide, either (a) extract a pure helper both handlers call, or (b) build the same feed directly. Read `srv/homepage-service.js` first — do NOT guess. Also: `news()` may return a cached value via `alerts-cache.js` or a similar helper — reuse that cache path, do not bypass it.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/unit/mcp-homepage-tools.test.js`
Expected: PASS all four tests.

- [ ] **Step 7: Commit**

```bash
git add srv/homepage-service.cds srv/homepage-service.js test/unit/mcp-homepage-tools.test.js
git commit -m "feat(#912): add get_recent_news + get_recent_videos MCP tools"
```

---

### Task 10: Add `kg_prerequisites` and `kg_what_to_learn_next` curated tools

**Files:**
- Modify: `srv/knowledge-graph-service.cds` — add 2 curated functions.
- Modify: `srv/knowledge-graph-service.js` — add 2 handlers slicing the `neighborhood()` result.
- Create: `test/unit/mcp-kg-tools.test.js`.

**Interfaces:**
- Consumes: existing `KnowledgeGraphService.neighborhood(slug) => NeighborhoodResult` which contains arms `teaches`, `prerequisitesOf`, `sharedConcepts`, `whatToLearnNext` (see `srv/knowledge-graph-service.js` — the `rankNeighborhood` export).
- Produces: `KnowledgeGraphService.kg_prerequisites(tutorial_slug, depth?) => array of TutorialRef` and `kg_what_to_learn_next(tutorial_slug, limit?) => array of TutorialRef`.

- [ ] **Step 1: Verify neighborhood shape**

Run: `grep -n "type NeighborhoodResult\|prerequisitesOf\|whatToLearnNext" srv/knowledge-graph-service.cds`
Expected: See the type definition and the arm names.

- [ ] **Step 2: Write the failing tests**

Create `test/unit/mcp-kg-tools.test.js`:

```js
import { expect, describe, it, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('MCP curated tools: KnowledgeGraphService', () => {
  let KG;
  beforeAll(async () => {
    await cds.deploy('srv').to('sqlite::memory:');
    KG = await cds.connect.to('KnowledgeGraphService');
  });

  describe('kg_prerequisites', () => {
    it('returns array of tutorial refs', async () => {
      const results = await KG.send('kg_prerequisites', { tutorial_slug: 'test-tutorial' });
      expect(Array.isArray(results)).toBe(true);
      for (const r of results) {
        expect(r).toHaveProperty('slug');
        expect(r).toHaveProperty('title');
        expect(r).toHaveProperty('reason');
      }
    });

    it('respects depth clamping', async () => {
      const results = await KG.send('kg_prerequisites', { tutorial_slug: 'x', depth: 999 });
      expect(results.length).toBeLessThanOrEqual(50);
    });

    it('returns empty array for unknown slug (does not throw)', async () => {
      const results = await KG.send('kg_prerequisites', { tutorial_slug: 'does-not-exist' });
      expect(results).toEqual([]);
    });
  });

  describe('kg_what_to_learn_next', () => {
    it('returns array of tutorial refs', async () => {
      const results = await KG.send('kg_what_to_learn_next', { tutorial_slug: 'test-tutorial', limit: 5 });
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('clamps limit at 50', async () => {
      const results = await KG.send('kg_what_to_learn_next', { tutorial_slug: 'x', limit: 999 });
      expect(results.length).toBeLessThanOrEqual(50);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/mcp-kg-tools.test.js`
Expected: FAIL — actions not defined.

- [ ] **Step 4: Add CDS function declarations**

Add to `srv/knowledge-graph-service.cds`, immediately after the existing `neighborhood(slug)` function declaration and before the admin actions section:

```cds
  /**
   * Tutorials that teach concepts this tutorial depends on. Answers "what
   * should I learn first?". Backed by the same graph the sidebar uses.
   *
   * @param tutorial_slug Tutorial slug (lowercase).
   * @param depth         Max returned entries (default 10, hard max 50).
   * @returns             Prerequisite tutorials ordered by strength.
   */
  function kg_prerequisites(
    tutorial_slug : String,
    depth         : Integer
  ) returns array of TutorialRef;

  /**
   * Tutorials that build on what this one teaches. Answers "what should I
   * learn next?". PageRank-blended (#916) when enabled.
   *
   * @param tutorial_slug Tutorial slug (lowercase).
   * @param limit         Max returned entries (default 10, hard max 50).
   * @returns             Next-step tutorials ordered by strength.
   */
  function kg_what_to_learn_next(
    tutorial_slug : String,
    limit         : Integer
  ) returns array of TutorialRef;
```

- [ ] **Step 5: Add handlers**

Add to `srv/knowledge-graph-service.js`, inside the service impl:

```js
  this.on('kg_prerequisites', async (req) => {
    const slug = (req.data.tutorial_slug ?? '').toLowerCase();
    const depth = Math.min(Math.max(req.data.depth ?? 10, 1), 50);
    if (!slug) return [];
    try {
      const nb = await this.send('neighborhood', { slug });
      const arm = nb?.prerequisitesOf ?? [];
      return arm.slice(0, depth);
    } catch (e) {
      req.error({ code: 'KG_LOOKUP_FAILED', message: e.message });
      return [];
    }
  });

  this.on('kg_what_to_learn_next', async (req) => {
    const slug = (req.data.tutorial_slug ?? '').toLowerCase();
    const limit = Math.min(Math.max(req.data.limit ?? 10, 1), 50);
    if (!slug) return [];
    try {
      const nb = await this.send('neighborhood', { slug });
      const arm = nb?.whatToLearnNext ?? [];
      return arm.slice(0, limit);
    } catch (e) {
      req.error({ code: 'KG_LOOKUP_FAILED', message: e.message });
      return [];
    }
  });
```

**Note for implementer:** Both handlers slice arms from the existing `neighborhood()` result — do NOT re-implement SPARQL/PageRank logic. If `neighborhood` returns null for unknown slugs (it may throw or return an empty result — check the JS), handle both. The memory-fact "silent swallow hides dead code — no bare `catch { return null }`" applies: the `req.error(...)` call above logs before returning empty; keep that pattern.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/unit/mcp-kg-tools.test.js`
Expected: PASS all five tests.

- [ ] **Step 7: Commit**

```bash
git add srv/knowledge-graph-service.cds srv/knowledge-graph-service.js test/unit/mcp-kg-tools.test.js
git commit -m "feat(#912): add kg_prerequisites + kg_what_to_learn_next MCP tools"
```

---

### Task 11: Add MCP protocol contract test

**Files:**
- Create: `test/unit/mcp-contract.test.js`.

**Interfaces:**
- Consumes: all 8 curated tools shipped in tasks 5-10.
- Produces: CI-blocking guard that all curated tools are enumerated on `tools/list` with non-empty descriptions and valid JSON-schema `input_schema`.

- [ ] **Step 1: Confirm how the MCP adapter mounts**

Run: `grep -rn "@mcp\|cap-js/ai\|mcp" node_modules/@cap-js/ai/lib 2>&1 | head -20`
Expected: Find the adapter's mount function. Note the mount path pattern (likely `/mcp/<ServiceName>`) so the test hits the right URL.

- [ ] **Step 2: Write the failing test**

Create `test/unit/mcp-contract.test.js`:

```js
import { expect, describe, it, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const CURATED_TOOLS = {
  SearchService: ['search_tutorials', 'list_missions', 'get_mission', 'get_tutorial'],
  HomepageService: ['get_recent_news', 'get_recent_videos'],
  KnowledgeGraphService: ['kg_prerequisites', 'kg_what_to_learn_next'],
};

describe('MCP protocol contract', () => {
  let server;
  beforeAll(async () => {
    server = await cds.server({ port: 0 });   // ephemeral port
  });
  afterAll(async () => {
    await server?.close();
  });

  for (const [service, tools] of Object.entries(CURATED_TOOLS)) {
    describe(`${service}`, () => {
      let toolList;

      beforeAll(async () => {
        const url = `http://localhost:${server.address().port}/mcp/${service}`;
        const initRes = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-06', capabilities: {}, clientInfo: { name: 'contract-test', version: '1' } },
          }),
        });
        expect(initRes.status).toBe(200);

        const listRes = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        });
        const body = await listRes.json();
        toolList = body.result?.tools ?? [];
      });

      for (const toolName of tools) {
        it(`exposes ${toolName} with description and input_schema`, () => {
          const tool = toolList.find(t => t.name === toolName);
          expect(tool, `${toolName} not enumerated`).toBeDefined();
          expect(tool.description, `${toolName} description empty`).toBeTruthy();
          expect(tool.description.length).toBeGreaterThan(20);
          expect(tool.inputSchema).toBeDefined();
          expect(tool.inputSchema.type).toBe('object');
        });
      }
    });
  }
});
```

- [ ] **Step 3: Run test to verify current shape**

Run: `npx vitest run test/unit/mcp-contract.test.js`
Expected: If all previous tasks passed, this should PASS. If ANY tool is missing its `/** */` doc-comment, this FAILS — surface that gap immediately.

- [ ] **Step 4: Fix any missing doc-comments**

If failures appear, revisit the corresponding earlier task's CDS file and add the missing `/** */` block. Re-run this test until green.

- [ ] **Step 5: Commit**

```bash
git add test/unit/mcp-contract.test.js
git commit -m "test(#912): MCP protocol contract test for tool enumeration"
```

---

### Task 12: Add hybrid smoke tests

**Files:**
- Create: `test/hybrid/mcp-tools.test.js`.

**Interfaces:**
- Consumes: real HANA via `cds bind --exec`; the 8 curated tools.
- Produces: one HANA-backed happy-path per curated tool. Ensures the CDS → HANA path (fuzzy search, BLOB reads, graph procedures) works.

- [ ] **Step 1: Read an existing hybrid test to match conventions**

Run: `head -40 test/hybrid/alerts.test.js`
Expected: See the hybrid rig — likely `import { hybridSetup } from './_guard.js'` or similar. Match this pattern.

- [ ] **Step 2: Write the test**

Create `test/hybrid/mcp-tools.test.js`:

```js
import { expect, describe, it, beforeAll } from 'vitest';
import cds from '@sap/cds';
// Add whatever hybrid guard/setup the sibling tests import — copy from test/hybrid/alerts.test.js.

describe('MCP tools against real HANA', { timeout: 30_000 }, () => {
  let SearchService, HomepageService, KG;

  beforeAll(async () => {
    SearchService   = await cds.connect.to('SearchService');
    HomepageService = await cds.connect.to('HomepageService');
    KG              = await cds.connect.to('KnowledgeGraphService');
  });

  it('search_tutorials returns HANA rows for a common query', async () => {
    const results = await SearchService.send('search_tutorials', { query: 'CAP', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('list_missions returns published missions', async () => {
    const results = await SearchService.send('list_missions', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('get_mission resolves a known slug', async () => {
    // Use whatever mission slug the seed data / hybrid DB is guaranteed to contain.
    // Grep test/hybrid/*.test.js for an already-used slug or set one via env.
    const slug = process.env.MCP_SMOKE_MISSION_SLUG ?? 'introducing-cap';
    const result = await SearchService.send('get_mission', { slug });
    if (result) expect(result.slug).toBe(slug);
  });

  it('get_tutorial returns metadata without html when step is omitted', async () => {
    const slug = process.env.MCP_SMOKE_TUTORIAL_SLUG ?? 'introducing-cap';
    const result = await SearchService.send('get_tutorial', { slug });
    if (result) {
      expect(result.html).toBeUndefined();
      expect(Array.isArray(result.steps)).toBe(true);
    }
  });

  it('get_tutorial returns html when a step is requested', async () => {
    const slug = process.env.MCP_SMOKE_TUTORIAL_SLUG ?? 'introducing-cap';
    const result = await SearchService.send('get_tutorial', { slug, step: 1 });
    if (result) expect(typeof result.html).toBe('string');
  });

  it('get_recent_news returns items from live feed', async () => {
    const results = await HomepageService.send('get_recent_news', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it('get_recent_videos returns items from live feed', async () => {
    const results = await HomepageService.send('get_recent_videos', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  });

  it('kg_prerequisites returns for a known tutorial slug', async () => {
    const slug = process.env.MCP_SMOKE_TUTORIAL_SLUG ?? 'introducing-cap';
    const results = await KG.send('kg_prerequisites', { tutorial_slug: slug });
    expect(Array.isArray(results)).toBe(true);
  });

  it('kg_what_to_learn_next returns for a known tutorial slug', async () => {
    const slug = process.env.MCP_SMOKE_TUTORIAL_SLUG ?? 'introducing-cap';
    const results = await KG.send('kg_what_to_learn_next', { tutorial_slug: slug });
    expect(Array.isArray(results)).toBe(true);
  });
});
```

**Note for implementer:** The `--project hybrid` flag is required to actually hit HANA. Bare `vitest <file>` silently skips hybrid setup — global memory-fact. Always run with `--project hybrid`.

- [ ] **Step 3: Run against real HANA**

Run: `npm run test:hybrid -- test/hybrid/mcp-tools.test.js`
Expected: All 9 tests pass.

- [ ] **Step 4: Commit**

```bash
git add test/hybrid/mcp-tools.test.js
git commit -m "test(#912): hybrid smoke tests for MCP curated tools"
```

---

### Task 13: Add approuter `/mcp/*` route

**Files:**
- Modify: `approuter/xs-app.json` — add anonymous `/mcp/*` route.
- Optional: `approuter/xs-app.qa.json` if the QA channel has its own route file.

**Interfaces:**
- Consumes: MCP endpoints at `tutorials-srv:/mcp/*`.
- Produces: Public URL `https://<approuter>/mcp/*` is reachable without XSUAA auth.

- [ ] **Step 1: Read current xs-app.json**

Run: `cat approuter/xs-app.json | jq .routes | head -80`
Expected: Existing routes array. Note the shape of the `/homepage/(.*)$` route (anonymous, matches memory-fact reference in `homepage-service.cds` header comment).

- [ ] **Step 2: Write a failing test**

Create `test/unit/approuter-mcp-route.test.js`:

```js
import { expect, describe, it } from 'vitest';
import fs from 'node:fs';

describe('approuter /mcp/* route', () => {
  const xsapp = JSON.parse(fs.readFileSync('approuter/xs-app.json', 'utf8'));

  it('has a route that matches /mcp/*', () => {
    const route = xsapp.routes.find(r => r.source?.includes('/mcp/'));
    expect(route, 'no /mcp/* route found').toBeDefined();
  });

  it('is anonymous (authenticationType: none)', () => {
    const route = xsapp.routes.find(r => r.source?.includes('/mcp/'));
    expect(route.authenticationType).toBe('none');
  });

  it('does NOT match /mcp-auth/* (Phase 2 namespace stays clean)', () => {
    const route = xsapp.routes.find(r => r.source?.includes('/mcp/'));
    // The Phase-1 route regex must exclude the reserved /mcp-auth namespace.
    // Simplest guard: the source doesn't contain 'mcp-auth' and matches /mcp/ literally.
    expect(route.source).not.toMatch(/mcp-auth/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/approuter-mcp-route.test.js`
Expected: FAIL — route not defined.

- [ ] **Step 4: Add the route**

Edit `approuter/xs-app.json`. Add this entry to the `routes` array, **before** any catch-all route (order matters — approuter matches first-wins):

```json
{
  "source": "^/mcp/(.*)$",
  "target": "/mcp/$1",
  "destination": "srv-api",
  "authenticationType": "none",
  "csrfProtection": false
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/approuter-mcp-route.test.js`
Expected: PASS all three assertions.

- [ ] **Step 6: Check if QA channel needs the same route**

Run: `ls approuter/*.json`
Expected: See if there's an `xs-app.qa.json`. If yes, add the same route. If no, skip.

- [ ] **Step 7: Commit**

```bash
git add approuter/xs-app.json test/unit/approuter-mcp-route.test.js
git commit -m "feat(#912): add anonymous /mcp/* approuter route"
```

---

### Task 14: Add deployed-target smoke test

**Files:**
- Create: `test/smoke/mcp.smoke.test.js`.

**Interfaces:**
- Consumes: `SMOKE_BASE_URL` (approuter URL of deployed target).
- Produces: two live checks — `initialize` returns 200; `search_tutorials` returns a non-empty result.

- [ ] **Step 1: Read existing smoke test conventions**

Run: `head -30 test/smoke/browse.smoke.test.js`
Expected: See how `SMOKE_BASE_URL` is consumed; whether Vitest is auto-skipping when the env var is unset. Match this pattern.

- [ ] **Step 2: Write the smoke test**

Create `test/smoke/mcp.smoke.test.js`:

```js
import { expect, describe, it } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;
const runIf = BASE ? describe : describe.skip;

runIf('MCP smoke — deployed target', { timeout: 20_000 }, () => {
  it('initialize on /mcp/SearchService returns 200', async () => {
    const res = await fetch(`${BASE}/mcp/SearchService`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
      }),
    });
    expect(res.status).toBe(200);
  });

  it('search_tutorials returns non-empty for a canary query', async () => {
    const res = await fetch(`${BASE}/mcp/SearchService`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'search_tutorials', arguments: { query: 'CAP', limit: 3 } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const content = body.result?.content ?? body.result;
    const items = Array.isArray(content) ? content : content?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
  });
});
```

**Note for implementer:** The exact shape of `tools/call` responses (`result.content` array vs. direct return) is adapter-defined. If the assertion fails on a good response, adjust the parsing to match `@cap-js/ai`'s actual output. Do NOT change the assertion to always pass — either fix the parsing or file a separate issue documenting the response shape.

- [ ] **Step 3: Run against local `cds watch` to smoke-check the test**

Run in one terminal: `cds watch`
Then: `SMOKE_BASE_URL=http://localhost:4004 npm run test:smoke -- test/smoke/mcp.smoke.test.js`
Expected: PASS both assertions locally.

- [ ] **Step 4: Commit**

```bash
git add test/smoke/mcp.smoke.test.js
git commit -m "test(#912): deployed-target smoke tests for MCP endpoint"
```

---

### Task 15: Author consumer quickstart doc

**Files:**
- Create: `docs/users/mcp-quickstart.md`.

**Interfaces:**
- Consumes: nothing — this is content, not code.
- Produces: copy-pasteable recipes for Claude Desktop and Claude Code that reach `/mcp/SearchService`, `/mcp/HomepageService`, `/mcp/KnowledgeGraphService`.

- [ ] **Step 1: Write the doc**

Create `docs/users/mcp-quickstart.md`:

````markdown
# MCP Quickstart

Connect an AI agent to the SAP Developers hosted MCP server — no local install.

## What you get

Nine free tools per service (schema `describe`, entity `query`, action `call_action`) plus eight opinionated tools:

- `search_tutorials` — fuzzy full-text search across SAP tutorials
- `get_tutorial` — fetch metadata + one step's HTML
- `list_missions` / `get_mission` — mission browse
- `get_recent_news` / `get_recent_videos` — homepage feeds
- `kg_prerequisites` / `kg_what_to_learn_next` — knowledge-graph recommendations

All read-only, all anonymous. No sign-in in Phase 1.

## Base URLs

- **Production:** `https://developers.sap.com/mcp/`
- **Dev:** `https://developers-dev.<region>.hana.ondemand.com/mcp/` (internal)

Each service is mounted under its own path segment: `/mcp/SearchService`, `/mcp/HomepageService`, `/mcp/KnowledgeGraphService`.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "sap-tutorials": {
      "url": "https://developers.sap.com/mcp/SearchService"
    },
    "sap-homepage": {
      "url": "https://developers.sap.com/mcp/HomepageService"
    },
    "sap-graph": {
      "url": "https://developers.sap.com/mcp/KnowledgeGraphService"
    }
  }
}
```

Restart Claude Desktop. Ask: *"Use sap-tutorials to search for CAP handler tutorials."*

## Claude Code

Add to your project's `.mcp.json` (or global config):

```json
{
  "mcpServers": {
    "sap-tutorials": {
      "type": "http",
      "url": "https://developers.sap.com/mcp/SearchService"
    }
  }
}
```

Then in Claude Code: `/mcp` to verify connection, tools appear as `mcp__sap-tutorials__*`.

## Older stdio-only clients

If your MCP client only speaks stdio (e.g. some agentic frameworks pre-2025), bridge with `mcp-remote`:

```bash
npm install -g mcp-remote
```

Config:

```json
{
  "mcpServers": {
    "sap-tutorials": {
      "command": "mcp-remote",
      "args": ["https://developers.sap.com/mcp/SearchService"]
    }
  }
}
```

## Troubleshooting

- **`initialize` returns 401:** you hit `/mcp-auth/*` (Phase 2, not yet available). Use `/mcp/*`.
- **`tools/list` empty:** the adapter did not register — check the URL includes a service name segment.
- **Slow first response:** cold start on the deployed instance; second call is fast.

## Replacing `sap-devs` for tutorial content

If you use the `sap-devs` CLI today, the hosted MCP covers the tutorial/mission/news/video parts. `sap-devs` remains useful for BTP/CF inspection and offline reading.

## What's next (not yet available)

- **Phase 2** — authenticated tools (progress, recommendations). Sign in via OAuth.
- **Phase 3** — KG deep-dive tools (`kg_shared_concepts`, `kg_neighborhood`).
````

- [ ] **Step 2: Commit**

```bash
git add docs/users/mcp-quickstart.md
git commit -m "docs(#912): MCP consumer quickstart with Claude Desktop + Code recipes"
```

---

### Task 16: Author tool reference doc

**Files:**
- Create: `docs/developers/reference/mcp-server.md`.

**Interfaces:**
- Consumes: the 8 curated tool signatures from tasks 5-10.
- Produces: canonical hand-authored reference table with one row per tool.

- [ ] **Step 1: Write the doc**

Create `docs/developers/reference/mcp-server.md`:

````markdown
# MCP Server Tool Reference

Canonical reference for the hosted MCP server. Auto-exposed schema tools (`describe`, `query`, `call_action`) are omitted — see the CAP `@cap-js/ai` docs for their shape. This page covers the eight hand-authored curated tools.

**Base URL pattern:** `<host>/mcp/<ServiceName>`

Where `<ServiceName>` is one of `SearchService`, `HomepageService`, `KnowledgeGraphService`.

Every tool is called via MCP `tools/call`:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "<tool>", "arguments": { ... } } }
```

## SearchService tools

### `search_tutorials`

Fuzzy full-text search across published tutorials.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes | Search terms; HANA fuzzy matching applies. |
| `tags` | string[] | no | Filter to tutorials carrying any of these tags. |
| `experience` | string | no | `beginner` \| `intermediate` \| `advanced`. |
| `limit` | integer | no | Default 10, hard max 100. |

Returns: `Array<{ slug, title, snippet, tags: string[] }>` ordered by relevance.

Example:

```json
{ "name": "search_tutorials",
  "arguments": { "query": "CAP handlers", "limit": 3 } }
```

### `get_tutorial`

Fetch tutorial metadata, step list, and optionally the rendered HTML for one step.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `slug` | string | yes | Lowercased server-side. |
| `step` | integer | no | 1-indexed step number. When omitted, `html` is not returned. |

Returns: `{ slug, title, tags: string[], steps: Array<{ number, title }>, html?: string }` or `null`.

### `list_missions`

Ordered mission list with tutorial counts.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `tags` | string[] | no | Tag filter. |
| `limit` | integer | no | Default 20, hard max 50. |

Returns: `Array<{ slug, title, description, tutorialCount }>`.

### `get_mission`

Fetch a mission with its ordered tutorial list.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `slug` | string | yes | Case-insensitive. |

Returns: `{ slug, title, description, tutorials: Array<{ slug, title, order }> }` or `null`.

## HomepageService tools

### `get_recent_news`

Recent SAP developer news items.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `limit` | integer | no | Default 10, hard max 50. |

Returns: `Array<{ title, link, publishedAt, description }>`.

### `get_recent_videos`

Recent SAP developer videos (featured + recent, flattened).

| Arg | Type | Required | Notes |
|---|---|---|---|
| `limit` | integer | no | Default 10, hard max 50. |

Returns: `Array<{ videoId, title, thumbnail, publishedAt }>`.

## KnowledgeGraphService tools

### `kg_prerequisites`

Tutorials that teach concepts a given tutorial depends on.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `tutorial_slug` | string | yes | Case-insensitive. |
| `depth` | integer | no | Default 10, hard max 50. |

Returns: `Array<{ slug, title, weight, reason }>`.

### `kg_what_to_learn_next`

Tutorials that build on what a given tutorial teaches. PageRank-blended (issue #916).

| Arg | Type | Required | Notes |
|---|---|---|---|
| `tutorial_slug` | string | yes | Case-insensitive. |
| `limit` | integer | no | Default 10, hard max 50. |

Returns: `Array<{ slug, title, weight, reason }>`.

## Error shape

All errors follow MCP JSON-RPC error convention:

```json
{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": -32000, "message": "human-readable message" } }
```

CAP-level errors (missing args, out-of-range values) are reported by the adapter before reaching handlers. Business errors from handlers surface with `code` and `message` matching the underlying `req.error(...)` call.
````

- [ ] **Step 2: Commit**

```bash
git add docs/developers/reference/mcp-server.md
git commit -m "docs(#912): canonical MCP tool reference"
```

---

### Task 17: Author operator runbook

**Files:**
- Create: `docs/developers/operations/mcp-server.md`.

**Interfaces:**
- Consumes: nothing — operator content.
- Produces: runbook covering disable-a-tool, disable-a-service, rollback, rate-limit tuning, metrics.

- [ ] **Step 1: Write the runbook**

Create `docs/developers/operations/mcp-server.md`:

````markdown
# MCP Server Operations

Runbook for operators. For consumer docs see [mcp-quickstart](../../users/mcp-quickstart.md); for tool reference see [mcp-server](../reference/mcp-server.md).

## Deploy

The MCP surface is part of `tutorials-srv`; the standard MTA deploy ships it:

```bash
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

## Disable one curated tool

Comment out the CDS function declaration in the owning service's `.cds` file and redeploy. MCP clients treat missing tools as unavailable, not errors — safe operation.

Example — disable `kg_what_to_learn_next`:

```cds
  // /**
  //  * Tutorials that build on what this one teaches. ...
  //  */
  // function kg_what_to_learn_next(...) returns array of TutorialRef;
```

Also comment out the corresponding `this.on(...)` handler in the `.js` file (leaving it registered without a CDS declaration is a no-op but noisy in logs).

## Disable one whole service's MCP surface

Remove the `@mcp` annotation from the service in its `.cds` file:

```cds
@path: '/search'
@requires: 'any'
@graphql
// @mcp                <-- comment out
service SearchService {
```

Redeploy. The service continues to serve OData; only `/mcp/SearchService` disappears.

## Full MCP shutdown (ultima ratio)

Remove `@cap-js/ai` from `dependencies` in `package.json`, run `npm install`, redeploy. `@cap-js/ai` also drives the Fiori ValueList recommendations from issue #959 — expect those to stop working too. Prefer disabling `@mcp` per service instead unless the plugin itself is the fault.

## Rollback

Regular MTA rollback rolls back the MCP surface along with everything else:

```bash
cf rollback tutorials-srv
```

No independent state to worry about — no DB migration, no persisted config.

## Metrics

Prometheus counters exposed via `srv/lib/metrics.js`:

- `mcp_tool_invocation_total{service, tool, outcome}` — one per curated tool call.
- `mcp_tool_duration_ms{service, tool}` — histogram.

Existing `srv-error-rate` alert covers MCP errors — no new alert wiring needed.

## Rate limiting

Approuter's `/mcp/*` route inherits the anonymous-IP throttle from `/homepage/*` and `/tutorials/*`. To tune independently, add per-route limits in `approuter/xs-app.json`. Only do this if the shared throttle proves too tight or too lax for real MCP traffic — measure first.

## Common failures

**"tools/list returns empty"** — `@cap-js/ai` didn't register the protocol. Check `cds env get requires.ai` outputs the `mcp.path` config, and that at least one service carries `@mcp`.

**"initialize returns 401"** — request hit `/mcp-auth/*` (Phase 2 namespace, not routed in Phase 1) or an authenticated service like DeveloperService. Use `/mcp/SearchService`, `/mcp/HomepageService`, `/mcp/KnowledgeGraphService`.

**"CDS: query.limit exceeded"** — a client asked for more rows than the entity's `@cds.query.limit`. This is the belt-and-braces cap working as intended. Curated tools slice their own results and shouldn't hit this.

## Phase 2 preparation

Phase 2 will add `/mcp-auth/*` for authenticated tools. Do not squat on that namespace in Phase 1.
````

- [ ] **Step 2: Commit**

```bash
git add docs/developers/operations/mcp-server.md
git commit -m "docs(#912): MCP operator runbook"
```

---

## Self-Review

**Spec coverage check:**

- ✅ **Architecture** — Tasks 1-3 (`@mcp` enablement), Task 4 (config), Task 13 (approuter route).
- ✅ **Auto-exposed tool surface (9 tools)** — Covered by tasks 1-3.
- ✅ **Hand-authored curated tools (8)** — Tasks 5-10.
- ✅ **Transport (Streamable HTTP)** — no code needed; `@cap-js/ai` handles.
- ✅ **Anonymous auth (`authenticationType: none`)** — Task 13.
- ✅ **Reserved `/mcp-auth/*` namespace** — asserted in Task 13's test.
- ✅ **Doc-comment as description enforcement** — Task 11.
- ✅ **`limit` clamping in every curated tool** — asserted in every unit test (tasks 5-10).
- ✅ **`req.user` not read in Phase 1** — asserted in Task 5's test; called out in global constraints.
- ✅ **Unit / contract / hybrid / smoke test layers** — Tasks 5-10 unit; Task 11 contract; Task 12 hybrid; Task 14 smoke.
- ✅ **Consumer doc / reference doc / operator runbook** — Tasks 15/16/17.
- ✅ **`@cap-js/ai` already installed** — Task 4 pins only, no `npm add`.

**Placeholder scan:** no TBD / TODO / "implement later"; every code block is concrete. The two spots that hedge — `srv/lib/content-store.js` helper names (task 8) and hybrid smoke slug (task 12) — are called out with grep-first instructions and env-var fallbacks, not silent placeholders.

**Type consistency:** `TutorialRef` used in tasks 5-10 matches the existing CDS type in `srv/knowledge-graph-service.cds` (`{ slug, title, weight, reason }`) — verified during spec-correction pass. `RssItem` and `VideoItem` types used in Task 9 match the existing type declarations in `srv/homepage-service.cds`. Function names are consistent across tasks (no `search_tutorials` → `searchTutorials` drift).

**Task independence:** Tasks 5-10 are independent of each other after Tasks 1-4 land. Tasks 11-14 depend on 5-10. Docs (15-17) parallelizable throughout.
