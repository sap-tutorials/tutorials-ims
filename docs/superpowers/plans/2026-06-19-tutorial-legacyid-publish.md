# Tutorials.legacyId NULL on publish-side INSERT — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the publish path from creating `Tutorials` rows with `legacyId IS NULL`. Self-heal pre-existing NULL rows on next republish. Provide a one-shot repair script for the rows that won't be republished, including downstream `CompletionPathItems.taskLegacyId` propagation.

**Architecture:** Two-line change in `srv/lib/content-publish-session.js` (INSERT branch + UPDATE branch self-heal). New `scripts/repair-tutorial-legacyid.cjs` mirrors the existing `dedupe-tutorial-meta.cjs` shape. Two hybrid tests (forward INSERT + UPDATE self-heal) and one repair-script hybrid test.

**Tech Stack:** `@sap/cds`, Vitest hybrid tests against real HANA via `cds bind --exec`. No CSN schema change.

**Spec:** [docs/superpowers/specs/2026-06-19-tutorial-legacyid-publish-design.md](../specs/2026-06-19-tutorial-legacyid-publish-design.md)

**Issue:** [#431](https://github.com/sap-tutorials/tutorials-ims/issues/431)

**Branch:** `fix/issue-431-tutorial-legacyid` (already created from `main`; spec committed as `78e96fbf`, `1dc39ff9`, `ebfd250c`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `srv/lib/content-publish-session.js` | Modify | Forward fix: INSERT branch always assigns `legacyId`. UPDATE branch reads `existingLegacy` and assigns one only if NULL (self-heal). |
| `test/hybrid/content-publish-chunked.test.js` | Modify | Two new `it()` blocks: forward INSERT + UPDATE self-heal. |
| `scripts/repair-tutorial-legacyid.cjs` | Create | One-shot script: walks `Tutorials WHERE legacyId IS NULL`, assigns sequence values, propagates to `CompletionPathItems.taskLegacyId` via the `tutorial : Association to Tutorials` FK. Per-tutorial transaction with `SELECT FOR UPDATE`, fail-soft. |
| `test/hybrid/repair-tutorial-legacyid.test.js` | Create | Hybrid test for the repair script's core logic. |

No other files change. No CSN schema change. No `Tutorials.legacyId` `@mandatory` constraint added.

---

## Pre-flight: commit the plan

- [ ] **Step 0 (commit this plan first):** Before starting Task 1, commit the plan file itself so the branch sequence reads spec → plan → impl.

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current  # expect: fix/issue-431-tutorial-legacyid
  git -c core.autocrlf=false add docs/superpowers/plans/2026-06-19-tutorial-legacyid-publish.md
  git -c core.autocrlf=false commit -m "docs(plan): tutorial legacyId NULL on publish-side INSERT (#431)"
  ```

  > **Branch slip safeguard (memory: `feedback_branch_slip_after_long_session`):** Pair `git branch --show-current` with the commit invocation in the SAME Bash call. Long sessions silently slip HEAD back to main; the workflow above caught it twice in this session.

---

## Task 1: Forward fix — INSERT branch + UPDATE branch self-heal

**Files:**
- Modify: `srv/lib/content-publish-session.js` (lines ~303–326)

- [ ] **Step 1: Read the current state to anchor edits**

  ```bash
  cd D:/projects/tutorials-poc
  sed -n '300,330p' srv/lib/content-publish-session.js
  ```

  You should see the `if (tutorialId)` UPDATE branch (lines 303–312), then `} else {` (line 313), then the INSERT (lines 314–325). The `getNextLegacyId` import is already present at the top of the file — check by running:

  ```bash
  grep -n "getNextLegacyId" srv/lib/content-publish-session.js | head -5
  ```

  Expected: at least one match like `import { getNextLegacyId } from './legacy-id.js'`. If it's NOT imported (it's used elsewhere in the same file at line ~338, so it should be), Task 1 won't compile — add the import first.

- [ ] **Step 2: Apply the two-branch edit**

  Replace the INSERT branch entries object so it includes `legacyId`. Replace the UPDATE branch with a self-healing variant.

  Before:

  ```js
  if (tutorialId) {
    await UPDATE(Tutorials).where({ ID: tutorialId }).set({
      title: meta.title,
      description: meta.description || null,
      averageTimeToComplete: meta.time || null,
      experienceTag: meta.level || null,
      primaryTag: meta.primaryTag || null,
      stepCount: Array.isArray(meta.steps) ? meta.steps.length : null,
      status: 'ACTIVE'
    });
  } else {
    tutorialId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: tutorialId,
      slug,
      title: meta.title,
      description: meta.description || null,
      averageTimeToComplete: meta.time || null,
      experienceTag: meta.level || null,
      primaryTag: meta.primaryTag || null,
      stepCount: Array.isArray(meta.steps) ? meta.steps.length : null,
      status: 'ACTIVE'
    });
  }
  ```

  After:

  ```js
  if (tutorialId) {
    // [#431] Self-heal: if an existing row was inserted with NULL legacyId by
    // the bug pre-this-fix, fill it in on the next publish. Avoids relying on
    // the repair script for any tutorial that gets re-published after deploy.
    // Note: this does NOT propagate to CompletionPathItems — that fixup is the
    // repair script's job.
    const existing = await SELECT.one.from(Tutorials).where({ ID: tutorialId }).columns('legacyId');
    const updates = {
      title: meta.title,
      description: meta.description || null,
      averageTimeToComplete: meta.time || null,
      experienceTag: meta.level || null,
      primaryTag: meta.primaryTag || null,
      stepCount: Array.isArray(meta.steps) ? meta.steps.length : null,
      status: 'ACTIVE'
    };
    if (existing?.legacyId == null) {
      updates.legacyId = await getNextLegacyId('Tutorials', db);
    }
    await UPDATE(Tutorials).where({ ID: tutorialId }).set(updates);
  } else {
    tutorialId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: tutorialId,
      slug,
      title: meta.title,
      description: meta.description || null,
      averageTimeToComplete: meta.time || null,
      experienceTag: meta.level || null,
      primaryTag: meta.primaryTag || null,
      stepCount: Array.isArray(meta.steps) ? meta.steps.length : null,
      status: 'ACTIVE',
      legacyId: await getNextLegacyId('Tutorials', db)  // [#431]
    });
  }
  ```

- [ ] **Step 3: Run the existing chunked-publish tests in unit mode (SQLite) as a smoke test**

  The hybrid suite needs HANA + `ALLOW_HYBRID_WRITES=true`, so don't run that yet. The existing unit tests for `content-publish-session` are minimal but worth a smoke pass:

  ```bash
  cd D:/projects/tutorials-poc
  npx vitest run scripts/__tests__/publish-content.test.ts --reporter=default 2>&1 | tail -10
  ```

  Expected: all tests pass. (This file exercises the publish-content side, not the session helpers directly, but it depends on the same module loading cleanly.)

  If it fails with "getNextLegacyId is not a function" or similar, you missed the import statement — fix and re-run.

- [ ] **Step 4: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current  # expect: fix/issue-431-tutorial-legacyid
  git -c core.autocrlf=false add srv/lib/content-publish-session.js
  git -c core.autocrlf=false commit -m "fix(publish-session): assign legacyId on Tutorials INSERT + UPDATE-branch self-heal (#431)

  INSERT branch: unconditionally assigns legacyId from getNextLegacyId.
  UPDATE branch: reads existing legacyId, assigns one only if NULL —
  self-heals republished tutorials so the repair script becomes optional
  for any slug that gets republished after deploy.

  Refs #431"
  ```

