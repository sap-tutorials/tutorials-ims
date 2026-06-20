# Phase 2-A Foundation + Knowledge Graph Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the 4 Knowledge Graph env vars to a `KnowledgeGraphSettings` HANA singleton with a self-contained resolver lib + custom-XML admin tile, establishing the template Phase 2-B/C/3 follow-ups will replicate.

**Architecture:** New singleton entity in `db/schema.cds` mirrors `ChatSettings`. Self-contained resolver `srv/lib/runtime-config/kg-settings.js` layers DB → env → hardcoded with 5s LRU TTL. Three consumer files (`srv/knowledge-graph-service.js`, `srv/jobs/extract-concepts-job.js`, `srv/jobs/consolidate-concepts-job.js`) swap `process.env.X` reads for resolver calls; cron consumers add `if (!kg.enabled) return` (intentional behavior tightening). Admin tile at `app/admin/knowledgeGraph/` mirrors Joule (custom XML, not Fiori Elements).

**Tech Stack:** SAP CAP Node.js, HANA Cloud, `lru-cache` (already a dep), Vitest (unit + hybrid), UI5 (custom XML, sap.m), `@cap-js/change-tracking`.

**Spec:** [docs/superpowers/specs/2026-06-20-issue-463-runtime-config-foundation-design.md](../specs/2026-06-20-issue-463-runtime-config-foundation-design.md)

**Branch:** `worktree-issue-463-runtime-config-foundation` (already checked out in worktree).

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `db/schema.cds` | Modify (append after `ChatSettings` block at line 487) | Define `KnowledgeGraphSettings` singleton entity |
| `db/data/com.sap.developers.ims-KnowledgeGraphSettings.csv` | Create | HEADER ONLY — empty seed (must stay empty per [feedback_cap_csv_seeds_clobber_admin_data]) |
| `db/change-tracking.cds` | Modify (append after `ChatSettings` line 17) | Add `@changelog` annotation |
| `srv/admin-service.cds` | Modify (append after `ChatSettings` projection at line 89) | Add `@odata.singleton @requires:'Admin'` projection |
| `srv/lib/runtime-config/kg-settings.js` | Create | Self-contained resolver (~110 lines, 5s LRU TTL, layered fallback) |
| `srv/knowledge-graph-service.js` | Modify (line 439, line 698) | Swap `process.env.X` reads for resolver |
| `srv/jobs/extract-concepts-job.js` | Modify (lines 121-138) | Swap reads + add `if (!kg.enabled) return` |
| `srv/jobs/consolidate-concepts-job.js` | Modify (lines 57-69) | Swap reads + add `if (!kg.enabled) return` |
| `app/admin/knowledgeGraph/webapp/manifest.json` | Create | UI5 component manifest, sap.m only |
| `app/admin/knowledgeGraph/webapp/Component.js` | Create | UI5 component shell |
| `app/admin/knowledgeGraph/webapp/index.html` | Create | UI5 boot HTML |
| `app/admin/knowledgeGraph/webapp/view/Settings.view.xml` | Create | 4-field form (Switch + 3 Inputs) |
| `app/admin/knowledgeGraph/webapp/controller/Settings.controller.js` | Create | Load/Save with CSRF round-trip + `credentials: 'include'` |
| `app/admin/knowledgeGraph/webapp/i18n/i18n.properties` | Create | Tile-local labels |
| `app/admin-shell/scripts/copy-components.js` | Modify (append `'knowledgeGraph'` to COMPONENTS array at line 8-25) | Wire tile into admin-shell `dist/components/` at build |
| `app/admin-shell/webapp/manifest.json` | Modify (3 locations: componentUsages line 53, targets line 152, routes line 202) | Wire tile into admin-shell router |
| `app/admin-shell/webapp/view/Shell.view.xml` | Modify (append `<tnt:NavigationListItem>` to System group around line 106) | Add side-nav label |
| `.deploy/mta.yaml` | Modify (line 97) | Add `mkdir -p srv/lib/runtime-config` + separate `cp` line for srv-qa |
| `test/unit/runtime-config/kg-settings.test.js` | Create | 6 unit tests (in-memory SQLite) |
| `test/hybrid/runtime-config.test.js` | Create | 2 hybrid round-trip tests (real HANA) |

**Deliberately NOT modified:**

- `deploy/dev.mtaext`, `deploy/qa.mtaext`, `deploy/prod.mtaext` — env vars stay in mtaext for backwards-compat through Phase 3 + soak window.
- `srv/jobs/scheduler.js` — cron jobs gate themselves now; scheduler is unaware of the flag.

---

## Pre-flight checklist

- [ ] **Step 0.1: Confirm working in the worktree, not the parent repo**

  Run:

  ```bash
  pwd
  git branch --show-current
  ```

  Expected: working directory ends in `.claude/worktrees/issue-463-runtime-config-foundation`, branch is `worktree-issue-463-runtime-config-foundation`.

  If wrong: STOP. Re-enter the worktree before any edits ([feedback_subagent_writes_can_leak_to_parent_repo](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_subagent_writes_can_leak_to_parent_repo.md)).

- [ ] **Step 0.2: Verify spec is committed at HEAD**

  Run:

  ```bash
  git log --oneline -3
  ```

  Expected: `fb222236 docs(spec): final consistency fix...` is the most recent commit. Spec must be committed before plan execution starts so subagents can read it.

- [ ] **Step 0.3: Verify lru-cache is in deps**

  Run:

  ```bash
  grep '"lru-cache"' package.json
  ```

  Expected: a line like `"lru-cache": "^11.x.x"` (or similar) in dependencies. Already there per `srv/lib/content-store.js` usage; this is just a sanity check.

- [ ] **Step 0.4: Confirm the existing chat-settings-resolver pattern is at HEAD**

  Run:

  ```bash
  test -f srv/lib/chat-settings-resolver.js && echo OK
  test -f test/unit/chat-settings-resolver.test.js && echo OK
  ```

  Expected: two `OK` lines. The plan references this resolver and its test file as the canonical templates throughout.

---

## Task 1: Define `KnowledgeGraphSettings` schema entity

**Files:**

- Modify: `db/schema.cds:485-487` (append after `ChatSettings` block — verify location with grep first)

- [ ] **Step 1.1: Locate the exact ChatSettings end line**

  Run:

  ```bash
  grep -n 'entity ChatSettings\|^}' db/schema.cds | head -20
  ```

  Identify the line where the ChatSettings block ends (closing `}` after `bannerText`/RAG/codeCheck fields). The new entity will be inserted after that line, before the next `entity` declaration.

- [ ] **Step 1.2: Append the KnowledgeGraphSettings entity**

  Append to `db/schema.cds` immediately after the closing `}` of the `ChatSettings` entity:

  ```cds
  // Phase 2-A foundation (#463). Mirrors the ChatSettings singleton pattern.
  // Resolver at srv/lib/runtime-config/kg-settings.js layers DB > env > default.
  // CSV seed at db/data/...-KnowledgeGraphSettings.csv MUST stay empty so HDI
  // redeploy doesn't clobber operator-set values (see feedback_cap_csv_seeds_clobber_admin_data).
  //
  // All 4 columns are nullable on purpose. Null means "fall through to env"
  // in the resolver. With a fresh deploy + no row + KNOWLEDGE_GRAPH_ENABLED=true
  // in mtaext, behavior is identical to today. After an admin saves the row,
  // DB values win.
  entity KnowledgeGraphSettings : cuid, managed {
    enabled                    : Boolean;
    extractBuildCap            : Integer       @assert.range: [0, 100000];
    mergeSimThreshold          : Decimal(3, 2) @assert.range: [0.01, 1.00];
    mergeSimThresholdExtract   : Decimal(3, 2) @assert.range: [0.01, 1.00];
  }
  ```

  **DO NOT** add `default false` / `default 200` / etc. — null is meaningful (it means "fall through to env"). Defaults would silently turn KG off in any env that has `KNOWLEDGE_GRAPH_ENABLED=true` today.

