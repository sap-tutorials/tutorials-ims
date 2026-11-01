# Draft Integrity Preflight Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a startup preflight check that warns when `cds.fiori.draft_admin_integrity: true` is serving on HANA but the required `ON DELETE CASCADE` constraints have not yet been deployed to that schema.

**Architecture:** A new `srv/lib/draft-integrity-preflight.js` module exports a pure async function `checkDraftCascadeConstraints(dbRun)` that queries `SYS.REFERENTIAL_CONSTRAINTS` for cascade FKs on draft tables. A `wireDraftIntegrityPreflight(cds)` wirer registers the check once in a `cds.on('served')` handler (globalThis-sentinel-guarded), skipping on SQLite/local. A unit test exercises the pure function directly with a mock `dbRun`. The runbook gets a one-liner pointing to the new guard.

**Tech Stack:** Node.js ESM, CAP `@sap/cds`, Vitest

**Spec:** `docs/developers/reference/tutorials-ims-gotchas.md` § "Optimized draft deletion — draft_admin_integrity (CAP 10.2, #2909)" + GitHub issue #2968

## Global Constraints

- Branch off `origin/DEV` — the `draft_admin_integrity: true` flag lives on DEV.
- Fail-open: the check MUST NOT crash the server; use `cds.log('draft-integrity-preflight').warn(…)` on missing constraints.
- Skip entirely on SQLite / non-HANA (guard: `cds.db?.options?.kind !== 'hana'`).
- globalThis sentinel pattern: `globalThis.__draftIntegrityPreflightRegistered` — matches existing sentinel style in `srv/server.js`.
- No new npm dependencies.
- `checkDraftCascadeConstraints` must be testable without booting CAP — it receives `dbRun` as a parameter, never imports `cds.db` directly.
- Unit tests: Vitest, `import { describe, it, expect } from 'vitest'` — no `cds.test()` harness.
- Commit to feature branch; open PR targeting `DEV`.

## Review Focus

- **SQLite skipped silently**: on `npm test` (in-memory SQLite) the preflight MUST NOT run or log noise. Test: the `isHanaKind` predicate with kind `sqlite` must return `false`.
- **Empty constraint result vs. DB error**: a `dbRun` that throws must be caught (fail-open), distinct from a result returning zero rows. Test: both branches in unit test.
- **Partial constraint coverage**: only some draft tables have the constraint. The check should list the missing tables. Test: unit test with a mix of found/missing.
- **Re-fire on `cds.test()`**: `cds.on('served')` can fire more than once under Vitest. The globalThis sentinel must prevent double-registration. Test: call `wireDraftIntegrityPreflight` twice and assert `dbRun` called at most once.
- **Known draft table name set must stay in sync**: if a new draft-enabled entity is added to `AdminService`, its table name must be added to `DRAFT_TABLES`. The unit test captures the expected set so a future addition will fail loudly.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `srv/lib/draft-integrity-preflight.js` | **Create** | Pure check function + wirer |
| `test/unit/draft-integrity-preflight.test.js` | **Create** | Unit tests for the pure function |
| `srv/server.js` | **Modify** | Import wirer, call it once |
| `docs/developers/reference/tutorials-ims-gotchas.md` | **Modify** | Add one bullet pointing to the preflight |

---

## Task 1: `srv/lib/draft-integrity-preflight.js` — pure check + wirer

**Files:**
- Create: `srv/lib/draft-integrity-preflight.js`

**Interfaces:**
- Produces:
  - `DRAFT_TABLES: string[]` — authoritative list of draft table names (lowercase HANA names)
  - `isHanaKind(cds: object) → boolean`
  - `checkDraftCascadeConstraints(dbRun: (sql: string) => Promise<any[]>) → Promise<{ok: boolean, found: string[], missing: string[], error?: string}>`
  - `wireDraftIntegrityPreflight(cds: object) → void`

- [ ] **Step 1: Enumerate draft-enabled entities to build `DRAFT_TABLES`**

  ```bash
  grep -n "annotate\|@odata.draft.enabled\|with draft\|AdminService" srv/admin-service.cds | head -40
  grep -n "draft.enabled" db/*.cds srv/*.cds | grep -v node_modules | head -30
  ```

  HANA table name for entity `com.sap.developers.ims.Missions` becomes `COM_SAP_DEVELOPERS_IMS_MISSIONS_DRAFTS`. The SQL query uses `TABLE_NAME` in uppercase; the code normalizes to lowercase for comparison.