---

## Task 2: Hybrid tests for the forward fix

**Files:**
- Modify: `test/hybrid/content-publish-chunked.test.js`

The existing test file already has cleanup logic for `__TEST__chunked-` and `__TEST__mixedcase-` prefixes. Add a new `__TEST__legacyid-` prefix and extend the cleanup.

- [ ] **Step 1: Add a new prefix constant + cleanup logic**

  Find the existing prefix constants near the top of the file (around line 9):

  ```js
  const PREFIX = '__TEST__chunked-';
  const MIXED_PREFIX = '__TEST__mixedcase-';
  ```

  Add a third:

  ```js
  const PREFIX = '__TEST__chunked-';
  const MIXED_PREFIX = '__TEST__mixedcase-';
  const LEGACY_PREFIX = '__TEST__legacyid-';
  ```

  Then find the `afterAll` cleanup block (starts around line 26). Currently it cleans `${PREFIX}%` and `${MIXED_PREFIX}%` from `ContentFiles`, plus mixed-case Tutorials/Steps. Extend the Tutorials cleanup to also remove `${LEGACY_PREFIX}%` rows (case-insensitive via the same `tutorialsTableInfo` + `LOWER()` pattern already in use).

  Search for the existing block:

  ```bash
  grep -n "MIXED_PREFIX" test/hybrid/content-publish-chunked.test.js
  ```

  At each match site, add a parallel statement for `LEGACY_PREFIX`. Specifically:

  - The `DELETE.from(ContentFiles).where({ slug: { like: \`${MIXED_PREFIX}%\` } })` line — duplicate for `LEGACY_PREFIX`.
  - The mixed-case Tutorials cleanup — extend the `LOWER(${slugCol}) LIKE` clause to also match `LOWER('${LEGACY_PREFIX}%')`. The simplest approach: copy the existing 3-statement cleanup block, change `MIXED_PREFIX` → `LEGACY_PREFIX`, paste below.

  > **Why a separate prefix:** the existing cleanups are tightly tied to the mixed-case test's specific slug shape. A separate prefix avoids any cross-test interaction and makes the new tests independently runnable.