- [ ] **Step 1.3: Verify schema compiles**

  Run:

  ```bash
  npx cds compile db/schema.cds > /dev/null && echo OK
  ```

  Expected: `OK` printed, no compile errors.

  If it fails with an `@assert.range` error, the project's CDS version may not support that annotation in this position — try moving the annotation onto its own line: `extractBuildCap : Integer; @assert.range : [0, 100000];` — but try the inline form first.

- [ ] **Step 1.4: Commit**

  ```bash
  git add db/schema.cds
  git commit -m "feat(db): add KnowledgeGraphSettings singleton entity (#463)

  Mirrors the ChatSettings pattern. All columns nullable so the resolver
  can fall through to env vars on first deploy (no behavior change until
  an admin explicitly saves a row).

  @assert.range guards entity-layer; HANA enforces at write time and
  Fiori surfaces validation hints in the admin tile."
  ```

---

## Task 2: Create empty CSV seed

**Files:**

- Create: `db/data/com.sap.developers.ims-KnowledgeGraphSettings.csv`

- [ ] **Step 2.1: Verify the existing data/ pattern**

  Run:

  ```bash
  ls db/data/ | head -5
  cat db/data/com.sap.developers.ims-Categories.csv | head -3
  ```

  Confirm filename pattern: `com.sap.developers.ims-<EntityName>.csv`. Confirm CSVs use `;` separator AND have a header row.

- [ ] **Step 2.2: Create empty CSV (header only)**

  Write to `db/data/com.sap.developers.ims-KnowledgeGraphSettings.csv`:

  ```csv
  ID
  ```

  That's it. One line. **MUST** stay empty per [feedback_cap_csv_seeds_clobber_admin_data] — a non-empty CSV would re-import on every HDI deploy as UPSERT and clobber operator-set values.

- [ ] **Step 2.3: Commit**

  ```bash
  git add db/data/com.sap.developers.ims-KnowledgeGraphSettings.csv
  git commit -m "feat(db): empty CSV seed for KnowledgeGraphSettings (#463)

  Header-only by design. HDI re-imports CSVs as UPSERT on every deploy;
  a non-empty seed would clobber operator-set values. Resolver falls
  through to env vars when the table is empty."
  ```

---

## Task 3: Add change-tracking annotation

**Files:**

- Modify: `db/change-tracking.cds:17-22` (append `KnowledgeGraphSettings` annotation after the `ChatSettings` line)

- [ ] **Step 3.1: Add the annotation**

  Open `db/change-tracking.cds`. Find line 17 (`annotate ims.ChatSettings with @changelog;`). Add the new annotation immediately after it:

  ```cds
  annotate ims.KnowledgeGraphSettings with @changelog;
  ```

  This is plain change-tracking (write-only annotation; `@cap-js/change-tracking` handles the rest). Mutations appear in the `ChangeLog` entity, surfaced via `/admin-ui/#changelog-display`.

  **DO NOT** add `@PersonalData` annotations — KG settings carry no personal data, and `@cap-js/audit-logging` is a different plugin with different semantics.

- [ ] **Step 3.2: Verify the annotation compiles in context**

  Run:

  ```bash
  npx cds compile srv/admin-service.cds > /dev/null && echo OK
  ```

  Expected: `OK`. (admin-service.cds includes change-tracking.cds transitively via `using` — compiling it is the easiest end-to-end check.)

- [ ] **Step 3.3: Commit**

  ```bash
  git add db/change-tracking.cds
  git commit -m "feat(db): change-tracking on KnowledgeGraphSettings (#463)

  Mirrors ChatSettings precedent at line 17. Writes appear in the
  ChangeLog entity, viewable at /admin-ui/#changelog-display."
  ```

---

## Task 4: Add AdminService projection

**Files:**

- Modify: `srv/admin-service.cds:84-89` (append after the `ChatSettings` projection block)

- [ ] **Step 4.1: Verify the ChatSettings projection location**

  Run:

  ```bash
  grep -n 'ChatSettings as projection' srv/admin-service.cds
  ```

  Expected: a hit at line 84. The new projection goes immediately after the closing `};` of the `ChatSettings` actions block (around line 89).