- [ ] **Step 2: Create `srv/lib/draft-integrity-preflight.js`**

  Module shape (exact signatures; implement bodies):

  ```js
  // srv/lib/draft-integrity-preflight.js
  export const DRAFT_TABLES = [ /* one entry per draft-enabled entity */ ];
  export function isHanaKind(cds) { /* cds.db?.options?.kind === 'hana' */ }
  export async function checkDraftCascadeConstraints(dbRun) { /* see below */ }
  export function wireDraftIntegrityPreflight(cds) { /* see below */ }
  ```

  `checkDraftCascadeConstraints(dbRun)`:
  - Calls `dbRun("SELECT TABLE_NAME FROM SYS.REFERENTIAL_CONSTRAINTS WHERE COLUMN_NAME = 'DRAFTADMINISTRATIVEDATA_DRAFTUUID' AND DELETE_RULE = 'CASCADE'")`
  - Maps result rows to a `Set` of `row.TABLE_NAME.toLowerCase()` values
  - Computes `found` = DRAFT_TABLES entries in the set, `missing` = DRAFT_TABLES entries not in the set
  - Returns `{ ok: missing.length === 0, found, missing }`
  - On throw: returns `{ ok: false, found: [], missing: [...DRAFT_TABLES], error: err.message }`

  `wireDraftIntegrityPreflight(cds)`:
  - `cds.on('served', async () => { … })`
  - Inside handler: check `globalThis.__draftIntegrityPreflightRegistered`; set it; call `isHanaKind(cds)` and return early if false
  - Call `checkDraftCascadeConstraints((sql) => cds.db.run(sql))`
  - Whole thing wrapped in outer try/catch; log warn on missing or error, log info on all-found

- [ ] **Step 3: Verify module loads**

  ```bash
  node --input-type=module -e "import { DRAFT_TABLES, isHanaKind } from './srv/lib/draft-integrity-preflight.js'; console.log('ok', DRAFT_TABLES.length)"
  ```
  Expected: `ok <N>` where N > 0, no error.

---

## Task 2: Unit tests

**Files:**
- Create: `test/unit/draft-integrity-preflight.test.js`

**Interfaces:**
- Consumes: `checkDraftCascadeConstraints`, `DRAFT_TABLES`, `isHanaKind`, `wireDraftIntegrityPreflight` from `../../srv/lib/draft-integrity-preflight.js`

- [ ] **Step 1: Write tests**

  ```js
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import {
    checkDraftCascadeConstraints, DRAFT_TABLES, isHanaKind, wireDraftIntegrityPreflight,
  } from '../../srv/lib/draft-integrity-preflight.js';

  describe('DRAFT_TABLES', () => {
    it('is a non-empty array of lowercase strings', () => {
      expect(Array.isArray(DRAFT_TABLES)).toBe(true);
      expect(DRAFT_TABLES.length).toBeGreaterThan(0);
      for (const t of DRAFT_TABLES) { expect(t).toBe(t.toLowerCase()); }
    });
    it('contains the known high-risk tables', () => {
      expect(DRAFT_TABLES).toContain('com_sap_developers_ims_missions_drafts');
      expect(DRAFT_TABLES).toContain('com_sap_developers_ims_groups_drafts');
    });
  });

  describe('isHanaKind', () => {
    it('true for hana', () => expect(isHanaKind({ db: { options: { kind: 'hana' } } })).toBe(true));
    it('false for sqlite', () => expect(isHanaKind({ db: { options: { kind: 'sqlite' } } })).toBe(false));
    it('false when cds.db absent', () => expect(isHanaKind({})).toBe(false));
  });

  describe('checkDraftCascadeConstraints', () => {
    it('ok:true when all tables have cascade FK', async () => {
      const rows = DRAFT_TABLES.map(t => ({ TABLE_NAME: t.toUpperCase() }));
      const r = await checkDraftCascadeConstraints(async () => rows);
      expect(r.ok).toBe(true);
      expect(r.missing).toHaveLength(0);
      expect(r.found).toHaveLength(DRAFT_TABLES.length);
    });
    it('ok:false when no constraints exist', async () => {
      const r = await checkDraftCascadeConstraints(async () => []);
      expect(r.ok).toBe(false);
      expect(r.found).toHaveLength(0);
      expect(r.missing).toHaveLength(DRAFT_TABLES.length);
    });
    it('ok:false and lists only missing tables when partial', async () => {
      const r = await checkDraftCascadeConstraints(async () => [{ TABLE_NAME: DRAFT_TABLES[0].toUpperCase() }]);
      expect(r.ok).toBe(false);
      expect(r.found).toHaveLength(1);
      expect(r.missing).toHaveLength(DRAFT_TABLES.length - 1);
      expect(r.missing).not.toContain(DRAFT_TABLES[0]);
    });
    it('ok:false with error property when dbRun throws', async () => {
      const r = await checkDraftCascadeConstraints(async () => { throw new Error('HANA gone'); });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('HANA gone');
      expect(r.found).toHaveLength(0);
    });
  });

  describe('wireDraftIntegrityPreflight sentinel', () => {
    let calls = 0;
    const fakeCds = {
      db: { options: { kind: 'hana' }, run: async () => { calls++; return []; } },
      on: (event, fn) => { if (event === 'served') void fn(); },
      log: () => ({ warn: () => {}, info: () => {} }),
    };
    beforeEach(() => { calls = 0; delete globalThis.__draftIntegrityPreflightRegistered; });
    afterEach(() => { delete globalThis.__draftIntegrityPreflightRegistered; });

    it('registers only once when called twice (sentinel)', async () => {
      wireDraftIntegrityPreflight(fakeCds);
      wireDraftIntegrityPreflight(fakeCds);
      await new Promise(r => setTimeout(r, 0));
      expect(calls).toBeLessThanOrEqual(1);
    });
  });
  ```