- [ ] **Step 2: Add the forward INSERT regression test**

  > **Why `appendToSession` + `abortSession`?** The mixed-case probe test above uses the same pattern. `upsertTutorialMetadata` runs as a side-effect of `appendToSession`, writing directly to `Tutorials`/`Steps` (NOT through the manifest). `abortSession` rolls back the manifest but leaves the Tutorials/Steps writes intact — that's exactly the hook we need for these assertions.

  Append this `it()` block to the `describe('content publish chunked — HANA', ...)` block, after the existing `'upsertTutorialMetadata matches mixed-case ...'` test:

  ```js
  it('upsertTutorialMetadata assigns a non-null legacyId on INSERT for new slugs (#431)', async () => {
    const slug = `${LEGACY_PREFIX}forward-insert`;
    const html = `<html><body><main class="tutorial-main">${slug}</main></body></html>`;

    const db = await cds.connect.to('db');
    const { Tutorials } = cds.entities(NS);

    // Sanity: ensure no pre-existing row for this slug.
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    const { table: tutTable, slugCol } = tutorialsTableInfo(NS, isHana);
    const pre = await db.run(`SELECT COUNT(*) AS C FROM ${tutTable} WHERE LOWER(${slugCol}) = ?`, [slug]);
    expect(pre[0].C ?? pre[0].c).toBe(0);

    // Drive a chunked publish that creates a brand-new Tutorials row.
    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-legacyid-insert', hugoVersion: 'test', expectedSlugCount: 1
    });
    await helpers.appendToSession({
      sessionId: begin.sessionId,
      files: { [slug]: gzipSync(Buffer.from(html)).toString('base64') },
      metadata: {
        [slug]: {
          title: 'legacyid forward insert probe',
          steps: [{ number: 1, title: 'Step one' }, { number: 2, title: 'Step two' }],
        },
      },
      bodyTexts: {},
    });
    await helpers.abortSession({ sessionId: begin.sessionId, reason: 'legacyid-probe-cleanup' });

    // Assert: the newly-inserted Tutorials row has a positive legacyId.
    const row = await SELECT.one.from(Tutorials).where({ slug }).columns('ID', 'legacyId');
    expect(row).toBeTruthy();
    expect(typeof row.legacyId).toBe('number');
    expect(row.legacyId).toBeGreaterThan(0);
  });
  ```

- [ ] **Step 3: Add the UPDATE-branch self-heal regression test**

  Append after Step 2's test:

  ```js
  it('upsertTutorialMetadata UPDATE branch self-heals NULL legacyId on republish (#431)', async () => {
    const slug = `${LEGACY_PREFIX}update-selfheal`;
    const seedId = cds.utils.uuid();

    const db = await cds.connect.to('db');
    const { Tutorials } = cds.entities(NS);

    // 1. Manually INSERT a Tutorials row with legacyId: null (mimics a stub
    //    written before the fix landed — the bug shape from #431).
    await INSERT.into(Tutorials).entries({
      ID: seedId,
      slug,
      title: 'legacyid update self-heal probe',
      status: 'ACTIVE',
      stepCount: null,
      legacyId: null,
    });

    // Sanity: confirm legacyId is NULL.
    const before = await SELECT.one.from(Tutorials).where({ ID: seedId }).columns('legacyId');
    expect(before?.legacyId).toBeNull();

    // 2. Drive a publish for the same slug → exercises the UPDATE branch.
    const html = `<html><body><main class="tutorial-main">${slug}</main></body></html>`;
    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-legacyid-update', hugoVersion: 'test', expectedSlugCount: 1
    });
    await helpers.appendToSession({
      sessionId: begin.sessionId,
      files: { [slug]: gzipSync(Buffer.from(html)).toString('base64') },
      metadata: {
        [slug]: {
          title: 'legacyid update self-heal probe',
          steps: [{ number: 1, title: 'Step one' }],
        },
      },
      bodyTexts: {},
    });
    await helpers.abortSession({ sessionId: begin.sessionId, reason: 'legacyid-probe-cleanup' });

    // 3. Assert: the same row now has a positive legacyId.
    const after = await SELECT.one.from(Tutorials).where({ ID: seedId }).columns('legacyId');
    expect(typeof after?.legacyId).toBe('number');
    expect(after.legacyId).toBeGreaterThan(0);
  });
  ```

- [ ] **Step 4: Run the hybrid suite locally (requires `cf login` + bound DEV HANA)**

  ```bash
  cd D:/projects/tutorials-poc
  ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/content-publish-chunked.test.js --reporter=default 2>&1 | tail -20
  ```

  Expected: all tests in this file pass — both the existing 4 plus the 2 new ones.

  If you don't have hybrid setup locally, **skip this step** — the tests will run in CI when the PR is open. The forward fix will get end-to-end verification via Task 4's deploy + workflow run anyway.

