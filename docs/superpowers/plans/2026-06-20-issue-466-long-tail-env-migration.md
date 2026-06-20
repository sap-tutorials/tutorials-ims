# Phase 3 Long-Tail Env-Var Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the 9 remaining long-tail env vars across 5 domains (UI-Events, Search, Navigator, Display, Tenant) to per-domain typed singletons + admin tiles. Establishes the new "Runtime Settings" nav-group containing all 7 runtime-config tiles. Final phase of the runtime-config research from #444.

**Architecture:** 5 new singleton entities in `db/schema.cds`. 5 self-contained resolver libs in `srv/lib/runtime-config/` (5s in-module cache, layered DB → env → default). 5 custom-XML admin tiles mirroring kg-settings. 8 consumer-file conversions including 3 async-ifications (`recordEvent`, `scheduleRebuild`, `shouldIncludeNestedGroups`). Admin-shell wiring at 5 locations × 5 tiles + nav-group restructuring. ~30 unit tests.

**Tech Stack:** SAP CAP Node.js, HANA Cloud, Vitest (unit only — no hybrid this PR), UI5 (custom XML, sap.m), `@cap-js/change-tracking`, native `node-cron` (existing scheduler integration).

**Spec:** [docs/superpowers/specs/2026-06-20-issue-466-long-tail-env-migration-design.md](../specs/2026-06-20-issue-466-long-tail-env-migration-design.md)

**Branch:** `worktree-issue-466-long-tail-env-migration` (already checked out in worktree).

---

## Worktree-state warning (verified at plan-writing time)

**This worktree branched from main BEFORE PRs #471 (Phase 2-A) and #482 (Phase 2-B) merged.** Verified by inspection:

- `srv/lib/runtime-config/` does NOT exist (kg-settings.js absent — confirmed `ls` returns "No such file or directory").
- `KnowledgeGraphSettings` and `Secrets` entities are NOT in `db/schema.cds` (last entity is `BranchDecisions`).
- `knowledgeGraph` and `secrets` nav-entries are NOT in `Shell.view.xml`.
- `app/admin-shell/scripts/copy-components.js` COMPONENTS array does NOT include `'knowledgeGraph'` or `'secrets'`.
- `app/admin-shell/webapp/i18n/i18n.properties` may NOT exist (created in #482).

**Implication for the plan:**

- The "RELOCATE" framing in the spec for Knowledge Graph + Secrets becomes "ADD" — those nav-entries don't exist anywhere in this worktree.
- Plan tasks for nav-group restructuring (Task 18) ONLY add the new "Runtime Settings" group with its 5 new children. Knowledge Graph + Secrets entries do NOT appear in the new group's children **in this worktree**. When this PR is rebased onto post-#471/#482 main during PR review, the rebase conflict will surface and a follow-up commit will move them in.
- All other plan tasks use idempotent appendable patterns (end-of-file, end-of-array) so they work regardless of worktree state.

**If this worktree gets rebased onto main mid-implementation:** stop, re-read the spec's nav-group section, and add the Knowledge Graph + Secrets `<NavigationListItem>` entries to the new Runtime Settings group via a follow-up commit.

---

## File Structure

### New files (35)

| File | Purpose |
| --- | --- |
| `db/data/com.sap.developers.ims-UiEventsSettings.csv` | Empty CSV seed (header only) |
| `db/data/com.sap.developers.ims-SearchSettings.csv` | Empty CSV seed |
| `db/data/com.sap.developers.ims-NavigatorSettings.csv` | Empty CSV seed |
| `db/data/com.sap.developers.ims-DisplaySettings.csv` | Empty CSV seed |
| `db/data/com.sap.developers.ims-TenantSettings.csv` | Empty CSV seed |
| `srv/lib/runtime-config/ui-events-settings.js` | Resolver lib (~110 lines) |
| `srv/lib/runtime-config/search-settings.js` | Resolver lib |
| `srv/lib/runtime-config/navigator-settings.js` | Resolver lib |
| `srv/lib/runtime-config/display-settings.js` | Resolver lib |
| `srv/lib/runtime-config/tenant-settings.js` | Resolver lib (largest — 4 fields) |
| `test/unit/runtime-config/ui-events-settings.test.js` | 5 unit tests |
| `test/unit/runtime-config/search-settings.test.js` | 6 unit tests |
| `test/unit/runtime-config/navigator-settings.test.js` | 5 unit tests |
| `test/unit/runtime-config/display-settings.test.js` | 5 unit tests |
| `test/unit/runtime-config/tenant-settings.test.js` | 7 unit tests |
| `app/admin/uiEvents/webapp/{manifest.json, Component.js, index.html, view/Settings.view.xml, controller/Settings.controller.js, i18n/i18n.properties}` | Admin tile (6 files) |
| `app/admin/search/webapp/{6 files}` | Admin tile |
| `app/admin/navigator/webapp/{6 files}` | Admin tile |
| `app/admin/display/webapp/{6 files}` | Admin tile |
| `app/admin/tenant/webapp/{6 files}` | Admin tile |
| `docs/developers/operations/runtime-config.md` | Operations doc (~150 lines) |

### Modified files (10)

| File | Change |
| --- | --- |
| `db/schema.cds` | Append 5 entities at end-of-file |
| `db/change-tracking.cds` | Append 5 `@changelog` annotations at end-of-file |
| `srv/admin-service.cds` | Append 5 `@odata.singleton` projections inside the service block |
| `srv/lib/ui-event-handler.js` | Async-ify `recordEvent()`; resolver call replaces `_state.enabled` |
| `srv/server.js` | 2 changes: rate-limiter (lazy-rebuild) + CORS (per-request resolver call) |
| `srv/lib/navigator-catalog.js` | Async-ify `shouldIncludeNestedGroups()` + caller `await` |
| `srv/admin-service.js` | Resolver swap for `dashboardUrl` (1 line) |
| `srv/jobs/scheduler.js` | Resolver swap for `dashboardUrl` (1 line) |
| `srv/lib/rebuild-trigger.js` | Drop `_state.environment`; async-ify `scheduleRebuild()` |
| `srv/lib/__tests__/rebuild-trigger.test.js` | 13 callers `→ await scheduleRebuild(...)` + `_resetForTests` semantics |
| `srv/server.js` | (counted above) — `scheduleRebuild` caller try/catch → `.catch()` |
| `srv/lib/tech-user-auth.js` | Async-ify `loadTechUsers()` + `loadTechUserMapping()` + caller `await`s |
| `app/admin-shell/scripts/copy-components.js` | Append 5 entries |
| `app/admin-shell/webapp/manifest.json` | 5 sub-entries × 4 blocks (resourceRoots, componentUsages, targets×2, routes) = 20 manifest entries |
| `app/admin-shell/webapp/view/Shell.view.xml` | New "Runtime Settings" peer-group with 5 children |
| `app/admin-shell/webapp/controller/Shell.controller.js` | 3 changes: groupExpanded init, NAV_KEY_TO_ROUTE × 5, NAV_KEY_TO_TITLE × 5 |
| `.deploy/mta.yaml:97` | Add `mkdir -p srv/lib/runtime-config` + 5 cp lines (worktree-state aware) |

---

## Pre-flight checklist

- [ ] **Step 0.1: Confirm working in the worktree, not the parent repo**

  Run:

  ```bash
  pwd
  git branch --show-current
  ```

  Expected: `pwd` ends in `issue-466-long-tail-env-migration`, branch is `worktree-issue-466-long-tail-env-migration`.

  If wrong: STOP. Re-enter the worktree before any edits ([feedback_subagent_writes_can_leak_to_parent_repo]).

- [ ] **Step 0.2: Verify spec is committed in branch history**

  Run:

  ```bash
  git log --oneline -10 | grep -E 'docs.*spec.*#466'
  ```

  Expected: at least one match showing the Phase 3 spec was committed (initial commit `be39fcc2` plus the iter-1 corrections commit `d9cea79a`).

- [ ] **Step 0.3: Confirm worktree state matches plan assumptions**

  Run:

  ```bash
  ls srv/lib/runtime-config/ 2>&1
  grep -nE 'entity (KnowledgeGraphSettings|Secrets) ' db/schema.cds | wc -l
  ```

  Expected:
  - First command: `No such file or directory` (the runtime-config subdirectory does NOT exist — pre-#471 state).
  - Second command: `0` (KG and Secrets entities are NOT in this worktree's schema.cds).

  **If either is unexpected** (rebased onto post-#471 main): re-read the worktree-state warning at the top of this plan and adjust Task 18 (nav-group children) accordingly — Knowledge Graph + Secrets entries must be ADDED to the new "Runtime Settings" group in that case.

- [ ] **Step 0.4: Confirm sibling-plan templates exist for reference**

  Run:

  ```bash
  test -f docs/superpowers/plans/2026-06-20-issue-463-runtime-config-foundation.md && echo OK_463
  test -f docs/superpowers/plans/2026-06-20-issue-464-secrets-visibility.md && echo OK_464
  ```

  Expected: 2 OK lines. These plans contain the canonical resolver-lib + admin-tile + admin-shell-wiring task templates this plan replicates.

  If either is missing, the worktree may be off the merge-base — STOP and verify branch state.

---

## Task 1: Define `UiEventsSettings` schema entity

**Files:**

- Modify: `db/schema.cds` (append at end-of-file — last entity is `BranchDecisions`)

- [ ] **Step 1.1: Verify last-entity location**

  ```bash
  tail -8 db/schema.cds
  wc -l db/schema.cds
  ```

  Expected: file ends with the `BranchDecisions` entity's closing `}`. Note the line count.

- [ ] **Step 1.2: Append the entity**

  Append to `db/schema.cds`:

  ```cds


  // Phase 3 (#466): UI events telemetry feature flag.
  // Resolver at srv/lib/runtime-config/ui-events-settings.js layers DB > env > default.
  // CSV seed must stay empty (HDI-clobbers-admin-edits footgun).
  entity UiEventsSettings : cuid, managed {
    enabled              : Boolean;
  }
  ```

- [ ] **Step 1.3: Verify schema compiles**

  ```bash
  npx cds compile db/schema.cds > /dev/null && echo OK
  ```

  Expected: `OK`. If compile fails, run without `> /dev/null` and read the error.

- [ ] **Step 1.4: Commit**

  ```bash
  git add db/schema.cds
  git commit -m "feat(db): add UiEventsSettings entity (#466)

  Phase 3 (#466) — first of 5 long-tail singletons. UI events
  telemetry feature flag. Single Boolean column, nullable so the
  resolver can fall through to env on first deploy."
  ```

---

## Task 2: Define `SearchSettings` schema entity

**Files:**

- Modify: `db/schema.cds` (append at end-of-file)

- [ ] **Step 2.1: Append the entity**

  Append to `db/schema.cds`:

  ```cds


  // Phase 3 (#466): Search /search/* per-IP rate limit.
  // rateLimitMax = requests-per-window; rateLimitWindowMs = rolling window in ms.
  // Range upper bound on windowMs at 600000 (10min) prevents an admin from
  // configuring a 1-hour rate-limit cell that would persist rejection state
  // across deploys.
  entity SearchSettings : cuid, managed {
    rateLimitMax         : Integer @assert.range: [0, 100000];
    rateLimitWindowMs    : Integer @assert.range: [1000, 600000];
  }
  ```

- [ ] **Step 2.2: Verify compiles**

  ```bash
  npx cds compile db/schema.cds > /dev/null && echo OK
  ```

- [ ] **Step 2.3: Commit**

  ```bash
  git add db/schema.cds
  git commit -m "feat(db): add SearchSettings entity (#466)

  Phase 3 (#466). Per-IP rate-limit knobs. @assert.range on
  windowMs caps it at 10min (operator footgun guard against
  hour-long rate-limit cells)."
  ```

---

## Task 3: Define `NavigatorSettings` schema entity

**Files:**

- Modify: `db/schema.cds` (append at end-of-file)

- [ ] **Step 3.1: Append the entity**

  ```cds


  // Phase 3 (#466): Navigator nested-group inclusion flag.
  // When true, /build/navigator emits cards for nested groups (richer behavior,
  // ~65 extra cards on dev). False matches developers.sap.com chip-counts.
  // See issue #364.
  entity NavigatorSettings : cuid, managed {
    includeNestedGroups  : Boolean;
  }
  ```

- [ ] **Step 3.2: Verify compiles**

  ```bash
  npx cds compile db/schema.cds > /dev/null && echo OK
  ```

- [ ] **Step 3.3: Commit**

  ```bash
  git add db/schema.cds
  git commit -m "feat(db): add NavigatorSettings entity (#466)

  Phase 3 (#466). Nested-group inclusion flag (issue #364)."
  ```

---

## Task 4: Define `DisplaySettings` schema entity

**Files:**

- Modify: `db/schema.cds` (append at end-of-file)

- [ ] **Step 4.1: Append the entity**

  ```cds


  // Phase 3 (#466): Display dashboard URL used in contributor-notification emails.
  // Default fallback (when null) is the prod approuter URL.
  entity DisplaySettings : cuid, managed {
    dashboardUrl         : String(500);
  }
  ```

- [ ] **Step 4.2: Verify compiles**

  ```bash
  npx cds compile db/schema.cds > /dev/null && echo OK
  ```

- [ ] **Step 4.3: Commit**

  ```bash
  git add db/schema.cds
  git commit -m "feat(db): add DisplaySettings entity (#466)

  Phase 3 (#466). Dashboard URL for contributor-notification
  emails. Default fallback in resolver is the prod approuter URL."
  ```

---

## Task 5: Define `TenantSettings` schema entity

**Files:**

- Modify: `db/schema.cds` (append at end-of-file)

- [ ] **Step 5.1: Append the entity**

  ```cds


  // Phase 3 (#466): Tenant-wide config bag.
  // allowedCorsOrigins: comma-separated origin URLs (raw env-var format).
  // rebuildTargetEnv: dev/qa/prod controlling rebuild-trigger workflow_dispatch
  //   target. NOT @assert.range enum-constrained at the DB level — only the
  //   admin-tile ComboBox enforces the value set. Direct OData PATCH (e.g. via
  //   curl by an Admin) bypasses validation. Deliberate: matches the
  //   no-write-time-validation stance for the other special-shape Tenant fields.
  //   Add @assert.range enum if this becomes painful (Phase 4).
  // techUsers: legacy JSON-array format (raw env-var format).
  // techUsersMapping: 'tech_id1:real_uuid1;tech_id2:real_uuid2' (raw env-var format).
  //
  // LargeString chosen for the 3 special-shape fields (CORS, techUsers,
  // techUsersMapping) to avoid silent truncation if these grow beyond 2000
  // chars in a multi-tenant rollout.
  //
  // Special-shape fields stored as raw String/LargeString — consumers keep their
  // existing parse logic. No write-time validation in this PR (matches today's
  // env-var typo failure mode); add @assert.format if validation becomes painful.
  entity TenantSettings : cuid, managed {
    allowedCorsOrigins   : LargeString;
    rebuildTargetEnv     : String(10);
    techUsers            : LargeString;
    techUsersMapping     : LargeString;
  }
  ```

- [ ] **Step 5.2: Verify compiles**

  ```bash
  npx cds compile db/schema.cds > /dev/null && echo OK
  ```

- [ ] **Step 5.3: Commit**

  ```bash
  git add db/schema.cds
  git commit -m "feat(db): add TenantSettings entity (#466)

  Phase 3 (#466) — last of 5 long-tail singletons. 4 fields:
  allowedCorsOrigins, rebuildTargetEnv, techUsers,
  techUsersMapping. LargeString for 3 special-shape fields
  (raw env-var format preserved; consumers keep existing parse
  logic). rebuildTargetEnv is String(10) NOT @assert.range
  enum-constrained — only the ComboBox enforces dev/qa/prod.
  Direct OData PATCH bypasses; deliberate stance, matches the
  no-write-time-validation pattern for the other Tenant fields."
  ```

---

## Task 6: Create empty CSV seeds (5 files, single commit)

**Files (CREATE):**

- `db/data/com.sap.developers.ims-UiEventsSettings.csv`
- `db/data/com.sap.developers.ims-SearchSettings.csv`
- `db/data/com.sap.developers.ims-NavigatorSettings.csv`
- `db/data/com.sap.developers.ims-DisplaySettings.csv`
- `db/data/com.sap.developers.ims-TenantSettings.csv`

All header-only, matching the per-entity column order. Empty seeds avoid the [feedback_cap_csv_seeds_clobber_admin_data] HDI-redeploy footgun.

- [ ] **Step 6.1: Verify CSV pattern via existing precedent**

  ```bash
  cat db/data/com.sap.developers.ims-Categories.csv | head -3
  ```

  Confirm `;` separator + header row + no `managed`-aspect columns.

- [ ] **Step 6.2: Create the 5 seed files**

  Each file gets exactly ONE line (the header) + trailing newline.

  `db/data/com.sap.developers.ims-UiEventsSettings.csv`:

  ```csv
  ID;enabled
  ```

  `db/data/com.sap.developers.ims-SearchSettings.csv`:

  ```csv
  ID;rateLimitMax;rateLimitWindowMs
  ```

  `db/data/com.sap.developers.ims-NavigatorSettings.csv`:

  ```csv
  ID;includeNestedGroups
  ```

  `db/data/com.sap.developers.ims-DisplaySettings.csv`:

  ```csv
  ID;dashboardUrl
  ```

  `db/data/com.sap.developers.ims-TenantSettings.csv`:

  ```csv
  ID;allowedCorsOrigins;rebuildTargetEnv;techUsers;techUsersMapping
  ```

- [ ] **Step 6.3: Verify all 5 files exist with correct headers**

  ```bash
  for f in UiEventsSettings SearchSettings NavigatorSettings DisplaySettings TenantSettings; do
    echo "$f:"
    cat "db/data/com.sap.developers.ims-${f}.csv"
  done
  ```

  Expected: each file prints exactly the header line (no row data).

- [ ] **Step 6.4: Commit (single commit for all 5)**

  ```bash
  git add db/data/com.sap.developers.ims-UiEventsSettings.csv \
          db/data/com.sap.developers.ims-SearchSettings.csv \
          db/data/com.sap.developers.ims-NavigatorSettings.csv \
          db/data/com.sap.developers.ims-DisplaySettings.csv \
          db/data/com.sap.developers.ims-TenantSettings.csv
  git commit -m "feat(db): empty CSV seeds for 5 runtime-config entities (#466)

  Phase 3 (#466). Header-only by design — HDI re-imports CSVs as
  UPSERT on every deploy; non-empty seeds would clobber admin-edited
  values. Per [feedback_cap_csv_seeds_clobber_admin_data]."
  ```

---

## Task 7: Add change-tracking annotations (5 entities, single commit)

**Files:**

- Modify: `db/change-tracking.cds` (append at end-of-file)

- [ ] **Step 7.1: Verify last-line context**

  ```bash
  tail -8 db/change-tracking.cds
  ```

  File should end with the `ConceptEdges` annotation.

- [ ] **Step 7.2: Append annotations**

  Append:

  ```cds


  // Phase 3 (#466): track admin edits to runtime-tunable settings.
  annotate ims.UiEventsSettings  with @changelog;
  annotate ims.SearchSettings    with @changelog;
  annotate ims.NavigatorSettings with @changelog;
  annotate ims.DisplaySettings   with @changelog;
  annotate ims.TenantSettings    with @changelog;
  ```

- [ ] **Step 7.3: Verify compiles**

  ```bash
  npx cds compile srv/admin-service.cds > /dev/null && echo OK
  ```

  Expected: `OK`. The admin-service.cds compile transitively includes change-tracking.cds.

- [ ] **Step 7.4: Commit**

  ```bash
  git add db/change-tracking.cds
  git commit -m "feat(db): change-tracking on 5 runtime-config entities (#466)

  Phase 3 (#466). Mutations appear in /admin-ui/#changelog-display."
  ```

---

## Task 8: Add 5 AdminService projections (single commit)

**Files:**

- Modify: `srv/admin-service.cds` (append before service-block closing `}`)

- [ ] **Step 8.1: Verify service-block boundary**

  ```bash
  tail -5 srv/admin-service.cds
  ```

  File must end with the closing `}` of the service block.

- [ ] **Step 8.2: Add 5 projections**

  Use Edit. Anchor on the last line before service-block close (`entity AdvocatePhotos  as projection on ims.AdvocatePhotos;`). Insert AFTER that line, BEFORE the closing `}`:

  ```cds

    @odata.singleton @requires: 'Admin'
    entity UiEventsSettings as projection on ims.UiEventsSettings;

    @odata.singleton @requires: 'Admin'
    entity SearchSettings as projection on ims.SearchSettings;

    @odata.singleton @requires: 'Admin'
    entity NavigatorSettings as projection on ims.NavigatorSettings;

    @odata.singleton @requires: 'Admin'
    entity DisplaySettings as projection on ims.DisplaySettings;

    @odata.singleton @requires: 'Admin'
    entity TenantSettings as projection on ims.TenantSettings;
  ```

- [ ] **Step 8.3: Verify compiles**

  ```bash
  npx cds compile srv/admin-service.cds > /dev/null && echo OK
  ```

  Expected: `OK`.

- [ ] **Step 8.4: Commit**

  ```bash
  git add srv/admin-service.cds
  git commit -m "feat(srv): 5 runtime-config AdminService projections (#466)

  Phase 3 (#466). All @odata.singleton (each entity has exactly one
  row). @requires:'Admin' enforces XSUAA scope."
  ```

---

## Task 9: Create resolver lib — UiEventsSettings

**Files (CREATE):**

- `srv/lib/runtime-config/ui-events-settings.js`

- [ ] **Step 9.1: Create directory**

  ```bash
  mkdir -p srv/lib/runtime-config
  ```

  (Confirmed not to exist — pre-#471 worktree state.)

- [ ] **Step 9.2: Write the resolver**

  Write to `srv/lib/runtime-config/ui-events-settings.js`:

  ```javascript
  // srv/lib/runtime-config/ui-events-settings.js
  // Resolves the UI-events telemetry feature flag. Layered precedence:
  //   1. UiEventsSettings row via cds.entities (CAP runtime path)
  //   2. UiEventsSettings raw-SQL UPPERCASE (HANA build-pipeline path)
  //   3. process.env.UI_EVENTS_ENABLED
  //   4. Hardcoded default: enabled=false
  //
  // Inspired by srv/lib/chat-settings-resolver.js (#318). 5-second in-module
  // cache via Map+timestamp (no npm dep). Self-contained per Phase 3 spec.
  //
  // Backwards-compatible: with empty DB row, behavior is identical to the
  // current process.env.UI_EVENTS_ENABLED reads. Reverting this PR is safe.

  import cds from '@sap/cds';

  const LOG = cds.log('ui-events-settings-resolver');

  const TTL_MS = 5_000;
  let _cachedAt = 0;
  let _cached = null;

  const DEFAULTS = { enabled: false };

  async function readRow() {
    try {
      const { UiEventsSettings } = cds.entities('com.sap.developers.ims');
      return (await SELECT.one.from(UiEventsSettings)) ?? null;
    } catch (capErr) {
      try {
        const db = await cds.connect.to('db');
        const rows = await db.run(
          'SELECT enabled FROM COM_SAP_DEVELOPERS_IMS_UIEVENTSSETTINGS LIMIT 1'
        );
        return rows?.[0] ?? null;
      } catch (sqlErr) {
        LOG.warn('UiEventsSettings read failed; using env-var defaults', sqlErr.message);
        return null;
      }
    }
  }

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

  export async function resolveUiEventsSettings() {
    const now = Date.now();
    if (_cached && (now - _cachedAt) < TTL_MS) return _cached;

    const row = await readRow();
    const settings = {
      enabled: Boolean(
        pick(row, 'enabled', 'ENABLED')
        ?? envFlag('UI_EVENTS_ENABLED')
        ?? DEFAULTS.enabled
      ),
    };

    _cached = settings;
    _cachedAt = now;
    return settings;
  }

  export function _resetCacheForTests() {
    _cached = null;
    _cachedAt = 0;
  }
  ```

- [ ] **Step 9.3: Syntax check**

  ```bash
  node --check srv/lib/runtime-config/ui-events-settings.js && echo OK
  ```

- [ ] **Step 9.4: Commit**

  ```bash
  git add srv/lib/runtime-config/ui-events-settings.js
  git commit -m "feat(runtime-config): UI events settings resolver (#466)

  First of 5 Phase 3 resolvers. Mirrors kg-settings template:
  layered DB → env → default; 5s cache; Boolean coercion on the
  enabled field; pick() helper for CAP-lowercase vs HANA-UPPERCASE
  column-name handling; _resetCacheForTests for unit tests."
  ```

---

## Task 10: Create resolver lib — SearchSettings

**Files (CREATE):**

- `srv/lib/runtime-config/search-settings.js`

- [ ] **Step 10.1: Write the resolver**

  Write to `srv/lib/runtime-config/search-settings.js`:

  ```javascript
  // srv/lib/runtime-config/search-settings.js
  // Resolves the /search/* per-IP rate-limit knobs. Layered precedence:
  //   1. SearchSettings row via cds.entities
  //   2. Raw-SQL UPPERCASE fallback for build-pipeline contexts
  //   3. process.env.SEARCH_RATE_LIMIT_MAX / SEARCH_RATE_LIMIT_WINDOW_MS
  //   4. Hardcoded defaults: rateLimitMax=60, rateLimitWindowMs=60000

  import cds from '@sap/cds';

  const LOG = cds.log('search-settings-resolver');

  const TTL_MS = 5_000;
  let _cachedAt = 0;
  let _cached = null;

  const DEFAULTS = {
    rateLimitMax: 60,
    rateLimitWindowMs: 60_000,
  };

  async function readRow() {
    try {
      const { SearchSettings } = cds.entities('com.sap.developers.ims');
      return (await SELECT.one.from(SearchSettings)) ?? null;
    } catch (capErr) {
      try {
        const db = await cds.connect.to('db');
        const rows = await db.run(
          'SELECT rateLimitMax, rateLimitWindowMs FROM COM_SAP_DEVELOPERS_IMS_SEARCHSETTINGS LIMIT 1'
        );
        return rows?.[0] ?? null;
      } catch (sqlErr) {
        LOG.warn('SearchSettings read failed; using env-var defaults', sqlErr.message);
        return null;
      }
    }
  }

  function pick(row, lower, upper) {
    if (row == null) return null;
    const v = row[lower];
    if (v !== undefined && v !== null) return v;
    const u = row[upper];
    return u !== undefined && u !== null ? u : null;
  }

  function envNumber(name) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  export async function resolveSearchSettings() {
    const now = Date.now();
    if (_cached && (now - _cachedAt) < TTL_MS) return _cached;

    const row = await readRow();
    const settings = {
      rateLimitMax:
        pick(row, 'rateLimitMax', 'RATELIMITMAX')
        ?? envNumber('SEARCH_RATE_LIMIT_MAX')
        ?? DEFAULTS.rateLimitMax,
      rateLimitWindowMs:
        pick(row, 'rateLimitWindowMs', 'RATELIMITWINDOWMS')
        ?? envNumber('SEARCH_RATE_LIMIT_WINDOW_MS')
        ?? DEFAULTS.rateLimitWindowMs,
    };

    _cached = settings;
    _cachedAt = now;
    return settings;
  }

  export function _resetCacheForTests() {
    _cached = null;
    _cachedAt = 0;
  }
  ```

- [ ] **Step 10.2: Syntax check**

  ```bash
  node --check srv/lib/runtime-config/search-settings.js && echo OK
  ```

- [ ] **Step 10.3: Commit**

  ```bash
  git add srv/lib/runtime-config/search-settings.js
  git commit -m "feat(runtime-config): Search settings resolver (#466)

  Layered DB → env → default for rate-limit knobs. Defaults
  60 req/min match the existing srv/server.js literal."
  ```

---

## Task 11: Create resolver libs — Navigator + Display + Tenant (3 files, 3 commits)

The pattern is mechanical. Each follows the kg-settings shape with per-domain field lists.

**Files (CREATE):**

- `srv/lib/runtime-config/navigator-settings.js`
- `srv/lib/runtime-config/display-settings.js`
- `srv/lib/runtime-config/tenant-settings.js`

- [ ] **Step 11.1: Write `navigator-settings.js`**

  ```javascript
  // srv/lib/runtime-config/navigator-settings.js
  // Resolves the /build/navigator nested-group inclusion flag. Layered:
  //   1. NavigatorSettings row → 2. raw-SQL UPPERCASE → 3. env → 4. default false

  import cds from '@sap/cds';

  const LOG = cds.log('navigator-settings-resolver');

  const TTL_MS = 5_000;
  let _cachedAt = 0;
  let _cached = null;

  const DEFAULTS = { includeNestedGroups: false };

  async function readRow() {
    try {
      const { NavigatorSettings } = cds.entities('com.sap.developers.ims');
      return (await SELECT.one.from(NavigatorSettings)) ?? null;
    } catch (capErr) {
      try {
        const db = await cds.connect.to('db');
        const rows = await db.run(
          'SELECT includeNestedGroups FROM COM_SAP_DEVELOPERS_IMS_NAVIGATORSETTINGS LIMIT 1'
        );
        return rows?.[0] ?? null;
      } catch (sqlErr) {
        LOG.warn('NavigatorSettings read failed; using env-var defaults', sqlErr.message);
        return null;
      }
    }
  }

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

  export async function resolveNavigatorSettings() {
    const now = Date.now();
    if (_cached && (now - _cachedAt) < TTL_MS) return _cached;

    const row = await readRow();
    const settings = {
      includeNestedGroups: Boolean(
        pick(row, 'includeNestedGroups', 'INCLUDENESTEDGROUPS')
        ?? envFlag('NAV_INCLUDE_NESTED_GROUPS')
        ?? DEFAULTS.includeNestedGroups
      ),
    };

    _cached = settings;
    _cachedAt = now;
    return settings;
  }

  export function _resetCacheForTests() {
    _cached = null;
    _cachedAt = 0;
  }
  ```

  Then: `node --check srv/lib/runtime-config/navigator-settings.js && echo OK` and commit:

  ```bash
  git add srv/lib/runtime-config/navigator-settings.js
  git commit -m "feat(runtime-config): Navigator settings resolver (#466)"
  ```

- [ ] **Step 11.2: Write `display-settings.js`**

  ```javascript
  // srv/lib/runtime-config/display-settings.js
  // Resolves the dashboard URL used in contributor-notification emails.
  // Default falls back to the prod approuter URL — same literal that
  // srv/admin-service.js:791 and srv/jobs/scheduler.js:134 used pre-migration.

  import cds from '@sap/cds';

  const LOG = cds.log('display-settings-resolver');

  const TTL_MS = 5_000;
  let _cachedAt = 0;
  let _cached = null;

  const DEFAULTS = {
    dashboardUrl: 'https://tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/ui/tutorialDashboard',
  };

  async function readRow() {
    try {
      const { DisplaySettings } = cds.entities('com.sap.developers.ims');
      return (await SELECT.one.from(DisplaySettings)) ?? null;
    } catch (capErr) {
      try {
        const db = await cds.connect.to('db');
        const rows = await db.run(
          'SELECT dashboardUrl FROM COM_SAP_DEVELOPERS_IMS_DISPLAYSETTINGS LIMIT 1'
        );
        return rows?.[0] ?? null;
      } catch (sqlErr) {
        LOG.warn('DisplaySettings read failed; using env-var defaults', sqlErr.message);
        return null;
      }
    }
  }

  function pick(row, lower, upper) {
    if (row == null) return null;
    const v = row[lower];
    if (v !== undefined && v !== null) return v;
    const u = row[upper];
    return u !== undefined && u !== null ? u : null;
  }

  function envString(name) {
    const v = process.env[name];
    return v === undefined || v === '' ? null : v;
  }

  export async function resolveDisplaySettings() {
    const now = Date.now();
    if (_cached && (now - _cachedAt) < TTL_MS) return _cached;

    const row = await readRow();
    const settings = {
      dashboardUrl:
        pick(row, 'dashboardUrl', 'DASHBOARDURL')
        ?? envString('DASHBOARD_URL')
        ?? DEFAULTS.dashboardUrl,
    };

    _cached = settings;
    _cachedAt = now;
    return settings;
  }

  export function _resetCacheForTests() {
    _cached = null;
    _cachedAt = 0;
  }
  ```

  Then: `node --check srv/lib/runtime-config/display-settings.js && echo OK` and commit:

  ```bash
  git add srv/lib/runtime-config/display-settings.js
  git commit -m "feat(runtime-config): Display settings resolver (#466)

  Hardcoded default IS the literal URL formerly shared between
  admin-service.js:791 and scheduler.js:134. Single source of truth."
  ```

- [ ] **Step 11.3: Write `tenant-settings.js`** (largest — 4 fields)

  ```javascript
  // srv/lib/runtime-config/tenant-settings.js
  // Resolves the tenant-wide config bag: CORS origins, rebuild target env,
  // tech-user JSON config, tech-user mapping. Special-shape fields stored
  // as raw String/LargeString — consumers keep their existing parse logic.

  import cds from '@sap/cds';

  const LOG = cds.log('tenant-settings-resolver');

  const TTL_MS = 5_000;
  let _cachedAt = 0;
  let _cached = null;

  const DEFAULTS = {
    allowedCorsOrigins: 'http://localhost:1313,http://localhost:5000,http://localhost:4004',
    rebuildTargetEnv: 'dev',
    techUsers: '',
    techUsersMapping: '',
  };

  async function readRow() {
    try {
      const { TenantSettings } = cds.entities('com.sap.developers.ims');
      return (await SELECT.one.from(TenantSettings)) ?? null;
    } catch (capErr) {
      try {
        const db = await cds.connect.to('db');
        const rows = await db.run(
          'SELECT allowedCorsOrigins, rebuildTargetEnv, techUsers, techUsersMapping ' +
          'FROM COM_SAP_DEVELOPERS_IMS_TENANTSETTINGS LIMIT 1'
        );
        return rows?.[0] ?? null;
      } catch (sqlErr) {
        LOG.warn('TenantSettings read failed; using env-var defaults', sqlErr.message);
        return null;
      }
    }
  }

  function pick(row, lower, upper) {
    if (row == null) return null;
    const v = row[lower];
    if (v !== undefined && v !== null) return v;
    const u = row[upper];
    return u !== undefined && u !== null ? u : null;
  }

  function envString(name) {
    const v = process.env[name];
    return v === undefined || v === '' ? null : v;
  }

  export async function resolveTenantSettings() {
    const now = Date.now();
    if (_cached && (now - _cachedAt) < TTL_MS) return _cached;

    const row = await readRow();
    const settings = {
      allowedCorsOrigins:
        pick(row, 'allowedCorsOrigins', 'ALLOWEDCORSORIGINS')
        ?? envString('ALLOWED_CORS_ORIGINS')
        ?? DEFAULTS.allowedCorsOrigins,
      rebuildTargetEnv:
        pick(row, 'rebuildTargetEnv', 'REBUILDTARGETENV')
        ?? envString('REBUILD_TARGET_ENV')
        ?? DEFAULTS.rebuildTargetEnv,
      techUsers:
        pick(row, 'techUsers', 'TECHUSERS')
        ?? envString('TECH_USERS')
        ?? DEFAULTS.techUsers,
      techUsersMapping:
        pick(row, 'techUsersMapping', 'TECHUSERSMAPPING')
        ?? envString('TECH_USERS_MAPPING')
        ?? DEFAULTS.techUsersMapping,
    };

    _cached = settings;
    _cachedAt = now;
    return settings;
  }

  export function _resetCacheForTests() {
    _cached = null;
    _cachedAt = 0;
  }
  ```

  Then: `node --check srv/lib/runtime-config/tenant-settings.js && echo OK` and commit:

  ```bash
  git add srv/lib/runtime-config/tenant-settings.js
  git commit -m "feat(runtime-config): Tenant settings resolver (#466)

  4-field resolver: allowedCorsOrigins, rebuildTargetEnv, techUsers,
  techUsersMapping. LargeString fields stored raw; consumers keep
  existing parse logic. Default CORS allowlist matches the literal
  formerly in srv/server.js:108. Default rebuildTargetEnv='dev'
  matches the formerly module-load _state.environment fallback."
  ```

---

## Task 12: Unit tests for 5 resolvers (5 files, 5 commits — 1 per file)

**TDD note:** Tests follow Tasks 9-11 because each resolver is a translation of an established spec — no design exploration to drive with red tests. Tests lock in the per-domain field semantics and TTL behavior.

**Files (CREATE):**

- `test/unit/runtime-config/ui-events-settings.test.js` (5 tests)
- `test/unit/runtime-config/search-settings.test.js` (6 tests)
- `test/unit/runtime-config/navigator-settings.test.js` (5 tests)
- `test/unit/runtime-config/display-settings.test.js` (5 tests)
- `test/unit/runtime-config/tenant-settings.test.js` (7 tests)

Total: 28 tests across 5 files.

- [ ] **Step 12.1: Create test directory + verify bootstrap pattern**

  ```bash
  mkdir -p test/unit/runtime-config
  head -30 test/unit/chat-settings-resolver.test.js
  ```

  Confirm the `cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:')` pattern.

- [ ] **Step 12.2: Write `ui-events-settings.test.js`** (5 tests)

  Mirrors `test/unit/chat-settings-resolver.test.js` shape. Tests:

  1. Hardcoded default false when DB empty + env unset.
  2. Falls through to env var when DB row absent.
  3. DB row wins over env var (admin override).
  4. Caches reads within 5s TTL (mutation invisible until reset).
  5. Cache reset returns fresh row.

  Run `npx vitest run test/unit/runtime-config/ui-events-settings.test.js` — expect 5/5. Commit:

  ```bash
  git add test/unit/runtime-config/ui-events-settings.test.js
  git commit -m "test(unit): UiEventsSettings resolver coverage (#466)"
  ```

- [ ] **Step 12.3: Write `search-settings.test.js`** (6 tests)

  Same shape + a 6th: `rateLimitMax = 0` is preserved (allowed by `@assert.range: [0, 100000]`; effectively disables search). 2 fields tested. Run + commit.

- [ ] **Step 12.4: Write `navigator-settings.test.js`** (5 tests)

  Same shape as ui-events. Substitute names. Run + commit.

- [ ] **Step 12.5: Write `display-settings.test.js`** (5 tests)

  String field (not Boolean). Default URL when both DB + env absent equals the resolver's hardcoded URL. Run + commit.

- [ ] **Step 12.6: Write `tenant-settings.test.js`** (7 tests)

  4 fields × precedence tests + 1 LargeString-roundtrip test (insert a 5000-char string, read back, verify no truncation):

  ```javascript
  it('LargeString roundtrip — 5000-char value not truncated', async () => {
    const { TenantSettings } = cds.entities('com.sap.developers.ims');
    const longCsv = Array.from({ length: 200 }, (_, i) => `http://origin-${i}.example.com`).join(',');
    await INSERT.into(TenantSettings).entries({
      ID: 'ee000000-0000-0000-0000-000000000001',
      allowedCorsOrigins: longCsv,
    });
    _resetCacheForTests();
    const s = await resolveTenantSettings();
    expect(s.allowedCorsOrigins.length).toBeGreaterThan(5000);
    expect(s.allowedCorsOrigins).toBe(longCsv);
  });
  ```

  Plus 6 standard tests (defaults, env fallback, DB wins per field). Run + commit.

- [ ] **Step 12.7: Run all 5 test files together**

  ```bash
  npx vitest run test/unit/runtime-config/ 2>&1 | tail -15
  ```

  Expected: 28/28 pass.

  **Note:** the actual test code for each file follows the kg-settings template at `test/unit/runtime-config/kg-settings.test.js` (already in main, post-#471). Implementer subagent reads that file first, then drops in domain-specific field names + tests.

---

## Task 13: Convert UI-Events consumer (`srv/lib/ui-event-handler.js`)

**Files:**

- Modify: `srv/lib/ui-event-handler.js` — async-ify `handleUIEvent()`; replace `_state.enabled` boot-snapshot with resolver call.

**⚠️ Plan-vs-spec correction:** the spec called the consumer function `recordEvent()`. The actual exported function is **`handleUIEvent`** (line 75). The spec inherited the wrong name. This task uses the correct name.

There are also **two `_state.enabled` reads** in the file:

- Line 37 in `checkFeatureFlag()` — sync exported function called from `srv/server.js:399` for boot-time logging.
- Line 76 in `handleUIEvent` — the per-request gate.

Both need conversion. Plan handles each below.

- [ ] **Step 13.1: Read current state**

  ```bash
  sed -n '1,45p' srv/lib/ui-event-handler.js
  sed -n '70,110p' srv/lib/ui-event-handler.js
  grep -n '_state\.enabled\|handleUIEvent\|checkFeatureFlag' srv/lib/ui-event-handler.js
  ```

  Confirm: line 20 (`_state` literal with `enabled`), line 37 (`checkFeatureFlag` reads `_state.enabled`), line 75 (`export async function handleUIEvent`), line 76 (gate inside `handleUIEvent`).

- [ ] **Step 13.2: Add resolver import** at top of file:

  ```javascript
  import { resolveUiEventsSettings } from './runtime-config/ui-events-settings.js';
  ```

- [ ] **Step 13.3: Drop `enabled` from `_state` initializer**

  ```javascript
  let _state = {
    insertFn: defaultInsert,
  }
  ```

- [ ] **Step 13.4: Convert the gate inside `handleUIEvent` (around line 76)**

  Replace `if (!_state.enabled) { ... }` with:

  ```javascript
  const { enabled } = await resolveUiEventsSettings();
  if (!enabled) {
    // ...self-disable logic UNCHANGED
  }
  ```

  `handleUIEvent` is already declared `async` (line 75: `export async function handleUIEvent`).

- [ ] **Step 13.5: Convert `checkFeatureFlag` boot-time gate (line 36-40)**

  `checkFeatureFlag()` is exported and called from `srv/server.js:399` at server boot for logging. It reads `_state.enabled` synchronously. Two options:

  **Option A (recommended): drop the boot warning** — the resolver-based gate inside `handleUIEvent` is sufficient; the boot warning is non-critical UX. Replace `checkFeatureFlag`'s body with a no-op stub that logs a generic message:

  ```javascript
  export function checkFeatureFlag() {
    console.log('[ui-event] UI events handler loaded. Feature flag resolved per-request from UiEventsSettings + env var fallback.');
  }
  ```

  **Option B: async-ify `checkFeatureFlag`** — convert to `export async function checkFeatureFlag()`, await the resolver, propagate `await` to the caller in `srv/server.js:399`. More invasive.

  Plan ships **Option A** (simpler; preserves the original "this loaded" log signal without a behavior-tied check at boot).

- [ ] **Step 13.6: Audit `_resetForTests` if it sets `enabled`**

  ```bash
  grep -n '_resetForTests\|setEnabled' srv/lib/ui-event-handler.js
  ```

  If `_resetForTests` accepts an `enabled` argument, drop it (resolver is source of truth now).

- [ ] **Step 13.7: Update existing tests**

  ```bash
  ls srv/lib/__tests__/ui-event-handler.test.js 2>&1
  ```

  If test file exists, replace any `_resetForTests({ enabled: ... })` calls with `vi.spyOn` of `resolveUiEventsSettings`. Run tests.

- [ ] **Step 13.8: Commit**

  ```bash
  git add srv/lib/ui-event-handler.js srv/lib/__tests__/ui-event-handler.test.js 2>/dev/null || git add srv/lib/ui-event-handler.js
  git commit -m "feat(ui-events): use resolver instead of module-load env snapshot (#466)

  Behavior change: recordEvent() is now async-resolver-gated.
  _state.enabled boot-time capture removed. Flag-flips propagate
  within 5s TTL instead of requiring 'cf restart'."
  ```

---

## Task 14: Convert Search rate-limiter consumer (`srv/server.js`)

**Files:**

- Modify: `srv/server.js:319-323` (rate-limiter init).

- [ ] **Step 14.1: Read current state**

  ```bash
  sed -n '315,330p' srv/server.js
  ```

- [ ] **Step 14.2: Add resolver import** at top of `srv/server.js`:

  ```javascript
  import { resolveSearchSettings } from './lib/runtime-config/search-settings.js';
  ```

- [ ] **Step 14.3: Replace boot-time init with lazy + cached**

  Replace lines 319-323 with:

  ```javascript
  // Phase 3 (#466): Lazy rate-limiter — resolver returns DB-backed values
  // (with 5s cache). Counter resets on rebuild within the cache window.
  // Documented in PR body as bounded surface widening (~120 req/10s burst).
  let _cachedLimiter = null;
  let _cachedLimiterAt = 0;
  const LIMITER_TTL_MS = 5_000;

  async function getSearchLimiter() {
    const now = Date.now();
    if (_cachedLimiter && (now - _cachedLimiterAt) < LIMITER_TTL_MS) return _cachedLimiter;
    const { rateLimitMax, rateLimitWindowMs } = await resolveSearchSettings();
    _cachedLimiter = createIpRateLimiter({ windowMs: rateLimitWindowMs, max: rateLimitMax });
    _cachedLimiterAt = now;
    return _cachedLimiter;
  }

  app.use('/search', async (req, res, next) => {
    const limiter = await getSearchLimiter();
    return ipRateLimitMiddleware(limiter, { logName: 'search-rate-limit' })(req, res, next);
  });
  ```

  **Optimization note:** if `ipRateLimitMiddleware(limiter, ...)` is more than a thin closure, cache the constructed middleware in `_cachedLimiter`'s sibling slot. Plan ships the simple version first; profile only if needed.

- [ ] **Step 14.4: Syntax check**

  ```bash
  node --check srv/server.js && echo OK
  ```

- [ ] **Step 14.5: Commit**

  ```bash
  git add srv/server.js
  git commit -m "feat(search): use resolver for rate-limit settings (#466)

  Behavior change: rate-limiter is rebuilt every ~5s (resolver TTL),
  which resets internal counters. Effectively allows ~120 req per
  10s window vs documented 60/min cap. Acceptable for accidental-
  abuse defense — the rate-limiter's actual purpose. Documented
  in PR body and Search admin-tile MessageStrip."
  ```

---

## Task 15: Convert CORS allowlist consumer (`srv/server.js:107-130`)

**Files:**

- Modify: `srv/server.js:107-130` (CORS Set + middleware).

- [ ] **Step 15.1: Read full middleware context**

  ```bash
  sed -n '95,135p' srv/server.js
  ```

  Read every header/preflight branch BEFORE replacing — preserve all behavior.

- [ ] **Step 15.2: Add resolver import** (already added in Task 14 if same file; if not):

  ```javascript
  import { resolveTenantSettings } from './lib/runtime-config/tenant-settings.js';
  ```

- [ ] **Step 15.3: Replace boot-time Set with per-request resolver call**

  Find `const ALLOWED_CORS_ORIGINS = new Set(...)` block + the `app.use((req, res, next) => { ... })` middleware. Replace BOTH with one async middleware:

  ```javascript
  // Phase 3 (#466): CORS allowlist resolved per-request from TenantSettings
  // (resolver caches the underlying string for 5s, so the new Set() cost is
  // microseconds × ~once-per-5s × N requests).
  app.use(async (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      const { allowedCorsOrigins } = await resolveTenantSettings();
      const allowed = new Set(
        allowedCorsOrigins.split(',').map(s => s.trim()).filter(Boolean)
      );
      if (allowed.has(origin)) {
        // ...preserve every header from the original middleware
      }
    }
    next();
  });
  ```

  **CRITICAL:** preserve EVERY header / OPTIONS / preflight response in the original middleware. The example skeleton above is illustrative.

- [ ] **Step 15.4: Syntax check**

  ```bash
  node --check srv/server.js && echo OK
  ```

- [ ] **Step 15.5: Commit**

  ```bash
  git add srv/server.js
  git commit -m "feat(tenant): CORS allowlist via resolver (#466)

  Set rebuilt per-request (resolver caches underlying string for 5s).
  Hardcoded localhost fallback moved into the resolver's
  DEFAULTS.allowedCorsOrigins — middleware no longer carries fallback
  logic."
  ```

---

## Task 16: Convert Navigator consumer (`srv/lib/navigator-catalog.js`)

**Files:**

- Modify: `srv/lib/navigator-catalog.js:19-21` (helper) + `:189` (caller).

- [ ] **Step 16.1: Read current state**

  ```bash
  sed -n '15,25p' srv/lib/navigator-catalog.js
  sed -n '185,195p' srv/lib/navigator-catalog.js
  ```

- [ ] **Step 16.2: Add resolver import:**

  ```javascript
  import { resolveNavigatorSettings } from './runtime-config/navigator-settings.js';
  ```

- [ ] **Step 16.3: Async-ify `shouldIncludeNestedGroups`**

  Replace lines 19-21:

  ```javascript
  async function shouldIncludeNestedGroups() {
    return (await resolveNavigatorSettings()).includeNestedGroups;
  }
  ```

- [ ] **Step 16.4: Add `await` at line 189 caller**

  ```javascript
  if ((await shouldIncludeNestedGroups()) && !groupRefs.find(g => g.id === group.legacyId)) {
  ```

  Verify enclosing function is async. Look back from line 189 to nearest `function`/`=>` declaration. If not async, mark it async and propagate to callers.

- [ ] **Step 16.5: Syntax check + run tests**

  ```bash
  node --check srv/lib/navigator-catalog.js && echo OK
  ls srv/lib/__tests__/navigator-catalog.test.js 2>&1
  npx vitest run srv/lib/__tests__/navigator-catalog.test.js 2>&1 | tail -10
  ```

  If tests exist and fail because they call `shouldIncludeNestedGroups()` synchronously, update them.

- [ ] **Step 16.6: Commit**

  ```bash
  git add srv/lib/navigator-catalog.js srv/lib/__tests__/navigator-catalog.test.js 2>/dev/null || git add srv/lib/navigator-catalog.js
  git commit -m "feat(navigator): use resolver for includeNestedGroups (#466)

  shouldIncludeNestedGroups() is now async (resolver call). Caller
  at line 189 awaits. Enclosing function confirmed async."
  ```

---

## Task 17: Convert Display consumer — TWO files (`srv/admin-service.js:791` + `srv/jobs/scheduler.js:134`)

**Files:**

- Modify: `srv/admin-service.js:791` (1 line)
- Modify: `srv/jobs/scheduler.js:134` (1 line)

Both files have identical `process.env.DASHBOARD_URL || '...prod-URL...'` patterns. The hardcoded fallback URL moves into the resolver's `DEFAULTS.dashboardUrl` — both consumers become 1-liner resolver calls.

- [ ] **Step 17.1: Update `srv/admin-service.js:791`**

  Add import:

  ```javascript
  import { resolveDisplaySettings } from './lib/runtime-config/display-settings.js';
  ```

  Replace line 791:

  ```javascript
  const { dashboardUrl } = await resolveDisplaySettings();
  ```

  Verify enclosing function is async (search backward for nearest `async function` / `async (req)`).

- [ ] **Step 17.2: Update `srv/jobs/scheduler.js:134`**

  Add import:

  ```javascript
  import { resolveDisplaySettings } from '../lib/runtime-config/display-settings.js';
  ```

  Replace line 134 with the same shape. Verify enclosing function is async.

- [ ] **Step 17.3: Syntax check both files**

  ```bash
  node --check srv/admin-service.js && echo OK_AS
  node --check srv/jobs/scheduler.js && echo OK_SCHED
  ```

- [ ] **Step 17.4: Commit (single commit, both files)**

  ```bash
  git add srv/admin-service.js srv/jobs/scheduler.js
  git commit -m "feat(display): use resolver for dashboardUrl (#466)

  Both consumers (admin-service.js + scheduler.js) had identical
  hardcoded fallback URLs. Fallback moves into the resolver's
  DEFAULTS.dashboardUrl — single source of truth."
  ```

---

## Task 18: Convert REBUILD_TARGET_ENV consumer + async-ify scheduleRebuild (`srv/lib/rebuild-trigger.js` + 2 callers)

**Files:**

- Modify: `srv/lib/rebuild-trigger.js` — drop `_state.environment`; async-ify `scheduleRebuild()`.
- Modify: `srv/server.js:370` (1 production caller).
- Modify: `srv/lib/__tests__/rebuild-trigger.test.js` (13 callers + `_resetForTests` semantics).

This is the largest consumer-conversion task — 3 files, ~30-40 line test diff.

- [ ] **Step 18.1: Read current state**

  ```bash
  sed -n '15,90p' srv/lib/rebuild-trigger.js
  ```

  Confirm:
  - Line 22-26: `_state.environment` initializer
  - Line 53: `export function scheduleRebuild(reason)` (sync)
  - Line 68: dispatch uses `environment: _state.environment`
  - Line 84: console.log references `_state.environment`

- [ ] **Step 18.2: Add resolver import**

  ```javascript
  import { resolveTenantSettings } from './runtime-config/tenant-settings.js';
  ```

- [ ] **Step 18.3: Drop `environment` from `_state`**

  Edit `_state` initializer to drop the line `environment: process.env.REBUILD_TARGET_ENV ?? 'dev',`.

- [ ] **Step 18.4: Async-ify `scheduleRebuild`**

  Change signature to `export async function scheduleRebuild(reason)`. Inside, BEFORE the `_state.dispatchFn(...)` call, add:

  ```javascript
  const { rebuildTargetEnv } = await resolveTenantSettings();
  ```

  Replace `_state.environment` references with `rebuildTargetEnv`.

  **Boot-time `console.log` at line 83 (inside `checkFeatureFlag`):**

  Currently:

  ```javascript
  console.log(`[rebuild-trigger] active — admin writes will dispatch with environment='${_state.environment}'.`)
  ```

  `checkFeatureFlag` is exported and called from `srv/server.js:396` at boot. Two options:

  **Plan ships Option A: drop the env-name from the message.** The log signal "rebuild-trigger active" remains; the env-name was nice-to-have. Replace the line with:

  ```javascript
  console.log('[rebuild-trigger] active — admin writes will dispatch (target env resolved per-call from TenantSettings).')
  ```

  No change to `checkFeatureFlag`'s sync signature; no change at the caller in `srv/server.js:396`.

  **Option B (rejected for simplicity):** convert `checkFeatureFlag` to async, await the resolver, propagate `await` to the caller in `srv/server.js:396`. More invasive than Option A and the env-name is non-critical.

- [ ] **Step 18.5: Update production caller in `srv/server.js:370`**

  ```bash
  sed -n '365,378p' srv/server.js
  ```

  The caller wraps `scheduleRebuild('admin-write')` in `try/catch`. After async-ification:

  ```javascript
  // Before:
  try {
    scheduleRebuild('admin-write');
  } catch (err) {
    console.error('[rebuild-trigger] scheduling failed', err);
  }

  // After:
  scheduleRebuild('admin-write').catch(err => {
    console.error('[rebuild-trigger] scheduling failed', err);
  });
  ```

  Preserves fire-and-forget but catches async errors.

- [ ] **Step 18.6: Update 13 test callers in `srv/lib/__tests__/rebuild-trigger.test.js`**

  Each `scheduleRebuild('admin-write')` becomes `await scheduleRebuild('admin-write')`. The `_resetForTests({ environment: 'qa' })` injection no longer works — replace with resolver mocking via `vi.spyOn`:

  ```javascript
  // At top of file:
  import * as tenantResolver from '../runtime-config/tenant-settings.js'

  // Replace _resetForTests({...environment: 'qa'}) with:
  _resetForTests({ dispatchFn: dispatch, debounceMs: 60_000, token: 'fake-token' })
  vi.spyOn(tenantResolver, 'resolveTenantSettings').mockResolvedValue({
    allowedCorsOrigins: '',
    rebuildTargetEnv: 'qa',
    techUsers: '',
    techUsersMapping: '',
  })

  // afterEach:
  vi.restoreAllMocks()
  ```

  Scope: ~30-40 line test diff (13 await additions + 3-4 environment-injection replacements + import + afterEach).

- [ ] **Step 18.7: Run tests**

  ```bash
  npx vitest run srv/lib/__tests__/rebuild-trigger.test.js 2>&1 | tail -15
  ```

  Expected: all pass. If a race surfaces (resolver mock not returning before `vi.advanceTimersByTimeAsync`), use `await Promise.resolve()` or flushPromises.

- [ ] **Step 18.8: Commit**

  ```bash
  git add srv/lib/rebuild-trigger.js srv/lib/__tests__/rebuild-trigger.test.js srv/server.js
  git commit -m "feat(rebuild-trigger): use resolver for REBUILD_TARGET_ENV (#466)

  Behavior change: scheduleRebuild() is now async. Production caller
  in srv/server.js:370 changed from try/catch to .catch() chain
  (preserves fire-and-forget; catches async errors).

  Test refactor: 13 callers in __tests__/rebuild-trigger.test.js
  await scheduleRebuild(). _resetForTests({environment}) injection
  pattern replaced with vi.spyOn(tenantResolver, ...).mockResolvedValue
  — the resolver is the source of truth now."
  ```

---

## Task 19: Convert TECH_USERS consumer (`srv/lib/tech-user-auth.js`)

**Files:**

- Modify: `srv/lib/tech-user-auth.js` — async-ify `loadTechUsers()` and `loadTechUserMapping()`.

- [ ] **Step 19.1: Read current state**

  ```bash
  sed -n '1,80p' srv/lib/tech-user-auth.js
  ```

- [ ] **Step 19.2: Add resolver import**

  ```javascript
  import { resolveTenantSettings } from './runtime-config/tenant-settings.js';
  ```

- [ ] **Step 19.3: Async-ify `loadTechUsers()` and `loadTechUserMapping()`**

  ```javascript
  // Before:
  function loadTechUsers() {
    if (techUsers !== null) return techUsers;
    const raw = process.env.TECH_USERS;
    // ...
  }

  // After:
  async function loadTechUsers() {
    if (techUsers !== null) return techUsers;
    const { techUsers: raw } = await resolveTenantSettings();
    // ...rest UNCHANGED
  }
  ```

  Same shape for `loadTechUserMapping()`.

- [ ] **Step 19.4: Update internal callers (lines 46, 64) — and async-ify the enclosing middleware**

  ```javascript
  const users = await loadTechUsers();
  const mapping = await loadTechUserMapping();
  ```

  **The enclosing function is `basicAuthMiddleware` (line 42)**, an exported sync Express middleware. After async-ification of `loadTechUsers`/`loadTechUserMapping`, the middleware itself MUST be async:

  ```javascript
  // Before:
  export function basicAuthMiddleware(req, res, next) {
    // ...
  }

  // After:
  export async function basicAuthMiddleware(req, res, next) {
    // ...
  }
  ```

  Express handles async middleware natively (errors propagate via `next(err)` if thrown). No call-site change needed at the registration point in `srv/server.js` — `app.use(basicAuthMiddleware)` works the same for sync and async middleware.

- [ ] **Step 19.5: Find external callers**

  ```bash
  grep -rn 'loadTechUsers\|loadTechUserMapping\|tech-user-auth' srv/ test/ 2>/dev/null
  ```

  Update each external caller to `await`. List in commit message.

- [ ] **Step 19.6: Run tests**

  ```bash
  ls srv/lib/__tests__/tech-user-auth.test.js 2>&1
  npx vitest run srv/lib/__tests__/tech-user-auth.test.js 2>&1 | tail -10
  ```

  If tests exist, they may need resolver mocking similar to Task 18.6.

- [ ] **Step 19.7: Commit**

  ```bash
  git add srv/lib/tech-user-auth.js srv/lib/__tests__/tech-user-auth.test.js 2>/dev/null || git add srv/lib/tech-user-auth.js
  git commit -m "feat(tenant): use resolver for TECH_USERS + TECH_USERS_MAPPING (#466)

  loadTechUsers() and loadTechUserMapping() are now async (resolver
  call). Module-level cache (techUsers / mapping vars) preserved —
  the resolver itself caches for 5s but the per-module memoization
  avoids re-parsing JSON on every call."
  ```

---

## Task 20: Create 5 admin tiles (5 packages × 6 files = 30 files; 5 commits)

**Files (CREATE):** 5 packages under `app/admin/`. Each package has 6 files matching the `app/admin/joule/` precedent.

For each domain (uiEvents, search, navigator, display, tenant), implementer subagent:

1. Reads `app/admin/joule/webapp/` to confirm structure (manifest.json, Component.js, index.html, view/Settings.view.xml, controller/Settings.controller.js, i18n/i18n.properties).
2. Creates the new package mirroring Joule's shape with domain-specific substitutions:
   - `sap.tutorials.admin.joule` → `sap.tutorials.admin.<domain>`
   - View fields per the spec's Section 5
   - Per-domain MessageStrip text per the spec
   - Save button always enabled (no dirty-flag tracking — Joule pattern)
   - CSRF round-trip via HEAD `/admin/$metadata` before PATCH

The 5 sub-tasks below summarize the per-tile work. Each subagent executes one tile end-to-end (create directory → 6 files → manifest validation → commit) before the next.

- [ ] **Step 20.1: UI Events tile** (`app/admin/uiEvents/webapp/`)

  1 field (Switch). MessageStrip: `"Telemetry endpoint gate. When OFF, /api/ui-events accepts the POST but silently drops the row (request still 204s). Changes propagate within 5 seconds across all server instances."`. Endpoint: `/admin/UiEventsSettings` (singleton). Run `mcp__plugin_ui5_ui5-mcp-server__run_manifest_validation` against the manifest. Commit:

  ```bash
  git add app/admin/uiEvents/
  git commit -m "feat(admin): UI Events admin tile (#466)"
  ```

- [ ] **Step 20.2: Search tile** (`app/admin/search/webapp/`)

  2 fields (Number × 2). MessageStrip per the spec mentions the security trade-off. Run manifest validation. Commit:

  ```bash
  git add app/admin/search/
  git commit -m "feat(admin): Search admin tile (#466)"
  ```

- [ ] **Step 20.3: Navigator tile** (`app/admin/navigator/webapp/`)

  1 field (Switch). MessageStrip mentions `~65 extra cards on dev`. Run validation. Commit:

  ```bash
  git add app/admin/navigator/
  git commit -m "feat(admin): Navigator admin tile (#466)"
  ```

- [ ] **Step 20.4: Display tile** (`app/admin/display/webapp/`)

  1 field (Input — URL). Placeholder text uses the actual prod approuter URL. Run validation. Commit:

  ```bash
  git add app/admin/display/
  git commit -m "feat(admin): Display admin tile (#466)"
  ```

- [ ] **Step 20.5: Tenant tile** (`app/admin/tenant/webapp/`)

  4 fields: 3 TextArea (LargeString) + 1 ComboBox for `rebuildTargetEnv` with dev/qa/prod options. ComboBox is the only validation point for the enum (DB is unconstrained `String(10)` — deliberate). Run validation. Commit:

  ```bash
  git add app/admin/tenant/
  git commit -m "feat(admin): Tenant admin tile (#466)

  4-field tile with 3 LargeString textareas + 1 ComboBox for
  rebuildTargetEnv. ComboBox is the only enum-enforcement point
  (DB is unconstrained String(10)). Direct OData PATCH bypasses
  validation by design."
  ```

---

## Task 21: Admin-shell wiring — copy-components.js + manifest.json (5 entries × 4 blocks)

**Files:**

- Modify: `app/admin-shell/scripts/copy-components.js` (5 entries to COMPONENTS array)
- Modify: `app/admin-shell/webapp/manifest.json` (5 sub-entries × 4 blocks = 20 entries)

- [ ] **Step 21.1: Append 5 entries to COMPONENTS array**

  Open `app/admin-shell/scripts/copy-components.js`. Find the `COMPONENTS` array (lines 8-25). Append the 5 entries at the end of the array (order doesn't matter):

  ```javascript
  'uiEvents',
  'search',
  'navigator',
  'display',
  'tenant',
  ```

- [ ] **Step 21.2: Add `resourceRoots` entries** in manifest

  Find the `resourceRoots` block. Add 5 entries:

  ```json
  "sap.tutorials.admin.uiEvents":  "./components/uiEvents",
  "sap.tutorials.admin.search":    "./components/search",
  "sap.tutorials.admin.navigator": "./components/navigator",
  "sap.tutorials.admin.display":   "./components/display",
  "sap.tutorials.admin.tenant":    "./components/tenant"
  ```

  **Run `mcp__plugin_ui5_ui5-mcp-server__run_manifest_validation`** against the manifest. Expect ✅.

- [ ] **Step 21.3: Add `componentUsages` entries**

  Find the `componentUsages` block. Add 5 entries (each follows the `jouleSettingsComponent` shape):

  ```json
  "uiEventsSettingsComponent": { "name": "sap.tutorials.admin.uiEvents", "settings": {}, "componentData": {}, "lazy": true },
  "searchSettingsComponent": { "name": "sap.tutorials.admin.search", "settings": {}, "componentData": {}, "lazy": true },
  "navigatorSettingsComponent": { "name": "sap.tutorials.admin.navigator", "settings": {}, "componentData": {}, "lazy": true },
  "displaySettingsComponent": { "name": "sap.tutorials.admin.display", "settings": {}, "componentData": {}, "lazy": true },
  "tenantSettingsComponent": { "name": "sap.tutorials.admin.tenant", "settings": {}, "componentData": {}, "lazy": true }
  ```

  **Run manifest validation again.** Fix any JSON syntax errors before continuing.

- [ ] **Step 21.4: Add `targets` entries** (5 new targets, each with unique prefix)

  Verify prefixes `ue / sr / nv / dp / tn` are not already in use:

  ```bash
  grep -E '"prefix":\s*"(ue|sr|nv|dp|tn)"' app/admin-shell/webapp/manifest.json
  ```

  Expected: empty. If a collision is found, choose alternatives.

  Add 5 target entries:

  ```json
  "uiEventsSettingsTarget":  { "type": "Component", "usage": "uiEventsSettingsComponent",  "id": "uiEventsSettingsTarget",  "viewLevel": 1, "prefix": "ue" },
  "searchSettingsTarget":    { "type": "Component", "usage": "searchSettingsComponent",    "id": "searchSettingsTarget",    "viewLevel": 1, "prefix": "sr" },
  "navigatorSettingsTarget": { "type": "Component", "usage": "navigatorSettingsComponent", "id": "navigatorSettingsTarget", "viewLevel": 1, "prefix": "nv" },
  "displaySettingsTarget":   { "type": "Component", "usage": "displaySettingsComponent",   "id": "displaySettingsTarget",   "viewLevel": 1, "prefix": "dp" },
  "tenantSettingsTarget":    { "type": "Component", "usage": "tenantSettingsComponent",    "id": "tenantSettingsTarget",    "viewLevel": 1, "prefix": "tn" }
  ```

  **Run manifest validation again.**

- [ ] **Step 21.5: Add `routes` entries**

  Find the `routes` array. Append 5 entries:

  ```json
  { "name": "uiEvents",  "pattern": "uiEvents",  "target": [{ "name": "uiEventsSettingsTarget",  "prefix": "ue" }] },
  { "name": "search",    "pattern": "search",    "target": [{ "name": "searchSettingsTarget",    "prefix": "sr" }] },
  { "name": "navigator", "pattern": "navigator", "target": [{ "name": "navigatorSettingsTarget", "prefix": "nv" }] },
  { "name": "display",   "pattern": "display",   "target": [{ "name": "displaySettingsTarget",   "prefix": "dp" }] },
  { "name": "tenant",    "pattern": "tenant",    "target": [{ "name": "tenantSettingsTarget",    "prefix": "tn" }] }
  ```

  **Run manifest validation a final time.** Expect ✅.

- [ ] **Step 21.6: Build admin-shell + verify all 5 components copied**

  ```bash
  npm --prefix app/admin-shell run build 2>&1 | tail -30
  ls app/admin-shell/dist/components/ | grep -E '(uiEvents|search|navigator|display|tenant)'
  ```

  Expected: build succeeds; 5 directories listed.

- [ ] **Step 21.7: Commit**

  ```bash
  git add app/admin-shell/scripts/copy-components.js app/admin-shell/webapp/manifest.json
  git commit -m "feat(admin-shell): wire 5 runtime-config tiles into manifest (#466)

  20 manifest entries across 4 blocks (resourceRoots, componentUsages,
  targets, routes) + 5 entries in copy-components.js COMPONENTS array.
  All 5 prefix codes (ue/sr/nv/dp/tn) verified unique.

  Manifest validation ran after each block addition (4 validation
  runs total) to catch JSON syntax errors early."
  ```

---

## Task 22: Admin-shell wiring — Shell.view.xml (new "Runtime Settings" peer-group)

**Files:**

- Modify: `app/admin-shell/webapp/view/Shell.view.xml`

**Worktree-state note:** This worktree branched before #471/#482. Knowledge Graph + Secrets entries do NOT exist in this Shell.view.xml. The new "Runtime Settings" group only contains the 5 NEW tiles. **If this PR rebases onto post-#471/#482 main during review, a follow-up commit relocates KG + Secrets into this group.**

- [ ] **Step 22.1: Read current Shell.view.xml structure**

  ```bash
  grep -n 'tnt:NavigationListItem\|System' app/admin-shell/webapp/view/Shell.view.xml | head -25
  ```

  Confirm the System group is around line 105 ending with `</tnt:NavigationListItem>`.

- [ ] **Step 22.2: Insert new "Runtime Settings" peer-group AFTER System closing tag**

  Use Edit. Find the System group's closing `</tnt:NavigationListItem>` (after the `Privacy` entry). Insert AFTER it:

  ```xml
  <tnt:NavigationListItem text="Runtime Settings" icon="sap-icon://settings" expanded="{viewModel>/groupExpanded/runtimeSettings}">
    <tnt:NavigationListItem text="UI Events" key="uiEvents" />
    <tnt:NavigationListItem text="Search" key="search" />
    <tnt:NavigationListItem text="Navigator" key="navigator" />
    <tnt:NavigationListItem text="Display" key="display" />
    <tnt:NavigationListItem text="Tenant" key="tenant" />
  </tnt:NavigationListItem>
  ```

  **Note:** the spec showed 7 children (KG + Secrets relocated in). This worktree has neither in Shell.view.xml, so the new group only has 5 children. Sort order matches spec (UI Events → Tenant). KG + Secrets get added in a rebase-conflict resolution commit when the PR rebases onto main.

  **Default expanded state:** the spec said "Default collapsed." Actual project convention is **default expanded** (every other group's `_loadGroupExpanded()` default is `true`). The `expanded="{viewModel>/groupExpanded/runtimeSettings}"` binding will resolve to `true` after Task 23.2 appends `"runtimeSettings"` to `NAV_GROUP_KEYS`. Plan ships default-expanded for consistency.

- [ ] **Step 22.3: Verify XML well-formed**

  ```bash
  node -e "const fs = require('fs'); const xml = fs.readFileSync('app/admin-shell/webapp/view/Shell.view.xml', 'utf8'); console.log('lines:', xml.split('\n').length); /* basic check */"
  ```

  Or via UI5 manifest validation tool. Confirm no orphan opening tags.

- [ ] **Step 22.4: Commit**

  ```bash
  git add app/admin-shell/webapp/view/Shell.view.xml
  git commit -m "feat(admin-shell): new 'Runtime Settings' peer-group with 5 tiles (#466)

  New nav-group as a PEER of System (not child — UI5 NavigationList
  doesn't render 3-level hierarchies cleanly). Default collapsed.

  Worktree branched pre-#471/#482, so KG + Secrets entries are NOT
  yet in this view. They get added to this group in the rebase-
  conflict resolution commit when the PR rebases onto main.

  All 5 child labels are hardcoded XML strings, deliberately
  consistent with the existing nav-item label pattern. i18n
  migration is a separate cleanup PR (out of scope #466)."
  ```

---

## Task 23: Admin-shell wiring — Shell.controller.js (NAV_GROUP_KEYS array + NAV maps × 2)

**Files:**

- Modify: `app/admin-shell/webapp/controller/Shell.controller.js`

**⚠️ Plan-vs-spec correction:** the spec said "find the `groupExpanded: { content: false, rewards: false, ... }` literal in onInit." The actual code uses an **array** `NAV_GROUP_KEYS = ["content", "rewards", "feedback", "reporting", "system"]` (line 63), and `_loadGroupExpanded()` iterates the array setting each key to **`true`** (default expanded, not collapsed). The spec inherited the wrong structure description.

3 changes: (a) append `"runtimeSettings"` to `NAV_GROUP_KEYS`; (b) 5 NAV_KEY_TO_ROUTE entries; (c) 5 NAV_KEY_TO_TITLE entries.

**Default expanded state:** the existing convention is `true` (expanded). The spec's "default collapsed" framing is therefore inconsistent with project convention. **Plan ships default-expanded** (matching every other group). Tom can collapse manually via the side-nav UI; localStorage persistence preserves the choice across reloads.

- [ ] **Step 23.1: Read current state**

  ```bash
  grep -n 'NAV_KEY_TO_ROUTE\|NAV_KEY_TO_TITLE\|NAV_GROUP_KEYS\|_loadGroupExpanded' app/admin-shell/webapp/controller/Shell.controller.js | head -15
  ```

  Confirm: `NAV_GROUP_KEYS` array around line 63 with 5 strings; `NAV_KEY_TO_ROUTE` around line 8; `NAV_KEY_TO_TITLE` around line 35.

- [ ] **Step 23.2: Append `"runtimeSettings"` to `NAV_GROUP_KEYS`**

  Find line 63:

  ```javascript
  var NAV_GROUP_KEYS = ["content", "rewards", "feedback", "reporting", "system"];
  ```

  Replace with:

  ```javascript
  var NAV_GROUP_KEYS = ["content", "rewards", "feedback", "reporting", "system", "runtimeSettings"];
  ```

  This automatically populates `groupExpanded.runtimeSettings = true` (default expanded, consistent with all other groups) via the existing `_loadGroupExpanded()` iterator.

- [ ] **Step 23.3: Add 5 NAV_KEY_TO_ROUTE entries**

  Find the `var NAV_KEY_TO_ROUTE = { ... }` literal (line 8). Add at the end (before the closing `}`):

  ```javascript
  uiEvents:  "uiEvents",
  search:    "search",
  navigator: "navigator",
  display:   "display",
  tenant:    "tenant",
  ```

- [ ] **Step 23.4: Add 5 NAV_KEY_TO_TITLE entries**

  Find the `var NAV_KEY_TO_TITLE = { ... }` literal (line 35). Add at the end:

  ```javascript
  uiEvents:  "UI Events",
  search:    "Search",
  navigator: "Navigator",
  display:   "Display",
  tenant:    "Tenant",
  ```

- [ ] **Step 23.5: Syntax check**

  ```bash
  node --check app/admin-shell/webapp/controller/Shell.controller.js && echo OK
  ```

- [ ] **Step 23.6: Build admin-shell again**

  ```bash
  npm --prefix app/admin-shell run build 2>&1 | tail -10
  ```

  Expected: build succeeds.

- [ ] **Step 23.7: Commit**

  ```bash
  git add app/admin-shell/webapp/controller/Shell.controller.js
  git commit -m "feat(admin-shell): NAV maps + NAV_GROUP_KEYS for 5 new tiles (#466)

  5th wiring location lesson from #463/#464: NAV_KEY_TO_ROUTE and
  NAV_KEY_TO_TITLE maps must include the new tile keys, otherwise
  clicking the side-nav item is a no-op.

  Also appends 'runtimeSettings' to NAV_GROUP_KEYS array — automatic
  groupExpanded.runtimeSettings=true via _loadGroupExpanded()
  iterator. Default expanded matches every other group (content,
  rewards, feedback, reporting, system).

  Plan-vs-spec correction: spec described groupExpanded as an object
  literal with false defaults; actual structure is the NAV_GROUP_KEYS
  array iterated with default-true. This commit follows the actual
  convention."
  ```

---

## Task 24: Update `.deploy/mta.yaml` srv-qa cp chain

**Files:**

- Modify: `.deploy/mta.yaml:97`

**Worktree-state aware:** if `srv/lib/runtime-config/` already has a cp segment (post-#471 worktree), append the 5 new files. Otherwise create the segment from scratch.

- [ ] **Step 24.1: Inspect current cp chain**

  ```bash
  sed -n '97p' .deploy/mta.yaml | head -c 800
  ```

  Look for `srv/lib/runtime-config` in the output. Determine: subdirectory exists in cp chain? (Yes / No)

- [ ] **Step 24.2: Update cp chain (worktree-state aware)**

  **Case A — `srv/lib/runtime-config` ALREADY in cp chain** (post-#471 rebase):

  Append 5 new file paths to the existing cp segment:

  ```text
  ../../srv/lib/runtime-config/ui-events-settings.js \
  ../../srv/lib/runtime-config/search-settings.js \
  ../../srv/lib/runtime-config/navigator-settings.js \
  ../../srv/lib/runtime-config/display-settings.js \
  ../../srv/lib/runtime-config/tenant-settings.js \
  ```

  **Case B — subdirectory NOT yet in cp chain** (pre-#471 worktree, expected for this PR):

  Add to the bash chain:

  ```bash
  mkdir -p srv/lib/runtime-config && \
  cp ../../srv/lib/runtime-config/ui-events-settings.js \
     ../../srv/lib/runtime-config/search-settings.js \
     ../../srv/lib/runtime-config/navigator-settings.js \
     ../../srv/lib/runtime-config/display-settings.js \
     ../../srv/lib/runtime-config/tenant-settings.js \
     srv/lib/runtime-config/
  ```

  Match existing bash-chain shape (single line OR `&&`-chained). The cp must come AFTER any general `mkdir` and BEFORE `cd srv` if present.

- [ ] **Step 24.3: Verify YAML + grep**

  ```bash
  yq '.modules[] | select(.name == "tutorials-srv-qa")' .deploy/mta.yaml > /dev/null && echo YAML_OK
  grep -c "ui-events-settings\.js\|search-settings\.js\|navigator-settings\.js\|display-settings\.js\|tenant-settings\.js" .deploy/mta.yaml
  ```

  Expected: `YAML_OK`, count ≥ 5.

- [ ] **Step 24.4: Commit**

  ```bash
  git add .deploy/mta.yaml
  git commit -m "chore(deploy): defensively add 5 runtime-config resolvers to srv-qa cp (#466)

  Mirrors #482's defensive-add pattern. srv-qa/server.js doesn't load
  scheduler.js or any consumer that imports these resolvers, so the
  files would be dead in gen/srv-qa/ today. Adding them preserves the
  convention that all srv/lib/runtime-config/* ships to QA, preempting
  a crash if QA ever grows a feature that imports them."
  ```

---

## Task 25: Operations doc

**Files (CREATE):**

- `docs/developers/operations/runtime-config.md`

- [ ] **Step 25.1: Write the doc** (~150 lines)

  Sections per the spec's Section 6:

  1. **Overview** — what's tunable per-domain, link to research-design parent + the 3 sibling specs (Phase 2-A foundation #463, Phase 2-B Secrets #464, Phase 3 long-tail #466).
  2. **How to flip a runtime-config flag** — admin UI path per domain (`/admin-ui/#uiEvents`, `#search`, `#navigator`, `#display`, `#tenant`, `#knowledgeGraph`, `#secrets`).
  3. **Per-domain field reference** — what each field controls + the env-var name it replaced. Table with: Domain | Field | Type | Default | Replaced env var | Caveats.
  4. **5-second cache TTL** — why flag-flips take ≤5s to propagate. Note: cron consumers re-read at tick-start; HTTP consumers see flips within 5s.
  5. **Backwards-compat invariant** — env vars stay in mtaext through a soak window (out of scope of #466).
  6. **Special-shape vars** — CSV/JSON/semicolon-pair format hints for CORS, TECH_USERS, TECH_USERS_MAPPING. Format examples.
  7. **Search rate-limiter caveat** — counter-reset within 5s TTL window. ~120 req/10s effective burst-tolerance.
  8. **Navigation breadcrumb** — Runtime Settings group lives below System group in admin-shell side-nav. Default collapsed.

  Doc is structured so each domain section is independently appendable. Phase 2-C (#465) will append a "Secrets — encrypted values" section here when it ships.

- [ ] **Step 25.2: Commit**

  ```bash
  git add docs/developers/operations/runtime-config.md
  git commit -m "docs(ops): runtime-config operations runbook (#466)

  Phase 3 final-piece doc covering all 7 runtime-config tiles + 5s
  TTL semantics + special-shape vars + Search rate-limiter caveat.
  Designed to be appendable when Phase 2-C (#465) ships."
  ```

---

## Task 26: End-to-end verification + finalize

- [ ] **Step 26.1: Run all unit tests**

  ```bash
  npm test 2>&1 | tail -30
  ```

  Expected: all pass. Specifically the new `test/unit/runtime-config/*.test.js` should show 28/28.

  If pre-existing tests fail unrelated to #466: check whether environment-related (fresh-worktree missing native bindings, etc.). Compare with main if needed. Don't block on pre-existing failures.

- [ ] **Step 26.2: CDS compile clean**

  ```bash
  npx cds compile srv/admin-service.cds > /dev/null && echo SRV_OK
  npx cds compile db/schema.cds > /dev/null && echo SCHEMA_OK
  ```

  Expected: 2 OKs.

- [ ] **Step 26.3: Admin-shell build clean**

  ```bash
  npm --prefix app/admin-shell run build 2>&1 | tail -20
  ```

  Expected: build success; output mentions `Copied uiEvents`, `Copied search`, `Copied navigator`, `Copied display`, `Copied tenant`.

- [ ] **Step 26.4: Inspect git log**

  ```bash
  git log --oneline main..HEAD | head -40
  ```

  Expected: ~25-30 commits visible. All on the worktree branch, none on main.

- [ ] **Step 26.5: Use `superpowers:finishing-a-development-branch` skill**

  Then push the branch + open the PR. The PR body draft from the spec's Section 7 lists the 3 behavior changes, the UX change (KG + Secrets relocation when rebased post-#471/#482), test plan checkboxes, and the out-of-scope items.

  PR body draft template (from spec):

  ```markdown
  # feat: Phase 3 long-tail env-var migration (#466)

  Closes #466. Final phase of the runtime-config research from #444.
  Migrates 9 long-tail env vars across 5 domains to per-domain typed
  singletons. Replicates patterns from #471 (Phase 2-A) and #482 (Phase 2-B).

  After this PR, every runtime-tunable env var from the #444 inventory
  is DB-backed.

  ## ⚠️ 3 behavior changes
  1. handleUIEvent() in srv/lib/ui-event-handler.js is now async (5s
     resolver TTL replaces module-load env-snapshot). checkFeatureFlag()
     boot-log message updated to drop the now-stale env-name reference.
  2. scheduleRebuild() in srv/lib/rebuild-trigger.js is now async.
     Production caller in srv/server.js:370 changed try/catch → .catch()
     to preserve fire-and-forget semantics. 13 test callers + the
     _resetForTests({environment}) injection pattern updated.
  3. Search rate-limiter is rebuilt every ~5s, which resets internal
     counters. Effectively: 60+60=120 requests possible per 10s window
     (vs documented 60/min). Acceptable for accidental-abuse defense.

  ## ⚠️ UX change (manifests after rebase onto main)
  Knowledge Graph + Secrets tiles MOVE from "System" to a new
  "Runtime Settings" nav-group. Routes UNCHANGED — bookmarks still work.
  This worktree branched pre-#471/#482, so the move materializes only
  after the rebase-conflict resolution commit during PR review.

  ## What's in the PR
  - 5 schema entities, 5 resolver libs, 5 admin tiles
  - 8 consumer-file conversions across 10 sites
  - Admin-shell: 20 manifest sub-entries + new "Runtime Settings"
    peer-group + NAV_KEY_TO_ROUTE/TITLE entries
  - 28 unit tests
  - 1 operations doc

  ## Test plan
  - [x] Unit tests pass (28 cases)
  - [ ] DEV deploy: 5 tiles load, edit, save
  - [ ] DEV deploy: Runtime Settings peer-group visible (collapsed by default)
  - [ ] DEV deploy: Existing routes (/admin-ui/#knowledgeGraph) still work
  ```

  Plan terminates here. The implementer subagent (or executing-plans skill) drives Tasks 1-26 to completion.

---

## Out of scope (deferred to follow-up issues)

- **Phase 2-C (#465) encrypted secrets store.** Gated on encryption-key management decision.
- **Removing env vars from mtaext.** Stays through a soak window after this PR ships.
- **Write-time format validation** for CORS / TECH_USERS / TECH_USERS_MAPPING. Phase 4 follow-up if validation becomes painful.
- **Hybrid round-trip tests** for the 5 new resolvers. Pattern-redundancy with kg-settings hybrid test already in main.
- **i18n migration of existing hardcoded admin-shell labels.** Bundle creation here unblocks it; actual migration is a separate cleanup PR.
- **Joule Settings relocation** into Runtime Settings group. Stays in System for now.

---

## References

- Spec: `docs/superpowers/specs/2026-06-20-issue-466-long-tail-env-migration-design.md`
- Research-design parent: `docs/superpowers/specs/2026-06-20-runtime-config-research-design.md`
- Sibling Phase 2-A plan (template): `docs/superpowers/plans/2026-06-20-issue-463-runtime-config-foundation.md`
- Sibling Phase 2-B plan (template): `docs/superpowers/plans/2026-06-20-issue-464-secrets-visibility.md`
- Issue: [#466](https://github.com/sap-tutorials/tutorials-ims/issues/466)