- [ ] **Step 2: Run tests**

  ```bash
  npx vitest run test/unit/draft-integrity-preflight.test.js
  ```
  Expected: all PASS.

- [ ] **Step 3: Run full unit suite**

  ```bash
  npm test
  ```
  Expected: no regressions vs. baseline.

- [ ] **Step 4: Commit**

  ```bash
  git add srv/lib/draft-integrity-preflight.js test/unit/draft-integrity-preflight.test.js
  git commit -m "feat(serve): draft-integrity-preflight — WARN on missing HANA cascade constraints (#2968)"
  ```

---

## Task 3: Wire into `srv/server.js`

**Files:**
- Modify: `srv/server.js`

**Interfaces:**
- Consumes: `wireDraftIntegrityPreflight` from `./lib/draft-integrity-preflight.js`

- [ ] **Step 1: Add import** at the top of `srv/server.js` alongside the existing `./lib/` imports:

  ```js
  import { wireDraftIntegrityPreflight } from './lib/draft-integrity-preflight.js';
  ```

- [ ] **Step 2: Call wirer** just before the metrics-db-wrap `cds.on('served')` block (~line 2348):

  ```js
  wireDraftIntegrityPreflight(cds);
  ```

- [ ] **Step 3: Smoke-check**

  ```bash
  cds watch
  ```
  Expected: server starts, no crash, no `[draft-integrity-preflight]` lines (SQLite skips).

- [ ] **Step 4: Commit**

  ```bash
  git add srv/server.js
  git commit -m "chore(serve): wire draft-integrity-preflight startup check (#2968)"
  ```

---

## Task 4: Update runbook

**Files:**
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md`

- [ ] **Step 1: Add bullet** in the "Optimized draft deletion" section, after "Constraint-deploy migration ordering (HANA)":

  ```markdown
  - **Startup preflight check** — `srv/lib/draft-integrity-preflight.js` runs once at boot (inside `cds.on('served')`, HANA only, fail-open). Queries `SYS.REFERENTIAL_CONSTRAINTS` for `ON DELETE CASCADE` FKs on every draft table and emits `cds.log('draft-integrity-preflight').warn(…)` listing any missing tables. If the warn line appears after a deploy, the HDI constraint deploy has not yet landed — wait and restart. Absent = all constraints present.
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add docs/developers/reference/tutorials-ims-gotchas.md
  git commit -m "docs: startup preflight check in draft_admin_integrity runbook (#2968)"
  ```

---

## Task 5: Open PR targeting DEV

- [ ] **Step 1: Push**

  ```bash
  git push -u origin worktree-draft-integrity-preflight-2968
  ```

- [ ] **Step 2: Open PR**

  ```bash
  gh pr create \
    --base DEV \
    --title "feat(serve): draft-integrity-preflight startup check for HANA cascade constraints (#2968)" \
    --body "..."
  ```
  Body: closes #2968, summary bullets, test plan checklist (vitest run, npm test, cds watch, hybrid CF log check).