- [ ] **Step 5: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add test/hybrid/content-publish-chunked.test.js
  git -c core.autocrlf=false commit -m "test(publish-chunked): hybrid regressions for legacyId INSERT + UPDATE self-heal (#431)"
  ```

---

## Task 3: Repair script `scripts/repair-tutorial-legacyid.cjs`

**Files:**
- Create: `scripts/repair-tutorial-legacyid.cjs`

Mirror `scripts/dedupe-tutorial-meta.cjs` for argument parsing, snapshot writing, HANA-only guard, and per-row tx pattern.

- [ ] **Step 1: Create the script**

  Use this exact template:

  ```js
  /* eslint-disable no-console */
  /**
   * One-shot repair: backfill Tutorials.legacyId for rows where it is NULL and
   * propagate the new legacyId to dependent CompletionPathItems rows (linked
   * via the tutorial : Association to Tutorials FK on CompletionPathItems).
   *
   * Background: upsertTutorialMetadata historically inserted Tutorials rows
   * without assigning legacyId. The forward fix in PR #?? closes the leak;
   * this script heals existing NULL rows.
   *
   * Out of scope: TaskRecords. The schema has no FK from TaskRecords to
   * Tutorials and no taskSlug column, so orphan TaskRecords (where
   * taskLegacyId was written NULL during the bug window) cannot be matched
   * back to a tutorial. Documented as accepted data-loss boundary in the
   * spec at docs/superpowers/specs/2026-06-19-tutorial-legacyid-publish-design.md.
   *
   * Modes:
   *   --dry-run     (default) — print plan, no writes
   *   --commit               — execute, snapshot first
   *   --verify-only          — count remaining NULL rows, exit 0/2
   *
   * Run via:  npx cds bind --exec -- node scripts/repair-tutorial-legacyid.cjs [--commit]
   */

  const cds = require('@sap/cds');
  const fs = require('node:fs');
  const path = require('node:path');

  const SNAPSHOT_DIR = path.resolve(__dirname, '..', '.migration-data');
  const SNAPSHOT_PATH = path.join(
    SNAPSHOT_DIR,
    `tutorial-legacyid-repair-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  );
  let snapshotInited = false;
  function appendSnapshot(record) {
    if (!snapshotInited) {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
      snapshotInited = true;
    }
    fs.appendFileSync(SNAPSHOT_PATH, JSON.stringify(record) + '\n');
  }

  const argv = process.argv.slice(2);
  const COMMIT = argv.includes('--commit');
  const VERIFY_ONLY = argv.includes('--verify-only');
  const DRY_RUN = argv.includes('--dry-run');
  if (COMMIT && VERIFY_ONLY) {
    console.error('--commit and --verify-only are mutually exclusive');
    process.exit(1);
  }
  if (COMMIT && DRY_RUN) {
    console.error('--commit and --dry-run are mutually exclusive');
    process.exit(1);
  }

  const TUT_TBL = '"COM_SAP_DEVELOPERS_IMS_TUTORIALS"';
  const CPI_TBL = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"';
  const TUT_SEQ = '"COM_SAP_DEVELOPERS_IMS_TUTORIALS_SEQ"';

  async function main() {
    const db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      console.error('FATAL: this script must run on HANA. Use `cds bind --exec`.');
      process.exit(1);
    }
    if (COMMIT) console.log(`Snapshot will be written to: ${SNAPSHOT_PATH}\n`);

    // Find every Tutorials row where legacyId IS NULL.
    const nullRows = await db.run(`
      SELECT "ID", "SLUG", "TITLE"
        FROM ${TUT_TBL}
       WHERE "LEGACYID" IS NULL
       ORDER BY "SLUG"
    `);

    if (VERIFY_ONLY) {
      console.log(`Tutorials rows with NULL legacyId: ${nullRows.length}`);
      process.exit(nullRows.length === 0 ? 0 : 2);
    }

    console.log(`\n--- Tutorials with NULL legacyId: ${nullRows.length} row(s) ---`);

    let tutorialsRepaired = 0;
    let cpiRepaired = 0;
    let tutorialsFailed = 0;

    for (const row of nullRows) {
      const slug = row.SLUG;
      const tutorialId = row.ID;

      // Look up dependent CompletionPathItems via the tutorial FK (NOT slug match —
      // the schema has no taskSlug column on CPI).
      const cpiRows = await db.run(`
        SELECT "ID", "TASKLEGACYID", "TASKTYPE"
          FROM ${CPI_TBL}
         WHERE "TUTORIAL_ID" = ?
           AND "TASKLEGACYID" IS NULL
           AND "TASKTYPE" = 'TUTORIAL'
      `, [tutorialId]);

      console.log(
        `  ${slug.padEnd(50)}  tutorialID=${tutorialId.slice(0,8)}  ` +
        `cpi_to_repair=${cpiRows.length}`
      );

      if (!COMMIT) continue;

      try {
        await db.tx(async tx => {
          // Acquire a row-level lock and re-check NULL — defends against a concurrent
          // publish that may have already filled in the legacyId.
          const recheck = await tx.run(`
            SELECT "LEGACYID" FROM ${TUT_TBL} WHERE "ID" = ? FOR UPDATE
          `, [tutorialId]);
          if (recheck[0]?.LEGACYID != null) {
            console.log(`    skipped — concurrent publish already set legacyId=${recheck[0].LEGACYID}`);
            return;
          }

          // Pull a new sequence value.
          const [seqRow] = await tx.run(`SELECT ${TUT_SEQ}.NEXTVAL AS "nextval" FROM DUMMY`);
          const newId = seqRow.nextval;

          // Snapshot before-state.
          appendSnapshot({ kind: 'tutorial-before', table: TUT_TBL, id: tutorialId, slug, newId });
          for (const cpi of cpiRows) {
            appendSnapshot({ kind: 'cpi-before', table: CPI_TBL, id: cpi.ID, tutorialId, newId });
          }

          // Apply the Tutorials UPDATE first.
          const tutResult = await tx.run(
            `UPDATE ${TUT_TBL} SET "LEGACYID" = ? WHERE "ID" = ? AND "LEGACYID" IS NULL`,
            [newId, tutorialId]
          );
          // Apply the CPI UPDATE.
          const cpiResult = await tx.run(`
            UPDATE ${CPI_TBL}
               SET "TASKLEGACYID" = ?
             WHERE "TUTORIAL_ID" = ?
               AND "TASKLEGACYID" IS NULL
               AND "TASKTYPE" = 'TUTORIAL'
          `, [newId, tutorialId]);

          tutorialsRepaired++;
          // tx.run for an UPDATE returns the affected row count on HANA via
          // the underlying driver; if not, we fall back to the pre-count.
          const cpiCount = (typeof cpiResult === 'number') ? cpiResult : cpiRows.length;
          cpiRepaired += cpiCount;

          console.log(`    ✓ legacyId=${newId}  cpi_updated=${cpiCount}`);
        });
      } catch (err) {
        tutorialsFailed++;
        console.error(`    ✗ failed for ${slug}: ${err.message}`);
        // Continue with the next tutorial — fail-soft per spec.
      }
    }

    console.log('\n=== SUMMARY ===');
    console.log(JSON.stringify({
      tutorialsScanned: nullRows.length,
      tutorialsRepaired,
      tutorialsFailed,
      cpiRowsRepaired: cpiRepaired,
    }, null, 2));
    if (!COMMIT) console.log('\nDry-run complete. Re-run with --commit to apply.');
  }

  main().catch(e => { console.error(e); process.exit(1); });
  ```

- [ ] **Step 2: Lint check (no test runner needed for the script itself)**

  ```bash
  cd D:/projects/tutorials-poc
  node --check scripts/repair-tutorial-legacyid.cjs
  ```

  Expected: no output (clean parse). If you get a syntax error, fix before continuing.

- [ ] **Step 3: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add scripts/repair-tutorial-legacyid.cjs
  git -c core.autocrlf=false commit -m "feat(scripts): repair-tutorial-legacyid.cjs for NULL Tutorials.legacyId rows (#431)

  Mirrors dedupe-tutorial-meta.cjs: --dry-run default, --commit applies,
  --verify-only exits 0/2. Per-tutorial transaction with SELECT FOR UPDATE
  + re-check; fail-soft on per-row failure. Propagates the new legacyId
  to CompletionPathItems via the tutorial : Association FK
  (CompletionPathItems.tutorial_ID — NOT slug-matched, since the schema
  has no taskSlug column).

  TaskRecords explicitly out of scope (no FK or slug column to recover
  orphans; documented in the spec)."
  ```

---

## Task 4: Hybrid test for the repair script

**Files:**
- Create: `test/hybrid/repair-tutorial-legacyid.test.js`

This test exercises the repair-script's core logic (not the script's CLI). To avoid invoking a child process in tests, refactor: the script's `main()` is monolithic, but the per-tutorial repair logic can be tested by replicating it inline in the test against `__TEST__legacyid-repair-` prefixed rows.

> **Why not refactor `scripts/repair-tutorial-legacyid.cjs` to export a callable function?** The repair script is `.cjs` and the test files are `.js` (ESM); cross-format imports add complexity. The hybrid test mirrors the script's SQL directly — same statements, scoped to test prefixes only. If the script logic later needs reuse, refactor to extract a shared helper.

- [ ] **Step 1: Create the hybrid test file**

  Use this template:

  ```js
  import cds from '@sap/cds';
  import { describe, it, expect, beforeAll, afterAll } from 'vitest';
  import { isSafeForWrites } from './_guard.js';

  const NS = 'com.sap.developers.ims';
  const TEST_PREFIX = '__TEST__legacyid-repair-';

  const TUT_TBL = '"COM_SAP_DEVELOPERS_IMS_TUTORIALS"';
  const CPI_TBL = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"';
  const PATH_TBL = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"';
  const TUT_SEQ = '"COM_SAP_DEVELOPERS_IMS_TUTORIALS_SEQ"';

  describe('repair-tutorial-legacyid (#431) — HANA', () => {
    let db;

    beforeAll(async () => {
      if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
        throw new Error('Hybrid writes require ALLOW_HYBRID_WRITES=true');
      }
      if (!isSafeForWrites()) {
        throw new Error('Refusing to run hybrid writes against production');
      }
      db = await cds.connect.to('db');
    });

    afterAll(async () => {
      // Clean up everything our prefix touched.
      await db.run(`DELETE FROM ${CPI_TBL}
        WHERE "TUTORIAL_ID" IN (SELECT "ID" FROM ${TUT_TBL} WHERE "SLUG" LIKE '${TEST_PREFIX}%')`);
      await db.run(`DELETE FROM ${PATH_TBL} WHERE "SLUG" LIKE '${TEST_PREFIX}%'`);
      await db.run(`DELETE FROM ${TUT_TBL} WHERE "SLUG" LIKE '${TEST_PREFIX}%'`);
    });

    it('backfills NULL Tutorials.legacyId and propagates to CompletionPathItems via FK', async () => {
      const tutorialId = cds.utils.uuid();
      const slug = `${TEST_PREFIX}probe`;
      const pathId = cds.utils.uuid();
      const cpiId = cds.utils.uuid();

      // 1. Seed a parent CompletionPath (FK target for the CPI row).
      // CompletionPaths inherits LegacyKeyed, so seed legacyId too — defensive
      // against any future NOT NULL constraint and consistent with how the
      // entity is written elsewhere.
      const pathLegacyId = 999_900_001;
      await db.run(
        `INSERT INTO ${PATH_TBL} ("ID", "SLUG", "TITLE", "STATUS", "LEGACYID") VALUES (?, ?, ?, ?, ?)`,
        [pathId, `${TEST_PREFIX}path`, 'Repair test path', 'ACTIVE', pathLegacyId]
      );

      // 2. Seed a Tutorials row with legacyId NULL (mimics the bug shape).
      await db.run(
        `INSERT INTO ${TUT_TBL} ("ID", "SLUG", "TITLE", "STATUS", "LEGACYID") VALUES (?, ?, ?, ?, NULL)`,
        [tutorialId, slug, 'Repair test tutorial', 'ACTIVE']
      );

      // 3. Seed a CompletionPathItems row pointing at the tutorial via FK,
      //    with taskLegacyId NULL (mimics the downstream-NULL shape).
      await db.run(
        `INSERT INTO ${CPI_TBL}
           ("ID", "PATH_ID", "TASKLEGACYID", "TASKTYPE", "TUTORIAL_ID", "ITEMORDER")
         VALUES (?, ?, NULL, 'TUTORIAL', ?, 1)`,
        [cpiId, pathId, tutorialId]
      );

      // Sanity: pre-state.
      const tutBefore = await db.run(`SELECT "LEGACYID" FROM ${TUT_TBL} WHERE "ID" = ?`, [tutorialId]);
      expect(tutBefore[0].LEGACYID).toBeNull();
      const cpiBefore = await db.run(`SELECT "TASKLEGACYID" FROM ${CPI_TBL} WHERE "ID" = ?`, [cpiId]);
      expect(cpiBefore[0].TASKLEGACYID).toBeNull();

      // 4. Apply the repair logic in a tx (mirrors the script's per-tutorial block).
      let assignedLegacyId;
      await db.tx(async tx => {
        const [seqRow] = await tx.run(`SELECT ${TUT_SEQ}.NEXTVAL AS "nextval" FROM DUMMY`);
        assignedLegacyId = seqRow.nextval;
        await tx.run(
          `UPDATE ${TUT_TBL} SET "LEGACYID" = ? WHERE "ID" = ? AND "LEGACYID" IS NULL`,
          [assignedLegacyId, tutorialId]
        );
        await tx.run(`
          UPDATE ${CPI_TBL}
             SET "TASKLEGACYID" = ?
           WHERE "TUTORIAL_ID" = ?
             AND "TASKLEGACYID" IS NULL
             AND "TASKTYPE" = 'TUTORIAL'
        `, [assignedLegacyId, tutorialId]);
      });

      // 5. Assert: both rows now carry the same positive legacyId.
      expect(typeof assignedLegacyId).toBe('number');
      expect(assignedLegacyId).toBeGreaterThan(0);

      const tutAfter = await db.run(`SELECT "LEGACYID" FROM ${TUT_TBL} WHERE "ID" = ?`, [tutorialId]);
      expect(tutAfter[0].LEGACYID).toBe(assignedLegacyId);

      const cpiAfter = await db.run(`SELECT "TASKLEGACYID" FROM ${CPI_TBL} WHERE "ID" = ?`, [cpiId]);
      expect(cpiAfter[0].TASKLEGACYID).toBe(assignedLegacyId);
    });

    it('leaves CompletionPathItems alone when taskLegacyId is already non-NULL', async () => {
      const tutorialId = cds.utils.uuid();
      const slug = `${TEST_PREFIX}skip`;
      const pathId = cds.utils.uuid();
      const cpiId = cds.utils.uuid();
      const preExistingTaskLegacyId = 999_999_001;

      await db.run(
        `INSERT INTO ${PATH_TBL} ("ID", "SLUG", "TITLE", "STATUS", "LEGACYID") VALUES (?, ?, ?, ?, ?)`,
        [pathId, `${TEST_PREFIX}path-skip`, 'Skip test path', 'ACTIVE', 999_900_002]
      );
      await db.run(
        `INSERT INTO ${TUT_TBL} ("ID", "SLUG", "TITLE", "STATUS", "LEGACYID") VALUES (?, ?, ?, ?, NULL)`,
        [tutorialId, slug, 'Skip test tutorial', 'ACTIVE']
      );
      // CPI starts with a non-NULL taskLegacyId — repair should NOT overwrite.
      await db.run(
        `INSERT INTO ${CPI_TBL}
           ("ID", "PATH_ID", "TASKLEGACYID", "TASKTYPE", "TUTORIAL_ID", "ITEMORDER")
         VALUES (?, ?, ?, 'TUTORIAL', ?, 1)`,
        [cpiId, pathId, preExistingTaskLegacyId, tutorialId]
      );

      // Apply the repair tx.
      await db.tx(async tx => {
        const [seqRow] = await tx.run(`SELECT ${TUT_SEQ}.NEXTVAL AS "nextval" FROM DUMMY`);
        await tx.run(
          `UPDATE ${TUT_TBL} SET "LEGACYID" = ? WHERE "ID" = ? AND "LEGACYID" IS NULL`,
          [seqRow.nextval, tutorialId]
        );
        await tx.run(`
          UPDATE ${CPI_TBL}
             SET "TASKLEGACYID" = ?
           WHERE "TUTORIAL_ID" = ?
             AND "TASKLEGACYID" IS NULL
             AND "TASKTYPE" = 'TUTORIAL'
        `, [seqRow.nextval, tutorialId]);
      });

      // Assert: the pre-existing taskLegacyId is unchanged.
      const cpiAfter = await db.run(`SELECT "TASKLEGACYID" FROM ${CPI_TBL} WHERE "ID" = ?`, [cpiId]);
      expect(cpiAfter[0].TASKLEGACYID).toBe(preExistingTaskLegacyId);
    });
  });
  ```

- [ ] **Step 2: Run the hybrid suite (requires `cf login` + `ALLOW_HYBRID_WRITES=true`)**

  ```bash
  cd D:/projects/tutorials-poc
  ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/repair-tutorial-legacyid.test.js --reporter=default 2>&1 | tail -10
  ```

  Expected: 2 tests pass.

  If hybrid setup isn't available locally, **skip** — the test runs in CI when the PR is open.

- [ ] **Step 3: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add test/hybrid/repair-tutorial-legacyid.test.js
  git -c core.autocrlf=false commit -m "test(hybrid): repair-tutorial-legacyid SQL contract regression (#431)"
  ```