- [ ] **Step 4.2: Add the projection**

  Append after the `ChatSettings` projection block (the line ending in `};` for the `actions { … };` block) in `srv/admin-service.cds`:

  ```cds
  @odata.singleton
  @requires: 'Admin'
  entity KnowledgeGraphSettings as projection on ims.KnowledgeGraphSettings;
  ```

  No actions needed (unlike ChatSettings's `seedEmbeddings`).

- [ ] **Step 4.3: Verify admin-service compiles**

  Run:

  ```bash
  npx cds compile srv/admin-service.cds > /dev/null && echo OK
  ```

  Expected: `OK`.

- [ ] **Step 4.4: Commit**

  ```bash
  git add srv/admin-service.cds
  git commit -m "feat(srv): KnowledgeGraphSettings AdminService projection (#463)

  @odata.singleton serves /admin/KnowledgeGraphSettings without a key
  suffix. @requires:'Admin' enforces XSUAA scope."
  ```

---

## Task 5: Create resolver lib

**Files:**

- Create: `srv/lib/runtime-config/kg-settings.js`

- [ ] **Step 5.1: Create the directory**

  Run:

  ```bash
  mkdir -p srv/lib/runtime-config
  ```

- [ ] **Step 5.2: Write the resolver**

  Write to `srv/lib/runtime-config/kg-settings.js`:

  ```javascript
  // srv/lib/runtime-config/kg-settings.js
  // Resolves the 4 Knowledge Graph runtime knobs. Layered precedence:
  //   1. KnowledgeGraphSettings row (CDS-via-cds.entities)
  //   2. KnowledgeGraphSettings raw-SQL UPPERCASE (HANA build-pipeline path)
  //   3. process.env.KNOWLEDGE_GRAPH_ENABLED / KG_EXTRACT_BUILD_CAP /
  //      KG_MERGE_SIM_THRESHOLD / KG_MERGE_SIM_THRESHOLD_EXTRACT
  //   4. Hardcoded defaults: enabled=false, cap=200, thresholds 0.92/0.85
  //
  // 5-second LRU TTL. Hot-path consumers (knowledge-graph-service.js per-request
  // gate) hit cache; cron consumers (extract/consolidate jobs) call once per tick.
  //
  // Backwards-compatible: with an empty DB row, behavior is identical to the
  // current process.env reads in the 3 consumer files. Reverting this PR is safe.
  //
  // Pattern derived from srv/lib/chat-settings-resolver.js (#318). Self-contained
  // per Phase 2-A spec — base helper extraction deferred to Phase 3.

  import cds from '@sap/cds';
  import { LRUCache } from 'lru-cache';

  const LOG = cds.log('kg-settings-resolver');

  const CACHE_KEY = 'kg-settings';
  const cache = new LRUCache({ max: 1, ttl: 5_000 });

  const DEFAULTS = {
    enabled: false,
    extractBuildCap: 200,
    mergeSimThreshold: 0.92,
    mergeSimThresholdExtract: 0.85,
  };

  /** Read the singleton row, tolerant of build-pipeline contexts where
   *  cds.entities() isn't initialized yet. Returns null on any failure. */
  async function readRow() {
    try {
      if (typeof cds.entities === 'function') {
        const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
        return (await SELECT.one.from(KnowledgeGraphSettings)) ?? null;
      }
      const db = await cds.connect.to('db');
      const rows = await db.run(
        'SELECT enabled, extractBuildCap, mergeSimThreshold, mergeSimThresholdExtract ' +
        'FROM COM_SAP_DEVELOPERS_IMS_KNOWLEDGEGRAPHSETTINGS LIMIT 1'
      );
      return rows?.[0] ?? null;
    } catch (err) {
      LOG.warn('KnowledgeGraphSettings read failed; using env-var defaults', err.message);
      return null;
    }
  }

  /** HANA returns UPPERCASE column names from raw db.run; CAP returns lowercase. */
  function pick(row, lower, upper) {
    if (row == null) return null;
    const v = row[lower];
    if (v !== undefined && v !== null) return v;
    const u = row[upper];
    return u !== undefined && u !== null ? u : null;
  }

  function envFlag(name) {
    const v = process.env[name];
    if (v === undefined) return null;
    return v === 'true';
  }

  function envNumber(name) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Resolve all 4 knobs at once. Returns a fully-populated object (no nulls).
   * @returns {Promise<{ enabled: boolean, extractBuildCap: number,
   *                     mergeSimThreshold: number, mergeSimThresholdExtract: number }>}
   */
  export async function resolveKnowledgeGraphSettings() {
    const cached = cache.get(CACHE_KEY);
    if (cached) return cached;

    const row = await readRow();

    const settings = {
      enabled:
        pick(row, 'enabled', 'ENABLED')
        ?? envFlag('KNOWLEDGE_GRAPH_ENABLED')
        ?? DEFAULTS.enabled,
      extractBuildCap:
        pick(row, 'extractBuildCap', 'EXTRACTBUILDCAP')
        ?? envNumber('KG_EXTRACT_BUILD_CAP')
        ?? DEFAULTS.extractBuildCap,
      mergeSimThreshold:
        pick(row, 'mergeSimThreshold', 'MERGESIMTHRESHOLD')
        ?? envNumber('KG_MERGE_SIM_THRESHOLD')
        ?? DEFAULTS.mergeSimThreshold,
      mergeSimThresholdExtract:
        pick(row, 'mergeSimThresholdExtract', 'MERGESIMTHRESHOLDEXTRACT')
        ?? envNumber('KG_MERGE_SIM_THRESHOLD_EXTRACT')
        ?? DEFAULTS.mergeSimThresholdExtract,
    };

    cache.set(CACHE_KEY, settings);
    return settings;
  }

  /** Test-only: clear the cache so a unit test can assert TTL behavior or
   *  exercise a fresh read after seeding a row. Not exported through any
   *  public surface. */
  export function _resetCacheForTests() {
    cache.clear();
  }
  ```

- [ ] **Step 5.3: Verify the file is syntactically valid**

  Run:

  ```bash
  node --check srv/lib/runtime-config/kg-settings.js && echo OK
  ```

  Expected: `OK`.

- [ ] **Step 5.4: Commit**

  ```bash
  git add srv/lib/runtime-config/kg-settings.js
  git commit -m "feat(srv): KnowledgeGraphSettings resolver lib (#463)

  Self-contained resolver mirroring chat-settings-resolver shape.
  Layered precedence: DB row → env var → hardcoded default.
  5s LRU TTL via lru-cache (already a dep).

  - Nullish-coalesce (??) preserves admin-set false/0 vs OR (||).
  - pick() helper centralizes lowercase/UPPERCASE column-name handling
    (CAP returns lowercase; HANA raw db.run returns UPPERCASE).
  - readRow() tolerates build-pipeline contexts where cds.entities()
    isn't initialized; falls through to raw SQL.
  - _resetCacheForTests exported for unit-test TTL assertions."
  ```

---

## Task 6: Unit tests for resolver

**Files:**

- Create: `test/unit/runtime-config/kg-settings.test.js`

- [ ] **Step 6.1: Read the chat-settings-resolver test as template**

  ```bash
  cat test/unit/chat-settings-resolver.test.js | head -40
  ```

  Note the `cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:')` bootstrap and the per-test `DELETE.from(...)` cleanup. The new test mirrors this exactly.

- [ ] **Step 6.2: Create the test directory**

  ```bash
  mkdir -p test/unit/runtime-config
  ```

- [ ] **Step 6.3: Write the failing tests**

  Write to `test/unit/runtime-config/kg-settings.test.js`:

  ```javascript
  // test/unit/runtime-config/kg-settings.test.js
  // Unit tests for srv/lib/runtime-config/kg-settings.js (#463).
  //
  // Same shape as test/unit/chat-settings-resolver.test.js: cds.deploy() the
  // schema to sqlite::memory once, then DELETE+INSERT per test. Resolver
  // cache is reset at the top of each test via _resetCacheForTests().

  import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
  import path from 'node:path';
  import cds from '@sap/cds';
  import {
    resolveKnowledgeGraphSettings,
    _resetCacheForTests,
  } from '../../../srv/lib/runtime-config/kg-settings.js';

  beforeAll(async () => {
    await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
  });

  beforeEach(async () => {
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(KnowledgeGraphSettings);
    delete process.env.KNOWLEDGE_GRAPH_ENABLED;
    delete process.env.KG_EXTRACT_BUILD_CAP;
    delete process.env.KG_MERGE_SIM_THRESHOLD;
    delete process.env.KG_MERGE_SIM_THRESHOLD_EXTRACT;
    _resetCacheForTests();
  });

  describe('resolveKnowledgeGraphSettings (#463)', () => {
    it('returns hardcoded defaults when DB empty and env unset', async () => {
      const s = await resolveKnowledgeGraphSettings();
      expect(s).toEqual({
        enabled: false,
        extractBuildCap: 200,
        mergeSimThreshold: 0.92,
        mergeSimThresholdExtract: 0.85,
      });
    });

    it('falls through to env vars when DB row absent', async () => {
      process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';
      process.env.KG_EXTRACT_BUILD_CAP = '500';
      const s = await resolveKnowledgeGraphSettings();
      expect(s.enabled).toBe(true);
      expect(s.extractBuildCap).toBe(500);
      expect(s.mergeSimThreshold).toBe(0.92); // hardcoded default still
    });

    it('DB row wins over env var (admin override of env)', async () => {
      process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';
      const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
      await INSERT.into(KnowledgeGraphSettings).entries({
        ID: '20000000-0000-0000-0000-000000000001',
        enabled: false, // admin override
        extractBuildCap: 50,
      });
      _resetCacheForTests();
      const s = await resolveKnowledgeGraphSettings();
      expect(s.enabled).toBe(false); // admin false beats env true
      expect(s.extractBuildCap).toBe(50);
    });

    it('null DB column falls through to env var', async () => {
      process.env.KG_MERGE_SIM_THRESHOLD = '0.75';
      const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
      await INSERT.into(KnowledgeGraphSettings).entries({
        ID: '20000000-0000-0000-0000-000000000002',
        enabled: true,
        mergeSimThreshold: null, // explicitly null
      });
      _resetCacheForTests();
      const s = await resolveKnowledgeGraphSettings();
      expect(Number(s.mergeSimThreshold)).toBe(0.75);
    });

    it('caches reads within 5s TTL — second read hits cache', async () => {
      const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
      await INSERT.into(KnowledgeGraphSettings).entries({
        ID: '20000000-0000-0000-0000-000000000003',
        extractBuildCap: 100,
      });
      _resetCacheForTests();

      const first = await resolveKnowledgeGraphSettings();
      expect(first.extractBuildCap).toBe(100);

      // Mutate the row WITHOUT resetting cache.
      await UPDATE(KnowledgeGraphSettings).with({ extractBuildCap: 999 });

      const second = await resolveKnowledgeGraphSettings();
      expect(second.extractBuildCap).toBe(100); // still cached
    });

    it('cache reset returns fresh row (simulating TTL expiry)', async () => {
      const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
      await INSERT.into(KnowledgeGraphSettings).entries({
        ID: '20000000-0000-0000-0000-000000000004',
        extractBuildCap: 100,
      });
      _resetCacheForTests();
      const first = await resolveKnowledgeGraphSettings();
      expect(first.extractBuildCap).toBe(100);

      await UPDATE(KnowledgeGraphSettings).with({ extractBuildCap: 999 });
      _resetCacheForTests(); // simulate TTL expiry
      const fresh = await resolveKnowledgeGraphSettings();
      expect(fresh.extractBuildCap).toBe(999);
    });
  });
  ```

- [ ] **Step 6.4: Run tests to confirm they pass**

  Run:

  ```bash
  npx vitest run test/unit/runtime-config/kg-settings.test.js
  ```

  Expected: 6 tests PASS. (The implementation in Task 5 already exists, so these are NOT pre-implementation failing tests — they're behavior verification on an existing module.)

  If any fails: stop and debug. Most likely cause is a path issue with `cds.deploy()` or a missed env-var cleanup in `beforeEach`. Refer to `test/unit/chat-settings-resolver.test.js` for the working pattern.

- [ ] **Step 6.5: Commit**

  ```bash
  git add test/unit/runtime-config/kg-settings.test.js
  git commit -m "test(unit): kg-settings resolver coverage (#463)

  6 tests covering: hardcoded defaults, env fallback, DB row wins,
  null column → env, TTL cache hit, TTL cache reset.

  Mirrors test/unit/chat-settings-resolver.test.js bootstrap pattern
  (cds.deploy to sqlite::memory once + DELETE per test)."
  ```

---

## Task 7: Convert `srv/knowledge-graph-service.js` consumer

**Files:**

- Modify: `srv/knowledge-graph-service.js:439` (HTTP gate)
- Modify: `srv/knowledge-graph-service.js:698-704` (threshold read)

- [ ] **Step 7.1: Add the resolver import**

  Find the existing imports at the top of `srv/knowledge-graph-service.js` (around line 1-20). Add:

  ```javascript
  import { resolveKnowledgeGraphSettings } from './lib/runtime-config/kg-settings.js';
  ```

  next to the other imports. Match the existing import style (named import, no `.js` extension if other imports omit it; the project uses ESM with explicit `.js`).

- [ ] **Step 7.2: Replace the HTTP gate at line 439**

  Find the block:

  ```javascript
    this.before('*', (req) => {
      if (process.env.KNOWLEDGE_GRAPH_ENABLED !== 'true') {
        req.reject(503, 'Knowledge graph is currently disabled');
      }
    });
  ```

  Replace with:

  ```javascript
    this.before('*', async (req) => {
      const kg = await resolveKnowledgeGraphSettings();
      if (!kg.enabled) {
        req.reject(503, 'Knowledge graph is currently disabled');
      }
    });
  ```

  Note the `async` keyword — the resolver is async.

- [ ] **Step 7.3: Replace the threshold read at line 698**

  Find the block:

  ```javascript
      const thresholdRaw = process.env.KG_MERGE_SIM_THRESHOLD;
      const thresholdParsed = thresholdRaw !== undefined ? Number(thresholdRaw) : NaN;
      const threshold =
        Number.isFinite(thresholdParsed) && thresholdParsed >= 0 && thresholdParsed <= 1
          ? thresholdParsed
          : 0.92;

      const pairs = findNearDuplicates(concepts, threshold);
  ```

  Replace with:

  ```javascript
      const { mergeSimThreshold: threshold } = await resolveKnowledgeGraphSettings();
      const pairs = findNearDuplicates(concepts, threshold);
  ```

  The bounds check is removed because:
  - `@assert.range` enforces `[0.01, 1.00]` at write time.
  - The resolver returns `Number` already (no parse needed).

  Confirm the enclosing handler is `async` (it almost certainly is — it does `await db.run(...)` already). If by some accident it's not, mark it `async`.

- [ ] **Step 7.4: Run unit tests for knowledge-graph-service if any exist**

  Run:

  ```bash
  ls test/unit/ | grep -i 'knowledge.*graph\|kg.service'
  ```

  If a test file exists, run it:

  ```bash
  npx vitest run test/unit/<file>.test.js
  ```

  Expected: pass. If no test file exists, skip — the consumer's behavior is exercised end-to-end via the resolver tests.

- [ ] **Step 7.5: Commit**

  ```bash
  git add srv/knowledge-graph-service.js
  git commit -m "refactor(kg): use resolver for HTTP gate and threshold (#463)

  Two consumers in this file:
  - this.before('*') HTTP gate at line 439
  - threshold read in the dedup-preview handler at line 698

  Both now read from resolveKnowledgeGraphSettings(). The bounds-check
  on threshold is moved to the schema's @assert.range; resolver
  returns Number directly."
  ```

---

## Task 8: Convert `srv/jobs/extract-concepts-job.js` consumer

**Files:**

- Modify: `srv/jobs/extract-concepts-job.js:115-138`

- [ ] **Step 8.1: Add the resolver import**

  At the top of `srv/jobs/extract-concepts-job.js`, add to existing imports:

  ```javascript
  import { resolveKnowledgeGraphSettings } from '../lib/runtime-config/kg-settings.js';
  ```

- [ ] **Step 8.2: Replace the env-var reads at lines 121-138**

  Find the block (lines 121-136):

  ```javascript
    // KG_EXTRACT_BUILD_CAP=0 means "make zero LLM calls" (effectively dry-run).
    // Negative or NaN falls back to the default 200. Don't use `|| 200` — that
    // would silently swallow the explicit-zero case.
    const capRaw = process.env.KG_EXTRACT_BUILD_CAP;
    const capParsed = capRaw !== undefined ? Number(capRaw) : NaN;
    const buildCap = Number.isFinite(capParsed) && capParsed >= 0 ? capParsed : 200;

    // Merge-on-extract threshold: cosine similarity above this collapses a
    // newly-proposed concept into an existing one rather than minting.
    // Override via KG_MERGE_SIM_THRESHOLD_EXTRACT (must be in (0, 1]).
    const thresholdRaw = Number(process.env.KG_MERGE_SIM_THRESHOLD_EXTRACT);
    const MERGE_THRESHOLD =
      Number.isFinite(thresholdRaw) && thresholdRaw > 0 && thresholdRaw <= 1
        ? thresholdRaw
        : MERGE_AT_EXTRACT_THRESHOLD;
  ```

  Replace with:

  ```javascript
    // Phase 2-A (#463): resolver layers DB > env > default. Gate the entire
    // tick on kg.enabled — previously this job ran regardless of the env
    // flag. The flag now means "stop new extraction work" end-to-end.
    const kg = await resolveKnowledgeGraphSettings();
    if (!kg.enabled) {
      log.info('extract-concepts: KnowledgeGraphSettings.enabled=false; skipping tick');
      return { reason: 'kg-disabled', conceptsExtracted: 0 };
    }
    const { extractBuildCap: buildCap, mergeSimThresholdExtract: MERGE_THRESHOLD } = kg;
  ```

  **Two intentional behavior changes**:
  - The cron job now early-returns when KG is disabled (per the spec's "Behavior changes" callout).
  - The early-return surfaces a structured summary so the job-log table doesn't show a partial/empty run as an error.

- [ ] **Step 8.3: Verify the early-return shape matches what the scheduler expects**

  Check what other early-returns (if any) in this file return:

  ```bash
  grep -n 'return {' srv/jobs/extract-concepts-job.js | head -10
  ```

  Confirm the `{ reason, conceptsExtracted }` shape is consistent with other early-returns. If the file uses a different convention (e.g. throwing, returning `null`), match that instead.

  If the file's normal happy-path return shape includes additional fields (like `conceptsCreated`, `conceptsMerged`, `conceptsSkipped`), include zero values for those in the early-return so any downstream consumer (formatJobSummary etc.) doesn't NPE on missing keys:

  ```javascript
      return { reason: 'kg-disabled', conceptsExtracted: 0, conceptsCreated: 0, conceptsMerged: 0, conceptsSkipped: 0 };
  ```

- [ ] **Step 8.4: Run any existing tests for the job**

  ```bash
  ls test/unit/ test/hybrid/ 2>/dev/null | grep -i 'extract.*concept\|consolidate.*concept'
  ```

  Run any matches with `npx vitest run <path>`. Most likely none exist and this consumer's new behavior is exercised live during DEV deploy smoke. **Note in the PR body** that the cron consumers don't have unit-test coverage for the new gate — that's a known gap, not a blocker.

- [ ] **Step 8.5: Commit**

  ```bash
  git add srv/jobs/extract-concepts-job.js
  git commit -m "refactor(kg): use resolver in extract-concepts cron + add enabled gate (#463)

  BEHAVIOR CHANGE: cron now early-returns when KnowledgeGraphSettings.
  enabled=false. Previously this job ran regardless of
  KNOWLEDGE_GRAPH_ENABLED — the env flag only blocked the HTTP surface.
  The flag now means 'stop new KG work' end-to-end.

  Operators relying on the (broken) env-flag-stops-cron behavior should
  set enabled=false in the new admin tile after first deploy."
  ```

---

## Task 9: Convert `srv/jobs/consolidate-concepts-job.js` consumer

**Files:**

- Modify: `srv/jobs/consolidate-concepts-job.js:50-72`

- [ ] **Step 9.1: Add the resolver import**

  At the top of `srv/jobs/consolidate-concepts-job.js`:

  ```javascript
  import { resolveKnowledgeGraphSettings } from '../lib/runtime-config/kg-settings.js';
  ```

- [ ] **Step 9.2: Replace the threshold read at lines 57-69**

  Find the block (lines 57-69):

  ```javascript
    // Merge threshold: cosine similarity STRICTLY ABOVE this collapses two
    // concepts. Override via KG_MERGE_SIM_THRESHOLD (must be in (0, 1]).
    // Setting `0` is a no-op (nothing satisfies `> 0` for normalised vectors of
    // disjoint concepts; useful for a "skip merges, only run cycles+rebuild"
    // dry-run pass). Don't use `|| DEFAULT` — that swallows the explicit 0.
    const thresholdRaw = process.env.KG_MERGE_SIM_THRESHOLD;
    const thresholdParsed = thresholdRaw !== undefined ? Number(thresholdRaw) : NaN;
    const MERGE_THRESHOLD =
      Number.isFinite(thresholdParsed) && thresholdParsed >= 0 && thresholdParsed <= 1
        ? thresholdParsed
        : DEFAULT_MERGE_THRESHOLD;
  ```

  Replace with:

  ```javascript
    // Phase 2-A (#463): resolver layers DB > env > default. Gate the entire
    // tick on kg.enabled.
    const kg = await resolveKnowledgeGraphSettings();
    if (!kg.enabled) {
      log.info('consolidate-concepts: KnowledgeGraphSettings.enabled=false; skipping tick');
      return { reason: 'kg-disabled' };
    }
    const { mergeSimThreshold: MERGE_THRESHOLD } = kg;
  ```

  **Match the early-return shape** to whatever the file's other return paths use, same as Task 8 step 8.3.

- [ ] **Step 9.3: Run any existing tests**

  Same as Task 8 step 8.4 — most likely no test file exists for this cron.

- [ ] **Step 9.4: Commit**

  ```bash
  git add srv/jobs/consolidate-concepts-job.js
  git commit -m "refactor(kg): use resolver in consolidate-concepts cron + add enabled gate (#463)

  Same behavior change as extract-concepts: cron now early-returns when
  KnowledgeGraphSettings.enabled=false."
  ```

---

## Task 10: Hybrid round-trip tests (real HANA)

**Files:**

- Create: `test/hybrid/runtime-config.test.js`

- [ ] **Step 10.1: Read existing hybrid test pattern**

  Run:

  ```bash
  ls test/hybrid/ | head -5
  cat test/hybrid/_guard.js | head -25
  cat $(ls test/hybrid/*.test.js | head -1) | head -40
  ```

  Confirm the `ensureWriteAllowed()` guard pattern and the typical `beforeAll`/`afterAll` cleanup shape.

- [ ] **Step 10.2: Write the hybrid tests**

  Write to `test/hybrid/runtime-config.test.js`:

  ```javascript
  // test/hybrid/runtime-config.test.js
  // Hybrid round-trip tests for kg-settings resolver (#463).
  // Requires `cds bind --exec` against DEV HANA + ALLOW_HYBRID_WRITES=true.

  import { describe, it, expect, beforeAll, afterAll } from 'vitest';
  import cds from '@sap/cds';
  import {
    resolveKnowledgeGraphSettings,
    _resetCacheForTests,
  } from '../../srv/lib/runtime-config/kg-settings.js';
  import { ensureWriteAllowed } from './_guard.js';

  describe('kg-settings resolver — HANA round-trip (#463)', () => {
    const cleanup = [];

    beforeAll(async () => {
      ensureWriteAllowed();
      await cds.connect.to('db');
    });

    afterAll(async () => {
      const db = await cds.connect.to('db');
      for (const id of cleanup) {
        await db.run(
          'DELETE FROM COM_SAP_DEVELOPERS_IMS_KNOWLEDGEGRAPHSETTINGS WHERE ID = ?',
          [id],
        );
      }
    });

    it('reads back what CAP wrote (lowercase column path)', async () => {
      const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
      const id = '__TEST__a3000000-0000-0000-0000-000000000001';
      cleanup.push(id);
      // Idempotent: clean any leftover from a prior failed run.
      await DELETE.from(KnowledgeGraphSettings).where({ ID: id });
      await INSERT.into(KnowledgeGraphSettings).entries({
        ID: id,
        enabled: true,
        extractBuildCap: 42,
        mergeSimThreshold: 0.55,
        mergeSimThresholdExtract: 0.66,
      });
      _resetCacheForTests();
      const s = await resolveKnowledgeGraphSettings();
      expect(s.enabled).toBe(true);
      expect(s.extractBuildCap).toBe(42);
      expect(Number(s.mergeSimThreshold)).toBeCloseTo(0.55, 2);
      expect(Number(s.mergeSimThresholdExtract)).toBeCloseTo(0.66, 2);
    });

    it('reads back via raw-SQL UPPERCASE path', async () => {
      const db = await cds.connect.to('db');
      const id = '__TEST__a3000000-0000-0000-0000-000000000002';
      cleanup.push(id);
      // Idempotent cleanup before insert
      await db.run(
        'DELETE FROM COM_SAP_DEVELOPERS_IMS_KNOWLEDGEGRAPHSETTINGS WHERE ID = ?',
        [id],
      );
      await db.run(
        'INSERT INTO COM_SAP_DEVELOPERS_IMS_KNOWLEDGEGRAPHSETTINGS ' +
        '(ID, enabled, extractBuildCap, mergeSimThreshold, mergeSimThresholdExtract, createdAt, modifiedAt) ' +
        'VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
        [id, true, 7, 0.30, 0.40],
      );
      _resetCacheForTests();
      const s = await resolveKnowledgeGraphSettings();
      // The DB has 2 rows now (one from each test), and the resolver picks
      // ONE row (whichever HANA returns first via SELECT...LIMIT 1). So we
      // assert ANY of the test data appears, not specifically this row's
      // data — the value of THIS test is exercising the raw-SQL UPPERCASE
      // code path without errors.
      expect(typeof s.extractBuildCap).toBe('number');
      expect(typeof s.enabled).toBe('boolean');
    });
  });
  ```

  **Note on the second test:** because the resolver does `SELECT … LIMIT 1` and there are two rows in the table during the test run, we can't deterministically assert THIS row's specific values. The value of the test is exercising the raw-SQL UPPERCASE code path — it asserts the shape but not the specific values. If you'd prefer fully-deterministic asserts, the second test must DELETE all rows before its insert; do that only if you're confident no other test/run is concurrently using the table.

- [ ] **Step 10.3: Run the hybrid tests**

  Hybrid tests need `cds bind` to DEV HANA + the write-guard env var. Run:

  ```bash
  ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/runtime-config.test.js
  ```

  Expected: 2 tests PASS. If `cf login` isn't fresh, this fails with a connection error — log in to DEV space first via `cf target -s dev`.

  **If you're not authenticated to CF**: skip this step. The PR can still be merged without hybrid tests passing locally; CI doesn't run hybrid tests automatically. Note in PR body: "Hybrid tests added but not run locally; verify after deploy."

- [ ] **Step 10.4: Commit**

  ```bash
  git add test/hybrid/runtime-config.test.js
  git commit -m "test(hybrid): kg-settings round-trip on real HANA (#463)

  2 tests covering both the CAP cds.entities path and the raw-SQL
  UPPERCASE fallback path. ensureWriteAllowed() guard + cleanup in
  afterAll. Test rows tagged with __TEST__ ID prefix."
  ```

---

## Task 11: Admin tile — files

**Files:**

- Create: `app/admin/knowledgeGraph/webapp/manifest.json`
- Create: `app/admin/knowledgeGraph/webapp/Component.js`
- Create: `app/admin/knowledgeGraph/webapp/index.html`
- Create: `app/admin/knowledgeGraph/webapp/view/Settings.view.xml`
- Create: `app/admin/knowledgeGraph/webapp/controller/Settings.controller.js`
- Create: `app/admin/knowledgeGraph/webapp/i18n/i18n.properties`

- [ ] **Step 11.1: Create the directory tree**

  ```bash
  mkdir -p app/admin/knowledgeGraph/webapp/{view,controller,i18n}
  ```

- [ ] **Step 11.2: Write `manifest.json`**

  Write to `app/admin/knowledgeGraph/webapp/manifest.json`:

  ```json
  {
    "_version": "1.65.0",
    "sap.app": {
      "id": "sap.tutorials.admin.knowledgeGraph",
      "type": "application",
      "title": "{{appTitle}}",
      "i18n": "i18n/i18n.properties"
    },
    "sap.ui5": {
      "rootView": {
        "viewName": "sap.tutorials.admin.knowledgeGraph.view.Settings",
        "type": "XML",
        "id": "settings",
        "async": true
      },
      "dependencies": {
        "minUI5Version": "1.136.0",
        "libs": { "sap.m": {}, "sap.ui.core": {}, "sap.ui.layout": {} }
      },
      "models": {
        "i18n": {
          "type": "sap.ui.model.resource.ResourceModel",
          "settings": { "bundleName": "sap.tutorials.admin.knowledgeGraph.i18n.i18n" }
        }
      },
      "contentDensities": { "compact": true, "cozy": true }
    }
  }
  ```

- [ ] **Step 11.3: Write `Component.js`**

  Write to `app/admin/knowledgeGraph/webapp/Component.js`:

  ```javascript
  sap.ui.define(["sap/ui/core/UIComponent"], function (UIComponent) {
    "use strict";
    return UIComponent.extend("sap.tutorials.admin.knowledgeGraph.Component", {
      metadata: { manifest: "json" }
    });
  });
  ```

- [ ] **Step 11.4: Write `index.html`**

  Reference existing pattern:

  ```bash
  cat app/admin/joule/webapp/index.html
  ```

  Copy that file's contents into `app/admin/knowledgeGraph/webapp/index.html`, but replace any `sap.tutorials.admin.joule` strings with `sap.tutorials.admin.knowledgeGraph`.

- [ ] **Step 11.5: Write the view**

  Write to `app/admin/knowledgeGraph/webapp/view/Settings.view.xml`:

  ```xml
  <mvc:View
    controllerName="sap.tutorials.admin.knowledgeGraph.controller.Settings"
    xmlns:mvc="sap.ui.core.mvc"
    xmlns="sap.m"
    xmlns:f="sap.ui.layout.form"
    height="100%">
    <ScrollContainer height="100%" width="100%" vertical="true" horizontal="false">
      <VBox class="sapUiMediumMargin">
        <Title text="{i18n>pageTitle}" level="H2" class="sapUiSmallMarginBottom" />
        <MessageStrip
          text="{i18n>infoStrip}"
          type="Information"
          showIcon="true"
          class="sapUiSmallMarginBottom" />

        <Panel headerText="{i18n>generalHeader}" class="sapUiSmallMarginBottom">
          <f:SimpleForm editable="true" layout="ResponsiveGridLayout">
            <Label text="{i18n>fieldEnabled}" />
            <Switch state="{settings>/enabled}" />

            <Label text="{i18n>fieldExtractBuildCap}" />
            <Input value="{settings>/extractBuildCap}" type="Number"
                   placeholder="{i18n>placeholderExtractBuildCap}" />

            <Label text="{i18n>fieldMergeSimThreshold}" />
            <Input value="{settings>/mergeSimThreshold}" type="Number"
                   placeholder="{i18n>placeholderMergeSimThreshold}" />

            <Label text="{i18n>fieldMergeSimThresholdExtract}" />
            <Input value="{settings>/mergeSimThresholdExtract}" type="Number"
                   placeholder="{i18n>placeholderMergeSimThresholdExtract}" />
          </f:SimpleForm>
        </Panel>

        <HBox justifyContent="End">
          <Button text="{i18n>buttonReload}" press=".onReload" />
          <Button text="{i18n>buttonSave}" type="Emphasized" press=".onSave"
                  class="sapUiTinyMarginBegin" />
        </HBox>
      </VBox>
    </ScrollContainer>
  </mvc:View>
  ```

  Save button is **always enabled** — no dirty-flag binding. Mirrors Joule's actual pattern.

- [ ] **Step 11.6: Write the controller**

  Write to `app/admin/knowledgeGraph/webapp/controller/Settings.controller.js`:

  ```javascript
  sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox"
  ], function (Controller, JSONModel, MessageToast, MessageBox) {
    "use strict";

    return Controller.extend("sap.tutorials.admin.knowledgeGraph.controller.Settings", {
      onInit: function () {
        var oJSON = new JSONModel({
          enabled: false,
          extractBuildCap: null,
          mergeSimThreshold: null,
          mergeSimThresholdExtract: null
        });
        this.getView().setModel(oJSON, "settings");
        this._loadSettings();
      },

      _loadSettings: function () {
        var oModel = this.getView().getModel("settings");
        fetch("/admin/KnowledgeGraphSettings", {
          credentials: "include",
          headers: { "Accept": "application/json" }
        })
          .then(function (res) {
            if (!res.ok) { throw new Error("HTTP " + res.status); }
            return res.json();
          })
          .then(function (data) {
            oModel.setData({
              enabled: !!data.enabled,
              extractBuildCap: data.extractBuildCap != null ? data.extractBuildCap : null,
              mergeSimThreshold: data.mergeSimThreshold != null ? data.mergeSimThreshold : null,
              mergeSimThresholdExtract: data.mergeSimThresholdExtract != null ? data.mergeSimThresholdExtract : null
            });
          })
          .catch(function (err) {
            MessageToast.show("Failed to load settings: " + err.message);
          });
      },

      onReload: function () {
        this._loadSettings();
      },

      onSave: function () {
        var data = this.getView().getModel("settings").getData();
        var cap = data.extractBuildCap === "" || data.extractBuildCap == null ? null : parseInt(data.extractBuildCap, 10);
        var t1  = data.mergeSimThreshold === "" || data.mergeSimThreshold == null ? null : Number(data.mergeSimThreshold);
        var t2  = data.mergeSimThresholdExtract === "" || data.mergeSimThresholdExtract == null ? null : Number(data.mergeSimThresholdExtract);
        var body = {
          enabled: !!data.enabled,
          extractBuildCap: cap,
          mergeSimThreshold: t1,
          mergeSimThresholdExtract: t2
        };

        // CSRF round-trip: HEAD /admin/$metadata returns the token; PATCH echoes it.
        // CAP enforces CSRF on writes; no exemption for /admin/. Joule does the same.
        fetch("/admin/$metadata", {
          method: "HEAD",
          credentials: "include",
          headers: { "x-csrf-token": "fetch" }
        })
          .then(function (res) {
            return res.headers.get("x-csrf-token") || "";
          })
          .then(function (token) {
            return fetch("/admin/KnowledgeGraphSettings", {
              method: "PATCH",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "x-csrf-token": token
              },
              body: JSON.stringify(body)
            });
          })
          .then(function (res) {
            if (!res.ok) { throw new Error("HTTP " + res.status); }
            MessageToast.show("Saved");
          })
          .catch(function (err) {
            MessageBox.error("Save failed: " + err.message);
          });
      }
    });
  });
  ```

- [ ] **Step 11.7: Write i18n**

  Write to `app/admin/knowledgeGraph/webapp/i18n/i18n.properties`:

  ```properties
  appTitle=Knowledge Graph Settings
  pageTitle=Knowledge Graph Settings
  generalHeader=General
  infoStrip=Changes take effect within 5 seconds across all server instances. Cron jobs honor flag changes on the next tick.
  fieldEnabled=Enabled
  fieldExtractBuildCap=Extract Build Cap (LLM calls per tick)
  fieldMergeSimThreshold=Consolidator Merge Threshold (0.01 — 1.00)
  fieldMergeSimThresholdExtract=Extract-time Merge Threshold (0.01 — 1.00)
  placeholderExtractBuildCap=200
  placeholderMergeSimThreshold=0.92
  placeholderMergeSimThresholdExtract=0.85
  buttonSave=Save
  buttonReload=Reload
  ```

- [ ] **Step 11.8: Verify all 6 tile files exist**

  Run:

  ```bash
  ls -la app/admin/knowledgeGraph/webapp/{manifest.json,Component.js,index.html,view/Settings.view.xml,controller/Settings.controller.js,i18n/i18n.properties}
  ```

  Expected: 6 files listed.

- [ ] **Step 11.9: Commit**

  ```bash
  git add app/admin/knowledgeGraph/
  git commit -m "feat(admin): KnowledgeGraph admin tile (#463)

  Custom-XML form mirroring Joule's pattern (singleton config, not
  Fiori Elements list-report). Always-enabled Save button — no
  attachPropertyChange dirty-tracking (Joule doesn't use it; the
  JSONModel propertyChange API doesn't fire for two-way binding leaves
  anyway).

  CSRF round-trip via HEAD /admin/\$metadata before PATCH — CAP
  enforces CSRF on writes; the existing approuter forwards it.
  credentials: 'include' on every fetch.

  MessageStrip explains 5s-cache lag + cron-honors-on-next-tick to
  prevent admin from thinking the toggle is broken when /graph/* still
  responds in the first 5s after flip."
  ```

---

## Task 12: Wire admin tile into admin-shell

**Files:**

- Modify: `app/admin-shell/scripts/copy-components.js:8-25` (add `'knowledgeGraph'` to COMPONENTS array)
- Modify: `app/admin-shell/webapp/manifest.json:53` (componentUsages)
- Modify: `app/admin-shell/webapp/manifest.json:152` (targets)
- Modify: `app/admin-shell/webapp/manifest.json:202` (routes)
- Modify: `app/admin-shell/webapp/view/Shell.view.xml:106` (side-nav System group)

- [ ] **Step 12.1: Add to copy-components.js**

  Open `app/admin-shell/scripts/copy-components.js`. In the `COMPONENTS` array (lines 8-25), add a new entry. Place it after `'joule'`:

  ```javascript
  const COMPONENTS = [
    'events',
    // ... existing entries ...
    'joule',
    'knowledgeGraph',
    'feedback',
  ]
  ```

  (Specifically: insert the line `'knowledgeGraph',` between `'joule',` and `'feedback'`.)

- [ ] **Step 12.2: Add componentUsages entry in manifest.json (line ~53)**

  Open `app/admin-shell/webapp/manifest.json`. In the `componentUsages` block (around lines 51-55), add a new entry mirroring the Joule line:

  ```json
        "sap.tutorials.admin.joule": "./components/joule",
        "sap.tutorials.admin.knowledgeGraph": "./components/knowledgeGraph",
        "sap.tutorials.admin.feedback": "./components/feedback"
  ```

- [ ] **Step 12.3: Add target entry in manifest.json (line ~152)**

  In the `targets` block, find the `jouleSettingsComponent` entry (lines 152-156). Add immediately after it:

  ```json
        "knowledgeGraphSettingsComponent": {
          "name": "sap.tutorials.admin.knowledgeGraph",
          "settings": {},
          "componentData": {},
          "lazy": true
        },
  ```

  And in the `targets` block at line ~310 (where `jouleSettingsTarget` is defined), add:

  ```json
          "knowledgeGraphSettingsTarget": {
            "type": "Component",
            "usage": "knowledgeGraphSettingsComponent",
            "id": "knowledgeGraphSettingsTarget",
            "viewLevel": 1,
            "prefix": "kg"
          },
  ```

  (Insert right after `jouleSettingsTarget`.)

- [ ] **Step 12.4: Add route entry in manifest.json (line ~202)**

  In the `routes` array (around line 200), find the existing joule route:

  ```json
          { "name": "joule", "pattern": "joule", "target": [{"name": "jouleSettingsTarget", "prefix": "jo"}] },
  ```

  Insert a new route right after it:

  ```json
          { "name": "knowledgeGraph", "pattern": "knowledgeGraph", "target": [{"name": "knowledgeGraphSettingsTarget", "prefix": "kg"}] },
  ```

- [ ] **Step 12.5: Add NavigationListItem to Shell.view.xml (line ~106)**

  Open `app/admin-shell/webapp/view/Shell.view.xml`. Find the System group's `Joule Settings` line (around line 106):

  ```xml
              <tnt:NavigationListItem text="Joule Settings" key="joule" />
  ```

  Insert a new line immediately after it:

  ```xml
              <tnt:NavigationListItem text="Knowledge Graph" key="knowledgeGraph" />
  ```

- [ ] **Step 12.6: Verify admin-shell builds successfully**

  Run:

  ```bash
  npm --prefix app/admin-shell install
  npm --prefix app/admin-shell run build
  ```

  Expected: build completes, `app/admin-shell/dist/` populated, `app/admin-shell/dist/components/knowledgeGraph/` exists with all 6 files copied. `console.log` should show `Copied knowledgeGraph` line in the build output.

  If the build fails with a manifest validation error, fix the JSON syntax (commas, indent levels) and re-run. Use `mcp__plugin_ui5_ui5-mcp-server__run_manifest_validation` against `app/admin-shell/webapp/manifest.json` if needed.

- [ ] **Step 12.7: Commit**

  ```bash
  git add app/admin-shell/
  git commit -m "feat(admin-shell): wire knowledgeGraph tile into shell (#463)

  Four-place wiring (mirrors every other admin tile):
  - copy-components.js: append 'knowledgeGraph' to COMPONENTS array
  - manifest.json: componentUsages, target, route entries
  - Shell.view.xml: NavigationListItem in System group"
  ```

---

## Task 13: Update srv-qa cp list in mta.yaml

**Files:**

- Modify: `.deploy/mta.yaml:97`

- [ ] **Step 13.1: Identify the srv-qa cp chain**

  Run:

  ```bash
  sed -n '97p' .deploy/mta.yaml | head -c 500
  ```

  Confirm the line begins with `- bash -c "mkdir -p srv/jobs && mkdir -p srv/handlers && mkdir -p srv/lib/branch && cp ...`

- [ ] **Step 13.2: Add `mkdir -p srv/lib/runtime-config` and a separate `cp` line**

  The existing line has the structure:

  ```bash
  mkdir -p srv/jobs && mkdir -p srv/handlers && mkdir -p srv/lib/branch && cp <branch files> srv/lib/branch/ && cp <flat lib files> srv/lib/ && cp <handlers> srv/handlers/ && cp <jobs> srv/jobs/
  ```

  Add `mkdir -p srv/lib/runtime-config` to the mkdir chain (e.g. between `mkdir -p srv/lib/branch` and the first `&& cp`). Add a new `cp` operation for the new module after the branch `cp`:

  ```bash
  ... && mkdir -p srv/lib/branch && mkdir -p srv/lib/runtime-config && cp ../../srv/lib/branch/condition.js ... srv/lib/branch/ && cp ../../srv/lib/runtime-config/kg-settings.js srv/lib/runtime-config/ && cp ../../srv/lib/content-store.js ... srv/lib/ && cp ...
  ```

  **Be precise about quote balance** — this is a single bash string argument; the shell will refuse if quotes mismatch.

- [ ] **Step 13.3: Verify mta.yaml parses**

  Run:

  ```bash
  yq '.modules[] | select(.name == "tutorials-srv-qa")' .deploy/mta.yaml > /dev/null && echo OK
  ```

  Expected: `OK`. If it fails, the YAML is broken — restore from `git checkout .deploy/mta.yaml` and try again.

- [ ] **Step 13.4: Commit**

  ```bash
  git add .deploy/mta.yaml
  git commit -m "chore(deploy): add srv/lib/runtime-config to srv-qa cp list (#463)

  Two edits per the srv/lib/branch precedent:
  1. mkdir -p srv/lib/runtime-config (new subdirectory)
  2. cp ../../srv/lib/runtime-config/kg-settings.js srv/lib/runtime-config/

  Without these, srv-qa boot crashes on the first import of the
  resolver. See feedback_srv_qa_cp_list_recurring."
  ```

---

## Task 14: End-to-end verification

- [ ] **Step 14.1: Run all unit tests**

  ```bash
  npm test -- --run 2>&1 | tail -30
  ```

  Expected: all tests pass. If any fail, the failure is most likely related to the resolver tests or a regression in an existing test caused by the schema or admin-service modifications.

- [ ] **Step 14.2: Confirm cds compile clean**

  ```bash
  npx cds compile srv/admin-service.cds > /dev/null && echo OK
  npx cds compile db/schema.cds > /dev/null && echo OK
  ```

  Expected: 2 `OK` lines.

- [ ] **Step 14.3: Confirm admin-shell build clean**

  ```bash
  npm --prefix app/admin-shell run build 2>&1 | tail -20
  ```

  Expected: build success, `Copied knowledgeGraph` in output.

- [ ] **Step 14.4: Inspect git log on the branch**

  ```bash
  git log --oneline main..HEAD
  ```

  Expected: 13-14 commits (one per task plus possible fixups), all on the worktree branch, none on main.

---

## Task 15: Finalize the development branch

Use the **superpowers:finishing-a-development-branch** skill to:

1. Verify tests pass.
2. Determine base branch (`main`).
3. Present the user with the 4-option menu (merge / push+PR / keep / discard).

When the user picks **"Push and create a Pull Request"**, the PR body should:

- Reference issue #463 (`Closes #463.`).
- Spell out the **cron behavior tightening** explicitly under a "⚠️ Behavior change" header. Suggested text:

  > **⚠️ Behavior change.** This PR changes cron-job behavior for `extract-concepts-job` and `consolidate-concepts-job`: they now early-return when `KnowledgeGraphSettings.enabled` is OFF. Previously these jobs ran regardless of `KNOWLEDGE_GRAPH_ENABLED` (the env flag only blocked the HTTP surface, not cron writes). The flag now means "stop new KG work" end-to-end. Operators relying on the (broken) env-flag-stops-cron behavior should set `enabled = false` in `/admin-ui/#knowledgeGraph` after first deploy.

- Include the test plan checkboxes:
  - [ ] Local unit tests pass (`npm test`).
  - [ ] Hybrid round-trip tests pass (`ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/runtime-config.test.js`).
  - [ ] DEV deploy: tile loads at `/admin-ui/#knowledgeGraph`.
  - [ ] DEV deploy: editing a value + clicking Save persists (re-fetch returns saved value).
  - [ ] DEV deploy: change appears in `/admin-ui/#changelog-display`.
  - [ ] DEV deploy: with `KnowledgeGraphSettings` empty, `KNOWLEDGE_GRAPH_ENABLED=true` env-var path still works (regression).

- Reference the spec doc: `docs/superpowers/specs/2026-06-20-issue-463-runtime-config-foundation-design.md`.

---

## Out of scope for this plan

- **Migrating any env var beyond KG.** Phase 3 (#466) covers Batch 2 (UI-Events + Search) and Batch 3 (Navigator/Display/Tenant).
- **Encrypted secrets.** Phase 2-B (#464) and 2-C (#465).
- **Push-based hot-reload.** Research doc rejected; revisit if a sub-second use case appears.
- **Smoke tests.** Hybrid is the deepest test layer in this PR; smoke covers the deployed path manually.
- **`AI_AUTHOR_ENABLED`.** Build-time only (0 srv consumers per the research-doc inventory).
- **Removing the env vars from mtaext.** Stays through Phase 3 + soak window.

## References

- Spec: `docs/superpowers/specs/2026-06-20-issue-463-runtime-config-foundation-design.md`
- Research-design parent: `docs/superpowers/specs/2026-06-20-runtime-config-research-design.md`
- Issue: [#463](https://github.com/sap-tutorials/tutorials-ims/issues/463)
- Precedent files: [srv/lib/chat-settings-resolver.js](../../../srv/lib/chat-settings-resolver.js), [test/unit/chat-settings-resolver.test.js](../../../test/unit/chat-settings-resolver.test.js), [app/admin/joule/webapp/](../../../app/admin/joule/webapp/), [app/admin-shell/scripts/copy-components.js](../../../app/admin-shell/scripts/copy-components.js)
- Memory: [feedback_cap_csv_seeds_clobber_admin_data], [feedback_srv_qa_cp_list_recurring], [feedback_subagent_writes_can_leak_to_parent_repo], [feedback_default_off_flags_need_live_smoke]