---

## Task 5: Final smoke + push + PR

- [ ] **Step 1: Verify branch state**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current   # fix/issue-431-tutorial-legacyid
  git log --oneline main..HEAD
  ```

  Expected: 8 commits — 3 spec, 1 plan, 1 publish-session fix, 1 hybrid forward test, 1 repair script, 1 hybrid repair test.

- [ ] **Step 2: Run unit tests as a regression sweep**

  ```bash
  cd D:/projects/tutorials-poc
  npx vitest run scripts/__tests__ --reporter=default 2>&1 | tail -10
  ```

  Expected: same baseline as before this PR (469 pass + 1 unrelated unhandled rejection in `publish-retry.test.ts` per recent session history).

- [ ] **Step 3: Push**

  ```bash
  cd D:/projects/tutorials-poc
  git push -u origin fix/issue-431-tutorial-legacyid
  ```

- [ ] **Step 4: Open PR**

  ```bash
  cd D:/projects/tutorials-poc
  gh pr create \
    --repo sap-tutorials/tutorials-ims \
    --base main \
    --title "fix(publish-session): assign legacyId on Tutorials INSERT + repair NULL rows (#431)" \
    --body "$(cat <<'EOF'
  ## What

  Two-part fix for #431:

  1. **Forward fix** in [`srv/lib/content-publish-session.js`](srv/lib/content-publish-session.js): the INSERT branch now unconditionally assigns `legacyId` from `getNextLegacyId('Tutorials', db)`. The UPDATE branch reads the existing `legacyId` and assigns one only if NULL — **self-heals** any tutorial that gets republished after deploy, eliminating reliance on the repair script for the long tail.
  2. **Backward repair** in [`scripts/repair-tutorial-legacyid.cjs`](scripts/repair-tutorial-legacyid.cjs): walks `Tutorials WHERE legacyId IS NULL`, assigns sequence values, propagates to `CompletionPathItems.taskLegacyId` via the `tutorial : Association to Tutorials` FK. Per-tutorial transaction with `SELECT FOR UPDATE` + re-check; fail-soft. `--dry-run` default, `--commit` applies.

  ## Why

  Per #431, `upsertTutorialMetadata` was creating new `Tutorials` rows with `legacyId IS NULL`. The Steps INSERT four lines later correctly used `getNextLegacyId('Steps', db)` — Tutorials was simply missed. Surfaced 2026-06-19 during #382 phase F1 mission-data repair: 5 known NULL rows (4 newly-published meta-tutorials + the historical `test-tutorial`).

  Downstream impact: `taskLegacyId` joins to `Tutorials.legacyId` for progress tracking (`TaskRecords`), mission-path resolution (`CompletionPathItems`), and recompute (`recomputeTutorialProgress` early-returns on NULL legacyId). Carry-forward in the publish session masked the symptom for existing tutorials.

  ## TaskRecords scope

  **Explicitly out of scope.** TaskRecords has no FK to Tutorials and no slug column — orphan rows whose `taskLegacyId` was written NULL during the bug window are unrecoverable from a repair script. The 4 named meta-tutorials are author-facing reference docs unlikely to have non-author user progress; documented as accepted data-loss boundary in the spec.

  ## Changes

  - **`srv/lib/content-publish-session.js`**: forward fix in the INSERT branch + UPDATE-branch self-heal.
  - **`test/hybrid/content-publish-chunked.test.js`**: 2 new hybrid regression tests under a new `__TEST__legacyid-` prefix (forward INSERT, UPDATE self-heal).
  - **`scripts/repair-tutorial-legacyid.cjs`**: new one-shot script. Mirrors the existing `dedupe-tutorial-meta.cjs` pattern (snapshot, `--dry-run`/`--commit`/`--verify-only`, HANA-only guard, per-tutorial tx).
  - **`test/hybrid/repair-tutorial-legacyid.test.js`**: 2 hybrid tests for the repair logic (positive case + skip-when-non-NULL guard).

  ## Test plan

  - ✅ Hybrid forward INSERT: a fresh slug published via the chunked path → `Tutorials.legacyId > 0`.
  - ✅ Hybrid UPDATE self-heal: a manually-NULLed Tutorials row → republish → `legacyId` non-null.
  - ✅ Hybrid repair: NULL Tutorials + matching CPI → both heal to the same legacyId via FK.
  - ✅ Hybrid skip-guard: CPI with non-NULL `taskLegacyId` is left alone.
  - **Manual run on DEV** (post-merge, post-deploy): `npx cds bind --exec -- node scripts/repair-tutorial-legacyid.cjs --dry-run` lists the known NULL rows, `--commit` heals them, `--verify-only` exits 0.

  ## Refs

  - Spec: [docs/superpowers/specs/2026-06-19-tutorial-legacyid-publish-design.md](docs/superpowers/specs/2026-06-19-tutorial-legacyid-publish-design.md)
  - Plan: [docs/superpowers/plans/2026-06-19-tutorial-legacyid-publish.md](docs/superpowers/plans/2026-06-19-tutorial-legacyid-publish.md)
  - Surfacing event: #382 phase F1
  - Companion fix: #428
  - Same masking pattern: #425, #432

  Closes #431.
  EOF
  )"
  ```

  Expected: PR URL printed.

---

## Out of scope (per spec)

- Recovering orphan TaskRecords (no FK / no slug column).
- Adding a `@mandatory` constraint on `Tutorials.legacyId` (CSN migration; deferred).
- Migrating away from `legacyId` to UUID-based joins (broader concern).
- Repairing `Steps.legacyId` NULLs (Steps INSERT already correctly assigns legacyId).
- Backfilling other `*.legacyId` fields elsewhere in the schema.
- Database trigger / `BEFORE INSERT` to assign legacyId at the DB layer (out of pattern).

## Notes for the implementer

- **Re-issue `git checkout`** as part of every commit invocation (memory: `feedback_branch_slip_after_long_session`). Each commit step in this plan reminds you to run `git branch --show-current` first.
- **Don't squash commits.** Spec → plan → publish-session → forward-test → repair-script → repair-test is a clean reviewable story (8 commits total).
- **Hybrid tests are the right altitude** for this fix — `upsertTutorialMetadata` is tightly coupled to `cds.entities()` and DB sequences. Don't try to write SQLite unit tests for it; the hybrid layer covers it.
- **Don't add a `@mandatory` constraint on `Tutorials.legacyId`** — the spec rejects this. Other code paths legitimately read NULL today (`recomputeTutorialProgress`'s short-circuit) and adding the constraint would force a CSN migration that risks breaking them.
- **The repair-script SQL uses HANA uppercase quoted identifiers** per `feedback_hana_raw_sql_uppercase` memory. Don't rewrite it to use lowercase — HANA strict-SQL rejects.
